/**
 * Lesson 15 -- ExtensionRunner.
 *
 * Holds loaded extensions and manages their lifecycle:
 * - bindCore(): wire up real action implementations
 * - invalidate(): mark stale after reload/session switch
 * - emit(): generic event dispatch
 * - Specialized emitters for events that chain/merge results
 */

import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ContextEventResult,
  Extension,
  ExtensionContext,
  ExtensionEvent,
  ExtensionMessage,
  ExtensionRuntime,
  ToolCallEvent,
  ToolCallEventResult,
  ExtensionToolDefinition,
  ToolResultEvent,
  ToolResultEventResult,
} from "./extension-types.js";

// ---------------------------------------------------------------------------
// Action implementations injected via bindCore()
// ---------------------------------------------------------------------------

export interface ExtensionActions {
  sendMessage: (content: string) => void;
  setModel: (modelId: string) => void;
  getActiveTools: () => string[];
  setActiveTools: (toolNames: string[]) => void;
}

export interface ContextActions {
  getCwd: () => string;
  isIdle: () => boolean;
  abort: () => void;
  getSystemPrompt: () => string;
}

// ---------------------------------------------------------------------------
// ExtensionRunner
// ---------------------------------------------------------------------------

export class ExtensionRunner {
  private extensions: Extension[];
  private runtime: ExtensionRuntime;
  private cwd: string;
  private isIdleFn: () => boolean = () => true;
  private abortFn: () => void = () => {};
  private getSystemPromptFn: () => string = () => "";
  private staleMessage: string | undefined;

  constructor(extensions: Extension[], runtime: ExtensionRuntime, cwd: string) {
    this.extensions = extensions;
    this.runtime = runtime;
    this.cwd = cwd;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Wire up real action implementations. Before this call, all action methods
   * on the runtime throw "not initialized" errors.
   *
   * Also flushes any provider registrations that were queued during loading.
   */
  bindCore(actions: ExtensionActions, contextActions: ContextActions): void {
    this.runtime.sendMessage = actions.sendMessage;
    this.runtime.setModel = actions.setModel;
    this.runtime.getActiveTools = actions.getActiveTools;
    this.runtime.setActiveTools = actions.setActiveTools;

    this.isIdleFn = contextActions.isIdle;
    this.abortFn = contextActions.abort;
    this.getSystemPromptFn = contextActions.getSystemPrompt;

    // Flush queued registrations
    for (const reg of this.runtime.pendingRegistrations) {
      console.log(`[runner] flushing provider registration: ${reg.name} from ${reg.path}`);
    }
    this.runtime.pendingRegistrations = [];
  }

  /**
   * Mark this runner as stale. All subsequent API calls through captured
   * references will throw. Called on session replacement or /reload.
   */
  invalidate(message?: string): void {
    if (!this.staleMessage) {
      this.staleMessage = message ?? "Extension runner is stale after reload or session switch.";
      this.runtime.invalidate(this.staleMessage);
    }
  }

  private assertActive(): void {
    if (this.staleMessage) {
      throw new Error(this.staleMessage);
    }
  }

  // =========================================================================
  // Query
  // =========================================================================

  /** Check if any extension has handlers for an event type. */
  hasHandlers(eventType: string): boolean {
    for (const ext of this.extensions) {
      const handlers = ext.handlers.get(eventType);
      if (handlers && handlers.length > 0) return true;
    }
    return false;
  }

  /** Get all registered tools (first registration per name wins). */
  getAllRegisteredTools(): ExtensionToolDefinition[] {
    const seen = new Map<string, ExtensionToolDefinition>();
    for (const ext of this.extensions) {
      for (const [name, tool] of ext.tools) {
        if (!seen.has(name)) seen.set(name, tool);
      }
    }
    return Array.from(seen.values());
  }

  /** Get a tool by name. */
  getToolDefinition(toolName: string): ExtensionToolDefinition | undefined {
    for (const ext of this.extensions) {
      const tool = ext.tools.get(toolName);
      if (tool) return tool;
    }
    return undefined;
  }

  // =========================================================================
  // Context Factory
  // =========================================================================

  /**
   * Create an ExtensionContext for event handlers.
   *
   * Values are resolved lazily via getters so changes through bindCore()
   * are reflected without re-creating contexts.
   */
  createContext(): ExtensionContext {
    const runner = this;
    return {
      get cwd() {
        runner.assertActive();
        return runner.cwd;
      },
      isIdle: () => {
        runner.assertActive();
        return runner.isIdleFn();
      },
      abort: () => {
        runner.assertActive();
        runner.abortFn();
      },
      getSystemPrompt: () => {
        runner.assertActive();
        return runner.getSystemPromptFn();
      },
    };
  }

  // =========================================================================
  // Generic Emit
  // =========================================================================

  /**
   * Emit a simple event to all handlers across all extensions.
   * Handlers run sequentially in extension load order.
   */
  async emit(event: ExtensionEvent): Promise<void> {
    const ctx = this.createContext();
    for (const ext of this.extensions) {
      const handlers = ext.handlers.get(event.type);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          await handler(event, ctx);
        } catch (err) {
          console.error(`[extension:${ext.path}] error in ${event.type}:`, err);
        }
      }
    }
  }

  // =========================================================================
  // Specialized Emitters
  // =========================================================================

  /**
   * Emit "context" event. Handlers can return modified messages.
   * Each handler sees the output of the previous handler (chaining).
   */
  async emitContext(messages: ExtensionMessage[]): Promise<ExtensionMessage[]> {
    const ctx = this.createContext();
    let current = structuredClone(messages);

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("context");
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          const event: ContextEvent = { type: "context", messages: current };
          const result = await handler(event, ctx);
          if (result && (result as ContextEventResult).messages) {
            current = (result as ContextEventResult).messages!;
          }
        } catch (err) {
          console.error(`[extension:${ext.path}] error in context:`, err);
        }
      }
    }

    return current;
  }

  /**
   * Emit "tool_call" event. Any handler can block execution.
   * If blocked, returns the result immediately.
   */
  async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    const ctx = this.createContext();
    let result: ToolCallEventResult | undefined;

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("tool_call");
      if (!handlers) continue;
      for (const handler of handlers) {
        const handlerResult = await handler(event, ctx);
        if (handlerResult) {
          result = handlerResult as ToolCallEventResult;
          if (result.block) return result; // short-circuit
        }
      }
    }

    return result;
  }

  /**
   * Emit "tool_result" event. Handlers can modify content/isError.
   * Modifications chain: each handler sees previous handler's changes.
   */
  async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
    const ctx = this.createContext();
    const current: ToolResultEvent = { ...event };
    let modified = false;

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("tool_result");
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          const handlerResult = await handler(current, ctx);
          if (!handlerResult) continue;
          const r = handlerResult as ToolResultEventResult;
          if (r.content !== undefined) {
            current.content = r.content;
            modified = true;
          }
          if (r.isError !== undefined) {
            current.isError = r.isError;
            modified = true;
          }
        } catch (err) {
          console.error(`[extension:${ext.path}] error in tool_result:`, err);
        }
      }
    }

    return modified ? { content: current.content, isError: current.isError } : undefined;
  }

  /**
   * Emit "before_agent_start". Handlers can modify the system prompt.
   * Multiple modifications chain.
   */
  async emitBeforeAgentStart(
    prompt: string,
    systemPrompt: string,
  ): Promise<{ systemPrompt?: string } | undefined> {
    const ctx = this.createContext();
    let currentSystemPrompt = systemPrompt;
    let modified = false;

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("before_agent_start");
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          const event: BeforeAgentStartEvent = {
            type: "before_agent_start",
            prompt,
            systemPrompt: currentSystemPrompt,
          };
          const result = await handler(event, ctx);
          if (result && (result as BeforeAgentStartEventResult).systemPrompt !== undefined) {
            currentSystemPrompt = (result as BeforeAgentStartEventResult).systemPrompt!;
            modified = true;
          }
        } catch (err) {
          console.error(`[extension:${ext.path}] error in before_agent_start:`, err);
        }
      }
    }

    return modified ? { systemPrompt: currentSystemPrompt } : undefined;
  }
}
