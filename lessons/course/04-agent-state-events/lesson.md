# 第四课: Agent 状态与事件模型

## 概述

前三课我们了解了项目架构、AI SDK 的消息模型和 Provider 管理。从这一课开始，我们进入 Agent 层 -- `packages/agent`。

一个 Agent 在运行时需要管理大量状态: 系统提示词、当前模型、可用工具、对话历史、流式消息、正在执行的工具调用、错误信息。同时，外部 UI 需要实时感知这些状态的变化。Pi 的方案是: **事件驱动 + 状态归约 (state reducer)**。低层循环产生事件，`processEvents()` 根据事件更新内部状态，然后依次通知所有订阅者。

本课目标:

1. 理解 `AgentState` 的公共接口和 `MutableAgentState` 的内部可写版本
2. 掌握 `AgentEvent` 判别联合类型 (discriminated union) 的全部 10 个变体
3. 理解订阅者模型 (`subscribe` / `unsubscribe`)
4. 理解 `processEvents()` 作为状态归约器的工作方式
5. 动手实现简化版的类型定义和 Agent 骨架

---

## 1. AgentState: 公共状态接口

Agent 的公共状态通过 `AgentState` 接口暴露。它是只读的 -- 外部代码可以读取状态，但不能直接修改流式状态和错误信息。

```typescript
interface AgentState {
  // --- 可配置字段 (外部可通过赋值修改) ---
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  set tools(tools: AgentTool<any>[]);
  get tools(): AgentTool<any>[];
  set messages(messages: AgentMessage[]);
  get messages(): AgentMessage[];

  // --- 运行时只读字段 (仅 Agent 内部修改) ---
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

### 设计要点

**为什么 `tools` 和 `messages` 是 accessor properties?**

```typescript
set tools(nextTools: AgentTool<any>[]) {
  tools = nextTools.slice(); // 浅拷贝
}
```

外部赋值时进行 `.slice()` 浅拷贝，防止外部持有的数组引用意外修改 Agent 内部状态。这是一种 "clone-on-set" 策略。

**为什么 `pendingToolCalls` 是 `ReadonlySet<string>`?**

公共 API 只需要检查某个工具调用是否正在执行 (`has`)，不需要添加或删除。用 `ReadonlySet` 既表达了语义，又在类型层面阻止了外部修改。

**`isStreaming` 的生命周期**

`isStreaming` 在调用 `prompt()` 或 `continue()` 时变为 `true`，在 `agent_end` 事件的所有监听器执行完毕后才变为 `false`。注意: `agent_end` 监听器运行期间 `isStreaming` 仍然是 `true`。

---

## 2. MutableAgentState: 内部可写版本

Agent 内部需要修改 `isStreaming`、`streamingMessage` 等字段。Pi 通过类型映射定义了一个可写版本:

```typescript
type MutableAgentState = Omit<
  AgentState,
  "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>; // 可写的 Set，不是 ReadonlySet
  errorMessage?: string;
};
```

`Omit` 去掉了 `AgentState` 中的 `readonly` 字段，然后用 `&` 交叉类型添加了可写版本。这样:

- 对外暴露 `AgentState` (通过 `get state()` getter)，只读
- 对内使用 `MutableAgentState`，可自由写入

工厂函数 `createMutableAgentState()` 负责初始化:

```typescript
function createMutableAgentState(
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >,
): MutableAgentState {
  let tools = initialState?.tools?.slice() ?? [];
  let messages = initialState?.messages?.slice() ?? [];

  return {
    systemPrompt: initialState?.systemPrompt ?? "",
    model: initialState?.model ?? DEFAULT_MODEL,
    thinkingLevel: initialState?.thinkingLevel ?? "off",
    get tools() {
      return tools;
    },
    set tools(next) {
      tools = next.slice();
    },
    get messages() {
      return messages;
    },
    set messages(next) {
      messages = next.slice();
    },
    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
}
```

关键: `tools` 和 `messages` 使用闭包变量 + getter/setter 实现 clone-on-set。这是 JavaScript 对象字面量中定义 accessor properties 的标准方式。

---

## 3. AgentEvent: 判别联合类型

`AgentEvent` 是一个 TypeScript 判别联合类型 (discriminated union)，以 `type` 作为判别属性 (discriminant)。它定义了 Agent 生命周期中的全部 10 种事件:

```typescript
type AgentEvent =
  // Agent 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn 生命周期 (一个 turn = 一次 assistant 响应 + 对应的工具调用/结果)
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message 生命周期
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool 执行生命周期
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: any;
      partialResult: any;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: any;
      isError: boolean;
    };
```

### 事件层级关系

```
agent_start
  turn_start
    message_start (user message)
    message_end   (user message)
    message_start (assistant message - 流式开始)
    message_update (assistant message - 流式更新, 多次)
    message_end   (assistant message - 流式结束)
    tool_execution_start (工具开始执行)
    tool_execution_update (工具执行中间更新, 可选)
    tool_execution_end   (工具执行完成)
    message_start (toolResult message)
    message_end   (toolResult message)
  turn_end
  turn_start       (如果有更多工具调用或 steering 消息)
    ...
  turn_end
agent_end
```

### 判别联合的类型收窄

```typescript
function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case "agent_start":
      // event 被收窄为 { type: "agent_start" }
      break;
    case "message_update":
      // event 被收窄为 { type: "message_update"; message: AgentMessage; ... }
      console.log(event.assistantMessageEvent); // 类型安全
      break;
    case "tool_execution_end":
      // event 被收窄为 { type: "tool_execution_end"; toolCallId: string; ... }
      console.log(event.isError); // 类型安全
      break;
  }
}
```

TypeScript 编译器在 `switch` 的每个 `case` 分支中自动将 `event` 收窄 (narrow) 为对应的具体类型。如果访问了某个变体不存在的字段，编译器会报错。

### 穷尽性检查 (Exhaustiveness Check)

```typescript
function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`);
}

function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case "agent_start":
      break;
    case "agent_end":
      break;
    // ... 其他 case
    default:
      assertNever(event); // 如果漏掉了某个变体，编译器会报错
  }
}
```

---

## 4. 订阅者模型

Agent 使用一种简洁的发布-订阅模式:

```typescript
class Agent {
  private readonly listeners = new Set<
    (event: AgentEvent, signal: AbortSignal) => Promise<void> | void
  >();

  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
```

### 设计要点

**返回取消订阅函数**

`subscribe()` 返回一个闭包，调用它即可取消订阅。不需要保存 listener 引用，不需要 `.off()` 方法:

```typescript
const unsub = agent.subscribe((event, signal) => {
  console.log(event.type);
});

// 稍后取消订阅
unsub();
```

**监听器按顺序 await**

```typescript
for (const listener of this.listeners) {
  await listener(event, signal);
}
```

监听器按添加顺序依次执行，每个都 `await`。这保证:

- 监听器 N 看到的状态与监听器 N-1 执行后一致
- 异步监听器 (如写入数据库、更新 UI) 不会互相竞争
- 整个事件处理是可预测的、确定性的

**AbortSignal 传播**

每个监听器接收当前运行的 `AbortSignal`。如果用户调用 `agent.abort()`，监听器可以检测到并跳过耗时操作:

```typescript
agent.subscribe(async (event, signal) => {
  if (signal.aborted) return; // 快速退出
  if (event.type === "message_end") {
    await saveToDatabase(event.message); // 耗时操作
  }
});
```

---

## 5. processEvents(): 状态归约器

`processEvents()` 是整个事件模型的核心。它是一个 **状态归约器 (state reducer)**: 接收一个事件，更新内部状态，然后通知所有订阅者。

```typescript
private async processEvents(event: AgentEvent): Promise<void> {
  // 第一步: 根据事件类型更新内部状态
  switch (event.type) {
    case "message_start":
      this._state.streamingMessage = event.message;
      break;

    case "message_update":
      this._state.streamingMessage = event.message;
      break;

    case "message_end":
      this._state.streamingMessage = undefined;
      this._state.messages.push(event.message);
      break;

    case "tool_execution_start": {
      const pending = new Set(this._state.pendingToolCalls);
      pending.add(event.toolCallId);
      this._state.pendingToolCalls = pending;
      break;
    }

    case "tool_execution_end": {
      const pending = new Set(this._state.pendingToolCalls);
      pending.delete(event.toolCallId);
      this._state.pendingToolCalls = pending;
      break;
    }

    case "turn_end":
      if (event.message.role === "assistant" && event.message.errorMessage) {
        this._state.errorMessage = event.message.errorMessage;
      }
      break;

    case "agent_end":
      this._state.streamingMessage = undefined;
      break;
  }

  // 第二步: 通知所有订阅者 (按顺序 await)
  const signal = this.activeRun?.abortController.signal;
  if (!signal) {
    throw new Error("Agent listener invoked outside active run");
  }
  for (const listener of this.listeners) {
    await listener(event, signal);
  }
}
```

### 状态转换规则

| 事件                                                 | 状态变更                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `message_start`                                      | `streamingMessage = event.message`                             |
| `message_update`                                     | `streamingMessage = event.message` (更新为最新的部分消息)      |
| `message_end`                                        | `streamingMessage = undefined`; `messages.push(event.message)` |
| `tool_execution_start`                               | `pendingToolCalls` 添加 `toolCallId`                           |
| `tool_execution_end`                                 | `pendingToolCalls` 移除 `toolCallId`                           |
| `turn_end`                                           | 如果 assistant message 有 `errorMessage`，设置 `errorMessage`  |
| `agent_end`                                          | `streamingMessage = undefined`                                 |
| `agent_start`, `turn_start`, `tool_execution_update` | 无状态变更 (仅通知监听器)                                      |

### 为什么 `pendingToolCalls` 要创建新 Set?

```typescript
case "tool_execution_start": {
  const pending = new Set(this._state.pendingToolCalls);
  pending.add(event.toolCallId);
  this._state.pendingToolCalls = pending;
  break;
}
```

每次修改都创建新的 `Set` 而不是在原 Set 上 `add/delete`。这是为了保证 **引用不可变性** -- 如果 UI 层缓存了 `pendingToolCalls` 的引用，新 Set 的创建会触发引用比较变化，从而触发重渲染。

---

## 6. Agent 类骨架

把上面的概念组合起来，Agent 类的核心结构如下:

```typescript
class Agent {
  // 内部可写状态
  private _state: MutableAgentState;
  // 订阅者集合
  private readonly listeners = new Set<
    (event: AgentEvent, signal: AbortSignal) => Promise<void> | void
  >();
  // 当前运行的上下文
  private activeRun?: {
    promise: Promise<void>;
    resolve: () => void;
    abortController: AbortController;
  };

  constructor(options?: AgentOptions) {
    this._state = createMutableAgentState(options?.initialState);
    // ... 初始化其他配置
  }

  // 公共状态访问
  get state(): AgentState {
    return this._state;
  }

  // 订阅事件
  subscribe(listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // 中止当前运行
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  // 等待当前运行完成
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  // 状态归约 + 通知
  private async processEvents(event: AgentEvent): Promise<void> {
    // 1. 更新 _state
    // 2. for-of listeners, await each
  }

  // 运行生命周期管理
  private async runWithLifecycle(executor): Promise<void> {
    // 1. 创建 AbortController
    // 2. 设置 isStreaming = true
    // 3. await executor(signal)
    // 4. finishRun() -- 清理运行时状态
  }

  // prompt() 和 continue() -- 将在下一课实现
}
```

### 运行生命周期

```
prompt() / continue()
  |
  v
runWithLifecycle()
  |-- 创建 AbortController
  |-- isStreaming = true
  |-- errorMessage = undefined
  |
  +-- executor(signal)
  |     |-- runAgentLoop() (第 5-6 课)
  |     |-- 通过回调调用 processEvents()
  |     +-- 循环结束
  |
  +-- finishRun()
        |-- isStreaming = false
        |-- streamingMessage = undefined
        |-- pendingToolCalls = new Set()
        +-- resolve activeRun promise
```

---

## 7. 实践: 手动推送事件验证状态变化

不需要实际的 LLM 调用，我们可以直接调用 `processEvents()` 来验证状态转换是否正确。这就是本课 `code/src/test.ts` 的思路:

```typescript
// 创建 Agent
const agent = new Agent();

// 订阅事件
const events: string[] = [];
agent.subscribe((event) => {
  events.push(event.type);
});

// 手动模拟一个完整运行
// 1. agent_start -> isStreaming 应该为 true
// 2. message_start -> streamingMessage 应该有值
// 3. message_end -> streamingMessage 为 undefined, messages 增加一条
// 4. agent_end -> 运行结束
```

这种测试方式的好处:

- 不依赖任何 LLM Provider
- 不需要网络请求
- 可以精确控制事件序列
- 验证每个事件的状态转换是否符合预期

---

## 总结

| 概念                | 作用                                          |
| ------------------- | --------------------------------------------- |
| `AgentState`        | 公共只读接口，UI 层消费                       |
| `MutableAgentState` | 内部可写版本，仅 Agent 和循环使用             |
| `AgentEvent`        | 判别联合，10 种生命周期事件                   |
| `subscribe()`       | 注册监听器，返回取消函数                      |
| `processEvents()`   | 状态归约器: 事件 -> 状态更新 -> 通知订阅者    |
| Clone-on-set        | `tools`/`messages` 赋值时浅拷贝，防止外部突变 |
| 引用不可变 Set      | `pendingToolCalls` 每次修改创建新 Set         |

下一课我们将实现 Agent Loop 的流式响应部分 -- 即低层循环如何调用 LLM、产生 `message_start/update/end` 事件，并将结果交给 `processEvents()` 处理。
