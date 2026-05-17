/**
 * Ls tool -- list directory contents.
 *
 * The simplest of the three auxiliary tools.  No external dependencies,
 * just `readdirSync` + `statSync` with alphabetical sorting and
 * directory-suffix marking.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { truncateHead, type TruncationResult } from "./grep-tool.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LS_LIMIT = 500;
const DEFAULT_MAX_BYTES = 50 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LsInput {
  path?: string;
  limit?: number;
}

export interface LsToolResult {
  content: string;
  entryCount: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Ls tool
// ---------------------------------------------------------------------------

/**
 * Create an ls tool bound to a working directory.
 *
 * Returns entries sorted alphabetically (case-insensitive).
 * Directories get a trailing `/` suffix.  Dotfiles are included.
 */
export function createLsTool(cwd: string) {
  return {
    name: "ls" as const,
    promptSnippet: "List directory contents",
    description:
      `List directory contents. Returns entries sorted alphabetically, with ` +
      `'/' suffix for directories. Includes dotfiles. Output is truncated to ` +
      `${DEFAULT_LS_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB.`,

    async execute(input: LsInput): Promise<LsToolResult> {
      const dirPath = path.resolve(cwd, input.path || ".");
      const limit = input.limit ?? DEFAULT_LS_LIMIT;

      // Validate path
      if (!existsSync(dirPath)) {
        throw new Error(`Path not found: ${dirPath}`);
      }

      const stat = statSync(dirPath);
      if (!stat.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
      }

      // Read and sort entries (case-insensitive alphabetical)
      let entries: string[];
      try {
        entries = readdirSync(dirPath);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(`Cannot read directory: ${message}`);
      }
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      // Format: append "/" to directories
      const results: string[] = [];
      let entryLimitReached = false;

      for (const entry of entries) {
        if (results.length >= limit) {
          entryLimitReached = true;
          break;
        }

        const fullPath = path.join(dirPath, entry);
        try {
          const entryStat = statSync(fullPath);
          results.push(entry + (entryStat.isDirectory() ? "/" : ""));
        } catch {
          // Skip entries we cannot stat
          continue;
        }
      }

      if (results.length === 0) {
        return { content: "(empty directory)", entryCount: 0, truncated: false };
      }

      // Apply byte truncation
      const rawOutput = results.join("\n");
      const truncation = truncateHead(rawOutput, {
        maxLines: Number.MAX_SAFE_INTEGER,
      });

      // Build notices
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
      }
      if (truncation.truncated) {
        notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
      }

      let output = truncation.content;
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      return {
        content: output,
        entryCount: results.length,
        truncated: truncation.truncated || entryLimitReached,
      };
    },
  };
}
