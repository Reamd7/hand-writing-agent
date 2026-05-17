// ============================================================================
// Lesson 5+6: Agent Loop -- runLoop (streaming + tool execution)
//
// Lesson 5: Single-turn streaming loop (runAgentLoop via streamAssistantResponse)
// Lesson 6: Multi-turn tool execution loop (runToolExecutionLoop via executeToolCalls)
//
// Both entry points coexist. The streaming version (L05) delegates to
// streamAssistantResponse and detects tool calls without executing them.
// The tool-execution version (L06) uses a configurable streamFn and
// executes tool calls through the 3-stage pipeline.
// ============================================================================

import type {
  AgentContext,
  AgentEvent,
  AgentEventSink as LocalAgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AssistantMessage,
  ToolCallContent,
  ToolResultMessage,
} from "./types.js";
import type { AgentEventSink, StreamingLoopConfig } from "./loop-types.js";
import { streamAssistantResponse } from "./stream-assistant.js";
import { executeToolCalls } from "./tool-executor.js";

// ===========================================================================
// Lesson 5: runAgentLoop (streaming, single-turn)
// ===========================================================================

/**
 * Start an agent loop with prompt messages.
 *
 * Steps:
 * 1. Append prompt messages to context
 * 2. Emit agent_start, turn_start
 * 3. Emit message_start/message_end for each prompt message
 * 4. Call runLoop() for the streaming + tool detection
 *
 * Corresponds to runAgentLoop() in agent-loop.ts:95-118.
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: StreamingLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  // Track all new messages produced during this run
  const newMessages: AgentMessage[] = [...prompts];

  // Build the working context (loop's copy)
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  // --- Emit lifecycle events ---
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  // Emit start/end for each prompt message (so listeners see them)
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  // --- Run the main loop ---
  await runStreamingLoop(currentContext, newMessages, config, signal, emit);

  return newMessages;
}

// ---------------------------------------------------------------------------
// runStreamingLoop -- single-turn version (L05)
// ---------------------------------------------------------------------------

/**
 * Main loop logic (simplified: single turn only).
 *
 * Streams ONE assistant response, detects tool calls (but does not execute).
 * Tool execution is handled by runToolExecutionLoop (L06).
 */
async function runStreamingLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: StreamingLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<void> {
  // Stream the assistant response
  const message: AssistantMessage = await streamAssistantResponse(
    currentContext,
    config,
    signal,
    emit,
  );
  newMessages.push(message);

  // Error or abort: emit turn_end + agent_end immediately
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return;
  }

  // Detect tool calls (but don't execute -- that's the tool execution loop)
  const toolCalls = message.content.filter((c): c is ToolCallContent => c.type === "toolCall");

  if (toolCalls.length > 0) {
    console.log(
      `[runLoop] Detected ${toolCalls.length} tool call(s):`,
      toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(", "),
    );
    console.log("[runLoop] Tool execution not implemented in streaming loop (see runToolExecutionLoop)");
  }

  // Emit turn_end and agent_end
  const toolResults: ToolResultMessage[] = []; // Empty -- no tool execution
  await emit({ type: "turn_end", message, toolResults });
  await emit({ type: "agent_end", messages: newMessages });
}

// ===========================================================================
// Lesson 6: runToolExecutionLoop (with tool execution)
// ===========================================================================

// ---------------------------------------------------------------------------
// streamAssistantResponseSimple (simplified for tool-execution demo)
//
// Uses a configurable fake streamFn that directly returns an AssistantMessage.
// In production, this would be the full streaming pipeline from L05.
// ---------------------------------------------------------------------------

async function streamAssistantResponseSimple(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: LocalAgentEventSink,
): Promise<AssistantMessage> {
  if (!config.streamFn) {
    throw new Error("streamFn is required in AgentLoopConfig for tool execution loop");
  }

  // Call the (fake) stream function
  const message = await config.streamFn(context, signal);

  // Emit message lifecycle events
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });

  // Add to context (in Pi this happens incrementally during streaming)
  context.messages.push(message);

  return message;
}

// ---------------------------------------------------------------------------
// runLoop: the complete agent loop with tool execution
//
// Flow:
//   1. Stream assistant response from LLM
//   2. If error/aborted -> emit turn_end + agent_end, return
//   3. Extract tool calls from the assistant message
//   4. If tool calls exist -> executeToolCalls (3-stage pipeline)
//   5. Push tool results into context
//   6. Emit turn_end
//   7. If no more tool calls -> exit
//   8. Otherwise -> loop back to step 1
// ---------------------------------------------------------------------------

async function runLoop(
  context: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: LocalAgentEventSink,
): Promise<void> {
  let turnCount = 0;

  while (true) {
    let hasMoreToolCalls = true;

    // Inner loop: process tool calls until the model stops calling tools
    while (hasMoreToolCalls) {
      // --- Turn start ---
      await emit({ type: "turn_start" });
      turnCount++;

      // --- Stream assistant response ---
      const message = await streamAssistantResponseSimple(context, config, signal, emit);
      newMessages.push(message);

      // --- Check for error/abort ---
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // --- Extract tool calls ---
      const toolCalls = message.content.filter((c): c is ToolCallContent => c.type === "toolCall");

      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        // Execute tool calls via the 3-stage pipeline
        const batch = await executeToolCalls(context, message, config, signal, emit);

        toolResults.push(...batch.messages);

        // If the batch did NOT terminate, the model might call more tools
        hasMoreToolCalls = !batch.terminate;

        // Push tool results into context for the next LLM call
        for (const result of toolResults) {
          context.messages.push(result);
          newMessages.push(result);
        }
      }

      // --- Turn end ---
      await emit({ type: "turn_end", message, toolResults });

      // Safety: prevent infinite loops in demo
      if (turnCount > 10) {
        console.log("[runLoop] Safety limit reached (10 turns), stopping.");
        hasMoreToolCalls = false;
      }
    }

    // No more tool calls -- exit
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

// ---------------------------------------------------------------------------
// runToolExecutionLoop: top-level entry point for tool execution demo
//
// Creates context, emits lifecycle events, and runs the loop.
// ---------------------------------------------------------------------------

export async function runToolExecutionLoop(
  prompt: string,
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const events: AgentEvent[] = [];
  const emit: LocalAgentEventSink = async (event) => {
    events.push(event);

    // Log events for visibility
    switch (event.type) {
      case "agent_start":
        console.log("\n=== Agent Start ===");
        break;
      case "agent_end":
        console.log(`=== Agent End (${event.messages.length} messages) ===\n`);
        break;
      case "turn_start":
        console.log("--- Turn Start ---");
        break;
      case "turn_end":
        console.log(`--- Turn End (${event.toolResults.length} tool results) ---`);
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          const msg = event.message as AssistantMessage;
          const textParts = msg.content.filter((c) => c.type === "text");
          const toolParts = msg.content.filter((c) => c.type === "toolCall");
          console.log(`  [assistant] text=${textParts.length} toolCalls=${toolParts.length}`);
        } else if (event.message.role === "toolResult") {
          const msg = event.message as ToolResultMessage;
          const preview =
            msg.content[0]?.type === "text" ? msg.content[0].text.slice(0, 60) : "(non-text)";
          console.log(`  [toolResult] ${msg.toolName} isError=${msg.isError} "${preview}"`);
        }
        break;
      case "tool_execution_start":
        console.log(`  >> tool_execution_start: ${event.toolName}(${JSON.stringify(event.args)})`);
        break;
      case "tool_execution_update":
        console.log(`  .. tool_execution_update: ${event.toolName}`);
        break;
      case "tool_execution_end":
        console.log(`  << tool_execution_end: ${event.toolName} isError=${event.isError}`);
        break;
    }
  };

  // Add user message to context
  const userMessage: AgentMessage = {
    role: "user",
    content: [{ type: "text", text: prompt }],
    timestamp: Date.now(),
  };
  context.messages.push(userMessage);
  const newMessages: AgentMessage[] = [userMessage];

  await emit({ type: "agent_start" });
  await emit({ type: "message_start", message: userMessage });
  await emit({ type: "message_end", message: userMessage });

  await runLoop(context, newMessages, config, signal, emit);

  return newMessages;
}
