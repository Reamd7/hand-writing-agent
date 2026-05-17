/**
 * A single chat message bubble.
 *
 * Displays a message from either the user or the assistant with
 * role-specific styling. In pi, the equivalent components are
 * `UserMessageComponent` and `AssistantMessageComponent`.
 */

import React from "react";
import { Box, Text } from "ink";

interface MessageBubbleProps {
  role: "user" | "assistant";
  content: string;
}

export function MessageBubble({ role, content }: MessageBubbleProps): React.ReactElement {
  const isUser = role === "user";
  const label = isUser ? "You" : "Agent";
  const labelColor = isUser ? "blue" : "green";

  // Don't render empty assistant messages (they're just tool-call containers)
  if (!isUser && !content.trim()) {
    return <Box />;
  }

  return (
    <Box paddingX={1} flexDirection="row" marginTop={0}>
      <Box width={6} flexShrink={0}>
        <Text color={labelColor} bold>
          {label}
        </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text wrap="wrap">{content}</Text>
      </Box>
    </Box>
  );
}
