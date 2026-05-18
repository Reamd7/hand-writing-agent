// @my-agent/core — Agent 核心运行时
//
// Lesson 02: 核心类型 re-export
// Lesson 03: Provider 管理（OpenCode 风格）

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
// Lesson 03: Provider 管理（OpenCode 风格）
// ---------------------------------------------------------------------------

// Provider system
export {
  type ProviderID,
  type ModelID,
  type ProviderInfo,
  type ModelInfo,
  type ModelCapabilities,
  type ModelCost,
  type ModelLimits,
  type ModelStatus,
  type ProviderApiInfo,
  type ProviderSource,
  type ProviderConfig,
  type ProviderSDK,
  providerID,
  modelID,
  ProviderIDs,
  CATALOG,
  resolveSDK,
  getLanguageModel,
  clearSDKCache,
  ProviderRegistry,
  parseModelKey,
  ProviderNotFoundError,
  ModelNotFoundError,
} from "./provider/index.js";

// Middleware
export { createLoggingMiddleware } from "./middleware.js";
export { createCachingMiddleware } from "./middleware.js";
export { createGuardrailMiddleware, applyMiddleware } from "./middleware.js";

// Stream
export { createStream } from "./create-stream.js";
export type {
  CreateStreamOptions,
  StreamMessage,
  AssistantMessageRecord,
  UserMessage as StreamUserMessage,
  TextContent as StreamTextContent,
  ThinkingContent as StreamThinkingContent,
  ToolCallContent,
} from "./create-stream.js";
