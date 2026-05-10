# Lesson 13: Session Persistence and Branching -- Reference Materials

## Pi Source Code References

- **`packages/coding-agent/src/core/session-manager.ts`** - Session persistence implementation
  - `SessionManager` - manages conversation sessions as append-only trees stored in JSONL files
  - `SessionHeader` - first line of every `.jsonl` file: `{ type: "session", version, id, timestamp, cwd, parentSession? }`
  - `SessionEntryBase` - common fields: `{ type, id, parentId, timestamp }`
  - `SessionMessageEntry` - `type: "message"`, wraps an `AgentMessage`
  - `ModelChangeEntry` - `type: "model_change"`, records provider/model switch
  - `CompactionEntry` - `type: "compaction"`, summary + `firstKeptEntryId` + `tokensBefore`
  - `BranchSummaryEntry` - `type: "branch_summary"`, context summary when branching
  - `CustomEntry` - `type: "custom"`, extension-specific data (not sent to LLM)
  - `CustomMessageEntry` - `type: "custom_message"`, extension data that participates in LLM context
  - `LabelEntry` - `type: "label"`, user-defined bookmarks on entries
  - `SessionInfoEntry` - `type: "session_info"`, e.g. user-defined display name
  - `SessionContext` - resolved output: `{ messages: AgentMessage[], thinkingLevel, model }`
  - `SessionInfo` - metadata for session listing: path, id, cwd, name, created, modified, messageCount, firstMessage

  ### Static Factory Methods
  - `SessionManager.create(cwd, sessionDir?)` - create a new persistent session
  - `SessionManager.open(path, sessionDir?, cwdOverride?)` - open an existing session file
  - `SessionManager.continueRecent(cwd, sessionDir?)` - resume most recent session or create new
  - `SessionManager.inMemory(cwd?)` - create an in-memory session (no file I/O)
  - `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` - fork session from another project

  ### Append Methods (all return entry id)
  - `appendMessage(message)` - append message as child of current leaf
  - `appendModelChange(provider, modelId)` - record model switch
  - `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)` - record compaction
  - `appendCustomEntry(customType, data?)` - extension-specific data
  - `appendCustomMessageEntry(customType, content, display, details?)` - extension message in LLM context
  - `appendLabelChange(targetId, label)` - set/clear bookmark label
  - `appendSessionInfo(name)` - set session display name

  ### Tree Traversal
  - `getLeafId()` / `getLeafEntry()` - current leaf pointer
  - `getEntry(id)` - lookup by id
  - `getChildren(parentId)` - direct children of an entry
  - `getBranch(fromId?)` - walk from entry to root, return path in root-to-leaf order
  - `getTree()` - build full tree structure as `SessionTreeNode[]`
  - `buildSessionContext()` - resolve root-to-leaf path into `SessionContext` for LLM

  ### Branching
  - `branch(branchFromId)` - move leaf pointer to earlier entry (next append creates new branch)
  - `resetLeaf()` - set leaf to null (next append creates new root)
  - `branchWithSummary(branchFromId, summary, details?, fromHook?)` - branch + append summary entry
  - `createBranchedSession(leafId)` - extract single path into new session file

  ### Internal
  - `generateId(byId)` - 8-char hex from `randomUUID()`, collision-checked
  - `createSessionId()` - `uuidv7()` for time-sortable session IDs
  - `_persist(entry)` - deferred flush: waits for first assistant message before writing to disk
  - `_rewriteFile()` - rewrite entire file (used after migration)
  - `_buildIndex()` - rebuild `byId` map, `labelsById` map, and `leafId` from file entries
  - `migrateToCurrentVersion(entries)` - run v1->v2->v3 migrations
  - `loadEntriesFromFile(filePath)` - read JSONL, parse lines, validate header
  - `findMostRecentSession(sessionDir)` - find newest `.jsonl` by mtime

  ### Free Functions
  - `buildSessionContext(entries, leafId?, byId?)` - stateless context builder (exported for use outside SessionManager)
  - `parseSessionEntries(content)` - parse JSONL string into `FileEntry[]`
  - `getLatestCompactionEntry(entries)` - find last compaction in entry list
  - `getDefaultSessionDir(cwd, agentDir?)` - compute session directory path

## JSONL Format

- **Specification**: https://jsonlines.org/
  - One JSON value per line, separated by `\n`
  - Each line is a valid JSON value (object, array, string, number, etc.)
  - UTF-8 encoded
  - No trailing comma, no wrapping array/object
  - Append-friendly: just write `JSON.stringify(entry) + "\n"` to the end of the file
  - Crash-safe: partial writes corrupt at most the last line; all previous lines remain valid
  - Streaming reads: process one line at a time, no need to parse the entire file into memory

## Node.js fs/readline for Streaming JSONL

- **`fs.appendFileSync(path, data)`** - atomic append for writing entries
- **`fs.readFileSync(path, "utf8")`** - read entire file for small-to-medium sessions
- **`fs.writeFileSync(path, data)`** - rewrite entire file (migration, branched session)
- **`readline.createInterface({ input: fs.createReadStream(path) })`** - line-by-line streaming for large files
- **`fs.existsSync(path)`** - check file existence before open
- **`fs.mkdirSync(path, { recursive: true })`** - ensure session directory exists
- **`fs.readdirSync(dir)`** - list session files for `findMostRecentSession`
- **`fs.statSync(path).mtime`** - file modification time for sorting sessions

## Key Design Patterns

| Pattern                  | Description                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Append-only JSONL        | Never modify existing lines; only append new entries. Crash-safe, merge-friendly                                          |
| Tree via id/parentId     | Each entry has a unique `id` and a `parentId` pointing to its parent. Branching = new child on an old entry               |
| Leaf pointer             | `leafId` tracks the current position; `appendXXX()` always creates a child of the leaf                                    |
| Deferred flush           | File is not written until the first assistant message arrives (avoids empty session files)                                |
| Root-to-leaf walk        | `getBranch()` walks parentId chain from leaf to root, then reverses. O(depth)                                             |
| Compaction-aware context | `buildSessionContext()` finds the latest compaction on the path, emits summary + kept messages + post-compaction messages |
| Time-sortable IDs        | Session IDs use UUIDv7 (timestamp-prefixed) for natural chronological ordering                                            |
| Short entry IDs          | Entry IDs are 8-char hex slices of UUIDv4, collision-checked against existing entries                                     |
| Migration pipeline       | Version field in header; `migrateToCurrentVersion()` runs chained v1->v2->v3 transforms                                   |
