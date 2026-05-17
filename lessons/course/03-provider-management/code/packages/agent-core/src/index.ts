// @my-agent/core — Agent 核心运行时
//
// Lesson 02: 核心类型 re-export
// Lesson 03: ModelRegistry + middleware + createStream

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

// ---------------------------------------------------------------------------
// Lesson 03: Provider 管理
// ---------------------------------------------------------------------------
export { ModelRegistry } from "./model-registry.js";
export type { ModelEntry, ModelMeta } from "./model-registry.js";
export { createLoggingMiddleware } from "./middleware.js";
export { createStream } from "./create-stream.js";
export type {
  CreateStreamOptions,
  AssistantMessageRecord,
  Message as StreamMessage,
} from "./create-stream.js";
