/**
 * AgentSession -- Facade that unifies the agent lifecycle.
 *
 * In a real codebase (like pi) this class is ~3100 lines. This simplified
 * version demonstrates the key responsibilities:
 *
 *   - Agent state access (model, tools, thinking level)
 *   - Event subscription with session persistence
 *   - Prompt dispatch with validation
 *   - Model and thinking level management
 *   - Tool registry management
 *   - System prompt rebuild on tool/config changes
 *
 * All three run modes (interactive, print, RPC) share one AgentSession
 * instance and layer their own I/O on top via subscribe().
 */

// ---------------------------------------------------------------------------
// Simulated external types (in a real codebase these come from @pi/agent-core
// and @pi/ai packages)
// ---------------------------------------------------------------------------

export interface Model {
  provider: string;
  id: string;
  contextWindow: number;
  reasoning?: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

export interface AssistantMessage {
  role: "assistant";
  content: Array<{ type: "text"; text: string } | { type: "toolCall"; name: string; id: string }>;
  usage: Usage;
  stopReason: "end" | "toolCall" | "error" | "aborted";
  errorMessage?: string;
  provider: string;
  model: string;
  timestamp: number;
}

export interface UserMessage {
  role: "user";
  content: string | Array<{ type: "text"; text: string }>;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | { role: string; [key: string]: unknown };

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<{ content: string }>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type AgentSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; reason: string };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgentSessionConfig {
  /** Current working directory */
  cwd: string;
  /** Initial model (may be undefined until user selects one) */
  model?: Model;
  /** Initial thinking level */
  thinkingLevel?: ThinkingLevel;
  /** Tool definitions to register */
  tools?: AgentTool[];
  /** Initial system prompt */
  systemPrompt?: string;
  /** Models available for cycling (from --models flag) */
  scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
}

// ---------------------------------------------------------------------------
// AgentSession
// ---------------------------------------------------------------------------

export class AgentSession {
  // -- State --
  private _model: Model | undefined;
  private _thinkingLevel: ThinkingLevel;
  private _systemPrompt: string;
  private _messages: AgentMessage[] = [];
  private _isStreaming = false;

  // -- Tool registry (definition + executable) --
  private _toolRegistry: Map<string, AgentTool> = new Map();
  private _activeToolNames: Set<string> = new Set();

  // -- Model cycling --
  private _scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

  // -- Event listeners --
  private _listeners: AgentSessionEventListener[] = [];

  // -- Metadata --
  readonly cwd: string;

  constructor(config: AgentSessionConfig) {
    this.cwd = config.cwd;
    this._model = config.model;
    this._thinkingLevel = config.thinkingLevel ?? "off";
    this._systemPrompt = config.systemPrompt ?? "You are a helpful coding assistant.";
    this._scopedModels = config.scopedModels ?? [];

    // Register initial tools
    if (config.tools) {
      for (const tool of config.tools) {
        this._toolRegistry.set(tool.name, tool);
        this._activeToolNames.add(tool.name);
      }
    }
  }

  // =========================================================================
  // Read-only state access
  // =========================================================================

  get model(): Model | undefined {
    return this._model;
  }

  get thinkingLevel(): ThinkingLevel {
    return this._thinkingLevel;
  }

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get systemPrompt(): string {
    return this._systemPrompt;
  }

  get messages(): readonly AgentMessage[] {
    return this._messages;
  }

  get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
    return this._scopedModels;
  }

  // =========================================================================
  // Event subscription
  // =========================================================================

  /**
   * Subscribe to session events. Returns an unsubscribe function.
   */
  subscribe(listener: AgentSessionEventListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this._listeners) {
      listener(event);
    }
  }

  // =========================================================================
  // Prompt dispatch
  // =========================================================================

  /**
   * Send a prompt to the agent.
   *
   * Validates model and API key before sending. During streaming, throws
   * unless a queueing strategy is specified.
   */
  async prompt(text: string): Promise<void> {
    // Validate
    if (!this._model) {
      throw new Error("No model selected. Use --model or /model to choose one.");
    }
    if (this._isStreaming) {
      throw new Error("Agent is already streaming. Abort first or queue via steer/followUp.");
    }

    // Build user message
    const userMessage: UserMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };

    this._messages.push(userMessage);
    this.emit({ type: "message_start", message: userMessage });
    this.emit({ type: "message_end", message: userMessage });

    // Simulate agent processing
    this._isStreaming = true;
    this.emit({ type: "agent_start" });

    try {
      // In a real implementation this calls the LLM provider and runs
      // the tool-use loop. Here we simulate a simple text response.
      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: `[simulated response to: "${text}"]` }],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
        stopReason: "end",
        provider: this._model.provider,
        model: this._model.id,
        timestamp: Date.now(),
      };

      this._messages.push(assistantMessage);
      this.emit({ type: "message_start", message: assistantMessage });
      this.emit({ type: "message_end", message: assistantMessage });
    } finally {
      this._isStreaming = false;
      this.emit({ type: "agent_end" });
    }
  }

  /**
   * Abort current streaming operation.
   */
  abort(): void {
    this._isStreaming = false;
  }

  // =========================================================================
  // Model management
  // =========================================================================

  /**
   * Set the active model. In a real implementation this validates auth
   * and persists the choice to the session file.
   */
  setModel(model: Model): void {
    this._model = model;
    // Clamp thinking level to what the new model supports
    if (!model.reasoning && this._thinkingLevel !== "off") {
      this.setThinkingLevel("off");
    }
  }

  /**
   * Cycle to the next model in the scoped model list.
   * Returns the new model, or undefined if only one model available.
   */
  cycleModel(): Model | undefined {
    if (this._scopedModels.length <= 1) return undefined;

    const currentIndex = this._scopedModels.findIndex(
      (sm) => sm.model.provider === this._model?.provider && sm.model.id === this._model?.id,
    );
    const nextIndex = (currentIndex + 1) % this._scopedModels.length;
    const next = this._scopedModels[nextIndex];

    this.setModel(next.model);
    if (next.thinkingLevel) {
      this.setThinkingLevel(next.thinkingLevel);
    }

    return next.model;
  }

  // =========================================================================
  // Thinking level management
  // =========================================================================

  /**
   * Set thinking level. Emits a change event.
   */
  setThinkingLevel(level: ThinkingLevel): void {
    const previous = this._thinkingLevel;
    this._thinkingLevel = level;
    if (level !== previous) {
      this.emit({ type: "thinking_level_changed", level });
    }
  }

  /** Cycle to the next thinking level. */
  cycleThinkingLevel(): ThinkingLevel {
    const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
    const idx = levels.indexOf(this._thinkingLevel);
    const next = levels[(idx + 1) % levels.length];
    this.setThinkingLevel(next);
    return next;
  }

  // =========================================================================
  // Tool management
  // =========================================================================

  /** Get names of currently active tools. */
  getActiveToolNames(): string[] {
    return [...this._activeToolNames];
  }

  /** Get all registered tools (active or not). */
  getAllTools(): AgentTool[] {
    return [...this._toolRegistry.values()];
  }

  /**
   * Set active tools by name. Unknown names are silently ignored.
   * Triggers a system prompt rebuild to include/exclude tool snippets.
   */
  setActiveToolsByName(names: string[]): void {
    this._activeToolNames.clear();
    for (const name of names) {
      if (this._toolRegistry.has(name)) {
        this._activeToolNames.add(name);
      }
    }
    this.rebuildSystemPrompt();
  }

  /** Register a new tool at runtime (e.g., from an extension). */
  registerTool(tool: AgentTool): void {
    this._toolRegistry.set(tool.name, tool);
    this._activeToolNames.add(tool.name);
    this.rebuildSystemPrompt();
  }

  // =========================================================================
  // System prompt
  // =========================================================================

  /**
   * Rebuild the system prompt based on active tools.
   *
   * In a real implementation this incorporates:
   * - Base instructions (coding assistant role, safety rules)
   * - Tool-specific prompt snippets and guidelines
   * - Loaded skills and context files (AGENTS.md)
   * - Custom --system-prompt overrides
   * - Extension-injected appends
   */
  rebuildSystemPrompt(): void {
    const toolList = [...this._activeToolNames].join(", ");
    this._systemPrompt = [
      "You are a helpful coding assistant.",
      "",
      `Active tools: ${toolList || "none"}`,
      "",
      "Use tools to read, edit, and execute code on the user's behalf.",
    ].join("\n");
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  /**
   * Dispose the session. Unsubscribes all listeners and cleans up resources.
   */
  dispose(): void {
    this._listeners = [];
  }
}
