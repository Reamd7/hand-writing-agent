// @my-agent/tools — Tool implementations
//
// Lesson 09: ToolDefinition abstraction + Read Tool
//   - types.ts: ToolDefinition, ExtensionContext, wrapToolDefinition
//   - read-tool.ts: Read tool (text + image files)
//   - truncate.ts: Truncation utilities
//   - path-utils.ts: Path resolution and security

export {
  wrapToolDefinition,
  wrapToolDefinitions,
} from "./types.js";

export type {
  AgentTool,
  ExtensionContext,
  ToolDefinition,
  TextContent,
  ImageContent,
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolExecutionMode,
} from "./types.js";

export {
  createReadToolDefinition,
  readSchema,
} from "./read-tool.js";

export type {
  ReadToolInput,
  ReadToolDetails,
  ReadOperations,
  ReadToolOptions,
} from "./read-tool.js";

export {
  truncateHead,
  truncateTail,
  formatSize,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
} from "./truncate.js";

export type {
  TruncationResult,
  TruncationOptions,
} from "./truncate.js";

export {
  expandPath,
  resolvePath,
  isWithinCwd,
} from "./path-utils.js";

// ---------------------------------------------------------------------------
// Lesson 10: Bash Tool
// ---------------------------------------------------------------------------

export {
  executeBash,
} from "./bash-tool.js";

export type {
  BashToolUpdate,
  BashToolResult,
  BashToolOptions,
} from "./bash-tool.js";

export {
  OutputAccumulator,
} from "./output-accumulator.js";

export type {
  OutputAccumulatorOptions,
  OutputSnapshot,
} from "./output-accumulator.js";

// ---------------------------------------------------------------------------
// Lesson 11: Edit & Write Tools
// ---------------------------------------------------------------------------

export {
  executeEdit,
  applyEditsToNormalizedContent,
  generateDiffString,
  prepareEditArguments,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  normalizeForFuzzyMatch,
  fuzzyFindText,
} from "./edit-tool.js";

export type {
  Edit,
  EditToolInput,
  EditResult,
} from "./edit-tool.js";

export {
  executeWrite,
} from "./write-tool.js";

export type {
  WriteToolInput,
  WriteResult,
} from "./write-tool.js";

export {
  withFileMutationQueue,
} from "./file-mutation-queue.js";
