# 第六课: Agent Loop (Part 2) -- 工具调用执行引擎

## 概述

上一课我们实现了 agent loop 的 LLM 流式响应部分: 发送上下文到模型、接收流式事件、组装最终的 `AssistantMessage`。但当模型返回的消息包含 `toolCall` 内容块时，循环不能直接停止 -- 它需要执行这些工具调用，将结果喂回模型，再进入下一轮。

本课聚焦工具调用的 **执行引擎**: 从模型返回 `toolCall` 到产出 `ToolResultMessage` 的完整管线。Pi 将这个过程拆为三个阶段:

```
prepare  -->  execute  -->  finalize
 (准备)        (执行)        (收尾)
```

每个阶段职责清晰、失败模式独立，并且在阶段边界插入了生命周期钩子 (`beforeToolCall` / `afterToolCall`)，让上层应用可以拦截、审批、改写工具调用的输入和输出。

本课目标:

1. 理解工具调用三阶段管线的设计动机和每个阶段的职责
2. 掌握 `prepareToolCall()` 的查找、参数修正、schema 校验、拦截流程
3. 掌握 `executePreparedToolCall()` 的执行和进度回调机制
4. 掌握 `finalizeExecutedToolCall()` 的字段级覆盖语义
5. 理解并行 vs 顺序执行的决策逻辑
6. 理解批次终止 (`shouldTerminateToolBatch`) 的全票制规则
7. 将工具执行集成到完整的 `runLoop` 中，形成 stream -> tool calls -> execute -> results -> loop 的闭环

---

## 1. 三阶段管线: 为什么要拆成三步?

一个朴素的实现可能是:

```typescript
for (const toolCall of toolCalls) {
  const tool = findTool(toolCall.name);
  const result = await tool.execute(toolCall.id, toolCall.arguments);
  results.push(result);
}
```

但真实场景需要处理很多问题:

- 工具找不到怎么办? (prepare 阶段拦截)
- LLM 生成的参数不符合 schema 怎么办? (prepare 阶段校验)
- 执行前需要用户授权怎么办? (prepare 阶段的 `beforeToolCall` 钩子)
- 工具抛异常怎么办? (execute 阶段捕获)
- 执行后需要改写结果怎么办? (finalize 阶段的 `afterToolCall` 钩子)
- 多个工具调用是并行还是顺序执行? (执行策略层)

Pi 把这些关注点分配到三个阶段:

| 阶段         | 函数                         | 职责                                                 |
| ------------ | ---------------------------- | ---------------------------------------------------- |
| **Prepare**  | `prepareToolCall()`          | 查找工具、修正参数、schema 校验、beforeToolCall 拦截 |
| **Execute**  | `executePreparedToolCall()`  | 调用 `tool.execute()`、收集进度更新、捕获异常        |
| **Finalize** | `finalizeExecutedToolCall()` | afterToolCall 钩子、字段级结果覆盖                   |

每个阶段要么产出下一阶段的输入，要么产出一个 "立即结果" (immediate outcome) 跳过后续阶段。

---

## 2. Prepare 阶段: `prepareToolCall()`

Prepare 阶段的输入是一个 `AgentToolCall` (模型返回的原始工具调用块)，输出是两种可能之一:

```typescript
type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool;
  args: unknown; // 经过校验的参数
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult;
  isError: boolean;
};
```

流程:

### 2.1 查找工具

```typescript
const tool = context.tools?.find((t) => t.name === toolCall.name);
if (!tool) {
  return { kind: "immediate", result: errorResult("Tool not found"), isError: true };
}
```

如果工具不存在，直接返回错误结果，不进入后续阶段。

### 2.2 参数预处理 (`prepareArguments`)

```typescript
const preparedToolCall = prepareToolCallArguments(tool, toolCall);
```

`prepareArguments()` 是工具定义上的可选方法。它在 schema 校验之前运行，用于修正 LLM 生成的参数。典型场景:

- 路径归一化: LLM 可能生成 `./src/../src/foo.ts`，`prepareArguments` 可以将其规范化为 `src/foo.ts`
- 旧字段映射: 模型可能使用了废弃的字段名，shim 将其转换为新名称
- 类型修正: 模型把数字写成了字符串 `"42"`，shim 将其转换为 `42`

关键点: `prepareArguments` 的输出会替换原始参数，然后才进入 schema 校验。如果它返回与输入相同的引用，说明不需要修正，直接复用原 toolCall 对象。

### 2.3 Schema 校验

```typescript
const validatedArgs = validateToolArguments(tool, preparedToolCall);
```

使用工具定义的 JSON Schema (Pi 用 TypeBox) 校验参数。校验失败会抛异常，被外层 try/catch 捕获并转为 immediate error outcome。

### 2.4 `beforeToolCall` 钩子

```typescript
if (config.beforeToolCall) {
  const beforeResult = await config.beforeToolCall(
    {
      assistantMessage,
      toolCall,
      args: validatedArgs,
      context: currentContext,
    },
    signal,
  );

  if (beforeResult?.block) {
    return {
      kind: "immediate",
      result: errorResult(beforeResult.reason || "Tool execution was blocked"),
      isError: true,
    };
  }
}
```

`beforeToolCall` 在参数校验之后、实际执行之前调用。它接收完整的上下文信息:

- `assistantMessage`: 触发这次工具调用的助手消息
- `toolCall`: 原始的工具调用块
- `args`: 已校验的参数
- `context`: 当前 agent 上下文

钩子返回 `{ block: true, reason?: string }` 可以阻止执行。典型用途:

- **权限控制**: 某些工具需要用户确认 (如文件删除)
- **速率限制**: 短时间内调用次数过多，暂停执行
- **安全审计**: 检查参数中的危险模式 (如 `rm -rf /`)

如果钩子没有阻止，prepare 阶段返回 `{ kind: "prepared", ... }`，进入 execute 阶段。

### 2.5 异常处理

整个 prepare 阶段包裹在 try/catch 中。任何异常 (schema 校验失败、prepareArguments 抛错等) 都被转为 immediate error outcome:

```typescript
try {
  // ... prepareArguments, validate, beforeToolCall
  return { kind: "prepared", toolCall, tool, args: validatedArgs };
} catch (error) {
  return {
    kind: "immediate",
    result: errorResult(error instanceof Error ? error.message : String(error)),
    isError: true,
  };
}
```

---

## 3. Execute 阶段: `executePreparedToolCall()`

Execute 阶段拿到 `PreparedToolCall`，调用实际的工具函数:

```typescript
async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];

  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args,
      signal,
      (partialResult) => {
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              args: prepared.toolCall.arguments,
              partialResult,
            }),
          ),
        );
      },
    );
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (error) {
    await Promise.all(updateEvents);
    return {
      result: errorResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}
```

关键设计点:

### 3.1 `onUpdate` 回调

工具执行可能是长时间运行的操作 (如编译代码、执行 bash 命令)。`onUpdate` 回调允许工具在执行过程中推送进度更新:

```typescript
// 工具实现内部:
async execute(id, args, signal, onUpdate) {
  onUpdate?.({ content: [{ type: "text", text: "Compiling..." }], details: { progress: 0.3 } });
  // ... 执行编译 ...
  onUpdate?.({ content: [{ type: "text", text: "Running tests..." }], details: { progress: 0.7 } });
  // ... 执行测试 ...
  return { content: [...], details: { progress: 1.0 } };
}
```

每次 `onUpdate` 调用都会发射一个 `tool_execution_update` 事件。注意这些事件推送是异步收集的 (`updateEvents` 数组)，在工具执行完成后统一 await。

### 3.2 异常捕获

工具执行抛出的任何异常都被捕获并转为 `isError: true` 的结果。工具不需要自己处理错误编码 -- 约定是 "throw on failure"。

### 3.3 AbortSignal 传播

Agent 的 abort signal 被传递给工具，工具可以用它来取消长时间运行的操作 (如 fetch 请求、子进程):

```typescript
// 工具内部使用 signal:
const response = await fetch(url, { signal });
```

---

## 4. Finalize 阶段: `finalizeExecutedToolCall()`

Finalize 阶段拿到 `ExecutedToolCallOutcome`，通过 `afterToolCall` 钩子给上层应用一个修改结果的机会:

```typescript
async function finalizeExecutedToolCall(
  context,
  assistantMessage,
  prepared,
  executed,
  config,
  signal,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context,
        },
        signal,
      );

      if (afterResult) {
        result = {
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = errorResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }

  return { toolCall: prepared.toolCall, result, isError };
}
```

### 4.1 字段级覆盖语义

`afterToolCall` 返回的 `AfterToolCallResult` 中，每个字段都是可选的:

```typescript
interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[]; // 替换整个 content 数组
  details?: unknown; // 替换整个 details
  isError?: boolean; // 替换 error 标记
  terminate?: boolean; // 替换终止提示
}
```

语义是 **字段级替换、不做深度合并**:

- 如果 `afterResult.content` 存在，用它完全替换原始 content
- 如果 `afterResult.content` 是 `undefined`，保留原始 content
- `details` 同理 -- 不会合并嵌套对象，而是整体替换

这种设计避免了深度合并的复杂性和意外行为。

### 4.2 典型用途

- **内容过滤**: 工具返回了敏感信息，afterToolCall 将其脱敏
- **结果增强**: 给工具结果添加额外上下文
- **强制终止**: 某些条件下设置 `terminate: true` 让 agent 停下来
- **错误降级**: 将某些 "错误" 结果标记为非错误，让模型继续工作

### 4.3 afterToolCall 自身抛异常

如果 afterToolCall 钩子本身抛异常，结果会被替换为错误:

```typescript
catch (error) {
  result = errorResult(error.message);
  isError = true;
}
```

这确保了管线不会因为钩子的 bug 而崩溃。

---

## 5. 并行 vs 顺序执行

Pi 支持两种工具执行模式:

```typescript
type ToolExecutionMode = "sequential" | "parallel";
```

决策逻辑在 `executeToolCalls()` 中:

```typescript
async function executeToolCalls(context, assistantMessage, config, signal, emit) {
  const toolCalls = assistantMessage.content.filter(c => c.type === "toolCall");

  // 检查是否有任何工具要求顺序执行
  const hasSequentialToolCall = toolCalls.some(
    tc => context.tools?.find(t => t.name === tc.name)?.executionMode === "sequential"
  );

  // 全局配置为 sequential，或者任何一个工具标记为 sequential -> 整个批次顺序执行
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(...);
  }
  return executeToolCallsParallel(...);
}
```

关键规则: **任何一个工具要求顺序执行，整个批次都会顺序执行**。这是保守但安全的策略 -- 如果一个工具有副作用需要顺序保证，那么同批次的其他工具也不应该并发。

### 5.1 顺序执行 (`executeToolCallsSequential`)

```
for each toolCall:
  emit(tool_execution_start)
  prepared = prepareToolCall(...)
  if immediate -> emit(tool_execution_end) + emit(message) -> continue
  executed  = executePreparedToolCall(...)
  finalized = finalizeExecutedToolCall(...)
  emit(tool_execution_end)
  emit(message_start + message_end)  // ToolResultMessage
```

每个工具调用按顺序走完三个阶段后，才处理下一个。事件按顺序发射。

### 5.2 并行执行 (`executeToolCallsParallel`)

并行模式更精妙。它分两步:

**第一步: 顺序准备、收集 thunks**

```typescript
const entries: FinalizedToolCallEntry[] = [];

for (const toolCall of toolCalls) {
  emit(tool_execution_start);
  const preparation = await prepareToolCall(...);

  if (preparation.kind === "immediate") {
    // 立即结果 (错误/被拦截): 直接存入 entries
    emit(tool_execution_end);
    entries.push(finalizedOutcome);
    continue;
  }

  // 需要执行的工具: 存为 thunk (延迟执行的函数)
  entries.push(async () => {
    const executed = await executePreparedToolCall(...);
    const finalized = await finalizeExecutedToolCall(...);
    emit(tool_execution_end);
    return finalized;
  });
}
```

`entries` 数组保持了与原始 toolCalls 相同的顺序。元素要么是已解决的 `FinalizedToolCallOutcome`，要么是待执行的 thunk。

**第二步: 并发执行 thunks，保持源顺序输出**

```typescript
const orderedResults = await Promise.all(
  entries.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
);

// 按源顺序发射 tool result messages
for (const finalized of orderedResults) {
  const message = createToolResultMessage(finalized);
  emit(message_start);
  emit(message_end);
  messages.push(message);
}
```

这里的设计有两个重要特性:

1. **`tool_execution_end` 按完成顺序发射**: 每个 thunk 内部在自己完成后立即 emit `tool_execution_end`。所以谁先完成，谁先通知 UI。
2. **`ToolResultMessage` 按源顺序发射**: `Promise.all` 保证 `orderedResults` 的顺序与 `entries` 一致。tool result messages 按模型返回 toolCall 的顺序发射，因为 LLM 期望工具结果的顺序与工具调用的顺序一致。

---

## 6. 批次终止: `shouldTerminateToolBatch`

```typescript
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}
```

规则: **全票制** -- 只有当批次中的每一个工具都设置了 `terminate: true` 时，才认为这个批次应该终止。

为什么不是 "任意一个设置 terminate 就停止"?

考虑这个场景: 模型同时调用了 `readFile` 和 `submitAnswer`。`submitAnswer` 设置了 `terminate: true` (任务完成了)，但 `readFile` 没有。如果采用 "任意一个" 策略，`submitAnswer` 会让 agent 停下来，但 `readFile` 的结果还没有被模型看到，这可能导致最终答案不完整。

全票制确保只有在所有工具都认为 "可以停了" 的情况下，agent 才会停止。

在 `runLoop` 中，终止标记影响循环:

```typescript
const executedBatch = await executeToolCalls(...);
toolResults.push(...executedBatch.messages);
hasMoreToolCalls = !executedBatch.terminate;
// 如果 terminate === true，hasMoreToolCalls === false，循环在本轮结束后停止
```

---

## 7. 完整的 runLoop: 集成工具执行

现在把工具执行集成到上一课的 `runLoop` 中，形成完整的循环:

```
┌──────────────────────────────────────────────────────┐
│                    runLoop                            │
│                                                      │
│  while (hasMoreToolCalls || pendingMessages) {       │
│                                                      │
│    1. 注入 pending messages                           │
│                                                      │
│    2. streamAssistantResponse()                      │
│       ├── transformContext() -- 可选的上下文变换       │
│       ├── convertToLlm()    -- AgentMessage -> Message│
│       └── streamSimple()    -- LLM streaming         │
│                                                      │
│    3. 检查 stopReason (error/aborted -> 退出)         │
│                                                      │
│    4. 提取 toolCalls                                 │
│       └── if toolCalls.length > 0:                   │
│           executeToolCalls()                         │
│           ├── prepareToolCall()     [stage 1]        │
│           ├── executePreparedToolCall() [stage 2]    │
│           ├── finalizeExecutedToolCall() [stage 3]   │
│           └── shouldTerminateToolBatch()             │
│                                                      │
│    5. emit(turn_end)                                 │
│                                                      │
│    6. shouldStopAfterTurn? -> 可选的提前退出          │
│                                                      │
│    7. getSteeringMessages() -> pendingMessages       │
│  }                                                   │
│                                                      │
│  getFollowUpMessages() -> 继续或退出                  │
│                                                      │
│  emit(agent_end)                                     │
└──────────────────────────────────────────────────────┘
```

伪代码 (完整注释版):

```typescript
async function runLoop(context, newMessages, config, signal, emit) {
  let firstTurn = true;
  let pendingMessages = (await config.getSteeringMessages?.()) || [];

  // 外层循环: follow-up messages 到达时继续
  while (true) {
    let hasMoreToolCalls = true;

    // 内层循环: 处理工具调用和 steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      // --- Turn 开始 ---
      if (!firstTurn) emit({ type: "turn_start" });
      else firstTurn = false;

      // --- 1. 注入 pending messages ---
      if (pendingMessages.length > 0) {
        for (const msg of pendingMessages) {
          emit({ type: "message_start", message: msg });
          emit({ type: "message_end", message: msg });
          context.messages.push(msg);
          newMessages.push(msg);
        }
        pendingMessages = [];
      }

      // --- 2. LLM 流式响应 ---
      const message = await streamAssistantResponse(context, config, signal, emit);
      newMessages.push(message);

      // --- 3. 检查错误 ---
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        emit({ type: "turn_end", message, toolResults: [] });
        emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // --- 4. 提取并执行工具调用 ---
      const toolCalls = message.content.filter((c) => c.type === "toolCall");
      const toolResults = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        // 核心: 执行工具调用批次
        const batch = await executeToolCalls(context, message, config, signal, emit);
        toolResults.push(...batch.messages);
        // 如果批次没有终止，还有更多工具调用要处理 (下一轮模型可能再次返回工具调用)
        hasMoreToolCalls = !batch.terminate;

        // 将工具结果加入上下文
        for (const result of toolResults) {
          context.messages.push(result);
          newMessages.push(result);
        }
      }

      // --- 5. Turn 结束 ---
      emit({ type: "turn_end", message, toolResults });

      // --- 6. 可选的提前退出 ---
      if (await config.shouldStopAfterTurn?.({ message, toolResults, context, newMessages })) {
        emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // --- 7. 获取 steering messages ---
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // 检查 follow-up messages
    const followUp = (await config.getFollowUpMessages?.()) || [];
    if (followUp.length > 0) {
      pendingMessages = followUp;
      continue; // 回到外层循环
    }

    break; // 没有更多消息，退出
  }

  emit({ type: "agent_end", messages: newMessages });
}
```

---

## 8. 事件流的完整时序

一次典型的工具调用轮次产生以下事件序列:

```
turn_start
  message_start          (assistant message 开始流式)
  message_update × N     (文本/工具调用 delta)
  message_end            (assistant message 完成)
  tool_execution_start   (工具 A 开始)
  tool_execution_update  (工具 A 进度) × N
  tool_execution_end     (工具 A 完成)
  tool_execution_start   (工具 B 开始)
  tool_execution_end     (工具 B 完成)
  message_start          (ToolResultMessage A)
  message_end
  message_start          (ToolResultMessage B)
  message_end
turn_end
```

如果是并行模式，`tool_execution_start` 会在准备阶段依次发射，但 `tool_execution_end` 按完成顺序发射 (谁先完成谁先发)。`message_start/end` (ToolResultMessage) 始终按源顺序发射。

---

## 9. 与 AI SDK 的对比

| 特性       | AI SDK (Vercel)                        | Pi                                                            |
| ---------- | -------------------------------------- | ------------------------------------------------------------- |
| 工具定义   | `tool()` helper + Zod schema           | `AgentTool` interface + TypeBox schema                        |
| 参数校验   | SDK 内部自动校验                       | `validateToolArguments()` 显式调用                            |
| 参数预处理 | 无                                     | `prepareArguments()` 在校验前修正参数                         |
| 执行前拦截 | `needsApproval` (审批流)               | `beforeToolCall` hook (通用拦截)                              |
| 执行后处理 | `experimental_onToolCallFinish` (观察) | `afterToolCall` hook (可修改结果)                             |
| 进度更新   | `AsyncIterable` (yield 中间结果)       | `onUpdate` 回调 + `tool_execution_update` 事件                |
| 并行控制   | 默认并行 (Promise.all)                 | 全局 + 每工具粒度控制，any sequential forces batch sequential |
| 终止控制   | `stopWhen` + step count                | `terminate` 字段 + 全票制批次终止                             |
| 错误处理   | `tool-error` content part              | `isError` 标记 + 错误 `content`                               |

Pi 的设计更侧重于 **钩子的可编程性** (beforeToolCall/afterToolCall 可以修改行为)，而 AI SDK 更侧重于 **声明式配置** (needsApproval, toolChoice)。两者的核心循环结构相似: stream -> detect tool calls -> execute -> feed results back -> loop。

---

## 动手练习

1. **运行 demo 的 7 个场景，观察三阶段管线的完整执行**

   ```bash
   npx tsx src/demo.ts
   ```

   demo 包含 7 个场景: 正常工具调用、工具未找到、schema 校验失败、beforeToolCall 拦截、afterToolCall 修改结果、并行执行、批次终止。逐一观察每个场景的事件输出，对照课程中的 `tool_execution_start -> tool_execution_update -> tool_execution_end` 时序图，确认事件顺序符合预期。

2. **添加一个新工具并集成到 agent loop**
   在 `code/src/tools/` 中创建一个 `calculator.ts`，定义一个 `calculator` 工具，接受 `expression: string` 参数，用 `eval()` 计算结果并返回。将它注册到 `demo.ts` 的 tools 数组中，然后发送一个需要计算的 prompt（如 "计算 123 \* 456 + 789"），验证模型能正确调用你的工具:

   ```bash
   npx tsx src/demo.ts calculator
   ```

   检查输出中是否包含 `tool_execution_start` 和 `tool_execution_end` 事件，以及计算结果是否正确。

3. **测试 beforeToolCall 拦截功能**
   修改 `demo.ts` 中的 `beforeToolCall` 钩子，当工具名为 `"bash"` 且参数中包含 `rm` 关键字时返回 `{ block: true, reason: "Dangerous command blocked" }`。然后发送一个 prompt 让模型尝试执行 `rm -rf /tmp/test`，验证工具调用被阻止:

   ```bash
   npx tsx src/demo.ts block
   ```

   确认输出中出现 "Dangerous command blocked" 错误消息，且没有实际执行命令。

4. **对比并行与顺序执行的性能差异**
   修改 `demo.ts`，构造一个场景让模型同时调用两个耗时工具（各 sleep 1 秒）。分别设置 `toolExecution: "parallel"` 和 `toolExecution: "sequential"`，对比两种模式的总执行时间:
   ```bash
   npx tsx src/demo.ts parallel
   npx tsx src/demo.ts sequential
   ```
   并行模式应在约 1 秒内完成，顺序模式应在约 2 秒内完成。

---

## 10. 小结

本课覆盖了工具调用执行引擎的完整实现:

1. **三阶段管线** 把关注点清晰分离: prepare 处理查找/校验/拦截，execute 处理实际运行，finalize 处理结果后处理
2. **prepare 阶段** 的 `prepareArguments` 在 schema 校验前修正参数，`beforeToolCall` 在执行前提供拦截点
3. **execute 阶段** 通过 `onUpdate` 回调支持进度更新，通过 try/catch 保证异常安全
4. **finalize 阶段** 的 `afterToolCall` 使用字段级覆盖语义 (非深度合并)
5. **并行 vs 顺序** 由全局 `toolExecution` 和每工具 `executionMode` 共同决定，任何 sequential 工具会让整个批次顺序执行
6. **批次终止** 采用全票制: 所有工具都同意终止才真正终止
7. **完整循环** 形成 stream -> tool calls -> execute -> results -> loop 的闭环

下一课我们将深入 steering messages 和 follow-up messages 队列，理解 agent 如何在运行中接受外部输入。
