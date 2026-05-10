# 第十五课：Extension API 设计

Agent 除了内置的工具和行为，还需要一套 **扩展机制** 让外部代码挂入核心生命周期。本课以 pi 的 Extension 系统为蓝本，讲解如何设计一个完整的 Extension API -- 从类型定义、发现加载、运行时管理到关键拦截点。

---

## 1. Extension 的本质

一个 Extension 就是一个 **工厂函数**：

```ts
type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
```

宿主加载扩展文件后调用这个工厂函数，传入 `ExtensionAPI` 对象。扩展在工厂函数内注册事件处理器、工具、命令、快捷键等。工厂函数返回后，扩展就"安装"完成了。

不使用 class、不使用 manifest JSON，纯函数式注册。这使得扩展文件极其简洁：

```ts
// .agent/extensions/my-ext.ts
import type { ExtensionFactory } from "@my-agent/core";

const extension: ExtensionFactory = (api) => {
  api.on("before_agent_start", (event) => {
    return { systemPrompt: event.systemPrompt + "\nExtra instructions." };
  });

  api.registerTool({ name: "hello" /* ... */ });
};

export default extension;
```

### 为什么用工厂函数

| 方案          | 优势                            | 劣势                   |
| ------------- | ------------------------------- | ---------------------- |
| 工厂函数      | 简单、无状态、支持 async 初始化 | --                     |
| Class         | 可以有实例状态                  | 需要 new、生命周期复杂 |
| Manifest JSON | 声明式                          | 表达力弱、无法动态注册 |

pi 选择工厂函数是因为扩展的"状态"全部通过闭包持有，不需要额外的实例管理。

---

## 2. ExtensionAPI 能力

`ExtensionAPI` 是传给工厂函数的唯一参数，暴露三类能力：

### 2.1 事件订阅: `on()`

```ts
interface ExtensionAPI {
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
  on(
    event: "before_agent_start",
    handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>,
  ): void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
  on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
  on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
  on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
  on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
  // ... 25+ events in pi
}
```

每个事件都有 **独立的类型签名**，handler 的参数和返回值完全类型安全。pi 通过 TypeScript 函数重载实现这一点：每个 `on()` 重载绑定特定的 event 名到特定的 Event/Result 类型对。

Handler 签名：

```ts
type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;
```

- 同步或异步均可
- 返回 void 表示不修改
- 返回 R 表示有结果（如修改 system prompt、阻止 tool call）

### 2.2 注册: `registerTool`, `registerCommand`, `registerShortcut`

```ts
// 注册一个 LLM 可调用的工具
api.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Does something useful",
  parameters: Type.Object({ input: Type.String() }), // TypeBox schema
  async execute(toolCallId, params, signal, ctx) {
    return { content: "result", isError: false };
  },
});

// 注册一个斜杠命令 (/mytool)
api.registerCommand("mytool", {
  description: "Run my tool manually",
  handler: async (args, ctx) => {
    /* ... */
  },
});

// 注册一个快捷键
api.registerShortcut("ctrl+shift+t", {
  description: "Quick action",
  handler: async (ctx) => {
    /* ... */
  },
});
```

注册方法只在工厂函数执行期间和运行时回调中调用。它们写入 Extension 对象的内部 Map。

### 2.3 动作: `sendMessage`, `setModel`, `setActiveTools`

```ts
api.sendMessage(content); // 发送消息到会话
api.setModel(model); // 切换模型
api.getActiveTools(); // 获取当前激活的工具列表
api.setActiveTools(["bash", "read"]); // 设置激活的工具
```

这些是**命令式动作**，直接操作宿主状态。它们不在工厂函数加载期间可用 -- 调用会抛出 "not initialized" 错误。只有在 runner.bindCore() 后才能使用。

---

## 3. ExtensionRunner: 生命周期管理

Runner 是扩展系统的核心调度器。它持有所有已加载的 Extension 对象和共享的 ExtensionRuntime。

### 3.1 架构概览

```
┌─────────────────────────────────────────────┐
│                Host (Agent Core)            │
│                                             │
│  ┌─────────┐    bindCore()     ┌─────────┐  │
│  │ Actions  │ ───────────────> │ Runner  │  │
│  └─────────┘                   │         │  │
│                                │ ext[0]  │  │
│  emit(event) ─────────────────>│ ext[1]  │  │
│                                │ ext[2]  │  │
│                                └─────────┘  │
└─────────────────────────────────────────────┘
```

### 3.2 生命周期

```
 discoverAndLoadExtensions()
          │
          ▼
  ┌─ loadExtensions() ─────────────────┐
  │  for each path:                     │
  │    1. createExtensionRuntime()      │  <-- throwing stubs
  │    2. jiti.import(path)             │  <-- load .ts at runtime
  │    3. factory(api)                  │  <-- extension registers handlers
  │  return { extensions, runtime }     │
  └─────────────────────────────────────┘
          │
          ▼
  new ExtensionRunner(extensions, runtime, cwd)
          │
          ▼
  runner.bindCore(actions, contextActions)
          │   ├─ Copy real action implementations into runtime
          │   ├─ Flush queued provider registrations
          │   └─ Wire up context getters (isIdle, abort, etc.)
          │
          ▼
    Runner is now live. Events can be emitted.
          │
          ▼
    ... agent runs, events flow ...
          │
          ▼
  runner.invalidate()
          │   └─ All captured API references now throw on use
          │
          ▼
    New runner created (on reload / session switch)
```

### 3.3 Runtime: 共享可变状态

Runtime 对象在 loader 和 runner 之间共享。它充当中间层：

```ts
interface ExtensionRuntime {
  // Action methods -- stubs initially, replaced by bindCore()
  sendMessage: (content: string) => void;
  setModel: (modelId: string) => void;
  getActiveTools: () => string[];
  setActiveTools: (toolNames: string[]) => void;

  // Lifecycle guards
  assertActive: () => void; // throws if stale
  invalidate: (msg?: string) => void;

  // Queued registrations (flushed on bindCore)
  pendingRegistrations: Array<{ name: string; config: unknown }>;
}
```

为什么要这层间接：

1. **加载期安全**: 工厂函数执行时 runtime 还没绑定，调用 action 会抛错，而不是静默失败
2. **热替换**: invalidate() 后所有通过闭包持有的旧 API 引用都会抛错
3. **队列**: 某些注册（如 provider）在加载期排队，bindCore 时批量执行

### 3.4 Invalidation

当用户执行 `/reload` 或切换 session 时，旧的 runner 被 invalidate：

```ts
runner.invalidate("Stale after /reload");
```

之后，任何通过旧 API 引用的操作都会抛出错误。这防止扩展在回调中持有旧引用造成竞态条件。pi 的实际错误信息非常详细，指导开发者如何正确处理 session 替换。

---

## 4. 事件派发: 通用与专用

### 4.1 通用 `emit(event)`

大部分事件走通用路径：遍历所有 extension 的 handler，依次调用：

```ts
async emit(event: ExtensionEvent): Promise<void> {
  const ctx = this.createContext();
  for (const ext of this.extensions) {
    const handlers = ext.handlers.get(event.type);
    if (!handlers) continue;
    for (const handler of handlers) {
      try {
        await handler(event, ctx);
      } catch (err) {
        this.emitError({ extensionPath: ext.path, event: event.type, error: err });
      }
    }
  }
}
```

特点：

- 按扩展加载顺序执行
- 单个 handler 异常不影响其他 handler
- 错误通过 `emitError` 通知宿主（而非抛出）

### 4.2 专用 emitters

某些事件需要 **结果链式合并**，必须有专门的 emit 方法：

| 方法                                         | 行为                                                           |
| -------------------------------------------- | -------------------------------------------------------------- |
| `emitContext(messages)`                      | handler 返回修改后的 messages，下一个 handler 看到前一个的输出 |
| `emitToolCall(event)`                        | handler 返回 `{ block: true }` 可以立即短路，阻止工具执行      |
| `emitToolResult(event)`                      | handler 可修改 content/isError，修改链式传递                   |
| `emitBeforeAgentStart(prompt, systemPrompt)` | handler 可修改 systemPrompt，多个 handler 的修改链式叠加       |
| `emitBeforeProviderRequest(payload)`         | handler 可替换发送给 LLM provider 的原始请求体                 |
| `emitInput(text, images, source)`            | handler 可 transform 输入或标记为 "handled" 短路               |
| `emitMessageEnd(event)`                      | handler 可替换最终消息（必须保持相同 role）                    |

以 `emitContext` 为例：

```ts
async emitContext(messages: Message[]): Promise<Message[]> {
  const ctx = this.createContext();
  let current = structuredClone(messages);  // 深拷贝，防止 handler 间污染

  for (const ext of this.extensions) {
    for (const handler of ext.handlers.get("context") ?? []) {
      try {
        const event = { type: "context", messages: current };
        const result = await handler(event, ctx);
        if (result?.messages) current = result.messages;
      } catch (err) { /* log */ }
    }
  }
  return current;
}
```

注意 `structuredClone` -- 初始深拷贝确保 handler 的修改不会意外影响调用方的原始数据。

---

## 5. 关键拦截点

这是 Extension 系统最强大的部分。通过在 agent 流水线的关键位置插入事件，扩展可以深度定制 agent 行为。

### 5.1 `before_agent_start` -- 修改 System Prompt

```ts
api.on("before_agent_start", (event) => {
  // event.prompt: 用户输入
  // event.systemPrompt: 完整的 system prompt
  // event.systemPromptOptions: 构建 system prompt 的结构化选项

  const extra = "\n\nAlways respond in JSON format.";
  return { systemPrompt: event.systemPrompt + extra };
});
```

用例：注入额外的 system prompt 指令、基于项目类型动态调整行为。

### 5.2 `context` -- 修改发给 LLM 的消息

```ts
api.on("context", (event) => {
  // event.messages: 即将发给 LLM 的完整消息列表

  // 过滤掉超过 N 轮的旧消息
  const recent = event.messages.slice(-10);
  return { messages: recent };
});
```

用例：自定义上下文窗口管理、注入 RAG 结果、添加记忆摘要。

### 5.3 `tool_call` -- 阻止或修改工具调用

```ts
api.on("tool_call", (event) => {
  // event.toolName: 工具名
  // event.input: 工具参数 (mutable -- 直接修改即可)

  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    return { block: true, reason: "Dangerous command blocked" };
  }

  // 修改参数（直接 mutate event.input）
  if (event.toolName === "bash") {
    event.input.timeout = 30000;
  }
});
```

用例：安全策略、参数注入、审计日志。

重要细节：`event.input` 是 **可变的**。扩展直接修改它即可 patch 工具参数，后续 handler 能看到之前 handler 的修改。返回 `{ block: true }` 则立即短路，工具不执行。

### 5.4 `tool_result` -- 修改工具执行结果

```ts
api.on("tool_result", (event) => {
  if (event.toolName === "read") {
    // 给 read 结果附加行号统计
    const lineCount = event.content
      .filter((c) => c.type === "text")
      .reduce((n, c) => n + c.text.split("\n").length, 0);
    return { content: [...event.content, { type: "text", text: `\n(${lineCount} lines)` }] };
  }
});
```

用例：结果后处理、数据脱敏、添加元数据。

### 5.5 `input` -- 拦截用户输入

```ts
api.on("input", (event) => {
  // 快捷宏
  if (event.text === "!!fix") {
    return { action: "transform", text: "Fix all type errors in the current file" };
  }

  // 完全接管输入处理
  if (event.text.startsWith("/custom")) {
    handleCustomCommand(event.text);
    return { action: "handled" };
  }

  return { action: "continue" };
});
```

---

## 6. Extension 发现与加载

### 6.1 发现路径

```
搜索顺序（先找到的优先）:

1. 项目本地:  cwd/.agent/extensions/
2. 全局:      ~/.agent/extensions/
3. 显式配置:  配置文件中指定的路径
```

每个目录的发现规则：

```
extensions/
├── my-tool.ts              → 直接加载
├── my-plugin/
│   ├── package.json        → 读取 pi.extensions 字段
│   └── src/
│       └── index.ts        → 由 package.json 声明
├── simple-ext/
│   └── index.ts            → 按约定加载 index
└── utils.js                → 直接加载
```

```ts
function discoverExtensionsInDir(dir: string): string[] {
  const discovered: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && isExtensionFile(entry.name)) {
      // 1. Direct .ts/.js files
      discovered.push(path.join(dir, entry.name));
    } else if (entry.isDirectory()) {
      // 2. Check package.json for pi.extensions
      // 3. Fall back to index.ts / index.js
      const entries = resolveExtensionEntries(entryPath);
      if (entries) discovered.push(...entries);
    }
  }
  return discovered;
}
```

去重通过 `Set<resolvedPath>` 实现，同一个文件不会被加载两次。

### 6.2 jiti: 运行时 TypeScript 加载

扩展是 `.ts` 文件，但 agent 运行时是编译后的 JS。需要一种方式在运行时加载并转译 TypeScript。

[jiti](https://github.com/unjs/jiti) 就是为此而生的：

```ts
import { createJiti } from "jiti";

async function loadExtensionModule(extensionPath: string) {
  const jiti = createJiti(import.meta.url, {
    moduleCache: false, // 允许 /reload 时重新加载
    // Node.js 开发模式:
    alias: {
      "@my-agent/core": "/path/to/core/index.js",
    },
    // 或编译后的二进制模式:
    // virtualModules: { "@my-agent/core": bundledCoreModule },
    // tryNative: false,
  });

  const module = await jiti.import(extensionPath, { default: true });
  return typeof module === "function" ? module : undefined;
}
```

关键选项：

| 选项                 | 用途                                                |
| -------------------- | --------------------------------------------------- |
| `moduleCache: false` | 禁用缓存，支持 `/reload` 重新加载扩展               |
| `alias`              | Node.js 模式下将扩展的 import 重定向到宿主包        |
| `virtualModules`     | 编译二进制模式下注入预打包的模块                    |
| `tryNative: false`   | 配合 virtualModules 使用，强制 jiti 处理所有 import |

为什么需要 alias/virtualModules：扩展 `import { Type } from "typebox"` 必须解析到 **宿主打包的** typebox，而不是扩展自己的 node_modules（可能版本不同）。这确保类型兼容性。

### 6.3 加载流程

```ts
async function loadExtension(extensionPath, runtime) {
  // 1. 用 jiti 加载模块
  const factory = await loadExtensionModule(extensionPath);
  if (typeof factory !== "function") return { error: "No factory function" };

  // 2. 创建 Extension 对象（空的 handler/tool/command Map）
  const extension = createExtension(extensionPath);

  // 3. 创建 ExtensionAPI（注册方法写入 extension，action 方法代理到 runtime）
  const api = createExtensionAPI(extension, runtime);

  // 4. 调用工厂函数
  await factory(api);

  // 5. 扩展现在"安装"完成 -- handlers, tools, commands 都填好了
  return { extension };
}
```

---

## 7. 完整伪代码

### 7.1 ExtensionAPI 创建

```ts
function createExtensionAPI(extension: Extension, runtime: ExtensionRuntime): ExtensionAPI {
  return {
    // 写入 Extension 对象
    on(event: string, handler: HandlerFn): void {
      runtime.assertActive();
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },

    registerTool(tool: ToolDefinition): void {
      runtime.assertActive();
      extension.tools.set(tool.name, tool);
      runtime.refreshTools(); // 通知宿主工具列表变更
    },

    registerCommand(name, options): void {
      runtime.assertActive();
      extension.commands.set(name, { name, ...options });
    },

    registerShortcut(key, options): void {
      runtime.assertActive();
      extension.shortcuts.set(key, { key, ...options });
    },

    // 代理到 runtime
    sendMessage(content): void {
      runtime.assertActive();
      runtime.sendMessage(content);
    },

    setModel(model): void {
      runtime.assertActive();
      runtime.setModel(model);
    },

    getActiveTools(): string[] {
      runtime.assertActive();
      return runtime.getActiveTools();
    },

    setActiveTools(names): void {
      runtime.assertActive();
      runtime.setActiveTools(names);
    },
  };
}
```

### 7.2 ExtensionRunner

```ts
class ExtensionRunner {
  private extensions: Extension[];
  private runtime: ExtensionRuntime;
  private staleMessage?: string;

  constructor(extensions, runtime, cwd) { /* ... */ }

  // -- 生命周期 --

  bindCore(actions, contextActions): void {
    // 将真正的实现复制到 runtime
    this.runtime.sendMessage = actions.sendMessage;
    this.runtime.setModel = actions.setModel;
    // ... 其他 action

    // 刷新加载期间排队的注册
    for (const reg of this.runtime.pendingRegistrations) {
      this.applyRegistration(reg);
    }
    this.runtime.pendingRegistrations = [];
  }

  invalidate(message?: string): void {
    this.staleMessage ??= message;
    this.runtime.invalidate(this.staleMessage);
  }

  // -- 通用派发 --

  async emit(event: ExtensionEvent): Promise<void> {
    const ctx = this.createContext();
    for (const ext of this.extensions) {
      for (const handler of ext.handlers.get(event.type) ?? []) {
        try { await handler(event, ctx); }
        catch (err) { this.emitError(ext.path, event.type, err); }
      }
    }
  }

  // -- 专用派发 --

  async emitContext(messages): Promise<Message[]> {
    let current = structuredClone(messages);
    for (const ext of this.extensions) {
      for (const handler of ext.handlers.get("context") ?? []) {
        const result = await handler({ type: "context", messages: current }, ctx);
        if (result?.messages) current = result.messages;
      }
    }
    return current;
  }

  async emitToolCall(event): Promise<ToolCallEventResult | undefined> {
    for (const ext of this.extensions) {
      for (const handler of ext.handlers.get("tool_call") ?? []) {
        const result = await handler(event, ctx);
        if (result?.block) return result;  // 短路
      }
    }
  }

  async emitBeforeAgentStart(prompt, systemPrompt): Promise<...> {
    let current = systemPrompt;
    for (...) {
      const result = await handler({ ..., systemPrompt: current }, ctx);
      if (result?.systemPrompt) current = result.systemPrompt;  // 链式修改
    }
    return modified ? { systemPrompt: current } : undefined;
  }

  // -- Context 工厂 --

  createContext(): ExtensionContext {
    const runner = this;
    return {
      get cwd() { runner.assertActive(); return runner._cwd; },
      isIdle: () => { runner.assertActive(); return runner.isIdleFn(); },
      abort: () => { runner.assertActive(); runner.abortFn(); },
    };
  }
}
```

### 7.3 Discovery + Loading

```ts
async function discoverAndLoadExtensions(configuredPaths, cwd): Promise<LoadResult> {
  const allPaths: string[] = [];
  const seen = new Set<string>();

  // 1. 项目本地
  addPaths(discoverExtensionsInDir(path.join(cwd, ".agent", "extensions")));

  // 2. 全局
  addPaths(discoverExtensionsInDir(path.join(os.homedir(), ".agent", "extensions")));

  // 3. 显式配置
  for (const p of configuredPaths) {
    addPaths([resolve(p)]);
  }

  // 加载
  const runtime = createExtensionRuntime(); // throwing stubs
  const extensions = [];
  for (const p of allPaths) {
    const factory = await jitiImport(p);
    const ext = createExtension(p);
    const api = createExtensionAPI(ext, runtime);
    await factory(api);
    extensions.push(ext);
  }

  return { extensions, runtime };
}
```

---

## 8. 设计要点总结

### 8.1 两阶段初始化

扩展加载分两阶段：

1. **注册阶段**（工厂函数执行）: 只能 `on()`、`registerTool()` 等注册操作，action 方法抛错
2. **运行阶段**（bindCore 之后）: 所有方法可用

这消除了加载顺序依赖 -- 扩展 A 不可能在加载阶段就调用 `sendMessage`，因为此时扩展 B 可能还没加载。

### 8.2 Stale Instance 防护

session 切换或 reload 后旧的 API 引用必须失效。如果扩展在回调中捕获了 `api` 引用：

```ts
const extension: ExtensionFactory = (api) => {
  // BAD: 闭包持有 api 引用
  setTimeout(() => {
    api.sendMessage("delayed"); // 如果已经 reload，这里会抛错
  }, 60000);
};
```

`assertActive()` 检查确保这类误用会给出清晰的错误信息，而不是静默操作在已废弃的 session 上。

### 8.3 Error Isolation

单个扩展的 handler 异常不会影响其他扩展：

```ts
for (const handler of handlers) {
  try {
    await handler(event, ctx);
  } catch (err) {
    this.emitError(ext.path, event.type, err);
    // 继续执行下一个 handler
  }
}
```

错误通过 `emitError` 回报给宿主，宿主决定如何展示（通知栏、日志等）。

### 8.4 一致的类型安全

- 事件通过函数重载确保类型安全
- 工具参数通过 TypeBox schema 定义，execute 方法接收类型化的参数
- Handler 返回值通过泛型参数 R 约束

### 8.5 jiti 的角色

jiti 解决了一个核心矛盾：扩展开发者想用 TypeScript 写扩展，但 agent 运行时是编译后的 JavaScript。jiti 在运行时透明地转译 TypeScript，扩展不需要构建步骤，不需要 tsconfig，直接写 `.ts` 就能用。

---

## 9. 代码文件说明

`code/` 目录包含本课的可运行示例：

| 文件            | 内容                                                      |
| --------------- | --------------------------------------------------------- |
| `src/types.ts`  | ExtensionAPI、ExtensionFactory、ExtensionEvent 等类型定义 |
| `src/runner.ts` | ExtensionRunner: 生命周期管理、事件派发、context 创建     |
| `src/loader.ts` | Extension 发现（文件系统扫描）和加载（jiti）              |
| `src/demo.ts`   | 完整演示: 加载扩展、注册工具、发射事件、执行工具          |

运行：

```bash
cd code
npm install
npm run demo
```

---

## 10. 练习

1. **添加事件**: 在 types.ts 中添加 `message_start` 和 `message_end` 事件。在 runner.ts 中为 `message_end` 实现专用 emitter，支持 handler 返回修改后的消息。

2. **实现 registerFlag**: 扩展可以注册 CLI flag (`api.registerFlag("verbose", { type: "boolean", default: false })`)，然后通过 `api.getFlag("verbose")` 读取。flag 值存储在 runtime.flagValues 中。

3. **provider 注册队列**: 实现 `api.registerProvider(name, config)` -- 在 bindCore 之前调用时排队，之后直接生效。思考：为什么不能在加载期间立即生效？

4. **链式 emitInput**: 实现 `emitInput(text, source)` 方法。handler 可以返回三种结果：`continue`（不修改）、`transform`（替换文本）、`handled`（完全接管，短路）。多个 handler 的 transform 链式叠加。
