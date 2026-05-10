// ============================================================================
// Lesson 4: Agent State and Event Model -- Test
//
// Manually push events through the Agent and verify state transitions.
// No LLM calls, no network -- pure state machine testing.
// ============================================================================

import { Agent } from "./agent.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${label}`);
  } else {
    failed++;
    console.error(`  [FAIL] ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  [PASS] ${label}`);
  } else {
    failed++;
    console.error(
      `  [FAIL] ${label} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const userMsg: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "Hello" }],
  timestamp: Date.now(),
};

const assistantMsg: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Hi there!" }],
  model: "test-model",
  provider: "test-provider",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  stopReason: "stop",
  timestamp: Date.now(),
};

const partialAssistantMsg: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Hi th" }],
  model: "test-model",
  provider: "test-provider",
  usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
  stopReason: "stop",
  timestamp: Date.now(),
};

const assistantWithToolCall: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "" },
    {
      type: "toolCall",
      id: "tc_001",
      name: "read_file",
      arguments: { path: "/tmp/test.txt" },
    },
  ],
  model: "test-model",
  provider: "test-provider",
  usage: { input: 10, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 18 },
  stopReason: "toolUse",
  timestamp: Date.now(),
};

const toolResultMsg: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "tc_001",
  toolName: "read_file",
  content: [{ type: "text", text: "file contents here" }],
  isError: false,
  timestamp: Date.now(),
};

const errorAssistantMsg: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "" }],
  model: "test-model",
  provider: "test-provider",
  usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
  stopReason: "error",
  errorMessage: "Rate limit exceeded",
  timestamp: Date.now(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testInitialState(): Promise<void> {
  console.log("\n--- Test: Initial state ---");

  const agent = new Agent();

  assertEqual(agent.state.systemPrompt, "", "systemPrompt defaults to empty string");
  assertEqual(agent.state.model.id, "unknown", "model defaults to unknown");
  assertEqual(agent.state.thinkingLevel, "off", "thinkingLevel defaults to off");
  assertEqual(agent.state.tools.length, 0, "tools defaults to empty array");
  assertEqual(agent.state.messages.length, 0, "messages defaults to empty array");
  assertEqual(agent.state.isStreaming, false, "isStreaming defaults to false");
  assertEqual(agent.state.streamingMessage, undefined, "streamingMessage defaults to undefined");
  assertEqual(agent.state.pendingToolCalls.size, 0, "pendingToolCalls defaults to empty set");
  assertEqual(agent.state.errorMessage, undefined, "errorMessage defaults to undefined");
}

async function testInitialStateWithOptions(): Promise<void> {
  console.log("\n--- Test: Initial state with options ---");

  const model = {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
    contextWindow: 128000,
    maxTokens: 4096,
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are helpful.",
      model,
      thinkingLevel: "high",
    },
  });

  assertEqual(agent.state.systemPrompt, "You are helpful.", "systemPrompt from options");
  assertEqual(agent.state.model.id, "gpt-4", "model from options");
  assertEqual(agent.state.thinkingLevel, "high", "thinkingLevel from options");
}

async function testCloneOnSet(): Promise<void> {
  console.log("\n--- Test: Clone-on-set for tools and messages ---");

  const agent = new Agent();

  // Assign messages and verify the internal array is a copy
  const externalMessages: AgentMessage[] = [userMsg];
  agent.state.messages = externalMessages;
  assertEqual(agent.state.messages.length, 1, "messages has 1 entry");

  // Mutating the external array should NOT affect agent state
  externalMessages.push(assistantMsg);
  assertEqual(agent.state.messages.length, 1, "external mutation does not affect agent state");

  // Verify tools clone-on-set similarly
  const externalTools = [
    {
      name: "test_tool",
      label: "Test",
      description: "A test tool",
      parameters: {},
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
    },
  ];
  agent.state.tools = externalTools;
  assertEqual(agent.state.tools.length, 1, "tools has 1 entry");

  externalTools.push({ ...externalTools[0], name: "another" });
  assertEqual(agent.state.tools.length, 1, "external tool mutation does not affect agent state");
}

async function testSubscribeUnsubscribe(): Promise<void> {
  console.log("\n--- Test: Subscribe and unsubscribe ---");

  const agent = new Agent();
  const events: string[] = [];

  const unsub = agent.subscribe((event) => {
    events.push(event.type);
  });

  const signal = await agent.startRun();
  await agent.pushEvent({ type: "agent_start" });
  assertEqual(events.length, 1, "listener received agent_start");
  assertEqual(events[0], "agent_start", "event type is agent_start");

  // Unsubscribe
  unsub();
  await agent.pushEvent({ type: "agent_end", messages: [] });
  assertEqual(events.length, 1, "unsubscribed listener does not receive agent_end");

  agent.finishRun();
}

async function testListenerOrder(): Promise<void> {
  console.log("\n--- Test: Listeners are called in subscription order ---");

  const agent = new Agent();
  const order: number[] = [];

  agent.subscribe(async () => {
    // Simulate async work
    await new Promise((r) => setTimeout(r, 10));
    order.push(1);
  });
  agent.subscribe(() => {
    order.push(2);
  });
  agent.subscribe(async () => {
    order.push(3);
  });

  const signal = await agent.startRun();
  await agent.pushEvent({ type: "agent_start" });

  assertEqual(order.length, 3, "all 3 listeners called");
  assertEqual(order[0], 1, "first listener called first");
  assertEqual(order[1], 2, "second listener called second");
  assertEqual(order[2], 3, "third listener called third");

  await agent.pushEvent({ type: "agent_end", messages: [] });
  agent.finishRun();
}

async function testAbortSignalPropagation(): Promise<void> {
  console.log("\n--- Test: AbortSignal propagation ---");

  const agent = new Agent();
  let receivedAborted = false;

  agent.subscribe((event, signal) => {
    receivedAborted = signal.aborted;
  });

  const signal = await agent.startRun();
  assert(!signal.aborted, "signal not aborted initially");

  agent.abort();
  await agent.pushEvent({ type: "agent_end", messages: [] });
  assert(receivedAborted, "listener sees aborted signal after abort()");

  agent.finishRun();
}

async function testMessageLifecycle(): Promise<void> {
  console.log("\n--- Test: Message lifecycle (start -> update -> end) ---");

  const agent = new Agent();
  const signal = await agent.startRun();

  // agent_start
  await agent.pushEvent({ type: "agent_start" });
  assert(agent.state.isStreaming, "isStreaming is true after startRun");

  // message_start -- streaming begins
  await agent.pushEvent({ type: "message_start", message: partialAssistantMsg });
  assert(agent.state.streamingMessage !== undefined, "streamingMessage is set on message_start");
  assertEqual(agent.state.messages.length, 0, "messages not yet updated");

  // message_update -- partial content arrives
  const updatedPartial: AssistantMessage = {
    ...partialAssistantMsg,
    content: [{ type: "text", text: "Hi there" }],
  };
  await agent.pushEvent({ type: "message_update", message: updatedPartial });
  assert(
    agent.state.streamingMessage !== undefined,
    "streamingMessage still set on message_update",
  );

  // message_end -- finalized
  await agent.pushEvent({ type: "message_end", message: assistantMsg });
  assertEqual(agent.state.streamingMessage, undefined, "streamingMessage cleared on message_end");
  assertEqual(agent.state.messages.length, 1, "message appended to messages on message_end");

  // agent_end
  await agent.pushEvent({ type: "agent_end", messages: [assistantMsg] });
  agent.finishRun();
  assert(!agent.state.isStreaming, "isStreaming is false after finishRun");
}

async function testToolExecutionLifecycle(): Promise<void> {
  console.log("\n--- Test: Tool execution lifecycle ---");

  const agent = new Agent();
  const signal = await agent.startRun();

  await agent.pushEvent({ type: "agent_start" });
  await agent.pushEvent({ type: "turn_start" });

  // Assistant message with tool call
  await agent.pushEvent({ type: "message_start", message: assistantWithToolCall });
  await agent.pushEvent({ type: "message_end", message: assistantWithToolCall });
  assertEqual(agent.state.messages.length, 1, "assistant message appended");

  // Tool execution starts
  await agent.pushEvent({
    type: "tool_execution_start",
    toolCallId: "tc_001",
    toolName: "read_file",
    args: { path: "/tmp/test.txt" },
  });
  assert(agent.state.pendingToolCalls.has("tc_001"), "tc_001 in pendingToolCalls after start");
  assertEqual(agent.state.pendingToolCalls.size, 1, "pendingToolCalls has 1 entry");

  // Tool execution ends
  await agent.pushEvent({
    type: "tool_execution_end",
    toolCallId: "tc_001",
    toolName: "read_file",
    result: { content: [{ type: "text", text: "file contents" }], details: {} },
    isError: false,
  });
  assert(
    !agent.state.pendingToolCalls.has("tc_001"),
    "tc_001 removed from pendingToolCalls after end",
  );
  assertEqual(agent.state.pendingToolCalls.size, 0, "pendingToolCalls is empty");

  // Tool result message
  await agent.pushEvent({ type: "message_start", message: toolResultMsg });
  await agent.pushEvent({ type: "message_end", message: toolResultMsg });
  assertEqual(agent.state.messages.length, 2, "tool result appended to messages");

  await agent.pushEvent({
    type: "turn_end",
    message: assistantWithToolCall,
    toolResults: [toolResultMsg],
  });
  await agent.pushEvent({ type: "agent_end", messages: [] });
  agent.finishRun();
}

async function testMultiplePendingToolCalls(): Promise<void> {
  console.log("\n--- Test: Multiple pending tool calls (parallel) ---");

  const agent = new Agent();
  const signal = await agent.startRun();

  await agent.pushEvent({ type: "agent_start" });

  // Start two tool executions
  await agent.pushEvent({
    type: "tool_execution_start",
    toolCallId: "tc_A",
    toolName: "tool_a",
    args: {},
  });
  await agent.pushEvent({
    type: "tool_execution_start",
    toolCallId: "tc_B",
    toolName: "tool_b",
    args: {},
  });
  assertEqual(agent.state.pendingToolCalls.size, 2, "2 pending tool calls");
  assert(agent.state.pendingToolCalls.has("tc_A"), "tc_A is pending");
  assert(agent.state.pendingToolCalls.has("tc_B"), "tc_B is pending");

  // End one
  await agent.pushEvent({
    type: "tool_execution_end",
    toolCallId: "tc_A",
    toolName: "tool_a",
    result: { content: [{ type: "text", text: "done" }], details: {} },
    isError: false,
  });
  assertEqual(agent.state.pendingToolCalls.size, 1, "1 pending tool call after tc_A ends");
  assert(!agent.state.pendingToolCalls.has("tc_A"), "tc_A no longer pending");
  assert(agent.state.pendingToolCalls.has("tc_B"), "tc_B still pending");

  // End the other
  await agent.pushEvent({
    type: "tool_execution_end",
    toolCallId: "tc_B",
    toolName: "tool_b",
    result: { content: [{ type: "text", text: "done" }], details: {} },
    isError: false,
  });
  assertEqual(agent.state.pendingToolCalls.size, 0, "0 pending after both end");

  await agent.pushEvent({ type: "agent_end", messages: [] });
  agent.finishRun();
}

async function testPendingToolCallsReferenceImmutability(): Promise<void> {
  console.log("\n--- Test: pendingToolCalls reference changes on each update ---");

  const agent = new Agent();
  const signal = await agent.startRun();
  await agent.pushEvent({ type: "agent_start" });

  const refBefore = agent.state.pendingToolCalls;

  await agent.pushEvent({
    type: "tool_execution_start",
    toolCallId: "tc_X",
    toolName: "tool_x",
    args: {},
  });

  const refAfter = agent.state.pendingToolCalls;
  assert(
    refBefore !== refAfter,
    "pendingToolCalls is a new Set instance after tool_execution_start",
  );

  await agent.pushEvent({
    type: "tool_execution_end",
    toolCallId: "tc_X",
    toolName: "tool_x",
    result: { content: [{ type: "text", text: "" }], details: {} },
    isError: false,
  });

  const refFinal = agent.state.pendingToolCalls;
  assert(refAfter !== refFinal, "pendingToolCalls is a new Set instance after tool_execution_end");

  await agent.pushEvent({ type: "agent_end", messages: [] });
  agent.finishRun();
}

async function testErrorMessageOnTurnEnd(): Promise<void> {
  console.log("\n--- Test: errorMessage set on turn_end with failed assistant ---");

  const agent = new Agent();
  const signal = await agent.startRun();

  await agent.pushEvent({ type: "agent_start" });
  await agent.pushEvent({ type: "turn_start" });
  await agent.pushEvent({ type: "message_start", message: errorAssistantMsg });
  await agent.pushEvent({ type: "message_end", message: errorAssistantMsg });

  assertEqual(agent.state.errorMessage, undefined, "errorMessage not set before turn_end");

  await agent.pushEvent({ type: "turn_end", message: errorAssistantMsg, toolResults: [] });
  assertEqual(agent.state.errorMessage, "Rate limit exceeded", "errorMessage set on turn_end");

  await agent.pushEvent({ type: "agent_end", messages: [errorAssistantMsg] });
  agent.finishRun();
}

async function testReset(): Promise<void> {
  console.log("\n--- Test: reset() clears state ---");

  const agent = new Agent();
  agent.state.messages = [userMsg, assistantMsg];
  assertEqual(agent.state.messages.length, 2, "messages has 2 entries before reset");

  agent.reset();
  assertEqual(agent.state.messages.length, 0, "messages empty after reset");
  assertEqual(agent.state.isStreaming, false, "isStreaming false after reset");
  assertEqual(agent.state.streamingMessage, undefined, "streamingMessage undefined after reset");
  assertEqual(agent.state.pendingToolCalls.size, 0, "pendingToolCalls empty after reset");
  assertEqual(agent.state.errorMessage, undefined, "errorMessage undefined after reset");
}

async function testWaitForIdle(): Promise<void> {
  console.log("\n--- Test: waitForIdle() resolves after finishRun ---");

  const agent = new Agent();

  // No active run -- resolves immediately
  await agent.waitForIdle();
  assert(true, "waitForIdle resolves immediately when no run is active");

  const signal = await agent.startRun();
  let idleResolved = false;

  // waitForIdle should not resolve until finishRun
  const idlePromise = agent.waitForIdle().then(() => {
    idleResolved = true;
  });

  // Push some events
  await agent.pushEvent({ type: "agent_start" });
  await agent.pushEvent({ type: "agent_end", messages: [] });
  assert(!idleResolved, "waitForIdle not resolved before finishRun");

  agent.finishRun();
  await idlePromise;
  assert(idleResolved, "waitForIdle resolved after finishRun");
}

async function testFullRunSimulation(): Promise<void> {
  console.log("\n--- Test: Full run simulation ---");

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant.",
      model: {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        contextWindow: 128000,
        maxTokens: 4096,
      },
    },
  });

  // Collect all events
  const collectedEvents: AgentEvent[] = [];
  agent.subscribe((event) => {
    collectedEvents.push(event);
  });

  const signal = await agent.startRun();

  // Simulate: user sends message, assistant replies with tool call,
  // tool executes, tool result message, assistant sends final reply.

  // agent_start
  await agent.pushEvent({ type: "agent_start" });

  // Turn 1: user message + assistant with tool call
  await agent.pushEvent({ type: "turn_start" });
  await agent.pushEvent({ type: "message_start", message: userMsg });
  await agent.pushEvent({ type: "message_end", message: userMsg });
  await agent.pushEvent({ type: "message_start", message: assistantWithToolCall });
  await agent.pushEvent({ type: "message_end", message: assistantWithToolCall });

  // Tool execution
  await agent.pushEvent({
    type: "tool_execution_start",
    toolCallId: "tc_001",
    toolName: "read_file",
    args: { path: "/tmp/test.txt" },
  });
  await agent.pushEvent({
    type: "tool_execution_end",
    toolCallId: "tc_001",
    toolName: "read_file",
    result: { content: [{ type: "text", text: "file contents" }], details: {} },
    isError: false,
  });

  // Tool result message
  await agent.pushEvent({ type: "message_start", message: toolResultMsg });
  await agent.pushEvent({ type: "message_end", message: toolResultMsg });
  await agent.pushEvent({
    type: "turn_end",
    message: assistantWithToolCall,
    toolResults: [toolResultMsg],
  });

  // Turn 2: assistant final reply
  await agent.pushEvent({ type: "turn_start" });
  await agent.pushEvent({ type: "message_start", message: assistantMsg });
  await agent.pushEvent({ type: "message_end", message: assistantMsg });
  await agent.pushEvent({ type: "turn_end", message: assistantMsg, toolResults: [] });

  // agent_end
  await agent.pushEvent({
    type: "agent_end",
    messages: [userMsg, assistantWithToolCall, toolResultMsg, assistantMsg],
  });

  agent.finishRun();

  // Verify final state
  assertEqual(agent.state.messages.length, 4, "4 messages in transcript");
  assertEqual(agent.state.messages[0].role, "user", "first message is user");
  assertEqual(agent.state.messages[1].role, "assistant", "second message is assistant");
  assertEqual(agent.state.messages[2].role, "toolResult", "third message is toolResult");
  assertEqual(agent.state.messages[3].role, "assistant", "fourth message is assistant");
  assert(!agent.state.isStreaming, "isStreaming false after run");
  assertEqual(agent.state.pendingToolCalls.size, 0, "no pending tool calls");
  assertEqual(agent.state.errorMessage, undefined, "no error message");

  // Verify collected events
  const eventTypes = collectedEvents.map((e) => e.type);
  assertEqual(eventTypes[0], "agent_start", "first event is agent_start");
  assertEqual(eventTypes[eventTypes.length - 1], "agent_end", "last event is agent_end");
  assert(eventTypes.includes("tool_execution_start"), "events include tool_execution_start");
  assert(eventTypes.includes("tool_execution_end"), "events include tool_execution_end");
  assertEqual(collectedEvents.length, 16, "16 total events in full simulation");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Lesson 4: Agent State and Event Model -- Tests ===\n");

  await testInitialState();
  await testInitialStateWithOptions();
  await testCloneOnSet();
  await testSubscribeUnsubscribe();
  await testListenerOrder();
  await testAbortSignalPropagation();
  await testMessageLifecycle();
  await testToolExecutionLifecycle();
  await testMultiplePendingToolCalls();
  await testPendingToolCallsReferenceImmutability();
  await testErrorMessageOnTurnEnd();
  await testReset();
  await testWaitForIdle();
  await testFullRunSimulation();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
