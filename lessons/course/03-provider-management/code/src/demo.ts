/**
 * Lesson 3 Demo: Switching Between OpenAI and Anthropic
 *
 * This demo shows:
 * 1. Registering multiple providers in a ModelRegistry
 * 2. Starting a conversation with one model
 * 3. Switching to another model mid-conversation
 * 4. Cross-provider message transformation in action
 *
 * To run:
 *   export OPENAI_API_KEY=sk-...
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsx src/demo.ts
 */

import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { ModelRegistry } from "./model-registry.js";
import { createStream } from "./create-stream.js";
import type { Message, AssistantMessageRecord } from "./create-stream.js";

// ---------------------------------------------------------------------------
// 1. Set up the registry
// ---------------------------------------------------------------------------

const registry = new ModelRegistry();

registry.register("openai", "gpt-4o", openai("gpt-4o"), {
  contextWindow: 128000,
  supportsImages: true,
  costPerMillionInputTokens: 2.5,
  costPerMillionOutputTokens: 10,
});

registry.register("anthropic", "claude-sonnet-4-5", anthropic("claude-sonnet-4-5"), {
  contextWindow: 200000,
  supportsImages: true,
  supportsThinking: true,
  costPerMillionInputTokens: 3,
  costPerMillionOutputTokens: 15,
});

console.log("Registered models:", registry.listKeys());
console.log();

// ---------------------------------------------------------------------------
// 2. Helper to stream a response and collect it
// ---------------------------------------------------------------------------

async function chat(
  modelKey: string,
  messages: Message[],
): Promise<{ text: string; messages: Message[] }> {
  console.log(`--- Using ${modelKey} ---`);

  const result = createStream(registry, {
    modelKey,
    messages,
    system: "You are a helpful assistant. Keep responses brief (1-2 sentences).",
  });

  let fullText = "";
  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
    fullText += chunk;
  }
  console.log("\n");

  // Build the assistant message record (tracks which model produced it)
  const [provider, modelId] = modelKey.split("/");
  const assistantMsg: AssistantMessageRecord = {
    role: "assistant",
    provider,
    model: modelId,
    content: [{ type: "text", text: fullText }],
  };

  return {
    text: fullText,
    messages: [...messages, assistantMsg],
  };
}

// ---------------------------------------------------------------------------
// 3. Run the demo
// ---------------------------------------------------------------------------

async function main() {
  const conversation: Message[] = [];

  // Turn 1: Ask OpenAI
  const userMsg1: Message = {
    role: "user",
    content: "What is the capital of France? Reply in one sentence.",
  };
  conversation.push(userMsg1);

  const result1 = await chat("openai/gpt-4o", conversation);

  // Turn 2: Switch to Anthropic, continuing the same conversation
  // The transformMessages function will handle any cross-provider
  // compatibility issues (thinking blocks, tool call IDs, etc.)
  const userMsg2: Message = {
    role: "user",
    content: "What is one famous landmark there? Reply in one sentence.",
  };
  const messagesForTurn2 = [...result1.messages, userMsg2];

  const result2 = await chat("anthropic/claude-sonnet-4-5", messagesForTurn2);

  // Turn 3: Switch back to OpenAI
  const userMsg3: Message = {
    role: "user",
    content: "When was it built? Reply in one sentence.",
  };
  const messagesForTurn3 = [...result2.messages, userMsg3];

  await chat("openai/gpt-4o", messagesForTurn3);

  // Show registry info
  console.log("=== Registry State ===");
  for (const entry of registry.listAll()) {
    console.log(`  ${entry.provider}/${entry.modelId}`, entry.meta ?? "");
  }
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
