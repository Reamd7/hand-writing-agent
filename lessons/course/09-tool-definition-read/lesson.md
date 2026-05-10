# 第九课: 工具定义系统与 Read Tool

## 概述

前面的课程中，我们构建了 Agent 的状态管理、事件循环和测试框架。Agent 的核心价值在于 **工具调用** -- LLM 通过调用工具与外部世界交互。本课将深入工具系统的架构设计，并以 Read Tool 为案例，完整实现一个生产级工具。

我们将学习:

1. 两层工具抽象: `ToolDefinition`（富层，含渲染和 prompt）vs `AgentTool`（薄层，运行时）
2. `wrapToolDefinition()` 适配器如何桥接两层
3. Zod/TypeBox schema 定义工具参数
4. Operations 接口: 可插拔 I/O（本地文件系统 / SSH / 远程）
5. 工具如何通过 `promptSnippet` 和 `promptGuidelines` 影响系统提示词
6. `executionMode`: 并行 vs 串行执行
7. Read Tool 完整实现: 路径解析、安全校验、文本截断、图片处理、abort 信号

---

## 1. 两层工具抽象

### 问题: 为什么需要两层?

Agent 运行时 (`packages/agent`) 只关心工具的名字、参数 schema 和执行函数。但实际的编码 Agent 还需要:

- **UI 渲染**: 工具调用和结果需要在 TUI 中展示（语法高亮、截断提示、图片预览）
- **Prompt 贡献**: 工具需要向系统提示词注入使用指南
- **执行模式控制**: 某些工具必须串行执行（如 bash），另一些可以并行（如 read）

这些关注点不属于底层 Agent 运行时，所以 pi 设计了两层抽象:

### AgentTool -- 薄层运行时接口

```typescript
// packages/agent/src/types.ts
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}

interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
}
```

`AgentTool` 是 Agent 循环直接消费的接口。它只包含执行所需的最小字段: `name`、`description`、`parameters`、`execute`。没有任何 UI 或 prompt 相关的概念。

### ToolDefinition -- 富层完整接口

```typescript
// packages/coding-agent/src/core/extensions/types.ts (简化)
interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  // === 基础字段 (与 AgentTool 共享) ===
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  prepareArguments?: (args: unknown) => Static<TParams>;
  executionMode?: "sequential" | "parallel";

  // === 执行 ===
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext, // <-- 额外的上下文参数
  ): Promise<AgentToolResult<TDetails>>;

  // === Prompt 贡献 ===
  promptSnippet?: string;
  promptGuidelines?: string[];

  // === UI 渲染 ===
  renderShell?: "default" | "self";
  renderCall?: (args, theme, context: ToolRenderContext) => Component;
  renderResult?: (result, options, theme, context: ToolRenderContext) => Component;
}
```

关键区别:

- `execute()` 多一个 `ctx: ExtensionContext` 参数，可以访问 cwd、model、UI 等
- `promptSnippet` 和 `promptGuidelines` 让工具向系统提示词注入内容
- `renderCall` 和 `renderResult` 控制工具在 TUI 中的显示方式

### 设计哲学

```
  ToolDefinition (coding-agent 层)
  ┌─────────────────────────────────┐
  │  name, description, parameters  │ ──┐
  │  label, execute()               │   │ wrapToolDefinition()
  │  executionMode                  │   │ 提取共享字段
  │  ─────────────────────────────  │   ▼
  │  promptSnippet                  │  AgentTool (agent 层)
  │  promptGuidelines               │  ┌───────────────────────┐
  │  renderCall()                   │  │  name, description    │
  │  renderResult()                 │  │  parameters, execute  │
  │  ctx: ExtensionContext          │  │  label                │
  └─────────────────────────────────┘  └───────────────────────┘
```

---

## 2. wrapToolDefinition() 适配器

两层之间的桥梁是一个极其简洁的适配器:

```typescript
// packages/coding-agent/src/core/tools/tool-definition-wrapper.ts
function wrapToolDefinition<TDetails = unknown>(
  definition: ToolDefinition<any, TDetails>,
  ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    execute: (toolCallId, params, signal, onUpdate) =>
      definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
  };
}
```

核心逻辑:

1. **复制共享字段**: name, label, description, parameters 等直接透传
2. **适配 execute 签名**: ToolDefinition.execute 有 5 个参数，AgentTool.execute 只有 4 个。适配器通过闭包注入 `ctx`
3. **丢弃 UI 字段**: renderCall, renderResult, promptSnippet 等不进入 AgentTool

`ctxFactory` 是一个工厂函数而非直接传入 ctx 对象。这是因为 `ExtensionContext` 在 session 生命周期中可能变化（切换 session、reload），工厂函数确保每次执行都获取最新的上下文。

还有一个反向适配器:

```typescript
function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as any,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    execute: async (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate),
  };
}
```

当外部传入 AgentTool（例如通过 API 覆盖），需要转成 ToolDefinition 以统一内部注册表。反向适配丢失了 ctx 参数和渲染函数，但这没关系 -- 外部 AgentTool 本来就没有这些。

---

## 3. Zod Schema 定义工具参数

### 为什么需要 Schema?

LLM 需要知道工具接受什么参数。Schema 同时服务于两个目的:

1. **LLM 侧**: 转换为 JSON Schema，嵌入 function calling 的 parameters 定义
2. **运行时侧**: 在执行前验证 LLM 返回的参数，提取 TypeScript 类型

pi 使用 TypeBox（产出 JSON Schema），但概念与 Zod 完全一致。我们的教学代码使用 Zod，因为 Zod 在社区中更普遍。

### 基本参数 Schema

```typescript
import { z } from "zod";

// Read tool 的参数 schema
const readSchema = z.object({
  path: z.string().describe("Path to the file to read (relative or absolute)"),
  offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
  limit: z.number().optional().describe("Maximum number of lines to read"),
});

// 提取 TypeScript 类型
type ReadInput = z.infer<typeof readSchema>;
// => { path: string; offset?: number; limit?: number }
```

### 嵌套与数组 Schema

更复杂的工具可能需要嵌套结构:

```typescript
const editSchema = z.object({
  path: z.string().describe("File path to edit"),
  edits: z
    .array(
      z.object({
        oldText: z.string().describe("Text to find"),
        newText: z.string().describe("Replacement text"),
      }),
    )
    .describe("List of edits to apply"),
  dryRun: z.boolean().optional().describe("Preview changes without applying"),
});
```

### Schema 到 JSON Schema 的转换

LLM provider 需要 JSON Schema 格式。Zod 可以通过 `zod-to-json-schema` 转换:

```typescript
import { zodToJsonSchema } from "zod-to-json-schema";

const jsonSchema = zodToJsonSchema(readSchema);
// 输出:
// {
//   type: "object",
//   properties: {
//     path: { type: "string", description: "Path to the file..." },
//     offset: { type: "number", description: "Line number..." },
//     limit: { type: "number", description: "Maximum number..." }
//   },
//   required: ["path"]
// }
```

TypeBox 天然产出 JSON Schema，不需要额外转换。这是 pi 选择 TypeBox 的原因之一。

---

## 4. Operations 接口: 可插拔 I/O

### 问题

Read Tool 需要读取文件。但 "读取文件" 这个操作在不同环境中有完全不同的实现:

- **本地**: `fs.readFile()`
- **SSH 远程**: 通过 SSH 连接读取远程文件
- **容器**: 通过 Docker exec 读取容器内文件
- **测试**: 返回预设内容，不接触真实文件系统

如果把 `fs.readFile()` 硬编码到工具里，就无法适应这些场景。

### 解决方案: Operations 接口

```typescript
// 定义操作接口
interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

// 默认实现: 本地文件系统
const defaultReadOperations: ReadOperations = {
  readFile: (path) => fsReadFile(path),
  access: (path) => fsAccess(path, constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};
```

工具创建时接收 operations:

```typescript
function createReadTool(
  cwd: string,
  options?: {
    operations?: ReadOperations;
    autoResizeImages?: boolean;
  },
) {
  const ops = options?.operations ?? defaultReadOperations;

  return {
    // ...
    async execute(toolCallId, params, signal) {
      // 使用 ops 而非直接调用 fs
      await ops.access(absolutePath);
      const buffer = await ops.readFile(absolutePath);
      const mimeType = ops.detectImageMimeType
        ? await ops.detectImageMimeType(absolutePath)
        : undefined;
      // ...
    },
  };
}
```

这就是经典的 **依赖注入**。调用者在创建工具时决定使用什么 I/O 实现，工具本身不关心底层细节。

---

## 5. promptSnippet 和 promptGuidelines

### 工具如何影响系统提示词

系统提示词不是静态的。它会根据当前激活的工具动态生成。每个工具可以贡献两部分内容:

**promptSnippet** -- 出现在 "Available Tools" 列表中的一行简介:

```
## Available Tools
- read: Read file contents
- edit: Edit files with find-and-replace
- bash: Execute shell commands
- grep: Search file contents with regex
```

**promptGuidelines** -- 出现在 "Guidelines" 章节中的使用指南:

```
## Guidelines
- Use read to examine files instead of cat or sed.
- Always verify file exists before editing.
- Prefer grep over bash grep for file searching.
```

### 在 ToolDefinition 中声明

```typescript
const readToolDefinition: ToolDefinition = {
  name: "read",
  label: "read",
  description: "Read the contents of a file...", // 发送给 LLM 的完整描述
  promptSnippet: "Read file contents", // 系统提示词中的简介
  promptGuidelines: ["Use read to examine files instead of cat or sed."],
  // ...
};
```

`description` 和 `promptSnippet` 的区别:

- `description` 是工具的 JSON Schema 描述，LLM 在每次 function calling 时都能看到
- `promptSnippet` 是系统提示词中的概览，帮助 LLM 快速了解有哪些工具可用

### 系统提示词构建流程

```
激活的工具列表 ──┐
                 │
系统提示词模板 ──┼──> 遍历每个工具
                 │    ├── 收集 promptSnippet -> "Available Tools" 部分
                 │    └── 收集 promptGuidelines -> "Guidelines" 部分
                 │
自定义指令 ──────┘──> 拼接最终系统提示词
```

这个设计的优雅之处在于: **工具是自描述的**。添加一个新工具不需要修改系统提示词模板，工具自己带着自己的使用说明。

---

## 6. executionMode: 并行 vs 串行

LLM 可能在一次回复中调用多个工具。执行策略有两种:

```typescript
type ToolExecutionMode = "sequential" | "parallel";
```

- **parallel**: 多个工具调用可以并发执行。适合只读操作（read, grep, find）
- **sequential**: 工具必须逐个执行。适合有副作用的操作（bash, edit, write）

每个工具可以通过 `executionMode` 声明自己的偏好:

```typescript
// Read tool -- 只读，可以并行
const readTool: ToolDefinition = {
  name: "read",
  executionMode: "parallel",
  // ...
};

// Bash tool -- 有副作用，必须串行
const bashTool: ToolDefinition = {
  name: "bash",
  executionMode: "sequential",
  // ...
};
```

当一批工具调用中混合了 parallel 和 sequential 工具时，Agent 循环的处理策略通常是: 所有工具降级为 sequential（保守策略），或者分组执行（先并行组，再串行组）。

---

## 7. Read Tool 完整实现

### 7.1 路径解析与安全

#### 路径解析链

用户（LLM）传入的路径可能是各种形式:

```
"src/index.ts"          -> 相对路径，需要相对 cwd 解析
"/home/user/file.txt"   -> 绝对路径，直接使用
"~/Documents/file.txt"  -> ~前缀，展开为 home 目录
"@src/file.ts"          -> @前缀（某些 LLM 习惯），需要去除
```

解析链:

```typescript
function expandPath(filePath: string): string {
  // 1. 去除 @ 前缀
  const normalized = filePath.startsWith("@") ? filePath.slice(1) : filePath;
  // 2. 展开 ~ 为 home 目录
  if (normalized === "~") return os.homedir();
  if (normalized.startsWith("~/")) return os.homedir() + normalized.slice(1);
  return normalized;
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  // 3. 如果是绝对路径，直接返回
  if (isAbsolute(expanded)) return expanded;
  // 4. 否则相对 cwd 解析
  return path.resolve(cwd, expanded);
}
```

#### 安全性: 路径必须在 cwd 内

在我们的教学实现中，我们添加了一个安全检查，确保解析后的路径不会逃逸到工作目录之外:

```typescript
function isWithinCwd(absolutePath: string, cwd: string): boolean {
  const resolved = path.resolve(absolutePath);
  const resolvedCwd = path.resolve(cwd);
  return resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd;
}
```

> **注意**: pi 的实际实现没有严格限制路径在 cwd 内，因为有些合理的操作需要读取 cwd 外的文件（如 ~/.config 中的配置）。但在教学和受限环境中，路径安全是重要的考量。

### 7.2 文本文件处理

文本文件读取的完整流程:

```
readFile(path) -> Buffer
    |
    v
buffer.toString("utf-8") -> 完整文本
    |
    v
split("\n") -> 所有行
    |
    v
应用 offset (1-indexed -> 0-indexed)
    |
    v
应用 limit (用户指定的行数限制)
    |
    v
truncateHead() -> 截断 (2000行 / 50KB)
    |
    v
添加行号前缀 "1: ...\n2: ...\n3: ..."
    |
    v
构建 continuation notice
    |
    v
返回 { content: [{ type: "text", text }], details }
```

#### 行号前缀

输出的每一行都带有行号前缀，方便 LLM 引用具体位置:

```
1: import { readFile } from "node:fs/promises";
2:
3: export async function loadConfig(path: string) {
4:   const content = await readFile(path, "utf-8");
5:   return JSON.parse(content);
6: }
```

#### 截断策略: truncateHead

文件可能很大。直接返回全部内容会导致:

- Context window 被不必要地占用
- LLM 处理大量文本时效果下降
- 响应延迟增加

`truncateHead()` 从文件头部截取，两个独立限制，先触发的生效:

```typescript
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

function truncateHead(content: string, options?: {
  maxLines?: number;
  maxBytes?: number;
}): TruncationResult {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = content.split("\n");
  const totalBytes = Buffer.byteLength(content, "utf-8");

  // 不需要截断
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, ... };
  }

  // 逐行累加，直到触发限制
  const outputLines: string[] = [];
  let outputBytes = 0;
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) break; // 字节限制
    outputLines.push(lines[i]);
    outputBytes += lineBytes;
  }

  return {
    content: outputLines.join("\n"),
    truncated: true,
    truncatedBy: outputLines.length >= maxLines ? "lines" : "bytes",
    totalLines: lines.length,
    outputLines: outputLines.length,
    ...
  };
}
```

关键设计决策:

- **不截断半行**: 即使字节限制恰好在一行中间触发，也丢弃整行而非截断
- **首行超限特殊处理**: 如果第一行就超过字节限制，返回空内容 + `firstLineExceedsLimit=true`，提示使用 bash fallback
- **双限制**: 2000 行的纯代码文件可能远小于 50KB，而单行超长的 JSON/minified 文件可能几十行就超过 50KB

#### Continuation Notice

截断后，输出末尾会附加继续阅读的提示:

```
[Showing lines 1-2000 of 5432. Use offset=2001 to continue.]
```

或者在字节限制触发时:

```
[Showing lines 1-847 of 5432 (50.0KB limit). Use offset=848 to continue.]
```

这给 LLM 提供了明确的 "下一步" 指令，形成分页读取模式。

### 7.3 图片文件处理

```
readFile(path) -> Buffer
    |
    v
detectImageMimeType(path) -> "image/png" | null
    |
    v (如果是图片)
buffer.toString("base64") -> base64 字符串
    |
    v
resizeImage({ data, mimeType }) -> ResizedImage | null
    |
    v
返回 [
  { type: "text", text: "Read image file [image/png]" },
  { type: "image", data: base64, mimeType: "image/png" }
]
```

MIME 检测使用 magic bytes（文件头部的字节签名）而非文件扩展名。这更可靠:

```typescript
const FILE_TYPE_SNIFF_BYTES = 4100;

async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
  const fd = await open(filePath, "r");
  const buffer = Buffer.alloc(FILE_TYPE_SNIFF_BYTES);
  const { bytesRead } = await fd.read(buffer, 0, FILE_TYPE_SNIFF_BYTES, 0);
  await fd.close();

  const fileType = await fileTypeFromBuffer(buffer.subarray(0, bytesRead));
  if (!fileType) return null;

  const supported = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  return supported.has(fileType.mime) ? fileType.mime : null;
}
```

只支持 4 种图片格式，因为这是主流 LLM vision API 的交集。

### 7.4 Abort Signal 标准模式

工具执行可能被用户中断（Ctrl+C）。正确处理 abort 是生产级工具的必备特征。pi 的 read tool 展示了标准的 abort 处理模式:

```typescript
async execute(toolCallId, params, signal) {
  return new Promise((resolve, reject) => {
    // 1. 预先检查: 如果已经 abort，直接拒绝
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }

    // 2. 设置 abort 标志和监听器
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(new Error("Operation aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // 3. 实际执行逻辑
    (async () => {
      try {
        await ops.access(absolutePath);
        if (aborted) return;           // <-- 每次 await 后检查

        const buffer = await ops.readFile(absolutePath);
        if (aborted) return;           // <-- 每次 await 后检查

        // ... 处理结果 ...

        // 4. 成功: 清理监听器，resolve
        signal?.removeEventListener("abort", onAbort);
        resolve({ content, details });
      } catch (error) {
        // 5. 失败: 清理监听器，reject（如果还没被 abort reject）
        signal?.removeEventListener("abort", onAbort);
        if (!aborted) reject(error);
      }
    })();
  });
}
```

四个关键步骤:

| 步骤         | 位置              | 作用                      |
| ------------ | ----------------- | ------------------------- |
| 预检查       | 函数开头          | 避免无意义的工作          |
| 注册监听器   | 开始执行前        | 响应运行中的取消          |
| await 后检查 | 每次异步操作后    | 避免在 abort 后继续处理   |
| 清理监听器   | resolve/reject 前 | 防止内存泄漏和重复 reject |

### 7.5 结果格式

工具返回标准的 `AgentToolResult`:

```typescript
interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[]; // 返回给 LLM 的内容
  details: T; // UI 渲染用的元数据
  terminate?: boolean; // 是否终止 agent 循环
}
```

Read tool 的具体返回:

**文本文件**:

```typescript
{
  content: [{
    type: "text",
    text: "1: import fs from 'node:fs';\n2: \n3: // ...\n\n[Showing lines 1-2000 of 5432. Use offset=2001 to continue.]"
  }],
  details: {
    truncation: {
      truncated: true,
      truncatedBy: "lines",
      totalLines: 5432,
      outputLines: 2000,
      // ...
    }
  }
}
```

**图片文件**:

```typescript
{
  content: [
    { type: "text", text: "Read image file [image/png]\n[Resized: 4000x3000 -> 2000x1500]" },
    { type: "image", data: "iVBORw0KGgo...", mimeType: "image/png" },
  ],
  details: undefined,
}
```

---

## 8. 完整伪代码

### ToolDefinition 接口

```
INTERFACE ToolDefinition<TParams, TDetails, TState>:
  // 基础
  name: string
  label: string
  description: string          // LLM function calling 描述
  parameters: TParams          // JSON Schema (TypeBox/Zod)

  // Prompt 贡献
  promptSnippet?: string       // "Available Tools" 列表中的一行
  promptGuidelines?: string[]  // "Guidelines" 中的使用指南

  // 执行
  executionMode?: "sequential" | "parallel"
  prepareArguments?: (raw) => validated
  execute(toolCallId, params, signal, onUpdate, ctx) => AgentToolResult

  // 渲染
  renderShell?: "default" | "self"
  renderCall?(args, theme, renderCtx) => Component
  renderResult?(result, options, theme, renderCtx) => Component
```

### Read Tool Schema

```
SCHEMA readSchema:
  path: STRING (required)    "Path to the file to read"
  offset: NUMBER (optional)  "Line number to start reading from (1-indexed)"
  limit: NUMBER (optional)   "Maximum number of lines to read"
```

### Read Tool Execute 伪代码

```
FUNCTION execute(toolCallId, {path, offset, limit}, signal, onUpdate, ctx):
  // 路径解析
  absolutePath = expandPath(path)   // 去@, 展开~
  absolutePath = resolve(cwd, absolutePath)  // 相对路径解析

  // Abort 预检查
  IF signal.aborted: THROW "Operation aborted"
  REGISTER abort listener

  // 文件可读性检查
  AWAIT ops.access(absolutePath)
  IF aborted: RETURN

  // MIME 检测
  mimeType = AWAIT ops.detectImageMimeType(absolutePath)

  IF mimeType IS NOT NULL:
    // === 图片路径 ===
    buffer = AWAIT ops.readFile(absolutePath)
    base64 = buffer.toBase64()
    resized = resizeImage(base64, mimeType, maxWidth=2000, maxHeight=2000)
    IF resized IS NULL:
      RETURN { content: [text("Image too large to resize")], details: undefined }
    RETURN {
      content: [
        text("Read image file [${mimeType}]"),
        image(resized.data, resized.mimeType)
      ],
      details: undefined
    }

  ELSE:
    // === 文本路径 ===
    buffer = AWAIT ops.readFile(absolutePath)
    allLines = buffer.toString("utf-8").split("\n")

    // 应用 offset (1-indexed)
    startLine = offset ? max(0, offset - 1) : 0
    IF startLine >= allLines.length:
      THROW "Offset beyond end of file"

    // 应用 limit
    IF limit IS DEFINED:
      selectedLines = allLines[startLine .. startLine + limit]
    ELSE:
      selectedLines = allLines[startLine ..]

    // 截断
    truncation = truncateHead(selectedLines.join("\n"))

    // 添加行号前缀
    numberedText = addLineNumbers(truncation.content, startLine + 1)

    // 添加 continuation notice
    IF truncation.truncated:
      nextOffset = startLine + truncation.outputLines + 1
      numberedText += "\n[Showing lines ... Use offset=${nextOffset} to continue.]"

    RETURN {
      content: [text(numberedText)],
      details: { truncation }
    }

  // 清理 abort listener
  REMOVE abort listener
```

---

## 动手练习

1. **运行 demo 的 7 个场景，验证 Read Tool 的完整功能**

   ```bash
   npx tsx src/demo.ts
   ```

   demo 包含 7 个场景: 读取小文件、读取大文件（触发截断）、指定 offset/limit 分页读取、读取图片文件、读取不存在的文件（错误处理）、abort 中断、路径安全校验。逐一检查每个场景的输出，确认行号前缀格式正确、截断提示包含 continuation notice。

2. **读取一个大文件，验证截断和分页机制**
   找到项目中一个超过 2000 行的文件（或用 `demo.ts` 中的生成脚本创建一个），用 Read Tool 读取它:

   ```bash
   npx tsx src/demo.ts large-file
   ```

   确认输出末尾出现类似 `[Showing lines 1-2000 of 5432. Use offset=2001 to continue.]` 的提示。然后修改 demo，传入 `offset: 2001` 再次读取，验证能从上次截断的位置继续:

   ```bash
   npx tsx src/demo.ts large-file-continued
   ```

   检查第二次读取的第一行行号是否为 `2001:`。

3. **为 Read Tool 添加对 SVG 图片的支持**
   在 `code/src/tools/read.ts` 的 `detectImageMimeType` 实现中，添加对 SVG 文件的识别逻辑（SVG 的 magic bytes 是 `<?xml` 或 `<svg`，MIME 类型为 `"image/svg+xml"`）。创建一个测试 SVG 文件，运行:

   ```bash
   npx tsx src/demo.ts svg
   ```

   验证输出中包含 `type: "image"` 内容块和正确的 MIME 类型。注意: 主流 LLM vision API 不支持 SVG，所以实际生产中需要考虑是否将 SVG 渲染为 PNG 后再返回。

4. **测试 Operations 接口的可插拔性**
   在 demo 中创建一个 mock 的 `ReadOperations` 实现，让 `readFile` 始终返回固定内容 `"mock content\nline 2\nline 3"`。用这个 mock 创建 Read Tool 并执行读取:
   ```bash
   npx tsx src/demo.ts mock-ops
   ```
   验证输出内容为 mock 数据而非真实文件内容，确认 Operations 接口的依赖注入正常工作。

---

## 9. 总结

### 架构关键点

| 概念            | 说明                                                             |
| --------------- | ---------------------------------------------------------------- |
| 两层抽象        | ToolDefinition 面向上层（UI + prompt），AgentTool 面向底层运行时 |
| 适配器模式      | wrapToolDefinition() 桥接两层，闭包注入 ExtensionContext         |
| Schema 驱动     | 参数定义同时服务于 LLM（JSON Schema）和运行时（类型安全）        |
| Operations 接口 | 依赖注入实现可插拔 I/O，解耦工具逻辑与环境细节                   |
| 自描述工具      | promptSnippet + promptGuidelines 让工具携带自己的使用说明        |
| Abort 标准模式  | 预检查 -> 注册 -> await 后检查 -> 清理                           |
| 双限制截断      | 行数限制 (2000) + 字节限制 (50KB)，先触发的生效                  |
| 分页读取        | 截断后提供 offset 参数，LLM 可以继续读取                         |

### 设计启发

1. **分层是为了关注点分离**: 运行时不需要知道 UI 如何渲染工具结果
2. **依赖注入让代码可测试**: Operations 接口让你可以用内存实现替换文件系统
3. **工具应该是自描述的**: 添加新工具不应该需要修改全局配置
4. **截断是生产必需的**: 没有截断的文件读取在真实项目中会立即击穿 context window
5. **Abort 处理是责任**: 长时间运行的工具必须尊重取消信号
