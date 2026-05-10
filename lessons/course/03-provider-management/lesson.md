# 第三课：Provider 管理与模型配置

## 概述

一个成熟的 AI agent 不会只绑定单一模型。用户可能希望在 Claude 和 GPT 之间自由切换,用便宜的模型做简单任务、用强模型处理复杂推理,或者在某个 provider 宕机时自动 fallback。这就要求我们的 agent 具备 **provider 管理** 和 **模型配置** 能力。

本课将从 Vercel AI SDK 的 provider 模型出发,讲解如何构建一个统一的模型注册表、如何用 middleware 模式增强模型行为、以及如何解决跨 provider 消息兼容性问题。

---

## 1. AI SDK 的 Provider 模型

### 1.1 每个 Provider 是一个独立的 npm 包

AI SDK 的核心设计决策:每个 provider 是一个独立的 npm 包 (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` 等)。这天然带来了:

- **按需加载**: 只安装你用到的 provider,不会把所有 SDK 的依赖拉进来
- **独立版本管理**: 某个 provider 的 API 变更不影响其他 provider
- **统一接口**: 所有 provider 都实现相同的 `LanguageModelV3` 接口

```typescript
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";

// 两个 provider,相同的使用方式
const gpt = openai("gpt-4o");
const claude = anthropic("claude-sonnet-4-5");
```

### 1.2 Provider Registry

AI SDK 提供 `createProviderRegistry()` 来集中管理多个 provider:

```typescript
import { createProviderRegistry, gateway } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";

const registry = createProviderRegistry({
  gateway,
  openai,
  anthropic,
});

// 通过 "provider:model" 字符串访问
const model = registry.languageModel("openai:gpt-4o");
```

### 1.3 pi 的做法: 自建 API Registry

pi 没有直接使用 AI SDK 的 `createProviderRegistry`,而是自建了 `ApiProvider` 注册表。原因是 pi 需要更底层的控制:

```typescript
// packages/ai/src/api-registry.ts (简化)
interface ApiProvider<TApi extends Api> {
  api: TApi; // "anthropic-messages" | "openai-completions" | ...
  stream: StreamFunction; // 全功能 stream
  streamSimple: StreamFunction; // 简化版 stream
}

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

function registerApiProvider(provider: ApiProvider): void {
  apiProviderRegistry.set(provider.api, { provider });
}
```

关键区别:pi 的 registry 以 **API 协议**(`"anthropic-messages"`, `"openai-responses"`)而非 provider 名称为 key。这是因为同一个 provider(如 OpenAI)可能有多种 API 协议(completions vs responses)。

---

## 2. Language Model Middleware

### 2.1 wrapLanguageModel 模式

AI SDK 的 `wrapLanguageModel()` 允许你在不修改模型本身的情况下增强其行为:

```typescript
import { wrapLanguageModel } from "ai";
import type { LanguageModelV3Middleware } from "@ai-sdk/provider";

const wrappedModel = wrapLanguageModel({
  model: baseModel,
  middleware: myMiddleware,
});
```

middleware 可以实现三个钩子:

| 钩子              | 作用             | 典型用途               |
| ----------------- | ---------------- | ---------------------- |
| `transformParams` | 在调用前修改参数 | RAG 注入、参数校验     |
| `wrapGenerate`    | 包装非流式调用   | 缓存、日志、guardrails |
| `wrapStream`      | 包装流式调用     | 流式日志、token 计数   |

### 2.2 典型 Middleware 场景

**Logging Middleware** -- 记录每次调用的参数和结果:

```typescript
const loggingMiddleware: LanguageModelV3Middleware = {
  wrapGenerate: async ({ doGenerate, params }) => {
    const startTime = Date.now();
    console.log("[LLM] generate called", params.prompt.length, "messages");

    const result = await doGenerate();

    console.log("[LLM] generate done", Date.now() - startTime, "ms");
    return result;
  },

  wrapStream: async ({ doStream, params }) => {
    console.log("[LLM] stream called");
    const { stream, ...rest } = await doStream();

    const transformStream = new TransformStream({
      transform(chunk, controller) {
        // 可以在这里统计 token、记录内容等
        controller.enqueue(chunk);
      },
      flush() {
        console.log("[LLM] stream finished");
      },
    });

    return { stream: stream.pipeThrough(transformStream), ...rest };
  },
};
```

**Caching Middleware** -- 对相同输入返回缓存结果:

```typescript
const cache = new Map<string, unknown>();

const cachingMiddleware: LanguageModelV3Middleware = {
  wrapGenerate: async ({ doGenerate, params }) => {
    const key = JSON.stringify(params);
    if (cache.has(key)) return cache.get(key);

    const result = await doGenerate();
    cache.set(key, result);
    return result;
  },
};
```

**Guardrails Middleware** -- 过滤敏感内容:

```typescript
const guardrailMiddleware: LanguageModelV3Middleware = {
  wrapGenerate: async ({ doGenerate }) => {
    const { text, ...rest } = await doGenerate();
    const cleanedText = text?.replace(/SENSITIVE_PATTERN/g, "<REDACTED>");
    return { text: cleanedText, ...rest };
  },
};
```

### 2.3 组合多个 Middleware

middleware 可以组合使用,按数组顺序从外到内嵌套:

```typescript
const model = wrapLanguageModel({
  model: baseModel,
  middleware: [loggingMiddleware, cachingMiddleware, guardrailMiddleware],
});
// 执行顺序: logging -> caching -> guardrail -> baseModel
```

---

## 3. 构建 Model Registry

### 3.1 设计思路

我们需要一个注册表,将 `"provider/model"` 字符串映射到具体的模型配置:

```typescript
interface ModelEntry {
  provider: string; // "openai" | "anthropic" | ...
  modelId: string; // "gpt-4o" | "claude-sonnet-4-5" | ...
  model: LanguageModel; // AI SDK 模型实例
}

class ModelRegistry {
  private models = new Map<string, ModelEntry>();

  register(provider: string, modelId: string, model: LanguageModel): void {
    const key = `${provider}/${modelId}`;
    this.models.set(key, { provider, modelId, model });
  }

  get(key: string): ModelEntry | undefined {
    return this.models.get(key);
  }

  list(): ModelEntry[] {
    return Array.from(this.models.values());
  }
}
```

### 3.2 pi 的两层 Registry

pi 使用两层 Map 结构:

```typescript
// packages/ai/src/models.ts
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// 第一层: provider -> Map
// 第二层: modelId -> Model
function getModel(provider, modelId) {
  return modelRegistry.get(provider)?.get(modelId);
}
```

这种两层结构的好处:可以高效地枚举某个 provider 下的所有模型 (`getModels(provider)`)。

### 3.3 懒加载 Provider

pi 的 `register-builtins.ts` 展示了一种精巧的懒加载模式:

```typescript
// 核心思想: 用 memoized promise 实现单例懒加载
let anthropicModulePromise: Promise<ProviderModule> | undefined;

function loadAnthropicModule(): Promise<ProviderModule> {
  // ||= 确保只 import 一次
  anthropicModulePromise ||= import("./anthropic.js").then((module) => ({
    stream: module.streamAnthropic,
    streamSimple: module.streamSimpleAnthropic,
  }));
  return anthropicModulePromise;
}

// 创建一个"同步返回、异步执行"的 stream 函数
function createLazyStream(loadModule) {
  return (model, context, options) => {
    const outer = new AssistantMessageEventStream(); // 立即返回

    loadModule()
      .then((module) => {
        const inner = module.stream(model, context, options);
        forwardStream(outer, inner); // 把内部事件转发到外部
      })
      .catch((error) => {
        outer.push({ type: "error", error });
        outer.end();
      });

    return outer; // 调用者拿到的是一个马上可以监听的 stream
  };
}
```

这个模式的价值:

- **启动速度**: 不需要在启动时加载所有 provider SDK
- **按需付出**: 只在实际使用某个 provider 时才加载它的 SDK
- **接口统一**: 调用者看到的始终是同步返回的 stream,不需要 await

---

## 4. 跨 Provider 消息兼容性

### 4.1 问题: 切换模型时 thinking blocks 怎么办?

这是实际开发中最棘手的问题之一。考虑以下场景:

1. 用户用 Claude Sonnet 4 (支持 extended thinking) 对话了 10 轮
2. 历史消息中包含 Claude 的 thinking blocks(带加密签名)
3. 用户切换到 GPT-4o 继续对话

直接把 Claude 的 thinking blocks 发给 OpenAI 会怎样?API 报错。

### 4.2 pi 的 transformMessages 解决方案

`transform-messages.ts` 处理了三个关键问题:

**问题 1: Thinking blocks 转换**

```typescript
// 伪代码 (基于 packages/ai/src/providers/transform-messages.ts)
if (block.type === "thinking") {
  if (block.redacted) {
    // 加密的 thinking 只对同一模型有意义
    return isSameModel ? block : []; // 跨模型直接丢弃
  }

  if (isSameModel && block.thinkingSignature) {
    return block; // 同模型保留签名(用于 replay)
  }

  if (!block.thinking?.trim()) {
    return []; // 空 thinking 直接丢弃
  }

  if (isSameModel) return block;

  // 跨模型: 把 thinking 降级为普通 text
  return { type: "text", text: block.thinking };
}
```

核心原则:

- **同模型**: 保留一切,包括加密签名
- **跨模型**: 有价值的推理内容降级为 text,加密/空内容直接丢弃

**问题 2: Tool Call ID 格式差异**

OpenAI Responses API 生成的 tool call ID 可能超过 450 个字符并包含 `|` 等特殊字符, 而 Anthropic 要求 ID 必须匹配 `^[a-zA-Z0-9_-]+$` 且不超过 64 字符:

```typescript
// 构建 ID 映射表
const toolCallIdMap = new Map<string, string>();

// 对跨模型的 tool call,用 normalizeToolCallId 回调生成兼容 ID
if (!isSameModel && normalizeToolCallId) {
  const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
  if (normalizedId !== toolCall.id) {
    toolCallIdMap.set(toolCall.id, normalizedId);
  }
}

// 后续的 toolResult 消息也要用映射后的 ID
if (msg.role === "toolResult") {
  const normalizedId = toolCallIdMap.get(msg.toolCallId);
  if (normalizedId) {
    return { ...msg, toolCallId: normalizedId };
  }
}
```

**问题 3: 孤立的 Tool Calls**

如果一轮对话因错误中断,可能产生有 tool call 但没有对应 tool result 的情况。大多数 API 要求 tool call 和 tool result 配对出现:

```typescript
// 为孤立的 tool calls 插入合成的 tool result
for (const tc of pendingToolCalls) {
  if (!existingToolResultIds.has(tc.id)) {
    result.push({
      role: "toolResult",
      toolCallId: tc.id,
      toolName: tc.name,
      content: [{ type: "text", text: "No result provided" }],
      isError: true,
    });
  }
}
```

### 4.3 图片内容降级

不是所有模型都支持图片输入。对于不支持视觉的模型,图片内容需要降级为占位文本:

```typescript
function downgradeUnsupportedImages(messages, model) {
  if (model.input.includes("image")) return messages; // 支持图片,原样返回

  return messages.map((msg) => {
    if (msg.role === "user") {
      // 把 image blocks 替换为 "(image omitted: model does not support images)"
      return { ...msg, content: replaceImagesWithPlaceholder(msg.content) };
    }
    return msg;
  });
}
```

---

## 5. providerOptions: Provider 特定配置

### 5.1 为什么需要 providerOptions

不同 provider 有各自特有的功能:

- **Anthropic**: extended thinking (`thinking.budgetTokens`)
- **OpenAI**: reasoning effort (`reasoningEffort: "high"`)
- **Google**: safety settings、grounding

`providerOptions` 提供了一种类型安全的方式来传递这些配置:

```typescript
const result = await streamText({
  model: anthropic("claude-sonnet-4-5"),
  prompt: "Explain quantum computing",
  providerOptions: {
    anthropic: {
      thinking: {
        type: "enabled",
        budgetTokens: 10000,
      },
    },
  },
});
```

### 5.2 用 defaultSettingsMiddleware 预配置

可以用 middleware 把 providerOptions 烤入模型配置:

```typescript
import { wrapLanguageModel, defaultSettingsMiddleware } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const claudeWithThinking = wrapLanguageModel({
  model: anthropic("claude-sonnet-4-5"),
  middleware: defaultSettingsMiddleware({
    settings: {
      maxOutputTokens: 64000,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 32000 },
        },
      },
    },
  }),
});
```

---

## 6. 构建统一的 createStream 入口

### 6.1 设计目标

一个 agent 需要一个统一的 stream 入口,它应该:

1. 根据 model key 从 registry 获取模型
2. 自动应用 middleware (日志、缓存等)
3. 处理跨 provider 的消息转换
4. 返回统一的事件流

### 6.2 伪代码

```typescript
async function createStream(options: {
  modelKey: string; // "openai/gpt-4o"
  messages: Message[];
  tools?: Tool[];
  abortSignal?: AbortSignal;
}) {
  // 1. 从 registry 获取模型
  const entry = registry.get(options.modelKey);
  if (!entry) throw new Error(`Unknown model: ${options.modelKey}`);

  // 2. 转换消息以兼容目标模型
  const transformedMessages = transformMessages(options.messages, entry.model);

  // 3. 应用 middleware
  const wrappedModel = wrapLanguageModel({
    model: entry.model,
    middleware: [loggingMiddleware],
  });

  // 4. 调用 streamText
  const result = streamText({
    model: wrappedModel,
    messages: transformedMessages,
    tools: options.tools,
    abortSignal: options.abortSignal,
  });

  return result;
}
```

### 6.3 pi 的实际实现

pi 的 `getApiProvider()` + `stream()` 模式本质上就是这个思路,但更底层:

```typescript
// 获取 provider
const provider = getApiProvider(model.api); // 通过 API 协议查找

// 调用 stream (内部会处理懒加载)
const eventStream = provider.stream(model, context, options);

// eventStream 是一个 AssistantMessageEventStream
// 可以 for-await 或者监听事件
for await (const event of eventStream) {
  if (event.type === "text") {
    /* 处理文本 */
  }
  if (event.type === "tool_call") {
    /* 处理工具调用 */
  }
  if (event.type === "thinking") {
    /* 处理推理 */
  }
}
```

---

## 7. 本课代码示例

完整的可运行代码在 `code/` 目录下:

| 文件                         | 说明                                  |
| ---------------------------- | ------------------------------------- |
| `code/src/model-registry.ts` | ModelRegistry 类,支持注册、查询、列举 |
| `code/src/middleware.ts`     | Logging middleware 实现               |
| `code/src/create-stream.ts`  | 统一的 `createStream()` 入口          |
| `code/src/demo.ts`           | 在 OpenAI 和 Anthropic 之间切换的演示 |

---

## 动手练习

1. **运行 demo，在 OpenAI 和 Anthropic 之间切换**

   ```bash
   npx tsx src/demo.ts
   ```

   观察输出中 provider 和 model 的变化。修改 `demo.ts` 中的 model key，分别使用 `"openai/gpt-4o"` 和 `"anthropic/claude-sonnet-4-5"` 发送同一条 prompt，对比两个 provider 的响应格式和内容差异。

2. **实现一个 caching middleware**
   在 `code/src/middleware.ts` 中，参照课程中的 `cachingMiddleware` 示例，实现一个基于 `Map` 的缓存中间件。将它注册到 `createStream()` 的 middleware 数组中，然后连续两次用相同的 prompt 调用 `createStream()`，验证第二次调用命中缓存（不产生实际 LLM 请求）:

   ```bash
   npx tsx src/demo.ts cache
   ```

   检查日志输出，确认第二次调用的耗时接近 0ms。

3. **向 ModelRegistry 添加一个新 provider**
   在 `code/src/model-registry.ts` 中注册一个新的 provider（例如 `google/gemini-2.5-flash`）。你需要:
   - 安装对应的 SDK 包（`@ai-sdk/google`）
   - 在 registry 中调用 `register("google", "gemini-2.5-flash", google("gemini-2.5-flash"))`
   - 修改 `demo.ts`，用新注册的 model key 发送请求并验证响应
   ```bash
   npm install @ai-sdk/google
   npx tsx src/demo.ts google
   ```
   确认新 provider 能正常返回流式响应。

---

## 8. 关键 Takeaways

1. **Provider 即 npm 包**: AI SDK 的设计让你只加载用到的 provider,天然按需加载
2. **Middleware 是增强而非修改**: `wrapLanguageModel()` 不改变原始模型,而是创建一个增强版本
3. **Registry 解耦模型选择和使用**: 调用者只需要一个字符串 key,不需要知道底层用的是哪个 SDK
4. **跨 provider 兼容是真实痛点**: thinking blocks、tool call ID 格式、图片支持差异都需要处理
5. **懒加载很重要**: pi 的 `createLazyStream` 模式确保启动速度不受 provider 数量影响
6. **消息转换是必需的**: 在模型切换时,必须对历史消息做适配,否则 API 会报错
