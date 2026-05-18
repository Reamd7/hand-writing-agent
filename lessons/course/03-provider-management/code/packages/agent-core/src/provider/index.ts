/**
 * Provider module — public API
 */

// Types
export type {
  ProviderID,
  ModelID,
  ProviderInfo,
  ModelInfo,
  ModelCapabilities,
  ModelCost,
  ModelLimits,
  ModelStatus,
  ProviderApiInfo,
  ProviderSource,
} from "./types.js";

export { providerID, modelID, ProviderIDs } from "./types.js";

// Catalog
export { CATALOG } from "./catalog.js";

// SDK Loader
export type { ProviderSDK } from "./sdk-loader.js";
export { resolveSDK, getLanguageModel, clearSDKCache } from "./sdk-loader.js";

// Registry (core)
export {
  ProviderRegistry,
  parseModelKey,
  ProviderNotFoundError,
  ModelNotFoundError,
} from "./registry.js";
export type { ProviderConfig } from "./registry.js";
