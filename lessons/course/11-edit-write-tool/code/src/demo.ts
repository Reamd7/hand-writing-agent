/**
 * Demo: create a file with Write, edit it with Edit, verify diff output.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeEdit } from "./edit-tool.js";
import { executeWrite } from "./write-tool.js";

async function main() {
  // Create a temporary working directory
  const cwd = await mkdtemp(join(tmpdir(), "lesson-11-"));
  console.log(`Working directory: ${cwd}\n`);

  try {
    // ── Step 1: Create a file using Write tool ─────────────────────
    console.log("=== Step 1: Write tool - create file ===\n");

    const initialContent = `import { readFile } from "fs/promises";

interface Config {
  host: string;
  port: number;
  debug: boolean;
}

function loadConfig(path: string): Config {
  const raw = readFile(path, "utf-8");
  return JSON.parse(raw);
}

function startServer(config: Config) {
  console.log(\`Starting on \${config.host}:\${config.port}\`);
  if (config.debug) {
    console.log("Debug mode enabled");
  }
}

const config = loadConfig("config.json");
startServer(config);
`;

    const writeResult = await executeWrite({ path: "src/server.ts", content: initialContent }, cwd);
    console.log(writeResult.message);
    console.log(`Bytes written: ${writeResult.bytesWritten}\n`);

    // ── Step 2: Edit the file with multiple edits ──────────────────
    console.log("=== Step 2: Edit tool - multiple edits ===\n");

    const editResult = await executeEdit(
      {
        path: "src/server.ts",
        edits: [
          {
            // Fix: readFile is async, needs await
            oldText: `  const raw = readFile(path, "utf-8");`,
            newText: `  const raw = await readFile(path, "utf-8");`,
          },
          {
            // Change: make loadConfig async
            oldText: `function loadConfig(path: string): Config {`,
            newText: `async function loadConfig(path: string): Promise<Config> {`,
          },
          {
            // Add logging level to Config
            oldText: `  debug: boolean;\n}`,
            newText: `  debug: boolean;\n  logLevel: "info" | "warn" | "error";\n}`,
          },
        ],
      },
      cwd,
    );

    console.log(editResult.message);
    console.log(`First changed line: ${editResult.firstChangedLine}\n`);
    console.log("Diff output:");
    console.log("─".repeat(60));
    console.log(editResult.diff);
    console.log("─".repeat(60));

    // ── Step 3: Verify the file content ────────────────────────────
    console.log("\n=== Step 3: Verify final file content ===\n");

    const finalContent = await readFile(join(cwd, "src/server.ts"), "utf-8");
    console.log(finalContent);

    // ── Step 4: Demonstrate error cases ────────────────────────────
    console.log("=== Step 4: Error cases ===\n");

    // Error: oldText not found
    console.log("--- Not found error ---");
    try {
      await executeEdit(
        {
          path: "src/server.ts",
          edits: [{ oldText: "this text does not exist", newText: "replacement" }],
        },
        cwd,
      );
    } catch (e) {
      console.log(`Error: ${(e as Error).message}\n`);
    }

    // Error: duplicate match (oldText appears more than once)
    console.log("--- Duplicate match error ---");
    try {
      await executeEdit(
        {
          path: "src/server.ts",
          edits: [{ oldText: "config", newText: "cfg" }],
        },
        cwd,
      );
    } catch (e) {
      console.log(`Error: ${(e as Error).message}\n`);
    }

    // Error: empty oldText
    console.log("--- Empty oldText error ---");
    try {
      await executeEdit(
        {
          path: "src/server.ts",
          edits: [{ oldText: "", newText: "something" }],
        },
        cwd,
      );
    } catch (e) {
      console.log(`Error: ${(e as Error).message}\n`);
    }

    // ── Step 5: Demonstrate prepareArguments compatibility ──────────
    console.log("=== Step 5: prepareArguments compatibility ===\n");

    // Simulate legacy single-edit format (top-level oldText/newText)
    const legacyInput = {
      path: "src/server.ts",
      oldText: `console.log("Debug mode enabled");`,
      newText: `console.log("[DEBUG] Debug mode is active");`,
    };

    console.log("Legacy input (top-level oldText/newText):");
    console.log(JSON.stringify(legacyInput, null, 2));

    // executeEdit calls prepareArguments internally
    const legacyResult = await executeEdit(legacyInput as any, cwd);
    console.log(`\n${legacyResult.message}`);
    console.log("Diff:");
    console.log(legacyResult.diff);
  } finally {
    // Clean up
    await rm(cwd, { recursive: true, force: true });
    console.log(`\nCleaned up ${cwd}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
