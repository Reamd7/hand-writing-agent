# 第十一课: Edit 和 Write 工具 -- 文件变更的核心引擎

## 概述

前几课我们构建了 Agent 的循环、工具执行管线、事件模型。但 coding agent 的核心能力 -- **修改代码文件** -- 还没有涉及。本课深入两个最关键的文件操作工具:

- **Edit**: 精确文本替换，修改文件的局部内容
- **Write**: 创建或完整覆写文件

以及支撑它们的基础设施:

- **FileMutationQueue**: 序列化对同一文件的并发写操作
- **Diff 计算**: 生成 unified diff 供 UI 展示

本课目标:

1. 理解 "精确文本替换" 模型为什么优于 diff/patch
2. 掌握多编辑批处理: 匹配、唯一性校验、重叠检测、逆序应用
3. 理解 FileMutationQueue 的 Promise 链式序列化机制
4. 掌握 Write 工具的目录自动创建和路径安全
5. 实现完整的 Edit 和 Write 工具

---

## 1. 为什么用精确文本替换而不是 diff/patch

### 1.1 LLM 生成 diff 的问题

直觉上，让模型生成 unified diff 然后 `patch` 应用似乎高效。但实践中 LLM 生成的 diff 极不可靠:

| 问题               | 说明                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| **行号漂移**       | 模型不能精确记忆文件每一行的行号，经常偏移几行                       |
| **上下文行不匹配** | diff 的 context lines 需要和文件精确匹配，模型常记错或省略空行       |
| **格式错误**       | `@@` 标记、`+`/`-` 前缀混乱，产出不合法的 diff                       |
| **跨 chunk 依赖**  | 一个 diff 里多个 hunk 的行号计算需要前一个 hunk 的增减，模型很难算对 |

精确文本替换把问题简化为: **找到这段文本，替换成那段文本**。模型只需要复制它看到的原文 (在上下文窗口里)，这比凭记忆计算行号可靠得多。

### 1.2 精确替换模型

```
输入: {
  path: "src/app.ts",
  edits: [
    { oldText: "const x = 1;", newText: "const x = 42;" },
    { oldText: "console.log(x)", newText: "console.info(x)" }
  ]
}

语义: 在文件中找到 oldText，替换为 newText
约束: 每个 oldText 必须在文件中恰好出现一次
```

关键约束:

- **唯一性**: `oldText` 在文件中必须恰好匹配一次。如果匹配 0 次，说明模型给错了文本；如果匹配多次，不知道该替换哪个
- **非重叠**: 多个 edit 的匹配区域不能重叠，否则语义不明确
- **基于原文匹配**: 所有 edit 都基于原始文件内容匹配，而不是逐个应用后的中间状态

---

## 2. Edit 工具的完整执行流程

### 2.1 高层流程

```
prepareArguments()          -- 兼容性适配
    |
    v
validateEditInput()         -- 校验 edits 非空
    |
    v
resolveToCwd()              -- 路径解析
    |
    v
withFileMutationQueue()     -- 序列化同文件操作
    |
    v
access()                    -- 检查文件可读可写
    |
    v
readFile()                  -- 读取文件内容
    |
    v
stripBom()                  -- 去除 BOM 标记
    |
    v
detectLineEnding()          -- 检测 CRLF/LF
    |
    v
normalizeToLF()             -- 统一转为 LF
    |
    v
applyEditsToNormalizedContent()  -- 核心: 匹配+替换
    |
    v
restoreLineEndings()        -- 恢复原始行尾
    |
    v
writeFile()                 -- 写回文件
    |
    v
generateDiffString()        -- 生成 diff 供 UI 展示
```

### 2.2 行尾规范化

文件可能使用 CRLF (Windows) 或 LF (Unix)，而 LLM 总是生成 LF。如果不做规范化，`oldText` 永远无法匹配 CRLF 文件:

```typescript
function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
```

策略: 读文件 -> 检测行尾 -> 全部转 LF -> 匹配和替换 -> 转回原始行尾 -> 写回。

### 2.3 BOM 处理

UTF-8 BOM (`\uFEFF`) 是一个不可见字符，出现在某些 Windows 编辑器创建的文件开头。LLM 不会在 `oldText` 中包含它，所以必须先剥离:

```typescript
function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}
```

写回时把 BOM 拼回去: `bom + restoreLineEndings(newContent, originalEnding)`。

### 2.4 核心: `applyEditsToNormalizedContent()`

这是 Edit 工具最关键的函数。它接收 LF 规范化后的文件内容和编辑数组，返回替换前后的内容:

```
输入: normalizedContent, edits[], path
输出: { baseContent, newContent }

步骤:
1. 规范化每个 edit 的 oldText/newText 为 LF
2. 校验: 每个 oldText 不能为空
3. 对所有 edit 做 fuzzyFindText，决定是否需要模糊匹配
4. 如果任何 edit 需要模糊匹配，将 baseContent 也做模糊规范化
5. 对每个 edit:
   a. 在 baseContent 中查找匹配位置
   b. 如果找不到 -> 报错
   c. 计算出现次数，如果 >1 -> 报错 "不唯一"
   d. 记录 { matchIndex, matchLength, newText }
6. 按 matchIndex 排序
7. 检查相邻 edit 是否重叠
8. 从后往前 (逆序) 应用替换
9. 如果替换后内容没变化 -> 报错
```

**为什么从后往前应用?** 因为替换会改变字符串长度。从后往前替换时，前面的匹配位置 (offset) 不受影响:

```
原文:   "aaa bbb ccc"
edit1:  位置 0, 长度 3, 替换为 "xx"      (aaa -> xx)
edit2:  位置 8, 长度 3, 替换为 "dddd"    (ccc -> dddd)

从后往前:
  第一步替换 edit2: "aaa bbb dddd"    -- edit1 的位置 0 不受影响
  第二步替换 edit1: "xx bbb dddd"     -- 正确!

从前往后:
  第一步替换 edit1: "xx bbb ccc"      -- 字符串缩短了 1 位
  第二步替换 edit2 (位置 8): "xx bbb cdd"  -- 错误! 位置偏移了
```

### 2.5 模糊匹配

LLM 有时会引入 Unicode 差异: 智能引号 (`""`) 代替 ASCII 引号 (`""`)、em-dash 代替 hyphen 等。模糊匹配作为后备:

```
精确匹配流程:
  content.indexOf(oldText) -> 找到? 返回
                           -> 没找到? 尝试模糊匹配

模糊匹配:
  1. 对 content 和 oldText 都做 NFKC 规范化
  2. 去除每行尾部空白
  3. 智能引号 -> ASCII 引号
  4. Unicode 破折号 -> ASCII hyphen
  5. 特殊空格 -> 普通空格
  6. 再做 indexOf
```

当任何一个 edit 触发了模糊匹配时，整个文件内容都切换到模糊规范化空间进行处理，保持一致性。

### 2.6 错误处理

Edit 工具有精确的错误分类:

```
空 oldText:
  "oldText must not be empty in {path}"

找不到 (0 次匹配):
  "Could not find the exact text in {path}. The old text must match
   exactly including all whitespace and newlines."

不唯一 (>1 次匹配):
  "Found {n} occurrences of the text in {path}. The text must be unique.
   Please provide more context to make it unique."

重叠:
  "edits[i] and edits[j] overlap in {path}. Merge them into one edit
   or target disjoint regions."

无变化:
  "No changes made to {path}. The replacement produced identical content."
```

这些错误消息直接返回给 LLM，引导它修正下一次调用。措辞是刻意设计的: 告诉模型 **该怎么修** (提供更多上下文、合并编辑等)。

---

## 3. `prepareArguments` -- 兼容性适配

不同 LLM 返回工具参数的格式不一致。`prepareArguments` 在 schema 校验之前运行，把各种怪异格式统一:

### 3.1 JSON 字符串解析

某些模型 (如 GLM) 把 `edits` 数组序列化成 JSON 字符串而不是原生数组:

```typescript
// 模型返回: { path: "foo.ts", edits: '[{"oldText":"a","newText":"b"}]' }
// 需要转成: { path: "foo.ts", edits: [{ oldText: "a", newText: "b" }] }

if (typeof args.edits === "string") {
  try {
    const parsed = JSON.parse(args.edits);
    if (Array.isArray(parsed)) args.edits = parsed;
  } catch {}
}
```

### 3.2 旧版单编辑格式

早期版本的 Edit 工具只支持单个替换，参数是顶层的 `oldText`/`newText`:

```typescript
// 旧格式: { path: "foo.ts", oldText: "a", newText: "b" }
// 转为:   { path: "foo.ts", edits: [{ oldText: "a", newText: "b" }] }

if (typeof legacy.oldText === "string" && typeof legacy.newText === "string") {
  const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
  edits.push({ oldText: legacy.oldText, newText: legacy.newText });
  const { oldText, newText, ...rest } = legacy;
  return { ...rest, edits };
}
```

注意它不是简单替换，而是 **追加**: 如果同时存在 `edits[]` 和顶层 `oldText`/`newText`，把顶层的追加到数组末尾。这确保两种格式混用时不丢数据。

---

## 4. FileMutationQueue -- 序列化并发写操作

### 4.1 问题: 并行工具调用的竞态条件

Agent 通常并行执行多个工具调用以提高效率。但如果两个 edit 调用同时修改同一个文件:

```
时间线:
  T1: edit-A 读取 file.ts (版本 1)
  T2: edit-B 读取 file.ts (版本 1)
  T3: edit-A 写入 file.ts (版本 2 = 版本 1 + 编辑 A)
  T4: edit-B 写入 file.ts (版本 3 = 版本 1 + 编辑 B)  -- 编辑 A 丢失!
```

经典的 lost update 问题。解决方案是 **对同一文件的操作串行化**，不同文件的操作仍然并行。

### 4.2 Promise 链式序列化

FileMutationQueue 的实现极其精简 -- 只有 20 多行，但设计巧妙:

```typescript
const fileMutationQueues = new Map<string, Promise<void>>();

async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = getMutationQueueKey(filePath);

  // 获取当前队列尾部 (如果没有，用已完成的 Promise)
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

  // 创建新的 Promise 作为新的队列尾部
  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });

  // 链接: 当前队列完成 -> nextQueue 完成 -> 整个链完成
  const chainedQueue = currentQueue.then(() => nextQueue);
  fileMutationQueues.set(key, chainedQueue);

  // 等待前面的操作完成
  await currentQueue;
  try {
    return await fn();
  } finally {
    // 释放下一个等待者
    releaseNext();
    // 如果我们是队列末尾，清理 Map 条目
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
```

### 4.3 运行时序图

假设 edit-A 和 edit-B 同时对 `file.ts` 调用 `withFileMutationQueue`:

```
edit-A 调用:
  1. currentQueue = Promise.resolve()     (队列为空)
  2. 创建 nextQueueA, releaseA
  3. chainedQueueA = resolved.then(() => nextQueueA)
  4. Map.set("file.ts", chainedQueueA)
  5. await currentQueue                    (立即完成)
  6. 执行 fn()...                          (正在工作)

edit-B 调用 (在 edit-A 的 fn() 执行期间):
  1. currentQueue = chainedQueueA          (A 正在工作)
  2. 创建 nextQueueB, releaseB
  3. chainedQueueB = chainedQueueA.then(() => nextQueueB)
  4. Map.set("file.ts", chainedQueueB)
  5. await currentQueue                    (阻塞! 等待 A 完成)

edit-A 完成:
  7. releaseA()                            (nextQueueA 完成)
  8. chainedQueueA 完成
  -> edit-B 的 await currentQueue 解除阻塞
  -> edit-B 开始执行 fn()

edit-B 完成:
  7. releaseB()
  8. chainedQueueB 完成
  9. Map 中 key 仍指向 chainedQueueB -> delete
```

### 4.4 队列键: 路径规范化

同一个文件可能通过不同路径引用 (`./src/app.ts` vs `/home/user/project/src/app.ts` vs 符号链接)。必须规范化:

```typescript
function getMutationQueueKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    // realpathSync 解析符号链接，得到真实路径
    return realpathSync.native(resolvedPath);
  } catch {
    // 文件不存在时 (write 创建新文件) 用 resolved path
    return resolvedPath;
  }
}
```

`realpathSync.native` 比 `realpathSync` 更快 (直接调用 OS 系统调用，不经过 JS 规范化)。对于新文件 (还不存在)，退回到 `resolve()` 的结果。

---

## 5. Diff 计算: 生成 unified diff

Edit 工具执行完替换后，需要生成 diff 供 UI 展示变更内容。

### 5.1 使用 `diff` 库

```typescript
import * as Diff from "diff";

const parts = Diff.diffLines(oldContent, newContent);
```

`Diff.diffLines()` 返回一个 `Change[]` 数组:

- `{ value: string, added: true }` -- 新增行
- `{ value: string, removed: true }` -- 删除行
- `{ value: string }` (无 added/removed) -- 不变的上下文行

### 5.2 自定义 diff 格式

Pi 不使用标准 unified diff 格式，而是生成一种更适合终端展示的格式:

```
 12 const x = 1;
-13 const y = 2;
+13 const y = 42;
 14 const z = 3;
```

特点:

- 行号右对齐，宽度动态计算
- `+` 表示新增行 (带新文件行号)
- `-` 表示删除行 (带旧文件行号)
- ` ` 表示上下文行
- 上下文行默认 4 行，超出用 `...` 省略

### 5.3 生成逻辑伪代码

```
function generateDiffString(oldContent, newContent, contextLines = 4):
  parts = Diff.diffLines(oldContent, newContent)
  output = []
  oldLineNum = 1, newLineNum = 1
  firstChangedLine = undefined

  for each part in parts:
    lines = part.value.split("\n")  // 去除末尾空串
    if lines.last == "": lines.pop()

    if part.added or part.removed:
      if firstChangedLine is undefined:
        firstChangedLine = newLineNum
      for each line:
        if part.added:
          output.push("+{newLineNum} {line}")
          newLineNum++
        else:
          output.push("-{oldLineNum} {line}")
          oldLineNum++

    else:  // 上下文行
      // 根据前后是否有变更，决定显示多少上下文
      // 前后都有变更: 如果总行数 <= 2*contextLines，全部显示
      //               否则显示前 contextLines + ... + 后 contextLines
      // 只有前面有变更: 显示前 contextLines 行
      // 只有后面有变更: 显示后 contextLines 行
      // 前后都没变更: 完全省略

  return { diff: output.join("\n"), firstChangedLine }
```

`firstChangedLine` 用于编辑器导航 -- UI 可以直接跳转到变更位置。

---

## 6. Write 工具

Write 工具比 Edit 简单得多，职责是创建新文件或完整覆写现有文件。

### 6.1 执行流程

```
resolveToCwd(path, cwd)        -- 路径解析
    |
    v
withFileMutationQueue()         -- 序列化
    |
    v
mkdir(dirname, { recursive })   -- 自动创建父目录
    |
    v
writeFile(path, content, utf-8) -- 写入内容
    |
    v
返回 "Successfully wrote {N} bytes to {path}"
```

### 6.2 自动创建父目录

```typescript
const dir = dirname(absolutePath);
await ops.mkdir(dir); // 等价于 mkdir -p
```

`{ recursive: true }` 意味着:

- 如果目录已存在，不报错
- 如果中间目录缺失，递归创建所有层级
- 使用 Write 工具时不需要先 mkdir

### 6.3 路径安全: `resolveToCwd`

Edit 和 Write 都使用 `resolveToCwd()` 将用户提供的路径解析为绝对路径:

```typescript
// 伪代码
function resolveToCwd(path: string, cwd: string): string {
  if (isAbsolute(path)) return normalize(path);
  return resolve(cwd, path);
}
```

这确保相对路径相对于项目根目录解析，而不是 Node.js 进程的当前工作目录。

### 6.4 返回字节数

```typescript
resolve({
  content: [
    {
      type: "text",
      text: `Successfully wrote ${content.length} bytes to ${path}`,
    },
  ],
  details: undefined,
});
```

返回字节数而不仅仅是 "success" 有两个好处:

1. LLM 可以验证写入的内容大小是否合理
2. 如果写入了空文件 (0 bytes)，这个数字会引起 LLM 的注意

### 6.5 Edit vs Write 的使用场景

| 场景             | 工具  | 原因                              |
| ---------------- | ----- | --------------------------------- |
| 修改文件的几行   | Edit  | 精确替换，不需要重写整个文件      |
| 创建新文件       | Write | 文件不存在，没有 oldText 可以匹配 |
| 完整重写小文件   | Write | 改动太大，用 edit 反而更复杂      |
| 修改大文件的局部 | Edit  | 只传输变更的部分，节省 token      |

Prompt guidelines 明确告诉 LLM: "Use write only for new files or complete rewrites."

---

## 7. 可插拔操作接口

Edit 和 Write 都支持通过 Operations 接口替换底层 IO 操作:

```typescript
// Edit 的可插拔接口
interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

// Write 的可插拔接口
interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}
```

默认实现使用 Node.js `fs/promises`。通过替换这些接口，可以让工具操作远程文件系统 (如 SSH、Docker 容器、云 VM)，而不需要修改任何工具逻辑。

---

## 8. AbortSignal 处理

Edit 和 Write 的执行函数都接收 `AbortSignal`，在多个阶段检查取消状态:

```
执行前检查 -> signal.aborted? 立即 reject

注册 abort 监听器 -> 设置 aborted = true, reject

每个 IO 操作后检查 -> if (aborted) return

完成后清理 -> signal.removeEventListener

出错时清理 -> signal.removeEventListener, if (!aborted) reject
```

关键细节:

- 在 `writeFile` 之前检查，避免写入已取消的操作的结果
- 在 `writeFile` 之后检查，因为写入可能在 abort 和 await 之间完成
- `finally` 中不一定抛出，因为 abort handler 可能已经 reject 过了

---

## 9. 完整伪代码

### 9.1 Edit 工具 `execute()`

```
function execute(toolCallId, input, signal):
  { path, edits } = validateEditInput(input)
  absolutePath = resolveToCwd(path, cwd)

  return withFileMutationQueue(absolutePath, async () => {
    if signal.aborted: throw "aborted"

    // 读取
    await access(absolutePath, R_OK | W_OK)
    buffer = await readFile(absolutePath)
    rawContent = buffer.toString("utf-8")

    // 规范化
    { bom, text } = stripBom(rawContent)
    originalEnding = detectLineEnding(text)
    normalizedContent = normalizeToLF(text)

    // 应用编辑
    { baseContent, newContent } = applyEditsToNormalizedContent(
      normalizedContent, edits, path
    )

    // 写回
    finalContent = bom + restoreLineEndings(newContent, originalEnding)
    await writeFile(absolutePath, finalContent)

    // 生成 diff
    diffResult = generateDiffString(baseContent, newContent)
    return {
      content: [{ type: "text", text: "Successfully replaced N block(s)" }],
      details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine }
    }
  })
```

### 9.2 `applyEditsToNormalizedContent()`

```
function applyEditsToNormalizedContent(content, edits, path):
  // 1. 规范化每个 edit
  normalizedEdits = edits.map(e => ({
    oldText: normalizeToLF(e.oldText),
    newText: normalizeToLF(e.newText)
  }))

  // 2. 空 oldText 检查
  for each edit at index i:
    if edit.oldText.length == 0: throw error

  // 3. 初始探测: 是否需要模糊匹配
  initialMatches = normalizedEdits.map(e => fuzzyFindText(content, e.oldText))
  baseContent = any match is fuzzy ?
    normalizeForFuzzyMatch(content) : content

  // 4. 在 baseContent 上查找所有 edit
  matchedEdits = []
  for each edit at index i:
    match = fuzzyFindText(baseContent, edit.oldText)
    if not match.found: throw "not found" error
    occurrences = countOccurrences(baseContent, edit.oldText)
    if occurrences > 1: throw "duplicate" error
    matchedEdits.push({ editIndex: i, matchIndex, matchLength, newText })

  // 5. 排序并检查重叠
  sort matchedEdits by matchIndex ascending
  for each adjacent pair:
    if prev.matchIndex + prev.matchLength > curr.matchIndex:
      throw "overlap" error

  // 6. 逆序应用
  newContent = baseContent
  for i from matchedEdits.length-1 down to 0:
    edit = matchedEdits[i]
    newContent = newContent[0..edit.matchIndex]
      + edit.newText
      + newContent[edit.matchIndex + edit.matchLength..]

  // 7. 检查是否有变化
  if baseContent == newContent: throw "no change" error

  return { baseContent, newContent }
```

### 9.3 Write 工具 `execute()`

```
function execute(toolCallId, { path, content }, signal):
  absolutePath = resolveToCwd(path, cwd)
  dir = dirname(absolutePath)

  return withFileMutationQueue(absolutePath, async () => {
    if signal.aborted: throw "aborted"

    await mkdir(dir, { recursive: true })
    await writeFile(absolutePath, content, "utf-8")

    return {
      content: [{ type: "text", text: "Successfully wrote N bytes to {path}" }],
      details: undefined
    }
  })
```

### 9.4 `withFileMutationQueue()`

```
queues = Map<string, Promise<void>>()

function withFileMutationQueue(filePath, fn):
  key = realpathSync(resolve(filePath)) ?? resolve(filePath)

  currentQueue = queues.get(key) ?? Promise.resolve()

  // 创建新的 Promise 和它的 resolve 函数
  let releaseNext
  nextQueue = new Promise(resolve => { releaseNext = resolve })

  // 链接到队列尾部
  chainedQueue = currentQueue.then(() => nextQueue)
  queues.set(key, chainedQueue)

  // 等待轮到自己
  await currentQueue
  try:
    return await fn()
  finally:
    releaseNext()  // 让下一个等待者开始
    if queues.get(key) === chainedQueue:
      queues.delete(key)  // 清理 (自己是最后一个)
```

---

## 10. 关键设计总结

| 设计决策                          | 理由                                     |
| --------------------------------- | ---------------------------------------- |
| 精确文本替换而非 diff/patch       | LLM 生成 diff 不可靠，精确匹配确定性更高 |
| 所有 edit 基于原文匹配            | 避免级联偏移错误，每个 edit 独立         |
| 逆序应用替换                      | 保持前面 edit 的偏移量不变               |
| 唯一性检查                        | 歧义匹配会导致修改错误位置               |
| 重叠检测                          | 重叠 edit 语义不明确，强制合并           |
| FileMutationQueue 基于 Promise 链 | 极简实现，无锁，利用 JS 单线程事件循环   |
| BOM 剥离                          | LLM 不会生成 BOM，不剥离则匹配失败       |
| CRLF 规范化                       | LLM 只生成 LF，必须统一                  |
| 模糊匹配作为后备                  | 处理 LLM 引入的 Unicode 微差异           |
| `prepareArguments` 兼容层         | 适配不同模型的参数格式差异               |
| Write 自动 mkdir -p               | 消除"目录不存在"的常见错误               |
| 可插拔 Operations 接口            | 支持远程文件系统而不修改工具逻辑         |

---

## 练习

1. **运行 demo**: 执行 `code/src/demo.ts`，观察 edit 和 write 的执行输出
2. **触发错误**: 修改 demo 中的 `oldText` 使其不匹配，观察错误消息
3. **并发测试**: 创建两个并行的 edit 操作指向同一文件，验证 FileMutationQueue 的串行化
4. **扩展练习**: 给 Edit 工具添加 `replaceAll` 选项，跳过唯一性检查并替换所有匹配
