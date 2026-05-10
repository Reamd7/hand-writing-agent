# Lesson 20: Architecture Review and Future Directions -- Reference Materials

## Primary Source: pi-mono Repository

- **Repository**: <https://github.com/earendil-works/pi-mono>
- **Key packages studied throughout this course**:

| Package           | Path                    | Role                                            |
| ----------------- | ----------------------- | ----------------------------------------------- |
| `pi-ai`           | `packages/ai`           | Unified multi-provider LLM streaming API        |
| `pi-agent-core`   | `packages/agent`        | Agent loop, tool execution, state management    |
| `pi-coding-agent` | `packages/coding-agent` | Full coding agent CLI: session, tools, TUI, RPC |
| `pi-tui`          | `packages/tui`          | Terminal UI differential rendering engine       |
| `pi-web-ui`       | `packages/web-ui`       | Web component library for AI chat interfaces    |

### Key Source Files (Architecture Trace)

| File                                                      | What it does                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/coding-agent/src/cli.ts`                        | CLI entry point, parses args, selects run mode                                     |
| `packages/coding-agent/src/main.ts`                       | Bootstraps the application, initializes services                                   |
| `packages/coding-agent/src/core/agent-session.ts`         | Session lifecycle: model selection, event subscription, compaction, bash execution |
| `packages/coding-agent/src/core/agent-session-runtime.ts` | Runtime layer connecting session to agent loop                                     |
| `packages/coding-agent/src/core/sdk.ts`                   | Configures the Agent instance with tools and stream function                       |
| `packages/coding-agent/src/core/system-prompt.ts`         | Builds the system prompt from templates and context                                |
| `packages/coding-agent/src/core/tools/index.ts`           | Registers all built-in tools (read, edit, write, bash, grep, find, ls)             |
| `packages/agent/src/agent.ts`                             | `Agent` class: state machine, message queue, streaming coordination                |
| `packages/agent/src/agent-loop.ts`                        | Core loop: LLM call -> parse tool calls -> execute -> emit results -> repeat       |
| `packages/agent/src/types.ts`                             | `AgentTool`, `AgentEvent`, `AgentContext`, `AgentState` type definitions           |
| `packages/ai/src/index.ts`                                | Public API surface for the AI SDK                                                  |
| `packages/ai/src/stream-simple.ts`                        | `streamSimple()`: unified streaming entry point across all providers               |
| `packages/ai/src/providers/`                              | Provider implementations (OpenAI, Anthropic, Google, etc.)                         |
| `packages/coding-agent/src/core/extensions/`              | Extension API: loader, runner, wrapper, types                                      |
| `packages/coding-agent/src/modes/interactive/`            | Interactive TUI mode (Ink-based)                                                   |
| `packages/coding-agent/src/modes/rpc/`                    | RPC mode for headless / Web UI integration                                         |
| `packages/coding-agent/src/modes/print-mode.ts`           | Non-interactive single-shot mode                                                   |

## AI SDK and Agent Patterns

- **Vercel AI SDK -- Agents overview**: <https://ai-sdk.dev/docs/agents/overview>
  - Explains the tool-calling loop pattern: LLM generates tool calls, runtime executes them, results feed back to LLM
  - `maxSteps` / `maxToolRoundtrips` concept for bounding loop iterations
  - Streaming with `streamText` and `generateText`

- **AI SDK Core -- Tool calling**: <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>
  - `tool()` helper, Zod schema for parameters, `execute` function
  - Multi-step tool calling with automatic continuation

- **AI SDK Core -- Streaming**: <https://ai-sdk.dev/docs/ai-sdk-core/generating-text>
  - `streamText()` returns an async iterable of events
  - Partial text, tool call deltas, usage metadata

## Model Context Protocol (MCP)

- **Specification**: <https://modelcontextprotocol.io/>
- **MCP TypeScript SDK**: <https://github.com/modelcontextprotocol/typescript-sdk>
- **MCP Concepts**:
  - Servers expose tools, resources, and prompts via a standardized JSON-RPC protocol
  - Clients (agents) discover and invoke MCP server capabilities dynamically
  - Transport: stdio, SSE, or HTTP
  - Enables agent interoperability -- any MCP-compatible agent can use any MCP server's tools

### MCP Integration Points in pi

| Concept         | pi equivalent                            | MCP mapping            |
| --------------- | ---------------------------------------- | ---------------------- |
| `AgentTool`     | Built-in tool definitions                | MCP Tool               |
| Extension tools | Dynamically loaded tools from extensions | MCP Tool (from server) |
| System prompt   | Static + dynamic prompt assembly         | MCP Prompt             |
| File context    | Read tool, grep, find                    | MCP Resource           |

## Multi-Agent Patterns

### Architectures

| Pattern                 | Description                                          | When to use                                            |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| **Orchestrator-Worker** | One agent delegates subtasks to specialized agents   | Complex multi-step tasks requiring different expertise |
| **Pipeline**            | Output of agent A feeds into agent B sequentially    | Data transformation chains, review pipelines           |
| **Debate / Consensus**  | Multiple agents propose solutions, a judge selects   | High-stakes decisions, code review                     |
| **Hierarchical**        | Tree of agents with supervisor nodes                 | Large-scale task decomposition                         |
| **Swarm**               | Agents hand off control dynamically based on context | Customer service routing, dynamic specialization       |

### References

- **Anthropic -- Building effective agents**: <https://www.anthropic.com/engineering/building-effective-agents>
- **OpenAI -- Agents SDK**: <https://openai.github.io/openai-agents-python/>
- **LangGraph**: <https://langchain-ai.github.io/langgraph/> -- graph-based multi-agent orchestration
- **CrewAI**: <https://www.crewai.com/> -- role-based multi-agent framework
- **AutoGen**: <https://microsoft.github.io/autogen/> -- Microsoft's multi-agent conversation framework

## Web UI and Real-time Streaming

- **AI SDK UI -- useChat**: <https://ai-sdk.dev/docs/ai-sdk-ui/chatbot>
  - React hook for streaming chat UIs
  - Automatic message state management
  - Tool invocation rendering
- **AI SDK UI -- useCompletion**: <https://ai-sdk.dev/docs/ai-sdk-ui/completion>
- **Server-Sent Events (SSE)**: <https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events>
- **pi's RPC mode**: `packages/coding-agent/src/modes/rpc/` -- JSON-RPC over stdio for Web UI integration

## Sandbox Execution

- **Docker SDK for Node.js**: <https://github.com/apocas/dockerode>
- **E2B -- Code Interpreter SDK**: <https://e2b.dev/docs>
- **Firecracker microVMs**: <https://firecracker-microvm.github.io/>
- Relevant pi code: `packages/coding-agent/src/core/bash-executor.ts` -- current process-based execution

## Structured Output

- **AI SDK -- Structured output**: <https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data>
  - `generateObject()` and `streamObject()` for schema-constrained generation
- **OpenAI structured outputs**: <https://platform.openai.com/docs/guides/structured-outputs>
- **Zod**: <https://zod.dev/> -- TypeScript schema library used for tool parameter validation throughout pi

## Lesson Cross-References

| Topic                                    | Lesson    |
| ---------------------------------------- | --------- |
| Project architecture and package layout  | Lesson 1  |
| AI SDK fundamentals and `streamSimple`   | Lesson 2  |
| Provider management and model resolution | Lesson 3  |
| Agent state and event system             | Lesson 4  |
| Agent loop and streaming                 | Lesson 5  |
| Tool execution in the loop               | Lesson 6  |
| Steering and followup queues             | Lesson 7  |
| Testing with mock providers              | Lesson 8  |
| Tool definition and Read tool            | Lesson 9  |
| Bash tool                                | Lesson 10 |
| Edit and Write tools                     | Lesson 11 |
| System prompt and auxiliary tools        | Lesson 12 |
| Session persistence                      | Lesson 13 |
| Context compaction                       | Lesson 14 |
| Extension API                            | Lesson 15 |
| Extension practice                       | Lesson 16 |
| Ink TUI                                  | Lesson 17 |
| CLI entry and modes                      | Lesson 18 |
| Production hardening                     | Lesson 19 |
