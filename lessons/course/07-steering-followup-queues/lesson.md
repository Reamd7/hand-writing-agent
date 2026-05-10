# 第七课: Steering 与 Follow-up 队列

## 概述

前几课我们实现了 Agent 的状态管理、事件模型和基础循环。但到目前为止，Agent 只能处理单轮 prompt: 用户发消息，Agent 完成所有工具调用后停止。真实场景中还需要两种能力:

1. **运行中修正 (steering)**: Agent 正在执行时，用户输入新指令，Agent 在当前 turn 结束后立即注入并继续
2. **运行后追加 (follow-up)**: Agent 完成所有工作后，队列中还有待处理的消息，自动继续而不是停止

Pi 的方案是 **双循环架构 + 两级消息队列**。内层循环处理工具调用和 steering 消息，外层循环检查 follow-up 消息。两个队列都通过 `PendingMessageQueue` 类管理，支持 `"all"` 和 `"one-at-a-time"` 两种 drain 模式。

本课目标:

1. 理解双循环 (double loop) 架构的设计和执行流程
2. 掌握 `PendingMessageQueue` 的两种 drain 模式
3. 理解 steering 队列和 follow-up 队列各自的注入时机
4. 理解 `shouldStopAfterTurn` 钩子的作用
5. 掌握 Agent 类的完整公共 API: `prompt()`, `continue()`, `steer()`, `followUp()`, `abort()`, `waitForIdle()`
6. 理解 `runWithLifecycle()` 的 AbortController 管理和失败合成
7. 理解上下文快照隔离: loop snapshot vs `Agent._state.messages`

---

## 1. PendingMessageQueue: 两种 drain 模式

`PendingMessageQueue` 是一个简单但关键的数据结构。它有两种模式:

- **`"all"`**: `drain()` 一次性返回队列中所有消息，然后清空队列
- **`"one-at-a-time"`**: `drain()` 只返回队列中第一条消息，剩余消息留在队列中

```typescript
type QueueMode = "all" | "one-at-a-time";

class PendingMessageQueue {
  private messages: AgentMessage[] = [];

  constructor(public mode: QueueMode) {}

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  hasItems(): boolean {
    return this.messages.length > 0;
  }

  drain(): AgentMessage[] {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    // "one-at-a-time": 只取第一条
    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear(): void {
    this.messages = [];
  }
}
```

### 为什么需要两种模式?

**`"all"` 模式**: 适合批量注入。比如用户连续输入了三条修正指令，`drain()` 一次全部取出，作为三条 user message 注入到上下文中，然后 Agent 只做一次 LLM 调用来回应所有修正。

**`"one-at-a-time"` 模式 (默认)**: 适合逐条处理。每次 `drain()` 只取一条消息。Agent 回应完这条消息后，下一次循环再取下一条。这样每条消息都能得到独立的 assistant 响应。

Pi 的默认值是两个队列都使用 `"one-at-a-time"`:

```typescript
this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
```

---

## 2. 双循环架构

`runLoop()` 是 Agent 循环的核心。它包含两层 `while` 循环:

```
外层循环 (follow-up loop):
  while (true) {
    内层循环 (steering + tool call loop):
      while (hasMoreToolCalls || pendingMessages.length > 0) {
        注入 pendingMessages
        调用 LLM
        执行 tool calls
        检查 shouldStopAfterTurn
        pendingMessages = getSteeringMessages()
      }
    // 内层循环结束 -- Agent 本来要停止了
    followUpMessages = getFollowUpMessages()
    if (有 follow-up) {
      pendingMessages = followUpMessages
      continue  // 回到外层循环, 重新进入内层
    }
    break  // 没有 follow-up, 真正停止
  }
```

### 内层循环: tool calls + steering

内层循环的继续条件是 `hasMoreToolCalls || pendingMessages.length > 0`:

- **`hasMoreToolCalls`**: 上一次 assistant 响应包含 tool calls，执行完毕后需要再次调用 LLM 让它处理 tool results
- **`pendingMessages.length > 0`**: steering 队列中有消息需要注入

每次内层循环迭代:

1. 注入 pending messages (如果有)
2. 调用 LLM 获取 assistant 响应
3. 如果响应是 error/aborted，立即退出整个循环
4. 执行 tool calls (如果有)
5. emit `turn_end`
6. 检查 `shouldStopAfterTurn` -- 如果返回 true，立即退出
7. poll `getSteeringMessages()` -- 如果有消息，设置为 pendingMessages，内层循环继续

### 外层循环: follow-up

当内层循环结束 (没有更多 tool calls，也没有 steering 消息)，Agent 本来会停止。此时外层循环 poll `getFollowUpMessages()`:

- 如果有 follow-up 消息: 设置为 pendingMessages，`continue` 回到外层循环，重新进入内层循环
- 如果没有: `break`，Agent 真正停止

### 完整伪代码

```typescript
async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<void> {
  let firstTurn = true;
  // 初始 steering poll -- 用户可能在等待期间已经输入了消息
  let pendingMessages = await config.getSteeringMessages?.() || [];

  // 外层循环: follow-up
  while (true) {
    let hasMoreToolCalls = true;

    // 内层循环: tool calls + steering
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // 注入 pending messages
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // 流式获取 assistant 响应
      const message = await streamAssistantResponse(
        currentContext, config, signal, emit
      );
      newMessages.push(message);

      // 错误/中止 -> 立即退出
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // 执行 tool calls
      const toolCalls = message.content.filter(c => c.type === "toolCall");
      hasMoreToolCalls = false;
      const toolResults = [];
      if (toolCalls.length > 0) {
        const batch = await executeToolCalls(...);
        toolResults.push(...batch.messages);
        hasMoreToolCalls = !batch.terminate;
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      // shouldStopAfterTurn 钩子
      if (await config.shouldStopAfterTurn?.({ message, toolResults, ... })) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Steering poll
      pendingMessages = await config.getSteeringMessages?.() || [];
    }

    // 内层循环结束 -- 检查 follow-up
    const followUpMessages = await config.getFollowUpMessages?.() || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;  // 回到外层循环
    }

    break;  // 没有 follow-up, 真正停止
  }

  await emit({ type: "agent_end", messages: newMessages });
}
```

---

## 3. Steering 队列: 运行中注入

Steering 的典型场景: Agent 正在执行一系列工具调用 (比如读取文件、搜索代码)，用户发现方向不对，输入 "不要搜索 tests 目录" 或 "用另一种方法"。

### 注入时机

Steering 消息在两个时间点被 poll:

1. **循环开始前 (初始 poll)**: `runLoop` 第一行就调用 `getSteeringMessages()`。这是因为用户可能在 Agent 启动前就已经排队了消息。
2. **每次 turn 结束后**: 在 `shouldStopAfterTurn` 检查之后，调用 `getSteeringMessages()`。如果有消息，内层循环继续。

### Agent 层的 steer() 方法

```typescript
class Agent {
  private readonly steeringQueue: PendingMessageQueue;

  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }
}
```

`steer()` 只是把消息放入队列。实际注入发生在循环的 `getSteeringMessages()` poll。这意味着:

- `steer()` 可以在任何时候调用 (甚至在 Agent 还在流式响应时)
- 消息不会中断当前的 assistant 响应或工具执行
- 只有在当前 turn 完成后，steering 消息才被注入
- 注入后 Agent 会多做一次 LLM 调用来处理注入的消息

### getSteeringMessages 闭包

`createLoopConfig()` 将 `steeringQueue.drain()` 封装为闭包传给循环:

```typescript
private createLoopConfig(
  options: { skipInitialSteeringPoll?: boolean } = {}
): AgentLoopConfig {
  let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
  return {
    // ...
    getSteeringMessages: async () => {
      if (skipInitialSteeringPoll) {
        skipInitialSteeringPoll = false;
        return [];
      }
      return this.steeringQueue.drain();
    },
    getFollowUpMessages: async () => this.followUpQueue.drain(),
  };
}
```

`skipInitialSteeringPoll` 机制: 当 `continue()` 发现最后一条消息是 assistant 消息时，它自己从 steering 队列 drain 消息并作为 prompt 传入 `runPromptMessages()`。为了避免 `runLoop` 再次 drain 一个已经空的队列 (或者意外 drain 到后续入队的消息)，传入 `skipInitialSteeringPoll: true`。

---

## 4. Follow-up 队列: 运行后追加

Follow-up 的典型场景: Agent 完成了一个任务后，系统需要自动追加下一步操作。比如 CI 集成中，Agent 修复了 bug 后自动追加 "运行测试" 的消息。

### 与 steering 的区别

| 特性     | Steering                    | Follow-up                                |
| -------- | --------------------------- | ---------------------------------------- |
| 注入时机 | 每次 turn 结束后            | Agent 准备停止时                         |
| 优先级   | 高 -- 在 follow-up 之前检查 | 低 -- 只在没有 steering 和 tool calls 时 |
| 典型场景 | 用户中途修正                | 系统自动追加下一步                       |
| 默认模式 | `"one-at-a-time"`           | `"one-at-a-time"`                        |

### 注入流程

```
内层循环结束 (无 tool calls, 无 steering)
  |
  v
poll getFollowUpMessages()
  |
  +--> 有消息 --> 设为 pendingMessages --> continue 外层循环
  |                                         |
  |                                         v
  |                                    内层循环重新开始
  |                                    (注入 follow-up 消息, 调用 LLM, ...)
  |
  +--> 无消息 --> break --> emit agent_end
```

### Agent 层的 followUp() 方法

```typescript
followUp(message: AgentMessage): void {
  this.followUpQueue.enqueue(message);
}
```

与 `steer()` 完全对称。唯一的区别在于循环中的 poll 时机不同。

---

## 5. shouldStopAfterTurn 钩子

`shouldStopAfterTurn` 是一个可选钩子，在每次 `turn_end` 之后、steering poll 之前调用。如果它返回 `true`，Agent 立即 emit `agent_end` 并退出，跳过所有队列检查。

```typescript
interface AgentLoopConfig {
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
}

interface ShouldStopAfterTurnContext {
  message: AssistantMessage; // 刚完成的 assistant 消息
  toolResults: ToolResultMessage[]; // 本 turn 的工具结果
  context: AgentContext; // 当前上下文
  newMessages: AgentMessage[]; // 本次运行产生的所有新消息
}
```

典型用途:

- **上下文窗口保护**: 当 context 接近 token 上限时强制停止
- **任务边界**: 检测到特定的 tool result (如 "task complete" 信号) 后停止
- **安全限制**: 限制最大 turn 数

注意: `shouldStopAfterTurn` 的检查在 steering poll **之前**。这意味着即使 steering 队列中有消息，如果钩子说停，Agent 就停。这是一个有意的设计 -- 安全限制优先于用户的 steering 请求。

---

## 6. Agent 类公共 API

### prompt()

```typescript
async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
  if (this.activeRun) {
    throw new Error("Agent is already processing a prompt.");
  }
  const messages = this.normalizePromptInput(input, images);
  await this.runPromptMessages(messages);
}
```

`prompt()` 是最常用的入口。它:

1. 检查互斥: 如果已经有 activeRun，抛异常
2. 标准化输入: 字符串变 UserMessage，单条消息变数组
3. 调用 `runPromptMessages()` 启动循环

### continue()

```typescript
async continue(): Promise<void> {
  if (this.activeRun) throw new Error("Agent is already processing.");

  const lastMessage = this._state.messages[this._state.messages.length - 1];
  if (!lastMessage) throw new Error("No messages to continue from");

  if (lastMessage.role === "assistant") {
    // 尝试 drain steering 消息作为 prompt
    const queuedSteering = this.steeringQueue.drain();
    if (queuedSteering.length > 0) {
      await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
      return;
    }
    // 尝试 drain follow-up 消息作为 prompt
    const queuedFollowUps = this.followUpQueue.drain();
    if (queuedFollowUps.length > 0) {
      await this.runPromptMessages(queuedFollowUps);
      return;
    }
    throw new Error("Cannot continue from message role: assistant");
  }

  // 最后一条消息是 user 或 toolResult -- 直接继续
  await this.runContinuation();
}
```

`continue()` 的逻辑比 `prompt()` 复杂。当最后一条消息是 assistant 时，不能直接让 LLM 继续 (LLM 需要 user/toolResult 消息作为输入)。所以 `continue()` 先尝试从队列 drain 消息:

1. 先看 steering 队列 -- 如果有消息，用它们作为 prompt 启动新循环
2. 再看 follow-up 队列 -- 同理
3. 都没有 -- 抛异常

### abort() 和 waitForIdle()

```typescript
abort(): void {
  this.activeRun?.abortController.abort();
}

waitForIdle(): Promise<void> {
  return this.activeRun?.promise ?? Promise.resolve();
}
```

`abort()` 触发 AbortController 的 signal。这会:

- 中断正在进行的 LLM 流式响应
- 中断正在执行的工具调用 (如果它们检查 signal)
- 在循环中产生 `stopReason: "aborted"` 的 assistant message

`waitForIdle()` 返回 activeRun 的 promise。这个 promise 在 `finishRun()` 中 resolve。`finishRun()` 在 `agent_end` 的所有 listener 执行完毕后才调用。所以 `waitForIdle()` 的 resolve 意味着:

- 所有事件已经发出
- 所有 listener 已经执行完毕
- `isStreaming` 已经变为 `false`

---

## 7. runWithLifecycle(): 运行生命周期管理

`runWithLifecycle()` 是所有运行的外壳。它管理 AbortController、isStreaming 状态和失败合成:

```typescript
private async runWithLifecycle(
  executor: (signal: AbortSignal) => Promise<void>
): Promise<void> {
  if (this.activeRun) throw new Error("Agent is already processing.");

  // 1. 创建 AbortController 和 promise
  const abortController = new AbortController();
  let resolvePromise = () => {};
  const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
  this.activeRun = { promise, resolve: resolvePromise, abortController };

  // 2. 设置运行时状态
  this._state.isStreaming = true;
  this._state.streamingMessage = undefined;
  this._state.errorMessage = undefined;

  try {
    // 3. 执行循环
    await executor(abortController.signal);
  } catch (error) {
    // 4. 失败合成
    await this.handleRunFailure(error, abortController.signal.aborted);
  } finally {
    // 5. 清理
    this.finishRun();
  }
}
```

### 失败合成 (handleRunFailure)

当 executor 抛出异常时 (比如 `convertToLlm` 出错、网络完全不可用等)，`handleRunFailure()` 构造一个合成的 assistant message，然后走完整的事件序列:

```typescript
private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
  const failureMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    model: this._state.model.id,
    provider: this._state.model.provider,
    usage: EMPTY_USAGE,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
  await this.processEvents({ type: "message_start", message: failureMessage });
  await this.processEvents({ type: "message_end", message: failureMessage });
  await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
  await this.processEvents({ type: "agent_end", messages: [failureMessage] });
}
```

为什么要合成事件? 因为 listener 可能依赖看到完整的 `message_start -> message_end -> turn_end -> agent_end` 序列来更新 UI。如果 executor 异常后直接跳到 `finishRun()`，listener 会遗漏事件，导致 UI 状态不一致。

### finishRun()

```typescript
private finishRun(): void {
  this._state.isStreaming = false;
  this._state.streamingMessage = undefined;
  this._state.pendingToolCalls = new Set<string>();
  this.activeRun?.resolve();
  this.activeRun = undefined;
}
```

`finishRun()` 在 `finally` 块中调用，保证无论成功还是失败都会执行。它:

1. 清理运行时状态
2. resolve activeRun promise (唤醒 `waitForIdle()` 的等待者)
3. 清除 activeRun 引用 (允许下一次 `prompt()` 或 `continue()`)

---

## 8. 上下文快照隔离

Agent 运行循环时，存在两份 messages 数组:

1. **Loop snapshot**: `createContextSnapshot()` 创建的浅拷贝，循环内部直接 push
2. **Agent.\_state.messages**: 通过 `processEvents()` 的 `message_end` 事件间接 push

```typescript
private createContextSnapshot(): AgentContext {
  return {
    systemPrompt: this._state.systemPrompt,
    messages: this._state.messages.slice(),  // 浅拷贝!
    tools: this._state.tools.slice(),
  };
}
```

为什么要两份?

- **Loop snapshot** 是循环的工作副本。循环在 LLM 流式响应过程中就要操作这个数组 (比如 push partial message，替换为 final message)。这些中间操作不应该反映到 Agent 的公共状态中。
- **Agent.\_state.messages** 是公共状态。它只在 `processEvents()` 处理 `message_end` 事件时才 push 完整的消息。这保证了公共状态始终包含的是最终确认的消息。

两者在运行期间各自独立增长，但最终包含相同的消息 (只是 loop snapshot 可能包含被中间替换的 partial message 引用)。

---

## 9. 完整伪代码汇总

### PendingMessageQueue

```typescript
class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  constructor(public mode: "all" | "one-at-a-time") {}

  enqueue(msg: AgentMessage): void {
    this.messages.push(msg);
  }
  hasItems(): boolean {
    return this.messages.length > 0;
  }
  clear(): void {
    this.messages = [];
  }

  drain(): AgentMessage[] {
    if (this.mode === "all") {
      const all = this.messages.slice();
      this.messages = [];
      return all;
    }
    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }
}
```

### Agent (队列相关部分)

```typescript
class Agent {
  private steeringQueue = new PendingMessageQueue("one-at-a-time");
  private followUpQueue = new PendingMessageQueue("one-at-a-time");
  private activeRun?: ActiveRun;

  steer(msg: AgentMessage): void { this.steeringQueue.enqueue(msg); }
  followUp(msg: AgentMessage): void { this.followUpQueue.enqueue(msg); }
  abort(): void { this.activeRun?.abortController.abort(); }
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  async prompt(input: ...): Promise<void> {
    if (this.activeRun) throw new Error("Already processing");
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(messages, snapshot, loopConfig, emit, signal);
    });
  }

  async continue(): Promise<void> {
    if (this.activeRun) throw new Error("Already processing");
    // 如果最后消息是 assistant: 尝试 drain steering -> follow-up -> 报错
    // 否则: 直接继续
  }

  private async runWithLifecycle(executor): Promise<void> {
    const ac = new AbortController();
    this.activeRun = { promise, resolve, abortController: ac };
    this._state.isStreaming = true;
    try {
      await executor(ac.signal);
    } catch (error) {
      await this.handleRunFailure(error, ac.signal.aborted);
    } finally {
      this.finishRun();
    }
  }
}
```

### Double Loop (runLoop)

```typescript
async function runLoop(context, newMessages, config, signal, emit): Promise<void> {
  let firstTurn = true;
  let pendingMessages = await config.getSteeringMessages?.() || [];

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) await emit({ type: "turn_start" });
      else firstTurn = false;

      // 注入 pending
      for (const msg of pendingMessages) {
        await emit({ type: "message_start", message: msg });
        await emit({ type: "message_end", message: msg });
        context.messages.push(msg);
        newMessages.push(msg);
      }
      pendingMessages = [];

      // LLM 调用
      const message = await streamAssistantResponse(...);
      newMessages.push(message);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Tool calls
      hasMoreToolCalls = false;
      const toolCalls = message.content.filter(c => c.type === "toolCall");
      if (toolCalls.length > 0) {
        const batch = await executeToolCalls(...);
        hasMoreToolCalls = !batch.terminate;
        // push results to context
      }

      await emit({ type: "turn_end", message, toolResults });

      if (await config.shouldStopAfterTurn?.(...)) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = await config.getSteeringMessages?.() || [];
    }

    const followUps = await config.getFollowUpMessages?.() || [];
    if (followUps.length > 0) {
      pendingMessages = followUps;
      continue;
    }
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}
```

---

## 动手练习

1. **运行 demo 的 4 个场景，观察双循环和队列行为**

   ```bash
   npx tsx src/demo.ts
   ```

   demo 包含 4 个场景: 基础 prompt、steering 注入、follow-up 追加、abort 中断。重点观察 steering 场景中消息的注入时机 -- 它应该在当前 turn 结束后、下一次 LLM 调用前被注入。对比 steering 和 follow-up 的 poll 时机差异。

2. **实现一个 shouldStopAfterTurn 钩子限制最大 turn 数**
   在 `demo.ts` 中添加一个 `shouldStopAfterTurn` 实现，用闭包维护一个 turn 计数器，当 turn 数超过 3 时返回 `true` 强制停止。然后构造一个需要多轮工具调用的 prompt（如 "依次读取 5 个文件"），验证 agent 在第 3 轮后停止:

   ```bash
   npx tsx src/demo.ts max-turns
   ```

   确认输出中只有 3 次 `turn_end` 事件，且最后一个事件后紧跟 `agent_end`。

3. **测试 steering 在工具执行期间的行为**
   修改 demo，在一个耗时工具执行过程中调用 `agent.steer()`。验证 steering 消息不会中断当前工具执行，而是在 turn 结束后才被注入:

   ```bash
   npx tsx src/demo.ts steer-during-tool
   ```

   观察事件时序: `tool_execution_start -> tool_execution_end -> turn_end -> message_start (steering message) -> message_end`。确认 steering 消息出现在 `turn_end` 之后。

4. **测试 "one-at-a-time" 与 "all" drain 模式的差异**
   修改 `demo.ts`，向 follow-up 队列连续入队 3 条消息。分别以 `followUpMode: "one-at-a-time"` 和 `followUpMode: "all"` 运行，对比两种模式下 agent 的 LLM 调用次数:
   ```bash
   npx tsx src/demo.ts drain-one
   npx tsx src/demo.ts drain-all
   ```
   `"one-at-a-time"` 模式应产生 3 次独立的 assistant 响应，`"all"` 模式应只产生 1 次（一次性注入全部消息）。

---

## 总结

| 概念                        | 作用                                                    |
| --------------------------- | ------------------------------------------------------- |
| `PendingMessageQueue`       | 统一的消息队列，支持 `"all"` 和 `"one-at-a-time"` drain |
| Steering 队列               | 运行中注入消息，每次 turn 结束后 poll                   |
| Follow-up 队列              | 运行后追加消息，仅在 Agent 准备停止时 poll              |
| 双循环                      | 内层处理 tool calls + steering，外层处理 follow-up      |
| `shouldStopAfterTurn`       | 安全钩子，优先级高于队列                                |
| `runWithLifecycle()`        | AbortController 管理 + 失败合成 + 清理                  |
| 上下文快照                  | loop 和 Agent.\_state 各持有独立的 messages 数组        |
| `prompt()` / `continue()`   | 互斥入口，不能同时运行两个                              |
| `steer()` / `followUp()`    | 非阻塞入队，可在任何时候调用                            |
| `abort()` / `waitForIdle()` | 协作式取消和等待                                        |

下一课我们将实现上下文管理: 当对话历史超过模型的上下文窗口时，如何自动裁剪消息、注入外部上下文，以及 `transformContext` 和 `convertToLlm` 的完整流水线。
