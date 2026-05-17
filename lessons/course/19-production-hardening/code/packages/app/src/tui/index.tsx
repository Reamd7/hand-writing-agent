/**
 * Entry point. Creates a mock agent session and renders the App.
 *
 * In a real application, you would create an actual AgentSession from your
 * agent framework. This demo uses a mock that simulates the event flow
 * so you can see the UI in action without a real LLM backend.
 */

import React from "react";
import { render } from "ink";
import { App } from "./components/App.js";
import type { AgentSession, AgentEvent } from "./hooks/useAgent.js";

// ---------------------------------------------------------------------------
// Mock agent session for demonstration.
// Replace this with your real agent session implementation.
// ---------------------------------------------------------------------------

function createMockAgent(): AgentSession {
  const listeners: Array<(event: AgentEvent) => void> = [];
  let aborted = false;

  return {
    model: { id: "gpt-4o", provider: "openai" },

    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },

    async prompt(text: string) {
      aborted = false;
      const emit = (event: AgentEvent): void => {
        for (const listener of listeners) {
          listener(event);
        }
      };

      const msgId = `msg-${Date.now()}`;
      const assistantId = `assistant-${Date.now()}`;
      const toolId = `tool-${Date.now()}`;

      // Simulate agent_start
      emit({ type: "agent_start" });

      // Simulate user message
      emit({
        type: "message_start",
        message: {
          id: msgId,
          role: "user",
          content: [{ type: "text", text }],
        },
      });

      // Simulate assistant streaming
      emit({
        type: "message_start",
        message: {
          id: assistantId,
          role: "assistant",
          content: [],
        },
      });

      // Simulate streaming tokens
      const response = `I received your message: "${text}". Let me think about that...`;
      for (let i = 1; i <= response.length; i++) {
        if (aborted) break;
        await sleep(20);
        emit({
          type: "message_update",
          message: {
            id: assistantId,
            role: "assistant",
            content: [{ type: "text", text: response.slice(0, i) }],
          },
        });
      }

      if (!aborted) {
        // Simulate a tool execution
        emit({
          type: "message_update",
          message: {
            id: assistantId,
            role: "assistant",
            content: [
              { type: "text", text: response },
              {
                type: "toolCall",
                id: toolId,
                name: "read_file",
                arguments: { path: "src/index.ts" },
              },
            ],
          },
        });

        emit({
          type: "tool_execution_start",
          toolCallId: toolId,
          toolName: "read_file",
          args: { path: "src/index.ts" },
        });

        await sleep(500);

        emit({
          type: "tool_execution_end",
          toolCallId: toolId,
          result: "// file contents here...",
          isError: false,
        });
      }

      // Finalize
      emit({
        type: "message_end",
        message: {
          id: assistantId,
          role: "assistant",
          content: [{ type: "text", text: response }],
          stopReason: aborted ? "aborted" : "end_turn",
        },
      });

      emit({ type: "agent_end" });
    },

    abort() {
      aborted = true;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const agent = createMockAgent();
render(<App agent={agent} />);
