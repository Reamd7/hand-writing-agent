// =============================================================================
// Lesson 2: fullStream Event -> AgentEvent Mapper
//
// Maps AI SDK's streamText fullStream events to our custom AgentEvent types.
// This demonstrates the bridge between the AI SDK's streaming protocol and
// a custom agent event system (similar to pi's architecture).
//
// Run: OPENAI_API_KEY=sk-... npx tsx src/event-mapper.ts
// =============================================================================

import { streamText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  ToolResultMessage,
  Usage,
} from "@my-agent/core";

// ---------------------------------------------------------------------------
// Helper: Create an empty Usage object
// ---------------------------------------------------------------------------

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

// ---------------------------------------------------------------------------
// Helper: Create a partial AssistantMessage for streaming state
// ---------------------------------------------------------------------------

function createPartialAssistant(model: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    model,
    provider: "openai",
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Core: Map fullStream events to AgentEvent + AssistantStreamEvent
// ---------------------------------------------------------------------------

/**
 * Processes an AI SDK fullStream and yields AgentEvent objects.
 *
 * This async generator bridges the gap between AI SDK's streaming protocol
 * and a custom agent event system. The mapping logic:
 *
 *   AI SDK fullStream event    ->  AgentEvent
 *   ─────────────────────────      ───────────────────────
 *   start-step (first)         ->  turn_start + message_start
 *   text-start                 ->  message_update (text_start)
 *   text-delta                 ->  message_update (text_delta)
 *   text-end                   ->  message_update (text_end)
 *   reasoning-start            ->  message_update (thinking_start)
 *   reasoning-delta            ->  message_update (thinking_delta)
 *   reasoning-end              ->  message_update (thinking_end)
 *   tool-call                  ->  message_update (toolcall_end)
 *   tool-input-start           ->  message_update (toolcall_start)
 *   tool-input-delta           ->  message_update (toolcall_delta)
 *   tool-result                ->  tool_execution_end + message_start/end (toolResult)
 *   finish-step                ->  message_end
 *   finish                     ->  turn_end + agent_end
 *   error                      ->  message_end (error) + agent_end
 */
async function* mapFullStreamToAgentEvents(
  fullStream: AsyncIterable<any>,
  model: string,
): AsyncGenerator<AgentEvent> {
  const partial = createPartialAssistant(model);
  let contentIndex = 0;
  let stepCount = 0;
  let textBuffer = "";
  let thinkingBuffer = "";
  const toolResults: ToolResultMessage[] = [];
  const collectedMessages: AgentMessage[] = [];

  yield { type: "agent_start" };

  for await (const part of fullStream) {
    switch (part.type) {
      // --- Step lifecycle ---
      case "start-step": {
        if (stepCount === 0) {
          yield { type: "turn_start" };
        }
        // Reset partial for new step
        partial.content = [];
        contentIndex = 0;
        textBuffer = "";
        thinkingBuffer = "";

        yield { type: "message_start", message: { ...partial } };
        stepCount++;
        break;
      }

      // --- Text streaming ---
      case "text-start": {
        const evt: AssistantMessageEvent = {
          type: "text_start",
          contentIndex,
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent: evt };
        break;
      }

      case "text-delta": {
        textBuffer += part.text ?? part.textDelta ?? "";
        // Update the partial message content
        const textContent = { type: "text" as const, text: textBuffer };
        partial.content[contentIndex] = textContent;

        const evt: AssistantMessageEvent = {
          type: "text_delta",
          contentIndex,
          delta: part.textDelta,
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent: evt };
        break;
      }

      case "text-end": {
        const evt: AssistantMessageEvent = {
          type: "text_end",
          contentIndex,
          content: textBuffer,
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent: evt };
        contentIndex++;
        textBuffer = "";
        break;
      }

      // --- Reasoning / Thinking ---
      case "reasoning-start": {
        const evt: AssistantMessageEvent = {
          type: "thinking_start",
          contentIndex,
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent: evt };
        break;
      }

      case "reasoning-delta": {
        thinkingBuffer += part.text ?? part.textDelta ?? "";
        const thinkingContent = { type: "thinking" as const, thinking: thinkingBuffer };
        partial.content[contentIndex] = thinkingContent;

        const evt: AssistantMessageEvent = {
          type: "thinking_delta",
          contentIndex,
          delta: part.textDelta,
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent: evt };
        break;
      }

      case "reasoning-end": {
        const evt: AssistantMessageEvent = {
          type: "thinking_end",
          contentIndex,
          content: thinkingBuffer,
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent: evt };
        contentIndex++;
        thinkingBuffer = "";
        break;
      }

      // --- Tool input streaming (before tool-call) ---
      case "tool-input-start": {
        const evt: AssistantMessageEvent = {
          type: "toolcall_start",
          contentIndex,
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent: evt };
        break;
      }

      case "tool-input-delta": {
        const evt: AssistantMessageEvent = {
          type: "toolcall_delta",
          contentIndex,
          delta: part.delta ?? part.inputTextDelta ?? "",
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent: evt };
        break;
      }

      // --- Tool call (complete) ---
      case "tool-call": {
        const toolCall = {
          type: "toolCall" as const,
          id: part.toolCallId,
          name: part.toolName,
          arguments: part.args ?? part.input ?? {},
        };
        partial.content[contentIndex] = toolCall;
        partial.stopReason = "toolUse";

        const evt: AssistantMessageEvent = {
          type: "toolcall_end",
          contentIndex,
          toolCall,
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent: evt };

        // Emit tool execution start
        yield {
          type: "tool_execution_start",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.args,
        };

        contentIndex++;
        break;
      }

      // --- Tool result ---
      case "tool-result": {
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          content: [{ type: "text", text: JSON.stringify(part.result) }],
          isError: false,
          timestamp: Date.now(),
        };
        toolResults.push(toolResult);

        yield {
          type: "tool_execution_end",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.result,
          isError: false,
        };

        // Emit the tool result as a message
        yield { type: "message_start", message: toolResult };
        yield { type: "message_end", message: toolResult };
        collectedMessages.push(toolResult);
        break;
      }

      // --- Step finish ---
      case "finish-step": {
        // Update usage from the step
        if (part.usage) {
          partial.usage = {
            input: part.usage.promptTokens ?? 0,
            output: part.usage.completionTokens ?? 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: part.usage.totalTokens ?? 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }

        const finalMessage: AssistantMessage = { ...partial, timestamp: Date.now() };
        yield { type: "message_end", message: finalMessage };
        collectedMessages.push(finalMessage);
        break;
      }

      // --- Stream finish ---
      case "finish": {
        const lastAssistant = collectedMessages.findLast(
          (m): m is AssistantMessage => (m as AssistantMessage).role === "assistant",
        );
        if (lastAssistant) {
          yield {
            type: "turn_end",
            message: lastAssistant,
            toolResults: [...toolResults],
          };
        }
        yield { type: "agent_end", messages: collectedMessages };
        break;
      }

      // --- Errors ---
      case "error": {
        partial.stopReason = "error";
        partial.errorMessage = String(part.error);

        const errorMessage: AssistantMessage = { ...partial, timestamp: Date.now() };
        yield { type: "message_end", message: errorMessage };
        collectedMessages.push(errorMessage);

        yield { type: "agent_end", messages: collectedMessages };
        break;
      }

      // Ignored event types: raw, source, file, start, tool-input-end, tool-error
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main: Run the mapper
// ---------------------------------------------------------------------------

async function main() {
  console.log("--- Event Mapper Demo ---\n");

  const result = streamText({
    model: openai("gpt-4o-mini"),
    tools: {
      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("The city name"),
        }),
        execute: async ({ city }) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return {
            city,
            temperature: Math.floor(Math.random() * 30) + 5,
            unit: "celsius",
          };
        },
      }),
    },
    prompt: "What is the weather in Berlin?",
    onError({ error }) {
      console.error("[stream error]", error);
    },
  });

  // Map fullStream events to AgentEvents and print them
  for await (const event of mapFullStreamToAgentEvents(result.fullStream, "gpt-4o-mini")) {
    switch (event.type) {
      case "agent_start":
        console.log("[AgentEvent] agent_start");
        break;

      case "agent_end":
        console.log(`[AgentEvent] agent_end (${event.messages.length} messages)`);
        break;

      case "turn_start":
        console.log("[AgentEvent] turn_start");
        break;

      case "turn_end":
        console.log(`[AgentEvent] turn_end (toolResults: ${event.toolResults.length})`);
        break;

      case "message_start":
        console.log(`[AgentEvent] message_start (role: ${(event.message as any).role})`);
        break;

      case "message_update": {
        const streamType = event.assistantMessageEvent.type;
        if (streamType === "text_delta") {
          process.stdout.write((event.assistantMessageEvent as any).delta);
        } else {
          console.log(`[AgentEvent] message_update (streamEvent: ${streamType})`);
        }
        break;
      }

      case "message_end":
        console.log(`\n[AgentEvent] message_end (role: ${(event.message as any).role})`);
        break;

      case "tool_execution_start":
        console.log(
          `[AgentEvent] tool_execution_start: ${event.toolName}(${JSON.stringify(event.args)})`,
        );
        break;

      case "tool_execution_end":
        console.log(
          `[AgentEvent] tool_execution_end: ${event.toolName} -> ${JSON.stringify(event.result)}`,
        );
        break;

      default:
        console.log(`[AgentEvent] ${event.type}`);
    }
  }
}

main().catch(console.error);
