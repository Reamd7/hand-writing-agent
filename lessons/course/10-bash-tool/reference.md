# Lesson 10: Bash Tool -- Reference Materials

## Pi Source Code References

- **`packages/coding-agent/src/core/tools/bash.ts`** - Bash tool implementation
  - `createBashToolDefinition()` - creates the tool definition with schema, execute, and render functions
  - `createLocalBashOperations()` - default local shell backend using `child_process.spawn`
  - `BashOperations` - pluggable interface for command execution (local shell, SSH, etc.)
  - `BashSpawnHook` - hook to rewrite command/cwd/env before execution
  - `BASH_UPDATE_THROTTLE_MS = 100` - minimum interval between streaming updates
  - `OutputAccumulator` - tracks streaming output with bounded memory
  - `emitOutputUpdate()` / `scheduleOutputUpdate()` - throttled output update emission
  - Timeout: `setTimeout` + `killProcessTree` on expiry
  - Abort: `signal.addEventListener("abort", onAbort)` kills process tree
  - Exit code: non-zero appends `"Command exited with code N"` as error
  - Truncation: `snapshot()` -> `truncateTail()` keeps newest output (tail)

- **`packages/coding-agent/src/core/tools/output-accumulator.ts`** - OutputAccumulator class
  - `append(data: Buffer)` - feed raw chunks, decode via `TextDecoder({ stream: true })`
  - `finish()` - flush decoder, finalize temp file decision
  - `snapshot()` - returns truncated content + truncation metadata + temp file path
  - `closeTempFile()` - finalize and close the write stream
  - Rolling tail buffer: keeps `maxBytes * 2` decoded text, trims on overflow
  - Temp file: created lazily when total output exceeds limits
  - `rawChunks[]` - buffered raw data before temp file is opened; flushed on temp file creation

- **`packages/coding-agent/src/core/tools/truncate.ts`** - Truncation utilities
  - `DEFAULT_MAX_LINES = 2000` - line count limit
  - `DEFAULT_MAX_BYTES = 50 * 1024` - 50KB byte limit
  - `truncateTail()` - keeps last N lines/bytes (for bash output where errors are at end)
  - `truncateHead()` - keeps first N lines/bytes (for file reads)
  - `TruncationResult` - metadata: truncated, truncatedBy, totalLines, outputLines, etc.

- **`packages/coding-agent/src/utils/shell.ts`** - Shell utilities
  - `getShellConfig()` - resolves shell path: user config > Git Bash > PATH bash > sh
  - `getShellEnv()` - extends `process.env` with agent bin directory on PATH
  - `killProcessTree()` - cross-platform: `taskkill /F /T` on Windows, `SIGKILL` on Unix
  - `trackDetachedChildPid()` / `untrackDetachedChildPid()` - track child PIDs for cleanup

- **`packages/coding-agent/src/utils/child-process.ts`** - Process wait helper
  - `waitForChildProcess()` - waits for exit without hanging on inherited stdio handles

## Node.js child_process

- **Documentation**: https://nodejs.org/api/child_process.html
  - `spawn(command, args, options)` - async process creation, returns `ChildProcess`
  - `options.cwd` - working directory
  - `options.env` - environment variables (default: `process.env`)
  - `options.stdio` - stdio configuration: `"pipe"`, `"ignore"`, `"inherit"`
  - `options.detached` - on Unix, makes child the leader of a new process group
  - `options.shell` - run command inside a shell (`true` or shell path)
  - `child.stdout` / `child.stderr` - readable streams when stdio is `"pipe"`
  - `child.pid` - process ID
  - `child.kill(signal)` - send signal to child process
  - Events: `"close"`, `"exit"`, `"error"`, `"spawn"`
  - Windows: `.bat`/`.cmd` files require shell; use `cmd.exe /c` or `shell: true`

## Key Design Patterns

| Pattern              | Description                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Shell wrapper        | `spawn(shell, ["-c", command])` instead of `spawn(command, { shell: true })` for explicit shell control |
| Merged stdout/stderr | Both streams feed the same `onData` callback; agent sees interleaved output                             |
| Throttled streaming  | 100ms minimum interval between `tool_execution_update` events to avoid UI thrashing                     |
| Tail truncation      | Keep newest output (errors/results at bottom), discard oldest                                           |
| Temp file overflow   | When output exceeds limits, write full output to temp file, return path for agent                       |
| Process tree kill    | Kill entire process group, not just the direct child (handles subprocesses)                             |
| Detached processes   | Unix: `detached: true` + negative PID kill for process group cleanup                                    |
| Cross-platform shell | Windows: Git Bash > bash.exe on PATH; Unix: /bin/bash > bash on PATH > sh                               |
