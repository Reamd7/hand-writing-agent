# Lesson 9: Tool Definition System and Read Tool -- Reference Materials

## Pi Source Code References

- **`packages/coding-agent/src/core/extensions/types.ts`** - ToolDefinition interface
  - `ToolDefinition<TParams, TDetails, TState>` - full tool definition with rendering, prompt, and execution
  - `ToolRenderContext<TState, TArgs>` - context passed to tool renderers (expanded, isPartial, invalidate, etc.)
  - `ToolRenderResultOptions` - expanded and isPartial flags for result rendering
  - `ExtensionContext` - passed to tool execute(), provides cwd, model, signal, UI access
  - `defineTool()` - helper to preserve type inference for standalone tool definitions
  - `promptSnippet` - one-line snippet for Available Tools section in system prompt
  - `promptGuidelines` - guideline bullets appended to system prompt Guidelines section
  - `executionMode` - per-tool override: "sequential" or "parallel"

- **`packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`** - Adapter layer
  - `wrapToolDefinition()` - converts ToolDefinition -> AgentTool (strips rendering, binds ctx)
  - `wrapToolDefinitions()` - batch wrapper for arrays
  - `createToolDefinitionFromAgentTool()` - reverse: synthesize minimal ToolDefinition from AgentTool

- **`packages/coding-agent/src/core/tools/read.ts`** - Read tool implementation
  - `createReadToolDefinition(cwd, options?)` - returns ToolDefinition with full rendering
  - `createReadTool(cwd, options?)` - returns AgentTool (wrapped)
  - `ReadOperations` interface - pluggable I/O: readFile, access, detectImageMimeType
  - `ReadToolOptions` - autoResizeImages, custom operations
  - `ReadToolDetails` - truncation metadata for UI rendering
  - `readSchema` - TypeBox schema: path (string), offset (optional number), limit (optional number)
  - Text path: readFile -> split lines -> apply offset -> truncateHead -> line-numbered output
  - Image path: readFile -> detectMimeType -> resizeImage -> base64 -> ImageContent

- **`packages/coding-agent/src/core/tools/truncate.ts`** - Truncation utilities
  - `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES = 50 * 1024`
  - `TruncationResult` - content, truncated, truncatedBy ("lines"|"bytes"), totalLines, outputLines, firstLineExceedsLimit
  - `truncateHead(content, options?)` - keep first N lines/bytes, for file reads
  - `truncateTail(content, options?)` - keep last N lines/bytes, for bash output
  - `truncateLine(line, maxChars?)` - single-line truncation for grep matches
  - `formatSize(bytes)` - human-readable byte formatting (B/KB/MB)

- **`packages/coding-agent/src/core/tools/path-utils.ts`** - Path resolution
  - `expandPath(filePath)` - normalize unicode spaces, strip @ prefix, expand ~
  - `resolveToCwd(filePath, cwd)` - expand + resolve relative to cwd
  - `resolveReadPath(filePath, cwd)` - resolveToCwd + macOS filename variant fallbacks (AM/PM, NFD, curly quotes)

- **`packages/coding-agent/src/utils/mime.ts`** - Image MIME detection
  - `detectSupportedImageMimeTypeFromFile(filePath)` - reads first 4100 bytes, uses file-type to sniff MIME
  - Supported: image/jpeg, image/png, image/gif, image/webp

- **`packages/agent/src/types.ts`** - Core agent types
  - `AgentTool<TParameters, TDetails>` extends `Tool<TParameters>` - slim runtime tool (no rendering)
  - `AgentToolResult<T>` - { content: (TextContent|ImageContent)[], details: T, terminate? }
  - `AgentToolUpdateCallback<T>` - callback for streaming partial tool results
  - `Tool<TParameters>` - base: { name, description, parameters }

- **`packages/ai/src/types.ts`** - AI SDK types
  - `Tool<TParameters>` - { name, description, parameters } (TSchema from TypeBox)
  - `TextContent` - { type: "text", text: string }
  - `ImageContent` - { type: "image", data: string, mimeType: string }

## External Documentation

- **Zod** (schema validation library): https://zod.dev/
  - `z.object({})` - object schema
  - `z.string()`, `z.number()`, `z.boolean()` - primitives
  - `z.optional()` - optional fields
  - `z.array()` - arrays
  - `z.describe()` - attach description for LLM parameter docs
  - `z.infer<typeof schema>` - extract TypeScript type from schema

- **TypeBox** (pi's actual schema library): https://github.com/sinclairzx81/typebox
  - `Type.Object({})` - object schema
  - `Type.String()`, `Type.Number()`, `Type.Boolean()` - primitives
  - `Type.Optional()` - optional fields
  - `Type.Array()` - arrays
  - `Static<typeof schema>` - extract TypeScript type from schema
  - TypeBox produces JSON Schema compatible output, used by LLM providers

- **Node.js fs API**: https://nodejs.org/api/fs.html
  - `fs/promises.readFile(path)` - async file read
  - `fs/promises.access(path, mode)` - async access check
  - `fs.constants.R_OK` - readable check flag

- **file-type**: https://github.com/sindresorhus/file-type
  - `fileTypeFromBuffer(buffer)` - detect MIME type from binary header bytes

## Key Architecture Patterns

| Pattern               | Description                                                                    |
| --------------------- | ------------------------------------------------------------------------------ |
| Two-layer abstraction | ToolDefinition (rich, UI+prompt) vs AgentTool (slim, runtime-only)             |
| Adapter pattern       | `wrapToolDefinition()` bridges the two layers                                  |
| Operations interface  | Pluggable I/O for local fs, SSH, remote -- dependency injection                |
| Prompt contribution   | Tools influence system prompt via promptSnippet and promptGuidelines           |
| Abort signal protocol | Check upfront, register listener, check after await, cleanup on resolve/reject |
| Head truncation       | Keep beginning of file; suitable for code reading                              |
| Tail truncation       | Keep end of output; suitable for bash command results                          |
| Path resolution chain | Expand ~ -> resolve to cwd -> try filesystem variant fallbacks                 |
