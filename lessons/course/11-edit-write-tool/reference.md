# Lesson 11: Edit and Write Tool -- Reference Materials

## Pi Source Code References

- **`packages/coding-agent/src/core/tools/edit.ts`** - Edit tool definition and execution
  - `editSchema` - TypeBox schema: `{ path: string, edits: Array<{ oldText: string, newText: string }> }`
  - `prepareEditArguments()` - compatibility shim: JSON-string edits -> parsed array, legacy `oldText`/`newText` top-level fields -> `edits[]`
  - `validateEditInput()` - ensures `edits` is a non-empty array
  - `createEditToolDefinition()` - full tool definition with execute, renderCall, renderResult
  - `execute()` - read file -> strip BOM -> normalize line endings -> apply edits -> restore line endings -> write file -> generate diff
  - `EditOperations` interface - pluggable `readFile`/`writeFile`/`access` for remote delegation (e.g. SSH)
  - `EditToolDetails` - `{ diff: string, firstChangedLine?: number }` returned as tool details

- **`packages/coding-agent/src/core/tools/edit-diff.ts`** - Diff computation utilities
  - `Edit` interface - `{ oldText: string, newText: string }`
  - `fuzzyFindText()` - exact match first, then fuzzy match (normalize Unicode quotes/dashes/spaces, trim trailing whitespace)
  - `applyEditsToNormalizedContent()` - match all edits against original content, validate uniqueness and non-overlap, apply in reverse offset order
  - `generateDiffString()` - produce unified diff with line numbers and configurable context lines (default 4)
  - `computeEditsDiff()` / `computeEditDiff()` - read file + apply edits + generate diff without writing (for TUI preview)
  - `detectLineEnding()` - detect CRLF vs LF
  - `normalizeToLF()` / `restoreLineEndings()` - normalize for matching, restore for writing
  - `stripBom()` - remove UTF-8 BOM before matching (LLM won't include BOM in oldText)
  - `normalizeForFuzzyMatch()` - NFKC normalize, strip trailing whitespace, smart quotes -> ASCII, Unicode dashes -> ASCII hyphen, special spaces -> regular space

- **`packages/coding-agent/src/core/tools/write.ts`** - Write tool definition and execution
  - `writeSchema` - TypeBox schema: `{ path: string, content: string }`
  - `createWriteToolDefinition()` - full tool definition
  - `execute()` - resolve path -> mkdir recursive -> writeFile -> report byte count
  - `WriteOperations` interface - pluggable `writeFile`/`mkdir` for remote delegation

- **`packages/coding-agent/src/core/tools/file-mutation-queue.ts`** - Serialize concurrent writes
  - `fileMutationQueues` - `Map<string, Promise<void>>` keyed by resolved real path
  - `getMutationQueueKey()` - `resolve()` then `realpathSync.native()` (falls back to resolved path if file doesn't exist yet)
  - `withFileMutationQueue()` - chain operations per file via promise chaining; different files run in parallel

## Node.js API References

- **fs/promises.writeFile**: https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options
- **fs/promises.readFile**: https://nodejs.org/api/fs.html#fspromisesreadfilepath-options
- **fs/promises.mkdir**: https://nodejs.org/api/fs.html#fspromisesmkdirpath-options
- **fs/promises.access**: https://nodejs.org/api/fs.html#fspromisesaccesspath-mode
- **fs.constants**: https://nodejs.org/api/fs.html#file-access-constants

## External Dependencies

- **diff** (npm) - `Diff.diffLines()` for generating unified diff output

## Key Design Decisions

| Decision                                       | Rationale                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Exact text replacement instead of diff/patch   | LLMs generate diffs poorly (wrong line numbers, bad context); exact string matching is deterministic and verifiable |
| All edits matched against original content     | Prevents cascading offset errors; each edit is independent of others                                                |
| Edits applied in reverse offset order          | Preserves string indices for earlier edits when applying later ones                                                 |
| Uniqueness check (exactly 1 occurrence)        | Ambiguous matches would apply edits to wrong locations; forces LLM to provide enough context                        |
| Overlap detection between edits                | Overlapping edits have undefined semantics; force merge into single edit                                            |
| FileMutationQueue per-file serialization       | Parallel tool calls may target the same file; read-modify-write must be atomic per file                             |
| BOM stripping before matching                  | LLM never sees or generates BOM characters; matching would fail without stripping                                   |
| Line ending normalization (CRLF -> LF -> CRLF) | LLM generates LF; file may use CRLF; normalize for matching, restore for writing                                    |
| Fuzzy matching as fallback                     | Handles minor Unicode differences (smart quotes, special spaces) the LLM may introduce                              |
| `prepareArguments` compatibility shim          | Some models send legacy single-edit format or JSON-string edits; normalize before validation                        |
| Write tool uses `mkdir -p` semantics           | Creating a file in a new directory should just work; no need for separate mkdir tool                                |
| Write tool reports byte count                  | Gives LLM confirmation of successful write with verifiable size                                                     |

## Edit Tool Error Taxonomy

| Error               | Condition                                  | Message Pattern                                   |
| ------------------- | ------------------------------------------ | ------------------------------------------------- |
| Empty oldText       | `oldText.length === 0`                     | `oldText must not be empty in {path}`             |
| Not found           | 0 occurrences in file                      | `Could not find the exact text in {path}`         |
| Duplicate           | >1 occurrences                             | `Found {n} occurrences ... must be unique`        |
| Overlap             | Two edits' matched regions intersect       | `edits[i] and edits[j] overlap`                   |
| No change           | All replacements produce identical content | `No changes made to {path}`                       |
| File not accessible | `access()` throws                          | `Could not edit file: {path}. Error code: {code}` |
