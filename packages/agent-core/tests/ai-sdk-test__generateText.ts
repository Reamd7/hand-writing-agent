// import { createOpenAI } from "@ai-sdk/openai";
// import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
// import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

// ;(async function () {
//     const axonhubOpenICompatibleProvider = createOpenAICompatible({
//         baseURL: "http://10.126.126.123:8090/v1",
//         name: "axonhub",
//         apiKey: "ah-753703bc0526298040cf900d107bd365b14cc7f3ac7dc3eac4afc43f02be6ab7",
//     })
//     const GLM5_1 = axonhubOpenICompatibleProvider.languageModel("glm-5.1")
//     const res = await generateText({
//         model: GLM5_1,
//         system: "你是一个简洁的技术文档写手。",
//         prompt: "用三句话解释 TypeScript 的类型推断。",
//     });
//     console.log(JSON.stringify(res, null, 2))
// })();

// ; (async function () {
//     const axonhubOpenICompatibleProvider = createAnthropic({
//         baseURL: "http://10.126.126.123:8090/v1",
//         name: "axonhub",
//         apiKey: "ah-753703bc0526298040cf900d107bd365b14cc7f3ac7dc3eac4afc43f02be6ab7",
//     })

//     const GLM5_1 = axonhubOpenICompatibleProvider.languageModel("glm-5.1")
//     const res = await generateText({
//         model: GLM5_1,
//         system: "你是一个简洁的技术文档写手。",
//         prompt: "用三句话解释 TypeScript 的类型推断。",
//         maxOutputTokens: 131072,
//     });
//     console.log(JSON.stringify(res, null, 2))
// })();

// ;(async function () {
//     const axonhubOpenICompatibleProvider = createOpenAI({
//         baseURL: "http://10.126.126.123:8090/v1",
//         name: "axonhub",
//         apiKey: "ah-753703bc0526298040cf900d107bd365b14cc7f3ac7dc3eac4afc43f02be6ab7",
//     })
//     const GLM5_1 = axonhubOpenICompatibleProvider.languageModel("glm-5.1")
//     const res = await generateText({
//         model: GLM5_1,
//         system: "你是一个简洁的技术文档写手。",
//         prompt: "用三句话解释 TypeScript 的类型推断。",
//         maxOutputTokens: 131072,
//     });
//     console.log(JSON.stringify(res, null, 2))
// })();

(async function () {
  const axonhubOpenICompatibleProvider = createGoogleGenerativeAI({
    baseURL: "http://10.126.126.123:8090/gemini",
    name: "axonhub",
    apiKey: "ah-753703bc0526298040cf900d107bd365b14cc7f3ac7dc3eac4afc43f02be6ab7",
  });
  const GLM5_1 = axonhubOpenICompatibleProvider.languageModel("glm-5.1");
  const res = await generateText({
    model: GLM5_1,
    system: "你是一个简洁的技术文档写手。",
    prompt: "用三句话解释 TypeScript 的类型推断。",
    maxOutputTokens: 131072,
  });
  console.log(JSON.stringify(res, null, 2));
})();
