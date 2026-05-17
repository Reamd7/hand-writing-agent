// ============================================================================
// Lesson 5: Agent Loop (Part 1) -- Context Management
//
// Three functions that form the context pipeline:
//
// 1. createContextSnapshot() -- shallow-copy state into an AgentContext
// 2. transformContext()       -- optional AgentMessage[] -> AgentMessage[] transform
// 3. convertToLlm()          -- AgentMessage[] -> CoreMessage[] for the LLM
//
// This pipeline runs once per assistant turn, right before the LLM call.
// ============================================================================

import type { ModelMessage } from "ai";
import type {
  AgentContext,
  AgentMessage,
  AgentTool,
  AssistantMessage,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "./types.js";

// ---------------------------------------------------------------------------
// createContextSnapshot
// ---------------------------------------------------------------------------

/**
 * Create a shallow copy of the current agent state for use in a loop run.
 *
 * The loop mutates context.messages during streaming (push partial, replace
 * in-place). Using a snapshot prevents those mutations from affecting the
 * Agent's authoritative state -- processEvents() handles that independently.
 *
 * Corresponds to Agent.createContextSnapshot() in packages/agent/src/agent.ts:402-408.
 */
export function createContextSnapshot(
  systemPrompt: string,
  messages: AgentMessage[],
  tools?: AgentTool[],
): AgentContext {
  return {
    systemPrompt,
    messages: messages.slice(), // shallow copy -- loop can push/replace freely
    tools: tools?.slice(),
  };
}

// ---------------------------------------------------------------------------
// transformContext
// ---------------------------------------------------------------------------

/**
 * Apply an optional transform to the message array before converting to LLM format.
 *
 * This is the extension point for:
 * - Context window management (pruning old messages when approaching token limit)
 * - Injecting context from external sources (RAG, file contents, etc.)
 * - Filtering sensitive messages before they reach the LLM
 *
 * The transform operates on AgentMessage[] (the richer type that includes
 * custom messages). It runs BEFORE convertToLlm narrows to CoreMessage[].
 *
 * Corresponds to config.transformContext in agent-loop.ts:261-263.
 */
export async function transformContext(
  messages: AgentMessage[],
  transform?: (messages: AgentMessage[]) => Promise<AgentMessage[]> | AgentMessage[],
): Promise<AgentMessage[]> {
  if (!transform) {
    return messages;
  }
  return transform(messages);
}

// ---------------------------------------------------------------------------
// convertToLlm (default implementation)
// ---------------------------------------------------------------------------

/**
 * Convert AgentMessage[] to AI SDK CoreMessage[] for the LLM call.
 *
 * This is the boundary where our rich message types get narrowed to what
 * the LLM understands. The default implementation:
 * - Keeps user, assistant, and toolResult messages
 * - Drops any custom messages (they exist for UI, not the LLM)
 * - Maps our message format to AI SDK's CoreMessage format
 *
 * Corresponds to defaultConvertToLlm in agent.ts:27-31 and
 * config.convertToLlm in agent-loop.ts:266.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (!("role" in msg)) continue;

    switch (msg.role) {
      case "user": {
        const userMsg = msg as UserMessage;
        // AI SDK expects content as string or array of parts
        const userContent = typeof userMsg.content === "string" ? [{ type: "text" as const, text: userMsg.content }] : userMsg.content;
        const textParts = userContent.filter((c) => c.type === "text").map((c) => c.text);
        if (textParts.length > 0) {
          result.push({
            role: "user",
            content: textParts.join("\n"),
          });
        }
        break;
      }

      case "assistant": {
        const assistantMsg = msg as AssistantMessage;
        const textParts = assistantMsg.content.filter((c) => c.type === "text");
        const toolCalls = assistantMsg.content.filter(
          (c): c is ToolCallContent => c.type === "toolCall",
        );

        if (toolCalls.length > 0) {
          // Assistant message with tool calls -- use AI SDK's content array format
          const content: Array<
            | { type: "text"; text: string }
            | {
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                args: Record<string, unknown>;
              }
          > = [];

          for (const t of textParts) {
            if (t.text) {
              content.push({ type: "text", text: t.text });
            }
          }
          for (const tc of toolCalls) {
            content.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.arguments,
            } as any);
          }

          result.push({ role: "assistant", content: content as any });
        } else {
          // Text-only assistant message
          const text = textParts.map((t) => t.text).join("");
          result.push({ role: "assistant", content: text });
        }
        break;
      }

      case "toolResult": {
        const toolMsg = msg as ToolResultMessage;
        const textContent = toolMsg.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        result.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: toolMsg.toolCallId,
              toolName: toolMsg.toolName,
              output: textContent,
            } as any,
          ],
        });
        break;
      }

      // Custom messages (any role not matching above) are silently dropped.
      // They exist for UI or internal bookkeeping, not for the LLM.
    }
  }

  return result;
}
