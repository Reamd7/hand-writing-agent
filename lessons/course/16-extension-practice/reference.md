# Lesson 16: Extension Practice -- Reference

## pi source

- `packages/coding-agent/examples/extensions/` -- Official extension examples (90+)
  - `commands.ts` -- `pi.registerCommand()` with argument completions and UI
  - `plan-mode/index.ts` -- Full plan mode: `/plan` command, `tool_call` interception, `before_agent_start` context injection, `context` event filtering, `session_start` state restoration, `setActiveTools`, `appendEntry` for state persistence
  - `protected-paths.ts` -- `tool_call` interception: block writes to `.env`, `.git/`, `node_modules/`
  - `permission-gate.ts` -- `tool_call` interception: confirm dangerous bash commands (`rm -rf`, `sudo`, `chmod 777`)
  - `confirm-destructive.ts` -- `session_before_switch` / `session_before_fork` cancellation
  - `dirty-repo-guard.ts` -- `pi.exec()` for shell commands, `session_before_switch` guard
  - `input-transform.ts` -- `input` event: transform, handle, or continue user input
  - `system-prompt-header.ts` -- `agent_start` event: `ctx.getSystemPrompt()`
  - `prompt-customizer.ts` -- `before_agent_start`: modify system prompt with `systemPromptOptions`
  - `event-bus.ts` -- `pi.events.on()` / `pi.events.emit()` for inter-extension communication
  - `hello.ts` -- Minimal `pi.registerTool()` example with TypeBox schema
  - `pirate.ts` -- `systemPromptAppend` for dynamic system prompt modification
  - `bash-spawn-hook.ts` -- `createBashTool()` with `spawnHook` for command/env injection

## Extension patterns

### Command extensions

- `pi.registerCommand(name, { description, handler, getArgumentCompletions? })` -- slash command registration
- Handler signature: `async (args: string, ctx: ExtensionCommandContext) => void`
- `ctx.ui.notify(message, level)` -- toast notifications
- `ctx.ui.select(title, items)` -- selection dialog
- `ctx.ui.confirm(title, body)` -- confirmation dialog
- `ctx.ui.editor(label, initial)` -- text editor dialog
- `pi.registerShortcut(Key.ctrlAlt("x"), { description, handler })` -- keyboard shortcut
- `pi.registerFlag(name, { description, type, default })` -- CLI flag registration

### Security extensions

- `pi.on("tool_call", handler)` -- intercept before tool execution
  - Return `{ block: true, reason: "..." }` to prevent execution
  - Return `undefined` to allow execution
  - Mutate `event.input` in place to modify arguments
  - `event.toolName`: "bash" | "read" | "edit" | "write" | "grep" | "find" | "ls" | string
  - `event.input`: typed per tool (e.g., `{ command: string }` for bash)
- `pi.on("tool_result", handler)` -- intercept after tool execution
  - Return `{ content?, details?, isError? }` to modify result
  - `event.content`: `(TextContent | ImageContent)[]`
  - `event.isError`: boolean
  - Type guards: `isBashToolResult()`, `isReadToolResult()`, etc.

### Context injection

- `pi.on("before_agent_start", handler)` -- inject messages or modify system prompt before each agent turn
  - Return `{ message: { customType, content, display } }` to inject context
  - Return `{ systemPrompt: string }` to replace system prompt
  - `display: false` hides message from UI but sends to LLM
- `pi.on("context", handler)` -- filter/transform the message list sent to LLM
  - Return `{ messages: AgentMessage[] }` to replace message list
  - Used for stripping stale context, adding synthetic messages

### Observe vs intercept

- **Observe (read-only)**: `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end` -- return value ignored
- **Intercept (modify/cancel)**: `tool_call`, `tool_result`, `before_agent_start`, `context`, `input`, `session_before_switch`, `session_before_fork`, `session_before_compact` -- return value changes behavior

## External Links

- [jiti](https://github.com/unjs/jiti) -- Runtime TypeScript and ESM support for Node.js; used by pi to load `.ts` extension files without a build step
- [pi Extension Examples](https://github.com/ArcadeAI/pi-mono/tree/main/packages/coding-agent/examples/extensions) -- Official pi extension examples directory with 90+ reference implementations
- [TypeBox](https://github.com/sinclairzx81/typebox) -- JSON Schema Type Builder used for defining tool parameter schemas in `registerTool()`
- [unjs ecosystem](https://github.com/unjs) -- The broader unjs project that jiti belongs to, providing runtime-agnostic JavaScript utilities
