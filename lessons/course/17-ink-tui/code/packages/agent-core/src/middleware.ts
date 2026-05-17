/**
 * Lesson 3: Language Model Middleware
 *
 * Demonstrates the wrapLanguageModel + middleware pattern for logging,
 * caching, and guardrails. These middleware implementations are
 * model-agnostic -- they work with any AI SDK provider.
 */

import { wrapLanguageModel } from "ai";
import type {
  LanguageModelV3 as LanguageModel,
  LanguageModelV3Middleware as LanguageModelMiddleware,
  LanguageModelV3StreamPart as StreamPart,
} from "@ai-sdk/provider";

// ---------------------------------------------------------------------------
// Logging Middleware
// ---------------------------------------------------------------------------

export interface LoggingOptions {
  /** Custom logger function. Defaults to console.log. */
  log?: (...args: unknown[]) => void;
  /** Whether to log the full params object. Defaults to false. */
  verbose?: boolean;
}

/**
 * Creates a middleware that logs every generate/stream call with timing info.
 *
 * Usage:
 *   const model = wrapLanguageModel({
 *     model: openai("gpt-4o"),
 *     middleware: createLoggingMiddleware(),
 *   });
 */
export function createLoggingMiddleware(options: LoggingOptions = {}): LanguageModelMiddleware {
  const log = options.log ?? console.log;
  const verbose = options.verbose ?? false;

  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const startTime = Date.now();
      log("[LLM:generate] start", {
        model: (model as any).modelId ?? "unknown",
        promptMessages: params.prompt.length,
        ...(verbose ? { params } : {}),
      });

      const result = await doGenerate();

      const elapsed = Date.now() - startTime;
      log("[LLM:generate] done", {
        model: (model as any).modelId ?? "unknown",
        elapsed: `${elapsed}ms`,
        usage: result.usage,
        finishReason: result.finishReason,
      });

      return result;
    },

    wrapStream: async ({ doStream, params, model }) => {
      const startTime = Date.now();
      log("[LLM:stream] start", {
        model: (model as any).modelId ?? "unknown",
        promptMessages: params.prompt.length,
      });

      const { stream, ...rest } = await doStream();

      let tokenCount = 0;

      const transformStream = new TransformStream<StreamPart, StreamPart>({
        transform(chunk, controller) {
          if (chunk.type === "text-delta") {
            tokenCount++;
          }
          controller.enqueue(chunk);
        },
        flush() {
          const elapsed = Date.now() - startTime;
          log("[LLM:stream] done", {
            model: (model as any).modelId ?? "unknown",
            elapsed: `${elapsed}ms`,
            textChunks: tokenCount,
          });
        },
      });

      return {
        stream: stream.pipeThrough(transformStream),
        ...rest,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Caching Middleware
// ---------------------------------------------------------------------------

/**
 * A simple in-memory cache middleware for non-streaming calls.
 * In production you would use Redis, SQLite, or a file-based cache.
 *
 * Note: Caching only applies to doGenerate (non-streaming). Streaming
 * calls always go through to the model, since replaying a cached stream
 * requires more complex infrastructure.
 */
export function createCachingMiddleware(): LanguageModelMiddleware {
  const cache = new Map<string, unknown>();

  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const cacheKey = JSON.stringify({
        modelId: (model as any).modelId,
        prompt: params.prompt,
      });

      const cached = cache.get(cacheKey);
      if (cached) {
        console.log("[LLM:cache] hit");
        return cached as Awaited<ReturnType<typeof doGenerate>>;
      }

      console.log("[LLM:cache] miss");
      const result = await doGenerate();
      cache.set(cacheKey, result);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Guardrail Middleware
// ---------------------------------------------------------------------------

export interface GuardrailOptions {
  /** Patterns to redact from generated text. */
  redactPatterns?: RegExp[];
  /** Replacement string for redacted content. */
  redactReplacement?: string;
}

/**
 * Creates a middleware that applies content guardrails to generated text.
 * Currently only supports non-streaming (doGenerate).
 */
export function createGuardrailMiddleware(options: GuardrailOptions = {}): LanguageModelMiddleware {
  const patterns = options.redactPatterns ?? [];
  const replacement = options.redactReplacement ?? "<REDACTED>";

  function redact(text: string): string {
    let result = text;
    for (const pattern of patterns) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();

      const resultAny = result as any;
      if (resultAny.text) {
        return { ...result, text: redact(resultAny.text) } as any;
      }

      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: Apply middleware to a model
// ---------------------------------------------------------------------------

/**
 * Convenience function to wrap a model with multiple middlewares at once.
 *
 * @example
 *   const model = applyMiddleware(baseModel, [
 *     createLoggingMiddleware(),
 *     createCachingMiddleware(),
 *   ]);
 */
export function applyMiddleware(
  model: LanguageModel,
  middleware: LanguageModelMiddleware[],
): LanguageModel {
  return wrapLanguageModel({ model, middleware });
}
