# 第19课：生产环境加固

> 一个 Agent 的核心循环跑通了、工具能调用了、上下文能管理了——但这还远远不够。投入生产环境后，你会面对网络抖动、恶意输入、token 爆炸、配置混乱等一系列真实问题。本课的目标是让你的 Agent 具备在真实环境中长期稳定运行的能力。

---

## 1. 错误恢复

### 1.1 网络重试与指数退避

LLM API 调用会遇到各种瞬态错误：速率限制 (429)、服务器过载 (503)、网络中断等。简单的立即重试会造成"惊群效应"——所有客户端同时重试，加剧服务器压力。

**指数退避 (Exponential Backoff)** 是标准解决方案：

```
延迟 = baseDelay * 2^(attempt - 1)

attempt 1: 2000ms (2秒)
attempt 2: 4000ms (4秒)
attempt 3: 8000ms (8秒)
```

#### 关键设计决策

**哪些错误该重试？** 不是所有错误都适合重试：

| 错误类型          | 重试？ | 原因                   |
| ----------------- | ------ | ---------------------- |
| 429 速率限制      | 是     | 等一下就好了           |
| 500/502/503/504   | 是     | 瞬态服务器问题         |
| 网络超时/连接断开 | 是     | 网络抖动               |
| 400 请求无效      | 否     | 客户端错误，重试无意义 |
| 401/403 认证失败  | 否     | 需要修复凭证           |
| 上下文溢出        | 否     | 需要压缩，不是重试     |

**取消支持**：重试等待期间用户必须能够取消。Pi 的实现使用 `AbortController`，用户按 Escape 即可中断等待。

**状态清理**：重试前必须清除失败状态。Pi 在重试前将错误消息从 agent state 中移除，避免 LLM 看到之前的错误消息。

#### 伪代码

```typescript
interface RetryConfig {
  maxRetries: number; // 最大重试次数，默认 3
  baseDelayMs: number; // 基础延迟，默认 2000ms
  maxDelayMs: number; // 最大延迟上限，默认 60000ms
}

async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  isRetryable: (error: Error) => boolean,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // 不可重试的错误直接抛出
      if (!isRetryable(error)) throw error;

      // 已达最大重试次数
      if (attempt >= config.maxRetries) break;

      // 计算延迟：指数退避 + 上限
      const delay = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);

      // 可取消的等待
      await sleep(delay, signal);
    }
  }

  throw lastError;
}
```

### 1.2 上下文溢出自动压缩 + 重试

当 LLM 返回上下文溢出错误时，重试是没用的——需要先压缩上下文，然后再重试。

Pi 的处理流程：

```
LLM 返回错误
  -> 是上下文溢出？
    -> 之前尝试过恢复？
      -> 是：报告失败（"已尝试过一次压缩-重试，仍然失败"）
      -> 否：标记 overflowRecoveryAttempted = true
             -> 运行自动压缩（保留最近消息的摘要）
             -> 压缩成功？
               -> 是：自动重试原请求
               -> 否：报告压缩失败
```

关键点：

- 溢出恢复最多尝试一次（避免无限循环）
- 压缩和重试是独立于普通错误重试的路径
- 压缩保留最近对话的摘要，确保上下文连贯性

#### 伪代码

```typescript
async function handleContextOverflow(agent: Agent, message: AssistantMessage): Promise<void> {
  if (overflowRecoveryAttempted) {
    throw new Error("上下文溢出恢复失败，请减少上下文或切换更大窗口的模型");
  }

  overflowRecoveryAttempted = true;

  // 从 agent state 移除错误消息
  removeLastAssistantMessage(agent);

  // 运行压缩：生成摘要，截断历史
  const result = await compact(agent, {
    reason: "overflow",
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  });

  if (!result.success) {
    throw new Error("上下文压缩失败: " + result.error);
  }

  // 压缩成功，自动重试
  await agent.continue();
}
```

### 1.3 工具失败的优雅降级

工具执行可能失败（文件不存在、命令超时、权限不足）。Agent 不应因为单个工具失败就崩溃。

**策略**：

1. **捕获并报告**：工具失败返回结构化错误信息，而非抛异常
2. **超时保护**：每个工具调用设置超时，超时后杀死进程树
3. **输出截断**：大输出截断并保存完整版到临时文件
4. **回退方案**：如果首选工具不可用，尝试替代方案

```typescript
// 工具执行包装器
async function executeToolSafely(
  tool: Tool,
  input: unknown,
  timeoutMs: number,
): Promise<ToolResult> {
  try {
    const result = await withTimeout(tool.execute(input), timeoutMs);
    return { success: true, content: result };
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        success: false,
        content: `工具 ${tool.name} 执行超时 (${timeoutMs}ms)`,
        isRetryable: true,
      };
    }
    return {
      success: false,
      content: `工具 ${tool.name} 执行失败: ${error.message}`,
      isRetryable: false,
    };
  }
}
```

---

## 2. 安全

### 2.1 路径穿越防护

路径穿越是 Agent 面临的最严重安全威胁之一。LLM 生成的路径可能包含 `../` 序列，突破沙箱边界访问敏感文件。

**OWASP 推荐的防护流程**：

```
用户输入 -> 解析为绝对路径 -> realpath 解析符号链接 -> 验证前缀 -> 执行操作
```

#### 攻击向量

```
直接穿越:      ../../../etc/passwd
URL编码:       ..%2F..%2F..%2Fetc%2Fpasswd
双重编码:      ..%252F..%252Fetc%252Fpasswd
空字节注入:    ../../../etc/passwd%00.png
Windows特殊:   ..\..\..\windows\system32\config\sam
```

#### 伪代码

```typescript
function isPathSafe(userPath: string, allowedBase: string): boolean {
  // 1. 规范化路径（解析 .., ., 分隔符）
  const resolved = path.resolve(allowedBase, userPath);

  // 2. 解析符号链接（防止符号链接指向外部）
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // 文件不存在时，检查父目录
    const parent = path.dirname(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      realPath = path.join(realParent, path.basename(resolved));
    } catch {
      return false; // 父目录也不存在
    }
  }

  // 3. 确保路径在允许的基目录下
  const normalizedBase = fs.realpathSync(allowedBase);
  return realPath === normalizedBase || realPath.startsWith(normalizedBase + path.sep);
}
```

### 2.2 环境变量泄露防护

Agent 的工具可能意外泄露环境变量中的 API Key、密码等敏感信息。

**防护措施**：

1. **过滤敏感环境变量**：传递给子进程的 env 不包含敏感 key
2. **输出扫描**：检查工具输出是否包含已知的敏感值
3. **日志脱敏**：记录日志时替换敏感值

```typescript
const SENSITIVE_ENV_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /private[_-]?key/i,
  /auth/i,
];

function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const isSensitive = SENSITIVE_ENV_PATTERNS.some((p) => p.test(key));
    sanitized[key] = isSensitive ? "***REDACTED***" : value;
  }
  return sanitized;
}
```

### 2.3 敏感文件检测

Agent 不应读取或操作已知的敏感文件。在执行文件操作前，检查目标文件是否为敏感文件。

```typescript
const SENSITIVE_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "service-account.json",
  ".npmrc", // 可能含 npm token
  ".pypirc", // 可能含 PyPI token
  "id_rsa",
  "id_ed25519",
  ".ssh/config",
  ".aws/credentials",
  ".docker/config.json",
];

const SENSITIVE_PATTERNS = [
  /\.env(\..+)?$/, // .env 及变体
  /credentials.*\.json$/i, // 凭证 JSON
  /secret/i, // 含 "secret" 的文件
  /\.pem$/, // 证书
  /\.key$/, // 私钥
];

function isSensitiveFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  if (SENSITIVE_FILES.includes(basename)) return true;
  return SENSITIVE_PATTERNS.some((p) => p.test(basename));
}
```

### 2.4 Bash 命令安全

Agent 生成的 bash 命令可能包含危险操作。需要在执行前进行安全检查。

```typescript
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\s+[\/~]/, // rm -rf / or ~
  /\b(curl|wget)\s+.*\|\s*bash/, // curl ... | bash (远程代码执行)
  /\bchmod\s+777\b/, // 过于宽松的权限
  /\b(mkfs|fdisk|dd)\b/, // 磁盘操作
  /\b>\s*\/dev\/sd[a-z]/, // 覆写磁盘设备
  /\bsudo\b/, // 提权操作
  /\b:(){ :\|:& };:/, // fork bomb
  /\bshutdown\b|\breboot\b/, // 关机/重启
];

function isSafeBashCommand(command: string): { safe: boolean; reason?: string } {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        safe: false,
        reason: `命令匹配危险模式: ${pattern.source}`,
      };
    }
  }
  return { safe: true };
}
```

---

## 3. 性能

### 3.1 Token 优化

Token 消耗直接关系到成本和延迟。优化策略：

1. **工具输出截断**：Pi 默认截断输出到最后 N 行或 K 字节，避免大文件内容吞噬上下文
2. **增量更新**：只发送变化的部分，而非完整状态
3. **选择性上下文**：只包含与当前任务相关的文件内容
4. **压缩历史**：定期将旧对话压缩为摘要

```typescript
interface TruncationConfig {
  maxLines: number; // 默认 2000
  maxBytes: number; // 默认 50KB
}

function truncateOutput(
  content: string,
  config: TruncationConfig,
): { content: string; truncated: boolean; fullPath?: string } {
  const lines = content.split("\n");
  const bytes = Buffer.byteLength(content);

  if (lines.length <= config.maxLines && bytes <= config.maxBytes) {
    return { content, truncated: false };
  }

  // 保留最后 N 行（最新的内容更重要）
  const kept = lines.slice(-config.maxLines);
  let result = kept.join("\n");

  // 再检查字节限制
  if (Buffer.byteLength(result) > config.maxBytes) {
    result = result.slice(-config.maxBytes);
  }

  // 保存完整输出到临时文件
  const fullPath = saveTempFile(content);

  return { content: result, truncated: true, fullPath };
}
```

### 3.2 并行工具执行

当 LLM 一次返回多个工具调用时，独立的调用应该并行执行。

```typescript
async function executeToolCalls(
  calls: ToolCall[],
  tools: Map<string, Tool>,
): Promise<ToolResult[]> {
  // 并行执行所有工具调用
  const results = await Promise.allSettled(
    calls.map(async (call) => {
      const tool = tools.get(call.name);
      if (!tool) {
        return { toolCallId: call.id, error: `未知工具: ${call.name}` };
      }
      return executeToolSafely(tool, call.input, tool.timeoutMs);
    }),
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      toolCallId: calls[i].id,
      success: false,
      content: `执行异常: ${r.reason}`,
    };
  });
}
```

### 3.3 会话清理

长时间运行的 Agent 会积累临时文件、子进程等资源。

```typescript
class SessionCleanup {
  private tempFiles: string[] = [];
  private childPids: Set<number> = new Set();
  private timers: NodeJS.Timeout[] = [];

  trackTempFile(path: string): void {
    this.tempFiles.push(path);
  }

  trackChildProcess(pid: number): void {
    this.childPids.add(pid);
  }

  trackTimer(timer: NodeJS.Timeout): void {
    this.timers.push(timer);
  }

  async cleanup(): Promise<void> {
    // 清理临时文件
    for (const file of this.tempFiles) {
      try {
        await fs.unlink(file);
      } catch {
        /* 忽略 */
      }
    }

    // 杀死残留子进程
    for (const pid of this.childPids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* 已退出 */
      }
    }

    // 清除定时器
    for (const timer of this.timers) {
      clearTimeout(timer);
    }

    this.tempFiles = [];
    this.childPids.clear();
    this.timers = [];
  }
}
```

---

## 4. 配置系统

### 4.1 配置层次

一个成熟的 Agent 需要多层配置：

```
优先级从低到高:
1. 硬编码默认值
2. 全局配置:  ~/.agent/config.yaml
3. 项目配置:  .agent/config.yaml (项目根目录)
4. 环境变量:  AGENT_* 前缀
5. 命令行参数
```

### 4.2 配置文件结构

```yaml
# ~/.agent/config.yaml (全局配置)
retry:
  enabled: true
  maxRetries: 3
  baseDelayMs: 2000

compaction:
  enabled: true
  reserveTokens: 16384

security:
  allowedPaths:
    - "~/projects"
    - "/tmp"
  blockedCommands:
    - "rm -rf /"

defaultModel: "claude-sonnet-4-20250514"
defaultProvider: "anthropic"
```

```yaml
# .agent/config.yaml (项目配置)
# 覆盖全局设置
retry:
  maxRetries: 5 # 这个项目网络不稳定，多重试几次

security:
  allowedPaths:
    - "./src"
    - "./tests" # 只允许访问项目内的特定目录
```

### 4.3 配置合并

项目配置覆盖全局配置，遵循深度合并规则：

```typescript
function mergeConfig(global: Config, project: Partial<Config>): Config {
  const merged = structuredClone(global);

  for (const [key, value] of Object.entries(project)) {
    if (value === undefined) continue;

    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof merged[key] === "object" &&
      merged[key] !== null
    ) {
      // 对象：深度合并
      merged[key] = mergeConfig(merged[key], value);
    } else {
      // 标量和数组：直接覆盖
      merged[key] = structuredClone(value);
    }
  }

  return merged;
}
```

### 4.4 YAML 校验

配置文件必须经过严格校验，防止无效配置导致运行时错误。

```typescript
import { parse } from "yaml";

interface ConfigSchema {
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
  };
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
  };
  security?: {
    allowedPaths?: string[];
    blockedCommands?: string[];
  };
  defaultModel?: string;
  defaultProvider?: string;
}

function loadConfig(filePath: string): ConfigSchema {
  const content = fs.readFileSync(filePath, "utf-8");
  const raw = parse(content);

  // 校验并返回类型安全的配置
  return validateConfig(raw);
}

function validateConfig(raw: unknown): ConfigSchema {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("配置文件必须是一个 YAML 对象");
  }

  const config = raw as Record<string, unknown>;
  const errors: string[] = [];

  // 校验 retry 部分
  if (config.retry !== undefined) {
    if (typeof config.retry !== "object" || config.retry === null) {
      errors.push("retry 必须是一个对象");
    } else {
      const retry = config.retry as Record<string, unknown>;
      if (retry.maxRetries !== undefined) {
        if (typeof retry.maxRetries !== "number" || retry.maxRetries < 0) {
          errors.push("retry.maxRetries 必须是非负整数");
        }
      }
      if (retry.baseDelayMs !== undefined) {
        if (typeof retry.baseDelayMs !== "number" || retry.baseDelayMs < 0) {
          errors.push("retry.baseDelayMs 必须是非负数");
        }
      }
    }
  }

  // ... 其他字段校验

  if (errors.length > 0) {
    throw new ConfigError("配置校验失败:\n" + errors.join("\n"));
  }

  return config as ConfigSchema;
}
```

---

## 5. 完整伪代码：生产加固 Agent

```typescript
// ========================================
// 生产加固 Agent 的完整结构
// ========================================

class ProductionAgent {
  private config: Config;
  private cleanup: SessionCleanup;

  constructor() {
    // 1. 加载配置（全局 + 项目，深度合并）
    this.config = loadMergedConfig();

    // 2. 初始化清理器
    this.cleanup = new SessionCleanup();

    // 3. 注册退出钩子
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  async prompt(userMessage: string): Promise<void> {
    // 包装 LLM 调用，加上自动重试
    const response = await withRetry(
      () => this.callLLM(userMessage),
      this.config.retry,
      (err) => this.isRetryableError(err),
    );

    // 处理响应
    if (response.stopReason === "error") {
      if (isContextOverflow(response)) {
        await this.handleContextOverflow();
        return;
      }
      throw new Error(response.errorMessage);
    }

    // 处理工具调用
    if (response.toolCalls.length > 0) {
      await this.handleToolCalls(response.toolCalls);
    }

    // 检查是否需要自动压缩
    await this.checkAutoCompaction();
  }

  private async handleToolCalls(calls: ToolCall[]): Promise<void> {
    for (const call of calls) {
      // 安全检查
      if (call.name === "bash") {
        const check = isSafeBashCommand(call.input.command);
        if (!check.safe) {
          // 返回安全错误给 LLM，而非执行
          await this.returnToolError(call.id, check.reason);
          continue;
        }
      }

      if (call.name === "read" || call.name === "write") {
        if (isSensitiveFile(call.input.path)) {
          await this.returnToolError(call.id, "拒绝访问敏感文件");
          continue;
        }
        if (!isPathSafe(call.input.path, this.config.security.allowedBase)) {
          await this.returnToolError(call.id, "路径越界");
          continue;
        }
      }

      // 执行工具（带超时和错误处理）
      const result = await executeToolSafely(
        this.tools.get(call.name),
        call.input,
        30000, // 30s 超时
      );

      this.cleanup.trackAnyResources(result);
    }
  }

  private async handleContextOverflow(): Promise<void> {
    if (this.overflowRecoveryAttempted) {
      throw new Error("上下文溢出恢复已失败，请手动处理");
    }
    this.overflowRecoveryAttempted = true;

    await this.compact({ reason: "overflow" });
    await this.agent.continue(); // 自动重试
  }

  private async checkAutoCompaction(): Promise<void> {
    if (!this.config.compaction.enabled) return;

    const usage = this.getContextTokenUsage();
    const limit = this.model.contextWindow;
    const threshold = limit - this.config.compaction.reserveTokens;

    if (usage > threshold) {
      await this.compact({ reason: "threshold" });
    }
  }

  private async shutdown(): Promise<void> {
    await this.cleanup.cleanup();
    process.exit(0);
  }
}

// ========================================
// 配置加载
// ========================================

function loadMergedConfig(): Config {
  // 1. 默认值
  const defaults = getDefaultConfig();

  // 2. 全局配置
  const globalPath = path.join(os.homedir(), ".agent", "config.yaml");
  const global = fs.existsSync(globalPath) ? loadConfig(globalPath) : {};

  // 3. 项目配置
  const projectPath = path.join(process.cwd(), ".agent", "config.yaml");
  const project = fs.existsSync(projectPath) ? loadConfig(projectPath) : {};

  // 4. 合并：defaults <- global <- project
  return mergeConfig(mergeConfig(defaults, global), project);
}
```

---

## 动手练习

1. **运行 demo.ts 并观察生产加固组件**

   ```bash
   npx tsx src/demo.ts
   ```

   确认程序启动时加载了配置（全局 + 项目合并）、注册了退出钩子（SIGTERM/SIGINT）、初始化了 SessionCleanup。观察日志输出中是否包含配置加载路径信息。

2. **测试重试逻辑**
   修改 demo.ts 或编写测试代码，模拟一个返回 429 状态码的 LLM 调用。验证：
   - `withRetry()` 按指数退避重试（第一次等 2s，第二次等 4s，第三次等 8s）
   - 达到 `maxRetries` 后抛出最后一个错误
   - 传入 `AbortController` 的 signal，在等待期间调用 `abort()`，确认重试立即终止
     同时验证 400（客户端错误）和 401（认证失败）不会触发重试。

3. **测试路径安全检查**
   调用 `isPathSafe()` 函数，传入以下路径并验证结果：

   ```typescript
   isPathSafe("src/index.ts", "/project"); // true -- 正常相对路径
   isPathSafe("../../../etc/passwd", "/project"); // false -- 路径穿越
   isPathSafe("src/../../outside.txt", "/project"); // false -- 隐蔽穿越
   ```

   同时测试 `isSensitiveFile()` 函数，验证 `.env`、`credentials.json`、`id_rsa` 被识别为敏感文件，而 `README.md`、`src/main.ts` 不被识别。

4. **创建配置文件并验证合并逻辑**
   在项目根目录创建 `.agent/config.yaml`：
   ```yaml
   retry:
     maxRetries: 5
   security:
     allowedPaths:
       - "./src"
   ```
   调用 `loadMergedConfig()`，验证：
   - `retry.maxRetries` 为 5（项目配置覆盖了默认值 3）
   - `retry.baseDelayMs` 保持默认值 2000（项目配置未指定，继承全局/默认）
   - `security.allowedPaths` 为 `["./src"]`（数组直接覆盖，不合并）
     测试完毕后删除 `.agent/config.yaml`。

---

## 总结

生产加固不是一个一次性的任务，而是一个持续的过程。核心原则：

1. **永远不信任外部输入** — LLM 生成的路径、命令、参数都需要验证
2. **优雅降级** — 单个组件失败不应导致整个系统崩溃
3. **可观测性** — 重试、压缩、安全拦截都应该有清晰的日志和用户反馈
4. **可配置性** — 所有阈值和策略都应可通过配置文件调整
5. **资源管理** — 临时文件、子进程、定时器都需要在会话结束时清理
