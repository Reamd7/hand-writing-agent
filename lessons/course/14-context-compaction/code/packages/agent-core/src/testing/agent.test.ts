// ============================================================================
// Lesson 8: Testing Agent Core -- Test Cases
//
// Five test groups demonstrating how to test an agent loop with a mock
// provider. Each group covers a distinct aspect of agent behavior:
//
// 1. Basic conversation: prompt -> text response
// 2. Single tool call: prompt -> tool call -> result -> final response
// 3. Multi-step tool calls: consecutive tool calls in one run
// 4. Error handling: tool failure, LLM error, abort
// 5. Steering: inject message during run
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import {
  MockProvider,
  mockTextResponse,
  mockToolCallResponse,
  mockMultiToolCallResponse,
  mockErrorResponse,
  runAgent,
} from "./mock-provider.js";
import type { AgentEvent, ToolCall } from "./mock-provider.js";
import {
  createTestAgent,
  createStaticTool,
  createFailingTool,
  createTool,
  collectEvents,
  eventTypes,
  messagesByRole,
} from "./test-utils.js";

// ---------------------------------------------------------------------------
// 1. Basic conversation
// ---------------------------------------------------------------------------

describe("basic conversation", () => {
  it("returns a text response for a simple prompt", async () => {
    const agent = createTestAgent({
      responses: [mockTextResponse("Hello! How can I help you?")],
    });

    const result = await agent.run("Hi there");

    // Verify messages
    expect(result.messages).toHaveLength(2); // user + assistant
    expect(result.messages[0]).toMatchObject({ role: "user", content: "Hi there" });
    expect(result.messages[1]).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });

    // Verify assistant text content
    const assistantMsg = result.messages[1];
    expect(assistantMsg.role).toBe("assistant");
    if (assistantMsg.role === "assistant") {
      expect(assistantMsg.content[0]).toMatchObject({
        type: "text",
        text: "Hello! How can I help you?",
      });
    }

    // Verify provider was called exactly once
    expect(agent.provider.callCount).toBe(1);
  });

  it("emits events in the correct order", async () => {
    const agent = createTestAgent({
      responses: [mockTextResponse("Hi")],
    });

    const result = await agent.run("Hello");

    const types = eventTypes(result);
    expect(types).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_delta",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });

  it("includes the user message in the context sent to the provider", async () => {
    const agent = createTestAgent({
      responses: [mockTextResponse("response")],
    });

    await agent.run("What is 2+2?");

    expect(agent.provider.callHistory).toHaveLength(1);
    const sentMessages = agent.provider.callHistory[0].messages;
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      role: "user",
      content: "What is 2+2?",
    });
  });

  it("handles empty text response", async () => {
    const agent = createTestAgent({
      responses: [mockTextResponse("")],
    });

    const result = await agent.run("test");

    expect(result.messages).toHaveLength(2);
    if (result.messages[1].role === "assistant") {
      expect(result.messages[1].content[0]).toMatchObject({
        type: "text",
        text: "",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Single tool call
// ---------------------------------------------------------------------------

describe("single tool call", () => {
  const readFileTool = createStaticTool("read_file", "file content here");

  it("executes a tool call and returns the final response", async () => {
    const agent = createTestAgent({
      responses: [
        // First response: tool call
        mockToolCallResponse("read_file", { path: "/tmp/test.txt" }, { toolCallId: "tc_1" }),
        // Second response: final text after tool result
        mockTextResponse("The file contains: file content here"),
      ],
      tools: [readFileTool],
    });

    const result = await agent.run("Read the test file");

    // Messages: user -> assistant(toolCall) -> toolResult -> assistant(text)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.messages[2].role).toBe("toolResult");
    expect(result.messages[3].role).toBe("assistant");

    // Verify tool result content
    const toolResult = result.messages[2];
    if (toolResult.role === "toolResult") {
      expect(toolResult.toolName).toBe("read_file");
      expect(toolResult.content).toBe("file content here");
      expect(toolResult.isError).toBe(false);
    }

    // Provider called twice: once for tool call, once for final response
    expect(agent.provider.callCount).toBe(2);
  });

  it("emits tool_call_start and tool_call_end events", async () => {
    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("read_file", { path: "/x" }, { toolCallId: "tc_1" }),
        mockTextResponse("Done"),
      ],
      tools: [readFileTool],
    });

    const result = await agent.run("Read it");

    const toolStarts = collectEvents(result, "tool_call_start");
    const toolEnds = collectEvents(result, "tool_call_end");

    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].toolCall.name).toBe("read_file");

    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0].result.content).toBe("file content here");
    expect(toolEnds[0].result.isError).toBe(false);
  });

  it("sends tool result back to the provider in the next call", async () => {
    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("read_file", { path: "/a" }, { toolCallId: "tc_1" }),
        mockTextResponse("Got it"),
      ],
      tools: [readFileTool],
    });

    await agent.run("Read file /a");

    // Second provider call should include the tool result
    const secondCallMessages = agent.provider.callHistory[1].messages;
    const toolResultMsg = secondCallMessages.find((m) => m.role === "toolResult");
    expect(toolResultMsg).toBeDefined();
    if (toolResultMsg && toolResultMsg.role === "toolResult") {
      expect(toolResultMsg.toolCallId).toBe("tc_1");
      expect(toolResultMsg.content).toBe("file content here");
    }
  });

  it("handles unknown tool gracefully", async () => {
    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("nonexistent_tool", {}, { toolCallId: "tc_1" }),
        mockTextResponse("Sorry, I could not find that tool."),
      ],
      tools: [], // No tools registered
    });

    const result = await agent.run("Do something");

    // Tool result should be an error
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toContain("not found");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-step tool calls
// ---------------------------------------------------------------------------

describe("multi-step tool calls", () => {
  const listFilesTool = createStaticTool("list_files", "a.txt\nb.txt");
  const readFileTool = createStaticTool("read_file", "content of file");
  const writeFileTool = createStaticTool("write_file", "written successfully");

  it("handles two consecutive tool call rounds", async () => {
    const agent = createTestAgent({
      responses: [
        // Round 1: list files
        mockToolCallResponse("list_files", { dir: "/" }, { toolCallId: "tc_1" }),
        // Round 2: read a file based on the listing
        mockToolCallResponse("read_file", { path: "/a.txt" }, { toolCallId: "tc_2" }),
        // Final: text response
        mockTextResponse("File a.txt contains: content of file"),
      ],
      tools: [listFilesTool, readFileTool],
    });

    const result = await agent.run("List files then read a.txt");

    // Messages: user -> assistant(tc1) -> toolResult1 -> assistant(tc2) -> toolResult2 -> assistant(text)
    expect(result.messages).toHaveLength(6);
    expect(agent.provider.callCount).toBe(3);

    // Verify the chain
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant"); // tool call 1
    expect(result.messages[2].role).toBe("toolResult"); // result 1
    expect(result.messages[3].role).toBe("assistant"); // tool call 2
    expect(result.messages[4].role).toBe("toolResult"); // result 2
    expect(result.messages[5].role).toBe("assistant"); // final text
  });

  it("handles multiple tool calls in a single response", async () => {
    const agent = createTestAgent({
      responses: [
        // One response with two tool calls
        mockMultiToolCallResponse([
          { name: "read_file", args: { path: "/a.txt" }, id: "tc_1" },
          { name: "read_file", args: { path: "/b.txt" }, id: "tc_2" },
        ]),
        // Final response after both tools execute
        mockTextResponse("Both files read successfully"),
      ],
      tools: [readFileTool],
    });

    const result = await agent.run("Read both files");

    // Messages: user -> assistant(2 tool calls) -> toolResult1 -> toolResult2 -> assistant(text)
    expect(result.messages).toHaveLength(5);

    const toolResults = messagesByRole(result, "toolResult");
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].toolCallId).toBe("tc_1");
    expect(toolResults[1].toolCallId).toBe("tc_2");

    // Both tool call events emitted
    const toolStarts = collectEvents(result, "tool_call_start");
    expect(toolStarts).toHaveLength(2);
  });

  it("respects maxTurns limit", async () => {
    // Create an infinite tool call loop
    const provider = new MockProvider();
    // Keep enqueuing tool calls forever (we'll rely on maxTurns)
    for (let i = 0; i < 20; i++) {
      provider.enqueue(mockToolCallResponse("list_files", {}, { toolCallId: `tc_${i}` }));
    }

    const result = await runAgent("loop forever", {
      provider,
      tools: [listFilesTool],
      maxTurns: 3,
    });

    // Should have stopped at 3 turns
    expect(provider.callCount).toBe(3);
    const turnStarts = collectEvents(result, "turn_start");
    expect(turnStarts).toHaveLength(3);
  });

  it("accumulates full context across turns", async () => {
    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("list_files", { dir: "/" }, { toolCallId: "tc_1" }),
        mockTextResponse("Done listing"),
      ],
      tools: [listFilesTool],
    });

    await agent.run("List root");

    // The second call should have: user + assistant(tc) + toolResult
    const secondCall = agent.provider.callHistory[1];
    expect(secondCall.messages).toHaveLength(3);
    expect(secondCall.messages[0].role).toBe("user");
    expect(secondCall.messages[1].role).toBe("assistant");
    expect(secondCall.messages[2].role).toBe("toolResult");
  });
});

// ---------------------------------------------------------------------------
// 4. Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  it("handles tool execution failure", async () => {
    const failingTool = createFailingTool("dangerous_tool", "Permission denied");

    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("dangerous_tool", {}, { toolCallId: "tc_1" }),
        mockTextResponse("The tool failed with a permission error."),
      ],
      tools: [failingTool],
    });

    const result = await agent.run("Run the dangerous tool");

    // Tool result should be an error
    const toolResult = result.messages.find((m) => m.role === "toolResult");
    expect(toolResult).toBeDefined();
    if (toolResult && toolResult.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toBe("Permission denied");
    }

    // Agent should still continue to the final response
    const assistantMessages = messagesByRole(result, "assistant");
    expect(assistantMessages).toHaveLength(2); // tool call + final
  });

  it("handles LLM error response", async () => {
    const agent = createTestAgent({
      responses: [mockErrorResponse("Rate limit exceeded")],
    });

    const result = await agent.run("Hello");

    // Should emit an error event
    const errors = collectEvents(result, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe("Rate limit exceeded");

    // Agent should end
    const agentEnds = collectEvents(result, "agent_end");
    expect(agentEnds).toHaveLength(1);
  });

  it("handles empty response queue (no more responses)", async () => {
    const agent = createTestAgent({
      responses: [], // Empty queue
    });

    const result = await agent.run("Hello");

    // Provider returns an error when queue is empty
    const errors = collectEvents(result, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain("no more responses");
  });

  it("tool failure does not stop the agent loop", async () => {
    let callCount = 0;
    const flakyTool = createTool("flaky", async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Temporary failure");
      }
      return { content: "success on retry", isError: false };
    });

    const agent = createTestAgent({
      responses: [
        // First: call flaky tool (will fail)
        mockToolCallResponse("flaky", {}, { toolCallId: "tc_1" }),
        // Second: LLM sees the error and tries again
        mockToolCallResponse("flaky", {}, { toolCallId: "tc_2" }),
        // Third: final response
        mockTextResponse("Done after retry"),
      ],
      tools: [flakyTool],
    });

    const result = await agent.run("Run flaky tool");

    // First tool result is an error, second succeeds
    const toolResults = messagesByRole(result, "toolResult");
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0].isError).toBe(true);
    expect(toolResults[0].content).toBe("Temporary failure");
    expect(toolResults[1].isError).toBe(false);
    expect(toolResults[1].content).toBe("success on retry");
  });

  it("emits error event but still completes with agent_end", async () => {
    const agent = createTestAgent({
      responses: [mockErrorResponse("Server error")],
    });

    const result = await agent.run("test");

    const types = eventTypes(result);
    expect(types).toContain("error");
    expect(types[types.length - 1]).toBe("agent_end");
  });
});

// ---------------------------------------------------------------------------
// 5. Steering
// ---------------------------------------------------------------------------

describe("steering", () => {
  it("injects a steering message before the LLM call", async () => {
    let steeringCalled = false;

    const agent = createTestAgent({
      responses: [mockTextResponse("I will be concise.")],
      onBeforeTurn: (messages) => {
        if (!steeringCalled) {
          steeringCalled = true;
          return "Please keep your response under 50 words.";
        }
        return undefined;
      },
    });

    const result = await agent.run("Explain quantum computing");

    // Steering event emitted
    const steeringEvents = collectEvents(result, "steering");
    expect(steeringEvents).toHaveLength(1);
    expect(steeringEvents[0].content).toBe("Please keep your response under 50 words.");

    // Provider should see both user message and steering message
    const sentMessages = agent.provider.callHistory[0].messages;
    expect(sentMessages).toHaveLength(2); // original user + steering
    expect(sentMessages[1]).toMatchObject({
      role: "user",
      content: "Please keep your response under 50 words.",
    });
  });

  it("steering can be applied conditionally per turn", async () => {
    let turnIndex = 0;

    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("search", { query: "test" }, { toolCallId: "tc_1" }),
        mockTextResponse("Found results"),
      ],
      tools: [createStaticTool("search", "result1, result2")],
      onBeforeTurn: () => {
        turnIndex++;
        if (turnIndex === 2) {
          return "Summarize the results briefly.";
        }
        return undefined;
      },
    });

    const result = await agent.run("Search for test");

    // Steering only on turn 2
    const steeringEvents = collectEvents(result, "steering");
    expect(steeringEvents).toHaveLength(1);
    expect(steeringEvents[0].content).toBe("Summarize the results briefly.");
  });

  it("steering messages appear in the provider's context", async () => {
    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("greet", {}, { toolCallId: "tc_1" }),
        mockTextResponse("Hi!"),
      ],
      tools: [createStaticTool("greet", "greeting sent")],
      onBeforeTurn: (messages) => {
        // Only steer on the second turn (after tool result)
        if (messages.some((m) => m.role === "toolResult")) {
          return "Be friendly.";
        }
        return undefined;
      },
    });

    const result = await agent.run("Greet the user");

    // Second provider call should include the steering message
    const secondCall = agent.provider.callHistory[1];
    const userMessages = secondCall.messages.filter((m) => m.role === "user");
    const steeringMsg = userMessages.find((m) => m.role === "user" && m.content === "Be friendly.");
    expect(steeringMsg).toBeDefined();
  });

  it("no steering when hook returns undefined", async () => {
    const agent = createTestAgent({
      responses: [mockTextResponse("Normal response")],
      onBeforeTurn: () => undefined,
    });

    const result = await agent.run("Hello");

    const steeringEvents = collectEvents(result, "steering");
    expect(steeringEvents).toHaveLength(0);

    // Only original user message sent to provider
    expect(agent.provider.callHistory[0].messages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end event validation
// ---------------------------------------------------------------------------

describe("end-to-end event validation", () => {
  it("full tool call cycle produces correct event sequence", async () => {
    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("calc", { expr: "2+2" }, { toolCallId: "tc_1" }),
        mockTextResponse("The answer is 4"),
      ],
      tools: [createStaticTool("calc", "4")],
    });

    const result = await agent.run("What is 2+2?");

    const types = eventTypes(result);
    expect(types).toEqual([
      // Turn 1: tool call
      "agent_start",
      "turn_start",
      "message_start", // assistant with tool call
      "message_end",
      "tool_call_start",
      "tool_call_end",
      "turn_end",
      // Turn 2: final text
      "turn_start",
      "message_start", // assistant with text
      "message_delta",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
  });

  it("agent_start is always first, agent_end is always last", async () => {
    const agent = createTestAgent({
      responses: [mockTextResponse("ok")],
    });

    const result = await agent.run("test");

    expect(result.events[0].type).toBe("agent_start");
    expect(result.events[result.events.length - 1].type).toBe("agent_end");
  });

  it("agent_end contains all accumulated messages", async () => {
    const agent = createTestAgent({
      responses: [
        mockToolCallResponse("echo", { text: "hi" }, { toolCallId: "tc_1" }),
        mockTextResponse("echoed: hi"),
      ],
      tools: [createStaticTool("echo", "hi")],
    });

    const result = await agent.run("Echo hi");

    const agentEnd = collectEvents(result, "agent_end");
    expect(agentEnd).toHaveLength(1);
    // agent_end.messages should match the full message list
    expect(agentEnd[0].messages).toHaveLength(result.messages.length);
  });

  it("message_start and message_end always appear in pairs", async () => {
    const agent = createTestAgent({
      responses: [mockToolCallResponse("t", {}, { toolCallId: "tc_1" }), mockTextResponse("done")],
      tools: [createStaticTool("t", "r")],
    });

    const result = await agent.run("go");

    const starts = collectEvents(result, "message_start");
    const ends = collectEvents(result, "message_end");
    expect(starts.length).toBe(ends.length);
    expect(starts.length).toBeGreaterThan(0);
  });

  it("dynamic response factory receives correct context", async () => {
    const provider = new MockProvider();
    provider.enqueue(({ messages, callIndex }) => {
      // Verify the factory receives the user message
      const lastUser = messages.filter((m) => m.role === "user").pop();
      const userText = lastUser && lastUser.role === "user" ? lastUser.content : "";
      return mockTextResponse(`Echo: ${userText} (call #${callIndex})`);
    });

    const result = await runAgent("Hello world", { provider });

    const assistant = result.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    if (assistant && assistant.role === "assistant") {
      const textBlock = assistant.content.find((b) => b.type === "text");
      expect(textBlock).toBeDefined();
      if (textBlock && textBlock.type === "text") {
        expect(textBlock.text).toBe("Echo: Hello world (call #0)");
      }
    }
  });
});
