/**
 * Token estimation strategies.
 *
 * Three approaches ordered by accuracy vs. complexity:
 * 1. chars/4 heuristic - fast, no dependencies, ~70-80% accurate
 * 2. Provider usage - exact, but only available post-response
 * 3. tiktoken - near-exact for OpenAI models, requires WASM dep
 */

import type { CoreMessage } from "ai";

// ---------------------------------------------------------------------------
// Strategy 1: chars/4 heuristic (what pi uses)
// ---------------------------------------------------------------------------

/**
 * Estimate token count using chars/4 heuristic.
 * Conservative (overestimates), which is safer for threshold decisions.
 *
 * Special cases:
 * - Images: fixed estimate of ~1200 tokens (4800 chars)
 * - Tool calls: include function name + serialized arguments
 */
export function estimateTokensChars4(message: CoreMessage): number {
  let chars = 0;

  switch (message.role) {
    case "user": {
      if (typeof message.content === "string") {
        chars = message.content.length;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text") {
            chars += part.text.length;
          } else if (part.type === "image") {
            chars += 4800; // ~1200 tokens for an image
          }
        }
      }
      break;
    }
    case "assistant": {
      if (typeof message.content === "string") {
        chars = message.content.length;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text") {
            chars += part.text.length;
          } else if (part.type === "tool-call") {
            chars += part.toolName.length;
            chars += JSON.stringify(part.args).length;
          }
        }
      }
      break;
    }
    case "tool": {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "tool-result") {
            if (typeof part.result === "string") {
              chars += part.result.length;
            } else {
              chars += JSON.stringify(part.result).length;
            }
          }
        }
      }
      break;
    }
    case "system": {
      if (typeof message.content === "string") {
        chars = message.content.length;
      }
      break;
    }
  }

  return Math.ceil(chars / 4);
}

// ---------------------------------------------------------------------------
// Strategy 2: Usage-based (from LLM response)
// ---------------------------------------------------------------------------

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

/**
 * Calculate context tokens from LLM usage report.
 * Uses totalTokens if available, otherwise sums components.
 */
export function calculateContextTokens(usage: TokenUsage): number {
  return usage.totalTokens ?? usage.promptTokens + usage.completionTokens;
}

// ---------------------------------------------------------------------------
// Combined estimator (pi's approach)
// ---------------------------------------------------------------------------

export interface ContextEstimate {
  /** Total estimated context tokens */
  tokens: number;
  /** Tokens from the last known usage report */
  usageTokens: number;
  /** Estimated tokens for messages after the last usage */
  trailingTokens: number;
  /** Index of last message with usage data, or null */
  lastUsageIndex: number | null;
}

/**
 * Estimate total context tokens using the best available data.
 *
 * Strategy: Use the last known LLM usage report (exact) for everything up to
 * that point, then estimate trailing messages with chars/4.
 *
 * @param messages - Conversation messages
 * @param lastUsage - Usage from the last assistant response, if available
 * @param lastUsageIndex - Index of the message that produced lastUsage
 */
export function estimateContextTokens(
  messages: CoreMessage[],
  lastUsage?: TokenUsage,
  lastUsageIndex?: number,
): ContextEstimate {
  // No usage data: estimate everything with chars/4
  if (!lastUsage || lastUsageIndex === undefined) {
    let estimated = 0;
    for (const msg of messages) {
      estimated += estimateTokensChars4(msg);
    }
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }

  // Use exact usage + estimate trailing messages
  const usageTokens = calculateContextTokens(lastUsage);
  let trailingTokens = 0;
  for (let i = lastUsageIndex + 1; i < messages.length; i++) {
    trailingTokens += estimateTokensChars4(messages[i]);
  }

  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
  };
}

// ---------------------------------------------------------------------------
// Utility: estimate total tokens for a message array
// ---------------------------------------------------------------------------

export function estimateTotalTokens(messages: CoreMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokensChars4(msg);
  }
  return total;
}
