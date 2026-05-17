import { randomUUID } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { v7 as uuidv7 } from "uuid";
import type {
  CompactionEntry,
  CustomEntry,
  FileEntry,
  LabelEntry,
  ModelChangeEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionInfo,
  SessionMessageEntry,
  SessionTreeNode,
} from "./session-types.js";

// ============================================================================
// Constants
// ============================================================================

const SESSION_VERSION = 1;

// ============================================================================
// ID Generation
// ============================================================================

/** Time-sortable session id (UUIDv7) */
function createSessionId(): string {
  return uuidv7();
}

/** Short 8-char hex entry id, collision-checked */
function generateEntryId(existing: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID();
}

// ============================================================================
// JSONL Read / Write
// ============================================================================

/** Parse a JSONL file into FileEntry[]. Skips malformed lines. */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf8");
  const entries: FileEntry[] = [];

  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as FileEntry);
    } catch {
      // Skip malformed lines -- JSONL is crash-safe, at most the last
      // line is corrupted after a crash.
    }
  }

  // Validate: first line must be a session header
  if (entries.length === 0) return [];
  const header = entries[0];
  if (header.type !== "session" || typeof (header as SessionHeader).id !== "string") {
    return [];
  }

  return entries;
}

/** Serialize all entries and overwrite the file */
function rewriteFile(filePath: string, entries: FileEntry[]): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(filePath, content);
}

/** Append a single entry to the file */
function appendEntry(filePath: string, entry: FileEntry): void {
  appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

// ============================================================================
// buildSessionContext (stateless, exported)
// ============================================================================

/**
 * Build LLM context from a flat entry list + leaf pointer.
 *
 * Walks from leaf to root via parentId chain, collects path entries,
 * then processes compaction (if any) to produce the final message list.
 */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
): SessionContext {
  // Index by id
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  // Find leaf
  if (leafId === null) {
    return { messages: [], model: null };
  }
  let leaf: SessionEntry | undefined;
  if (leafId) {
    leaf = byId.get(leafId);
  }
  if (!leaf && entries.length > 0) {
    leaf = entries[entries.length - 1];
  }
  if (!leaf) {
    return { messages: [], model: null };
  }

  // Walk leaf -> root, then reverse to get root -> leaf path
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  // Extract model changes and find latest compaction along the path
  let model: { provider: string; modelId: string } | null = null;
  let compaction: CompactionEntry | null = null;

  for (const entry of path) {
    if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  // Build message list
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  const pushIfMessage = (entry: SessionEntry) => {
    if (entry.type === "message") {
      messages.push(entry.message);
    }
  };

  if (compaction) {
    // 1. Emit compaction summary as a "system recap"
    messages.push({
      role: "user",
      content: `[Previous conversation summary]\n${compaction.summary}`,
    });

    const compIdx = path.findIndex((e) => e.type === "compaction" && e.id === compaction!.id);

    // 2. Emit kept messages (before compaction, from firstKeptEntryId onward)
    let foundFirstKept = false;
    for (let i = 0; i < compIdx; i++) {
      if (path[i].id === compaction.firstKeptEntryId) {
        foundFirstKept = true;
      }
      if (foundFirstKept) {
        pushIfMessage(path[i]);
      }
    }

    // 3. Emit messages after compaction
    for (let i = compIdx + 1; i < path.length; i++) {
      pushIfMessage(path[i]);
    }
  } else {
    // No compaction -- emit all messages on the path
    for (const entry of path) {
      pushIfMessage(entry);
    }
  }

  return { messages, model };
}

// ============================================================================
// Find most recent session
// ============================================================================

function findMostRecentSession(sessionDir: string): string | null {
  try {
    const files = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionDir, f))
      .map((p) => ({ path: p, mtime: statSync(p).mtime }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files[0]?.path ?? null;
  } catch {
    return null;
  }
}

// ============================================================================
// SessionManager
// ============================================================================

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Core ideas:
 * - Each entry has `id` + `parentId` forming a tree.
 * - `leafId` is the "cursor" -- appending always creates a child of the leaf.
 * - `branch(id)` moves the cursor to an earlier entry; the next append forks.
 * - `buildSessionContext()` walks root-to-leaf to produce the LLM message list.
 * - JSONL is append-only: existing lines are never modified (crash-safe).
 */
export class SessionManager {
  private sessionId: string = "";
  private sessionFile: string | undefined;
  private sessionDir: string;
  private cwd: string;
  private persist: boolean;

  private fileEntries: FileEntry[] = [];
  private byId: Map<string, SessionEntry> = new Map();
  private labelsById: Map<string, string> = new Map();
  private leafId: string | null = null;

  // --------------------------------------------------------------------------
  // Construction (private -- use static factories)
  // --------------------------------------------------------------------------

  private constructor(
    cwd: string,
    sessionDir: string,
    sessionFile: string | undefined,
    persist: boolean,
  ) {
    this.cwd = cwd;
    this.sessionDir = sessionDir;
    this.persist = persist;

    if (persist && sessionDir && !existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    if (sessionFile) {
      this.openFile(sessionFile);
    } else {
      this.initNewSession();
    }
  }

  // --------------------------------------------------------------------------
  // Static Factories
  // --------------------------------------------------------------------------

  /** Create a brand-new persistent session */
  static create(cwd: string, sessionDir: string): SessionManager {
    return new SessionManager(cwd, sessionDir, undefined, true);
  }

  /** Open an existing session file */
  static open(filePath: string, sessionDir?: string): SessionManager {
    const entries = loadEntriesFromFile(filePath);
    const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
    const cwd = header?.cwd ?? process.cwd();
    const dir = sessionDir ?? resolve(filePath, "..");
    return new SessionManager(cwd, dir, filePath, true);
  }

  /** Continue the most recent session in a directory, or create new */
  static continueRecent(cwd: string, sessionDir: string): SessionManager {
    const mostRecent = findMostRecentSession(sessionDir);
    if (mostRecent) {
      return new SessionManager(cwd, sessionDir, mostRecent, true);
    }
    return new SessionManager(cwd, sessionDir, undefined, true);
  }

  /** In-memory session (no file I/O) -- useful for tests */
  static inMemory(cwd: string = process.cwd()): SessionManager {
    return new SessionManager(cwd, "", undefined, false);
  }

  /**
   * Fork a session from a source file into a new project directory.
   * Copies all entries, creates a new session id, updates cwd.
   */
  static forkFrom(sourcePath: string, targetCwd: string, sessionDir: string): SessionManager {
    const sourceEntries = loadEntriesFromFile(sourcePath);
    if (sourceEntries.length === 0) {
      throw new Error(`Cannot fork: source session is empty or invalid: ${sourcePath}`);
    }

    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    const newId = createSessionId();
    const timestamp = new Date().toISOString();
    const safeTs = timestamp.replace(/[:.]/g, "-");
    const newFile = join(sessionDir, `${safeTs}_${newId}.jsonl`);

    // Write new header
    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id: newId,
      timestamp,
      cwd: targetCwd,
      parentSession: sourcePath,
    };
    appendEntry(newFile, header);

    // Copy all non-header entries
    for (const entry of sourceEntries) {
      if (entry.type !== "session") {
        appendEntry(newFile, entry);
      }
    }

    return new SessionManager(targetCwd, sessionDir, newFile, true);
  }

  // --------------------------------------------------------------------------
  // Session Initialization
  // --------------------------------------------------------------------------

  private initNewSession(): void {
    this.sessionId = createSessionId();
    const timestamp = new Date().toISOString();

    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
    };

    this.fileEntries = [header];
    this.byId.clear();
    this.labelsById.clear();
    this.leafId = null;

    if (this.persist) {
      const safeTs = timestamp.replace(/[:.]/g, "-");
      this.sessionFile = join(this.sessionDir, `${safeTs}_${this.sessionId}.jsonl`);
      rewriteFile(this.sessionFile, this.fileEntries);
    }
  }

  private openFile(filePath: string): void {
    this.sessionFile = resolve(filePath);

    if (!existsSync(this.sessionFile)) {
      this.initNewSession();
      // Preserve the explicit path the caller requested
      this.sessionFile = resolve(filePath);
      return;
    }

    this.fileEntries = loadEntriesFromFile(this.sessionFile);
    if (this.fileEntries.length === 0) {
      this.initNewSession();
      this.sessionFile = resolve(filePath);
      return;
    }

    const header = this.fileEntries[0] as SessionHeader;
    this.sessionId = header.id;
    this.buildIndex();
  }

  // --------------------------------------------------------------------------
  // Index Maintenance
  // --------------------------------------------------------------------------

  private buildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.leafId = null;

    for (const entry of this.fileEntries) {
      if (entry.type === "session") continue;
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;

      // Resolve labels (last-write-wins)
      if (entry.type === "label") {
        if (entry.label) {
          this.labelsById.set(entry.targetId, entry.label);
        } else {
          this.labelsById.delete(entry.targetId);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Append Methods
  // --------------------------------------------------------------------------

  private doAppend(entry: SessionEntry): void {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;

    if (this.persist && this.sessionFile) {
      appendEntry(this.sessionFile, entry);
    }
  }

  /** Append a user or assistant message. Returns entry id. */
  appendMessage(message: { role: "user" | "assistant"; content: string }): string {
    const entry: SessionMessageEntry = {
      type: "message",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    this.doAppend(entry);
    return entry.id;
  }

  /** Record a model/provider switch. Returns entry id. */
  appendModelChange(provider: string, modelId: string): string {
    const entry: ModelChangeEntry = {
      type: "model_change",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this.doAppend(entry);
    return entry.id;
  }

  /** Record a compaction (context summarization). Returns entry id. */
  appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): string {
    const entry: CompactionEntry = {
      type: "compaction",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
    };
    this.doAppend(entry);
    return entry.id;
  }

  /** Append a custom extension entry. Returns entry id. */
  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: "custom",
      customType,
      data,
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    };
    this.doAppend(entry);
    return entry.id;
  }

  /** Set or clear a label on an entry. Returns label entry id. */
  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: LabelEntry = {
      type: "label",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    this.doAppend(entry);

    if (label) {
      this.labelsById.set(targetId, label);
    } else {
      this.labelsById.delete(targetId);
    }
    return entry.id;
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  getSessionId(): string {
    return this.sessionId;
  }
  getSessionFile(): string | undefined {
    return this.sessionFile;
  }
  getSessionDir(): string {
    return this.sessionDir;
  }
  getCwd(): string {
    return this.cwd;
  }
  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  getHeader(): SessionHeader | null {
    const h = this.fileEntries.find((e) => e.type === "session");
    return h ? (h as SessionHeader) : null;
  }

  /** All session entries (excludes the header line) */
  getEntries(): SessionEntry[] {
    return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
  }

  // --------------------------------------------------------------------------
  // Tree Traversal
  // --------------------------------------------------------------------------

  /** Walk from an entry to root, return path in root-to-leaf order */
  getBranch(fromId?: string): SessionEntry[] {
    const path: SessionEntry[] = [];
    const startId = fromId ?? this.leafId;
    let current = startId ? this.byId.get(startId) : undefined;

    while (current) {
      path.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return path;
  }

  /** Build the full tree structure */
  getTree(): SessionTreeNode[] {
    const entries = this.getEntries();
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];

    // Create nodes
    for (const entry of entries) {
      const label = this.labelsById.get(entry.id);
      nodeMap.set(entry.id, { entry, children: [], label });
    }

    // Wire parent-child relationships
    for (const entry of entries) {
      const node = nodeMap.get(entry.id)!;
      if (entry.parentId === null) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(entry.parentId);
        if (parent) {
          parent.children.push(node);
        } else {
          roots.push(node); // orphan -> treat as root
        }
      }
    }

    // Sort children by timestamp
    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      node.children.sort(
        (a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime(),
      );
      stack.push(...node.children);
    }

    return roots;
  }

  /** Build the LLM context from the current leaf */
  buildSessionContext(): SessionContext {
    return buildSessionContext(this.getEntries(), this.leafId);
  }

  // --------------------------------------------------------------------------
  // Branching
  // --------------------------------------------------------------------------

  /**
   * Move the leaf pointer to an earlier entry.
   * The next `appendXXX()` call creates a child of that entry,
   * forming a new branch. Existing entries are never modified.
   */
  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
  }

  /**
   * Reset the leaf pointer to null (before any entries).
   * The next append creates a new root entry (parentId = null).
   */
  resetLeaf(): void {
    this.leafId = null;
  }

  /**
   * Extract a single branch (root-to-leaf path) into a new session file.
   * Returns the new file path, or undefined for in-memory sessions.
   */
  forkToNewSession(leafId: string): string | undefined {
    const path = this.getBranch(leafId);
    if (path.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }

    const newId = createSessionId();
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: "session",
      version: SESSION_VERSION,
      id: newId,
      timestamp,
      cwd: this.cwd,
      parentSession: this.persist ? this.sessionFile : undefined,
    };

    if (this.persist) {
      const safeTs = timestamp.replace(/[:.]/g, "-");
      const newFile = join(this.sessionDir, `${safeTs}_${newId}.jsonl`);
      rewriteFile(newFile, [header, ...path]);
      return newFile;
    }

    // In-memory: replace current session content
    this.fileEntries = [header, ...path];
    this.sessionId = newId;
    this.buildIndex();
    return undefined;
  }

  // --------------------------------------------------------------------------
  // Listing
  // --------------------------------------------------------------------------

  /** List all sessions in a directory, sorted by modified time (newest first) */
  static list(sessionDir: string): SessionInfo[] {
    if (!existsSync(sessionDir)) return [];

    const files = readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionDir, f));

    const sessions: SessionInfo[] = [];

    for (const filePath of files) {
      const entries = loadEntriesFromFile(filePath);
      if (entries.length === 0) continue;

      const header = entries[0] as SessionHeader;
      const stats = statSync(filePath);
      let messageCount = 0;
      let firstMessage = "";

      for (const entry of entries) {
        if (entry.type !== "message") continue;
        messageCount++;
        const msg = (entry as SessionMessageEntry).message;
        if (!firstMessage && msg.role === "user") {
          firstMessage = msg.content;
        }
      }

      sessions.push({
        path: filePath,
        id: header.id,
        cwd: header.cwd,
        created: new Date(header.timestamp),
        modified: stats.mtime,
        messageCount,
        firstMessage: firstMessage || "(no messages)",
      });
    }

    sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return sessions;
  }
}
