# Lesson 15: Extension API Design -- Reference

## pi source

- `packages/coding-agent/src/core/extensions/types.ts` -- Extension system types
  - `ExtensionAPI` interface: 25+ event subscriptions via `on()`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, action methods (`sendMessage`, `setModel`, `setActiveTools`, etc.)
  - `ExtensionFactory`: `(pi: ExtensionAPI) => void | Promise<void>`
  - `ExtensionEvent` union: `session_start`, `session_shutdown`, `before_agent_start`, `context`, `tool_call`, `tool_result`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `model_select`, `input`, `user_bash`, `resources_discover`, `before_provider_request`, `after_provider_response`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `thinking_level_select`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_before_tree`, `session_compact`, `session_tree`
  - `ToolDefinition`: name, label, description, parameters (TypeBox schema), execute function, optional render hooks
  - `Extension`: loaded extension with handlers map, tools map, commands, flags, shortcuts, messageRenderers
  - `ExtensionRuntime`: shared state + action stubs, created by loader, completed by runner.bindCore()

- `packages/coding-agent/src/core/extensions/runner.ts` -- Extension runner
  - `ExtensionRunner` class: holds loaded extensions + runtime, manages lifecycle
  - `bindCore(actions, contextActions)`: wires up real action implementations, flushes queued provider registrations
  - `bindCommandContext(actions)`: wires up session control methods (newSession, fork, switchSession, etc.)
  - `invalidate()`: marks runner as stale after session replacement or reload
  - Generic `emit(event)` for simple events
  - Specialized emitters: `emitToolCall`, `emitToolResult`, `emitContext`, `emitBeforeAgentStart`, `emitBeforeProviderRequest`, `emitMessageEnd`, `emitResourcesDiscover`, `emitInput`, `emitUserBash`
  - `createContext()` / `createCommandContext()`: lazy property descriptors with stale-instance guards

- `packages/coding-agent/src/core/extensions/loader.ts` -- Extension loader
  - `discoverAndLoadExtensions(configuredPaths, cwd, agentDir)`: main entry
  - Discovery order: project `.agent/extensions/`, global `~/.agent/extensions/`, explicit paths
  - `discoverExtensionsInDir(dir)`: direct `.ts`/`.js` files, subdirs with `index.ts`, subdirs with `package.json` containing `pi.extensions` field
  - `loadExtensionModule(path)`: uses jiti `createJiti` with `virtualModules` (Bun binary) or `alias` (Node.js dev)
  - `createExtensionAPI(extension, runtime, cwd, eventBus)`: builds the `ExtensionAPI` that gets passed to factory
  - `createExtensionRuntime()`: creates runtime with throwing action stubs
  - `loadExtensionFromFactory(factory, ...)`: for inline/programmatic extensions

## jiti

- Repository: https://github.com/unjs/jiti
- Runtime TypeScript and ESM support for Node.js
- Key features used by pi:
  - `createJiti(importMetaUrl, options)` -- create a jiti instance
  - `jiti.import(path, { default: true })` -- async import with default export unwrapping
  - `virtualModules` option -- inject pre-bundled modules (used in compiled Bun binary so extensions resolve to bundled packages instead of filesystem)
  - `alias` option -- redirect module specifiers to specific paths (used in Node.js dev mode)
  - `moduleCache: false` -- disable caching so extensions can be reloaded
  - `tryNative: false` -- force jiti to handle all imports (needed for virtualModules to work)
- Why jiti: extensions are `.ts` files that need transpilation at runtime. jiti handles this transparently without requiring a build step, pre-compilation, or the user to install TypeScript.

## Plugin Architecture Patterns

### Inversion of Control (IoC)

The Extension API follows an IoC pattern: the host defines the lifecycle and calls into extensions at predetermined points, rather than extensions calling host methods directly. The `ExtensionAPI.on()` method is the primary IoC mechanism -- the extension registers intent, and the host decides when to invoke it.

### Event-Driven Plugin Model

pi's extension system is an event-driven plugin architecture:

- **Event bus**: The runner acts as a centralized event dispatcher
- **Typed events**: Each event has a distinct payload and result type (no stringly-typed generic events)
- **Chain of responsibility**: For interceptor events (`tool_call`, `context`, `before_agent_start`), handlers form an ordered chain where each can modify or short-circuit

### Factory Function vs Class-Based Plugins

| Aspect      | Factory (pi's approach)             | Class-based (e.g., VS Code)    |
| ----------- | ----------------------------------- | ------------------------------ |
| State       | Closures                            | Instance properties            |
| Lifecycle   | Single function call                | `activate()` / `deactivate()`  |
| Async init  | Natural (`async factory`)           | Requires `activate(): Promise` |
| Testing     | Call function, inspect side effects | Instantiate, mock dependencies |
| Composition | Multiple factories, independent     | Inheritance hierarchies        |

### Dependency Injection

The `ExtensionAPI` object passed to the factory function is a form of constructor injection:

- The host constructs the API object with the correct bindings
- The extension receives its dependencies (event registration, tool registration, action methods) through the single `api` parameter
- Extensions never import host internals directly -- all capabilities come through the injected API
- This enables testing: pass a mock `ExtensionAPI` to test an extension in isolation

### Two-Phase Initialization Pattern

pi's `createExtensionRuntime()` -> `bindCore()` sequence is a two-phase initialization:

1. **Phase 1 (load time)**: Runtime created with throwing stubs. Extensions can register handlers but cannot perform actions.
2. **Phase 2 (bind time)**: Real implementations replace stubs. Queued registrations flush.

This pattern prevents temporal coupling -- extensions loaded early cannot accidentally depend on host state that only exists after all extensions finish loading.

### Stale Reference Prevention

The `invalidate()` / `assertActive()` pattern guards against a common plugin system bug: holding onto API references across lifecycle boundaries. When a session reloads, all prior API references become poisoned. This is similar to:

- React's stale closure problem (solved by refs/effects)
- Rust's borrow checker (compile-time reference validity)
- Erlang's process model (messages to dead processes are discarded)

## pi Extension Examples Directory

The `packages/coding-agent/examples/extensions/` directory contains 90+ example extensions organized by pattern:

- **Tool registration**: `hello.ts` (minimal), `bash-spawn-hook.ts` (advanced with spawn hooks)
- **Command registration**: `commands.ts` (slash commands with completions and UI)
- **Event interception**: `protected-paths.ts`, `permission-gate.ts`, `confirm-destructive.ts`
- **Context modification**: `prompt-customizer.ts`, `pirate.ts`, `system-prompt-header.ts`
- **Input transformation**: `input-transform.ts` (transform, handle, or pass through)
- **Complex state management**: `plan-mode/index.ts` (multi-event coordination with persistence)
- **Inter-extension communication**: `event-bus.ts` (custom event bus via `pi.events`)

These examples serve as both documentation and integration tests for the extension API surface.

## External Links

- [jiti - Runtime TypeScript/ESM for Node.js](https://github.com/unjs/jiti) -- Used by pi to load `.ts` extension files at runtime without a build step
- [TypeBox - JSON Schema Type Builder](https://github.com/sinclairzx81/typebox) -- Used for defining tool parameter schemas in `registerTool()`
- [Plugin Architecture Patterns - Microsoft](https://learn.microsoft.com/en-us/azure/architecture/patterns/plug-ins) -- Overview of plugin architecture approaches in software systems
- [VS Code Extension API](https://code.visualstudio.com/api) -- A class-based extension system for comparison; uses `activate()`/`deactivate()` lifecycle vs pi's factory function approach
- [Dependency Injection - Martin Fowler](https://martinfowler.com/articles/injection.html) -- The foundational article on DI patterns that inform the ExtensionAPI design
- [Chain of Responsibility Pattern](https://refactoring.guru/design-patterns/chain-of-responsibility) -- The design pattern behind pi's interceptor event chain (`tool_call`, `context`, etc.)
