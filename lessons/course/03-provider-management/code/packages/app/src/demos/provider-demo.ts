/**
 * Lesson 3 Demo: OpenCode 风格 Provider 管理
 *
 * 演示：
 * 1. ProviderRegistry 自动从环境变量发现 provider
 * 2. 通过配置添加自定义 provider
 * 3. 中途切换模型的对话
 * 4. 跨 provider 消息转换
 *
 * 运行：
 *   export OPENAI_API_KEY=sk-...
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsx src/demos/provider-demo.ts
 */

import {
  ProviderRegistry,
  createStream,
  ProviderIDs,
} from "@my-agent/core";
import type { AssistantMessageRecord, StreamMessage } from "@my-agent/core";

// ---------------------------------------------------------------------------
// 1. 创建 registry（自动发现）
// ---------------------------------------------------------------------------

// OpenCode 风格：ProviderRegistry.create() 会：
//   1. 加载内置目录（Anthropic, OpenAI, Google 的模型元数据）
//   2. 扫描环境变量自动检测可用 provider
// 不再需要手动 import SDK 包和 registry.register()！
const registry = ProviderRegistry.create();

// 查看发现结果
console.log("=== Provider Discovery ===");
for (const p of registry.list()) {
  const status = p.key ? "✓ available" : "✗ no API key";
  const models = Object.keys(p.models).join(", ");
  console.log(`  ${p.name} (${p.id}): ${status}`);
  console.log(`    models: ${models}`);
}
console.log();

// 也可以通过配置添加自定义 provider：
// const registry = ProviderRegistry.create({
//   deepseek: {
//     name: "DeepSeek",
//     baseURL: "https://api.deepseek.com/v1",
//     apiKey: process.env.DEEPSEEK_API_KEY,
//     npm: "@ai-sdk/openai-compatible",
//     models: {
//       "deepseek-chat": { name: "DeepSeek Chat" },
//     },
//   },
// });

// ---------------------------------------------------------------------------
// 2. 查看模型元数据
// ---------------------------------------------------------------------------

console.log("=== Model Metadata ===");
const available = registry.listAvailable();
for (const p of available) {
  for (const model of Object.values(p.models)) {
    console.log(`  ${p.id}/${model.id}:`);
    console.log(`    name: ${model.name}`);
    console.log(`    context: ${model.limit.context.toLocaleString()} tokens`);
    console.log(`    cost: $${model.cost.input}/M input, $${model.cost.output}/M output`);
    console.log(`    capabilities: reasoning=${model.capabilities.reasoning}, images=${model.capabilities.images}`);
  }
}
console.log();

// 获取最便宜的模型
for (const p of available) {
  const small = registry.getSmallModel(p.id);
  if (small) {
    console.log(`  Cheapest model for ${p.id}: ${small.id} ($${small.cost.input}/M input)`);
  }
}
console.log();

// ---------------------------------------------------------------------------
// 3. Helper：流式对话
// ---------------------------------------------------------------------------

async function chat(
  modelKey: string,
  messages: StreamMessage[],
): Promise<{ text: string; messages: StreamMessage[] }> {
  console.log(`--- Using ${modelKey} ---`);

  // createStream 现在是 async（因为首次调用需要懒加载 SDK）
  const result = await createStream(registry, {
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

  // 构建 assistant message（记录是哪个模型生成的）
  const [provider, modelId] = modelKey.split("/");
  const assistantMsg: AssistantMessageRecord = {
    role: "assistant",
    provider: provider!,
    model: modelId!,
    content: [{ type: "text", text: fullText }],
  };

  return {
    text: fullText,
    messages: [...messages, assistantMsg],
  };
}

// ---------------------------------------------------------------------------
// 4. 运行 demo
// ---------------------------------------------------------------------------

async function main() {
  // 检查是否有可用的 provider
  if (available.length === 0) {
    console.error("No providers available. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.");
    process.exit(1);
  }

  // 确定使用哪些模型
  const hasOpenAI = registry.getProvider(ProviderIDs.openai)?.key;
  const hasAnthropic = registry.getProvider(ProviderIDs.anthropic)?.key;

  const model1 = hasOpenAI
    ? "openai/gpt-4o"
    : "anthropic/claude-sonnet-4-5";
  const model2 = hasAnthropic
    ? "anthropic/claude-sonnet-4-5"
    : "openai/gpt-4o";

  console.log(`=== Running conversation: ${model1} → ${model2} → ${model1} ===\n`);

  const conversation: StreamMessage[] = [];

  // Turn 1
  const userMsg1: StreamMessage = {
    role: "user",
    content: "What is the capital of France? Reply in one sentence.",
  };
  conversation.push(userMsg1);
  const result1 = await chat(model1, conversation);

  // Turn 2: 切换 provider，继续同一对话
  // transformMessages 会处理跨 provider 兼容性
  const userMsg2: StreamMessage = {
    role: "user",
    content: "What is one famous landmark there? Reply in one sentence.",
  };
  const result2 = await chat(model2, [...result1.messages, userMsg2]);

  // Turn 3: 切换回来
  const userMsg3: StreamMessage = {
    role: "user",
    content: "When was it built? Reply in one sentence.",
  };
  await chat(model1, [...result2.messages, userMsg3]);

  // 展示 registry 状态
  console.log("=== Final Registry State ===");
  for (const p of registry.listAvailable()) {
    const modelNames = Object.values(p.models)
      .map((m) => `${m.id} (${m.name})`)
      .join(", ");
    console.log(`  ${p.id}: ${modelNames}`);
  }
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
