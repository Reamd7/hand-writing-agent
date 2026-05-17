/**
 * Main orchestrator.
 *
 * This is the heart of the CLI startup pipeline:
 *
 *   1. Parse CLI arguments
 *   2. Resolve run mode (interactive / print / json / rpc)
 *   3. Handle quick-exit paths (--version, --help)
 *   4. Build services (simulated: model resolution, API key lookup)
 *   5. Create AgentSession facade
 *   6. Read piped stdin if applicable
 *   7. Dispatch to the appropriate run mode
 *
 * In pi's real codebase this file is ~727 lines. The version here is
 * stripped to the structural skeleton that matters for understanding.
 */

import { parseArgs, type RunMode } from "./args.js";
import { AgentSession, type Model, type AgentTool } from "./agent-session.js";
import { runPrintMode } from "./print-mode.js";

// ---------------------------------------------------------------------------
// Simulated services
// ---------------------------------------------------------------------------

/** Resolve the model from CLI flags (simplified). */
function resolveModel(provider?: string, modelPattern?: string): Model | undefined {
  // In a real implementation this searches ModelRegistry with fuzzy matching.
  // Here we return a hardcoded default.
  if (!provider && !modelPattern) {
    return {
      provider: "anthropic",
      id: "claude-sonnet-4-20250514",
      contextWindow: 200_000,
      reasoning: true,
    };
  }
  return {
    provider: provider ?? "anthropic",
    id: modelPattern ?? "claude-sonnet-4-20250514",
    contextWindow: 200_000,
    reasoning: true,
  };
}

/**
 * Resolve API key from the priority chain:
 *   1. --api-key CLI argument
 *   2. Environment variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
 *   3. Config file (~/.config/pi/agent/auth.json)
 *   4. OAuth tokens
 *
 * Returns undefined if no key is found.
 */
function resolveApiKey(provider: string, cliApiKey?: string): string | undefined {
  // Priority 1: CLI argument
  if (cliApiKey) return cliApiKey;

  // Priority 2: Environment variable
  const envMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    groq: "GROQ_API_KEY",
    xai: "XAI_API_KEY",
  };
  const envVar = envMap[provider];
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }

  // Priority 3 & 4: config file and OAuth (not implemented in demo)
  return undefined;
}

/** Create minimal built-in tool definitions. */
function createBuiltinTools(cwd: string): AgentTool[] {
  return [
    {
      name: "read",
      description: "Read file contents",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async execute(args) {
        return { content: `[would read ${args.path} from ${cwd}]` };
      },
    },
    {
      name: "bash",
      description: "Execute shell commands",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      async execute(args) {
        return { content: `[would execute: ${args.command}]` };
      },
    },
    {
      name: "edit",
      description: "Edit files with find/replace",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
        required: ["path", "old", "new"],
      },
      async execute(args) {
        return { content: `[would edit ${args.path}]` };
      },
    },
    {
      name: "write",
      description: "Write file contents (create or overwrite)",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      async execute(args) {
        return { content: `[would write ${args.path}]` };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Piped stdin reader
// ---------------------------------------------------------------------------

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;

  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim() || undefined);
    });
    process.stdin.resume();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  // Step 1: Parse arguments
  const parsed = parseArgs(argv);
  const appMode: RunMode = parsed.resolvedMode;

  // Step 2: Quick-exit paths (--version and --help are handled by commander)

  // Step 3: Resolve model and API key
  const cwd = process.cwd();
  const model = resolveModel(parsed.provider, parsed.model);

  if (model) {
    const apiKey = resolveApiKey(model.provider, parsed.apiKey);
    if (!apiKey) {
      console.error(
        `No API key found for provider "${model.provider}". ` +
          `Set ${model.provider.toUpperCase()}_API_KEY or use --api-key.`,
      );
      process.exit(1);
    }
  }

  // Step 4: Build tools (apply --tools allowlist or --no-tools)
  let tools = createBuiltinTools(cwd);
  if (parsed.noTools) {
    tools = [];
  } else if (parsed.tools) {
    const allowed = new Set(parsed.tools);
    tools = tools.filter((t) => allowed.has(t.name));
  }

  // Step 5: Create AgentSession facade
  const session = new AgentSession({
    cwd,
    model,
    thinkingLevel: parsed.thinking,
    tools,
    systemPrompt: parsed.systemPrompt,
  });

  // Step 6: Read piped stdin (skip for RPC mode which uses stdin for protocol)
  let stdinContent: string | undefined;
  if (appMode !== "rpc") {
    stdinContent = await readPipedStdin();
  }

  // Combine stdin content with positional messages
  const allMessages: string[] = [];
  if (stdinContent) {
    allMessages.push(stdinContent);
  }
  allMessages.push(...parsed.messages);

  // Step 7: Dispatch to run mode
  switch (appMode) {
    case "rpc": {
      // In a real implementation: runRpcMode(runtime)
      // RPC mode listens on stdin for JSON commands and writes JSON to stdout.
      console.error("RPC mode: listening on stdin for JSON commands...");
      console.error("(not implemented in this demo -- see pi's rpc-mode.ts)");
      // Keep process alive
      await new Promise(() => {});
      break;
    }

    case "interactive": {
      // In a real implementation: new InteractiveMode(runtime, opts).run()
      // Interactive mode renders a TUI with ink (React for CLI).
      console.log("Interactive mode (TUI)");
      console.log(`Model: ${model?.provider}/${model?.id}`);
      console.log(`Tools: ${session.getActiveToolNames().join(", ")}`);
      console.log(`Thinking: ${session.thinkingLevel}`);
      console.log("");

      if (allMessages.length > 0) {
        // Send initial messages
        for (const msg of allMessages) {
          console.log(`> ${msg}`);
          await session.prompt(msg);
          const last = session.messages[session.messages.length - 1];
          if (last?.role === "assistant") {
            const content = (last as { content: Array<{ type: string; text?: string }> }).content;
            for (const block of content) {
              if (block.type === "text" && block.text) {
                console.log(block.text);
              }
            }
          }
          console.log("");
        }
      } else {
        console.log("Type a message to start. (Ctrl+C to exit)");
      }
      // In reality the TUI event loop would keep running here.
      break;
    }

    case "print":
    case "json": {
      if (allMessages.length === 0) {
        console.error("Error: print mode requires at least one message.");
        console.error('Usage: myagent -p "your prompt here"');
        process.exit(1);
      }

      const exitCode = await runPrintMode(session, {
        mode: appMode === "json" ? "json" : "text",
        messages: allMessages,
      });

      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
      break;
    }
  }
}
