# Lesson 14 Reference: Context Window Management and Compaction

## pi Source Code

Core compaction logic lives in `packages/coding-agent/src/core/compaction/`:

| File                      | Purpose                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compaction.ts`           | Main compaction pipeline: `prepareCompaction()`, `compact()`, `generateSummary()`, token estimation, cut point detection, `shouldCompact()` threshold check                 |
| `utils.ts`                | Shared utilities: `serializeConversation()`, file operation tracking (`extractFileOpsFromMessage`, `computeFileLists`, `formatFileOperations`), summarization system prompt |
| `branch-summarization.ts` | Branch summary generation when navigating session trees (separate from compaction but shares utilities)                                                                     |
| `index.ts`                | Re-exports                                                                                                                                                                  |

Trigger logic lives in `packages/coding-agent/src/core/agent-session.ts`:

- `_checkCompaction()` (line ~1766) - decides whether to compact after each agent turn
- `_runAutoCompaction()` (line ~1849) - orchestrates the compaction flow with events

## AI SDK Usage for Summarization

pi uses its own `completeSimple()` wrapper (non-streaming) from `@earendil-works/pi-ai`:

```typescript
// packages/ai/src/stream.ts
export async function completeSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const s = streamSimple(model, context, options);
  return s.result();
}
```

This is equivalent to Vercel AI SDK's `generateText()` - a non-streaming completion call used for summarization because we need the full summary text at once (no incremental display).

In our course code, we use the standard Vercel AI SDK:

```typescript
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const { text } = await generateText({
  model: openai("gpt-4o-mini"),
  system: "You are a context summarization assistant...",
  prompt: serializedConversation,
  maxTokens: 4096,
});
```

## Token Counting Strategies

### 1. chars/4 Heuristic (pi's approach)

Used in `estimateTokens()` in `compaction.ts`:

```typescript
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  // ... accumulate character count from message content
  return Math.ceil(chars / 4);
}
```

- Simple, fast, no dependencies
- Conservative (overestimates) - safe for threshold decisions
- Handles text, tool calls, images (fixed 4800 chars estimate per image)

### 2. Usage-Based (actual token counts from LLM responses)

`calculateContextTokens()` reads from the LLM's usage report:

```typescript
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
```

- Exact count from provider
- Only available after an LLM response
- `estimateContextTokens()` combines last known usage + chars/4 for trailing messages

### 3. tiktoken (not used in pi, common alternative)

```typescript
import { encoding_for_model } from "tiktoken";
const enc = encoding_for_model("gpt-4o");
const tokens = enc.encode(text).length;
enc.free();
```

- Exact for OpenAI models
- Requires WASM dependency (~4MB)
- Model-specific (different encodings for different model families)

### Strategy Comparison

| Strategy       | Accuracy | Speed          | Dependencies  | When to Use                           |
| -------------- | -------- | -------------- | ------------- | ------------------------------------- |
| chars/4        | ~70-80%  | O(1)           | None          | Threshold checks, cut point detection |
| Provider usage | 100%     | N/A (post-hoc) | None          | Post-response compaction trigger      |
| tiktoken       | ~99%     | O(n)           | tiktoken WASM | Pre-request budget planning           |

## Key Design Decisions in pi

1. **Two-tier estimation**: Use exact provider usage when available, fall back to chars/4 for messages after the last LLM response
2. **Conservative overestimation**: chars/4 slightly overestimates, which is safer than underestimating (compact too early > overflow)
3. **Non-streaming summarization**: Compaction uses `completeSimple()` (not streaming) because the summary is written atomically to the session
4. **Iterative summaries**: When a previous compaction exists, the new summary updates the old one rather than re-summarizing everything
5. **File operation tracking**: Compaction preserves which files were read/modified across compaction boundaries via `CompactionDetails`

## External Links

- [AI SDK `generateText` Documentation](https://ai-sdk.dev/docs/ai-sdk-core/generating-text) -- The Vercel AI SDK function used for non-streaming completions; pi's `completeSimple()` serves the same purpose for summarization
- [tiktoken](https://github.com/openai/tiktoken) -- OpenAI's BPE tokenizer library for exact token counting; not used by pi but a common alternative to the chars/4 heuristic
- [tiktoken (JS/WASM port)](https://www.npmjs.com/package/tiktoken) -- JavaScript/WASM port of tiktoken for use in Node.js and browser environments
- [OpenAI Tokenizer Tool](https://platform.openai.com/tokenizer) -- Interactive web tool for visualizing how text is tokenized by different OpenAI models
- [Anthropic Token Counting API](https://docs.anthropic.com/en/docs/build-with-claude/token-counting) -- Anthropic's server-side token counting endpoint for exact Claude token estimates
- [Context Window Overflow Handling - AI SDK Docs](https://ai-sdk.dev/docs/ai-sdk-core/settings#maxretries) -- AI SDK settings relevant to handling context overflow errors and retry strategies
