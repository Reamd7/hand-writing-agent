/**
 * Lesson 3: Unified createStream Entry Point
 *
 * 统一 streaming 入口函数：
 * 1. 从 ProviderRegistry 按 key 解析模型（懒加载 SDK）
 * 2. 跨 provider 消息兼容性转换
 * 3. 应用中间件（logging 等）
 * 4. 调用 streamText 返回结果
 *
 * 消息转换逻辑保留自 Lesson 3 原版（pi 的 transformMessages 简化版）。
 * OpenCode 在 provider/transform.ts 做更全面的处理。
 */

import { streamText, wrapLanguageModel } from "ai";
import type {
  LanguageModelV3 as LanguageModel,
  LanguageModelV3Middleware as LanguageModelMiddleware,
} from "@ai-sdk/provider";
import type { ProviderRegistry } from "./provider/registry.js";
import { createLoggingMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  args: string;
}

export interface AssistantMessageRecord {
  role: "assistant";
  provider: string;
  model: string;
  content: (TextContent | ThinkingContent | ToolCallContent)[];
}

export interface UserMessage {
  role: "user";
  content: string;
}

export type StreamMessage = AssistantMessageRecord | UserMessage;

// ---------------------------------------------------------------------------
// Cross-provider message transformation
// ---------------------------------------------------------------------------

/**
 * 为目标模型转换对话历史的兼容性。
 *
 * 处理：
 * - 跨模型场景的 thinking block 降级
 * - Redacted / signed thinking 验证
 *
 * OpenCode 在 provider/transform.ts 做更全面的版本
 * （Anthropic 空内容、tool-call ID 清理、reasoning parts 等），
 * 后续课程会扩展。
 */
function transformMessages(
  messages: StreamMessage[],
  targetProvider: string,
  targetModelId: string,
): StreamMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const isSameModel =
      msg.provider === targetProvider && msg.model === targetModelId;

    const transformedContent = msg.content.flatMap(
      (block): (TextContent | ThinkingContent | ToolCallContent)[] => {
        if (block.type === "thinking") {
          if (block.redacted) return isSameModel ? [block] : [];
          if (isSameModel && block.thinkingSignature) return [block];
          if (!block.thinking?.trim()) return [];
          if (isSameModel) return [block];
          // 跨模型：降级为纯文本
          return [{ type: "text" as const, text: block.thinking }];
        }
        return [block];
      },
    );

    return { ...msg, content: transformedContent };
  });
}

/**
 * 将 StreamMessage[] 转换为 AI SDK streamText 期望的格式。
 */
function toSdkMessages(
  messages: StreamMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages.map((msg) => {
    if (msg.role === "user") {
      return { role: "user" as const, content: msg.content };
    }

    const text = msg.content
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join("");

    return { role: "assistant" as const, content: text };
  });
}

// ---------------------------------------------------------------------------
// createStream
// ---------------------------------------------------------------------------

export interface CreateStreamOptions {
  /** "provider/modelId" 格式的模型键 */
  modelKey: string;
  /** 对话历史 */
  messages: StreamMessage[];
  /** 系统提示词 */
  system?: string;
  /** 在默认中间件之上附加的中间件 */
  middleware?: LanguageModelMiddleware[];
  /** 取消信号 */
  abortSignal?: AbortSignal;
  /** Provider 特有选项（如 Anthropic thinking 配置） */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * 统一 streaming 入口。
 *
 * 与 Lesson 3 原版的关键区别：使用 ProviderRegistry 做异步模型解析
 * （懒加载 SDK），所以这个函数现在是 async 的。
 */
export async function createStream(
  registry: ProviderRegistry,
  options: CreateStreamOptions,
): Promise<ReturnType<typeof streamText>> {
  const {
    modelKey,
    messages,
    system,
    middleware: extraMiddleware = [],
    abortSignal,
    providerOptions,
  } = options;

  // 1. 从 registry 解析模型（async — 触发懒加载 SDK）
  const languageModel = await registry.getLanguageModel(modelKey);

  // 2. 获取 provider/model 信息用于消息转换
  const { provider, model } = registry.getModel(modelKey);

  // 3. 跨 provider 消息兼容性转换
  const transformed = transformMessages(messages, provider.id, model.id);

  // 4. 转换为 SDK 消息格式
  const sdkMessages = toSdkMessages(transformed);

  // 5. 应用中间件：默认 logging + 额外中间件
  const allMiddleware: LanguageModelMiddleware[] = [
    createLoggingMiddleware(),
    ...extraMiddleware,
  ];

  const wrappedModel: LanguageModel = wrapLanguageModel({
    model: languageModel,
    middleware: allMiddleware,
  });

  // 6. 合并 model 级别选项与调用者选项
  const mergedProviderOptions = {
    ...model.options,
    ...providerOptions,
  };

  // 7. 调用 streamText
  return streamText({
    model: wrappedModel,
    messages: sdkMessages,
    system,
    abortSignal,
    providerOptions: mergedProviderOptions as any,
  });
}
