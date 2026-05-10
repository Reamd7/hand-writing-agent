/**
 * CLI argument parsing with commander.js.
 *
 * This module defines all CLI options, parses them, and returns a typed
 * Args object that the rest of the application consumes.
 *
 * pi itself uses a hand-rolled parser to avoid the dependency; this
 * exercise uses commander.js to teach the conventional approach.
 */

import { Command, Option } from "commander";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunMode = "interactive" | "print" | "json" | "rpc";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface Args {
  /** LLM provider name (e.g. "anthropic", "openai") */
  provider?: string;
  /** Model ID or fuzzy pattern */
  model?: string;
  /** Explicit API key (highest priority in the resolution chain) */
  apiKey?: string;
  /** Override system prompt */
  systemPrompt?: string;
  /** Thinking / reasoning budget */
  thinking?: ThinkingLevel;
  /** Comma-separated tool allowlist */
  tools?: string[];
  /** Disable all tools */
  noTools: boolean;
  /** Non-interactive print mode */
  print: boolean;
  /** Explicit run mode (overrides print flag) */
  mode?: "text" | "json" | "rpc";
  /** Positional messages to send */
  messages: string[];
  /** Resolved run mode after considering all flags + stdin */
  resolvedMode: RunMode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_THINKING: readonly string[] = ["off", "minimal", "low", "medium", "high"];

function resolveRunMode(opts: { mode?: string; print: boolean }, stdinIsTTY: boolean): RunMode {
  if (opts.mode === "rpc") return "rpc";
  if (opts.mode === "json") return "json";
  if (opts.print || !stdinIsTTY) return "print";
  return "interactive";
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments into a typed Args object.
 *
 * @param argv - Raw argument array (without `node` and script path).
 *               Typically `process.argv.slice(2)`.
 */
export function parseArgs(argv: string[]): Args {
  const program = new Command();

  program
    .name("myagent")
    .description("Minimal AI coding agent (Lesson 18 demo)")
    .version("0.1.0")
    .allowUnknownOption(true) // Forward unknown flags to extension system
    .allowExcessArguments(true); // Positional messages

  // Provider & model
  program.option("--provider <name>", "LLM provider name");
  program.option("--model <pattern>", "Model ID or fuzzy pattern");
  program.option("--api-key <key>", "API key (overrides env vars and config)");

  // Prompt
  program.option("--system-prompt <text>", "Override the default system prompt");

  // Thinking
  program.addOption(
    new Option("--thinking <level>", "Thinking / reasoning budget").choices(
      VALID_THINKING as string[],
    ),
  );

  // Tools
  program.option("--tools, -t <names>", "Comma-separated allowlist of tool names", (val: string) =>
    val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  program.option("--no-tools, -nt", "Disable all tools", false);

  // Run mode
  program.option("-p, --print", "Non-interactive mode: send prompt, print result, exit", false);
  program.addOption(new Option("--mode <mode>", "Output mode").choices(["text", "json", "rpc"]));

  // Parse without exiting on error (so we can test programmatically).
  program.exitOverride();
  try {
    program.parse(argv, { from: "user" });
  } catch {
    // Commander throws on --help / --version; let it propagate.
    process.exit(0);
  }

  const opts = program.opts();
  const messages = program.args; // Everything that isn't a flag

  const stdinIsTTY = process.stdin.isTTY ?? true;

  return {
    provider: opts.provider,
    model: opts.model,
    apiKey: opts.apiKey,
    systemPrompt: opts.systemPrompt,
    thinking: opts.thinking as ThinkingLevel | undefined,
    tools: opts.tools,
    noTools: !!opts.noTools,
    print: !!opts.print,
    mode: opts.mode,
    messages,
    resolvedMode: resolveRunMode(opts, stdinIsTTY),
  };
}
