// ============================================================================
// Lesson 7: Steering and Follow-up Queues -- Agent Class
//
// Complete Agent class with:
// - prompt(), continue(), steer(), followUp(), abort(), waitForIdle()
// - runWithLifecycle() with AbortController management and failure synthesis
// - Context snapshot isolation
// - Steering and follow-up queue integration via createLoopConfig()
//
// Modeled after packages/agent/src/agent.ts.
// ============================================================================

import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.js";
import { PendingMessageQueue } from "./pending-queue.js";
import type {
  AgentContext,
  AgentEvent,
  AgentEventListener,
  AgentLoopConfig,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentTool,
  AssistantMessage,
  ImageContent,
  Model,
  MutableAgentState,
  ShouldStopAfterTurnContext,
  TextContent,
  Usage,
} from "./types.js";
import type { QueueMode } from "./pending-queue.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL: Model = {
  id: "unknown",
  name: "unknown",
  provider: "unknown",
  contextWindow: 0,
  maxTokens: 0,
};

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
};

// ---------------------------------------------------------------------------
// MutableAgentState factory
// ---------------------------------------------------------------------------

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
 * Stateful wrapper around the low-level agent loop.
 *
 * Owns the conversation transcript, emits lifecycle events, executes tools,
 * and exposes queueing APIs for steering and follow-up messages.
 */
export class Agent {
  private _state: MutableAgentState;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;
  private activeRun?: ActiveRun;

  private readonly callLlm: AgentOptions["callLlm"];
  private readonly _shouldStopAfterTurn?: (
    context: ShouldStopAfterTurnContext,
  ) => boolean | Promise<boolean>;

  constructor(options: AgentOptions = {}) {
    this._state = createMutableAgentState(options.initialState);
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    this.callLlm = options.callLlm;
    this._shouldStopAfterTurn = options.shouldStopAfterTurn;
  }

  // -----------------------------------------------------------------------
  // Public state access
  // -----------------------------------------------------------------------

  get state(): AgentState {
    return this._state;
  }

  // -----------------------------------------------------------------------
  // Queue mode accessors
  // -----------------------------------------------------------------------

  set steeringMode(mode: QueueMode) {
    this.steeringQueue.mode = mode;
  }

  get steeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  set followUpMode(mode: QueueMode) {
    this.followUpQueue.mode = mode;
  }

  get followUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  // -----------------------------------------------------------------------
  // Subscriber model
  // -----------------------------------------------------------------------

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -----------------------------------------------------------------------
  // Steering and follow-up
  // -----------------------------------------------------------------------

  /** Queue a message to be injected after the current assistant turn finishes. */
  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  /** Queue a message to run only after the agent would otherwise stop. */
  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  /** Remove all queued steering messages. */
  clearSteeringQueue(): void {
    this.steeringQueue.clear();
  }

  /** Remove all queued follow-up messages. */
  clearFollowUpQueue(): void {
    this.followUpQueue.clear();
  }

  /** Remove all queued steering and follow-up messages. */
  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  /** Returns true when either queue still contains pending messages. */
  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  // -----------------------------------------------------------------------
  // Run lifecycle
  // -----------------------------------------------------------------------

  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  abort(): void {
    this.activeRun?.abortController.abort();
  }

  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  reset(): void {
    this._state.messages = [];
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this._state.errorMessage = undefined;
    this.clearAllQueues();
  }

  // -----------------------------------------------------------------------
  // prompt() and continue()
  // -----------------------------------------------------------------------

  /** Start a new prompt from text, a single message, or a batch. */
  async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  async prompt(input: string, images?: ImageContent[]): Promise<void>;
  async prompt(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): Promise<void> {
    if (this.activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
      );
    }
    const messages = this.normalizePromptInput(input, images);
    await this.runPromptMessages(messages);
  }

  /** Continue from the current transcript. */
  async continue(): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing. Wait for completion before continuing.");
    }

    const lastMessage = this._state.messages[this._state.messages.length - 1];
    if (!lastMessage) {
      throw new Error("No messages to continue from");
    }

    if ("role" in lastMessage && lastMessage.role === "assistant") {
      // Try steering queue first
      const queuedSteering = this.steeringQueue.drain();
      if (queuedSteering.length > 0) {
        await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
        return;
      }

      // Try follow-up queue
      const queuedFollowUps = this.followUpQueue.drain();
      if (queuedFollowUps.length > 0) {
        await this.runPromptMessages(queuedFollowUps);
        return;
      }

      throw new Error("Cannot continue from message role: assistant");
    }

    await this.runContinuation();
  }

  // -----------------------------------------------------------------------
  // Private: input normalization
  // -----------------------------------------------------------------------

  private normalizePromptInput(
    input: string | AgentMessage | AgentMessage[],
    images?: ImageContent[],
  ): AgentMessage[] {
    if (Array.isArray(input)) {
      return input;
    }

    if (typeof input !== "string") {
      return [input];
    }

    const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
    if (images && images.length > 0) {
      content.push(...images);
    }
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  // -----------------------------------------------------------------------
  // Private: run orchestration
  // -----------------------------------------------------------------------

  private async runPromptMessages(
    messages: AgentMessage[],
    options: { skipInitialSteeringPoll?: boolean } = {},
  ): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(
        messages,
        this.createContextSnapshot(),
        this.createLoopConfig(options),
        (event) => this.processEvents(event),
        signal,
      );
    });
  }

  private async runContinuation(): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(
        this.createContextSnapshot(),
        this.createLoopConfig(),
        (event) => this.processEvents(event),
        signal,
      );
    });
  }

  // -----------------------------------------------------------------------
  // Private: context snapshot
  // -----------------------------------------------------------------------

  /**
   * Create a shallow copy of the current context for the loop.
   *
   * The loop mutates its copy freely. Agent._state.messages is updated
   * separately via processEvents() on message_end events.
   */
  private createContextSnapshot(): AgentContext {
    return {
      systemPrompt: this._state.systemPrompt,
      messages: this._state.messages.slice(),
      tools: this._state.tools.slice(),
    };
  }

  // -----------------------------------------------------------------------
  // Private: loop config with queue closures
  // -----------------------------------------------------------------------

  private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
    let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;

    const defaultCallLlm = async (): Promise<AssistantMessage> => ({
      role: "assistant",
      content: [{ type: "text", text: "No LLM configured" }],
      model: this._state.model.id,
      provider: this._state.model.provider,
      usage: EMPTY_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    });

    return {
      model: this._state.model,
      thinkingLevel: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
      callLlm: this.callLlm ?? defaultCallLlm,
      shouldStopAfterTurn: this._shouldStopAfterTurn,

      getSteeringMessages: async () => {
        if (skipInitialSteeringPoll) {
          skipInitialSteeringPoll = false;
          return [];
        }
        return this.steeringQueue.drain();
      },

      getFollowUpMessages: async () => this.followUpQueue.drain(),
    };
  }

  // -----------------------------------------------------------------------
  // Private: runWithLifecycle
  // -----------------------------------------------------------------------

  /**
   * Wraps every run with:
   * 1. AbortController creation
   * 2. isStreaming state management
   * 3. Failure synthesis on uncaught errors
   * 4. Guaranteed cleanup via finishRun()
   */
  private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing.");
    }

    const abortController = new AbortController();
    let resolvePromise: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.activeRun = { promise, resolve: resolvePromise, abortController };

    this._state.isStreaming = true;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  // -----------------------------------------------------------------------
  // Private: failure synthesis
  // -----------------------------------------------------------------------

  /**
   * Synthesize a complete event sequence for a failed run.
   *
   * Listeners always see message_start -> message_end -> turn_end -> agent_end,
   * even when the executor throws. This prevents UI state inconsistencies.
   */
  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const failureMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: this._state.model.id,
      provider: this._state.model.provider,
      usage: EMPTY_USAGE,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    await this.processEvents({ type: "message_start", message: failureMessage });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  // -----------------------------------------------------------------------
  // Private: run cleanup
  // -----------------------------------------------------------------------

  private finishRun(): void {
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this._state.pendingToolCalls = new Set<string>();
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  // -----------------------------------------------------------------------
  // Private: state reducer + listener notification
  // -----------------------------------------------------------------------

  private async processEvents(event: AgentEvent): Promise<void> {
    // Step 1: Update internal state
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
          "role" in event.message &&
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
}
