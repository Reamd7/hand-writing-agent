/**
 * Lesson 3: Model Registry
 *
 * A central registry that maps "provider/modelId" keys to language model
 * instances. This decouples model selection (configuration) from model
 * usage (calling streamText/generateText).
 */

import type { LanguageModelV2 as LanguageModel } from "@ai-sdk/provider";

export interface ModelEntry {
  /** Provider name, e.g. "openai", "anthropic" */
  provider: string;
  /** Model identifier within the provider, e.g. "gpt-4o", "claude-sonnet-4-5" */
  modelId: string;
  /** The AI SDK language model instance */
  model: LanguageModel;
  /** Optional metadata: cost per million tokens, context window, etc. */
  meta?: ModelMeta;
}

export interface ModelMeta {
  contextWindow?: number;
  costPerMillionInputTokens?: number;
  costPerMillionOutputTokens?: number;
  supportsImages?: boolean;
  supportsThinking?: boolean;
}

export class ModelRegistry {
  /**
   * Two-level map: provider -> modelId -> ModelEntry.
   * This matches pi's approach in packages/ai/src/models.ts for efficient
   * per-provider enumeration.
   */
  private providers = new Map<string, Map<string, ModelEntry>>();

  /**
   * Register a model under "provider/modelId".
   *
   * @example
   *   registry.register("openai", "gpt-4o", openai("gpt-4o"), {
   *     contextWindow: 128000,
   *     supportsImages: true,
   *   });
   */
  register(provider: string, modelId: string, model: LanguageModel, meta?: ModelMeta): void {
    let providerMap = this.providers.get(provider);
    if (!providerMap) {
      providerMap = new Map();
      this.providers.set(provider, providerMap);
    }

    const entry: ModelEntry = { provider, modelId, model, meta };
    providerMap.set(modelId, entry);
  }

  /**
   * Retrieve a model by its composite key "provider/modelId".
   * Returns undefined if not found.
   *
   * @example
   *   const entry = registry.get("openai/gpt-4o");
   */
  get(key: string): ModelEntry | undefined {
    const slashIndex = key.indexOf("/");
    if (slashIndex === -1) return undefined;

    const provider = key.slice(0, slashIndex);
    const modelId = key.slice(slashIndex + 1);

    return this.providers.get(provider)?.get(modelId);
  }

  /**
   * Get a model or throw if not found.
   */
  getOrThrow(key: string): ModelEntry {
    const entry = this.get(key);
    if (!entry) {
      throw new Error(
        `Model "${key}" not found in registry. ` + `Available: ${this.listKeys().join(", ")}`,
      );
    }
    return entry;
  }

  /**
   * List all registered provider names.
   */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * List all models for a given provider.
   */
  listModels(provider: string): ModelEntry[] {
    const providerMap = this.providers.get(provider);
    return providerMap ? Array.from(providerMap.values()) : [];
  }

  /**
   * List all registered models across all providers.
   */
  listAll(): ModelEntry[] {
    const result: ModelEntry[] = [];
    for (const providerMap of this.providers.values()) {
      for (const entry of providerMap.values()) {
        result.push(entry);
      }
    }
    return result;
  }

  /**
   * List all registered "provider/modelId" keys.
   */
  listKeys(): string[] {
    return this.listAll().map((e) => `${e.provider}/${e.modelId}`);
  }

  /**
   * Remove a specific model from the registry.
   */
  unregister(key: string): boolean {
    const slashIndex = key.indexOf("/");
    if (slashIndex === -1) return false;

    const provider = key.slice(0, slashIndex);
    const modelId = key.slice(slashIndex + 1);

    const providerMap = this.providers.get(provider);
    if (!providerMap) return false;

    const deleted = providerMap.delete(modelId);
    if (providerMap.size === 0) {
      this.providers.delete(provider);
    }
    return deleted;
  }

  /**
   * Remove all models for a provider.
   */
  unregisterProvider(provider: string): boolean {
    return this.providers.delete(provider);
  }

  /**
   * Clear the entire registry.
   */
  clear(): void {
    this.providers.clear();
  }
}
