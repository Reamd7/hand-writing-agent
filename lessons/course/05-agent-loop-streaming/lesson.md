# 第五课: Agent Loop (Part 1) -- 流式响应与轮次管理

## 概述

第四课我们建立了 Agent 的状态管理和事件模型: `AgentState`, `AgentEvent`, `processEvents()`, `subscribe()`。但 Agent 还没有能力发起 LLM 调用 -- 所有事件都是手动推送的测试数据。

从这一课开始，我们连接真正的 LLM。本课聚焦 Agent Loop 的前半段:

1. 理解 Agent Loop 的宏观流程
2. 实现 `streamAssistantResponse()` -- 流式调用 LLM 并产生事件
3. 理解上下文快照隔离 (context snapshot isolation)
4. 实现单轮循环 (prompt -> stream -> end)

工具调用的执行留给第六课。

---

## 1. Agent Loop 宏观流程

一个完整的 Agent Loop 看起来像这样:

```
User Prompt
    |
    v
[agent_start]
    |
    v
+-- [turn_start] ----------------------------------------+
|                                                         |
|  transformContext(messages)    -- 可选: 修剪/注入上下文   |
|         |                                               |
|         v                                               |
|  convertToLlm(messages)       -- 过滤, 只保留 LLM 能   |
|         |                       理解的消息               |
|         v                                               |
|  streamText(model, context)   -- 调用 AI SDK            |
|         |                                               |
|         v                                               |
|  消费 fullStream 事件          -- 映射到 AgentEvent      |
|    message_start                                        |
|    message_update (text delta)                          |
|    message_update (text delta)                          |
|    ...                                                  |
|    message_end                                          |
|         |                                               |
|         v                                               |
|  检测 tool calls                                        |
|         |                                               |
|    有 tool calls?                                       |
|    /           \                                        |
|   是            否                                      |
|   |              |                                      |
|   v              v                                      |
| 执行工具       [turn_end]                               |
| (Lesson 6)        |                                     |
|   |              [agent_end]                            |
|   v               结束                                  |
| [turn_end]                                              |
| [turn_start]  <-- 新的一轮                               |
| 回到 transformContext                                   |
+--------------------------------------------------------+
```

Pi 的完整实现在 `packages/agent/src/agent-loop.ts` 的 `runLoop()` 函数中 (第 155-246 行)。它有两层循环:

- **外层循环**: 检查 follow-up 消息 (Agent 停止后是否有排队的后续消息)
- **内层循环**: stream 响应 -> 执行工具 -> 检查 steering 消息 -> 如果有更多工具调用就继续

本课只实现最简单的路径: **一轮流式响应，检测但不执行工具调用**。

---

## 2. streamAssistantResponse() 内部管线

这是 Agent Loop 的核心函数。它负责一次完整的 LLM 流式调用。管线分四个阶段:

### 阶段 1: transformContext() -- 可选的消息转换

```typescript
let messages = context.messages;
if (config.transformContext) {
  messages = await config.transformContext(messages);
}
```

`transformContext` 是一个扩展点，操作的是 `AgentMessage[]` (包含自定义消息的丰富类型)。典型用途:

- **上下文窗口管理**: 当消息太多接近 token 上限时，裁剪旧消息
- **外部上下文注入**: 从 RAG 系统获取相关文档，作为消息插入
- **敏感信息过滤**: 在发送给 LLM 之前移除敏感内容

对应 `agent-loop.ts:260-263`:

```typescript
// Pi 源码
let messages = context.messages;
if (config.transformContext) {
  messages = await config.transformContext(messages, signal);
}
```

### 阶段 2: convertToLlm() -- 消息格式转换

```typescript
const llmMessages = config.convertToLlm(messages);
```

这是 **AgentMessage 世界到 LLM 世界的边界**。默认实现只保留三种角色:

```typescript
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (msg) => msg.role === "user" || msg.role === "assistant" || msg.role === "toolResult",
  );
}
```

为什么需要这一步? 因为 `AgentMessage` 联合类型可以包含自定义消息 (通过 declaration merging 扩展的 `CustomAgentMessages`)。这些自定义消息对 UI 有意义，但 LLM 不认识它们。`convertToLlm` 负责过滤或转换。

在我们的代码中，这一步还负责将内部消息格式映射到 AI SDK 的 `CoreMessage` 格式。

对应 `agent-loop.ts:265-266` 和 `agent.ts:27-31`。

### 阶段 3: 调用 AI SDK streamText

```typescript
const response = streamFn({
  model: config.languageModel,
  system: context.systemPrompt,
  messages: llmMessages,
  signal,
});
```

`streamFn` 是可注入的。生产环境用 `streamText` (来自 `ai` 包)，测试时可以注入 mock:

```typescript
// 测试用的 mock stream function
const mockStreamFn: StreamFn = (opts) => ({
  fullStream: (async function* () {
    yield { type: "text-delta", textDelta: "Hello " };
    yield { type: "text-delta", textDelta: "world!" };
    yield {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  })(),
  text: Promise.resolve("Hello world!"),
  finishReason: Promise.resolve("stop"),
  usage: Promise.resolve({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }),
});
```

AI SDK 的 `streamText` 返回一个对象，其中 `fullStream` 是一个 `AsyncIterable`，包含所有流式事件。关键事件类型:

| 事件         | 含义                                   |
| ------------ | -------------------------------------- |
| `text-delta` | 一段增量文本                           |
| `tool-call`  | 完整的工具调用 (name + args)           |
| `reasoning`  | 推理/思考内容 (部分模型支持)           |
| `finish`     | 流结束，包含 `finishReason` 和 `usage` |
| `error`      | 错误                                   |

对应 `agent-loop.ts:275-285`。

### 阶段 4: 消费 fullStream，映射到 AgentEvent

这是最复杂的部分。我们用 `for await...of` 遍历 `fullStream`，把每个 AI SDK 事件映射到我们的 `AgentEvent`:

```typescript
for await (const part of response.fullStream) {
    switch (part.type) {
        case "text-delta": {
            accumulatedText += part.textDelta;

            if (!partialMessage) {
                // 第一个 text delta -- 创建 partial message
                partialMessage = createPartialMessage(accumulatedText, ...);
                context.messages.push(partialMessage);
                await emit({ type: "message_start", message: partialMessage });
            } else {
                // 后续 delta -- 原地更新
                partialMessage = createPartialMessage(accumulatedText, ...);
                context.messages[context.messages.length - 1] = partialMessage;
                await emit({ type: "message_update", message: partialMessage, delta: part.textDelta });
            }
            break;
        }

        case "tool-call": {
            // 收集工具调用
            accumulatedToolCalls.push({
                type: "toolCall", id: part.toolCallId,
                name: part.toolName, arguments: part.args,
            });
            // 更新 partial message...
            break;
        }

        case "finish": {
            finalUsage = mapUsage(part.usage);
            finalStopReason = mapFinishReason(part.finishReason);
            break;
        }
    }
}

// 流结束: 构建最终的 AssistantMessage
const finalMessage: AssistantMessage = { ... };
context.messages[context.messages.length - 1] = finalMessage;
await emit({ type: "message_end", message: finalMessage });
return finalMessage;
```

对应 `agent-loop.ts:287-344`。

Pi 的实际实现有更多事件类型 (`thinking_start`, `thinking_delta`, `toolcall_start`, `toolcall_delta` 等)，因为 Pi 的 AI 层 (`@earendil-works/pi-ai`) 定义了自己的流式事件协议。我们的简化版本直接使用 AI SDK 的 `fullStream` 事件。

---

## 3. 上下文快照隔离

这是一个容易被忽略但非常重要的设计。当 Agent 开始一次运行时:

```typescript
// agent.ts:402-408
private createContextSnapshot(): AgentContext {
    return {
        systemPrompt: this._state.systemPrompt,
        messages: this._state.messages.slice(),  // 浅拷贝!
        tools: this._state.tools.slice(),
    };
}
```

`.slice()` 创建了一个浅拷贝。此后:

```
Agent._state.messages  (权威状态，由 processEvents 更新)
        |
        | .slice()
        v
AgentContext.messages   (循环的工作副本，被 streamAssistantResponse 直接修改)
```

**循环的工作副本** 被 `streamAssistantResponse()` 直接修改:

- 第一个 text delta 到来时，push 一个 partial message
- 后续 delta 到来时，`messages[last] = updatedPartial` (原地替换)
- 流结束时，`messages[last] = finalMessage`

**权威状态** 由 `processEvents()` 独立更新:

- `message_end` 事件: `this._state.messages.push(event.message)`

两个数组没有共享引用。这确保了:

1. 流式 partial message 不会出现在权威状态中 (只有 `message_end` 时的最终版本才会)
2. 循环可以自由修改工作副本，不会干扰 UI 从权威状态读取的数据
3. 如果流式过程出错，权威状态不会处于不一致的中间态

---

## 4. Partial Message 管理

流式响应中，我们需要一种方式让 UI 实时显示正在生成的文本。Pi 的做法是维护一个 "partial message":

```
时间线:

t0: stream 开始
    context.messages = [user_msg]

t1: 收到第一个 text_delta "Hello"
    partial = { role: "assistant", content: [{ text: "Hello" }], ... }
    context.messages = [user_msg, partial]          // push
    emit: message_start

t2: 收到 text_delta " world"
    partial = { role: "assistant", content: [{ text: "Hello world" }], ... }
    context.messages = [user_msg, partial]          // messages[last] = partial
    emit: message_update

t3: 收到 finish
    final = { role: "assistant", content: [{ text: "Hello world" }], usage: {...}, ... }
    context.messages = [user_msg, final]            // messages[last] = final
    emit: message_end
```

在 Agent 侧 (`processEvents`):

- `message_start`: 设置 `_state.streamingMessage = event.message`
- `message_update`: 更新 `_state.streamingMessage = event.message`
- `message_end`: 清除 `_state.streamingMessage = undefined`，并 `_state.messages.push(event.message)`

UI 组件通过读取 `agent.state.streamingMessage` 来显示正在生成的内容。只有 `message_end` 后，最终消息才进入 `agent.state.messages`。

对应 `agent-loop.ts:287-333` (循环侧) 和 `agent.ts:497-533` (Agent 侧)。

---

## 5. 终止条件识别

`streamAssistantResponse()` 返回一个 `AssistantMessage`，其中 `stopReason` 告诉循环该怎么做:

| stopReason  | 含义             | 循环行为                      |
| ----------- | ---------------- | ----------------------------- |
| `"stop"`    | 模型正常结束     | 检查是否有 tool calls         |
| `"toolUse"` | 模型请求使用工具 | 执行工具，继续循环 (Lesson 6) |
| `"length"`  | 达到 token 上限  | 当作正常结束处理              |
| `"error"`   | 流式过程出错     | 立即终止，emit agent_end      |
| `"aborted"` | 被用户取消       | 立即终止，emit agent_end      |

```typescript
// agent-loop.ts:194-198
if (message.stopReason === "error" || message.stopReason === "aborted") {
  await emit({ type: "turn_end", message, toolResults: [] });
  await emit({ type: "agent_end", messages: newMessages });
  return;
}
```

错误和取消是硬终止 -- 不检查工具调用，不检查 steering 消息，直接结束。

---

## 6. 单轮循环: prompt -> stream -> end

把以上所有部分组装起来，最简单的循环看起来像这样:

```typescript
async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  // 1. 生命周期事件
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  // 2. 为每个 prompt 消息发出事件
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  // 3. 流式获取助手响应
  const message = await streamAssistantResponse(currentContext, config, signal, emit);
  newMessages.push(message);

  // 4. 终止条件检查
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return newMessages;
  }

  // 5. 检测工具调用 (但不执行)
  const toolCalls = message.content.filter((c) => c.type === "toolCall");
  if (toolCalls.length > 0) {
    console.log(`Detected ${toolCalls.length} tool call(s) -- execution in Lesson 6`);
  }

  // 6. 结束
  await emit({ type: "turn_end", message, toolResults: [] });
  await emit({ type: "agent_end", messages: newMessages });
  return newMessages;
}
```

---

## 7. 完整伪代码 (带详细注释)

以下伪代码展示了 Pi 完整实现的流式管线，包含本课未实现的工具执行循环，供你建立全局理解:

```
function runLoop(context, newMessages, config, signal, emit):
    firstTurn = true
    pendingMessages = config.getSteeringMessages()     // 启动时检查 steering 消息

    // ═══════════════════════════════════════════════════════════
    // 外层循环: 处理 follow-up 消息 (Agent 停止后的排队消息)
    // ═══════════════════════════════════════════════════════════
    while true:
        hasMoreToolCalls = true

        // ═══════════════════════════════════════════════════════
        // 内层循环: 流式响应 + 工具执行 + steering
        // ═══════════════════════════════════════════════════════
        while hasMoreToolCalls OR pendingMessages.length > 0:

            // --- 轮次开始 ---
            if not firstTurn:
                emit(turn_start)
            else:
                firstTurn = false

            // --- 注入 pending messages ---
            if pendingMessages.length > 0:
                for msg in pendingMessages:
                    emit(message_start, msg)
                    emit(message_end, msg)
                    context.messages.push(msg)
                    newMessages.push(msg)
                pendingMessages = []

            // --- 流式助手响应 ---
            //
            // streamAssistantResponse 内部:
            //   1. transformContext(messages)    -> AgentMessage[] 修改
            //   2. convertToLlm(messages)       -> CoreMessage[] 过滤
            //   3. streamFn(model, context)      -> 调用 LLM
            //   4. for await (event of fullStream):
            //        - text_delta: 累积文本, 更新 partial, emit message_update
            //        - tool_call: 收集工具调用
            //        - finish: 记录 usage 和 stopReason
            //   5. 构建最终 AssistantMessage
            //   6. emit message_end
            //   7. return finalMessage
            //
            message = await streamAssistantResponse(context, config, signal, emit)
            newMessages.push(message)

            // --- 错误/取消: 硬终止 ---
            if message.stopReason == "error" OR "aborted":
                emit(turn_end, message, [])
                emit(agent_end, newMessages)
                return

            // --- 检查工具调用 ---
            toolCalls = message.content.filter(c => c.type == "toolCall")
            toolResults = []
            hasMoreToolCalls = false

            if toolCalls.length > 0:
                // 执行工具 (并行或顺序)
                batch = await executeToolCalls(context, message, config, signal, emit)
                toolResults = batch.messages
                hasMoreToolCalls = !batch.terminate

                // 工具结果加入上下文
                for result in toolResults:
                    context.messages.push(result)
                    newMessages.push(result)

            // --- 轮次结束 ---
            emit(turn_end, message, toolResults)

            // --- 检查是否应该停止 ---
            if config.shouldStopAfterTurn({ message, toolResults, context }):
                emit(agent_end, newMessages)
                return

            // --- 检查 steering 消息 ---
            pendingMessages = config.getSteeringMessages()

        // 内层循环结束 -- 没有更多工具调用，没有 steering 消息

        // --- 检查 follow-up 消息 ---
        followUpMessages = config.getFollowUpMessages()
        if followUpMessages.length > 0:
            pendingMessages = followUpMessages
            continue    // 回到外层循环

        break   // 没有更多消息，退出

    // --- 正常结束 ---
    emit(agent_end, newMessages)
```

---

## 8. 练习: 理解事件流

运行 demo，观察控制台输出:

```bash
OPENAI_API_KEY=sk-... npx tsx src/demo.ts
```

你应该看到类似这样的输出:

```
Running agent loop with prompt: Explain what an agent loop is in 2 sentences.
Model: gpt-4o-mini

=== AGENT START ===

--- Turn Start ---
[message_start] User: "Explain what an agent loop is in 2 sentences."
[message_end] user
[message_start] Assistant (streaming begins)
An agent loop is a continuous cycle where...       <-- 逐字符流式输出
[message_end] Assistant finished. stopReason=stop, tokens: in=28, out=45
--- Turn End ---

=== AGENT END (2 new messages) ===
```

事件顺序:

1. `agent_start` -- 整个运行开始
2. `turn_start` -- 第一轮开始
3. `message_start` (user) -- 用户消息
4. `message_end` (user)
5. `message_start` (assistant) -- 助手流式开始
6. `message_update` x N -- 每个 text delta
7. `message_end` (assistant) -- 助手消息完成
8. `turn_end` -- 第一轮结束
9. `agent_end` -- 整个运行结束

---

## 9. 本课要点回顾

| 概念                        | 说明                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| **Agent Loop 宏观流程**     | prompt -> stream -> tool calls -> loop, 用事件驱动                         |
| **streamAssistantResponse** | 四阶段管线: transform -> convert -> stream -> map events                   |
| **上下文快照隔离**          | `.slice()` 创建工作副本，循环和 Agent.\_state 互不干扰                     |
| **Partial message**         | 流式过程中原地更新 context.messages[last]，通过 message_update 事件通知 UI |
| **终止条件**                | error/aborted 硬终止; stop 检查工具; toolUse 继续循环 (Lesson 6)           |
| **StreamFn 可注入**         | 生产用 streamText，测试用 mock -- 依赖注入                                 |
| **convertToLlm 边界**       | AgentMessage 世界到 LLM 世界的类型转换和过滤                               |

下一课 (Lesson 6) 我们将实现工具执行循环: `executeToolCalls()`, prepare/execute/finalize 管线, 以及完整的多轮 Agent Loop。
