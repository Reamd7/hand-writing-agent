// ============================================================================
// Lesson 4: Agent State and Event Model -- Type Definitions
//
// Re-exports types from @earendil-works/pi-ai and @earendil-works/pi-agent-core.
// Lesson-specific types (MutableAgentState, AgentLoopConfig, etc.) are defined
// locally and reference the imported types.
// ============================================================================

// ---------------------------------------------------------------------------
// From pi-ai: LLM-layer types
// ---------------------------------------------------------------------------
import type {
  TextContent,
  ImageContent,
  ToolCall,
  Usage,
  StopReason,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  Model,
} from "@earendil-works/pi-ai";

export type {
  TextContent,
  ImageContent,
  ToolCall,
  Usage,
  StopReason,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  Model,
};

// Backward-compat alias: lesson code uses ToolCallContent as the name
export type { ToolCall as ToolCallContent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// From pi-agent-core: Agent-layer types
// ---------------------------------------------------------------------------
import type {
  CustomAgentMessages,
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentTool,
  AgentContext,
  AgentState,
  AgentEventSink,
  AgentToolCall,
  ThinkingLevel,
  ToolExecutionMode,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
} from "@earendil-works/pi-agent-core";

export type {
  CustomAgentMessages,
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentTool,
  AgentContext,
  AgentState,
  AgentEventSink,
  AgentToolCall,
  ThinkingLevel,
  ToolExecutionMode,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
};

// ---------------------------------------------------------------------------
// Lesson-specific types: AgentEvent (progressive -- no streaming event yet)
// ---------------------------------------------------------------------------

/**
 * Events emitted by the Agent for UI updates and state management.
 *
 * This is a progressive version that omits the streaming-level
 * `assistantMessageEvent` field on `message_update` (introduced later
 * in lesson 5). The canonical AgentEvent from pi-agent-core includes it.
 */
export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent;

export interface AgentStartEvent {
  type: "agent_start";
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}

export interface TurnStartEvent {
  type: "turn_start";
}

export interface TurnEndEvent {
  type: "turn_end";
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}

export interface MessageStartEvent {
  type: "message_start";
  message: AgentMessage;
}

export interface MessageUpdateEvent {
  type: "message_update";
  message: AgentMessage;
  delta?: string;
}

export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: AgentToolResult<any>;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: AgentToolResult<any>;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Lesson-specific: MutableAgentState
// ---------------------------------------------------------------------------

/**
 * Internal writable version of AgentState.
 * Removes `readonly` from runtime fields so the Agent class and loop
 * internals can update them.
 */
export type MutableAgentState = Omit<
  AgentState,
  "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

// ---------------------------------------------------------------------------
// Lesson-specific: Simplified AgentLoopConfig (full version in pi-agent-core)
// ---------------------------------------------------------------------------

/** Configuration for a single agent loop run (simplified for this lesson). */
export interface AgentLoopConfig {
  model: Model<any>;
  thinkingLevel?: ThinkingLevel;
  /** Global tool execution mode. Default: "parallel". */
  toolExecution?: ToolExecutionMode;
  /** Called before a tool executes, after argument validation. */
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  /** Called after a tool executes, before events are emitted. */
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  /** Fake LLM stream function (used by the tool-execution loop). */
  streamFn?: (context: AgentContext, signal?: AbortSignal) => Promise<AssistantMessage>;
}

// ---------------------------------------------------------------------------
// Lesson-specific: AgentOptions
// ---------------------------------------------------------------------------

/** Options for constructing an Agent. */
export interface AgentOptions {
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >;
}

// ---------------------------------------------------------------------------
// Lesson-specific: AgentEventListener
// ---------------------------------------------------------------------------

export type AgentEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
