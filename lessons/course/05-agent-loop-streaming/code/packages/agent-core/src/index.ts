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

// ---------------------------------------------------------------------------
// Lesson 04: Agent 状态与事件模型
// ---------------------------------------------------------------------------
export { Agent } from "./agent.js";
export type {
  AgentEvent as LocalAgentEvent,
  AgentStartEvent,
  AgentEndEvent,
  TurnStartEvent,
  TurnEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  MessageEndEvent,
  ToolExecutionStartEvent,
  ToolExecutionUpdateEvent,
  ToolExecutionEndEvent,
  MutableAgentState,
  AgentLoopConfig,
  AgentOptions,
  AgentEventListener,
} from "./types.js";

// ---------------------------------------------------------------------------
// Lesson 05: Agent Loop (streaming pipeline)
// ---------------------------------------------------------------------------
export { runAgentLoop } from "./agent-loop.js";
export { streamAssistantResponse } from "./stream-assistant.js";
export { createContextSnapshot, transformContext, defaultConvertToLlm } from "./context.js";
export type {
  StreamFn,
  StreamResult,
  StreamPart,
  AgentEventSink,
  StreamingLoopConfig,
} from "./loop-types.js";
