/**
 * Lesson 9 Demo: Read tool in action.
 *
 * Demonstrates:
 * 1. Creating a ToolDefinition and wrapping it into an AgentTool
 * 2. Reading a text file with line numbers and truncation
 * 3. Reading a text file with offset/limit
 * 4. Reading an image file (if one exists)
 * 5. Error handling: file not found, offset out of bounds
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { createReadToolDefinition } from "./read-tool.js";
import { wrapToolDefinition } from "./types.js";
import type { AgentToolResult, TextContent, ImageContent } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printSeparator(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}\n`);
}

function printResult(result: AgentToolResult<any>): void {
  for (const block of result.content) {
    if (block.type === "text") {
      console.log(block.text);
    } else if (block.type === "image") {
      console.log(`[Image: ${block.mimeType}, ${block.data.length} bytes base64]`);
    }
  }
  if (result.details) {
    console.log("\n--- Details ---");
    console.log(JSON.stringify(result.details, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cwd = process.cwd();
  const ctx = { cwd, model: { supportsImages: true } };

  // Create the ToolDefinition
  const readToolDef = createReadToolDefinition(cwd);

  // Wrap into AgentTool (demonstrates the adapter)
  const readTool = wrapToolDefinition(readToolDef, () => ctx);

  console.log(`Working directory: ${cwd}`);
  console.log(`Tool name: ${readTool.name}`);
  console.log(`Tool description: ${readTool.description}`);
  console.log(`Prompt snippet: ${readToolDef.promptSnippet}`);
  console.log(`Prompt guidelines: ${readToolDef.promptGuidelines?.join("; ")}`);
  console.log(`Execution mode: ${readToolDef.executionMode}`);

  // ------------------------------------------------------------------
  // Demo 1: Read this file itself (text file with line numbers)
  // ------------------------------------------------------------------
  printSeparator("Demo 1: Read src/demo.ts (first 20 lines)");

  try {
    const result = await readTool.execute("call-1", {
      path: "src/demo.ts",
      limit: 20,
    });
    printResult(result);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  }

  // ------------------------------------------------------------------
  // Demo 2: Read with offset
  // ------------------------------------------------------------------
  printSeparator("Demo 2: Read src/demo.ts lines 10-25");

  try {
    const result = await readTool.execute("call-2", {
      path: "src/demo.ts",
      offset: 10,
      limit: 16,
    });
    printResult(result);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  }

  // ------------------------------------------------------------------
  // Demo 3: Read a large generated file to trigger truncation
  // ------------------------------------------------------------------
  printSeparator("Demo 3: Read large file (truncation)");

  const tmpDir = os.tmpdir();
  const largePath = path.join(cwd, "_demo_large_file.txt");

  try {
    // Generate a file with 100 lines
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`Line ${i}: ${"x".repeat(40)}`);
    }
    await fs.writeFile(largePath, lines.join("\n"), "utf-8");

    // Read with a small line limit to demonstrate truncation
    const tinyReadDef = createReadToolDefinition(cwd);
    // We use the ToolDefinition directly to pass custom truncation context
    const result = await tinyReadDef.execute(
      "call-3",
      { path: "_demo_large_file.txt", limit: 10 },
      undefined,
      undefined,
      ctx,
    );
    printResult(result);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  } finally {
    // Cleanup
    await fs.unlink(largePath).catch(() => {});
  }

  // ------------------------------------------------------------------
  // Demo 4: Read an image file (if test image exists)
  // ------------------------------------------------------------------
  printSeparator("Demo 4: Read image file");

  // Create a minimal 1x1 PNG for demo purposes
  const pngPath = path.join(cwd, "_demo_test.png");
  try {
    // Minimal valid PNG: 1x1 pixel, RGBA, no compression
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await fs.writeFile(pngPath, pngBuffer);

    const result = await readTool.execute("call-4", {
      path: "_demo_test.png",
    });
    printResult(result);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  } finally {
    await fs.unlink(pngPath).catch(() => {});
  }

  // ------------------------------------------------------------------
  // Demo 5: Error cases
  // ------------------------------------------------------------------
  printSeparator("Demo 5: Error - file not found");

  try {
    await readTool.execute("call-5", {
      path: "nonexistent_file.txt",
    });
  } catch (err: any) {
    console.error(`Expected error: ${err.message}`);
  }

  printSeparator("Demo 6: Error - offset out of bounds");

  // Create a small file to test offset error
  const smallPath = path.join(cwd, "_demo_small.txt");
  try {
    await fs.writeFile(smallPath, "line1\nline2\nline3\n", "utf-8");
    await readTool.execute("call-6", {
      path: "_demo_small.txt",
      offset: 100,
    });
  } catch (err: any) {
    console.error(`Expected error: ${err.message}`);
  } finally {
    await fs.unlink(smallPath).catch(() => {});
  }

  // ------------------------------------------------------------------
  // Demo 7: Path security - escape attempt
  // ------------------------------------------------------------------
  printSeparator("Demo 7: Security - path escape attempt");

  try {
    await readTool.execute("call-7", {
      path: "../../../etc/passwd",
    });
  } catch (err: any) {
    console.error(`Expected error: ${err.message}`);
  }

  console.log("\n--- Demo complete ---");
}

main().catch(console.error);
