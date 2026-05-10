/**
 * full-example.ts -- A complete minimal agent in one file.
 *
 * Capstone reference for "How to Build an Agent" course.
 * Demonstrates the entire agent flow:
 *   1. Import AI SDK
 *   2. Define tools (read + bash)
 *   3. Build system prompt
 *   4. Run agent loop with tool execution
 *   5. Stream results to stdout
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx full-example.ts "Read package.json and summarize it"
 *
 * Requirements:
 *   npm install ai @ai-sdk/openai zod
 */

import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

const MODEL = "gpt-4o";
const MAX_STEPS = 15; // maximum tool-call rounds before forced stop
const BASH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 10_000; // truncate long tool outputs

const workingDir = process.cwd();

// ---------------------------------------------------------------------------
// 2. System Prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a coding assistant with access to the local filesystem.",
    "You can read files and execute bash commands to help the user.",
    "",
    "## Rules",
    "- Always read a file before modifying it.",
    "- Use bash for tasks like running tests, installing packages, or git operations.",
    "- When bash output is long, summarize the key information.",
    "- If a command fails, explain the error and suggest a fix.",
    "- Be concise. Answer in the same language the user uses.",
    "",
    `## Environment`,
    `- Working directory: ${workingDir}`,
    `- Platform: ${process.platform}`,
    `- Node.js: ${process.version}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 3. Tool Definitions
// ---------------------------------------------------------------------------

/**
 * Truncate output that exceeds the maximum length.
 * Preserves the beginning and end for context.
 */
function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_LENGTH) return text;
  const half = Math.floor(MAX_OUTPUT_LENGTH / 2);
  const omitted = text.length - MAX_OUTPUT_LENGTH;
  return (
    text.slice(0, half) + `\n\n... (${omitted} characters omitted) ...\n\n` + text.slice(-half)
  );
}

/**
 * Read tool -- read a file from the local filesystem.
 *
 * Supports offset and limit for reading specific sections of large files.
 * Returns the file content with line numbers prefixed.
 */
const readFileTool = {
  description:
    "Read a file from the local filesystem. Returns content with line numbers. " +
    "Use offset and limit for large files.",
  parameters: z.object({
    path: z.string().describe("Absolute or relative path to the file"),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Line number to start from (1-indexed). Defaults to 1."),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Maximum number of lines to read. Defaults to 500."),
  }),
  execute: async ({
    path,
    offset,
    limit,
  }: {
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<string> => {
    const resolved = resolve(workingDir, path);

    if (!existsSync(resolved)) {
      return `Error: File not found: ${resolved}`;
    }

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      return `Error: Path is a directory, not a file: ${resolved}`;
    }

    // Basic binary detection: check for null bytes in the first 8KB
    const raw = readFileSync(resolved);
    const head = raw.subarray(0, 8192);
    if (head.includes(0)) {
      return `Error: File appears to be binary (${stat.size} bytes). Cannot display.`;
    }

    const content = raw.toString("utf-8");
    const allLines = content.split("\n");

    const startLine = (offset ?? 1) - 1; // convert to 0-indexed
    const maxLines = limit ?? 500;
    const selectedLines = allLines.slice(startLine, startLine + maxLines);

    const numbered = selectedLines.map((line, i) => `${startLine + i + 1}: ${line}`).join("\n");

    const totalLines = allLines.length;
    const shown = selectedLines.length;

    let result = numbered;
    if (startLine > 0 || startLine + shown < totalLines) {
      result += `\n\n(Showing lines ${startLine + 1}-${startLine + shown} of ${totalLines} total)`;
    }

    return truncateOutput(result);
  },
};

/**
 * Bash tool -- execute a shell command.
 *
 * Runs the command synchronously with a timeout.
 * Returns combined stdout + stderr.
 */
const bashTool = {
  description:
    "Execute a bash command in the working directory. " +
    "Use for running tests, git operations, installing packages, listing files, etc. " +
    "Commands time out after 30 seconds.",
  parameters: z.object({
    command: z.string().describe("The bash command to execute"),
  }),
  execute: async ({ command }: { command: string }): Promise<string> => {
    try {
      const output = execSync(command, {
        cwd: workingDir,
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB buffer
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const result = (output ?? "").trim();
      if (result.length === 0) {
        return "(command completed with no output)";
      }
      return truncateOutput(result);
    } catch (err: unknown) {
      const error = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const parts: string[] = [];
      if (error.status !== undefined) {
        parts.push(`Exit code: ${error.status}`);
      }
      if (error.stdout) {
        parts.push(`stdout:\n${error.stdout.trim()}`);
      }
      if (error.stderr) {
        parts.push(`stderr:\n${error.stderr.trim()}`);
      }
      if (parts.length === 0) {
        parts.push(`Error: ${error.message ?? "Unknown error"}`);
      }
      return truncateOutput(parts.join("\n\n"));
    }
  },
};

// ---------------------------------------------------------------------------
// 4. Agent Loop
// ---------------------------------------------------------------------------

/**
 * Run the agent loop.
 *
 * Uses the AI SDK's `streamText` with `maxSteps` to automatically handle
 * the tool-calling loop:
 *   LLM response -> tool calls -> execute tools -> feed results back -> repeat
 *
 * The loop continues until:
 *   - The LLM produces a final text response with no tool calls
 *   - maxSteps is reached
 *   - An error occurs
 */
async function runAgent(userMessage: string): Promise<void> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`User: ${userMessage}`);
  console.log(`${"=".repeat(60)}\n`);

  const result = streamText({
    model: openai(MODEL),
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: userMessage }],
    tools: {
      read: readFileTool,
      bash: bashTool,
    },
    maxSteps: MAX_STEPS,
    // Called when the LLM decides to use a tool
    onStepFinish: ({ stepType, toolCalls, toolResults, text, usage }) => {
      if (stepType === "tool-result" && toolCalls) {
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          const result = toolResults[i];
          console.log(`\n--- Tool: ${call.toolName} ---`);
          console.log(`Args: ${JSON.stringify(call.args, null, 2)}`);

          // Show a preview of the result (first 200 chars)
          const resultStr = typeof result === "string" ? result : JSON.stringify(result);
          if (resultStr.length > 200) {
            console.log(`Result: ${resultStr.slice(0, 200)}...`);
          } else {
            console.log(`Result: ${resultStr}`);
          }
          console.log(`--- End Tool ---\n`);
        }
      }

      if (usage) {
        console.log(`  [tokens: input=${usage.promptTokens}, output=${usage.completionTokens}]`);
      }
    },
  });

  // Stream the final text response to stdout
  console.log("\nAssistant: ");
  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }
  console.log("\n");

  // Print final usage summary
  const finalUsage = await result.usage;
  console.log(`${"=".repeat(60)}`);
  console.log(
    `Total tokens: input=${finalUsage.promptTokens}, output=${finalUsage.completionTokens}`,
  );
  console.log(`${"=".repeat(60)}\n`);
}

// ---------------------------------------------------------------------------
// 5. Entry Point
// ---------------------------------------------------------------------------

const userInput = process.argv.slice(2).join(" ").trim();

if (!userInput) {
  console.error("Usage: npx tsx full-example.ts <your message>");
  console.error('Example: npx tsx full-example.ts "Read package.json and summarize"');
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error("Error: OPENAI_API_KEY environment variable is not set.");
  console.error("Export it before running: export OPENAI_API_KEY=sk-...");
  process.exit(1);
}

runAgent(userInput).catch((err) => {
  console.error("Agent error:", err);
  process.exit(1);
});
