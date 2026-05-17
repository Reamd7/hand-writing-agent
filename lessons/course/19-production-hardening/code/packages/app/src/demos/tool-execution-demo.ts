// ============================================================================
// Lesson 6: Demo -- Watch the full tool execution cycle
//
// Simulates a prompt that triggers tool calls. The fake LLM returns
// assistant messages with toolCall content blocks, and the loop executes
// them through the 3-stage pipeline (prepare -> execute -> finalize).
//
// Demonstrates:
//   1. A simple tool call (get_weather) with successful execution
//   2. Parallel execution of two tool calls (get_weather x2)
//   3. beforeToolCall blocking a dangerous tool (delete_file)
//   4. afterToolCall overriding a result (add disclaimer to web_search)
//   5. A tool that uses onUpdate for progress reporting
//   6. Batch termination via terminate:true
//   7. Sequential execution forced by per-tool executionMode
// ============================================================================

import type {
  AgentContext,
  AgentLoopConfig,
  AgentTool,
  AssistantMessage,
} from "@my-agent/core";
import { runToolExecutionLoop } from "@my-agent/core";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const getWeatherTool: AgentTool = {
  name: "get_weather",
  label: "Get Weather",
  description: "Get the current weather for a location",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string" },
    },
    required: ["location"],
  },
  async execute(id, args) {
    const location = (args as { location: string }).location;
    // Simulate a short delay
    await new Promise((r) => setTimeout(r, 50));
    const temp = 15 + Math.floor(Math.random() * 20);
    return {
      content: [{ type: "text", text: `${location}: ${temp}C, sunny` }],
      details: { temperature: temp, condition: "sunny" },
    };
  },
};

const deleteFileTool: AgentTool = {
  name: "delete_file",
  label: "Delete File",
  description: "Delete a file from the filesystem",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
  },
  async execute(id, args) {
    // This should never actually run in the demo (blocked by beforeToolCall)
    return {
      content: [{ type: "text", text: `Deleted: ${(args as { path: string }).path}` }],
      details: {},
    };
  },
};

const webSearchTool: AgentTool = {
  name: "web_search",
  label: "Web Search",
  description: "Search the web for information",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
  async execute(id, args) {
    await new Promise((r) => setTimeout(r, 30));
    return {
      content: [{ type: "text", text: `Results for: ${(args as { query: string }).query}` }],
      details: { resultCount: 42 },
    };
  },
};

const longRunningTool: AgentTool = {
  name: "compile_project",
  label: "Compile Project",
  description: "Compile the project (long-running, uses onUpdate)",
  parameters: {
    type: "object",
    properties: {
      target: { type: "string" },
    },
  },
  // This tool reports progress via onUpdate
  async execute(id, args, _signal, onUpdate) {
    const target = (args as { target?: string }).target || "production";

    onUpdate?.({
      content: [{ type: "text", text: "Compiling..." }],
      details: { phase: "compile", progress: 0.3 },
    });
    await new Promise((r) => setTimeout(r, 80));

    onUpdate?.({
      content: [{ type: "text", text: "Linking..." }],
      details: { phase: "link", progress: 0.7 },
    });
    await new Promise((r) => setTimeout(r, 80));

    return {
      content: [{ type: "text", text: `Build complete (${target})` }],
      details: { phase: "done", progress: 1.0 },
    };
  },
};

const submitAnswerTool: AgentTool = {
  name: "submit_answer",
  label: "Submit Answer",
  description: "Submit the final answer and terminate",
  parameters: {
    type: "object",
    properties: {
      answer: { type: "string" },
    },
    required: ["answer"],
  },
  async execute(id, args) {
    return {
      content: [{ type: "text", text: (args as { answer: string }).answer }],
      details: {},
      terminate: true, // Signal batch termination
    };
  },
};

const sequentialDbTool: AgentTool = {
  name: "db_write",
  label: "Database Write",
  description: "Write to database (must be sequential)",
  parameters: {
    type: "object",
    properties: {
      table: { type: "string" },
      data: { type: "string" },
    },
  },
  executionMode: "sequential", // Forces entire batch to be sequential
  async execute(id, args) {
    await new Promise((r) => setTimeout(r, 40));
    const { table, data } = args as { table: string; data: string };
    return {
      content: [{ type: "text", text: `Wrote to ${table}: ${data}` }],
      details: { table },
    };
  },
};

// ---------------------------------------------------------------------------
// All tools
// ---------------------------------------------------------------------------

const allTools: AgentTool[] = [
  getWeatherTool,
  deleteFileTool,
  webSearchTool,
  longRunningTool,
  submitAnswerTool,
  sequentialDbTool,
];

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

let scenarioCallCount = 0;

function createConfig(
  responses: AssistantMessage[],
  overrides?: Partial<AgentLoopConfig>,
): AgentLoopConfig {
  scenarioCallCount = 0;
  return {
    model: {
      id: "fake-model",
      name: "Fake Model",
      api: "openai-completions",
      provider: "fake",
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
    streamFn: async () => {
      const response = responses[scenarioCallCount];
      scenarioCallCount++;
      if (!response) {
        // Default: model says "done" with no tool calls
        return {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          api: "openai-completions",
          model: "fake-model",
          provider: "fake",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        };
      }
      return response;
    },
    ...overrides,
  };
}

function createContext(): AgentContext {
  return {
    systemPrompt: "You are a helpful assistant.",
    messages: [],
    tools: allTools,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Simple tool call
// Model calls get_weather, then responds with text.
// ---------------------------------------------------------------------------

async function scenario1() {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 1: Simple tool call (get_weather)");
  console.log("=".repeat(70));

  const config = createConfig([
    // Turn 1: Model calls get_weather
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check the weather." },
        {
          type: "toolCall",
          id: "tc_1",
          name: "get_weather",
          arguments: { location: "Tokyo" },
        },
      ],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    // Turn 2: Model responds with final text
    {
      role: "assistant",
      content: [{ type: "text", text: "The weather in Tokyo is nice today!" }],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ]);

  await runToolExecutionLoop("What's the weather in Tokyo?", createContext(), config);
}

// ---------------------------------------------------------------------------
// Scenario 2: Parallel tool calls
// Model calls get_weather twice in one message. Both execute concurrently.
// ---------------------------------------------------------------------------

async function scenario2() {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 2: Parallel tool calls (get_weather x2)");
  console.log("=".repeat(70));

  const config = createConfig([
    // Turn 1: Two parallel tool calls
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc_a",
          name: "get_weather",
          arguments: { location: "London" },
        },
        {
          type: "toolCall",
          id: "tc_b",
          name: "get_weather",
          arguments: { location: "Paris" },
        },
      ],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    // Turn 2: Summary
    {
      role: "assistant",
      content: [{ type: "text", text: "London and Paris weather compared!" }],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ]);

  await runToolExecutionLoop("Compare weather in London and Paris", createContext(), config);
}

// ---------------------------------------------------------------------------
// Scenario 3: beforeToolCall blocks a dangerous tool
// Model tries to call delete_file, but the hook blocks it.
// ---------------------------------------------------------------------------

async function scenario3() {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 3: beforeToolCall blocks delete_file");
  console.log("=".repeat(70));

  const config = createConfig(
    [
      // Turn 1: Model tries to delete a file
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc_del",
            name: "delete_file",
            arguments: { path: "/etc/passwd" },
          },
        ],
        api: "openai-completions",
        model: "fake-model",
        provider: "fake",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      // Turn 2: Model acknowledges the block
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I understand, I cannot delete that file.",
          },
        ],
        api: "openai-completions",
        model: "fake-model",
        provider: "fake",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ],
    {
      // beforeToolCall hook: block delete_file
      beforeToolCall: async (ctx) => {
        if (ctx.toolCall.name === "delete_file") {
          console.log("  [beforeToolCall] BLOCKING delete_file!");
          return { block: true, reason: "File deletion is not allowed" };
        }
        return undefined;
      },
    },
  );

  await runToolExecutionLoop("Delete /etc/passwd", createContext(), config);
}

// ---------------------------------------------------------------------------
// Scenario 4: afterToolCall overrides a result
// Model calls web_search, afterToolCall adds a disclaimer.
// ---------------------------------------------------------------------------

async function scenario4() {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 4: afterToolCall overrides web_search result");
  console.log("=".repeat(70));

  const config = createConfig(
    [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc_ws",
            name: "web_search",
            arguments: { query: "TypeScript generics" },
          },
        ],
        api: "openai-completions",
        model: "fake-model",
        provider: "fake",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the search results." }],
        api: "openai-completions",
        model: "fake-model",
        provider: "fake",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ],
    {
      // afterToolCall hook: add disclaimer to web_search results
      afterToolCall: async (ctx) => {
        if (ctx.toolCall.name === "web_search") {
          console.log("  [afterToolCall] Adding disclaimer to web_search result");
          return {
            content: [
              ...ctx.result.content,
              {
                type: "text" as const,
                text: "\n[Disclaimer: results may be outdated]",
              },
            ],
          };
        }
        return undefined;
      },
    },
  );

  await runToolExecutionLoop("Search for TypeScript generics", createContext(), config);
}

// ---------------------------------------------------------------------------
// Scenario 5: onUpdate progress reporting
// Model calls compile_project which uses onUpdate callbacks.
// ---------------------------------------------------------------------------

async function scenario5() {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 5: Tool with onUpdate progress (compile_project)");
  console.log("=".repeat(70));

  const config = createConfig([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc_build",
          name: "compile_project",
          arguments: { target: "release" },
        },
      ],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Build completed successfully!" }],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ]);

  await runToolExecutionLoop("Build the project for release", createContext(), config);
}

// ---------------------------------------------------------------------------
// Scenario 6: Batch termination
// Model calls submit_answer (terminate:true). Loop stops after this batch.
// ---------------------------------------------------------------------------

async function scenario6() {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 6: Batch termination via terminate:true");
  console.log("=".repeat(70));

  const config = createConfig([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc_answer",
          name: "submit_answer",
          arguments: { answer: "The answer is 42." },
        },
      ],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    // This response should NOT be reached because terminate:true stops the loop
    {
      role: "assistant",
      content: [{ type: "text", text: "This should not appear." }],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ]);

  await runToolExecutionLoop("What is the answer?", createContext(), config);
}

// ---------------------------------------------------------------------------
// Scenario 7: Sequential execution forced by per-tool executionMode
// Model calls db_write (sequential) + get_weather (parallel).
// The db_write forces the entire batch to run sequentially.
// ---------------------------------------------------------------------------

async function scenario7() {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 7: Sequential execution (db_write forces batch sequential)");
  console.log("=".repeat(70));

  const config = createConfig([
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc_db",
          name: "db_write",
          arguments: { table: "users", data: "Alice" },
        },
        {
          type: "toolCall",
          id: "tc_w",
          name: "get_weather",
          arguments: { location: "Berlin" },
        },
      ],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "Database updated and weather checked." }],
      api: "openai-completions",
      model: "fake-model",
      provider: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ]);

  await runToolExecutionLoop("Save Alice to users and check Berlin weather", createContext(), config);
}

// ---------------------------------------------------------------------------
// Run all scenarios
// ---------------------------------------------------------------------------

async function main() {
  console.log("Lesson 6 Demo: Tool Call Execution Engine");
  console.log("==========================================");

  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();

  console.log("\nAll scenarios completed.");
}

main().catch(console.error);
