// ============================================================================
// Lesson 7: Steering and Follow-up Queues -- Agent Loop (Double Loop)
//
// This file implements the double-loop architecture:
// - Inner loop: processes tool calls and steering messages
// - Outer loop: checks for follow-up messages when agent would stop
//
// Modeled after runLoop() in packages/agent/src/agent-loop.ts.
// Simplified: no streaming, no tool argument validation, no parallel
// tool execution. Focus is on the steering/follow-up control flow.
// ============================================================================

import type {
  AgentContext,
  AgentEventSink as LocalAgentEventSink,
  AgentFullLoopConfig,
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Start an agent loop with new prompt messages.
 *
 * Appends the prompt messages to the context, emits lifecycle events for
 * them, then enters the double loop.
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentFullLoopConfig,
  emit: LocalAgentEventSink,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  // Emit events for the prompt messages
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit);
  return newMessages;
}

/**
 * Continue an agent loop from existing context.
 *
 * The last message in context must NOT be an assistant message (the LLM
 * needs a user or toolResult to respond to).
 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentFullLoopConfig,
  emit: LocalAgentEventSink,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  const lastMessage = context.messages[context.messages.length - 1];
  if (lastMessage && "role" in lastMessage && lastMessage.role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, signal, emit);
  return newMessages;
}

// ---------------------------------------------------------------------------
// Double loop
// ---------------------------------------------------------------------------

/**
 * Main loop logic implementing the double-loop architecture.
 *
 * - Inner loop: continues while there are tool calls to process or
 *   steering messages to inject.
 * - Outer loop: continues when follow-up messages arrive after the
 *   agent would otherwise stop.
 */
async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentFullLoopConfig,
  signal: AbortSignal | undefined,
  emit: LocalAgentEventSink,
): Promise<void> {
  let firstTurn = true;

  // Initial steering poll -- user may have typed while we were starting up
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

  // ---- Outer loop: follow-up ----
  while (true) {
    let hasMoreToolCalls = true;

    // ---- Inner loop: tool calls + steering ----
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      // Emit turn_start (skip for the very first turn -- already emitted by caller)
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // Inject pending messages into context
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // Check abort before LLM call
      if (signal?.aborted) {
        const abortedMessage = createAbortedMessage(config);
        newMessages.push(abortedMessage);
        await emit({ type: "message_start", message: abortedMessage });
        await emit({ type: "message_end", message: abortedMessage });
        await emit({ type: "turn_end", message: abortedMessage, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Call LLM
      const message = await config.callLlm(currentContext.messages, currentContext.tools, signal);
      currentContext.messages.push(message);
      newMessages.push(message);

      await emit({ type: "message_start", message });
      await emit({ type: "message_end", message });

      // Error or abort -> exit immediately
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Execute tool calls
      const toolCalls = message.content.filter((c) => c.type === "toolCall");
      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        for (const tc of toolCalls) {
          if (tc.type !== "toolCall") continue;

          await emit({
            type: "tool_execution_start",
            toolCallId: tc.id,
            toolName: tc.name,
            args: tc.arguments,
          });

          const tool = currentContext.tools?.find((t) => t.name === tc.name);
          let toolResult: ToolResultMessage;

          if (!tool) {
            toolResult = {
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: [{ type: "text", text: `Tool ${tc.name} not found` }],
              isError: true,
              timestamp: Date.now(),
            };
          } else {
            try {
              const result = await tool.execute(tc.id, tc.arguments, signal);
              toolResult = {
                role: "toolResult",
                toolCallId: tc.id,
                toolName: tc.name,
                content: result.content,
                details: result.details,
                isError: false,
                timestamp: Date.now(),
              };
              // If all tools in batch set terminate, we stop
              if (!result.terminate) {
                hasMoreToolCalls = true;
              }
            } catch (error) {
              toolResult = {
                role: "toolResult",
                toolCallId: tc.id,
                toolName: tc.name,
                content: [
                  { type: "text", text: error instanceof Error ? error.message : String(error) },
                ],
                isError: true,
                timestamp: Date.now(),
              };
              hasMoreToolCalls = true;
            }
          }

          await emit({
            type: "tool_execution_end",
            toolCallId: tc.id,
            toolName: tc.name,
            result: { content: toolResult.content, details: toolResult.details },
            isError: toolResult.isError,
          });

          await emit({ type: "message_start", message: toolResult });
          await emit({ type: "message_end", message: toolResult });

          currentContext.messages.push(toolResult);
          newMessages.push(toolResult);
          toolResults.push(toolResult);
        }
      }

      // Emit turn_end
      await emit({ type: "turn_end", message, toolResults });

      // shouldStopAfterTurn -- checked BEFORE steering poll
      if (
        await config.shouldStopAfterTurn?.({
          message,
          toolResults,
          context: currentContext,
          newMessages,
        })
      ) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Steering poll -- check for messages queued during this turn
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // ---- Inner loop exhausted: agent would stop ----
    // Check for follow-up messages
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      // Set as pending so inner loop processes them next iteration
      pendingMessages = followUpMessages;
      continue;
    }

    // No more messages -- exit
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAbortedMessage(config: AgentFullLoopConfig): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: config.model.api,
    model: config.model.id,
    provider: config.model.provider,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: "Aborted",
    timestamp: Date.now(),
  };
}
