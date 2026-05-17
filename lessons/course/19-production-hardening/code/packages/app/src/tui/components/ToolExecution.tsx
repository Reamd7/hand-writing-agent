/**
 * Displays a tool execution with status indicator and result.
 *
 * Maps to pi's `ToolExecutionComponent`, which tracks tool lifecycle:
 *   pending -> running (markExecutionStarted) -> done/error (updateResult)
 *
 * Each tool call is keyed by its toolCallId in the parent's `toolStates` Map.
 * The status determines the icon and color.
 */

import React from "react";
import { Box, Text } from "ink";

interface ToolExecutionProps {
  name: string;
  status: "pending" | "running" | "done" | "error";
  result?: string;
}

const STATUS_CONFIG = {
  pending: { icon: "○", color: "gray" as const },
  running: { icon: "⟳", color: "yellow" as const },
  done: { icon: "✓", color: "green" as const },
  error: { icon: "✗", color: "red" as const },
};

/** Maximum lines of tool result to display before truncation. */
const MAX_RESULT_LINES = 6;

export function ToolExecution({ name, status, result }: ToolExecutionProps): React.ReactElement {
  const config = STATUS_CONFIG[status];

  // Truncate long results
  let displayResult = result;
  if (displayResult) {
    const lines = displayResult.split("\n");
    if (lines.length > MAX_RESULT_LINES) {
      displayResult =
        lines.slice(0, MAX_RESULT_LINES).join("\n") +
        `\n... (${lines.length - MAX_RESULT_LINES} more lines)`;
    }
  }

  return (
    <Box flexDirection="column" paddingLeft={3}>
      {/* Status line */}
      <Box flexDirection="row">
        <Text color={config.color}>{config.icon}</Text>
        <Text> </Text>
        <Text bold>{name}</Text>
        {status === "running" && <Text dimColor> running...</Text>}
        {status === "pending" && <Text dimColor> pending</Text>}
      </Box>

      {/* Result output */}
      {displayResult && (
        <Box paddingLeft={3}>
          <Text dimColor wrap="truncate">
            {displayResult}
          </Text>
        </Box>
      )}
    </Box>
  );
}
