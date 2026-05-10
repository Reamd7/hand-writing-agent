# 第17课：使用 ink 构建交互式聊天 TUI

## 为什么选择 ink

在之前的课程中，我们了解了 pi 使用自定义的 TUI 框架（`@earendil-works/pi-tui`）来渲染终端界面。那套系统提供了差分渲染（differential rendering）和 Kitty 图片协议支持等高级特性，但实现复杂度极高——光 `interactive-mode.ts` 一个文件就超过 5000 行。

对于我们自己的 agent 项目，有一个更实际的选择：**ink**。

### ink 的优势

| 特性     | ink                                              | 自定义 TUI（pi 方案）                           |
| -------- | ------------------------------------------------ | ----------------------------------------------- |
| 开发模型 | React 组件 + JSX，声明式                         | 命令式 Container/Component，手动 addChild/clear |
| 布局     | Flexbox（Yoga 引擎，同 React Native）            | 手动计算宽高和位置                              |
| 状态管理 | useState, useEffect, useReducer                  | 手动跟踪实例变量、Map                           |
| 生态     | ink-text-input, ink-spinner, ink-select-input 等 | 全部自建                                        |
| 学习曲线 | 会 React 就会用                                  | 需要理解底层终端渲染                            |
| 开发速度 | 快                                               | 慢                                              |

### 放弃了什么

- **差分渲染**：ink 每帧全量重绘，不做字符级 diff。对于聊天 UI 这种场景够用，但高频更新场景（如大文件 diff 滚动）性能不如自定义方案。
- **Kitty 图片协议**：ink 不支持终端内联图片。如果需要展示图片，只能降级为文件路径或 ASCII art。
- **精细控制**：自定义 TUI 可以控制每个像素，ink 的 flexbox 有时不够灵活。

### 结论

对于 90% 的 agent 聊天界面场景，ink 是正确的选择。**用 React 的思维写终端 UI，把精力花在 agent 逻辑上。**

---

## ink 核心 API

### `render(element)`

入口函数。类似 `ReactDOM.createRoot().render()`，但渲染目标是终端。

```tsx
import { render } from "ink";
import { App } from "./components/App.js";

render(<App />);
```

### `<Box>` -- 布局容器

ink 的 `<div>`。支持 flexbox 属性：

```tsx
<Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
  <Box justifyContent="space-between">
    <Text>Left</Text>
    <Text>Right</Text>
  </Box>
</Box>
```

常用属性：

- `flexDirection`: "row" | "column"
- `justifyContent`: "flex-start" | "center" | "flex-end" | "space-between"
- `alignItems`: "flex-start" | "center" | "flex-end" | "stretch"
- `padding`, `paddingX`, `paddingY`, `margin`, `marginX`, `marginY`
- `width`, `height`, `minWidth`, `minHeight`
- `borderStyle`: "single" | "double" | "round" | "bold" | "classic"
- `borderColor`: 颜色字符串
- `overflow`: "visible" | "hidden"

### `<Text>` -- 文本渲染

ink 的 `<span>`。支持样式属性：

```tsx
<Text color="green" bold>Success</Text>
<Text dimColor>Muted text</Text>
<Text backgroundColor="red" color="white"> ERROR </Text>
```

常用属性：

- `color`: "red" | "green" | "cyan" | "#ff0000" 等
- `bold`, `italic`, `underline`, `strikethrough`, `dimColor`, `inverse`
- `wrap`: "wrap" | "truncate" | "truncate-start" | "truncate-middle"

### `useInput(handler, options?)`

键盘输入钩子。每次按键触发 handler：

```tsx
import { useInput } from "ink";

useInput(
  (input, key) => {
    if (key.return) {
      // Enter 键
    }
    if (input === "q") {
      // q 键
    }
    if (key.ctrl && input === "c") {
      // Ctrl+C
    }
  },
  { isActive: isFocused },
);
```

`key` 对象包含：`return`, `escape`, `ctrl`, `shift`, `tab`, `upArrow`, `downArrow`, `leftArrow`, `rightArrow`, `backspace`, `delete`。

### `useApp()`

获取 app 控制权：

```tsx
import { useApp } from "ink";

const { exit } = useApp();
// 调用 exit() 退出 ink 应用
```

---

## 组件设计

我们的聊天 UI 由以下组件构成：

```
App                          // 顶层容器，管理 agent 状态
  +-- StatusBar              // 模型信息 + 加载动画
  +-- ChatHistory            // 可滚动的消息列表
  |     +-- MessageBubble    // 单条消息（用户/助手）
  |     +-- ToolExecution    // 工具调用展示
  +-- StreamingText          // 流式文本（助手正在生成）
  +-- InputEditor            // 文本输入框
```

这个结构对应 pi 的组件层级，但用 React 声明式地表达：

| pi 组件                     | ink 组件                                           | 说明                     |
| --------------------------- | -------------------------------------------------- | ------------------------ |
| `FooterComponent`           | `StatusBar`                                        | 模型名、token 用量、状态 |
| `chatContainer`             | `ChatHistory`                                      | 消息列表容器             |
| `UserMessageComponent`      | `MessageBubble` (role=user)                        | 用户消息                 |
| `AssistantMessageComponent` | `MessageBubble` (role=assistant) + `StreamingText` | 助手消息                 |
| `ToolExecutionComponent`    | `ToolExecution`                                    | 工具执行状态             |
| `CustomEditor`              | `InputEditor`                                      | 文本输入                 |
| `Loader` (spinner)          | `StatusBar` 中的 `<Spinner />`                     | 加载指示器               |

---

## 连接 Agent 事件到 React 状态

这是本课的核心模式。pi 使用命令式的 `subscribe` + `handleEvent` switch 来更新 UI。在 ink 中，我们用 `useEffect` + `subscribe` 模式把事件映射为 React 状态更新。

### 核心思路

```
Agent 事件流                    React 状态
-----------                    ----------
agent_start              -->   setIsLoading(true)
message_start (user)     -->   setMessages(prev => [...prev, userMsg])
message_start (assistant)-->   setMessages(prev => [...prev, newAssistantMsg])
message_update           -->   setStreamingContent(event.message.content)
                               创建 ToolExecution 组件
tool_execution_start     -->   setToolStates(prev => new Map([...prev, [id, {status:"running"}]]))
tool_execution_update    -->   setToolStates -- 更新 partial result
tool_execution_end       -->   setToolStates -- 标记完成
message_end              -->   setStreamingContent(null), 最终化消息
agent_end                -->   setIsLoading(false)
```

### `useAgent` Hook

自定义 hook 封装了整个订阅逻辑：

```tsx
function useAgent(agent: AgentSession) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [toolStates, setToolStates] = useState<Map<string, ToolState>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const unsubscribe = agent.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          setIsLoading(true);
          break;
        case "message_update":
          // 提取文本内容，更新 streaming 状态
          // 提取 tool calls，更新 tool 状态
          break;
        case "agent_end":
          setIsLoading(false);
          break;
        // ... 其他事件
      }
    });
    return unsubscribe;
  }, [agent]);

  return { messages, streamingContent, toolStates, isLoading };
}
```

对比 pi 的 `handleEvent`（命令式）：

```typescript
// pi: 命令式更新
case "agent_start":
    this.pendingTools.clear();
    this.loadingAnimation = this.createWorkingLoader();
    this.statusContainer.addChild(this.loadingAnimation);
    this.ui.requestRender();  // 手动触发渲染
    break;
```

```tsx
// ink: 声明式更新
case "agent_start":
    setIsLoading(true);  // React 自动重新渲染
    setToolStates(new Map());
    break;
```

React 的优势在于：**状态变化自动触发重渲染，不需要手动管理组件生命周期。**

---

## 事件映射详解

### `agent_start` -> Spinner

当 agent 开始处理时，显示加载动画：

```tsx
// StatusBar.tsx
import Spinner from "ink-spinner";

function StatusBar({ isLoading, modelName }: StatusBarProps) {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text dimColor>Model: {modelName}</Text>
      <Box flexGrow={1} />
      {isLoading && (
        <Text color="cyan">
          <Spinner type="dots" /> Working...
        </Text>
      )}
    </Box>
  );
}
```

### `message_update` -> StreamingText

每次 `message_update` 事件携带完整的 assistant message content。我们提取文本部分并实时显示：

```tsx
function StreamingText({ content }: { content: string }) {
  return (
    <Box paddingLeft={2}>
      <Text color="green">{">"} </Text>
      <Text>{content}</Text>
      <Text dimColor>{"▊"}</Text>
    </Box>
  );
}
```

pi 对应的逻辑在 `handleEvent` 的 `message_update` case 中：

```typescript
case "message_update":
    if (this.streamingComponent && event.message.role === "assistant") {
        this.streamingMessage = event.message;
        this.streamingComponent.updateContent(this.streamingMessage);
        // ...遍历 content 创建 ToolExecutionComponent
    }
    break;
```

### `tool_execution_*` -> ToolExecution 组件

工具执行有三个阶段的事件：

```tsx
function ToolExecution({ name, status, result }: ToolExecutionProps) {
  const statusColor = status === "running" ? "yellow" : status === "done" ? "green" : "red";

  return (
    <Box flexDirection="column" paddingLeft={2} marginY={0}>
      <Text>
        <Text color={statusColor}>
          {status === "running" ? "⟳" : status === "done" ? "✓" : "✗"}
        </Text>{" "}
        <Text bold>{name}</Text>
        {status === "running" && <Text dimColor> running...</Text>}
      </Text>
      {result && (
        <Box paddingLeft={4}>
          <Text dimColor wrap="truncate">
            {result}
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

对应 pi 中的 `ToolExecutionComponent`，它在 `tool_execution_start` 时创建，`tool_execution_update` 时调用 `updateResult(partialResult, true)`，`tool_execution_end` 时调用 `updateResult(result)` 并从 `pendingTools` Map 中移除。

### `agent_end` -> 停止 Spinner

```tsx
case "agent_end":
    setIsLoading(false);
    // React 自动隐藏 Spinner
    break;
```

---

## 用户输入处理

### Enter -> 发送 prompt / steer

```tsx
function InputEditor({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [value, setValue] = useState("");

  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1}>
      <Text color="blue">{"> "}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(text) => {
          if (text.trim()) {
            onSubmit(text);
            setValue("");
          }
        }}
        placeholder="Type a message..."
      />
    </Box>
  );
}
```

当用户按 Enter 时：

1. `onSubmit` 回调触发
2. 调用 `agent.prompt(text)` 发送消息
3. 清空输入框
4. agent 开始处理，事件流驱动 UI 更新

### Ctrl+C -> 中止

```tsx
// App.tsx 中
useInput((input, key) => {
  if (key.ctrl && input === "c") {
    if (isLoading) {
      agent.abort(); // 中止当前 agent 运行
    } else {
      exit(); // 退出应用
    }
  }
});
```

这对应 pi 中复杂的 SIGINT 处理逻辑（双击 Ctrl+C 退出、单击中止等），我们这里简化为：正在加载时中止，空闲时退出。

---

## 各组件的完整伪代码

### App.tsx -- 顶层组件

```tsx
function App({ agent }: { agent: AgentSession }) {
  const { messages, streamingContent, toolStates, isLoading } = useAgent(agent);
  const { exit } = useApp();

  const handleSubmit = useCallback(
    async (text: string) => {
      await agent.prompt(text);
    },
    [agent],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (isLoading) agent.abort();
      else exit();
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <StatusBar modelName={agent.model.id} isLoading={isLoading} />
      <ChatHistory messages={messages} toolStates={toolStates} />
      {streamingContent && <StreamingText content={streamingContent} />}
      <InputEditor onSubmit={handleSubmit} isActive={!isLoading} />
    </Box>
  );
}
```

### ChatHistory.tsx -- 消息历史

```tsx
function ChatHistory({ messages, toolStates }: ChatHistoryProps) {
  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {messages.map((msg, i) => (
        <Box key={i} flexDirection="column">
          <MessageBubble role={msg.role} content={msg.content} />
          {/* 如果是 assistant 消息，渲染关联的工具执行 */}
          {msg.role === "assistant" &&
            msg.toolCalls?.map((tc) => (
              <ToolExecution
                key={tc.id}
                name={tc.name}
                status={toolStates.get(tc.id)?.status ?? "done"}
                result={toolStates.get(tc.id)?.result}
              />
            ))}
        </Box>
      ))}
    </Box>
  );
}
```

### MessageBubble.tsx -- 单条消息

```tsx
function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === "user";
  return (
    <Box paddingX={1} marginY={0} flexDirection="row">
      <Text color={isUser ? "blue" : "green"} bold>
        {isUser ? "You" : "Agent"}
      </Text>
      <Text>{": "}</Text>
      <Text wrap="wrap">{content}</Text>
    </Box>
  );
}
```

### ToolExecution.tsx -- 工具执行

```tsx
function ToolExecution({ name, status, result }: ToolExecutionProps) {
  const icon = status === "running" ? "⟳" : status === "done" ? "✓" : "✗";
  const color = status === "running" ? "yellow" : status === "done" ? "green" : "red";

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={color}>{icon}</Text> <Text bold>{name}</Text>
        {status === "running" && <Text dimColor> running...</Text>}
      </Text>
      {result && (
        <Box paddingLeft={4}>
          <Text dimColor wrap="truncate">
            {result}
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

### StreamingText.tsx -- 流式文本

```tsx
function StreamingText({ content }: { content: string }) {
  return (
    <Box paddingLeft={1}>
      <Text color="green" bold>
        {"Agent"}
      </Text>
      <Text>{": "}</Text>
      <Text>{content}</Text>
      <Text color="cyan">{"▊"}</Text>
    </Box>
  );
}
```

### InputEditor.tsx -- 输入框

```tsx
function InputEditor({ onSubmit, isActive }: InputEditorProps) {
  const [value, setValue] = useState("");

  return (
    <Box borderStyle="round" borderColor={isActive ? "blue" : "gray"} paddingX={1}>
      <Text color="blue">{"> "}</Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(text) => {
          if (text.trim()) {
            onSubmit(text);
            setValue("");
          }
        }}
        placeholder="Type a message..."
        focus={isActive}
      />
    </Box>
  );
}
```

### StatusBar.tsx -- 状态栏

```tsx
function StatusBar({ modelName, isLoading }: StatusBarProps) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text dimColor>
        Model: <Text bold>{modelName}</Text>
      </Text>
      {isLoading ? (
        <Text color="cyan">
          <Spinner type="dots" /> Working...
        </Text>
      ) : (
        <Text color="green">Ready</Text>
      )}
    </Box>
  );
}
```

---

## 完整数据流回顾

```
用户按 Enter
    |
    v
InputEditor.onSubmit(text)
    |
    v
agent.prompt(text) -----> agent 开始处理
    |                           |
    |                   agent_start 事件
    |                           |
    |                   setIsLoading(true)
    |                   StatusBar 显示 Spinner
    |                           |
    |                   message_start (user) 事件
    |                   setMessages([...prev, userMsg])
    |                   ChatHistory 渲染新的 MessageBubble
    |                           |
    |                   message_start (assistant) 事件
    |                   创建新的 assistant 消息占位
    |                           |
    |                   message_update 事件（多次）
    |                   setStreamingContent(latestText)
    |                   StreamingText 实时更新
    |                           |
    |                   tool_execution_start 事件
    |                   setToolStates -- 新增工具
    |                   ToolExecution 组件出现
    |                           |
    |                   tool_execution_end 事件
    |                   setToolStates -- 标记完成
    |                   ToolExecution 变绿
    |                           |
    |                   message_end 事件
    |                   finalize assistant 消息
    |                   清除 streamingContent
    |                           |
    |                   agent_end 事件
    |                   setIsLoading(false)
    |                   Spinner 消失
    v
用户可以输入下一条消息
```

---

## 动手练习

1. **运行 ink 聊天应用**

   ```bash
   npx tsx src/demo.ts
   ```

   确认终端中渲染出 StatusBar（顶部，显示模型名）、ChatHistory（中间）、InputEditor（底部，带蓝色边框）。检查 StatusBar 是否显示 "Ready" 状态。

2. **发送一条消息并观察事件流**
   在输入框中输入一段文本（如 "list all files in src"），按 Enter 发送。观察：
   - ChatHistory 中出现一条蓝色的 "You" 消息
   - StatusBar 从 "Ready" 变为 Spinner + "Working..."
   - StreamingText 区域出现绿色的 "Agent" 前缀和闪烁光标 `▊`，内容逐步增长
   - 工具调用时出现黄色 `⟳` 图标，完成后变为绿色 `✓`

3. **观察流式输出的实时更新**
   发送一个需要较长回复的 prompt（如 "explain the event-driven architecture pattern in detail"）。在 agent 生成过程中注意观察：
   - StreamingText 组件是否实时更新（每次 `message_update` 事件触发一次 `setStreamingContent`）
   - 生成完成后 StreamingText 消失，最终消息出现在 ChatHistory 中
   - Spinner 停止，StatusBar 恢复 "Ready"

4. **测试 Ctrl+C 中止行为**
   发送一个 prompt，在 agent 正在生成时按 Ctrl+C。验证：
   - agent 调用 `abort()` 中止当前操作
   - Spinner 停止，UI 恢复到可输入状态
   - 在空闲状态（非加载中）按 Ctrl+C 退出整个应用

---

## 小结

1. **ink = React for terminal**。`Box` 是 flexbox 容器，`Text` 是样式文本，`useInput` 处理键盘。
2. **事件驱动 UI**：通过 `useEffect` + `subscribe` 将 agent 事件流映射为 React 状态。状态变化自动触发重渲染。
3. **组件拆分**：App > StatusBar + ChatHistory + StreamingText + InputEditor。每个组件只关心自己的 props。
4. **trade-off 明确**：放弃差分渲染和 Kitty 图片，换取 React 的开发效率和生态。对聊天 UI 来说这是值得的。
5. **学习 pi 的模式**：即使不用 ink，pi 的事件订阅 + switch 分发模式也是构建 agent UI 的标准范式。把它从命令式翻译为声明式，就是 ink 方案的核心。
