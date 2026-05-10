// ============================================================================
// Lesson 7: Steering and Follow-up Queues -- Type Definitions
//
// Carries forward the types from Lesson 4 and extends AgentLoopConfig with
// steering/follow-up hooks, shouldStopAfterTurn, and convertToLlm.
// ============================================================================

// ---------------------------------------------------------------------------
// Foundational types (simplified from @earendil-works/pi-ai)
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface UserMessage {
  role: "user";
  content: (TextContent | ImageContent)[];
  timestamp: number;
}

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

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Model metadata
// ---------------------------------------------------------------------------

export interface Model {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxTokens: number;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ---------------------------------------------------------------------------
// Agent messages (extensible)
// ---------------------------------------------------------------------------

export interface CustomAgentMessages {}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ---------------------------------------------------------------------------
// AgentTool
// ---------------------------------------------------------------------------

export interface AgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details: TDetails;
  terminate?: boolean;
}

export type AgentToolUpdateCallback<TDetails = unknown> = (
  partialResult: AgentToolResult<TDetails>,
) => void;

export interface AgentTool<TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}

// ---------------------------------------------------------------------------
// AgentContext
// ---------------------------------------------------------------------------

export interface AgentContext {
  systemPrompt: string;
  messages: AgentMessage[];
  tools?: AgentTool[];
}

// ---------------------------------------------------------------------------
// AgentEvent
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: AgentToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    };

// ---------------------------------------------------------------------------
// AgentState
// ---------------------------------------------------------------------------

export interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  set tools(tools: AgentTool[]);
  get tools(): AgentTool[];
  set messages(messages: AgentMessage[]);
  get messages(): AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}

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
// ShouldStopAfterTurnContext
// ---------------------------------------------------------------------------

export interface ShouldStopAfterTurnContext {
  message: AgentMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}

// ---------------------------------------------------------------------------
// AgentLoopConfig
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  model: Model;
  thinkingLevel?: ThinkingLevel;
  toolExecution?: "sequential" | "parallel";

  /**
   * Simulate an LLM call. In a real agent this calls the streaming provider.
   * For this lesson we use a fake that reads from a response queue.
   */
  callLlm: (
    messages: AgentMessage[],
    tools: AgentTool[] | undefined,
    signal?: AbortSignal,
  ) => Promise<AssistantMessage>;

  /** Called after each turn_end. Return true to force-stop the agent. */
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

  /** Poll steering messages to inject mid-run. */
  getSteeringMessages?: () => Promise<AgentMessage[]>;

  /** Poll follow-up messages when agent would otherwise stop. */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

// ---------------------------------------------------------------------------
// AgentOptions
// ---------------------------------------------------------------------------

export interface AgentOptions {
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  /** Fake LLM: given context messages, return an assistant response. */
  callLlm?: (
    messages: AgentMessage[],
    tools: AgentTool[] | undefined,
    signal?: AbortSignal,
  ) => Promise<AssistantMessage>;
  /** Optional shouldStopAfterTurn hook. */
  shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

export type AgentEventListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

// ---------------------------------------------------------------------------
// AgentEventSink
// ---------------------------------------------------------------------------

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;
