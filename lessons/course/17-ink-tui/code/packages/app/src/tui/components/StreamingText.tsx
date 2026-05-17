/**
 * Displays incrementally-arriving assistant text during streaming.
 *
 * This component is rendered only while `streamingContent !== null` and
 * shows the in-progress text with a blinking cursor. Once the message
 * finalizes (message_end event), the parent removes this component and
 * the text appears in ChatHistory as a finalized MessageBubble.
 *
 * In pi, the equivalent is `AssistantMessageComponent` with its
 * `updateContent()` method called on each `message_update` event.
 * Here, React handles the update automatically when the content prop changes.
 */

import React from "react";
import { Box, Text } from "ink";

interface StreamingTextProps {
  content: string;
}

export function StreamingText({ content }: StreamingTextProps): React.ReactElement {
  // Show a placeholder while waiting for the first token
  if (!content) {
    return (
      <Box paddingX={1} flexDirection="row" marginTop={0}>
        <Box width={6} flexShrink={0}>
          <Text color="green" bold>
            Agent
          </Text>
        </Box>
        <Text dimColor>Thinking...</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1} flexDirection="row" marginTop={0}>
      <Box width={6} flexShrink={0}>
        <Text color="green" bold>
          Agent
        </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text wrap="wrap">
          {content}
          <Text color="cyan">{"\u2588"}</Text>
        </Text>
      </Box>
    </Box>
  );
}
