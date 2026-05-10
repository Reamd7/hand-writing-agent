# 第 14 课：上下文窗口管理与压缩 (Context Compaction)

## 问题：为什么需要上下文压缩？

每个 LLM 都有一个固定的**上下文窗口**（context window）。当前主流模型的窗口大小：

| 模型            | 上下文窗口  |
| --------------- | ----------- |
| GPT-4o          | 128k tokens |
| Claude Sonnet 4 | 200k tokens |
| Gemini 2.5 Pro  | 1M tokens   |

一个 coding agent 的典型对话会快速消耗上下文：

- 系统提示词：~2k tokens
- 每次用户消息：~100-500 tokens
- 每次助手回复（含思考）：~500-2000 tokens
- 每次工具调用 + 结果：~200-5000 tokens（读文件可以很大）
- 一个完整的 agent loop（用户提问 -> 多轮工具调用 -> 最终回复）：~5k-30k tokens

这意味着一个 128k 窗口的模型，持续工作 5-10 轮就可能接近上限。超出窗口后，LLM 会返回错误，对话无法继续。

**上下文压缩**（compaction）的目标：在上下文即将溢出时，将旧的对话历史压缩成一份简短的摘要，释放空间让对话继续。

---

## 两种触发模式

pi 实现了两种互补的触发机制：

### 1. 阈值触发 (Threshold Compaction)

在每次 agent 回合结束后（`agent_end` 事件），检查当前上下文使用量：

```
if contextTokens > contextWindow - reserveTokens:
    触发压缩
```

这里的关键参数：

- `contextTokens`：当前上下文占用的 token 数（从 LLM usage 报告获取）
- `contextWindow`：模型的上下文窗口大小
- `reserveTokens`：预留缓冲区（默认 16384 tokens），确保压缩后有足够空间

pi 源码中的判断逻辑（`compaction.ts`）：

```typescript
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}
```

**特点**：

- 在 agent 完成回复后触发，不打断用户交互
- 压缩完成后不自动重试，用户继续手动输入下一条消息
- 属于"预防性"压缩，在溢出之前主动处理

### 2. 溢出触发 (Overflow Compaction)

当 LLM 直接返回上下文溢出错误时的紧急处理：

```
if LLM返回上下文溢出错误:
    移除错误消息
    紧急压缩
    自动重试上一次请求
```

pi 源码中的处理逻辑（`agent-session.ts`）：

```typescript
// Case 1: Overflow - LLM returned context overflow error
if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
  if (this._overflowRecoveryAttempted) {
    // 已经尝试过一次恢复，放弃
    emit("Context overflow recovery failed...");
    return;
  }

  this._overflowRecoveryAttempted = true;
  // 从 agent state 中移除错误消息
  const messages = this.agent.state.messages;
  if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
    this.agent.state.messages = messages.slice(0, -1);
  }
  await this._runAutoCompaction("overflow", true); // willRetry = true
  return;
}
```

**特点**：

- 紧急处理，已经发生了错误
- 压缩完成后**自动重试**上一次 LLM 请求
- 只尝试一次恢复，如果压缩后仍然溢出则报错
- 属于"应急"机制，理想情况下不应该触发（阈值触发应该提前拦截）

### 两种模式的关系

```
正常流程：
  用户消息 -> agent loop -> agent_end
                              |
                              v
                      [阈值检查] -- 超过阈值 --> [压缩] --> 等待用户下一条消息
                              |
                          未超过
                              |
                              v
                        等待用户下一条消息

溢出流程：
  用户消息 -> agent loop -> LLM 返回溢出错误
                              |
                              v
                      [移除错误消息] -> [紧急压缩] -> [自动重试请求]
```

---

## 压缩流水线 (Compaction Pipeline)

### 整体流程

```
[session entries] --> prepareCompaction() --> compact() --> [CompactionResult]
                                                                  |
                                                                  v
                                              appendCompaction() 写入 session
                                                                  |
                                                                  v
                                              buildSessionContext() 重建 agent state
```

### 步骤 1：prepareCompaction() - 准备阶段

这是一个**纯函数**，不涉及任何 I/O，只做数据处理：

```typescript
export function prepareCompaction(
  pathEntries: SessionEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined;
```

核心任务：

#### 1a. 查找上一次压缩边界

```typescript
// 找到最近一次 compaction entry
let prevCompactionIndex = -1;
for (let i = pathEntries.length - 1; i >= 0; i--) {
  if (pathEntries[i].type === "compaction") {
    prevCompactionIndex = i;
    break;
  }
}

// 确定搜索范围：从上次压缩保留点到最新条目
let boundaryStart = 0;
if (prevCompactionIndex >= 0) {
  const prevCompaction = pathEntries[prevCompactionIndex];
  previousSummary = prevCompaction.summary; // 用于迭代更新
  boundaryStart = findIndex(prevCompaction.firstKeptEntryId);
}
```

#### 1b. 寻找切割点 (Cut Point)

从最新消息往回走，累计 token 数，直到超过 `keepRecentTokens` 预算：

```typescript
export function findCutPoint(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult;
```

算法：

1. 从尾部向前遍历，累加每条消息的估算 token 数
2. 当累计超过 `keepRecentTokens`（默认 20000）时停止
3. 在该位置找到最近的**合法切割点**
4. 合法切割点：user、assistant、custom、bashExecution 消息（不能在 toolResult 处切割，因为 toolResult 必须跟在对应的 tool call 之后）

切割的结果将对话分成两部分：

```
[--- 需要压缩的旧消息 ---][--- 保留的新消息 ---]
         summarize               keep
```

**Split Turn 处理**：如果切割点落在一个 turn 的中间（比如 assistant 的工具调用序列中间），pi 会识别这种情况并生成额外的 "turn prefix summary"，确保保留部分的上下文不会断裂。

#### 1c. 分离消息

```typescript
// 需要摘要的消息（将被丢弃）
const messagesToSummarize: AgentMessage[] = [];
for (let i = boundaryStart; i < historyEnd; i++) {
  const msg = getMessageFromEntry(pathEntries[i]);
  if (msg) messagesToSummarize.push(msg);
}

// 如果发生了 turn split，还需要单独处理 turn prefix
const turnPrefixMessages: AgentMessage[] = [];
if (cutPoint.isSplitTurn) {
  for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
    const msg = getMessageFromEntry(pathEntries[i]);
    if (msg) turnPrefixMessages.push(msg);
  }
}
```

### 步骤 2：提取文件操作

跟踪会话中涉及的文件，这些信息会附加到摘要中：

```typescript
const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
```

具体做法：

1. 从上一次压缩的 `details` 中恢复历史文件列表
2. 遍历所有 assistant 消息的 tool call，按工具名分类：
   - `read` 工具 -> `fileOps.read`
   - `write` 工具 -> `fileOps.written`
   - `edit` 工具 -> `fileOps.edited`
3. 最终计算：`readFiles` = 只读过没修改过的文件，`modifiedFiles` = 写过或编辑过的文件

产出格式（附加到摘要末尾）：

```xml
<read-files>
src/utils.ts
src/config.ts
</read-files>

<modified-files>
src/compaction.ts
src/agent.ts
</modified-files>
```

### 步骤 3：序列化对话为纯文本

将结构化的消息数组转换为文本格式，防止摘要模型把它当作对话继续回复：

```typescript
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      parts.push(`[User]: ${content}`);
    } else if (msg.role === "assistant") {
      // 分别处理 thinking、text、toolCall
      parts.push(`[Assistant]: ${text}`);
      parts.push(`[Assistant tool calls]: read(path="src/foo.ts"); edit(path=...)`);
    } else if (msg.role === "toolResult") {
      // 截断过长的工具结果（最多 2000 字符）
      parts.push(`[Tool result]: ${truncateForSummary(content, 2000)}`);
    }
  }
  return parts.join("\n\n");
}
```

### 步骤 4：调用 LLM 生成摘要

使用**非流式**调用（相当于 `generateText`）生成摘要：

```typescript
export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model<any>,
  reserveTokens: number,
  apiKey: string,
  ...
): Promise<string> {
  const maxTokens = Math.floor(0.8 * reserveTokens);

  // 序列化对话
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);

  // 构建 prompt
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    promptText += UPDATE_SUMMARIZATION_PROMPT;  // 增量更新
  } else {
    promptText += SUMMARIZATION_PROMPT;  // 首次摘要
  }

  // 非流式调用
  const response = await completeSimple(model, {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: promptText }],
  }, { maxTokens, signal, apiKey });

  return response.content
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("\n");
}
```

关键设计决策：

- **迭代式摘要**：如果存在上一次压缩的摘要（`previousSummary`），使用 `UPDATE_SUMMARIZATION_PROMPT` 让模型在旧摘要基础上增量更新，而不是重新摘要全部内容。这保证了多次压缩不会丢失早期上下文。
- **结构化输出格式**：摘要遵循固定模板（Goal、Progress、Key Decisions、Next Steps 等），方便后续 LLM 快速理解上下文。
- **Split Turn 并行摘要**：如果发生了 turn split，会并行生成历史摘要和 turn prefix 摘要，然后合并。

### 步骤 5：持久化并重建状态

```typescript
// 写入 session
sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details);

// 重建 agent state
const sessionContext = sessionManager.buildSessionContext();
agent.state.messages = sessionContext.messages;
```

`buildSessionContext()` 重新从 session entries 构建消息列表。压缩后的上下文结构：

```
[compaction summary (user message)] -> [保留的近期消息...]
```

压缩摘要作为一条 user role 的消息注入到上下文开头，后面跟着保留下来的近期消息。

---

## Token 计数策略

### 策略 1：chars/4 启发式

pi 的主要估算方法。基于英文文本平均每个 token 约 4 个字符的经验值：

```typescript
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  // 累加消息中所有文本内容的字符数
  // 对图片使用固定估算值（4800 chars = ~1200 tokens）
  return Math.ceil(chars / 4);
}
```

优点：零依赖、O(1) 复杂度、偏保守（宁可高估触发早一点的压缩）。
缺点：对非拉丁文字（中文、日文等）不准确，中文每个字符约 1-2 个 token。

### 策略 2：基于 Usage 的精确计数

LLM 响应自带 usage 信息，这是最准确的数据：

```typescript
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
```

pi 的 `estimateContextTokens()` 结合了两种策略：

```typescript
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  // 找到最后一条有 usage 的 assistant 消息
  const usageInfo = getLastAssistantUsageInfo(messages);

  if (!usageInfo) {
    // 没有任何 usage 数据，全部用 chars/4 估算
    return { tokens: sumEstimated, ... };
  }

  // 用 usage 的精确值 + 后续消息的 chars/4 估算
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }

  return { tokens: usageTokens + trailingTokens, ... };
}
```

### 策略 3：tiktoken

使用 OpenAI 开源的 tokenizer，可以得到精确的 token 数：

```typescript
import { encoding_for_model } from "tiktoken";
const enc = encoding_for_model("gpt-4o");
const tokens = enc.encode("Hello world").length;
enc.free(); // WASM 资源需要手动释放
```

pi 没有使用 tiktoken，因为 chars/4 足够满足需求，且避免了 WASM 依赖。

---

## 完整伪代码

```
function checkCompaction(assistantMessage, contextWindow, settings):
    if not settings.enabled: return

    // ---- 溢出触发 ----
    if isContextOverflow(assistantMessage):
        if overflowRecoveryAttempted:
            reportError("Recovery failed")
            return
        overflowRecoveryAttempted = true
        removeLastMessage(agentState)        // 移除错误消息
        runCompaction("overflow", retry=true)
        return

    // ---- 阈值触发 ----
    contextTokens = calculateContextTokens(assistantMessage.usage)
    if contextTokens > contextWindow - reserveTokens:
        runCompaction("threshold", retry=false)

function runCompaction(reason, retry):
    emit("compaction_start", reason)

    entries = session.getBranch()
    preparation = prepareCompaction(entries, settings)
    if not preparation: return

    result = compact(preparation, model, apiKey)

    session.appendCompaction(result.summary, result.firstKeptEntryId, ...)
    agent.state.messages = session.buildSessionContext().messages

    emit("compaction_end", reason, willRetry=retry)

    if retry:
        resubmitLastRequest()

function prepareCompaction(entries, settings):
    // 1. 找到上次压缩边界
    prevCompaction = findLastCompaction(entries)
    boundaryStart = prevCompaction ? prevCompaction.firstKeptIndex : 0
    previousSummary = prevCompaction?.summary

    // 2. 估算当前 token 数
    tokensBefore = estimateContextTokens(buildMessages(entries))

    // 3. 寻找切割点
    cutPoint = findCutPoint(entries, boundaryStart, entries.length, keepRecentTokens)

    // 4. 分离消息
    messagesToSummarize = entries[boundaryStart..cutPoint].messages
    keptMessages = entries[cutPoint..end].messages

    // 5. 提取文件操作
    fileOps = extractFileOperations(messagesToSummarize, prevCompaction)

    return { messagesToSummarize, firstKeptEntryId, fileOps, previousSummary, ... }

function compact(preparation, model, apiKey):
    // 1. 序列化对话为纯文本
    text = serializeConversation(preparation.messagesToSummarize)

    // 2. 构建 prompt（首次 vs 增量更新）
    if preparation.previousSummary:
        prompt = text + previousSummary + UPDATE_PROMPT
    else:
        prompt = text + INITIAL_PROMPT

    // 3. 调用 LLM 生成摘要（非流式）
    summary = generateText(model, systemPrompt, prompt)

    // 4. 附加文件操作信息
    summary += formatFileOperations(preparation.fileOps)

    return { summary, firstKeptEntryId, tokensBefore }
```

---

## 关键设计总结

| 设计点     | 决策                     | 原因                                  |
| ---------- | ------------------------ | ------------------------------------- |
| 触发时机   | agent_end 之后           | 不打断工具执行流程                    |
| 两种触发   | 阈值 + 溢出              | 预防为主，应急为辅                    |
| Token 估算 | Usage + chars/4 混合     | 精确与简单的平衡                      |
| 摘要方式   | 非流式 generateText      | 原子写入，不需要增量展示              |
| 迭代更新   | 基于上次摘要增量         | 避免多次压缩丢失早期上下文            |
| 切割策略   | 保留最近 N tokens        | 最新上下文最重要                      |
| 文件跟踪   | 跨压缩边界累积           | 确保 agent 始终知道哪些文件被操作过   |
| 纯函数设计 | prepareCompaction 无 I/O | 可测试、可扩展（extensions 可以接管） |

---

## 练习

1. 运行 `code/src/demo.ts`，观察当对话超过阈值时压缩如何触发
2. 修改 `COMPACTION_THRESHOLD` 为不同值，观察压缩频率的变化
3. 尝试在 `estimateTokens()` 中实现 tiktoken 精确计数，对比 chars/4 的误差
4. 思考：如果用户的对话主要是中文，chars/4 的估算偏差会怎样？如何修正？
