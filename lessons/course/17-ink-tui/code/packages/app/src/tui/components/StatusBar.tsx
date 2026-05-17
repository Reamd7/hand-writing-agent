/**
 * Status bar showing model information and loading state.
 *
 * In pi, this role is split between `FooterComponent` (model name, token
 * usage, git branch) and `statusContainer` + `Loader` (spinner animation).
 * We combine them into a single status bar for simplicity.
 */

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

interface StatusBarProps {
  modelName: string;
  isLoading: boolean;
}

export function StatusBar({ modelName, isLoading }: StatusBarProps): React.ReactElement {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
      flexDirection="row"
    >
      {/* Left: model info */}
      <Box>
        <Text dimColor>Model: </Text>
        <Text bold>{modelName}</Text>
      </Box>

      {/* Right: status indicator */}
      <Box>
        {isLoading ? (
          <Text color="cyan">
            <Spinner type="dots" />
            <Text> Working...</Text>
          </Text>
        ) : (
          <Text color="green">Ready</Text>
        )}
      </Box>
    </Box>
  );
}
