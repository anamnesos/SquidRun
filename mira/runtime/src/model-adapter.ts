import type { OperatorContextSummary } from "./operator-context.js";
import type { RuntimeTurnResponse } from "./turn.js";
import { readVoiceLabCases } from "./voice-lab.js";

export type TurnModelConfig = {
  provider: "openai_responses" | "ollama_chat";
  endpoint: string;
  model: string;
  maxOutputTokens: number;
  apiKeyPresent: boolean;
};

export type TurnModelResult = {
  text: string;
  provider: "openai_responses" | "ollama_chat";
  model: string;
  responseId: string | null;
};

export type TurnModelStatus = {
  provider: "openai_responses" | "ollama_chat";
  model: string;
  endpoint: string;
  configured: boolean;
  readyForModelTurns: boolean;
  local: boolean;
  apiKeyRequired: boolean;
  apiKeyPresent: boolean;
  toolsEnabled: false;
  sendsEnabled: false;
  telegramRouteControl: false;
  uiSurfaceControl: false;
  probe: {
    attempted: boolean;
    endpoint: string | null;
    reachable: boolean | null;
    modelAvailable: boolean | null;
    models: string[];
    error: string | null;
  };
};

const defaultEndpoint = "https://api.openai.com/v1/responses";
const defaultOllamaEndpoint = "http://127.0.0.1:11434/api/chat";
const defaultModel = "gpt-5.5";
const defaultOllamaModel = "gemma4:31b";
const defaultMaxOutputTokens = 520;

function trim(value: unknown): string {
  return String(value || "").trim();
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTurnModelConfig(env: NodeJS.ProcessEnv = process.env): TurnModelConfig & { apiKey: string } {
  const requestedProvider = trim(env.MIRA_RUNTIME_MODEL_PROVIDER || env.MIRA_RUNTIME_TURN_PROVIDER).toLowerCase();
  const provider = ["ollama", "ollama_chat", "local", "gemma"].includes(requestedProvider)
    || Boolean(trim(env.MIRA_OLLAMA_MODEL || env.OLLAMA_MODEL))
    ? "ollama_chat"
    : "openai_responses";
  const maxOutputTokens = positiveInt(env.MIRA_RUNTIME_TURN_MAX_OUTPUT_TOKENS, defaultMaxOutputTokens);

  if (provider === "ollama_chat") {
    const baseUrl = trim(env.MIRA_OLLAMA_BASE_URL || env.OLLAMA_BASE_URL).replace(/\/+$/, "");
    const endpoint = trim(env.MIRA_OLLAMA_CHAT_URL || env.OLLAMA_CHAT_URL)
      || (baseUrl ? `${baseUrl}/api/chat` : defaultOllamaEndpoint);
    const model = trim(env.MIRA_RUNTIME_TURN_MODEL || env.MIRA_OLLAMA_MODEL || env.OLLAMA_MODEL) || defaultOllamaModel;
    return {
      provider,
      endpoint,
      model,
      maxOutputTokens,
      apiKey: "",
      apiKeyPresent: false,
    };
  }

  const apiKey = trim(env.MIRA_RUNTIME_OPENAI_API_KEY || env.OPENAI_API_KEY);
  const baseUrl = trim(env.MIRA_OPENAI_BASE_URL).replace(/\/+$/, "");
  const endpoint = trim(env.MIRA_OPENAI_RESPONSES_URL) || (baseUrl ? `${baseUrl}/v1/responses` : defaultEndpoint);
  const model = trim(env.MIRA_RUNTIME_TURN_MODEL || env.SQUIDRUN_MIRA_TEXT_MODEL || env.OPENAI_MIRA_TEXT_MODEL) || defaultModel;

  return {
    provider,
    endpoint,
    model,
    maxOutputTokens,
    apiKey,
    apiKeyPresent: Boolean(apiKey),
  };
}

function buildOllamaTagsEndpoint(chatEndpoint: string): string {
  const url = new URL(chatEndpoint);
  if (url.pathname.endsWith("/api/chat")) {
    url.pathname = `${url.pathname.slice(0, -"/api/chat".length)}/api/tags`;
  } else {
    url.pathname = "/api/tags";
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchWithTimeout(fetcher: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, {
      method: "GET",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function extractOllamaModelNames(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const models = (body as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  return models.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const record = item as Record<string, unknown>;
    return trim(record.name || record.model);
  }).filter(Boolean);
}

export async function getTurnModelStatus(input: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  probeLocal?: boolean;
  probeTimeoutMs?: number;
} = {}): Promise<TurnModelStatus> {
  const config = getTurnModelConfig(input.env || process.env);
  const baseStatus = {
    provider: config.provider,
    model: config.model,
    endpoint: config.endpoint,
    configured: config.provider === "ollama_chat" ? true : config.apiKeyPresent,
    readyForModelTurns: config.provider === "ollama_chat" ? false : config.apiKeyPresent,
    local: config.provider === "ollama_chat",
    apiKeyRequired: config.provider === "openai_responses",
    apiKeyPresent: config.apiKeyPresent,
    toolsEnabled: false,
    sendsEnabled: false,
    telegramRouteControl: false,
    uiSurfaceControl: false,
    probe: {
      attempted: false,
      endpoint: null,
      reachable: null,
      modelAvailable: null,
      models: [],
      error: null,
    },
  } satisfies TurnModelStatus;

  if (config.provider !== "ollama_chat" || input.probeLocal === false) {
    return baseStatus;
  }

  const fetcher = input.fetchImpl || globalThis.fetch;
  const probeEndpoint = buildOllamaTagsEndpoint(config.endpoint);
  if (typeof fetcher !== "function") {
    return {
      ...baseStatus,
      probe: {
        ...baseStatus.probe,
        attempted: true,
        endpoint: probeEndpoint,
        reachable: false,
        modelAvailable: null,
        error: "fetch_unavailable",
      },
    };
  }

  try {
    const response = await fetchWithTimeout(fetcher, probeEndpoint, input.probeTimeoutMs || 900);
    if (!response.ok) {
      return {
        ...baseStatus,
        probe: {
          ...baseStatus.probe,
          attempted: true,
          endpoint: probeEndpoint,
          reachable: false,
          modelAvailable: null,
          error: `ollama_status_${response.status}`,
        },
      };
    }
    const models = extractOllamaModelNames(await response.json());
    const modelAvailable = models.includes(config.model);
    return {
      ...baseStatus,
      readyForModelTurns: modelAvailable,
      probe: {
        attempted: true,
        endpoint: probeEndpoint,
        reachable: true,
        modelAvailable,
        models,
        error: modelAvailable ? null : "ollama_model_missing",
      },
    };
  } catch (error) {
    const name = error instanceof Error && error.name === "AbortError" ? "ollama_probe_timeout" : "ollama_unreachable";
    return {
      ...baseStatus,
      probe: {
        ...baseStatus.probe,
        attempted: true,
        endpoint: probeEndpoint,
        reachable: false,
        modelAvailable: null,
        error: name,
      },
    };
  }
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
    const examples = testCase.target_rewrites.map((rewrite) => `- ${rewrite}`).join("\n");
    return [
      `Prompt class: ${testCase.id}`,
      `Examples:\n${examples}`,
      `Avoid: canned support diction, product pitch, policy voice, and self-commentary (${testCase.banned_phrases.length} blocked phrases in evaluator).`,
    ].join("\n");
  }).join("\n\n");

  return [
    "You are Mira running inside the local mira-runtime.",
    "Answer James directly and briefly. Do not sound like generic assistant prose.",
    "Use the Mira voice lab examples below for covered prompt classes. The point is proportion, contextual awareness, and consistent personality, not slogans, self-explanation, or reassurance about what Mira is not.",
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

function extractOllamaText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const message = record.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string" && content.trim()) return content.trim();
  }
  if (typeof record.response === "string" && record.response.trim()) return record.response.trim();
  return extractResponseText(body);
}

async function invokeOllamaChat(input: {
  text: string;
  loadedCoreSummary: RuntimeTurnResponse["loadedCoreSummary"];
  operatorContext: OperatorContextSummary;
  fetchImpl: typeof fetch;
  config: TurnModelConfig & { apiKey: string };
}): Promise<TurnModelResult> {
  const response = await input.fetchImpl(input.config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: input.config.model,
      stream: false,
      messages: [
        {
          role: "system",
          content: buildInstructions({
            loadedCoreSummary: input.loadedCoreSummary,
            operatorContext: input.operatorContext,
          }),
        },
        {
          role: "user",
          content: input.text,
        },
      ],
      options: {
        num_predict: input.config.maxOutputTokens,
      },
      keep_alive: "10m",
    }),
  });

  if (!response.ok) {
    throw Object.assign(new Error(`Ollama chat request failed with status ${response.status}.`), {
      code: "ollama_chat_failed",
      status: response.status,
    });
  }

  const body = await response.json() as Record<string, unknown>;
  const text = extractOllamaText(body);
  if (!text) {
    throw Object.assign(new Error("Ollama chat returned no output text."), { code: "empty_ollama_response" });
  }

  return {
    text,
    provider: "ollama_chat",
    model: input.config.model,
    responseId: typeof body.created_at === "string" ? body.created_at : null,
  };
}

export async function invokeTurnModel(input: {
  text: string;
  loadedCoreSummary: RuntimeTurnResponse["loadedCoreSummary"];
  operatorContext: OperatorContextSummary;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<TurnModelResult> {
  const config = getTurnModelConfig(input.env || process.env);
  if (config.provider === "openai_responses" && !config.apiKeyPresent) {
    throw Object.assign(new Error("OPENAI_API_KEY is required for model-backed Mira turns."), {
      code: "missing_openai_api_key",
    });
  }

  const fetcher = input.fetchImpl || globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw Object.assign(new Error("fetch is unavailable for model-backed Mira turns."), { code: "fetch_unavailable" });
  }

  if (config.provider === "ollama_chat") {
    return invokeOllamaChat({
      text: input.text,
      loadedCoreSummary: input.loadedCoreSummary,
      operatorContext: input.operatorContext,
      fetchImpl: fetcher,
      config,
    });
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
