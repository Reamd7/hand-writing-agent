# Lesson 17: Building Interactive Chat UI with ink - Reference Materials

## Core Libraries

### ink (React for CLI)

- **Repository**: https://github.com/vadimdemedes/ink
- **What it is**: A React renderer for the terminal. Write CLI apps using React components and flexbox layout.
- **Key exports**: `render()`, `Box`, `Text`, `useInput()`, `useApp()`, `useStdout()`, `Static`, `Newline`
- **Layout model**: Flexbox via Yoga (same as React Native). `Box` supports `flexDirection`, `justifyContent`, `alignItems`, `padding`, `margin`, `width`, `height`, `borderStyle`.
- **Version**: v5 (ESM-only, React 18)

### ink-text-input

- **Repository**: https://github.com/vadimdemedes/ink-text-input
- **What it is**: Text input component for ink. Handles cursor movement, insertion, deletion.
- **Key props**: `value`, `onChange`, `onSubmit`, `placeholder`, `focus`
- **Usage pattern**: Controlled component -- parent owns `value` state, `onChange` updates it, `onSubmit` fires on Enter.

### ink-spinner

- **Repository**: https://github.com/vadimdemedes/ink-spinner
- **What it is**: Animated spinner component for ink.
- **Key props**: `type` (spinner style from `cli-spinners`)
- **Usage**: Wrap in `<Text>` for color: `<Text color="cyan"><Spinner type="dots" /></Text>`

## React Hooks in Terminal Context

### `useInput(handler, options?)`

- Fires on every keypress. Handler receives `(input: string, key: Key)`.
- `key` object has boolean flags: `return`, `escape`, `ctrl`, `shift`, `tab`, `upArrow`, `downArrow`, etc.
- `options.isActive` controls whether the handler is active (useful for modal focus).

### `useApp()`

- Returns `{ exit }`. Call `exit()` to unmount the ink app and return control to the shell.
- Useful for Ctrl+C handling: `useInput((_, key) => { if (key.escape) exit(); })`.

### `useStdout()`

- Returns `{ stdout, write }`. Access raw `process.stdout` stream and a `write()` helper.
- Rarely needed in normal component rendering; useful for logging outside the React tree.

## pi Source Architecture Reference

### File: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

This is pi's TUI implementation. It does NOT use ink -- it uses a custom immediate-mode rendering system (`@earendil-works/pi-tui`). Key architectural patterns to learn from:

#### Event Subscription Pattern

```typescript
// pi subscribes to agent events and dispatches to UI:
private subscribeToAgent(): void {
    this.unsubscribe = this.session.subscribe(async (event) => {
        await this.handleEvent(event);
    });
}
```

#### Event-to-UI Mapping (`handleEvent` switch)

| Event Type                  | UI Action                                           |
| --------------------------- | --------------------------------------------------- |
| `agent_start`               | Clear pending tools, show loading spinner           |
| `message_start` (user)      | Add user message component to chat                  |
| `message_start` (assistant) | Create `AssistantMessageComponent`, begin streaming |
| `message_update`            | Update streaming component, create tool components  |
| `message_end`               | Finalize streaming, handle abort/error states       |
| `tool_execution_start`      | Create/update `ToolExecutionComponent`              |
| `tool_execution_update`     | Update tool result (partial)                        |
| `tool_execution_end`        | Finalize tool result, remove from pending           |
| `agent_end`                 | Stop spinner, clear terminal progress               |
| `compaction_start`          | Show compaction loader                              |
| `compaction_end`            | Remove compaction loader, show summary              |

#### AgentSessionEvent Type (from `agent-session.ts`)

```typescript
export type AgentSessionEvent =
  | AgentEvent // agent_start, message_start/update/end, tool_execution_*, agent_end
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | {
      type: "compaction_end";
      reason: string;
      result: CompactionResult | undefined;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

#### Component Hierarchy (pi's custom TUI)

```
TUI (root)
  +-- headerContainer (logo, keybindings)
  +-- chatContainer (message history)
  |     +-- UserMessageComponent
  |     +-- AssistantMessageComponent (streaming)
  |     +-- ToolExecutionComponent (per tool call)
  +-- pendingMessagesContainer (queued steering/followUp)
  +-- statusContainer (loading spinner)
  +-- widgetContainerAbove
  +-- editorContainer (CustomEditor -- text input)
  +-- widgetContainerBelow
  +-- FooterComponent (model info, context usage, git branch)
```

#### Key Design Decisions in pi

- **Imperative mutation**: pi uses `Container.addChild()` / `.clear()` instead of React's declarative re-render. This is necessary for pi's differential terminal rendering and Kitty image protocol support.
- **Tool tracking**: `pendingTools` is a `Map<string, ToolExecutionComponent>` keyed by `toolCallId`. Components are created on first sight and mutated in-place on updates.
- **Streaming**: A single `AssistantMessageComponent` is reused for the entire assistant turn. `updateContent()` is called on every `message_update` event.

## Translating pi's Pattern to ink/React

The core insight: pi's imperative `handleEvent` switch becomes a React `useEffect` + `subscribe` pattern that updates state, and React's reconciler handles the DOM diffing.

```
pi (imperative)                    ink (declarative)
---------------------------------------------------
session.subscribe(handler)    -->  useEffect(() => { const unsub = subscribe(handler); return unsub; }, [])
container.addChild(component) -->  setState(prev => [...prev, newItem])
component.updateContent(msg)  -->  setState(prev => prev.map(m => m.id === id ? {...m, content} : m))
container.clear()             -->  setState([])
loadingAnimation.start/stop   -->  {isLoading && <Spinner />}
```
