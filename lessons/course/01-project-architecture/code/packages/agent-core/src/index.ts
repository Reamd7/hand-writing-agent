// Agent core: message types and agent loop interface

/** A single message in a conversation. */
export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Definition of a tool that the agent can invoke. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The result returned after a tool execution. */
export interface ToolResult {
  toolName: string;
  result: string;
}

/** Configuration for an agent instance. */
export interface AgentConfig {
  model: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTurns: number;
}

/** Create an AgentConfig with sensible defaults, overridable via partial input. */
export function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: "default",
    systemPrompt: "You are a helpful assistant.",
    tools: [],
    maxTurns: 10,
    ...overrides,
  };
}
