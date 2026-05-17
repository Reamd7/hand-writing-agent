/**
 * Lesson 19: Security utilities for production Agent hardening.
 *
 * Covers:
 * - Path traversal prevention (OWASP)
 * - Sensitive file detection
 * - Bash command safety checks
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

// ============================================================================
// Path Traversal Prevention
// ============================================================================

/**
 * Check whether a user-supplied path is safe (contained within allowedBase).
 *
 * Prevention strategy (OWASP Path Traversal):
 * 1. Resolve to absolute path (handles .., ., relative segments)
 * 2. Resolve symlinks via realpathSync (prevents symlink escape)
 * 3. Verify the resolved path starts with the allowed base directory
 *
 * @param userPath - The path provided by the user or LLM
 * @param allowedBase - The directory that all paths must be within
 * @returns true if the path is safely within allowedBase
 *
 * @example
 * ```ts
 * isPathSafe("src/index.ts", "/home/user/project");     // true
 * isPathSafe("../../etc/passwd", "/home/user/project");  // false
 * ```
 */
export function isPathSafe(userPath: string, allowedBase: string): boolean {
  // Reject null bytes (classic bypass technique)
  if (userPath.includes("\0")) {
    return false;
  }

  // Decode any percent-encoded sequences to catch %2F bypass
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(userPath);
  } catch {
    // If decoding fails, use the raw path
    decodedPath = userPath;
  }

  // Reject if decoded path still contains null bytes
  if (decodedPath.includes("\0")) {
    return false;
  }

  // Resolve to absolute path (normalizes .., ., and separators)
  const resolved = resolve(allowedBase, decodedPath);

  // Resolve symlinks for the real filesystem path
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    // File doesn't exist yet -- resolve the parent to check containment
    const parent = dirname(resolved);
    try {
      const realParent = realpathSync(parent);
      realPath = join(realParent, basename(resolved));
    } catch {
      // Parent doesn't exist either -- fall back to the resolved path
      // This is still safe because resolve() already normalized traversals
      realPath = resolved;
    }
  }

  // Normalize the base directory too
  let normalizedBase: string;
  try {
    normalizedBase = realpathSync(resolve(allowedBase));
  } catch {
    normalizedBase = resolve(allowedBase);
  }

  // On Windows, comparison must be case-insensitive
  if (process.platform === "win32") {
    return (
      realPath.toLowerCase() === normalizedBase.toLowerCase() ||
      realPath.toLowerCase().startsWith(normalizedBase.toLowerCase() + sep)
    );
  }

  return realPath === normalizedBase || realPath.startsWith(normalizedBase + sep);
}

// ============================================================================
// Sensitive File Detection
// ============================================================================

/** Known sensitive filenames (exact match on basename). */
const SENSITIVE_FILENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.staging",
  ".env.test",
  "credentials.json",
  "service-account.json",
  "service-account-key.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  ".htpasswd",
  "shadow",
  "master.key",
  "production.key",
]);

/** Patterns that indicate a sensitive file (tested against basename). */
const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/, // .env and all variants
  /credentials.*\.json$/i, // any credentials JSON
  /^service[-_]?account.*\.json$/i, // GCP service accounts
  /secret/i, // anything with "secret" in the name
  /\.pem$/i, // certificates / private keys
  /\.key$/i, // private keys
  /\.p12$/i, // PKCS#12 keystores
  /\.pfx$/i, // PKCS#12 keystores (Windows)
  /\.jks$/i, // Java keystores
  /^\.aws\/credentials$/, // AWS credentials file
  /^\.docker\/config\.json$/, // Docker auth config
  /^\.ssh\//, // Anything under .ssh/
  /^\.gnupg\//, // GPG keys
  /^known_hosts$/, // SSH known hosts
  /^authorized_keys$/, // SSH authorized keys
];

/**
 * Check whether a file path points to a known sensitive file.
 *
 * Checks both exact filename matches and pattern-based detection.
 * Use this before any file read/write operation in the Agent.
 *
 * @param filePath - Absolute or relative file path
 * @returns true if the file is considered sensitive
 *
 * @example
 * ```ts
 * isSensitiveFile(".env");                    // true
 * isSensitiveFile("config/credentials.json"); // true
 * isSensitiveFile("src/index.ts");            // false
 * ```
 */
export function isSensitiveFile(filePath: string): boolean {
  const name = basename(filePath);

  // Exact match
  if (SENSITIVE_FILENAMES.has(name)) {
    return true;
  }

  // Pattern match (test against both basename and the normalized path)
  const normalizedPath = filePath.replace(/\\/g, "/");
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(name) || pattern.test(normalizedPath));
}

// ============================================================================
// Bash Command Safety
// ============================================================================

interface CommandSafetyResult {
  safe: boolean;
  reason?: string;
}

/** Dangerous command patterns with human-readable descriptions. */
const DANGEROUS_COMMANDS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)[\/~]/,
    description: "Forced removal of root or home directory",
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+[\/~]/,
    description: "Recursive forced removal of root or home directory",
  },
  {
    pattern: /\b(curl|wget)\s+.*\|\s*(ba)?sh\b/,
    description: "Piping remote content to shell (remote code execution)",
  },
  {
    pattern: /\bchmod\s+777\b/,
    description: "Setting overly permissive file permissions",
  },
  {
    pattern: /\b(mkfs|fdisk)\b/,
    description: "Filesystem/disk partitioning commands",
  },
  {
    pattern: /\bdd\b.*\bof=\/dev\//,
    description: "Writing directly to block device",
  },
  {
    pattern: />\s*\/dev\/sd[a-z]/,
    description: "Redirecting output to disk device",
  },
  {
    pattern: /:()\s*\{\s*:\|:&\s*\}\s*;?\s*:/,
    description: "Fork bomb",
  },
  {
    pattern: /\bshutdown\b|\breboot\b|\binit\s+[06]\b/,
    description: "System shutdown or reboot",
  },
  {
    pattern: /\bsudo\b/,
    description: "Privilege escalation via sudo",
  },
  {
    pattern: />\s*\/etc\/(passwd|shadow|sudoers)\b/,
    description: "Overwriting critical system files",
  },
  {
    pattern: /\beval\s.*\$\(/,
    description: "eval with command substitution (injection risk)",
  },
];

/**
 * Check whether a bash command is safe to execute.
 *
 * This is a heuristic check -- it catches common dangerous patterns
 * but is not a complete sandbox. For full isolation, use a container
 * or VM-based execution environment.
 *
 * @param command - The bash command string to check
 * @returns Object with `safe` boolean and optional `reason` string
 *
 * @example
 * ```ts
 * isSafeBashCommand("ls -la");           // { safe: true }
 * isSafeBashCommand("rm -rf /");         // { safe: false, reason: "..." }
 * isSafeBashCommand("curl x | bash");    // { safe: false, reason: "..." }
 * ```
 */
export function isSafeBashCommand(command: string): CommandSafetyResult {
  for (const { pattern, description } of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      return {
        safe: false,
        reason: `Blocked: ${description} (matched: ${pattern.source})`,
      };
    }
  }

  return { safe: true };
}
