// ============================================================================
// Lesson 5: Agent Loop (Part 1) -- Demo
//
// Send a simple prompt, watch events flow through the pipeline.
//
// Usage:
//   OPENAI_API_KEY=sk-... npx tsx src/demo.ts
//
// What this demonstrates:
// 1. createContextSnapshot() isolates the loop from external state
// 2. streamAssistantResponse() streams text and emits events
// 3. runAgentLoop() orchestrates the full single-turn flow
// 4. Every AgentEvent is logged so you can see the lifecycle
// ============================================================================

import { openai } from "@ai-sdk/openai";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AssistantMessage,
  UserMessage,
} from "./types.js";
import { createContextSnapshot, defaultConvertToLlm } from "./context.js";
import { runAgentLoop } from "./agent-loop.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MODEL_ID = process.env.MODEL_ID ?? "gpt-4o-mini";

const loopConfig: AgentLoopConfig = {
  languageModel: openai(MODEL_ID),
  model: {
    id: MODEL_ID,
    name: MODEL_ID,
    provider: "openai",
    contextWindow: 128000,
    maxTokens: 4096,
  },
  convertToLlm: defaultConvertToLlm,
};

// ---------------------------------------------------------------------------
// Event logger -- acts as a simple "processEvents" / subscriber
// ---------------------------------------------------------------------------

/**
 * Log every event with formatting.
 * In a real Agent, this would be processEvents() updating _state
 * and then fanning out to subscribers.
 */
async function eventLogger(event: AgentEvent): Promise<void> {
  switch (event.type) {
    case "agent_start":
      console.log("\n=== AGENT START ===\n");
      break;

    case "turn_start":
      console.log("--- Turn Start ---");
      break;

    case "message_start":
      if (event.message.role === "user") {
        const userMsg = event.message as UserMessage;
        const text = userMsg.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        console.log(`[message_start] User: "${text}"`);
      } else if (event.message.role === "assistant") {
        console.log("[message_start] Assistant (streaming begins)");
      }
      break;

    case "message_update": {
      // Print the delta character by character (streaming effect)
      if (event.delta) {
        process.stdout.write(event.delta);
      }
      break;
    }

    case "message_end": {
      if (event.message.role === "assistant") {
        const assistantMsg = event.message as AssistantMessage;
        console.log(); // newline after streaming
        console.log(
          `[message_end] Assistant finished. stopReason=${assistantMsg.stopReason}, ` +
            `tokens: in=${assistantMsg.usage.input}, out=${assistantMsg.usage.output}`,
        );
      } else {
        console.log(`[message_end] ${event.message.role}`);
      }
      break;
    }

    case "turn_end":
      console.log("--- Turn End ---");
      break;

    case "agent_end":
      console.log(`\n=== AGENT END (${event.messages.length} new messages) ===\n`);
      break;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is required.");
    console.error("Usage: OPENAI_API_KEY=sk-... npx tsx src/demo.ts");
    process.exit(1);
  }

  // Simulate: the Agent holds messages in its _state
  const agentMessages: AgentMessage[] = [];
  const systemPrompt = "You are a concise assistant. Keep replies under 100 words.";

  // Step 1: Create a context snapshot (like Agent.createContextSnapshot())
  const context: AgentContext = createContextSnapshot(systemPrompt, agentMessages);

  // Step 2: Create the user prompt
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: "Explain what an agent loop is in 2 sentences." }],
    timestamp: Date.now(),
  };

  // Step 3: Run the agent loop
  const promptText = userMessage.content[0];
  console.log(
    "Running agent loop with prompt:",
    promptText.type === "text" ? promptText.text : "(image)",
  );
  console.log("Model:", MODEL_ID);

  const newMessages = await runAgentLoop([userMessage], context, loopConfig, eventLogger);

  // Step 4: Show the results
  console.log("--- Final message list ---");
  for (const msg of newMessages) {
    if (msg.role === "user") {
      const userMsg = msg as UserMessage;
      const text = userMsg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      console.log(`  [user] ${text}`);
    } else if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      const text = assistantMsg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      console.log(`  [assistant] ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);
    }
  }
}

main().catch(console.error);
