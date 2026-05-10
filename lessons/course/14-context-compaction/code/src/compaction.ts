/**
 * Context compaction for long conversations.
 *
 * Mirrors the design of pi's compaction pipeline:
 * - prepareCompaction(): pure function, finds cut point, separates messages
 * - compact(): calls LLM to generate summary, returns CompactionResult
 *
 * Uses Vercel AI SDK's generateText for non-streaming summarization.
 */

import { generateText, type CoreMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { estimateTokensChars4, estimateTotalTokens } from "./token-counter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactionSettings {
  enabled: boolean;
  /** Tokens to reserve as buffer before triggering compaction */
  reserveTokens: number;
  /** How many tokens of recent messages to keep after compaction */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export interface CompactionResult {
  /** Generated summary of the compacted messages */
  summary: string;
  /** Index of the first kept message */
  firstKeptIndex: number;
  /** Estimated tokens before compaction */
  tokensBefore: number;
  /** Estimated tokens after compaction */
  tokensAfter: number;
  /** Files that were read during the compacted conversation */
  readFiles: string[];
  /** Files that were modified during the compacted conversation */
  modifiedFiles: string[];
}

export interface CompactionPreparation {
  /** Index of the first message to keep */
  firstKeptIndex: number;
  /** Messages that will be summarized (old history) */
  messagesToSummarize: CoreMessage[];
  /** Messages that will be kept (recent context) */
  messagesToKeep: CoreMessage[];
  /** Estimated tokens before compaction */
  tokensBefore: number;
  /** Previous compaction summary, if any (for iterative update) */
  previousSummary?: string;
  /** Files read in the compacted portion */
  readFiles: string[];
  /** Files modified in the compacted portion */
  modifiedFiles: string[];
}

// ---------------------------------------------------------------------------
// Should compact check
// ---------------------------------------------------------------------------

/**
 * Check if compaction should trigger.
 *
 * pi's formula: contextTokens > contextWindow - reserveTokens
 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

// ---------------------------------------------------------------------------
// File operation extraction
// ---------------------------------------------------------------------------

interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

/**
 * Extract file operations from assistant tool calls.
 * Tracks which files were read vs. modified for the compaction summary.
 */
function extractFileOperations(messages: CoreMessage[]): FileOperations {
  const ops: FileOperations = {
    read: new Set(),
    written: new Set(),
    edited: new Set(),
  };

  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    if (!Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (part.type !== "tool-call") continue;
      const args = part.args as Record<string, unknown>;
      const path = typeof args.path === "string" ? args.path : undefined;
      if (!path) continue;

      switch (part.toolName) {
        case "read":
          ops.read.add(path);
          break;
        case "write":
          ops.written.add(path);
          break;
        case "edit":
          ops.edited.add(path);
          break;
      }
    }
  }

  return ops;
}

function computeFileLists(ops: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...ops.edited, ...ops.written]);
  const readOnly = [...ops.read].filter((f) => !modified.has(f)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

// ---------------------------------------------------------------------------
// Cut point detection
// ---------------------------------------------------------------------------

/**
 * Find the cut point that keeps approximately `keepRecentTokens` of recent messages.
 *
 * Algorithm:
 * 1. Walk backwards from newest message, accumulating token estimates
 * 2. When accumulated tokens >= keepRecentTokens, that's our cut point
 * 3. Never cut at a tool result (must follow its tool call)
 *
 * Returns the index of the first message to keep.
 */
function findCutPoint(messages: CoreMessage[], keepRecentTokens: number): number {
  let accumulated = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokensChars4(messages[i]);

    if (accumulated >= keepRecentTokens) {
      // Find next valid cut point at or after i
      // Don't cut at tool results - they must stay with their tool call
      let cutIndex = i;
      while (cutIndex < messages.length && messages[cutIndex].role === "tool") {
        cutIndex++;
      }
      return cutIndex;
    }
  }

  // All messages fit within budget - keep from the start
  return 0;
}

// ---------------------------------------------------------------------------
// Conversation serialization
// ---------------------------------------------------------------------------

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncated = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncated} more characters truncated]`;
}

/**
 * Serialize messages to plain text for summarization.
 * Prevents the summarization model from treating it as a conversation to continue.
 */
function serializeConversation(messages: CoreMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .filter((p): p is { type: "text"; text: string } => p.type === "text")
                .map((p) => p.text)
                .join("");
        if (text) parts.push(`[User]: ${text}`);
        break;
      }
      case "assistant": {
        if (typeof msg.content === "string") {
          parts.push(`[Assistant]: ${msg.content}`);
        } else if (Array.isArray(msg.content)) {
          const texts: string[] = [];
          const toolCalls: string[] = [];
          for (const part of msg.content) {
            if (part.type === "text") texts.push(part.text);
            if (part.type === "tool-call") {
              const argsStr = JSON.stringify(part.args);
              toolCalls.push(`${part.toolName}(${argsStr})`);
            }
          }
          if (texts.length > 0) {
            parts.push(`[Assistant]: ${texts.join("\n")}`);
          }
          if (toolCalls.length > 0) {
            parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
          }
        }
        break;
      }
      case "tool": {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "tool-result") {
              const text =
                typeof part.result === "string" ? part.result : JSON.stringify(part.result);
              parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
            }
          }
        }
        break;
      }
    }
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Summarization prompts
// ---------------------------------------------------------------------------

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- If something is no longer relevant, you may remove it

Use the same structured format (Goal, Progress, Key Decisions, Next Steps).

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// ---------------------------------------------------------------------------
// prepareCompaction() - pure function, no I/O
// ---------------------------------------------------------------------------

/**
 * Prepare for compaction by finding the cut point and separating messages.
 *
 * This is a pure function - no LLM calls, no I/O.
 * Returns undefined if compaction is not possible (e.g., too few messages).
 */
export function prepareCompaction(
  messages: CoreMessage[],
  settings: CompactionSettings,
  previousSummary?: string,
): CompactionPreparation | undefined {
  if (messages.length < 3) {
    return undefined; // Not enough messages to compact
  }

  const tokensBefore = estimateTotalTokens(messages);
  const cutIndex = findCutPoint(messages, settings.keepRecentTokens);

  if (cutIndex === 0) {
    return undefined; // Everything fits in the keep budget
  }

  const messagesToSummarize = messages.slice(0, cutIndex);
  const messagesToKeep = messages.slice(cutIndex);

  // Extract file operations from the summarized portion
  const fileOps = extractFileOperations(messagesToSummarize);
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);

  return {
    firstKeptIndex: cutIndex,
    messagesToSummarize,
    messagesToKeep,
    tokensBefore,
    previousSummary,
    readFiles,
    modifiedFiles,
  };
}

// ---------------------------------------------------------------------------
// compact() - calls LLM for summarization
// ---------------------------------------------------------------------------

/**
 * Run compaction: generate a summary of old messages using the LLM.
 *
 * Uses generateText (non-streaming) because we need the complete summary
 * before we can persist it and rebuild agent state.
 *
 * @param preparation - Output from prepareCompaction()
 * @param modelId - OpenAI model ID for summarization (default: "gpt-4o-mini")
 */
export async function compact(
  preparation: CompactionPreparation,
  modelId: string = "gpt-4o-mini",
): Promise<CompactionResult> {
  const {
    firstKeptIndex,
    messagesToSummarize,
    messagesToKeep,
    tokensBefore,
    previousSummary,
    readFiles,
    modifiedFiles,
  } = preparation;

  // Serialize conversation to text
  const conversationText = serializeConversation(messagesToSummarize);

  // Build prompt (initial vs. incremental update)
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    promptText += UPDATE_SUMMARIZATION_PROMPT;
  } else {
    promptText += SUMMARIZATION_PROMPT;
  }

  // Call LLM (non-streaming)
  const { text: summary } = await generateText({
    model: openai(modelId),
    system: SUMMARIZATION_SYSTEM_PROMPT,
    prompt: promptText,
    maxTokens: 4096,
  });

  // Append file operations to summary
  const fullSummary = summary + formatFileOperations(readFiles, modifiedFiles);

  // Build new message list: [compaction summary] + [kept messages]
  const compactedMessages: CoreMessage[] = [
    { role: "user", content: `[Previous conversation summary]:\n\n${fullSummary}` },
    ...messagesToKeep,
  ];
  const tokensAfter = estimateTotalTokens(compactedMessages);

  return {
    summary: fullSummary,
    firstKeptIndex,
    tokensBefore,
    tokensAfter,
    readFiles,
    modifiedFiles,
  };
}

// ---------------------------------------------------------------------------
// Helper: rebuild messages after compaction
// ---------------------------------------------------------------------------

/**
 * Rebuild the message array after compaction.
 * Injects the compaction summary as the first user message,
 * followed by the kept recent messages.
 */
export function rebuildMessages(summary: string, keptMessages: CoreMessage[]): CoreMessage[] {
  return [
    {
      role: "user" as const,
      content: `[Previous conversation summary]:\n\n${summary}`,
    },
    ...keptMessages,
  ];
}
