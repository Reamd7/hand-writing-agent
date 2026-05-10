# 第十课: Bash Tool -- 让 Agent 执行命令

## 概述

前面几课我们构建了 Agent 的核心循环和工具框架。现在进入最关键的工具之一: **Bash Tool** -- 让 Agent 能够在用户机器上执行任意 shell 命令。

Bash Tool 不是简单地调用 `child_process.exec()` 拿到结果。生产级实现需要解决一系列棘手问题:

- **流式输出**: 长时间运行的命令需要实时展示输出，而不是等命令结束才返回
- **输出膨胀**: `find /` 可能产生几十 MB 输出，必须限制内存占用
- **超时控制**: 命令挂起时需要能强制终止
- **用户中断**: 用户按 Ctrl+C 时需要杀死子进程
- **跨平台**: Windows 和 Unix 的 shell、进程管理、信号机制完全不同
- **退出码**: 非零退出码需要告知 Agent 命令失败了

本课将:

1. 分析 `child_process.spawn` 的关键配置
2. 实现 `OutputAccumulator` -- 流式输出的有界缓冲区
3. 实现完整的 Bash Tool: 流式更新、超时、中断、截断
4. 编写跨平台 demo 验证所有功能

---

## 1. child_process.spawn 的 Shell 包装

### 为什么用 spawn 而不是 exec

Node.js 提供了两种主要的命令执行方式:

| 方法                   | 特点                                               |
| ---------------------- | -------------------------------------------------- |
| `exec(command)`        | 缓冲全部输出到内存，通过回调返回完整 stdout/stderr |
| `spawn(command, args)` | 流式输出，stdout/stderr 是可读流                   |

Agent 执行的命令可能产生大量输出 (`grep -r`, `find /`, `npm install`)。`exec` 会把所有输出缓冲到内存，超过 `maxBuffer` (默认 1MB) 就会报错。`spawn` 则以流的方式逐块推送数据，我们可以按需截断。

### Shell 包装模式

直接用 `spawn("ls", ["-la"])` 只能执行简单命令，不支持管道 (`|`)、重定向 (`>`)、环境变量展开 (`$HOME`) 等 shell 特性。Agent 需要完整的 shell 能力，所以我们的模式是:

```typescript
// 不是这样:
spawn(command, { shell: true });

// 而是这样:
spawn(shellPath, ["-c", command], { cwd, env, ... });
```

为什么不用 `shell: true`? 因为 `shell: true` 使用系统默认 shell (Windows 上是 `cmd.exe`)，而我们希望明确控制使用哪个 shell。Pi 在 Windows 上优先使用 Git Bash，这样 Agent 编写的命令可以跨平台一致。

### 跨平台 Shell 解析

Pi 的 `getShellConfig()` 按优先级解析 shell:

```
Windows:
  1. 用户配置的 shellPath
  2. Git Bash (Program Files\Git\bin\bash.exe)
  3. PATH 上的 bash.exe (Cygwin, MSYS2, WSL)
  4. 抛错

Unix:
  1. 用户配置的 shellPath
  2. /bin/bash
  3. PATH 上的 bash
  4. sh (最终兜底)
```

我们的教学版简化为: 在 Windows 上使用 `cmd.exe /c`，在 Unix 上使用 `/bin/sh -c`。这样不依赖 Git Bash，保证到处都能跑:

```typescript
function getShellConfig(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    return { shell: process.env.ComSpec || "cmd.exe", args: ["/c"] };
  }
  return { shell: "/bin/sh", args: ["-c"] };
}
```

### 环境变量注入

`spawn` 的 `env` 选项完全替换子进程的环境变量 (不是追加)。如果传了 `env`，子进程就只有你传的这些变量。所以需要展开 `process.env` 再追加自定义变量:

```typescript
const env = {
  ...process.env, // 继承父进程所有环境变量
  CUSTOM_VAR: "value", // 追加自定义变量
};
spawn(shell, args, { env });
```

### stdio 配置

```typescript
spawn(shell, args, {
  stdio: ["ignore", "pipe", "pipe"],
  //       stdin    stdout   stderr
});
```

- `stdin: "ignore"` -- Agent 执行的命令不需要交互式输入
- `stdout: "pipe"` -- 通过 `child.stdout` 流读取标准输出
- `stderr: "pipe"` -- 通过 `child.stderr` 流读取标准错误

### detached 模式与进程树清理

```typescript
spawn(shell, args, {
  detached: process.platform !== "win32",
});
```

在 Unix 上，`detached: true` 让子进程成为新进程组的组长。这样当我们需要终止命令时，可以用 `process.kill(-pid, "SIGKILL")` 杀掉整个进程组 (包括命令启动的所有子进程)。

在 Windows 上不需要 `detached`，因为 `taskkill /F /T /PID` 可以直接杀掉进程树。

跨平台的进程树终止:

```typescript
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      detached: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // 负 PID = 进程组
    } catch {
      try {
        process.kill(pid, "SIGKILL"); // 兜底: 只杀直接子进程
      } catch {
        // 进程已退出
      }
    }
  }
}
```

---

## 2. OutputAccumulator: 有界输出缓冲区

### 问题

命令输出可能非常大。`find / -name "*.js"` 轻松产出几十 MB。我们不能:

- 把全部输出存在内存里 (OOM)
- 把全部输出发给 LLM (token 爆炸)

但我们需要:

- 实时流式展示输出给用户
- 命令结束后把截断结果返回给 Agent
- 超大输出保存到临时文件，让 Agent 需要时可以读取

### 设计

`OutputAccumulator` 是一个增量式输出跟踪器，核心策略:

1. **滚动尾部缓冲**: 内存中只保留最近 `maxBytes * 2` 的解码文本
2. **行和字节双限制**: 快照时按 2000 行 / 50KB 截断 (取先触发的)
3. **尾部截断**: 保留最新输出 (错误信息通常在末尾)
4. **懒惰临时文件**: 只在输出超过限制时才创建临时文件保存完整输出

### 数据流

```
Buffer chunks (from spawn)
    |
    v
append(data: Buffer)
    |
    +---> TextDecoder.decode(data, {stream:true}) --> tailText (滚动缓冲)
    |
    +---> rawChunks[] (临时文件打开前暂存)
    |     或
    +---> tempFileStream.write(data) (临时文件打开后直接写入)
    |
    v
snapshot() --> truncateTail(tailText) --> { content, truncation, fullOutputPath }
```

### 为什么用 TextDecoder 而不是 toString

`child.stdout` 推送的是 `Buffer`，需要解码为字符串。直接 `data.toString("utf-8")` 有一个隐蔽问题: 多字节 UTF-8 字符可能被拆分到两个 chunk 中。例如中文字符 "你" 是 3 字节 `[0xE4, 0xBD, 0xA0]`，可能第一个 chunk 以 `[0xE4, 0xBD]` 结尾，第二个以 `[0xA0]` 开头。`toString()` 会各自解码出乱码。

`TextDecoder` 的 `{ stream: true }` 选项解决了这个问题: 它会缓存不完整的多字节序列，等下一个 chunk 到来时再拼接解码。

```typescript
const decoder = new TextDecoder();

// chunk 1: [0xE4, 0xBD] -- 不完整的 UTF-8，TextDecoder 缓存
decoder.decode(chunk1, { stream: true }); // ""

// chunk 2: [0xA0, 0x48, 0x69] -- 拼接后完成解码
decoder.decode(chunk2, { stream: true }); // "你Hi"

// 结束: 刷新缓存
decoder.decode(); // ""
```

### 滚动尾部缓冲

`tailText` 不断追加新解码的文本。当它超过 `maxBytes * 4` 时 (`maxRollingBytes * 2`)，执行修剪:

```
修剪前: tailText = "... 很长的旧输出 ... 新输出"
                                        ^
                        maxRollingBytes 位置 (从末尾回退)

修剪后: tailText = "新输出的后半部分"
```

修剪时需要注意 UTF-8 字符边界。通过检查字节的高位 (`byte & 0xC0 === 0x80` 表示续延字节)，跳过不完整字符:

```typescript
// 找到有效的 UTF-8 字符起始位置
while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
  start++;
}
```

### 快照与截断

`snapshot()` 对当前尾部缓冲执行 `truncateTail()`:

- **行限制**: 从末尾往前数最多 2000 行
- **字节限制**: 从末尾往前累加字节，不超过 50KB
- **先触发的赢**: 如果 1500 行就超了 50KB，按字节截断

截断是尾部截断 (tail truncation) -- 保留最新的输出。这和 `read` 工具的头部截断 (head truncation，保留文件开头) 相反。对于命令输出，错误信息和最终结果通常在末尾，所以保留尾部更有价值。

### 临时文件

当输出超过限制时，完整输出需要保存到磁盘:

```typescript
if (totalRawBytes > maxBytes || totalDecodedBytes > maxBytes || totalLines > maxLines) {
  // 创建临时文件
  ensureTempFile();
}
```

临时文件的创建是懒惰的: 在输出未超限时，原始 chunk 暂存在 `rawChunks[]` 数组中。一旦决定创建临时文件，先把 `rawChunks` 全部写入，然后清空数组，后续的 chunk 直接写入文件流。

这样对于小输出 (绝大多数命令)，完全不涉及磁盘 I/O。

---

## 3. 流式更新机制

### 问题

用户执行 `npm install` 这样的长命令时，如果要等命令完成才显示输出，体验很差。我们需要在命令运行过程中实时推送输出给前端。

### onUpdate 回调

`execute()` 函数接收一个可选的 `onUpdate` 回调。每当有新输出时，调用它推送当前快照:

```typescript
async execute(toolCallId, { command, timeout }, signal, onUpdate) {
  const output = new OutputAccumulator();

  const handleData = (data: Buffer) => {
    output.append(data);
    scheduleOutputUpdate();  // 安排一次更新
  };

  child.stdout.on("data", handleData);
  child.stderr.on("data", handleData);
}
```

`onUpdate` 的参数格式和最终工具结果相同 -- 包含 `content` 数组和 `details` 对象。这样前端用同一套渲染逻辑处理中间更新和最终结果。

### 100ms 节流

高频输出的命令 (如 `cat /dev/urandom | xxd`) 每秒可能产生上百次 data 事件。每次都调用 `onUpdate` 会导致:

- 前端重绘风暴
- 不必要的 CPU 消耗
- 事件队列阻塞

解决方案是 100ms 节流:

```typescript
const THROTTLE_MS = 100;
let lastUpdateAt = 0;
let updateDirty = false;
let updateTimer: NodeJS.Timeout | undefined;

function scheduleOutputUpdate(): void {
  updateDirty = true;
  const delay = THROTTLE_MS - (Date.now() - lastUpdateAt);

  if (delay <= 0) {
    // 上次更新已经超过 100ms，立即发送
    clearTimeout(updateTimer);
    updateTimer = undefined;
    emitOutputUpdate();
    return;
  }

  // 还没到 100ms，安排延迟发送 (只安排一次)
  updateTimer ??= setTimeout(() => {
    updateTimer = undefined;
    emitOutputUpdate();
  }, delay);
}

function emitOutputUpdate(): void {
  if (!updateDirty) return;
  updateDirty = false;
  lastUpdateAt = Date.now();

  const snapshot = output.snapshot({ persistIfTruncated: true });
  onUpdate({
    content: [{ type: "text", text: snapshot.content || "" }],
    details: { ... },
  });
}
```

关键设计:

- `updateDirty` 标记: 避免无数据变化时的空更新
- `delay <= 0` 快速路径: 上次更新已超过 100ms，直接发送，不走 timer
- `??=` 只创建一个 timer: 多次 `scheduleOutputUpdate()` 调用不会创建多个 timer
- 结束时先 `clearUpdateTimer()` 再 `emitOutputUpdate()`: 确保最终状态被发送

### 事件流中的位置

在 Agent 框架中，`onUpdate` 回调最终会触发 `tool_execution_update` 事件:

```
tool_execution_start
  |
  +-- tool_execution_update (100ms 间隔)
  +-- tool_execution_update
  +-- tool_execution_update
  |
tool_execution_end (包含最终结果)
```

前端订阅这些事件来实时渲染命令输出。

---

## 4. 超时控制

### 实现

超时是可选的。Agent 可以在工具参数中指定 `timeout` (秒):

```typescript
if (timeout !== undefined && timeout > 0) {
  timeoutHandle = setTimeout(() => {
    timedOut = true;
    killProcessTree(child.pid);
  }, timeout * 1000);
}
```

超时触发时:

1. 设置 `timedOut = true` 标记
2. 杀掉整个进程树
3. 子进程退出，Promise resolve
4. 检查 `timedOut` 标记，抛出 `Error("timeout:N")`
5. 上层捕获，返回已收集的输出 + 超时提示

### 超时 vs 正常退出的时序

```
正常退出:
  spawn -> data events -> child exits -> clearTimeout -> resolve(exitCode)

超时退出:
  spawn -> data events -> setTimeout fires -> killProcessTree -> child exits
    -> check timedOut=true -> reject(Error("timeout:N"))
```

注意: `killProcessTree()` 之后子进程不会立即退出。它是异步的 -- 信号发出后需要等待 OS 清理。所以我们在 `waitForChildProcess()` resolve 之后再检查 `timedOut` 标记，而不是在 timeout 回调中直接 reject。

### 清理

无论正常退出还是超时，都需要清理 timer:

```typescript
if (timeoutHandle) clearTimeout(timeoutHandle);
```

---

## 5. AbortSignal: 用户中断

### 场景

用户在 Agent 执行命令时按 Ctrl+C (或点击中断按钮)。Agent 框架传递一个 `AbortSignal` 给工具的 `execute` 函数。

### 实现

```typescript
const onAbort = () => {
  if (child.pid) killProcessTree(child.pid);
};

if (signal) {
  if (signal.aborted) {
    // 信号在 spawn 之前就已经触发了
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }
}
```

关键点:

- **检查 `signal.aborted`**: 信号可能在 `spawn` 之前就已经触发，必须立即处理
- **`{ once: true }`**: 只监听一次，避免重复杀进程
- **清理监听器**: 正常退出时要 `signal.removeEventListener("abort", onAbort)`，防止内存泄漏
- **中断后 reject**: `signal.aborted` 为 true 时，reject `Error("aborted")`

### 中断后的输出处理

中断时可能已经有部分输出。上层会:

1. 调用 `finishOutput()` 获取已收集的输出快照
2. 把输出和 "Command aborted" 状态拼接
3. 作为错误消息抛出

这样 Agent 能看到命令被中断前的输出，帮助它理解发生了什么。

---

## 6. 输出截断: truncateTail

### 双限制策略

截断有两个独立限制，先触发的赢:

- **行限制**: 默认 2000 行
- **字节限制**: 默认 50KB

### 为什么是 tail 截断

```
完整输出 (10000 行):
  第 1 行: 编译开始...
  第 2 行: 编译文件 a.ts...
  ...
  第 9998 行: 编译文件 z.ts...
  第 9999 行: Error: Type 'string' is not assignable to type 'number'
  第 10000 行: 编译失败，1 个错误

tail 截断 (保留最后 2000 行):
  第 8001 行: 编译文件 x.ts...
  ...
  第 9999 行: Error: Type 'string' is not assignable to type 'number'
  第 10000 行: 编译失败，1 个错误
```

错误信息在末尾。如果做 head 截断 (保留开头)，Agent 只能看到 "编译开始..." 这样的无用信息。

### truncateTail 算法

```
输入: content (字符串), maxLines, maxBytes

1. 按 "\n" 分割成行数组 lines[]
2. 如果 totalLines <= maxLines 且 totalBytes <= maxBytes:
     返回原内容，truncated = false

3. 从末尾往前遍历:
   for i = lines.length-1 downto 0:
     lineBytes = byteLength(lines[i]) + (已有行 ? 1 : 0)  // +1 是换行符
     if 累积字节 + lineBytes > maxBytes:
       truncatedBy = "bytes"
       break
     收集此行
     if 已收集行数 >= maxLines:
       truncatedBy = "lines"
       break

4. 返回收集的行 (倒序拼接) + 截断元数据
```

### 大输出到磁盘

当输出被截断时，完整输出已被写入临时文件。返回给 Agent 的消息中包含文件路径:

```
[Showing lines 8001-10000 of 10000. Full output: /tmp/pi-bash-a1b2c3d4.log]
```

Agent 可以用 `read` 工具读取完整文件的特定部分。

---

## 7. 退出码处理

### 非零退出码

shell 命令的退出码 0 表示成功，非零表示失败。常见的退出码:

| 退出码 | 含义                             |
| ------ | -------------------------------- |
| 0      | 成功                             |
| 1      | 一般错误                         |
| 2      | 使用错误 (参数错误)              |
| 126    | 权限不足                         |
| 127    | 命令不存在                       |
| 128+N  | 被信号 N 终止 (如 137 = SIGKILL) |

### 处理逻辑

```typescript
if (exitCode !== 0 && exitCode !== null) {
  throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
}
```

非零退出码时，工具返回错误。错误消息包含:

1. 命令的实际输出 (可能包含错误详情)
2. 尾部追加 `"Command exited with code N"`

这两部分之间用空行分隔。Agent 看到这个消息就知道命令失败了，并且能从输出中理解失败原因。

`exitCode === null` 表示进程被信号终止但没有退出码 (通常是我们自己杀的 -- 超时或中断)。这种情况在上层已经处理了 (超时/中断的 error path)。

---

## 8. 完整伪代码

### OutputAccumulator

```
class OutputAccumulator:
    maxLines = 2000
    maxBytes = 50KB
    decoder = new TextDecoder()
    tailText = ""
    tailBytes = 0
    totalRawBytes = 0
    totalDecodedBytes = 0
    totalLines = 1
    rawChunks = []
    tempFilePath = null
    tempFileStream = null

    append(data: Buffer):
        totalRawBytes += data.length
        text = decoder.decode(data, {stream: true})
        totalDecodedBytes += byteLength(text)
        tailText += text
        tailBytes += byteLength(text)

        // 计算新增的换行数
        totalLines += countNewlines(text)

        // 修剪过大的尾部缓冲
        if tailBytes > maxBytes * 4:
            trimTail()

        // 决定是否需要临时文件
        if tempFileStream exists:
            tempFileStream.write(data)
        else if shouldUseTempFile():
            ensureTempFile()
            tempFileStream.write(data)
        else:
            rawChunks.push(data)

    finish():
        text = decoder.decode()  // 刷新缓存
        appendDecodedText(text)
        if shouldUseTempFile():
            ensureTempFile()

    snapshot() -> {content, truncation, fullOutputPath}:
        result = truncateTail(snapshotText(), maxLines, maxBytes)
        return {
            content: result.content,
            truncation: result metadata,
            fullOutputPath: tempFilePath,
        }

    trimTail():
        buffer = Buffer.from(tailText)
        start = buffer.length - maxBytes*2
        // 跳过不完整的 UTF-8 字符
        while buffer[start] is continuation byte:
            start++
        tailText = buffer[start..].toString()

    ensureTempFile():
        if tempFilePath exists: return
        tempFilePath = os.tmpdir() + "/pi-bash-" + randomHex + ".log"
        tempFileStream = createWriteStream(tempFilePath)
        for chunk in rawChunks:
            tempFileStream.write(chunk)
        rawChunks = []
```

### Bash Tool Execute

```
function executeBash(command, timeout, signal, onUpdate):
    output = new OutputAccumulator()
    lastUpdateAt = 0
    updateDirty = false
    updateTimer = null

    // 节流更新
    scheduleOutputUpdate():
        updateDirty = true
        delay = 100ms - (now - lastUpdateAt)
        if delay <= 0:
            clearTimer(updateTimer)
            emitOutputUpdate()
            return
        if updateTimer is null:
            updateTimer = setTimeout(emitOutputUpdate, delay)

    emitOutputUpdate():
        if not updateDirty: return
        updateDirty = false
        lastUpdateAt = now
        snapshot = output.snapshot()
        onUpdate({ content: snapshot.content, details: snapshot.truncation })

    // 启动子进程
    {shell, args} = getShellConfig()
    child = spawn(shell, [...args, command], {
        cwd, env, stdio: ["ignore", "pipe", "pipe"],
        detached: (platform != "win32"),
    })

    // 超时
    if timeout > 0:
        timeoutHandle = setTimeout(() => {
            timedOut = true
            killProcessTree(child.pid)
        }, timeout * 1000)

    // 流式收集
    child.stdout.on("data", data => {
        output.append(data)
        scheduleOutputUpdate()
    })
    child.stderr.on("data", data => {
        output.append(data)
        scheduleOutputUpdate()
    })

    // 中断
    onAbort = () => killProcessTree(child.pid)
    if signal:
        if signal.aborted: onAbort()
        else: signal.on("abort", onAbort, {once: true})

    // 等待退出
    try:
        exitCode = await waitForProcess(child)
    catch err:
        snapshot = finishOutput()
        if err.message == "aborted":
            throw Error(snapshot.content + "\nCommand aborted")
        if err.message starts with "timeout:":
            throw Error(snapshot.content + "\nCommand timed out after Ns")
        throw err
    finally:
        clearTimeout(timeoutHandle)
        signal?.removeEventListener("abort", onAbort)

    // 完成
    snapshot = finishOutput()
    if exitCode != 0:
        throw Error(snapshot.content + "\nCommand exited with code " + exitCode)
    return { content: snapshot.content, details: snapshot.truncation }
```

---

## 9. 与 Pi 实现的对比

| 维度           | 教学版                    | Pi 生产版                                      |
| -------------- | ------------------------- | ---------------------------------------------- |
| Shell 选择     | `cmd.exe` / `/bin/sh`     | Git Bash 优先，多级回退                        |
| 输出合并       | stdout + stderr 合并      | 相同                                           |
| 流式更新       | 100ms 节流                | 相同                                           |
| 截断策略       | tail 截断，2000 行 / 50KB | 相同                                           |
| 临时文件       | 超限写 tmpdir             | 相同                                           |
| 进程树清理     | `taskkill` / `SIGKILL`    | 相同 + PID 跟踪 + 父进程退出时清理             |
| Pluggable 后端 | 无                        | `BashOperations` 接口，可替换为 SSH 等远程执行 |
| Spawn Hook     | 无                        | `BashSpawnHook` 可改写 command/cwd/env         |
| UI 渲染        | 无                        | `renderCall()` / `renderResult()` TUI 组件     |
| 命令前缀       | 无                        | `commandPrefix` 注入 shell 初始化脚本          |

---

## 动手练习

1. **运行 demo，观察流式输出和节流机制**

   ```bash
   npx tsx src/demo.ts
   ```

   demo 会执行多个命令场景: 快速命令（`echo`）、流式输出命令（`ping` 或循环 `echo`）、非零退出码命令。观察流式输出的更新频率，确认 100ms 节流生效 -- 即使命令产出大量输出，`tool_execution_update` 事件也不会超过每秒 10 次。

2. **测试超时控制: 执行一个长时间运行的命令**
   修改 `demo.ts`，执行一个 `sleep 30`（或 Windows 上的 `ping -n 30 127.0.0.1`）命令，并设置 `timeout: 3`（3 秒超时）:

   ```bash
   npx tsx src/demo.ts timeout
   ```

   验证命令在约 3 秒后被终止，输出中包含 "Command timed out after 3s" 错误消息。检查进程是否被完全清理（无残留子进程）。

3. **测试 AbortSignal 中断**
   修改 `demo.ts`，启动一个长命令后在 2 秒后手动触发 `abortController.abort()`:

   ```bash
   npx tsx src/demo.ts abort
   ```

   验证命令被中断，输出中包含 "Command aborted" 消息以及中断前已收集的部分输出。确认 abort listener 被正确清理（无内存泄漏警告）。

4. **验证大输出的截断和临时文件机制**
   执行一个产生大量输出的命令（如 `seq 1 10000` 或 Windows 上的等效命令），观察截断行为:
   ```bash
   npx tsx src/demo.ts large-output
   ```
   确认返回的内容只包含最后 2000 行（tail 截断），且输出末尾包含临时文件路径 `Full output: /tmp/pi-bash-xxxx.log`。用 `cat` 或 `read` 工具检查临时文件，验证完整输出已被保存。

---

## 总结

| 概念                        | 作用                                                       |
| --------------------------- | ---------------------------------------------------------- |
| `spawn(shell, ["-c", cmd])` | 在指定 shell 中执行命令，获取流式输出                      |
| `OutputAccumulator`         | 有界缓冲区: 滚动尾部 + TextDecoder 流式解码 + 懒惰临时文件 |
| 100ms 节流                  | 避免高频输出导致 UI 重绘风暴                               |
| `truncateTail()`            | 保留最新 2000 行 / 50KB，错误信息在末尾                    |
| 临时文件                    | 超限输出写磁盘，返回路径让 Agent 按需读取                  |
| `killProcessTree()`         | 跨平台终止进程树: `taskkill /F /T` vs `SIGKILL` 进程组     |
| AbortSignal                 | 用户中断时杀子进程，返回已收集的部分输出                   |
| 退出码                      | 非零追加 "Command exited with code N"，通知 Agent 命令失败 |

下一课我们将实现 Edit 和 Write 工具 -- 让 Agent 能够修改文件。
