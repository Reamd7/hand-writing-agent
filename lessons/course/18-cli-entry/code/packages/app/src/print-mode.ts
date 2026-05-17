/**
 * Print mode: single-shot execution.
 *
 * Send one or more prompts to the agent, stream the result to stdout, then
 * exit. Used for:
 *
 *   myagent -p "list all .ts files"          # text output
 *   myagent --mode json "hello"              # JSON event stream
 *   echo "explain this" | myagent            # piped stdin -> auto print mode
 */

import type { AgentSession, AgentSessionEvent, AssistantMessage } from "./agent-session.js";

export interface PrintModeOptions {
  /** "text" outputs only the final assistant text; "json" streams all events */
  mode: "text" | "json";
  /** Messages to send sequentially */
  messages: string[];
}

/**
 * Run in print (single-shot) mode.
 *
 * @returns Exit code: 0 on success, 1 on error.
 */
export async function runPrintMode(
  session: AgentSession,
  options: PrintModeOptions,
): Promise<number> {
  const { mode, messages } = options;
  let exitCode = 0;

  // In JSON mode, subscribe to all events and write each as a JSON line.
  let unsubscribe: (() => void) | undefined;
  if (mode === "json") {
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      process.stdout.write(JSON.stringify(event) + "\n");
    });
  }

  // Register signal handlers for graceful shutdown.
  const onSignal = () => {
    session.abort();
    session.dispose();
    process.exit(143);
  };
  process.on("SIGTERM", onSignal);

  try {
    // Send each message sequentially. The agent processes tool calls
    // internally and returns when the assistant is done.
    for (const message of messages) {
      await session.prompt(message);
    }

    // In text mode, extract the final assistant response and print it.
    if (mode === "text") {
      const msgs = session.messages;
      const last = msgs[msgs.length - 1];

      if (last && last.role === "assistant") {
        const assistant = last as AssistantMessage;

        if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
          console.error(assistant.errorMessage ?? `Request ${assistant.stopReason}`);
          exitCode = 1;
        } else {
          for (const block of assistant.content) {
            if (block.type === "text") {
              process.stdout.write(block.text + "\n");
            }
          }
        }
      }
    }

    return exitCode;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    return 1;
  } finally {
    unsubscribe?.();
    process.off("SIGTERM", onSignal);
    session.dispose();
  }
}
