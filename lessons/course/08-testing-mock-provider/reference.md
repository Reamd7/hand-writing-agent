# Lesson 8: Testing Agent Core -- Mock Provider -- Reference Materials

## AI SDK Testing

- **AI SDK testing guide**: https://ai-sdk.dev/docs/ai-sdk-core/testing
  - `MockLanguageModelV1`: preset responses for `generateText` / `streamText`
  - Simulated streaming via `simulateReadableStream` with configurable chunk delay
  - `MockEmbeddingModelV1` for embedding tests
  - Test approach: replace real model with mock, assert on output and tool calls

## Pi Source Code References

- **`packages/ai/src/providers/faux.ts`** - Pi's built-in mock provider
  - `registerFauxProvider()` - registers a faux API with a response queue
  - `FauxResponseStep` - `AssistantMessage | FauxResponseFactory` (static or dynamic)
  - `FauxResponseFactory` - `(context, options, state, model) => AssistantMessage`
  - `fauxAssistantMessage()`, `fauxText()`, `fauxToolCall()` - message factories
  - `streamWithDeltas()` - simulates token-by-token streaming with configurable `tokensPerSecond`
  - `withUsageEstimate()` - synthetic token count and cache simulation
  - `FauxProviderRegistration.setResponses()` / `appendResponses()` - queue management
  - `FauxProviderRegistration.state.callCount` - tracks how many times the provider was called

- **`packages/ai/src/types.ts`** - Type definitions
  - `AssistantMessage` - role, content blocks, usage, stopReason, errorMessage
  - `AssistantMessageEvent` - discriminated union for stream events (start, text_delta, toolcall_end, done, error)
  - `ToolCall` - id, name, arguments
  - `Context` - systemPrompt, messages, tools
  - `StreamFunction` - `(model, context, options?) => AssistantMessageEventStream`

- **`packages/agent/src/agent.ts`** - Agent class
  - `Agent.subscribe()` - event listener registration
  - `Agent.processEvents()` - state reducer
  - `Agent.pushEvent()` - test entry point for manual event injection

- **`packages/agent/src/agent-loop.ts`** - Low-level agent loop
  - `runAgentLoop()` - drives the LLM call / tool execution cycle
  - `streamAssistantResponse()` - calls provider, emits message events
  - `executeToolCalls()` - runs tools, emits tool execution events

## Vitest

- **Vitest docs**: https://vitest.dev/
  - `describe` / `it` / `expect` - test structure and assertions
  - `beforeEach` / `afterEach` - setup and teardown
  - `vi.fn()` - mock functions with call tracking
  - `vi.spyOn()` - spy on existing methods
  - `expect().toEqual()` - deep equality
  - `expect().toMatchObject()` - partial match
  - `expect().toThrow()` - error assertions
  - `expect().rejects.toThrow()` - async error assertions

## Key Testing Patterns

| Pattern                  | Description                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Scripted response queue  | Pre-load mock provider with ordered responses; each `stream()` call shifts the next                    |
| Event collection         | Subscribe to agent, collect all `AgentEvent`s in an array, assert order and content                    |
| Tool call cycle          | Response with `stopReason: "toolUse"` triggers tool execution; provide tool result, then next response |
| Error injection          | Return `stopReason: "error"` with `errorMessage` to test error paths                                   |
| Abort testing            | Call `agent.abort()` mid-stream, verify `stopReason: "aborted"`                                        |
| Multi-step orchestration | Queue multiple responses: tool call -> text, tool call -> tool call -> text                            |
| Deterministic output     | Fixed response content enables exact string matching, not just "contains"                              |

## Design Principles for Mock Providers

1. **No network**: mock providers operate entirely in-memory
2. **Deterministic**: same input always produces same output (no randomness)
3. **Scriptable**: responses are pre-configured, not generated
4. **Observable**: track call count, inspect received context
5. **Controllable**: support tool calls, errors, abort, and multi-turn flows
6. **Minimal**: only implement what the test needs; avoid production provider complexity
