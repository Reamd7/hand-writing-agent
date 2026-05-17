/**
 * Scrollable message history.
 *
 * Renders the full list of finalized messages (user + assistant) along with
 * their associated tool executions.
 *
 * In pi, this role is played by `chatContainer` (a Container that holds
 * UserMessageComponent, AssistantMessageComponent, and ToolExecutionComponent
 * instances added imperatively). Here we map the same data declaratively.
 */

import React from "react";
import { Box, Text } from "ink";
import { MessageBubble } from "./MessageBubble.js";
import { ToolExecution } from "./ToolExecution.js";
import type { Message, ToolState, ToolCallContent } from "../hooks/useAgent.js";

interface ChatHistoryProps {
  messages: Message[];
  toolStates: Map<string, ToolState>;
}

export function ChatHistory({ messages, toolStates }: ChatHistoryProps): React.ReactElement {
  if (messages.length === 0) {
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={1} paddingY={1}>
        <Text dimColor>No messages yet. Type a message below to start.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {messages.map((msg) => (
        <Box key={msg.id} flexDirection="column">
          {/* Render the message text */}
          <MessageBubble role={msg.role} content={getTextContent(msg)} />

          {/* Render tool executions associated with this assistant message */}
          {msg.role === "assistant" &&
            getToolCalls(msg).map((tc) => {
              const state = toolStates.get(tc.id);
              return (
                <ToolExecution
                  key={tc.id}
                  name={tc.name}
                  status={state?.status ?? "done"}
                  result={state?.result}
                />
              );
            })}

          {/* Show error/abort status if present */}
          {msg.stopReason === "aborted" && (
            <Box paddingLeft={2}>
              <Text color="yellow">[Aborted] {msg.errorMessage ?? "Operation aborted"}</Text>
            </Box>
          )}
          {msg.stopReason === "error" && (
            <Box paddingLeft={2}>
              <Text color="red">[Error] {msg.errorMessage ?? "Unknown error"}</Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTextContent(msg: Message): string {
  return msg.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");
}

function getToolCalls(msg: Message): ToolCallContent[] {
  return msg.content.filter((c): c is ToolCallContent => c.type === "toolCall");
}
