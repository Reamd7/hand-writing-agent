// Application entry point: bootstrap tools and run a demo agent loop

import { createAgentConfig } from "@my-agent/core";
import { executeTool, listTools, registerTool } from "@my-agent/tools";

// Register a demo tool
registerTool(
  {
    name: "greet",
    description: "Returns a greeting message",
    parameters: { name: { type: "string" } },
  },
  async (args) => `Hello, ${String(args.name ?? "world")}!`,
);

// Create agent configuration
const config = createAgentConfig({
  model: "gpt-4",
  systemPrompt: "You are a coding assistant.",
  tools: [
    {
      name: "greet",
      description: "Returns a greeting message",
      parameters: { name: { type: "string" } },
    },
  ],
});

console.log("Agent config:", config);
console.log("Registered tools:", listTools());

// Execute the demo tool
const result = await executeTool("greet", { name: "Student" });
console.log("Tool result:", result);
