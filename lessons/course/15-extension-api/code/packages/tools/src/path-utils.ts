/**
 * Lesson 9: Path resolution utilities.
 *
 * resolvePath()  -- expand ~, strip @, resolve relative to cwd.
 * isWithinCwd()  -- security check: ensure path does not escape cwd.
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * Expand special path prefixes:
 * - Strip leading "@" (some LLMs prefix paths with @).
 * - Expand "~" and "~/" to the user's home directory.
 */
export function expandPath(filePath: string): string {
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

/**
 * Resolve a file path relative to the given cwd.
 *
 * 1. Expand special prefixes (@ and ~).
 * 2. If the result is absolute, return as-is.
 * 3. Otherwise resolve relative to cwd.
 */
export function resolvePath(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(cwd, expanded);
}

/**
 * Check whether an absolute path is within (or equal to) the given cwd.
 *
 * This is a security boundary: prevents LLM from reading files outside the
 * project directory. Uses path.resolve() to normalize before comparison,
 * which handles ".." traversal.
 */
export function isWithinCwd(absolutePath: string, cwd: string): boolean {
  const resolved = path.resolve(absolutePath);
  const resolvedCwd = path.resolve(cwd);
  return resolved === resolvedCwd || resolved.startsWith(resolvedCwd + path.sep);
}
