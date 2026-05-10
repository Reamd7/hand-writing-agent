// ============================================================================
// Lesson 6: Tool Call Execution Engine -- Type Definitions
//
// Types for the three-stage tool execution pipeline (prepare/execute/finalize),
// lifecycle hooks (beforeToolCall/afterToolCall), and the agent loop config
// that ties everything together.
// ============================================================================

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface UserMessage {
  role: "user";
  content: (TextContent | ImageContent)[];
  timestamp: number;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ToolCallContent)[];
  model: string;
  provider: string;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
export type AgentMessage = Message;

// ---------------------------------------------------------------------------
// Tool types
// ---------------------------------------------------------------------------

/** A single tool call content block from an assistant message. */
export type AgentToolCall = ToolCallContent;

/** Final or partial result produced by a tool. */
export interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  /**
   * Hint that the agent should stop after the current tool batch.
   * Early termination only happens when ALL finalized tools set this to true.
   */
  terminate?: boolean;
}

/** Callback for streaming partial tool execution updates. */
export type AgentToolUpdateCallback<TDetails = unknown> = (
  partialResult: AgentToolResult<TDetails>,
) => void;

/** Execution mode: sequential or parallel. */
export type ToolExecutionMode = "sequential" | "parallel";

/** Tool definition used by the agent runtime. */
export interface AgentTool<TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
  /**
   * Optional argument shim that runs BEFORE schema validation.
   * Use this to normalize LLM-generated arguments (fix paths, coerce types, etc.)
   */
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  /** Execute the tool. Throw on failure. */
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /**
   * Per-tool execution mode override.
   * If any tool in a batch is "sequential", the entire batch runs sequentially.
   */
  executionMode?: ToolExecutionMode;
}

// ---------------------------------------------------------------------------
// Agent context
// ---------------------------------------------------------------------------

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

// ---------------------------------------------------------------------------
// Lifecycle hook types
// ---------------------------------------------------------------------------

/**
 * Context passed to `beforeToolCall`.
 * The hook sees the validated arguments and can block execution.
 */
export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  /** Validated arguments (after prepareArguments + schema validation). */
  args: unknown;
  context: AgentContext;
}

/**
 * Result from `beforeToolCall`.
 * Return `{ block: true }` to prevent execution. `reason` becomes the error text.
 */
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

/**
 * Context passed to `afterToolCall`.
 * The hook sees the full execution result and can override fields.
 */
export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  result: AgentToolResult;
  isError: boolean;
  context: AgentContext;
}

/**
 * Partial override from `afterToolCall`.
 * Field-level merge: each provided field replaces the original.
 * Omitted fields keep their original values. No deep merge.
 */
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

// ---------------------------------------------------------------------------
// Agent loop config (relevant subset for tool execution)
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  /** Global tool execution mode. Default: "parallel". */
  toolExecution?: ToolExecutionMode;

  /**
   * Called before a tool executes, after argument validation.
   * Return `{ block: true }` to prevent execution.
   */
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;

  /**
   * Called after a tool executes, before events are emitted.
   * Return field-level overrides for the result.
   */
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;

  /** Fake LLM stream function (used by the loop -- not relevant to tool execution). */
  streamFn?: (context: AgentContext, signal?: AbortSignal) => Promise<AssistantMessage>;
}

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: AgentToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    };

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Internal pipeline types (exported for tests/demo visibility)
// ---------------------------------------------------------------------------

/** Stage 1 success: tool found, args validated, not blocked. Ready to execute. */
export interface PreparedToolCall {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool;
  args: unknown;
}

/** Stage 1 early exit: tool not found, validation failed, or blocked. */
export interface ImmediateToolCallOutcome {
  kind: "immediate";
  result: AgentToolResult;
  isError: boolean;
}

/** Stage 2 output: raw execution result before afterToolCall. */
export interface ExecutedToolCallOutcome {
  result: AgentToolResult;
  isError: boolean;
}

/** Stage 3 output: final result paired with its tool call. */
export interface FinalizedToolCallOutcome {
  toolCall: AgentToolCall;
  result: AgentToolResult;
  isError: boolean;
}

/** Parallel batch entry: either an immediate result or a deferred thunk. */
export type FinalizedToolCallEntry =
  | FinalizedToolCallOutcome
  | (() => Promise<FinalizedToolCallOutcome>);

/** Return type of executeToolCalls (both sequential and parallel). */
export interface ExecutedToolCallBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}
