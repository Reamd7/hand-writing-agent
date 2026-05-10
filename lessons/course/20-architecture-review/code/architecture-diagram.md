# pi Agent System -- Complete Architecture Diagram

## Full System Overview

```
╔═════════════════════════════════════════════════════════════════════════════════╗
║                              pi-mono ARCHITECTURE                              ║
║                                                                                 ║
║  5 packages, 7 layers, one request path                                         ║
╚═════════════════════════════════════════════════════════════════════════════════╝


USER INPUT
  │  "Read src/index.ts and summarize it"
  │
  ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ LAYER 1: CLI ENTRY                                                             ┃
┃ Package: coding-agent                                                          ┃
┃ Files:   src/cli.ts, src/main.ts, src/cli/args.ts                              ┃
┃                                                                                 ┃
┃  cli.ts ─── parseArgs(process.argv)                                             ┃
┃    │           │                                                                ┃
┃    │    ┌──────┴──────┬──────────────┐                                          ┃
┃    │    ▼             ▼              ▼                                           ┃
┃    │  --prompt      --print        (default)                                    ┃
┃    │  + --file      single-shot    interactive                                  ┃
┃    │                                                                            ┃
┃    └── main.ts ─── selectMode() ─┬─ interactive-mode.ts  (Ink TUI)             ┃
┃                                   ├─ print-mode.ts        (stdout)              ┃
┃                                   └─ rpc-mode.ts          (JSON-RPC/stdio)      ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                    │ mode.start() -> agentSession.send(msg)
                                    ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ LAYER 2: AGENT SESSION                                                         ┃
┃ Package: coding-agent                                                          ┃
┃ Files:   src/core/agent-session.ts (3100+ lines)                               ┃
┃          src/core/agent-session-runtime.ts                                      ┃
┃          src/core/agent-session-services.ts                                     ┃
┃                                                                                 ┃
┃  AgentSession                                                                   ┃
┃  ├── Model lifecycle                                                            ┃
┃  │   ├── model-resolver.ts ── detect provider from env vars                     ┃
┃  │   ├── model-registry.ts ── list available models                             ┃
┃  │   └── hot-switch model at runtime                                            ┃
┃  │                                                                              ┃
┃  ├── Session persistence                                                        ┃
┃  │   ├── session-manager.ts ── list / create / delete sessions                  ┃
┃  │   ├── session/repo/jsonl.ts ── JSONL file storage                            ┃
┃  │   └── session/repo/memory.ts ── in-memory (testing)                          ┃
┃  │                                                                              ┃
┃  ├── Context management                                                         ┃
┃  │   ├── compaction/compaction.ts ── auto/manual context compression             ┃
┃  │   ├── compaction/branch-summarization.ts ── branch summaries                  ┃
┃  │   └── compaction/utils.ts ── token counting helpers                           ┃
┃  │                                                                              ┃
┃  ├── System prompt                                                              ┃
┃  │   ├── system-prompt.ts ── assemble from templates + context                   ┃
┃  │   └── prompt-templates.ts ── template definitions                             ┃
┃  │                                                                              ┃
┃  ├── Bash execution                                                             ┃
┃  │   └── bash-executor.ts ── process mgmt, timeout, operation queue              ┃
┃  │                                                                              ┃
┃  ├── Event routing                                                              ┃
┃  │   └── event-bus.ts ── typed event dispatcher                                  ┃
┃  │                                                                              ┃
┃  └── Diagnostics                                                                ┃
┃      ├── diagnostics.ts ── debug info collection                                 ┃
┃      └── timings.ts ── performance measurement                                   ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                    │ agent.send(AgentMessage[])
                                    ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ LAYER 3: EXTENSION SYSTEM                                                      ┃
┃ Package: coding-agent                                                          ┃
┃ Files:   src/core/extensions/                                                   ┃
┃                                                                                 ┃
┃  Extension lifecycle:                                                           ┃
┃  ┌─────────────┐    ┌──────────────┐    ┌──────────────┐                       ┃
┃  │  loader.ts  │───>│  runner.ts   │───>│  wrapper.ts  │                       ┃
┃  │ scan dirs,  │    │ init/destroy │    │ extension    │                       ┃
┃  │ import()    │    │ dispatch     │    │ tools ->     │                       ┃
┃  │ modules     │    │ events       │    │ AgentTool    │                       ┃
┃  └─────────────┘    └──────────────┘    └──────────────┘                       ┃
┃                                                                                 ┃
┃  Extension hooks (types.ts):                                                    ┃
┃  ├── onSessionStart    ── setup when session begins                             ┃
┃  ├── onTurnStart       ── before each agent turn                                ┃
┃  ├── onTurnEnd         ── after each agent turn                                 ┃
┃  ├── onMessageStart/End ── around each message                                  ┃
┃  ├── onToolExecutionStart/End ── around tool calls                              ┃
┃  ├── onBeforeCompact   ── modify compaction behavior                            ┃
┃  ├── registerTools     ── add custom tools                                      ┃
┃  └── enhanceSystemPrompt ── modify system prompt                                ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                    │ tools registered, hooks attached
                                    ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ LAYER 4: TOOL DEFINITIONS                                                      ┃
┃ Package: coding-agent                                                          ┃
┃ Files:   src/core/tools/                                                        ┃
┃                                                                                 ┃
┃  Built-in tools (registered in tools/index.ts):                                 ┃
┃                                                                                 ┃
┃  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                          ┃
┃  │   Read   │ │   Edit   │ │  Write   │ │   Bash   │                          ┃
┃  │ read.ts  │ │ edit.ts  │ │ write.ts │ │ bash.ts  │                          ┃
┃  │          │ │edit-diff │ │          │ │          │                          ┃
┃  │ offset,  │ │.ts exact │ │ create   │ │ timeout, │                          ┃
┃  │ limit,   │ │ string   │ │ dirs,    │ │ truncate │                          ┃
┃  │ binary   │ │ replace, │ │ write    │ │ output,  │                          ┃
┃  │ detect   │ │ replaceA │ │ content  │ │ workdir  │                          ┃
┃  └──────────┘ └──────────┘ └──────────┘ └──────────┘                          ┃
┃  ┌──────────┐ ┌──────────┐ ┌──────────┐                                       ┃
┃  │   Grep   │ │   Find   │ │    Ls    │                                       ┃
┃  │ grep.ts  │ │ find.ts  │ │  ls.ts   │                                       ┃
┃  │          │ │          │ │          │                                       ┃
┃  │ regex    │ │ glob     │ │ list dir │                                       ┃
┃  │ search,  │ │ pattern  │ │ entries  │                                       ┃
┃  │ include  │ │ match    │ │          │                                       ┃
┃  └──────────┘ └──────────┘ └──────────┘                                       ┃
┃                                                                                 ┃
┃  Shared infrastructure:                                                         ┃
┃  ├── tool-definition-wrapper.ts ── beforeToolCall / afterToolCall hooks          ┃
┃  ├── file-mutation-queue.ts     ── serialize file write operations               ┃
┃  ├── output-accumulator.ts      ── collect + truncate large outputs              ┃
┃  ├── path-utils.ts              ── path normalization, security checks           ┃
┃  ├── render-utils.ts            ── format tool results for display               ┃
┃  └── truncate.ts                ── smart truncation for long content             ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                    │ AgentTool[] injected into Agent
                                    ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ LAYER 5: AGENT CORE                                                            ┃
┃ Package: agent (pi-agent-core)                                                 ┃
┃ Files:   src/agent.ts, src/agent-loop.ts, src/types.ts                         ┃
┃                                                                                 ┃
┃  ┌──────────────────────────────────────────────────────────────────┐           ┃
┃  │  Agent (agent.ts)                                                │           ┃
┃  │                                                                   │           ┃
┃  │  State machine:  idle ──send()──> streaming ──done──> idle       │           ┃
┃  │                                                                   │           ┃
┃  │  ┌─────────────────┐  ┌──────────────────────────┐              │           ┃
┃  │  │ Message Queue    │  │ AgentState (observable)   │              │           ┃
┃  │  │ mode: all |      │  │ - isStreaming: boolean    │              │           ┃
┃  │  │   one-at-a-time  │  │ - messages: AgentMessage[]│              │           ┃
┃  │  │                  │  │ - usage: TokenUsage       │              │           ┃
┃  │  │ send() queues    │  │ - pendingToolCalls: Set   │              │           ┃
┃  │  │ if streaming     │  │ - streamingMessage?       │              │           ┃
┃  │  └─────────────────┘  └──────────────────────────┘              │           ┃
┃  │                                                                   │           ┃
┃  │  convertToLlm(AgentMessage[]) -> Message[]                       │           ┃
┃  │  (custom message types filtered/mapped at this boundary)          │           ┃
┃  └──────────────────────────────┬───────────────────────────────────┘           ┃
┃                                  │                                               ┃
┃  ┌──────────────────────────────┴───────────────────────────────────┐           ┃
┃  │  AgentLoop (agent-loop.ts)                                       │           ┃
┃  │                                                                   │           ┃
┃  │  ┌─────────────── LOOP ─────────────────────────────┐            │           ┃
┃  │  │                                                    │            │           ┃
┃  │  │  1. Build context:                                │            │           ┃
┃  │  │     { model, system, messages, tools }            │            │           ┃
┃  │  │                    │                               │            │           ┃
┃  │  │  2. Call streamFn(context)                        │            │           ┃
┃  │  │     └── receives AssistantMessageEventStream      │            │           ┃
┃  │  │                    │                               │            │           ┃
┃  │  │  3. Stream events:                                │            │           ┃
┃  │  │     text_delta ──> emit to sink                   │            │           ┃
┃  │  │     tool_call  ──> collect                        │            │           ┃
┃  │  │                    │                               │            │           ┃
┃  │  │  4. If tool calls present:                        │            │           ┃
┃  │  │     for each toolCall:                            │            │           ┃
┃  │  │       a. validateToolArguments(schema, args)      │            │           ┃
┃  │  │       b. beforeToolCall() -> may block            │            │           ┃
┃  │  │       c. tool.execute(validatedArgs) -> result    │            │           ┃
┃  │  │       d. afterToolCall() -> may modify result     │            │           ┃
┃  │  │       e. emit tool_execution_end                  │            │           ┃
┃  │  │       f. push toolResult to messages              │            │           ┃
┃  │  │                    │                               │            │           ┃
┃  │  │  5. Check stopReason:                             │            │           ┃
┃  │  │     "toolCall" ──> continue loop (go to 1)        │            │           ┃
┃  │  │     "endTurn"  ──> break                          │            │           ┃
┃  │  │     "error"    ──> break with error               │            │           ┃
┃  │  │     "aborted"  ──> break                          │            │           ┃
┃  │  │                                                    │            │           ┃
┃  │  └────────────────────────────────────────────────────┘            │           ┃
┃  └──────────────────────────────┬───────────────────────────────────┘           ┃
┃                                  │ streamFn(SimpleStreamOptions)                 ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                    │
                                    ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ LAYER 6: AI SDK (LLM Abstraction)                                              ┃
┃ Package: ai (pi-ai)                                                            ┃
┃ Files:   src/stream-simple.ts, src/providers/*, src/types.ts                   ┃
┃                                                                                 ┃
┃  ┌──────────────────────────────────────────────────────────────┐               ┃
┃  │  streamSimple(options: SimpleStreamOptions)                  │               ┃
┃  │  ├── Resolve model -> find provider                         │               ┃
┃  │  ├── Build provider-specific request                        │               ┃
┃  │  └── Return AssistantMessageEventStream                     │               ┃
┃  └──────────────────────────────┬───────────────────────────────┘               ┃
┃                                  │                                               ┃
┃  Provider routing (lazy registration):                                          ┃
┃  ┌───────────────┐ ┌───────────────┐ ┌──────────────┐ ┌──────────────┐         ┃
┃  │ openai-       │ │ anthropic-    │ │ google-      │ │ bedrock-     │         ┃
┃  │ completions   │ │ messages      │ │ gemini       │ │ converse     │         ┃
┃  │               │ │               │ │              │ │              │         ┃
┃  │ Transform:    │ │ Transform:    │ │ Transform:   │ │ Transform:   │         ┃
┃  │ Message[] ->  │ │ Message[] ->  │ │ Message[] -> │ │ Message[] -> │         ┃
┃  │ OpenAI format │ │ Claude format │ │ Gemini fmt   │ │ Bedrock fmt  │         ┃
┃  │               │ │               │ │              │ │              │         ┃
┃  │ Parse SSE ->  │ │ Parse SSE ->  │ │ Parse SSE -> │ │ Parse SSE -> │         ┃
┃  │ Std events    │ │ Std events    │ │ Std events   │ │ Std events   │         ┃
┃  └───────┬───────┘ └───────┬───────┘ └──────┬───────┘ └──────┬───────┘         ┃
┃          │                 │                │                │                  ┃
┃  Standardized events emitted by all providers:                                  ┃
┃  ┌──────────────────────────────────────────────────────────────┐               ┃
┃  │  { type: "text",     text: "..." }                          │               ┃
┃  │  { type: "toolCall", name: "read", args: {...} }            │               ┃
┃  │  { type: "thinking", text: "..." }                          │               ┃
┃  │  { type: "usage",    input: N, output: N, ... }             │               ┃
┃  │  { type: "stop",     reason: "endTurn"|"toolCall"|"error" } │               ┃
┃  └──────────────────────────────────────────────────────────────┘               ┃
┃                                  │                                               ┃
┃  Supporting infrastructure:                                                     ┃
┃  ├── EventStream<T, R> ── async iterable with push/end                          ┃
┃  ├── Model type ── id, contextWindow, cost, capabilities                        ┃
┃  ├── Transport ── apiKey, baseUrl, headers                                      ┃
┃  ├── Tool schema ── Zod-based parameter definitions                             ┃
┃  └── env-api-keys.ts ── auto-detect API keys from env                           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┯━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
                                    │ HTTP POST + SSE response
                                    ▼
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ LAYER 7: EXTERNAL LLM APIs                                                     ┃
┃                                                                                 ┃
┃  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐     ┃
┃  │   OpenAI     │ │  Anthropic   │ │   Google     │ │    AWS Bedrock    │     ┃
┃  │              │ │              │ │              │ │                    │     ┃
┃  │ GPT-4o       │ │ Claude 4     │ │ Gemini 2.5   │ │ Claude/Llama/etc  │     ┃
┃  │ GPT-4o-mini  │ │ Claude 3.5   │ │ Gemini 2.0   │ │ via AWS SDK       │     ┃
┃  │ o1, o3       │ │ Haiku        │ │              │ │                    │     ┃
┃  └──────────────┘ └──────────────┘ └──────────────┘ └────────────────────┘     ┃
┃                                                                                 ┃
┃  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────────────┐     ┃
┃  │  Groq        │ │ Together     │ │  Mistral     │ │  Azure OpenAI     │     ┃
┃  │  (fast)      │ │ (open src)   │ │              │ │                    │     ┃
┃  └──────────────┘ └──────────────┘ └──────────────┘ └────────────────────┘     ┃
┃                                                                                 ┃
┃  + DeepSeek, Fireworks, OpenRouter, xAI, Cerebras, ...                          ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

## Event Flow (Single Turn with Tool Call)

```
                    Time ──────────────────────────────────────────────>

Agent.send()        AgentLoop           AI SDK              LLM API
    │                  │                   │                    │
    │──queue msg──────>│                   │                    │
    │                  │──streamFn()──────>│                    │
    │                  │                   │──HTTP POST────────>│
    │                  │                   │                    │
    │                  │                   │<─SSE: text delta───│
    │<─emit: text_delta│<─event: text──────│                    │
    │                  │                   │<─SSE: tool_use─────│
    │<─emit: tool_call─│<─event: toolCall──│                    │
    │                  │                   │<─SSE: stop─────────│
    │                  │<─event: stop──────│                    │
    │                  │                   │                    │
    │                  │──execute tool──>  │                    │
    │<─emit: tool_exec │  (read.ts)       │                    │
    │  _start          │                   │                    │
    │                  │<─tool result────  │                    │
    │<─emit: tool_exec │                   │                    │
    │  _end            │                   │                    │
    │                  │                   │                    │
    │                  │──streamFn()──────>│                    │
    │                  │  (with result)    │──HTTP POST────────>│
    │                  │                   │                    │
    │                  │                   │<─SSE: text delta───│
    │<─emit: text_delta│<─event: text──────│                    │
    │                  │                   │<─SSE: stop─────────│
    │                  │<─event: stop──────│                    │
    │                  │                   │  (endTurn)         │
    │<─emit: turn_end──│                   │                    │
    │                  │                   │                    │
```

## Data Type Transformations Across Boundaries

```
User types string
       │
       ▼
AgentMessage {                              ← CLI / Session layer creates
  role: "user",
  content: [{ type: "text", text: "..." }]
}
       │
       ▼ convertToLlm()
Message {                                   ← Agent Core converts for LLM
  role: "user",
  content: [{ type: "text", text: "..." }]
}
       │
       ▼ Provider transform
OpenAI: {                                   ← AI SDK transforms per provider
  role: "user",
  content: "..."                            ← OpenAI flattens single text
}
Anthropic: {
  role: "user",
  content: [{ type: "text", text: "..." }]  ← Anthropic keeps array
}
       │
       ▼ HTTP POST body
JSON -> LLM API
       │
       ▼ SSE response stream
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
       │
       ▼ Provider parse
AssistantMessageEvent {                     ← AI SDK standardizes
  type: "text",
  text: "..."
}
       │
       ▼ Agent Loop emits
AgentEvent {                                ← Agent Core wraps
  type: "text_delta",
  text: "...",
  messageId: "..."
}
       │
       ▼ UI renders
<Text color="white">...</Text>              ← Ink component (TUI)
  or
console.log("...")                          ← Print mode
  or
{"jsonrpc":"2.0","method":"event",...}      ← RPC mode
```

## Package Dependency Graph

```
                    ┌──────────────────────────────────────┐
                    │        coding-agent                    │
                    │  (application layer - top of stack)    │
                    │                                        │
                    │  CLI, Session, Tools, Extensions,      │
                    │  Interactive/Print/RPC modes            │
                    └────┬──────────┬──────────┬────────────┘
                         │          │          │
              ┌──────────┘          │          └─────────┐
              ▼                     ▼                     ▼
     ┌────────────────┐  ┌─────────────────┐  ┌─────────────────┐
     │   agent-core   │  │      tui        │  │    web-ui       │
     │                │  │                 │  │                 │
     │  Agent class,  │  │  Diff renderer, │  │  React chat     │
     │  AgentLoop,    │  │  ANSI control,  │  │  components,    │
     │  types, events │  │  layout engine  │  │  message UI     │
     └───────┬────────┘  └─────────────────┘  └─────────────────┘
             │                (standalone)         (standalone)
             ▼
     ┌────────────────┐
     │      ai        │
     │                │
     │  streamSimple, │
     │  providers,    │
     │  model types,  │
     │  EventStream   │
     └────────────────┘
          (bottom)
```

## Directory Structure Map

```
pi-mono/
├── package.json                    # Workspace root, "type": "module"
├── tsconfig.base.json              # Shared TS config
├── biome.json                      # Formatting + linting
│
├── packages/
│   ├── ai/                         # LAYER 6: LLM Abstraction
│   │   ├── src/
│   │   │   ├── index.ts            # Public API exports
│   │   │   ├── types.ts            # Api, Model, Message, Tool types
│   │   │   ├── stream-simple.ts    # streamSimple() entry point
│   │   │   ├── event-stream.ts     # EventStream<T,R> implementation
│   │   │   ├── env-api-keys.ts     # Auto-detect API keys
│   │   │   ├── models.generated.ts # Auto-generated model catalog
│   │   │   └── providers/
│   │   │       ├── register-builtins.ts  # Lazy provider registration
│   │   │       ├── openai.ts             # OpenAI provider
│   │   │       ├── anthropic.ts          # Anthropic provider
│   │   │       ├── google.ts             # Google Gemini provider
│   │   │       ├── bedrock.ts            # AWS Bedrock provider
│   │   │       └── ...                   # 10+ more providers
│   │   └── test/
│   │
│   ├── agent/                      # LAYER 5: Agent Core
│   │   ├── src/
│   │   │   ├── index.ts            # Public API exports
│   │   │   ├── agent.ts            # Agent class (state machine)
│   │   │   ├── agent-loop.ts       # Core loop implementation
│   │   │   ├── types.ts            # AgentTool, AgentEvent, AgentContext
│   │   │   └── harness/            # Test harness + session abstractions
│   │   │       ├── agent-harness.ts
│   │   │       ├── session/
│   │   │       ├── compaction/
│   │   │       └── system-prompt.ts
│   │   └── test/
│   │
│   ├── coding-agent/               # LAYERS 1-4: Application
│   │   ├── src/
│   │   │   ├── cli.ts              # CLI entry (Layer 1)
│   │   │   ├── main.ts             # Bootstrap
│   │   │   ├── cli/                # Arg parsing, session picker
│   │   │   ├── core/
│   │   │   │   ├── agent-session.ts        # Session lifecycle (Layer 2)
│   │   │   │   ├── agent-session-runtime.ts
│   │   │   │   ├── extensions/             # Extension system (Layer 3)
│   │   │   │   │   ├── types.ts
│   │   │   │   │   ├── loader.ts
│   │   │   │   │   ├── runner.ts
│   │   │   │   │   └── wrapper.ts
│   │   │   │   ├── tools/                  # Tool definitions (Layer 4)
│   │   │   │   │   ├── index.ts
│   │   │   │   │   ├── read.ts
│   │   │   │   │   ├── edit.ts
│   │   │   │   │   ├── write.ts
│   │   │   │   │   ├── bash.ts
│   │   │   │   │   ├── grep.ts
│   │   │   │   │   ├── find.ts
│   │   │   │   │   └── ls.ts
│   │   │   │   ├── system-prompt.ts
│   │   │   │   ├── compaction/
│   │   │   │   └── ...
│   │   │   ├── modes/
│   │   │   │   ├── interactive/    # Ink TUI mode
│   │   │   │   ├── print-mode.ts   # Single-shot mode
│   │   │   │   └── rpc/            # JSON-RPC mode
│   │   │   └── utils/
│   │   └── test/
│   │
│   ├── tui/                        # Standalone terminal UI
│   │   └── src/                    # Diff rendering engine
│   │
│   └── web-ui/                     # Standalone web components
│       └── src/                    # React chat UI
```
