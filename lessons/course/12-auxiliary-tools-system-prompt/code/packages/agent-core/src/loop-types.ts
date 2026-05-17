// ============================================================================
// Lesson 5: Agent Loop (Part 1) -- Streaming-specific Type Definitions
//
// Types introduced in Lesson 5 that don't exist in L04's types.ts.
// These support the streaming pipeline (StreamFn, StreamResult, etc.)
// and the streaming-aware loop configuration.
// ============================================================================

import type { ModelMessage, LanguageModel } from "ai";
import type { AgentEvent, AgentMessage, Model } from "./types.js";

// ---------------------------------------------------------------------------
// StreamFn: wraps AI SDK streamText for injection / mocking
// ---------------------------------------------------------------------------

/**
 * StreamFn wraps the actual LLM call. This indirection allows:
 * - Injecting mock streams for testing
 * - Swapping between different AI SDK versions
 * - Adding middleware at the stream level
 */
export type StreamFn = (opts: {
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  signal?: AbortSignal;
}) => StreamResult;

// ---------------------------------------------------------------------------
// StreamResult: simplified representation of streamText return value
// ---------------------------------------------------------------------------

export interface StreamResult {
  fullStream: AsyncIterable<StreamPart>;
  text: Promise<string>;
  finishReason: Promise<string>;
  usage: Promise<{ promptTokens: number; completionTokens: number; totalTokens: number }>;
}

// ---------------------------------------------------------------------------
// StreamPart: subset of AI SDK fullStream event types that we handle
// ---------------------------------------------------------------------------

export type StreamPart =
  | { type: "text-delta"; textDelta: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool-call-streaming-start"; toolCallId: string; toolName: string }
  | { type: "tool-call-delta"; toolCallId: string; toolName: string; argsTextDelta: string }
  | {
      type: "finish";
      finishReason: string;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    }
  | { type: "error"; error: unknown }
  | { type: "reasoning"; textDelta: string }
  | { type: "start"; messageId?: string }
  | { type: "start-step"; messageId?: string }
  | {
      type: "finish-step";
      finishReason: string;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    };

// ---------------------------------------------------------------------------
// AgentEventSink: local version using lesson's AgentEvent
// ---------------------------------------------------------------------------

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

// ---------------------------------------------------------------------------
// StreamingLoopConfig: L05's AgentLoopConfig (renamed to avoid conflict)
// ---------------------------------------------------------------------------

/**
 * Configuration for a single agent loop run (streaming version).
 * The Agent class builds this from its own fields before each run.
 *
 * Named StreamingLoopConfig to avoid conflict with L04's AgentLoopConfig
 * which has different fields (model, thinkingLevel, toolExecution).
 */
export interface StreamingLoopConfig {
  /** AI SDK LanguageModel instance. */
  languageModel: LanguageModel;
  /** Model metadata for recording in AssistantMessage. */
  model: Model<any>;
  /** Convert AgentMessage[] to AI SDK CoreMessage[] before the LLM call. */
  convertToLlm: (messages: AgentMessage[]) => ModelMessage[];
  /** Optional transform applied to AgentMessage[] before convertToLlm. */
  transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]> | AgentMessage[];
  /** Injectable stream function. Defaults to a wrapper around AI SDK streamText. */
  streamFn?: StreamFn;
}
