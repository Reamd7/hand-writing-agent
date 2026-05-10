# 第 2 课：AI SDK 基础与消息模型设计

## 学习目标

完成本课后，你将能够：

1. 使用 AI SDK Core 的三个核心函数：`generateText()`、`streamText()`、`tool()`
2. 理解 `streamText` 的 `fullStream` 事件协议中每一种事件的含义
3. 设计一套类型安全的 `AgentMessage` 和 `AgentEvent` 体系
4. 通过 TypeScript 声明合并（declaration merging）扩展消息类型
5. 将 fullStream 事件映射为自定义 AgentEvent

## 前置要求

- 完成第 1 课（Agent 概念与架构概览）
- Node.js 20+ 已安装
- 至少有一个 LLM API Key（OpenAI 或 Anthropic）

---

## 1. AI SDK 概览

[AI SDK](https://ai-sdk.dev) 是 Vercel 推出的 TypeScript 工具包，为开发者提供了与多种 LLM 交互的统一 API。它的核心价值是**提供商无关性**——同一套代码可以在 OpenAI、Anthropic、Google 等不同模型之间无缝切换。

AI SDK 主要分为两层：

| 层级            | 说明                                                      |
| --------------- | --------------------------------------------------------- |
| **AI SDK Core** | 文本生成、结构化数据、工具调用、Agent 构建的统一 API      |
| **AI SDK UI**   | 面向前端框架（React/Vue/Svelte）的 hooks，快速构建聊天 UI |

我们关注的是 **AI SDK Core** 中的三个核心函数。

### 1.1 安装 Provider

```bash
# 核心包
npm install ai

# Provider（按需安装）
npm install @ai-sdk/openai     # OpenAI / Azure OpenAI
npm install @ai-sdk/anthropic  # Anthropic (Claude)
npm install @ai-sdk/google     # Google Gemini

# 工具参数校验
npm install zod
```

每个 Provider 包导出一个工厂函数，用于创建模型实例：

```typescript
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

const gpt4o = openai("gpt-4o");
const claude = anthropic("claude-sonnet-4-20250514");
const gemini = google("gemini-2.5-flash");
```

---

## 2. 三大核心函数

### 2.1 `generateText()` — 阻塞式文本生成

`generateText()` 等待模型生成完整响应后才返回结果。适用于非交互式场景，如批量处理、后台任务。

```typescript
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const { text, usage, finishReason } = await generateText({
  model: openai("gpt-4o"),
  system: "你是一个简洁的技术文档写手。",
  prompt: "用三句话解释 TypeScript 的类型推断。",
});

console.log(text);
// text: 完整的生成文本
// usage: { promptTokens, completionTokens, totalTokens }
// finishReason: "stop" | "length" | "tool-calls" | ...
```

**返回值要点**：

- `result.text` — 生成的文本
- `result.toolCalls` — 模型请求的工具调用列表
- `result.toolResults` — 工具执行结果
- `result.usage` — token 用量
- `result.steps` — 多步执行的详细记录
- `result.response.messages` — 可直接追加到会话历史的消息

### 2.2 `streamText()` — 流式文本生成

对于交互式场景（聊天机器人、实时应用），等待完整响应可能需要数十秒。`streamText()` 在模型生成的同时逐块返回内容：

```typescript
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const result = streamText({
  model: openai("gpt-4o"),
  prompt: "列举 5 个 TypeScript 设计模式。",
});

// 方式 1: 只读文本流
for await (const chunk of result.textStream) {
  process.stdout.write(chunk); // 逐字输出
}

// 方式 2: 完整事件流（fullStream）—— 更强大
for await (const part of result.fullStream) {
  // part.type 区分不同事件类型
}
```

> **关键区别**：`textStream` 只给你文本片段；`fullStream` 给你所有事件（文本、推理、工具调用、用量统计等），是构建 Agent 的基础。

**流完成后的聚合结果**（Promise）：

```typescript
const text = await result.text; // 完整文本
const usage = await result.totalUsage; // 累计 token 用量
const steps = await result.steps; // 所有步骤详情
```

### 2.3 `tool()` — 类型安全的工具定义

`tool()` 是一个辅助函数，确保工具定义拥有完整的类型推断：

```typescript
import { tool } from "ai";
import { z } from "zod";

const weatherTool = tool({
  description: "获取指定城市的当前天气",
  inputSchema: z.object({
    city: z.string().describe("城市名称"),
    unit: z.enum(["celsius", "fahrenheit"]).optional().describe("温度单位"),
  }),
  execute: async ({ city, unit }) => {
    // city 和 unit 的类型从 Zod schema 自动推断
    const response = await fetch(`https://api.weather.com/${city}`);
    return response.json();
  },
});
```

工具定义的三要素：

| 属性          | 说明                                                      |
| ------------- | --------------------------------------------------------- |
| `description` | 告诉模型这个工具做什么（影响模型选择工具的决策）          |
| `inputSchema` | Zod schema，定义参数结构（同时用于 LLM 提示和运行时校验） |
| `execute`     | 异步执行函数，参数类型从 schema 推断                      |

将工具传入 `generateText` 或 `streamText`：

```typescript
const result = await generateText({
  model: openai("gpt-4o"),
  tools: { getWeather: weatherTool },
  prompt: "东京现在天气怎么样？",
});

// 如果模型调用了工具：
console.log(result.toolCalls); // [{ toolName: "getWeather", args: { city: "Tokyo" } }]
console.log(result.toolResults); // [{ toolName: "getWeather", result: { ... } }]
```

---

## 3. `fullStream` 事件协议详解

`streamText` 的 `fullStream` 属性是一个 `AsyncIterable`，它按顺序产出以下类型的事件。理解这套协议是构建 Agent 的关键。

### 3.1 完整事件类型表

| 事件类型           | 说明                           | 关键字段                           |
| ------------------ | ------------------------------ | ---------------------------------- |
| `start`            | 流开始                         | —                                  |
| `start-step`       | 一个新步骤开始                 | —                                  |
| `text-start`       | 文本块开始                     | —                                  |
| `text-delta`       | 文本增量                       | `textDelta: string`                |
| `text-end`         | 文本块结束                     | —                                  |
| `reasoning-start`  | 推理/思考块开始                | —                                  |
| `reasoning-delta`  | 推理增量                       | `textDelta: string`                |
| `reasoning-end`    | 推理块结束                     | —                                  |
| `tool-call`        | 工具调用（完整）               | `toolCallId`, `toolName`, `args`   |
| `tool-input-start` | 工具输入开始流式传输           | `toolName`, `toolCallId`           |
| `tool-input-delta` | 工具输入增量                   | `inputTextDelta: string`           |
| `tool-input-end`   | 工具输入传输完成               | —                                  |
| `tool-result`      | 工具执行结果                   | `toolCallId`, `toolName`, `result` |
| `tool-error`       | 工具执行错误                   | `toolName`, `error`                |
| `source`           | 引用来源（部分 Provider 支持） | `url`, `title`                     |
| `file`             | 模型生成的文件                 | `mediaType`, `data`                |
| `finish-step`      | 步骤结束                       | `finishReason`, `usage`            |
| `finish`           | 整个流结束                     | `finishReason`, `totalUsage`       |
| `error`            | 流错误                         | `error`                            |
| `raw`              | 原始 Provider 数据             | `rawValue`                         |

### 3.2 事件时序图

一次包含工具调用的完整交互产生的事件序列：

```
start
  start-step                          ← 第 1 步开始
    tool-input-start                  ← 工具输入开始流式传输
      tool-input-delta*               ← 工具参数 JSON 逐块到达
    tool-input-end                    ← 工具输入传输完成
    tool-call                         ← 完整的工具调用（参数已解析）
    tool-result                       ← 工具执行完毕，结果返回
  finish-step                         ← 第 1 步结束（reason: "tool-calls"）
  start-step                          ← 第 2 步开始（模型继续生成）
    text-start
      text-delta*                     ← 模型基于工具结果生成文本
    text-end
  finish-step                         ← 第 2 步结束（reason: "stop"）
finish                                ← 整个流结束
```

> **要点**：`tool-input-start/delta/end` 是工具参数的流式传输，在 `tool-call`（完整解析后的调用）之前出现。`tool-result` 在工具 `execute` 完成后出现。这些都在同一步（step）内。

### 3.3 代码实战

参见 `code/src/stream-demo.ts`，这是一个完整的示例，展示如何遍历 `fullStream` 的每一种事件。

---

## 4. 自定义消息模型设计

AI SDK 的消息类型适合通用场景，但构建 Agent 需要更丰富的类型系统。我们以 pi 项目的设计为参照，设计一套自定义消息模型。

### 4.1 内容块类型（Content Blocks）

与其让消息内容是单一字符串，我们将内容建模为**类型化的块数组**。这样一条消息可以同时包含文本、图片、推理和工具调用：

```typescript
// 文本块
interface TextContent {
  type: "text";
  text: string;
}

// 图片块
interface ImageContent {
  type: "image";
  data: string; // base64 编码
  mimeType: string; // 如 "image/png"
}

// 推理/思考块
interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string; // 用于多轮推理连续性
  redacted?: boolean; // 是否被安全过滤器编辑
}

// 工具调用块
interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
```

> **设计原则**：每种内容块都带有 `type` 鉴别符（discriminant），使得 TypeScript 可以在 `switch` 中进行类型收窄（narrowing）。

### 4.2 消息类型

基于内容块，定义三种角色的消息：

```typescript
// 用户消息
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[]; // 支持多模态输入
  timestamp: number;
}

// 助手消息（LLM 响应）
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  model: string; // 使用的模型
  provider: string; // 提供商
  usage: Usage; // token 用量
  stopReason: StopReason; // 停止原因
  errorMessage?: string; // 错误时的消息
  timestamp: number;
}

// 工具结果消息
interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string; // 对应哪个工具调用
  toolName: string; // 工具名称
  content: (TextContent | ImageContent)[]; // 结果（可包含图片）
  isError: boolean; // 是否执行出错
  timestamp: number;
}
```

三种消息的联合类型：

```typescript
type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

### 4.3 Token 用量追踪

```typescript
interface Usage {
  input: number; // 输入 token 数
  output: number; // 输出 token 数
  cacheRead: number; // 从缓存读取的 token 数
  cacheWrite: number; // 写入缓存的 token 数
  totalTokens: number;
  cost: {
    input: number; // 输入费用（美元）
    output: number; // 输出费用
    cacheRead: number;
    cacheWrite: number;
    total: number; // 总费用
  };
}
```

> **为什么要 cacheRead/cacheWrite？** 现代 LLM API（如 Anthropic 的 prompt caching）对缓存命中和缓存写入有不同的计费方式。精确追踪这些数据对成本控制至关重要。

---

## 5. 声明合并扩展消息类型

到目前为止，`Message` 只包含三种 LLM 级别的消息。但一个完整的 Agent 应用往往需要更多消息类型——通知、工件（artifact）、状态更新等。

pi 项目使用了 TypeScript 的**声明合并（declaration merging）** 机制来实现扩展，而不是修改核心类型：

### 5.1 核心接口

```typescript
// 在核心库中定义一个空接口
interface CustomAgentMessages {
  // 空的——由应用通过声明合并扩展
}

// AgentMessage 自动包含所有自定义类型
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

### 5.2 应用层扩展

```typescript
// 在应用代码中扩展
declare module "@mariozechner/agent" {
  interface CustomAgentMessages {
    artifact: {
      role: "artifact";
      name: string;
      content: string;
      language: string;
      timestamp: number;
    };
    notification: {
      role: "notification";
      text: string;
      level: "info" | "warn" | "error";
      timestamp: number;
    };
  }
}
```

扩展后，`AgentMessage` 自动变为：

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | { role: "artifact"; name: string; content: string; language: string; timestamp: number }
  | { role: "notification"; text: string; level: "info" | "warn" | "error"; timestamp: number };
```

### 5.3 为什么用声明合并？

| 方案                       | 优点                 | 缺点                                     |
| -------------------------- | -------------------- | ---------------------------------------- |
| 泛型参数 `Agent<TMessage>` | 灵活                 | 泛型病毒式传播，所有使用处都要传类型参数 |
| 直接修改核心类型           | 简单                 | 无法在不 fork 库的情况下扩展             |
| **声明合并**               | 无侵入、类型自动扩展 | 需要理解 TS 模块增强机制                 |

声明合并是 pi 项目选择的方案，因为它让**核心库不需要知道应用层有哪些自定义消息类型**，同时保持完整的类型安全。

---

## 6. AgentEvent 类型设计

Agent 在运行时需要向 UI 层通知各种状态变化。`AgentEvent` 定义了这套事件协议：

```typescript
type AgentEvent =
  // Agent 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }

  // Turn 生命周期（一个 turn = 一次助手响应 + 工具调用/结果）
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }

  // 消息生命周期
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; streamEvent: AssistantStreamEvent }
  | { type: "message_end"; message: AgentMessage }

  // 工具执行生命周期
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };
```

### 6.1 事件层次结构

```
agent_start
  turn_start
    message_start (assistant)
      message_update*           ← 流式增量，附带 AssistantStreamEvent
    message_end (assistant)
    tool_execution_start*       ← 每个工具调用一次
      tool_execution_update*    ← 工具可以报告中间进度
    tool_execution_end*
    message_start* (toolResult) ← 每个工具结果一次
    message_end* (toolResult)
  turn_end
  turn_start                    ← 如果有后续 turn（工具结果触发）
    ...
  turn_end
agent_end
```

### 6.2 设计要点

1. **`message_update` 包含原始流事件**：UI 层既能获得更新后的完整消息快照，也能访问底层的流式事件细节（如文本增量内容、推理内容等）。

2. **Tool execution 独立于 message 生命周期**：工具执行可能耗时很长（如文件操作、代码执行），它的开始/更新/结束事件独立于消息事件发出。

3. **`agent_end` 携带完整消息列表**：方便调用方一次性获取整个运行期间产生的所有消息，而无需自己拼接。

---

## 7. fullStream 到 AgentEvent 的映射

核心挑战是将 AI SDK 的低级流事件转化为我们的高级 Agent 事件。下表展示映射关系：

| AI SDK fullStream 事件 | AgentEvent                                                               |
| ---------------------- | ------------------------------------------------------------------------ |
| `start-step`（第一步） | `turn_start` + `message_start`                                           |
| `text-start`           | `message_update`（streamEvent: `text_start`）                            |
| `text-delta`           | `message_update`（streamEvent: `text_delta`）                            |
| `text-end`             | `message_update`（streamEvent: `text_end`）                              |
| `reasoning-start`      | `message_update`（streamEvent: `thinking_start`）                        |
| `reasoning-delta`      | `message_update`（streamEvent: `thinking_delta`）                        |
| `reasoning-end`        | `message_update`（streamEvent: `thinking_end`）                          |
| `tool-input-start`     | `message_update`（streamEvent: `toolcall_start`）                        |
| `tool-input-delta`     | `message_update`（streamEvent: `toolcall_delta`）                        |
| `tool-call`            | `message_update`（streamEvent: `toolcall_end`） + `tool_execution_start` |
| `tool-result`          | `tool_execution_end` + `message_start/end`（toolResult）                 |
| `finish-step`          | `message_end`                                                            |
| `finish`               | `turn_end` + `agent_end`                                                 |
| `error`                | `message_end`（error） + `agent_end`                                     |

映射的完整实现参见 `code/src/event-mapper.ts`。核心是一个 async generator 函数，它消费 `fullStream`，维护一个 partial `AssistantMessage` 状态，并在适当时机 yield 对应的 `AgentEvent`。

### 7.1 映射器的关键状态

```typescript
// 维护的状态
const partial: AssistantMessage = { ... }; // 当前正在构建的助手消息
let contentIndex = 0;                       // 当前内容块索引
let textBuffer = "";                        // 文本累积缓冲
let thinkingBuffer = "";                    // 推理累积缓冲
const toolResults: ToolResultMessage[] = []; // 工具结果收集
const collectedMessages: AgentMessage[] = []; // 所有消息收集
```

每当收到 `text-delta` 事件，我们：

1. 将增量文本追加到 `textBuffer`
2. 更新 `partial.content[contentIndex]` 中的文本内容
3. 发出 `message_update` 事件，附带 `text_delta` 流事件

这样 UI 层可以同时获得增量数据（用于实时渲染）和完整快照（用于状态管理）。

---

## 8. AgentContext 类型

`AgentContext` 是传给 LLM 的上下文快照：

```typescript
interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentToolDef[];
}
```

在每次 LLM 调用前，Agent 需要：

1. 从 `AgentMessage[]` 转换为 LLM 能理解的 `Message[]`（过滤掉自定义消息类型）
2. 可选地压缩上下文（当消息过多时裁剪旧消息）
3. 将 tools 定义传给模型

这些步骤在 pi 的 `AgentLoopConfig` 中通过 `convertToLlm` 和 `transformContext` 两个钩子实现。

---

## 9. 动手练习

### 练习 1：运行 fullStream Demo

```bash
cd code
npm install
OPENAI_API_KEY=sk-... npm run stream-demo
```

观察控制台输出的每一个事件，对照第 3 节的事件时序图。

**思考题**：

- `start-step` 事件出现了几次？为什么？
- `finish-step` 中的 `finishReason` 分别是什么？
- 如果把 prompt 改为不需要工具调用的问题，事件序列会怎样变化？

### 练习 2：运行 Event Mapper

```bash
OPENAI_API_KEY=sk-... npm run event-mapper
```

观察 `AgentEvent` 的输出格式。

**思考题**：

- `message_start` 事件出现了几次？分别对应什么角色的消息？
- `tool_execution_start` 和 `tool_execution_end` 之间发生了什么？
- 如果工具执行失败，事件序列会怎样变化？

### 练习 3：添加自定义消息类型

修改 `code/src/types.ts`，通过声明合并添加一个 `StatusMessage` 类型：

```typescript
// 在 types.ts 末尾添加：
declare module "./types" {
  interface CustomAgentMessages {
    status: {
      role: "status";
      text: string;
      level: "info" | "warn" | "error";
      timestamp: number;
    };
  }
}
```

然后编写一段代码，创建一个 `AgentMessage` 数组，其中混合使用 `UserMessage`、`AssistantMessage` 和 `StatusMessage`，验证 TypeScript 是否正确地类型检查所有消息类型。

### 练习 4：扩展 Usage 追踪

在 event-mapper 的 `finish-step` 处理中，累加所有步骤的 token 用量，在 `agent_end` 时打印总用量。考虑：

- 多步执行时如何避免重复计算？
- 缓存命中的 token 应该如何在总量中体现？

---

## 10. 本课小结

| 概念             | 要点                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| `generateText()` | 阻塞式，返回完整结果，适合后台任务                                            |
| `streamText()`   | 流式，实时返回增量数据，适合交互式 UI                                         |
| `tool()`         | 类型安全的工具定义，Zod schema 驱动                                           |
| `fullStream`     | 包含所有事件类型的完整流协议                                                  |
| Content Blocks   | `TextContent`, `ThinkingContent`, `ImageContent`, `ToolCall` — 类型化的内容块 |
| `Message`        | LLM 级别的消息联合类型（user/assistant/toolResult）                           |
| `AgentMessage`   | 通过声明合并扩展的应用级消息类型                                              |
| `AgentEvent`     | Agent 向 UI 通知状态变化的事件协议                                            |
| `Usage`          | 包含缓存和费用明细的 token 追踪                                               |

### 下一课预告

**第 3 课：Agent Loop 与工具执行引擎** — 我们将实现完整的 Agent 循环：接收用户输入 -> 调用 LLM -> 执行工具 -> 将结果反馈给 LLM -> 循环直到完成。重点内容包括 `AgentLoopConfig`、`beforeToolCall`/`afterToolCall` 钩子、并行与串行工具执行策略。
