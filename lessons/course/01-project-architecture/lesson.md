# 第一课：项目架构与工程化搭建

## 学习目标

完成本课后，你将能够：

1. 理解 pi 的 5 包分层架构设计，以及为什么 agent 项目需要这种分层
2. 使用 npm workspaces 搭建 TypeScript monorepo
3. 配置 ESM、TypeScript strict 模式和 Biome 格式化工具
4. 从零创建一个可构建、可运行的 3 包 agent 项目骨架

---

## 1. 为什么要研究 pi 的架构

pi 是一个成熟的 AI agent 工具套件，包含统一 LLM API、agent 运行时、编码代理 CLI、终端 UI 和 Web UI。它的工程化决策经过大量生产验证，是我们学习 agent 架构的最佳范本。

在开始自己写代码之前，先拆解一个优秀项目的骨架，是最高效的学习方式。

---

## 2. pi 的 5 包分层架构

pi monorepo 包含 5 个包，每个包职责明确：

| 包名                    | npm 名称                          | 职责                                                 |
| ----------------------- | --------------------------------- | ---------------------------------------------------- |
| `packages/ai`           | `@earendil-works/pi-ai`           | 统一多供应商 LLM API（OpenAI、Anthropic、Google 等） |
| `packages/agent`        | `@earendil-works/pi-agent-core`   | Agent 运行时：工具调用、状态管理、传输抽象           |
| `packages/coding-agent` | `@earendil-works/pi-coding-agent` | 编码代理 CLI：集成所有包，提供交互式编码体验         |
| `packages/tui`          | `@earendil-works/pi-tui`          | 终端 UI 库：差分渲染引擎                             |
| `packages/web-ui`       | `@earendil-works/pi-web-ui`       | Web 组件库：AI 聊天界面                              |

### 2.1 依赖关系图

```
┌─────────┐     ┌─────────────┐     ┌───────────────┐
│  pi-ai  │────>│ pi-agent-   │────>│ pi-coding-    │
│ (LLM层) │     │   core      │     │   agent       │
└─────────┘     │ (Agent运行时)│     │ (应用层/CLI)   │
                └─────────────┘     └───────────────┘
                                           ▲   ▲
┌─────────┐                                │   │
│ pi-tui  │────────────────────────────────┘   │
│(终端UI) │                                    │
└─────────┘                                    │
┌──────────┐                                   │
│pi-web-ui │───────────────────────────────────┘
│ (Web UI) │
└──────────┘
```

关键观察：

- **`ai` 是最底层**：不依赖任何其他 pi 包。它只负责与各 LLM 供应商通信，输出标准化的事件流。
- **`agent` 依赖 `ai`**：在 LLM API 之上构建 agent 循环（工具调用 -> 执行 -> 返回结果 -> 继续对话）。
- **`tui` 和 `web-ui` 是独立的 UI 层**：不依赖 agent 逻辑，只提供渲染能力。
- **`coding-agent` 是顶层应用**：组装所有底层包，提供完整的编码代理体验。

### 2.2 为什么分层很重要

**可替换性**：LLM 供应商随时可能出新的 API。`ai` 层隔离了这些变化，上层不需要改动。

**可测试性**：`agent` 层可以用 mock 的 LLM 流来测试，不需要真正调用 API。`coding-agent` 的测试套件用的就是 faux provider。

**可复用性**：`ai` 包可以独立发布到 npm，任何 Node.js 项目都能用。`tui` 也是如此。

**构建效率**：TypeScript project references 允许增量编译。改了 `ai` 的一个文件，只需要重新编译 `ai` 及其下游，而不是整个仓库。

**关注点分离**：每个包有独立的 `package.json`、`tsconfig.json`、测试目录。一个开发者可以只关注 `ai` 包的代码，不需要理解 UI 层的实现。

---

## 3. 我们的简化版：3 包布局

在课程项目中，我们不需要 5 个包。我们用 3 个包来复现 pi 的核心分层思想：

```
┌──────────────┐     ┌─────────────┐     ┌──────────┐
│  agent-core  │────>│    tools    │────>│   app    │
│  (LLM+Agent) │     │ (工具实现)   │     │ (应用层) │
└──────────────┘     └─────────────┘     └──────────┘
```

| 我们的包              | 对应 pi 的                  | 职责                          |
| --------------------- | --------------------------- | ----------------------------- |
| `packages/agent-core` | `ai` + `agent`              | LLM 通信 + agent 循环核心     |
| `packages/tools`      | `coding-agent` 中的工具部分 | 文件读写、bash 执行等工具实现 |
| `packages/app`        | `coding-agent` 的 CLI 部分  | 组装一切，提供命令行入口      |

为什么这样简化：

- 初学阶段，将 LLM 层和 agent 运行时合并可以减少认知负担
- 工具层独立出来是因为它是 agent 最核心的扩展点
- 应用层负责把一切粘合在一起

---

## 4. 工程化选择

### 4.1 npm workspaces

npm 内置的 monorepo 方案。在根 `package.json` 中声明 `"workspaces": ["packages/*"]`，npm 会：

- 将所有子包 symlink 到根 `node_modules/`
- 自动解析包间依赖（例如 `tools` 依赖 `agent-core` 时，直接 link 到本地源码）
- 支持统一安装、统一运行脚本

相比 Lerna、Turborepo 等方案，npm workspaces 零依赖、零配置，是最简单的起步方式。

### 4.2 ESM (ECMAScript Modules)

Node.js 的现代模块系统。我们在 `package.json` 中设置 `"type": "module"`：

- 使用 `import`/`export` 而不是 `require()`/`module.exports`
- 相对导入必须带文件扩展名：`import { foo } from "./foo.js"`
- TypeScript 源码是 `.ts`，但 import 路径写 `.js`（指向编译产物）
- 支持 top-level `await`
- `package.json` 的 `"exports"` 字段精确控制公开 API

pi 整个仓库都使用 ESM。这是 2024+ Node.js 项目的标准选择。

### 4.3 TypeScript strict 模式

`tsconfig.base.json` 中开启 `"strict": true`，同时启用：

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "skipLibCheck": true,
  },
}
```

关键点：

- `"module": "Node16"` + `"moduleResolution": "Node16"`：匹配 Node.js 的 ESM 解析行为
- `"composite": true`：启用 TypeScript project references，允许增量编译
- `"declaration": true`：生成 `.d.ts` 类型声明文件，下游包依赖这些文件
- `"declarationMap": true`：支持跨包 Go to Definition

### 4.4 Biome

替代 ESLint + Prettier 的单一工具：

- 格式化：与 Prettier 97% 兼容
- Lint：500+ 规则
- 速度：比 Prettier 快约 35 倍
- 配置：单个 `biome.json` 文件

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "formatter": {
    "indentStyle": "tab",
    "lineWidth": 140
  },
  "linter": {
    "enabled": true
  }
}
```

---

## 5. 项目结构详解

最终的目录结构：

```
my-agent/
├── package.json              # 根配置：workspaces, scripts
├── tsconfig.base.json        # 共享 TypeScript 配置
├── biome.json                # 格式化 + lint 配置
├── packages/
│   ├── agent-core/
│   │   ├── package.json      # name: "@my-agent/core"
│   │   ├── tsconfig.json     # extends ../../tsconfig.base.json
│   │   └── src/
│   │       └── index.ts      # LLM 通信 + agent 循环的类型和接口
│   ├── tools/
│   │   ├── package.json      # name: "@my-agent/tools", depends on @my-agent/core
│   │   ├── tsconfig.json     # references: [{ path: "../agent-core" }]
│   │   └── src/
│   │       └── index.ts      # 工具注册和实现
│   └── app/
│       ├── package.json      # name: "@my-agent/app", depends on core + tools
│       ├── tsconfig.json     # references: [{ path: "../agent-core" }, { path: "../tools" }]
│       └── src/
│           └── index.ts      # CLI 入口
```

### 5.1 根 `package.json` 结构

```jsonc
{
  "name": "my-agent-monorepo",
  "private": true, // 防止意外发布到 npm
  "type": "module", // 整个仓库使用 ESM
  "workspaces": ["packages/*"], // 声明 workspace 位置
  "scripts": {
    "build": "tsc --build", // 利用 project references 按顺序编译
    "clean": "tsc --build --clean",
    "check": "biome check .",
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "typescript": "^5.7.0",
  },
}
```

### 5.2 `tsconfig.base.json`

所有子包的 `tsconfig.json` 通过 `"extends"` 继承这个文件：

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "Node16",
    "resolveJsonModule": true,
    "composite": true,
  },
}
```

### 5.3 子包的 `tsconfig.json`（以 `tools` 为例）

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
  },
  "include": ["src"],
  "references": [
    { "path": "../agent-core" }, // 声明对 agent-core 的编译依赖
  ],
}
```

`references` 告诉 TypeScript：编译 `tools` 之前，先确保 `agent-core` 已编译。`tsc --build` 会自动处理拓扑排序。

### 5.4 子包的 `package.json`（以 `tools` 为例）

```jsonc
{
  "name": "@my-agent/tools",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
    },
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
  },
  "dependencies": {
    "@my-agent/core": "^0.1.0", // workspace 依赖，会 symlink 到本地
  },
}
```

关键字段：

- `"exports"`：精确声明包的公开入口点。下游 `import "@my-agent/tools"` 时，Node.js 和 TypeScript 都会查找这里
- `"types"`：TypeScript 用来解析类型声明的入口
- `"main"`：CommonJS 后备入口（虽然我们用 ESM，但保留兼容性是好习惯）

---

## 6. 动手实践

### Step 1：创建目录结构

```bash
mkdir my-agent && cd my-agent
mkdir -p packages/agent-core/src
mkdir -p packages/tools/src
mkdir -p packages/app/src
```

### Step 2：初始化根 `package.json`

创建 `package.json`：

```json
{
  "name": "my-agent-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "tsc --build",
    "clean": "tsc --build --clean",
    "check": "npx @biomejs/biome check ."
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "typescript": "^5.7.0",
    "@types/node": "^22.10.0"
  }
}
```

### Step 3：创建 `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "Node16",
    "resolveJsonModule": true,
    "composite": true
  }
}
```

### Step 4：创建根 `tsconfig.json`

这是一个"solution" tsconfig，只包含 references，不包含文件：

```json
{
  "files": [],
  "references": [
    { "path": "packages/agent-core" },
    { "path": "packages/tools" },
    { "path": "packages/app" }
  ]
}
```

### Step 5：创建 `agent-core` 包

`packages/agent-core/package.json`：

```json
{
  "name": "@my-agent/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  }
}
```

`packages/agent-core/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

`packages/agent-core/src/index.ts`：

```typescript
// Agent core: message types and agent loop interface

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  toolName: string;
  result: string;
}

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  maxTurns: number;
}

export function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    model: "default",
    systemPrompt: "You are a helpful assistant.",
    tools: [],
    maxTurns: 10,
    ...overrides,
  };
}
```

### Step 6：创建 `tools` 包

`packages/tools/package.json`：

```json
{
  "name": "@my-agent/tools",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@my-agent/core": "^0.1.0"
  }
}
```

`packages/tools/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"],
  "references": [{ "path": "../agent-core" }]
}
```

`packages/tools/src/index.ts`：

```typescript
import type { ToolDefinition, ToolResult } from "@my-agent/core";

// Tool registry: register and execute tools

const registry = new Map<string, ToolExecutor>();

type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

export function registerTool(definition: ToolDefinition, executor: ToolExecutor): void {
  registry.set(definition.name, executor);
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const executor = registry.get(name);
  if (!executor) {
    return { toolName: name, result: `Error: tool "${name}" not found` };
  }
  const result = await executor(args);
  return { toolName: name, result };
}

export function listTools(): string[] {
  return [...registry.keys()];
}
```

### Step 7：创建 `app` 包

`packages/app/package.json`：

```json
{
  "name": "@my-agent/app",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@my-agent/core": "^0.1.0",
    "@my-agent/tools": "^0.1.0"
  }
}
```

`packages/app/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"],
  "references": [{ "path": "../agent-core" }, { "path": "../tools" }]
}
```

`packages/app/src/index.ts`：

```typescript
import { createAgentConfig } from "@my-agent/core";
import { listTools, registerTool, executeTool } from "@my-agent/tools";

// Bootstrap: register a demo tool and run a simple agent loop

registerTool(
  {
    name: "greet",
    description: "Returns a greeting message",
    parameters: { name: { type: "string" } },
  },
  async (args) => `Hello, ${args.name ?? "world"}!`,
);

const config = createAgentConfig({
  model: "gpt-4",
  systemPrompt: "You are a coding assistant.",
  tools: [
    {
      name: "greet",
      description: "Returns a greeting message",
      parameters: { name: { type: "string" } },
    },
  ],
});

console.log("Agent config:", config);
console.log("Registered tools:", listTools());

const result = await executeTool("greet", { name: "Student" });
console.log("Tool result:", result);
```

### Step 8：安装依赖并构建

```bash
npm install
npm run build
```

`tsc --build` 会按照 project references 的拓扑顺序编译：先 `agent-core`，再 `tools`，最后 `app`。

### Step 9：运行

```bash
node packages/app/dist/index.js
```

预期输出：

```
Agent config: {
  model: 'gpt-4',
  systemPrompt: 'You are a coding assistant.',
  tools: [ { name: 'greet', description: 'Returns a greeting message', parameters: [Object] } ],
  maxTurns: 10
}
Registered tools: [ 'greet' ]
Tool result: { toolName: 'greet', result: 'Hello, Student!' }
```

---

## 7. 总结

本课我们完成了：

1. **分析了 pi 的 5 包架构**：`ai` -> `agent` -> `coding-agent`，加上独立的 `tui` 和 `web-ui`。理解了分层带来的可替换性、可测试性和构建效率。

2. **设计了我们的 3 包架构**：`agent-core`（核心类型和 agent 循环）-> `tools`（工具注册和执行）-> `app`（应用入口）。这是 pi 架构的教学简化版。

3. **掌握了 4 个工程化选择**：
   - npm workspaces：零依赖的 monorepo 方案
   - ESM：Node.js 现代模块系统
   - TypeScript strict + project references：类型安全 + 增量编译
   - Biome：快速的格式化和 lint 工具

4. **从零搭建了可工作的项目骨架**：可以 `npm install && npm run build` 并运行。

下一课，我们将在 `agent-core` 中实现真正的 LLM 通信层。
