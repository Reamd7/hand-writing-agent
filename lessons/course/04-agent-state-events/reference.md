# Lesson 4: Agent State and Event Model -- Reference Materials

## Pi Source Code References

- **`packages/agent/src/types.ts`** - Core type definitions
  - `AgentState` - public state interface with accessor properties for `tools` and `messages`
  - `MutableAgentState` - internal writable version (defined in `agent.ts`, omits readonly modifiers)
  - `AgentEvent` - discriminated union of all lifecycle events
  - `AgentTool<TParameters, TDetails>` - tool definition with `execute`, `label`, `prepareArguments`
  - `AgentToolResult<T>` - result type with `content`, `details`, `terminate`
  - `AgentContext` - snapshot passed into the low-level loop (`systemPrompt`, `messages`, `tools`)
  - `AgentLoopConfig` - full loop configuration extending `SimpleStreamOptions`
  - `ThinkingLevel` - `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`
  - `AgentMessage` - union of `Message | CustomAgentMessages[keyof CustomAgentMessages]`

- **`packages/agent/src/agent.ts`** - Agent class implementation
  - `createMutableAgentState()` - factory with clone-on-set for `tools` and `messages`
  - `Agent.subscribe()` - listener registration, returns unsubscribe function
  - `Agent.processEvents()` - state reducer: updates `_state`, then fans out to listeners in order
  - `Agent.state` getter - exposes `MutableAgentState` as read-only `AgentState`
  - `Agent.runWithLifecycle()` - sets up `AbortController`, manages `activeRun`, calls `finishRun()`
  - `PendingMessageQueue` - internal queue for steering/follow-up messages

- **`packages/agent/src/agent-loop.ts`** - Low-level loop that emits `AgentEvent`s
  - `runAgentLoop()` / `runAgentLoopContinue()` - sink-based loop entry points
  - `agentLoop()` / `agentLoopContinue()` - `EventStream`-based wrappers
  - `streamAssistantResponse()` - transforms `AgentMessage[]` to `Message[]` at the LLM boundary
  - `executeToolCalls()` - sequential or parallel tool execution with prepare/execute/finalize pipeline

## Event-Driven Architecture Patterns

- **Observer Pattern**: subscribers register callbacks; the subject notifies all subscribers when state changes. Pi uses `Set<listener>` with ordered async iteration.
- **Event Sourcing (lightweight)**: `processEvents()` acts as a state reducer -- each event deterministically updates the agent state before notifying listeners. State is derived from the event sequence.
- **Discriminated Union Dispatch**: a single `switch (event.type)` routes to the correct handler. The TypeScript compiler verifies exhaustiveness if a `default` branch is omitted with `--noImplicitReturns`.
- **Unsubscribe-via-closure**: `subscribe()` returns a function that removes the listener. No event name strings, no `.off()` method -- just call the returned function.
- **Async listener ordering**: listeners are awaited sequentially in subscription order. This guarantees that listener N sees the same state as listener N-1 left it, important for UI consistency.
- **AbortSignal propagation**: the active run's `AbortController.signal` is forwarded to every listener, enabling cooperative cancellation from any layer.

## TypeScript Discriminated Unions

- **Handbook reference**: https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions
- A union type where every member shares a common literal-typed property (the "discriminant"). TypeScript narrows the type inside `switch`/`if` branches on that property.
- Pi's `AgentEvent` uses `type` as the discriminant with 10 variants: `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.
- Pattern:

  ```typescript
  type Event = { type: "a"; payload: string } | { type: "b"; count: number };

  function handle(event: Event) {
    switch (event.type) {
      case "a":
        // event is narrowed to { type: "a"; payload: string }
        console.log(event.payload);
        break;
      case "b":
        // event is narrowed to { type: "b"; count: number }
        console.log(event.count);
        break;
    }
  }
  ```

- Exhaustiveness checking: add a `default: never` arm or use `satisfies never` to catch unhandled variants at compile time.

## Key Design Decisions in Pi

| Decision                                                         | Rationale                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `tools`/`messages` use accessor properties with `.slice()`       | Prevents external mutation of internal arrays; cheap shallow copy        |
| `pendingToolCalls` is `ReadonlySet<string>` in public API        | Exposes set semantics without allowing `add`/`delete` from outside       |
| `MutableAgentState` is a private type                            | Only the Agent class and loop internals can write streaming/error fields |
| `processEvents()` updates state _before_ notifying listeners     | Listeners always see consistent, up-to-date state                        |
| Listeners receive `AbortSignal`                                  | Allows listeners to skip expensive work when the run is cancelled        |
| `agent_end` is emitted before `finishRun()` clears runtime state | Listeners can still read `isStreaming === true` during `agent_end`       |
