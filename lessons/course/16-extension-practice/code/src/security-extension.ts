/**
 * Security Audit Extension
 *
 * Demonstrates two interception patterns:
 * 1. pi.on("tool_call", ...) -- intercept and block dangerous bash commands
 * 2. pi.on("tool_result", ...) -- filter sensitive output (API keys, passwords)
 *
 * Also demonstrates the observe pattern with agent_start / agent_end for
 * audit logging without modifying behavior.
 *
 * Usage:
 *   pi -e ./src/security-extension.ts
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AuditEntry, DangerousPattern, SensitivePattern } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Bash commands that should be blocked outright. */
const DANGEROUS_PATTERNS: DangerousPattern[] = [
  { label: "recursive delete", pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\b/ },
  { label: "force delete root", pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*)\s+\/\s*$/ },
  { label: "disk format", pattern: /\bmkfs\b/ },
  { label: "disk overwrite", pattern: /\bdd\b.*\bof=\/dev\// },
  { label: "permission escalation", pattern: /\bchmod\s+(-[a-zA-Z]*\s+)?777\s/ },
  { label: "recursive chown to root", pattern: /\bsudo\s+chown\s+-R\s+root\b/ },
  { label: "history clear", pattern: /\bhistory\s+-c\b/ },
  { label: "fork bomb", pattern: /:\(\)\s*\{\s*:\|:&\s*\}/ },
];

/** Patterns in tool output that indicate sensitive data -- these get redacted. */
const SENSITIVE_PATTERNS: SensitivePattern[] = [
  {
    label: "AWS access key",
    pattern: /(AKIA[0-9A-Z]{16})/g,
    replacement: "AKIA****************",
  },
  {
    label: "generic API key assignment",
    // Matches: API_KEY=sk-abc123..., api_key: "sk-abc123..."
    pattern: /(api[_-]?key\s*[:=]\s*["']?)([a-zA-Z0-9_-]{20,})/gi,
    replacement: "$1[REDACTED]",
  },
  {
    label: "bearer token",
    pattern: /(Bearer\s+)([a-zA-Z0-9._-]{20,})/g,
    replacement: "$1[REDACTED]",
  },
  {
    label: "private key block",
    pattern:
      /(-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----)([\s\S]*?)(-----END\s+(RSA\s+)?PRIVATE\s+KEY-----)/g,
    replacement: "$1\n[REDACTED]\n$4",
  },
  {
    label: "password in URL",
    // Matches: https://user:password@host
    pattern: /(:\/\/[^:]+:)([^@]+)(@)/g,
    replacement: "$1[REDACTED]$3",
  },
  {
    label: "generic password assignment",
    pattern: /(password\s*[:=]\s*["']?)([^\s"']{8,})/gi,
    replacement: "$1[REDACTED]",
  },
];

// ---------------------------------------------------------------------------
// Audit log (in-memory, for demonstration)
// ---------------------------------------------------------------------------

const auditLog: AuditEntry[] = [];

function log(event: AuditEntry["event"], toolName: string, detail: string): void {
  auditLog.push({ timestamp: Date.now(), event, toolName, detail });
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function securityExtension(pi: ExtensionAPI): void {
  // -----------------------------------------------------------------------
  // 1. Intercept tool_call -- block dangerous bash commands
  // -----------------------------------------------------------------------

  pi.on("tool_call", async (event, ctx) => {
    // Only inspect bash commands
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    for (const rule of DANGEROUS_PATTERNS) {
      if (rule.pattern.test(command)) {
        log("blocked", "bash", `${rule.label}: ${command}`);

        if (ctx.hasUI) {
          ctx.ui.notify(`Blocked dangerous command: ${rule.label}\n${command}`, "warning");
        }

        return {
          block: true,
          reason:
            `Security: command blocked (${rule.label}). ` +
            "If this is intentional, disable the security extension.",
        };
      }
    }

    // Command passed all checks -- log as allowed
    log("allowed", "bash", command);
    return undefined;
  });

  // -----------------------------------------------------------------------
  // 2. Intercept tool_result -- redact sensitive output
  // -----------------------------------------------------------------------

  pi.on("tool_result", async (event) => {
    let modified = false;

    const newContent = event.content.map((block) => {
      if (block.type !== "text") return block;

      let text = (block as TextContent).text;

      for (const rule of SENSITIVE_PATTERNS) {
        // Reset lastIndex for global regexps
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(text)) {
          rule.pattern.lastIndex = 0;
          text = text.replace(rule.pattern, rule.replacement);
          modified = true;
          log("redacted", event.toolName, rule.label);
        }
      }

      return { type: "text" as const, text };
    });

    if (modified) {
      return { content: newContent };
    }

    return undefined;
  });

  // -----------------------------------------------------------------------
  // 3. Observe pattern -- audit logging (read-only, no modification)
  // -----------------------------------------------------------------------

  // Log when agent starts (observe only, return value ignored)
  pi.on("agent_start", async () => {
    log("allowed", "agent", "agent session started");
  });

  // Log when agent ends
  pi.on("agent_end", async () => {
    log("allowed", "agent", `agent session ended, ${auditLog.length} audit entries`);
  });

  // -----------------------------------------------------------------------
  // 4. /audit command -- view audit log
  // -----------------------------------------------------------------------

  pi.registerCommand("audit", {
    description: "View the security audit log",

    getArgumentCompletions: (prefix) => {
      const subcommands = ["all", "blocked", "redacted", "clear"];
      const filtered = subcommands.filter((s) => s.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
    },

    handler: async (args, ctx) => {
      const filter = args.trim();

      if (filter === "clear") {
        auditLog.length = 0;
        ctx.ui.notify("Audit log cleared.", "info");
        return;
      }

      const entries =
        filter === "blocked" || filter === "redacted"
          ? auditLog.filter((e) => e.event === filter)
          : auditLog;

      if (entries.length === 0) {
        ctx.ui.notify("Audit log is empty.", "info");
        return;
      }

      const lines = entries.map((e) => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        return `[${time}] ${e.event.toUpperCase()} ${e.toolName}: ${e.detail}`;
      });

      const selected = await ctx.ui.select(`Security Audit Log (${entries.length} entries)`, lines);

      if (selected) {
        ctx.ui.notify(selected, "info");
      }
    },
  });
}
