/**
 * Text input component for user messages.
 *
 * Uses `ink-text-input` as a controlled component. The parent passes
 * `onSubmit` which fires when Enter is pressed, and `isActive` to
 * disable input while the agent is processing.
 *
 * In pi, the equivalent is `CustomEditor` -- a full multiline editor
 * with autocomplete, syntax highlighting, etc. Our version is simpler
 * since ink-text-input handles cursor movement and editing for us.
 */

import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputEditorProps {
  onSubmit: (text: string) => void;
  isActive: boolean;
}

export function InputEditor({ onSubmit, isActive }: InputEditorProps): React.ReactElement {
  const [value, setValue] = useState("");

  const handleSubmit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
  };

  return (
    <Box
      borderStyle="round"
      borderColor={isActive ? "blue" : "gray"}
      paddingX={1}
      flexDirection="row"
    >
      <Text color={isActive ? "blue" : "gray"}>{"> "}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={isActive ? "Type a message..." : "Agent is working..."}
        focus={isActive}
      />
    </Box>
  );
}
