/**
 * Lesson 9: Two-layer tool abstraction.
 *
 * ToolDefinition -- rich interface with rendering, prompt contribution, and ExtensionContext.
 * AgentTool      -- slim runtime interface consumed by the agent loop.
 * wrapToolDefinition() -- adapter that bridges the two layers.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// From pi-ai: Content types
// ---------------------------------------------------------------------------
export type { TextContent, ImageContent } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// From pi-agent-core: Tool result and execution types
// ---------------------------------------------------------------------------
export type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ToolExecutionMode } from "@earendil-works/pi-agent-core";

// ---------------------------------------------------------------------------
// AgentTool -- slim runtime interface (agent loop layer)
// ---------------------------------------------------------------------------

export interface AgentTool<TParams extends z.ZodType = z.ZodType, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  prepareArguments?: (args: unknown) => z.infer<TParams>;
  executionMode?: ToolExecutionMode;
  execute: (
    toolCallId: string,
    params: z.infer<TParams>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}

// ---------------------------------------------------------------------------
// ExtensionContext -- simplified version of pi's ExtensionContext
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  /** Current working directory. */
  cwd: string;
  /** Current model info (simplified). */
  model?: { supportsImages: boolean };
}

// ---------------------------------------------------------------------------
// ToolDefinition -- rich interface (coding-agent layer)
// ---------------------------------------------------------------------------

export interface ToolDefinition<TParams extends z.ZodType = z.ZodType, TDetails = unknown> {
  /** Tool name (used in LLM tool calls). */
  name: string;
  /** Human-readable label for UI. */
  label: string;
  /** Description for LLM (sent as function calling description). */
  description: string;
  /** Parameter schema (Zod). */
  parameters: TParams;

  /** One-line snippet for the "Available Tools" section in system prompt. */
  promptSnippet?: string;
  /** Guideline bullets appended to the system prompt Guidelines section. */
  promptGuidelines?: string[];

  /** Per-tool execution mode override. */
  executionMode?: ToolExecutionMode;
  /** Compatibility shim for raw tool call arguments before validation. */
  prepareArguments?: (args: unknown) => z.infer<TParams>;

  /** Execute the tool. */
  execute(
    toolCallId: string,
    params: z.infer<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}

// ---------------------------------------------------------------------------
// wrapToolDefinition() -- adapter: ToolDefinition -> AgentTool
// ---------------------------------------------------------------------------

/**
 * Wrap a ToolDefinition into an AgentTool for the core runtime.
 *
 * Strips rendering and prompt fields. Injects ExtensionContext via a factory
 * function so the context is always fresh (it may change across sessions).
 */
export function wrapToolDefinition<TDetails = unknown>(
  definition: ToolDefinition<z.ZodType, TDetails>,
  ctxFactory?: () => ExtensionContext,
): AgentTool<z.ZodType, TDetails> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    execute: (toolCallId, params, signal, onUpdate) =>
      definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
  };
}

/**
 * Wrap multiple ToolDefinitions into AgentTools.
 */
export function wrapToolDefinitions(
  definitions: ToolDefinition[],
  ctxFactory?: () => ExtensionContext,
): AgentTool[] {
  return definitions.map((d) => wrapToolDefinition(d, ctxFactory));
}
