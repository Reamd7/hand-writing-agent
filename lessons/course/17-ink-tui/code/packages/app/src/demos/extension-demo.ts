/**
 * Lesson 15 -- Demo: load an extension that registers a tool.
 *
 * This demo shows the full lifecycle:
 * 1. Create runtime (with throwing stubs)
 * 2. Load extension from inline factory
 * 3. Create runner
 * 4. bindCore() to wire up real actions
 * 5. Emit events and execute tools
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

// ---------------------------------------------------------------------------
// 1. Define an extension (normally this would be a .ts file on disk)
// ---------------------------------------------------------------------------

const myExtension: ExtensionFactory = (api) => {
  // Register a tool
  api.registerTool({
    name: "timestamp",
    label: "Timestamp",
    description: "Returns the current Unix timestamp",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", description: "Output format: unix or iso" },
      },
      required: [],
    },
    async execute(_toolCallId, params, _signal, _ctx) {
      const format = (params.format as string) ?? "unix";
      const now = new Date();
      const content =
        format === "iso" ? now.toISOString() : String(Math.floor(now.getTime() / 1000));
      return { content, isError: false };
    },
  });

  // Listen to before_agent_start -- inject a line into the system prompt
  api.on("before_agent_start", (event) => {
    const extra =
      "\n\nYou have access to a timestamp tool. Use it when asked about the current time.";
    return { systemPrompt: event.systemPrompt + extra };
  });

  // Listen to tool_call -- log every tool invocation
  api.on("tool_call", (event) => {
    console.log(`[my-extension] tool_call: ${event.toolName}(${JSON.stringify(event.input)})`);
  });

  // Listen to tool_result -- append metadata to results
  api.on("tool_result", (event) => {
    if (event.toolName === "timestamp") {
      return { content: event.content + " [from timestamp extension]" };
    }
  });

  // Listen to context -- log message count before each LLM call
  api.on("context", (event) => {
    console.log(`[my-extension] context: ${event.messages.length} messages being sent to LLM`);
  });

  // Register a command
  api.registerCommand("time", {
    description: "Show current time",
    handler: async () => {
      const now = new Date().toLocaleTimeString();
      console.log(`Current time: ${now}`);
    },
  });

  // Register a keyboard shortcut
  api.registerShortcut("ctrl+t", {
    description: "Quick timestamp",
    handler: () => {
      console.log(`Timestamp: ${Date.now()}`);
    },
  });

  console.log("[my-extension] loaded");
};

// ---------------------------------------------------------------------------
// 2. Load the extension
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Extension API Demo ===\n");

  // Create shared runtime with throwing stubs
  const runtime = createExtensionRuntime();

  // Load extension from factory (no filesystem needed for this demo)
  const extension = await loadExtensionFromFactory(myExtension, runtime, "<demo>");

  console.log(`\nLoaded extension: ${extension.path}`);
  console.log(`  Tools: ${Array.from(extension.tools.keys()).join(", ")}`);
  console.log(`  Commands: ${Array.from(extension.commands.keys()).join(", ")}`);
  console.log(`  Shortcuts: ${Array.from(extension.shortcuts.keys()).join(", ")}`);
  console.log(`  Event handlers: ${Array.from(extension.handlers.keys()).join(", ")}`);

  // ---------------------------------------------------------------------------
  // 3. Create runner and bind core
  // ---------------------------------------------------------------------------

  const runner = new ExtensionRunner([extension], runtime, process.cwd());

  // Simulate host action implementations
  const actions: ExtensionActions = {
    sendMessage: (content) => console.log(`[host] sendMessage: ${content}`),
    setModel: (id) => console.log(`[host] setModel: ${id}`),
    getActiveTools: () => ["timestamp", "bash", "read"],
    setActiveTools: (names) => console.log(`[host] setActiveTools: ${names.join(", ")}`),
  };

  const contextActions: ContextActions = {
    getCwd: () => process.cwd(),
    isIdle: () => true,
    abort: () => console.log("[host] abort"),
    getSystemPrompt: () => "You are a helpful assistant.",
  };

  runner.bindCore(actions, contextActions);
  console.log("\nRunner bound to core.\n");

  // ---------------------------------------------------------------------------
  // 4. Simulate agent lifecycle
  // ---------------------------------------------------------------------------

  // Emit before_agent_start
  console.log("--- before_agent_start ---");
  const startResult = await runner.emitBeforeAgentStart(
    "What time is it?",
    "You are a helpful assistant.",
  );
  if (startResult?.systemPrompt) {
    console.log(`System prompt modified: ${startResult.systemPrompt.slice(-80)}...`);
  }

  // Emit context (messages going to LLM)
  console.log("\n--- context ---");
  const messages = await runner.emitContext([{ role: "user", content: "What time is it?" }]);
  console.log(`Messages after context handlers: ${messages.length}`);

  // Emit tool_call
  console.log("\n--- tool_call ---");
  const toolCallEvent: ToolCallEvent = {
    type: "tool_call",
    toolCallId: "call-1",
    toolName: "timestamp",
    input: { format: "iso" },
  };
  const callResult = await runner.emitToolCall(toolCallEvent);
  console.log(`Tool call result: ${JSON.stringify(callResult)}`);

  // Execute the tool
  console.log("\n--- tool execution ---");
  const tool = runner.getToolDefinition("timestamp");
  if (tool) {
    const ctx = runner.createContext();
    const result = await tool.execute("call-1", { format: "iso" }, undefined, ctx);
    console.log(`Tool output: ${result.content}`);

    // Emit tool_result
    console.log("\n--- tool_result ---");
    const resultEvent: ToolResultEvent = {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "timestamp",
      content: result.content,
      isError: false,
    };
    const modified = await runner.emitToolResult(resultEvent);
    if (modified) {
      console.log(`Modified result: ${modified.content}`);
    }
  }

  // Emit agent_end
  console.log("\n--- agent_end ---");
  await runner.emit({
    type: "agent_end",
    messages: [{ role: "assistant", content: "The current time is ..." }],
  });

  // ---------------------------------------------------------------------------
  // 5. Demonstrate invalidation
  // ---------------------------------------------------------------------------

  console.log("\n--- invalidation ---");
  runner.invalidate("Simulating /reload");
  try {
    runner.createContext().isIdle();
  } catch (err) {
    console.log(`Expected error: ${(err as Error).message}`);
  }

  console.log("\n=== Demo complete ===");
}

main().catch(console.error);
