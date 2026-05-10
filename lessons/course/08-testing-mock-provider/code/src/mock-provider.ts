// ============================================================================
// Lesson 8: Testing Agent Core -- Mock Provider
//
// A minimal mock provider that returns scripted AssistantMessage responses.
// No network, no randomness, no streaming delays -- pure deterministic
// behavior for testing the agent loop.
//
// Design:
// - Pre-loaded response queue: each call to `stream()` shifts the next response
// - Supports text, tool calls, errors, and abort
// - Tracks call history for assertions
// - Exposes received context for verification
// ============================================================================

// ---------------------------------------------------------------------------
// Foundational types (simplified from packages/ai/src/types.ts)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContentBlock = TextContent | ToolCall;

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface UserMessage {
  role: "user";
  content: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolExecutionResult>;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Agent events (simplified discriminated union)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage }
  | { type: "message_start"; message: AssistantMessage }
  | { type: "message_delta"; content: string }
  | { type: "message_end"; message: AssistantMessage }
  | { type: "tool_call_start"; toolCall: ToolCall }
  | { type: "tool_call_end"; toolCall: ToolCall; result: ToolExecutionResult }
  | { type: "error"; error: string }
  | { type: "steering"; content: string };

// ---------------------------------------------------------------------------
// Mock Provider
// ---------------------------------------------------------------------------

const DEFAULT_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};

/** A single scripted response or a factory that builds one from the context. */
export type MockResponseStep =
  | AssistantMessage
  | ((context: { messages: Message[]; callIndex: number }) => AssistantMessage);

/** History entry recorded for each call to `stream()`. */
export interface MockCallRecord {
  messages: Message[];
  response: AssistantMessage;
}

/**
 * Create a text-only AssistantMessage. Convenience factory for tests.
 */
export function mockTextResponse(text: string, model = "mock-model"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    provider: "mock",
    usage: DEFAULT_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Create an AssistantMessage containing a single tool call.
 */
export function mockToolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
  options: { toolCallId?: string; model?: string } = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: options.toolCallId ?? `tc_${Date.now()}`,
        name: toolName,
        arguments: args,
      },
    ],
    model: options.model ?? "mock-model",
    provider: "mock",
    usage: DEFAULT_USAGE,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

/**
 * Create an AssistantMessage with multiple tool calls.
 */
export function mockMultiToolCallResponse(
  toolCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }>,
  model = "mock-model",
): AssistantMessage {
  return {
    role: "assistant",
    content: toolCalls.map((tc, i) => ({
      type: "toolCall" as const,
      id: tc.id ?? `tc_${i}`,
      name: tc.name,
      arguments: tc.args,
    })),
    model,
    provider: "mock",
    usage: DEFAULT_USAGE,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

/**
 * Create an error AssistantMessage.
 */
export function mockErrorResponse(errorMessage: string, model = "mock-model"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    model,
    provider: "mock",
    usage: DEFAULT_USAGE,
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

/**
 * MockProvider: a scriptable, deterministic provider for testing agent loops.
 *
 * Usage:
 *   const provider = new MockProvider();
 *   provider.enqueue(mockTextResponse("Hello!"));
 *   const response = provider.stream(messages);
 */
export class MockProvider {
  private queue: MockResponseStep[] = [];
  private _callHistory: MockCallRecord[] = [];

  /** Number of times `stream()` has been called. */
  get callCount(): number {
    return this._callHistory.length;
  }

  /** Full call history for assertions. */
  get callHistory(): readonly MockCallRecord[] {
    return this._callHistory;
  }

  /** Number of responses remaining in the queue. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Enqueue one or more scripted responses. */
  enqueue(...responses: MockResponseStep[]): void {
    this.queue.push(...responses);
  }

  /** Replace the entire response queue. */
  setResponses(responses: MockResponseStep[]): void {
    this.queue = [...responses];
  }

  /** Clear the queue and call history. */
  reset(): void {
    this.queue = [];
    this._callHistory = [];
  }

  /**
   * Simulate a streaming call to the LLM.
   *
   * Shifts the next response from the queue, records the call, and
   * returns the AssistantMessage. If the queue is empty, returns an
   * error response.
   *
   * In a real provider this would return a stream of events; here we
   * return the complete message synchronously for simplicity.
   */
  stream(messages: Message[]): AssistantMessage {
    const step = this.queue.shift();
    if (!step) {
      const errorResponse = mockErrorResponse("MockProvider: no more responses in queue");
      this._callHistory.push({ messages: [...messages], response: errorResponse });
      return errorResponse;
    }

    const response =
      typeof step === "function"
        ? step({ messages: [...messages], callIndex: this._callHistory.length })
        : step;

    this._callHistory.push({ messages: [...messages], response });
    return response;
  }
}

// ---------------------------------------------------------------------------
// Simplified Agent (drives the mock provider through a tool-call loop)
// ---------------------------------------------------------------------------

export interface AgentConfig {
  provider: MockProvider;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  /** Maximum number of turns to prevent infinite loops. */
  maxTurns?: number;
  /** Hook called before each LLM call. Return a message to inject (steering). */
  onBeforeTurn?: (messages: Message[]) => string | undefined;
}

export interface AgentRunResult {
  messages: Message[];
  events: AgentEvent[];
}

/**
 * Run the agent loop: send messages to the provider, execute tool calls,
 * continue until the assistant stops or maxTurns is reached.
 *
 * This is a simplified version of pi's runAgentLoop(). It produces
 * AgentEvents that can be collected and asserted on.
 */
export async function runAgent(userMessage: string, config: AgentConfig): Promise<AgentRunResult> {
  const { provider, tools = [], maxTurns = 10, onBeforeTurn } = config;
  const events: AgentEvent[] = [];
  const messages: Message[] = [];
  const signal = new AbortController();

  function emit(event: AgentEvent): void {
    events.push(event);
  }

  // Initial user message
  const userMsg: UserMessage = {
    role: "user",
    content: userMessage,
    timestamp: Date.now(),
  };
  messages.push(userMsg);

  emit({ type: "agent_start" });

  let turns = 0;

  while (turns < maxTurns) {
    turns++;

    // Steering hook: inject a message before the LLM call
    if (onBeforeTurn) {
      const steering = onBeforeTurn([...messages]);
      if (steering) {
        const steeringMsg: UserMessage = {
          role: "user",
          content: steering,
          timestamp: Date.now(),
        };
        messages.push(steeringMsg);
        emit({ type: "steering", content: steering });
      }
    }

    emit({ type: "turn_start" });

    // Call the mock provider
    let assistantMessage: AssistantMessage;
    try {
      assistantMessage = provider.stream(messages);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      emit({ type: "error", error: errorMsg });
      emit({ type: "agent_end", messages });
      return { messages, events };
    }

    // Check for provider-level error
    if (assistantMessage.stopReason === "error") {
      emit({ type: "message_start", message: assistantMessage });
      emit({ type: "message_end", message: assistantMessage });
      emit({ type: "error", error: assistantMessage.errorMessage ?? "Unknown error" });
      messages.push(assistantMessage);
      emit({ type: "turn_end", message: assistantMessage });
      emit({ type: "agent_end", messages });
      return { messages, events };
    }

    // Emit message events
    emit({ type: "message_start", message: assistantMessage });
    for (const block of assistantMessage.content) {
      if (block.type === "text") {
        emit({ type: "message_delta", content: block.text });
      }
    }
    emit({ type: "message_end", message: assistantMessage });
    messages.push(assistantMessage);

    // Extract tool calls
    const toolCalls = assistantMessage.content.filter((b): b is ToolCall => b.type === "toolCall");

    if (toolCalls.length === 0) {
      // No tool calls -- turn and agent complete
      emit({ type: "turn_end", message: assistantMessage });
      break;
    }

    // Execute tool calls
    for (const tc of toolCalls) {
      emit({ type: "tool_call_start", toolCall: tc });

      const toolDef = tools.find((t) => t.name === tc.name);
      let result: ToolExecutionResult;

      if (!toolDef) {
        result = { content: `Tool "${tc.name}" not found`, isError: true };
      } else {
        try {
          result = await toolDef.execute(tc.arguments, signal.signal);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          result = { content: errorMsg, isError: true };
        }
      }

      emit({ type: "tool_call_end", toolCall: tc, result });

      // Append tool result to messages
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: result.content,
        isError: result.isError,
        timestamp: Date.now(),
      };
      messages.push(toolResult);
    }

    emit({ type: "turn_end", message: assistantMessage });
    // Loop continues -- the agent will call the provider again with updated messages
  }

  emit({ type: "agent_end", messages });
  return { messages, events };
}
