# Lesson 12: Auxiliary Tools and System Prompt Engineering -- Reference Materials

## Pi Source Code References

- **`packages/coding-agent/src/core/tools/grep.ts`** - Grep tool (regex content search)
  - `createGrepToolDefinition(cwd, options?)` - factory returning `ToolDefinition`
  - `grepSchema` - TypeBox schema: `pattern`, `path?`, `glob?`, `ignoreCase?`, `literal?`, `context?`, `limit?`
  - `GrepOperations` - pluggable `isDirectory()` + `readFile()` for remote backends
  - `DEFAULT_LIMIT = 100` - max matches before truncation
  - Delegates to `rg` (ripgrep) via `ensureTool("rg")`, parses `--json` output
  - `formatBlock()` - renders match lines with optional context lines (before/after)
  - Output: `relativePath:lineNumber: matchText`, long lines truncated to `GREP_MAX_LINE_LENGTH` (500 chars)
  - Byte truncation via `truncateHead()` with `DEFAULT_MAX_BYTES` (50KB)
  - `promptSnippet`: "Search file contents for patterns (respects .gitignore)"

- **`packages/coding-agent/src/core/tools/find.ts`** - Find tool (glob file search)
  - `createFindToolDefinition(cwd, options?)` - factory returning `ToolDefinition`
  - `findSchema` - TypeBox schema: `pattern`, `path?`, `limit?`
  - `FindOperations` - pluggable `exists()` + `glob()` for remote backends
  - `DEFAULT_LIMIT = 1000` - max results before truncation
  - Delegates to `fd` via `ensureTool("fd")`, uses `--glob --hidden --no-require-git`
  - Path-containing patterns get `--full-path` flag and `**/` prefix
  - Output: newline-separated relative paths, byte truncation via `truncateHead()`
  - `promptSnippet`: "Find files by glob pattern (respects .gitignore)"

- **`packages/coding-agent/src/core/tools/ls.ts`** - Ls tool (directory listing)
  - `createLsToolDefinition(cwd, options?)` - factory returning `ToolDefinition`
  - `lsSchema` - TypeBox schema: `path?`, `limit?`
  - `LsOperations` - pluggable `exists()` + `stat()` + `readdir()` for remote backends
  - `DEFAULT_LIMIT = 500` - max entries before truncation
  - Alphabetical sort (case-insensitive), directories get `/` suffix
  - Includes dotfiles, byte truncation via `truncateHead()`
  - `promptSnippet`: "List directory contents"

- **`packages/coding-agent/src/core/tools/truncate.ts`** - Shared truncation utilities
  - `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 * 1024`
  - `GREP_MAX_LINE_LENGTH = 500`
  - `truncateHead(content, options?)` - keep first N lines/bytes (for reads, grep, find)
  - `truncateTail(content, options?)` - keep last N lines/bytes (for bash output)
  - `truncateLine(line, maxChars?)` - single line truncation with `[truncated]` suffix
  - `TruncationResult` - `{ content, truncated, truncatedBy, totalLines, totalBytes, ... }`

- **`packages/coding-agent/src/core/tools/path-utils.ts`** - Path resolution
  - `resolveToCwd(filePath, cwd)` - resolve relative/absolute/~ paths against cwd
  - `expandPath(filePath)` - expand `~`, normalize unicode spaces, strip `@` prefix

- **`packages/coding-agent/src/core/system-prompt.ts`** - System prompt construction
  - `BuildSystemPromptOptions` - `customPrompt?`, `selectedTools?`, `toolSnippets?`, `promptGuidelines?`, `appendSystemPrompt?`, `cwd`, `contextFiles?`, `skills?`
  - `buildSystemPrompt(options)` - structured prompt assembly:
    1. Role description (expert coding assistant)
    2. Available tools list (from `toolSnippets` keyed by tool name)
    3. Guidelines (tool-dependent rules + custom `promptGuidelines` + defaults)
    4. Documentation pointers (readme, docs, examples paths)
    5. Append section (`appendSystemPrompt`)
    6. Project context files (`contextFiles` array of `{ path, content }`)
    7. Skills section (only when `read` tool is available)
    8. Date and working directory (always last)
  - Custom prompt path: replaces default structure, but still appends context files, skills, date/cwd
  - Conditional guidelines: e.g., "Prefer grep/find/ls tools over bash" only when those tools are active

- **`packages/coding-agent/src/core/resource-loader.ts`** - Resource and context loading
  - `loadProjectContextFiles({ cwd, agentDir })` - discovers `AGENTS.md` / `CLAUDE.md`
    - Checks global agent dir first, then walks from cwd up to filesystem root
    - Candidates per directory: `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`
    - Deduplicates by path, returns array of `{ path, content }`
    - Ancestor files are ordered root-first (outermost first)
  - `DefaultResourceLoader` - orchestrates extensions, skills, prompts, themes, context files
  - `DefaultResourceLoader.reload()` - full reload: resolves paths, loads extensions, skills, context files, system prompt

- **`packages/coding-agent/src/core/extensions/types.ts`** - ToolDefinition interface
  - `ToolDefinition.promptSnippet?` - one-line snippet for "Available tools" section in system prompt
  - `ToolDefinition.promptGuidelines?` - guideline bullets appended to Guidelines section when tool is active

## External Dependencies

- **glob** (npm): https://www.npmjs.com/package/glob
  - `glob(pattern, options?)` - async glob matching
  - Key options: `cwd`, `ignore`, `dot` (include dotfiles), `nodir`, `absolute`
  - Supports `**` for recursive matching, `{a,b}` for alternatives

- **ignore** (npm): https://www.npmjs.com/package/ignore
  - `.gitignore` parser and path filter
  - `ignore().add(patterns)` - load gitignore rules
  - `ig.ignores(path)` - test if a path should be ignored

- **ripgrep** (rg): https://github.com/BurntSushi/ripgrep
  - Pi's grep tool delegates to `rg --json` for structured output
  - Respects `.gitignore` by default, supports `--glob` for file filtering

- **fd**: https://github.com/sharkdp/fd
  - Pi's find tool delegates to `fd --glob` for file search
  - `--hidden` includes dotfiles, `--no-require-git` enables gitignore without git repo

## Key Design Patterns

| Pattern                          | Description                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Pluggable operations             | Each tool defines an `*Operations` interface (e.g., `GrepOperations`) so the same tool logic works over SSH or other remote backends        |
| Truncation budget                | All auxiliary tools share the same 50KB / 2000-line budget via `truncateHead()`. Grep adds a per-line 500-char limit                        |
| promptSnippet / promptGuidelines | Tools declare how they appear in the system prompt. The prompt builder consumes these declaratively                                         |
| Conditional guidelines           | `buildSystemPrompt()` emits different guideline bullets depending on which tools are active (e.g., grep+find present -> "prefer over bash") |
| Context file discovery           | Walk up from cwd to root, collecting `AGENTS.md` / `CLAUDE.md` at each level. Outermost files come first so inner files can override        |
| Dynamic prompt rebuild           | System prompt is rebuilt whenever tool set changes (e.g., user enables/disables grep), so the LLM always sees accurate tool descriptions    |
