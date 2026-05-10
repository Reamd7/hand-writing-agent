# 第二十课：架构回顾与未来方向

## 学习目标

完成本课后，你将能够：

1. 从用户输入到最终响应，完整追踪一条请求在 agent 系统中经过的每一层
2. 清晰描述每一层的职责边界，以及各层之间的通信契约
3. 理解 pi 的完整实现与我们课程简化版之间的差距
4. 规划 agent 系统的演进方向：MCP 集成、多 agent、Web UI、沙箱执行、结构化输出

---

## 1. 完整请求链追踪

这是整个课程最重要的一张图。一条用户消息从输入到响应，经过的完整路径：

```
用户输入 "读取 src/index.ts 并总结"
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  CLI 层 (cli.ts)                                            │
│  解析命令行参数 -> 选择运行模式 (interactive/print/rpc)       │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  AgentSession (agent-session.ts)                            │
│  管理会话生命周期：模型选择、事件订阅、持久化、压缩           │
│  调用 agent.send(userMessage)                               │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent (agent.ts)                                           │
│  状态机：管理消息队列、流式状态、pending tool calls           │
│  把 AgentMessage[] 转换为 Message[]（LLM 格式）              │
│  启动 agentLoop()                                           │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent Loop (agent-loop.ts)                                 │
│  核心循环：                                                  │
│  1. 组装 context (system prompt + messages + tools)          │
│  2. 调用 streamFn() 发起 LLM 请求                            │
│  3. 流式接收 assistant 响应                                  │
│  4. 如果有 tool calls -> 执行工具 -> 把结果加入 messages      │
│  5. 如果没有 tool calls 或 stopReason != "toolCall" -> 结束  │
│  6. 回到步骤 2                                               │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  AI SDK (streamSimple / provider)                           │
│  将标准化请求转换为供应商特定格式 (OpenAI/Anthropic/Google)   │
│  发送 HTTP 请求，解析 SSE 流，发射标准化事件                  │
│  text / toolCall / thinking / usage / stop                  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  LLM API (远程服务)                                         │
│  接收 prompt + tools schema，生成回复                        │
│  返回 SSE 流：文本片段 + 工具调用                            │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼  LLM 返回: toolCall("read", {path: "src/index.ts"})
┌─────────────────────────────────────────────────────────────┐
│  Tool Execution (agent-loop.ts 内部)                        │
│  1. 验证工具参数 (validateToolArguments, Zod schema)         │
│  2. beforeToolCall 钩子 -> 可以拦截                          │
│  3. 执行 tool.execute(args) -> 返回 AgentToolResult          │
│  4. afterToolCall 钩子 -> 可以修改结果                       │
│  5. 发射 tool_execution_end 事件                             │
│  6. 工具结果作为 toolResult 消息加入 context                  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼  循环继续：tool result -> LLM -> 文本响应
┌─────────────────────────────────────────────────────────────┐
│  事件流 (EventStream<AgentEvent>)                           │
│  每一步都发射事件：                                          │
│  turn_start -> text_delta -> tool_call -> tool_execution_*  │
│  -> text_delta -> turn_end                                  │
│  UI 层订阅这些事件来渲染界面                                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  UI 层 (TUI / Web UI / Print)                               │
│  消费事件流，渲染用户界面                                    │
│  TUI: Ink 组件差分渲染到终端                                 │
│  Web UI: React 组件渲染到浏览器                              │
│  Print: 纯文本输出到 stdout                                  │
└─────────────────────────────────────────────────────────────┘
```

### 1.1 用一次真实交互来理解

假设用户输入 "读取 src/index.ts 并总结"。以下是每一层发生的事情：

**第 1 步 -- CLI 层**

```
cli.ts: parseArgs(process.argv)
  -> mode = "interactive"
  -> 进入 interactive-mode.ts
  -> 用户在终端输入消息
  -> 调用 agentSession.send(userMessage)
```

**第 2 步 -- AgentSession**

```
agent-session.ts: send(message)
  -> 检查模型是否已选择
  -> 创建 AgentMessage { role: "user", content: [...] }
  -> 调用 agent.send(message)
  -> 订阅返回的 EventStream
  -> 把事件转发给 UI + 持久化到 session 存储
```

**第 3 步 -- Agent 状态机**

```
agent.ts: send(message)
  -> 把消息加入 state.messages[]
  -> 调用 agentLoop(prompts, context, config)
  -> 返回 EventStream<AgentEvent>
```

**第 4 步 -- Agent Loop 第一轮**

```
agent-loop.ts: runAgentLoop()
  -> convertToLlm(messages) -- 只保留 user/assistant/toolResult
  -> streamFn({ model, system, messages, tools }) -- 调用 AI SDK
  -> 流式接收 LLM 响应
  -> LLM 返回: toolCall("read", { path: "src/index.ts" })
  -> 验证参数 -> 执行 read tool -> 读取文件内容
  -> 文件内容作为 toolResult 消息加入 context
  -> stopReason == "toolCall" -> 继续循环
```

**第 5 步 -- Agent Loop 第二轮**

```
agent-loop.ts: (循环继续)
  -> 带着新的 toolResult 再次调用 streamFn()
  -> LLM 看到文件内容，生成总结文本
  -> 没有新的 tool calls
  -> stopReason == "endTurn" -> 循环结束
```

**第 6 步 -- 事件流回到 UI**

```
EventStream 发射的完整事件序列：
  turn_start
  text_delta("我来") text_delta("读取") text_delta("这个文件")
  tool_call_start("read", {path: "src/index.ts"})
  tool_execution_start
  tool_execution_end(fileContent)
  text_delta("这个文件") text_delta("的主要功能是...")
  turn_end

UI 逐个消费这些事件，实时渲染到屏幕
```

### 1.2 数据格式在各层之间的转换

理解数据格式的转换是理解架构的关键：

```
用户输入 (string)
    ↓ CLI 层
AgentMessage { role: "user", content: [{ type: "text", text: "..." }] }
    ↓ Agent 层 (convertToLlm)
Message { role: "user", content: [{ type: "text", text: "..." }] }
    ↓ AI SDK (provider 转换)
OpenAI格式: { role: "user", content: "..." }
  或 Anthropic格式: { role: "user", content: [{ type: "text", text: "..." }] }
    ↓ HTTP 请求
JSON body -> LLM API
    ↓ SSE 响应流
event: content_block_delta / chunk
    ↓ AI SDK (解析 + 标准化)
AssistantMessageEvent { type: "text", text: "..." }
AssistantMessageEvent { type: "toolCall", name: "read", args: {...} }
    ↓ Agent Loop
AgentEvent { type: "text_delta" | "tool_call" | "tool_execution_end" | ... }
    ↓ UI 层
渲染到终端 / 浏览器 / stdout
```

---

## 2. 层级职责回顾

### 2.1 AI SDK 层 (`packages/ai`)

**职责**：统一多供应商 LLM API，提供标准化的流式事件。

| 关键组件         | 功能                                                        |
| ---------------- | ----------------------------------------------------------- |
| `streamSimple()` | 统一入口：接收标准化请求，路由到正确的 provider             |
| Provider 实现    | 将标准化请求转换为供应商格式 (OpenAI, Anthropic, Google 等) |
| `EventStream`    | 异步事件流抽象，支持 push/end/iterate                       |
| `Model` 类型     | 标准化模型元数据：id, contextWindow, cost, capabilities     |
| `Transport`      | API 密钥、baseUrl、请求头等连接配置                         |
| `Tool` schema    | Zod-based 工具参数 schema 定义                              |

**设计原则**：

- 零 agent 逻辑 -- 不知道循环、会话、状态的存在
- 一次调用 = 一次 LLM 请求，不做自动重试或多轮
- provider 实现通过 lazy registration 按需加载

**我们课程中学到的对应内容**：第 2 课（基础）、第 3 课（provider 管理）。

### 2.2 Agent Core 层 (`packages/agent`)

**职责**：在 LLM API 之上构建 agent 循环和工具执行。

| 关键组件       | 功能                                                               |
| -------------- | ------------------------------------------------------------------ |
| `Agent` 类     | 状态机：消息队列管理、流式状态、abort 控制                         |
| `agentLoop()`  | 核心循环：LLM call -> tool execution -> repeat                     |
| `AgentTool`    | 工具定义接口：name, schema, execute, beforeToolCall, afterToolCall |
| `AgentContext` | 不可变上下文：messages, system prompt, model, tools                |
| `AgentEvent`   | 标准化事件类型：text_delta, tool_call, turn_start/end 等           |
| `AgentState`   | 可观察状态：isStreaming, messages, usage, pendingToolCalls         |

**设计原则**：

- 不知道具体有哪些工具 -- 工具通过配置注入
- 不知道 UI 的存在 -- 通过事件流与外部通信
- 不知道持久化的存在 -- 消息只存在于内存中
- `convertToLlm` 允许自定义消息类型（如 BashExecutionMessage）映射到标准 LLM 消息

**我们课程中学到的对应内容**：第 4 课（状态/事件）、第 5 课（循环/流式）、第 6 课（工具执行）、第 7 课（steering/followup）。

### 2.3 工具层 (`packages/coding-agent/src/core/tools/`)

**职责**：实现具体的工具能力。

| 工具      | 文件       | 功能                                    |
| --------- | ---------- | --------------------------------------- |
| Read      | `read.ts`  | 读取文件，支持 offset/limit，二进制检测 |
| Edit      | `edit.ts`  | 精确字符串替换，支持 replaceAll         |
| Write     | `write.ts` | 写入文件，创建目录                      |
| Bash      | `bash.ts`  | 执行 shell 命令，超时控制，输出截断     |
| Grep      | `grep.ts`  | 正则搜索文件内容                        |
| Find/Glob | `find.ts`  | 文件名模式匹配                          |
| Ls        | `ls.ts`    | 列出目录内容                            |

**设计原则**：

- 每个工具是一个纯函数：输入参数 -> 输出结果
- 工具不知道 agent 循环的存在
- `tool-definition-wrapper.ts` 提供 beforeToolCall/afterToolCall 钩子的统一包装
- `file-mutation-queue.ts` 确保文件操作的串行化

**我们课程中学到的对应内容**：第 9 课（Read）、第 10 课（Bash）、第 11 课（Edit/Write）、第 12 课（辅助工具/系统提示）。

### 2.4 Session 层 (`packages/coding-agent/src/core/`)

**职责**：管理 agent 的完整生命周期和持久化。

| 关键组件             | 功能                                     |
| -------------------- | ---------------------------------------- |
| `AgentSession`       | 会话生命周期：创建/恢复/切换/分支        |
| `session-manager.ts` | 会话仓库：列出、删除、重命名会话         |
| `model-resolver.ts`  | 模型选择：provider 检测、默认模型        |
| `compaction/`        | 上下文压缩：token 计算、自动/手动压缩    |
| `system-prompt.ts`   | 系统提示组装：模板 + 环境信息 + 工具说明 |
| `bash-executor.ts`   | Bash 执行器：进程管理、超时、操作队列    |

**设计原则**：

- AgentSession 是所有运行模式（interactive, print, rpc）的共享核心
- 持久化通过 JSONL 格式实现，每个事件一行
- 压缩策略可配置：阈值、保留策略

**我们课程中学到的对应内容**：第 13 课（持久化）、第 14 课（压缩）。

### 2.5 Extension 层 (`packages/coding-agent/src/core/extensions/`)

**职责**：允许第三方代码扩展 agent 的能力。

| 关键组件     | 功能                                    |
| ------------ | --------------------------------------- |
| `types.ts`   | Extension API 接口定义                  |
| `loader.ts`  | 从文件系统加载 extension 模块           |
| `runner.ts`  | 生命周期管理：初始化、事件分发、清理    |
| `wrapper.ts` | 将 extension 注册的工具包装为 AgentTool |

**设计原则**：

- Extension 通过约定接口（hooks）与核心交互，不直接修改核心代码
- 支持工具注册、事件监听、系统提示增强
- 隔离性：extension 崩溃不会影响核心 agent

**我们课程中学到的对应内容**：第 15 课（API 设计）、第 16 课（实践）。

### 2.6 UI 层

**职责**：将 agent 事件流渲染为用户可见的界面。

| 模式        | 实现                | 特点                           |
| ----------- | ------------------- | ------------------------------ |
| Interactive | Ink (React for CLI) | 差分渲染、键盘快捷键、实时更新 |
| Print       | 纯文本 stdout       | 单次执行、管道友好             |
| RPC         | JSON-RPC over stdio | 无头模式、Web UI 集成          |

**设计原则**：

- UI 层只消费事件，不修改 agent 状态
- 所有模式共享同一个 AgentSession
- TUI 自建渲染引擎（`pi-tui`），不依赖 blessed/ink 的布局

**我们课程中学到的对应内容**：第 17 课（Ink TUI）、第 18 课（CLI 入口/模式）。

### 2.7 层级边界总结

```
┌──────────────────────────────────────────────────────────┐
│                    UI Layer                               │
│  Interactive (Ink)  │  Print (stdout)  │  RPC (JSON-RPC) │
├──────────────────────────────────────────────────────────┤
│                  Extension Layer                         │
│  loader -> runner -> wrapper -> hooks                    │
├──────────────────────────────────────────────────────────┤
│                  Session Layer                           │
│  AgentSession  │  Compaction  │  Persistence  │  Model   │
├──────────────────────────────────────────────────────────┤
│                   Tool Layer                             │
│  Read │ Edit │ Write │ Bash │ Grep │ Find │ Ls          │
├──────────────────────────────────────────────────────────┤
│                 Agent Core Layer                         │
│  Agent (state machine)  │  AgentLoop  │  EventStream    │
├──────────────────────────────────────────────────────────┤
│                  AI SDK Layer                            │
│  streamSimple  │  Providers  │  Model metadata           │
├──────────────────────────────────────────────────────────┤
│               LLM APIs (external)                        │
│  OpenAI  │  Anthropic  │  Google  │  Bedrock  │  ...    │
└──────────────────────────────────────────────────────────┘
```

每两层之间的通信契约：

| 边界              | 向下传递                                      | 向上传递                      |
| ----------------- | --------------------------------------------- | ----------------------------- |
| UI <-> Session    | `send(message)`, `compact()`, `switchModel()` | `AgentEvent` 事件流           |
| Session <-> Agent | `agent.send(AgentMessage)`                    | `EventStream<AgentEvent>`     |
| Agent <-> Loop    | `AgentContext` + `AgentLoopConfig`            | `AgentEvent` via sink         |
| Loop <-> AI SDK   | `SimpleStreamOptions`                         | `AssistantMessageEventStream` |
| AI SDK <-> LLM    | HTTP request (provider-specific JSON)         | SSE stream                    |

---

## 3. pi 完整实现 vs 我们的简化版

在整个课程中，我们构建了一个简化版的 agent 系统来学习核心概念。以下是 pi 完整实现中我们没有涉及的部分：

### 3.1 自定义 TUI 渲染引擎 (`pi-tui`)

pi 没有直接使用 Ink 的布局系统，而是构建了自己的差分渲染引擎：

```
pi-tui 做了什么：
├── 自定义 Yoga 布局计算
├── 差分渲染 -- 只重绘变化的区域，而非整个屏幕
├── ANSI 转义序列直接操作 -- 精确控制光标位置和颜色
├── 自适应终端尺寸 -- 监听 resize 事件，动态重新布局
└── 独立于 agent 逻辑 -- 可用于任何终端 UI 项目
```

我们课程中使用了 Ink 的标准组件（`<Box>`, `<Text>`），这对于学习足够了，但 pi 的渲染性能要好得多。

### 3.2 自定义 LLM 层 (`pi-ai`)

pi 没有使用 Vercel AI SDK，而是从零构建了自己的 LLM 抽象层：

```
pi-ai 做了什么：
├── 统一 15+ 供应商的 API 差异
│   ├── 每个供应商一个 provider 文件
│   ├── 统一的 Message/Tool/AssistantMessage 类型系统
│   └── 标准化的事件流：text, toolCall, thinking, usage, stop
├── Lazy provider registration -- 按需加载，启动快
├── Transport 抽象 -- API key, base URL, custom headers
├── Token 计算和成本估算
├── 流式解析每个供应商的 SSE 格式差异
└── 完整的错误处理和重试逻辑
```

我们课程中直接使用了 Vercel AI SDK 的 `streamText()`。在生产项目中，自建 LLM 层的优势是完全控制行为、更好的错误处理、以及消除外部依赖。

### 3.3 Web UI (`pi-web-ui`)

pi 提供了一个完整的 Web 组件库用于浏览器中的 AI 聊天：

```
pi-web-ui 做了什么：
├── React 组件库 -- 消息气泡、代码块、工具调用可视化
├── 通过 RPC 模式与后端通信
│   └── coding-agent 的 RPC 模式 = Web UI 的后端
├── 实时流式渲染 -- 打字机效果，工具执行进度
├── 会话管理 UI -- 列表、切换、分支
└── 响应式设计 -- 移动端和桌面端
```

### 3.4 完整的 RPC 系统

pi 的 RPC 模式是一个完整的 JSON-RPC 实现：

```
RPC 模式做了什么：
├── JSON-RPC 2.0 协议 over stdio
├── 双向通信 -- 客户端请求 + 服务端推送
├── 完整的方法集：
│   ├── send -- 发送用户消息
│   ├── getState -- 获取 agent 状态
│   ├── switchModel -- 切换模型
│   ├── compact -- 触发压缩
│   ├── listSessions / switchSession -- 会话管理
│   └── subscribe/unsubscribe -- 事件订阅
├── JSONL 帧协议 -- 用 newline 分隔 JSON 消息
└── Web UI 作为 RPC 客户端连接
```

### 3.5 生产级功能清单

| 功能             | pi 实现                           | 我们的简化版                |
| ---------------- | --------------------------------- | --------------------------- |
| 多 provider 支持 | 15+ 供应商                        | 单一 provider (通过 AI SDK) |
| 工具数量         | 7+ 内置 + extension 工具          | 2-3 个核心工具              |
| 会话持久化       | JSONL 文件存储 + 分支             | 内存或简单文件              |
| 上下文压缩       | 自动 + 手动 + 分支摘要            | 基础截断                    |
| Extension 系统   | 完整的生命周期 + 工具注册         | Hook 框架                   |
| UI               | 自定义 TUI + Web UI + Print + RPC | 简单 Ink UI                 |
| Bash 执行        | 进程池 + 超时 + 操作队列          | 简单 child_process          |
| 错误处理         | 每层独立错误恢复                  | 基础 try/catch              |
| 模型切换         | 运行时热切换 + 自动检测           | 启动时配置                  |
| Thinking 支持    | 多级 thinking budget              | 无                          |
| 遥测             | 诊断收集 + 性能计时               | 无                          |

---

## 4. 演进方向

### 4.1 MCP (Model Context Protocol) 集成

MCP 是由 Anthropic 提出的开放协议，目标是标准化 agent 与外部工具/资源的通信方式。

**MCP 解决什么问题**：

目前 pi 的工具是在代码中硬编码注册的。如果你想添加一个数据库查询工具，你必须：

1. 写一个 TypeScript 模块
2. 实现 `AgentTool` 接口
3. 在 tools/index.ts 中注册
4. 重新编译和部署

有了 MCP，工具可以运行在独立的进程中（MCP Server），agent 通过标准协议动态发现和调用它们：

```
当前架构：
┌──────────────────────┐
│     Agent            │
│  ┌────┐ ┌────┐     │
│  │Read│ │Bash│ ... │  <- 工具编译在 agent 内部
│  └────┘ └────┘     │
└──────────────────────┘

MCP 架构：
┌──────────────────────┐     stdio/SSE      ┌──────────────────┐
│     Agent            │ <================> │  MCP Server:     │
│  (MCP Client)        │     JSON-RPC       │  database-tools  │
└──────────────────────┘                    └──────────────────┘
                             stdio/SSE      ┌──────────────────┐
                         <================> │  MCP Server:     │
                             JSON-RPC       │  git-tools       │
                                            └──────────────────┘
```

**集成路径**：

```typescript
// 1. 安装 MCP SDK
// npm install @modelcontextprotocol/sdk

// 2. 创建 MCP Client
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
});

const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);

// 3. 发现工具
const { tools } = await client.listTools();
// tools = [{ name: "read_file", inputSchema: {...} }, ...]

// 4. 把 MCP 工具转换为 AgentTool
function mcpToolToAgentTool(mcpTool, client): AgentTool {
  return {
    name: mcpTool.name,
    description: mcpTool.description,
    schema: convertJsonSchemaToZod(mcpTool.inputSchema),
    execute: async (args) => {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: args,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result.content) }],
      };
    },
  };
}
```

**pi 的 Extension 系统已经为 MCP 做了准备**：Extension 可以注册工具，MCP Client 可以作为一个特殊的 Extension 实现，在初始化时连接 MCP Server，把发现的工具注册到 agent 中。

### 4.2 Sub-Agent / Multi-Agent

当前 pi 是单 agent 架构：一个 Agent 实例处理所有任务。对于复杂任务，可以引入多 agent 协作。

**Orchestrator-Worker 模式**：

```
用户: "重构整个项目的错误处理"
         │
         ▼
┌─────────────────────────────┐
│  Orchestrator Agent          │
│  分析任务，分解为子任务       │
│  1. 审查当前错误处理模式      │
│  2. 设计新的错误类型体系      │
│  3. 逐文件重构               │
│  4. 运行测试验证              │
└─────────┬───────────────────┘
          │
    ┌─────┼─────┬──────────┐
    ▼     ▼     ▼          ▼
 Worker  Worker Worker   Worker
 (审查)  (设计) (重构x3) (测试)
```

**实现思路**：

```typescript
// Sub-agent 就是一个配置不同工具和 system prompt 的 Agent 实例
function createSubAgent(role: string, tools: AgentTool[]): Agent {
  return new Agent({
    model,
    systemPrompt: `You are a ${role} specialist. Focus only on your task.`,
    tools,
    // 子 agent 可以用更小的模型降低成本
    streamFn: (opts) => streamSimple({ ...opts, model: cheaperModel }),
  });
}

// Orchestrator 把 sub-agent 作为一个工具
const delegateTool: AgentTool = {
  name: "delegate",
  description: "Delegate a subtask to a specialist agent",
  schema: z.object({
    role: z.enum(["reviewer", "designer", "implementer", "tester"]),
    task: z.string(),
  }),
  execute: async ({ role, task }) => {
    const subAgent = createSubAgent(role, getToolsForRole(role));
    const result = await subAgent.send({ role: "user", content: task });
    return { content: [{ type: "text", text: result.text }] };
  },
};
```

**注意事项**：

- 子 agent 的上下文是独立的，不共享主 agent 的历史
- 需要设计好信息传递机制：orchestrator 提供足够的上下文给 worker
- 成本控制：每个子 agent 调用都消耗 token
- 错误传播：子 agent 失败时，orchestrator 需要决定重试还是换方案

### 4.3 Web UI (AI SDK UI + useChat)

如果使用 Vercel AI SDK 构建 Web UI，可以利用 `useChat` hook 快速实现流式聊天界面：

**后端 (Next.js API Route)**：

```typescript
// app/api/chat/route.ts
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai("gpt-4o"),
    system: "You are a coding assistant.",
    messages,
    tools: {
      readFile: {
        description: "Read a file from the project",
        parameters: z.object({ path: z.string() }),
        execute: async ({ path }) => {
          const content = await fs.readFile(path, "utf-8");
          return content;
        },
      },
    },
    maxSteps: 10,
  });

  return result.toDataStreamResponse();
}
```

**前端 (React)**：

```typescript
// app/page.tsx
import { useChat } from "@ai-sdk/react";

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } =
    useChat({ api: "/api/chat" });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id}>
          <strong>{m.role}:</strong> {m.content}
          {m.toolInvocations?.map((tool) => (
            <div key={tool.toolCallId}>
              Tool: {tool.toolName} -> {tool.state}
            </div>
          ))}
        </div>
      ))}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} />
        <button type="submit" disabled={isLoading}>Send</button>
      </form>
    </div>
  );
}
```

**与 pi 的 RPC 模式对比**：

| 方面     | AI SDK useChat       | pi RPC 模式         |
| -------- | -------------------- | ------------------- |
| 通信协议 | HTTP + SSE           | stdio + JSON-RPC    |
| 部署模型 | Web server (Next.js) | Local process       |
| 工具执行 | Server-side          | Local machine       |
| 状态管理 | React state + SDK    | AgentSession        |
| 适用场景 | Web 应用             | 桌面 agent + Web UI |

### 4.4 沙箱执行

当前 pi 的 Bash 工具直接在宿主机上执行命令。这在受信任的环境下没问题，但如果 agent 要运行不受信任的代码，就需要沙箱隔离：

**Docker 沙箱**：

```typescript
import Docker from "dockerode";

const docker = new Docker();

async function executeSandboxed(command: string): Promise<string> {
  const container = await docker.createContainer({
    Image: "node:20-slim",
    Cmd: ["bash", "-c", command],
    // 安全限制
    HostConfig: {
      Memory: 512 * 1024 * 1024, // 512MB 内存限制
      CpuPeriod: 100000,
      CpuQuota: 50000, // 50% CPU
      NetworkMode: "none", // 禁止网络
      ReadonlyRootfs: true,
      // 挂载工作目录为只读
      Binds: [`${workDir}:/workspace:ro`],
    },
  });

  await container.start();

  // 设置超时
  const timeout = setTimeout(() => container.kill(), 30000);

  const stream = await container.logs({ follow: true, stdout: true, stderr: true });
  const output = await collectStream(stream);

  clearTimeout(timeout);
  await container.remove({ force: true });

  return output;
}
```

**E2B Cloud Sandbox**：

```typescript
import { Sandbox } from "@e2b/code-interpreter";

async function executeInCloud(code: string): Promise<string> {
  const sandbox = await Sandbox.create();
  const execution = await sandbox.runCode(code);
  await sandbox.kill();
  return execution.text;
}
```

**渐进式方案**：

1. **阶段 1**：进程级隔离 -- 使用 `--no-network` flag，限制文件系统访问（pi 当前阶段）
2. **阶段 2**：Docker 容器 -- 每次执行创建临时容器
3. **阶段 3**：microVM (Firecracker) -- 亚秒级启动的轻量虚拟机

### 4.5 结构化输出

当前 agent 的所有输出都是自由文本。结构化输出让 LLM 直接生成符合 schema 的 JSON，用于需要精确格式的场景：

```typescript
import { generateObject } from "ai";
import { z } from "zod";

// 让 LLM 生成结构化的代码审查报告
const { object: review } = await generateObject({
  model: openai("gpt-4o"),
  schema: z.object({
    summary: z.string().describe("One-line summary of the review"),
    issues: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        severity: z.enum(["error", "warning", "info"]),
        message: z.string(),
        suggestedFix: z.string().optional(),
      }),
    ),
    approved: z.boolean(),
  }),
  prompt: `Review this code change:\n${diff}`,
});

// review.issues 是类型安全的数组
for (const issue of review.issues) {
  console.log(`${issue.severity} at ${issue.file}:${issue.line}: ${issue.message}`);
}
```

**在 agent 中的应用场景**：

- 任务分解：让 LLM 输出结构化的子任务列表
- 工具选择：让 LLM 输出 `{ tool: string, reason: string }` 而非自由文本
- 代码生成：让 LLM 输出 `{ filePath: string, content: string }[]` 而非 markdown 代码块
- 评估和决策：让 LLM 输出评分和理由的结构化格式

---

## 5. 完整架构图

以下是 pi 系统的完整架构图，标注了每个模块的位置和职责：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER INTERFACE LAYER                            │
│                                                                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌────────────────────────┐  │
│  │  Interactive     │  │  Print Mode     │  │  RPC Mode              │  │
│  │  (Ink TUI)       │  │  (stdout)       │  │  (JSON-RPC/stdio)     │  │
│  │                  │  │                  │  │                        │  │
│  │  Ink components  │  │  console.log()   │  │  rpc-types.ts         │  │
│  │  theme.ts        │  │  Markdown render │  │  rpc-mode.ts          │  │
│  │  keybindings.ts  │  │                  │  │  jsonl framing        │  │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────┬────────────┘  │
│           │                     │                        │               │
│           └─────────────────────┼────────────────────────┘               │
│                                 │ agentSession.send(msg)                 │
├─────────────────────────────────┼───────────────────────────────────────┤
│                        SESSION LAYER                                     │
│                                 │                                        │
│  ┌──────────────────────────────┴──────────────────────────────────┐    │
│  │                     AgentSession                                 │    │
│  │  agent-session.ts (3100+ lines)                                  │    │
│  │                                                                   │    │
│  │  - Model selection & hot-switching                                │    │
│  │  - Event subscription + session persistence                       │    │
│  │  - Thinking level management                                      │    │
│  │  - Bash execution (bash-executor.ts)                              │    │
│  │  - Session branching & switching                                  │    │
│  │  - HTML export                                                    │    │
│  └──────┬──────────┬──────────────┬────────────┬────────────────────┘    │
│         │          │              │            │                          │
│  ┌──────┴───┐ ┌────┴─────┐ ┌─────┴──────┐ ┌──┴──────────────┐          │
│  │Compaction│ │Persistence│ │  System    │ │ Model           │          │
│  │          │ │           │ │  Prompt    │ │ Resolver        │          │
│  │compact() │ │JSONL store│ │system-     │ │model-resolver.ts│          │
│  │auto/     │ │session/   │ │prompt.ts   │ │model-registry.ts│          │
│  │manual    │ │repo/      │ │templates   │ │                 │          │
│  └──────────┘ └───────────┘ └────────────┘ └─────────────────┘          │
├─────────────────────────────────────────────────────────────────────────┤
│                       EXTENSION LAYER                                    │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  ExtensionRunner                                                 │    │
│  │  loader.ts -> runner.ts -> wrapper.ts                            │    │
│  │                                                                   │    │
│  │  Hooks: onSessionStart, onTurnStart, onTurnEnd,                  │    │
│  │         onToolExecutionStart/End, onBeforeCompact,               │    │
│  │         registerTools, enhanceSystemPrompt                        │    │
│  │                                                                   │    │
│  │  Tool registration: extension tools -> AgentTool wrapper          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────────────────┤
│                         TOOL LAYER                                       │
│                                                                         │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐  │
│  │  Read  │ │  Edit  │ │ Write  │ │  Bash  │ │  Grep  │ │Find / Ls │  │
│  │read.ts │ │edit.ts │ │write.ts│ │bash.ts │ │grep.ts │ │find/ls.ts│  │
│  └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └────┬─────┘  │
│      │          │          │          │          │            │         │
│      └──────────┴──────────┴──────────┴──────────┴────────────┘         │
│                        │                                                 │
│      tool-definition-wrapper.ts (beforeToolCall / afterToolCall)         │
│      file-mutation-queue.ts (serialized file operations)                 │
├─────────────────────────────────────────────────────────────────────────┤
│                      AGENT CORE LAYER                                    │
│                                                                         │
│  ┌────────────────────────────────────────────────┐                     │
│  │  Agent (agent.ts)                               │                     │
│  │  - State machine: idle -> streaming -> idle     │                     │
│  │  - Message queue (QueueMode: all | one-at-a-time)│                    │
│  │  - AbortController management                   │                     │
│  │  - AgentMessage[] -> Message[] conversion        │                     │
│  └──────────────────────┬─────────────────────────┘                     │
│                          │                                               │
│  ┌──────────────────────┴─────────────────────────┐                     │
│  │  AgentLoop (agent-loop.ts)                      │                     │
│  │  while (stopReason == "toolCall") {             │                     │
│  │    response = streamFn(context)                 │                     │
│  │    for (toolCall of response.toolCalls) {       │                     │
│  │      result = validateAndExecute(toolCall)      │                     │
│  │      context.messages.push(toolResult)          │                     │
│  │    }                                            │                     │
│  │  }                                              │                     │
│  └──────────────────────┬─────────────────────────┘                     │
│                          │ streamFn(SimpleStreamOptions)                  │
├──────────────────────────┼──────────────────────────────────────────────┤
│                      AI SDK LAYER                                        │
│                          │                                               │
│  ┌──────────────────────┴─────────────────────────┐                     │
│  │  streamSimple() -> provider routing             │                     │
│  └──────────────────────┬─────────────────────────┘                     │
│                          │                                               │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ OpenAI   │ │Anthropic │ │  Google   │ │ Bedrock  │ │  Others...  │  │
│  │provider  │ │ provider │ │ provider  │ │ provider │ │             │  │
│  └────┬─────┘ └────┬─────┘ └─────┬─────┘ └────┬─────┘ └──────┬──────┘  │
│       │            │             │             │              │         │
│       └────────────┴─────────────┴─────────────┴──────────────┘         │
│                          │ HTTP + SSE                                     │
├──────────────────────────┼──────────────────────────────────────────────┤
│                     LLM APIs (External)                                  │
│                          │                                               │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐                  │
│  │ OpenAI   │ │Anthropic │ │  Gemini   │ │ AWS      │                  │
│  │ API      │ │ API      │ │  API      │ │ Bedrock  │                  │
│  └──────────┘ └──────────┘ └───────────┘ └──────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6. "接下来改进什么" 清单

完成了 20 课的学习后，以下是你的 agent 项目可以继续改进的方向。按优先级排序：

### 高优先级（立即可做）

- [ ] **添加更多工具**：当前只有 read + bash，添加 edit（精确替换）、write（创建文件）、grep（内容搜索）、find（文件查找）
- [ ] **改进错误处理**：工具执行失败时，返回有意义的错误消息而非崩溃；LLM API 错误时自动重试
- [ ] **添加 AbortController 支持**：用户可以中断正在进行的 agent 循环
- [ ] **实现会话持久化**：把消息历史保存到 JSONL 文件，支持恢复中断的对话
- [ ] **添加 token 使用量追踪**：显示每次对话消耗的 input/output token 数和成本估算

### 中优先级（需要更多设计）

- [ ] **上下文压缩**：当消息历史超过 context window 的阈值时，自动摘要旧消息
- [ ] **多 provider 支持**：通过环境变量或配置文件选择 OpenAI / Anthropic / Google
- [ ] **Extension API**：允许第三方模块注册工具和修改系统提示
- [ ] **MCP Client 集成**：连接 MCP Server，动态发现和使用外部工具
- [ ] **结构化输出任务**：对特定场景（代码审查、任务分解）使用 `generateObject` 而非自由文本

### 低优先级（进阶方向）

- [ ] **Web UI**：使用 AI SDK 的 `useChat` 构建浏览器界面
- [ ] **Multi-agent**：实现 orchestrator-worker 模式处理复杂任务
- [ ] **沙箱执行**：Docker 容器隔离 bash 命令执行
- [ ] **自定义 TUI**：替换 Ink 标准组件，使用差分渲染提高性能
- [ ] **流式工具结果**：工具执行过程中实时推送进度（如 bash 命令输出）
- [ ] **分支对话**：从历史消息的任意点创建对话分支
- [ ] **Thinking 支持**：对支持 extended thinking 的模型启用 thinking budget

### 架构改进

- [ ] **类型安全的事件总线**：替换简单的回调为强类型的 EventEmitter
- [ ] **工具执行模式**：支持 sequential 和 parallel 两种工具执行模式
- [ ] **beforeToolCall/afterToolCall 钩子**：允许拦截和修改工具调用
- [ ] **自定义消息类型**：支持 `convertToLlm` 自定义映射，允许 BashExecution 等特殊消息类型
- [ ] **配置管理**：统一的配置文件（YAML/TOML），支持工作区级别的覆盖

---

## 7. 课程总结

回顾 20 课的学习路径：

```
第 1-3 课：基础设施
  项目架构 -> AI SDK 基础 -> Provider 管理
  "一个 agent 站在什么地基上"

第 4-7 课：核心循环
  状态/事件 -> 循环/流式 -> 工具执行 -> Steering
  "agent 的心脏是如何跳动的"

第 8 课：测试
  Mock Provider -> 确定性测试
  "如何验证你的 agent 是正确的"

第 9-12 课：工具能力
  Read -> Bash -> Edit/Write -> System Prompt + 辅助工具
  "agent 的手和眼睛"

第 13-14 课：记忆
  Session 持久化 -> Context 压缩
  "agent 如何记住过去，又如何忘记"

第 15-16 课：可扩展性
  Extension API 设计 -> Extension 实践
  "如何让别人给你的 agent 添加能力"

第 17-18 课：用户界面
  Ink TUI -> CLI 入口和模式
  "agent 如何与人交互"

第 19 课：生产化
  错误恢复、性能、安全
  "从玩具到工具"

第 20 课：回顾与未来
  全链路追踪、架构总结、演进方向
  "站在山顶回看来路，望向远方"
```

### 核心设计原则（贯穿整个课程）

1. **分层隔离**：每一层只知道自己的职责，通过明确的接口与相邻层通信
2. **事件驱动**：agent 的所有状态变化都通过事件流传播，UI 是事件的消费者
3. **工具即函数**：工具是纯函数，输入参数，输出结果，不知道循环和状态的存在
4. **可测试性优先**：每一层都可以通过 mock 相邻层来独立测试
5. **渐进式复杂度**：从最简单的实现开始，在真实需求驱动下逐步增加复杂度

你现在拥有了从零构建一个生产级 AI agent 所需的全部知识。`code/src/full-example.ts` 是一个完整的单文件参考实现，你可以从它开始，按照清单逐步演进。

祝你构建出优秀的 agent。
