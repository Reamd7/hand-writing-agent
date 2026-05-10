# Lesson 2: AI SDK Fundamentals and Message Model Design - Reference Materials

## Official Documentation

- **AI SDK Introduction**: https://ai-sdk.dev/docs/introduction
  - Overview of AI SDK, unified API for multiple LLM providers
  - Two main libraries: AI SDK Core (text generation, tools, agents) and AI SDK UI (framework hooks)

- **AI SDK Core - Generating Text**: https://ai-sdk.dev/docs/ai-sdk-core/generating-text
  - `generateText()` for non-interactive use cases
  - `streamText()` for streaming responses, `fullStream` event protocol
  - Result properties: text, reasoning, toolCalls, toolResults, usage, steps, etc.

- **AI SDK Core - Tool Calling**: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
  - `tool()` helper function for type-safe tool definitions
  - Tool schema with Zod: `inputSchema`, `description`, `execute`
  - Multi-step calls with `stopWhen`, tool choice, active tools
  - Tool execution options: toolCallId, messages, abortSignal

- **AI SDK Foundations - Streaming**: https://ai-sdk.dev/docs/foundations/streaming
  - Blocking vs streaming UI patterns
  - `textStream` as AsyncIterable/ReadableStream
  - Backpressure-aware token generation

- **Zod Documentation**: https://zod.dev/
  - TypeScript-first schema validation with static type inference
  - Used by AI SDK for tool input schema definitions
  - Zero dependencies, works in Node.js and browsers

## Pi Source Code References

- **`packages/ai/src/types.ts`** - Low-level message and model types
  - `TextContent`, `ThinkingContent`, `ImageContent`, `ToolCall` - content block types
  - `UserMessage`, `AssistantMessage`, `ToolResultMessage` - LLM message types
  - `Message` - union of all LLM message types
  - `Usage` - token counting with cost breakdown (input, output, cacheRead, cacheWrite)
  - `StopReason` - "stop" | "length" | "toolUse" | "error" | "aborted"
  - `AssistantMessageEvent` - streaming event protocol (start, text_start/delta/end, thinking_start/delta/end, toolcall_start/delta/end, done, error)
  - `Tool`, `Context`, `StreamOptions` - model interaction types
  - `Model<TApi>` - unified model interface with provider, cost, context window metadata

- **`packages/agent/src/types.ts`** - Agent-level abstractions
  - `AgentMessage` - union of `Message | CustomAgentMessages[keyof CustomAgentMessages]`
  - `CustomAgentMessages` - extensible interface for declaration merging
  - `AgentEvent` - UI event protocol (agent_start/end, turn_start/end, message_start/update/end, tool_execution_start/update/end)
  - `AgentContext` - snapshot with systemPrompt, messages, tools
  - `AgentTool<TParameters>` - tool definition with label, execute, prepareArguments
  - `AgentToolResult<T>` - content + details + terminate hint
  - `AgentLoopConfig` - full loop configuration with convertToLlm, transformContext, hooks
  - `AgentState` - public agent state with streaming status, pending tool calls

## Key Concepts Map

```
AI SDK (Vercel)                    Pi (Custom Agent)
─────────────────                  ──────────────────
streamText()                       streamSimple() / StreamFn
  fullStream events:                 AssistantMessageEvent:
  - text-start/delta/end             - text_start/delta/end
  - reasoning-start/delta/end        - thinking_start/delta/end
  - tool-call                        - toolcall_start/delta/end
  - tool-input-start/delta/end       - done / error
  - tool-result
  - start-step / finish-step
  - finish / error

generateText()                     (used internally)
tool()                             AgentTool<TParameters>
ToolSet                            AgentTool<any>[]

CoreMessage                        Message (UserMessage | AssistantMessage | ToolResultMessage)
UIMessage                          AgentMessage (Message | CustomAgentMessages[...])
```
