import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { streamText, tool } from "ai";
import path from "path";
import fs from "fs/promises";
import process from "process";
import { z } from "zod";
import { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { AgentEvent } from "@earendil-works/pi-agent-core";

const PWD = process.cwd();

const axonhubOpenICompatibleProvider = createOpenAICompatible({
  baseURL: "http://10.126.126.123:8090/v1",
  name: "axonhub",
  apiKey: "ah-753703bc0526298040cf900d107bd365b14cc7f3ac7dc3eac4afc43f02be6ab7",
});

const GLM5_1 = axonhubOpenICompatibleProvider.languageModel("glm-5.1");

const WEATHER_CODES: Record<number, string> = {
  0: "晴",
  1: "大部晴",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨(小)",
  67: "冻雨(大)",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "阵雨(小)",
  81: "阵雨(中)",
  82: "阵雨(大)",
  85: "阵雪(小)",
  86: "阵雪(大)",
  95: "雷暴",
  96: "雷暴+冰雹(小)",
  99: "雷暴+冰雹(大)",
};

const weatherTool = tool({
  description: "获取指定城市的天气信息，支持最多10天预报",
  inputSchema: z.object({
    city: z.string().describe("城市名称，支持中文如 北京、英文如 Beijing"),
    days: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("预报天数，1=仅当天，最多10天，默认1"),
  }),
  execute: async ({ city, days }) => {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`,
    );
    const geoData = (await geoRes.json()) as any;
    const place = geoData.results?.[0];
    if (!place) throw new Error(`City not found: ${city}`);

    const forecastDays = days ?? 1;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&forecast_days=${forecastDays}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunshine_duration,uv_index_max,precipitation_probability_max,wind_speed_10m_max` +
      `&timezone=auto`;
    const res = await fetch(url);
    const data = (await res.json()) as any;

    const current = data.current;
    const result: any = {
      city: place.name,
      country: place.country,
      current: {
        temperature: current?.temperature_2m + "°C",
        feelsLike: current?.apparent_temperature + "°C",
        humidity: current?.relative_humidity_2m + "%",
        weather: WEATHER_CODES[current?.weather_code] ?? "未知",
        windSpeed: current?.wind_speed_10m + " km/h",
        windDir: current?.wind_direction_10m + "°",
        pressure: current?.surface_pressure + " hPa",
      },
    };

    if (forecastDays > 1) {
      result.forecast = data.daily?.time.map((date: string, i: number) => ({
        date,
        maxTemp: data.daily.temperature_2m_max[i] + "°C",
        minTemp: data.daily.temperature_2m_min[i] + "°C",
        weather: WEATHER_CODES[data.daily.weather_code[i]] ?? "未知",
        sunHour: (data.daily.sunshine_duration[i] / 3600).toFixed(1) + "h",
        uvIndex: data.daily.uv_index_max[i],
        rainChance: data.daily.precipitation_probability_max[i] + "%",
        maxWindSpeed: data.daily.wind_speed_10m_max[i] + " km/h",
      }));
    }
    return result;
  },
});

const getTime = tool({
  description: "获取当前时间",
  inputSchema: z.object({
    timezone: z.string().describe("时区，如 Asia/Shanghai"),
  }),
  execute: async ({ timezone }) => {
    return new Date().toLocaleString("zh-CN", { timeZone: timezone });
  },
});

const getCurrentCity = tool({
  description: "获取用户当前所在城市",
  inputSchema: z.object({}),
  execute: async () => {
    const response = await fetch("https://ipapi.co/json/");
    const data = (await response.json()) as { city: string; region: string; country_name: string };
    return { city: data.city, region: data.region, country: data.country_name };
  },
});

const resolveSafePath = (filePath: string) => {
  const resolved = path.resolve(PWD, filePath);
  if (!resolved.startsWith(PWD)) {
    throw new Error("Access denied: path outside working directory");
  }
  if (!resolved.endsWith(".md")) {
    throw new Error("Only .md files are allowed");
  }
  return resolved;
};

const readMarkdown = tool({
  description: "读取当前工作目录下的 Markdown 文件内容",
  inputSchema: z.object({
    filePath: z.string().describe("相对于工作目录的 .md 文件路径"),
  }),
  execute: async ({ filePath }) => {
    const resolved = resolveSafePath(filePath);
    const content = await fs.readFile(resolved, "utf-8");
    return content;
  },
});

const editMarkdown = tool({
  description: "编辑当前工作目录下的 Markdown 文件，将 oldString 替换为 newString",
  inputSchema: z.object({
    filePath: z.string().describe("相对于工作目录的 .md 文件路径"),
    oldString: z.string().describe("要替换的原始文本"),
    newString: z.string().describe("替换后的新文本"),
  }),
  execute: async ({ filePath, oldString, newString }) => {
    const resolved = resolveSafePath(filePath);
    const content = await fs.readFile(resolved, "utf-8");
    if (!content.includes(oldString)) {
      throw new Error("oldString not found in file");
    }
    const newContent = content.replace(oldString, newString);
    await fs.writeFile(resolved, newContent, "utf-8");
    return "File updated successfully";
  },
});

const result = streamText({
  model: GLM5_1,
  system: "你是一个简洁的技术文档写手。",
  prompt: "帮我查询当前7天天气,并写出好看的md",
  tools: {
    getWeatcher: weatherTool,
    getTime,
    getCurrentCity,
    readMarkdown,
    editMarkdown,
  },
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk); // 逐字输出
}

// const text = await result.text; // 完整文本
// const usage = await result.totalUsage; // 累计 token 用量
// const steps = await result.steps; // 所有步骤详情

// console.log(text, usage, steps)
function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createPartialAssistant(model: string, api: string, provider: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider,
    model,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export async function* mapFullStreamToAgentEvents(
  fullStream: (typeof result)["fullStream"],
  model: string,
  api: string,
  provider: string,
): AsyncIterable<AgentEvent> {
  const partial = createPartialAssistant(model, api, provider);
  let contentIndex = 0;
  let stepCount = 0;
  let textBuffer = "";
  let thinkingBuffer = "";
  const toolResults: ToolResultMessage[] = [];
  const collectedMessages: AgentMessage[] = [];

  yield { type: "agent_start" };

  // Iterate over every event in fullStream
  for await (const part of fullStream) {
    switch (part.type) {
      // --- Stream lifecycle ---
      case "start": {
        console.log(`[start] Stream started`);
        break;
      }

      case "start-step": {
        console.log(`[start-step] Step started`);
        if (stepCount === 0) {
          yield { type: "turn_start" };
        }
        // Reset partial for new step
        partial.content = [];
        contentIndex = 0;
        textBuffer = "";
        thinkingBuffer = "";

        yield { type: "message_start", message: { ...partial } };
        stepCount++;
        break;
      }

      // --- Text generation ---
      case "text-start": {
        console.log(`[text-start] Text block started`);
        const textStartEvt: AssistantMessageEvent = {
          type: "text_start",
          contentIndex,
          partial: { ...partial },
        };
        yield {
          type: "message_update",
          message: { ...partial },
          assistantMessageEvent: textStartEvt,
        };
        break;
      }

      case "text-delta": {
        console.log(`\n[text-delta] Text block ended`);

        textBuffer += part.text;
        // Update the partial message content
        const textContent: TextContent = { type: "text", text: textBuffer };
        partial.content[contentIndex] = textContent;

        const textDeltaEvt: AssistantMessageEvent = {
          type: "text_delta" as const,
          contentIndex,
          delta: part.text,
          partial: { ...partial },
        };

        yield {
          type: "message_update",
          message: { ...partial },
          assistantMessageEvent: textDeltaEvt,
        };
        break;
      }

      case "text-end": {
        console.log(`\n[text-end] Text block ended`);
        const textEndEvt: AssistantMessageEvent = {
          type: "text_end",
          contentIndex,
          content: textBuffer,
          partial: { ...partial },
        };
        yield {
          type: "message_update",
          message: { ...partial },
          assistantMessageEvent: textEndEvt,
        };
        contentIndex++;
        textBuffer = "";
        break;
      }

      // --- Reasoning / Thinking ---
      case "reasoning-start": {
        console.log(`[reasoning-start] Reasoning started`);

        const reasoningStartEvt: AssistantMessageEvent = {
          type: "thinking_start",
          contentIndex,
          partial: { ...partial },
        };

        yield {
          type: "message_update",
          message: { ...partial },
          assistantMessageEvent: reasoningStartEvt,
        };

        break;
      }

      case "reasoning-delta": {
        thinkingBuffer += part.text;
        const thinkingContent: ThinkingContent = {
          type: "thinking" as const,
          thinking: thinkingBuffer,
        };
        partial.content[contentIndex] = thinkingContent;

        const reasoningDeltaEvt: AssistantMessageEvent = {
          type: "thinking_delta",
          contentIndex,
          delta: part.text,
          partial: { ...partial },
        };

        yield {
          type: "message_update",
          message: { ...partial },
          assistantMessageEvent: reasoningDeltaEvt,
        };

        break;
      }

      case "reasoning-end": {
        console.log(`\n[reasoning-end] Reasoning ended`);
        const reasoningDeltaEvt: AssistantMessageEvent = {
          type: "thinking_end",
          contentIndex,
          content: thinkingBuffer,
          partial: { ...partial },
        };
        yield {
          type: "message_update",
          message: { ...partial },
          assistantMessageEvent: reasoningDeltaEvt,
        };
        contentIndex++;
        thinkingBuffer = "";
        break;
      }

      // --- Tool calls ---
      case "tool-input-start": {
        console.log(`[tool-input-start] Tool input streaming for: ${part.toolName}`);
        const assistantMessageEvent: AssistantMessageEvent = {
          type: "toolcall_start",
          contentIndex,
          partial: { ...partial },
        };
        yield {
          type: "message_update",
          message: { ...partial },
          assistantMessageEvent,
        };
        break;
      }

      case "tool-input-delta": {
        console.log(`[tool-input-delta] Input chunk: ${part.delta}`);
        const assistantMessageEvent: AssistantMessageEvent = {
          type: "toolcall_delta",
          contentIndex,
          delta: part.delta,
          partial: { ...partial },
        };
        yield {
          type: "message_update",
          message: { ...partial },
          assistantMessageEvent,
        };
        break;
      }

      case "tool-input-end": {
        // ignore
        console.log(`[tool-input-end] Tool input complete`);
        break;
      }

      case "tool-call": {
        console.log(
          `[tool-call] Tool: ${part.toolName}, ID: ${part.toolCallId}, Args: ${JSON.stringify(part, undefined, 2)}`,
        );
        const toolCall: ToolCall = {
          type: "toolCall" as const,
          id: part.toolCallId,
          name: part.toolName,
          arguments: part.input as Record<string, unknown>,
        };
        partial.content[contentIndex] = toolCall;
        partial.stopReason = "toolUse";

        const assistantMessageEvent: AssistantMessageEvent = {
          type: "toolcall_end",
          contentIndex,
          toolCall,
          partial: { ...partial },
        };
        yield { type: "message_update", message: { ...partial }, assistantMessageEvent };

        // Emit tool execution start (tool is about to be executed by AI SDK)
        yield {
          type: "tool_execution_start",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.input,
        };

        contentIndex++;
        break;
      }

      case "tool-result": {
        console.log(
          `[tool-result] Tool: ${part.toolName}, Result: ${JSON.stringify(part, undefined, 2)}`,
        );

        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          content: [{ type: "text", text: JSON.stringify(part.output) }],
          isError: false,
          timestamp: Date.now(),
        };
        toolResults.push(toolResult);

        yield {
          type: "tool_execution_end",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.output,
          isError: false,
        };

        // Emit the tool result as a message
        yield { type: "message_start", message: toolResult };
        yield { type: "message_end", message: toolResult };
        collectedMessages.push(toolResult);

        break;
      }

      case "tool-error": {
        console.error(`[tool-error] Tool: ${part.toolName}, Error: ${part.error}`);

        const errorToolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          content: [{ type: "text", text: String(part.error) }],
          isError: true,
          timestamp: Date.now(),
        };
        toolResults.push(errorToolResult);

        yield {
          type: "tool_execution_end",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          result: part.error,
          isError: true,
        };

        yield { type: "message_start", message: errorToolResult };
        yield { type: "message_end", message: errorToolResult };
        collectedMessages.push(errorToolResult);
        break;
      }

      // --- Sources ---
      case "source": {
        console.log(`[source] Source: ${JSON.stringify(part)}`);
        break;
      }

      // --- Files ---
      case "file": {
        console.log(`[file] File received: ${part.file.mediaType}`);
        break;
      }

      // --- Step lifecycle ---
      case "finish-step": {
        console.log(
          `[finish-step] Reason: ${part.finishReason}, Usage: ${JSON.stringify(part.usage)}`,
        );
        // Update usage from the step
        if (part.usage) {
          partial.usage = {
            input: part.usage.inputTokens ?? 0,
            output: part.usage.outputTokens ?? 0,
            cacheRead: part.usage.inputTokenDetails.cacheReadTokens ?? 0,
            cacheWrite: part.usage.inputTokenDetails.cacheWriteTokens ?? 0,
            totalTokens: part.usage.totalTokens ?? 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }

        const finalMessage: AssistantMessage = { ...partial, timestamp: Date.now() };
        yield { type: "message_end", message: finalMessage };
        collectedMessages.push(finalMessage);
        break;
      }

      case "finish": {
        console.log(
          `[finish] Final reason: ${part.finishReason}, Total usage: ${JSON.stringify(part.totalUsage)}`,
        );
        const lastAssistant = collectedMessages.findLast(
          (m): m is AssistantMessage => (m as AssistantMessage).role === "assistant",
        );
        if (lastAssistant) {
          yield {
            type: "turn_end",
            message: lastAssistant,
            toolResults: [...toolResults],
          };
        }
        yield { type: "agent_end", messages: collectedMessages };
        break;
      }

      // --- Errors ---
      case "error": {
        console.error(`[error] Stream error:`, part.error);

        // Close the assistant message with error
        partial.stopReason = "error";
        const errorMessage: AssistantMessage = { ...partial, timestamp: Date.now() };
        yield { type: "message_end", message: errorMessage };
        collectedMessages.push(errorMessage);

        // Close turn + agent
        yield {
          type: "turn_end",
          message: errorMessage,
          toolResults: [...toolResults],
        };
        yield { type: "agent_end", messages: collectedMessages };
        break;
      }

      // --- Raw provider events ---
      case "raw": {
        // Uncomment to see raw provider chunks:
        // console.log(`[raw]`, part.rawValue);
        break;
      }

      default: {
        console.log(`[unknown] ${(part as { type: string }).type}`);
      }
    }
  }
}

// 如果模型调用了工具：
console.log(await result.toolCalls); // [{ toolName: "getWeather", args: { city: "Tokyo" } }]
console.log(await result.toolResults); // [{ toolName: "getWeather", result: { ... } }]
