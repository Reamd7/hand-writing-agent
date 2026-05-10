# Lesson 3: Provider Management and Model Configuration -- References

## AI SDK Official Documentation

- [Provider & Model Management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management)
  - `customProvider()` for pre-configured model settings, aliases, and limiting available models
  - `createProviderRegistry()` for multi-provider access via `providerId:modelId` strings
  - Global provider configuration via `globalThis.AI_SDK_DEFAULT_PROVIDER`

- [Language Model Middleware](https://ai-sdk.dev/docs/ai-sdk-core/middleware)
  - `wrapLanguageModel()` for intercepting and modifying model calls
  - Built-in middlewares: `extractReasoningMiddleware`, `defaultSettingsMiddleware`, `simulateStreamingMiddleware`
  - Middleware interface: `transformParams`, `wrapGenerate`, `wrapStream`
  - Composing multiple middlewares via array

- [Settings](https://ai-sdk.dev/docs/ai-sdk-core/settings)
  - Common settings: `maxOutputTokens`, `temperature`, `topP`, `topK`, `seed`
  - `providerOptions` for provider-specific configuration (e.g. Anthropic thinking, OpenAI reasoning effort)
  - `abortSignal`, `timeout`, `headers`

## pi Source Code

- [`packages/ai/src/api-registry.ts`](../../packages/ai/src/api-registry.ts)
  - `ApiProvider` interface: `{ api, stream, streamSimple }`
  - Module-level `Map<string, RegisteredApiProvider>` as the singleton registry
  - `registerApiProvider()`, `getApiProvider()`, `getApiProviders()`, `unregisterApiProviders()`
  - `wrapStream()` / `wrapStreamSimple()` for type-safe api mismatch guards

- [`packages/ai/src/models.ts`](../../packages/ai/src/models.ts)
  - `Map<provider, Map<modelId, Model>>` two-level registry initialized from generated data
  - `getModel(provider, modelId)`, `getProviders()`, `getModels(provider)`
  - `calculateCost()` for usage-based billing
  - `getSupportedThinkingLevels()`, `clampThinkingLevel()` for reasoning model management

- [`packages/ai/src/providers/register-builtins.ts`](../../packages/ai/src/providers/register-builtins.ts)
  - Lazy loading pattern: `loadAnthropicProviderModule()` uses `import()` with memoized promise
  - `createLazyStream()` wraps async module loading into a synchronous `AssistantMessageEventStream`
  - `forwardStream()` bridges `AsyncIterable<Event>` to push-based `EventStream`
  - `registerBuiltInApiProviders()` registers all built-in providers at module load time

- [`packages/ai/src/providers/transform-messages.ts`](../../packages/ai/src/providers/transform-messages.ts)
  - Cross-provider message transformation for model switching
  - Thinking block handling: keep for same model, convert to text for cross-model, drop redacted/encrypted
  - Tool call ID normalization: OpenAI 450+ char IDs vs Anthropic 64-char `[a-zA-Z0-9_-]+` constraint
  - Synthetic tool result insertion for orphaned tool calls
  - Error/aborted assistant message filtering
