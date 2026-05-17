/**
 * Write tool: create or overwrite files with automatic directory creation.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileMutationQueue } from "./file-mutation-queue.js";

// ── Types ────────────────────────────────────────────────────────────

export interface WriteToolInput {
  path: string;
  content: string;
}

export interface WriteResult {
  message: string;
  bytesWritten: number;
}

// ── Path resolution ──────────────────────────────────────────────────

function resolveToCwd(path: string, cwd: string): string {
  if (resolve(path) === path) return path; // already absolute
  return resolve(cwd, path);
}

// ── Path security ────────────────────────────────────────────────────

/**
 * Basic path security: ensure the resolved path is within the cwd.
 * Prevents writing to arbitrary locations via `../../etc/passwd` tricks.
 */
function assertWithinCwd(absolutePath: string, cwd: string): void {
  const normalizedPath = resolve(absolutePath);
  const normalizedCwd = resolve(cwd);
  if (!normalizedPath.startsWith(normalizedCwd)) {
    throw new Error(
      `Path "${absolutePath}" resolves outside the working directory. ` +
        `Write operations are restricted to ${normalizedCwd}.`,
    );
  }
}

// ── Write tool execute ───────────────────────────────────────────────

/**
 * Execute the write tool: create directories, write file, report bytes.
 */
export async function executeWrite(input: WriteToolInput, cwd: string): Promise<WriteResult> {
  const { path, content } = input;
  const absolutePath = resolveToCwd(path, cwd);

  // Security check
  assertWithinCwd(absolutePath, cwd);

  const dir = dirname(absolutePath);

  return withFileMutationQueue(absolutePath, async () => {
    // Create parent directories if they don't exist (mkdir -p)
    await mkdir(dir, { recursive: true });

    // Write the file
    await writeFile(absolutePath, content, "utf-8");

    const bytesWritten = Buffer.byteLength(content, "utf-8");
    return {
      message: `Successfully wrote ${bytesWritten} bytes to ${path}`,
      bytesWritten,
    };
  });
}
