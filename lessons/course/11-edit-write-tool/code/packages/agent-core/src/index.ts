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
// Lesson 04 types: tool lifecycle hooks (from pi-agent-core, re-exported)
// ---------------------------------------------------------------------------
export type {
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  ToolExecutionMode,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
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

// ---------------------------------------------------------------------------
// Lesson 06: Tool Execution Engine
// ---------------------------------------------------------------------------
export { runToolExecutionLoop } from "./agent-loop.js";
export {
  executeToolCalls,
  prepareToolCall,
  executePreparedToolCall,
  finalizeExecutedToolCall,
  shouldTerminateToolBatch,
  executeToolCallsSequential,
  executeToolCallsParallel,
} from "./tool-executor.js";
export type {
  PreparedToolCall,
  ImmediateToolCallOutcome,
  ExecutedToolCallOutcome,
  FinalizedToolCallOutcome,
  FinalizedToolCallEntry,
  ExecutedToolCallBatch,
} from "./tool-executor-types.js";

// ---------------------------------------------------------------------------
// Lesson 07: Steering and Follow-up Queues
// ---------------------------------------------------------------------------
export {
  runAgentLoop as runAgentLoopFull,
  runAgentLoopContinue,
} from "./agent-loop-full.js";
export { PendingMessageQueue } from "./pending-queue.js";
export type { QueueMode } from "./pending-queue.js";
export type {
  AgentFullLoopConfig,
  ShouldStopAfterTurnContext,
} from "./types.js";

// ---------------------------------------------------------------------------
// Lesson 08: Testing -- Mock Provider & Test Utilities
// ---------------------------------------------------------------------------
export {
  MockProvider,
  mockTextResponse,
  mockToolCallResponse,
  mockMultiToolCallResponse,
  mockErrorResponse,
} from "./testing/mock-provider.js";
export {
  createTestAgent,
  collectEvents,
  eventTypes,
  messagesByRole,
  createTool,
  createStaticTool,
  createFailingTool,
} from "./testing/test-utils.js";
