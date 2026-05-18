/**
 * SDK Loader
 *
 * 按需懒加载 AI SDK provider 包。
 * 直接借鉴 OpenCode 的 BUNDLED_PROVIDERS + resolveSDK() 模式。
 *
 * 核心洞察：每个 provider SDK 通过 dynamic import() 在首次使用时才加载，
 * 加载后的 SDK 工厂被缓存，后续调用复用已有实例。
 *
 * @see https://github.com/anomalyco/opencode — provider.ts BUNDLED_PROVIDERS
 * @see https://github.com/anomalyco/opencode — provider.ts resolveSDK()
 */

import type { LanguageModelV3 as LanguageModel } from "@ai-sdk/provider";
import type { ModelInfo, ProviderInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Bundled provider loaders
// (来自 OpenCode 的 BUNDLED_PROVIDERS — lazy import() map)
// ---------------------------------------------------------------------------

/** 加载后的 SDK 实例，可以创建 language model */
export interface ProviderSDK {
  languageModel(modelId: string): LanguageModel;
}

/**
 * npm 包名 → 懒加载函数的映射。
 *
 * OpenCode 有 20+ 条目，我们只保留已安装的依赖。
 * 添加新 provider 只需：
 * 1. 安装包：pnpm add @ai-sdk/xxx
 * 2. 在这里加一行
 */
const BUNDLED_PROVIDERS: Record<
  string,
  () => Promise<(opts: any) => ProviderSDK>
> = {
  "@ai-sdk/anthropic": () =>
    import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  "@ai-sdk/openai": () =>
    import("@ai-sdk/openai").then((m) => m.createOpenAI),
  "@ai-sdk/google": () =>
    import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
};

// ---------------------------------------------------------------------------
// SDK cache
// (来自 OpenCode 的 State.sdk — 按 provider+options 哈希缓存)
// ---------------------------------------------------------------------------

const sdkCache = new Map<string, ProviderSDK>();

function cacheKey(provider: ProviderInfo, model: ModelInfo): string {
  return JSON.stringify({
    providerID: provider.id,
    npm: model.api.npm,
    baseURL: model.api.url || provider.options["baseURL"] || "",
  });
}

// ---------------------------------------------------------------------------
// resolveSDK
// (简化自 OpenCode 的 resolveSDK 函数)
// ---------------------------------------------------------------------------

/**
 * 解析并缓存给定 provider + model 的 SDK 实例。
 *
 * 流程（借鉴 OpenCode）：
 * 1. 从 provider info 构建 options（baseURL, apiKey, headers）
 * 2. 检查缓存
 * 3. 优先尝试 bundled provider（lazy import）
 * 4. 回退到动态 import 加载未知包
 * 5. 调用 create* 工厂函数，缓存并返回
 */
export async function resolveSDK(
  provider: ProviderInfo,
  model: ModelInfo,
): Promise<ProviderSDK> {
  const key = cacheKey(provider, model);

  const cached = sdkCache.get(key);
  if (cached) return cached;

  // 构建 SDK options
  const options: Record<string, unknown> = { ...provider.options };
  const baseURL =
    (options["baseURL"] as string) || model.api.url || undefined;
  if (baseURL) options["baseURL"] = baseURL;
  if (provider.key) options["apiKey"] = provider.key;

  // 尝试 bundled provider（常见路径）
  const bundledLoader = BUNDLED_PROVIDERS[model.api.npm];
  if (bundledLoader) {
    const factory = await bundledLoader();
    const sdk = factory(options);
    sdkCache.set(key, sdk);
    return sdk;
  }

  // 回退：动态 import（对应 OpenCode 的 Npm.add fallback）
  const mod = await import(model.api.npm);
  const createFnKey = Object.keys(mod as Record<string, unknown>).find(
    (k: string) => k.startsWith("create"),
  );
  if (!createFnKey) {
    throw new Error(
      `SDK package "${model.api.npm}" does not export a create* function`,
    );
  }
  const createFn = (mod as Record<string, (opts: any) => ProviderSDK>)[
    createFnKey
  ]!;

  const sdk = createFn(options);
  sdkCache.set(key, sdk);
  return sdk;
}

// ---------------------------------------------------------------------------
// getLanguageModel
// (简化自 OpenCode 的 getLanguage Effect 函数)
// ---------------------------------------------------------------------------

const modelCache = new Map<string, LanguageModel>();

/**
 * 获取可直接使用的 LanguageModel 实例。
 * 调用者无需了解 SDK 细节 — 拿到 LanguageModel 直接传给 streamText。
 */
export async function getLanguageModel(
  provider: ProviderInfo,
  model: ModelInfo,
): Promise<LanguageModel> {
  const key = `${provider.id}/${model.id}`;

  const cached = modelCache.get(key);
  if (cached) return cached;

  const sdk = await resolveSDK(provider, model);
  const language = sdk.languageModel(model.api.id);

  modelCache.set(key, language);
  return language;
}

/** 清除所有缓存（测试或配置变更时使用） */
export function clearSDKCache(): void {
  sdkCache.clear();
  modelCache.clear();
}
