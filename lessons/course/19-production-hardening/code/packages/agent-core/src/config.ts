/**
 * Lesson 19: Layered configuration system with YAML validation.
 *
 * Config priority (low to high):
 * 1. Hardcoded defaults
 * 2. Global config:  ~/.agent/config.yaml
 * 3. Project config: .agent/config.yaml
 * 4. Environment variable overrides
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// ============================================================================
// Schema & Types
// ============================================================================

export interface RetryConfig {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface CompactionConfig {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface SecurityConfig {
  allowedPaths: string[];
  blockedCommands: string[];
}

export interface ConfigSchema {
  retry: RetryConfig;
  compaction: CompactionConfig;
  security: SecurityConfig;
  defaultModel: string;
  defaultProvider: string;
}

// ============================================================================
// Defaults
// ============================================================================

export function getDefaultConfig(): ConfigSchema {
  return {
    retry: {
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2000,
      maxDelayMs: 60000,
    },
    compaction: {
      enabled: true,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    },
    security: {
      allowedPaths: ["."],
      blockedCommands: [],
    },
    defaultModel: "claude-sonnet-4-20250514",
    defaultProvider: "anthropic",
  };
}

// ============================================================================
// Validation
// ============================================================================

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly errors: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Validate a raw parsed YAML object against the expected config schema.
 *
 * Returns a partial config (only validated fields) that can be merged
 * with defaults.
 */
export function validateConfig(raw: unknown): Partial<ConfigSchema> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("Config file must be a YAML object");
  }

  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  const result: Record<string, unknown> = {};

  // -- retry --
  if (obj.retry !== undefined) {
    if (typeof obj.retry !== "object" || obj.retry === null || Array.isArray(obj.retry)) {
      errors.push("retry: must be an object");
    } else {
      const retry = obj.retry as Record<string, unknown>;
      const validRetry: Record<string, unknown> = {};

      if (retry.enabled !== undefined) {
        if (typeof retry.enabled !== "boolean") {
          errors.push("retry.enabled: must be a boolean");
        } else {
          validRetry.enabled = retry.enabled;
        }
      }

      if (retry.maxRetries !== undefined) {
        if (
          typeof retry.maxRetries !== "number" ||
          retry.maxRetries < 0 ||
          !Number.isInteger(retry.maxRetries)
        ) {
          errors.push("retry.maxRetries: must be a non-negative integer");
        } else {
          validRetry.maxRetries = retry.maxRetries;
        }
      }

      if (retry.baseDelayMs !== undefined) {
        if (typeof retry.baseDelayMs !== "number" || retry.baseDelayMs < 0) {
          errors.push("retry.baseDelayMs: must be a non-negative number");
        } else {
          validRetry.baseDelayMs = retry.baseDelayMs;
        }
      }

      if (retry.maxDelayMs !== undefined) {
        if (typeof retry.maxDelayMs !== "number" || retry.maxDelayMs < 0) {
          errors.push("retry.maxDelayMs: must be a non-negative number");
        } else {
          validRetry.maxDelayMs = retry.maxDelayMs;
        }
      }

      if (Object.keys(validRetry).length > 0) {
        result.retry = validRetry;
      }
    }
  }

  // -- compaction --
  if (obj.compaction !== undefined) {
    if (
      typeof obj.compaction !== "object" ||
      obj.compaction === null ||
      Array.isArray(obj.compaction)
    ) {
      errors.push("compaction: must be an object");
    } else {
      const compaction = obj.compaction as Record<string, unknown>;
      const validCompaction: Record<string, unknown> = {};

      if (compaction.enabled !== undefined) {
        if (typeof compaction.enabled !== "boolean") {
          errors.push("compaction.enabled: must be a boolean");
        } else {
          validCompaction.enabled = compaction.enabled;
        }
      }

      if (compaction.reserveTokens !== undefined) {
        if (
          typeof compaction.reserveTokens !== "number" ||
          compaction.reserveTokens < 0 ||
          !Number.isInteger(compaction.reserveTokens)
        ) {
          errors.push("compaction.reserveTokens: must be a non-negative integer");
        } else {
          validCompaction.reserveTokens = compaction.reserveTokens;
        }
      }

      if (compaction.keepRecentTokens !== undefined) {
        if (
          typeof compaction.keepRecentTokens !== "number" ||
          compaction.keepRecentTokens < 0 ||
          !Number.isInteger(compaction.keepRecentTokens)
        ) {
          errors.push("compaction.keepRecentTokens: must be a non-negative integer");
        } else {
          validCompaction.keepRecentTokens = compaction.keepRecentTokens;
        }
      }

      if (Object.keys(validCompaction).length > 0) {
        result.compaction = validCompaction;
      }
    }
  }

  // -- security --
  if (obj.security !== undefined) {
    if (typeof obj.security !== "object" || obj.security === null || Array.isArray(obj.security)) {
      errors.push("security: must be an object");
    } else {
      const security = obj.security as Record<string, unknown>;
      const validSecurity: Record<string, unknown> = {};

      if (security.allowedPaths !== undefined) {
        if (
          !Array.isArray(security.allowedPaths) ||
          !security.allowedPaths.every((p) => typeof p === "string")
        ) {
          errors.push("security.allowedPaths: must be an array of strings");
        } else {
          validSecurity.allowedPaths = security.allowedPaths;
        }
      }

      if (security.blockedCommands !== undefined) {
        if (
          !Array.isArray(security.blockedCommands) ||
          !security.blockedCommands.every((c) => typeof c === "string")
        ) {
          errors.push("security.blockedCommands: must be an array of strings");
        } else {
          validSecurity.blockedCommands = security.blockedCommands;
        }
      }

      if (Object.keys(validSecurity).length > 0) {
        result.security = validSecurity;
      }
    }
  }

  // -- scalar fields --
  if (obj.defaultModel !== undefined) {
    if (typeof obj.defaultModel !== "string") {
      errors.push("defaultModel: must be a string");
    } else {
      result.defaultModel = obj.defaultModel;
    }
  }

  if (obj.defaultProvider !== undefined) {
    if (typeof obj.defaultProvider !== "string") {
      errors.push("defaultProvider: must be a string");
    } else {
      result.defaultProvider = obj.defaultProvider;
    }
  }

  if (errors.length > 0) {
    throw new ConfigError(`Config validation failed:\n  ${errors.join("\n  ")}`, errors);
  }

  return result as Partial<ConfigSchema>;
}

// ============================================================================
// Deep Merge
// ============================================================================

/**
 * Deep merge two config objects. Values in `override` take precedence.
 *
 * Rules:
 * - Objects are merged recursively
 * - Arrays are replaced entirely (not concatenated)
 * - Scalars are overwritten
 * - undefined values in override are skipped
 */
export function mergeConfig<T extends object>(base: T, override: Partial<T>): T {
  const merged = structuredClone(base);

  for (const key of Object.keys(override) as Array<keyof T>) {
    const overrideValue = override[key];
    if (overrideValue === undefined) continue;

    const baseValue = merged[key];

    if (
      typeof overrideValue === "object" &&
      overrideValue !== null &&
      !Array.isArray(overrideValue) &&
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue)
    ) {
      // Recursive merge for nested objects
      (merged as Record<string, unknown>)[key as string] = mergeConfig(
        baseValue as Record<string, unknown>,
        overrideValue as Record<string, unknown>,
      );
    } else {
      // Scalars and arrays: direct override
      (merged as Record<string, unknown>)[key as string] = structuredClone(overrideValue);
    }
  }

  return merged;
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Load and validate a single YAML config file.
 *
 * @param filePath - Absolute path to a .yaml config file
 * @returns Validated partial config
 * @throws ConfigError if the file is malformed or fails validation
 */
export function loadConfig(filePath: string): Partial<ConfigSchema> {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new ConfigError(`Failed to read config file: ${filePath}: ${error}`);
  }

  // Empty file is valid (no overrides)
  if (content.trim() === "") {
    return {};
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    throw new ConfigError(`Failed to parse YAML in ${filePath}: ${error}`);
  }

  return validateConfig(raw);
}

/**
 * Load the fully merged config from all layers.
 *
 * Priority (low to high):
 * 1. Hardcoded defaults
 * 2. Global:  ~/.agent/config.yaml
 * 3. Project: .agent/config.yaml (relative to cwd)
 * 4. Environment variables (AGENT_DEFAULT_MODEL, AGENT_DEFAULT_PROVIDER)
 *
 * @param cwd - Current working directory for project config lookup
 * @returns Fully merged and validated ConfigSchema
 */
export function loadMergedConfig(cwd: string = process.cwd()): ConfigSchema {
  // 1. Defaults
  let config = getDefaultConfig();

  // 2. Global config
  const globalPath = join(homedir(), ".agent", "config.yaml");
  if (existsSync(globalPath)) {
    const globalOverrides = loadConfig(globalPath);
    config = mergeConfig(config, globalOverrides);
  }

  // 3. Project config
  const projectPath = join(cwd, ".agent", "config.yaml");
  if (existsSync(projectPath)) {
    const projectOverrides = loadConfig(projectPath);
    config = mergeConfig(config, projectOverrides);
  }

  // 4. Environment variable overrides
  if (process.env.AGENT_DEFAULT_MODEL) {
    config.defaultModel = process.env.AGENT_DEFAULT_MODEL;
  }
  if (process.env.AGENT_DEFAULT_PROVIDER) {
    config.defaultProvider = process.env.AGENT_DEFAULT_PROVIDER;
  }

  return config;
}
