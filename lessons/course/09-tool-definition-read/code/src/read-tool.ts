/**
 * Lesson 9: Read tool implementation.
 *
 * Full read tool with:
 * - Text file support (line numbers, offset/limit, truncation)
 * - Image file support (MIME detection, resize, base64)
 * - Pluggable operations interface
 * - Abort signal handling
 */

import { access as fsAccess, open, readFile as fsReadFile } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { fileTypeFromBuffer } from "file-type";
import { resolvePath, isWithinCwd } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ImageContent,
  TextContent,
  ToolDefinition,
} from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const readSchema = z.object({
  path: z.string().describe("Path to the file to read (relative or absolute)"),
  offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
  limit: z.number().optional().describe("Maximum number of lines to read"),
});

export type ReadToolInput = z.infer<typeof readSchema>;

// ---------------------------------------------------------------------------
// Details (metadata for UI rendering)
// ---------------------------------------------------------------------------

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

// ---------------------------------------------------------------------------
// Operations interface -- pluggable I/O
// ---------------------------------------------------------------------------

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (SSH, containers, etc.)
 * or to inject test doubles.
 */
export interface ReadOperations {
  /** Read file contents as a Buffer. */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Check if file is readable (throw if not). */
  access: (absolutePath: string) => Promise<void>;
  /** Detect image MIME type. Return null for non-images. */
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

// ---------------------------------------------------------------------------
// Default operations: local filesystem
// ---------------------------------------------------------------------------

const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const FILE_TYPE_SNIFF_BYTES = 4100;

/**
 * Detect supported image MIME type by reading file header bytes.
 * Uses magic bytes, not file extension -- more reliable.
 */
async function detectSupportedImageMimeType(filePath: string): Promise<string | null> {
  const fileHandle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(FILE_TYPE_SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, 0);
    if (bytesRead === 0) return null;

    const fileType = await fileTypeFromBuffer(buffer.subarray(0, bytesRead));
    if (!fileType) return null;

    return SUPPORTED_IMAGE_MIMES.has(fileType.mime) ? fileType.mime : null;
  } finally {
    await fileHandle.close();
  }
}

const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeType,
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ReadToolOptions {
  /** Custom operations for file reading. Default: local filesystem. */
  operations?: ReadOperations;
}

// ---------------------------------------------------------------------------
// Line numbering
// ---------------------------------------------------------------------------

/**
 * Add line number prefixes to content.
 * Example: "foo\nbar" with startLine=1 becomes "1: foo\n2: bar"
 */
function addLineNumbers(content: string, startLine: number): string {
  const lines = content.split("\n");
  return lines.map((line, i) => `${startLine + i}: ${line}`).join("\n");
}

// ---------------------------------------------------------------------------
// createReadToolDefinition
// ---------------------------------------------------------------------------

export function createReadToolDefinition(
  cwd: string,
  options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
  const ops = options?.operations ?? defaultReadOperations;

  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    promptSnippet: "Read file contents",
    promptGuidelines: ["Use read to examine files instead of cat or sed."],
    parameters: readSchema,
    executionMode: "parallel",

    async execute(
      _toolCallId: string,
      { path, offset, limit }: ReadToolInput,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<ReadToolDetails | undefined> | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<ReadToolDetails | undefined>> {
      // ------------------------------------------------------------------
      // Path resolution and security
      // ------------------------------------------------------------------
      const absolutePath = resolvePath(path, cwd);

      if (!isWithinCwd(absolutePath, cwd)) {
        throw new Error(`Access denied: path "${path}" resolves outside the working directory`);
      }

      // ------------------------------------------------------------------
      // Abort signal: standard pattern
      // ------------------------------------------------------------------
      return new Promise<AgentToolResult<ReadToolDetails | undefined>>((resolve, reject) => {
        // Step 1: Check upfront
        if (signal?.aborted) {
          reject(new Error("Operation aborted"));
          return;
        }

        // Step 2: Register listener
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          reject(new Error("Operation aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        // Step 3: Async execution
        (async () => {
          try {
            // Check file is readable
            await ops.access(absolutePath);
            if (aborted) return; // Check after await

            // Detect image MIME type
            const mimeType = ops.detectImageMimeType
              ? await ops.detectImageMimeType(absolutePath)
              : undefined;
            if (aborted) return;

            let content: (TextContent | ImageContent)[];
            let details: ReadToolDetails | undefined;

            if (mimeType) {
              // ============================================================
              // IMAGE PATH
              // ============================================================
              const buffer = await ops.readFile(absolutePath);
              if (aborted) return;

              const base64 = buffer.toString("base64");
              const textNote = `Read image file [${mimeType}]`;

              content = [
                { type: "text", text: textNote },
                { type: "image", data: base64, mimeType },
              ];
              details = undefined;
            } else {
              // ============================================================
              // TEXT PATH
              // ============================================================
              const buffer = await ops.readFile(absolutePath);
              if (aborted) return;

              const textContent = buffer.toString("utf-8");
              const allLines = textContent.split("\n");
              const totalFileLines = allLines.length;

              // Apply offset (1-indexed input -> 0-indexed array)
              const startLine = offset ? Math.max(0, offset - 1) : 0;
              const startLineDisplay = startLine + 1;

              if (startLine >= allLines.length) {
                throw new Error(
                  `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
                );
              }

              // Apply limit if specified
              let selectedContent: string;
              let userLimitedLines: number | undefined;

              if (limit !== undefined) {
                const endLine = Math.min(startLine + limit, allLines.length);
                selectedContent = allLines.slice(startLine, endLine).join("\n");
                userLimitedLines = endLine - startLine;
              } else {
                selectedContent = allLines.slice(startLine).join("\n");
              }

              // Apply truncation (line + byte limits)
              const truncation = truncateHead(selectedContent);

              let outputText: string;

              if (truncation.firstLineExceedsLimit) {
                // First line exceeds byte limit -- suggest bash fallback
                const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
                outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
                details = { truncation };
              } else if (truncation.truncated) {
                // Truncation occurred -- build continuation notice
                const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
                const nextOffset = endLineDisplay + 1;

                // Add line numbers
                outputText = addLineNumbers(truncation.content, startLineDisplay);

                if (truncation.truncatedBy === "lines") {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                } else {
                  outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                }
                details = { truncation };
              } else if (
                userLimitedLines !== undefined &&
                startLine + userLimitedLines < allLines.length
              ) {
                // User-specified limit stopped early
                const remaining = allLines.length - (startLine + userLimitedLines);
                const nextOffset = startLine + userLimitedLines + 1;
                outputText = addLineNumbers(truncation.content, startLineDisplay);
                outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
                details = undefined;
              } else {
                // No truncation needed
                outputText = addLineNumbers(truncation.content, startLineDisplay);
                details = undefined;
              }

              content = [{ type: "text", text: outputText }];
            }

            // Step 4: Success -- cleanup and resolve
            if (aborted) return;
            signal?.removeEventListener("abort", onAbort);
            resolve({ content, details });
          } catch (error) {
            // Step 5: Error -- cleanup and reject
            signal?.removeEventListener("abort", onAbort);
            if (!aborted) reject(error);
          }
        })();
      });
    },
  };
}
