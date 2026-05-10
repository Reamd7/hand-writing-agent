// =============================================================================
// Lesson 2: Custom Agent Message & Event Type Definitions
//
// This file demonstrates how to design a typed message model for an AI agent,
// inspired by pi's packages/ai/src/types.ts and packages/agent/src/types.ts.
// =============================================================================

// ---------------------------------------------------------------------------
// 1. Content Block Types
// ---------------------------------------------------------------------------

/** Plain text content block. */
export interface TextContent {
  type: "text";
  text: string;
}

/** Image content block (base64-encoded). */
export interface ImageContent {
  type: "image";
  data: string; // base64 encoded
  mimeType: string; // e.g. "image/png", "image/jpeg"
}

/** Model reasoning/thinking content block. */
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Opaque signature for multi-turn reasoning continuity (provider-specific). */
  thinkingSignature?: string;
  /** True when the thinking content was redacted by safety filters. */
  redacted?: boolean;
}

/** A tool call requested by the assistant. */
export interface ToolCall {
  type: "toolCall";
  /** Unique identifier for this tool call instance. */
  id: string;
  /** Name of the tool to invoke. */
  name: string;
  /** Parsed arguments matching the tool's input schema. */
  arguments: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 2. Token Usage Tracking
// ---------------------------------------------------------------------------

/** Token usage and cost breakdown for a single LLM call. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// 3. Message Types (LLM-level)
// ---------------------------------------------------------------------------

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** A message from the user. */
export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

/** A message from the assistant (LLM response). */
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  model: string;
  provider: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

/** Result of executing a tool call, sent back to the model. */
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

/** Union of all LLM-level message types. */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// 4. Extensible AgentMessage (declaration merging pattern)
// ---------------------------------------------------------------------------

/**
 * Extensible interface for custom app-level messages.
 *
 * Apps extend this via TypeScript declaration merging:
 *
 * @example
 * ```typescript
 * declare module "./types" {
 *   interface CustomAgentMessages {
 *     artifact: { role: "artifact"; name: string; content: string; timestamp: number };
 *     status: { role: "status"; text: string; timestamp: number };
 *   }
 * }
 * ```
 *
 * After merging, AgentMessage automatically includes the new types.
 */
export interface CustomAgentMessages {
  // Empty by default - apps extend via declaration merging
}

/**
 * AgentMessage is the union of base LLM messages and any custom messages
 * registered through declaration merging on CustomAgentMessages.
 *
 * This allows the agent framework to handle arbitrary app-specific message
 * types while preserving full type safety.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ---------------------------------------------------------------------------
// 5. Agent Context
// ---------------------------------------------------------------------------

/** Tool definition for the agent runtime. */
export interface AgentToolDef {
  name: string;
  description: string;
  /** JSON Schema or Zod schema describing the tool's input parameters. */
  parameters: Record<string, unknown>;
}

/** Snapshot of the agent's current context, passed to the LLM. */
export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentToolDef[];
}

// ---------------------------------------------------------------------------
// 6. Agent Events (UI update protocol)
// ---------------------------------------------------------------------------

/**
 * Events emitted by the agent for UI rendering and state management.
 *
 * Lifecycle:
 *   agent_start
 *     -> turn_start
 *       -> message_start (assistant)
 *         -> message_update* (streaming deltas)
 *       -> message_end (assistant)
 *       -> tool_execution_start*
 *         -> tool_execution_update* (partial results)
 *       -> tool_execution_end*
 *       -> message_start* (toolResult)
 *       -> message_end* (toolResult)
 *     -> turn_end
 *     -> (repeat turns if tool calls trigger follow-ups)
 *   agent_end
 */
export type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      message: AgentMessage;
      /** The raw streaming event from the LLM provider layer. */
      streamEvent: AssistantStreamEvent;
    }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution lifecycle
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

// ---------------------------------------------------------------------------
// 7. Assistant Stream Events (maps to fullStream event types)
// ---------------------------------------------------------------------------

/**
 * Streaming events from the LLM layer, modeled after AI SDK's fullStream
 * protocol with adaptations matching pi's AssistantMessageEvent.
 */
export type AssistantStreamEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };
