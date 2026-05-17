// @my-agent/core — Agent 核心运行时
//
// Lesson 02: 从 pi-agent 导入并 re-export 核心类型
// 后续课程将逐步添加 Agent 类、agent loop 等实现

// ---------------------------------------------------------------------------
// LLM 层类型（from pi-ai）
// ---------------------------------------------------------------------------
export type {
  TextContent,
  ImageContent,
  ThinkingContent,
  ToolCall,
  Usage,
  StopReason,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  Message,
  Tool,
  Context,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";

// Backward-compat alias
export type { AssistantMessageEvent as AssistantStreamEvent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Agent 层类型（from pi-agent-core）
// ---------------------------------------------------------------------------
export type {
  CustomAgentMessages,
  AgentMessage,
  AgentEvent,
  AgentContext,
} from "@earendil-works/pi-agent-core";
