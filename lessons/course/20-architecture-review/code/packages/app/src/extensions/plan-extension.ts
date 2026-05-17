/**
 * Plan Command Extension
 *
 * Demonstrates three extension patterns:
 * 1. api.registerCommand("plan", ...) -- slash command registration
 * 2. api.on("before_agent_start", ...) -- inject planning instructions into system prompt
 * 3. api.on("context", ...) -- inject planning context into message list
 *
 * NOTE: This is a simplified version adapted from pi's plan extension.
 * The original uses pi-specific UI and session APIs (ctx.ui, ctx.sessionManager).
 * Here we use console.log for output and simplified event shapes from @my-agent/core.
 */

import type { ExtensionAPI } from "@my-agent/core";
import type { PlanStep } from "./extension-practice-types.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let planActive = false;
let planGoal = "";
let steps: PlanStep[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse numbered plan steps from assistant text. */
export function parsePlanSteps(text: string): PlanStep[] {
  const result: PlanStep[] = [];
  // Match lines like "1. Do something" or "1) Do something"
  const regex = /^\s*(\d+)[.)]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    result.push({
      number: parseInt(match[1], 10),
      text: match[2].trim(),
      completed: false,
    });
  }
  return result;
}

/** Format plan steps for display. */
function formatSteps(items: PlanStep[]): string {
  return items
    .map((s) => {
      const marker = s.completed ? "[x]" : "[ ]";
      return `${marker} ${s.number}. ${s.text}`;
    })
    .join("\n");
}

/** Log the plan status to console. */
function logStatus(): void {
  if (!planActive || steps.length === 0) return;
  const done = steps.filter((s) => s.completed).length;
  console.log(`[plan] status: ${done}/${steps.length} steps completed`);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function planExtension(api: ExtensionAPI): void {
  // -----------------------------------------------------------------------
  // 1. Register /plan command
  // -----------------------------------------------------------------------

  api.registerCommand("plan", {
    description: "Create, view, or clear an execution plan",

    handler: async (args: string) => {
      const trimmed = args.trim();

      // /plan status -- show current plan
      if (trimmed === "status") {
        if (!planActive || steps.length === 0) {
          console.log("[plan] No active plan. Use /plan <goal> to create one.");
          return;
        }
        console.log(`[plan] Goal: ${planGoal}\n\n${formatSteps(steps)}`);
        return;
      }

      // /plan clear -- reset plan state
      if (trimmed === "clear") {
        planActive = false;
        planGoal = "";
        steps = [];
        console.log("[plan] Plan cleared.");
        return;
      }

      // /plan <goal> -- activate plan mode with a goal
      if (!trimmed) {
        console.log("[plan] Usage: /plan <goal> | /plan status | /plan clear");
        return;
      }

      planActive = true;
      planGoal = trimmed;
      steps = [];
      logStatus();

      // Send the goal as a user message to trigger the agent
      api.sendMessage(
        `Create a detailed numbered plan for: ${trimmed}\n\n` +
          "Output ONLY the plan as a numbered list. Do NOT execute any steps yet.",
      );
    },
  });

  // -----------------------------------------------------------------------
  // 2. Inject planning instructions via before_agent_start
  // -----------------------------------------------------------------------

  api.on("before_agent_start", async (event) => {
    if (!planActive) return;

    // If we have no steps yet, the agent is creating the plan.
    if (steps.length === 0) {
      const planInstruction =
        "\n\n[PLAN MODE]\n" +
        "You are in planning mode. Create a clear numbered plan.\n" +
        "Rules:\n" +
        "- Output a numbered list (1. 2. 3. ...)\n" +
        "- Each step should be concrete and actionable\n" +
        "- Do NOT execute any steps -- only describe what to do\n" +
        "- Use read-only tools (read, grep, find, ls) for research if needed\n" +
        "- Do NOT use edit or write tools";
      return { systemPrompt: event.systemPrompt + planInstruction };
    }

    // If we have steps, inject progress context
    const remaining = steps.filter((s) => !s.completed);
    if (remaining.length === 0) return;

    const progressContext =
      "\n\n[PLAN EXECUTION PROGRESS]\n" +
      `Goal: ${planGoal}\n\n` +
      `Remaining steps:\n${remaining.map((s) => `${s.number}. ${s.text}`).join("\n")}\n\n` +
      "Execute the next step. After completing it, include [DONE:N] where N is the step number.";
    return { systemPrompt: event.systemPrompt + progressContext };
  });

  // -----------------------------------------------------------------------
  // 3. Filter stale plan context via the context event
  // -----------------------------------------------------------------------

  api.on("context", async (event) => {
    // For this simplified version, just pass through messages unchanged.
    // In the full pi version, this would strip stale plan-instruction messages.
    return { messages: event.messages };
  });

  // -----------------------------------------------------------------------
  // Track [DONE:N] markers in agent responses (via turn_end)
  // -----------------------------------------------------------------------

  api.on("turn_end", async () => {
    // In the full pi version, this would parse [DONE:N] markers from
    // the assistant's response and mark steps as completed.
    // Here we just log status.
    logStatus();
  });

  // -----------------------------------------------------------------------
  // Restore state on session resume
  // -----------------------------------------------------------------------

  api.on("session_start", async () => {
    // In the full pi version, this would read plan-state entries from
    // ctx.sessionManager.getEntries() to restore state.
    console.log("[plan] session started, plan state:", planActive ? "active" : "inactive");
  });
}
