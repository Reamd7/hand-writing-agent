/**
 * Find tool -- search for files by glob pattern.
 *
 * Pi's production version delegates to `fd` for speed.  This teaching
 * implementation uses the `glob` npm package for portability.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { truncateHead, type TruncationResult } from "./grep-tool.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_MAX_BYTES = 50 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FindInput {
  pattern: string;
  path?: string;
  limit?: number;
}

export interface FindToolResult {
  content: string;
  resultCount: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Find tool
// ---------------------------------------------------------------------------

/**
 * Create a find tool bound to a working directory.
 *
 * Uses the `glob` npm package to match files.  Respects common ignore
 * patterns (node_modules, .git).  Results are returned as newline-separated
 * relative POSIX paths.
 */
export function createFindTool(cwd: string) {
  return {
    name: "find" as const,
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
    description:
      `Search for files by glob pattern. Returns matching file paths relative ` +
      `to the search directory. Respects .gitignore. Output is truncated to ` +
      `${DEFAULT_FIND_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB.`,

    async execute(input: FindInput): Promise<FindToolResult> {
      const searchPath = path.resolve(cwd, input.path || ".");
      const limit = input.limit ?? DEFAULT_FIND_LIMIT;

      if (!existsSync(searchPath)) {
        throw new Error(`Path not found: ${searchPath}`);
      }

      // Use glob to search for files
      const results = await glob(input.pattern, {
        cwd: searchPath,
        ignore: ["**/node_modules/**", "**/.git/**"],
        dot: true, // Include dotfiles
        nodir: true, // Files only, not directories
      });

      if (results.length === 0) {
        return {
          content: "No files found matching pattern",
          resultCount: 0,
          truncated: false,
        };
      }

      // Sort by path for deterministic output, then limit
      results.sort();
      const limited = results.slice(0, limit);

      // Normalize to POSIX paths
      const posixPaths = limited.map((p) => p.replace(/\\/g, "/"));

      const resultLimitReached = results.length >= limit;
      const rawOutput = posixPaths.join("\n");

      // Apply byte truncation
      const truncation = truncateHead(rawOutput, {
        maxLines: Number.MAX_SAFE_INTEGER,
      });

      // Build notices
      const notices: string[] = [];
      if (resultLimitReached) {
        notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more`);
      }
      if (truncation.truncated) {
        notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
      }

      let output = truncation.content;
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      return {
        content: output,
        resultCount: limited.length,
        truncated: truncation.truncated || resultLimitReached,
      };
    },
  };
}
