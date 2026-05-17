import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
  /** The truncated content. */
  content: string;
  /** Whether truncation occurred. */
  truncated: boolean;
  /** Which limit was hit first: "lines", "bytes", or null. */
  truncatedBy: "lines" | "bytes" | null;
  /** Total line count of the original content. */
  totalLines: number;
  /** Total byte size of the original content. */
  totalBytes: number;
  /** Number of lines kept after truncation. */
  outputLines: number;
  /** Number of bytes kept after truncation. */
  outputBytes: number;
  /** Max lines limit that was applied. */
  maxLines: number;
  /** Max bytes limit that was applied. */
  maxBytes: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

/**
 * Truncate content from the tail (keep last N lines / bytes).
 *
 * Suitable for command output where errors and final results appear at the end.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  // No truncation needed.
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      maxLines,
      maxBytes,
    };
  }

  // Work backwards from the end, collecting complete lines.
  const collected: string[] = [];
  let collectedBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = lines.length - 1; i >= 0 && collected.length < maxLines; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf-8") + (collected.length > 0 ? 1 : 0);

    if (collectedBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }

    collected.unshift(line);
    collectedBytes += lineBytes;
  }

  if (collected.length >= maxLines && collectedBytes <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = collected.join("\n");
  const outputBytes = Buffer.byteLength(outputContent, "utf-8");

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: collected.length,
    outputBytes,
    maxLines,
    maxBytes,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// OutputAccumulator
// ---------------------------------------------------------------------------

export interface OutputAccumulatorOptions {
  maxLines?: number;
  maxBytes?: number;
  tempFilePrefix?: string;
}

export interface OutputSnapshot {
  /** Truncated content suitable for returning to the agent. */
  content: string;
  /** Truncation metadata. */
  truncation: TruncationResult;
  /** Path to the temp file containing full output, if created. */
  fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends raw Buffer chunks from a child process, decodes them with a
 * streaming UTF-8 decoder, keeps a rolling decoded tail for display
 * snapshots, and lazily opens a temp file when full output needs to be
 * preserved.
 */
export class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  /** We keep roughly 2x maxBytes of decoded text in memory. */
  private readonly maxRollingBytes: number;
  private readonly tempFilePrefix: string;
  private readonly decoder = new TextDecoder();

  /** Raw chunks buffered before a temp file is opened. */
  private rawChunks: Buffer[] = [];
  /** Rolling decoded text (newest output). */
  private tailText = "";
  private tailBytes = 0;
  /** Whether tailText starts at a line boundary (not a mid-line trim). */
  private tailStartsAtLineBoundary = true;

  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private totalLines = 1;
  private finished = false;

  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePrefix = options.tempFilePrefix ?? "bash-output";
  }

  /** Feed a raw Buffer chunk from the child process. */
  append(data: Buffer): void {
    if (this.finished) {
      throw new Error("Cannot append to a finished OutputAccumulator");
    }

    this.totalRawBytes += data.length;

    // Decode with streaming: handles multi-byte chars split across chunks.
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));

    // Persist to temp file or buffer raw chunks.
    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  /** Signal that no more data will arrive. Flushes the decoder. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    // Flush any buffered bytes in the TextDecoder.
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldUseTempFile()) {
      this.ensureTempFile();
    }
  }

  /**
   * Take a snapshot of the current output.
   *
   * If `persistIfTruncated` is true and the output is truncated, ensure
   * the full output is being written to a temp file.
   */
  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });

    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;

    const truncatedBy = truncated
      ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
      : null;

    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated,
      truncatedBy,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };

    if (options.persistIfTruncated && truncation.truncated) {
      this.ensureTempFile();
    }

    return {
      content: truncation.content,
      truncation,
      fullOutputPath: this.tempFilePath,
    };
  }

  /** Close and finalize the temp file stream. */
  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) return;

    const stream = this.tempFileStream;
    this.tempFileStream = undefined;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private appendDecodedText(text: string): void {
    if (text.length === 0) return;

    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;

    // Trim if tail buffer is too large.
    if (this.tailBytes > this.maxRollingBytes * 2) {
      this.trimTail();
    }

    // Count newlines for totalLines tracking.
    let newlines = 0;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
    }
    if (newlines > 0) {
      this.totalLines += newlines;
    }
  }

  /**
   * Trim the tail buffer to approximately maxRollingBytes.
   *
   * Ensures we cut at a valid UTF-8 character boundary.
   */
  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }

    let start = buffer.length - this.maxRollingBytes;
    // Skip continuation bytes (10xxxxxx) to find a valid char start.
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
      start++;
    }

    this.tailStartsAtLineBoundary =
      start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;

    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  /**
   * Return the text to use for snapshots.
   *
   * If the tail was trimmed mid-line, skip the first partial line.
   */
  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.tailText;

    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  private shouldUseTempFile(): boolean {
    return (
      this.totalRawBytes > this.maxBytes ||
      this.totalDecodedBytes > this.maxBytes ||
      this.totalLines > this.maxLines
    );
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;

    this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
    this.tempFileStream = createWriteStream(this.tempFilePath);

    // Flush any buffered raw chunks into the file.
    for (const chunk of this.rawChunks) {
      this.tempFileStream.write(chunk);
    }
    this.rawChunks = [];
  }
}
