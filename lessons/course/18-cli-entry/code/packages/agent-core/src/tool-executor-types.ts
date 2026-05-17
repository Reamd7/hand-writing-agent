// ============================================================================
// Lesson 6: Tool Call Execution Engine -- Internal Pipeline Types
//
// These types model the 3-stage pipeline: prepare -> execute -> finalize.
// They are NOT from pi-agent-core; they are lesson-specific types that
// mirror the internal logic of Pi's executeToolCalls() and helpers.
// ============================================================================

import type {
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  ToolResultMessage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Stage 1 output: prepareToolCall
// ---------------------------------------------------------------------------

/** Stage 1 success: tool found, args validated, not blocked. Ready to execute. */
export interface PreparedToolCall {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool<any>;
  args: unknown;
}

/** Stage 1 early exit: tool not found, validation failed, or blocked. */
export interface ImmediateToolCallOutcome {
  kind: "immediate";
  result: AgentToolResult<any>;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Stage 2 output: executePreparedToolCall
// ---------------------------------------------------------------------------

/** Stage 2 output: raw execution result before afterToolCall. */
export interface ExecutedToolCallOutcome {
  result: AgentToolResult<any>;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Stage 3 output: finalizeExecutedToolCall
// ---------------------------------------------------------------------------

/** Stage 3 output: final result paired with its tool call. */
export interface FinalizedToolCallOutcome {
  toolCall: AgentToolCall;
  result: AgentToolResult<any>;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Parallel batch entry
// ---------------------------------------------------------------------------

/** Parallel batch entry: either an immediate result or a deferred thunk. */
export type FinalizedToolCallEntry =
  | FinalizedToolCallOutcome
  | (() => Promise<FinalizedToolCallOutcome>);

// ---------------------------------------------------------------------------
// Batch return type
// ---------------------------------------------------------------------------

/** Return type of executeToolCalls (both sequential and parallel). */
export interface ExecutedToolCallBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}
