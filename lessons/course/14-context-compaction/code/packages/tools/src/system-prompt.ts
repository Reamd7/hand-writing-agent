/**
 * System prompt construction and project context discovery.
 *
 * Mirrors the five-section structure of pi's `buildSystemPrompt()`:
 *   1. Role description
 *   2. Available tools list (each tool's `promptSnippet`)
 *   3. Guidelines (tool-dependent + custom + defaults)
 *   4. Project context (AGENTS.md / CLAUDE.md discovered by walking up from cwd)
 *   5. Date and working directory (always last)
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildSystemPromptOptions {
  /** Completely replace the default prompt with a custom one. */
  customPrompt?: string;
  /** Names of the currently active tools. Default: ["read","bash","edit","write"] */
  selectedTools?: string[];
  /** Tool name -> one-line prompt snippet (from ToolDefinition.promptSnippet). */
  toolSnippets?: Record<string, string>;
  /** Extra guideline bullets (from ToolDefinition.promptGuidelines + user config). */
  promptGuidelines?: string[];
  /** Free-form text appended after the main prompt body. */
  appendSystemPrompt?: string;
  /** Absolute working directory. */
  cwd: string;
  /** Pre-loaded context files. Pass `loadProjectContextFiles()` output here. */
  contextFiles?: Array<{ path: string; content: string }>;
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

function formatDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Project context discovery
// ---------------------------------------------------------------------------

const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
  for (const filename of CONTEXT_FILE_CANDIDATES) {
    const filePath = path.join(dir, filename);
    if (existsSync(filePath)) {
      try {
        return { path: filePath, content: readFileSync(filePath, "utf-8") };
      } catch {
        // Unreadable -- skip
      }
    }
  }
  return null;
}

/**
 * Discover project context files by walking up from `cwd` to the filesystem
 * root.  Optionally also checks a global `agentDir` (e.g. `~/.config/pi/`).
 *
 * Returns files ordered outermost-first so that monorepo-root rules appear
 * before package-level rules in the prompt.
 */
export function loadProjectContextFiles(options: {
  cwd: string;
  agentDir?: string;
}): Array<{ path: string; content: string }> {
  const contextFiles: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  // 1. Global agent directory (e.g. ~/.config/pi/)
  if (options.agentDir) {
    const globalContext = loadContextFileFromDir(options.agentDir);
    if (globalContext) {
      contextFiles.push(globalContext);
      seenPaths.add(globalContext.path);
    }
  }

  // 2. Walk from cwd up to filesystem root
  const ancestorFiles: Array<{ path: string; content: string }> = [];
  let currentDir = path.resolve(options.cwd);
  const root = path.resolve("/");

  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      ancestorFiles.unshift(contextFile); // outermost first
      seenPaths.add(contextFile.path);
    }

    if (currentDir === root) break;
    const parentDir = path.resolve(currentDir, "..");
    if (parentDir === currentDir) break; // safety: cannot go higher
    currentDir = parentDir;
  }

  contextFiles.push(...ancestorFiles);
  return contextFiles;
}

// ---------------------------------------------------------------------------
// buildSystemPrompt()
// ---------------------------------------------------------------------------

/**
 * Build the full system prompt string.
 *
 * When `customPrompt` is provided, it replaces the default role/tools/guidelines
 * sections but context files, date, and cwd are still appended.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const {
    customPrompt,
    selectedTools,
    toolSnippets,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    contextFiles,
  } = options;

  const date = formatDate(new Date());
  const promptCwd = cwd.replace(/\\/g, "/"); // Windows compat

  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

  // -----------------------------------------------------------------------
  // Custom prompt path -- replace default body, keep context/date/cwd
  // -----------------------------------------------------------------------
  if (customPrompt) {
    let prompt = customPrompt;
    prompt += appendSection;
    prompt += formatContextFiles(contextFiles);
    prompt += `\nCurrent date: ${date}`;
    prompt += `\nCurrent working directory: ${promptCwd}`;
    return prompt;
  }

  // -----------------------------------------------------------------------
  // Default prompt path
  // -----------------------------------------------------------------------

  // -- Section 2: Available tools --
  const tools = selectedTools || ["read", "bash", "edit", "write"];
  const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
  const toolsList =
    visibleTools.length > 0
      ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n")
      : "(none)";

  // -- Section 3: Guidelines (with dedup) --
  const guidelinesList: string[] = [];
  const guidelinesSet = new Set<string>();
  const addGuideline = (g: string): void => {
    if (guidelinesSet.has(g)) return;
    guidelinesSet.add(g);
    guidelinesList.push(g);
  };

  // Conditional tool-related guidelines
  const hasBash = tools.includes("bash");
  const hasGrep = tools.includes("grep");
  const hasFind = tools.includes("find");
  const hasLs = tools.includes("ls");

  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    addGuideline("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    addGuideline(
      "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    );
  }

  // Custom guidelines (from tool promptGuidelines + user config)
  for (const g of promptGuidelines ?? []) {
    const trimmed = g.trim();
    if (trimmed.length > 0) addGuideline(trimmed);
  }

  // Universal guidelines (always present)
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");

  const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

  // -- Assemble --
  let prompt = `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}`;

  prompt += appendSection;
  prompt += formatContextFiles(contextFiles);

  // -- Section 5: Date and cwd (always last) --
  prompt += `\nCurrent date: ${date}`;
  prompt += `\nCurrent working directory: ${promptCwd}`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatContextFiles(files?: Array<{ path: string; content: string }>): string {
  if (!files || files.length === 0) return "";
  let section = "\n\n# Project Context\n\n";
  section += "Project-specific instructions and guidelines:\n\n";
  for (const { path: filePath, content } of files) {
    section += `## ${filePath}\n\n${content}\n\n`;
  }
  return section;
}
