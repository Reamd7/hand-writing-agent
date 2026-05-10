# Lesson 5: Agent Loop (Part 1) - Streaming Response and Turn Management -- Reference Materials

## Pi Source Code References

- **`packages/agent/src/agent-loop.ts`** - Low-level loop and streaming pipeline
  - `agentLoop()` - public entry point; creates `EventStream`, fires `runAgentLoop()` in background
  - `agentLoopContinue()` - continues from existing context without adding a new message
  - `runAgentLoop()` - adds prompt messages to context, emits `agent_start` + `turn_start`, calls `runLoop()`
  - `runLoop()` - main loop: outer loop checks follow-up messages, inner loop handles tool calls + steering messages
  - `streamAssistantResponse()` - core streaming pipeline:
    1. `config.transformContext(messages)` -- optional AgentMessage-level transform (pruning, injection)
    2. `config.convertToLlm(messages)` -- filter to LLM-compatible Message[] (drops custom messages)
    3. Build `Context` object with `systemPrompt`, `messages`, `tools`
    4. Call `streamFn(model, context, options)` -- invokes `streamSimple` or custom stream function
    5. Consume `response` async iterator, map events to `AgentEvent` via `emit()`
    6. Partial message management: push on `start`, replace-in-place on deltas, finalize on `done`/`error`
  - `executeToolCalls()` - dispatches to sequential or parallel execution (covered in Lesson 6)

- **`packages/agent/src/agent.ts`** - Stateful Agent wrapper
  - `Agent.createContextSnapshot()` - shallow-copies `systemPrompt`, `messages`, `tools` into an `AgentContext`
  - `Agent.createLoopConfig()` - builds `AgentLoopConfig` from Agent instance fields
  - `Agent.processEvents()` - state reducer: updates `_state`, then notifies listeners
  - `Agent.runPromptMessages()` - calls `runWithLifecycle()` -> `runAgentLoop()`
  - `defaultConvertToLlm()` - filters to `user | assistant | toolResult` messages only

- **`packages/agent/src/types.ts`** - Type definitions
  - `StreamFn` - type alias for the stream function signature (`typeof streamSimple`)
  - `AgentLoopConfig` - extends `SimpleStreamOptions` with `model`, `convertToLlm`, `transformContext`, hooks
  - `AgentContext` - `{ systemPrompt, messages, tools }` snapshot
  - `AgentEvent` - discriminated union with `message_start`, `message_update`, `message_end`, etc.

## AI SDK streamText Reference

- **Documentation**: https://ai-sdk.dev/docs/ai-sdk-core/generating-text#streamtext
- **`fullStream` property**: https://ai-sdk.dev/docs/ai-sdk-core/generating-text#fullstream-property
- **API Reference**: https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text

### Key `fullStream` Event Types

| Event Type         | Description                                  |
| ------------------ | -------------------------------------------- |
| `start`            | Stream started                               |
| `start-step`       | New step (LLM call) started                  |
| `text-start`       | Text generation started                      |
| `text-delta`       | Incremental text chunk                       |
| `text-end`         | Text generation ended                        |
| `reasoning-start`  | Reasoning/thinking started                   |
| `reasoning-delta`  | Incremental reasoning chunk                  |
| `reasoning-end`    | Reasoning ended                              |
| `tool-call`        | Complete tool call (name + args)             |
| `tool-input-start` | Tool input streaming started                 |
| `tool-input-delta` | Incremental tool input chunk                 |
| `tool-input-end`   | Tool input streaming ended                   |
| `tool-result`      | Tool execution result                        |
| `finish-step`      | Step completed (has `finishReason`, `usage`) |
| `finish`           | All steps completed                          |
| `error`            | Error occurred                               |

### `streamText` Usage Pattern

```typescript
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const result = streamText({
  model: openai("gpt-4o"),
  system: "You are helpful.",
  messages: [{ role: "user", content: "Hello" }],
  tools: {
    /* ... */
  },
});

// Consume fullStream for fine-grained control
for await (const part of result.fullStream) {
  switch (part.type) {
    case "text-delta":
      process.stdout.write(part.textDelta);
      break;
    case "tool-call":
      console.log("Tool:", part.toolName, part.args);
      break;
    case "finish":
      console.log("Done:", part.finishReason);
      break;
  }
}
```

### `streamText` Return Value

- `result.fullStream` - `AsyncIterable` of all stream parts (fine-grained events)
- `result.textStream` - `AsyncIterable` of text deltas only
- `result.text` - Promise that resolves to the complete generated text
- `result.toolCalls` - Promise that resolves to tool calls from the last step
- `result.finishReason` - Promise that resolves to finish reason
- `result.usage` - Promise that resolves to token usage
- `result.response` - Promise that resolves to response metadata

## Context Snapshot Isolation Pattern

The Agent operates on a **snapshot** of its state when starting a loop:

```
Agent._state.messages  (authoritative, mutated by processEvents)
        |
        | .slice() (shallow copy)
        v
AgentContext.messages   (loop's working copy, mutated during streaming)
```

- **Loop** mutates the snapshot's `messages` array (push partial, replace-in-place, push final)
- **processEvents** independently mutates `Agent._state.messages` (push on `message_end`)
- No shared reference -- the loop and the state reducer operate on separate arrays
- This prevents the streaming placeholder from appearing in the authoritative state

## Partial Message Management Timeline

```
Stream event     | context.messages effect        | emit() effect
-----------------|-------------------------------|---------------------------
start            | push(partial)                  | message_start
text_delta       | messages[last] = partial       | message_update
text_end         | messages[last] = partial       | message_update
done             | messages[last] = final         | message_end
(error)          | messages[last] = final         | message_end
```

The partial message is placed into the context array in-place so that if the loop needs to read the current messages (e.g., for a transform), it always sees the latest partial content. On `done`/`error`, the partial is replaced with the finalized `AssistantMessage`.

## Key Design Decisions

| Decision                                                    | Rationale                                                                                          |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `transformContext` runs before `convertToLlm`               | Transform works on AgentMessage[] (richer type), convert narrows to Message[] for LLM              |
| `convertToLlm` filters custom messages                      | LLM only understands user/assistant/toolResult; app-specific messages must be dropped or converted |
| Partial message is stored in context array                  | Loop always sees current streaming state; no separate "partial" slot needed                        |
| `streamFn` is injectable                                    | Enables testing with mock streams; production uses `streamSimple` from `@earendil-works/pi-ai`     |
| `done`/`error` both call `response.result()`                | Ensures the final AssistantMessage always has complete usage stats and stopReason                  |
| `addedPartial` flag tracks whether start event was received | Handles edge case where stream ends without emitting a `start` event                               |
