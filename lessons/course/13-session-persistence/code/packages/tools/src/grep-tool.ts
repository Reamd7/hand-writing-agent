/**
 * Grep tool -- search file contents for a regex or literal pattern.
 *
 * Simplified teaching implementation.  Pi's production version delegates to
 * ripgrep (`rg --json`) for speed; here we use Node's built-in `readline` to
 * scan files found via the filesystem, which is slower but dependency-free.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Truncation helpers (shared with find / ls)
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 50 * 1024; // 50 KB
const GREP_MAX_LINE_LENGTH = 500;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export function truncateHead(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): TruncationResult {
  const maxLines = options.maxLines ?? 2000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = content.split("\n");
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLinesArr.push(lines[i]);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: Buffer.byteLength(outputContent, "utf-8"),
  };
}

function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

// ---------------------------------------------------------------------------
// .gitignore-aware file walking (simplified)
// ---------------------------------------------------------------------------

import ignore from "ignore";

function loadGitignoreRules(dir: string): ReturnType<typeof ignore> {
  const ig = ignore();
  // Always ignore these directories
  ig.add(["node_modules", ".git"]);
  try {
    const content = readFileSync(path.join(dir, ".gitignore"), "utf-8");
    ig.add(content);
  } catch {
    // No .gitignore -- that is fine
  }
  return ig;
}

function walkFiles(dir: string, ig: ReturnType<typeof ignore>, base: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const relativePath = path.relative(base, path.join(dir, entry)).replace(/\\/g, "/");
    if (ig.ignores(relativePath)) continue;
    const fullPath = path.join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...walkFiles(fullPath, ig, base));
      } else if (stat.isFile()) {
        results.push(fullPath);
      }
    } catch {
      // Skip unreadable entries
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Grep tool
// ---------------------------------------------------------------------------

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export interface GrepToolResult {
  content: string;
  matchCount: number;
  truncated: boolean;
}

const DEFAULT_GREP_LIMIT = 100;

/**
 * Create a grep tool bound to a working directory.
 *
 * Returns a simple `execute(input)` function -- no UI rendering, no
 * pluggable Operations, no child-process management.  This keeps the
 * teaching code focused on the *logic* of content search + truncation.
 */
export function createGrepTool(cwd: string) {
  return {
    name: "grep" as const,
    promptSnippet: "Search file contents for patterns (respects .gitignore)",
    description:
      `Search file contents for a pattern. Returns matching lines with file paths ` +
      `and line numbers. Respects .gitignore. Output is truncated to ` +
      `${DEFAULT_GREP_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB.`,

    async execute(input: GrepInput): Promise<GrepToolResult> {
      const searchPath = path.resolve(cwd, input.path || ".");
      const limit = input.limit ?? DEFAULT_GREP_LIMIT;
      const contextLines = input.context && input.context > 0 ? input.context : 0;

      // Build regex
      let regex: RegExp;
      if (input.literal) {
        const escaped = input.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        regex = new RegExp(escaped, input.ignoreCase ? "i" : "");
      } else {
        regex = new RegExp(input.pattern, input.ignoreCase ? "i" : "");
      }

      // Glob filter (simplified: match against basename)
      const globFilter = input.glob
        ? (filePath: string) => {
            const base = path.basename(filePath);
            // Simple glob: *.ts -> ends with .ts
            const ext = input.glob!.startsWith("*") ? input.glob!.slice(1) : input.glob!;
            return base.endsWith(ext);
          }
        : undefined;

      // Walk files
      const ig = loadGitignoreRules(searchPath);
      const files = walkFiles(searchPath, ig, searchPath);

      // Search
      const outputLines: string[] = [];
      let matchCount = 0;
      let linesTruncated = false;

      for (const filePath of files) {
        if (matchCount >= limit) break;

        if (globFilter && !globFilter(filePath)) continue;

        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          continue;
        }

        const fileLines = content.split("\n");
        const relativePath = path.relative(searchPath, filePath).replace(/\\/g, "/");

        for (let i = 0; i < fileLines.length; i++) {
          if (matchCount >= limit) break;

          if (regex.test(fileLines[i])) {
            matchCount++;
            const lineNumber = i + 1;

            if (contextLines === 0) {
              // No context -- just the match line
              const { text, wasTruncated } = truncateLine(fileLines[i]);
              if (wasTruncated) linesTruncated = true;
              outputLines.push(`${relativePath}:${lineNumber}: ${text}`);
            } else {
              // With context lines
              const start = Math.max(0, i - contextLines);
              const end = Math.min(fileLines.length - 1, i + contextLines);
              for (let c = start; c <= end; c++) {
                const { text, wasTruncated } = truncateLine(fileLines[c]);
                if (wasTruncated) linesTruncated = true;
                const cn = c + 1;
                if (c === i) {
                  outputLines.push(`${relativePath}:${cn}: ${text}`);
                } else {
                  outputLines.push(`${relativePath}-${cn}- ${text}`);
                }
              }
            }
          }
        }
      }

      if (matchCount === 0) {
        return { content: "No matches found", matchCount: 0, truncated: false };
      }

      // Apply byte truncation
      const rawOutput = outputLines.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

      // Build notices
      const notices: string[] = [];
      if (matchCount >= limit) {
        notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more`);
      }
      if (truncation.truncated) {
        notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars`);
      }

      let output = truncation.content;
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      return {
        content: output,
        matchCount,
        truncated: truncation.truncated || matchCount >= limit,
      };
    },
  };
}
