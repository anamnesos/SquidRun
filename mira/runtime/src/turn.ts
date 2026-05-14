import { planManualBridgeRequest, type ManualBridgeRequestPlan } from "./bridge-request-plan.js";
import { getSessionSkeleton } from "./runtime.js";

export type RuntimeTurnInput = {
  text?: string;
  sessionId?: string | null;
  requestId?: string;
  messageId?: string;
  suggestTeamPlanFor?: string;
};

export type RuntimeTurnResponse = {
  ok: true;
  protocol: "mira.runtime_turn.v0";
  runtimeExecutes: false;
  modelInvoked: false;
  telegramRouteControl: false;
  uiSurfaceControl: false;
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
  response: {
    role: "mira";
    content: string;
  };
  suggestedTeamPlan: ManualBridgeRequestPlan | null;
};

function buildContent(inputText: string, session = getSessionSkeleton().session): string {
  const stateParts = [
    session.acceptanceContinuity.loaded
      ? `acceptance docs loaded=${session.acceptanceContinuity.documentCount}`
      : "acceptance docs not loaded",
    session.normalizedCore.loaded
      ? `normalized core loaded=${session.normalizedCore.documentCount}`
      : "normalized core not loaded",
    "full continuity not claimed",
  ];

  return `I heard: ${inputText}\nRuntime state: ${stateParts.join("; ")}.`;
}

export function runRuntimeTurn(input: RuntimeTurnInput = {}): RuntimeTurnResponse {
  const text = String(input.text || "").trim();
  if (!text) {
    throw Object.assign(new Error("Runtime turn text cannot be empty."), { code: "empty_turn_text" });
  }

  const session = getSessionSkeleton().session;
  const sessionId = typeof input.sessionId === "string" && input.sessionId.trim()
    ? input.sessionId.trim()
    : null;
  const responseContent = buildContent(text, session);
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
    modelInvoked: false,
    telegramRouteControl: false,
    uiSurfaceControl: false,
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
    response: {
      role: "mira",
      content: responseContent,
    },
    suggestedTeamPlan,
  };
}
