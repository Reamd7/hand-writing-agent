/**
 * Shared types for lesson 16 extensions.
 */

/** A rule describing a dangerous command pattern. */
export interface DangerousPattern {
  /** Human-readable label for the pattern (e.g., "recursive delete"). */
  label: string;
  /** Regular expression to match against bash commands. */
  pattern: RegExp;
}

/** A rule describing a sensitive output pattern to redact. */
export interface SensitivePattern {
  /** Human-readable label for what gets redacted. */
  label: string;
  /** Regular expression with capture groups to match sensitive content. */
  pattern: RegExp;
  /** Replacement string (may use $1, $2 for capture group references). */
  replacement: string;
}

/** Plan step tracked by the plan extension. */
export interface PlanStep {
  /** 1-based step number. */
  number: number;
  /** Description of the step. */
  text: string;
  /** Whether the step has been completed. */
  completed: boolean;
}

/** Audit log entry produced by the security extension. */
export interface AuditEntry {
  timestamp: number;
  event: "blocked" | "redacted" | "allowed";
  toolName: string;
  detail: string;
}
