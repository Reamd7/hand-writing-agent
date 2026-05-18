/**
 * Provider Catalog
 *
 * 内置模型目录 — 已知 provider 和 model 的静态元数据。
 * OpenCode 从 models.dev 服务运行时拉取；我们硬编码一个精简子集。
 *
 * @see https://github.com/anomalyco/opencode — provider.ts fromModelsDevProvider()
 */

import type { ModelInfo, ProviderInfo } from "./types.js";
import { modelID, ProviderIDs } from "./types.js";
import type { ProviderID } from "./types.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function model(
  provider: ProviderID,
  id: string,
  opts: {
    name: string;
    npm: string;
    apiId?: string;
    url?: string;
    context: number;
    output: number;
    inputCost: number;
    outputCost: number;
    capabilities?: Partial<ModelInfo["capabilities"]>;
    status?: ModelInfo["status"];
  },
): ModelInfo {
  return {
    id: modelID(id),
    providerID: provider,
    api: {
      id: opts.apiId ?? id,
      url: opts.url ?? "",
      npm: opts.npm,
    },
    name: opts.name,
    capabilities: {
      temperature: true,
      reasoning: false,
      toolCall: true,
      images: false,
      streaming: true,
      ...opts.capabilities,
    },
    cost: { input: opts.inputCost, output: opts.outputCost },
    limit: { context: opts.context, output: opts.output },
    status: opts.status ?? "active",
    options: {},
  };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const anthropicModels: Record<string, ModelInfo> = {
  "claude-sonnet-4-5": model(ProviderIDs.anthropic, "claude-sonnet-4-5", {
    name: "Claude Sonnet 4.5",
    npm: "@ai-sdk/anthropic",
    apiId: "claude-sonnet-4-5-20250514",
    context: 200_000,
    output: 16_384,
    inputCost: 3,
    outputCost: 15,
    capabilities: { reasoning: true, images: true },
  }),
  "claude-haiku-3-5": model(ProviderIDs.anthropic, "claude-haiku-3-5", {
    name: "Claude 3.5 Haiku",
    npm: "@ai-sdk/anthropic",
    apiId: "claude-3-5-haiku-20241022",
    context: 200_000,
    output: 8_192,
    inputCost: 0.8,
    outputCost: 4,
    capabilities: { images: true },
  }),
};

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

const openaiModels: Record<string, ModelInfo> = {
  "gpt-4o": model(ProviderIDs.openai, "gpt-4o", {
    name: "GPT-4o",
    npm: "@ai-sdk/openai",
    context: 128_000,
    output: 16_384,
    inputCost: 2.5,
    outputCost: 10,
    capabilities: { images: true },
  }),
  "gpt-4o-mini": model(ProviderIDs.openai, "gpt-4o-mini", {
    name: "GPT-4o Mini",
    npm: "@ai-sdk/openai",
    context: 128_000,
    output: 16_384,
    inputCost: 0.15,
    outputCost: 0.6,
    capabilities: { images: true },
  }),
  "o3-mini": model(ProviderIDs.openai, "o3-mini", {
    name: "o3-mini",
    npm: "@ai-sdk/openai",
    context: 200_000,
    output: 100_000,
    inputCost: 1.1,
    outputCost: 4.4,
    capabilities: { reasoning: true, temperature: false },
  }),
};

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

const googleModels: Record<string, ModelInfo> = {
  "gemini-2.5-pro": model(ProviderIDs.google, "gemini-2.5-pro", {
    name: "Gemini 2.5 Pro",
    npm: "@ai-sdk/google",
    apiId: "gemini-2.5-pro-preview-05-06",
    context: 1_048_576,
    output: 65_536,
    inputCost: 1.25,
    outputCost: 10,
    capabilities: { reasoning: true, images: true },
  }),
  "gemini-2.5-flash": model(ProviderIDs.google, "gemini-2.5-flash", {
    name: "Gemini 2.5 Flash",
    npm: "@ai-sdk/google",
    apiId: "gemini-2.5-flash-preview-04-17",
    context: 1_048_576,
    output: 65_536,
    inputCost: 0.15,
    outputCost: 0.6,
    capabilities: { reasoning: true, images: true },
  }),
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * 内置 provider 目录。
 *
 * 对应 OpenCode 的 fromModelsDevProvider() 输出 —
 * Record<ProviderID, ProviderInfo>，包含所有已知 provider 及其 model。
 */
export const CATALOG: Record<string, ProviderInfo> = {
  [ProviderIDs.anthropic]: {
    id: ProviderIDs.anthropic,
    name: "Anthropic",
    source: "builtin",
    env: ["ANTHROPIC_API_KEY"],
    options: {},
    models: anthropicModels,
  },
  [ProviderIDs.openai]: {
    id: ProviderIDs.openai,
    name: "OpenAI",
    source: "builtin",
    env: ["OPENAI_API_KEY"],
    options: {},
    models: openaiModels,
  },
  [ProviderIDs.google]: {
    id: ProviderIDs.google,
    name: "Google",
    source: "builtin",
    env: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    options: {},
    models: googleModels,
  },
};
