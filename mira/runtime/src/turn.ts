import fs from "node:fs";
import path from "node:path";
import { planManualBridgeRequest, type ManualBridgeRequestPlan } from "./bridge-request-plan.js";
import { invokeTurnModel } from "./model-adapter.js";
import { loadOperatorContext, type OperatorContextSummary } from "./operator-context.js";
import { loadPersonaCore, type PersonaCore } from "./persona-core.js";
import { getSessionSkeleton } from "./runtime.js";
import { getStateRootReadiness } from "./state-root.js";
import {
  readRuntimeTurnMemorySummary,
  refreshRuntimeTurnMemorySummary,
  type RuntimeTurnMemorySummary,
} from "./turn-memory.js";
import { listRuntimeTurnJournal } from "./turn-journal.js";
import { matchVoiceLabTurn, type VoiceLabMatch } from "./voice-lab.js";

export type RuntimeTurnInput = {
  text?: string;
  sessionId?: string | null;
  requestId?: string;
  messageId?: string;
  suggestTeamPlanFor?: string;
  useModel?: boolean;
  modelProvider?: "ollama" | "ollama_chat" | "local" | "gemma" | "openai" | "openai_responses";
  modelName?: string;
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
    provider: "openai_responses" | "ollama_chat" | null;
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
  personaCore: PersonaCore;
  recentTurns: RecentTurnMemory[];
  recentMemory: {
    loaded: boolean;
    summary: string | null;
    topics: string[];
    openLoops: string[];
    qualityNotes: string[];
    sourceRecordCount: number;
  };
  response: {
    role: "mira";
    content: string;
  };
  voiceLab: VoiceLabMatch | null;
  suggestedTeamPlan: ManualBridgeRequestPlan | null;
};

export type RecentTurnMemory = {
  createdAt: string;
  outcome: "ok" | "error";
  promptPreview: string;
  responsePreview: string | null;
  errorCode: string | null;
  model: string | null;
  voiceLabCaseId: string | null;
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
  personaCore = loadPersonaCore(getStateRootReadiness()),
  recentTurns: RecentTurnMemory[] = [],
  recentMemory: RuntimeTurnMemorySummary | null = null,
): string {
  const lowerText = inputText.toLowerCase();
  const hasStarterContext = session.acceptanceContinuity.loaded || session.normalizedCore.loaded || loadedCoreSummary.available;
  const hasWorkContext = operatorContext.loaded && operatorContext.operatingLanes.length > 0;
  const asksContext = /\b(know|context|memory|remember|loaded|right now|ground|status)\b/.test(lowerText);
  const asksRecentQuality = /\b(bad|dumb|wrong|recent|last answer|remember|memory|quality|why.*answer)\b/.test(lowerText);

  if (asksRecentQuality && recentMemory?.summary) {
    const topics = recentMemory.topics;
    if (topics.includes("answer quality") || recentMemory.quality_notes.length > 0) {
      return `${personaCore.name}. I remember the thread turning on answer quality. You wanted less quoting, less status-talk, and more actual use of what just happened.`;
    }
    if (topics.includes("customer reply drafting") || topics.includes("local task review")) {
      return `${personaCore.name}. I remember we were working through local draft and review work. I should keep that grounded and not turn it into a status dump.`;
    }
    return `${personaCore.name}. I remember the recent thread. I should use it directly here, not repeat it back as notes.`;
  }

  if (asksContext) {
    if (hasStarterContext && hasWorkContext) {
      const memoryLine = recentMemory?.summary ? ` ${recentMemory.summary}` : "";
      return `${personaCore.name}. The work areas are loaded, and the recent thread points are in reach.${memoryLine}`;
    }
    if (hasStarterContext) {
      return `${personaCore.name}. The starter notes are loaded. I can use the recent thread without dumping it back at you.`;
    }
    return `${personaCore.name}. Not much yet. I have the live thread, but not real memory loaded behind it.`;
  }

  if (hasStarterContext) {
    const posture = personaCore.relationshipPosture ? " I know the posture James wants: caring, direct, friction-capable, not a mirror." : "";
    const memoryHint = recentMemory?.open_loops[0] ? ` ${recentMemory.open_loops[0]}.` : "";
    return `${personaCore.name}. I'm here.${posture}${memoryHint}`;
  }

  return `${personaCore.name}. I'm here. Say it a little more directly and I'll work with it.`;
}

function preview(value: string | null | undefined, maxLength = 180): string | null {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function summarizePriorResponse(value: string | null | undefined): string | null {
  const normalized = preview(value, 220);
  if (!normalized) return null;
  if (/(I heard:|Runtime state:|Loaded normalized core summary:|Operator context:)/i.test(normalized)) {
    return "runtime recital instead of a real answer";
  }
  if (/Last prompt was .*I answered:/i.test(normalized)) {
    return "journal reflection that started quoting itself";
  }
  return normalized;
}

function loadRecentTurnMemory(limit = 5): RecentTurnMemory[] {
  return listRuntimeTurnJournal({ limit }).records.map((record) => ({
    createdAt: record.created_at,
    outcome: record.outcome,
    promptPreview: preview(record.prompt, 140) || "",
    responsePreview: summarizePriorResponse(record.response?.content),
    errorCode: record.error?.code || null,
    model: record.model?.model || null,
    voiceLabCaseId: record.voice_lab?.caseId || null,
  }));
}

function toRecentMemoryResponse(summary: RuntimeTurnMemorySummary | null): RuntimeTurnResponse["recentMemory"] {
  return {
    loaded: Boolean(summary),
    summary: summary?.summary || null,
    topics: summary?.topics || [],
    openLoops: summary?.open_loops || [],
    qualityNotes: summary?.quality_notes || [],
    sourceRecordCount: summary?.source_record_count || 0,
  };
}

function memoryContextLine(summary: RuntimeTurnMemorySummary | null): string {
  if (!summary || summary.source_record_count <= 0) return "";
  if (summary.topics.includes("answer quality") || summary.quality_notes.length > 0) {
    return " You have been pressing on answer quality, so I should be direct and use the last few turns instead of describing them.";
  }
  if (summary.topics.includes("customer reply drafting") || summary.topics.includes("local task review")) {
    return " The recent work is local draft and review handling, with external sending still off the table.";
  }
  if (summary.last_user_intent) {
    return ` Recently, you ${summary.last_user_intent.replace(/\.$/, "")}.`;
  }
  return "";
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
  const stateRoot = getStateRootReadiness();
  const operatorContext = loadOperatorContext(stateRoot);
  const personaCore = loadPersonaCore(stateRoot);
  const recentTurns = loadRecentTurnMemory();
  const existingRecentMemory = readRuntimeTurnMemorySummary();
  const recentMemorySummary = existingRecentMemory.summary || refreshRuntimeTurnMemorySummary().summary;
  const voiceSeed = input.messageId || input.requestId || null;
  const voiceLab = matchVoiceLabTurn(text, { seed: voiceSeed });
  const memoryPrompt = /\b(bad|dumb|wrong|recent|last answer|remember|memory|quality|why.*answer)\b/i.test(text);
  let responseContent = memoryPrompt && recentMemorySummary
    ? buildContent(text, session, loadedCoreSummary, operatorContext, personaCore, recentTurns, recentMemorySummary)
    : voiceLab?.content || buildContent(text, session, loadedCoreSummary, operatorContext, personaCore, recentTurns, recentMemorySummary);
  let modelInvoked = false;
  let modelProvider: "openai_responses" | "ollama_chat" | null = null;
  let modelName: string | null = null;
  let modelResponseId: string | null = null;
  if (input.useModel === true) {
    const modelResult = await invokeTurnModel({
      text,
      loadedCoreSummary,
      operatorContext,
      personaCore,
      recentTurns,
      recentMemory: recentMemorySummary,
      env: {
        ...process.env,
        ...(input.modelProvider ? { MIRA_RUNTIME_MODEL_PROVIDER: input.modelProvider } : {}),
        ...(input.modelName ? { MIRA_RUNTIME_TURN_MODEL: input.modelName } : {}),
      },
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
    personaCore,
    recentTurns,
    recentMemory: toRecentMemoryResponse(recentMemorySummary),
    response: {
      role: "mira",
      content: `${responseContent}${input.useModel === true || memoryPrompt ? "" : memoryContextLine(recentMemorySummary)}`.trim(),
    },
    voiceLab,
    suggestedTeamPlan,
  };
}
