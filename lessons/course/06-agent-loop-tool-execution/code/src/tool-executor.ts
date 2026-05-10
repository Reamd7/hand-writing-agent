// ============================================================================
// Lesson 6: Tool Call Execution Engine
//
// Three-stage pipeline: prepare -> execute -> finalize
// Plus parallel/sequential execution strategies and batch termination.
//
// Modeled after packages/agent/src/agent-loop.ts (executeToolCalls and helpers).
// ============================================================================

import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  AssistantMessage,
  ExecutedToolCallBatch,
  ExecutedToolCallOutcome,
  FinalizedToolCallEntry,
  FinalizedToolCallOutcome,
  ImmediateToolCallOutcome,
  PreparedToolCall,
  ToolResultMessage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Error result helper
// ---------------------------------------------------------------------------

function createErrorToolResult(message: string): AgentToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

// ---------------------------------------------------------------------------
// Stage 1: prepareToolCall
//
// Steps:
//   1. Find the tool by name in context.tools
//   2. Run prepareArguments() shim if present (normalizes LLM-generated args)
//   3. Validate arguments against tool schema (simplified: just check it's an object)
//   4. Run beforeToolCall hook (can block execution)
//
// Returns either a PreparedToolCall (ready for stage 2) or an
// ImmediateToolCallOutcome (skip straight to result).
// ---------------------------------------------------------------------------

function prepareToolCallArguments(tool: AgentTool, toolCall: AgentToolCall): AgentToolCall {
  if (!tool.prepareArguments) {
    return toolCall;
  }
  const prepared = tool.prepareArguments(toolCall.arguments);
  // If the shim returns the same reference, nothing changed -- reuse original
  if (prepared === toolCall.arguments) {
    return toolCall;
  }
  return { ...toolCall, arguments: prepared };
}

function validateToolArguments(tool: AgentTool, toolCall: AgentToolCall): Record<string, unknown> {
  // Simplified validation: in Pi this uses TypeBox schema validation.
  // Here we just ensure it's a non-null object.
  const args = toolCall.arguments;
  if (typeof args !== "object" || args === null) {
    throw new Error(
      `Invalid arguments for tool "${tool.name}": expected object, got ${typeof args}`,
    );
  }
  return args as Record<string, unknown>;
}

export async function prepareToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  // Step 1: Find tool by name
  const tool = context.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool "${toolCall.name}" not found`),
      isError: true,
    };
  }

  try {
    // Step 2: Run prepareArguments shim (before validation)
    const preparedToolCall = prepareToolCallArguments(tool, toolCall);

    // Step 3: Validate arguments against schema
    const validatedArgs = validateToolArguments(tool, preparedToolCall);

    // Step 4: Run beforeToolCall hook
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context,
        },
        signal,
      );

      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
          isError: true,
        };
      }
    }

    // All checks passed -- ready for execution
    return {
      kind: "prepared",
      toolCall,
      tool,
      args: validatedArgs,
    };
  } catch (error) {
    // Any error during preparation (validation, hook failure) -> immediate error
    return {
      kind: "immediate",
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Stage 2: executePreparedToolCall
//
// Calls tool.execute() with the validated arguments. Collects progress
// updates via onUpdate callback and emits tool_execution_update events.
// Catches any exceptions and converts them to error results.
// ---------------------------------------------------------------------------

export async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
  // Collect promises from async onUpdate event emissions
  const updateEvents: Promise<void>[] = [];

  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args as Record<string, unknown>,
      signal,
      // onUpdate: tool pushes partial results during execution
      (partialResult) => {
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              args: prepared.toolCall.arguments,
              partialResult,
            }),
          ),
        );
      },
    );

    // Wait for all update event emissions to settle
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (error) {
    // Wait for any update events that were emitted before the error
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Stage 3: finalizeExecutedToolCall
//
// Runs afterToolCall hook with field-level override semantics.
// Each field in AfterToolCallResult, if present, replaces the original.
// No deep merge -- content and details are replaced in full.
// ---------------------------------------------------------------------------

export async function finalizeExecutedToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context,
        },
        signal,
      );

      // Apply field-level overrides (nullish coalescing preserves originals)
      if (afterResult) {
        result = {
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      // afterToolCall hook itself failed -- replace result with error
      result = createErrorToolResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }

  return { toolCall: prepared.toolCall, result, isError };
}

// ---------------------------------------------------------------------------
// Batch termination
//
// ALL tools in the batch must set terminate:true for the batch to terminate.
// This is the "unanimous vote" rule -- prevents premature exit when one tool
// is done but others still have relevant results for the model.
// ---------------------------------------------------------------------------

export function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return finalizedCalls.length > 0 && finalizedCalls.every((f) => f.result.terminate === true);
}

// ---------------------------------------------------------------------------
// Event emission helpers
// ---------------------------------------------------------------------------

async function emitToolExecutionEnd(
  finalized: FinalizedToolCallOutcome,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content,
    details: finalized.result.details,
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

async function emitToolResultMessage(
  message: ToolResultMessage,
  emit: AgentEventSink,
): Promise<void> {
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}

// ---------------------------------------------------------------------------
// Sequential execution
//
// Each tool call is fully processed (prepare -> execute -> finalize) before
// the next one starts. Events are emitted inline.
// ---------------------------------------------------------------------------

export async function executeToolCallsSequential(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    // Emit start event
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    // Stage 1: Prepare
    const preparation = await prepareToolCall(context, assistantMessage, toolCall, config, signal);

    let finalized: FinalizedToolCallOutcome;
    if (preparation.kind === "immediate") {
      // Preparation failed or was blocked -- skip execute/finalize
      finalized = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      };
    } else {
      // Stage 2: Execute
      const executed = await executePreparedToolCall(preparation, signal, emit);
      // Stage 3: Finalize
      finalized = await finalizeExecutedToolCall(
        context,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
    }

    // Emit end event and tool result message
    await emitToolExecutionEnd(finalized, emit);
    const resultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(resultMessage, emit);

    finalizedCalls.push(finalized);
    messages.push(resultMessage);
  }

  return {
    messages,
    terminate: shouldTerminateToolBatch(finalizedCalls),
  };
}

// ---------------------------------------------------------------------------
// Parallel execution
//
// Two phases:
// 1. Prepare all tool calls sequentially (hooks may need context).
//    Immediate results are stored directly. Prepared calls become thunks.
// 2. Execute all thunks concurrently via Promise.all.
//    tool_execution_end emits in completion order (whoever finishes first).
//    ToolResultMessages emit in source order after all thunks resolve.
// ---------------------------------------------------------------------------

export async function executeToolCallsParallel(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const entries: FinalizedToolCallEntry[] = [];

  // Phase 1: Sequential preparation, collect immediate results and thunks
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(context, assistantMessage, toolCall, config, signal);

    if (preparation.kind === "immediate") {
      // Immediate result -- no need to create a thunk
      const finalized: FinalizedToolCallOutcome = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      };
      await emitToolExecutionEnd(finalized, emit);
      entries.push(finalized);
      continue;
    }

    // Deferred execution -- wrap in a thunk for concurrent execution
    entries.push(async () => {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      const finalized = await finalizeExecutedToolCall(
        context,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
      // tool_execution_end fires in completion order (whoever finishes first)
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
  }

  // Phase 2: Execute all thunks concurrently, preserve source order
  const orderedResults = await Promise.all(
    entries.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
  );

  // Emit ToolResultMessages in source order (LLM expects this)
  const messages: ToolResultMessage[] = [];
  for (const finalized of orderedResults) {
    const resultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(resultMessage, emit);
    messages.push(resultMessage);
  }

  return {
    messages,
    terminate: shouldTerminateToolBatch(orderedResults),
  };
}

// ---------------------------------------------------------------------------
// Entry point: executeToolCalls
//
// Decides between parallel and sequential based on:
// 1. Global config.toolExecution setting
// 2. Per-tool executionMode ("sequential" on any tool forces the whole batch)
// ---------------------------------------------------------------------------

export async function executeToolCalls(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const toolCalls = assistantMessage.content.filter(
    (c): c is AgentToolCall => c.type === "toolCall",
  );

  // Check if any tool in the batch requires sequential execution
  const hasSequentialTool = toolCalls.some(
    (tc) => context.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );

  // Global sequential OR any sequential tool -> entire batch runs sequentially
  if (config.toolExecution === "sequential" || hasSequentialTool) {
    return executeToolCallsSequential(context, assistantMessage, toolCalls, config, signal, emit);
  }

  return executeToolCallsParallel(context, assistantMessage, toolCalls, config, signal, emit);
}
