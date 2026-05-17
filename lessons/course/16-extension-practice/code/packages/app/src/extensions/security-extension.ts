/**
 * Security Audit Extension
 *
 * Demonstrates two interception patterns:
 * 1. api.on("tool_call", ...) -- intercept and block dangerous bash commands
 * 2. api.on("tool_result", ...) -- filter sensitive output (API keys, passwords)
 *
 * Also demonstrates the observe pattern with agent_start / agent_end for
 * audit logging without modifying behavior.
 *
 * NOTE: This is a simplified version adapted from pi's security extension.
 * The original uses pi-specific UI APIs (ctx.ui.notify, ctx.ui.select).
 * Here we use console.log for output and simplified event shapes from @my-agent/core.
 */

import type { ExtensionAPI } from "@my-agent/core";
import type { AuditEntry, DangerousPattern, SensitivePattern } from "./extension-practice-types.js";

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
export const SENSITIVE_PATTERNS: SensitivePattern[] = [
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

/** Get a copy of the audit log (for testing/demo). */
export function getAuditLog(): AuditEntry[] {
  return [...auditLog];
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function securityExtension(api: ExtensionAPI): void {
  // -----------------------------------------------------------------------
  // 1. Intercept tool_call -- block dangerous bash commands
  // -----------------------------------------------------------------------

  api.on("tool_call", async (event) => {
    // Only inspect bash commands
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command as string;

    for (const rule of DANGEROUS_PATTERNS) {
      if (rule.pattern.test(command)) {
        log("blocked", "bash", `${rule.label}: ${command}`);

        console.log(`[security] Blocked dangerous command: ${rule.label}\n  ${command}`);

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

  api.on("tool_result", async (event) => {
    let content = event.content;
    let modified = false;

    for (const rule of SENSITIVE_PATTERNS) {
      // Reset lastIndex for global regexps
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(content)) {
        rule.pattern.lastIndex = 0;
        content = content.replace(rule.pattern, rule.replacement);
        modified = true;
        log("redacted", event.toolName, rule.label);
      }
    }

    if (modified) {
      return { content };
    }

    return undefined;
  });

  // -----------------------------------------------------------------------
  // 3. Observe pattern -- audit logging (read-only, no modification)
  // -----------------------------------------------------------------------

  // Log when agent starts (observe only, return value ignored)
  api.on("agent_start", async () => {
    log("allowed", "agent", "agent session started");
  });

  // Log when agent ends
  api.on("agent_end", async () => {
    log("allowed", "agent", `agent session ended, ${auditLog.length} audit entries`);
  });

  // -----------------------------------------------------------------------
  // 4. /audit command -- view audit log
  // -----------------------------------------------------------------------

  api.registerCommand("audit", {
    description: "View the security audit log",

    handler: async (args: string) => {
      const filter = args.trim();

      if (filter === "clear") {
        auditLog.length = 0;
        console.log("[security] Audit log cleared.");
        return;
      }

      const entries =
        filter === "blocked" || filter === "redacted"
          ? auditLog.filter((e) => e.event === filter)
          : auditLog;

      if (entries.length === 0) {
        console.log("[security] Audit log is empty.");
        return;
      }

      console.log(`[security] Audit Log (${entries.length} entries):`);
      for (const e of entries) {
        const time = new Date(e.timestamp).toLocaleTimeString();
        console.log(`  [${time}] ${e.event.toUpperCase()} ${e.toolName}: ${e.detail}`);
      }
    },
  });
}
