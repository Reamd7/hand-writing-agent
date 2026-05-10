# How to Build an Agent

> 基于 pi agent (earendil-works/pi-mono) 源码架构，使用 Vercel AI SDK 作为 LLM 层、ink 作为 TUI 框架，从零手把手构建一个完整的 coding agent。

---

## 课程定位

- **目标受众**：有 TypeScript/Node.js 基础的开发者，想深入理解 AI Agent 架构
- **课程产出**：一个功能完整的 terminal coding agent（类似 pi / Claude Code / Cursor Agent）
- **技术栈**：TypeScript, ESM, Vercel AI SDK v6, Zod, ink (React), Node.js
- **课程时长**：20 课，每课约 45-60 分钟
- **教学原则**：每课产出可运行代码，逐步叠加，不跳步

### 哪些自己写，哪些用现成的

| 层                 | 方案                    | 理由                            |
| ------------------ | ----------------------- | ------------------------------- |
| LLM 通信           | **Vercel AI SDK v6**    | 课程教的是 agent，不是 LLM SDK  |
| Terminal UI        | **ink (React for CLI)** | 课程教的是 agent，不是 TUI 框架 |
| Agent loop         | **自建**                | 这是 agent 的心脏，必须手写     |
| Tool 系统          | **自建**                | 这是 agent 的能力边界，必须手写 |
| Session/Compaction | **自建**                | 这是 agent 的记忆系统，必须手写 |
| Extension 系统     | **自建**                | 这是 agent 的扩展能力，必须手写 |

---

## 架构总览

```
┌────────────────────────────────────────────────────────┐
│                      CLI Entry                         │
│               (cli.ts -> main.ts)                      │
├───────────┬───────────────┬────────────────┬───────────┤
│Interactive│    Print      │      RPC       │           │
│   Mode    │    Mode       │     Mode       │           │
│  (ink)    │  (stdout)     │  (JSON-RPC)    │           │
├───────────┴───────────────┴────────────────┤           │
│           AgentSession                     │ Extension │
│    (session, compaction, extensions)       │  System   │
├────────────────────────────────────────────┤           │
│           Agent (agent-core)               │           │
│    (state, events, queues, lifecycle)      │           │
├────────────────────────────────────────────┤           │
│           Agent Loop                       │           │
│    (turn cycle, streaming, tool exec)      │           │
├────────────────────────────────────────────┤           │
│         Vercel AI SDK v6                   │           │
│    (streamText, providers, tool())         │           │
├────────────────────────────────────────────┤           │
│           Tool System                      │           │
│    (read, bash, edit, write, grep, ...)    │           │
└────────────────────────────────────────────┴───────────┘
```

课程按依赖关系从底向上构建：AI SDK 基础 -> Agent 核心 -> Tool 系统 -> Session/Extension -> UI -> CLI。

---

## 第一部分：基础设施

### 第 1 课：项目架构与工程搭建

**目标**：理解为什么 agent 需要分层架构，搭建项目骨架。

**知识点**：

- pi 的 5 包分层设计解析：`ai` -> `agent` -> `coding-agent`，`tui`，`web-ui`
- 依赖关系图：为什么要分层而不是一个大包
- 本课程的简化分层：`packages/agent-core`（agent loop + state）、`packages/tools`（tool 实现）、`packages/app`（CLI + UI）
- 工程化选型：npm workspaces、ESM (`"type": "module"`)、TypeScript strict mode、Biome 格式化

**动手**：

1. 初始化 monorepo 骨架，创建三个 package
2. 配置共享 `tsconfig.base.json`（target ES2022, module Node16, strict）
3. 配置 workspace 依赖关系
4. 验证 `npm run build` 能跑通空包

**对应 pi 源码**：

- 根 `package.json` — workspaces 配置
- `tsconfig.base.json` — 共享 TypeScript 配置
- 各包 `package.json` 的依赖关系

---

## 第二部分：LLM 层（AI SDK）

### 第 2 课：AI SDK 基础与消息模型设计

**目标**：掌握 AI SDK 核心 API，设计 agent 内部的消息类型系统。

**知识点**：

- AI SDK Core 三大函数：`generateText()`、`streamText()`、`tool()`
- Provider 安装与配置：`@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/google`
- `streamText` 的 `fullStream` 事件协议：
  - `text-start` / `text-delta` / `text-end`
  - `reasoning-start` / `reasoning-delta` / `reasoning-end`
  - `tool-call` / `tool-input-start` / `tool-input-delta` / `tool-result`
  - `start-step` / `finish-step` / `finish` / `error`
- 自定义 `AgentMessage` 类型设计（对比 pi 的 `UserMessage` / `AssistantMessage` / `ToolResultMessage`）
- 使用 TypeScript declaration merging 实现可扩展消息类型（pi 的 `CustomAgentMessages` 模式）
- `Usage` 类型：token 计数与成本追踪

**动手**：

1. 安装 AI SDK 和至少两个 provider 包
2. 写一个最小的 `streamText` demo，消费 `fullStream` 并打印所有事件
3. 定义 `AgentMessage`、`AgentContext`、`AgentEvent` 核心类型
4. 实现 `fullStream` 事件到 `AgentEvent` 的映射函数

**对应 pi 源码**：

- `packages/ai/src/types.ts` — 消息类型定义
- `packages/agent/src/types.ts` — `AgentMessage`、`AgentEvent`、`AgentContext`

### 第 3 课：Provider 管理与模型配置

**目标**：实现多 provider 管理、模型切换和 middleware 机制。

**知识点**：

- AI SDK 的 provider 模型：每个 provider 是独立 npm 包，天然懒加载
- `wrapLanguageModel()` + Language Model Middleware：日志、caching、guardrails
- 简单的模型注册表设计：`provider + modelId -> LanguageModelV1` 映射
- 跨 provider 消息兼容性：为什么切换模型时 thinking blocks 需要处理
- `providerOptions` 传递 provider 特定配置（如 Anthropic 的 `cacheControl`）

**动手**：

1. 实现 `ModelRegistry` 类：注册、查找、列出可用模型
2. 实现一个简单的 logging middleware
3. 封装 `createStream(model, context, options)` 统一入口函数
4. 测试在 OpenAI 和 Anthropic 之间切换模型

**对应 pi 源码**：

- `packages/ai/src/api-registry.ts` — provider 注册表
- `packages/ai/src/models.ts` — 模型注册表
- `packages/ai/src/providers/transform-messages.ts` — 跨 provider 消息转换

---

## 第三部分：Agent 核心运行时

### 第 4 课：Agent 状态与事件模型

**目标**：设计 agent 的状态管理和事件驱动架构。

**知识点**：

- `AgentState` 设计：
  - 配置：`systemPrompt`、`model`、`thinkingLevel`
  - 数据：`tools[]`、`messages[]`
  - 运行时：`isStreaming`、`streamingMessage`、`pendingToolCalls`、`errorMessage`
- `MutableAgentState`：内部可写版本，`tools`/`messages` 的 setter 自动 clone 防止外部修改
- `AgentEvent` 判别联合类型设计：
  - `agent_start` / `agent_end`
  - `turn_start` / `turn_end`
  - `message_start` / `message_update` / `message_end`
  - `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- 订阅模型：`subscribe(listener)` 返回 unsubscribe 函数
  - 监听器按注册顺序同步 `await`，保证事件处理顺序
  - 监听器接收 `AbortSignal`，支持取消
- `processEvents()` 作为状态 reducer：每个事件更新状态，然后扇出到所有订阅者

**动手**：

1. 实现 `MutableAgentState` 类（含 clone 保护的 getter/setter）
2. 定义完整的 `AgentEvent` 类型
3. 实现 `Agent` 类骨架：构造函数、`subscribe()`、`processEvents()`
4. 单元测试：订阅事件、验证状态更新

**对应 pi 源码**：

- `packages/agent/src/types.ts` — `AgentState`、`AgentEvent`、`AgentTool`
- `packages/agent/src/agent.ts` — `Agent` 类、`MutableAgentState`、订阅模型

### 第 5 课：Agent Loop（上）—— 流式响应与轮次管理

**目标**：实现 agent 循环的核心流程 —— 发送消息、接收流式响应、管理轮次。

**知识点**：

- Agent loop 的宏观流程：`prompt -> stream response -> handle tool calls -> loop`
- `streamAssistantResponse()` 内部流程：
  1. `transformContext()` — 扩展点，修改消息列表（AgentMessage[] -> AgentMessage[]）
  2. `convertToLlm()` — 过滤自定义消息，只保留 LLM 能理解的消息
  3. 调用 AI SDK `streamText(model, context, options)`
  4. 消费 `fullStream`，映射每个事件到 `AgentEvent` 并通过 `processEvents` 扇出
- Context snapshot 隔离：loop 操作快照副本，`processEvents` 独立更新 `Agent._state.messages`
- 部分消息（partial message）管理：流式过程中消息就地更新到 context
- 终止条件识别：`done` / `error` / `aborted`

**动手**：

1. 实现 `createContextSnapshot()` — 从 Agent state 创建快照
2. 实现 `streamAssistantResponse()` — 调用 `streamText`，消费 `fullStream`，发射事件
3. 实现基本的 `runLoop()` — 单轮：发送消息 -> 流式响应 -> 结束
4. 集成测试：发一条消息，验证完整事件流

**对应 pi 源码**：

- `packages/agent/src/agent-loop.ts` — `streamAssistantResponse()`、`runLoop()` 的上半部分
- `packages/agent/src/agent.ts` — `createContextSnapshot()`

### 第 6 课：Agent Loop（下）—— Tool 调用执行引擎

**目标**：实现 tool 调用的检测、执行和结果回传，完成完整的 agent 循环。

**知识点**：

- Tool 执行三阶段流水线：`prepare -> execute -> finalize`
- `prepareToolCall()`：
  1. 从 tool 注册表查找 tool（未找到 -> 立即错误）
  2. `prepareArguments()` — 预处理原始参数（兼容性 shim）
  3. Schema 校验（Zod `parse`）
  4. `beforeToolCall` hook — 可阻断执行（返回 `{ block: true, reason }`）
- `executePreparedToolCall()`：
  1. 调用 `tool.execute(id, args, signal, onUpdate)`
  2. `onUpdate` 回调发射 `tool_execution_update` 事件（用于流式输出）
  3. 异常捕获，转为错误结果
- `finalizeExecutedToolCall()`：
  1. `afterToolCall` hook — 字段级覆盖（content, details, terminate, isError）
  2. Hook 自身异常替换原结果
- 并行 vs 串行执行策略：
  - 全局 `toolExecution` 配置 + 单 tool `executionMode` 覆盖
  - 任何一个 tool 是 sequential，整批强制 sequential
- 批次终止逻辑：`shouldTerminateToolBatch` — 所有 tool 都 `terminate: true` 才停止循环

**动手**：

1. 实现 `prepareToolCall()` + `executePreparedToolCall()` + `finalizeExecutedToolCall()`
2. 实现 `executeToolCallsParallel()` 和 `executeToolCallsSequential()`
3. 将 tool 执行集成到 `runLoop()` — 检测 tool calls -> 执行 -> 结果回传 -> 继续循环
4. 集成测试：定义一个简单 tool，验证 prompt -> tool call -> tool result -> 最终回复的完整流程

**对应 pi 源码**：

- `packages/agent/src/agent-loop.ts` — `executeToolCalls()`、`prepareToolCall()`、`executePreparedToolCall()`、`finalizeExecutedToolCall()`、`shouldTerminateToolBatch()`

### 第 7 课：Steering 与 Follow-up 队列

**目标**：实现用户中途干预（steering）和多轮追加（follow-up）能力。

**知识点**：

- 双层循环架构：
  - 内层循环：处理 tool calls + steering 消息（agent 运行中的干预）
  - 外层循环：处理 follow-up 消息（agent 即将停止时的追加）
- `PendingMessageQueue` 设计：
  - `"all"` 模式：一次性排空所有消息
  - `"one-at-a-time"` 模式：每次只取一条
  - API：`enqueue()`、`drain()`、`hasItems()`、`clear()`
- Steering 队列：在 agent 运行中注入消息，下一次 LLM 调用前生效
  - 两个轮询点：loop 开始时 + 每轮 turn 结束时
- Follow-up 队列：agent 即将停止时检查，有消息则继续外层循环
- `shouldStopAfterTurn` hook：每轮结束后检查是否应提前终止
- `Agent` 类公共 API：
  - `prompt()` — 发起新一轮对话（必须在 idle 状态）
  - `continue()` — 继续上一轮
  - `steer(message)` — 运行中注入消息
  - `followUp(message)` — 追加后续消息
  - `abort()` — 中止当前运行
  - `waitForIdle()` — 等待运行结束

**动手**：

1. 实现 `PendingMessageQueue` 类
2. 将双层循环集成到 `runLoop()` — steering poll + follow-up poll
3. 实现 `runWithLifecycle()` — AbortController 管理、`isStreaming` 状态、失败合成消息
4. 完善 `Agent` 类：`prompt()`、`continue()`、`steer()`、`followUp()`、`abort()`
5. 测试：运行中 steer 一条消息，验证 agent 在下一轮 LLM 调用前能看到它

**对应 pi 源码**：

- `packages/agent/src/agent.ts` — `PendingMessageQueue`、`prompt()`、`continue()`、`steer()`、`followUp()`、`runWithLifecycle()`
- `packages/agent/src/agent-loop.ts` — `runLoop()` 双层循环

### 第 8 课：测试 Agent 核心 —— Mock Provider

**目标**：构建确定性测试基础设施，确保 agent 核心逻辑可靠。

**知识点**：

- 为什么需要 mock provider：确定性、无网络依赖、可控制 tool call 输出
- AI SDK 的 `MockLanguageModelV1`：预设响应、模拟流式输出
- pi 的 Faux Provider 设计思路：预编排 `AssistantMessage` 队列、可配置 `tokensPerSecond`
- 测试用例设计：
  - 基本对话：prompt -> text response
  - 单步 tool call：prompt -> tool call -> tool result -> final response
  - 多步 tool call：连续多次 tool call
  - 错误处理：tool 执行失败、LLM 错误、abort
  - Steering：运行中注入消息
- 端到端事件验证：收集所有 `AgentEvent`，断言事件顺序和内容

**动手**：

1. 基于 AI SDK `MockLanguageModelV1` 封装一个更易用的测试工具
2. 编写 5 个核心测试用例覆盖上述场景
3. 验证所有测试通过

**对应 pi 源码**：

- `packages/ai/src/providers/faux.ts` — Faux Provider 实现

---

## 第四部分：Tool 系统

### 第 9 课：Tool 定义体系与 Read Tool

**目标**：设计 tool 系统架构，实现第一个 tool。

**知识点**：

- 两层 tool 抽象：
  - `ToolDefinition`（富定义）：含 name、description、parameters、execute、promptSnippet、promptGuidelines
  - `AgentTool`（精简运行时）：只含 name、description、parameters、execute
- `wrapToolDefinition()` — 剥离 UI 关注点，注入运行时上下文
- Zod schema 定义 tool 参数
- `Operations` 接口抽象：tool I/O 可插拔（本地 fs / SSH / 远程）
- Read tool 实现：
  - 路径解析与安全检查
  - 行号前缀、偏移/限制、截断策略（`truncateHead` — 2000 行 / 50KB）
  - 图片文件处理（MIME 检测 -> 缩放 -> base64 -> `ImageContent`）
  - abort signal 标准处理模式

**动手**：

1. 定义 `ToolDefinition` 和 `AgentTool` 接口
2. 实现 `wrapToolDefinition()` 适配函数
3. 实现 read tool 完整功能
4. 单元测试

**对应 pi 源码**：

- `packages/coding-agent/src/core/extensions/types.ts` — `ToolDefinition`
- `packages/coding-agent/src/core/tools/read.ts`
- `packages/coding-agent/src/core/tools/truncate.ts`

### 第 10 课：实现 Bash Tool

**目标**：实现命令执行工具，掌握流式输出和安全控制。

**知识点**：

- `child_process.spawn` 封装：`shell: true`，环境变量注入
- `OutputAccumulator`：缓冲合并 stdout/stderr
- 流式更新机制：
  - `onUpdate` 回调 -> `tool_execution_update` 事件
  - 节流控制：100ms 间隔，避免刷屏
- 超时控制：可选 timeout 参数，超时后 kill 进程
- AbortSignal 传递：用户 abort -> kill 子进程
- 输出截断：`truncateTail()` — 保留尾部（最新输出），2000 行 / 50KB
- 大输出落盘：超过阈值写入临时文件，返回路径提示 agent 用 read 工具查看

**动手**：

1. 实现 `OutputAccumulator`
2. 实现 `spawn` 封装（shell + env + timeout + abort）
3. 实现流式更新 + 节流
4. 实现输出截断和大输出落盘
5. 集成测试

**对应 pi 源码**：

- `packages/coding-agent/src/core/tools/bash.ts`
- `packages/coding-agent/src/core/tools/output-accumulator.ts`

### 第 11 课：实现 Edit 和 Write Tool

**目标**：实现精确文本编辑和文件写入工具。

**知识点**：

- Edit tool 的 "old text -> new text" 精确替换模型：
  - 为什么不用 diff/patch：LLM 生成 diff 容易出错，精确文本匹配更可靠
  - 多编辑批处理：`edits[]` 数组，逐个查找并替换
  - 唯一性检查：`oldText` 必须在文件中恰好匹配一次
- `FileMutationQueue`：串行化对同一文件的并发写入，防止竞态
- Diff 计算：生成 unified diff 用于 UI 展示
- `prepareArguments` 兼容性处理：旧格式适配、JSON string 自动解析
- Write tool：自动创建目录 + 写入 + 字节数确认 + 路径安全检查

**动手**：

1. 实现 `FileMutationQueue`
2. 实现 edit tool：查找 -> 替换 -> diff 生成
3. 实现 write tool
4. 测试：并发编辑同一文件、多次编辑

**对应 pi 源码**：

- `packages/coding-agent/src/core/tools/edit.ts`
- `packages/coding-agent/src/core/tools/write.ts`
- `packages/coding-agent/src/core/tools/file-mutation-queue.ts`

### 第 12 课：辅助 Tool 与 System Prompt 工程

**目标**：实现辅助搜索工具，构建动态 system prompt。

**知识点**：

- 辅助 tool 实现（grep / find / ls）：
  - Grep：正则搜索文件内容，`include` 过滤，结果截断
  - Find：glob 模式查找，`.gitignore` 尊重，按修改时间排序
  - Ls：目录列表，递归深度控制
- 工具分组策略：默认启用 4 个（read/bash/edit/write），可选 3 个（grep/find/ls）
- `buildSystemPrompt()` 结构化构建：
  1. 角色描述
  2. 可用工具列表（每个 tool 的 `promptSnippet`）
  3. 使用指南（tool `promptGuidelines` + 通用规则）
  4. 项目上下文（自动发现 `AGENTS.md` / `CLAUDE.md`）
  5. 日期和工作目录
- System prompt 随 tool 变化动态重建

**动手**：

1. 实现 grep / find / ls tool
2. 实现 `buildSystemPrompt()` 函数
3. 实现项目上下文发现
4. 测试：改变 active tools，验证 system prompt 更新

**对应 pi 源码**：

- `packages/coding-agent/src/core/tools/grep.ts`, `find.ts`, `ls.ts`
- `packages/coding-agent/src/core/system-prompt.ts`

---

## 第五部分：Session 管理

### 第 13 课：Session 持久化与分支

**目标**：实现对话会话的持久化和分支管理。

**知识点**：

- 为什么需要 session 持久化：断点续聊、历史回顾、分支探索
- JSONL 存储格式：每行一个 JSON entry，追加写入（高性能、crash-safe）
- 树形结构设计：每个 entry 有 `id` + `parentId`
  - "分支" = 从根到叶子的路径
  - 支持任意节点分叉
- Entry 类型：`message`、`model_change`、`compaction`、`label`、`custom`
- `SessionManager` API：
  - `create()` / `open()` / `inMemory()` / `continueRecent()`
  - `appendMessage()` / `appendCompaction()` / `appendModelChange()`
  - `buildSessionContext()` — 从根到叶遍历，重建 `AgentMessage[]`
- 分支操作：`branch()` / `resetLeaf()` / `forkFrom()`

**动手**：

1. 实现 JSONL 文件读写工具
2. 实现 `SessionManager` 类
3. 实现树形结构遍历和分支路径构建
4. 测试：创建 session、追加消息、重新加载、分支

**对应 pi 源码**：

- `packages/coding-agent/src/core/session-manager.ts`

### 第 14 课：Context Window 管理与 Compaction

**目标**：解决长对话的上下文溢出问题。

**知识点**：

- 问题：模型 context window 有限（128k-200k tokens），长对话会溢出
- 两种触发模式：
  1. **阈值压缩**：`contextTokens / contextWindow` 超过阈值，`agent_end` 后主动触发
  2. **溢出压缩**：LLM 返回 context overflow 错误，紧急压缩 + 自动重试
- 压缩流程 `compact()`：
  1. `prepareCompaction()` — 找切割点，分离要摘要的和要保留的
  2. 提取文件操作记录
  3. 序列化对话为纯文本
  4. 调用 `generateText`（非流式）生成摘要
  5. 持久化压缩 entry，重建 agent state
- Token 计数估算策略

**动手**：

1. 实现 token 计数估算函数
2. 实现 `prepareCompaction()` 和 `compact()`
3. 集成到 agent 生命周期
4. 测试：模拟长对话触发压缩

**对应 pi 源码**：

- `packages/coding-agent/src/core/compaction/`

---

## 第六部分：扩展系统

### 第 15 课：Extension API 设计

**目标**：实现可插拔的扩展系统。

**知识点**：

- Extension = 工厂函数：`(api: ExtensionAPI) => void | Promise<void>`
- `ExtensionAPI` 能力：
  - 事件订阅 `api.on()`：25+ 事件类型
  - 注册 tool / command / shortcut
  - 动作：`sendMessage()`、`setModel()`、`setActiveTools()`
- `ExtensionRunner` 职责：
  - 持有已加载 extension，管理生命周期
  - 特化 emitter：`emitToolCall()`、`emitToolResult()`、`emitContext()`
- 关键事件拦截点：
  - `before_agent_start` — 修改 system prompt
  - `context` — LLM 调用前修改消息列表
  - `tool_call` — 阻断或修改 tool 调用
  - `tool_result` — 修改 tool 结果
- Extension 发现与加载：项目 `.agent/` 目录 + 全局目录 + `jiti` 加载 TS

**动手**：

1. 定义 `ExtensionAPI` 接口
2. 实现 `ExtensionRunner`
3. 实现 extension 发现和加载
4. 测试：加载一个注册自定义 tool 的 extension

**对应 pi 源码**：

- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/src/core/extensions/loader.ts`

### 第 16 课：实战 —— 编写 Extension

**目标**：通过实例理解扩展能力的边界。

**知识点**：

- 实现一个 `/plan` 命令 extension：
  - `api.registerCommand("plan", handler)` — slash command
  - `api.on("before_agent_start")` — 注入规划指令到 system prompt
  - `api.on("context")` — 注入规划上下文
- 实现一个安全审计 extension：
  - `api.on("tool_call")` — 拦截危险 bash 命令
  - `api.on("tool_result")` — 过滤敏感输出
- 只读事件（observe）vs 拦截事件（intercept/modify）的设计区别

**动手**：

1. 实现 `/plan` command extension
2. 实现安全审计 extension
3. 测试交互效果

**对应 pi 源码**：

- `packages/coding-agent/examples/extensions/`

---

## 第七部分：Terminal UI（ink）

### 第 17 课：用 ink 构建交互式 Chat UI

**目标**：用 ink（React for CLI）构建完整的交互式终端界面。

**知识点**：

- 为什么选 ink：
  - React 组件模型，声明式 UI，状态驱动渲染
  - 成熟生态：`ink-text-input`、`ink-spinner`、`ink-select-input`
  - 对比 pi 自建 TUI 的取舍：放弃差分渲染/Kitty image 精细控制，换取开发速度
- ink 核心概念：
  - `render()` 挂载 React 组件到终端
  - `<Box>`（flexbox 布局）、`<Text>`（样式文本）
  - `useInput()` hook 处理键盘输入
  - `useApp()` hook 控制应用退出
  - `useStdout()` hook 获取终端尺寸
- 组件设计：
  - `<App>` — 顶层容器，管理 Agent 实例和全局状态
  - `<ChatHistory>` — 消息列表，滚动显示
  - `<MessageBubble>` — 单条消息渲染（用户 / 助手 / tool result）
  - `<ToolExecution>` — tool 调用渲染（header + 流式输出 + 状态色）
  - `<StreamingText>` — 流式 Markdown 渲染（用 `marked` 或 `ink-markdown`）
  - `<InputEditor>` — 用户输入框（基于 `ink-text-input`）
  - `<StatusBar>` — 底部状态栏（model 名称、token 用量、spinner）
- Agent 事件到 React 状态的映射：
  - `agent.subscribe()` -> `useEffect` 内订阅
  - 事件更新 `useState` / `useReducer` -> 触发 React 重渲染
  - `agent_start` -> `setIsStreaming(true)` + 显示 spinner
  - `message_update` -> 更新 `streamingContent`
  - `tool_execution_start/update/end` -> 更新 tool 组件状态
  - `agent_end` -> `setIsStreaming(false)` + 聚焦输入框
- 用户输入处理：
  - 回车提交 -> 检查 slash commands -> `agent.prompt()` 或 `agent.steer()`
  - Ctrl+C -> `agent.abort()`
  - 运行中输入 -> `agent.steer()`

**动手**：

1. 搭建 ink 应用骨架（`<App>` + `render()`）
2. 实现 `<ChatHistory>` + `<MessageBubble>`
3. 实现 `<StreamingText>`（增量 Markdown 渲染）
4. 实现 `<ToolExecution>` 组件
5. 实现 `<InputEditor>` + slash command 解析
6. 用 `useEffect` + `agent.subscribe()` 将 agent 事件连接到 React 状态
7. 端到端演示：完整的交互式对话

**对应 pi 源码**（架构映射，非直接对应）：

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — 事件到 UI 的映射逻辑
- `packages/tui/src/components/` — 组件职责划分参考

---

## 第八部分：CLI 与产品化

### 第 18 课：CLI 入口与运行模式

**目标**：构建 CLI 入口，支持多种运行模式。

**知识点**：

- CLI 入口 `cli.ts`：Shebang、进程标题、Proxy 配置
- `main.ts` 流程：
  1. 参数解析（`--model`、`--provider`、`--system-prompt`、`--tool`）
  2. 创建 `SessionManager`
  3. 构建 services（settings、auth、model registry、resource loader）
  4. 创建 `AgentSession`
  5. 分发到运行模式
- 三种运行模式：
  - **Interactive**（默认）：ink TUI
  - **Print**（`-p "prompt"`）：非交互，stdout 输出后退出
  - **RPC**（`--rpc`）：JSON-RPC over stdin/stdout，供 IDE 集成
- API key 解析链：CLI arg -> 环境变量 -> 配置文件
- `AgentSession` 作为 facade：统一管理 agent + session + extensions + tools

**动手**：

1. 实现 CLI 参数解析
2. 实现 `AgentSession` facade
3. 实现 Print mode
4. 集成 Interactive mode（ink）
5. 端到端测试：`node cli.js -p "say hi"` 和交互模式

**对应 pi 源码**：

- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/src/core/agent-session.ts`

---

## 第九部分：进阶与总结

### 第 19 课：生产化打磨

**目标**：处理生产环境中的边缘情况和用户体验细节。

**知识点**：

- 错误恢复策略：
  - 网络错误自动重试（指数退避）
  - Context overflow 自动 compaction + 重试
  - Tool 执行失败的优雅降级
- 安全加固：
  - 路径遍历防护（所有文件操作限制在 cwd 内）
  - 环境变量泄露防护
  - 敏感文件检测（`.env`、`credentials.json` 等）
- 性能优化：
  - Token 用量优化（截断策略的调优）
  - 并行 tool 执行的合理使用
  - Session 文件清理策略
- 配置系统：
  - 项目级配置（`.agent/config.yaml`）
  - 全局配置（`~/.agent/config.yaml`）
  - 配置合并优先级

**动手**：

1. 实现错误重试逻辑
2. 添加路径安全检查
3. 实现配置系统
4. 压力测试：长对话、大文件、并发 tool 调用

**对应 pi 源码**：

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/core/agent-session.ts` 中的错误处理逻辑

### 第 20 课：回顾与架构全景

**目标**：回顾完整架构，理解各层如何协作，讨论演进方向。

**知识点**：

- 完整请求链路追踪：用户输入 -> CLI -> AgentSession -> Agent -> Loop -> AI SDK -> Provider -> LLM -> 响应 -> Tool 执行 -> 循环 -> UI 渲染
- 各层职责边界回顾：
  - AI SDK：LLM 通信（不关心 agent 逻辑）
  - Agent Core：状态 + 事件 + 循环（不关心具体 tool）
  - Tool System：具体能力实现（不关心 UI）
  - Session：持久化 + 记忆（不关心运行时）
  - Extension：横切关注点注入
  - UI (ink)：渲染 + 输入（不关心 agent 内部）
- pi 做了而本课程简化的部分：
  - 自建 TUI 框架（差分渲染、Kitty image、键盘协议）
  - 自建 LLM 抽象层（30+ provider、OAuth、prompt cache）
  - Web UI（Lit web components）
  - RPC mode 完整实现
- 演进方向讨论：
  - MCP (Model Context Protocol) 集成
  - Sub-agent / Multi-agent
  - Web UI 版本（AI SDK UI + `useChat`）
  - 沙箱执行（安全的 code execution）

**产出**：

- 一份完整的架构图（标注每个模块的来源：自建 / AI SDK / ink）
- 一份"如果要做的更好"的清单

---

## 附录

### 附录 A：完整技术栈

| 层           | 技术                                                    | 替代 pi 的                                   |
| ------------ | ------------------------------------------------------- | -------------------------------------------- |
| LLM 通信     | Vercel AI SDK v6                                        | `packages/ai`（~8000 行）                    |
| Provider     | `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google` | 自建 9 种 wire protocol                      |
| Tool schema  | Zod                                                     | TypeBox                                      |
| Agent 核心   | **自建**                                                | `packages/agent`                             |
| Tool 实现    | **自建**                                                | `packages/coding-agent/src/core/tools/`      |
| Session 存储 | **自建**（JSONL）                                       | 同 pi                                        |
| Extension    | **自建**                                                | `packages/coding-agent/src/core/extensions/` |
| TUI 框架     | ink (React for CLI)                                     | `packages/tui`（~3000 行自建框架）           |
| CLI          | Node.js                                                 | 同 pi                                        |
| 格式化       | Biome                                                   | 同 pi                                        |
| 测试         | Vitest                                                  | 同 pi                                        |

### 附录 B：关键设计决策总结

| 决策                                    | 原因                                             |
| --------------------------------------- | ------------------------------------------------ |
| AI SDK 替代自建 LLM 层                  | 课程聚焦 agent 逻辑，省 6 课时间                 |
| ink 替代自建 TUI                        | 课程聚焦 agent 逻辑，省 4 课时间                 |
| 自建 agent loop（不用 `ToolLoopAgent`） | agent loop 是核心教学价值，不能被封装掉          |
| Push-based 事件分发                     | 适合扇出到多个消费者（UI + session + extension） |
| Declaration merging 扩展消息            | `AgentMessage` 可扩展自定义类型                  |
| Context snapshot 隔离                   | loop 和 Agent state 互不干扰                     |
| Operations 接口抽象                     | Tool I/O 可插拔，支持远程执行                    |
| FileMutationQueue                       | 串行化并发文件写入                               |
| JSONL 树形 session                      | 支持分支/回溯，追加写入高性能                    |
| Extension 工厂函数                      | 简单、可隔离、支持异步初始化                     |

### 附录 C：学习路径建议

#### 路径 1：最小可用 Agent（10 课）

第 1-6, 9-12 课。产出：AI SDK + agent loop + 7 个 tool + system prompt。仅 print mode，无 TUI。
适合想快速理解 agent 原理的学员。

#### 路径 2：完整 CLI Agent（18 课）

追加第 7-8, 13-14, 17-18 课。产出：带 ink TUI 的交互式 coding agent，含 session 持久化和 compaction。
适合想构建生产级 agent 的学员。

#### 路径 3：可扩展 Agent（20 课）

追加第 15-16, 19-20 课。产出：支持 extension 插件的完整 agent，含生产化加固。
适合想构建平台级 agent 的学员。

### 附录 D：各课与 pi 源码文件对照表

| 课  | 核心 pi 源码                                                                           |
| --- | -------------------------------------------------------------------------------------- |
| 1   | 根 `package.json`, `tsconfig.base.json`                                                |
| 2   | `packages/ai/src/types.ts`, `packages/agent/src/types.ts`                              |
| 3   | `packages/ai/src/api-registry.ts`, `packages/ai/src/models.ts`                         |
| 4   | `packages/agent/src/types.ts`, `packages/agent/src/agent.ts`                           |
| 5   | `packages/agent/src/agent-loop.ts`（streamAssistantResponse）                          |
| 6   | `packages/agent/src/agent-loop.ts`（executeToolCalls）                                 |
| 7   | `packages/agent/src/agent.ts`（queues, lifecycle）                                     |
| 8   | `packages/ai/src/providers/faux.ts`                                                    |
| 9   | `packages/coding-agent/src/core/tools/read.ts`, `extensions/types.ts`                  |
| 10  | `packages/coding-agent/src/core/tools/bash.ts`                                         |
| 11  | `packages/coding-agent/src/core/tools/edit.ts`, `write.ts`                             |
| 12  | `packages/coding-agent/src/core/tools/grep.ts`, `find.ts`, `ls.ts`, `system-prompt.ts` |
| 13  | `packages/coding-agent/src/core/session-manager.ts`                                    |
| 14  | `packages/coding-agent/src/core/compaction/`                                           |
| 15  | `packages/coding-agent/src/core/extensions/runner.ts`, `loader.ts`                     |
| 16  | `packages/coding-agent/examples/extensions/`                                           |
| 17  | `packages/coding-agent/src/modes/interactive/interactive-mode.ts`                      |
| 18  | `packages/coding-agent/src/cli.ts`, `main.ts`, `agent-session.ts`                      |
| 19  | `packages/coding-agent/src/config.ts`, 各处错误处理                                    |
| 20  | 全局架构回顾                                                                           |
