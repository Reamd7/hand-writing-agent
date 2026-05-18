/**
 * Provider Types
 *
 * 品牌类型和接口定义。
 * 借鉴 OpenCode 的 schema.ts + provider.ts 数据模型，简化为学习版。
 *
 * @see https://github.com/anomalyco/opencode — packages/opencode/src/provider/schema.ts
 * @see https://github.com/anomalyco/opencode — packages/opencode/src/provider/provider.ts
 */

// ---------------------------------------------------------------------------
// Branded ID types
// (OpenCode 用 Effect Schema brand，我们用轻量 TS brand)
// ---------------------------------------------------------------------------

/** 品牌化 provider 标识符，如 "anthropic", "openai" */
export type ProviderID = string & { readonly __brand: "ProviderID" };

/** 品牌化 model 标识符，如 "claude-sonnet-4-5", "gpt-4o" */
export type ModelID = string & { readonly __brand: "ModelID" };

export function providerID(id: string): ProviderID {
  return id as ProviderID;
}

export function modelID(id: string): ModelID {
  return id as ModelID;
}

// Well-known provider IDs（对应 OpenCode 的 ProviderID statics）
export const ProviderIDs = {
  anthropic: providerID("anthropic"),
  openai: providerID("openai"),
  google: providerID("google"),
  openaiCompatible: providerID("openai-compatible"),
} as const;

// ---------------------------------------------------------------------------
// Model capabilities / cost / limits
// (简化自 OpenCode 的 ProviderCapabilities / ProviderCost / ProviderLimit)
// ---------------------------------------------------------------------------

export type ModelStatus = "active" | "alpha" | "deprecated";

/** 模型能力 */
export interface ModelCapabilities {
  temperature: boolean;
  reasoning: boolean;
  toolCall: boolean;
  images: boolean;
  streaming: boolean;
}

/** 每百万 token 定价（USD） */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Token 限制 */
export interface ModelLimits {
  context: number;
  output: number;
}

// ---------------------------------------------------------------------------
// Provider API info
// (来自 OpenCode 的 ProviderApiInfo — 用哪个 SDK 包)
// ---------------------------------------------------------------------------

export interface ProviderApiInfo {
  /** 传给 SDK 的 model ID，如 "claude-sonnet-4-5-20250514" */
  id: string;
  /** API base URL（可选，空字符串表示用 SDK 默认值） */
  url: string;
  /** SDK npm 包名，如 "@ai-sdk/anthropic" */
  npm: string;
}

// ---------------------------------------------------------------------------
// Model definition
// (来自 OpenCode 的 Model schema)
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: ModelID;
  providerID: ProviderID;
  api: ProviderApiInfo;
  name: string;
  capabilities: ModelCapabilities;
  cost: ModelCost;
  limit: ModelLimits;
  status: ModelStatus;
  /** Provider-specific options，传给 streamText/generateText */
  options: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Provider definition
// (来自 OpenCode 的 Info schema)
// ---------------------------------------------------------------------------

export type ProviderSource = "builtin" | "env" | "config" | "manual";

export interface ProviderInfo {
  id: ProviderID;
  name: string;
  source: ProviderSource;
  /** 持有 API key 的环境变量名 */
  env: string[];
  /** 解析后的 API key */
  key?: string;
  /** Provider 级别的 SDK 选项 */
  options: Record<string, unknown>;
  /** 该 provider 下的所有模型 */
  models: Record<string, ModelInfo>;
}
