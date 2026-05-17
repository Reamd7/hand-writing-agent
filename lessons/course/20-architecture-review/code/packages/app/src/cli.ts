#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * This file does three things and nothing more:
 *   1. Process-level environment setup (title, warnings)
 *   2. Global HTTP proxy / timeout configuration (omitted in this demo)
 *   3. Hand off to main()
 *
 * Keeping this file tiny makes the orchestrator (main.ts) testable
 * without spawning a child process.
 */

import { main } from "./main.js";

// Set a human-readable process title (visible in `ps` / Task Manager).
process.title = "myagent";

// Mark ourselves so nested bash tool calls can detect recursion.
process.env.MY_AGENT = "true";

// Silence Node.js deprecation warnings that pollute LLM output.
process.emitWarning = (() => {}) as typeof process.emitWarning;

// In a real agent you would configure undici's EnvHttpProxyAgent here
// to honor HTTP_PROXY and disable body/headers timeouts for long SSE streams:
//
//   import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
//   setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

// Slice off `node` and the script path -- pass only user-supplied args.
main(process.argv.slice(2));
