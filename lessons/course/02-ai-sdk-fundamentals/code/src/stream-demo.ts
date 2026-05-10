// =============================================================================
// Lesson 2: streamText fullStream Demo
//
// Demonstrates calling streamText and printing every event from fullStream.
// Run: OPENAI_API_KEY=sk-... npx tsx src/stream-demo.ts
// =============================================================================

import { streamText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

async function main() {
  console.log("--- streamText fullStream Demo ---\n");

  const result = streamText({
    model: openai("gpt-4o-mini"),
    tools: {
      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("The city name"),
        }),
        execute: async ({ city }) => {
          // Simulate an API call
          await new Promise((resolve) => setTimeout(resolve, 500));
          const temperature = Math.floor(Math.random() * 30) + 5;
          return { city, temperature, unit: "celsius" };
        },
      }),
    },
    prompt: "What is the weather in Tokyo? After getting the result, summarize it briefly.",
    onError({ error }) {
      console.error("[onError]", error);
    },
  });

  // Iterate over every event in fullStream
  for await (const part of result.fullStream) {
    switch (part.type) {
      // --- Stream lifecycle ---
      case "start":
        console.log(`[start] Stream started`);
        break;

      case "start-step":
        console.log(`[start-step] Step started`);
        break;

      // --- Text generation ---
      case "text-start":
        console.log(`[text-start] Text block started`);
        break;

      case "text-delta":
        process.stdout.write(part.textDelta);
        break;

      case "text-end":
        console.log(`\n[text-end] Text block ended`);
        break;

      // --- Reasoning / Thinking ---
      case "reasoning-start":
        console.log(`[reasoning-start] Reasoning started`);
        break;

      case "reasoning-delta":
        process.stdout.write(`  (thinking: ${part.textDelta})`);
        break;

      case "reasoning-end":
        console.log(`\n[reasoning-end] Reasoning ended`);
        break;

      // --- Tool calls ---
      case "tool-call":
        console.log(
          `[tool-call] Tool: ${part.toolName}, ID: ${part.toolCallId}, Args: ${JSON.stringify(part.args)}`,
        );
        break;

      case "tool-input-start":
        console.log(`[tool-input-start] Tool input streaming for: ${part.toolName}`);
        break;

      case "tool-input-delta":
        console.log(`[tool-input-delta] Input chunk: ${part.inputTextDelta}`);
        break;

      case "tool-input-end":
        console.log(`[tool-input-end] Tool input complete`);
        break;

      case "tool-result":
        console.log(`[tool-result] Tool: ${part.toolName}, Result: ${JSON.stringify(part.result)}`);
        break;

      case "tool-error":
        console.log(`[tool-error] Tool: ${part.toolName}, Error: ${part.error}`);
        break;

      // --- Sources ---
      case "source":
        console.log(`[source] Source: ${JSON.stringify(part)}`);
        break;

      // --- Files ---
      case "file":
        console.log(`[file] File received: ${part.mediaType}`);
        break;

      // --- Step lifecycle ---
      case "finish-step":
        console.log(
          `[finish-step] Reason: ${part.finishReason}, Usage: ${JSON.stringify(part.usage)}`,
        );
        break;

      case "finish":
        console.log(
          `[finish] Final reason: ${part.finishReason}, Total usage: ${JSON.stringify(part.totalUsage)}`,
        );
        break;

      // --- Errors ---
      case "error":
        console.error(`[error] Stream error:`, part.error);
        break;

      // --- Raw provider events ---
      case "raw":
        // Uncomment to see raw provider chunks:
        // console.log(`[raw]`, part.rawValue);
        break;

      default:
        console.log(`[unknown] ${(part as { type: string }).type}`);
    }
  }

  // After stream completes, access aggregated results
  console.log("\n--- Aggregated Results ---");
  console.log("Final text:", await result.text);
  console.log("Total usage:", await result.totalUsage);
  console.log("Finish reason:", await result.finishReason);

  const steps = await result.steps;
  console.log(`Total steps: ${steps.length}`);
  for (const [i, step] of steps.entries()) {
    console.log(`  Step ${i}: reason=${step.finishReason}, toolCalls=${step.toolCalls.length}`);
  }
}

main().catch(console.error);
