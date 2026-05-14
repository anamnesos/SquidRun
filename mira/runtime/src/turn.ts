import fs from "node:fs";
import path from "node:path";
import { planManualBridgeRequest, type ManualBridgeRequestPlan } from "./bridge-request-plan.js";
import { invokeTurnModel } from "./model-adapter.js";
import { loadOperatorContext, type OperatorContextSummary } from "./operator-context.js";
import { getSessionSkeleton } from "./runtime.js";
import { getStateRootReadiness } from "./state-root.js";
import { matchVoiceLabTurn, type VoiceLabMatch } from "./voice-lab.js";

export type RuntimeTurnInput = {
  text?: string;
  sessionId?: string | null;
  requestId?: string;
  messageId?: string;
  suggestTeamPlanFor?: string;
  useModel?: boolean;
};

export type RuntimeTurnResponse = {
  ok: true;
  protocol: "mira.runtime_turn.v0";
  runtimeExecutes: false;
  modelInvoked: boolean;
  telegramRouteControl: false;
  uiSurfaceControl: false;
  model: {
    requested: boolean;
    provider: "openai_responses" | null;
    model: string | null;
    responseId: string | null;
    toolsEnabled: false;
    sendsEnabled: false;
    store: false;
  };
  input: {
    text: string;
    sessionId: string | null;
  };
  state: {
    stateRootReady: boolean;
    continuityLoaded: false;
    liveDataImported: false;
    acceptanceContinuityLoaded: boolean;
    acceptanceDocumentCount: number;
    normalizedCoreLoaded: boolean;
    normalizedCoreDocumentCount: number;
  };
  loadedCoreSummary: {
    available: boolean;
    metadataOnly: true;
    liveContinuityExcluded: true;
    identity: string | null;
    relationship: string | null;
    permissions: string | null;
  };
  operatorContext: OperatorContextSummary;
  response: {
    role: "mira";
    content: string;
  };
  voiceLab: VoiceLabMatch | null;
  suggestedTeamPlan: ManualBridgeRequestPlan | null;
};

function readJsonIfInside(stateRootPath: string | null, relativePath: string): Record<string, unknown> | null {
  if (!stateRootPath) return null;
  const stateRoot = path.resolve(stateRootPath);
  const absolutePath = path.resolve(stateRoot, relativePath);
  const relative = path.relative(stateRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;

  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function summarizePermissions(permissions: unknown): string | null {
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return null;
  const values = permissions as Record<string, unknown>;
  const allowed = [
    values.read_local_redacted_context === true ? "read local redacted context" : null,
    values.propose_next_action === true ? "propose next action" : null,
  ].filter(Boolean);
  const blocked = [
    values.send_external === false ? "external sends" : null,
    values.network === false ? "network" : null,
    values.deploy === false ? "deploy" : null,
    values.trade === false ? "trade" : null,
    values.runtime_start === false ? "runtime start" : null,
  ].filter(Boolean);

  return `allowed: ${allowed.join(", ") || "none"}; blocked: ${blocked.join(", ") || "none"}; fail_closed=${values.fail_closed === true}`;
}

function buildLoadedCoreSummary(session = getSessionSkeleton().session): RuntimeTurnResponse["loadedCoreSummary"] {
  const empty = {
    available: false,
    metadataOnly: true,
    liveContinuityExcluded: true,
    identity: null,
    relationship: null,
    permissions: null,
  } as const;

  if (!session.normalizedCore.loaded || !session.stateRootPath) return empty;

  const selfProfile = readJsonIfInside(session.stateRootPath, "continuity/core/mira-self-profile.normalized.json");
  const relationship = readJsonIfInside(session.stateRootPath, "continuity/core/james-relationship-state.normalized.json");
  const permissions = readJsonIfInside(session.stateRootPath, "permissions/core/relationship-presence-permissions.normalized.json");

  return {
    available: true,
    metadataOnly: true,
    liveContinuityExcluded: true,
    identity: selfProfile
      ? `Mira profile=${String(selfProfile.profile_kind || "unknown")}; role=${String(selfProfile.role || "unknown")}; model_runtime_active=${selfProfile.model_runtime_active === true}; persona_runtime_active=${selfProfile.persona_runtime_active === true}`
      : null,
    relationship: relationship
      ? `James mode=${String(relationship.relationship_mode || "unknown")}; knows=${String(relationship.what_mira_knows_about_james || "not loaded")}`
      : null,
    permissions: permissions ? summarizePermissions(permissions.permissions) : null,
  };
}

function buildContent(
  inputText: string,
  session = getSessionSkeleton().session,
  loadedCoreSummary = buildLoadedCoreSummary(session),
  operatorContext = loadOperatorContext(getStateRootReadiness()),
): string {
  const stateParts = [
    session.acceptanceContinuity.loaded
      ? `acceptance docs loaded=${session.acceptanceContinuity.documentCount}`
      : "acceptance docs not loaded",
    session.normalizedCore.loaded
      ? `normalized core loaded=${session.normalizedCore.documentCount}`
      : "normalized core not loaded",
    "full continuity not claimed",
  ];
  const coreParts = loadedCoreSummary.available
    ? [
      loadedCoreSummary.identity,
      loadedCoreSummary.relationship,
      loadedCoreSummary.permissions,
    ].filter(Boolean)
    : [];

  const coreLine = coreParts.length > 0
    ? `\nLoaded normalized core summary: ${coreParts.join(" | ")}.`
    : "";
  const operatorLine = operatorContext.loaded
    ? `\nOperator context: ${operatorContext.businessThesis || "business thesis loaded"} Lanes: ${operatorContext.operatingLanes.join(", ")}.`
    : "";

  return `I heard: ${inputText}\nRuntime state: ${stateParts.join("; ")}.${coreLine}${operatorLine}`;
}

export async function runRuntimeTurn(input: RuntimeTurnInput = {}): Promise<RuntimeTurnResponse> {
  const text = String(input.text || "").trim();
  if (!text) {
    throw Object.assign(new Error("Runtime turn text cannot be empty."), { code: "empty_turn_text" });
  }

  const session = getSessionSkeleton().session;
  const sessionId = typeof input.sessionId === "string" && input.sessionId.trim()
    ? input.sessionId.trim()
    : null;
  const loadedCoreSummary = buildLoadedCoreSummary(session);
  const operatorContext = loadOperatorContext(getStateRootReadiness());
  const voiceSeed = input.messageId || input.requestId || null;
  const voiceLab = matchVoiceLabTurn(text, { seed: voiceSeed });
  let responseContent = voiceLab?.content || buildContent(text, session, loadedCoreSummary, operatorContext);
  let modelInvoked = false;
  let modelProvider: "openai_responses" | null = null;
  let modelName: string | null = null;
  let modelResponseId: string | null = null;
  if (input.useModel === true) {
    const modelResult = await invokeTurnModel({
      text,
      loadedCoreSummary,
      operatorContext,
    });
    responseContent = modelResult.text;
    modelInvoked = true;
    modelProvider = modelResult.provider;
    modelName = modelResult.model;
    modelResponseId = modelResult.responseId;
  }
  let suggestedTeamPlan: ManualBridgeRequestPlan | null = null;
  if (input.suggestTeamPlanFor) {
    const planInput = {
      targetRole: input.suggestTeamPlanFor,
      content: responseContent,
      sessionId,
    };
    if (input.messageId) {
      Object.assign(planInput, { messageId: input.messageId });
    }
    if (input.requestId) {
      Object.assign(planInput, { requestId: input.requestId });
    }
    suggestedTeamPlan = planManualBridgeRequest(planInput);
  }

  return {
    ok: true,
    protocol: "mira.runtime_turn.v0",
    runtimeExecutes: false,
    modelInvoked,
    telegramRouteControl: false,
    uiSurfaceControl: false,
    model: {
      requested: input.useModel === true,
      provider: modelProvider,
      model: modelName,
      responseId: modelResponseId,
      toolsEnabled: false,
      sendsEnabled: false,
      store: false,
    },
    input: {
      text,
      sessionId,
    },
    state: {
      stateRootReady: session.stateRootReady,
      continuityLoaded: false,
      liveDataImported: false,
      acceptanceContinuityLoaded: session.acceptanceContinuity.loaded,
      acceptanceDocumentCount: session.acceptanceContinuity.documentCount,
      normalizedCoreLoaded: session.normalizedCore.loaded,
      normalizedCoreDocumentCount: session.normalizedCore.documentCount,
    },
    loadedCoreSummary,
    operatorContext,
    response: {
      role: "mira",
      content: responseContent,
    },
    voiceLab,
    suggestedTeamPlan,
  };
}
