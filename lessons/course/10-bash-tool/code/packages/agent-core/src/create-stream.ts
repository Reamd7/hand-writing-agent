/**
 * Lesson 3: Unified createStream Entry Point
 *
 * A single function that:
 * 1. Resolves a model from the registry by key
 * 2. Transforms messages for cross-provider compatibility
 * 3. Applies middleware (logging, etc.)
 * 4. Calls streamText and returns the result
 *
 * This mirrors the pattern used in pi's agent loop where
 * getApiProvider(model.api).stream(model, context, options) is the
 * central dispatch point.
 */

import { streamText, wrapLanguageModel } from "ai";
import type {
  LanguageModelV3 as LanguageModel,
  LanguageModelV3Middleware as LanguageModelMiddleware,
} from "@ai-sdk/provider";
import type { ModelRegistry } from "./model-registry.js";
import { createLoggingMiddleware } from "./middleware.js";

// ---------------------------------------------------------------------------
// Message types (from pi-ai, with lesson-specific additions)
// ---------------------------------------------------------------------------

import type { TextContent, ThinkingContent } from "@earendil-works/pi-ai";
export type { TextContent, ThinkingContent };

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

export type Message = AssistantMessageRecord | UserMessage;

// ---------------------------------------------------------------------------
// Cross-provider message transformation
// ---------------------------------------------------------------------------

/**
 * Transform conversation history for compatibility with the target model.
 *
 * This is a simplified version of pi's transformMessages() from
 * packages/ai/src/providers/transform-messages.ts. The real implementation
 * also handles:
 * - Tool call ID normalization (OpenAI 450+ chars vs Anthropic 64 char limit)
 * - Synthetic tool result insertion for orphaned tool calls
 * - Image content downgrade for non-vision models
 * - Error/aborted assistant message filtering
 */
function transformMessages(
  messages: Message[],
  targetProvider: string,
  targetModelId: string,
): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const isSameModel = msg.provider === targetProvider && msg.model === targetModelId;

    const transformedContent = msg.content.flatMap((block): (TextContent | ThinkingContent | ToolCallContent)[] => {
      if (block.type === "thinking") {
        // Redacted/encrypted thinking is only valid for the same model
        if (block.redacted) {
          return isSameModel ? [block] : [];
        }

        // Same model with signature: keep for replay
        if (isSameModel && block.thinkingSignature) {
          return [block];
        }

        // Empty thinking: drop
        if (!block.thinking?.trim()) {
          return [];
        }

        // Same model: keep as-is
        if (isSameModel) return [block];

        // Cross-model: downgrade to plain text so the reasoning
        // context is preserved but provider-specific metadata is stripped
        return [{ type: "text" as const, text: block.thinking } as TextContent];
      }

      return [block];
    });

    return { ...msg, content: transformedContent };
  });
}

/**
 * Convert our Message[] to the format expected by AI SDK's streamText.
 */
function toSdkMessages(messages: Message[]): Array<{
  role: "user" | "assistant";
  content: string;
}> {
  return messages.map((msg) => {
    if (msg.role === "user") {
      return { role: "user" as const, content: msg.content };
    }

    // For assistant messages, concatenate text content
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
  /** Model key in "provider/modelId" format */
  modelKey: string;
  /** Conversation history */
  messages: Message[];
  /** System prompt */
  system?: string;
  /** Additional middleware to apply on top of defaults */
  middleware?: LanguageModelMiddleware[];
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Provider-specific options (e.g. Anthropic thinking config) */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Unified streaming entry point.
 *
 * Resolves the model from the registry, transforms messages for
 * cross-provider compatibility, applies middleware, and returns
 * an AI SDK streamText result.
 */
export function createStream(registry: ModelRegistry, options: CreateStreamOptions): ReturnType<typeof streamText> {
  const {
    modelKey,
    messages,
    system,
    middleware: extraMiddleware = [],
    abortSignal,
    providerOptions,
  } = options;

  // 1. Resolve model from registry
  const entry = registry.getOrThrow(modelKey);

  // 2. Transform messages for cross-provider compatibility
  const transformed = transformMessages(messages, entry.provider, entry.modelId);

  // 3. Convert to SDK message format
  const sdkMessages = toSdkMessages(transformed);

  // 4. Apply middleware: default logging + any extras
  const allMiddleware: LanguageModelMiddleware[] = [createLoggingMiddleware(), ...extraMiddleware];

  const wrappedModel: LanguageModel = wrapLanguageModel({
    model: entry.model,
    middleware: allMiddleware,
  });

  // 5. Call streamText
  return streamText({
    model: wrappedModel,
    messages: sdkMessages,
    system,
    abortSignal,
    providerOptions: providerOptions as any,
  });
}
