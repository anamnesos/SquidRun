import { getTurnModelStatus } from "./model-adapter.js";

export type ModelProviderStatus = {
  ok: true;
  protocol: "mira.model_provider_status.v0";
  selectedProvider: "openai_responses" | "ollama_chat";
  model: string;
  endpoint: string;
  available: boolean;
  reason:
    | "openai_key_present"
    | "missing_openai_api_key"
    | "ollama_ready"
    | "ollama_unreachable"
    | "ollama_model_missing";
  checkedEndpoint: string | null;
  installedModels: string[];
  nextLocalModelStep: string | null;
  runtimeBlocked: false;
};

export type ModelProviderChoice = {
  id: "ollama_gemma" | "openai_gpt" | "claude_subscription" | "gemini_subscription";
  label: string;
  provider: "ollama_chat" | "openai_responses" | "unwired";
  model: string | null;
  available: boolean;
  selectable: boolean;
  reason: string;
  subscriptionKnown: boolean;
  runtimeAdapterReady: boolean;
};

export type ModelProviderList = {
  ok: true;
  protocol: "mira.model_provider_list.v0";
  selectedProvider: "openai_responses" | "ollama_chat";
  choices: ModelProviderChoice[];
};

function buildStatusInput(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): Parameters<typeof getTurnModelStatus>[0] {
  const statusInput: Parameters<typeof getTurnModelStatus>[0] = { env };
  if (fetchImpl) {
    statusInput.fetchImpl = fetchImpl;
  }
  return statusInput;
}

export async function getModelProviderStatus(input: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
} = {}): Promise<ModelProviderStatus> {
  const statusInput: Parameters<typeof getTurnModelStatus>[0] = {
    env: input.env || process.env,
  };
  if (input.fetchImpl) {
    statusInput.fetchImpl = input.fetchImpl;
  }
  const status = await getTurnModelStatus(statusInput);
  if (status.provider === "ollama_chat") {
    const available = status.readyForModelTurns;
    const reason = available
      ? "ollama_ready"
      : status.probe.modelAvailable === false
        ? "ollama_model_missing"
        : "ollama_unreachable";
    return {
      ok: true,
      protocol: "mira.model_provider_status.v0",
      selectedProvider: status.provider,
      model: status.model,
      endpoint: status.endpoint,
      available,
      reason,
      checkedEndpoint: status.probe.endpoint,
      installedModels: status.probe.models,
      nextLocalModelStep: available
        ? null
        : reason === "ollama_model_missing"
          ? `Run: ollama pull ${status.model}.`
          : `Install/start Ollama, then run: ollama pull ${status.model}. Start Mira with MIRA_RUNTIME_MODEL_PROVIDER=ollama.`,
      runtimeBlocked: false,
    };
  }

  return {
    ok: true,
    protocol: "mira.model_provider_status.v0",
    selectedProvider: status.provider,
    model: status.model,
    endpoint: status.endpoint,
    available: status.readyForModelTurns,
    reason: status.apiKeyPresent ? "openai_key_present" : "missing_openai_api_key",
    checkedEndpoint: null,
    installedModels: [],
    nextLocalModelStep: "For local/offline model use: install Ollama, run ollama pull gemma4:31b, then set MIRA_RUNTIME_MODEL_PROVIDER=ollama.",
    runtimeBlocked: false,
  };
}

export async function getModelProviderList(input: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
} = {}): Promise<ModelProviderList> {
  const env = input.env || process.env;
  const fetchImpl = input.fetchImpl;
  const selected = await getTurnModelStatus(buildStatusInput(env, fetchImpl));
  const ollamaInput: Parameters<typeof getModelProviderStatus>[0] = {
    env: {
      ...env,
      MIRA_RUNTIME_MODEL_PROVIDER: "ollama",
      MIRA_RUNTIME_TURN_MODEL: env.MIRA_OLLAMA_MODEL || env.OLLAMA_MODEL || "gemma4:31b",
    },
  };
  if (fetchImpl) ollamaInput.fetchImpl = fetchImpl;
  const ollama = await getModelProviderStatus(ollamaInput);
  const openaiInput: Parameters<typeof getModelProviderStatus>[0] = {
    env: {
      ...env,
      MIRA_RUNTIME_MODEL_PROVIDER: "openai",
      MIRA_RUNTIME_TURN_MODEL: env.SQUIDRUN_MIRA_TEXT_MODEL || env.OPENAI_MIRA_TEXT_MODEL || env.MIRA_RUNTIME_TURN_MODEL || "gpt-5.5",
      MIRA_OLLAMA_MODEL: "",
      OLLAMA_MODEL: "",
    },
  };
  if (fetchImpl) openaiInput.fetchImpl = fetchImpl;
  const openai = await getModelProviderStatus(openaiInput);

  return {
    ok: true,
    protocol: "mira.model_provider_list.v0",
    selectedProvider: selected.provider,
    choices: [
      {
        id: "ollama_gemma",
        label: "Gemma local",
        provider: "ollama_chat",
        model: ollama.model,
        available: ollama.available,
        selectable: ollama.available,
        reason: ollama.reason,
        subscriptionKnown: false,
        runtimeAdapterReady: true,
      },
      {
        id: "openai_gpt",
        label: "OpenAI API",
        provider: "openai_responses",
        model: openai.model,
        available: openai.available,
        selectable: openai.available,
        reason: openai.reason,
        subscriptionKnown: false,
        runtimeAdapterReady: true,
      },
      {
        id: "claude_subscription",
        label: "Claude subscription",
        provider: "unwired",
        model: null,
        available: false,
        selectable: false,
        reason: "subscription_known_runtime_adapter_not_wired",
        subscriptionKnown: true,
        runtimeAdapterReady: false,
      },
      {
        id: "gemini_subscription",
        label: "Gemini subscription",
        provider: "unwired",
        model: null,
        available: false,
        selectable: false,
        reason: "subscription_known_runtime_adapter_not_wired",
        subscriptionKnown: true,
        runtimeAdapterReady: false,
      },
    ],
  };
}
