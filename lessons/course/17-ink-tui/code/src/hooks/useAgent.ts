/**
 * Custom hook that subscribes to agent events and maps them to React state.
 *
 * This is the ink equivalent of pi's `subscribeToAgent()` + `handleEvent()` pattern.
 * Instead of imperatively mutating Container children, we update React state
 * and let React's reconciler handle the re-render.
 */

import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types -- simplified versions of pi's AgentSessionEvent and related types
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type MessageContent = TextContent | ToolCallContent;

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: MessageContent[];
  /** Populated on message_end for assistant messages */
  stopReason?: "end_turn" | "aborted" | "error";
  errorMessage?: string;
}

export interface ToolState {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  result?: string;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "message_start"; message: Message }
  | { type: "message_update"; message: Message }
  | { type: "message_end"; message: Message }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: "tool_execution_update"; toolCallId: string; partialResult: string }
  | { type: "tool_execution_end"; toolCallId: string; result: string; isError: boolean }
  | { type: "agent_end" };

/**
 * Minimal agent session interface. The real implementation would come from
 * your agent framework; this captures only what the UI hook needs.
 */
export interface AgentSession {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
  model: { id: string; provider: string };
}

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export interface AgentState {
  messages: Message[];
  streamingContent: string | null;
  toolStates: Map<string, ToolState>;
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useAgent(agent: AgentSession): AgentState {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [toolStates, setToolStates] = useState<Map<string, ToolState>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    /**
     * Event handler that mirrors pi's `handleEvent` switch statement.
     * Each case maps an agent event to one or more React state updates.
     *
     * Compare with pi's interactive-mode.ts lines ~2624-2817.
     */
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        // -----------------------------------------------------------------
        // agent_start: Agent begins processing. Show spinner, clear tools.
        // pi equivalent: clear pendingTools, create Loader, add to statusContainer.
        // -----------------------------------------------------------------
        case "agent_start":
          setIsLoading(true);
          setToolStates(new Map());
          break;

        // -----------------------------------------------------------------
        // message_start: A new message appears. Add to history.
        // pi equivalent: addMessageToChat() for user, create AssistantMessageComponent for assistant.
        // -----------------------------------------------------------------
        case "message_start":
          if (event.message.role === "user") {
            setMessages((prev) => [...prev, event.message]);
          } else if (event.message.role === "assistant") {
            // Don't add to messages yet -- we show it via streamingContent.
            // It gets finalized on message_end.
            setStreamingContent("");
          }
          break;

        // -----------------------------------------------------------------
        // message_update: Streaming content update from the assistant.
        // pi equivalent: streamingComponent.updateContent(streamingMessage),
        //   plus scanning content array for new toolCall entries.
        // -----------------------------------------------------------------
        case "message_update": {
          if (event.message.role !== "assistant") break;

          // Extract text content for streaming display
          const textParts = event.message.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text);
          setStreamingContent(textParts.join(""));

          // Extract tool calls and register them as pending
          for (const content of event.message.content) {
            if (content.type === "toolCall") {
              setToolStates((prev) => {
                if (prev.has(content.id)) {
                  // Update args for existing tool (they stream in incrementally)
                  const updated = new Map(prev);
                  const existing = updated.get(content.id)!;
                  updated.set(content.id, { ...existing, args: content.arguments });
                  return updated;
                }
                // New tool call
                const updated = new Map(prev);
                updated.set(content.id, {
                  id: content.id,
                  name: content.name,
                  args: content.arguments,
                  status: "pending",
                });
                return updated;
              });
            }
          }
          break;
        }

        // -----------------------------------------------------------------
        // message_end: Finalize the assistant message. Move from streaming to history.
        // pi equivalent: finalize streamingComponent, handle abort/error, clear refs.
        // -----------------------------------------------------------------
        case "message_end":
          if (event.message.role === "assistant") {
            setMessages((prev) => [...prev, event.message]);
            setStreamingContent(null);

            // If aborted/error, mark all pending tools as error
            if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
              setToolStates((prev) => {
                const updated = new Map(prev);
                for (const [id, tool] of updated) {
                  if (tool.status === "pending" || tool.status === "running") {
                    updated.set(id, {
                      ...tool,
                      status: "error",
                      result: event.message.errorMessage ?? "Aborted",
                    });
                  }
                }
                return updated;
              });
            }
          }
          break;

        // -----------------------------------------------------------------
        // tool_execution_start: Tool begins executing.
        // pi equivalent: create ToolExecutionComponent, call markExecutionStarted().
        // -----------------------------------------------------------------
        case "tool_execution_start":
          setToolStates((prev) => {
            const updated = new Map(prev);
            const existing = updated.get(event.toolCallId);
            updated.set(event.toolCallId, {
              id: event.toolCallId,
              name: event.toolName,
              args: event.args,
              status: "running",
              result: existing?.result,
            });
            return updated;
          });
          break;

        // -----------------------------------------------------------------
        // tool_execution_update: Partial result from tool.
        // pi equivalent: component.updateResult(partialResult, true).
        // -----------------------------------------------------------------
        case "tool_execution_update":
          setToolStates((prev) => {
            const updated = new Map(prev);
            const existing = updated.get(event.toolCallId);
            if (existing) {
              updated.set(event.toolCallId, {
                ...existing,
                result: event.partialResult,
              });
            }
            return updated;
          });
          break;

        // -----------------------------------------------------------------
        // tool_execution_end: Tool finished.
        // pi equivalent: component.updateResult(result), pendingTools.delete(id).
        // -----------------------------------------------------------------
        case "tool_execution_end":
          setToolStates((prev) => {
            const updated = new Map(prev);
            const existing = updated.get(event.toolCallId);
            if (existing) {
              updated.set(event.toolCallId, {
                ...existing,
                status: event.isError ? "error" : "done",
                result: event.result,
              });
            }
            return updated;
          });
          break;

        // -----------------------------------------------------------------
        // agent_end: Agent finished processing. Hide spinner.
        // pi equivalent: stop loader, clear terminal progress.
        // -----------------------------------------------------------------
        case "agent_end":
          setIsLoading(false);
          break;
      }
    });

    return unsubscribe;
  }, [agent]);

  return { messages, streamingContent, toolStates, isLoading };
}

/**
 * Helper hook for submitting prompts. Wraps agent.prompt() with error handling.
 */
export function usePromptSubmit(agent: AgentSession): (text: string) => void {
  return useCallback(
    (text: string) => {
      agent.prompt(text).catch(() => {
        // Error is surfaced via agent events (message_end with error stopReason)
      });
    },
    [agent],
  );
}
