// ============================================================================
// Lesson 7: Steering and Follow-up Queues -- Demo
//
// Demonstrates:
// 1. PendingMessageQueue "all" vs "one-at-a-time" drain modes
// 2. Steering: inject a correction while the agent is running
// 3. Follow-up: automatically continue after the agent finishes
// 4. shouldStopAfterTurn: force-stop after a certain number of turns
// ============================================================================

import { Agent } from "./agent.js";
import { PendingMessageQueue } from "./pending-queue.js";
import type { AgentMessage, AssistantMessage, Usage } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "fake-model",
    provider: "fake",
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function separator(title: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}\n`);
}

// ---------------------------------------------------------------------------
// Demo 1: PendingMessageQueue drain modes
// ---------------------------------------------------------------------------

function demoDrainModes(): void {
  separator("Demo 1: PendingMessageQueue drain modes");

  const msg1 = makeUserMessage("first");
  const msg2 = makeUserMessage("second");
  const msg3 = makeUserMessage("third");

  // "all" mode
  const allQueue = new PendingMessageQueue("all");
  allQueue.enqueue(msg1);
  allQueue.enqueue(msg2);
  allQueue.enqueue(msg3);

  const allDrained = allQueue.drain();
  console.log(`[all] drain() returned ${allDrained.length} messages`);
  console.log(`[all] hasItems after drain: ${allQueue.hasItems()}`);

  // "one-at-a-time" mode
  const oneQueue = new PendingMessageQueue("one-at-a-time");
  oneQueue.enqueue(msg1);
  oneQueue.enqueue(msg2);
  oneQueue.enqueue(msg3);

  const first = oneQueue.drain();
  console.log(`\n[one-at-a-time] first drain(): ${first.length} message`);
  console.log(`[one-at-a-time] hasItems: ${oneQueue.hasItems()} (${oneQueue.length} remaining)`);

  const second = oneQueue.drain();
  console.log(`[one-at-a-time] second drain(): ${second.length} message`);
  console.log(`[one-at-a-time] hasItems: ${oneQueue.hasItems()} (${oneQueue.length} remaining)`);

  const third = oneQueue.drain();
  console.log(`[one-at-a-time] third drain(): ${third.length} message`);
  console.log(`[one-at-a-time] hasItems: ${oneQueue.hasItems()}`);

  const empty = oneQueue.drain();
  console.log(`[one-at-a-time] fourth drain() (empty): ${empty.length} messages`);
}

// ---------------------------------------------------------------------------
// Demo 2: Steering -- inject a correction during a run
// ---------------------------------------------------------------------------

async function demoSteering(): Promise<void> {
  separator("Demo 2: Steering -- inject correction during run");

  // Track which call we are on to simulate different responses
  let callCount = 0;
  const responseQueue: AssistantMessage[] = [
    makeAssistantMessage("I'll search in the tests directory..."),
    makeAssistantMessage("OK, searching in src/ instead. Found the file."),
  ];

  const agent = new Agent({
    callLlm: async () => {
      const response = responseQueue[callCount] ?? makeAssistantMessage("Done.");
      callCount++;
      return response;
    },
  });

  // Subscribe to events for logging
  const events: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "message_end" && "role" in event.message) {
      const msg = event.message;
      if (msg.role === "user") {
        const text = msg.content.find((c) => c.type === "text");
        if (text && text.type === "text") events.push(`[user] ${text.text}`);
      } else if (msg.role === "assistant") {
        const text = msg.content.find((c) => c.type === "text");
        if (text && text.type === "text") events.push(`[assistant] ${text.text}`);
      }
    }
  });

  // Queue a steering message BEFORE prompting
  // (simulates user typing while agent starts up)
  agent.steer(makeUserMessage("Don't search tests/, use src/ instead"));

  // Start the agent
  await agent.prompt("Find the config file");
  await agent.waitForIdle();

  console.log("Event log:");
  for (const e of events) {
    console.log(`  ${e}`);
  }
  console.log(`\nTotal messages in state: ${agent.state.messages.length}`);
  console.log(`isStreaming: ${agent.state.isStreaming}`);
}

// ---------------------------------------------------------------------------
// Demo 3: Follow-up -- automatic continuation after agent finishes
// ---------------------------------------------------------------------------

async function demoFollowUp(): Promise<void> {
  separator("Demo 3: Follow-up -- auto-continue after completion");

  let callCount = 0;
  const responseQueue: AssistantMessage[] = [
    makeAssistantMessage("Bug fixed in parser.ts"),
    makeAssistantMessage("All 42 tests passed."),
  ];

  const agent = new Agent({
    callLlm: async () => {
      const response = responseQueue[callCount] ?? makeAssistantMessage("Done.");
      callCount++;
      return response;
    },
  });

  const events: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "message_end" && "role" in event.message) {
      const msg = event.message;
      if (msg.role === "user") {
        const text = msg.content.find((c) => c.type === "text");
        if (text && text.type === "text") events.push(`[user] ${text.text}`);
      } else if (msg.role === "assistant") {
        const text = msg.content.find((c) => c.type === "text");
        if (text && text.type === "text") events.push(`[assistant] ${text.text}`);
      }
    }
  });

  // Queue a follow-up BEFORE prompting
  // This will only be processed after the first prompt completes
  agent.followUp(makeUserMessage("Now run the tests"));

  await agent.prompt("Fix the bug in parser.ts");
  await agent.waitForIdle();

  console.log("Event log:");
  for (const e of events) {
    console.log(`  ${e}`);
  }
  console.log(`\nTotal messages in state: ${agent.state.messages.length}`);
}

// ---------------------------------------------------------------------------
// Demo 4: shouldStopAfterTurn -- force-stop after max turns
// ---------------------------------------------------------------------------

async function demoShouldStop(): Promise<void> {
  separator("Demo 4: shouldStopAfterTurn -- max turn limit");

  let callCount = 0;
  const agent = new Agent({
    callLlm: async () => {
      callCount++;
      return makeAssistantMessage(`Response #${callCount}`);
    },
    shouldStopAfterTurn: ({ newMessages }) => {
      // Count assistant messages in this run
      const assistantCount = newMessages.filter(
        (m) => "role" in m && m.role === "assistant",
      ).length;
      const shouldStop = assistantCount >= 2;
      if (shouldStop) {
        console.log(`  [hook] shouldStopAfterTurn -> true (${assistantCount} assistant messages)`);
      }
      return shouldStop;
    },
  });

  const events: string[] = [];
  agent.subscribe((event) => {
    if (event.type === "message_end" && "role" in event.message) {
      const msg = event.message;
      if (msg.role === "assistant") {
        const text = msg.content.find((c) => c.type === "text");
        if (text && text.type === "text") events.push(`[assistant] ${text.text}`);
      }
    }
  });

  // Queue multiple steering messages -- only some will be processed before stop
  agent.steer(makeUserMessage("steering 1"));
  agent.steer(makeUserMessage("steering 2"));
  agent.steer(makeUserMessage("steering 3"));

  await agent.prompt("Start");
  await agent.waitForIdle();

  console.log("\nEvent log:");
  for (const e of events) {
    console.log(`  ${e}`);
  }
  console.log(`\nTotal assistant responses: ${callCount}`);
  console.log(`Queued messages remaining: ${agent.hasQueuedMessages()}`);
}

// ---------------------------------------------------------------------------
// Run all demos
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  demoDrainModes();
  await demoSteering();
  await demoFollowUp();
  await demoShouldStop();

  separator("All demos complete");
}

main().catch(console.error);
