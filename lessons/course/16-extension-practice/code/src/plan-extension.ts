/**
 * Plan Command Extension
 *
 * Demonstrates three extension patterns:
 * 1. pi.registerCommand("plan", ...) -- slash command registration
 * 2. pi.on("before_agent_start", ...) -- inject planning instructions into system prompt
 * 3. pi.on("context", ...) -- inject planning context into message list
 *
 * Usage:
 *   pi -e ./src/plan-extension.ts
 *   /plan create a refactoring plan for the auth module
 *   /plan status
 *   /plan clear
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanStep } from "./types.js";

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
function parsePlanSteps(text: string): PlanStep[] {
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

/** Update the footer status widget. */
function updateStatus(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!planActive || steps.length === 0) {
    ctx.ui.setStatus("plan", undefined);
    return;
  }
  const done = steps.filter((s) => s.completed).length;
  ctx.ui.setStatus("plan", ctx.ui.theme.fg("accent", `plan ${done}/${steps.length}`));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function planExtension(pi: ExtensionAPI): void {
  // -----------------------------------------------------------------------
  // 1. Register /plan command
  // -----------------------------------------------------------------------

  pi.registerCommand("plan", {
    description: "Create, view, or clear an execution plan",

    getArgumentCompletions: (prefix) => {
      const subcommands = ["status", "clear"];
      const filtered = subcommands.filter((s) => s.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },

    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // /plan status -- show current plan
      if (trimmed === "status") {
        if (!planActive || steps.length === 0) {
          ctx.ui.notify("No active plan. Use /plan <goal> to create one.", "info");
          return;
        }
        ctx.ui.notify(`Goal: ${planGoal}\n\n${formatSteps(steps)}`, "info");
        return;
      }

      // /plan clear -- reset plan state
      if (trimmed === "clear") {
        planActive = false;
        planGoal = "";
        steps = [];
        updateStatus(pi, ctx);
        ctx.ui.notify("Plan cleared.", "info");
        return;
      }

      // /plan <goal> -- activate plan mode with a goal
      if (!trimmed) {
        ctx.ui.notify("Usage: /plan <goal> | /plan status | /plan clear", "warning");
        return;
      }

      planActive = true;
      planGoal = trimmed;
      steps = [];
      updateStatus(pi, ctx);

      // Send the goal as a user message to trigger the agent
      pi.sendUserMessage(
        `Create a detailed numbered plan for: ${trimmed}\n\n` +
          "Output ONLY the plan as a numbered list. Do NOT execute any steps yet.",
      );
    },
  });

  // -----------------------------------------------------------------------
  // 2. Inject planning instructions via before_agent_start
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async () => {
    if (!planActive) return;

    // If we have no steps yet, the agent is creating the plan.
    // Inject a system-level instruction to guide plan creation.
    if (steps.length === 0) {
      return {
        message: {
          customType: "plan-instruction",
          content:
            "[PLAN MODE]\n" +
            "You are in planning mode. Create a clear numbered plan.\n" +
            "Rules:\n" +
            "- Output a numbered list (1. 2. 3. ...)\n" +
            "- Each step should be concrete and actionable\n" +
            "- Do NOT execute any steps -- only describe what to do\n" +
            "- Use read-only tools (read, grep, find, ls) for research if needed\n" +
            "- Do NOT use edit or write tools",
          display: false,
        },
      };
    }

    // If we have steps, inject progress context so the agent knows what
    // has been done and what remains.
    const remaining = steps.filter((s) => !s.completed);
    if (remaining.length === 0) return;

    return {
      message: {
        customType: "plan-progress",
        content:
          "[PLAN EXECUTION PROGRESS]\n" +
          `Goal: ${planGoal}\n\n` +
          `Remaining steps:\n${remaining.map((s) => `${s.number}. ${s.text}`).join("\n")}\n\n` +
          "Execute the next step. After completing it, include [DONE:N] where N is the step number.",
        display: false,
      },
    };
  });

  // -----------------------------------------------------------------------
  // 3. Filter stale plan context via the context event
  // -----------------------------------------------------------------------

  pi.on("context", async (event) => {
    // When plan mode is off, strip all plan-related injected messages
    // so they don't pollute the context window.
    if (!planActive) {
      return {
        messages: event.messages.filter((m) => {
          const msg = m as AgentMessage & { customType?: string };
          if (msg.customType === "plan-instruction") return false;
          if (msg.customType === "plan-progress") return false;
          return true;
        }),
      };
    }

    // When plan mode is active, strip old plan-instruction messages
    // (only keep the latest one injected by before_agent_start).
    // This prevents instruction buildup across multiple turns.
    let seenInstruction = false;
    const reversed = [...event.messages].reverse();
    const filtered = reversed.filter((m) => {
      const msg = m as AgentMessage & { customType?: string };
      if (msg.customType === "plan-instruction") {
        if (seenInstruction) return false; // remove duplicates
        seenInstruction = true;
      }
      return true;
    });
    return { messages: filtered.reverse() };
  });

  // -----------------------------------------------------------------------
  // Track [DONE:N] markers in agent responses
  // -----------------------------------------------------------------------

  pi.on("turn_end", async (event, ctx) => {
    if (!planActive || steps.length === 0) return;
    if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) return;

    const text = event.message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Match [DONE:1], [DONE:2], etc.
    const doneRegex = /\[DONE:(\d+)]/g;
    let match: RegExpExecArray | null;
    while ((match = doneRegex.exec(text)) !== null) {
      const stepNum = parseInt(match[1], 10);
      const step = steps.find((s) => s.number === stepNum);
      if (step && !step.completed) {
        step.completed = true;
      }
    }

    updateStatus(pi, ctx);

    // Persist state for session resume
    pi.appendEntry("plan-state", { goal: planGoal, steps });

    // Notify if all steps are done
    if (steps.every((s) => s.completed)) {
      ctx.ui.notify("All plan steps completed!", "info");
      planActive = false;
      updateStatus(pi, ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Restore state on session resume
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();

    // Find the last plan-state entry
    const planEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "plan-state",
      )
      .pop() as { data?: { goal: string; steps: PlanStep[] } } | undefined;

    if (planEntry?.data) {
      planGoal = planEntry.data.goal;
      steps = planEntry.data.steps;
      planActive = steps.some((s) => !s.completed);
    }

    updateStatus(pi, ctx);
  });
}
