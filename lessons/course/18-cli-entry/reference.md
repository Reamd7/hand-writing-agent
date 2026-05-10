# Lesson 18: CLI Entry and Run Modes -- Reference

## pi Source Files

| File                                                              | Role                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/coding-agent/src/cli.ts`                                | CLI entry point -- shebang, process title, proxy setup, calls `main()`                |
| `packages/coding-agent/src/main.ts`                               | Orchestrator -- arg parsing, session creation, service wiring, mode dispatch          |
| `packages/coding-agent/src/cli/args.ts`                           | Argument definitions and hand-rolled parser (no commander.js)                         |
| `packages/coding-agent/src/core/agent-session.ts`                 | `AgentSession` facade -- unifies agent lifecycle, tools, compaction, model management |
| `packages/coding-agent/src/modes/print-mode.ts`                   | Print mode (`-p`) -- single-shot prompt, stream to stdout, exit                       |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts`                 | RPC mode (`--mode rpc`) -- JSON-RPC over stdin/stdout for embedding                   |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | Interactive mode -- TUI with ink, the default run mode                                |

## External Dependencies

### commander.js

- Repository: <https://github.com/tj/commander.js>
- The most widely used Node.js CLI framework.
- Provides declarative option/command parsing, auto-generated help, type coercion.
- **Note:** pi itself does NOT use commander.js -- it hand-rolls a for-loop parser in `args.ts`. The course exercise uses commander.js to teach the conventional approach.

### Node.js Process API

| API                   | Usage in pi                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| `process.title`       | Set to `APP_NAME` so the process shows a meaningful name in `ps` / Task Manager |
| `process.argv`        | Raw CLI arguments; `main()` receives `process.argv.slice(2)`                    |
| `process.env`         | Read env vars for API keys, feature flags (`PI_OFFLINE`, `PI_CODING_AGENT`)     |
| `process.stdin`       | Piped input detection (`isTTY`), RPC mode JSON line reader                      |
| `process.stdout`      | Print mode output, RPC mode JSON output                                         |
| `process.exit()`      | Terminate with status code after version/help/error                             |
| `process.emitWarning` | Suppressed in cli.ts to silence Node deprecation noise                          |

### undici (EnvHttpProxyAgent)

- pi uses `setGlobalDispatcher(new EnvHttpProxyAgent(...))` to honor `HTTP_PROXY` / `HTTPS_PROXY` and to disable body/headers timeouts for long-running LLM streams.

## Architecture Overview

```
cli.ts                     -- entry: shebang, process setup, proxy
  |
  v
main.ts                    -- orchestrator
  |
  +-- parseArgs(argv)      -- hand-rolled arg parser
  +-- resolveAppMode()     -- interactive | print | json | rpc
  +-- createSessionManager()
  +-- createAgentSessionRuntime()
  |     +-- createAgentSessionServices()  -- auth, models, settings, resources
  |     +-- buildSessionOptions()         -- model, thinking, tools from CLI
  |     +-- createAgentSessionFromServices()
  |           +-- new AgentSession(config)
  |
  +-- dispatch to mode:
        - interactive -> new InteractiveMode(runtime).run()
        - print/json  -> runPrintMode(runtime, opts)
        - rpc         -> runRpcMode(runtime)
```

## Key Design Decisions

1. **Separation of entry from orchestration** -- `cli.ts` is 22 lines of pure environment setup; all logic lives in `main.ts`, making it testable without spawning a process.

2. **Hand-rolled parser** -- Avoids the ~180KB commander.js dependency. The parser is a single pass over `args[]` with explicit flag matching. Unknown flags are collected into a Map for extensions.

3. **AgentSession as facade** -- All three modes (interactive, print, RPC) share the same `AgentSession` instance. Mode-specific I/O is layered on top via event listeners and method calls.

4. **Runtime factory pattern** -- `createAgentSessionRuntime` accepts a factory function, allowing the runtime to be recreated (e.g., on session switch) without re-parsing args.

5. **API key resolution chain** -- `--api-key` CLI arg > environment variables > `auth.json` config file > OAuth tokens. Resolved through `ModelRegistry` and `AuthStorage`.
