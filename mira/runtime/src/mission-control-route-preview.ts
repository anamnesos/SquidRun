import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateRootReadiness } from "./state-root.js";

type JsonObject = Record<string, unknown>;

export type MissionControlRoutePreviewRecord = {
  protocol: "mira.mission_control_route_preview.v0";
  id: string;
  status: "pending_internal_review";
  createdAt: string;
  source: string;
  targetRole: "architect" | "builder" | "oracle";
  targetPaneId: "1" | "2" | "3";
  purpose: string;
  content: string;
  contentPreview: string;
  missionAnswerPreview: string | null;
  evidence: Array<{ kind: string; path?: string; summary?: string }>;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlRoutePreviewInput = {
  preview?: unknown;
  routePreview?: unknown;
  missionAnswer?: unknown;
  source?: unknown;
};

export type MissionControlRoutePreviewWriteResult = {
  ok: true;
  protocol: "mira.mission_control_route_preview_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  record: MissionControlRoutePreviewRecord & { actionToken: string };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlRoutePreviewListResult = {
  ok: true;
  protocol: "mira.mission_control_route_preview_list.v0";
  stateRootPath: string | null;
  previewCount: number;
  previews: Array<MissionControlRoutePreviewRecord & {
    actionToken: string;
    relativePath?: string;
    absolutePath?: string;
  }>;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalRouteRequestRecord = {
  protocol: "mira.mission_control_internal_route_request.v0";
  id: string;
  status: "pending_internal_review";
  createdAt: string;
  sourcePreviewId: string;
  sourcePreviewToken: string;
  targetRole: "architect" | "builder" | "oracle";
  targetPaneId: "1" | "2" | "3";
  purpose: string;
  content: string;
  contentPreview: string;
  missionAnswerPreview: string | null;
  evidence: Array<{ kind: string; path?: string; summary?: string }>;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalRouteRequestWriteResult = {
  ok: true;
  protocol: "mira.mission_control_internal_route_request_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  request: MissionControlInternalRouteRequestRecord & { actionToken: string };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalRouteRequestListResult = {
  ok: true;
  protocol: "mira.mission_control_internal_route_request_list.v0";
  stateRootPath: string | null;
  requestCount: number;
  requests: Array<MissionControlInternalRouteRequestRecord & {
    actionToken: string;
    relativePath?: string;
    absolutePath?: string;
  }>;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlOwnedWorkContinuationDecision = "approve" | "reject" | "edit";
export type MissionControlOwnedWorkContinuationStatus =
  | "approved_for_internal_review"
  | "rejected"
  | "edited_for_internal_review";

export type MissionControlOwnedWorkContinuationRecord = {
  protocol: "mira.mission_control_owned_work_continuation.v0";
  id: string;
  status: MissionControlOwnedWorkContinuationStatus;
  decision: MissionControlOwnedWorkContinuationDecision;
  createdAt: string;
  sourceRequestId: string;
  sourceRequestToken: string;
  sourcePreviewId: string;
  targetRole: "architect" | "builder" | "oracle";
  targetPaneId: "1" | "2" | "3";
  purpose: string;
  content: string;
  contentPreview: string;
  editedContent: string | null;
  note: string | null;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlOwnedWorkContinuationWriteResult = {
  ok: true;
  protocol: "mira.mission_control_owned_work_continuation_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  continuation: MissionControlOwnedWorkContinuationRecord & { actionToken: string };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlOwnedWorkContinuationListResult = {
  ok: true;
  protocol: "mira.mission_control_owned_work_continuation_list.v0";
  stateRootPath: string | null;
  continuationCount: number;
  continuations: Array<MissionControlOwnedWorkContinuationRecord & {
    actionToken: string;
    relativePath?: string;
    absolutePath?: string;
  }>;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlFollowThroughRecommendationStatus =
  | "selected_for_internal_review"
  | "available_for_internal_review"
  | "not_recommended";

export type MissionControlFollowThroughRecommendation = {
  protocol: "mira.mission_control_follow_through_recommendation.v0";
  id: string;
  actionToken: string;
  status: MissionControlFollowThroughRecommendationStatus;
  selected: boolean;
  createdAt: string;
  sourceContinuationId: string;
  sourceContinuationToken: string;
  sourceContinuationDecision: MissionControlOwnedWorkContinuationDecision;
  sourceContinuationStatus: MissionControlOwnedWorkContinuationStatus;
  sourceRequestId: string;
  sourceRequestToken: string;
  sourcePreviewId: string;
  targetRole: "architect" | "builder" | "oracle";
  targetPaneId: "1" | "2" | "3";
  purpose: string;
  nextTeamMove: string;
  contentPreview: string;
  note: string | null;
  selectorReason: string;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlFollowThroughRecommendationListResult = {
  ok: true;
  protocol: "mira.mission_control_follow_through_recommendation_list.v0";
  stateRootPath: string | null;
  recommendationCount: number;
  selectedRecommendation: MissionControlFollowThroughRecommendation | null;
  recommendations: MissionControlFollowThroughRecommendation[];
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalDeliveryPreviewRecord = {
  protocol: "mira.mission_control_internal_delivery_preview.v0";
  id: string;
  status: "reviewed_preview_only";
  createdAt: string;
  sourceRecommendationId: string;
  sourceRecommendationToken: string;
  sourceContinuationId: string;
  sourceContinuationToken: string;
  sourceRequestId: string;
  sourceRequestToken: string;
  sourcePreviewId: string;
  targetRole: "architect" | "builder" | "oracle";
  targetPaneId: "1" | "2" | "3";
  purpose: string;
  content: string;
  contentPreview: string;
  nextTeamMove: string;
  selectorReason: string;
  deliveryPacket: {
    protocol: "mira.mission_control_internal_delivery_preview_packet.v0";
    target: {
      system: "squidrun";
      role: "architect" | "builder" | "oracle";
      paneId: "1" | "2" | "3";
    };
    body: {
      content: string;
    };
  };
  reviewDetails: {
    protocol: "mira.mission_control_internal_delivery_preview_review.v0";
    targetLabel: string;
    packetSha256: string;
    bodySha256: string;
    bodyCharCount: number;
    copyText: string;
    copyInstruction: string;
    manualCopyRequired: true;
    previewOnly: true;
    noLiveSend: true;
  };
  audit: {
    reviewStatus: "preview_ready";
    manualExecutionRequired: true;
    notSent: true;
    commandStored: false;
    sendPerformed: false;
    runtimeExecutes: false;
    externalSend: false;
    telegramSend: false;
    routeFlip: false;
    providerInvoked: false;
    accountOrTokenAccess: false;
    liveHmSend: false;
  };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalDeliveryPreviewWriteResult = {
  ok: true;
  protocol: "mira.mission_control_internal_delivery_preview_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  preview: MissionControlInternalDeliveryPreviewRecord & { actionToken: string };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalDeliveryPreviewListResult = {
  ok: true;
  protocol: "mira.mission_control_internal_delivery_preview_list.v0";
  stateRootPath: string | null;
  previewCount: number;
  previews: Array<MissionControlInternalDeliveryPreviewRecord & {
    actionToken: string;
    relativePath?: string;
    absolutePath?: string;
  }>;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlDispatchReadinessChecklistItem = {
  id:
    | "pane_target_matches"
    | "copied_body_checksum_matches"
    | "manual_review_required"
    | "no_delivery_path";
  label: string;
  ok: true;
};

export type MissionControlDispatchReadinessRecord = {
  protocol: "mira.mission_control_dispatch_readiness.v0";
  id: string;
  status: "ready_for_manual_dispatch_review";
  createdAt: string;
  sourceDeliveryPreviewId: string;
  sourceDeliveryPreviewToken: string;
  sourceRecommendationId: string;
  sourceContinuationId: string;
  sourceRequestId: string;
  sourcePreviewId: string;
  targetRole: "architect" | "builder" | "oracle";
  targetPaneId: "1" | "2" | "3";
  targetLabel: string;
  purpose: string;
  content: string;
  contentPreview: string;
  packetSha256: string;
  bodySha256: string;
  copyTextSha256: string;
  checksumMatched: true;
  copiedPaneMessage: {
    targetRole: "architect" | "builder" | "oracle";
    targetPaneId: "1" | "2" | "3";
    body: string;
    bodySha256: string;
    bodyCharCount: number;
  };
  checklist: MissionControlDispatchReadinessChecklistItem[];
  audit: {
    reviewStatus: "dispatch_readiness_ready";
    manualExecutionRequired: true;
    notSent: true;
    commandStored: false;
    sendPerformed: false;
    runtimeExecutes: false;
    externalSend: false;
    telegramSend: false;
    routeFlip: false;
    providerInvoked: false;
    accountOrTokenAccess: false;
    liveHmSend: false;
    checksumMatched: true;
    noHmSendExecution: true;
    noTelegramSend: true;
    noRouteFlip: true;
    noProviderCall: true;
    noRuntimeExecution: true;
    noExternalDelivery: true;
  };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlDispatchReadinessWriteResult = {
  ok: true;
  protocol: "mira.mission_control_dispatch_readiness_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  readiness: MissionControlDispatchReadinessRecord & { actionToken: string };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlDispatchReadinessListResult = {
  ok: true;
  protocol: "mira.mission_control_dispatch_readiness_list.v0";
  stateRootPath: string | null;
  readinessCount: number;
  readiness: Array<MissionControlDispatchReadinessRecord & {
    actionToken: string;
    relativePath?: string;
    absolutePath?: string;
  }>;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalSendDryRunRecord = {
  protocol: "mira.mission_control_internal_send_dry_run.v0";
  id: string;
  status: "dry_run_ready";
  createdAt: string;
  sourceDispatchReadinessId: string;
  sourceDispatchReadinessToken: string;
  sourceDeliveryPreviewId: string;
  sourceDeliveryPreviewToken: string;
  sourceRecommendationId: string;
  sourceContinuationId: string;
  sourceRequestId: string;
  sourcePreviewId: string;
  targetRole: "architect" | "builder" | "oracle";
  targetPaneId: "1" | "2" | "3";
  targetLabel: string;
  purpose: string;
  content: string;
  contentPreview: string;
  bodySha256: string;
  packetSha256: string;
  adapterDryRun: {
    protocol: "mira.hm_send_adapter.v0";
    dryRun: true;
    channel: "hm-send";
    transport: "ui/scripts/hm-send.js";
    target: {
      system: "squidrun";
      role: "architect" | "builder" | "oracle";
      pane_id: "1" | "2" | "3";
    };
    body: {
      content: string;
    };
  };
  activationGate: {
    protocol: "mira.mission_control_internal_send_activation_gate.v0";
    required: true;
    requiredReview: "separate_reviewed_activation";
    realSendAllowed: false;
    liveHmSendExecutionAllowed: false;
  };
  audit: {
    reviewStatus: "internal_send_dry_run_ready";
    dryRunOnly: true;
    manualExecutionRequired: true;
    realSendRequiresSeparateActivation: true;
    dispatchReadinessChecksumMatched: true;
    notSent: true;
    commandStored: false;
    sendPerformed: false;
    runtimeExecutes: false;
    externalSend: false;
    telegramSend: false;
    routeFlip: false;
    providerInvoked: false;
    accountOrTokenAccess: false;
    liveHmSend: false;
  };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalSendDryRunWriteResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_dry_run_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  dryRun: MissionControlInternalSendDryRunRecord & { actionToken: string };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalSendDryRunListResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_dry_run_list.v0";
  stateRootPath: string | null;
  dryRunCount: number;
  dryRuns: Array<MissionControlInternalSendDryRunRecord & {
    actionToken: string;
    relativePath?: string;
    absolutePath?: string;
  }>;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalSendActivationDesignRequirement = {
  id:
    | "missing_or_bad_token_refuses"
    | "live_effect_input_refuses"
    | "command_input_refuses"
    | "separate_review_required"
    | "pre_activation_snapshot_required"
    | "failure_audit_required"
    | "durable_activation_audit_required"
    | "transport_result_audit_required"
    | "no_command_storage_required";
  label: string;
  ok: true;
};

export type MissionControlInternalSendActivationDesignRecord = {
  protocol: "mira.mission_control_internal_send_activation_design.v0";
  id: string;
  status: "activation_design_review_only";
  createdAt: string;
  sourceInternalSendDryRunId: string;
  sourceInternalSendDryRunToken: string;
  sourceDispatchReadinessId: string;
  sourceDispatchReadinessToken: string;
  sourceDeliveryPreviewId: string;
  sourceDeliveryPreviewToken: string;
  sourceRecommendationId: string;
  sourceContinuationId: string;
  sourceRequestId: string;
  sourcePreviewId: string;
  targetRole: "architect" | "builder" | "oracle";
  targetPaneId: "1" | "2" | "3";
  targetLabel: string;
  purpose: string;
  content: string;
  contentPreview: string;
  bodySha256: string;
  adapterPacketSha256: string;
  activationDesign: {
    protocol: "mira.mission_control_internal_send_activation_design_gate.v0";
    designOnly: true;
    activationAllowed: false;
    requiredReview: "separate_reviewed_activation";
    refusalRollbackAuditRequired: true;
    liveHmSendExecutionAllowed: false;
    realSendAllowed: false;
  };
  refusalRequirements: MissionControlInternalSendActivationDesignRequirement[];
  rollbackRequirements: MissionControlInternalSendActivationDesignRequirement[];
  auditRequirements: MissionControlInternalSendActivationDesignRequirement[];
  audit: {
    reviewStatus: "activation_design_ready";
    dryRunOnly: true;
    designOnly: true;
    manualExecutionRequired: true;
    realSendRequiresSeparateActivation: true;
    sourceDryRunChecksumMatched: true;
    notSent: true;
    commandStored: false;
    sendPerformed: false;
    runtimeExecutes: false;
    externalSend: false;
    telegramSend: false;
    routeFlip: false;
    providerInvoked: false;
    accountOrTokenAccess: false;
    liveHmSend: false;
  };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalSendActivationDesignWriteResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_activation_design_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  design: MissionControlInternalSendActivationDesignRecord & { actionToken: string };
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

export type MissionControlInternalSendActivationDesignListResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_activation_design_list.v0";
  stateRootPath: string | null;
  designCount: number;
  designs: Array<MissionControlInternalSendActivationDesignRecord & {
    actionToken: string;
    relativePath?: string;
    absolutePath?: string;
  }>;
  manualExecutionRequired: true;
  reviewRequired: true;
  internalOnly: true;
  reviewableOwnedWork: true;
  notSent: true;
  commandStored: false;
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramSend: false;
  routeFlip: false;
  providerInvoked: false;
  accountOrTokenAccess: false;
  liveHmSend: false;
};

const allowedRoles = new Set(["architect", "builder", "oracle"]);

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function previewsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "route-previews");
}

function routeRequestsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "internal-route-requests");
}

function continuationsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "owned-work-continuations");
}

function deliveryPreviewsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "internal-delivery-previews");
}

function dispatchReadinessDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "dispatch-readiness");
}

function internalSendDryRunsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "internal-send-dry-runs");
}

function internalSendActivationDesignsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "internal-send-activation-designs");
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an object.`), { code: "invalid_route_preview_record" });
  }
  return value as JsonObject;
}

function nonEmptyText(value: unknown, label: string, maxLength: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    throw Object.assign(new Error(`${label} is required.`), { code: "invalid_route_preview_record" });
  }
  return text.slice(0, maxLength);
}

function optionalPreview(value: unknown, maxLength: number): string | null {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) return null;
  return text.slice(0, maxLength);
}

function assertTrue(value: unknown, label: string): void {
  if (value !== true) {
    throw Object.assign(new Error(`${label} must be true for a persisted Mission Control preview.`), {
      code: "route_preview_not_reviewable",
    });
  }
}

function assertFalse(value: unknown, label: string): void {
  if (value !== false) {
    throw Object.assign(new Error(`${label} must be false for a preview/history record.`), {
      code: "route_preview_has_live_effect",
    });
  }
}

function rejectExplicitTrue(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for a preview/history record.`), {
      code: "route_preview_has_live_effect",
    });
  }
}

function rejectRouteRequestLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for an internal route request.`), {
      code: "mission_control_route_request_has_live_effect",
    });
  }
}

function rejectContinuationLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for an owned-work continuation.`), {
      code: "mission_control_continuation_has_live_effect",
    });
  }
}

function rejectDeliveryPreviewLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for an internal delivery preview.`), {
      code: "mission_control_delivery_preview_has_live_effect",
    });
  }
}

function rejectDispatchReadinessLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for a dispatch-readiness checklist.`), {
      code: "mission_control_dispatch_readiness_has_live_effect",
    });
  }
}

function rejectInternalSendDryRunLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for an internal-send dry run.`), {
      code: "mission_control_internal_send_dry_run_has_live_effect",
    });
  }
}

function rejectInternalSendActivationDesignLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for an internal-send activation design.`), {
      code: "mission_control_internal_send_activation_design_has_live_effect",
    });
  }
}

function optionalObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function rejectRouteRequestInput(input: JsonObject): void {
  if ("command" in input || "args" in input) {
    throw Object.assign(new Error("Mission Control route requests do not accept command or args fields."), {
      code: "mission_control_route_request_command_not_allowed",
    });
  }
  const audit = optionalObject(input.audit);
  const plan = optionalObject(input.plan);
  for (const [containerLabel, container] of [["request", input], ["audit", audit], ["plan", plan]] as const) {
    if (!container) continue;
    for (const flag of [
      "sendPerformed",
      "runtimeExecutes",
      "externalSend",
      "telegramSend",
      "routeFlip",
      "providerInvoked",
      "accountOrTokenAccess",
      "liveHmSend",
    ]) {
      rejectRouteRequestLiveEffect(container[flag], `${containerLabel}.${flag}`);
    }
  }
}

function normalizeEvidence(value: unknown): MissionControlRoutePreviewRecord["evidence"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item) => {
    const raw = item && typeof item === "object" && !Array.isArray(item) ? item as JsonObject : {};
    const kind = optionalPreview(raw.kind, 40) || "summary";
    const pathValue = optionalPreview(raw.path, 220);
    const summary = optionalPreview(raw.summary, 320);
    const normalized: { kind: string; path?: string; summary?: string } = { kind };
    if (pathValue) normalized.path = pathValue;
    if (summary) normalized.summary = summary;
    return normalized;
  });
}

function buildActionToken(id: string): string {
  return `mission-route-${crypto.createHash("sha256").update(`mira.mission_control_route_preview.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildRouteRequestActionToken(id: string): string {
  return `mission-request-${crypto.createHash("sha256").update(`mira.mission_control_internal_route_request.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildOwnedWorkContinuationActionToken(id: string): string {
  return `mission-continuation-${crypto.createHash("sha256").update(`mira.mission_control_owned_work_continuation.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildFollowThroughRecommendationId(id: string): string {
  return `mission-follow-through-${crypto.createHash("sha256").update(`mira.mission_control_follow_through_recommendation.v0:${id}`).digest("hex").slice(0, 24)}`;
}

function buildFollowThroughRecommendationActionToken(id: string): string {
  return `mission-follow-through-${crypto.createHash("sha256").update(`mira.mission_control_follow_through_recommendation.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildDeliveryPreviewActionToken(id: string): string {
  return `mission-delivery-preview-${crypto.createHash("sha256").update(`mira.mission_control_internal_delivery_preview.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildDispatchReadinessActionToken(id: string): string {
  return `mission-dispatch-readiness-${crypto.createHash("sha256").update(`mira.mission_control_dispatch_readiness.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildInternalSendDryRunActionToken(id: string): string {
  return `mission-send-dry-run-${crypto.createHash("sha256").update(`mira.mission_control_internal_send_dry_run.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildInternalSendActivationDesignActionToken(id: string): string {
  return `mission-send-activation-design-${crypto.createHash("sha256").update(`mira.mission_control_internal_send_activation_design.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function checksumPayload(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

function toPublicRecord(record: MissionControlRoutePreviewRecord): MissionControlRoutePreviewRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildActionToken(record.id),
  };
}

function toPublicRouteRequest(record: MissionControlInternalRouteRequestRecord): MissionControlInternalRouteRequestRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildRouteRequestActionToken(record.id),
  };
}

function toPublicContinuation(record: MissionControlOwnedWorkContinuationRecord): MissionControlOwnedWorkContinuationRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildOwnedWorkContinuationActionToken(record.id),
  };
}

function toPublicDeliveryPreview(record: MissionControlInternalDeliveryPreviewRecord): MissionControlInternalDeliveryPreviewRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildDeliveryPreviewActionToken(record.id),
  };
}

function toPublicDispatchReadiness(record: MissionControlDispatchReadinessRecord): MissionControlDispatchReadinessRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildDispatchReadinessActionToken(record.id),
  };
}

function toPublicInternalSendDryRun(record: MissionControlInternalSendDryRunRecord): MissionControlInternalSendDryRunRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildInternalSendDryRunActionToken(record.id),
  };
}

function toPublicInternalSendActivationDesign(record: MissionControlInternalSendActivationDesignRecord): MissionControlInternalSendActivationDesignRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildInternalSendActivationDesignActionToken(record.id),
  };
}

function parseStoredRecord(value: string): MissionControlRoutePreviewRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlRoutePreviewRecord>;
    if (parsed.protocol !== "mira.mission_control_route_preview.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "pending_internal_review") return null;
    if (parsed.manualExecutionRequired !== true || parsed.reviewRequired !== true || parsed.internalOnly !== true) return null;
    if (parsed.notSent !== true || parsed.commandStored !== false) return null;
    if (
      parsed.sendPerformed !== false
      || parsed.runtimeExecutes !== false
      || parsed.externalSend !== false
      || parsed.telegramSend !== false
      || parsed.routeFlip !== false
      || parsed.providerInvoked !== false
      || parsed.accountOrTokenAccess !== false
      || parsed.liveHmSend !== false
    ) return null;
    if (!allowedRoles.has(String(parsed.targetRole))) return null;
    return parsed as MissionControlRoutePreviewRecord;
  } catch {
    return null;
  }
}

function parseRouteRequestRecord(value: string): MissionControlInternalRouteRequestRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlInternalRouteRequestRecord>;
    if (parsed.protocol !== "mira.mission_control_internal_route_request.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "pending_internal_review") return null;
    if (parsed.manualExecutionRequired !== true || parsed.reviewRequired !== true || parsed.internalOnly !== true) return null;
    if (parsed.reviewableOwnedWork !== true || parsed.notSent !== true || parsed.commandStored !== false) return null;
    if (
      parsed.sendPerformed !== false
      || parsed.runtimeExecutes !== false
      || parsed.externalSend !== false
      || parsed.telegramSend !== false
      || parsed.routeFlip !== false
      || parsed.providerInvoked !== false
      || parsed.accountOrTokenAccess !== false
      || parsed.liveHmSend !== false
    ) return null;
    if (!allowedRoles.has(String(parsed.targetRole))) return null;
    if ("command" in parsed || "args" in parsed) return null;
    return parsed as MissionControlInternalRouteRequestRecord;
  } catch {
    return null;
  }
}

function parseContinuationRecord(value: string): MissionControlOwnedWorkContinuationRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlOwnedWorkContinuationRecord>;
    if (parsed.protocol !== "mira.mission_control_owned_work_continuation.v0" || typeof parsed.id !== "string") return null;
    if (!["approved_for_internal_review", "rejected", "edited_for_internal_review"].includes(String(parsed.status))) return null;
    if (!["approve", "reject", "edit"].includes(String(parsed.decision))) return null;
    if (parsed.manualExecutionRequired !== true || parsed.reviewRequired !== true || parsed.internalOnly !== true) return null;
    if (parsed.reviewableOwnedWork !== true || parsed.notSent !== true || parsed.commandStored !== false) return null;
    if (
      parsed.sendPerformed !== false
      || parsed.runtimeExecutes !== false
      || parsed.externalSend !== false
      || parsed.telegramSend !== false
      || parsed.routeFlip !== false
      || parsed.providerInvoked !== false
      || parsed.accountOrTokenAccess !== false
      || parsed.liveHmSend !== false
    ) return null;
    if (!allowedRoles.has(String(parsed.targetRole))) return null;
    if ("command" in parsed || "args" in parsed) return null;
    return parsed as MissionControlOwnedWorkContinuationRecord;
  } catch {
    return null;
  }
}

function parseDeliveryPreviewRecord(value: string): MissionControlInternalDeliveryPreviewRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlInternalDeliveryPreviewRecord>;
    if (parsed.protocol !== "mira.mission_control_internal_delivery_preview.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "reviewed_preview_only") return null;
    if (parsed.manualExecutionRequired !== true || parsed.reviewRequired !== true || parsed.internalOnly !== true) return null;
    if (parsed.reviewableOwnedWork !== true || parsed.notSent !== true || parsed.commandStored !== false) return null;
    if (
      parsed.sendPerformed !== false
      || parsed.runtimeExecutes !== false
      || parsed.externalSend !== false
      || parsed.telegramSend !== false
      || parsed.routeFlip !== false
      || parsed.providerInvoked !== false
      || parsed.accountOrTokenAccess !== false
      || parsed.liveHmSend !== false
    ) return null;
    if (!allowedRoles.has(String(parsed.targetRole))) return null;
    if ("command" in parsed || "args" in parsed) return null;
    return parsed as MissionControlInternalDeliveryPreviewRecord;
  } catch {
    return null;
  }
}

function parseDispatchReadinessRecord(value: string): MissionControlDispatchReadinessRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlDispatchReadinessRecord>;
    if (parsed.protocol !== "mira.mission_control_dispatch_readiness.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "ready_for_manual_dispatch_review") return null;
    if (parsed.manualExecutionRequired !== true || parsed.reviewRequired !== true || parsed.internalOnly !== true) return null;
    if (parsed.reviewableOwnedWork !== true || parsed.notSent !== true || parsed.commandStored !== false) return null;
    if (parsed.checksumMatched !== true) return null;
    if (
      parsed.sendPerformed !== false
      || parsed.runtimeExecutes !== false
      || parsed.externalSend !== false
      || parsed.telegramSend !== false
      || parsed.routeFlip !== false
      || parsed.providerInvoked !== false
      || parsed.accountOrTokenAccess !== false
      || parsed.liveHmSend !== false
    ) return null;
    if (!allowedRoles.has(String(parsed.targetRole))) return null;
    if ("command" in parsed || "args" in parsed) return null;
    return parsed as MissionControlDispatchReadinessRecord;
  } catch {
    return null;
  }
}

function parseInternalSendDryRunRecord(value: string): MissionControlInternalSendDryRunRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlInternalSendDryRunRecord>;
    if (parsed.protocol !== "mira.mission_control_internal_send_dry_run.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "dry_run_ready") return null;
    if (parsed.manualExecutionRequired !== true || parsed.reviewRequired !== true || parsed.internalOnly !== true) return null;
    if (parsed.reviewableOwnedWork !== true || parsed.notSent !== true || parsed.commandStored !== false) return null;
    if (
      parsed.sendPerformed !== false
      || parsed.runtimeExecutes !== false
      || parsed.externalSend !== false
      || parsed.telegramSend !== false
      || parsed.routeFlip !== false
      || parsed.providerInvoked !== false
      || parsed.accountOrTokenAccess !== false
      || parsed.liveHmSend !== false
    ) return null;
    if (!allowedRoles.has(String(parsed.targetRole))) return null;
    if ("command" in parsed || "args" in parsed) return null;
    return parsed as MissionControlInternalSendDryRunRecord;
  } catch {
    return null;
  }
}

function parseInternalSendActivationDesignRecord(value: string): MissionControlInternalSendActivationDesignRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlInternalSendActivationDesignRecord>;
    if (parsed.protocol !== "mira.mission_control_internal_send_activation_design.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "activation_design_review_only") return null;
    if (parsed.manualExecutionRequired !== true || parsed.reviewRequired !== true || parsed.internalOnly !== true) return null;
    if (parsed.reviewableOwnedWork !== true || parsed.notSent !== true || parsed.commandStored !== false) return null;
    if (
      parsed.sendPerformed !== false
      || parsed.runtimeExecutes !== false
      || parsed.externalSend !== false
      || parsed.telegramSend !== false
      || parsed.routeFlip !== false
      || parsed.providerInvoked !== false
      || parsed.accountOrTokenAccess !== false
      || parsed.liveHmSend !== false
    ) return null;
    if (!allowedRoles.has(String(parsed.targetRole))) return null;
    if ("command" in parsed || "args" in parsed) return null;
    return parsed as MissionControlInternalSendActivationDesignRecord;
  } catch {
    return null;
  }
}

function normalizeRoutePreview(input: MissionControlRoutePreviewInput): MissionControlRoutePreviewRecord {
  const preview = asObject(input.routePreview ?? input.preview, "routePreview");
  if (preview.status !== "reviewed_preview_only") {
    throw Object.assign(new Error("Only reviewed preview-only Mission Control route previews can be saved."), {
      code: "route_preview_not_reviewable",
    });
  }
  const plan = asObject(preview.plan, "routePreview.plan");
  assertTrue(plan.manualExecutionRequired, "plan.manualExecutionRequired");
  assertFalse(plan.runtimeExecutes, "plan.runtimeExecutes");

  const audit = asObject(preview.audit, "routePreview.audit");
  if (audit.reviewStatus !== "preview_ready") {
    throw Object.assign(new Error("Mission Control route preview must be preview_ready before saving."), {
      code: "route_preview_not_reviewable",
    });
  }
  assertFalse(audit.sendPerformed, "audit.sendPerformed");
  assertFalse(audit.runtimeExecutes, "audit.runtimeExecutes");
  assertFalse(audit.externalSend, "audit.externalSend");
  assertFalse(audit.routeFlip, "audit.routeFlip");
  assertFalse(audit.providerInvoked, "audit.providerInvoked");
  rejectExplicitTrue(audit.telegramSend, "audit.telegramSend");
  rejectExplicitTrue(audit.accountOrTokenAccess, "audit.accountOrTokenAccess");
  rejectExplicitTrue(audit.liveHmSend, "audit.liveHmSend");

  const target = asObject(plan.target, "routePreview.plan.target");
  const role = String(target.role || "").trim().toLowerCase();
  if (!allowedRoles.has(role)) {
    throw Object.assign(new Error("Mission Control route preview target must be Architect, Builder, or Oracle."), {
      code: "invalid_pane_target",
    });
  }
  const paneId = String(target.paneId || "").trim();
  if (!["1", "2", "3"].includes(paneId)) {
    throw Object.assign(new Error("Mission Control route preview pane id must be 1, 2, or 3."), {
      code: "invalid_pane_target",
    });
  }

  const envelope = asObject(plan.envelope, "routePreview.plan.envelope");
  const body = asObject(envelope.body, "routePreview.plan.envelope.body");
  const content = nonEmptyText(body.content, "route preview content", 5000);
  const purpose = nonEmptyText(preview.selectedDraftPurpose || "coordination", "route preview purpose", 160);
  const source = optionalPreview(input.source, 80) || "runtime-ui";
  const messageId = optionalPreview(envelope.message_id, 160) || "mission-control-route-preview";
  const requestId = optionalPreview(envelope.request_id, 160) || "mission-control-route-preview-request";
  const fingerprint = crypto.createHash("sha256")
    .update([messageId, requestId, role, paneId, purpose, content].join("\n"))
    .digest("hex")
    .slice(0, 24);
  const id = `mission-route-preview-${fingerprint}`;

  return {
    protocol: "mira.mission_control_route_preview.v0",
    id,
    status: "pending_internal_review",
    createdAt: new Date().toISOString(),
    source,
    targetRole: role as "architect" | "builder" | "oracle",
    targetPaneId: paneId as "1" | "2" | "3",
    purpose,
    content,
    contentPreview: content.length > 260 ? `${content.slice(0, 259)}...` : content,
    missionAnswerPreview: optionalPreview(input.missionAnswer, 500),
    evidence: normalizeEvidence(envelope.evidence),
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

function readPreviewRecords(rootPath: string): MissionControlRoutePreviewRecord[] {
  const dir = previewsDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseStoredRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlRoutePreviewRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readRouteRequestRecords(rootPath: string): MissionControlInternalRouteRequestRecord[] {
  const dir = routeRequestsDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseRouteRequestRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlInternalRouteRequestRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readContinuationRecords(rootPath: string): MissionControlOwnedWorkContinuationRecord[] {
  const dir = continuationsDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseContinuationRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlOwnedWorkContinuationRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readDeliveryPreviewRecords(rootPath: string): MissionControlInternalDeliveryPreviewRecord[] {
  const dir = deliveryPreviewsDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseDeliveryPreviewRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlInternalDeliveryPreviewRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readDispatchReadinessRecords(rootPath: string): MissionControlDispatchReadinessRecord[] {
  const dir = dispatchReadinessDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseDispatchReadinessRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlDispatchReadinessRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readInternalSendDryRunRecords(rootPath: string): MissionControlInternalSendDryRunRecord[] {
  const dir = internalSendDryRunsDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseInternalSendDryRunRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlInternalSendDryRunRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readInternalSendActivationDesignRecords(rootPath: string): MissionControlInternalSendActivationDesignRecord[] {
  const dir = internalSendActivationDesignsDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseInternalSendActivationDesignRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlInternalSendActivationDesignRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function resolvePreviewRecord(input: { previewToken?: unknown }, rootPath: string): MissionControlRoutePreviewRecord {
  const previewToken = optionalPreview(input.previewToken, 200);
  if (!previewToken) {
    throw Object.assign(new Error("Saved Mission Control route preview token is required."), {
      code: "mission_control_route_preview_token_required",
    });
  }
  const records = readPreviewRecords(rootPath);
  const record = records.find((candidate) => {
    return buildActionToken(candidate.id) === previewToken;
  });
  if (!record) {
    throw Object.assign(new Error("Mission Control route preview was not found."), {
      code: "mission_control_route_preview_not_found",
    });
  }
  return record;
}

function routeRequestFromPreview(preview: MissionControlRoutePreviewRecord): MissionControlInternalRouteRequestRecord {
  const id = `mission-route-request-${crypto.createHash("sha256").update(`mira.mission_control_internal_route_request.v0:${preview.id}`).digest("hex").slice(0, 24)}`;
  return {
    protocol: "mira.mission_control_internal_route_request.v0",
    id,
    status: "pending_internal_review",
    createdAt: new Date().toISOString(),
    sourcePreviewId: preview.id,
    sourcePreviewToken: buildActionToken(preview.id),
    targetRole: preview.targetRole,
    targetPaneId: preview.targetPaneId,
    purpose: preview.purpose,
    content: preview.content,
    contentPreview: preview.contentPreview,
    missionAnswerPreview: preview.missionAnswerPreview,
    evidence: preview.evidence,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

function normalizeContinuationDecision(value: unknown): MissionControlOwnedWorkContinuationDecision {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "approve" || normalized === "approved") return "approve";
  if (normalized === "reject" || normalized === "rejected") return "reject";
  if (normalized === "edit" || normalized === "edited") return "edit";
  throw Object.assign(new Error("Continuation decision must be approve, reject, or edit."), {
    code: "invalid_mission_control_continuation_decision",
  });
}

function continuationStatus(decision: MissionControlOwnedWorkContinuationDecision): MissionControlOwnedWorkContinuationStatus {
  if (decision === "approve") return "approved_for_internal_review";
  if (decision === "reject") return "rejected";
  return "edited_for_internal_review";
}

function rejectContinuationInput(input: JsonObject): void {
  const audit = optionalObject(input.audit);
  const plan = optionalObject(input.plan);
  for (const [containerLabel, container] of [["continuation", input], ["audit", audit], ["plan", plan]] as const) {
    if (!container) continue;
    if ("command" in container || "args" in container) {
      throw Object.assign(new Error(`Mission Control continuations do not accept command or args fields in ${containerLabel}.`), {
        code: "mission_control_continuation_command_not_allowed",
      });
    }
    for (const flag of [
      "sendPerformed",
      "runtimeExecutes",
      "externalSend",
      "telegramSend",
      "routeFlip",
      "providerInvoked",
      "accountOrTokenAccess",
      "liveHmSend",
    ]) {
      rejectContinuationLiveEffect(container[flag], `${containerLabel}.${flag}`);
    }
  }
}

function rejectDeliveryPreviewInput(input: JsonObject): void {
  const audit = optionalObject(input.audit);
  const plan = optionalObject(input.plan);
  const packet = optionalObject(input.packet);
  const deliveryPacket = optionalObject(input.deliveryPacket);
  const deliveryPacketTarget = optionalObject(deliveryPacket?.target);
  const deliveryPacketBody = optionalObject(deliveryPacket?.body);
  for (const [containerLabel, container] of [
    ["preview", input],
    ["audit", audit],
    ["plan", plan],
    ["packet", packet],
    ["deliveryPacket", deliveryPacket],
    ["deliveryPacket.target", deliveryPacketTarget],
    ["deliveryPacket.body", deliveryPacketBody],
  ] as const) {
    if (!container) continue;
    if ("command" in container || "args" in container) {
      throw Object.assign(new Error(`Mission Control delivery previews do not accept command or args fields in ${containerLabel}.`), {
        code: "mission_control_delivery_preview_command_not_allowed",
      });
    }
    for (const flag of [
      "sendPerformed",
      "runtimeExecutes",
      "externalSend",
      "telegramSend",
      "routeFlip",
      "providerInvoked",
      "accountOrTokenAccess",
      "liveHmSend",
    ]) {
      rejectDeliveryPreviewLiveEffect(container[flag], `${containerLabel}.${flag}`);
    }
  }
}

function rejectDispatchReadinessInput(input: JsonObject): void {
  const audit = optionalObject(input.audit);
  const plan = optionalObject(input.plan);
  const packet = optionalObject(input.packet);
  const readinessPacket = optionalObject(input.readinessPacket);
  const deliveryPacket = optionalObject(input.deliveryPacket);
  const dispatchPacket = optionalObject(input.dispatchPacket);
  const copiedPaneMessage = optionalObject(input.copiedPaneMessage);
  const readinessPacketTarget = optionalObject(readinessPacket?.target);
  const readinessPacketBody = optionalObject(readinessPacket?.body);
  const deliveryPacketTarget = optionalObject(deliveryPacket?.target);
  const deliveryPacketBody = optionalObject(deliveryPacket?.body);
  const dispatchPacketTarget = optionalObject(dispatchPacket?.target);
  const dispatchPacketBody = optionalObject(dispatchPacket?.body);
  const copiedPaneMessageBody = optionalObject(copiedPaneMessage?.body);
  for (const [containerLabel, container] of [
    ["readiness", input],
    ["audit", audit],
    ["plan", plan],
    ["packet", packet],
    ["readinessPacket", readinessPacket],
    ["readinessPacket.target", readinessPacketTarget],
    ["readinessPacket.body", readinessPacketBody],
    ["deliveryPacket", deliveryPacket],
    ["deliveryPacket.target", deliveryPacketTarget],
    ["deliveryPacket.body", deliveryPacketBody],
    ["dispatchPacket", dispatchPacket],
    ["dispatchPacket.target", dispatchPacketTarget],
    ["dispatchPacket.body", dispatchPacketBody],
    ["copiedPaneMessage", copiedPaneMessage],
    ["copiedPaneMessage.body", copiedPaneMessageBody],
  ] as const) {
    if (!container) continue;
    if ("command" in container || "args" in container) {
      throw Object.assign(new Error(`Mission Control dispatch readiness does not accept command or args fields in ${containerLabel}.`), {
        code: "mission_control_dispatch_readiness_command_not_allowed",
      });
    }
    for (const flag of [
      "sendPerformed",
      "runtimeExecutes",
      "externalSend",
      "telegramSend",
      "routeFlip",
      "providerInvoked",
      "accountOrTokenAccess",
      "liveHmSend",
    ]) {
      rejectDispatchReadinessLiveEffect(container[flag], `${containerLabel}.${flag}`);
    }
  }
}

function rejectInternalSendDryRunInput(input: JsonObject): void {
  const audit = optionalObject(input.audit);
  const plan = optionalObject(input.plan);
  const adapterDryRun = optionalObject(input.adapterDryRun);
  const adapterTarget = optionalObject(adapterDryRun?.target);
  const adapterBody = optionalObject(adapterDryRun?.body);
  const activationGate = optionalObject(input.activationGate);
  const delivery = optionalObject(input.delivery);
  const dispatch = optionalObject(input.dispatch);
  for (const [containerLabel, container] of [
    ["dryRun", input],
    ["audit", audit],
    ["plan", plan],
    ["adapterDryRun", adapterDryRun],
    ["adapterDryRun.target", adapterTarget],
    ["adapterDryRun.body", adapterBody],
    ["activationGate", activationGate],
    ["delivery", delivery],
    ["dispatch", dispatch],
  ] as const) {
    if (!container) continue;
    if ("command" in container || "args" in container) {
      throw Object.assign(new Error(`Mission Control internal-send dry runs do not accept command or args fields in ${containerLabel}.`), {
        code: "mission_control_internal_send_dry_run_command_not_allowed",
      });
    }
    for (const flag of [
      "sendPerformed",
      "runtimeExecutes",
      "externalSend",
      "telegramSend",
      "routeFlip",
      "providerInvoked",
      "accountOrTokenAccess",
      "liveHmSend",
      "realSendAllowed",
      "liveHmSendExecutionAllowed",
    ]) {
      rejectInternalSendDryRunLiveEffect(container[flag], `${containerLabel}.${flag}`);
    }
  }
}

function rejectInternalSendActivationDesignInput(input: JsonObject): void {
  const activationDesign = optionalObject(input.activationDesign);
  const audit = optionalObject(input.audit);
  const plan = optionalObject(input.plan);
  const request = optionalObject(input.request);
  const activationRequest = optionalObject(input.activationRequest);
  const activationGate = optionalObject(input.activationGate);
  const adapterDryRun = optionalObject(input.adapterDryRun);
  const adapterTarget = optionalObject(adapterDryRun?.target);
  const adapterBody = optionalObject(adapterDryRun?.body);
  const rollback = optionalObject(input.rollback);
  const rollbackPlan = optionalObject(input.rollbackPlan);
  const delivery = optionalObject(input.delivery);
  const dispatch = optionalObject(input.dispatch);
  for (const [containerLabel, container] of [
    ["activationDesign", input],
    ["activationDesign", activationDesign],
    ["audit", audit],
    ["plan", plan],
    ["request", request],
    ["activationRequest", activationRequest],
    ["activationGate", activationGate],
    ["adapterDryRun", adapterDryRun],
    ["adapterDryRun.target", adapterTarget],
    ["adapterDryRun.body", adapterBody],
    ["rollback", rollback],
    ["rollbackPlan", rollbackPlan],
    ["delivery", delivery],
    ["dispatch", dispatch],
  ] as const) {
    if (!container) continue;
    if ("command" in container || "args" in container) {
      throw Object.assign(new Error(`Mission Control internal-send activation designs do not accept command or args fields in ${containerLabel}.`), {
        code: "mission_control_internal_send_activation_design_command_not_allowed",
      });
    }
    for (const flag of [
      "sendPerformed",
      "runtimeExecutes",
      "externalSend",
      "telegramSend",
      "routeFlip",
      "providerInvoked",
      "accountOrTokenAccess",
      "liveHmSend",
      "realSendAllowed",
      "liveHmSendExecutionAllowed",
      "activationAllowed",
      "execute",
      "executed",
      "sendNow",
      "activate",
      "deliveryPerformed",
      "bridgeDelivery",
    ]) {
      rejectInternalSendActivationDesignLiveEffect(container[flag], `${containerLabel}.${flag}`);
    }
  }
}

function resolveRouteRequest(input: { requestToken?: unknown }, rootPath: string): MissionControlInternalRouteRequestRecord {
  const requestToken = optionalPreview(input.requestToken, 220);
  if (!requestToken) {
    throw Object.assign(new Error("Mission Control route request token is required."), {
      code: "mission_control_route_request_token_required",
    });
  }
  const record = readRouteRequestRecords(rootPath).find((candidate) => buildRouteRequestActionToken(candidate.id) === requestToken);
  if (!record) {
    throw Object.assign(new Error("Mission Control route request was not found."), {
      code: "mission_control_route_request_not_found",
    });
  }
  return record;
}

function continuationFromRouteRequest(
  request: MissionControlInternalRouteRequestRecord,
  input: { decision?: unknown; editedContent?: unknown; note?: unknown },
): MissionControlOwnedWorkContinuationRecord {
  const decision = normalizeContinuationDecision(input.decision);
  const editedContent = decision === "edit" ? nonEmptyText(input.editedContent, "edited continuation content", 5000) : null;
  const note = optionalPreview(input.note, 500);
  const content = editedContent || request.content;
  const fingerprint = crypto.createHash("sha256")
    .update([request.id, decision, editedContent || "", note || ""].join("\n"))
    .digest("hex")
    .slice(0, 24);
  const id = `mission-owned-work-continuation-${fingerprint}`;

  return {
    protocol: "mira.mission_control_owned_work_continuation.v0",
    id,
    status: continuationStatus(decision),
    decision,
    createdAt: new Date().toISOString(),
    sourceRequestId: request.id,
    sourceRequestToken: buildRouteRequestActionToken(request.id),
    sourcePreviewId: request.sourcePreviewId,
    targetRole: request.targetRole,
    targetPaneId: request.targetPaneId,
    purpose: request.purpose,
    content,
    contentPreview: content.length > 260 ? `${content.slice(0, 259)}...` : content,
    editedContent,
    note,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

function buildFollowThroughRecommendation(
  continuation: MissionControlOwnedWorkContinuationRecord,
  selectedContinuationId: string | null,
): MissionControlFollowThroughRecommendation {
  const selected = continuation.id === selectedContinuationId;
  const id = buildFollowThroughRecommendationId(continuation.id);
  const contentPreview = continuation.contentPreview || continuation.content;
  const target = continuation.targetRole;
  const purpose = continuation.purpose || "coordination";
  const nextTeamMove = continuation.decision === "reject"
    ? `Do not advance the rejected ${target} ${purpose} continuation.`
    : `Ask ${target} to review the ${continuation.decision} ${purpose} continuation: ${contentPreview}`;
  const selectorReason = continuation.decision === "reject"
    ? "Rejected continuation is retained as history and is not selected."
    : selected
      ? "Newest approved or edited continuation; use this as the next internal team move."
      : "Approved or edited continuation is available, but a newer reviewable continuation is selected.";

  return {
    protocol: "mira.mission_control_follow_through_recommendation.v0",
    id,
    actionToken: buildFollowThroughRecommendationActionToken(id),
    status: continuation.decision === "reject"
      ? "not_recommended"
      : selected
        ? "selected_for_internal_review"
        : "available_for_internal_review",
    selected,
    createdAt: continuation.createdAt,
    sourceContinuationId: continuation.id,
    sourceContinuationToken: buildOwnedWorkContinuationActionToken(continuation.id),
    sourceContinuationDecision: continuation.decision,
    sourceContinuationStatus: continuation.status,
    sourceRequestId: continuation.sourceRequestId,
    sourceRequestToken: continuation.sourceRequestToken,
    sourcePreviewId: continuation.sourcePreviewId,
    targetRole: continuation.targetRole,
    targetPaneId: continuation.targetPaneId,
    purpose: continuation.purpose,
    nextTeamMove,
    contentPreview,
    note: continuation.note,
    selectorReason,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

function continuationSelectionRank(continuation: MissionControlOwnedWorkContinuationRecord): number {
  if (continuation.decision === "edit") return 2;
  if (continuation.decision === "approve") return 1;
  return 0;
}

function selectFollowThroughContinuation(records: MissionControlOwnedWorkContinuationRecord[]): MissionControlOwnedWorkContinuationRecord | null {
  const eligible = records
    .filter((record) => record.decision !== "reject")
    .sort((left, right) => {
      const byTime = String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
      if (byTime !== 0) return byTime;
      return continuationSelectionRank(right) - continuationSelectionRank(left);
    });
  return eligible[0] || null;
}

function resolveSelectedRecommendation(
  input: { recommendationToken?: unknown },
  rootPath: string,
): {
  recommendation: MissionControlFollowThroughRecommendation;
  continuation: MissionControlOwnedWorkContinuationRecord;
} {
  const recommendationToken = optionalPreview(input.recommendationToken, 260);
  if (!recommendationToken) {
    throw Object.assign(new Error("Selected Mission Control follow-through recommendation token is required."), {
      code: "mission_control_follow_through_recommendation_token_required",
    });
  }
  const continuations = readContinuationRecords(rootPath);
  const selectedContinuation = selectFollowThroughContinuation(continuations);
  if (!selectedContinuation) {
    throw Object.assign(new Error("No selected Mission Control follow-through recommendation is available."), {
      code: "mission_control_follow_through_recommendation_not_found",
    });
  }
  const selectedRecommendation = buildFollowThroughRecommendation(selectedContinuation, selectedContinuation.id);
  if (selectedRecommendation.actionToken !== recommendationToken) {
    throw Object.assign(new Error("Only the selected Mission Control follow-through recommendation can become a delivery preview."), {
      code: "mission_control_follow_through_recommendation_not_selected",
    });
  }
  return {
    recommendation: selectedRecommendation,
    continuation: selectedContinuation,
  };
}

function resolveDeliveryPreview(
  input: { deliveryPreviewToken?: unknown },
  rootPath: string,
): MissionControlInternalDeliveryPreviewRecord {
  const deliveryPreviewToken = optionalPreview(input.deliveryPreviewToken, 260);
  if (!deliveryPreviewToken) {
    throw Object.assign(new Error("Mission Control delivery preview token is required."), {
      code: "mission_control_delivery_preview_token_required",
    });
  }
  const record = readDeliveryPreviewRecords(rootPath).find((candidate) => {
    return buildDeliveryPreviewActionToken(candidate.id) === deliveryPreviewToken;
  });
  if (!record) {
    throw Object.assign(new Error("Mission Control delivery preview was not found."), {
      code: "mission_control_delivery_preview_not_found",
    });
  }
  return record;
}

function resolveDispatchReadiness(
  input: { dispatchReadinessToken?: unknown },
  rootPath: string,
): MissionControlDispatchReadinessRecord {
  const dispatchReadinessToken = optionalPreview(input.dispatchReadinessToken, 280);
  if (!dispatchReadinessToken) {
    throw Object.assign(new Error("Mission Control dispatch-readiness token is required."), {
      code: "mission_control_dispatch_readiness_token_required",
    });
  }
  const record = readDispatchReadinessRecords(rootPath).find((candidate) => {
    return buildDispatchReadinessActionToken(candidate.id) === dispatchReadinessToken;
  });
  if (!record) {
    throw Object.assign(new Error("Mission Control dispatch-readiness checklist was not found."), {
      code: "mission_control_dispatch_readiness_not_found",
    });
  }
  return record;
}

function resolveInternalSendDryRun(
  input: { internalSendDryRunToken?: unknown; dryRunToken?: unknown },
  rootPath: string,
): MissionControlInternalSendDryRunRecord {
  const dryRunToken = optionalPreview(input.internalSendDryRunToken ?? input.dryRunToken, 300);
  if (!dryRunToken) {
    throw Object.assign(new Error("Mission Control internal-send dry-run token is required."), {
      code: "mission_control_internal_send_dry_run_token_required",
    });
  }
  const record = readInternalSendDryRunRecords(rootPath).find((candidate) => {
    return buildInternalSendDryRunActionToken(candidate.id) === dryRunToken;
  });
  if (!record) {
    throw Object.assign(new Error("Mission Control internal-send dry run was not found."), {
      code: "mission_control_internal_send_dry_run_not_found",
    });
  }
  return record;
}

function deliveryPreviewFromRecommendation(
  recommendation: MissionControlFollowThroughRecommendation,
  continuation: MissionControlOwnedWorkContinuationRecord,
): MissionControlInternalDeliveryPreviewRecord {
  const id = `mission-delivery-preview-${crypto.createHash("sha256")
    .update(`mira.mission_control_internal_delivery_preview.v0:${recommendation.id}`)
    .digest("hex")
    .slice(0, 24)}`;
  const content = continuation.content;
  const deliveryPacket: MissionControlInternalDeliveryPreviewRecord["deliveryPacket"] = {
    protocol: "mira.mission_control_internal_delivery_preview_packet.v0",
    target: {
      system: "squidrun",
      role: recommendation.targetRole,
      paneId: recommendation.targetPaneId,
    },
    body: {
      content,
    },
  };
  const targetLabel = `${recommendation.targetRole} pane ${recommendation.targetPaneId}`;
  return {
    protocol: "mira.mission_control_internal_delivery_preview.v0",
    id,
    status: "reviewed_preview_only",
    createdAt: new Date().toISOString(),
    sourceRecommendationId: recommendation.id,
    sourceRecommendationToken: recommendation.actionToken,
    sourceContinuationId: continuation.id,
    sourceContinuationToken: buildOwnedWorkContinuationActionToken(continuation.id),
    sourceRequestId: continuation.sourceRequestId,
    sourceRequestToken: continuation.sourceRequestToken,
    sourcePreviewId: continuation.sourcePreviewId,
    targetRole: recommendation.targetRole,
    targetPaneId: recommendation.targetPaneId,
    purpose: recommendation.purpose,
    content,
    contentPreview: content.length > 260 ? `${content.slice(0, 259)}...` : content,
    nextTeamMove: recommendation.nextTeamMove,
    selectorReason: recommendation.selectorReason,
    deliveryPacket,
    reviewDetails: {
      protocol: "mira.mission_control_internal_delivery_preview_review.v0",
      targetLabel,
      packetSha256: checksumPayload(deliveryPacket),
      bodySha256: sha256Text(content),
      bodyCharCount: content.length,
      copyText: content,
      copyInstruction: `Manual copy only: paste this body into ${targetLabel} after review.`,
      manualCopyRequired: true,
      previewOnly: true,
      noLiveSend: true,
    },
    audit: {
      reviewStatus: "preview_ready",
      manualExecutionRequired: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    },
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

function internalSendDryRunFromDispatchReadiness(readiness: MissionControlDispatchReadinessRecord): MissionControlInternalSendDryRunRecord {
  const bodyContent = readiness.copiedPaneMessage.body;
  const bodySha256 = sha256Text(bodyContent);
  if (bodySha256 !== readiness.bodySha256 || bodySha256 !== readiness.copyTextSha256 || readiness.checksumMatched !== true) {
    throw Object.assign(new Error("Mission Control dispatch-readiness checksum does not match the internal-send dry-run body."), {
      code: "mission_control_internal_send_dry_run_checksum_mismatch",
    });
  }
  const id = `mission-send-dry-run-${crypto.createHash("sha256")
    .update(`mira.mission_control_internal_send_dry_run.v0:${readiness.id}`)
    .digest("hex")
    .slice(0, 24)}`;

  return {
    protocol: "mira.mission_control_internal_send_dry_run.v0",
    id,
    status: "dry_run_ready",
    createdAt: new Date().toISOString(),
    sourceDispatchReadinessId: readiness.id,
    sourceDispatchReadinessToken: buildDispatchReadinessActionToken(readiness.id),
    sourceDeliveryPreviewId: readiness.sourceDeliveryPreviewId,
    sourceDeliveryPreviewToken: readiness.sourceDeliveryPreviewToken,
    sourceRecommendationId: readiness.sourceRecommendationId,
    sourceContinuationId: readiness.sourceContinuationId,
    sourceRequestId: readiness.sourceRequestId,
    sourcePreviewId: readiness.sourcePreviewId,
    targetRole: readiness.targetRole,
    targetPaneId: readiness.targetPaneId,
    targetLabel: readiness.targetLabel,
    purpose: readiness.purpose,
    content: bodyContent,
    contentPreview: bodyContent.length > 260 ? `${bodyContent.slice(0, 259)}...` : bodyContent,
    bodySha256,
    packetSha256: readiness.packetSha256,
    adapterDryRun: {
      protocol: "mira.hm_send_adapter.v0",
      dryRun: true,
      channel: "hm-send",
      transport: "ui/scripts/hm-send.js",
      target: {
        system: "squidrun",
        role: readiness.targetRole,
        pane_id: readiness.targetPaneId,
      },
      body: {
        content: bodyContent,
      },
    },
    activationGate: {
      protocol: "mira.mission_control_internal_send_activation_gate.v0",
      required: true,
      requiredReview: "separate_reviewed_activation",
      realSendAllowed: false,
      liveHmSendExecutionAllowed: false,
    },
    audit: {
      reviewStatus: "internal_send_dry_run_ready",
      dryRunOnly: true,
      manualExecutionRequired: true,
      realSendRequiresSeparateActivation: true,
      dispatchReadinessChecksumMatched: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    },
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

function activationDesignFromInternalSendDryRun(dryRun: MissionControlInternalSendDryRunRecord): MissionControlInternalSendActivationDesignRecord {
  const bodyContent = dryRun.adapterDryRun.body.content;
  const bodySha256 = sha256Text(bodyContent);
  const adapterPacketSha256 = checksumPayload(dryRun.adapterDryRun);
  if (bodySha256 !== dryRun.bodySha256) {
    throw Object.assign(new Error("Mission Control internal-send dry-run checksum does not match the activation design source."), {
      code: "mission_control_internal_send_activation_design_checksum_mismatch",
    });
  }
  const id = `mission-send-activation-design-${crypto.createHash("sha256")
    .update(`mira.mission_control_internal_send_activation_design.v0:${dryRun.id}`)
    .digest("hex")
    .slice(0, 24)}`;

  return {
    protocol: "mira.mission_control_internal_send_activation_design.v0",
    id,
    status: "activation_design_review_only",
    createdAt: new Date().toISOString(),
    sourceInternalSendDryRunId: dryRun.id,
    sourceInternalSendDryRunToken: buildInternalSendDryRunActionToken(dryRun.id),
    sourceDispatchReadinessId: dryRun.sourceDispatchReadinessId,
    sourceDispatchReadinessToken: dryRun.sourceDispatchReadinessToken,
    sourceDeliveryPreviewId: dryRun.sourceDeliveryPreviewId,
    sourceDeliveryPreviewToken: dryRun.sourceDeliveryPreviewToken,
    sourceRecommendationId: dryRun.sourceRecommendationId,
    sourceContinuationId: dryRun.sourceContinuationId,
    sourceRequestId: dryRun.sourceRequestId,
    sourcePreviewId: dryRun.sourcePreviewId,
    targetRole: dryRun.targetRole,
    targetPaneId: dryRun.targetPaneId,
    targetLabel: dryRun.targetLabel,
    purpose: dryRun.purpose,
    content: bodyContent,
    contentPreview: bodyContent.length > 260 ? `${bodyContent.slice(0, 259)}...` : bodyContent,
    bodySha256,
    adapterPacketSha256,
    activationDesign: {
      protocol: "mira.mission_control_internal_send_activation_design_gate.v0",
      designOnly: true,
      activationAllowed: false,
      requiredReview: "separate_reviewed_activation",
      refusalRollbackAuditRequired: true,
      liveHmSendExecutionAllowed: false,
      realSendAllowed: false,
    },
    refusalRequirements: [
      {
        id: "missing_or_bad_token_refuses",
        label: "Missing or unknown internal-send dry-run tokens must return 400 without writing.",
        ok: true,
      },
      {
        id: "live_effect_input_refuses",
        label: "Any live-effect activation flag must be refused before an activation-design record is written.",
        ok: true,
      },
      {
        id: "command_input_refuses",
        label: "Command or args fields must be refused before an activation-design record is written.",
        ok: true,
      },
      {
        id: "separate_review_required",
        label: "Real hm-send activation remains blocked until a separate reviewed activation gate exists.",
        ok: true,
      },
    ],
    rollbackRequirements: [
      {
        id: "pre_activation_snapshot_required",
        label: "Future activation must snapshot the dry-run token, target, body checksum, and adapter checksum before any execution.",
        ok: true,
      },
      {
        id: "failure_audit_required",
        label: "Future activation failure must record a not-sent/failure audit before retry or rollback.",
        ok: true,
      },
    ],
    auditRequirements: [
      {
        id: "durable_activation_audit_required",
        label: "Future activation must write a durable audit row with reviewer, checksum, and outcome.",
        ok: true,
      },
      {
        id: "transport_result_audit_required",
        label: "Future activation must record the hm-send transport result without changing route ownership.",
        ok: true,
      },
      {
        id: "no_command_storage_required",
        label: "This design stores requirements only and no executable command or args.",
        ok: true,
      },
    ],
    audit: {
      reviewStatus: "activation_design_ready",
      dryRunOnly: true,
      designOnly: true,
      manualExecutionRequired: true,
      realSendRequiresSeparateActivation: true,
      sourceDryRunChecksumMatched: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    },
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

function dispatchReadinessFromDeliveryPreview(preview: MissionControlInternalDeliveryPreviewRecord): MissionControlDispatchReadinessRecord {
  const id = `mission-dispatch-readiness-${crypto.createHash("sha256")
    .update(`mira.mission_control_dispatch_readiness.v0:${preview.id}`)
    .digest("hex")
    .slice(0, 24)}`;
  const copyText = preview.reviewDetails.copyText;
  const copyTextSha256 = sha256Text(copyText);
  const packetSha256 = checksumPayload(preview.deliveryPacket);
  const bodySha256 = sha256Text(preview.deliveryPacket.body.content);
  if (
    packetSha256 !== preview.reviewDetails.packetSha256
    || bodySha256 !== preview.reviewDetails.bodySha256
    || copyTextSha256 !== preview.reviewDetails.bodySha256
  ) {
    throw Object.assign(new Error("Mission Control delivery preview checksum does not match the copied pane body."), {
      code: "mission_control_dispatch_readiness_checksum_mismatch",
    });
  }
  const checklist: MissionControlDispatchReadinessChecklistItem[] = [
    {
      id: "pane_target_matches",
      label: `Pane target is ${preview.reviewDetails.targetLabel}`,
      ok: true,
    },
    {
      id: "copied_body_checksum_matches",
      label: "Copied pane body checksum matches the saved delivery preview body.",
      ok: true,
    },
    {
      id: "manual_review_required",
      label: "Manual pane review is required before dispatch.",
      ok: true,
    },
    {
      id: "no_delivery_path",
      label: "Checklist is review-only: no hm-send, Telegram, route flip, provider/model, runtime execution, or external delivery.",
      ok: true,
    },
  ];

  return {
    protocol: "mira.mission_control_dispatch_readiness.v0",
    id,
    status: "ready_for_manual_dispatch_review",
    createdAt: new Date().toISOString(),
    sourceDeliveryPreviewId: preview.id,
    sourceDeliveryPreviewToken: buildDeliveryPreviewActionToken(preview.id),
    sourceRecommendationId: preview.sourceRecommendationId,
    sourceContinuationId: preview.sourceContinuationId,
    sourceRequestId: preview.sourceRequestId,
    sourcePreviewId: preview.sourcePreviewId,
    targetRole: preview.targetRole,
    targetPaneId: preview.targetPaneId,
    targetLabel: preview.reviewDetails.targetLabel,
    purpose: preview.purpose,
    content: preview.content,
    contentPreview: preview.contentPreview,
    packetSha256,
    bodySha256,
    copyTextSha256,
    checksumMatched: true,
    copiedPaneMessage: {
      targetRole: preview.targetRole,
      targetPaneId: preview.targetPaneId,
      body: copyText,
      bodySha256: copyTextSha256,
      bodyCharCount: copyText.length,
    },
    checklist,
    audit: {
      reviewStatus: "dispatch_readiness_ready",
      manualExecutionRequired: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
      checksumMatched: true,
      noHmSendExecution: true,
      noTelegramSend: true,
      noRouteFlip: true,
      noProviderCall: true,
      noRuntimeExecution: true,
      noExternalDelivery: true,
    },
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function createMissionControlRoutePreviewRecord(
  input: MissionControlRoutePreviewInput,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlRoutePreviewWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control route previews can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  const dir = previewsDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control preview destination escaped Mira state root."), {
      code: "unsafe_mission_control_preview_path",
    });
  }
  const record = normalizeRoutePreview(input);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control preview file escaped Mira state root."), {
      code: "unsafe_mission_control_preview_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseStoredRecord(fs.readFileSync(absolutePath, "utf8"));
    if (parsed) stored = parsed;
  } else {
    const handle = fs.openSync(absolutePath, "wx");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      created = true;
    } finally {
      fs.closeSync(handle);
    }
  }

  return {
    ok: true,
    protocol: "mira.mission_control_route_preview_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    record: toPublicRecord(stored),
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function createMissionControlInternalRouteRequest(
  input: { previewToken?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlInternalRouteRequestWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control route requests can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectRouteRequestInput(input);
  const preview = resolvePreviewRecord(input, rootPath);
  const dir = routeRequestsDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control route request destination escaped Mira state root."), {
      code: "unsafe_mission_control_request_path",
    });
  }

  const record = routeRequestFromPreview(preview);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control route request file escaped Mira state root."), {
      code: "unsafe_mission_control_request_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseRouteRequestRecord(fs.readFileSync(absolutePath, "utf8"));
    if (parsed) stored = parsed;
  } else {
    const handle = fs.openSync(absolutePath, "wx");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      created = true;
    } finally {
      fs.closeSync(handle);
    }
  }

  return {
    ok: true,
    protocol: "mira.mission_control_internal_route_request_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    request: toPublicRouteRequest(stored),
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function listMissionControlRoutePreviewRecords(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlRoutePreviewListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_route_preview_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      previewCount: 0,
      previews: [],
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const previews = readPreviewRecords(rootPath).map((record) => {
    const publicRecord = toPublicRecord(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(previewsDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_route_preview_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    previewCount: previews.length,
    previews,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function listMissionControlInternalRouteRequests(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlInternalRouteRequestListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_internal_route_request_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      requestCount: 0,
      requests: [],
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
      reviewableOwnedWork: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const requests = readRouteRequestRecords(rootPath).map((record) => {
    const publicRecord = toPublicRouteRequest(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(routeRequestsDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_internal_route_request_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    requestCount: requests.length,
    requests,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function createMissionControlOwnedWorkContinuation(
  input: { requestToken?: unknown; decision?: unknown; editedContent?: unknown; note?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlOwnedWorkContinuationWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control continuations can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectContinuationInput(input);
  const request = resolveRouteRequest(input, rootPath);
  const dir = continuationsDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control continuation destination escaped Mira state root."), {
      code: "unsafe_mission_control_continuation_path",
    });
  }

  const record = continuationFromRouteRequest(request, input);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control continuation file escaped Mira state root."), {
      code: "unsafe_mission_control_continuation_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseContinuationRecord(fs.readFileSync(absolutePath, "utf8"));
    if (parsed) stored = parsed;
  } else {
    const handle = fs.openSync(absolutePath, "wx");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      created = true;
    } finally {
      fs.closeSync(handle);
    }
  }

  return {
    ok: true,
    protocol: "mira.mission_control_owned_work_continuation_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    continuation: toPublicContinuation(stored),
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function createMissionControlInternalDeliveryPreview(
  input: { recommendationToken?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlInternalDeliveryPreviewWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control delivery previews can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectDeliveryPreviewInput(input);
  const { recommendation, continuation } = resolveSelectedRecommendation(input, rootPath);
  const dir = deliveryPreviewsDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control delivery preview destination escaped Mira state root."), {
      code: "unsafe_mission_control_delivery_preview_path",
    });
  }

  const record = deliveryPreviewFromRecommendation(recommendation, continuation);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control delivery preview file escaped Mira state root."), {
      code: "unsafe_mission_control_delivery_preview_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseDeliveryPreviewRecord(fs.readFileSync(absolutePath, "utf8"));
    if (parsed) stored = parsed;
  } else {
    const handle = fs.openSync(absolutePath, "wx");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      created = true;
    } finally {
      fs.closeSync(handle);
    }
  }

  return {
    ok: true,
    protocol: "mira.mission_control_internal_delivery_preview_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    preview: toPublicDeliveryPreview(stored),
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function createMissionControlDispatchReadiness(
  input: { deliveryPreviewToken?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlDispatchReadinessWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control dispatch readiness can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectDispatchReadinessInput(input);
  const preview = resolveDeliveryPreview(input, rootPath);
  const dir = dispatchReadinessDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control dispatch readiness destination escaped Mira state root."), {
      code: "unsafe_mission_control_dispatch_readiness_path",
    });
  }

  const record = dispatchReadinessFromDeliveryPreview(preview);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control dispatch readiness file escaped Mira state root."), {
      code: "unsafe_mission_control_dispatch_readiness_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseDispatchReadinessRecord(fs.readFileSync(absolutePath, "utf8"));
    if (parsed) stored = parsed;
  } else {
    const handle = fs.openSync(absolutePath, "wx");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      created = true;
    } finally {
      fs.closeSync(handle);
    }
  }

  return {
    ok: true,
    protocol: "mira.mission_control_dispatch_readiness_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    readiness: toPublicDispatchReadiness(stored),
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function createMissionControlInternalSendDryRun(
  input: { dispatchReadinessToken?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlInternalSendDryRunWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control internal-send dry runs can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectInternalSendDryRunInput(input);
  const readiness = resolveDispatchReadiness(input, rootPath);
  const dir = internalSendDryRunsDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control internal-send dry-run destination escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_dry_run_path",
    });
  }

  const record = internalSendDryRunFromDispatchReadiness(readiness);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control internal-send dry-run file escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_dry_run_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseInternalSendDryRunRecord(fs.readFileSync(absolutePath, "utf8"));
    if (parsed) stored = parsed;
  } else {
    const handle = fs.openSync(absolutePath, "wx");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      created = true;
    } finally {
      fs.closeSync(handle);
    }
  }

  return {
    ok: true,
    protocol: "mira.mission_control_internal_send_dry_run_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    dryRun: toPublicInternalSendDryRun(stored),
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function createMissionControlInternalSendActivationDesign(
  input: { internalSendDryRunToken?: unknown; dryRunToken?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlInternalSendActivationDesignWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control internal-send activation designs can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectInternalSendActivationDesignInput(input);
  const dryRun = resolveInternalSendDryRun(input, rootPath);
  const dir = internalSendActivationDesignsDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control internal-send activation-design destination escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_activation_design_path",
    });
  }

  const record = activationDesignFromInternalSendDryRun(dryRun);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control internal-send activation-design file escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_activation_design_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseInternalSendActivationDesignRecord(fs.readFileSync(absolutePath, "utf8"));
    if (parsed) stored = parsed;
  } else {
    const handle = fs.openSync(absolutePath, "wx");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      created = true;
    } finally {
      fs.closeSync(handle);
    }
  }

  return {
    ok: true,
    protocol: "mira.mission_control_internal_send_activation_design_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    design: toPublicInternalSendActivationDesign(stored),
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function listMissionControlOwnedWorkContinuations(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlOwnedWorkContinuationListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_owned_work_continuation_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      continuationCount: 0,
      continuations: [],
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
      reviewableOwnedWork: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const continuations = readContinuationRecords(rootPath).map((record) => {
    const publicRecord = toPublicContinuation(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(continuationsDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_owned_work_continuation_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    continuationCount: continuations.length,
    continuations,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function listMissionControlInternalDeliveryPreviews(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlInternalDeliveryPreviewListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_internal_delivery_preview_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      previewCount: 0,
      previews: [],
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
      reviewableOwnedWork: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const previews = readDeliveryPreviewRecords(rootPath).map((record) => {
    const publicRecord = toPublicDeliveryPreview(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(deliveryPreviewsDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_internal_delivery_preview_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    previewCount: previews.length,
    previews,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function listMissionControlDispatchReadiness(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlDispatchReadinessListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_dispatch_readiness_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      readinessCount: 0,
      readiness: [],
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
      reviewableOwnedWork: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const readiness = readDispatchReadinessRecords(rootPath).map((record) => {
    const publicRecord = toPublicDispatchReadiness(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(dispatchReadinessDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_dispatch_readiness_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    readinessCount: readiness.length,
    readiness,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function listMissionControlInternalSendDryRuns(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlInternalSendDryRunListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_internal_send_dry_run_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      dryRunCount: 0,
      dryRuns: [],
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
      reviewableOwnedWork: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const dryRuns = readInternalSendDryRunRecords(rootPath).map((record) => {
    const publicRecord = toPublicInternalSendDryRun(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(internalSendDryRunsDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_internal_send_dry_run_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    dryRunCount: dryRuns.length,
    dryRuns,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function listMissionControlInternalSendActivationDesigns(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlInternalSendActivationDesignListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_internal_send_activation_design_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      designCount: 0,
      designs: [],
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
      reviewableOwnedWork: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const designs = readInternalSendActivationDesignRecords(rootPath).map((record) => {
    const publicRecord = toPublicInternalSendActivationDesign(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(internalSendActivationDesignsDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_internal_send_activation_design_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    designCount: designs.length,
    designs,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}

export function listMissionControlFollowThroughRecommendations(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlFollowThroughRecommendationListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_follow_through_recommendation_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      recommendationCount: 0,
      selectedRecommendation: null,
      recommendations: [],
      manualExecutionRequired: true,
      reviewRequired: true,
      internalOnly: true,
      reviewableOwnedWork: true,
      notSent: true,
      commandStored: false,
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramSend: false,
      routeFlip: false,
      providerInvoked: false,
      accountOrTokenAccess: false,
      liveHmSend: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const continuations = readContinuationRecords(rootPath);
  const selectedContinuation = selectFollowThroughContinuation(continuations);
  const recommendations = continuations.map((record) => buildFollowThroughRecommendation(record, selectedContinuation?.id || null));
  const selectedRecommendation = recommendations.find((recommendation) => recommendation.selected) || null;

  return {
    ok: true,
    protocol: "mira.mission_control_follow_through_recommendation_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    recommendationCount: recommendations.length,
    selectedRecommendation,
    recommendations,
    manualExecutionRequired: true,
    reviewRequired: true,
    internalOnly: true,
    reviewableOwnedWork: true,
    notSent: true,
    commandStored: false,
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramSend: false,
    routeFlip: false,
    providerInvoked: false,
    accountOrTokenAccess: false,
    liveHmSend: false,
  };
}
