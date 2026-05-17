/**
 * Lesson 15 -- Extension discovery and loading.
 *
 * Demonstrates:
 * - Filesystem discovery: project .agent/extensions/, global ~/.agent/extensions/
 * - jiti for runtime TypeScript loading (no build step needed)
 * - ExtensionAPI creation and factory invocation
 * - Runtime with throwing stubs, completed later by runner.bindCore()
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  Extension,
  ExtensionAPI,
  ExtensionFactory,
  ExtensionRuntime,
  LoadExtensionsResult,
  ExtensionToolDefinition,
} from "./extension-types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_DIR_NAME = ".agent";

// ---------------------------------------------------------------------------
// Runtime Factory
// ---------------------------------------------------------------------------

/**
 * Create an ExtensionRuntime with throwing stubs.
 *
 * Action methods (sendMessage, setModel, etc.) cannot be called during
 * extension loading because the host is not yet wired up. The runner
 * replaces these stubs via bindCore() after all extensions are loaded.
 */
export function createExtensionRuntime(): ExtensionRuntime {
  const notInitialized = (): never => {
    throw new Error(
      "Extension runtime not initialized. Action methods cannot be called during extension loading.",
    );
  };

  const state: { staleMessage?: string } = {};

  return {
    sendMessage: notInitialized,
    setModel: notInitialized,
    getActiveTools: notInitialized,
    setActiveTools: notInitialized,
    flagValues: new Map(),
    pendingRegistrations: [],
    assertActive() {
      if (state.staleMessage) throw new Error(state.staleMessage);
    },
    invalidate(message?: string) {
      state.staleMessage ??= message ?? "Extension instance is stale.";
    },
  };
}

// ---------------------------------------------------------------------------
// Extension Factory
// ---------------------------------------------------------------------------

function createExtension(extensionPath: string): Extension {
  return {
    path: extensionPath,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    shortcuts: new Map(),
  };
}

/**
 * Build the ExtensionAPI that gets passed to the factory function.
 *
 * Registration methods (on, registerTool, etc.) write to the Extension object.
 * Action methods (sendMessage, setModel, etc.) delegate to the shared runtime.
 */
function createExtensionAPI(extension: Extension, runtime: ExtensionRuntime): ExtensionAPI {
  type HandlerFn = (...args: unknown[]) => Promise<unknown>;

  return {
    // -- Event subscription --
    on(event: string, handler: HandlerFn): void {
      runtime.assertActive();
      const list = extension.handlers.get(event) ?? [];
      list.push(handler);
      extension.handlers.set(event, list);
    },

    // -- Registration --
    registerTool(tool: ExtensionToolDefinition): void {
      runtime.assertActive();
      extension.tools.set(tool.name, tool);
    },

    registerCommand(name, options): void {
      runtime.assertActive();
      extension.commands.set(name, { name, ...options });
    },

    registerShortcut(key, options): void {
      runtime.assertActive();
      extension.shortcuts.set(key, { key, ...options });
    },

    // -- Actions (delegate to runtime) --
    sendMessage(content: string): void {
      runtime.assertActive();
      runtime.sendMessage(content);
    },

    setModel(modelId: string): void {
      runtime.assertActive();
      runtime.setModel(modelId);
    },

    getActiveTools(): string[] {
      runtime.assertActive();
      return runtime.getActiveTools();
    },

    setActiveTools(toolNames: string[]): void {
      runtime.assertActive();
      runtime.setActiveTools(toolNames);
    },
  } as ExtensionAPI;
}

// ---------------------------------------------------------------------------
// Module Loading (jiti)
// ---------------------------------------------------------------------------

/**
 * Load an extension module from a .ts or .js file using jiti.
 *
 * jiti transpiles TypeScript at runtime, so extensions don't need a
 * build step. Key options:
 * - moduleCache: false -- allows reloading on /reload
 * - alias (Node.js) or virtualModules (compiled binary) -- ensures
 *   extensions resolve to the host's bundled packages
 */
async function loadExtensionModule(extensionPath: string): Promise<ExtensionFactory | undefined> {
  // Dynamic import so this file works even without jiti installed
  // (the rest of the lesson code still compiles and demonstrates the patterns)
  const { createJiti } = await import("jiti");

  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    // In a real agent you would also set:
    //   alias: { "@my-agent/core": "/path/to/core/index.js" }
    // or for compiled binaries:
    //   virtualModules: { "@my-agent/core": bundledCoreModule }
    //   tryNative: false
  });

  const module = await jiti.import(extensionPath, { default: true });
  const factory = module as ExtensionFactory;
  return typeof factory === "function" ? factory : undefined;
}

// ---------------------------------------------------------------------------
// Single Extension Loading
// ---------------------------------------------------------------------------

async function loadExtension(
  extensionPath: string,
  runtime: ExtensionRuntime,
): Promise<{ extension: Extension | null; error: string | null }> {
  try {
    const factory = await loadExtensionModule(extensionPath);
    if (!factory) {
      return {
        extension: null,
        error: `Extension does not export a valid factory function: ${extensionPath}`,
      };
    }

    const extension = createExtension(extensionPath);
    const api = createExtensionAPI(extension, runtime);

    // Invoke the factory -- extension registers handlers, tools, etc.
    await factory(api);

    return { extension, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { extension: null, error: `Failed to load extension: ${message}` };
  }
}

/**
 * Load an extension from an inline factory (no filesystem).
 * Useful for testing or embedding extensions programmatically.
 */
export async function loadExtensionFromFactory(
  factory: ExtensionFactory,
  runtime: ExtensionRuntime,
  extensionPath = "<inline>",
): Promise<Extension> {
  const extension = createExtension(extensionPath);
  const api = createExtensionAPI(extension, runtime);
  await factory(api);
  return extension;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Discover extension files in a directory (one level deep).
 *
 * Rules:
 * 1. Direct .ts/.js files -> load
 * 2. Subdirectory with index.ts or index.js -> load the index
 * 3. Subdirectory with package.json containing "agent.extensions" -> load declared paths
 */
function discoverExtensionsInDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const discovered: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    // 1. Direct files
    if (entry.isFile() && isExtensionFile(entry.name)) {
      discovered.push(entryPath);
      continue;
    }

    // 2 & 3. Subdirectories
    if (entry.isDirectory()) {
      // Check package.json first
      const pkgPath = path.join(entryPath, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          if (pkg.agent?.extensions?.length) {
            for (const ext of pkg.agent.extensions as string[]) {
              const resolved = path.resolve(entryPath, ext);
              if (fs.existsSync(resolved)) discovered.push(resolved);
            }
            continue;
          }
        } catch {
          /* ignore malformed package.json */
        }
      }

      // Fall back to index.ts / index.js
      const indexTs = path.join(entryPath, "index.ts");
      const indexJs = path.join(entryPath, "index.js");
      if (fs.existsSync(indexTs)) discovered.push(indexTs);
      else if (fs.existsSync(indexJs)) discovered.push(indexJs);
    }
  }

  return discovered;
}

/**
 * Discover and load extensions from standard locations.
 *
 * Search order:
 * 1. Project-local: cwd/.agent/extensions/
 * 2. Global: ~/.agent/extensions/
 * 3. Explicitly configured paths
 */
export async function discoverAndLoadExtensions(
  configuredPaths: string[],
  cwd: string,
): Promise<LoadExtensionsResult> {
  const allPaths: string[] = [];
  const seen = new Set<string>();

  const addPaths = (paths: string[]) => {
    for (const p of paths) {
      const resolved = path.resolve(p);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        allPaths.push(p);
      }
    }
  };

  // 1. Project-local extensions
  const localExtDir = path.join(cwd, CONFIG_DIR_NAME, "extensions");
  addPaths(discoverExtensionsInDir(localExtDir));

  // 2. Global extensions
  const globalExtDir = path.join(os.homedir(), CONFIG_DIR_NAME, "extensions");
  addPaths(discoverExtensionsInDir(globalExtDir));

  // 3. Explicit paths
  for (const p of configuredPaths) {
    const resolved = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      addPaths(discoverExtensionsInDir(resolved));
    } else {
      addPaths([resolved]);
    }
  }

  return loadExtensions(allPaths);
}

/**
 * Load extensions from an array of file paths.
 */
export async function loadExtensions(paths: string[]): Promise<LoadExtensionsResult> {
  const extensions: Extension[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  const runtime = createExtensionRuntime();

  for (const extPath of paths) {
    const { extension, error } = await loadExtension(extPath, runtime);
    if (error) {
      errors.push({ path: extPath, error });
      continue;
    }
    if (extension) extensions.push(extension);
  }

  return { extensions, errors, runtime };
}
