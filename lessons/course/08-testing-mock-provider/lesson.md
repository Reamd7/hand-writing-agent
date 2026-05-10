# 第八课: 测试 Agent 核心 -- Mock Provider

## 概述

前面几课我们构建了 Agent 的状态管理、事件模型和执行循环。现在面临一个关键问题: **如何测试这些代码?**

直接调用真实 LLM API 做测试存在严重问题:

- **不确定性**: 同一个 prompt 每次返回不同结果，断言无法精确匹配
- **网络依赖**: CI 环境可能没有网络，或者 API 限流/宕机导致测试不稳定
- **成本**: 每次运行测试都消耗 token，积少成多
- **速度**: 一次 API 调用需要几百毫秒到几秒，大规模测试套件会非常慢
- **工具调用不可控**: 无法精确控制模型何时调用工具、调用什么工具

解决方案是 **Mock Provider** -- 一个可脚本化的假 LLM，返回预设的确定性响应。本课将:

1. 分析 AI SDK 的 `MockLanguageModelV1` 设计
2. 深入 pi 的 `Faux Provider` 实现
3. 构建我们自己的简化版 Mock Provider
4. 编写 5 组测试用例覆盖核心 Agent 行为
5. 掌握端到端事件验证的方法论

---

## 1. 为什么需要 Mock Provider

### 测试金字塔中的位置

```
         /\
        /  \         E2E 测试 (真实 API, 少量)
       /----\
      /      \       集成测试 (Mock Provider, 大量)
     /--------\
    /          \     单元测试 (纯函数, 最多)
   /____________\
```

Mock Provider 主要服务于集成测试层: 验证 Agent 循环的逻辑 (状态转换、工具调用、多轮对话) 而不涉及真实的网络通信。

### Mock Provider 的三个核心保证

| 保证       | 说明                                                      |
| ---------- | --------------------------------------------------------- |
| **确定性** | 同样的输入永远产生同样的输出。可以用 `toEqual()` 精确断言 |
| **无网络** | 完全内存操作，毫秒级返回，CI 友好                         |
| **可控性** | 精确控制何时返回文本、何时触发工具调用、何时报错          |

---

## 2. AI SDK 的 MockLanguageModelV1

Vercel AI SDK 提供了 `MockLanguageModelV1`，用于测试 `generateText()` 和 `streamText()`:

```typescript
import { MockLanguageModelV1 } from "ai/test";
import { generateText } from "ai";

const result = await generateText({
  model: new MockLanguageModelV1({
    doGenerate: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 20 },
      text: "Hello, World!",
    }),
  }),
  prompt: "Say hello",
});

expect(result.text).toBe("Hello, World!");
```

### 模拟流式响应

```typescript
import { simulateReadableStream } from "ai/test";

new MockLanguageModelV1({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: "text-delta", textDelta: "Hello" },
        { type: "text-delta", textDelta: ", " },
        { type: "text-delta", textDelta: "World!" },
        { type: "finish", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 20 } },
      ],
      chunkDelayInMs: 50, // 模拟流式延迟
    }),
    rawCall: { rawPrompt: null, rawSettings: {} },
  }),
});
```

### 设计要点

- `doGenerate` 返回完整响应 (非流式)
- `doStream` 返回一个 `ReadableStream`，由 `simulateReadableStream` 构造
- `chunkDelayInMs` 控制 chunk 之间的延迟，模拟真实的流式体验
- 同一个 mock 可以同时提供 `doGenerate` 和 `doStream`

这种设计简洁有效，但它是在 AI SDK 的抽象层工作。Pi 需要在自己的 `AssistantMessage` / `AssistantMessageEvent` 层面 mock。

---

## 3. Pi 的 Faux Provider

Pi 在 `packages/ai/src/providers/faux.ts` 中实现了一个完整的 mock provider，称为 **Faux Provider**。它比 AI SDK 的 `MockLanguageModelV1` 更贴近 pi 的内部架构。

### 核心 API

```typescript
// 注册一个 faux provider，返回控制句柄
const faux = registerFauxProvider({
  tokensPerSecond: 100, // 模拟流式速度
});

// 预设响应队列
faux.setResponses([
  fauxAssistantMessage("Hello!"),
  fauxAssistantMessage(
    [fauxText("Let me check..."), fauxToolCall("read_file", { path: "/tmp/test.txt" })],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("The file contains test data."),
]);

// 获取模型 (用于传给 stream 函数)
const model = faux.getModel();
```

### 响应队列模型

Faux Provider 的核心是一个 **先进先出队列 (FIFO queue)**:

```typescript
let pendingResponses: FauxResponseStep[] = [];

// 每次 stream() 调用 shift 一个响应
const step = pendingResponses.shift();
```

每次 Agent 循环调用 `stream(model, context, options)` 时，Faux Provider 从队列头部取出下一个响应。如果队列为空，返回错误。

### 静态响应 vs 动态工厂

`FauxResponseStep` 是一个联合类型:

```typescript
type FauxResponseStep = AssistantMessage | FauxResponseFactory;

type FauxResponseFactory = (
  context: Context,
  options: StreamOptions | undefined,
  state: { callCount: number },
  model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;
```

- **静态响应**: 直接是一个 `AssistantMessage`，无论上下文如何都返回相同内容
- **动态工厂**: 一个函数，接收当前上下文和调用计数，动态生成响应

动态工厂在需要根据上下文做决策时非常有用:

```typescript
faux.setResponses([
  // 根据收到的消息数量决定是否继续调用工具
  (context, _options, state) => {
    if (context.messages.length < 5) {
      return fauxAssistantMessage(fauxToolCall("gather_more", {}), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("All data gathered.");
  },
]);
```

### 流式模拟

Faux Provider 不是直接返回完整消息，而是模拟真实的流式传输过程:

```typescript
async function streamWithDeltas(
  stream: AssistantMessageEventStream,
  message: AssistantMessage,
  minTokenSize: number,
  maxTokenSize: number,
  tokensPerSecond: number | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  // 1. 发送 start 事件
  stream.push({ type: "start", partial: { ...partial } });

  // 2. 遍历每个 content block
  for (const block of message.content) {
    if (block.type === "text") {
      // 把文本切分成 token 大小的 chunk
      stream.push({ type: "text_start", ... });
      for (const chunk of splitStringByTokenSize(block.text, min, max)) {
        await scheduleChunk(chunk, tokensPerSecond); // 模拟延迟
        stream.push({ type: "text_delta", delta: chunk, ... });
      }
      stream.push({ type: "text_end", ... });
    }

    if (block.type === "toolCall") {
      stream.push({ type: "toolcall_start", ... });
      // 把 arguments JSON 也切分成 chunk 逐步发送
      for (const chunk of splitStringByTokenSize(JSON.stringify(block.arguments), ...)) {
        stream.push({ type: "toolcall_delta", delta: chunk, ... });
      }
      stream.push({ type: "toolcall_end", toolCall: block, ... });
    }
  }

  // 3. 发送 done 事件
  stream.push({ type: "done", reason: message.stopReason, message });
  stream.end(message);
}
```

这意味着即使在测试中，事件序列也和真实 provider 完全一致: `start -> text_start -> text_delta* -> text_end -> done`。

### Token 和缓存模拟

`withUsageEstimate()` 函数根据消息长度估算 token 用量，并模拟 prompt caching:

```typescript
function withUsageEstimate(message, context, options, promptCache) {
  const promptText = serializeContext(context);
  const promptTokens = estimateTokens(promptText); // length / 4
  const outputTokens = estimateTokens(assistantContentToText(message.content));

  // 如果有 sessionId，计算缓存命中
  if (sessionId && options?.cacheRetention !== "none") {
    const previousPrompt = promptCache.get(sessionId);
    if (previousPrompt) {
      // 计算公共前缀长度 -> cacheRead
      // 新增部分 -> cacheWrite
    }
  }
}
```

这样测试可以验证 token 使用量和缓存行为，而不需要真实 API。

---

## 4. 我们的简化版 Mock Provider

理解了 AI SDK 和 pi 的方案后，我们来构建一个教学版的 Mock Provider。设计原则:

- **最简化**: 不模拟流式 delta，直接返回完整消息
- **可脚本化**: 响应队列 + 动态工厂
- **可观测**: 记录调用历史，暴露调用计数
- **自包含**: 包含一个简化的 Agent 循环用于端到端测试

### MockProvider 类

```typescript
export class MockProvider {
  private queue: MockResponseStep[] = [];
  private _callHistory: MockCallRecord[] = [];

  get callCount(): number {
    return this._callHistory.length;
  }

  get callHistory(): readonly MockCallRecord[] {
    return this._callHistory;
  }

  enqueue(...responses: MockResponseStep[]): void {
    this.queue.push(...responses);
  }

  stream(messages: Message[]): AssistantMessage {
    const step = this.queue.shift();
    if (!step) {
      // 队列为空 -> 返回错误
      const errorResponse = mockErrorResponse("No more responses in queue");
      this._callHistory.push({ messages: [...messages], response: errorResponse });
      return errorResponse;
    }

    const response =
      typeof step === "function"
        ? step({ messages: [...messages], callIndex: this._callHistory.length })
        : step;

    this._callHistory.push({ messages: [...messages], response });
    return response;
  }
}
```

关键设计决策:

1. **`stream()` 是同步的**: 真实 provider 返回事件流，但我们的测试不需要流式模拟，直接返回完整消息即可
2. **`messages` 做浅拷贝**: `[...messages]` 防止后续修改影响历史记录
3. **队列为空时返回错误而不是抛异常**: 这样 Agent 循环可以正常处理错误路径

### 消息工厂函数

```typescript
// 纯文本响应
export function mockTextResponse(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "mock-model",
    provider: "mock",
    usage: DEFAULT_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// 带工具调用的响应
export function mockToolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `tc_${Date.now()}`,
        name: toolName,
        arguments: args,
      },
    ],
    stopReason: "toolUse",
    // ...
  };
}

// 错误响应
export function mockErrorResponse(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage,
    // ...
  };
}
```

### 简化的 Agent 循环

```typescript
export async function runAgent(userMessage: string, config: AgentConfig): Promise<AgentRunResult> {
  const { provider, tools = [], maxTurns = 10, onBeforeTurn } = config;
  const events: AgentEvent[] = [];
  const messages: Message[] = [];

  // 初始用户消息
  messages.push({ role: "user", content: userMessage, timestamp: Date.now() });
  emit({ type: "agent_start" });

  let turns = 0;
  while (turns < maxTurns) {
    turns++;

    // Steering: 在 LLM 调用前注入消息
    if (onBeforeTurn) {
      const steering = onBeforeTurn([...messages]);
      if (steering) {
        messages.push({ role: "user", content: steering, timestamp: Date.now() });
        emit({ type: "steering", content: steering });
      }
    }

    emit({ type: "turn_start" });

    // 调用 provider
    const response = provider.stream(messages);

    // 处理错误
    if (response.stopReason === "error") {
      emit({ type: "error", error: response.errorMessage ?? "Unknown error" });
      emit({ type: "agent_end", messages });
      return { messages, events };
    }

    // 发送消息事件
    emit({ type: "message_start", message: response });
    emit({ type: "message_end", message: response });
    messages.push(response);

    // 提取工具调用
    const toolCalls = response.content.filter((b) => b.type === "toolCall");

    if (toolCalls.length === 0) {
      emit({ type: "turn_end", message: response });
      break; // 没有工具调用，循环结束
    }

    // 执行工具调用
    for (const tc of toolCalls) {
      emit({ type: "tool_call_start", toolCall: tc });

      const toolDef = tools.find((t) => t.name === tc.name);
      let result;

      if (!toolDef) {
        result = { content: `Tool "${tc.name}" not found`, isError: true };
      } else {
        try {
          result = await toolDef.execute(tc.arguments);
        } catch (err) {
          result = { content: err.message, isError: true };
        }
      }

      emit({ type: "tool_call_end", toolCall: tc, result });
      messages.push({
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: result.content,
        isError: result.isError,
        timestamp: Date.now(),
      });
    }

    emit({ type: "turn_end", message: response });
    // 继续循环，用更新后的 messages 调用 provider
  }

  emit({ type: "agent_end", messages });
  return { messages, events };
}
```

循环的核心逻辑:

1. 调用 `provider.stream(messages)` 获取响应
2. 如果响应包含工具调用，执行工具，把结果追加到 messages
3. 继续调用 provider，直到响应不含工具调用或达到 maxTurns

---

## 5. 测试用例设计

### 5.1 基本对话: prompt -> text response

最简单的场景: 用户发送消息，助手返回纯文本。

```typescript
describe("basic conversation", () => {
  it("returns a text response for a simple prompt", async () => {
    const agent = createTestAgent({
      responses: [mockTextResponse("Hello!")],
    });

    const result = await agent.run("Hi there");

    // 2 条消息: user + assistant
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ role: "user", content: "Hi there" });
    expect(result.messages[1]).toMatchObject({ role: "assistant", stopReason: "stop" });

    // Provider 只被调用了一次
    expect(agent.provider.callCount).toBe(1);
  });

  it("emits events in the correct order", async () => {
    const result = await agent.run("Hello");

    expect(eventTypes(result)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_delta",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });
});
```

**测试要点**:

- 验证消息数量和角色
- 验证 provider 调用次数
- 验证事件序列的精确顺序

### 5.2 单次工具调用: prompt -> tool call -> result -> final response

```typescript
describe("single tool call", () => {
  it("executes a tool call and returns the final response", async () => {
    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("read_file", { path: "/tmp/test.txt" }),
        mockTextResponse("The file contains: file content here"),
      ],
      tools: [createStaticTool("read_file", "file content here")],
    });

    const result = await agent.run("Read the test file");

    // 4 条消息: user -> assistant(toolCall) -> toolResult -> assistant(text)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("toolResult");
    expect(result.messages[3].role).toBe("assistant");

    // Provider 被调用了两次
    expect(agent.provider.callCount).toBe(2);
  });
});
```

**测试要点**:

- 预设 2 个响应: 第一个触发工具调用，第二个是最终文本
- 验证 4 条消息的角色顺序
- 验证工具结果被正确传回 provider

### 5.3 多步工具调用: 连续多轮工具调用

```typescript
describe("multi-step tool calls", () => {
  it("handles two consecutive tool call rounds", async () => {
    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("list_files", { dir: "/" }), // 第一轮
        mockToolCallResponse("read_file", { path: "/a.txt" }), // 第二轮
        mockTextResponse("File a.txt contains: content"), // 最终
      ],
      tools: [listFilesTool, readFileTool],
    });

    const result = await agent.run("List files then read a.txt");

    // 6 条消息: user -> tc1 -> result1 -> tc2 -> result2 -> text
    expect(result.messages).toHaveLength(6);
    expect(agent.provider.callCount).toBe(3);
  });

  it("handles multiple tool calls in a single response", async () => {
    const agent = createTestAgent({
      responses: [
        mockMultiToolCallResponse([
          { name: "read_file", args: { path: "/a.txt" }, id: "tc_1" },
          { name: "read_file", args: { path: "/b.txt" }, id: "tc_2" },
        ]),
        mockTextResponse("Both files read"),
      ],
      tools: [readFileTool],
    });

    const result = await agent.run("Read both files");

    // 5 条消息: user -> assistant(2 tool calls) -> result1 -> result2 -> text
    expect(result.messages).toHaveLength(5);
    const toolResults = messagesByRole(result, "toolResult");
    expect(toolResults).toHaveLength(2);
  });
});
```

**测试要点**:

- 多轮工具调用验证上下文累积
- 单响应多工具调用验证并行执行
- `maxTurns` 防止无限循环

### 5.4 错误处理

```typescript
describe("error handling", () => {
  it("handles tool execution failure", async () => {
    const failingTool = createFailingTool("dangerous_tool", "Permission denied");

    const agent = createTestAgent({
      responses: [mockToolCallResponse("dangerous_tool", {}), mockTextResponse("The tool failed.")],
      tools: [failingTool],
    });

    const result = await agent.run("Run the dangerous tool");

    // 工具结果标记为错误
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toBe("Permission denied");

    // Agent 仍然继续到最终响应 (工具失败不会终止循环)
    expect(messagesByRole(result, "assistant")).toHaveLength(2);
  });

  it("handles LLM error response", async () => {
    const agent = createTestAgent({
      responses: [mockErrorResponse("Rate limit exceeded")],
    });

    const result = await agent.run("Hello");

    const errors = collectEvents(result, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("Rate limit exceeded");
  });
});
```

**测试要点**:

- 工具异常被捕获并转为 `isError: true` 的 toolResult，循环继续
- LLM 错误直接终止循环
- 队列为空时返回错误而非崩溃

### 5.5 Steering: 运行期间注入消息

```typescript
describe("steering", () => {
  it("injects a steering message before the LLM call", async () => {
    const agent = createTestAgent({
      responses: [mockTextResponse("I will be concise.")],
      onBeforeTurn: (messages) => {
        return "Please keep your response under 50 words.";
      },
    });

    const result = await agent.run("Explain quantum computing");

    // Steering 事件被发出
    const steeringEvents = collectEvents(result, "steering");
    expect(steeringEvents).toHaveLength(1);

    // Provider 收到了 steering 消息
    const sentMessages = agent.provider.callHistory[0].messages;
    expect(sentMessages).toHaveLength(2); // user + steering
  });
});
```

**测试要点**:

- `onBeforeTurn` 钩子在每轮 LLM 调用前执行
- 返回字符串时注入为用户消息
- 返回 `undefined` 时不注入
- 可以根据当前消息历史条件性触发

---

## 6. 端到端事件验证

事件序列是 Agent 行为的完整记录。通过收集所有事件并断言其顺序和内容，可以验证 Agent 循环的正确性。

### 事件收集模式

```typescript
// 辅助函数: 提取特定类型的事件
function collectEvents<T extends AgentEvent["type"]>(
  result: AgentRunResult,
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return result.events.filter((e) => e.type === type);
}

// 辅助函数: 提取事件类型序列
function eventTypes(result: AgentRunResult): string[] {
  return result.events.map((e) => e.type);
}
```

### 完整工具调用周期的事件序列

```typescript
it("full tool call cycle produces correct event sequence", async () => {
  const result = await agent.run("What is 2+2?");

  expect(eventTypes(result)).toEqual([
    // Turn 1: 工具调用
    "agent_start",
    "turn_start",
    "message_start", // assistant with tool call
    "message_end",
    "tool_call_start",
    "tool_call_end",
    "turn_end",
    // Turn 2: 最终文本
    "turn_start",
    "message_start", // assistant with text
    "message_delta",
    "message_end",
    "turn_end",
    "agent_end",
  ]);
});
```

### 不变量断言

除了精确序列，还应验证一些事件不变量:

```typescript
// agent_start 总是第一个事件
expect(result.events[0].type).toBe("agent_start");

// agent_end 总是最后一个事件
expect(result.events[result.events.length - 1].type).toBe("agent_end");

// message_start 和 message_end 总是成对出现
const starts = collectEvents(result, "message_start");
const ends = collectEvents(result, "message_end");
expect(starts.length).toBe(ends.length);

// agent_end 包含完整的消息列表
const agentEnd = collectEvents(result, "agent_end");
expect(agentEnd[0].messages.length).toBe(result.messages.length);
```

---

## 7. 测试工具函数

为了让测试代码简洁，我们提供了一组辅助函数:

### createTestAgent -- 测试 Agent 工厂

```typescript
export function createTestAgent(options: TestAgentOptions = {}): TestAgent {
  const provider = new MockProvider();
  if (options.responses) {
    provider.enqueue(...options.responses);
  }

  return {
    provider, // 暴露 provider 用于断言
    run: (userMessage) => runAgent(userMessage, { provider, tools: options.tools, ... }),
  };
}
```

### 工具定义辅助

```typescript
// 返回固定结果的工具
const readFileTool = createStaticTool("read_file", "file content");

// 总是抛出异常的工具
const failingTool = createFailingTool("bad_tool", "Permission denied");

// 自定义逻辑的工具
const counterTool = createTool("counter", async (args) => {
  count++;
  return { content: `Count: ${count}`, isError: false };
});
```

---

## 8. 与 pi 的 Faux Provider 对比

| 维度       | 我们的 MockProvider   | Pi 的 Faux Provider                            |
| ---------- | --------------------- | ---------------------------------------------- |
| 流式模拟   | 无 (同步返回)         | 完整的事件流 + 可配置延迟                      |
| Token 估算 | 无                    | `estimateTokens()` + prompt cache              |
| 响应类型   | 静态消息或工厂函数    | `FauxResponseStep` (相同设计)                  |
| 注册方式   | 直接构造              | `registerFauxProvider()` 注册到全局 API 注册表 |
| 模型管理   | 无                    | 支持多模型定义                                 |
| Abort 处理 | 由 Agent 循环处理     | 内建中断检测                                   |
| 适用场景   | 教学 / Agent 逻辑测试 | 生产级 Agent + Provider 集成测试               |

关键差异在于 Faux Provider 是一个完整的 provider 实现，注册到 pi 的全局 API 注册表中，Agent 通过正常的 provider 路由调用它。我们的 MockProvider 则直接传入 Agent 循环，跳过了 provider 注册层。

---

## 9. 完整伪代码

### Mock Provider

```
class MockProvider:
    queue: ResponseStep[]
    callHistory: CallRecord[]

    enqueue(responses...):
        queue.push_all(responses)

    stream(messages) -> AssistantMessage:
        step = queue.shift()
        if step is null:
            return error_response("no more responses")
        response = step is function ? step(messages, callHistory.length) : step
        callHistory.push({ messages: copy(messages), response })
        return response
```

### Agent Loop

```
function runAgent(userMessage, config) -> RunResult:
    messages = [user_message(userMessage)]
    events = []
    emit("agent_start")

    turns = 0
    while turns < maxTurns:
        turns += 1

        // Steering
        if onBeforeTurn:
            steering = onBeforeTurn(messages)
            if steering:
                messages.push(user_message(steering))
                emit("steering", steering)

        emit("turn_start")

        // LLM call
        response = provider.stream(messages)
        if response.stopReason == "error":
            emit("error", response.errorMessage)
            emit("agent_end", messages)
            return { messages, events }

        emit("message_start", response)
        emit("message_end", response)
        messages.push(response)

        // Tool calls
        toolCalls = response.content.filter(type == "toolCall")
        if toolCalls.empty:
            emit("turn_end", response)
            break

        for tc in toolCalls:
            emit("tool_call_start", tc)
            result = execute_tool(tc.name, tc.arguments)
            emit("tool_call_end", tc, result)
            messages.push(tool_result(tc.id, tc.name, result))

        emit("turn_end", response)

    emit("agent_end", messages)
    return { messages, events }
```

### Test Case: 工具调用周期

```
test "tool call cycle":
    provider = new MockProvider()
    provider.enqueue(
        tool_call_response("calc", { expr: "2+2" }),
        text_response("The answer is 4"),
    )

    result = runAgent("What is 2+2?", {
        provider,
        tools: [static_tool("calc", "4")],
    })

    assert result.messages.length == 4
    assert result.messages[0].role == "user"
    assert result.messages[1].role == "assistant"
    assert result.messages[2].role == "toolResult"
    assert result.messages[3].role == "assistant"
    assert provider.callCount == 2

    assert eventTypes(result) == [
        "agent_start",
        "turn_start", "message_start", "message_end",
        "tool_call_start", "tool_call_end", "turn_end",
        "turn_start", "message_start", "message_delta", "message_end",
        "turn_end",
        "agent_end",
    ]
```

---

## 总结

| 概念            | 作用                                                                  |
| --------------- | --------------------------------------------------------------------- |
| MockProvider    | 可脚本化的假 LLM，返回预设响应                                        |
| 响应队列        | FIFO 模型，每次 `stream()` 消耗一个                                   |
| 动态工厂        | 根据上下文动态生成响应                                                |
| 消息工厂函数    | `mockTextResponse()`, `mockToolCallResponse()`, `mockErrorResponse()` |
| 事件收集        | 收集 AgentEvent 数组，断言顺序和内容                                  |
| createTestAgent | 封装 provider + agent 循环的测试工厂                                  |
| 工具辅助        | `createStaticTool()`, `createFailingTool()` 快速定义测试工具          |
| Steering 测试   | `onBeforeTurn` 钩子注入控制消息                                       |
| 端到端验证      | 精确断言事件序列 + 不变量检查                                         |

下一课我们将实现 Agent 的持久化层 -- 对话存储和恢复，使 Agent 能够跨会话保持状态。
