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
