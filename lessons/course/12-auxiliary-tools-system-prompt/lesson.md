# 第十二课: 辅助工具与系统提示词工程

## 概述

前面的课程中，我们构建了 Agent 的核心循环、工具执行和测试框架。但到目前为止，Agent 只有 read、bash、edit、write 这四个核心工具。真实的编程 Agent 还需要**文件搜索能力**: 在大型代码库中快速定位文件和内容。

本课覆盖两个紧密相关的主题:

1. **辅助工具 (Auxiliary Tools)**: grep、find、ls -- 三个文件探索工具的设计与实现
2. **系统提示词工程 (System Prompt Engineering)**: `buildSystemPrompt()` 如何将工具列表、使用指南、项目上下文组装成结构化的系统提示词

这两个主题之所以放在一起，是因为工具和系统提示词是双向关联的:

- 每个工具通过 `promptSnippet` 和 `promptGuidelines` 声明自己在提示词中的呈现方式
- `buildSystemPrompt()` 根据当前激活的工具集动态生成提示词
- 工具集变化时，提示词必须同步重建

本课目标:

1. 理解 grep、find、ls 三个辅助工具的参数设计和输出格式
2. 掌握截断 (truncation) 策略: 为什么需要、如何实现
3. 理解工具分组: 默认激活 vs 可选激活
4. 掌握 `buildSystemPrompt()` 的五段式结构
5. 理解项目上下文发现机制: `AGENTS.md` / `CLAUDE.md` 的向上搜索
6. 实现完整的辅助工具和系统提示词构建器

---

## 1. 为什么需要辅助工具

### bash 不够吗?

Agent 拥有 bash 工具后，理论上可以执行 `grep`、`find`、`ls` 等命令。但实践中存在问题:

| 问题                  | 说明                                                            |
| --------------------- | --------------------------------------------------------------- |
| **输出爆炸**          | `grep -r "import" .` 在大项目中可能返回数万行，撑爆上下文窗口   |
| **格式不一致**        | 不同操作系统的 `ls`、`find` 输出格式不同，LLM 需要适配          |
| **.gitignore 不尊重** | 原生 `grep` 不会跳过 `node_modules`，结果充斥噪音               |
| **无截断控制**        | bash 工具可以截断总输出，但无法控制匹配数、单行长度等细粒度限制 |
| **错误处理差**        | bash 的 exit code 语义模糊，专用工具可以返回结构化的错误信息    |

专用的辅助工具解决了这些问题: 自动尊重 `.gitignore`，内置截断预算，统一的输出格式，精确的错误信息。

### 工具分组: 默认 vs 可选

Pi 将工具分为两组:

```
默认激活: read, bash, edit, write     -- 核心四件套，始终可用
可选激活: grep, find, ls              -- 辅助工具，可单独启用/禁用
```

可选工具的存在增加了上下文窗口的消耗 (每个工具的 schema 和 description 都占 token)，所以让用户根据需求选择。当辅助工具被激活时，系统提示词会自动添加一条指南: "Prefer grep/find/ls tools over bash for file exploration"。

---

## 2. 截断策略: 保护上下文窗口

辅助工具最重要的设计决策是**截断 (truncation)**。LLM 的上下文窗口是有限的，工具输出如果太大，会挤占后续对话的空间，甚至导致 API 报错。

### 双重截断预算

Pi 的所有辅助工具共享一套截断机制，有两个独立的上限，哪个先到就截断:

```
行数上限: DEFAULT_MAX_LINES = 2000
字节上限: DEFAULT_MAX_BYTES = 50KB (50 * 1024)
```

此外，每个工具还有自己的条目上限:

| 工具 | 条目上限  | 说明                         |
| ---- | --------- | ---------------------------- |
| grep | 100 匹配  | 超过后终止 ripgrep 进程      |
| find | 1000 结果 | 通过 `fd --max-results` 控制 |
| ls   | 500 条目  | 遍历时计数控制               |

### 截断方向: Head vs Tail

截断可以从头部或尾部进行:

- **`truncateHead()`**: 保留前 N 行/字节。用于 grep、find、ls、read -- 用户通常想看开头
- **`truncateTail()`**: 保留后 N 行/字节。用于 bash -- 错误信息和最终结果通常在末尾

```typescript
// 简化版 truncateHead
function truncateHead(
  content: string,
  options: { maxLines?: number; maxBytes?: number } = {}
): TruncationResult {
  const maxLines = options.maxLines ?? 2000;
  const maxBytes = options.maxBytes ?? 50 * 1024;
  const lines = content.split("\n");
  const totalBytes = Buffer.byteLength(content, "utf-8");

  // 不需要截断
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, ... };
  }

  // 逐行累加，检查两个上限
  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0);
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLines.push(lines[i]);
    outputBytes += lineBytes;
  }

  return {
    content: outputLines.join("\n"),
    truncated: true,
    truncatedBy,
    totalLines: lines.length,
    totalBytes,
    outputLines: outputLines.length,
    outputBytes,
  };
}
```

关键设计: **永远不截断半行**。如果一行加上去会超过字节上限，就整行丢弃。这避免了 LLM 看到不完整的代码行。

### Grep 的额外保护: 单行截断

Grep 匹配到的行可能非常长 (比如压缩过的 JSON 文件)。所以 grep 还有一层单行截断:

```typescript
const GREP_MAX_LINE_LENGTH = 500;

function truncateLine(
  line: string,
  maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) {
    return { text: line, wasTruncated: false };
  }
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
```

### 截断通知

截断发生后，工具会在输出末尾追加通知，告诉 LLM 发生了什么以及如何获取更多数据:

```
src/agent.ts:42: export class Agent {
src/agent.ts:100: private processEvents() {
...

[100 matches limit reached. Use limit=200 for more, or refine pattern. 50.0KB limit reached]
```

这些通知是**可操作的**: LLM 看到后可以调整参数重试。

---

## 3. Grep 工具: 文件内容搜索

### 参数 Schema

```typescript
const grepSchema = {
  pattern: string,          // 搜索模式 (正则或字面量)
  path?: string,            // 搜索目录或文件 (默认: cwd)
  glob?: string,            // 文件名过滤，如 "*.ts"
  ignoreCase?: boolean,     // 大小写不敏感 (默认: false)
  literal?: boolean,        // 字面量模式，不解释为正则 (默认: false)
  context?: number,         // 匹配行前后的上下文行数 (默认: 0)
  limit?: number,           // 最大匹配数 (默认: 100)
};
```

### 执行流程

```
1. 解析参数，解析路径 (resolveToCwd)
2. 确保 ripgrep (rg) 可用 (ensureTool)
3. 构建 rg 命令行参数:
   rg --json --line-number --color=never --hidden [--ignore-case] [--fixed-strings] [--glob *.ts] -- pattern searchPath
4. 启动子进程，逐行解析 JSON 输出
5. 每个 match 事件提取: filePath, lineNumber, lineText
6. 达到 limit 时 kill 子进程
7. 格式化匹配行 (带或不带上下文)
8. 应用截断: 单行截断 + 全局截断
9. 追加截断通知
```

### 输出格式

无上下文时:

```
src/tools/grep.ts:38: const DEFAULT_LIMIT = 100;
src/tools/find.ts:30: const DEFAULT_LIMIT = 1000;
```

有上下文 (`context: 1`) 时:

```
src/tools/grep.ts-37- export type GrepToolInput = Static<typeof grepSchema>;
src/tools/grep.ts:38: const DEFAULT_LIMIT = 100;
src/tools/grep.ts-39-
```

格式说明: 匹配行用 `:lineNumber:` 分隔，上下文行用 `-lineNumber-` 分隔。这和 `grep -n` 的格式一致，LLM 已经很熟悉。

### 可插拔操作 (Pluggable Operations)

```typescript
interface GrepOperations {
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  readFile: (absolutePath: string) => Promise<string> | string;
}
```

Pi 的每个辅助工具都定义了一个 `*Operations` 接口。默认实现使用本地文件系统，但可以替换为 SSH、Docker 容器等远程后端。这是一个很好的可扩展性设计。

---

## 4. Find 工具: 文件名搜索

### 参数 Schema

```typescript
const findSchema = {
  pattern: string,    // glob 模式，如 "*.ts", "**/*.spec.ts", "src/**/*.json"
  path?: string,      // 搜索目录 (默认: cwd)
  limit?: number,     // 最大结果数 (默认: 1000)
};
```

### 执行流程

```
1. 解析参数，解析路径
2. 如果有自定义 FindOperations.glob()，使用它 (远程后端)
3. 否则，确保 fd 可用 (ensureTool)
4. 构建 fd 命令行:
   fd --glob --color=never --hidden --no-require-git --max-results 1000 [--full-path] -- pattern searchPath
5. 读取输出，每行一个文件路径
6. 将绝对路径转为相对路径 (toPosixPath)
7. 应用截断
8. 追加截断通知
```

### 路径模式处理

Find 工具需要处理一个细节: `fd --glob` 默认只匹配文件名 (basename)，但如果 pattern 包含 `/`，说明用户想匹配路径，需要启用 `--full-path` 并补上 `**/` 前缀:

```typescript
let effectivePattern = pattern;
if (pattern.includes("/")) {
  args.push("--full-path");
  if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
    effectivePattern = `**/${pattern}`;
  }
}
```

### 输出格式

```
src/core/tools/grep.ts
src/core/tools/find.ts
src/core/tools/ls.ts
src/core/system-prompt.ts
```

简单的每行一个相对路径，使用 POSIX 风格 (`/`) 分隔。

### 我们的简化实现: 用 glob 包

Pi 在默认实现中使用 `fd` 命令行工具。对于教学目的，我们用 Node.js 的 `glob` 包实现同样的功能:

```typescript
import { glob } from "glob";

const results = await glob(pattern, {
  cwd: searchPath,
  ignore: ["**/node_modules/**", "**/.git/**"],
  dot: true, // 包含 dotfiles
  nodir: true, // 只匹配文件，不匹配目录
});
```

`glob` 包支持标准的 glob 语法 (`*`, `**`, `{a,b}`)，通过 `ignore` 选项模拟 `.gitignore` 的效果。

---

## 5. Ls 工具: 目录列表

### 参数 Schema

```typescript
const lsSchema = {
  path?: string,     // 目录路径 (默认: cwd)
  limit?: number,    // 最大条目数 (默认: 500)
};
```

### 执行流程

Ls 是三个辅助工具中最简单的，不需要外部命令行工具:

```
1. 解析路径
2. 检查路径存在且是目录
3. readdir() 读取条目
4. 按字母排序 (大小写不敏感)
5. 对每个条目 stat() 判断是否目录，加 "/" 后缀
6. 应用条目上限和截断
7. 追加截断通知
```

### 输出格式

```
.gitignore
README.md
node_modules/
package.json
src/
tsconfig.json
```

目录条目带 `/` 后缀，文件没有。包含 dotfiles (`.gitignore` 等)。

### 可插拔操作

```typescript
interface LsOperations {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  stat: (
    absolutePath: string,
  ) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  readdir: (absolutePath: string) => Promise<string[]> | string[];
}
```

---

## 6. ToolDefinition 的提示词元数据

每个工具除了 `name`、`description`、`parameters`、`execute` 之外，还有两个提示词相关的字段:

```typescript
interface ToolDefinition {
  name: string;
  description: string;            // 完整描述，包含在 LLM 的 tool schema 中
  promptSnippet?: string;         // 一行摘要，显示在系统提示词的 "Available tools" 列表中
  promptGuidelines?: string[];    // 指南条目，追加到系统提示词的 "Guidelines" 部分
  parameters: TSchema;
  execute(...): Promise<ToolResult>;
}
```

**`promptSnippet`**: 简短的一行描述，用于系统提示词的工具列表:

```
Available tools:
- read: Read files and images
- bash: Execute shell commands
- grep: Search file contents for patterns (respects .gitignore)
- find: Find files by glob pattern (respects .gitignore)
- ls: List directory contents
```

**`promptGuidelines`**: 当该工具激活时，额外追加到 Guidelines 部分的指南。比如 bash 工具可能添加 "Use bash for system commands, not for file content search"。

这种设计让工具自己声明在提示词中如何呈现，而不是让 `buildSystemPrompt()` 硬编码每个工具的描述。新增工具时只需设置这两个字段，不需要修改提示词构建逻辑。

---

## 7. buildSystemPrompt(): 结构化构建

`buildSystemPrompt()` 是系统提示词的核心构建器。它接收工具列表、上下文文件等输入，输出完整的系统提示词字符串。

### 五段式结构

```
+-----------------------------------+
| 1. 角色描述                        |   "You are an expert coding assistant..."
+-----------------------------------+
| 2. 可用工具列表                     |   每个工具的 promptSnippet 一行
+-----------------------------------+
| 3. 使用指南                        |   工具的 promptGuidelines + 通用规则
+-----------------------------------+
| 4. 项目上下文                      |   AGENTS.md / CLAUDE.md 内容
+-----------------------------------+
| 5. 日期与工作目录                   |   Current date + cwd
+-----------------------------------+
```

### 输入参数

```typescript
interface BuildSystemPromptOptions {
  customPrompt?: string; // 自定义提示词 (替换默认)
  selectedTools?: string[]; // 激活的工具名列表
  toolSnippets?: Record<string, string>; // 工具名 -> promptSnippet
  promptGuidelines?: string[]; // 额外指南条目
  appendSystemPrompt?: string; // 追加文本
  cwd: string; // 工作目录
  contextFiles?: Array<{ path: string; content: string }>; // 上下文文件
  skills?: Skill[]; // 技能列表
}
```

### 构建逻辑

```typescript
function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const {
    customPrompt,
    selectedTools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    contextFiles,
    skills,
  } = options;

  // 格式化日期和路径
  const date = formatDate(new Date()); // "2025-01-15"
  const promptCwd = cwd.replace(/\\/g, "/"); // Windows 反斜杠转正斜杠

  // -- 自定义提示词路径 --
  if (customPrompt) {
    let prompt = customPrompt;
    if (appendSystemPrompt) prompt += "\n\n" + appendSystemPrompt;
    if (contextFiles?.length) {
      prompt += "\n\n# Project Context\n\n";
      for (const { path, content } of contextFiles) {
        prompt += `## ${path}\n\n${content}\n\n`;
      }
    }
    prompt += `\nCurrent date: ${date}`;
    prompt += `\nCurrent working directory: ${promptCwd}`;
    return prompt;
  }

  // -- 默认提示词路径 --

  // 1. 工具列表
  const tools = selectedTools || ["read", "bash", "edit", "write"];
  const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
      : "(none)";

  // 2. 指南 (带去重)
  const guidelines: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (g: string) => {
    if (!seen.has(g)) {
      seen.add(g);
      guidelines.push(g);
    }
  };

  // 工具相关指南
  const hasBash = tools.includes("bash");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");
  const hasLs = tools.includes("ls");

  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
  }

  // 自定义指南
  for (const g of promptGuidelines ?? []) {
    if (g.trim()) addGuideline(g.trim());
  }

  // 通用指南
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");

  const guidelinesText = guidelines.map((g) => `- ${g}`).join("\n");

  // 3. 组装
  let prompt = `You are an expert coding assistant...

Available tools:
${toolsList}

Guidelines:
${guidelinesText}`;

  if (appendSystemPrompt) prompt += "\n\n" + appendSystemPrompt;

  // 4. 项目上下文
  if (contextFiles?.length) {
    prompt += "\n\n# Project Context\n\n";
    for (const { path, content } of contextFiles) {
      prompt += `## ${path}\n\n${content}\n\n`;
    }
  }

  // 5. 日期与工作目录 (始终在最后)
  prompt += `\nCurrent date: ${date}`;
  prompt += `\nCurrent working directory: ${promptCwd}`;

  return prompt;
}
```

### 关键设计决策

**1. 日期和 cwd 在最后**

系统提示词的结尾是 LLM 最"新鲜"的记忆。把日期和工作目录放在最后，确保 LLM 始终能正确回忆当前上下文。

**2. 指南去重**

多个工具可能声明相同的 guideline。使用 Set 去重避免重复，保持提示词简洁。

**3. 条件指南**

不是简单地列出所有规则，而是根据工具集动态调整:

- 只有 bash -> "Use bash for file operations"
- 有 bash + grep -> "Prefer grep over bash"
- 没有 bash -> 不添加任何文件操作指南

这种条件逻辑避免了给 LLM 无用的指令 (比如推荐一个不存在的工具)。

**4. 自定义提示词不丢失上下文**

即使用户提供了完全自定义的 `customPrompt`，项目上下文文件、日期和 cwd 仍然会被追加。这确保 LLM 无论在什么提示词下都知道自己在哪个项目中工作。

---

## 8. 项目上下文发现: AGENTS.md / CLAUDE.md

### 发现机制

`loadProjectContextFiles()` 通过向上遍历目录树来发现项目上下文文件:

```typescript
function loadProjectContextFiles(options: {
  cwd: string;
  agentDir: string;
}): Array<{ path: string; content: string }> {
  const contextFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  // 1. 全局配置目录
  const globalContext = loadContextFileFromDir(options.agentDir);
  if (globalContext) {
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  // 2. 从 cwd 向上遍历到根目录
  const ancestorFiles: Array<{ path: string; content: string }> = [];
  let currentDir = options.cwd;
  const root = path.resolve("/");

  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      ancestorFiles.unshift(contextFile); // 外层在前
      seenPaths.add(contextFile.path);
    }
    if (currentDir === root) break;
    const parentDir = path.resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  contextFiles.push(...ancestorFiles);
  return contextFiles;
}
```

### 文件候选列表

每个目录检查这些文件名 (按优先级):

```
AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD
```

每个目录只取第一个存在的。

### 排列顺序

```
[全局配置] -> [根目录] -> [中间目录] -> ... -> [cwd]
```

最外层的文件排在最前面。这意味着如果 monorepo 根目录和子包目录都有 `AGENTS.md`，两个都会被加载，根目录的在前。在系统提示词中，这表现为:

```
# Project Context

## /home/user/myproject/AGENTS.md
(monorepo 级别的规则)

## /home/user/myproject/packages/api/AGENTS.md
(子包级别的规则)
```

LLM 会同时看到两组规则。子包的规则可以补充或细化根目录的规则。

### 为什么叫 AGENTS.md / CLAUDE.md

`AGENTS.md` 是 Pi 定义的约定文件名。`CLAUDE.md` 是 Anthropic 的 Claude Code 使用的约定文件名。Pi 同时支持两者，这样从 Claude Code 迁移过来的项目不需要改文件名。

---

## 9. 动态重建: 工具变化时重建提示词

系统提示词不是静态的。当用户启用或禁用工具时，提示词必须重建:

```typescript
// 伪代码: Agent 会话中的工具变化处理
class AgentSession {
  private tools: Map<string, ToolDefinition> = new Map();
  private systemPromptCache: string | null = null;

  addTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    this.systemPromptCache = null; // 使缓存失效
  }

  removeTool(name: string): void {
    this.tools.delete(name);
    this.systemPromptCache = null; // 使缓存失效
  }

  getSystemPrompt(): string {
    if (this.systemPromptCache) return this.systemPromptCache;

    // 从当前工具集提取 snippets 和 guidelines
    const toolSnippets: Record<string, string> = {};
    const promptGuidelines: string[] = [];
    for (const [name, tool] of this.tools) {
      if (tool.promptSnippet) toolSnippets[name] = tool.promptSnippet;
      for (const g of tool.promptGuidelines ?? []) {
        promptGuidelines.push(g);
      }
    }

    this.systemPromptCache = buildSystemPrompt({
      selectedTools: [...this.tools.keys()],
      toolSnippets,
      promptGuidelines,
      cwd: this.cwd,
      contextFiles: this.contextFiles,
    });

    return this.systemPromptCache;
  }
}
```

每次工具集变化时，缓存失效，下一次调用 `getSystemPrompt()` 会重新构建。这确保 LLM 看到的工具列表和指南始终与实际可用的工具一致。

---

## 10. 完整伪代码

### Grep 工具

```typescript
import { type TSchema } from "typebox";

const GREP_MAX_LINE_LENGTH = 500;
const DEFAULT_MATCH_LIMIT = 100;
const DEFAULT_MAX_BYTES = 50 * 1024;

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

interface GrepOperations {
  isDirectory(path: string): boolean | Promise<boolean>;
  readFile(path: string): string | Promise<string>;
}

function createGrepTool(cwd: string, ops?: GrepOperations) {
  return {
    name: "grep",
    promptSnippet: "Search file contents for patterns (respects .gitignore)",

    async execute(input: GrepInput): Promise<ToolResult> {
      const searchPath = resolveToCwd(input.path || ".", cwd);
      const limit = input.limit ?? DEFAULT_MATCH_LIMIT;

      // 1. 启动 ripgrep 子进程
      const args = ["--json", "--line-number", "--color=never", "--hidden"];
      if (input.ignoreCase) args.push("--ignore-case");
      if (input.literal) args.push("--fixed-strings");
      if (input.glob) args.push("--glob", input.glob);
      args.push("--", input.pattern, searchPath);

      const child = spawn("rg", args);

      // 2. 解析 JSON 输出，收集匹配
      const matches: Match[] = [];
      for await (const line of readLines(child.stdout)) {
        const event = JSON.parse(line);
        if (event.type === "match") {
          matches.push({
            filePath: event.data.path.text,
            lineNumber: event.data.line_number,
            lineText: event.data.lines.text,
          });
          if (matches.length >= limit) {
            child.kill();
            break;
          }
        }
      }

      if (matches.length === 0) return { text: "No matches found" };

      // 3. 格式化输出
      const outputLines: string[] = [];
      for (const match of matches) {
        const relativePath = path.relative(searchPath, match.filePath);
        const { text } = truncateLine(match.lineText.trimEnd(), GREP_MAX_LINE_LENGTH);
        outputLines.push(`${relativePath}:${match.lineNumber}: ${text}`);
      }

      // 4. 全局截断
      const result = truncateHead(outputLines.join("\n"), { maxLines: Infinity });

      // 5. 追加通知
      const notices: string[] = [];
      if (matches.length >= limit) notices.push(`${limit} matches limit reached`);
      if (result.truncated) notices.push("50.0KB limit reached");

      let output = result.content;
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      return { text: output };
    },
  };
}
```

### Find 工具

```typescript
import { glob } from "glob";

const DEFAULT_FIND_LIMIT = 1000;

interface FindInput {
  pattern: string;
  path?: string;
  limit?: number;
}

function createFindTool(cwd: string) {
  return {
    name: "find",
    promptSnippet: "Find files by glob pattern (respects .gitignore)",

    async execute(input: FindInput): Promise<ToolResult> {
      const searchPath = resolveToCwd(input.path || ".", cwd);
      const limit = input.limit ?? DEFAULT_FIND_LIMIT;

      // 使用 glob 包搜索
      const results = await glob(input.pattern, {
        cwd: searchPath,
        ignore: ["**/node_modules/**", "**/.git/**"],
        dot: true,
        nodir: true,
      });

      if (results.length === 0) return { text: "No files found matching pattern" };

      // 转为 POSIX 路径
      const paths = results.slice(0, limit).map((p) => p.replace(/\\/g, "/"));

      // 截断
      const rawOutput = paths.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Infinity });

      let output = truncation.content;
      const notices: string[] = [];
      if (paths.length >= limit) notices.push(`${limit} results limit reached`);
      if (truncation.truncated) notices.push("50.0KB limit reached");
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

      return { text: output };
    },
  };
}
```

### Ls 工具

```typescript
const DEFAULT_LS_LIMIT = 500;

interface LsInput {
  path?: string;
  limit?: number;
}

function createLsTool(cwd: string) {
  return {
    name: "ls",
    promptSnippet: "List directory contents",

    async execute(input: LsInput): Promise<ToolResult> {
      const dirPath = resolveToCwd(input.path || ".", cwd);
      const limit = input.limit ?? DEFAULT_LS_LIMIT;

      if (!existsSync(dirPath)) throw new Error(`Path not found: ${dirPath}`);

      const stat = statSync(dirPath);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);

      const entries = readdirSync(dirPath);
      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const results: string[] = [];
      for (const entry of entries) {
        if (results.length >= limit) break;
        const fullPath = path.join(dirPath, entry);
        try {
          const entryStat = statSync(fullPath);
          results.push(entry + (entryStat.isDirectory() ? "/" : ""));
        } catch {
          continue; // 跳过无法 stat 的条目
        }
      }

      if (results.length === 0) return { text: "(empty directory)" };

      const rawOutput = results.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Infinity });

      let output = truncation.content;
      if (results.length >= limit || truncation.truncated) {
        const notices: string[] = [];
        if (results.length >= limit) notices.push(`${limit} entries limit reached`);
        if (truncation.truncated) notices.push("50.0KB limit reached");
        output += `\n\n[${notices.join(". ")}]`;
      }

      return { text: output };
    },
  };
}
```

### buildSystemPrompt 完整实现

```typescript
interface BuildSystemPromptOptions {
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd: string;
  contextFiles?: Array<{ path: string; content: string }>;
}

function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const {
    customPrompt,
    selectedTools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    contextFiles,
  } = options;

  const date = formatDate(new Date());
  const promptCwd = cwd.replace(/\\/g, "/");
  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

  // 自定义提示词路径
  if (customPrompt) {
    let prompt = customPrompt + appendSection;
    prompt += formatContextFiles(contextFiles);
    prompt += `\nCurrent date: ${date}`;
    prompt += `\nCurrent working directory: ${promptCwd}`;
    return prompt;
  }

  // 默认提示词路径
  const tools = selectedTools || ["read", "bash", "edit", "write"];
  const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
      : "(none)";

  // 构建指南 (带去重)
  const guidelinesList: string[] = [];
  const guidelinesSet = new Set<string>();
  const addGuideline = (g: string) => {
    if (guidelinesSet.has(g)) return;
    guidelinesSet.add(g);
    guidelinesList.push(g);
  };

  const hasBash = tools.includes("bash");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");
  const hasLs = tools.includes("ls");

  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline("Prefer grep/find/ls tools over bash for file exploration");
  }

  for (const g of promptGuidelines ?? []) {
    if (g.trim()) addGuideline(g.trim());
  }

  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");

  const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

  let prompt = `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

Guidelines:
${guidelines}`;

  prompt += appendSection;
  prompt += formatContextFiles(contextFiles);
  prompt += `\nCurrent date: ${date}`;
  prompt += `\nCurrent working directory: ${promptCwd}`;

  return prompt;
}

function formatContextFiles(files?: Array<{ path: string; content: string }>): string {
  if (!files?.length) return "";
  let section = "\n\n# Project Context\n\n";
  section += "Project-specific instructions and guidelines:\n\n";
  for (const { path, content } of files) {
    section += `## ${path}\n\n${content}\n\n`;
  }
  return section;
}

function formatDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
```

### loadProjectContextFiles 完整实现

```typescript
function loadProjectContextFiles(
  cwd: string,
  agentDir: string,
): Array<{ path: string; content: string }> {
  const contextFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  const CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

  function loadFromDir(dir: string): { path: string; content: string } | null {
    for (const filename of CANDIDATES) {
      const filePath = path.join(dir, filename);
      if (existsSync(filePath)) {
        try {
          return { path: filePath, content: readFileSync(filePath, "utf-8") };
        } catch {
          /* skip */
        }
      }
    }
    return null;
  }

  // 1. 全局配置目录
  const globalContext = loadFromDir(agentDir);
  if (globalContext) {
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  // 2. 从 cwd 向上遍历
  const ancestorFiles: typeof contextFiles = [];
  let currentDir = cwd;
  const root = path.resolve("/");

  while (true) {
    const file = loadFromDir(currentDir);
    if (file && !seenPaths.has(file.path)) {
      ancestorFiles.unshift(file); // 外层在前
      seenPaths.add(file.path);
    }
    if (currentDir === root) break;
    const parentDir = path.resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  contextFiles.push(...ancestorFiles);
  return contextFiles;
}
```

---

## 11. 完整架构图

```
                            ToolDefinition
                        +--------------------+
                        | name               |
                        | description        |
                        | promptSnippet   -------> buildSystemPrompt()
                        | promptGuidelines ------> buildSystemPrompt()
                        | parameters         |
                        | execute()          |
                        +--------------------+
                              |
              +---------------+---------------+
              |               |               |
         grep tool       find tool        ls tool
              |               |               |
    +-------------------+  glob/fd     readdirSync
    | rg --json         |  --glob      + statSync
    | + truncateLine()  |              + sort
    +-------------------+
              |               |               |
              +-------+-------+-------+-------+
                      |
               truncateHead()
          (50KB / 2000 lines budget)

  loadProjectContextFiles()
    |
    | 全局 agentDir -> 根目录 -> ... -> cwd
    | 每级查找 AGENTS.md / CLAUDE.md
    |
    v
  buildSystemPrompt()
    |
    +-- 1. 角色描述
    +-- 2. Available tools (toolSnippets)
    +-- 3. Guidelines (条件指南 + promptGuidelines + 通用)
    +-- 4. Project Context (contextFiles)
    +-- 5. Current date + cwd
```

---

## 动手练习

1. **运行 demo.ts，观察辅助工具输出**

   ```bash
   npx tsx src/demo.ts
   ```

   观察 grep、find、ls 三个工具的输出格式。确认截断通知是否出现（如果结果超出预算）。尝试修改 `DEFAULT_MAX_LINES` 为一个很小的值（如 5），重新运行，验证截断行为。

2. **用 grep 工具搜索项目中的特定模式**
   在 demo.ts 中调用 grep 工具，搜索 `import.*from` 模式，限制 `limit: 10`。验证：
   - 输出不超过 10 条匹配
   - 每行格式为 `相对路径:行号: 内容`
   - 单行超过 500 字符时被截断并标注 `[truncated]`

3. **构建不同工具配置下的系统提示词**
   调用 `buildSystemPrompt()` 三次，分别传入：
   - `selectedTools: ["read", "bash", "edit", "write"]` -- 仅核心工具
   - `selectedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"]` -- 全部工具
   - `selectedTools: ["read", "edit", "write"]` -- 无 bash
     对比三次输出的 Guidelines 部分，确认条件指南逻辑：第一种应包含 "Use bash for file operations"，第二种应包含 "Prefer grep/find/ls over bash"，第三种不应包含任何文件操作指南。

4. **测试项目上下文发现**
   在项目根目录创建一个 `AGENTS.md` 文件，写入一行 `# Test context`。调用 `loadProjectContextFiles()` 传入当前 cwd，验证返回的 contextFiles 数组包含你创建的文件。然后删除该文件。

---

## 12. 总结

本课覆盖了两个相辅相成的主题:

**辅助工具**:

- grep (内容搜索)、find (文件搜索)、ls (目录列表) 三个工具为 Agent 提供了结构化的文件探索能力
- 所有工具共享截断预算 (50KB / 2000行)，保护 LLM 的上下文窗口
- 可插拔的 Operations 接口支持远程后端
- 工具通过 `promptSnippet` 和 `promptGuidelines` 声明自己在提示词中的呈现

**系统提示词工程**:

- `buildSystemPrompt()` 采用五段式结构: 角色、工具、指南、上下文、元信息
- 指南是条件性的，根据工具集动态调整
- 项目上下文通过向上遍历目录树发现 `AGENTS.md` / `CLAUDE.md`
- 工具集变化时提示词必须重建，保持一致性
- 日期和工作目录放在最后，确保 LLM 始终能回忆当前上下文

下一课我们将进入 Agent 的交互模式架构，了解 TUI 如何与 Agent 核心协作。
