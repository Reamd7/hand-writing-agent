// ============================================================================
// Lesson 4: Agent State and Event Model -- Type Definitions
//
// Simplified but production-quality types modeled after packages/agent/src/types.ts.
// We omit LLM streaming internals (AssistantMessageEvent, StreamFn, etc.) since
// those belong to lessons 2-3 and 5-6. The focus here is on state, events, tools,
// and the Agent contract.
// ============================================================================

// ---------------------------------------------------------------------------
// Foundational types (simplified from @earendil-works/pi-ai)
// ---------------------------------------------------------------------------

/** Text content block in a message or tool result. */
export interface TextContent {
  type: "text";
  text: string;
}

/** Image content block in a message or tool result. */
export interface ImageContent {
  type: "image";
  /** Base64-encoded image data or a URL. */
  data: string;
  mimeType: string;
}

/** User message sent to the model. */
export interface UserMessage {
  role: "user";
  content: (TextContent | ImageContent)[];
  timestamp: number;
}

/** Assistant message returned by the model. */
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ToolCallContent)[];
  model: string;
  provider: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

/** Tool call block inside an assistant message. */
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Tool result message fed back to the model. */
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

/** Token usage statistics. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

/** Why the model stopped generating. */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/** Union of all LLM-level messages. */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Model metadata (simplified)
// ---------------------------------------------------------------------------

/** Model descriptor. */
export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
}

/** Thinking/reasoning level for models that support it. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ---------------------------------------------------------------------------
// Agent messages (extensible)
// ---------------------------------------------------------------------------

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * ```typescript
 * declare module "./types.js" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
  // Empty by default -- apps extend via declaration merging
}

/**
 * Union of LLM messages + any custom messages registered via declaration merging.
 * This is the message type used throughout the Agent layer.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ---------------------------------------------------------------------------
// AgentTool
// ---------------------------------------------------------------------------

/** Final or partial result produced by a tool. */
export interface AgentToolResult<TDetails = unknown> {
  /** Text or image content returned to the model. */
  content: (TextContent | ImageContent)[];
  /** Arbitrary structured details for logs or UI rendering. */
  details: TDetails;
  /**
   * Hint that the agent should stop after the current tool batch.
   * Early termination only happens when every finalized tool result
   * in the batch sets this to true.
   */
  terminate?: boolean;
}

/** Callback used by tools to stream partial execution updates. */
export type AgentToolUpdateCallback<TDetails = unknown> = (
  partialResult: AgentToolResult<TDetails>,
) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<TDetails = unknown> {
  /** Machine-readable name used in tool calls. */
  name: string;
  /** Human-readable label for UI display. */
  label: string;
  /** Description sent to the model as part of the tool schema. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
  /**
   * Execute the tool call.
   * Throw on failure instead of encoding errors in `content`.
   */
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /**
   * Per-tool execution mode override.
   * - "sequential": this tool must execute one at a time.
   * - "parallel": this tool can execute concurrently.
   */
  executionMode?: "sequential" | "parallel";
}

// ---------------------------------------------------------------------------
// AgentContext
// ---------------------------------------------------------------------------

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
  /** System prompt included with every model request. */
  systemPrompt: string;
  /** Transcript visible to the model. */
  messages: AgentMessage[];
  /** Tools available for this run. */
  tools?: AgentTool[];
}

// ---------------------------------------------------------------------------
// AgentEvent -- Discriminated union
// ---------------------------------------------------------------------------

/**
 * Events emitted by the Agent for UI updates and state management.
 *
 * Uses `type` as the discriminant property. TypeScript narrows the type
 * in switch/case branches automatically.
 *
 * `agent_end` is the last event emitted for a run, but awaited listeners
 * for that event are still part of run settlement.
 */
export type AgentEvent =
  // --- Agent lifecycle ---
  | AgentStartEvent
  | AgentEndEvent
  // --- Turn lifecycle (one turn = one assistant response + tool calls) ---
  | TurnStartEvent
  | TurnEndEvent
  // --- Message lifecycle ---
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  // --- Tool execution lifecycle ---
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent;

export interface AgentStartEvent {
  type: "agent_start";
}

export interface AgentEndEvent {
  type: "agent_end";
  /** All new messages produced during this run. */
  messages: AgentMessage[];
}

export interface TurnStartEvent {
  type: "turn_start";
}

export interface TurnEndEvent {
  type: "turn_end";
  /** The assistant message that completed this turn. */
  message: AgentMessage;
  /** Tool result messages produced during this turn. */
  toolResults: ToolResultMessage[];
}

export interface MessageStartEvent {
  type: "message_start";
  /** The message being started (may be partial for streaming assistant messages). */
  message: AgentMessage;
}

export interface MessageUpdateEvent {
  type: "message_update";
  /** Updated partial assistant message. */
  message: AgentMessage;
}

export interface MessageEndEvent {
  type: "message_end";
  /** The finalized message. */
  message: AgentMessage;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: AgentToolResult;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: AgentToolResult;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// AgentState
// ---------------------------------------------------------------------------

/**
 * Public agent state.
 *
 * `tools` and `messages` use accessor properties so implementations can
 * copy assigned arrays before storing them (clone-on-set).
 */
export interface AgentState {
  /** System prompt sent with each model request. */
  systemPrompt: string;
  /** Active model used for future turns. */
  model: Model;
  /** Requested reasoning level for future turns. */
  thinkingLevel: ThinkingLevel;
  /** Available tools. Assigning a new array copies the top-level array. */
  set tools(tools: AgentTool[]);
  get tools(): AgentTool[];
  /** Conversation transcript. Assigning a new array copies the top-level array. */
  set messages(messages: AgentMessage[]);
  get messages(): AgentMessage[];
  /** True while the agent is processing a prompt or continuation. */
  readonly isStreaming: boolean;
  /** Partial assistant message for the current streamed response, if any. */
  readonly streamingMessage?: AgentMessage;
  /** Tool call IDs currently executing. */
  readonly pendingToolCalls: ReadonlySet<string>;
  /** Error message from the most recent failed/aborted assistant turn. */
  readonly errorMessage?: string;
}

/**
 * Internal writable version of AgentState.
 *
 * Removes `readonly` from runtime fields so the Agent class and loop
 * internals can update them. `pendingToolCalls` becomes a full `Set`.
 */
export type MutableAgentState = Omit<
  AgentState,
  "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"
> & {
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
};

// ---------------------------------------------------------------------------
// AgentLoopConfig (simplified -- full version adds convertToLlm, hooks, etc.)
// ---------------------------------------------------------------------------

/** Configuration for a single agent loop run. */
export interface AgentLoopConfig {
  /** Model to use for this run. */
  model: Model;
  /** Thinking/reasoning level. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Tool execution mode.
   * - "sequential": execute tool calls one by one
   * - "parallel": execute allowed tool calls concurrently
   */
  toolExecution?: "sequential" | "parallel";
}

// ---------------------------------------------------------------------------
// AgentOptions
// ---------------------------------------------------------------------------

/** Options for constructing an Agent. */
export interface AgentOptions {
  /** Partial initial state. Runtime fields (isStreaming, etc.) are ignored. */
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >;
}

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

/**
 * Event listener function.
 * Receives the event and the active run's AbortSignal.
 * May return a promise -- the Agent awaits each listener in order.
 */
export type AgentEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;
