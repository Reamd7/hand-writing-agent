// ============================================================================
// Lesson 8: Testing Agent Core -- Test Utilities
//
// Helpers for writing concise agent tests:
// - collectEvents(): filter events by type from a run result
// - createTestAgent(): factory with sensible defaults
// - Tool definition helpers
// ============================================================================

import type {
  AgentConfig,
  AgentEvent,
  AgentRunResult,
  MockResponseStep,
  ToolDefinition,
  ToolExecutionResult,
  Message,
} from "./mock-provider.js";
import { MockProvider, runAgent } from "./mock-provider.js";

// ---------------------------------------------------------------------------
// Event collection helpers
// ---------------------------------------------------------------------------

/**
 * Extract all events of a specific type from a run result.
 */
export function collectEvents<T extends AgentEvent["type"]>(
  result: AgentRunResult,
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return result.events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

/**
 * Extract the ordered list of event type strings from a run result.
 */
export function eventTypes(result: AgentRunResult): string[] {
  return result.events.map((e) => e.type);
}

/**
 * Extract all messages of a specific role from the final message list.
 */
export function messagesByRole<T extends Message["role"]>(
  result: AgentRunResult,
  role: T,
): Extract<Message, { role: T }>[] {
  return result.messages.filter((m): m is Extract<Message, { role: T }> => m.role === role);
}

// ---------------------------------------------------------------------------
// Test agent factory
// ---------------------------------------------------------------------------

export interface TestAgentOptions {
  /** Pre-loaded mock responses. */
  responses?: MockResponseStep[];
  /** Tool definitions available to the agent. */
  tools?: ToolDefinition[];
  /** System prompt. */
  systemPrompt?: string;
  /** Max turns before the loop stops. */
  maxTurns?: number;
  /** Steering hook. */
  onBeforeTurn?: (messages: Message[]) => string | undefined;
}

export interface TestAgent {
  /** The underlying MockProvider for additional assertions. */
  provider: MockProvider;
  /** Run the agent with a user message and return the result. */
  run: (userMessage: string) => Promise<AgentRunResult>;
}

/**
 * Create a test agent with a MockProvider and sensible defaults.
 *
 * Usage:
 *   const agent = createTestAgent({ responses: [mockTextResponse("Hi")] });
 *   const result = await agent.run("Hello");
 */
export function createTestAgent(options: TestAgentOptions = {}): TestAgent {
  const provider = new MockProvider();
  if (options.responses) {
    provider.enqueue(...options.responses);
  }

  const config: AgentConfig = {
    provider,
    tools: options.tools,
    systemPrompt: options.systemPrompt,
    maxTurns: options.maxTurns,
    onBeforeTurn: options.onBeforeTurn,
  };

  return {
    provider,
    run: (userMessage: string) => runAgent(userMessage, config),
  };
}

// ---------------------------------------------------------------------------
// Tool definition helpers
// ---------------------------------------------------------------------------

/**
 * Create a simple tool definition for testing.
 */
export function createTool(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<ToolExecutionResult> | ToolExecutionResult,
): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: {},
    execute: async (args) => handler(args),
  };
}

/**
 * Create a tool that always returns a fixed string result.
 */
export function createStaticTool(name: string, result: string): ToolDefinition {
  return createTool(name, () => ({
    content: result,
    isError: false,
  }));
}

/**
 * Create a tool that always throws an error.
 */
export function createFailingTool(name: string, errorMessage: string): ToolDefinition {
  return createTool(name, () => {
    throw new Error(errorMessage);
  });
}
