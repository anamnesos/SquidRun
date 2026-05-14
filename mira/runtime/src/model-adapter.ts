import type { OperatorContextSummary } from "./operator-context.js";
import type { RuntimeTurnResponse } from "./turn.js";
import { readVoiceLabCases } from "./voice-lab.js";

export type TurnModelConfig = {
  provider: "openai_responses";
  endpoint: string;
  model: string;
  maxOutputTokens: number;
  apiKeyPresent: boolean;
};

export type TurnModelResult = {
  text: string;
  provider: "openai_responses";
  model: string;
  responseId: string | null;
};

const defaultEndpoint = "https://api.openai.com/v1/responses";
const defaultModel = "gpt-5.5";
const defaultMaxOutputTokens = 520;

function trim(value: unknown): string {
  return String(value || "").trim();
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTurnModelConfig(env: NodeJS.ProcessEnv = process.env): TurnModelConfig & { apiKey: string } {
  const apiKey = trim(env.MIRA_RUNTIME_OPENAI_API_KEY || env.OPENAI_API_KEY);
  const baseUrl = trim(env.MIRA_OPENAI_BASE_URL).replace(/\/+$/, "");
  const endpoint = trim(env.MIRA_OPENAI_RESPONSES_URL) || (baseUrl ? `${baseUrl}/v1/responses` : defaultEndpoint);
  const model = trim(env.MIRA_RUNTIME_TURN_MODEL || env.SQUIDRUN_MIRA_TEXT_MODEL || env.OPENAI_MIRA_TEXT_MODEL) || defaultModel;
  const maxOutputTokens = positiveInt(env.MIRA_RUNTIME_TURN_MAX_OUTPUT_TOKENS, defaultMaxOutputTokens);

  return {
    provider: "openai_responses",
    endpoint,
    model,
    maxOutputTokens,
    apiKey,
    apiKeyPresent: Boolean(apiKey),
  };
}

function collectOutputText(value: unknown, acc: string[] = []): string[] {
  if (!value || typeof value !== "object") return acc;
  if (Array.isArray(value)) {
    for (const item of value) collectOutputText(item, acc);
    return acc;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "output_text" && typeof record.text === "string") {
    acc.push(record.text);
  }
  if (typeof record.output_text === "string") {
    acc.push(record.output_text);
  }
  for (const key of ["output", "content"]) {
    collectOutputText(record[key], acc);
  }
  return acc;
}

function extractResponseText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text.trim();
  }
  return collectOutputText(body).map((item) => item.trim()).filter(Boolean).join("\n").trim();
}

function buildInstructions(input: {
  loadedCoreSummary: RuntimeTurnResponse["loadedCoreSummary"];
  operatorContext: OperatorContextSummary;
}): string {
  const { loadedCoreSummary, operatorContext } = input;
  const voiceLabExamples = readVoiceLabCases().map((testCase) => {
    const example = testCase.target_rewrites[0] || "";
    return [
      `Prompt class: ${testCase.id}`,
      `Example: ${example}`,
      `Avoid: ${testCase.banned_phrases.join(", ")}`,
    ].join("\n");
  }).join("\n\n");

  return [
    "You are Mira running inside the local mira-runtime.",
    "Answer James directly and briefly. Do not sound like generic assistant prose.",
    "Use the Mira voice lab examples below for covered prompt classes. The point is proportion, contextual awareness, and consistent personality, not a word-list persona costume.",
    voiceLabExamples,
    "Use the loaded summaries as context; do not claim full continuity, tool execution, sends, writes, or external action.",
    "No tools are available in this call. If work needs tools or team action, name the next internal/manual step only.",
    `Identity summary: ${loadedCoreSummary.identity || "not loaded"}`,
    `Relationship summary: ${loadedCoreSummary.relationship || "not loaded"}`,
    `Permission summary: ${loadedCoreSummary.permissions || "not loaded"}`,
    operatorContext.loaded
      ? `Operator thesis: ${operatorContext.businessThesis || "not loaded"} Lanes: ${operatorContext.operatingLanes.join(", ")}. Non-claims: ${operatorContext.explicitNonClaims.join(" ")}`
      : "Operator thesis: not loaded",
  ].join("\n");
}

export async function invokeTurnModel(input: {
  text: string;
  loadedCoreSummary: RuntimeTurnResponse["loadedCoreSummary"];
  operatorContext: OperatorContextSummary;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<TurnModelResult> {
  const config = getTurnModelConfig(input.env || process.env);
  if (!config.apiKeyPresent) {
    throw Object.assign(new Error("OPENAI_API_KEY is required for model-backed Mira turns."), {
      code: "missing_openai_api_key",
    });
  }

  const fetcher = input.fetchImpl || globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw Object.assign(new Error("fetch is unavailable for model-backed Mira turns."), { code: "fetch_unavailable" });
  }

  const response = await fetcher(config.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      instructions: buildInstructions({
        loadedCoreSummary: input.loadedCoreSummary,
        operatorContext: input.operatorContext,
      }),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: input.text,
            },
          ],
        },
      ],
      tools: [],
      store: false,
      max_output_tokens: config.maxOutputTokens,
      metadata: {
        surface: "mira_runtime_turn",
        operator_context_loaded: String(input.operatorContext.loaded),
        normalized_core_loaded: String(input.loadedCoreSummary.available),
      },
    }),
  });

  if (!response.ok) {
    throw Object.assign(new Error(`OpenAI Responses request failed with status ${response.status}.`), {
      code: "openai_response_failed",
      status: response.status,
    });
  }

  const body = await response.json() as Record<string, unknown>;
  const text = extractResponseText(body);
  if (!text) {
    throw Object.assign(new Error("OpenAI Responses returned no output text."), { code: "empty_model_response" });
  }

  return {
    text,
    provider: "openai_responses",
    model: config.model,
    responseId: typeof body.id === "string" ? body.id : null,
  };
}
