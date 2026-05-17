// ============================================================================
// Lesson 7: Steering and Follow-up Queues -- PendingMessageQueue
//
// A simple message queue with two drain modes:
// - "all": drain() returns every queued message at once
// - "one-at-a-time": drain() returns only the first message per call
//
// Modeled after PendingMessageQueue in packages/agent/src/agent.ts.
// ============================================================================

import type { AgentMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Queue mode
// ---------------------------------------------------------------------------

export type QueueMode = "all" | "one-at-a-time";

// ---------------------------------------------------------------------------
// PendingMessageQueue
// ---------------------------------------------------------------------------

/**
 * Internal message queue used for steering and follow-up messages.
 *
 * Drain semantics depend on the mode:
 * - "all": drain() returns the full queue contents and clears it.
 *   Good for batch injection -- one LLM call sees all queued messages.
 * - "one-at-a-time": drain() returns only the first message and shifts
 *   the rest forward. Good for serialized processing -- each message
 *   gets its own assistant response.
 */
export class PendingMessageQueue {
  private messages: AgentMessage[] = [];

  constructor(public mode: QueueMode) {}

  /** Push a message onto the end of the queue. */
  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  /** Check whether the queue has at least one pending message. */
  hasItems(): boolean {
    return this.messages.length > 0;
  }

  /**
   * Remove and return messages according to the current mode.
   *
   * - "all": returns every message, clears the queue.
   * - "one-at-a-time": returns the first message only; remaining
   *   messages stay in the queue for future drain() calls.
   *
   * Returns an empty array if the queue is empty.
   */
  drain(): AgentMessage[] {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }

    // "one-at-a-time": take only the first message
    const first = this.messages[0];
    if (!first) {
      return [];
    }
    this.messages = this.messages.slice(1);
    return [first];
  }

  /** Discard all pending messages. */
  clear(): void {
    this.messages = [];
  }

  /** Current number of pending messages (useful for debugging). */
  get length(): number {
    return this.messages.length;
  }
}
