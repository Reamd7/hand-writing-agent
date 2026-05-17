/**
 * Demo: exercise the three auxiliary tools and system prompt builder.
 *
 * Run:  npx tsx src/demo.ts
 */

import path from "node:path";
import {
  createGrepTool,
  createFindTool,
  createLsTool,
  buildSystemPrompt,
  loadProjectContextFiles,
} from "@my-agent/tools";

// Use the lesson code directory itself as the demo workspace
const cwd = path.resolve(import.meta.dirname, "..");

function separator(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}\n`);
}

// ---------------------------------------------------------------------------
// 1. Grep: search for "function" in .ts files
// ---------------------------------------------------------------------------

async function demoGrep(): Promise<void> {
  separator("Grep Tool: search for 'function' in *.ts files");

  const grep = createGrepTool(cwd);
  const result = await grep.execute({
    pattern: "function",
    path: "src",
    glob: "*.ts",
    limit: 10,
  });

  console.log(`Matches found: ${result.matchCount}`);
  console.log(`Truncated: ${result.truncated}`);
  console.log("---");
  console.log(result.content);
}

// ---------------------------------------------------------------------------
// 2. Find: locate all TypeScript files
// ---------------------------------------------------------------------------

async function demoFind(): Promise<void> {
  separator("Find Tool: locate all *.ts files");

  const find = createFindTool(cwd);
  const result = await find.execute({
    pattern: "**/*.ts",
    limit: 50,
  });

  console.log(`Files found: ${result.resultCount}`);
  console.log(`Truncated: ${result.truncated}`);
  console.log("---");
  console.log(result.content);
}

// ---------------------------------------------------------------------------
// 3. Ls: list the src/ directory
// ---------------------------------------------------------------------------

async function demoLs(): Promise<void> {
  separator("Ls Tool: list src/ directory");

  const ls = createLsTool(cwd);
  const result = await ls.execute({ path: "src" });

  console.log(`Entries: ${result.entryCount}`);
  console.log(`Truncated: ${result.truncated}`);
  console.log("---");
  console.log(result.content);
}

// ---------------------------------------------------------------------------
// 4. System prompt: build with different tool configurations
// ---------------------------------------------------------------------------

function demoSystemPrompt(): void {
  separator("System Prompt: default tools only (read, bash, edit, write)");

  const defaultPrompt = buildSystemPrompt({
    cwd,
    toolSnippets: {
      read: "Read files and images",
      bash: "Execute shell commands",
      edit: "Edit files with search/replace",
      write: "Write new files",
    },
  });
  console.log(defaultPrompt);
  console.log(`\n--- prompt length: ${defaultPrompt.length} chars ---`);

  separator("System Prompt: with auxiliary tools (grep, find, ls)");

  const fullPrompt = buildSystemPrompt({
    cwd,
    selectedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    toolSnippets: {
      read: "Read files and images",
      bash: "Execute shell commands",
      edit: "Edit files with search/replace",
      write: "Write new files",
      grep: "Search file contents for patterns (respects .gitignore)",
      find: "Find files by glob pattern (respects .gitignore)",
      ls: "List directory contents",
    },
    promptGuidelines: [
      "When searching code, prefer grep over bash + rg",
      "Use find to locate config files before reading them",
    ],
  });
  console.log(fullPrompt);
  console.log(`\n--- prompt length: ${fullPrompt.length} chars ---`);
}

// ---------------------------------------------------------------------------
// 5. Project context discovery
// ---------------------------------------------------------------------------

function demoContextDiscovery(): void {
  separator("Project Context Discovery");

  const contextFiles = loadProjectContextFiles({ cwd });

  if (contextFiles.length === 0) {
    console.log("No AGENTS.md or CLAUDE.md found in directory tree.");
  } else {
    for (const file of contextFiles) {
      console.log(`Found: ${file.path}`);
      console.log(`  Content preview: ${file.content.slice(0, 100).replace(/\n/g, " ")}...`);
      console.log();
    }
  }

  // Build prompt with discovered context
  if (contextFiles.length > 0) {
    separator("System Prompt with Project Context");

    const prompt = buildSystemPrompt({
      cwd,
      selectedTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      toolSnippets: {
        read: "Read files and images",
        bash: "Execute shell commands",
        edit: "Edit files with search/replace",
        write: "Write new files",
        grep: "Search file contents for patterns (respects .gitignore)",
        find: "Find files by glob pattern (respects .gitignore)",
        ls: "List directory contents",
      },
      contextFiles,
    });

    // Show just the Project Context section
    const contextIdx = prompt.indexOf("# Project Context");
    if (contextIdx !== -1) {
      const dateIdx = prompt.indexOf("\nCurrent date:");
      const section = prompt.slice(contextIdx, dateIdx !== -1 ? dateIdx : undefined);
      console.log(section.slice(0, 500));
      if (section.length > 500) console.log(`... (${section.length - 500} more chars)`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run all demos
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await demoGrep();
    await demoFind();
    await demoLs();
    demoSystemPrompt();
    demoContextDiscovery();
  } catch (err) {
    console.error("Demo failed:", err);
    process.exit(1);
  }
}

main();
