/**
 * Demo: Session persistence, reload, branching, and tree verification.
 *
 * Run: npx tsx src/demo.ts
 */

import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager, buildSessionContext, loadEntriesFromFile } from "./session-manager.js";
import type { SessionEntry } from "./types.js";

// ============================================================================
// Helpers
// ============================================================================

function printBranch(label: string, entries: SessionEntry[]): void {
  console.log(`\n--- ${label} (${entries.length} entries) ---`);
  for (const e of entries) {
    if (e.type === "message") {
      console.log(`  [${e.id}] ${e.message.role}: ${e.message.content}`);
    } else if (e.type === "model_change") {
      console.log(`  [${e.id}] model_change -> ${e.provider}/${e.modelId}`);
    } else if (e.type === "compaction") {
      console.log(`  [${e.id}] compaction: "${e.summary.slice(0, 50)}..."`);
    } else {
      console.log(`  [${e.id}] ${e.type}`);
    }
  }
}

function printTree(
  nodes: Array<{ entry: SessionEntry; children: any[]; label?: string }>,
  indent = 0,
): void {
  for (const node of nodes) {
    const prefix = "  ".repeat(indent);
    const e = node.entry;
    const labelStr = node.label ? ` [label: ${node.label}]` : "";
    if (e.type === "message") {
      console.log(`${prefix}- [${e.id}] ${e.message.role}: "${e.message.content}"${labelStr}`);
    } else {
      console.log(`${prefix}- [${e.id}] ${e.type}${labelStr}`);
    }
    printTree(node.children, indent + 1);
  }
}

// ============================================================================
// Main Demo
// ============================================================================

const DEMO_DIR = join(tmpdir(), "session-demo-" + Date.now());
mkdirSync(DEMO_DIR, { recursive: true });

console.log("=== Session Persistence Demo ===");
console.log(`Working directory: ${DEMO_DIR}\n`);

// --------------------------------------------------------------------------
// 1. Create a session and add messages
// --------------------------------------------------------------------------

console.log("1. Creating a new session and adding messages...");
const sm = SessionManager.create(DEMO_DIR, DEMO_DIR);
console.log(`   Session ID: ${sm.getSessionId()}`);
console.log(`   Session file: ${sm.getSessionFile()}`);

const id1 = sm.appendMessage({ role: "user", content: "What is TypeScript?" });
const id2 = sm.appendMessage({
  role: "assistant",
  content: "TypeScript is a typed superset of JavaScript.",
});
const id3 = sm.appendMessage({ role: "user", content: "How do I use generics?" });
const id4 = sm.appendMessage({
  role: "assistant",
  content: "Generics let you write reusable code with type parameters.",
});

console.log(`   Added 4 messages. Leaf: ${sm.getLeafId()}`);
printBranch("Current branch", sm.getBranch());

// --------------------------------------------------------------------------
// 2. Reload from file
// --------------------------------------------------------------------------

console.log("\n2. Reloading session from JSONL file...");
const sm2 = SessionManager.open(sm.getSessionFile()!);
console.log(`   Session ID: ${sm2.getSessionId()}`);
console.log(`   Entry count: ${sm2.getEntries().length}`);
console.log(`   Leaf: ${sm2.getLeafId()}`);

const ctx = sm2.buildSessionContext();
console.log(`   Context messages: ${ctx.messages.length}`);
for (const m of ctx.messages) {
  console.log(`     ${m.role}: ${m.content}`);
}

// --------------------------------------------------------------------------
// 3. Branching -- go back to an earlier point and fork
// --------------------------------------------------------------------------

console.log("\n3. Branching from the second message...");
sm2.branch(id2); // Move leaf back to the assistant's first reply
console.log(`   Leaf after branch(): ${sm2.getLeafId()}`);

// Append a different follow-up question (creates a fork)
const id5 = sm2.appendMessage({ role: "user", content: "What about interfaces?" });
const id6 = sm2.appendMessage({
  role: "assistant",
  content: "Interfaces define the shape of objects.",
});
console.log(`   Added 2 messages on new branch.`);

// Show both branches
printBranch("Branch A (original)", sm2.getBranch(id4));
printBranch("Branch B (new fork)", sm2.getBranch(id6));

// --------------------------------------------------------------------------
// 4. Tree visualization
// --------------------------------------------------------------------------

console.log("\n4. Full session tree:");
printTree(sm2.getTree());

// --------------------------------------------------------------------------
// 5. buildSessionContext respects the current branch
// --------------------------------------------------------------------------

console.log("\n5. buildSessionContext for each branch:");

const ctxA = buildSessionContext(sm2.getEntries(), id4);
console.log(`   Branch A context (${ctxA.messages.length} messages):`);
for (const m of ctxA.messages) {
  console.log(`     ${m.role}: ${m.content}`);
}

const ctxB = buildSessionContext(sm2.getEntries(), id6);
console.log(`   Branch B context (${ctxB.messages.length} messages):`);
for (const m of ctxB.messages) {
  console.log(`     ${m.role}: ${m.content}`);
}

// --------------------------------------------------------------------------
// 6. Model change tracking
// --------------------------------------------------------------------------

console.log("\n6. Model change tracking...");
sm2.appendModelChange("openai", "gpt-4o");
sm2.appendMessage({ role: "user", content: "Explain type narrowing." });
sm2.appendMessage({
  role: "assistant",
  content: "Type narrowing refines types inside conditionals.",
});

const ctxWithModel = sm2.buildSessionContext();
console.log(`   Current model: ${ctxWithModel.model?.provider}/${ctxWithModel.model?.modelId}`);

// --------------------------------------------------------------------------
// 7. Compaction
// --------------------------------------------------------------------------

console.log("\n7. Compaction...");
const firstKeptId = sm2.getLeafId()!;
sm2.appendCompaction(
  "User asked about TypeScript, interfaces, and type narrowing.",
  firstKeptId,
  2500,
);
sm2.appendMessage({ role: "user", content: "What are mapped types?" });
sm2.appendMessage({
  role: "assistant",
  content: "Mapped types transform properties of existing types.",
});

const ctxCompacted = sm2.buildSessionContext();
console.log(`   Context after compaction (${ctxCompacted.messages.length} messages):`);
for (const m of ctxCompacted.messages) {
  console.log(`     ${m.role}: ${m.content.slice(0, 80)}`);
}

// --------------------------------------------------------------------------
// 8. Labels
// --------------------------------------------------------------------------

console.log("\n8. Labels (bookmarks)...");
sm2.appendLabelChange(id1, "first-question");
sm2.appendLabelChange(id5, "interfaces-branch");
console.log(`   Label on ${id1}: ${sm2.getLabel(id1)}`);
console.log(`   Label on ${id5}: ${sm2.getLabel(id5)}`);

// --------------------------------------------------------------------------
// 9. Fork to new session file
// --------------------------------------------------------------------------

console.log("\n9. Fork branch to new session file...");
const forkedFile = sm2.forkToNewSession(id6);
console.log(`   Forked file: ${forkedFile}`);

if (forkedFile) {
  const forked = SessionManager.open(forkedFile);
  console.log(`   Forked session entries: ${forked.getEntries().length}`);
  printBranch("Forked branch content", forked.getBranch());
}

// --------------------------------------------------------------------------
// 10. Session listing
// --------------------------------------------------------------------------

console.log("\n10. Listing sessions in directory...");
const sessions = SessionManager.list(DEMO_DIR);
console.log(`   Found ${sessions.length} session(s):`);
for (const s of sessions) {
  console.log(`     - ${s.id} | ${s.messageCount} msgs | "${s.firstMessage.slice(0, 40)}"`);
}

// --------------------------------------------------------------------------
// 11. In-memory session
// --------------------------------------------------------------------------

console.log("\n11. In-memory session (no file)...");
const mem = SessionManager.inMemory();
mem.appendMessage({ role: "user", content: "Hello from memory" });
mem.appendMessage({ role: "assistant", content: "I exist only in RAM." });
console.log(`   Session ID: ${mem.getSessionId()}`);
console.log(`   File: ${mem.getSessionFile() ?? "(none)"}`);
console.log(`   Entries: ${mem.getEntries().length}`);

// --------------------------------------------------------------------------
// 12. Verify JSONL file integrity
// --------------------------------------------------------------------------

console.log("\n12. JSONL file integrity check...");
const rawEntries = loadEntriesFromFile(sm.getSessionFile()!);
console.log(`   Raw lines in original file: ${rawEntries.length}`);
console.log(
  `   Header: version=${(rawEntries[0] as any).version}, id=${(rawEntries[0] as any).id}`,
);

// --------------------------------------------------------------------------
// Cleanup
// --------------------------------------------------------------------------

console.log("\n13. Cleaning up...");
rmSync(DEMO_DIR, { recursive: true, force: true });
console.log("   Done.");

console.log("\n=== Demo Complete ===");
