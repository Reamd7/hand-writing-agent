// ============================================================================
// Session Entry Types
//
// Each entry in the session JSONL file has an `id` and `parentId`, forming
// a tree structure. The "current branch" is the path from root to the
// current leaf. Branching = moving the leaf pointer to an earlier entry
// and appending new children there.
// ============================================================================

/** All supported entry types */
export type SessionEntryType = "message" | "model_change" | "compaction" | "label" | "custom";

/** Common fields shared by all session entries */
export interface SessionEntryBase {
  type: SessionEntryType;
  /** Unique identifier for this entry (8-char hex) */
  id: string;
  /** Parent entry id, or null for the first entry (root of the tree) */
  parentId: string | null;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** A chat message (user or assistant) */
export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: {
    role: "user" | "assistant";
    content: string;
  };
}

/** Records a model/provider switch */
export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

/**
 * Context compaction: summarizes older messages to save tokens.
 * - `summary`: condensed text of the compacted portion
 * - `firstKeptEntryId`: id of the oldest entry still kept verbatim
 * - `tokensBefore`: token count before compaction (for metrics)
 */
export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

/** User-defined bookmark/label on another entry */
export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

/** Extension-specific data (not sent to LLM) */
export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

/** Union of all entry types */
export type SessionEntry =
  | SessionMessageEntry
  | ModelChangeEntry
  | CompactionEntry
  | LabelEntry
  | CustomEntry;

// ============================================================================
// Session Header & Info
// ============================================================================

/** First line of every session JSONL file */
export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  /** If this session was forked, path to the parent session file */
  parentSession?: string;
}

/** Union of header + entries = raw file content */
export type FileEntry = SessionHeader | SessionEntry;

/** Metadata for listing sessions (returned by list operations) */
export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

/** Resolved context sent to the LLM */
export interface SessionContext {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model: { provider: string; modelId: string } | null;
}

/** Tree node for visualization / traversal */
export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
}
