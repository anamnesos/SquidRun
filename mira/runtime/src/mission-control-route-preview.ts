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
  missionAnswerPreview: string | null;
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
  missionAnswerPreview: string | null;
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
  missionAnswerPreview: string | null;
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

export type MissionControlInternalSendActivationRequestRequirement = {
  id:
    | "activation_design_token_required"
    | "activation_design_checksum_required"
    | "reviewer_required"
    | "refusal_path_required"
    | "rollback_path_required"
    | "audit_path_required"
    | "separate_activation_required";
  label: string;
  ok: true;
};

export type MissionControlInternalSendActivationRequestRecord = {
  protocol: "mira.mission_control_internal_send_activation_request_preview.v0";
  id: string;
  status: "activation_request_review_only";
  createdAt: string;
  sourceInternalSendActivationDesignId: string;
  sourceInternalSendActivationDesignToken: string;
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
  reviewer: {
    required: true;
    status: "pending_review";
    reviewerRole: "architect_or_oracle";
    note: string;
  };
  activationRequest: {
    protocol: "mira.mission_control_internal_send_activation_request_gate.v0";
    previewOnly: true;
    activationAllowed: false;
    requiredReview: "separate_reviewed_activation";
    reviewerRequired: true;
    refusalRollbackAuditRequired: true;
    liveHmSendExecutionAllowed: false;
    realSendAllowed: false;
  };
  refusalPolicy: MissionControlInternalSendActivationRequestRequirement[];
  rollbackPlan: MissionControlInternalSendActivationRequestRequirement[];
  auditPlan: MissionControlInternalSendActivationRequestRequirement[];
  audit: {
    reviewStatus: "activation_request_preview_ready";
    previewOnly: true;
    manualExecutionRequired: true;
    realSendRequiresSeparateActivation: true;
    sourceActivationDesignChecksumMatched: true;
    reviewerRequired: true;
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

export type MissionControlInternalSendActivationRequestWriteResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_activation_request_preview_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  request: MissionControlInternalSendActivationRequestRecord & { actionToken: string };
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

export type MissionControlInternalSendActivationRequestListResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_activation_request_preview_list.v0";
  stateRootPath: string | null;
  requestCount: number;
  requests: Array<MissionControlInternalSendActivationRequestRecord & {
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

export type MissionControlInternalSendActivationDecisionAuditRequirement = {
  id:
    | "activation_request_token_required"
    | "activation_request_checksum_required"
    | "review_decision_recorded"
    | "refusal_recorded"
    | "rollback_audit_recorded"
    | "separate_activation_required";
  label: string;
  ok: true;
};

export type MissionControlInternalSendActivationDecisionAuditRecord = {
  protocol: "mira.mission_control_internal_send_activation_decision_audit.v0";
  id: string;
  status: "activation_decision_audit_review_only";
  createdAt: string;
  sourceInternalSendActivationRequestId: string;
  sourceInternalSendActivationRequestToken: string;
  sourceInternalSendActivationDesignId: string;
  sourceInternalSendActivationDesignToken: string;
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
  reviewer: {
    required: true;
    status: "pending_review";
    reviewerRole: "architect_or_oracle";
  };
  decision: {
    protocol: "mira.mission_control_internal_send_activation_decision.v0";
    reviewOnly: true;
    decision: "refuse_live_activation_until_separate_gate";
    activationAllowed: false;
    liveHmSendExecutionAllowed: false;
    realSendAllowed: false;
    separateActivationRequired: true;
  };
  refusal: {
    status: "refused_for_live_execution";
    reason: string;
    liveEffectBlocked: true;
  };
  rollbackAudit: {
    status: "rollback_audit_previewed";
    requiresPreActivationSnapshot: true;
    requiresFailureAudit: true;
    requiresTransportOutcomeAudit: true;
  };
  auditRequirements: MissionControlInternalSendActivationDecisionAuditRequirement[];
  audit: {
    reviewStatus: "activation_decision_audit_ready";
    reviewOnly: true;
    manualExecutionRequired: true;
    sourceActivationRequestChecksumMatched: true;
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

export type MissionControlInternalSendActivationDecisionAuditWriteResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_activation_decision_audit_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  audit: MissionControlInternalSendActivationDecisionAuditRecord & { actionToken: string };
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

export type MissionControlInternalSendActivationDecisionAuditListResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_activation_decision_audit_list.v0";
  stateRootPath: string | null;
  auditCount: number;
  audits: Array<MissionControlInternalSendActivationDecisionAuditRecord & {
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

export type MissionControlInternalSendActivationImplementationReadinessRequirement = {
  id:
    | "decision_audit_token_required"
    | "decision_audit_checksum_required"
    | "decision_refusal_required"
    | "disabled_by_default_required"
    | "rollback_audit_required"
    | "separate_activation_required";
  label: string;
  ok: true;
};

export type MissionControlInternalSendActivationImplementationReadinessRecord = {
  protocol: "mira.mission_control_internal_send_activation_implementation_readiness.v0";
  id: string;
  status: "activation_implementation_readiness_review_only";
  createdAt: string;
  sourceInternalSendActivationDecisionAuditId: string;
  sourceInternalSendActivationDecisionAuditToken: string;
  sourceInternalSendActivationRequestId: string;
  sourceInternalSendActivationRequestToken: string;
  sourceInternalSendActivationDesignId: string;
  sourceInternalSendActivationDesignToken: string;
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
  implementationGate: {
    protocol: "mira.mission_control_internal_send_activation_implementation_gate.v0";
    readinessOnly: true;
    disabledByDefault: true;
    implementationEnabled: false;
    activationAllowed: false;
    liveHmSendExecutionAllowed: false;
    realSendAllowed: false;
    separateActivationRequired: true;
  };
  refusal: {
    status: "live_activation_still_refused";
    sourceDecision: "refuse_live_activation_until_separate_gate";
    reason: string;
  };
  rollback: {
    status: "rollback_requirements_ready";
    preActivationSnapshotRequired: true;
    failureAuditRequired: true;
    transportOutcomeAuditRequired: true;
  };
  auditRequirements: MissionControlInternalSendActivationImplementationReadinessRequirement[];
  audit: {
    reviewStatus: "activation_implementation_readiness_ready";
    readinessOnly: true;
    disabledByDefault: true;
    implementationEnabled: false;
    manualExecutionRequired: true;
    sourceDecisionAuditChecksumMatched: true;
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

export type MissionControlInternalSendActivationImplementationReadinessWriteResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_activation_implementation_readiness_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  readiness: MissionControlInternalSendActivationImplementationReadinessRecord & { actionToken: string };
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

export type MissionControlInternalSendActivationImplementationReadinessListResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_activation_implementation_readiness_list.v0";
  stateRootPath: string | null;
  readinessCount: number;
  readiness: Array<MissionControlInternalSendActivationImplementationReadinessRecord & {
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

export type MissionControlInternalSendLiveActivationGateContractRequirement = {
  id:
    | "implementation_readiness_token_required"
    | "implementation_readiness_checksum_required"
    | "james_explicit_request_required"
    | "target_pane_confirmation_required"
    | "transport_dry_run_replay_required"
    | "rollback_and_audit_review_required"
    | "separate_activation_lane_required";
  label: string;
  ok: true;
};

export type MissionControlInternalSendLiveActivationGateContractRecord = {
  protocol: "mira.mission_control_internal_send_live_activation_gate_contract.v0";
  id: string;
  status: "live_activation_gate_hard_stop";
  createdAt: string;
  sourceInternalSendActivationImplementationReadinessId: string;
  sourceInternalSendActivationImplementationReadinessToken: string;
  sourceInternalSendActivationDecisionAuditId: string;
  sourceInternalSendActivationDecisionAuditToken: string;
  sourceInternalSendActivationRequestId: string;
  sourceInternalSendActivationRequestToken: string;
  sourceInternalSendActivationDesignId: string;
  sourceInternalSendActivationDesignToken: string;
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
  hardStop: {
    protocol: "mira.mission_control_internal_send_live_activation_hard_stop.v0";
    contractOnly: true;
    liveActivationAllowed: false;
    liveHmSendExecutionAllowed: false;
    realSendAllowed: false;
    implementationEnabled: false;
    separateActivationLaneRequired: true;
    jamesSetupRequiredBeforeLiveSend: true;
  };
  jamesRequirements: MissionControlInternalSendLiveActivationGateContractRequirement[];
  setupRequirements: MissionControlInternalSendLiveActivationGateContractRequirement[];
  rollbackRequirements: MissionControlInternalSendLiveActivationGateContractRequirement[];
  audit: {
    reviewStatus: "live_activation_gate_contract_ready";
    contractOnly: true;
    hardStop: true;
    manualExecutionRequired: true;
    sourceImplementationReadinessChecksumMatched: true;
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

export type MissionControlInternalSendLiveActivationGateContractWriteResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_live_activation_gate_contract_write.v0";
  created: boolean;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  contract: MissionControlInternalSendLiveActivationGateContractRecord & { actionToken: string };
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

export type MissionControlInternalSendLiveActivationGateContractListResult = {
  ok: true;
  protocol: "mira.mission_control_internal_send_live_activation_gate_contract_list.v0";
  stateRootPath: string | null;
  contractCount: number;
  contracts: Array<MissionControlInternalSendLiveActivationGateContractRecord & {
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

export type MissionControlActivationPipelineStageId =
  | "route_preview"
  | "internal_route_request"
  | "owned_work_continuation"
  | "follow_through_recommendation"
  | "internal_delivery_preview"
  | "dispatch_readiness"
  | "internal_send_dry_run"
  | "activation_design"
  | "activation_request"
  | "activation_decision_audit"
  | "activation_implementation_readiness"
  | "live_activation_gate_contract";

export type MissionControlActivationPipelineStageStatus = "missing" | "saved" | "derived";

export type MissionControlActivationPipelineStage = {
  id: MissionControlActivationPipelineStageId;
  label: string;
  protocol: string | null;
  status: MissionControlActivationPipelineStageStatus;
  count: number;
  latestId: string | null;
  latestToken: string | null;
  latestStatus: string | null;
  relativePath: string | null;
  sourceStageId: MissionControlActivationPipelineStageId | null;
  sourceToken: string | null;
  latestCreatedAt: string | null;
  targetRole: string | null;
  targetPaneId: string | null;
  targetLabel: string | null;
  contentPreview: string | null;
  bodySha256: string | null;
  adapterPacketSha256: string | null;
  summary: string;
  hardStop: {
    liveActivationAllowed: false;
    liveHmSendExecutionAllowed: false;
    realSendAllowed: false;
    implementationEnabled: false;
    separateActivationLaneRequired: boolean;
    jamesSetupRequiredBeforeLiveSend: boolean;
  } | null;
};

export type MissionControlActivationPipelineTrace = {
  protocol: "mira.mission_control_activation_pipeline_trace.v0";
  entryCount: number;
  currentStageId: MissionControlActivationPipelineStageId | null;
  currentArtifactToken: string | null;
  sourcePath: string;
  entries: Array<{
    stageId: MissionControlActivationPipelineStageId;
    label: string;
    status: MissionControlActivationPipelineStageStatus;
    token: string | null;
    relativePath: string | null;
    sourceStageId: MissionControlActivationPipelineStageId | null;
    sourceToken: string | null;
    createdAt: string | null;
    targetRole: string | null;
    contentPreview: string | null;
    bodySha256: string | null;
    adapterPacketSha256: string | null;
    summary: string;
  }>;
  noEffectSummary: string;
};

export type MissionControlActivationPipelineAdvanceSelection = {
  protocol: "mira.mission_control_activation_pipeline_advance_selection.v0";
  status: "no_chain" | "advance_available" | "hard_stop_reached";
  selectedStageId: MissionControlActivationPipelineStageId | null;
  selectedStageLabel: string | null;
  selectedArtifactToken: string | null;
  selectedRelativePath: string | null;
  selectedArtifactStatus: MissionControlActivationPipelineStageStatus | null;
  selectedSourceStageId: MissionControlActivationPipelineStageId | null;
  selectedSourceToken: string | null;
  selectedBodySha256: string | null;
  selectedAdapterPacketSha256: string | null;
  nextStageId: MissionControlActivationPipelineStageId | null;
  nextStageLabel: string | null;
  reason: string;
  comparisonSummary: string;
  candidates: Array<{
    stageId: MissionControlActivationPipelineStageId;
    label: string;
    token: string | null;
    relativePath: string | null;
    status: MissionControlActivationPipelineStageStatus;
    selected: boolean;
    nextStageId: MissionControlActivationPipelineStageId | null;
    nextStageLabel: string | null;
    reason: string;
  }>;
  noEffectSummary: string;
};

export type MissionControlActivationPipelineManualActionPreflight = {
  protocol: "mira.mission_control_activation_pipeline_manual_action_preflight.v0";
  status: "ready" | "blocked_no_source" | "blocked_hard_stop";
  selectedStageId: MissionControlActivationPipelineStageId | null;
  selectedStageLabel: string | null;
  selectedArtifactToken: string | null;
  selectedRelativePath: string | null;
  nextStageId: MissionControlActivationPipelineStageId | null;
  nextStageLabel: string | null;
  manualActionLabel: string | null;
  manualActionSurface: "mission_control_workbench" | null;
  tokenField: string | null;
  tokenValue: string | null;
  explanation: string;
  evidenceChecks: Array<{
    id: string;
    label: string;
    ok: boolean;
  }>;
  noEffectSummary: string;
};

export type MissionControlActivationPipelinePayloadPreview = {
  protocol: "mira.mission_control_activation_pipeline_payload_preview.v0";
  status: "ready" | "needs_manual_input" | "blocked";
  actionLabel: string | null;
  method: "POST" | null;
  endpoint: string | null;
  payload: Record<string, string> | null;
  requiredManualInputs: string[];
  selectedStageId: MissionControlActivationPipelineStageId | null;
  selectedArtifactToken: string | null;
  selectedRelativePath: string | null;
  explanation: string;
  handlerDriftCheck: {
    protocol: "mira.mission_control_workbench_handler_drift_check.v0";
    status: "matched" | "mismatched" | "blocked";
    handlerName: string | null;
    handlerSource: string | null;
    actionLabel: string | null;
    expectedMethod: "POST" | null;
    previewMethod: "POST" | null;
    expectedEndpoint: string | null;
    previewEndpoint: string | null;
    expectedTokenField: string | null;
    previewTokenField: string | null;
    expectedBodyFields: string[];
    previewBodyFields: string[];
    explanation: string;
    checks: Array<{
      id: string;
      label: string;
      ok: boolean;
    }>;
    noEffectSummary: string;
  };
  validationChecks: Array<{
    id: string;
    label: string;
    ok: boolean;
  }>;
  noEffectSummary: string;
};

export type MissionControlActivationPipelineEndToEndReadout = {
  protocol: "mira.mission_control_activation_pipeline_end_to_end_readout.v0";
  status: "empty" | "in_progress" | "terminal_hard_stop";
  headline: string;
  completedChainSummary: string;
  currentHardStopTruth: string;
  provenSummary: string;
  manualOnlySummary: string;
  nextBoundary: string;
  currentStageId: MissionControlActivationPipelineStageId | null;
  currentStageLabel: string;
  currentArtifactToken: string | null;
  currentRelativePath: string | null;
  stageCount: number;
  availableStageCount: number;
  missingStageLabels: string[];
  hardStopRecorded: boolean;
  liveSendAvailable: false;
  realSendRequiresSeparateActivation: true;
  demoPath: {
    protocol: "mira.mission_control_activation_pipeline_demo_path.v0";
    surface: "New Mira local workbench";
    open: string;
    read: string[];
    means: string;
    manualOnly: string;
    nextBoundary: string;
    inspectionRunbook: {
      protocol: "mira.mission_control_demo_inspection_runbook.v0";
      entryPoint: string;
      evidenceSource: "GET /mission-control/activation-pipeline-status";
      steps: string[];
      expectedReadout: string[];
      verification: string;
      boundary: string;
    };
    walkthrough: {
      protocol: "mira.mission_control_demo_walkthrough.v0";
      title: string;
      sourceEvidence: string[];
      narrativeSteps: string[];
      whyUseful: string;
      stillManual: string;
      nextBoundary: string;
    };
    whatNowSummary: {
      protocol: "mira.mission_control_what_now_summary.v0";
      answer: string;
      currentMeaning: string;
      inspectNext: string;
      noLiveReason: string;
      nextBoundary: string;
      sourceEvidence: string[];
      noEffectSummary: string;
    };
    noEffectSummary: string;
  };
  noEffectSummary: string;
};

export type MissionControlActivationPipelineStatusResult = {
  ok: true;
  protocol: "mira.mission_control_activation_pipeline_status.v0";
  stateRootPath: string | null;
  currentStage: MissionControlActivationPipelineStage | null;
  currentStageId: MissionControlActivationPipelineStageId | null;
  currentStageLabel: string;
  lastSavedArtifact: MissionControlActivationPipelineStage | null;
  stageCount: number;
  stages: MissionControlActivationPipelineStage[];
  currentStageTrace: MissionControlActivationPipelineTrace;
  advanceSelection: MissionControlActivationPipelineAdvanceSelection;
  manualActionPreflight: MissionControlActivationPipelineManualActionPreflight;
  payloadPreview: MissionControlActivationPipelinePayloadPreview;
  endToEndReadout: MissionControlActivationPipelineEndToEndReadout;
  hardStopTruth: {
    liveSendAvailable: false;
    liveActivationAllowed: false;
    liveHmSendExecutionAllowed: false;
    realSendAllowed: false;
    implementationEnabled: false;
    hardStopContractRecorded: boolean;
    separateActivationLaneRequired: true;
    jamesSetupRequiredBeforeLiveSend: true;
  };
  nextBoundary: {
    label: string;
    currentNextStep: string;
    futureJamesVisibleGate: string;
    liveSendAvailable: false;
    separateActivationLaneRequired: true;
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

const allowedRoles = new Set(["architect", "builder", "oracle"]);

const activationPipelineStageDefinitions: Array<{
  id: MissionControlActivationPipelineStageId;
  label: string;
}> = [
  { id: "route_preview", label: "Route preview" },
  { id: "internal_route_request", label: "Review item" },
  { id: "owned_work_continuation", label: "Owned-work continuation" },
  { id: "follow_through_recommendation", label: "Follow-through recommendation" },
  { id: "internal_delivery_preview", label: "Delivery preview" },
  { id: "dispatch_readiness", label: "Dispatch readiness" },
  { id: "internal_send_dry_run", label: "Internal-send dry run" },
  { id: "activation_design", label: "Activation design" },
  { id: "activation_request", label: "Activation request" },
  { id: "activation_decision_audit", label: "Decision audit" },
  { id: "activation_implementation_readiness", label: "Implementation readiness" },
  { id: "live_activation_gate_contract", label: "Live activation hard-stop contract" },
];

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

function internalSendActivationRequestsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "internal-send-activation-requests");
}

function internalSendActivationDecisionAuditsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "internal-send-activation-decision-audits");
}

function internalSendActivationImplementationReadinessDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "internal-send-activation-implementation-readiness");
}

function internalSendLiveActivationGateContractsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "internal-send-live-activation-gate-contracts");
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

function rejectInternalSendActivationRequestLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for an internal-send activation request preview.`), {
      code: "mission_control_internal_send_activation_request_has_live_effect",
    });
  }
}

function rejectInternalSendActivationDecisionAuditLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for an internal-send activation decision audit.`), {
      code: "mission_control_internal_send_activation_decision_audit_has_live_effect",
    });
  }
}

function rejectInternalSendActivationImplementationReadinessLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for internal-send activation implementation readiness.`), {
      code: "mission_control_internal_send_activation_implementation_readiness_has_live_effect",
    });
  }
}

function rejectInternalSendLiveActivationGateContractLiveEffect(value: unknown, label: string): void {
  if (value === true) {
    throw Object.assign(new Error(`${label} cannot be true for an internal-send live activation gate contract.`), {
      code: "mission_control_internal_send_live_activation_gate_contract_has_live_effect",
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

function buildInternalSendActivationRequestActionToken(id: string): string {
  return `mission-send-activation-request-${crypto.createHash("sha256").update(`mira.mission_control_internal_send_activation_request_preview.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildInternalSendActivationDecisionAuditActionToken(id: string): string {
  return `mission-send-activation-audit-${crypto.createHash("sha256").update(`mira.mission_control_internal_send_activation_decision_audit.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildInternalSendActivationImplementationReadinessActionToken(id: string): string {
  return `mission-send-activation-ready-${crypto.createHash("sha256").update(`mira.mission_control_internal_send_activation_implementation_readiness.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function buildInternalSendLiveActivationGateContractActionToken(id: string): string {
  return `mission-send-live-gate-${crypto.createHash("sha256").update(`mira.mission_control_internal_send_live_activation_gate_contract.v0:${id}`).digest("base64url").slice(0, 18)}`;
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

function toPublicInternalSendActivationRequest(record: MissionControlInternalSendActivationRequestRecord): MissionControlInternalSendActivationRequestRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildInternalSendActivationRequestActionToken(record.id),
  };
}

function toPublicInternalSendActivationDecisionAudit(record: MissionControlInternalSendActivationDecisionAuditRecord): MissionControlInternalSendActivationDecisionAuditRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildInternalSendActivationDecisionAuditActionToken(record.id),
  };
}

function toPublicInternalSendActivationImplementationReadiness(record: MissionControlInternalSendActivationImplementationReadinessRecord): MissionControlInternalSendActivationImplementationReadinessRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildInternalSendActivationImplementationReadinessActionToken(record.id),
  };
}

function toPublicInternalSendLiveActivationGateContract(record: MissionControlInternalSendLiveActivationGateContractRecord): MissionControlInternalSendLiveActivationGateContractRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildInternalSendLiveActivationGateContractActionToken(record.id),
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

function parseInternalSendActivationRequestRecord(value: string): MissionControlInternalSendActivationRequestRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlInternalSendActivationRequestRecord>;
    if (parsed.protocol !== "mira.mission_control_internal_send_activation_request_preview.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "activation_request_review_only") return null;
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
    return parsed as MissionControlInternalSendActivationRequestRecord;
  } catch {
    return null;
  }
}

function parseInternalSendActivationDecisionAuditRecord(value: string): MissionControlInternalSendActivationDecisionAuditRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlInternalSendActivationDecisionAuditRecord>;
    if (parsed.protocol !== "mira.mission_control_internal_send_activation_decision_audit.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "activation_decision_audit_review_only") return null;
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
    return parsed as MissionControlInternalSendActivationDecisionAuditRecord;
  } catch {
    return null;
  }
}

function parseInternalSendActivationImplementationReadinessRecord(value: string): MissionControlInternalSendActivationImplementationReadinessRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlInternalSendActivationImplementationReadinessRecord>;
    if (parsed.protocol !== "mira.mission_control_internal_send_activation_implementation_readiness.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "activation_implementation_readiness_review_only") return null;
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
    return parsed as MissionControlInternalSendActivationImplementationReadinessRecord;
  } catch {
    return null;
  }
}

function parseInternalSendLiveActivationGateContractRecord(value: string): MissionControlInternalSendLiveActivationGateContractRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<MissionControlInternalSendLiveActivationGateContractRecord>;
    if (parsed.protocol !== "mira.mission_control_internal_send_live_activation_gate_contract.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "live_activation_gate_hard_stop") return null;
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
    return parsed as MissionControlInternalSendLiveActivationGateContractRecord;
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

function readInternalSendActivationRequestRecords(rootPath: string): MissionControlInternalSendActivationRequestRecord[] {
  const dir = internalSendActivationRequestsDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseInternalSendActivationRequestRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlInternalSendActivationRequestRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readInternalSendActivationDecisionAuditRecords(rootPath: string): MissionControlInternalSendActivationDecisionAuditRecord[] {
  const dir = internalSendActivationDecisionAuditsDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseInternalSendActivationDecisionAuditRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlInternalSendActivationDecisionAuditRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readInternalSendActivationImplementationReadinessRecords(rootPath: string): MissionControlInternalSendActivationImplementationReadinessRecord[] {
  const dir = internalSendActivationImplementationReadinessDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseInternalSendActivationImplementationReadinessRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlInternalSendActivationImplementationReadinessRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readInternalSendLiveActivationGateContractRecords(rootPath: string): MissionControlInternalSendLiveActivationGateContractRecord[] {
  const dir = internalSendLiveActivationGateContractsDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseInternalSendLiveActivationGateContractRecord(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is MissionControlInternalSendLiveActivationGateContractRecord => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function unknownRecordValue(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function hardStopFromRecord(record: Record<string, unknown> | null): MissionControlActivationPipelineStage["hardStop"] {
  const hardStop = record?.hardStop;
  if (!hardStop || typeof hardStop !== "object" || Array.isArray(hardStop)) return null;
  const hardStopRecord = hardStop as Record<string, unknown>;
  return {
    liveActivationAllowed: false,
    liveHmSendExecutionAllowed: false,
    realSendAllowed: false,
    implementationEnabled: false,
    separateActivationLaneRequired: hardStopRecord.separateActivationLaneRequired === true,
    jamesSetupRequiredBeforeLiveSend: hardStopRecord.jamesSetupRequiredBeforeLiveSend === true,
  };
}

function sourceStageIdForActivationStage(
  id: MissionControlActivationPipelineStageId,
): MissionControlActivationPipelineStageId | null {
  switch (id) {
    case "internal_route_request": return "route_preview";
    case "owned_work_continuation": return "internal_route_request";
    case "follow_through_recommendation": return "owned_work_continuation";
    case "internal_delivery_preview": return "follow_through_recommendation";
    case "dispatch_readiness": return "internal_delivery_preview";
    case "internal_send_dry_run": return "dispatch_readiness";
    case "activation_design": return "internal_send_dry_run";
    case "activation_request": return "activation_design";
    case "activation_decision_audit": return "activation_request";
    case "activation_implementation_readiness": return "activation_decision_audit";
    case "live_activation_gate_contract": return "activation_implementation_readiness";
    case "route_preview": return null;
    default: return null;
  }
}

function sourceTokenForActivationStage(
  id: MissionControlActivationPipelineStageId,
  record: Record<string, unknown> | null,
): string | null {
  switch (id) {
    case "internal_route_request": return unknownRecordValue(record, "sourcePreviewToken");
    case "owned_work_continuation": return unknownRecordValue(record, "sourceRequestToken");
    case "follow_through_recommendation": return unknownRecordValue(record, "sourceContinuationToken");
    case "internal_delivery_preview": return unknownRecordValue(record, "sourceRecommendationToken");
    case "dispatch_readiness": return unknownRecordValue(record, "sourceDeliveryPreviewToken");
    case "internal_send_dry_run": return unknownRecordValue(record, "sourceDispatchReadinessToken");
    case "activation_design": return unknownRecordValue(record, "sourceInternalSendDryRunToken");
    case "activation_request": return unknownRecordValue(record, "sourceInternalSendActivationDesignToken");
    case "activation_decision_audit": return unknownRecordValue(record, "sourceInternalSendActivationRequestToken");
    case "activation_implementation_readiness": return unknownRecordValue(record, "sourceInternalSendActivationDecisionAuditToken");
    case "live_activation_gate_contract": return unknownRecordValue(record, "sourceInternalSendActivationImplementationReadinessToken");
    case "route_preview": return null;
    default: return null;
  }
}

function relativePathForActivationStage(
  id: MissionControlActivationPipelineStageId,
  record: Record<string, unknown> | null,
): string | null {
  const recordId = unknownRecordValue(record, "id");
  if (!recordId || !/^[A-Za-z0-9._-]+$/.test(recordId)) return null;
  switch (id) {
    case "route_preview": return `mission-control/route-previews/${recordId}.json`;
    case "internal_route_request": return `mission-control/internal-route-requests/${recordId}.json`;
    case "owned_work_continuation": return `mission-control/owned-work-continuations/${recordId}.json`;
    case "internal_delivery_preview": return `mission-control/internal-delivery-previews/${recordId}.json`;
    case "dispatch_readiness": return `mission-control/dispatch-readiness/${recordId}.json`;
    case "internal_send_dry_run": return `mission-control/internal-send-dry-runs/${recordId}.json`;
    case "activation_design": return `mission-control/internal-send-activation-designs/${recordId}.json`;
    case "activation_request": return `mission-control/internal-send-activation-requests/${recordId}.json`;
    case "activation_decision_audit": return `mission-control/internal-send-activation-decision-audits/${recordId}.json`;
    case "activation_implementation_readiness": return `mission-control/internal-send-activation-implementation-readiness/${recordId}.json`;
    case "live_activation_gate_contract": return `mission-control/internal-send-live-activation-gate-contracts/${recordId}.json`;
    case "follow_through_recommendation": return null;
    default: return null;
  }
}

function stageFromRecord(
  id: MissionControlActivationPipelineStageId,
  label: string,
  count: number,
  record: (Record<string, unknown> & { actionToken?: string }) | null,
  status: MissionControlActivationPipelineStageStatus,
): MissionControlActivationPipelineStage {
  const latestStatus = unknownRecordValue(record, "status");
  const latestToken = unknownRecordValue(record, "actionToken");
  const contentPreview = unknownRecordValue(record, "contentPreview") || unknownRecordValue(record, "content");
  return {
    id,
    label,
    protocol: unknownRecordValue(record, "protocol"),
    status: record ? status : "missing",
    count,
    latestId: unknownRecordValue(record, "id"),
    latestToken,
    latestStatus,
    relativePath: record ? relativePathForActivationStage(id, record) : null,
    sourceStageId: record ? sourceStageIdForActivationStage(id) : null,
    sourceToken: record ? sourceTokenForActivationStage(id, record) : null,
    latestCreatedAt: unknownRecordValue(record, "createdAt"),
    targetRole: unknownRecordValue(record, "targetRole"),
    targetPaneId: unknownRecordValue(record, "targetPaneId"),
    targetLabel: unknownRecordValue(record, "targetLabel"),
    contentPreview,
    bodySha256: unknownRecordValue(record, "bodySha256"),
    adapterPacketSha256: unknownRecordValue(record, "adapterPacketSha256"),
    summary: record
      ? `${label}: ${String(latestStatus || status).replace(/_/g, " ")}; token ${latestToken || "not available"}.`
      : `${label}: not saved yet.`,
    hardStop: hardStopFromRecord(record),
  };
}

function buildActivationPipelineTrace(
  stages: MissionControlActivationPipelineStage[],
  currentStage: MissionControlActivationPipelineStage | null,
): MissionControlActivationPipelineTrace {
  const entries = stages
    .filter((stage) => stage.status !== "missing")
    .map((stage) => ({
      stageId: stage.id,
      label: stage.label,
      status: stage.status,
      token: stage.latestToken,
      relativePath: stage.relativePath,
      sourceStageId: stage.sourceStageId,
      sourceToken: stage.sourceToken,
      createdAt: stage.latestCreatedAt,
      targetRole: stage.targetRole,
      contentPreview: stage.contentPreview,
      bodySha256: stage.bodySha256,
      adapterPacketSha256: stage.adapterPacketSha256,
      summary: stage.summary,
    }));

  return {
    protocol: "mira.mission_control_activation_pipeline_trace.v0",
    entryCount: entries.length,
    currentStageId: currentStage?.id || null,
    currentArtifactToken: currentStage?.latestToken || null,
    sourcePath: entries.length
      ? entries.map((entry) => entry.label).join(" -> ")
      : "No saved Mission Control activation artifacts yet.",
    entries,
    noEffectSummary: "Read-only trace only; no command stored, live hm-send execution, bridge delivery, Telegram, route flip, provider/model call, account or token access, runtime execution, or external delivery.",
  };
}

function nextStageAfter(
  stageId: MissionControlActivationPipelineStageId | null,
): { id: MissionControlActivationPipelineStageId; label: string } | null {
  if (!stageId) return null;
  const currentIndex = activationPipelineStageDefinitions.findIndex((definition) => definition.id === stageId);
  return currentIndex >= 0 ? activationPipelineStageDefinitions[currentIndex + 1] || null : null;
}

function buildActivationPipelineAdvanceSelection(
  stages: MissionControlActivationPipelineStage[],
): MissionControlActivationPipelineAdvanceSelection {
  const availableStages = stages.filter((stage) => stage.status !== "missing");
  const firstMissingIndex = stages.findIndex((stage) => stage.status === "missing");
  const hardStopReached = firstMissingIndex === -1
    && stages.some((stage) => stage.id === "live_activation_gate_contract" && stage.status !== "missing");
  const selectedStage = hardStopReached
    ? stages.find((stage) => stage.id === "live_activation_gate_contract") || null
    : firstMissingIndex > 0
      ? stages[firstMissingIndex - 1]
      : null;
  const nextStage = hardStopReached
    ? null
    : firstMissingIndex >= 0
      ? stages[firstMissingIndex]
      : null;
  const status: MissionControlActivationPipelineAdvanceSelection["status"] = hardStopReached
    ? "hard_stop_reached"
    : selectedStage && nextStage
      ? "advance_available"
      : "no_chain";
  const reason = status === "hard_stop_reached"
    ? "The chain is already at the live activation hard-stop contract. This read-only surface has no next artifact to advance; future real send would require a separate James-visible setup/activation lane."
    : status === "advance_available" && selectedStage && nextStage
      ? `${selectedStage.label} is the latest available stage before the first missing stage, ${nextStage.label}.`
      : "No saved Mission Control route preview exists yet, so there is no artifact to advance.";
  const comparisonSummary = status === "hard_stop_reached"
    ? `Compared ${availableStages.length} available stage(s); no advancement is available after the hard-stop contract.`
    : status === "advance_available" && selectedStage && nextStage
      ? `Compared ${availableStages.length} available stage(s); selected ${selectedStage.label} because ${nextStage.label} is the first missing stage.`
      : "Compared 0 available stages; start by saving a route preview.";

  return {
    protocol: "mira.mission_control_activation_pipeline_advance_selection.v0",
    status,
    selectedStageId: selectedStage?.id || null,
    selectedStageLabel: selectedStage?.label || null,
    selectedArtifactToken: selectedStage?.latestToken || null,
    selectedRelativePath: selectedStage?.relativePath || null,
    selectedArtifactStatus: selectedStage?.status || null,
    selectedSourceStageId: selectedStage?.sourceStageId || null,
    selectedSourceToken: selectedStage?.sourceToken || null,
    selectedBodySha256: selectedStage?.bodySha256 || null,
    selectedAdapterPacketSha256: selectedStage?.adapterPacketSha256 || null,
    nextStageId: nextStage?.id || null,
    nextStageLabel: nextStage?.label || null,
    reason,
    comparisonSummary,
    candidates: availableStages.map((stage) => {
      const stageNext = nextStageAfter(stage.id);
      const selected = selectedStage?.id === stage.id;
      return {
        stageId: stage.id,
        label: stage.label,
        token: stage.latestToken,
        relativePath: stage.relativePath,
        status: stage.status,
        selected,
        nextStageId: stageNext?.id || null,
        nextStageLabel: stageNext?.label || null,
        reason: selected
          ? reason
          : `${stage.label} is available evidence, but ${selectedStage?.label || "no saved artifact"} is the current selection.`,
      };
    }),
    noEffectSummary: "Read-only selection aid only; it compares existing trace entries and does not persist a selection, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.",
  };
}

function manualActionForActivationAdvance(
  selectedStageId: MissionControlActivationPipelineStageId | null,
): { label: string; tokenField: string } | null {
  switch (selectedStageId) {
    case "route_preview": return { label: "Make review item", tokenField: "previewToken" };
    case "internal_route_request": return { label: "Review continuation", tokenField: "requestToken" };
    case "follow_through_recommendation": return { label: "Preview delivery packet", tokenField: "recommendationToken" };
    case "internal_delivery_preview": return { label: "Review dispatch readiness", tokenField: "deliveryPreviewToken" };
    case "dispatch_readiness": return { label: "Create send dry run", tokenField: "dispatchReadinessToken" };
    case "internal_send_dry_run": return { label: "Design activation proof", tokenField: "internalSendDryRunToken" };
    case "activation_design": return { label: "Preview activation request", tokenField: "internalSendActivationDesignToken" };
    case "activation_request": return { label: "Record decision audit", tokenField: "internalSendActivationRequestToken" };
    case "activation_decision_audit": return { label: "Check implementation readiness", tokenField: "internalSendActivationDecisionAuditToken" };
    case "activation_implementation_readiness": return { label: "Define live gate contract", tokenField: "internalSendActivationImplementationReadinessToken" };
    case "owned_work_continuation":
    case "live_activation_gate_contract":
    default:
      return null;
  }
}

function buildActivationPipelineManualActionPreflight(
  selection: MissionControlActivationPipelineAdvanceSelection,
): MissionControlActivationPipelineManualActionPreflight {
  const action = manualActionForActivationAdvance(selection.selectedStageId);
  const blockedHardStop = selection.status === "hard_stop_reached";
  const ready = selection.status === "advance_available"
    && Boolean(action)
    && Boolean(selection.selectedArtifactToken)
    && Boolean(selection.nextStageId);
  const status: MissionControlActivationPipelineManualActionPreflight["status"] = blockedHardStop
    ? "blocked_hard_stop"
    : ready
      ? "ready"
      : "blocked_no_source";
  const explanation = status === "ready" && action
    ? `${action.label} is the next manual internal action because ${selection.selectedStageLabel} is selected and ${selection.nextStageLabel} is the first missing stage. Use the selected token as ${action.tokenField}; this preflight does not perform the action.`
    : status === "blocked_hard_stop"
      ? "No manual advancement is available from this read-only surface because the selected artifact is the live activation hard-stop contract."
      : "No manual action is ready because there is no selected saved artifact with a token and next missing stage.";

  return {
    protocol: "mira.mission_control_activation_pipeline_manual_action_preflight.v0",
    status,
    selectedStageId: selection.selectedStageId,
    selectedStageLabel: selection.selectedStageLabel,
    selectedArtifactToken: selection.selectedArtifactToken,
    selectedRelativePath: selection.selectedRelativePath,
    nextStageId: selection.nextStageId,
    nextStageLabel: selection.nextStageLabel,
    manualActionLabel: status === "ready" ? action?.label || null : null,
    manualActionSurface: status === "ready" ? "mission_control_workbench" : null,
    tokenField: status === "ready" ? action?.tokenField || null : null,
    tokenValue: status === "ready" ? selection.selectedArtifactToken : null,
    explanation,
    evidenceChecks: [
      {
        id: "selected_artifact_token_present",
        label: "Selected artifact token is available.",
        ok: Boolean(selection.selectedArtifactToken),
      },
      {
        id: "selected_artifact_path_present",
        label: "Selected artifact path is available or the selected entry is derived.",
        ok: Boolean(selection.selectedRelativePath) || selection.selectedArtifactStatus === "derived",
      },
      {
        id: "next_stage_missing",
        label: "A next missing stage exists for manual advancement.",
        ok: Boolean(selection.nextStageId),
      },
      {
        id: "not_hard_stop",
        label: "Selected artifact is not the live activation hard-stop contract.",
        ok: !blockedHardStop,
      },
      {
        id: "preflight_is_read_only",
        label: "Preflight is derived from GET status and does not persist or execute anything.",
        ok: true,
      },
    ],
    noEffectSummary: "Read-only preflight only; it explains the next manual internal action and does not persist, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.",
  };
}

function manualActionPayloadPreviewForStage(
  stageId: MissionControlActivationPipelineStageId | null,
  tokenValue: string | null,
): {
  method: "POST";
  endpoint: string;
  tokenField: string;
  payload: Record<string, string>;
  requiredManualInputs: string[];
} | null {
  if (!tokenValue) return null;
  switch (stageId) {
    case "route_preview":
      return {
        method: "POST",
        endpoint: "/mission-control/internal-route-requests",
        tokenField: "previewToken",
        payload: { previewToken: tokenValue },
        requiredManualInputs: [],
      };
    case "internal_route_request":
      return {
        method: "POST",
        endpoint: "/mission-control/owned-work-continuations",
        tokenField: "requestToken",
        payload: {
          requestToken: tokenValue,
          decision: "<approve|edit|reject>",
          editedContent: "<review text when editing>",
          note: "<optional note>",
        },
        requiredManualInputs: ["decision", "editedContent when decision is edit", "optional note"],
      };
    case "follow_through_recommendation":
      return {
        method: "POST",
        endpoint: "/mission-control/internal-delivery-previews",
        tokenField: "recommendationToken",
        payload: { recommendationToken: tokenValue },
        requiredManualInputs: [],
      };
    case "internal_delivery_preview":
      return {
        method: "POST",
        endpoint: "/mission-control/dispatch-readiness",
        tokenField: "deliveryPreviewToken",
        payload: { deliveryPreviewToken: tokenValue },
        requiredManualInputs: [],
      };
    case "dispatch_readiness":
      return {
        method: "POST",
        endpoint: "/mission-control/internal-send-dry-runs",
        tokenField: "dispatchReadinessToken",
        payload: { dispatchReadinessToken: tokenValue },
        requiredManualInputs: [],
      };
    case "internal_send_dry_run":
      return {
        method: "POST",
        endpoint: "/mission-control/internal-send-activation-designs",
        tokenField: "internalSendDryRunToken",
        payload: { internalSendDryRunToken: tokenValue },
        requiredManualInputs: [],
      };
    case "activation_design":
      return {
        method: "POST",
        endpoint: "/mission-control/internal-send-activation-requests",
        tokenField: "internalSendActivationDesignToken",
        payload: { internalSendActivationDesignToken: tokenValue },
        requiredManualInputs: [],
      };
    case "activation_request":
      return {
        method: "POST",
        endpoint: "/mission-control/internal-send-activation-decision-audits",
        tokenField: "internalSendActivationRequestToken",
        payload: { internalSendActivationRequestToken: tokenValue },
        requiredManualInputs: [],
      };
    case "activation_decision_audit":
      return {
        method: "POST",
        endpoint: "/mission-control/internal-send-activation-implementation-readiness",
        tokenField: "internalSendActivationDecisionAuditToken",
        payload: { internalSendActivationDecisionAuditToken: tokenValue },
        requiredManualInputs: [],
      };
    case "activation_implementation_readiness":
      return {
        method: "POST",
        endpoint: "/mission-control/internal-send-live-activation-gate-contracts",
        tokenField: "internalSendActivationImplementationReadinessToken",
        payload: { internalSendActivationImplementationReadinessToken: tokenValue },
        requiredManualInputs: [],
      };
    case "owned_work_continuation":
    case "live_activation_gate_contract":
    default:
      return null;
  }
}

function workbenchHandlerExpectationForStage(
  stageId: MissionControlActivationPipelineStageId | null,
): {
  handlerName: string;
  handlerSource: string;
  method: "POST";
  endpoint: string;
  tokenField: string;
  bodyFields: string[];
} | null {
  switch (stageId) {
    case "route_preview":
      return {
        handlerName: "createRouteRequestFromPreview",
        handlerSource: "mira/ui/app.js:createRouteRequestFromPreview",
        method: "POST",
        endpoint: "/mission-control/internal-route-requests",
        tokenField: "previewToken",
        bodyFields: ["previewToken"],
      };
    case "internal_route_request":
      return {
        handlerName: "createOwnedWorkContinuation",
        handlerSource: "mira/ui/app.js:createOwnedWorkContinuation",
        method: "POST",
        endpoint: "/mission-control/owned-work-continuations",
        tokenField: "requestToken",
        bodyFields: ["requestToken", "decision", "editedContent", "note"],
      };
    case "follow_through_recommendation":
      return {
        handlerName: "createInternalDeliveryPreview",
        handlerSource: "mira/ui/app.js:createInternalDeliveryPreview",
        method: "POST",
        endpoint: "/mission-control/internal-delivery-previews",
        tokenField: "recommendationToken",
        bodyFields: ["recommendationToken"],
      };
    case "internal_delivery_preview":
      return {
        handlerName: "createDispatchReadiness",
        handlerSource: "mira/ui/app.js:createDispatchReadiness",
        method: "POST",
        endpoint: "/mission-control/dispatch-readiness",
        tokenField: "deliveryPreviewToken",
        bodyFields: ["deliveryPreviewToken"],
      };
    case "dispatch_readiness":
      return {
        handlerName: "createInternalSendDryRun",
        handlerSource: "mira/ui/app.js:createInternalSendDryRun",
        method: "POST",
        endpoint: "/mission-control/internal-send-dry-runs",
        tokenField: "dispatchReadinessToken",
        bodyFields: ["dispatchReadinessToken"],
      };
    case "internal_send_dry_run":
      return {
        handlerName: "createInternalSendActivationDesign",
        handlerSource: "mira/ui/app.js:createInternalSendActivationDesign",
        method: "POST",
        endpoint: "/mission-control/internal-send-activation-designs",
        tokenField: "internalSendDryRunToken",
        bodyFields: ["internalSendDryRunToken"],
      };
    case "activation_design":
      return {
        handlerName: "createInternalSendActivationRequest",
        handlerSource: "mira/ui/app.js:createInternalSendActivationRequest",
        method: "POST",
        endpoint: "/mission-control/internal-send-activation-requests",
        tokenField: "internalSendActivationDesignToken",
        bodyFields: ["internalSendActivationDesignToken"],
      };
    case "activation_request":
      return {
        handlerName: "createInternalSendActivationDecisionAudit",
        handlerSource: "mira/ui/app.js:createInternalSendActivationDecisionAudit",
        method: "POST",
        endpoint: "/mission-control/internal-send-activation-decision-audits",
        tokenField: "internalSendActivationRequestToken",
        bodyFields: ["internalSendActivationRequestToken"],
      };
    case "activation_decision_audit":
      return {
        handlerName: "createInternalSendActivationImplementationReadiness",
        handlerSource: "mira/ui/app.js:createInternalSendActivationImplementationReadiness",
        method: "POST",
        endpoint: "/mission-control/internal-send-activation-implementation-readiness",
        tokenField: "internalSendActivationDecisionAuditToken",
        bodyFields: ["internalSendActivationDecisionAuditToken"],
      };
    case "activation_implementation_readiness":
      return {
        handlerName: "createInternalSendLiveActivationGateContract",
        handlerSource: "mira/ui/app.js:createInternalSendLiveActivationGateContract",
        method: "POST",
        endpoint: "/mission-control/internal-send-live-activation-gate-contracts",
        tokenField: "internalSendActivationImplementationReadinessToken",
        bodyFields: ["internalSendActivationImplementationReadinessToken"],
      };
    case "owned_work_continuation":
    case "live_activation_gate_contract":
    default:
      return null;
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function buildHandlerDriftCheck(
  preflight: MissionControlActivationPipelineManualActionPreflight,
  payloadDefinition: ReturnType<typeof manualActionPayloadPreviewForStage>,
): MissionControlActivationPipelinePayloadPreview["handlerDriftCheck"] {
  const expectation = workbenchHandlerExpectationForStage(preflight.selectedStageId);
  const previewMethod = payloadDefinition?.method || null;
  const previewBodyFields = payloadDefinition ? Object.keys(payloadDefinition.payload) : [];
  const previewTokenField = payloadDefinition
    ? Object.keys(payloadDefinition.payload).find((field) => field === payloadDefinition.tokenField) || null
    : null;
  const methodMatches = Boolean(expectation && previewMethod === expectation.method);
  const endpointMatches = Boolean(expectation && payloadDefinition?.endpoint === expectation.endpoint);
  const tokenFieldMatches = Boolean(expectation && payloadDefinition?.tokenField === expectation.tokenField && previewTokenField === expectation.tokenField);
  const bodyShapeMatches = Boolean(expectation && sameStringSet(previewBodyFields, expectation.bodyFields));
  const matched = preflight.status === "ready"
    && Boolean(payloadDefinition)
    && Boolean(expectation)
    && methodMatches
    && endpointMatches
    && tokenFieldMatches
    && bodyShapeMatches
    && payloadDefinition?.payload[payloadDefinition.tokenField] === preflight.tokenValue;
  const status = preflight.status !== "ready" || !payloadDefinition || !expectation
    ? "blocked"
    : matched
      ? "matched"
      : "mismatched";

  return {
    protocol: "mira.mission_control_workbench_handler_drift_check.v0",
    status,
    handlerName: expectation?.handlerName || null,
    handlerSource: expectation?.handlerSource || null,
    actionLabel: preflight.manualActionLabel,
    expectedMethod: expectation?.method || null,
    previewMethod,
    expectedEndpoint: expectation?.endpoint || null,
    previewEndpoint: payloadDefinition?.endpoint || null,
    expectedTokenField: expectation?.tokenField || null,
    previewTokenField,
    expectedBodyFields: expectation?.bodyFields || [],
    previewBodyFields,
    explanation: status === "matched"
      ? `${expectation?.handlerName} expects ${expectation?.method} ${expectation?.endpoint} with ${expectation?.tokenField}; payload preview matches that workbench handler contract.`
      : status === "mismatched"
        ? "Payload preview does not match the static workbench handler expectation for this selected stage."
      : "No workbench handler drift check is available because the manual action preflight is blocked.",
    checks: [
      {
        id: "manual_preflight_ready",
        label: "Manual action preflight is ready.",
        ok: preflight.status === "ready",
      },
      {
        id: "handler_method_matches_preview",
        label: "Workbench handler method matches the payload preview method.",
        ok: methodMatches,
      },
      {
        id: "handler_endpoint_matches_preview",
        label: "Workbench handler endpoint matches the payload preview endpoint.",
        ok: endpointMatches,
      },
      {
        id: "handler_token_field_matches_preview",
        label: "Workbench handler token field matches the payload preview token field.",
        ok: tokenFieldMatches,
      },
      {
        id: "handler_body_shape_matches_preview",
        label: "Workbench handler body shape matches the payload preview body shape.",
        ok: bodyShapeMatches,
      },
      {
        id: "handler_drift_check_read_only",
        label: "Drift check is derived from GET status and does not submit the handler.",
        ok: true,
      },
    ],
    noEffectSummary: "Read-only workbench handler drift check only; it compares endpoint and token-field expectations and does not submit, persist, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.",
  };
}

function buildActivationPipelinePayloadPreview(
  preflight: MissionControlActivationPipelineManualActionPreflight,
): MissionControlActivationPipelinePayloadPreview {
  const payloadDefinition = manualActionPayloadPreviewForStage(preflight.selectedStageId, preflight.tokenValue);
  const readyForPayload = preflight.status === "ready" && Boolean(payloadDefinition);
  const status: MissionControlActivationPipelinePayloadPreview["status"] = !readyForPayload
    ? "blocked"
    : payloadDefinition && payloadDefinition.requiredManualInputs.length > 0
      ? "needs_manual_input"
      : "ready";
  const explanation = status === "ready" && payloadDefinition
    ? `This is the exact workbench payload preview for ${preflight.manualActionLabel}; it is not submitted by the status surface.`
    : status === "needs_manual_input" && payloadDefinition
      ? `This payload skeleton needs manual input before ${preflight.manualActionLabel} can be submitted from the workbench.`
      : "No payload preview is available because the manual action preflight is blocked.";

  return {
    protocol: "mira.mission_control_activation_pipeline_payload_preview.v0",
    status,
    actionLabel: preflight.manualActionLabel,
    method: payloadDefinition ? "POST" : null,
    endpoint: payloadDefinition?.endpoint || null,
    payload: payloadDefinition?.payload || null,
    requiredManualInputs: payloadDefinition?.requiredManualInputs || [],
    selectedStageId: preflight.selectedStageId,
    selectedArtifactToken: preflight.selectedArtifactToken,
    selectedRelativePath: preflight.selectedRelativePath,
    explanation,
    handlerDriftCheck: buildHandlerDriftCheck(preflight, payloadDefinition),
    validationChecks: [
      {
        id: "manual_preflight_ready",
        label: "Manual action preflight is ready.",
        ok: preflight.status === "ready",
      },
      {
        id: "endpoint_known",
        label: "Existing workbench endpoint is known.",
        ok: Boolean(payloadDefinition?.endpoint),
      },
      {
        id: "selected_token_present",
        label: "Selected artifact token is present in the preview payload.",
        ok: Boolean(preflight.tokenValue),
      },
      {
        id: "payload_preview_read_only",
        label: "Payload preview is derived from GET status and is not submitted or persisted.",
        ok: true,
      },
    ],
    noEffectSummary: "Read-only payload preview only; it validates the existing workbench action payload shape and does not persist, submit, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.",
  };
}

function buildActivationPipelineEndToEndReadout(
  stages: MissionControlActivationPipelineStage[],
  currentStage: MissionControlActivationPipelineStage | null,
  hardStopTruth: MissionControlActivationPipelineStatusResult["hardStopTruth"],
  nextBoundary: MissionControlActivationPipelineStatusResult["nextBoundary"],
  manualActionPreflight: MissionControlActivationPipelineManualActionPreflight,
): MissionControlActivationPipelineEndToEndReadout {
  const availableStages = stages.filter((stage) => stage.status !== "missing");
  const missingStageLabels = stages.filter((stage) => stage.status === "missing").map((stage) => stage.label);
  const hardStopRecorded = hardStopTruth.hardStopContractRecorded === true;
  const status: MissionControlActivationPipelineEndToEndReadout["status"] = hardStopRecorded
    ? "terminal_hard_stop"
    : currentStage
      ? "in_progress"
      : "empty";
  const headline = status === "terminal_hard_stop"
    ? "Mission Control send chain is complete to the hard stop; live send is unavailable."
    : status === "in_progress"
      ? `Mission Control send chain is at ${currentStage?.label || "an in-progress stage"}; the next step remains manual-only.`
      : "Mission Control send chain has no saved artifact yet.";
  const completedChainSummary = missingStageLabels.length === 0
    ? `${availableStages.length}/${stages.length} stages have saved or derived local evidence.`
    : `${availableStages.length}/${stages.length} stages have saved or derived local evidence; missing ${missingStageLabels.join(", ")}.`;
  const provenSummary = status === "terminal_hard_stop"
    ? "Saved local evidence covers route preview through live activation hard-stop contract; the status refresh is read-only and no next artifact is available."
    : currentStage
      ? `Saved local evidence currently reaches ${currentStage.label}; the next workbench action is ${manualActionPreflight.manualActionLabel || "not ready"}.`
      : "No saved chain evidence exists yet.";
  const manualOnlySummary = status === "terminal_hard_stop"
    ? "All advancement before the hard stop used explicit workbench actions; this readout has no submit, send, execution, provider, route, account, or token path."
    : manualActionPreflight.status === "ready"
      ? `${manualActionPreflight.manualActionLabel} remains an explicit workbench action; this readout only explains it.`
      : "No manual advancement is ready from this readout.";
  const currentHardStopTruth = `liveSendAvailable:${hardStopTruth.liveSendAvailable}; hardStopRecorded:${hardStopRecorded}; jamesSetupRequiredBeforeLiveSend:${hardStopTruth.jamesSetupRequiredBeforeLiveSend}.`;

  return {
    protocol: "mira.mission_control_activation_pipeline_end_to_end_readout.v0",
    status,
    headline,
    completedChainSummary,
    currentHardStopTruth,
    provenSummary,
    manualOnlySummary,
    nextBoundary: nextBoundary.currentNextStep,
    currentStageId: currentStage?.id || null,
    currentStageLabel: currentStage?.label || "No Mission Control send chain yet",
    currentArtifactToken: currentStage?.latestToken || null,
    currentRelativePath: currentStage?.relativePath || null,
    stageCount: stages.length,
    availableStageCount: availableStages.length,
    missingStageLabels,
    hardStopRecorded,
    liveSendAvailable: false,
    realSendRequiresSeparateActivation: true,
    demoPath: {
      protocol: "mira.mission_control_activation_pipeline_demo_path.v0",
      surface: "New Mira local workbench",
      open: "Open the local New Mira workbench and read the Mission Control activation pipeline status card.",
      read: [
        "Readout",
        "Completed chain",
        "What was proven",
        "Manual-only",
        "Readout boundary",
      ],
      means: status === "terminal_hard_stop"
        ? "The demo shows Mission Control can explain a complete saved local coordination chain from artifacts, ending at a hard stop instead of pretending to send."
        : "The demo shows the current saved Mission Control coordination chain and the next explicit manual workbench step.",
      manualOnly: "This demo path only reads existing status/artifact evidence; it does not submit, send, execute, call a model/provider, flip routes, or access accounts/tokens.",
      nextBoundary: nextBoundary.currentNextStep,
      inspectionRunbook: {
        protocol: "mira.mission_control_demo_inspection_runbook.v0",
        entryPoint: "Local New Mira workbench -> Mission Control activation pipeline status card",
        evidenceSource: "GET /mission-control/activation-pipeline-status",
        steps: [
          "Open the local New Mira workbench",
          "Find the Activation pipeline status card",
          "Read Demo path, Completed chain, What was proven, Manual-only, and Readout boundary",
          "Confirm terminal hard-stop/no-live-send truth before any future activation discussion",
        ],
        expectedReadout: status === "terminal_hard_stop"
          ? [
            "terminal hard stop",
            `${availableStages.length}/${stages.length} stages available`,
            "live send unavailable",
            "future real send requires a separate James-visible setup/activation lane",
          ]
          : [
            "in-progress local chain",
            `${availableStages.length}/${stages.length} stages available`,
            "next manual workbench step remains explicit",
            "live send unavailable",
          ],
        verification: "API and UI harnesses verify this card from the existing status GET; no screenshot, fixed-port runtime, write, or send is required for the proof.",
        boundary: "Inspection is read-only product clarity over saved local artifacts/status; it is not a dispatch, activation, model turn, route flip, or external action.",
      },
      walkthrough: {
        protocol: "mira.mission_control_demo_walkthrough.v0",
        title: status === "terminal_hard_stop"
          ? "Mission Control completed-chain hard-stop walkthrough"
          : "Mission Control in-progress saved-chain walkthrough",
        sourceEvidence: [
          `current stage: ${currentStage?.label || "No saved stage"}`,
          `artifact token: ${currentStage?.latestToken || "none"}`,
          `artifact path: ${currentStage?.relativePath || "none"}`,
          `saved stages: ${availableStages.length}/${stages.length}`,
        ],
        narrativeSteps: status === "terminal_hard_stop"
          ? [
            "Mission Control reads the saved local coordination chain from route preview through live-gate contract.",
            "It shows the current evidence is the live activation hard-stop contract, backed by token/path/source checksums.",
            "It explains that the chain is complete as an inspection demo, but live send is not available from this surface.",
            "It points the next boundary at a separate James-visible setup/activation lane for any future real send proposal.",
          ]
          : [
            "Mission Control reads the saved local coordination chain and identifies the current furthest artifact.",
            "It shows which local evidence backs the current stage and what manual workbench action would be next.",
            "It keeps the walkthrough read-only so the demo explains the next move without taking it.",
          ],
        whyUseful: "This is useful because Mission Control turns saved local team-work artifacts into an inspectable next-state explanation instead of generic chat.",
        stillManual: "The walkthrough does not click, submit, send, execute, call a provider/model, flip routes, or access accounts/tokens.",
        nextBoundary: nextBoundary.currentNextStep,
      },
      whatNowSummary: {
        protocol: "mira.mission_control_what_now_summary.v0",
        answer: status === "terminal_hard_stop"
          ? "Inspect the local status card as a completed Mission Control demo; the chain ends at a hard stop, not a live send."
          : "Inspect the local status card for the current saved stage and the next explicit manual workbench step.",
        currentMeaning: status === "terminal_hard_stop"
          ? `The saved chain is complete as a read-only demo: ${availableStages.length}/${stages.length} stages are available and the current artifact is ${currentStage?.label || "the hard stop"}.`
          : `The saved chain is in progress: ${availableStages.length}/${stages.length} stages are available and the current artifact is ${currentStage?.label || "not saved yet"}.`,
        inspectNext: status === "terminal_hard_stop"
          ? "Read the status card's Readout, Current evidence, Trace path, Demo walkthrough, and Hard stop rows."
          : "Read the status card's Current stage, Selected artifact, Manual action preflight, and Payload preview rows.",
        noLiveReason: "Live action is unavailable because this status projection is read-only and any real send requires a separate James-visible setup/activation lane.",
        nextBoundary: nextBoundary.currentNextStep,
        sourceEvidence: [
          `current stage: ${currentStage?.label || "No saved stage"}`,
          `artifact token: ${currentStage?.latestToken || "none"}`,
          `artifact path: ${currentStage?.relativePath || "none"}`,
          `available stages: ${availableStages.length}/${stages.length}`,
          `live send available: ${hardStopTruth.liveSendAvailable}`,
        ],
        noEffectSummary: "What-now summary is derived from existing status/artifact evidence only; it does not persist, submit, execute, send, call a provider/model, flip routes, or access accounts/tokens.",
      },
      noEffectSummary: "Read-only demo path only; it explains where to look in the local workbench and what the saved status means without adding a write path or live action.",
    },
    noEffectSummary: "Read-only Mission Control end-to-end readout only; it summarizes existing status/trace artifacts and does not persist, submit, execute, send, deliver, call a provider/model, access accounts/tokens, flip routes, or start runtime work.",
  };
}

function missingStage(id: MissionControlActivationPipelineStageId, label: string): MissionControlActivationPipelineStage {
  return stageFromRecord(id, label, 0, null, "missing");
}

function currentPipelineNextStep(currentStageId: MissionControlActivationPipelineStageId | null): string {
  if (!currentStageId) return "Save a Mission Control route preview before this chain has a current stage.";
  if (currentStageId === "live_activation_gate_contract") {
    return "The chain is at the hard-stop contract. Live send is unavailable; future real send would require a separate James-visible setup/activation lane.";
  }
  const currentIndex = activationPipelineStageDefinitions.findIndex((stage) => stage.id === currentStageId);
  const nextStage = activationPipelineStageDefinitions[currentIndex + 1] || null;
  return nextStage
    ? `Next inspectable step is ${nextStage.label.toLowerCase()}; live send is still unavailable.`
    : "Live send is unavailable; future real send would require a separate James-visible setup/activation lane.";
}

function buildActivationPipelineStages(rootPath: string | null): MissionControlActivationPipelineStage[] {
  if (!rootPath) {
    return activationPipelineStageDefinitions.map((definition) => missingStage(definition.id, definition.label));
  }

  const previews = readPreviewRecords(rootPath).map(toPublicRecord);
  const routeRequests = readRouteRequestRecords(rootPath).map(toPublicRouteRequest);
  const continuations = readContinuationRecords(rootPath).map(toPublicContinuation);
  const rawContinuations = readContinuationRecords(rootPath);
  const selectedContinuation = selectFollowThroughContinuation(rawContinuations);
  const followThrough = selectedContinuation
    ? buildFollowThroughRecommendation(selectedContinuation, selectedContinuation.id)
    : null;
  const recommendations = rawContinuations.map((record) => buildFollowThroughRecommendation(record, selectedContinuation?.id || null));
  const deliveryPreviews = readDeliveryPreviewRecords(rootPath).map(toPublicDeliveryPreview);
  const dispatchReadiness = readDispatchReadinessRecords(rootPath).map(toPublicDispatchReadiness);
  const dryRuns = readInternalSendDryRunRecords(rootPath).map(toPublicInternalSendDryRun);
  const activationDesigns = readInternalSendActivationDesignRecords(rootPath).map(toPublicInternalSendActivationDesign);
  const activationRequests = readInternalSendActivationRequestRecords(rootPath).map(toPublicInternalSendActivationRequest);
  const decisionAudits = readInternalSendActivationDecisionAuditRecords(rootPath).map(toPublicInternalSendActivationDecisionAudit);
  const implementationReadiness = readInternalSendActivationImplementationReadinessRecords(rootPath).map(toPublicInternalSendActivationImplementationReadiness);
  const liveGateContracts = readInternalSendLiveActivationGateContractRecords(rootPath).map(toPublicInternalSendLiveActivationGateContract);

  return [
    stageFromRecord("route_preview", "Route preview", previews.length, previews[0] || null, "saved"),
    stageFromRecord("internal_route_request", "Review item", routeRequests.length, routeRequests[0] || null, "saved"),
    stageFromRecord("owned_work_continuation", "Owned-work continuation", continuations.length, continuations[0] || null, "saved"),
    stageFromRecord("follow_through_recommendation", "Follow-through recommendation", recommendations.length, followThrough, "derived"),
    stageFromRecord("internal_delivery_preview", "Delivery preview", deliveryPreviews.length, deliveryPreviews[0] || null, "saved"),
    stageFromRecord("dispatch_readiness", "Dispatch readiness", dispatchReadiness.length, dispatchReadiness[0] || null, "saved"),
    stageFromRecord("internal_send_dry_run", "Internal-send dry run", dryRuns.length, dryRuns[0] || null, "saved"),
    stageFromRecord("activation_design", "Activation design", activationDesigns.length, activationDesigns[0] || null, "saved"),
    stageFromRecord("activation_request", "Activation request", activationRequests.length, activationRequests[0] || null, "saved"),
    stageFromRecord("activation_decision_audit", "Decision audit", decisionAudits.length, decisionAudits[0] || null, "saved"),
    stageFromRecord("activation_implementation_readiness", "Implementation readiness", implementationReadiness.length, implementationReadiness[0] || null, "saved"),
    stageFromRecord("live_activation_gate_contract", "Live activation hard-stop contract", liveGateContracts.length, liveGateContracts[0] || null, "saved"),
  ];
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

function rejectInternalSendActivationRequestInput(input: JsonObject): void {
  const activationRequest = optionalObject(input.activationRequest);
  const activationRequestTarget = optionalObject(activationRequest?.target);
  const activationRequestBody = optionalObject(activationRequest?.body);
  const request = optionalObject(input.request);
  const requestTarget = optionalObject(request?.target);
  const requestBody = optionalObject(request?.body);
  const reviewer = optionalObject(input.reviewer);
  const reviewerTarget = optionalObject(reviewer?.target);
  const reviewerBody = optionalObject(reviewer?.body);
  const refusal = optionalObject(input.refusal);
  const refusalPolicy = optionalObject(input.refusalPolicy);
  const rollback = optionalObject(input.rollback);
  const rollbackPlan = optionalObject(input.rollbackPlan);
  const rollbackPlanTarget = optionalObject(rollbackPlan?.target);
  const rollbackPlanBody = optionalObject(rollbackPlan?.body);
  const audit = optionalObject(input.audit);
  const auditPlan = optionalObject(input.auditPlan);
  const auditPlanTarget = optionalObject(auditPlan?.target);
  const auditPlanBody = optionalObject(auditPlan?.body);
  const delivery = optionalObject(input.delivery);
  const dispatch = optionalObject(input.dispatch);
  for (const [containerLabel, container] of [
    ["activationRequest", input],
    ["activationRequest", activationRequest],
    ["activationRequest.target", activationRequestTarget],
    ["activationRequest.body", activationRequestBody],
    ["request", request],
    ["request.target", requestTarget],
    ["request.body", requestBody],
    ["reviewer", reviewer],
    ["reviewer.target", reviewerTarget],
    ["reviewer.body", reviewerBody],
    ["refusal", refusal],
    ["refusalPolicy", refusalPolicy],
    ["rollback", rollback],
    ["rollbackPlan", rollbackPlan],
    ["rollbackPlan.target", rollbackPlanTarget],
    ["rollbackPlan.body", rollbackPlanBody],
    ["audit", audit],
    ["auditPlan", auditPlan],
    ["auditPlan.target", auditPlanTarget],
    ["auditPlan.body", auditPlanBody],
    ["delivery", delivery],
    ["dispatch", dispatch],
  ] as const) {
    if (!container) continue;
    if ("command" in container || "args" in container) {
      throw Object.assign(new Error(`Mission Control internal-send activation request previews do not accept command or args fields in ${containerLabel}.`), {
        code: "mission_control_internal_send_activation_request_command_not_allowed",
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
      rejectInternalSendActivationRequestLiveEffect(container[flag], `${containerLabel}.${flag}`);
    }
  }
}

function rejectInternalSendActivationDecisionAuditInput(input: JsonObject): void {
  const decision = optionalObject(input.decision);
  const decisionTarget = optionalObject(decision?.target);
  const decisionBody = optionalObject(decision?.body);
  const refusal = optionalObject(input.refusal);
  const refusalTarget = optionalObject(refusal?.target);
  const refusalBody = optionalObject(refusal?.body);
  const rollback = optionalObject(input.rollback);
  const rollbackTarget = optionalObject(rollback?.target);
  const rollbackBody = optionalObject(rollback?.body);
  const rollbackAudit = optionalObject(input.rollbackAudit);
  const rollbackAuditTarget = optionalObject(rollbackAudit?.target);
  const rollbackAuditBody = optionalObject(rollbackAudit?.body);
  const audit = optionalObject(input.audit);
  const auditTarget = optionalObject(audit?.target);
  const auditBody = optionalObject(audit?.body);
  const request = optionalObject(input.request);
  const requestTarget = optionalObject(request?.target);
  const requestBody = optionalObject(request?.body);
  for (const [containerLabel, container] of [
    ["decisionAudit", input],
    ["decision", decision],
    ["decision.target", decisionTarget],
    ["decision.body", decisionBody],
    ["refusal", refusal],
    ["refusal.target", refusalTarget],
    ["refusal.body", refusalBody],
    ["rollback", rollback],
    ["rollback.target", rollbackTarget],
    ["rollback.body", rollbackBody],
    ["rollbackAudit", rollbackAudit],
    ["rollbackAudit.target", rollbackAuditTarget],
    ["rollbackAudit.body", rollbackAuditBody],
    ["audit", audit],
    ["audit.target", auditTarget],
    ["audit.body", auditBody],
    ["request", request],
    ["request.target", requestTarget],
    ["request.body", requestBody],
  ] as const) {
    if (!container) continue;
    if ("command" in container || "args" in container) {
      throw Object.assign(new Error(`Mission Control internal-send activation decision audits do not accept command or args fields in ${containerLabel}.`), {
        code: "mission_control_internal_send_activation_decision_audit_command_not_allowed",
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
      rejectInternalSendActivationDecisionAuditLiveEffect(container[flag], `${containerLabel}.${flag}`);
    }
  }
}

function rejectInternalSendActivationImplementationReadinessInput(input: JsonObject): void {
  const implementationReadiness = optionalObject(input.implementationReadiness);
  const implementationReadinessTarget = optionalObject(implementationReadiness?.target);
  const implementationReadinessBody = optionalObject(implementationReadiness?.body);
  const implementation = optionalObject(input.implementation);
  const implementationTarget = optionalObject(implementation?.target);
  const implementationBody = optionalObject(implementation?.body);
  const activationImplementation = optionalObject(input.activationImplementation);
  const activationImplementationTarget = optionalObject(activationImplementation?.target);
  const activationImplementationBody = optionalObject(activationImplementation?.body);
  const gate = optionalObject(input.gate);
  const gateTarget = optionalObject(gate?.target);
  const gateBody = optionalObject(gate?.body);
  const readiness = optionalObject(input.readiness);
  const readinessTarget = optionalObject(readiness?.target);
  const readinessBody = optionalObject(readiness?.body);
  const refusal = optionalObject(input.refusal);
  const refusalTarget = optionalObject(refusal?.target);
  const refusalBody = optionalObject(refusal?.body);
  const rollback = optionalObject(input.rollback);
  const rollbackTarget = optionalObject(rollback?.target);
  const rollbackBody = optionalObject(rollback?.body);
  const rollbackAudit = optionalObject(input.rollbackAudit);
  const rollbackAuditTarget = optionalObject(rollbackAudit?.target);
  const rollbackAuditBody = optionalObject(rollbackAudit?.body);
  const audit = optionalObject(input.audit);
  const auditTarget = optionalObject(audit?.target);
  const auditBody = optionalObject(audit?.body);
  const decisionAudit = optionalObject(input.decisionAudit);
  const decisionAuditTarget = optionalObject(decisionAudit?.target);
  const decisionAuditBody = optionalObject(decisionAudit?.body);
  for (const [containerLabel, container] of [
    ["implementationReadiness", input],
    ["implementationReadiness", implementationReadiness],
    ["implementationReadiness.target", implementationReadinessTarget],
    ["implementationReadiness.body", implementationReadinessBody],
    ["implementation", implementation],
    ["implementation.target", implementationTarget],
    ["implementation.body", implementationBody],
    ["activationImplementation", activationImplementation],
    ["activationImplementation.target", activationImplementationTarget],
    ["activationImplementation.body", activationImplementationBody],
    ["gate", gate],
    ["gate.target", gateTarget],
    ["gate.body", gateBody],
    ["readiness", readiness],
    ["readiness.target", readinessTarget],
    ["readiness.body", readinessBody],
    ["refusal", refusal],
    ["refusal.target", refusalTarget],
    ["refusal.body", refusalBody],
    ["rollback", rollback],
    ["rollback.target", rollbackTarget],
    ["rollback.body", rollbackBody],
    ["rollbackAudit", rollbackAudit],
    ["rollbackAudit.target", rollbackAuditTarget],
    ["rollbackAudit.body", rollbackAuditBody],
    ["audit", audit],
    ["audit.target", auditTarget],
    ["audit.body", auditBody],
    ["decisionAudit", decisionAudit],
    ["decisionAudit.target", decisionAuditTarget],
    ["decisionAudit.body", decisionAuditBody],
  ] as const) {
    if (!container) continue;
    if ("command" in container || "args" in container) {
      throw Object.assign(new Error(`Mission Control internal-send activation implementation readiness does not accept command or args fields in ${containerLabel}.`), {
        code: "mission_control_internal_send_activation_implementation_readiness_command_not_allowed",
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
      "implementationEnabled",
      "execute",
      "executed",
      "sendNow",
      "activate",
      "deliveryPerformed",
      "bridgeDelivery",
    ]) {
      rejectInternalSendActivationImplementationReadinessLiveEffect(container[flag], `${containerLabel}.${flag}`);
    }
  }
}

function rejectInternalSendLiveActivationGateContractInput(input: JsonObject): void {
  const liveActivationGate = optionalObject(input.liveActivationGate);
  const liveActivationGateTarget = optionalObject(liveActivationGate?.target);
  const liveActivationGateBody = optionalObject(liveActivationGate?.body);
  const gate = optionalObject(input.gate);
  const gateTarget = optionalObject(gate?.target);
  const gateBody = optionalObject(gate?.body);
  const hardStop = optionalObject(input.hardStop);
  const hardStopTarget = optionalObject(hardStop?.target);
  const hardStopBody = optionalObject(hardStop?.body);
  const jamesRequirements = optionalObject(input.jamesRequirements);
  const jamesRequirementsTarget = optionalObject(jamesRequirements?.target);
  const jamesRequirementsBody = optionalObject(jamesRequirements?.body);
  const setupRequirements = optionalObject(input.setupRequirements);
  const setupRequirementsTarget = optionalObject(setupRequirements?.target);
  const setupRequirementsBody = optionalObject(setupRequirements?.body);
  const activation = optionalObject(input.activation);
  const activationTarget = optionalObject(activation?.target);
  const activationBody = optionalObject(activation?.body);
  const readiness = optionalObject(input.readiness);
  const readinessTarget = optionalObject(readiness?.target);
  const readinessBody = optionalObject(readiness?.body);
  const audit = optionalObject(input.audit);
  const auditTarget = optionalObject(audit?.target);
  const auditBody = optionalObject(audit?.body);
  for (const [containerLabel, container] of [
    ["liveActivationGate", input],
    ["liveActivationGate", liveActivationGate],
    ["liveActivationGate.target", liveActivationGateTarget],
    ["liveActivationGate.body", liveActivationGateBody],
    ["gate", gate],
    ["gate.target", gateTarget],
    ["gate.body", gateBody],
    ["hardStop", hardStop],
    ["hardStop.target", hardStopTarget],
    ["hardStop.body", hardStopBody],
    ["jamesRequirements", jamesRequirements],
    ["jamesRequirements.target", jamesRequirementsTarget],
    ["jamesRequirements.body", jamesRequirementsBody],
    ["setupRequirements", setupRequirements],
    ["setupRequirements.target", setupRequirementsTarget],
    ["setupRequirements.body", setupRequirementsBody],
    ["activation", activation],
    ["activation.target", activationTarget],
    ["activation.body", activationBody],
    ["readiness", readiness],
    ["readiness.target", readinessTarget],
    ["readiness.body", readinessBody],
    ["audit", audit],
    ["audit.target", auditTarget],
    ["audit.body", auditBody],
  ] as const) {
    if (!container) continue;
    if ("command" in container || "args" in container) {
      throw Object.assign(new Error(`Mission Control internal-send live activation gate contracts do not accept command or args fields in ${containerLabel}.`), {
        code: "mission_control_internal_send_live_activation_gate_contract_command_not_allowed",
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
      "liveActivationAllowed",
      "liveHmSendExecutionAllowed",
      "activationAllowed",
      "implementationEnabled",
      "execute",
      "executed",
      "sendNow",
      "activate",
      "deliveryPerformed",
      "bridgeDelivery",
    ]) {
      rejectInternalSendLiveActivationGateContractLiveEffect(container[flag], `${containerLabel}.${flag}`);
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
    missionAnswerPreview: request.missionAnswerPreview,
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
    missionAnswerPreview: continuation.missionAnswerPreview,
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

function resolveInternalSendActivationDesign(
  input: { internalSendActivationDesignToken?: unknown; activationDesignToken?: unknown; designToken?: unknown },
  rootPath: string,
): MissionControlInternalSendActivationDesignRecord {
  const designToken = optionalPreview(input.internalSendActivationDesignToken ?? input.activationDesignToken ?? input.designToken, 320);
  if (!designToken) {
    throw Object.assign(new Error("Mission Control internal-send activation-design token is required."), {
      code: "mission_control_internal_send_activation_design_token_required",
    });
  }
  const record = readInternalSendActivationDesignRecords(rootPath).find((candidate) => {
    return buildInternalSendActivationDesignActionToken(candidate.id) === designToken;
  });
  if (!record) {
    throw Object.assign(new Error("Mission Control internal-send activation design was not found."), {
      code: "mission_control_internal_send_activation_design_not_found",
    });
  }
  return record;
}

function resolveInternalSendActivationRequest(
  input: { internalSendActivationRequestToken?: unknown; activationRequestToken?: unknown; requestToken?: unknown },
  rootPath: string,
): MissionControlInternalSendActivationRequestRecord {
  const requestToken = optionalPreview(input.internalSendActivationRequestToken ?? input.activationRequestToken ?? input.requestToken, 340);
  if (!requestToken) {
    throw Object.assign(new Error("Mission Control internal-send activation request token is required."), {
      code: "mission_control_internal_send_activation_request_token_required",
    });
  }
  const record = readInternalSendActivationRequestRecords(rootPath).find((candidate) => {
    return buildInternalSendActivationRequestActionToken(candidate.id) === requestToken;
  });
  if (!record) {
    throw Object.assign(new Error("Mission Control internal-send activation request was not found."), {
      code: "mission_control_internal_send_activation_request_not_found",
    });
  }
  return record;
}

function resolveInternalSendActivationDecisionAudit(
  input: { internalSendActivationDecisionAuditToken?: unknown; activationDecisionAuditToken?: unknown; decisionAuditToken?: unknown; auditToken?: unknown },
  rootPath: string,
): MissionControlInternalSendActivationDecisionAuditRecord {
  const auditToken = optionalPreview(input.internalSendActivationDecisionAuditToken ?? input.activationDecisionAuditToken ?? input.decisionAuditToken ?? input.auditToken, 360);
  if (!auditToken) {
    throw Object.assign(new Error("Mission Control internal-send activation decision audit token is required."), {
      code: "mission_control_internal_send_activation_decision_audit_token_required",
    });
  }
  const record = readInternalSendActivationDecisionAuditRecords(rootPath).find((candidate) => {
    return buildInternalSendActivationDecisionAuditActionToken(candidate.id) === auditToken;
  });
  if (!record) {
    throw Object.assign(new Error("Mission Control internal-send activation decision audit was not found."), {
      code: "mission_control_internal_send_activation_decision_audit_not_found",
    });
  }
  return record;
}

function resolveInternalSendActivationImplementationReadiness(
  input: { internalSendActivationImplementationReadinessToken?: unknown; activationImplementationReadinessToken?: unknown; implementationReadinessToken?: unknown; readinessToken?: unknown },
  rootPath: string,
): MissionControlInternalSendActivationImplementationReadinessRecord {
  const readinessToken = optionalPreview(input.internalSendActivationImplementationReadinessToken ?? input.activationImplementationReadinessToken ?? input.implementationReadinessToken ?? input.readinessToken, 380);
  if (!readinessToken) {
    throw Object.assign(new Error("Mission Control internal-send activation implementation readiness token is required."), {
      code: "mission_control_internal_send_activation_implementation_readiness_token_required",
    });
  }
  const record = readInternalSendActivationImplementationReadinessRecords(rootPath).find((candidate) => {
    return buildInternalSendActivationImplementationReadinessActionToken(candidate.id) === readinessToken;
  });
  if (!record) {
    throw Object.assign(new Error("Mission Control internal-send activation implementation readiness was not found."), {
      code: "mission_control_internal_send_activation_implementation_readiness_not_found",
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
    missionAnswerPreview: recommendation.missionAnswerPreview,
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

function activationRequestPreviewFromActivationDesign(
  design: MissionControlInternalSendActivationDesignRecord,
): MissionControlInternalSendActivationRequestRecord {
  const bodySha256 = sha256Text(design.content);
  if (bodySha256 !== design.bodySha256) {
    throw Object.assign(new Error("Mission Control activation-design checksum does not match the activation-request source."), {
      code: "mission_control_internal_send_activation_request_checksum_mismatch",
    });
  }
  const id = `mission-send-activation-request-${crypto.createHash("sha256")
    .update(`mira.mission_control_internal_send_activation_request_preview.v0:${design.id}`)
    .digest("hex")
    .slice(0, 24)}`;

  return {
    protocol: "mira.mission_control_internal_send_activation_request_preview.v0",
    id,
    status: "activation_request_review_only",
    createdAt: new Date().toISOString(),
    sourceInternalSendActivationDesignId: design.id,
    sourceInternalSendActivationDesignToken: buildInternalSendActivationDesignActionToken(design.id),
    sourceInternalSendDryRunId: design.sourceInternalSendDryRunId,
    sourceInternalSendDryRunToken: design.sourceInternalSendDryRunToken,
    sourceDispatchReadinessId: design.sourceDispatchReadinessId,
    sourceDispatchReadinessToken: design.sourceDispatchReadinessToken,
    sourceDeliveryPreviewId: design.sourceDeliveryPreviewId,
    sourceDeliveryPreviewToken: design.sourceDeliveryPreviewToken,
    sourceRecommendationId: design.sourceRecommendationId,
    sourceContinuationId: design.sourceContinuationId,
    sourceRequestId: design.sourceRequestId,
    sourcePreviewId: design.sourcePreviewId,
    targetRole: design.targetRole,
    targetPaneId: design.targetPaneId,
    targetLabel: design.targetLabel,
    purpose: design.purpose,
    content: design.content,
    contentPreview: design.contentPreview,
    bodySha256,
    adapterPacketSha256: design.adapterPacketSha256,
    reviewer: {
      required: true,
      status: "pending_review",
      reviewerRole: "architect_or_oracle",
      note: "A reviewer must accept the request preview before any separate live activation lane.",
    },
    activationRequest: {
      protocol: "mira.mission_control_internal_send_activation_request_gate.v0",
      previewOnly: true,
      activationAllowed: false,
      requiredReview: "separate_reviewed_activation",
      reviewerRequired: true,
      refusalRollbackAuditRequired: true,
      liveHmSendExecutionAllowed: false,
      realSendAllowed: false,
    },
    refusalPolicy: [
      {
        id: "activation_design_token_required",
        label: "Missing or unknown activation-design tokens must return 400 without writing.",
        ok: true,
      },
      {
        id: "activation_design_checksum_required",
        label: "Activation-design body checksum must match before a request preview is written.",
        ok: true,
      },
      {
        id: "separate_activation_required",
        label: "This request preview cannot perform live hm-send; real send remains a later reviewed activation gate.",
        ok: true,
      },
    ],
    rollbackPlan: [
      {
        id: "rollback_path_required",
        label: "A later activation must define rollback/failure handling before execution is allowed.",
        ok: true,
      },
      {
        id: "activation_design_checksum_required",
        label: "The activation design token, body checksum, and adapter checksum must be preserved for rollback review.",
        ok: true,
      },
    ],
    auditPlan: [
      {
        id: "reviewer_required",
        label: "A reviewer field is required before any activation request can leave preview mode.",
        ok: true,
      },
      {
        id: "audit_path_required",
        label: "A later activation must record reviewer, refusal, rollback, transport outcome, and no-route-flip evidence.",
        ok: true,
      },
    ],
    audit: {
      reviewStatus: "activation_request_preview_ready",
      previewOnly: true,
      manualExecutionRequired: true,
      realSendRequiresSeparateActivation: true,
      sourceActivationDesignChecksumMatched: true,
      reviewerRequired: true,
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

function activationDecisionAuditFromActivationRequest(
  request: MissionControlInternalSendActivationRequestRecord,
): MissionControlInternalSendActivationDecisionAuditRecord {
  const bodySha256 = sha256Text(request.content);
  if (bodySha256 !== request.bodySha256) {
    throw Object.assign(new Error("Mission Control activation-request checksum does not match the decision-audit source."), {
      code: "mission_control_internal_send_activation_decision_audit_checksum_mismatch",
    });
  }
  const id = `mission-send-activation-audit-${crypto.createHash("sha256")
    .update(`mira.mission_control_internal_send_activation_decision_audit.v0:${request.id}`)
    .digest("hex")
    .slice(0, 24)}`;

  return {
    protocol: "mira.mission_control_internal_send_activation_decision_audit.v0",
    id,
    status: "activation_decision_audit_review_only",
    createdAt: new Date().toISOString(),
    sourceInternalSendActivationRequestId: request.id,
    sourceInternalSendActivationRequestToken: buildInternalSendActivationRequestActionToken(request.id),
    sourceInternalSendActivationDesignId: request.sourceInternalSendActivationDesignId,
    sourceInternalSendActivationDesignToken: request.sourceInternalSendActivationDesignToken,
    sourceInternalSendDryRunId: request.sourceInternalSendDryRunId,
    sourceInternalSendDryRunToken: request.sourceInternalSendDryRunToken,
    sourceDispatchReadinessId: request.sourceDispatchReadinessId,
    sourceDispatchReadinessToken: request.sourceDispatchReadinessToken,
    sourceDeliveryPreviewId: request.sourceDeliveryPreviewId,
    sourceDeliveryPreviewToken: request.sourceDeliveryPreviewToken,
    sourceRecommendationId: request.sourceRecommendationId,
    sourceContinuationId: request.sourceContinuationId,
    sourceRequestId: request.sourceRequestId,
    sourcePreviewId: request.sourcePreviewId,
    targetRole: request.targetRole,
    targetPaneId: request.targetPaneId,
    targetLabel: request.targetLabel,
    purpose: request.purpose,
    content: request.content,
    contentPreview: request.contentPreview,
    bodySha256,
    adapterPacketSha256: request.adapterPacketSha256,
    reviewer: {
      required: true,
      status: "pending_review",
      reviewerRole: "architect_or_oracle",
    },
    decision: {
      protocol: "mira.mission_control_internal_send_activation_decision.v0",
      reviewOnly: true,
      decision: "refuse_live_activation_until_separate_gate",
      activationAllowed: false,
      liveHmSendExecutionAllowed: false,
      realSendAllowed: false,
      separateActivationRequired: true,
    },
    refusal: {
      status: "refused_for_live_execution",
      reason: "No live hm-send execution is allowed from this review-only audit artifact.",
      liveEffectBlocked: true,
    },
    rollbackAudit: {
      status: "rollback_audit_previewed",
      requiresPreActivationSnapshot: true,
      requiresFailureAudit: true,
      requiresTransportOutcomeAudit: true,
    },
    auditRequirements: [
      {
        id: "activation_request_token_required",
        label: "Missing or unknown activation-request tokens must return 400 without writing.",
        ok: true,
      },
      {
        id: "activation_request_checksum_required",
        label: "Activation-request body checksum must match before a decision audit is written.",
        ok: true,
      },
      {
        id: "review_decision_recorded",
        label: "The review-only decision is recorded without allowing activation.",
        ok: true,
      },
      {
        id: "refusal_recorded",
        label: "Live execution refusal is recorded before any future activation gate.",
        ok: true,
      },
      {
        id: "rollback_audit_recorded",
        label: "Rollback and failure-audit requirements are recorded before any future activation gate.",
        ok: true,
      },
      {
        id: "separate_activation_required",
        label: "Real hm-send activation remains a later separately reviewed gate.",
        ok: true,
      },
    ],
    audit: {
      reviewStatus: "activation_decision_audit_ready",
      reviewOnly: true,
      manualExecutionRequired: true,
      sourceActivationRequestChecksumMatched: true,
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

function activationImplementationReadinessFromDecisionAudit(
  audit: MissionControlInternalSendActivationDecisionAuditRecord,
): MissionControlInternalSendActivationImplementationReadinessRecord {
  const bodySha256 = sha256Text(audit.content);
  if (bodySha256 !== audit.bodySha256) {
    throw Object.assign(new Error("Mission Control activation decision audit checksum does not match the implementation-readiness source."), {
      code: "mission_control_internal_send_activation_implementation_readiness_checksum_mismatch",
    });
  }
  if (
    audit.decision?.activationAllowed !== false
    || audit.decision?.liveHmSendExecutionAllowed !== false
    || audit.decision?.decision !== "refuse_live_activation_until_separate_gate"
    || audit.refusal?.liveEffectBlocked !== true
  ) {
    throw Object.assign(new Error("Mission Control activation implementation readiness requires a refused decision audit source."), {
      code: "mission_control_internal_send_activation_implementation_readiness_source_not_refused",
    });
  }
  const id = `mission-send-activation-implementation-${crypto.createHash("sha256")
    .update(`mira.mission_control_internal_send_activation_implementation_readiness.v0:${audit.id}`)
    .digest("hex")
    .slice(0, 24)}`;

  return {
    protocol: "mira.mission_control_internal_send_activation_implementation_readiness.v0",
    id,
    status: "activation_implementation_readiness_review_only",
    createdAt: new Date().toISOString(),
    sourceInternalSendActivationDecisionAuditId: audit.id,
    sourceInternalSendActivationDecisionAuditToken: buildInternalSendActivationDecisionAuditActionToken(audit.id),
    sourceInternalSendActivationRequestId: audit.sourceInternalSendActivationRequestId,
    sourceInternalSendActivationRequestToken: audit.sourceInternalSendActivationRequestToken,
    sourceInternalSendActivationDesignId: audit.sourceInternalSendActivationDesignId,
    sourceInternalSendActivationDesignToken: audit.sourceInternalSendActivationDesignToken,
    sourceInternalSendDryRunId: audit.sourceInternalSendDryRunId,
    sourceInternalSendDryRunToken: audit.sourceInternalSendDryRunToken,
    sourceDispatchReadinessId: audit.sourceDispatchReadinessId,
    sourceDispatchReadinessToken: audit.sourceDispatchReadinessToken,
    sourceDeliveryPreviewId: audit.sourceDeliveryPreviewId,
    sourceDeliveryPreviewToken: audit.sourceDeliveryPreviewToken,
    sourceRecommendationId: audit.sourceRecommendationId,
    sourceContinuationId: audit.sourceContinuationId,
    sourceRequestId: audit.sourceRequestId,
    sourcePreviewId: audit.sourcePreviewId,
    targetRole: audit.targetRole,
    targetPaneId: audit.targetPaneId,
    targetLabel: audit.targetLabel,
    purpose: audit.purpose,
    content: audit.content,
    contentPreview: audit.contentPreview,
    bodySha256,
    adapterPacketSha256: audit.adapterPacketSha256,
    implementationGate: {
      protocol: "mira.mission_control_internal_send_activation_implementation_gate.v0",
      readinessOnly: true,
      disabledByDefault: true,
      implementationEnabled: false,
      activationAllowed: false,
      liveHmSendExecutionAllowed: false,
      realSendAllowed: false,
      separateActivationRequired: true,
    },
    refusal: {
      status: "live_activation_still_refused",
      sourceDecision: audit.decision.decision,
      reason: "Implementation readiness is review-only and remains disabled until a separate activation implementation gate exists.",
    },
    rollback: {
      status: "rollback_requirements_ready",
      preActivationSnapshotRequired: audit.rollbackAudit.requiresPreActivationSnapshot,
      failureAuditRequired: audit.rollbackAudit.requiresFailureAudit,
      transportOutcomeAuditRequired: audit.rollbackAudit.requiresTransportOutcomeAudit,
    },
    auditRequirements: [
      {
        id: "decision_audit_token_required",
        label: "Missing or unknown decision-audit tokens must return 400 without writing.",
        ok: true,
      },
      {
        id: "decision_audit_checksum_required",
        label: "Decision-audit body checksum must match before implementation readiness is written.",
        ok: true,
      },
      {
        id: "decision_refusal_required",
        label: "Source decision must refuse live activation before implementation readiness can be recorded.",
        ok: true,
      },
      {
        id: "disabled_by_default_required",
        label: "Activation implementation stays disabled by default.",
        ok: true,
      },
      {
        id: "rollback_audit_required",
        label: "Rollback and failure-audit requirements remain required before any future activation.",
        ok: true,
      },
      {
        id: "separate_activation_required",
        label: "Real hm-send activation remains its own later reviewed gate.",
        ok: true,
      },
    ],
    audit: {
      reviewStatus: "activation_implementation_readiness_ready",
      readinessOnly: true,
      disabledByDefault: true,
      implementationEnabled: false,
      manualExecutionRequired: true,
      sourceDecisionAuditChecksumMatched: true,
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

function liveActivationGateContractFromImplementationReadiness(
  readiness: MissionControlInternalSendActivationImplementationReadinessRecord,
): MissionControlInternalSendLiveActivationGateContractRecord {
  const bodySha256 = sha256Text(readiness.content);
  if (bodySha256 !== readiness.bodySha256) {
    throw Object.assign(new Error("Mission Control activation implementation readiness checksum does not match the live-activation gate source."), {
      code: "mission_control_internal_send_live_activation_gate_contract_checksum_mismatch",
    });
  }
  if (
    readiness.implementationGate?.implementationEnabled !== false
    || readiness.implementationGate?.activationAllowed !== false
    || readiness.implementationGate?.liveHmSendExecutionAllowed !== false
  ) {
    throw Object.assign(new Error("Mission Control live activation gate contract requires a disabled implementation-readiness source."), {
      code: "mission_control_internal_send_live_activation_gate_contract_source_not_disabled",
    });
  }
  const id = `mission-send-live-gate-${crypto.createHash("sha256")
    .update(`mira.mission_control_internal_send_live_activation_gate_contract.v0:${readiness.id}`)
    .digest("hex")
    .slice(0, 24)}`;

  return {
    protocol: "mira.mission_control_internal_send_live_activation_gate_contract.v0",
    id,
    status: "live_activation_gate_hard_stop",
    createdAt: new Date().toISOString(),
    sourceInternalSendActivationImplementationReadinessId: readiness.id,
    sourceInternalSendActivationImplementationReadinessToken: buildInternalSendActivationImplementationReadinessActionToken(readiness.id),
    sourceInternalSendActivationDecisionAuditId: readiness.sourceInternalSendActivationDecisionAuditId,
    sourceInternalSendActivationDecisionAuditToken: readiness.sourceInternalSendActivationDecisionAuditToken,
    sourceInternalSendActivationRequestId: readiness.sourceInternalSendActivationRequestId,
    sourceInternalSendActivationRequestToken: readiness.sourceInternalSendActivationRequestToken,
    sourceInternalSendActivationDesignId: readiness.sourceInternalSendActivationDesignId,
    sourceInternalSendActivationDesignToken: readiness.sourceInternalSendActivationDesignToken,
    sourceInternalSendDryRunId: readiness.sourceInternalSendDryRunId,
    sourceInternalSendDryRunToken: readiness.sourceInternalSendDryRunToken,
    sourceDispatchReadinessId: readiness.sourceDispatchReadinessId,
    sourceDispatchReadinessToken: readiness.sourceDispatchReadinessToken,
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
    content: readiness.content,
    contentPreview: readiness.contentPreview,
    bodySha256,
    adapterPacketSha256: readiness.adapterPacketSha256,
    hardStop: {
      protocol: "mira.mission_control_internal_send_live_activation_hard_stop.v0",
      contractOnly: true,
      liveActivationAllowed: false,
      liveHmSendExecutionAllowed: false,
      realSendAllowed: false,
      implementationEnabled: false,
      separateActivationLaneRequired: true,
      jamesSetupRequiredBeforeLiveSend: true,
    },
    jamesRequirements: [
      {
        id: "james_explicit_request_required",
        label: "James must explicitly request a later live internal-send activation for this exact target and body.",
        ok: true,
      },
      {
        id: "target_pane_confirmation_required",
        label: `James-visible setup must confirm ${readiness.targetLabel} is the intended live pane target.`,
        ok: true,
      },
      {
        id: "separate_activation_lane_required",
        label: "A later activation lane must be reviewed separately before any live hm-send execution exists.",
        ok: true,
      },
    ],
    setupRequirements: [
      {
        id: "implementation_readiness_token_required",
        label: "Missing or unknown implementation-readiness tokens must return 400 without writing.",
        ok: true,
      },
      {
        id: "implementation_readiness_checksum_required",
        label: "Implementation-readiness body checksum must match before a live gate contract is written.",
        ok: true,
      },
      {
        id: "transport_dry_run_replay_required",
        label: "A later activation lane must replay the dry-run envelope and compare target/body checksums before execution.",
        ok: true,
      },
    ],
    rollbackRequirements: [
      {
        id: "rollback_and_audit_review_required",
        label: "Rollback and transport-outcome audit review must be accepted in a later lane before execution.",
        ok: true,
      },
    ],
    audit: {
      reviewStatus: "live_activation_gate_contract_ready",
      contractOnly: true,
      hardStop: true,
      manualExecutionRequired: true,
      sourceImplementationReadinessChecksumMatched: true,
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

export function createMissionControlInternalSendActivationRequest(
  input: { internalSendActivationDesignToken?: unknown; activationDesignToken?: unknown; designToken?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlInternalSendActivationRequestWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control internal-send activation request previews can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectInternalSendActivationRequestInput(input);
  const design = resolveInternalSendActivationDesign(input, rootPath);
  const dir = internalSendActivationRequestsDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control internal-send activation request destination escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_activation_request_path",
    });
  }

  const record = activationRequestPreviewFromActivationDesign(design);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control internal-send activation request file escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_activation_request_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseInternalSendActivationRequestRecord(fs.readFileSync(absolutePath, "utf8"));
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
    protocol: "mira.mission_control_internal_send_activation_request_preview_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    request: toPublicInternalSendActivationRequest(stored),
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

export function createMissionControlInternalSendActivationDecisionAudit(
  input: { internalSendActivationRequestToken?: unknown; activationRequestToken?: unknown; requestToken?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlInternalSendActivationDecisionAuditWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control internal-send activation decision audits can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectInternalSendActivationDecisionAuditInput(input);
  const request = resolveInternalSendActivationRequest(input, rootPath);
  const dir = internalSendActivationDecisionAuditsDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control internal-send activation decision audit destination escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_activation_decision_audit_path",
    });
  }

  const record = activationDecisionAuditFromActivationRequest(request);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control internal-send activation decision audit file escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_activation_decision_audit_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseInternalSendActivationDecisionAuditRecord(fs.readFileSync(absolutePath, "utf8"));
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
    protocol: "mira.mission_control_internal_send_activation_decision_audit_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    audit: toPublicInternalSendActivationDecisionAudit(stored),
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

export function createMissionControlInternalSendActivationImplementationReadiness(
  input: { internalSendActivationDecisionAuditToken?: unknown; activationDecisionAuditToken?: unknown; decisionAuditToken?: unknown; auditToken?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlInternalSendActivationImplementationReadinessWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control internal-send activation implementation readiness can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectInternalSendActivationImplementationReadinessInput(input);
  const audit = resolveInternalSendActivationDecisionAudit(input, rootPath);
  const dir = internalSendActivationImplementationReadinessDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control internal-send activation implementation readiness destination escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_activation_implementation_readiness_path",
    });
  }

  const record = activationImplementationReadinessFromDecisionAudit(audit);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control internal-send activation implementation readiness file escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_activation_implementation_readiness_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseInternalSendActivationImplementationReadinessRecord(fs.readFileSync(absolutePath, "utf8"));
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
    protocol: "mira.mission_control_internal_send_activation_implementation_readiness_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    readiness: toPublicInternalSendActivationImplementationReadiness(stored),
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

export function createMissionControlInternalSendLiveActivationGateContract(
  input: { internalSendActivationImplementationReadinessToken?: unknown; activationImplementationReadinessToken?: unknown; implementationReadinessToken?: unknown; readinessToken?: unknown } & JsonObject,
  env: NodeJS.ProcessEnv = process.env,
): MissionControlInternalSendLiveActivationGateContractWriteResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before Mission Control internal-send live activation gate contracts can be saved."), {
      code: "state_root_not_ready",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  rejectInternalSendLiveActivationGateContractInput(input);
  const readiness = resolveInternalSendActivationImplementationReadiness(input, rootPath);
  const dir = internalSendLiveActivationGateContractsDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Mission Control internal-send live activation gate contract destination escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_live_activation_gate_contract_path",
    });
  }

  const record = liveActivationGateContractFromImplementationReadiness(readiness);
  const absolutePath = path.resolve(dir, `${record.id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Mission Control internal-send live activation gate contract file escaped Mira state root."), {
      code: "unsafe_mission_control_internal_send_live_activation_gate_contract_path",
    });
  }

  fs.mkdirSync(dir, { recursive: true });
  let created = false;
  let stored = record;
  if (fs.existsSync(absolutePath)) {
    const parsed = parseInternalSendLiveActivationGateContractRecord(fs.readFileSync(absolutePath, "utf8"));
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
    protocol: "mira.mission_control_internal_send_live_activation_gate_contract_write.v0",
    created,
    stateRootPath: rootPath,
    relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
    absolutePath,
    contract: toPublicInternalSendLiveActivationGateContract(stored),
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

export function listMissionControlInternalSendActivationRequests(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlInternalSendActivationRequestListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_internal_send_activation_request_preview_list.v0",
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
  const requests = readInternalSendActivationRequestRecords(rootPath).map((record) => {
    const publicRecord = toPublicInternalSendActivationRequest(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(internalSendActivationRequestsDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_internal_send_activation_request_preview_list.v0",
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

export function listMissionControlInternalSendActivationDecisionAudits(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlInternalSendActivationDecisionAuditListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_internal_send_activation_decision_audit_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      auditCount: 0,
      audits: [],
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
  const audits = readInternalSendActivationDecisionAuditRecords(rootPath).map((record) => {
    const publicRecord = toPublicInternalSendActivationDecisionAudit(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(internalSendActivationDecisionAuditsDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_internal_send_activation_decision_audit_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    auditCount: audits.length,
    audits,
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

export function listMissionControlInternalSendActivationImplementationReadiness(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlInternalSendActivationImplementationReadinessListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_internal_send_activation_implementation_readiness_list.v0",
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
  const readiness = readInternalSendActivationImplementationReadinessRecords(rootPath).map((record) => {
    const publicRecord = toPublicInternalSendActivationImplementationReadiness(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(internalSendActivationImplementationReadinessDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_internal_send_activation_implementation_readiness_list.v0",
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

export function listMissionControlInternalSendLiveActivationGateContracts(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlInternalSendLiveActivationGateContractListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.mission_control_internal_send_live_activation_gate_contract_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      contractCount: 0,
      contracts: [],
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
  const contracts = readInternalSendLiveActivationGateContractRecords(rootPath).map((record) => {
    const publicRecord = toPublicInternalSendLiveActivationGateContract(record);
    if (!options.includeInternal) return publicRecord;
    const absolutePath = path.resolve(internalSendLiveActivationGateContractsDir(rootPath), `${record.id}.json`);
    return {
      ...publicRecord,
      relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
      absolutePath,
    };
  });

  return {
    ok: true,
    protocol: "mira.mission_control_internal_send_live_activation_gate_contract_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    contractCount: contracts.length,
    contracts,
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

export function getMissionControlActivationPipelineStatus(
  env: NodeJS.ProcessEnv = process.env,
  options: { includeInternal?: boolean } = {},
): MissionControlActivationPipelineStatusResult {
  const stateRoot = getStateRootReadiness(env);
  const rootPath = stateRoot.ready && stateRoot.path ? path.resolve(stateRoot.path) : null;
  const stages = buildActivationPipelineStages(rootPath);
  const currentStage = [...stages].reverse().find((stage) => stage.status !== "missing") || null;
  const lastSavedArtifact = [...stages].reverse().find((stage) => stage.status === "saved") || null;
  const liveGateStage = stages.find((stage) => stage.id === "live_activation_gate_contract") || null;
  const hardStop = liveGateStage?.hardStop || null;
  const currentStageTrace = buildActivationPipelineTrace(stages, currentStage);
  const advanceSelection = buildActivationPipelineAdvanceSelection(stages);
  const manualActionPreflight = buildActivationPipelineManualActionPreflight(advanceSelection);
  const payloadPreview = buildActivationPipelinePayloadPreview(manualActionPreflight);
  const hardStopTruth = {
    liveSendAvailable: false,
    liveActivationAllowed: false,
    liveHmSendExecutionAllowed: false,
    realSendAllowed: false,
    implementationEnabled: false,
    hardStopContractRecorded: liveGateStage?.status === "saved" && Boolean(hardStop),
    separateActivationLaneRequired: true,
    jamesSetupRequiredBeforeLiveSend: true,
  } as const;
  const nextBoundary = {
    label: "Live send is not available from this surface.",
    currentNextStep: currentPipelineNextStep(currentStage?.id || null),
    futureJamesVisibleGate: "Future real send would require a separate James-visible setup/activation lane.",
    liveSendAvailable: false,
    separateActivationLaneRequired: true,
  } as const;
  const endToEndReadout = buildActivationPipelineEndToEndReadout(
    stages,
    currentStage,
    hardStopTruth,
    nextBoundary,
    manualActionPreflight,
  );

  return {
    ok: true,
    protocol: "mira.mission_control_activation_pipeline_status.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    currentStage,
    currentStageId: currentStage?.id || null,
    currentStageLabel: currentStage?.label || "No Mission Control send chain yet",
    lastSavedArtifact,
    stageCount: stages.length,
    stages,
    currentStageTrace,
    advanceSelection,
    manualActionPreflight,
    payloadPreview,
    endToEndReadout,
    hardStopTruth,
    nextBoundary,
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
