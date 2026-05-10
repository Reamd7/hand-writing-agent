# Lesson 7: Steering and Follow-up Queues -- Reference Materials

## Pi Source Code References

- **`packages/agent/src/agent.ts`** - Agent class with queue infrastructure
  - `PendingMessageQueue` - internal queue class with `"all"` vs `"one-at-a-time"` drain modes
    - `enqueue(message)` - push a message onto the queue
    - `drain()` - return messages according to mode (`"all"` returns everything, `"one-at-a-time"` returns first only)
    - `hasItems()` - check if queue has pending messages
    - `clear()` - discard all pending messages
  - `Agent.steer(message)` - enqueue a steering message (injected after current turn ends)
  - `Agent.followUp(message)` - enqueue a follow-up message (processed when agent would otherwise stop)
  - `Agent.clearSteeringQueue()` / `Agent.clearFollowUpQueue()` / `Agent.clearAllQueues()` - queue management
  - `Agent.hasQueuedMessages()` - check if either queue has pending items
  - `Agent.steeringMode` / `Agent.followUpMode` - get/set drain mode per queue
  - `Agent.prompt()` - start a new prompt; throws if already running
  - `Agent.continue()` - continue from current transcript; drains steering then follow-up if last message is assistant
  - `Agent.abort()` - abort current run via `AbortController.abort()`
  - `Agent.waitForIdle()` - resolves when activeRun promise settles
  - `Agent.runWithLifecycle()` - sets up `AbortController`, manages `isStreaming`, synthesizes failure messages on error
  - `Agent.createContextSnapshot()` - shallow-copies `messages`, `tools`, `systemPrompt` for loop isolation
  - `Agent.createLoopConfig()` - builds `AgentLoopConfig` with `getSteeringMessages` / `getFollowUpMessages` closures that drain from the queues; supports `skipInitialSteeringPoll`

- **`packages/agent/src/agent-loop.ts`** - Double loop with steering/follow-up polling
  - `runLoop()` - main loop logic shared by `runAgentLoop` and `runAgentLoopContinue`
    - Outer `while (true)` loop: continues when follow-up messages arrive after agent would stop
    - Inner `while (hasMoreToolCalls || pendingMessages.length > 0)` loop: processes tool calls + steering messages
    - Initial steering poll at loop start (before first LLM call)
    - Post-turn steering poll via `config.getSteeringMessages()`
    - Follow-up poll via `config.getFollowUpMessages()` when inner loop exhausts
    - `shouldStopAfterTurn` hook checked after each `turn_end`, before steering poll
  - `runAgentLoop()` - entry point: appends prompt messages to context, emits `agent_start` + `turn_start`, calls `runLoop()`
  - `runAgentLoopContinue()` - entry point for continuation: no new messages, validates last message is not assistant

## Double Loop Architecture

```
runLoop():
  pendingMessages = getSteeringMessages()   // initial poll

  OUTER: while (true) {
    INNER: while (hasMoreToolCalls || pendingMessages.length > 0) {
      emit turn_start
      inject pendingMessages into context
      stream assistant response
      if error/aborted -> emit turn_end, agent_end, return
      execute tool calls -> hasMoreToolCalls
      emit turn_end
      if shouldStopAfterTurn -> emit agent_end, return
      pendingMessages = getSteeringMessages()
    }
    // inner loop exhausted -- agent would stop
    followUpMessages = getFollowUpMessages()
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages
      continue OUTER
    }
    break
  }
  emit agent_end
```

## Key Design Patterns

- **Two-tier queueing**: Steering messages interrupt the inner loop (injected between turns). Follow-up messages only fire when the agent has nothing left to do. This separates "mid-run corrections" from "post-run continuation".
- **Drain semantics**: `"all"` mode returns every queued message at once (batch injection). `"one-at-a-time"` mode returns only the first message per drain call (serialized processing). Default is `"one-at-a-time"` for both queues.
- **Context snapshot isolation**: `createContextSnapshot()` copies `messages` and `tools` arrays so the loop operates on a stable snapshot. The loop mutates its copy; `processEvents()` separately appends to `Agent._state.messages` via `message_end` events. The two arrays diverge during a run and reconverge only because `processEvents` pushes the same messages.
- **skipInitialSteeringPoll**: When `continue()` drains steering messages itself and passes them as the prompt, it sets `skipInitialSteeringPoll: true` so `runLoop` does not double-drain from an already-emptied queue.
- **Failure synthesis**: `handleRunFailure()` constructs a synthetic `AssistantMessage` with `stopReason: "error"` or `"aborted"`, emits `message_start -> message_end -> turn_end -> agent_end` so listeners always see a complete event sequence even on crashes.
- **AbortController per run**: `runWithLifecycle()` creates a fresh `AbortController` for each run. `abort()` signals it. The signal propagates to the stream function and all tool executions.
- **Mutual exclusion**: `prompt()` and `continue()` throw if `activeRun` already exists. Callers must use `steer()` / `followUp()` to queue messages during a run, or `waitForIdle()` before starting a new run.

## External Links

- [AbortController - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) -- Standard API for aborting asynchronous operations; used by pi to cancel agent runs and tool executions
- [AbortSignal - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) -- Signal object that communicates abort state; passed through the stream function and tool execute calls
- [Async Iteration and Generators - MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Iterators_and_generators) -- Foundation for `for await...of` loops used to consume event streams
- [Async Iterators and Generators - tc39 proposal](https://github.com/tc39/proposal-async-iteration) -- The TC39 specification for async iteration that underpins stream consumption patterns
- [Event-Driven Architecture - Martin Fowler](https://martinfowler.com/articles/201701-event-driven.html) -- Overview of event-driven patterns relevant to the steering/follow-up queue design
- [Enterprise Integration Patterns: Message Queue](https://www.enterpriseintegrationpatterns.com/patterns/messaging/MessageQueue.html) -- Queue-based messaging patterns that inform the two-tier queue design
