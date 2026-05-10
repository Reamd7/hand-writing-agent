# 第十三课: Session 持久化与分支

## 概述

前面的课程中, 我们的 Agent 运行一次就结束了 -- 消息列表只存在于内存中。关闭程序, 对话历史就消失了。

一个生产级 Agent 需要 **session 持久化**:

- **恢复对话**: 关闭终端后重新打开, 从上次离开的地方继续
- **历史回顾**: 浏览过去的对话, 搜索之前讨论的内容
- **分支探索**: 回到某个节点, 尝试不同的提问方向, 不丢失原来的路径

本课将:

1. 分析 JSONL 存储格式: 为什么 append-only 是最佳选择
2. 实现树形结构: 用 `id` + `parentId` 支持任意分支
3. 构建完整的 `SessionManager`: 创建、打开、追加、分支、重建上下文
4. 编写 demo 验证持久化、重载、分支操作

---

## 1. 为什么需要 Session 持久化

### 1.1 没有持久化的痛点

```
用户: 帮我重构 auth 模块
助手: 好的, 我来分析代码结构... (做了大量工作)
用户: (不小心关闭终端)
用户: (重新打开) 继续刚才的重构
助手: 我不知道你在说什么, 请重新描述你的需求。
```

所有的上下文 -- Agent 做了什么修改、分析了哪些文件、用户确认了哪些决策 -- 全部丢失。

### 1.2 持久化解决了什么

| 需求     | 解决方案                           |
| -------- | ---------------------------------- |
| 恢复对话 | 从文件重新加载消息列表, 续接对话   |
| 历史搜索 | 扫描所有 session 文件, 全文搜索    |
| 分支探索 | 树形结构, 从任意节点 fork 出新分支 |
| 崩溃恢复 | Append-only 格式, 最多丢失最后一行 |
| 多项目   | 按 cwd 目录分组存储                |

### 1.3 存储格式选择

常见选择:

| 格式      | 优点                              | 缺点                                   |
| --------- | --------------------------------- | -------------------------------------- |
| SQLite    | 查询灵活, 事务安全                | 需要额外依赖, schema 迁移复杂          |
| JSON 文件 | 简单                              | 每次写入必须重写整个文件, 大文件性能差 |
| **JSONL** | **Append-only, 崩溃安全, 无依赖** | 查询需要全文扫描                       |

Pi 选择 **JSONL** (JSON Lines) -- 每行一个 JSON 对象, 追加写入。对于对话历史这种顺序写入、偶尔全量读取的场景, JSONL 是最优解。

---

## 2. JSONL 存储格式

### 2.1 JSONL 规范

JSONL (JSON Lines, https://jsonlines.org/) 的规则非常简单:

- 每行是一个合法的 JSON 值
- 行与行之间用 `\n` 分隔
- UTF-8 编码
- 没有外层的 `[]` 或 `{}`

一个 session 文件的内容:

```jsonl
{"type":"session","version":1,"id":"019726ab-...","timestamp":"2025-01-15T10:30:00.000Z","cwd":"/home/user/project"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2025-01-15T10:30:01.000Z","message":{"role":"user","content":"What is TypeScript?"}}
{"type":"message","id":"e5f6a7b8","parentId":"a1b2c3d4","timestamp":"2025-01-15T10:30:02.000Z","message":{"role":"assistant","content":"TypeScript is a typed superset of JavaScript."}}
{"type":"message","id":"c9d0e1f2","parentId":"e5f6a7b8","timestamp":"2025-01-15T10:30:05.000Z","message":{"role":"user","content":"How do I use generics?"}}
```

### 2.2 为什么 Append-Only 是关键

**写入性能**: 追加一行 = 一次 `appendFileSync` 调用。不需要读取-修改-写回整个文件。

**崩溃安全**: 如果程序在写入过程中崩溃, 最多损坏最后一行。前面所有行都完好无损。下次加载时跳过解析失败的行即可:

```typescript
for (const line of content.trim().split("\n")) {
  if (!line.trim()) continue;
  try {
    entries.push(JSON.parse(line));
  } catch {
    // 跳过损坏的行 -- 最多丢失最后一条消息
  }
}
```

**无锁**: 文件只追加不修改, 不需要文件锁。多个读者可以同时读取。

### 2.3 文件结构

每个 session 文件的第一行是 **header**:

```typescript
interface SessionHeader {
  type: "session";
  version: number; // 格式版本, 用于迁移
  id: string; // UUIDv7, 时间排序
  timestamp: string; // ISO 8601
  cwd: string; // 会话的工作目录
  parentSession?: string; // fork 来源
}
```

后续每一行是一个 **entry**, 所有 entry 共享基础字段:

```typescript
interface SessionEntryBase {
  type: string;
  id: string; // 8 字符 hex, 碰撞检测
  parentId: string | null; // 父节点 id, null 表示根
  timestamp: string;
}
```

---

## 3. 树形结构: id + parentId

### 3.1 为什么不用线性列表

线性列表 (entries 按顺序排列) 无法表达分支:

```
用户问了 A, 助手回答了 B
用户想回到 A, 换个方向问 C
```

如果只是数组, "回到 A 问 C" 意味着要删除 B 然后追加 C。但我们不想丢失 B -- 也许用户之后想回来看。

### 3.2 树形结构

每个 entry 有:

- `id`: 唯一标识 (8 字符 hex, 从 `randomUUID()` 截取, 碰撞检测)
- `parentId`: 父 entry 的 id, `null` 表示根节点

```
              [a1b2] user: "What is TS?"
                |
              [e5f6] assistant: "TS is..."
              /           \
    [c9d0] user:        [f3a4] user:
    "Generics?"         "Interfaces?"
        |                   |
    [b7c8] assistant:   [d5e6] assistant:
    "Generics let..."   "Interfaces define..."
```

**分支 = 一个 entry 有多个子节点。**

"当前会话" = 从根到某个叶子的路径。不同的叶子 = 不同的分支。

### 3.3 Leaf 指针

`SessionManager` 维护一个 `leafId` -- 当前位置的指针。

- **追加消息**: 新 entry 的 `parentId` = 当前 `leafId`, 然后 `leafId` 移动到新 entry
- **分支**: `branch(id)` 把 `leafId` 移回某个旧 entry。下一次追加就在那里 fork
- **重置**: `resetLeaf()` 把 `leafId` 设为 null, 下一次追加创建新的根节点

```typescript
// 线性追加
sm.appendMessage({ role: "user", content: "A" }); // leaf -> A
sm.appendMessage({ role: "assistant", content: "B" }); // leaf -> B

// 分支: 回到 A, 走不同方向
sm.branch(idOfA); // leaf -> A
sm.appendMessage({ role: "user", content: "C" }); // leaf -> C (fork!)
```

### 3.4 从 leaf 到 root 的遍历

要构建 LLM 上下文, 需要沿着 `parentId` 链从 leaf 走到 root, 然后翻转:

```typescript
getBranch(fromId?: string): SessionEntry[] {
  const path: SessionEntry[] = [];
  let current = fromId ? this.byId.get(fromId) : this.getLeafEntry();

  while (current) {
    path.unshift(current);  // 头部插入 -> 最终是 root-to-leaf 顺序
    current = current.parentId ? this.byId.get(current.parentId) : undefined;
  }
  return path;
}
```

时间复杂度: O(depth), 即当前分支的深度, 而不是整棵树的大小。

---

## 4. Entry 类型

### 4.1 message

最核心的类型 -- 用户或助手的消息:

```typescript
interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: {
    role: "user" | "assistant";
    content: string;
  };
}
```

### 4.2 model_change

记录模型切换 (用户中途换模型):

```typescript
interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}
```

`buildSessionContext()` 遍历路径时收集最新的 `model_change`, 返回给调用方知道当前用的是哪个模型。

### 4.3 compaction

当对话过长, 需要压缩上下文 (summarization) 时记录:

```typescript
interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string; // 压缩后的摘要
  firstKeptEntryId: string; // 摘要之后保留的第一条消息
  tokensBefore: number; // 压缩前的 token 数
}
```

`buildSessionContext()` 碰到 compaction 时的处理逻辑:

1. 先输出 summary (作为上下文的开头)
2. 输出从 `firstKeptEntryId` 到 compaction 之间的保留消息
3. 输出 compaction 之后的消息

这样 LLM 看到的是: "之前的对话摘要 + 最近的完整消息"。

### 4.4 label

用户定义的书签, 标记在某个 entry 上:

```typescript
interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string; // 被标记的 entry id
  label: string | undefined; // undefined 表示清除标记
}
```

Label 是 append-only 的: 设置 label 追加一条 `label` entry, 清除 label 追加一条 `label: undefined` entry。`SessionManager` 内部维护 `labelsById: Map<string, string>` 做 last-write-wins 解析。

### 4.5 custom

扩展机制 -- 插件可以存储自定义数据:

```typescript
interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string; // 插件标识符
  data?: unknown; // 任意数据
}
```

`custom` entry 不参与 LLM 上下文 (`buildSessionContext()` 会忽略它)。插件在 session 重载时扫描 `customType` 重建自己的状态。

---

## 5. SessionManager API

### 5.1 创建与打开

```typescript
class SessionManager {
  // 新建持久化 session
  static create(cwd: string, sessionDir: string): SessionManager;

  // 打开已有 session 文件
  static open(filePath: string, sessionDir?: string): SessionManager;

  // 继续最近的 session, 或新建
  static continueRecent(cwd: string, sessionDir: string): SessionManager;

  // 内存中 session (不写文件, 用于测试)
  static inMemory(cwd?: string): SessionManager;

  // 从另一个项目 fork session
  static forkFrom(sourcePath: string, targetCwd: string, sessionDir: string): SessionManager;
}
```

Pi 用 `continueRecent` 实现 "重新打开终端自动续接" -- 扫描目录找最新的 `.jsonl`, 没有就新建。

### 5.2 追加方法

所有追加方法都返回新 entry 的 id, 且自动把 leaf 指针移到新 entry:

```typescript
// 追加消息 (最常用)
appendMessage(message: { role: "user" | "assistant"; content: string }): string;

// 记录模型切换
appendModelChange(provider: string, modelId: string): string;

// 记录上下文压缩
appendCompaction(summary: string, firstKeptEntryId: string, tokensBefore: number): string;

// 自定义 entry (插件用)
appendCustomEntry(customType: string, data?: unknown): string;

// 设置/清除书签
appendLabelChange(targetId: string, label: string | undefined): string;
```

每个方法内部:

1. 生成 8 字符 hex id (碰撞检测)
2. 设置 `parentId = this.leafId`
3. 追加到内存数组 + 写入文件
4. 更新 `leafId` 到新 entry

### 5.3 构建 LLM 上下文

```typescript
buildSessionContext(): SessionContext;
```

返回:

```typescript
interface SessionContext {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model: { provider: string; modelId: string } | null;
}
```

核心逻辑:

1. 从 `leafId` 沿 `parentId` 走到 root, 得到路径
2. 沿路径收集 `model_change` (最后一个生效)
3. 找路径上最后一个 `compaction`
4. 如果有 compaction: 输出 summary + 保留消息 + 后续消息
5. 如果没有: 输出路径上所有 `message` entry

这是 **整个 session 系统的核心** -- 把树形存储转换成 LLM 需要的线性消息列表。

### 5.4 分支操作

```typescript
// 移动 leaf 到旧 entry (下次 append 在那里 fork)
branch(branchFromId: string): void;

// 重置 leaf 到 null (下次 append 创建新根)
resetLeaf(): void;

// 提取一个分支到新 session 文件
forkToNewSession(leafId: string): string | undefined;
```

分支操作 **不修改任何已有 entry**。只是移动指针。这就是 append-only 的魔力 -- 历史不可变, 只能增长。

---

## 6. 完整伪代码

### 6.1 SessionManager 核心结构

```
class SessionManager:
  // 状态
  sessionId: string
  sessionFile: string | undefined
  fileEntries: FileEntry[]      // 内存中的完整 entry 列表
  byId: Map<string, Entry>      // id -> entry 索引
  labelsById: Map<string, string> // targetId -> label 文本
  leafId: string | null         // 当前位置指针

  // 构造 (private)
  constructor(cwd, sessionDir, sessionFile, persist):
    如果 sessionFile 存在:
      从文件加载 entries
      构建 byId 索引
      leafId = 最后一个 entry 的 id
    否则:
      创建 header entry
      leafId = null

  // 追加 entry (private)
  doAppend(entry):
    fileEntries.push(entry)
    byId.set(entry.id, entry)
    leafId = entry.id
    如果 persist: appendFileSync(sessionFile, JSON.stringify(entry) + "\n")

  // 追加消息 (public)
  appendMessage(message):
    entry = {
      type: "message",
      id: generateEntryId(byId),  // 8-char hex, 碰撞检测
      parentId: leafId,            // 挂在当前 leaf 下
      timestamp: now(),
      message
    }
    doAppend(entry)
    return entry.id
```

### 6.2 树遍历: getBranch

```
getBranch(fromId?):
  path = []
  current = fromId ? byId.get(fromId) : byId.get(leafId)

  while current != null:
    path.unshift(current)   // 头插
    current = current.parentId ? byId.get(current.parentId) : null

  return path  // root-to-leaf 顺序
```

### 6.3 构建上下文: buildSessionContext

```
buildSessionContext(entries, leafId):
  // 1. 构建 id 索引
  byId = new Map()
  for entry in entries:
    byId.set(entry.id, entry)

  // 2. 找到 leaf
  leaf = byId.get(leafId) ?? entries[last]

  // 3. 从 leaf 走到 root
  path = []
  current = leaf
  while current:
    path.unshift(current)
    current = byId.get(current.parentId)

  // 4. 收集 model 和 compaction
  model = null
  compaction = null
  for entry in path:
    if entry.type == "model_change":
      model = { provider, modelId }
    if entry.type == "compaction":
      compaction = entry

  // 5. 构建消息列表
  messages = []
  if compaction:
    messages.push({ role: "user", content: "[Summary]\n" + compaction.summary })
    // 保留消息: firstKeptEntryId 到 compaction
    // 后续消息: compaction 之后
    ...
  else:
    for entry in path:
      if entry.type == "message":
        messages.push(entry.message)

  return { messages, model }
```

### 6.4 分支

```
branch(branchFromId):
  assert byId.has(branchFromId)
  leafId = branchFromId
  // 就这么简单 -- 下次 appendMessage() 的 parentId 就是 branchFromId
  // 旧的 entries 完全不受影响

resetLeaf():
  leafId = null
  // 下次 append 的 parentId = null -> 新的根节点
```

### 6.5 JSONL 读写

```
loadEntriesFromFile(filePath):
  content = readFileSync(filePath, "utf8")
  entries = []
  for line in content.split("\n"):
    if line is empty: skip
    try:
      entries.push(JSON.parse(line))
    catch:
      skip  // 崩溃安全: 跳过损坏的行

  // 验证 header
  if entries[0].type != "session": return []
  return entries

appendToFile(filePath, entry):
  appendFileSync(filePath, JSON.stringify(entry) + "\n")
```

### 6.6 构建树: getTree

```
getTree():
  entries = getEntries()  // 排除 header
  nodeMap = new Map()     // id -> TreeNode
  roots = []

  // 创建节点
  for entry in entries:
    nodeMap.set(entry.id, { entry, children: [], label: labelsById.get(entry.id) })

  // 连接父子
  for entry in entries:
    node = nodeMap.get(entry.id)
    if entry.parentId == null:
      roots.push(node)
    else:
      parent = nodeMap.get(entry.parentId)
      if parent:
        parent.children.push(node)
      else:
        roots.push(node)  // 孤儿节点当 root

  // 子节点按时间排序
  for each node (iterative BFS/DFS):
    node.children.sort(by timestamp)

  return roots
```

---

## 7. ID 生成策略

### 7.1 Session ID: UUIDv7

Session ID 使用 UUIDv7 (`uuid` 包的 `v7()` 函数):

```
019726ab-1234-7abc-8def-0123456789ab
^^^^^^^^
时间戳前缀
```

UUIDv7 的前 48 位是毫秒级 Unix 时间戳, 这意味着:

- 按字典序排列 = 按创建时间排列
- 文件名自然排序 = 时间排序
- 不需要额外的排序字段

### 7.2 Entry ID: 8 字符 Hex

Entry ID 从 UUIDv4 截取前 8 个字符:

```typescript
function generateEntryId(existing: { has(id: string): boolean }): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) return id;
  }
  return randomUUID(); // fallback
}
```

为什么不用完整 UUID:

- 8 字符足够 (4 billion 种可能, 一个 session 几千条 entry)
- 文件体积更小 (每行省 28 字节)
- UI 显示更友好

碰撞检测确保同一 session 内不重复。跨 session 重复无所谓 -- id 只在 session 内有意义。

---

## 8. 关键设计决策

### 8.1 Append-Only 不变性

一旦 entry 写入文件, 永不修改。这带来:

- **崩溃安全**: 没有 "写到一半" 的状态
- **并发友好**: 读者不需要锁
- **审计追踪**: 完整的操作历史
- **简单**: 不需要 WAL、事务、回滚

代价是文件只会增长。但对话历史通常不会太大 (几百条消息 = 几百 KB), 这不是问题。

### 8.2 Deferred Flush (延迟写入)

Pi 的实现有一个优化: 在第一条 assistant 消息到来之前, 不写入文件。这避免了用户输入一条消息后立刻关闭 (没有任何回复) 产生的空 session 文件。

我们的教学实现简化了这一点, 在 `create` 时就写入 header。生产环境可以考虑加上延迟写入。

### 8.3 Migration (迁移)

Session 文件格式会演变。Header 中的 `version` 字段用于迁移:

```typescript
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
  const version = header?.version ?? 1;
  if (version < 2) migrateV1ToV2(entries);
  if (version < 3) migrateV2ToV3(entries);
  return true;
}
```

迁移在加载时执行, 然后 rewrite 整个文件。这是唯一会重写文件的场景 (除了 `forkToNewSession`)。

---

## 9. Demo 说明

`code/src/demo.ts` 演示了完整的流程:

1. **创建 session**: `SessionManager.create()` 生成 JSONL 文件
2. **追加消息**: 4 条消息形成线性链
3. **重载**: `SessionManager.open()` 从文件重建状态
4. **分支**: `branch()` 回到第 2 条消息, 追加新消息形成 fork
5. **树可视化**: `getTree()` 展示完整的树结构
6. **上下文构建**: `buildSessionContext()` 分别为两个分支生成消息列表
7. **Model 切换**: `appendModelChange()` + 上下文中的 model 信息
8. **Compaction**: 压缩上下文后重建消息列表
9. **Labels**: 给 entry 添加书签
10. **Fork 到新文件**: `forkToNewSession()` 提取单条路径
11. **列表**: `SessionManager.list()` 扫描目录
12. **内存模式**: `SessionManager.inMemory()` 无文件 I/O
13. **JSONL 验证**: 直接读取文件确认格式

运行:

```bash
cd code
npm install
npx tsx src/demo.ts
```

---

## 10. 与 Pi 源码的对应

| 教学实现                  | Pi 源码                              | 差异                                                                                |
| ------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- |
| `SessionManager.create()` | `SessionManager.create()`            | Pi 使用 `getDefaultSessionDir()` 自动计算目录                                       |
| `appendMessage()`         | `appendMessage()`                    | Pi 接受 `Message \| CustomMessage \| BashExecutionMessage`                          |
| `buildSessionContext()`   | `buildSessionContext()`              | Pi 还处理 `thinkingLevel`, `branch_summary`, `custom_message`                       |
| `branch()`                | `branch()`                           | 完全一致                                                                            |
| `forkToNewSession()`      | `createBranchedSession()`            | Pi 版本还处理 label 迁移                                                            |
| `getTree()`               | `getTree()`                          | Pi 版本还携带 `labelTimestamp`                                                      |
| Entry types: 5 种         | Entry types: 9 种                    | Pi 还有 `thinking_level_change`, `branch_summary`, `custom_message`, `session_info` |
| `loadEntriesFromFile()`   | `loadEntriesFromFile()`              | Pi 版本还做 header 验证和 migration                                                 |
| 无迁移                    | `migrateV1ToV2()`, `migrateV2ToV3()` | 教学版不需要向后兼容                                                                |
| 无 deferred flush         | `_persist()` 延迟到首条 assistant    | 教学版简化为立即写入                                                                |

---

## 小结

本课的核心思想:

1. **JSONL = 最适合对话历史的存储格式**: append-only, 崩溃安全, 零依赖
2. **id + parentId = 树形结构**: 用两个字段实现任意分支, 不需要复杂的数据结构
3. **leaf 指针**: 所有追加操作相对于 leaf, `branch()` 只是移动指针
4. **buildSessionContext() 是核心**: 从树形存储 -> 线性消息列表, 处理 compaction
5. **不变性**: entry 一旦写入永不修改, 所有 "修改" 通过追加新 entry 实现

这套设计在 Pi 中支撑了完整的对话恢复、历史浏览、分支探索和上下文压缩, 同时保持了实现的简洁性。
