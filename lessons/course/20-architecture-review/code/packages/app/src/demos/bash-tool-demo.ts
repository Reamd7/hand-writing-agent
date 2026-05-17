import { executeBash, type BashToolUpdate } from "@my-agent/tools";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function separator(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}\n`);
}

function isWindows(): boolean {
  return process.platform === "win32";
}

// ---------------------------------------------------------------------------
// Demo 1: Basic command execution
// ---------------------------------------------------------------------------

async function demoBasicCommand(): Promise<void> {
  separator("Demo 1: Basic command execution");

  // Use a cross-platform command.
  const command = isWindows() ? "echo Hello from Bash Tool" : "echo 'Hello from Bash Tool'";

  const result = await executeBash(command);
  console.log("Result:", result.content[0]?.text.trim());
}

// ---------------------------------------------------------------------------
// Demo 2: Streaming output with onUpdate
// ---------------------------------------------------------------------------

async function demoStreamingOutput(): Promise<void> {
  separator("Demo 2: Streaming output (onUpdate callback)");

  let updateCount = 0;
  const onUpdate = (update: BashToolUpdate): void => {
    updateCount++;
    const text = update.content[0]?.text ?? "";
    const lines = text.split("\n").filter(Boolean).length;
    console.log(`  [update #${updateCount}] ${lines} lines so far`);
  };

  // Generate output over a short period.
  // Windows: use ping for delay; Unix: use sleep.
  const command = isWindows()
    ? "for /L %i in (1,1,10) do @(echo Line %i & ping -n 1 127.0.0.1 >nul)"
    : 'for i in $(seq 1 10); do echo "Line $i"; sleep 0.05; done';

  const result = await executeBash(command, { onUpdate });

  const finalLines = result.content[0]?.text.trim().split("\n").length ?? 0;
  console.log(`\nFinal output: ${finalLines} lines`);
  console.log(`Total streaming updates received: ${updateCount}`);
}

// ---------------------------------------------------------------------------
// Demo 3: Timeout
// ---------------------------------------------------------------------------

async function demoTimeout(): Promise<void> {
  separator("Demo 3: Timeout (2 second limit)");

  // A command that would run for a long time.
  const command = isWindows() ? "ping -n 30 127.0.0.1" : "sleep 30";

  try {
    await executeBash(command, { timeout: 2 });
    console.log("ERROR: Should have timed out!");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only show the status line, not any partial output.
    const statusLine = message.split("\n").filter(Boolean).pop() ?? message;
    console.log(`Caught expected error: ${statusLine}`);
  }
}

// ---------------------------------------------------------------------------
// Demo 4: AbortSignal (user cancellation)
// ---------------------------------------------------------------------------

async function demoAbort(): Promise<void> {
  separator("Demo 4: AbortSignal (cancel after 1 second)");

  const controller = new AbortController();

  // Cancel after 1 second.
  const cancelTimer = setTimeout(() => {
    console.log("  Sending abort signal...");
    controller.abort();
  }, 1000);

  const command = isWindows() ? "ping -n 30 127.0.0.1" : "sleep 30";

  try {
    await executeBash(command, { signal: controller.signal });
    console.log("ERROR: Should have been aborted!");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusLine = message.split("\n").filter(Boolean).pop() ?? message;
    console.log(`Caught expected error: ${statusLine}`);
  } finally {
    clearTimeout(cancelTimer);
  }
}

// ---------------------------------------------------------------------------
// Demo 5: Non-zero exit code
// ---------------------------------------------------------------------------

async function demoExitCode(): Promise<void> {
  separator("Demo 5: Non-zero exit code");

  // A command that fails.
  const command = isWindows() ? "cmd /c exit 42" : "exit 42";

  try {
    await executeBash(command);
    console.log("ERROR: Should have thrown!");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusLine = message.split("\n").filter(Boolean).pop() ?? message;
    console.log(`Caught expected error: ${statusLine}`);
  }
}

// ---------------------------------------------------------------------------
// Demo 6: Large output + truncation
// ---------------------------------------------------------------------------

async function demoTruncation(): Promise<void> {
  separator("Demo 6: Large output truncation");

  // Generate more than 2000 lines.
  const command = isWindows()
    ? "for /L %i in (1,1,3000) do @echo Line %i: This is a test line with some content to make it a bit longer"
    : 'for i in $(seq 1 3000); do echo "Line $i: This is a test line with some content to make it a bit longer"; done';

  const result = await executeBash(command);

  const text = result.content[0]?.text ?? "";
  const lines = text.split("\n");
  const firstLine = lines[0];
  const lastContentLine = lines.filter((l) => l.startsWith("Line")).pop();

  console.log(`Output lines (truncated): ${lines.length}`);
  console.log(`First visible line: ${firstLine?.slice(0, 60)}...`);
  console.log(`Last visible line:  ${lastContentLine?.slice(0, 60)}...`);

  if (result.details?.truncated) {
    console.log(`Truncated: yes`);
    if (result.details.fullOutputPath) {
      console.log(`Full output saved to: ${result.details.fullOutputPath}`);
    }
  } else {
    console.log(`Truncated: no`);
  }
}

// ---------------------------------------------------------------------------
// Demo 7: Environment variable injection
// ---------------------------------------------------------------------------

async function demoEnvInjection(): Promise<void> {
  separator("Demo 7: Environment variable injection");

  const command = isWindows() ? "echo %MY_AGENT_VAR%" : 'echo "$MY_AGENT_VAR"';

  const result = await executeBash(command, {
    env: { MY_AGENT_VAR: "injected-value-42" },
  });

  console.log("Result:", result.content[0]?.text.trim());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Bash Tool Demo");
  console.log(`Platform: ${process.platform}`);
  console.log(
    `Shell: ${process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh"}`,
  );

  await demoBasicCommand();
  await demoStreamingOutput();
  await demoTimeout();
  await demoAbort();
  await demoExitCode();
  await demoTruncation();
  await demoEnvInjection();

  separator("All demos complete");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
