/**
 * Lesson 16 -- Demo: load both extensions and test interception patterns.
 *
 * This demo loads the plan and security extensions via the programmatic API
 * (loadExtensionFromFactory), wires them up with the ExtensionRunner, and
 * simulates the event pipeline to verify the extension patterns work.
 */

import type {
  ExtensionFactory,
  ToolCallEvent,
  ToolResultEvent,
} from "@my-agent/core";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
  ExtensionRunner,
  type ExtensionActions,
  type ContextActions,
} from "@my-agent/core";

import planExtension from "../extensions/plan-extension.js";
import securityExtension from "../extensions/security-extension.js";
import { getAuditLog } from "../extensions/security-extension.js";

// ---------------------------------------------------------------------------
// Main demo
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Lesson 16: Extension Practice Demo ===\n");

  // -----------------------------------------------------------------------
  // 1. Load both extensions
  // -----------------------------------------------------------------------

  const runtime = createExtensionRuntime();

  const planExt = await loadExtensionFromFactory(
    planExtension as ExtensionFactory,
    runtime,
    "<plan-extension>",
  );
  const securityExt = await loadExtensionFromFactory(
    securityExtension as ExtensionFactory,
    runtime,
    "<security-extension>",
  );

  console.log(`Loaded plan extension:`);
  console.log(`  Commands: ${Array.from(planExt.commands.keys()).join(", ")}`);
  console.log(`  Event handlers: ${Array.from(planExt.handlers.keys()).join(", ")}`);

  console.log(`\nLoaded security extension:`);
  console.log(`  Commands: ${Array.from(securityExt.commands.keys()).join(", ")}`);
  console.log(`  Event handlers: ${Array.from(securityExt.handlers.keys()).join(", ")}`);

  // -----------------------------------------------------------------------
  // 2. Create runner and bind core
  // -----------------------------------------------------------------------

  const runner = new ExtensionRunner(
    [planExt, securityExt],
    runtime,
    process.cwd(),
  );

  const actions: ExtensionActions = {
    sendMessage: (content) => console.log(`\n[host] sendMessage: ${content.slice(0, 80)}...`),
    setModel: (id) => console.log(`[host] setModel: ${id}`),
    getActiveTools: () => ["bash", "read", "write", "edit"],
    setActiveTools: (names) => console.log(`[host] setActiveTools: ${names.join(", ")}`),
  };

  const contextActions: ContextActions = {
    getCwd: () => process.cwd(),
    isIdle: () => true,
    abort: () => console.log("[host] abort"),
    getSystemPrompt: () => "You are a helpful coding assistant.",
  };

  runner.bindCore(actions, contextActions);
  console.log("\nRunner bound to core.\n");

  // -----------------------------------------------------------------------
  // 3. Test security extension: block dangerous command
  // -----------------------------------------------------------------------

  console.log("=== Test 1: Block dangerous bash command ===");
  const dangerousCall: ToolCallEvent = {
    type: "tool_call",
    toolCallId: "tc-1",
    toolName: "bash",
    input: { command: "rm -rf /tmp/important-data" },
  };
  const blockResult = await runner.emitToolCall(dangerousCall);
  console.log(`Blocked: ${blockResult?.block ?? false}`);
  console.log(`Reason: ${blockResult?.reason ?? "(none)"}`);

  // -----------------------------------------------------------------------
  // 4. Test security extension: allow safe command
  // -----------------------------------------------------------------------

  console.log("\n=== Test 2: Allow safe bash command ===");
  const safeCall: ToolCallEvent = {
    type: "tool_call",
    toolCallId: "tc-2",
    toolName: "bash",
    input: { command: "ls -la /tmp" },
  };
  const allowResult = await runner.emitToolCall(safeCall);
  console.log(`Blocked: ${allowResult?.block ?? false}`);

  // -----------------------------------------------------------------------
  // 5. Test security extension: redact sensitive output
  // -----------------------------------------------------------------------

  console.log("\n=== Test 3: Redact sensitive output ===");
  const sensitiveResult: ToolResultEvent = {
    type: "tool_result",
    toolCallId: "tc-3",
    toolName: "read",
    content:
      'DATABASE_URL=postgres://admin:supersecretpassword123@db.host.com:5432/mydb\n' +
      'API_KEY="sk-proj-abc123def456ghi789jkl012mno345"',
    isError: false,
  };
  const redacted = await runner.emitToolResult(sensitiveResult);
  if (redacted?.content) {
    console.log("Redacted output:");
    console.log(redacted.content);
  }

  // -----------------------------------------------------------------------
  // 6. Test plan extension: before_agent_start with plan mode
  // -----------------------------------------------------------------------

  console.log("\n=== Test 4: Plan extension injects into system prompt ===");
  // Simulate /plan command by calling the command handler directly
  const planCmd = planExt.commands.get("plan");
  if (planCmd) {
    await planCmd.handler("refactor the auth module to use JWT tokens");
  }

  // Now emit before_agent_start - plan extension should modify the system prompt
  const startResult = await runner.emitBeforeAgentStart(
    "Create a plan",
    "You are a helpful assistant.",
  );
  if (startResult?.systemPrompt) {
    console.log("\nSystem prompt now includes plan instructions:");
    // Show last 200 chars
    const prompt = startResult.systemPrompt;
    console.log(`...${prompt.slice(-200)}`);
  }

  // -----------------------------------------------------------------------
  // 7. Audit log summary
  // -----------------------------------------------------------------------

  console.log("\n=== Audit Log ===");
  const auditEntries = getAuditLog();
  console.log(`Total entries: ${auditEntries.length}`);
  for (const e of auditEntries) {
    const time = new Date(e.timestamp).toLocaleTimeString();
    console.log(`  [${time}] ${e.event.toUpperCase()} ${e.toolName}: ${e.detail}`);
  }

  // -----------------------------------------------------------------------
  // 8. Event flow summary
  // -----------------------------------------------------------------------

  console.log("\n=== Event Flow Summary ===");
  console.log(`
Extension loading flow:
1. Discovery - extensions found in .agent/extensions/ or via -e flag
2. Loading   - jiti transpiles TypeScript at runtime
3. Registration - extensions register handlers, tools, commands
4. Binding   - runner.bindCore() connects real action implementations
5. Runtime   - events flow through handlers in registration order

Event categories:
- OBSERVE:    agent_start, agent_end, turn_start, turn_end, session_start
- INTERCEPT:  tool_call (can block), tool_result (can modify)
- TRANSFORM:  before_agent_start (modify system prompt), context (modify messages)

Pipeline pattern:
- Multiple extensions handle the same event
- Results chain: each handler sees previous handler's output
- Blocking is short-circuit: first block wins
`);

  console.log("=== Demo complete ===");
}

main().catch(console.error);
