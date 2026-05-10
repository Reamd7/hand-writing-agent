# Lesson 6: Agent Loop (Part 2) - Tool Call Execution Engine -- Reference Materials

## Pi Source Code References

- **`packages/agent/src/agent-loop.ts`** - Tool execution pipeline
  - `executeToolCalls()` - entry point: decides parallel vs sequential based on `config.toolExecution` and per-tool `executionMode`
  - `prepareToolCall()` - stage 1: find tool by name, `prepareArguments()` shim, `validateToolArguments()`, `beforeToolCall` hook (can block)
  - `executePreparedToolCall()` - stage 2: call `tool.execute(id, args, signal, onUpdate)`, `onUpdate` emits `tool_execution_update`, catches exceptions
  - `finalizeExecutedToolCall()` - stage 3: `afterToolCall` hook with field-level override (`content`, `details`, `terminate`, `isError`)
  - `shouldTerminateToolBatch()` - batch termination: ALL finalized calls must set `terminate: true`
  - `executeToolCallsSequential()` - prepare-execute-finalize one at a time, emit events inline
  - `executeToolCallsParallel()` - prepare sequentially (immediate results short-circuit), execute concurrently via `Promise.all`, emit tool-result messages in source order
  - `prepareToolCallArguments()` - calls `tool.prepareArguments()` if present, returns original or shimmed tool call
  - `createErrorToolResult()` - builds an `AgentToolResult` with a text error message
  - `createToolResultMessage()` - converts `FinalizedToolCallOutcome` to `ToolResultMessage`
  - `emitToolExecutionEnd()` / `emitToolResultMessage()` - event emission helpers

- **`packages/agent/src/types.ts`** - Tool-related types
  - `AgentTool<TParameters, TDetails>` - tool definition: `name`, `label`, `description`, `parameters`, `execute`, `prepareArguments?`, `executionMode?`
  - `AgentToolCall` - extracted from `AssistantMessage.content` via `Extract<..., { type: "toolCall" }>`
  - `AgentToolResult<T>` - `{ content, details, terminate? }`
  - `AgentToolUpdateCallback<T>` - `(partialResult: AgentToolResult<T>) => void`
  - `ToolExecutionMode` - `"sequential" | "parallel"`
  - `BeforeToolCallContext` - `{ assistantMessage, toolCall, args, context }`
  - `BeforeToolCallResult` - `{ block?, reason? }`
  - `AfterToolCallContext` - `{ assistantMessage, toolCall, args, result, isError, context }`
  - `AfterToolCallResult` - `{ content?, details?, isError?, terminate? }` (field-level merge, no deep merge)
  - `AgentLoopConfig.toolExecution` - global mode, default "parallel"
  - `AgentLoopConfig.beforeToolCall` / `afterToolCall` - lifecycle hooks

## Internal Type Aliases (not exported from agent-loop.ts)

| Type                       | Fields                                                                  | Purpose                                                   |
| -------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `PreparedToolCall`         | `{ kind: "prepared", toolCall, tool, args }`                            | Stage 1 success: ready for execution                      |
| `ImmediateToolCallOutcome` | `{ kind: "immediate", result, isError }`                                | Stage 1 early exit: error or blocked                      |
| `ExecutedToolCallOutcome`  | `{ result, isError }`                                                   | Stage 2 output before afterToolCall                       |
| `FinalizedToolCallOutcome` | `{ toolCall, result, isError }`                                         | Stage 3 output: final result with toolCall reference      |
| `FinalizedToolCallEntry`   | `FinalizedToolCallOutcome \| (() => Promise<FinalizedToolCallOutcome>)` | Parallel batch entry: immediate outcome or deferred thunk |
| `ExecutedToolCallBatch`    | `{ messages: ToolResultMessage[], terminate: boolean }`                 | Return type of both sequential and parallel executors     |

## AI SDK Tool Calling Reference

- **Documentation**: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- **Key concepts**:
  - `tool()` helper: defines `description`, `inputSchema` (Zod), `execute`, optional `strict` mode
  - Multi-step calls via `stopWhen`: model calls tool -> SDK executes -> feeds result back -> model generates again
  - `toolChoice`: `auto` | `required` | `none` | `{ type: "tool", toolName }` -- controls whether model must call tools
  - Tool execution receives `{ toolCallId, messages, abortSignal }` as second parameter
  - `experimental_onToolCallStart` / `experimental_onToolCallFinish` lifecycle callbacks
  - Tool execution errors become `tool-error` content parts for automated retry in multi-step flows
  - `needsApproval`: tool approval flow via `tool-approval-request` / `tool-approval-response` parts

## Key Design Decisions

| Decision                                                                     | Rationale                                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 3-stage pipeline (prepare/execute/finalize)                                  | Each stage has a distinct responsibility and failure mode; hooks inject at clean boundaries                 |
| `prepareArguments()` runs before schema validation                           | Allows tools to fix up LLM-generated arguments (e.g. normalize paths) before validation rejects them        |
| `beforeToolCall` can block execution                                         | Enables permission systems, rate limiting, or user approval without modifying tool code                     |
| `afterToolCall` uses field-level merge (no deep merge)                       | Simple semantics -- each field is either overridden or kept. Avoids surprising nested merge behavior        |
| Batch termination requires ALL tools to set `terminate: true`                | Prevents premature exit when one tool finishes early but others still have work; conservative default       |
| Parallel mode prepares sequentially, executes concurrently                   | Preparation may need context (beforeToolCall hook), but execution is the expensive part worth parallelizing |
| Parallel mode collects immediate results inline, deferred results via thunks | Avoids creating unnecessary promises for already-resolved preparation failures                              |
| Tool result messages emitted in source order (parallel mode)                 | LLM expects tool results in the same order as tool calls in the assistant message                           |
