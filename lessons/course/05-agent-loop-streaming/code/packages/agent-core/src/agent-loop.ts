// ============================================================================
// Lesson 5: Agent Loop (Part 1) -- runLoop (single-turn)
//
// Basic agent loop: single turn only.
// - Accepts a prompt (AgentMessage[])
// - Emits agent_start, turn_start
// - Streams assistant response via streamAssistantResponse()
// - Detects tool calls but does NOT execute them (that's Lesson 6)
// - Emits turn_end, agent_end
//
// This corresponds to the top half of runLoop() in agent-loop.ts:155-246,
// simplified to a single turn (no tool execution loop).
// ============================================================================

import type {
  AgentContext,
  AgentMessage,
  AssistantMessage,
  ToolCallContent,
  ToolResultMessage,
} from "./types.js";
import type { AgentEventSink, StreamingLoopConfig } from "./loop-types.js";
import { streamAssistantResponse } from "./stream-assistant.js";

// ---------------------------------------------------------------------------
// runAgentLoop -- entry point
// ---------------------------------------------------------------------------

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
  await runLoop(currentContext, newMessages, config, signal, emit);

  return newMessages;
}

// ---------------------------------------------------------------------------
// runLoop -- single-turn version
// ---------------------------------------------------------------------------

/**
 * Main loop logic (simplified: single turn only).
 *
 * Full pi version:
 * - Outer loop: checks for follow-up messages after agent would stop
 * - Inner loop: stream response -> execute tool calls -> check steering
 * - Continues until no more tool calls and no pending messages
 *
 * This lesson's version:
 * - Stream ONE assistant response
 * - Detect tool calls (report them in the turn_end event)
 * - Do NOT execute tool calls (Lesson 6 adds that)
 * - Emit turn_end + agent_end and return
 *
 * Corresponds to runLoop() in agent-loop.ts:155-246.
 */
async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: StreamingLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<void> {
  // ------------------------------------------------------------------
  // Stream the assistant response
  // ------------------------------------------------------------------
  const message: AssistantMessage = await streamAssistantResponse(
    currentContext,
    config,
    signal,
    emit,
  );
  newMessages.push(message);

  // ------------------------------------------------------------------
  // Check termination conditions
  // ------------------------------------------------------------------

  // Error or abort: emit turn_end + agent_end immediately
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return;
  }

  // ------------------------------------------------------------------
  // Detect tool calls (but don't execute -- that's Lesson 6)
  // ------------------------------------------------------------------
  const toolCalls = message.content.filter((c): c is ToolCallContent => c.type === "toolCall");

  if (toolCalls.length > 0) {
    // In the full implementation, this is where executeToolCalls() runs.
    // The tool results would be pushed to currentContext.messages and
    // newMessages, then the loop would continue with another turn.
    //
    // For this lesson, we just log the detection and stop.
    console.log(
      `[runLoop] Detected ${toolCalls.length} tool call(s):`,
      toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(", "),
    );
    console.log("[runLoop] Tool execution not implemented yet (see Lesson 6)");
  }

  // ------------------------------------------------------------------
  // Emit turn_end and agent_end
  // ------------------------------------------------------------------
  const toolResults: ToolResultMessage[] = []; // Empty -- no tool execution yet
  await emit({ type: "turn_end", message, toolResults });
  await emit({ type: "agent_end", messages: newMessages });
}
