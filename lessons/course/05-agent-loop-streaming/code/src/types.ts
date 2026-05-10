// ============================================================================
// Lesson 5: Agent Loop (Part 1) -- Type Definitions
//
// Imports and re-exports types from Lesson 4, then adds:
// - StreamFn: injectable stream function type
// - AgentLoopConfig: full loop configuration
// - LLM context types needed for the streaming pipeline
// ============================================================================

import type { CoreMessage, LanguageModel } from "ai";

// ---------------------------------------------------------------------------
// Re-export foundational types from Lesson 4 concepts
// ---------------------------------------------------------------------------

/** Text content block. */
export interface TextContent {
  type: "text";
  text: string;
}

/** Image content block. */
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** Tool call block inside an assistant message. */
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** User message. */
export interface UserMessage {
  role: "user";
  content: (TextContent | ImageContent)[];
  timestamp: number;
}

/** Assistant message returned by the model. */
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ToolCallContent)[];
  model: string;
  provider: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

/** Tool result message. */
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

/** Token usage statistics. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** Why the model stopped generating. */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** Union of LLM-level messages. */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** Extensible custom message interface (apps extend via declaration merging). */
export interface CustomAgentMessages {}

/** AgentMessage: union of LLM messages + any custom messages. */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ---------------------------------------------------------------------------
// Model metadata (simplified)
// ---------------------------------------------------------------------------

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// Tool types (from Lesson 4, simplified)
// ---------------------------------------------------------------------------

export interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  terminate?: boolean;
}

export interface AgentTool<TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<TDetails>>;
}

// ---------------------------------------------------------------------------
// AgentContext -- snapshot passed into the loop
// ---------------------------------------------------------------------------

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

// ---------------------------------------------------------------------------
// AgentEvent -- discriminated union (from Lesson 4, extended for streaming)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; delta?: string }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    };

// ---------------------------------------------------------------------------
// NEW in Lesson 5: StreamFn type
// ---------------------------------------------------------------------------

/**
 * StreamFn wraps the actual LLM call. It takes an AI SDK LanguageModel,
 * CoreMessage[], a system prompt, and an AbortSignal. It returns the
 * streamText result object.
 *
 * This indirection allows:
 * - Injecting mock streams for testing
 * - Swapping between different AI SDK versions
 * - Adding middleware (logging, retry) at the stream level
 */
export type StreamFn = (opts: {
  model: LanguageModel;
  system: string;
  messages: CoreMessage[];
  signal?: AbortSignal;
}) => StreamResult;

/**
 * Simplified representation of the streamText return value.
 * We only need fullStream for our pipeline.
 */
export interface StreamResult {
  fullStream: AsyncIterable<StreamPart>;
  /** Promise that resolves to the complete text after the stream finishes. */
  text: Promise<string>;
  /** Promise that resolves to the finish reason. */
  finishReason: Promise<string>;
  /** Promise that resolves to token usage. */
  usage: Promise<{ promptTokens: number; completionTokens: number; totalTokens: number }>;
}

/**
 * Subset of AI SDK fullStream event types that we handle.
 * This is simplified -- the real AI SDK has more event types.
 */
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
// AgentEventSink -- callback to push events out of the loop
// ---------------------------------------------------------------------------

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

// ---------------------------------------------------------------------------
// AgentLoopConfig -- full loop configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a single agent loop run.
 *
 * This is the "control surface" for the loop. The Agent class builds
 * this from its own fields before each run.
 */
export interface AgentLoopConfig {
  /** AI SDK LanguageModel instance. */
  languageModel: LanguageModel;

  /** Model metadata for recording in AssistantMessage. */
  model: Model;

  /**
   * Convert AgentMessage[] to AI SDK CoreMessage[] before the LLM call.
   * Filters out custom messages, keeps only user/assistant/toolResult.
   */
  convertToLlm: (messages: AgentMessage[]) => CoreMessage[];

  /**
   * Optional transform applied to AgentMessage[] before convertToLlm.
   * Use for context window management, injection, etc.
   */
  transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]> | AgentMessage[];

  /**
   * Injectable stream function. Defaults to a wrapper around AI SDK streamText.
   */
  streamFn?: StreamFn;
}
