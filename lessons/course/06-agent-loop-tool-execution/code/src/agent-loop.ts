// ============================================================================
// Lesson 6: Complete runLoop with Tool Execution
//
// This file integrates the tool execution engine (tool-executor.ts) into
// the full agent loop: stream -> detect tool calls -> execute -> push results -> loop.
//
// Modeled after packages/agent/src/agent-loop.ts (runLoop, streamAssistantResponse).
// ============================================================================

import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AssistantMessage,
  ToolCallContent,
  ToolResultMessage,
} from "./types.js";
import { executeToolCalls } from "./tool-executor.js";

// ---------------------------------------------------------------------------
// streamAssistantResponse (simplified)
//
// In Pi, this transforms AgentMessage[] -> Message[] for the LLM, then streams
// the response with incremental events. Here we use a configurable fake
// streamFn that directly returns an AssistantMessage.
// ---------------------------------------------------------------------------

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  if (!config.streamFn) {
    throw new Error("streamFn is required in AgentLoopConfig");
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
// runLoop: the complete agent loop
//
// Flow:
//   1. Check for pending steering messages
//   2. Stream assistant response from LLM
//   3. If error/aborted -> emit turn_end + agent_end, return
//   4. Extract tool calls from the assistant message
//   5. If tool calls exist -> executeToolCalls (3-stage pipeline)
//   6. Push tool results into context
//   7. Emit turn_end
//   8. Check shouldStopAfterTurn
//   9. Get steering messages for next iteration
//   10. If no more tool calls and no pending messages -> check follow-ups
//   11. If no follow-ups -> emit agent_end, return
// ---------------------------------------------------------------------------

export async function runLoop(
  context: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
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
      const message = await streamAssistantResponse(context, config, signal, emit);
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
// agentLoop: top-level entry point
//
// Creates context, emits lifecycle events, and runs the loop.
// ---------------------------------------------------------------------------

export async function agentLoop(
  prompt: string,
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const events: AgentEvent[] = [];
  const emit: AgentEventSink = async (event) => {
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
