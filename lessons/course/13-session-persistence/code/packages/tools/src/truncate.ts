/**
 * Lesson 9: Truncation utilities for tool outputs.
 *
 * Two independent limits -- whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * truncateHead() -- keep first N lines/bytes (for file reads).
 * truncateTail() -- keep last N lines/bytes (for bash output).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

// ---------------------------------------------------------------------------
// TruncationResult
// ---------------------------------------------------------------------------

export interface TruncationResult {
  /** The truncated content. */
  content: string;
  /** Whether truncation occurred. */
  truncated: boolean;
  /** Which limit was hit: "lines", "bytes", or null if not truncated. */
  truncatedBy: "lines" | "bytes" | null;
  /** Total number of lines in the original content. */
  totalLines: number;
  /** Total number of bytes in the original content. */
  totalBytes: number;
  /** Number of complete lines in the truncated output. */
  outputLines: number;
  /** Number of bytes in the truncated output. */
  outputBytes: number;
  /** Whether the first line exceeded the byte limit (head truncation only). */
  firstLineExceedsLimit: boolean;
  /** The max lines limit that was applied. */
  maxLines: number;
  /** The max bytes limit that was applied. */
  maxBytes: number;
}

export interface TruncationOptions {
  /** Maximum number of lines (default: 2000). */
  maxLines?: number;
  /** Maximum number of bytes (default: 50KB). */
  maxBytes?: number;
}

// ---------------------------------------------------------------------------
// formatSize -- human-readable byte count
// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}

// ---------------------------------------------------------------------------
// truncateHead -- keep first N lines/bytes (for file reads)
// ---------------------------------------------------------------------------

/**
 * Truncate content from the head (keep first N lines/bytes).
 *
 * - Never returns partial lines.
 * - If the first line alone exceeds the byte limit, returns empty content
 *   with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  // No truncation needed
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  // First line alone exceeds byte limit
  const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  // Collect complete lines that fit within both limits
  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0); // +1 for newline separator

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    outputLinesArr.push(lines[i]);
    outputBytesCount += lineBytes;
  }

  // If we exited because of line limit (not bytes)
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

// ---------------------------------------------------------------------------
// truncateTail -- keep last N lines/bytes (for bash output)
// ---------------------------------------------------------------------------

/**
 * Truncate content from the tail (keep last N lines/bytes).
 *
 * - Works backwards from end.
 * - If the last line alone exceeds maxBytes, takes the trailing portion
 *   of that line (partial line edge case).
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  // No truncation needed
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  // Work backwards from the end
  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    outputLinesArr.unshift(lines[i]);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}
