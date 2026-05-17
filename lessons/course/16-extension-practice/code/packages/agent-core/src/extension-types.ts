/**
 * Lesson 15 -- Extension API types.
 *
 * Simplified model of pi's extension system. Demonstrates:
 * - ExtensionFactory pattern: (api) => void | Promise<void>
 * - Typed event subscription with on()
 * - Tool, command, and shortcut registration
 * - Action methods for host interaction
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Fired before each LLM call. Handler can modify the messages array. */
export interface ContextEvent {
  type: "context";
  messages: ExtensionMessage[];
}

/** Fired after user prompt, before the agent loop starts. */
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}

export interface AgentStartEvent {
  type: "agent_start";
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: ExtensionMessage[];
}

export interface TurnStartEvent {
  type: "turn_start";
  turnIndex: number;
}

export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
}

/** Fired before a tool executes. Handler can block execution. */
export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** Fired after a tool executes. Handler can modify the result. */
export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume";
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume";
}

export interface ModelSelectEvent {
  type: "model_select";
  modelId: string;
  previousModelId: string | undefined;
}

export interface InputEvent {
  type: "input";
  text: string;
  source: "interactive" | "extension";
}

/** Union of all extension events. */
export type ExtensionEvent =
  | ContextEvent
  | BeforeAgentStartEvent
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionStartEvent
  | SessionShutdownEvent
  | ModelSelectEvent
  | InputEvent;

// ---------------------------------------------------------------------------
// Event Results
// ---------------------------------------------------------------------------

export interface ContextEventResult {
  messages?: ExtensionMessage[];
}

export interface BeforeAgentStartEventResult {
  /** Replace the system prompt for this turn. */
  systemPrompt?: string;
}

export interface ToolCallEventResult {
  /** Block tool execution. */
  block?: boolean;
  reason?: string;
}

export interface ToolResultEventResult {
  content?: string;
  isError?: boolean;
}

export interface InputEventResult {
  action: "continue" | "transform" | "handled";
  text?: string;
}

// ---------------------------------------------------------------------------
// Event Handler
// ---------------------------------------------------------------------------

/** Handler function. Returns result or void. */
export type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

// ---------------------------------------------------------------------------
// Messages (simplified)
// ---------------------------------------------------------------------------

export interface ExtensionMessage {
  role: "user" | "assistant" | "tool_result";
  content: string;
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

/** Schema for tool parameters (simplified -- pi uses TypeBox). */
export interface ExtensionParameterSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

/** Tool that LLM can call. */
export interface ExtensionToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: ExtensionParameterSchema;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<ExtensionToolResult>;
}

export interface ExtensionToolResult {
  content: string;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// Extension Context (passed to event handlers)
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  cwd: string;
  isIdle(): boolean;
  abort(): void;
  getSystemPrompt(): string;
}

// ---------------------------------------------------------------------------
// ExtensionAPI (passed to factory function)
// ---------------------------------------------------------------------------

export interface ExtensionAPI {
  // Event subscription -- typed overloads for each event
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
  on(
    event: "before_agent_start",
    handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>,
  ): void;
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
  on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
  on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
  on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
  on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

  // Registration
  registerTool(tool: ExtensionToolDefinition): void;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string) => Promise<void> },
  ): void;
  registerShortcut(
    key: string,
    options: { description?: string; handler: () => Promise<void> | void },
  ): void;

  // Actions
  sendMessage(content: string): void;
  setModel(modelId: string): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}

// ---------------------------------------------------------------------------
// Extension Factory
// ---------------------------------------------------------------------------

/** An extension is a factory function that receives the API and registers handlers. */
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Loaded Extension (internal)
// ---------------------------------------------------------------------------

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/** Internal representation of a loaded extension. */
export interface Extension {
  path: string;
  handlers: Map<string, HandlerFn[]>;
  tools: Map<string, ExtensionToolDefinition>;
  commands: Map<
    string,
    { name: string; description?: string; handler: (args: string) => Promise<void> }
  >;
  shortcuts: Map<
    string,
    { key: string; description?: string; handler: () => Promise<void> | void }
  >;
}

// ---------------------------------------------------------------------------
// Extension Runtime (shared mutable state)
// ---------------------------------------------------------------------------

/**
 * Shared runtime state. Created by loader with throwing stubs for action
 * methods. The runner replaces stubs with real implementations via bindCore().
 */
export interface ExtensionRuntime {
  sendMessage: (content: string) => void;
  setModel: (modelId: string) => void;
  getActiveTools: () => string[];
  setActiveTools: (toolNames: string[]) => void;
  /** Flag values set during registration, overridden by CLI */
  flagValues: Map<string, boolean | string>;
  /** Provider registrations queued before bindCore() */
  pendingRegistrations: Array<{ name: string; path: string }>;
  /** Throws if the extension instance is stale after reload/replacement. */
  assertActive: () => void;
  /** Marks instance as stale. */
  invalidate: (message?: string) => void;
}

// ---------------------------------------------------------------------------
// Load Result
// ---------------------------------------------------------------------------

export interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  runtime: ExtensionRuntime;
}
