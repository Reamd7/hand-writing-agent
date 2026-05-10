// Tool registry: register and execute tools

import type { ToolDefinition, ToolResult } from "@my-agent/core";

/** A function that executes a tool given its arguments. */
type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

const registry = new Map<string, ToolExecutor>();

/** Register a tool with its definition and executor function. */
export function registerTool(definition: ToolDefinition, executor: ToolExecutor): void {
  registry.set(definition.name, executor);
}

/** Execute a registered tool by name. Returns an error result if not found. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const executor = registry.get(name);
  if (!executor) {
    return { toolName: name, result: `Error: tool "${name}" not found` };
  }
  const result = await executor(args);
  return { toolName: name, result };
}

/** List all registered tool names. */
export function listTools(): string[] {
  return [...registry.keys()];
}
