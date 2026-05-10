# 第 18 课：CLI 入口与运行模式

## 本课目标

理解一个 CLI Agent 从进程启动到模式分发的完整流程。学完本课你能回答：

- `cli.ts` 的 22 行代码各做了什么？
- `main.ts` 如何把参数、会话、服务、运行时串联成一条管线？
- Interactive / Print / RPC 三种运行模式的输入输出差异是什么？
- `AgentSession` 为什么是所有模式共享的门面对象？

---

## 1. CLI 入口：cli.ts

pi 的 CLI 入口是 `packages/coding-agent/src/cli.ts`，只有 22 行。每一行都有明确职责：

```ts
#!/usr/bin/env node                       // (1) shebang -- 让 shell 知道用 node 执行
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { APP_NAME } from "./config.js";
import { main } from "./main.js";

process.title = APP_NAME; // (2) 设置进程名 -- ps / 任务管理器可读
process.env.PI_CODING_AGENT = "true"; // (3) 标记自身 -- 防止嵌套调用时的 bash 工具递归
process.emitWarning = (() => {}) as any; // (4) 静默 Node 弃用警告

// (5) 代理 + 超时设置
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

main(process.argv.slice(2)); // (6) 把控制权交给 main()
```

### 关键设计：入口与编排分离

`cli.ts` 只做进程级环境设置，不包含任何业务逻辑。所有逻辑在 `main.ts`，这样做的好处：

- **可测试性**：可以直接调用 `main(["--model", "sonnet", "-p", "hello"])` 而不用 spawn 子进程。
- **可嵌入性**：SDK 用户可以跳过 `cli.ts`，直接调用 `main()` 或更底层的 API。

### shebang 工作原理

```
#!/usr/bin/env node
```

Unix 系统看到这行后，会执行 `env node cli.ts`。`env` 在 `$PATH` 中搜索 `node`，比硬编码 `/usr/local/bin/node` 更具可移植性。在 Windows 上 shebang 被 npm/yarn 的 bin wrapper 处理。

### 为什么用 EnvHttpProxyAgent？

LLM 的 SSE 流可能持续数分钟（例如 vLLM 缓冲大型 tool call）。undici 默认的 `bodyTimeout` 和 `headersTimeout` 均为 300 秒，超时后会中断流。设置为 0 禁用这两个超时，让 provider SDK 自己管理 AbortController 超时。

同时 `EnvHttpProxyAgent` 会自动读取 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，让企业环境用户无需额外配置。

---

## 2. 参数解析：args.ts

pi 没有使用 commander.js，而是手写了一个单遍扫描解析器：

```ts
export function parseArgs(args: string[]): Args {
  const result: Args = {
    messages: [],
    fileArgs: [],
    unknownFlags: new Map(),
    diagnostics: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model" && i + 1 < args.length) {
      result.model = args[++i];
    } else if (arg === "--print" || arg === "-p") {
      result.print = true;
      // -p 后面可以跟一个 prompt
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        result.messages.push(next);
        i++;
      }
    } else if (arg.startsWith("@")) {
      result.fileArgs.push(arg.slice(1));
    } else if (arg.startsWith("--")) {
      // 未知 flag -- 收集起来给扩展系统
      result.unknownFlags.set(arg.slice(2), true);
    } else {
      result.messages.push(arg);
    }
  }
  return result;
}
```

### 为什么不用 commander.js？

1. **减少依赖体积**：commander.js 约 180KB，对 CLI 工具来说是不小的开销。
2. **未知 flag 转发**：pi 的扩展系统允许注册自定义 CLI flag（如 `--plan`），这些 flag 在解析时是未知的。commander.js 默认会报错，需要额外配置。手写解析器直接将未知 flag 收集到 `unknownFlags` Map。
3. **`-p` 的特殊语义**：`-p` 既是 bool flag 又可以携带一个参数（`-p "hello"`），这在 commander.js 中需要 custom processing。

### Args 接口核心字段

```ts
interface Args {
  provider?: string; // --provider anthropic
  model?: string; // --model sonnet
  apiKey?: string; // --api-key sk-xxx
  systemPrompt?: string; // --system-prompt "You are..."
  thinking?: ThinkingLevel; // --thinking high
  print?: boolean; // -p
  mode?: Mode; // --mode rpc | json | text
  tools?: string[]; // --tools read,bash
  noTools?: boolean; // --no-tools
  messages: string[]; // 位置参数 -- 非 flag 的文本
  fileArgs: string[]; // @file 参数
  unknownFlags: Map<string, boolean | string>;
  diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}
```

---

## 3. 主编排：main.ts

`main.ts` 是整个启动管线的核心。简化后的控制流：

```
main(argv)
  |
  +-- (1) parseArgs(argv)
  |
  +-- (2) resolveAppMode(parsed, stdin.isTTY)
  |         -> "interactive" | "print" | "json" | "rpc"
  |
  +-- (3) 快速退出路径
  |         --version -> print VERSION, exit
  |         --help    -> printHelp(), exit
  |         --export  -> exportFromFile(), exit
  |
  +-- (4) createSessionManager(parsed, cwd, sessionDir)
  |         --no-session  -> inMemory()
  |         --session X   -> open(X)
  |         --continue    -> continueRecent(cwd)
  |         --resume      -> TUI 选择器
  |         default       -> create(cwd)
  |
  +-- (5) createAgentSessionRuntime(factory, context)
  |         factory 内部:
  |         +-- createAgentSessionServices()   // auth, models, settings, resources
  |         +-- buildSessionOptions()          // 从 CLI flag 映射到 session 选项
  |         +-- createAgentSessionFromServices()
  |               +-- new AgentSession(config) // facade 对象
  |
  +-- (6) 读取 piped stdin（非 RPC 模式）
  |
  +-- (7) prepareInitialMessage(parsed, autoResize, stdinContent)
  |
  +-- (8) 模式分发
          rpc         -> runRpcMode(runtime)
          interactive -> new InteractiveMode(runtime).run()
          print/json  -> runPrintMode(runtime, opts)
```

### 步骤 (2)：模式判定逻辑

```ts
function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
  if (parsed.mode === "rpc") return "rpc";
  if (parsed.mode === "json") return "json";
  if (parsed.print || !stdinIsTTY) return "print";
  return "interactive";
}
```

注意 `!stdinIsTTY` -- 如果 stdin 是管道输入（例如 `echo "hello" | pi`），自动切换到 print 模式。这让 pi 可以无缝嵌入 shell 管道。

### 步骤 (5)：运行时工厂模式

`createAgentSessionRuntime` 接受一个工厂函数而非直接的配置对象：

```ts
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd, agentDir, sessionManager, sessionStartEvent
}) => {
  const services = await createAgentSessionServices({ cwd, agentDir, authStorage, ... });
  const { options } = buildSessionOptions(parsed, scopedModels, ...);
  const created = await createAgentSessionFromServices({ services, sessionManager, ... });
  return { ...created, services, diagnostics };
};

const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
```

工厂模式的好处：当用户在 interactive 模式中切换会话时，可以用相同的工厂重新创建整个运行时，而不需要重新解析 CLI 参数。

---

## 4. 三种运行模式

### 4.1 Interactive 模式（默认）

```
pi
pi "help me refactor this"
```

- 使用 ink（React for CLI）渲染 TUI 界面
- 全双工：用户可以在 agent 运行时发送 steering message
- 支持 Ctrl+P 切换模型、Ctrl+C 中断、/command 斜杠命令
- 入口：`new InteractiveMode(runtime, options).run()`

### 4.2 Print 模式（-p 或管道输入）

```
pi -p "list all .ts files in src/"
echo "explain this code" | pi
pi --mode json "hello"
```

- 单次执行：发送 prompt -> 流式输出 -> 退出
- 两种输出格式：
  - `text`：只输出最终 assistant 文本（默认）
  - `json`：输出所有 AgentSessionEvent 作为 JSON 行（`--mode json`）
- 适合脚本集成：退出码 0 表示成功，1 表示错误

Print 模式的核心逻辑：

```ts
async function runPrintMode(runtime, options): Promise<number> {
  const { mode, messages, initialMessage, initialImages } = options;
  let session = runtime.session;

  // 订阅事件 -- JSON 模式下每个事件输出一行
  session.subscribe((event) => {
    if (mode === "json") {
      writeRawStdout(JSON.stringify(event) + "\n");
    }
  });

  // 发送 prompt
  if (initialMessage) {
    await session.prompt(initialMessage, { images: initialImages });
  }
  for (const msg of messages) {
    await session.prompt(msg);
  }

  // text 模式：提取最后一条 assistant 消息的文本
  if (mode === "text") {
    const last = session.state.messages.at(-1);
    if (last?.role === "assistant") {
      for (const content of last.content) {
        if (content.type === "text") {
          writeRawStdout(content.text + "\n");
        }
      }
    }
  }

  return exitCode;
}
```

### 4.3 RPC 模式（--mode rpc）

```
pi --mode rpc
```

- 无头运行：通过 stdin 接收 JSON 命令，通过 stdout 发送 JSON 事件和响应
- 用于嵌入到编辑器（VS Code）、Web UI、或其他应用中
- 协议：
  - **命令**（stdin）：`{ "type": "prompt", "id": "1", "text": "hello" }`
  - **响应**（stdout）：`{ "type": "response", "id": "1", "command": "prompt", "success": true }`
  - **事件**（stdout）：实时推送的 AgentSessionEvent
- 支持命令：prompt、abort、model_set、thinking_set、compact、session_state、shutdown 等

---

## 5. API Key 解析链

pi 从多个来源查找 API key，优先级从高到低：

```
1. --api-key CLI 参数
   |  authStorage.setRuntimeApiKey(provider, key)
   v
2. 环境变量
   |  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...
   v
3. 配置文件 (~/.config/pi/agent/auth.json)
   |  AuthStorage.create() 加载
   v
4. OAuth 令牌
   |  通过 /login 命令获取的令牌
   v
5. 无 key -> 报错
   "No API key found for provider X"
```

这个链在 `ModelRegistry.getApiKeyAndHeaders()` 中实现。`AgentSession._getRequiredRequestAuth()` 在每次 LLM 调用前执行此检查。

---

## 6. AgentSession 门面

`AgentSession` 是所有运行模式共享的核心抽象。它把 Agent（核心循环）、SessionManager（持久化）、ExtensionRunner（扩展系统）、工具注册等统一在一个接口后面。

### 职责一览

| 职责          | 方法                                         |
| ------------- | -------------------------------------------- |
| 发送 prompt   | `prompt(text, options)`                      |
| 中断当前操作  | `abort()`                                    |
| 模型管理      | `setModel()`, `cycleModel()`                 |
| Thinking 级别 | `setThinkingLevel()`, `cycleThinkingLevel()` |
| 工具管理      | `setActiveToolsByName()`, `getAllTools()`    |
| 会话压缩      | `compact()`, 自动压缩检查                    |
| Bash 执行     | `executeBash(command, onChunk)`              |
| 事件订阅      | `subscribe(listener)`                        |
| 扩展绑定      | `bindExtensions(bindings)`                   |
| 运行时重建    | `reload()`                                   |
| 会话导航      | `navigateTree(targetId)`                     |

### 构造函数：初始化链

```ts
class AgentSession {
  constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this.settingsManager = config.settingsManager;
    this._resourceLoader = config.resourceLoader;
    this._modelRegistry = config.modelRegistry;

    // 订阅 agent 事件 -- 自动处理持久化、扩展通知、自动压缩
    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
    this._installAgentToolHooks();

    // 构建运行时：工具注册 + 扩展加载 + 系统提示词
    this._buildRuntime({
      activeToolNames: this._initialActiveToolNames,
      includeAllExtensionTools: true,
    });
  }
}
```

### 事件处理管线

AgentSession 内部的事件处理是一条串行队列：

```
Agent 核心发出事件
  |
  v
_handleAgentEvent(event)           -- 同步入队
  |
  v
_processAgentEvent(event)          -- 异步执行
  |
  +-- 从 steering/followUp 队列中移除已送达消息
  +-- _emitExtensionEvent(event)   -- 通知扩展系统
  +-- _emit(event)                 -- 通知所有外部监听者
  +-- 持久化到 SessionManager       -- message_end 时追加到 JSONL
  +-- 检查自动重试                   -- agent_end 时检查是否需要重试
  +-- 检查自动压缩                   -- agent_end 时检查上下文大小
```

### 工具注册

AgentSession 维护两层工具注册：

1. **定义注册 (`_toolDefinitions`)** -- 记录工具的 schema、description、promptSnippet
2. **实例注册 (`_toolRegistry`)** -- 包装后的 AgentTool 实例，带有扩展钩子

```ts
private _refreshToolRegistry(): void {
  // 1. 收集内置工具 (read, bash, edit, write, grep, find, ls)
  // 2. 收集扩展工具 (extensionRunner.getAllRegisteredTools())
  // 3. 收集 SDK 自定义工具
  // 4. 用 wrapRegisteredTools 包装 -- 注入 beforeToolCall/afterToolCall 钩子
  // 5. 合并到 _toolRegistry Map
  // 6. 根据 allowedToolNames 过滤
  // 7. 重建系统提示词（包含活跃工具的 snippet）
}
```

### 系统提示词构建

每次工具集变化时，系统提示词都会重建：

```ts
private _rebuildSystemPrompt(toolNames: string[]): string {
  // 收集活跃工具的 promptSnippet 和 promptGuidelines
  // 加载自定义系统提示词（来自 --system-prompt 或配置）
  // 加载 Skills、AGENTS.md 上下文文件
  // 调用 buildSystemPrompt() 组装最终提示词
  return buildSystemPrompt(options);
}
```

---

## 7. 完整伪代码

### cli.ts

```
设置 shebang (#!/usr/bin/env node)
导入 undici, config, main

process.title = APP_NAME
process.env.PI_CODING_AGENT = "true"
process.emitWarning = noop

设置全局 HTTP 代理（禁用超时）

main(process.argv.slice(2))
```

### args.ts

```
function parseArgs(args: string[]): Args
  result = { messages: [], fileArgs: [], unknownFlags: Map, diagnostics: [] }

  for i = 0 to args.length:
    arg = args[i]
    match arg:
      "--help", "-h"       -> result.help = true
      "--version", "-v"    -> result.version = true
      "--provider" + next  -> result.provider = next; i++
      "--model" + next     -> result.model = next; i++
      "--api-key" + next   -> result.apiKey = next; i++
      "--system-prompt"    -> result.systemPrompt = next; i++
      "--print", "-p"      -> result.print = true; 可选吞一个参数
      "--mode" + next      -> result.mode = next (text|json|rpc); i++
      "--tools" + next     -> result.tools = next.split(","); i++
      "--no-tools"         -> result.noTools = true
      "--thinking" + next  -> 验证后 result.thinking = next; i++
      "@xxx"               -> result.fileArgs.push(xxx)
      "--unknown"          -> result.unknownFlags.set(name, value)
      else                 -> result.messages.push(arg)

  return result
```

### main.ts

```
async function main(argv):
  parsed = parseArgs(argv)
  appMode = resolveAppMode(parsed, stdin.isTTY)

  if parsed.version: print VERSION; exit
  if parsed.help: printHelp(); exit
  if parsed.export: exportFromFile(); exit

  sessionManager = await createSessionManager(parsed, cwd, sessionDir)

  createRuntime = async (context) =>
    services = await createAgentSessionServices(context)
    options = buildSessionOptions(parsed, scopedModels, ...)
    session = await createAgentSessionFromServices(services, options)
    return { session, services, diagnostics }

  runtime = await createAgentSessionRuntime(createRuntime, context)

  stdinContent = await readPipedStdin()  // 跳过 RPC 模式
  initialMessage = await prepareInitialMessage(parsed, stdinContent)

  switch appMode:
    "rpc":
      await runRpcMode(runtime)

    "interactive":
      mode = new InteractiveMode(runtime, { initialMessage, ... })
      await mode.run()

    "print" | "json":
      exitCode = await runPrintMode(runtime, {
        mode: appMode == "json" ? "json" : "text",
        initialMessage,
        messages: parsed.messages,
      })
      if exitCode != 0: process.exitCode = exitCode
```

### agent-session.ts（核心方法）

```
class AgentSession:
  constructor(config):
    this.agent = config.agent
    this.sessionManager = config.sessionManager
    this._modelRegistry = config.modelRegistry
    this._resourceLoader = config.resourceLoader

    agent.subscribe(this._handleAgentEvent)
    this._installAgentToolHooks()
    this._buildRuntime({ activeToolNames, includeAllExtensionTools: true })

  async prompt(text, options):
    // 1. 尝试执行扩展命令 (/command)
    // 2. 触发 input 扩展事件（允许拦截/转换）
    // 3. 展开 skill 命令和 prompt 模板
    // 4. 如果正在流式输出 -> 排队为 steer 或 followUp
    // 5. 验证 model 和 API key
    // 6. 检查是否需要预压缩
    // 7. 构建消息数组 + 扩展注入
    // 8. agent.prompt(messages)
    // 9. await waitForRetry()

  async setModel(model):
    验证 auth -> agent.state.model = model -> 持久化 -> 通知扩展

  setThinkingLevel(level):
    clamp 到模型能力 -> agent.state.thinkingLevel = level -> 持久化 -> emit 事件

  setActiveToolsByName(names):
    过滤有效工具 -> agent.state.tools = tools -> 重建系统提示词

  async compact(customInstructions):
    断开 agent 事件 -> abort 当前操作 -> 生成压缩摘要 -> 更新 session -> 重连

  _handleAgentEvent(event):
    同步: 创建 retry promise（如果是可重试错误）
    入队: _agentEventQueue.then(() => _processAgentEvent(event))

  _processAgentEvent(event):
    更新队列状态 -> 通知扩展 -> 通知监听者 -> 持久化 -> 检查重试 -> 检查压缩

  dispose():
    取消订阅 -> 清理资源 -> 使扩展 runner 失效
```

### print-mode.ts

```
async function runPrintMode(runtime, options):
  session = runtime.session
  mode = options.mode  // "text" | "json"

  // JSON 模式：输出 session header
  if mode == "json":
    writeRawStdout(JSON.stringify(session.sessionManager.getHeader()))

  // 绑定扩展
  await session.bindExtensions({ commandContextActions, onError })

  // 订阅事件
  session.subscribe((event) =>
    if mode == "json": writeRawStdout(JSON.stringify(event) + "\n")
  )

  // 发送 prompt
  if initialMessage:
    await session.prompt(initialMessage)
  for msg in messages:
    await session.prompt(msg)

  // text 模式：提取最后一条 assistant 消息
  if mode == "text":
    last = session.state.messages.at(-1)
    if last.role == "assistant" and not error:
      for content in last.content:
        if content.type == "text":
          writeRawStdout(content.text + "\n")

  // 清理并返回退出码
  await runtime.dispose()
  return exitCode
```

---

## 动手练习

1. **以 print 模式运行**

   ```bash
   npx tsx src/cli.ts -p "list all TypeScript files in the src directory"
   ```

   验证：程序执行完毕后自动退出（无交互界面），stdout 输出 agent 的最终文本回复。尝试用管道模式：

   ```bash
   echo "what is 2+2?" | npx tsx src/cli.ts
   ```

   确认 stdin 非 TTY 时自动切换到 print 模式。

2. **以 interactive 模式运行**

   ```bash
   npx tsx src/cli.ts
   ```

   确认出现 TUI 界面（StatusBar + ChatHistory + InputEditor）。输入一条消息并按 Enter，验证 agent 响应后可以继续输入。按 Ctrl+C 退出。

3. **测试 --model 参数**

   ```bash
   npx tsx src/cli.ts --model sonnet -p "hello"
   ```

   验证 `parseArgs()` 正确解析 `--model sonnet`，agent 使用指定的模型。尝试传入无效模型名：

   ```bash
   npx tsx src/cli.ts --model nonexistent-model -p "hello"
   ```

   确认程序输出错误信息而非崩溃。

4. **测试 API Key 解析链**
   按以下顺序验证优先级：
   - 移除所有环境变量中的 API key，运行程序，确认报错 "No API key found"
   - 设置环境变量 `ANTHROPIC_API_KEY=test-key`，运行程序，确认使用环境变量中的 key
   - 同时传入 `--api-key cli-key`，确认 CLI 参数优先于环境变量
   ```bash
   ANTHROPIC_API_KEY=env-key npx tsx src/cli.ts --api-key cli-key -p "hello"
   ```

---

## 8. 总结

| 组件               | 职责                | 行数  |
| ------------------ | ------------------- | ----- |
| `cli.ts`           | 进程环境设置        | ~22   |
| `args.ts`          | 参数解析 + 帮助文本 | ~354  |
| `main.ts`          | 启动管线编排        | ~727  |
| `agent-session.ts` | Agent 生命周期门面  | ~3100 |
| `print-mode.ts`    | 单次执行模式        | ~158  |
| `rpc-mode.ts`      | JSON-RPC 嵌入模式   | ~754  |

核心设计原则：

1. **入口极简** -- `cli.ts` 只做环境设置，一切逻辑在 `main.ts`
2. **工厂模式** -- 运行时可重建，支持会话切换
3. **门面模式** -- `AgentSession` 统一所有模式的共享状态
4. **模式即策略** -- 三种模式是同一运行时的不同 I/O 策略
5. **解析链** -- API key 从多个来源按优先级解析

下一课我们将深入 Interactive 模式的 TUI 实现。
