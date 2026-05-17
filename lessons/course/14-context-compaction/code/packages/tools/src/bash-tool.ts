import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  OutputAccumulator,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type OutputSnapshot,
} from "./output-accumulator.js";

// ---------------------------------------------------------------------------
// Shell configuration (cross-platform)
// ---------------------------------------------------------------------------

interface ShellConfig {
  shell: string;
  args: string[];
}

/**
 * Resolve the shell to use for command execution.
 *
 * - Windows: cmd.exe (always available)
 * - Unix: /bin/sh (POSIX baseline)
 */
function getShellConfig(): ShellConfig {
  if (process.platform === "win32") {
    return { shell: process.env.ComSpec || "cmd.exe", args: ["/c"] };
  }
  return { shell: "/bin/sh", args: ["-c"] };
}

// ---------------------------------------------------------------------------
// Process tree kill (cross-platform)
// ---------------------------------------------------------------------------

/**
 * Kill a process and all its descendants.
 *
 * - Windows: `taskkill /F /T /PID` terminates the tree.
 * - Unix: `process.kill(-pid)` sends the signal to the process group
 *   (requires the child to have been spawned with `detached: true`).
 */
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // taskkill may fail if the process already exited.
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already dead.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Wait for child process
// ---------------------------------------------------------------------------

/**
 * Wait for a child process to exit.
 *
 * Resolves with the exit code (or null if killed by a signal).
 * We listen to both stdout/stderr "close" and the process "exit" to avoid
 * hanging when detached descendants hold stdio handles open.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    let exitCode: number | null = null;
    let exitReceived = false;
    let stdoutClosed = !child.stdout;
    let stderrClosed = !child.stderr;

    function tryResolve(): void {
      if (exitReceived && stdoutClosed && stderrClosed) {
        resolve(exitCode);
      }
    }

    child.on("error", reject);

    child.on("exit", (code) => {
      exitCode = code;
      exitReceived = true;
      tryResolve();
    });

    child.stdout?.on("close", () => {
      stdoutClosed = true;
      tryResolve();
    });

    child.stderr?.on("close", () => {
      stderrClosed = true;
      tryResolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Bash tool update types
// ---------------------------------------------------------------------------

export interface BashToolUpdate {
  content: Array<{ type: string; text: string }>;
  details?: {
    truncated?: boolean;
    fullOutputPath?: string;
  };
}

export interface BashToolResult {
  content: Array<{ type: string; text: string }>;
  details?: {
    truncated?: boolean;
    fullOutputPath?: string;
  };
}

// ---------------------------------------------------------------------------
// Bash Tool
// ---------------------------------------------------------------------------

const BASH_UPDATE_THROTTLE_MS = 100;

export interface BashToolOptions {
  /** Working directory for the command. Defaults to process.cwd(). */
  cwd?: string;
  /** Extra environment variables merged into process.env. */
  env?: Record<string, string>;
}

/**
 * Execute a shell command with streaming output, timeout, abort, and
 * output truncation.
 *
 * This is the core of what a Bash tool does inside an agent. It spawns a
 * child process, collects output via OutputAccumulator, and supports:
 *
 * - Streaming updates via onUpdate callback (100ms throttle)
 * - Optional timeout that kills the process tree
 * - AbortSignal that kills the process tree on user cancel
 * - Tail truncation (keep newest 2000 lines / 50KB)
 * - Large output written to temp file
 */
export async function executeBash(
  command: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
    onUpdate?: (update: BashToolUpdate) => void;
  } = {},
): Promise<BashToolResult> {
  const { cwd = process.cwd(), env: extraEnv, timeout, signal, onUpdate } = options;

  // Validate working directory.
  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  const { shell, args } = getShellConfig();
  const childEnv = extraEnv ? { ...process.env, ...extraEnv } : process.env;

  // -----------------------------------------------------------------------
  // OutputAccumulator + throttled updates
  // -----------------------------------------------------------------------

  const output = new OutputAccumulator({ tempFilePrefix: "bash-tool" });
  let updateTimer: NodeJS.Timeout | undefined;
  let updateDirty = false;
  let lastUpdateAt = 0;

  const emitOutputUpdate = (): void => {
    if (!onUpdate || !updateDirty) return;
    updateDirty = false;
    lastUpdateAt = Date.now();

    const snapshot = output.snapshot({ persistIfTruncated: true });
    onUpdate({
      content: [{ type: "text", text: snapshot.content || "" }],
      details: snapshot.truncation.truncated
        ? { truncated: true, fullOutputPath: snapshot.fullOutputPath }
        : undefined,
    });
  };

  const clearUpdateTimer = (): void => {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = undefined;
    }
  };

  const scheduleOutputUpdate = (): void => {
    if (!onUpdate) return;
    updateDirty = true;

    const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
    if (delay <= 0) {
      clearUpdateTimer();
      emitOutputUpdate();
      return;
    }

    // Only schedule one timer at a time.
    updateTimer ??= setTimeout(() => {
      updateTimer = undefined;
      emitOutputUpdate();
    }, delay);
  };

  // Send an initial empty update so the UI knows the tool started.
  if (onUpdate) {
    onUpdate({ content: [] });
  }

  // -----------------------------------------------------------------------
  // Spawn the child process
  // -----------------------------------------------------------------------

  const child = spawn(shell, [...args, command], {
    cwd,
    detached: process.platform !== "win32",
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // -----------------------------------------------------------------------
  // Timeout
  // -----------------------------------------------------------------------

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  if (timeout !== undefined && timeout > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (child.pid) killProcessTree(child.pid);
    }, timeout * 1000);
  }

  // -----------------------------------------------------------------------
  // Stream stdout and stderr into the accumulator
  // -----------------------------------------------------------------------

  const handleData = (data: Buffer): void => {
    output.append(data);
    scheduleOutputUpdate();
  };

  child.stdout?.on("data", handleData);
  child.stderr?.on("data", handleData);

  // -----------------------------------------------------------------------
  // AbortSignal
  // -----------------------------------------------------------------------

  const onAbort = (): void => {
    if (child.pid) killProcessTree(child.pid);
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // -----------------------------------------------------------------------
  // Helper: finalize output
  // -----------------------------------------------------------------------

  const finishOutput = async (): Promise<OutputSnapshot> => {
    output.finish();
    clearUpdateTimer();
    emitOutputUpdate();
    const snapshot = output.snapshot({ persistIfTruncated: true });
    await output.closeTempFile();
    return snapshot;
  };

  const appendStatus = (text: string, status: string): string =>
    text ? `${text}\n\n${status}` : status;

  // -----------------------------------------------------------------------
  // Wait for the process to exit
  // -----------------------------------------------------------------------

  try {
    let exitCode: number | null;

    try {
      exitCode = await waitForChildProcess(child);
    } catch (err) {
      const snapshot = await finishOutput();
      const text = snapshot.content || "";

      if (signal?.aborted) {
        throw new Error(appendStatus(text, "Command aborted"));
      }
      if (timedOut) {
        throw new Error(appendStatus(text, `Command timed out after ${timeout} seconds`));
      }
      throw err;
    }

    // Cleanup timer and signal listener.
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onAbort);

    // Check for abort / timeout that raced with normal exit.
    if (signal?.aborted) {
      const snapshot = await finishOutput();
      throw new Error(appendStatus(snapshot.content || "", "Command aborted"));
    }
    if (timedOut) {
      const snapshot = await finishOutput();
      throw new Error(
        appendStatus(snapshot.content || "", `Command timed out after ${timeout} seconds`),
      );
    }

    // Normal exit path.
    const snapshot = await finishOutput();
    const outputText = snapshot.content || "(no output)";

    // Build truncation suffix for the agent.
    let text = outputText;
    let truncated = false;
    let fullOutputPath: string | undefined;

    if (snapshot.truncation.truncated) {
      truncated = true;
      fullOutputPath = snapshot.fullOutputPath;
      const startLine = snapshot.truncation.totalLines - snapshot.truncation.outputLines + 1;
      const endLine = snapshot.truncation.totalLines;

      if (snapshot.truncation.truncatedBy === "lines") {
        text += `\n\n[Showing lines ${startLine}-${endLine} of ${snapshot.truncation.totalLines}. Full output: ${fullOutputPath}]`;
      } else {
        text += `\n\n[Showing lines ${startLine}-${endLine} of ${snapshot.truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
      }
    }

    // Non-zero exit code is an error.
    if (exitCode !== 0 && exitCode !== null) {
      throw new Error(appendStatus(text, `Command exited with code ${exitCode}`));
    }

    return {
      content: [{ type: "text", text }],
      details: truncated ? { truncated, fullOutputPath } : undefined,
    };
  } finally {
    clearUpdateTimer();
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
