// ============================================================================
// Lesson 5: Agent Loop (Part 1) -- streamAssistantResponse
//
// The core streaming pipeline: transforms context, calls the LLM via AI SDK
// streamText, consumes fullStream events, and maps them to AgentEvents.
//
// This corresponds to streamAssistantResponse() in agent-loop.ts:252-345.
// ============================================================================

import { streamText } from "ai";
import type {
  AgentContext,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AssistantMessage,
  StreamFn,
  StreamResult,
  ToolCallContent,
  Usage,
} from "./types.js";
import { defaultConvertToLlm, transformContext } from "./context.js";

// ---------------------------------------------------------------------------
// Default stream function (wraps AI SDK streamText)
// ---------------------------------------------------------------------------

/**
 * Default StreamFn implementation using AI SDK's streamText.
 *
 * This is what runs in production. The loop accepts a custom `streamFn`
 * for testing or middleware injection.
 */
const defaultStreamFn: StreamFn = (opts) => {
  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    abortSignal: opts.signal,
  });

  // AI SDK streamText returns a rich object; we adapt it to our StreamResult interface
  return result as unknown as StreamResult;
};

// ---------------------------------------------------------------------------
// Empty usage constant
// ---------------------------------------------------------------------------

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};

// ---------------------------------------------------------------------------
// streamAssistantResponse
// ---------------------------------------------------------------------------

/**
 * Stream an assistant response from the LLM.
 *
 * Pipeline:
 * 1. transformContext() -- optional AgentMessage[] modification
 * 2. convertToLlm()    -- narrow to CoreMessage[] (drop custom messages)
 * 3. streamFn()         -- call AI SDK streamText (or mock)
 * 4. Consume fullStream -- map events to AgentEvent, manage partial message
 *
 * Partial message management:
 * - On first text-delta: create partial AssistantMessage, push into context, emit message_start
 * - On subsequent deltas: replace context[last] with updated partial, emit message_update
 * - On finish/error: replace context[last] with final message, emit message_end
 *
 * This function mutates context.messages (the loop's snapshot, not Agent._state.messages).
 * processEvents() independently updates the authoritative state.
 *
 * Corresponds to agent-loop.ts:252-345.
 */
export async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  // ------------------------------------------------------------------
  // Step 1: Transform context (optional)
  // ------------------------------------------------------------------
  let messages: AgentMessage[] = context.messages;
  if (config.transformContext) {
    messages = await transformContext(messages, config.transformContext);
  }

  // ------------------------------------------------------------------
  // Step 2: Convert to LLM-compatible messages
  // ------------------------------------------------------------------
  const convertFn = config.convertToLlm ?? defaultConvertToLlm;
  const llmMessages = convertFn(messages);

  // ------------------------------------------------------------------
  // Step 3: Call the stream function
  // ------------------------------------------------------------------
  const streamFn = config.streamFn ?? defaultStreamFn;
  const response = streamFn({
    model: config.languageModel,
    system: context.systemPrompt,
    messages: llmMessages,
    signal,
  });

  // ------------------------------------------------------------------
  // Step 4: Consume fullStream, build partial message, emit events
  // ------------------------------------------------------------------

  // Accumulate text and tool calls as they stream in
  let accumulatedText = "";
  const accumulatedToolCalls: ToolCallContent[] = [];

  // Track whether we've started emitting a partial message
  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  // Usage and finish reason (filled on finish event)
  let finalUsage: Usage = EMPTY_USAGE;
  let finalStopReason: AssistantMessage["stopReason"] = "stop";
  let finalErrorMessage: string | undefined;

  for await (const part of response.fullStream) {
    // Check for abort between events
    if (signal?.aborted) {
      finalStopReason = "aborted";
      break;
    }

    switch (part.type) {
      // ---- Text streaming ----
      case "text-delta": {
        accumulatedText += part.textDelta;

        if (!partialMessage) {
          // First text delta -- create the partial message
          partialMessage = createPartialMessage(accumulatedText, accumulatedToolCalls, config);
          context.messages.push(partialMessage);
          addedPartial = true;
          await emit({
            type: "message_start",
            message: { ...partialMessage },
          });
        } else {
          // Subsequent delta -- update in-place
          partialMessage = createPartialMessage(accumulatedText, accumulatedToolCalls, config);
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            message: { ...partialMessage },
            delta: part.textDelta,
          });
        }
        break;
      }

      // ---- Tool call (complete, not streaming) ----
      case "tool-call": {
        accumulatedToolCalls.push({
          type: "toolCall",
          id: part.toolCallId,
          name: part.toolName,
          arguments: part.args,
        });

        // Update or create partial
        partialMessage = createPartialMessage(accumulatedText, accumulatedToolCalls, config);

        if (!addedPartial) {
          context.messages.push(partialMessage);
          addedPartial = true;
          await emit({
            type: "message_start",
            message: { ...partialMessage },
          });
        } else {
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            message: { ...partialMessage },
          });
        }
        break;
      }

      // ---- Finish (final event with usage) ----
      case "finish": {
        finalUsage = {
          input: part.usage.promptTokens,
          output: part.usage.completionTokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: part.usage.promptTokens + part.usage.completionTokens,
        };
        finalStopReason = mapFinishReason(part.finishReason, accumulatedToolCalls.length > 0);
        break;
      }

      // ---- Error ----
      case "error": {
        finalStopReason = "error";
        finalErrorMessage = part.error instanceof Error ? part.error.message : String(part.error);
        break;
      }

      // Other event types (reasoning, start, start-step, finish-step, etc.)
      // are ignored in this simplified implementation.
    }
  }

  // ------------------------------------------------------------------
  // Finalize: create the completed AssistantMessage
  // ------------------------------------------------------------------

  const finalMessage: AssistantMessage = {
    role: "assistant",
    content: [
      ...(accumulatedText ? [{ type: "text" as const, text: accumulatedText }] : []),
      ...accumulatedToolCalls,
    ],
    model: config.model.id,
    provider: config.model.provider,
    usage: finalUsage,
    stopReason: finalStopReason,
    errorMessage: finalErrorMessage,
    timestamp: Date.now(),
  };

  // Replace partial in context, or push if we never started streaming
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
  }

  // Emit start if we never got any deltas (e.g., error before any content)
  if (!addedPartial) {
    await emit({ type: "message_start", message: { ...finalMessage } });
  }

  // Always emit message_end with the finalized message
  await emit({ type: "message_end", message: finalMessage });

  return finalMessage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a partial AssistantMessage from accumulated content.
 * Used during streaming to represent the in-progress message.
 */
function createPartialMessage(
  text: string,
  toolCalls: ToolCallContent[],
  config: AgentLoopConfig,
): AssistantMessage {
  return {
    role: "assistant",
    content: [...(text ? [{ type: "text" as const, text }] : []), ...toolCalls],
    model: config.model.id,
    provider: config.model.provider,
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Map AI SDK finish reasons to our StopReason type.
 */
function mapFinishReason(reason: string, hasToolCalls: boolean): AssistantMessage["stopReason"] {
  if (hasToolCalls) return "toolUse";

  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool-calls":
      return "toolUse";
    case "error":
      return "error";
    default:
      return "stop";
  }
}
