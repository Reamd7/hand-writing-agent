// ============================================================================
// Lesson 4: Agent State and Event Model -- Agent Class
//
// This file implements the Agent class skeleton: state management, subscriber
// model, and processEvents(). The actual agent loop (prompt/continue) is NOT
// implemented here -- that is the subject of lessons 5-6.
//
// What IS here:
// - createMutableAgentState() factory
// - Agent.subscribe() / unsubscribe
// - Agent.processEvents() as state reducer
// - Agent.state getter
// - Agent.abort() / waitForIdle()
// - Agent.pushEvent() for testing (simulates the loop pushing events)
// ============================================================================

import type {
  AgentEvent,
  AgentEventListener,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentTool,
  Model,
  MutableAgentState,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default model (placeholder for when no model is configured)
// ---------------------------------------------------------------------------

const DEFAULT_MODEL: Model<any> = {
  id: "unknown",
  name: "unknown",
  api: "",
  provider: "unknown",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 0,
  maxTokens: 0,
};

// ---------------------------------------------------------------------------
// MutableAgentState factory
// ---------------------------------------------------------------------------

/**
 * Create a MutableAgentState with clone-on-set for `tools` and `messages`.
 *
 * The returned object uses getter/setter pairs backed by closure variables.
 * Assigning a new array to `tools` or `messages` triggers `.slice()` so the
 * Agent never holds a reference to an externally-owned array.
 */
function createMutableAgentState(
  initialState?: Partial<
    Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">
  >,
): MutableAgentState {
  let tools: AgentTool[] = initialState?.tools?.slice() ?? [];
  let messages: AgentMessage[] = initialState?.messages?.slice() ?? [];

  return {
    systemPrompt: initialState?.systemPrompt ?? "",
    model: initialState?.model ?? DEFAULT_MODEL,
    thinkingLevel: initialState?.thinkingLevel ?? "off",

    get tools(): AgentTool[] {
      return tools;
    },
    set tools(nextTools: AgentTool[]) {
      tools = nextTools.slice();
    },

    get messages(): AgentMessage[] {
      return messages;
    },
    set messages(nextMessages: AgentMessage[]) {
      messages = nextMessages.slice();
    },

    isStreaming: false,
    streamingMessage: undefined,
    pendingToolCalls: new Set<string>(),
    errorMessage: undefined,
  };
}

// ---------------------------------------------------------------------------
// Active run tracking
// ---------------------------------------------------------------------------

interface ActiveRun {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
}

// ---------------------------------------------------------------------------
// Agent class
// ---------------------------------------------------------------------------

/**
 * Stateful wrapper that owns the conversation transcript, emits lifecycle
 * events, and provides a subscriber model for UI updates.
 *
 * In this lesson we implement the state + event infrastructure. The actual
 * agent loop (LLM calls, tool execution) is added in lessons 5-6.
 */
export class Agent {
  private _state: MutableAgentState;
  private readonly listeners = new Set<AgentEventListener>();
  private activeRun?: ActiveRun;

  constructor(options: AgentOptions = {}) {
    this._state = createMutableAgentState(options.initialState);
  }

  // -----------------------------------------------------------------------
  // Public state access
  // -----------------------------------------------------------------------

  /**
   * Current agent state (read-only view).
   *
   * The returned object IS the internal MutableAgentState, but the
   * AgentState interface hides the writable runtime fields behind
   * `readonly` modifiers. `tools` and `messages` setters perform
   * clone-on-set.
   */
  get state(): AgentState {
    return this._state;
  }

  // -----------------------------------------------------------------------
  // Subscriber model
  // -----------------------------------------------------------------------

  /**
   * Subscribe to agent lifecycle events.
   *
   * Listener promises are awaited in subscription order and are included
   * in the current run's settlement. Listeners receive the active
   * AbortSignal for the current run.
   *
   * Returns an unsubscribe function.
   */
  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -----------------------------------------------------------------------
  // Run lifecycle
  // -----------------------------------------------------------------------

  /** Active abort signal for the current run, if any. */
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /** Abort the current run, if one is active. */
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  /**
   * Resolve when the current run and all awaited event listeners
   * have finished. Resolves immediately if no run is active.
   */
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  /** Clear transcript state, runtime state. */
  reset(): void {
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this._state.errorMessage = undefined;
  }

  // -----------------------------------------------------------------------
  // Event processing -- the state reducer
  // -----------------------------------------------------------------------

  /**
   * Process a single event: update internal state, then notify listeners.
   *
   * This is the core state reducer. The low-level agent loop calls this
   * for every event it produces. In this lesson we expose it via
   * `pushEvent()` for testing.
   *
   * State is always updated BEFORE listeners are notified, so listeners
   * see consistent, up-to-date state.
   */
  private async processEvents(event: AgentEvent): Promise<void> {
    // Step 1: Reduce state based on event type
    switch (event.type) {
      case "message_start":
        this._state.streamingMessage = event.message;
        break;

      case "message_update":
        this._state.streamingMessage = event.message;
        break;

      case "message_end":
        this._state.streamingMessage = undefined;
        this._state.messages.push(event.message);
        break;

      case "tool_execution_start": {
        const pendingToolCalls = new Set(this._state.pendingToolCalls);
        pendingToolCalls.add(event.toolCallId);
        this._state.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "tool_execution_end": {
        const pendingToolCalls = new Set(this._state.pendingToolCalls);
        pendingToolCalls.delete(event.toolCallId);
        this._state.pendingToolCalls = pendingToolCalls;
        break;
      }

      case "turn_end":
        if (
          event.message.role === "assistant" &&
          "errorMessage" in event.message &&
          event.message.errorMessage
        ) {
          this._state.errorMessage = event.message.errorMessage;
        }
        break;

      case "agent_end":
        this._state.streamingMessage = undefined;
        break;

      // agent_start, turn_start, tool_execution_update:
      // No state changes -- listeners are still notified.
    }

    // Step 2: Notify all listeners in subscription order
    const signal = this.activeRun?.abortController.signal;
    if (!signal) {
      throw new Error("Agent listener invoked outside active run");
    }
    for (const listener of this.listeners) {
      await listener(event, signal);
    }
  }

  // -----------------------------------------------------------------------
  // Run management (simplified for this lesson)
  // -----------------------------------------------------------------------

  /**
   * Start a managed run. Sets up the AbortController and activeRun
   * tracking. The executor receives the abort signal and should call
   * pushEvent() to emit events.
   */
  async startRun(): Promise<AbortSignal> {
    if (this.activeRun) {
      throw new Error("Agent is already processing.");
    }

    const abortController = new AbortController();
    let resolvePromise: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.activeRun = {
      promise,
      resolve: resolvePromise,
      abortController,
    };

    this._state.isStreaming = true;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;

    return abortController.signal;
  }

  /**
   * End the current run. Clears runtime state and resolves the
   * activeRun promise so waitForIdle() callers are notified.
   */
  finishRun(): void {
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  /**
   * Push an event into the agent's event pipeline.
   *
   * In production, the low-level loop calls processEvents() internally.
   * This method exposes that pipeline for testing: you can manually
   * construct events and verify state transitions.
   *
   * Requires an active run (call startRun() first).
   */
  async pushEvent(event: AgentEvent): Promise<void> {
    await this.processEvents(event);
  }
}
