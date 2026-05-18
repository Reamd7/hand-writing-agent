/**
 * Provider Registry
 *
 * Provider 管理的核心服务，融合 OpenCode 的关键模式：
 * - 环境变量自动发现
 * - 内置模型目录
 * - 配置驱动的 provider 注册
 * - 懒加载 SDK 解析
 *
 * @see https://github.com/anomalyco/opencode — packages/opencode/src/provider/provider.ts
 */

import type { LanguageModelV3 as LanguageModel } from "@ai-sdk/provider";
import type {
  ProviderID,
  ModelID,
  ProviderInfo,
  ModelInfo,
  ProviderSource,
} from "./types.js";
import { providerID, modelID } from "./types.js";
import { CATALOG } from "./catalog.js";
import { getLanguageModel, clearSDKCache } from "./sdk-loader.js";

// ---------------------------------------------------------------------------
// Config types（用户配置覆盖）
// ---------------------------------------------------------------------------

/** 用户自定义或覆盖 provider 的配置 */
export interface ProviderConfig {
  name?: string;
  apiKey?: string;
  baseURL?: string;
  npm?: string;
  env?: string[];
  options?: Record<string, unknown>;
  models?: Record<string, Partial<ModelInfo> & { id?: string }>;
}

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

/**
 * 中心化 provider 注册表。
 *
 * 设计借鉴 OpenCode 的 Provider.Service：
 * - `create()` 执行发现（env 扫描 + config 合并）
 * - `getModel()` / `getLanguageModel()` 按需解析
 * - `list()` / `listAvailable()` 枚举
 *
 * 与 OpenCode 的 Effect-based service 不同，这是一个普通 class，
 * 易于实例化和测试。Effect 层可以在后续课程中添加。
 */
export class ProviderRegistry {
  private providers = new Map<ProviderID, ProviderInfo>();

  // -----------------------------------------------------------------------
  // 初始化
  // (简化自 OpenCode 的 layer Effect，provider.ts:1163-1503)
  // -----------------------------------------------------------------------

  /**
   * 创建并初始化 registry：
   * 1. 加载内置目录
   * 2. 扫描环境变量
   * 3. 合并用户配置
   */
  static create(config?: Record<string, ProviderConfig>): ProviderRegistry {
    const registry = new ProviderRegistry();
    registry.loadCatalog();
    registry.discoverFromEnv();
    if (config) {
      registry.applyConfig(config);
    }
    return registry;
  }

  /**
   * Step 1: 加载内置目录。
   * 对应 OpenCode 从 models.dev 加载，我们用静态 CATALOG。
   */
  private loadCatalog(): void {
    for (const [id, provider] of Object.entries(CATALOG)) {
      this.providers.set(providerID(id), structuredClone(provider));
    }
  }

  /**
   * Step 2: 从环境变量自动发现 provider。
   *
   * 借鉴 OpenCode provider.ts:1352-1363：
   * ```
   * const apiKey = provider.env.map((item) => envs[item]).find(Boolean)
   * if (!apiKey) continue
   * mergeProvider(providerID, { source: "env", key: apiKey })
   * ```
   */
  private discoverFromEnv(): void {
    for (const [, provider] of this.providers) {
      const apiKey = provider.env
        .map((envVar) => process.env[envVar])
        .find(Boolean);

      if (apiKey) {
        provider.source = "env";
        provider.key = apiKey;
      }
    }
  }

  /**
   * Step 3: 合并用户配置覆盖。
   *
   * 借鉴 OpenCode provider.ts:1259-1350 (config providers)
   * 和 provider.ts:1418-1426 (re-apply config)。
   */
  private applyConfig(config: Record<string, ProviderConfig>): void {
    for (const [id, cfg] of Object.entries(config)) {
      const pid = providerID(id);
      let provider = this.providers.get(pid);

      if (!provider) {
        // 目录中不存在的新 provider — 从配置创建
        provider = {
          id: pid,
          name: cfg.name ?? id,
          source: "config" as ProviderSource,
          env: cfg.env ?? [],
          key: cfg.apiKey,
          options: {},
          models: {},
        };
        this.providers.set(pid, provider);
      }

      // 合并配置
      if (cfg.name) provider.name = cfg.name;
      if (cfg.apiKey) {
        provider.key = cfg.apiKey;
        provider.source = "config";
      }
      if (cfg.baseURL) provider.options["baseURL"] = cfg.baseURL;
      if (cfg.options) {
        provider.options = { ...provider.options, ...cfg.options };
      }
      if (cfg.env) provider.env = cfg.env;

      // 合并 model 覆盖
      if (cfg.models) {
        for (const [mid, modelCfg] of Object.entries(cfg.models)) {
          const existing = provider.models[mid];
          if (existing) {
            if (modelCfg.api)
              existing.api = { ...existing.api, ...modelCfg.api };
            if (modelCfg.capabilities)
              existing.capabilities = {
                ...existing.capabilities,
                ...modelCfg.capabilities,
              };
            if (modelCfg.options)
              existing.options = { ...existing.options, ...modelCfg.options };
          } else {
            // 添加新 model
            const npm = cfg.npm ?? "@ai-sdk/openai-compatible";
            provider.models[mid] = {
              id: modelID(modelCfg.id ?? mid),
              providerID: pid,
              api: {
                id: modelCfg.id ?? mid,
                url: cfg.baseURL ?? "",
                npm,
                ...modelCfg.api,
              },
              name: modelCfg.name ?? mid,
              capabilities: {
                temperature: true,
                reasoning: false,
                toolCall: true,
                images: false,
                streaming: true,
                ...modelCfg.capabilities,
              },
              cost: modelCfg.cost ?? { input: 0, output: 0 },
              limit: modelCfg.limit ?? { context: 128_000, output: 4_096 },
              status: modelCfg.status ?? "active",
              options: modelCfg.options ?? {},
            };
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // 手动注册（测试或运行时添加）
  // -----------------------------------------------------------------------

  registerProvider(provider: ProviderInfo): void {
    this.providers.set(provider.id, provider);
  }

  // -----------------------------------------------------------------------
  // 查询 API
  // (来自 OpenCode 的 Provider.Interface)
  // -----------------------------------------------------------------------

  /** 列出所有已知 provider（无论是否有 API key） */
  list(): ProviderInfo[] {
    return Array.from(this.providers.values());
  }

  /** 只列出有 API key 的 provider */
  listAvailable(): ProviderInfo[] {
    return this.list().filter((p) => p.key !== undefined);
  }

  getProvider(id: ProviderID): ProviderInfo | undefined {
    return this.providers.get(id);
  }

  getProviderOrThrow(id: ProviderID): ProviderInfo {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ProviderNotFoundError(id);
    }
    return provider;
  }

  /**
   * 通过 "provider/modelId" 复合键获取模型。
   *
   * 来自 OpenCode 的 getModel (provider.ts:1655-1677)：
   * 先查 provider，再查其中的 model，失败时提供建议。
   */
  getModel(key: string): { provider: ProviderInfo; model: ModelInfo } {
    const parsed = parseModelKey(key);
    const provider = this.getProviderOrThrow(parsed.providerID);

    const model = provider.models[parsed.modelID];
    if (!model) {
      const available = Object.keys(provider.models);
      throw new ModelNotFoundError(
        parsed.providerID,
        parsed.modelID,
        available,
      );
    }

    return { provider, model };
  }

  /**
   * 将 "provider/modelId" 解析为可直接使用的 LanguageModel。
   *
   * 这是调用者的主要 API — 合并了 provider 查找、SDK 懒加载、model 实例化。
   * 来自 OpenCode 的 getLanguage (provider.ts:1679-1703)。
   */
  async getLanguageModel(key: string): Promise<LanguageModel> {
    const { provider, model } = this.getModel(key);

    if (!provider.key) {
      throw new Error(
        `Provider "${provider.id}" has no API key. ` +
          `Set one of: ${provider.env.join(", ")}`,
      );
    }

    return getLanguageModel(provider, model);
  }

  /**
   * 获取默认模型 — 第一个可用 provider 的第一个 model。
   * 简化自 OpenCode 的 defaultModel (provider.ts:1775-1807)。
   */
  defaultModel():
    | { providerID: ProviderID; modelID: ModelID }
    | undefined {
    const available = this.listAvailable();
    const provider = available[0];
    if (!provider) return undefined;

    const models = Object.values(provider.models);
    const firstModel = models[0];
    if (!firstModel) return undefined;

    return {
      providerID: provider.id,
      modelID: firstModel.id,
    };
  }

  /**
   * 查找 provider 下最小/最便宜的模型。
   * 简化自 OpenCode 的 getSmallModel (provider.ts:1717-1773)。
   */
  getSmallModel(pid: ProviderID): ModelInfo | undefined {
    const provider = this.providers.get(pid);
    if (!provider) return undefined;

    const small = ["haiku", "mini", "flash", "nano"];
    for (const hint of small) {
      for (const model of Object.values(provider.models)) {
        if (model.id.includes(hint)) return model;
      }
    }

    // 回退：按 input cost 排序
    const models = Object.values(provider.models);
    if (models.length === 0) return undefined;
    return models.sort((a, b) => a.cost.input - b.cost.input)[0];
  }

  clear(): void {
    this.providers.clear();
    clearSDKCache();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * 解析 "provider/modelId" 字符串。
 * 来自 OpenCode 的 parseModel (provider.ts:1835-1841)。
 */
export function parseModelKey(key: string): {
  providerID: ProviderID;
  modelID: string;
} {
  const slashIndex = key.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model key "${key}". Expected format: "provider/modelId"`,
    );
  }
  return {
    providerID: providerID(key.slice(0, slashIndex)),
    modelID: key.slice(slashIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// Errors
// (来自 OpenCode 的 ModelNotFoundError / InitError)
// ---------------------------------------------------------------------------

export class ProviderNotFoundError extends Error {
  readonly providerID: ProviderID;

  constructor(providerID: ProviderID) {
    super(`Provider "${providerID}" not found`);
    this.name = "ProviderNotFoundError";
    this.providerID = providerID;
  }
}

export class ModelNotFoundError extends Error {
  readonly providerID: ProviderID;
  readonly modelID: string;
  readonly suggestions: string[];

  constructor(
    providerID: ProviderID,
    modelID: string,
    available: string[],
  ) {
    const hint =
      available.length > 0
        ? ` Available: ${available.join(", ")}`
        : "";
    super(
      `Model "${modelID}" not found in provider "${providerID}".${hint}`,
    );
    this.name = "ModelNotFoundError";
    this.providerID = providerID;
    this.modelID = modelID;
    this.suggestions = available;
  }
}
