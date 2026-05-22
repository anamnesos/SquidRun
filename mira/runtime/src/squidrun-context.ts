import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { planManualBridgeRequest, type ManualBridgeRequestPlan } from "./bridge-request-plan.js";

type JsonObject = Record<string, unknown>;
const internalPaneActivationSeamCommitHash = "7ff9fe8d";
const continuationSelectorCommitHash = "6092a28a";
const v1RoutePreviewAlignmentCommitHash = "e82f1a54";
const commsEvidenceWindowCommitHash = "4bfe771c";
const directChannelReadinessContractCommitHash = "22e876dc";
const toolAppActionPlanProofCommitHash = "5b3e0386";
const continuityMemoryBoundaryCommitHash = "bf82cea4";
const continuityMemoryProofCommitHash = "d0bffd58";
const cleanContextSelectionCommitHash = "13c90817";
const demoWorkbenchProofCommitHash = "48e419b4";
const workbenchSurfaceProofCommitHash = "c301c1ac";
const commandCardSurfaceCommitHash = "5d119dc6";
const commandCardFollowThroughCommitHash = "df0a47a6";
const commandCardRoutePlanProofSurfaceCommitHash = "120806b4";
const internalRoutePlanningCommitHash = "0cb27b6b";
const internalRoutePromotionPlanSurfaceCommitHash = "f7352d10";
const internalRouteAuditPlanningCommitHash = "c1a05e07";
const postAuditPlanningSelectorCommitHash = "582ef1c6";
const internalRouteAuditReviewLaneProofCommitHash = "b1acd4d7";
const jamesActionLineDedupCommitHash = "2533ace2";
const internalRoutePromotionDecisionGateCommitHash = "cbeb0d2f";
const internalRoutePromotionDecisionGateSurfaceCommitHash = "5fc2cd90";
const commsHistoryEvidenceLimit = 1000;

export type SquidRunProjectContext = {
  ok: true;
  protocol: "mira.squidrun_context.v0";
  source: "local_squidrun_files";
  project: {
    name: string;
    workspace: string | null;
    squidrunRoot: string;
    sessionId: string | null;
  };
  lane: {
    loaded: boolean;
    status: string | null;
    sourceRef: string | null;
    sourceTimestampMs: number | null;
    targetRole: string | null;
    objective: string | null;
    nextAction: string | null;
    generatedAt: string | null;
    staleHandoff: {
      status: "stale_superseded";
      sourceRef: string;
      sourceTimestampMs: number | null;
      objective: string | null;
      supersededBySourceRef: string;
      supersededByCommit: string;
      reason: string;
    } | null;
  };
  ownedWork: {
    loaded: boolean;
    active: Array<{
      agent: string;
      taskId: string | null;
      title: string | null;
      nextStep: string | null;
    }>;
    pendingCount: number;
  };
  git: {
    loaded: boolean;
    branch: string | null;
    dirtyCount: number;
    shortStat: string | null;
    statusPreview: string[];
  };
  dirtyWork: {
    loaded: boolean;
    summary: string;
    files: string[];
  };
  systemMap: {
    loaded: boolean;
    relativePath: "docs/mira-system-map.md";
    truth: string | null;
    nextGate: string | null;
  };
  roadmap: {
    loaded: boolean;
    relativePath: "docs/mira-north-star-roadmap.md";
    hardTruth: string | null;
    firstDemo: string | null;
    stopPivot: string | null;
  };
  recentComms: {
    loaded: boolean;
    latestBuilderInstruction: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
    } | null;
    latestCommitCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestBuilderAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestContinuationDelegation: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash?: string | null;
    } | null;
    latestContinuationSelectorCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestV1AlignmentDelegation: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestV1AlignmentCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestEvidenceWindowCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestDirectChannelReadinessCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestDirectChannelReadinessAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestToolAppActionPlanCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestToolAppActionPlanAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestContinuityMemoryBoundaryCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestContinuityMemoryBoundaryAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestContinuityMemoryProofCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestContinuityMemoryProofAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestContinuityMemoryProofOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestCleanContextSelectionCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestCleanContextSelectionOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestDemoWorkbenchProofCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestDemoWorkbenchProofOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestWorkbenchSurfaceProofCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestWorkbenchSurfaceProofOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestCommandCardSurfaceCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestCommandCardSurfaceOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestCommandCardFollowThroughCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestCommandCardFollowThroughOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestCommandCardRoutePlanProofSurfaceCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestCommandCardRoutePlanProofSurfaceOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRoutePlanningCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRoutePlanningOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRoutePromotionPlanSurfaceCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRoutePromotionPlanSurfaceOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRouteAuditPlanningCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRouteAuditPlanningBuilderAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRouteAuditPlanningOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestPostAuditPlanningSelectorCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestPostAuditPlanningSelectorBuilderAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestPostAuditPlanningSelectorOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRouteAuditReviewLaneProofCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRouteAuditReviewLaneProofOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestJamesActionLineDedupCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestJamesActionLineDedupOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRoutePromotionDecisionGateCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRoutePromotionDecisionGateOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRoutePromotionDecisionGateSurfaceCheckpoint: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    latestInternalRoutePromotionDecisionGateSurfaceOracleAck: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
      commitHash: string | null;
    } | null;
    oracleBenchmark: {
      sourceRef: string | null;
      excerpt: string | null;
      timestampMs: number | null;
    } | null;
  };
  missionControl: {
    question: "what is happening here, and what happens next?";
    foundationVsProduct: string;
    answer: string;
    nextTeamMove: string;
    jamesAction: "NONE" | "DO THIS";
    jamesActionReason: string;
    coordinationDrafts: Array<{
      target: "architect" | "builder" | "oracle";
      purpose: string;
      message: string;
    }>;
    toolAppActionPlan: null | {
      id: "mission-control-tool-app-action-plan-v0";
      status: "planning_only";
      owner: "Builder";
      target: {
        actionCategory: "local_squidrun_evidence_review";
        action: string;
      };
      sourceEvidence: Array<{
        kind: "file" | "comms" | "summary";
        path?: string;
        sourceRef?: string;
        commitHash?: string;
        summary: string;
      }>;
      jamesControlPoint: string;
      preconditions: string[];
      refusalNoGoConditions: string[];
      audit: {
        planningOnly: true;
        executed: false;
        browsed: false;
        appToolCalled: false;
        posted: false;
        routed: false;
        sent: false;
        runtimeStarted: false;
        credentialAccessed: false;
        deployed: false;
        moneyMovement: false;
      };
    };
    continuityMemoryProof: null | {
      id: "mission-control-continuity-memory-proof-v0";
      status: "proof_only";
      owner: "Builder";
      sourceEvidence: Array<{
        kind: "file" | "test" | "comms" | "summary";
        path?: string;
        sourceRef?: string;
        commitHash?: string;
        summary: string;
      }>;
      currentLaneTruth: {
        sourcePath: ".squidrun/handoffs/current-lane.json";
        loaded: boolean;
        sourceRef: string | null;
        objective: string | null;
        nextAction: string | null;
        generatedAt: string | null;
        authority: "loaded_but_stale_superseded";
      };
      staleOnlySummaryRefusal: {
        refused: true;
        staleSourceRef: string | null;
        staleObjective: string | null;
        reason: string;
      };
      jamesControlPoint: string;
      preconditions: string[];
      refusalNoGoConditions: string[];
      audit: {
        proofOnly: true;
        planningOnly: true;
        imported: false;
        copied: false;
        wrote: false;
        restarted: false;
        processStarted: false;
        browsed: false;
        appToolCalled: false;
        sent: false;
        routed: false;
        posted: false;
        runtimeStarted: false;
        providerInvoked: false;
        modelInvoked: false;
        accountAccessed: false;
        tokenAccessed: false;
        credentialAccessed: false;
        deviceTouched: false;
        userTargeted: false;
        externalTargeted: false;
        deployed: false;
        moneyMovement: false;
        tradingTouched: false;
      };
    };
    demoWorkbenchProof: null | {
      id: "mission-control-demo-workbench-proof-v0";
      status: "proof_planning_only";
      owner: "Builder";
      target: {
        surface: "local_mission_control_answer_surface";
        question: "what is happening here, and what should happen next?";
        action: string;
      };
      sourceEvidence: Array<{
        kind: "file" | "comms" | "summary" | "completed_context";
        path?: string;
        sourceRef?: string;
        commitHash?: string;
        summary: string;
      }>;
      completedContext: {
        toolAppActionPlanId: "mission-control-tool-app-action-plan-v0";
        continuityMemoryProofId: "mission-control-continuity-memory-proof-v0";
      };
      expectedJamesVisibleChecks: string[];
      jamesControlPoint: string;
      preconditions: string[];
      refusalNoGoConditions: string[];
      audit: {
        proofOnly: true;
        planningOnly: true;
        runtimeStarted: false;
        browserOpened: false;
        workbenchOpened: false;
        uiActionPerformed: false;
        fetched: false;
        posted: false;
        routed: false;
        sent: false;
        providerInvoked: false;
        modelInvoked: false;
        accountAccessed: false;
        tokenAccessed: false;
        credentialAccessed: false;
        deviceTouched: false;
        userTargeted: false;
        externalTargeted: false;
        deployed: false;
        moneyMovement: false;
        tradingTouched: false;
      };
    };
    commandCardAcceptance: null | {
      id: "mission-control-v0-command-card-acceptance";
      status: "acceptance_planning_only";
      owner: "Builder";
      sourceEvidence: Array<{
        kind: "file" | "comms" | "completed_context" | "summary";
        path?: string;
        sourceRef?: string;
        commitHash?: string;
        summary: string;
      }>;
      completedContext: {
        toolAppActionPlanId: "mission-control-tool-app-action-plan-v0";
        continuityMemoryProofId: "mission-control-continuity-memory-proof-v0";
        demoWorkbenchProofId: "mission-control-demo-workbench-proof-v0";
      };
      cardFields: {
        currentLaneWhyItMatters: string;
        whatChangedRecently: string;
        builderNextMove: string;
        oracleNextMove: string;
        contextCardStatus: string;
        jamesActionLine: "JAMES ACTION: NONE";
        dryRunRoutePlan: {
          target: "oracle";
          purpose: "command-card no-effect review";
          manualExecutionRequired: true;
          sendPerformed: false;
          summary: string;
        };
      };
      jamesControlPoint: string;
      preconditions: string[];
      refusalNoGoConditions: string[];
      audit: {
        acceptanceOnly: true;
        planningOnly: true;
        runtimeStarted: false;
        browserOpened: false;
        workbenchOpened: false;
        uiActionPerformed: false;
        fetched: false;
        posted: false;
        routed: false;
        sent: false;
        providerInvoked: false;
        modelInvoked: false;
        accountAccessed: false;
        tokenAccessed: false;
        credentialAccessed: false;
        deviceTouched: false;
        userTargeted: false;
        externalTargeted: false;
        deployed: false;
        moneyMovement: false;
        tradingTouched: false;
      };
    };
    commandCardRoutePlanFollowThroughProof: null | {
      id: "mission-control-command-card-route-plan-follow-through-v0";
      status: "proof_ready_for_oracle_review";
      owner: "Builder";
      routePlan: {
        target: "oracle";
        purpose: string;
        message: string;
        body: string;
        manualExecutionRequired: true;
        runtimeExecutes: false;
        sendPerformed: false;
      };
      sourceEvidence: Array<{
        kind: "file" | "comms" | "completed_context" | "summary";
        path?: string;
        sourceRef?: string;
        commitHash?: string;
        summary: string;
      }>;
      completedContext: {
        commandCardAcceptanceId: "mission-control-v0-command-card-acceptance";
      };
      jamesControlPoint: string;
      preconditions: string[];
      refusalNoGoConditions: string[];
      audit: {
        proofOnly: true;
        planningOnly: true;
        runtimeStarted: false;
        browserOpened: false;
        workbenchOpened: false;
        uiActionPerformed: false;
        fetched: false;
        posted: false;
        routed: false;
        sent: false;
        providerInvoked: false;
        modelInvoked: false;
        accountAccessed: false;
        tokenAccessed: false;
        credentialAccessed: false;
        deviceTouched: false;
        userTargeted: false;
        externalTargeted: false;
        deployed: false;
        moneyMovement: false;
        tradingTouched: false;
      };
    };
    internalRoutePromotionReviewPlan: null | {
      id: "mission-control-internal-route-promotion-review-plan-v0";
      status: "planning_only_ready_for_oracle_review";
      owner: "Builder";
      target: {
        role: "oracle";
        purpose: "internal-route promotion no-send review";
        message: string;
        body: string;
        manualExecutionRequired: true;
        runtimeExecutes: false;
        sendPerformed: false;
        promotionPerformed: false;
        routeFlip: false;
      };
      sourceEvidence: Array<{
        kind: "file" | "comms" | "completed_context" | "summary";
        path?: string;
        sourceRef?: string;
        commitHash?: string;
        summary: string;
      }>;
      completedContext: {
        commandCardAcceptanceId: "mission-control-v0-command-card-acceptance";
        commandCardRoutePlanFollowThroughProofId: "mission-control-command-card-route-plan-follow-through-v0";
      };
      jamesControlPoint: string;
      preconditions: string[];
      refusalNoGoConditions: string[];
      audit: {
        planningOnly: true;
        manualOnly: true;
        sendPerformed: false;
        promotionPerformed: false;
        routeFlip: false;
        runtimeExecutes: false;
        runtimeStarted: false;
        browserOpened: false;
        workbenchOpened: false;
        uiActionPerformed: false;
        fetched: false;
        posted: false;
        routed: false;
        sent: false;
        providerInvoked: false;
        modelInvoked: false;
        accountAccessed: false;
        tokenAccessed: false;
        credentialAccessed: false;
        deviceTouched: false;
        userTargeted: false;
        externalTargeted: false;
        deployed: false;
        moneyMovement: false;
        tradingTouched: false;
      };
    };
    internalRouteAuditReviewLaneProof: null | {
      id: "mission-control-internal-route-audit-review-lane-proof-v0";
      status: "planning_only_ready_for_oracle_review";
      owner: "Builder";
      review: {
        target: "oracle";
        purpose: "internal route/audit planning review";
        message: string;
        body: string;
        manualExecutionRequired: true;
        runtimeExecutes: false;
        sendPerformed: false;
        promotionPerformed: false;
        routeFlip: false;
      };
      sourceEvidence: Array<{
        kind: "file" | "comms" | "completed_context" | "summary";
        path?: string;
        sourceRef?: string;
        commitHash?: string;
        summary: string;
      }>;
      completedContext: {
        commandCardAcceptanceId: "mission-control-v0-command-card-acceptance";
        commandCardRoutePlanFollowThroughProofId: "mission-control-command-card-route-plan-follow-through-v0";
        internalRoutePromotionReviewPlanId: "mission-control-internal-route-promotion-review-plan-v0";
      };
      jamesControlPoint: string;
      preconditions: string[];
      refusalNoGoConditions: string[];
      audit: {
        planningOnly: true;
        manualOnly: true;
        sendPerformed: false;
        promotionPerformed: false;
        routeFlip: false;
        runtimeExecutes: false;
        runtimeStarted: false;
        browserOpened: false;
        workbenchOpened: false;
        uiActionPerformed: false;
        fetched: false;
        posted: false;
        routed: false;
        sent: false;
        providerInvoked: false;
        modelInvoked: false;
        accountAccessed: false;
        tokenAccessed: false;
        credentialAccessed: false;
        deviceTouched: false;
        userTargeted: false;
        externalTargeted: false;
        deployed: false;
        moneyMovement: false;
        tradingTouched: false;
      };
    };
    internalRouteAuditPromotionDecisionGateProof: null | {
      id: "mission-control-internal-route-audit-promotion-decision-gate-proof-v0";
      status: "planning_only_ready_for_oracle_review";
      owner: "Builder";
      decisionGate: {
        target: "oracle";
        reviewer: "oracle";
        purpose: "internal route/audit promotion decision-gate review";
        message: string;
        body: string;
        sourceProofId: "mission-control-internal-route-audit-review-lane-proof-v0";
        manualExecutionRequired: true;
        runtimeExecutes: false;
        sendPerformed: false;
        promotionPerformed: false;
        routeFlip: false;
      };
      sourceEvidence: Array<{
        kind: "file" | "comms" | "completed_context" | "summary";
        path?: string;
        sourceRef?: string;
        commitHash?: string;
        summary: string;
      }>;
      completedContext: {
        commandCardAcceptanceId: "mission-control-v0-command-card-acceptance";
        commandCardRoutePlanFollowThroughProofId: "mission-control-command-card-route-plan-follow-through-v0";
        internalRoutePromotionReviewPlanId: "mission-control-internal-route-promotion-review-plan-v0";
        internalRouteAuditReviewLaneProofId: "mission-control-internal-route-audit-review-lane-proof-v0";
      };
      jamesControlPoint: string;
      preconditions: string[];
      refusalNoGoConditions: string[];
      audit: {
        planningOnly: true;
        manualOnly: true;
        sendPerformed: false;
        promotionPerformed: false;
        routeFlip: false;
        runtimeExecutes: false;
        runtimeStarted: false;
        browserOpened: false;
        workbenchOpened: false;
        uiActionPerformed: false;
        fetched: false;
        posted: false;
        routed: false;
        sent: false;
        providerInvoked: false;
        modelInvoked: false;
        accountAccessed: false;
        tokenAccessed: false;
        credentialAccessed: false;
        deviceTouched: false;
        userTargeted: false;
        externalTargeted: false;
        deployed: false;
        moneyMovement: false;
        tradingTouched: false;
      };
    };
    internalRoutePreview: {
      status: "reviewed_preview_only";
      selectedDraftTarget: "architect" | "builder" | "oracle";
      selectedDraftPurpose: string;
      plan: ManualBridgeRequestPlan;
      audit: {
        reviewStatus: "preview_ready";
        sendPerformed: false;
        runtimeExecutes: false;
        externalSend: false;
        routeFlip: false;
        providerInvoked: false;
        note: string;
      };
    };
    evidence: string[];
    continuationDecision: {
      status: "current_handoff" | "stale_handoff_superseded";
      preferredSourceRef: string | null;
      committedSeam: string | null;
      staleSourceRef: string | null;
      staleObjective: string | null;
      reason: string;
    };
  };
  summary: {
    headline: string;
    happening: string;
    nextStep: string;
    toolAppActionPlan: string | null;
    continuityMemoryProof: string | null;
    demoWorkbenchProof: string | null;
    commandCardAcceptance: string | null;
    commandCardRoutePlanFollowThroughProof: string | null;
    internalRoutePromotionReviewPlan: string | null;
    internalRouteAuditReviewLaneProof: string | null;
    internalRouteAuditPromotionDecisionGateProof: string | null;
    jamesAction: "NONE" | "DO THIS";
    jamesActionReason: string;
  };
  reads: {
    link: boolean;
    currentLane: boolean;
    ownedWorkQueue: boolean;
    gitStatus: boolean;
    systemMap: boolean;
    roadmap: boolean;
    recentComms: boolean;
  };
};

function trimText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

function preview(value: unknown, maxLength = 190): string | null {
  const text = trimText(value);
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function numberValue(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeCommsPreview(value: unknown, maxLength = 260): string | null {
  return preview(value, maxLength)
    ?.replace(/`?JAMES ACTION:[^`.\n]*`?/gi, "James-action line")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function readJsonObject(filePath: string): JsonObject | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function readText(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function hasSquidRunLink(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, ".squidrun", "link.json"));
}

function findSquidRunRoot(startPath: string): string {
  let current = path.resolve(startPath || process.cwd());
  if (!fs.existsSync(current)) current = process.cwd();
  const stats = fs.existsSync(current) ? fs.statSync(current) : null;
  if (stats?.isFile()) current = path.dirname(current);

  for (;;) {
    if (hasSquidRunLink(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startPath || process.cwd());
    current = parent;
  }
}

function resolveSquidRunRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  const candidates = [
    env.SQUIDRUN_WORKSPACE,
    env.SQUIDRUN_PROJECT_ROOT,
    env.SQUIDRUN_ROOT,
    cwd,
  ].map((value) => trimText(value)).filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (hasSquidRunLink(resolved)) return resolved;
  }

  return findSquidRunRoot(cwd);
}

function objectValue(input: JsonObject | null, key: string): JsonObject | null {
  const value = input?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function arrayValue(input: JsonObject | null, key: string): unknown[] {
  const value = input?.[key];
  return Array.isArray(value) ? value : [];
}

function summarizeLane(currentLane: JsonObject | null): SquidRunProjectContext["lane"] {
  const activeLane = objectValue(currentLane, "activeLane");
  const continuity = objectValue(currentLane, "continuity");
  return {
    loaded: Boolean(currentLane),
    status: trimText(currentLane?.status),
    sourceRef: trimText(activeLane?.sourceRef),
    sourceTimestampMs: numberValue(activeLane?.sourceTimestampMs),
    targetRole: trimText(activeLane?.targetRole),
    objective: preview(activeLane?.objective),
    nextAction: preview(continuity?.next_action),
    generatedAt: trimText(currentLane?.generatedAt),
    staleHandoff: null,
  };
}

function summarizeOwnedWork(queue: JsonObject | null): SquidRunProjectContext["ownedWork"] {
  const agents = objectValue(queue, "agents");
  const active: SquidRunProjectContext["ownedWork"]["active"] = [];
  let pendingCount = 0;

  for (const [agent, rawBucket] of Object.entries(agents || {})) {
    const bucket = rawBucket && typeof rawBucket === "object" && !Array.isArray(rawBucket)
      ? rawBucket as JsonObject
      : null;
    const activeTask = objectValue(bucket, "active");
    if (activeTask) {
      active.push({
        agent,
        taskId: trimText(activeTask.taskId || activeTask.id),
        title: preview(activeTask.title || activeTask.message, 120),
        nextStep: preview(activeTask.nextStep, 160),
      });
    }
    pendingCount += arrayValue(bucket, "pending").length;
  }

  return {
    loaded: Boolean(queue),
    active,
    pendingCount,
  };
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return null;
  }
}

function readGitStatus(squidrunRoot: string): SquidRunProjectContext["git"] {
  const branch = git(["branch", "--show-current"], squidrunRoot);
  const status = git(["status", "--short"], squidrunRoot);
  const shortStat = git(["diff", "--shortstat"], squidrunRoot);
  if (branch === null && status === null) {
    return {
      loaded: false,
      branch: null,
      dirtyCount: 0,
      shortStat: null,
      statusPreview: [],
    };
  }

  const lines = (status || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    loaded: true,
    branch: branch || null,
    dirtyCount: lines.length,
    shortStat: shortStat || null,
    statusPreview: lines.slice(0, 8),
  };
}

function statusLinePath(line: string): string {
  return line
    .replace(/^([?AMDRCU ]{1,2})\s+/, "")
    .replace(/^(.+)\s+->\s+/, "")
    .trim();
}

function summarizeDirtyWork(gitStatus: SquidRunProjectContext["git"]): SquidRunProjectContext["dirtyWork"] {
  if (!gitStatus.loaded) {
    return {
      loaded: false,
      summary: "Git status is not available.",
      files: [],
    };
  }

  const files = gitStatus.statusPreview.map(statusLinePath).filter(Boolean);
  if (gitStatus.dirtyCount === 0) {
    return {
      loaded: true,
      summary: "Worktree is clean.",
      files,
    };
  }

  const fileText = files.length > 0 ? files.slice(0, 5).join(", ") : "files not listed";
  const more = gitStatus.dirtyCount > files.length ? ` and ${gitStatus.dirtyCount - files.length} more` : "";
  return {
    loaded: true,
    summary: `${gitStatus.dirtyCount} changed file(s): ${fileText}${more}.`,
    files,
  };
}

function firstLineContaining(text: string, pattern: RegExp): string | null {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-|]\s*/, "").trim())
    .find((line) => pattern.test(line)) || null;
}

function readSystemMapTruth(squidrunRoot: string): SquidRunProjectContext["systemMap"] {
  const relativePath = "docs/mira-system-map.md" as const;
  const text = readText(path.join(squidrunRoot, relativePath));
  if (!text) {
    return {
      loaded: false,
      relativePath,
      truth: null,
      nextGate: null,
    };
  }

  return {
    loaded: true,
    relativePath,
    truth: preview(
      firstLineContaining(text, /not impressive yet|New Mira .*local workbench|inside James|actual SquidRun|generic agents/i)
        || firstLineContaining(text, /New Mira .*prototype|local workbench/i),
      220,
    ),
    nextGate: preview(
      firstLineContaining(text, /Usefulness next gate|current next slices|product-surface|workbench/i),
      220,
    ),
  };
}

function readRoadmapTruth(squidrunRoot: string): SquidRunProjectContext["roadmap"] {
  const relativePath = "docs/mira-north-star-roadmap.md" as const;
  const text = readText(path.join(squidrunRoot, relativePath));
  if (!text) {
    return {
      loaded: false,
      relativePath,
      hardTruth: null,
      firstDemo: null,
      stopPivot: null,
    };
  }

  return {
    loaded: true,
    relativePath,
    hardTruth: preview(firstLineContaining(text, /Current New Mira is not holy-shit amazing/i), 220),
    firstDemo: preview(firstLineContaining(text, /Mira Mission Control|Mission Control v0|First Inspectable Demo/i), 220),
    stopPivot: preview(firstLineContaining(text, /Stop or pivot|Stop \/ Pivot Criteria|three product lanes/i), 220),
  };
}

function sourceRefFromBody(rawBody: string | null, sender: string | null): string | null {
  if (!rawBody || !sender) return null;
  const match = rawBody.match(/\(([A-Z]+)\s+#(\d+)\)/);
  if (!match) return sender;
  return `${match[1]?.toLowerCase()}#${match[2]}`;
}

function sourceRefNumber(sourceRef: string | null): number | null {
  const match = String(sourceRef || "").match(/#(\d+)$/);
  return match ? numberValue(match[1]) : null;
}

function sourceRefRole(sourceRef: string | null): string | null {
  const match = String(sourceRef || "").match(/^([a-z]+)#\d+$/i);
  return match?.[1]?.toLowerCase() || null;
}

function extractCommitHash(rawBody: string | null): string | null {
  const text = rawBody || "";
  const commitMatch = text.match(/\b[0-9a-f]{7,40}\b/i);
  return commitMatch?.[0]?.toLowerCase() || null;
}

function containsCommitHash(rawBody: string | null, commitHash: string): boolean {
  const escaped = commitHash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(rawBody || "");
}

function commsSummary(row: JsonObject | null, maxLength = 260, preferredCommitHash: string | null = null): {
  sourceRef: string | null;
  excerpt: string | null;
  timestampMs: number | null;
  commitHash: string | null;
} | null {
  if (!row) return null;
  const rawBody = trimText(row.rawBody);
  const commitHash = preferredCommitHash && containsCommitHash(rawBody, preferredCommitHash)
    ? preferredCommitHash
    : containsCommitHash(rawBody, internalPaneActivationSeamCommitHash)
      ? internalPaneActivationSeamCommitHash
      : extractCommitHash(rawBody);
  return {
    sourceRef: sourceRefFromBody(rawBody, trimText(row.sender)),
    excerpt: safeCommsPreview(rawBody, maxLength),
    timestampMs: numberValue(row.timestampMs),
    commitHash,
  };
}

function isReportShapedCommsBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\([A-Z]+\s+#\d+\):\s*(?:Committed|Checkpoint|PASS\b|MODIFY\/containment|MODIFY resolved|ACK\b|Status check|Status pulse|Status\/MODIFY|Builder status nudge|Builder final nudge|Builder final closure nudge|Builder, containment|Builder containment|Oracle .* PASS|Builder .* PASS|Received [0-9a-f]{7,40} checkpoint)/i.test(body)
    || /^\([A-Z]+\s+#\d+\):\s*MODIFY (?:on|update on)\s+#\d+\b/i.test(body)
    || /^\([A-Z]+\s+#\d+\):\s*(?:Fallback trigger|Containment)\b/i.test(body)
    || /^\([A-Z]+\s+#\d+\):\s*Builder,?\s+(?:#\d+\s+)?WIP sanity\b/i.test(body)
    || /\b(?:focused context test is still red|current failure is tighter now|red-fixture nudge|green but incomplete|not reviewable|current dirty scope is|read-only proof|close the packet|close packet visibly|final containment|containment nudge)\b/i.test(body)
    || /\b(?:Proof|Post-commit proof|Committed-HEAD proof|Clean-head proof|pre-commit all checks passed)\s*:/i.test(body);
}

function isMissionControlContinuationDelegationBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  const instructionShaped = /(?:\):\s*)?(?:MODIFY\b|Current-session delegation|TASK\b|Builder\s*:|Builder\b.*\b(?:build|fix|patch|add|continue|land|take)\b|Fix\b|Regression must\b|Live acceptance\b|next Mira map-backed slice|next map-backed Mira slice|next map-backed slice|new tiny follow-up slice)/i.test(body);
  const continuationTarget = /continuation-aware Mission Control command context|next Mira map-backed slice|next map-backed Mira slice|next-move advancement|selector cleanup|tool\/app action planning|command-card|command card|route-plan follow-through|follow-through proof|internal-route promotion|internal route\/audit|route\/audit|promotion\/review|post-582ef1c6|582ef1c6|post-f7352d10|f7352d10|post-0cb27b6b|0cb27b6b|post-120806b4|120806b4|post-df0a47a6|df0a47a6|post-c301c1ac|c301c1ac|demo\/workbench|demoWorkbenchProof|surface-alignment|workbench\/surface|workbench surface|post-48e419b4|48e419b4|clean-context regression|post-208d7ad7|208d7ad7|stale[- ]handoff|current-lane handoff/i.test(body);
  return instructionShaped && continuationTarget && !isReportShapedCommsBody(body);
}

function isInternalPaneActivationSeamBuilderAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(BUILDER\s+#\d+\):\s*ACK (?:on|checkpoint)?\s*[`'"]?7ff9fe8d Add Mira internal pane activation attempt seam/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isContinuationSelectorCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /continuation selector follow-up committed as [`'"]?6092a28a Harden Mission Control delegation selection/i.test(body)
    && /Checkpoint|committed|Post-commit proof|pre-commit/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isMissionControlV1AlignmentDelegationBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Current-session delegation:\s*next Mira map-backed slice is Mission Control v1 dry-run coordination plan alignment/i.test(body)
    && /coordination drafts\/preview align with v1|drafts\/preview align with v1/i.test(body);
}

function isV1AlignmentCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*Mission Control v1 draft\/preview alignment committed as [`'"]?e82f1a54 Align Mission Control v1 route preview drafts/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isEvidenceWindowCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*continuation evidence-window hardening committed as [`'"]?4bfe771c Harden Mission Control comms evidence window/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isDirectChannelReadinessCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*direct-channel readiness contract alignment committed as [`'"]?22e876dc Align Mission Control direct-channel readiness contract/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isDirectChannelReadinessAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(BUILDER\s+#\d+\):\s*ACK checkpoint [`'"]?22e876dc Align Mission Control direct-channel readiness contract/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isToolAppActionPlanCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*Mission Control tool\/app action-plan first proof committed as [`'"]?5b3e0386 Add Mission Control tool app action plan proof/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isToolAppActionPlanAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(BUILDER\s+#\d+\):\s*ACK checkpoint [`'"]?5b3e0386 Add Mission Control tool app action plan proof/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isContinuityMemoryBoundaryCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*post-5b3e0386 continuity\/memory next-move advancement committed as [`'"]?bf82cea4 Advance Mission Control continuity memory boundary/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isContinuityMemoryBoundaryAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(BUILDER\s+#\d+\):\s*ACK checkpoint [`'"]?bf82cea4 Advance Mission Control continuity memory boundary/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isContinuityMemoryProofCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*Mission Control continuity\/memory first proof committed as [`'"]?d0bffd58 Add Mission Control continuity memory proof/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isContinuityMemoryProofAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(BUILDER\s+#\d+\):\s*ACK checkpoint [`'"]?d0bffd58 Add Mission Control continuity memory proof/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isContinuityMemoryProofOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Received [`'"]?d0bffd58 checkpoint/i.test(body)
    && /Mission Control continuity\/memory first proof|Mission Control continuity memory proof|Add Mission Control continuity memory proof/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isCleanContextSelectionCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #169 clean-context selector hardening as [`'"]?13c90817 Harden Mission Control clean context selection/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isCleanContextSelectionOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Received [`'"]?13c90817 checkpoint/i.test(body)
    && /clean-context selector hardening/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isDemoWorkbenchProofCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #178 Mission Control demo\/workbench first-proof slice as [`'"]?48e419b4 Add Mission Control demo workbench proof/i.test(body)
    && /[`'"]?missionControl\.demoWorkbenchProof[`'"]?\s+present/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isDemoWorkbenchProofOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Received [`'"]?48e419b4 checkpoint/i.test(body)
    && /demo\/workbench first-proof slice/i.test(body)
    && /missionControl\.demoWorkbenchProof present/i.test(body);
}

function isWorkbenchSurfaceProofCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #188 post-48e419b4 workbench surface proof slice as [`'"]?c301c1ac Render Mission Control workbench proof surface/i.test(body)
    && /UI renders proof id\/question\/completed contexts\/next step\/control point/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isWorkbenchSurfaceProofOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Received [`'"]?c301c1ac checkpoint/i.test(body)
    && /#188 workbench surface proof slice/i.test(body)
    && /zero \/turn POST/i.test(body)
    && /one JAMES ACTION line/i.test(body);
}

function isCommandCardSurfaceCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #230 command-card surface acceptance as [`'"]?5d119dc6 Render Mission Control command card surface/i.test(body)
    && /Local Mission Control workbench now renders [`'"]?missionControl\.commandCardAcceptance[`'"]? from existing [`'"]?\/squidrun\/context[`'"]?/i.test(body)
    && /exactly one JAMES ACTION line/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isCommandCardSurfaceOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Checkpoint received\.\s*#230\s*\/\s*5d119dc6 closure recorded/i.test(body)
    && /command-card surface now renders from existing \/squidrun\/context/i.test(body)
    && /exactly one JAMES ACTION line/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isCommandCardFollowThroughCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #237 post-5d119dc6 command-card follow-through advancement as [`'"]?df0a47a6 Advance Mission Control command card follow-through/i.test(body)
    && /nextStep is one dry-run Builder\/Oracle route-plan review\/follow-through lane/i.test(body)
    && /exactly one JAMES ACTION line/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isCommandCardFollowThroughOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Checkpoint received\.\s*#237\s*\/\s*df0a47a6 closure recorded/i.test(body)
    && /nextStep advanced to the dry-run Builder\/Oracle route-plan review\/follow-through lane/i.test(body)
    && /Exactly one JAMES ACTION line/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isCommandCardRoutePlanProofSurfaceCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #254 display-only route-plan follow-through proof surface as [`'"]?120806b4 Render Mission Control route plan proof surface/i.test(body)
    && /local workbench renders existing [`'"]?missionControl\.commandCardRoutePlanFollowThroughProof[`'"]? from loaded [`'"]?\/squidrun\/context[`'"]? beside commandCardAcceptance/i.test(body)
    && /zero POST\/no \/turn/i.test(body)
    && /exactly one JAMES ACTION line/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isCommandCardRoutePlanProofSurfaceOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Checkpoint received\.\s*#254\s*\/\s*120806b4 closure recorded/i.test(body)
    && /workbench renders [`'"]?missionControl\.commandCardRoutePlanFollowThroughProof[`'"]? from loaded [`'"]?\/squidrun\/context[`'"]? beside commandCardAcceptance/i.test(body)
    && /zero POST\/no \/turn/i.test(body)
    && /exactly one JAMES ACTION line/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRoutePlanningCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #262 post-120806b4 Mission Control context advancement as [`'"]?0cb27b6b Advance Mission Control internal route planning/i.test(body)
    && /nextStep internal-route promotion\/review planning from the visible proof only/i.test(body)
    && /selected draft purpose internal-route promotion no-send review/i.test(body)
    && /exactly one JAMES ACTION line/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRoutePlanningOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Checkpoint received\.\s*#262\s*\/\s*0cb27b6b closure recorded/i.test(body)
    && /nextStep internal-route promotion\/review planning from the visible proof only/i.test(body)
    && /no live-effect authority added/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRoutePromotionPlanSurfaceCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #282 internal-route promotion plan surface as [`'"]?f7352d10 Render Mission Control internal route promotion plan/i.test(body)
    && /[`'"]?missionControl\.internalRoutePromotionReviewPlan[`'"]?=mission-control-internal-route-promotion-review-plan-v0/i.test(body)
    && /selected draft purpose internal-route promotion plan review/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRoutePromotionPlanSurfaceOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Checkpoint received\.\s*#282\s*\/\s*f7352d10 closure recorded/i.test(body)
    && /internal-route promotion plan surface|missionControl\.internalRoutePromotionReviewPlan/i.test(body)
    && /no runtime context advancement|no live-effect authority added|display-only/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRouteAuditPlanningCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #289 post-f7352d10 internal route\/audit planning advancement as [`'"]?c1a05e07 Advance Mission Control internal route audit planning/i.test(body)
    && /source-specific surface evidence [`'"]?architect#287\/f7352d10[`'"]? plus [`'"]?oracle#95\/f7352d10[`'"]?/i.test(body)
    && /selected draft purpose [`'"]?internal route\/audit planning review[`'"]?/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRouteAuditPlanningBuilderAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(BUILDER\s+#\d+\):\s*ACK [`'"]?c1a05e07 checkpoint/i.test(body)
    && /latestContinuationDelegation|internal route\/audit planning|architect#295/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRouteAuditPlanningOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*(?:Received [`'"]?c1a05e07 checkpoint|Checkpoint received\.\s*#289\s*\/\s*c1a05e07 closure recorded)/i.test(body)
    && /internal route\/audit planning|route\/audit planning|Advance Mission Control internal route audit planning/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isPostAuditPlanningSelectorCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed #300 post-c1a05e07 selector hardening as [`'"]?582ef1c6 Harden Mission Control post audit planning selector/i.test(body)
    && /source-specific audit-planning checkpoint [`'"]?architect#298\/c1a05e07[`'"]?/i.test(body)
    && /Builder ACK [`'"]?builder#90\/c1a05e07[`'"]?/i.test(body)
    && /Oracle ACK [`'"]?oracle#98\/c1a05e07[`'"]?/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isPostAuditPlanningSelectorBuilderAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(BUILDER\s+#\d+\):\s*ACK [`'"]?582ef1c6 checkpoint/i.test(body)
    && /post-c1a05e07 selector hardening|WIP sanity\/status\/containment\/closure-nudge/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isPostAuditPlanningSelectorOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  const reviewAck = /^\(ORACLE\s+#\d+\):\s*(?:Received [`'"]?582ef1c6 checkpoint|Checkpoint received\.\s*#300\s*\/\s*582ef1c6 closure recorded)/i.test(body)
    && /post-c1a05e07 selector hardening|WIP sanity\/status\/containment\/closure-nudge|Mission Control post audit planning selector/i.test(body);
  const liveCleanHeadAck = /^\(ORACLE\s+#\d+\):\s*Checkpoint received\.\s*582ef1c6 selector hardening recorded clean-head\b/i.test(body);
  return (reviewAck || liveCleanHeadAck)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRouteAuditReviewLaneProofCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint:\s*committed corrective #325 as [`'"]?b1acd4d7 Fix Mission Control post audit Oracle ACK selector/i.test(body)
    && /latestPostAuditPlanningSelectorOracleAck=oracle#101\/582ef1c6|fixed [`'"]?latestPostAuditPlanningSelectorOracleAck[`'"]?=oracle#101\/582ef1c6|post-audit selector checkpoint [`'"]?architect#311\/582ef1c6[`'"]?/i.test(body)
    && /Completed contexts remain present|commandCardAcceptance|commandCardRoutePlanFollowThroughProof|internalRoutePromotionReviewPlan/i.test(body)
    && /NextStep remains .*internal route\/audit planning|selected draft purpose .*internal route\/audit planning review|internal route\/audit planning lane/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRouteAuditReviewLaneProofOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*(?:Received [`'"]?b1acd4d7 checkpoint|Checkpoint received\.\s*b1acd4d7)/i.test(body)
    && /post-audit selector|Oracle ACK selector|latestPostAuditPlanningSelectorOracleAck|internal route\/audit planning/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isJamesActionLineDedupCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint [`'"]?2533ace2 Deduplicate Mission Control James action line[`'"]? is committed clean/i.test(body)
    && /composed [`'"]?missionControl\.answer[`'"]? has exactly one literal [`'"]?JAMES ACTION:[`'"]? occurrence/i.test(body)
    && /structured [`'"]?missionControl\.commandCardAcceptance\.cardFields\.jamesActionLine[`'"]? remains [`'"]?JAMES ACTION:\s*NONE[`'"]?/i.test(body)
    && /completed contexts remain present through [`'"]?internalRouteAuditReviewLaneProof[`'"]?/i.test(body)
    && /No live-effect\/trading authority added/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isJamesActionLineDedupOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Checkpoint received\.\s*Clean-head closure recorded for [`'"]?2533ace2 Deduplicate Mission Control James action line[`'"]?/i.test(body)
    && /Oracle #10 PASS and Builder #107 map-guard closure are accepted as committed evidence/i.test(body)
    && /composed [`'"]?missionControl\.answer[`'"]? has exactly one literal [`'"]?JAMES ACTION:[`'"]? occurrence/i.test(body)
    && /structured [`'"]?missionControl\.commandCardAcceptance\.cardFields\.jamesActionLine[`'"]? remains [`'"]?JAMES ACTION:\s*NONE[`'"]?/i.test(body)
    && /completed contexts remain present through [`'"]?missionControl\.internalRouteAuditReviewLaneProof[`'"]?/i.test(body)
    && /no runtime\/route\/send\/UI\/status\/provider\/model\/credential\/deploy\/money\/trading authority was added/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRoutePromotionDecisionGateCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint [`'"]?cbeb0d2f Advance Mission Control route audit decision gate[`'"]? committed clean/i.test(body)
    && /latestJamesActionLineDedupCheckpoint=architect#372\/2533ace2/i.test(body)
    && /latestJamesActionLineDedupOracleAck=oracle#11\/2533ace2/i.test(body)
    && /completed contexts present through commandCardAcceptance, commandCardRoutePlanFollowThroughProof, internalRoutePromotionReviewPlan, and internalRouteAuditReviewLaneProof/i.test(body)
    && /nextStep\/drafts\/preview now point to no-live-effect internal route\/audit promotion decision-gate planning from the visible audit-review proof only/i.test(body)
    && /composed answer has exactly one literal JAMES ACTION line/i.test(body)
    && /No live authority added/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRoutePromotionDecisionGateOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Checkpoint received\.\s*Clean-head closure recorded for [`'"]?cbeb0d2f Advance Mission Control route audit decision gate[`'"]?/i.test(body)
    && /Oracle #14 PASS accepted as committed evidence/i.test(body)
    && /HEAD is [`'"]?cbeb0d2f[`'"]?/i.test(body)
    && /post-answer-shape evidence remains source-bound to [`'"]?architect#372\/2533ace2[`'"]? plus [`'"]?oracle#11\/2533ace2[`'"]?/i.test(body)
    && /completed contexts are retained through [`'"]?missionControl\.internalRouteAuditReviewLaneProof[`'"]?/i.test(body)
    && /clean nextStep\/drafts\/preview advanced from accepted audit-proof review to one no-live-effect internal route\/audit promotion decision-gate planning lane from the visible audit-review proof only/i.test(body)
    && /composed answer keeps exactly one literal [`'"]?JAMES ACTION:[`'"]? line/i.test(body)
    && /no runtime\/browser\/workbench\/UI\/status action, fetch\/POST, route\/send\/hm-send, provider\/model, credential\/account\/token\/device\/user\/external target, deploy, money, or trading authority was added/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRoutePromotionDecisionGateSurfaceCheckpointBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /Checkpoint [`'"]?5fc2cd90 Render Mission Control route audit decision proof[`'"]? committed clean/i.test(body)
    && /workbench display-only renders existing [`'"]?missionControl\.internalRouteAuditPromotionDecisionGateProof[`'"]? from loaded [`'"]?\/squidrun\/context[`'"]?/i.test(body)
    && /no runtime context advancement/i.test(body)
    && /zero [`'"]?\/turn[`'"]? POST\/new fetch path in proof/i.test(body)
    && /exactly one visible [`'"]?JAMES ACTION:[`'"]? line/i.test(body)
    && /no runtime\/browser\/workbench\/UI\/status route\/send\/hm-send\/provider\/model\/credential\/deploy\/money\/trading authority added/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function isInternalRoutePromotionDecisionGateSurfaceOracleAckBody(rawBody: string | null): boolean {
  const body = rawBody || "";
  return /^\(ORACLE\s+#\d+\):\s*Checkpoint received\.\s*Clean-head closure recorded for [`'"]?5fc2cd90 Render Mission Control route audit decision proof[`'"]?/i.test(body)
    && /Oracle #23 PASS accepted as committed evidence/i.test(body)
    && /HEAD is [`'"]?5fc2cd90[`'"]?/i.test(body)
    && /display-only workbench surface renders existing [`'"]?missionControl\.internalRouteAuditPromotionDecisionGateProof[`'"]? from loaded [`'"]?\/squidrun\/context[`'"]? beside completed audit review-lane proof/i.test(body)
    && /no runtime context advancement/i.test(body)
    && /pre-commit passed focused UI read-only boot and map guard/i.test(body)
    && /exactly one visible [`'"]?JAMES ACTION:[`'"]? line/i.test(body)
    && /no live route\/send\/runtime\/UI\/provider\/credential\/deploy\/money\/trading authority was added/i.test(body)
    && /JAMES ACTION:\s*NONE/i.test(body);
}

function readRecentComms(squidrunRoot: string): SquidRunProjectContext["recentComms"] {
  const scriptPath = path.join(squidrunRoot, "ui", "scripts", "hm-comms.js");
  if (!fs.existsSync(scriptPath)) {
    return {
      loaded: false,
      latestBuilderInstruction: null,
      latestCommitCheckpoint: null,
      latestBuilderAck: null,
      latestContinuationDelegation: null,
      latestContinuationSelectorCheckpoint: null,
      latestV1AlignmentDelegation: null,
      latestV1AlignmentCheckpoint: null,
      latestEvidenceWindowCheckpoint: null,
      latestDirectChannelReadinessCheckpoint: null,
      latestDirectChannelReadinessAck: null,
      latestToolAppActionPlanCheckpoint: null,
      latestToolAppActionPlanAck: null,
      latestContinuityMemoryBoundaryCheckpoint: null,
      latestContinuityMemoryBoundaryAck: null,
      latestContinuityMemoryProofCheckpoint: null,
      latestContinuityMemoryProofAck: null,
      latestContinuityMemoryProofOracleAck: null,
      latestCleanContextSelectionCheckpoint: null,
      latestCleanContextSelectionOracleAck: null,
      latestDemoWorkbenchProofCheckpoint: null,
      latestDemoWorkbenchProofOracleAck: null,
      latestWorkbenchSurfaceProofCheckpoint: null,
      latestWorkbenchSurfaceProofOracleAck: null,
      latestCommandCardSurfaceCheckpoint: null,
      latestCommandCardSurfaceOracleAck: null,
      latestCommandCardFollowThroughCheckpoint: null,
      latestCommandCardFollowThroughOracleAck: null,
      latestCommandCardRoutePlanProofSurfaceCheckpoint: null,
      latestCommandCardRoutePlanProofSurfaceOracleAck: null,
      latestInternalRoutePlanningCheckpoint: null,
      latestInternalRoutePlanningOracleAck: null,
      latestInternalRoutePromotionPlanSurfaceCheckpoint: null,
      latestInternalRoutePromotionPlanSurfaceOracleAck: null,
      latestInternalRouteAuditPlanningCheckpoint: null,
      latestInternalRouteAuditPlanningBuilderAck: null,
      latestInternalRouteAuditPlanningOracleAck: null,
      latestPostAuditPlanningSelectorCheckpoint: null,
      latestPostAuditPlanningSelectorBuilderAck: null,
      latestPostAuditPlanningSelectorOracleAck: null,
      latestInternalRouteAuditReviewLaneProofCheckpoint: null,
      latestInternalRouteAuditReviewLaneProofOracleAck: null,
      latestJamesActionLineDedupCheckpoint: null,
      latestJamesActionLineDedupOracleAck: null,
      latestInternalRoutePromotionDecisionGateCheckpoint: null,
      latestInternalRoutePromotionDecisionGateOracleAck: null,
      latestInternalRoutePromotionDecisionGateSurfaceCheckpoint: null,
      latestInternalRoutePromotionDecisionGateSurfaceOracleAck: null,
      oracleBenchmark: null,
    };
  }

  try {
    const stdout = execFileSync(process.execPath, [
      scriptPath,
      "history",
      "--last",
      String(commsHistoryEvidenceLimit),
      "--json",
    ], {
      cwd: squidrunRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 2500,
    });
    const parsed = JSON.parse(stdout) as JsonObject;
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const mapped = rows
      .map((row) => row && typeof row === "object" && !Array.isArray(row) ? row as JsonObject : null)
      .filter(Boolean) as JsonObject[];
    const builderRows = mapped.filter((row) => trimText(row.sender) === "architect" && trimText(row.target) === "builder");
    const builderInstruction = builderRows.find((row) => {
      const body = trimText(row.rawBody) || "";
      return /Mission Control|mission-control|north-star|holy-shit|first inspectable demo|operator surface|demo\/workbench|clean-context regression|getSquidRunContext|internal route\/audit|route\/audit|208d7ad7/i.test(body)
        && !isReportShapedCommsBody(body)
        && !/status ping|status check/i.test(body);
    }) || null;
    const commitCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && containsCommitHash(body, internalPaneActivationSeamCommitHash)
        && /Committed the internal-pane activation attempt seam|Checkpoint: internal-pane activation attempt seam committed|Commit already landed as [`'"]?7ff9fe8d/i.test(body)
        && /PASS|proof|pre-commit|working tree clean|tree clean/i.test(body)
        && /JAMES ACTION:\s*NONE/i.test(body);
    });
    const builderAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "builder"
        && isInternalPaneActivationSeamBuilderAckBody(body);
    });
    const continuationDelegation = builderRows.find((row) => {
      const body = trimText(row.rawBody) || "";
      return isMissionControlContinuationDelegationBody(body);
    });
    const continuationSelectorCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && isContinuationSelectorCheckpointBody(body);
    });
    const v1AlignmentDelegation = builderRows.find((row) => {
      const body = trimText(row.rawBody) || "";
      return isMissionControlV1AlignmentDelegationBody(body);
    });
    const v1AlignmentCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && isV1AlignmentCheckpointBody(body);
    });
    const evidenceWindowCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && isEvidenceWindowCheckpointBody(body);
    });
    const directChannelReadinessCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && isDirectChannelReadinessCheckpointBody(body);
    });
    const directChannelReadinessAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "builder"
        && isDirectChannelReadinessAckBody(body);
    });
    const toolAppActionPlanCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && isToolAppActionPlanCheckpointBody(body);
    });
    const toolAppActionPlanAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "builder"
        && isToolAppActionPlanAckBody(body);
    });
    const continuityMemoryBoundaryCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && isContinuityMemoryBoundaryCheckpointBody(body);
    });
    const continuityMemoryBoundaryAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "builder"
        && isContinuityMemoryBoundaryAckBody(body);
    });
    const continuityMemoryProofCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && isContinuityMemoryProofCheckpointBody(body);
    });
    const continuityMemoryProofAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "builder"
        && isContinuityMemoryProofAckBody(body);
    });
    const continuityMemoryProofOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isContinuityMemoryProofOracleAckBody(body);
    });
    const cleanContextSelectionCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isCleanContextSelectionCheckpointBody(body);
    });
    const cleanContextSelectionOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isCleanContextSelectionOracleAckBody(body);
    });
    const demoWorkbenchProofCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isDemoWorkbenchProofCheckpointBody(body);
    });
    const demoWorkbenchProofOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isDemoWorkbenchProofOracleAckBody(body);
    });
    const workbenchSurfaceProofCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isWorkbenchSurfaceProofCheckpointBody(body);
    });
    const workbenchSurfaceProofOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isWorkbenchSurfaceProofOracleAckBody(body);
    });
    const commandCardSurfaceCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isCommandCardSurfaceCheckpointBody(body);
    });
    const commandCardSurfaceOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isCommandCardSurfaceOracleAckBody(body);
    });
    const commandCardFollowThroughCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isCommandCardFollowThroughCheckpointBody(body);
    });
    const commandCardFollowThroughOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isCommandCardFollowThroughOracleAckBody(body);
    });
    const commandCardRoutePlanProofSurfaceCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isCommandCardRoutePlanProofSurfaceCheckpointBody(body);
    });
    const commandCardRoutePlanProofSurfaceOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isCommandCardRoutePlanProofSurfaceOracleAckBody(body);
    });
    const internalRoutePlanningCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isInternalRoutePlanningCheckpointBody(body);
    });
    const internalRoutePlanningOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isInternalRoutePlanningOracleAckBody(body);
    });
    const internalRoutePromotionPlanSurfaceCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isInternalRoutePromotionPlanSurfaceCheckpointBody(body);
    });
    const internalRoutePromotionPlanSurfaceOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isInternalRoutePromotionPlanSurfaceOracleAckBody(body);
    });
    const internalRouteAuditPlanningCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isInternalRouteAuditPlanningCheckpointBody(body);
    });
    const internalRouteAuditPlanningBuilderAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "builder"
        && isInternalRouteAuditPlanningBuilderAckBody(body);
    });
    const internalRouteAuditPlanningOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isInternalRouteAuditPlanningOracleAckBody(body);
    });
    const postAuditPlanningSelectorCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isPostAuditPlanningSelectorCheckpointBody(body);
    });
    const postAuditPlanningSelectorBuilderAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "builder"
        && isPostAuditPlanningSelectorBuilderAckBody(body);
    });
    const postAuditPlanningSelectorOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isPostAuditPlanningSelectorOracleAckBody(body);
    });
    const internalRouteAuditReviewLaneProofCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isInternalRouteAuditReviewLaneProofCheckpointBody(body);
    });
    const internalRouteAuditReviewLaneProofOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isInternalRouteAuditReviewLaneProofOracleAckBody(body);
    });
    const jamesActionLineDedupCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isJamesActionLineDedupCheckpointBody(body);
    });
    const jamesActionLineDedupOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isJamesActionLineDedupOracleAckBody(body);
    });
    const internalRoutePromotionDecisionGateCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isInternalRoutePromotionDecisionGateCheckpointBody(body);
    });
    const internalRoutePromotionDecisionGateOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isInternalRoutePromotionDecisionGateOracleAckBody(body);
    });
    const internalRoutePromotionDecisionGateSurfaceCheckpoint = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "architect"
        && trimText(row.target) === "builder"
        && isInternalRoutePromotionDecisionGateSurfaceCheckpointBody(body);
    });
    const internalRoutePromotionDecisionGateSurfaceOracleAck = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle"
        && isInternalRoutePromotionDecisionGateSurfaceOracleAckBody(body);
    });
    const oracleBenchmark = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle" && /benchmark|holy-shit|not impressive|current New Mira/i.test(body);
    });

    return {
      loaded: true,
      latestBuilderInstruction: commsSummary(builderInstruction || null),
      latestCommitCheckpoint: commsSummary(commitCheckpoint || null),
      latestBuilderAck: commsSummary(builderAck || null, 260, internalPaneActivationSeamCommitHash),
      latestContinuationDelegation: commsSummary(continuationDelegation || null),
      latestContinuationSelectorCheckpoint: commsSummary(continuationSelectorCheckpoint || null, 260, continuationSelectorCommitHash),
      latestV1AlignmentDelegation: commsSummary(v1AlignmentDelegation || null),
      latestV1AlignmentCheckpoint: commsSummary(v1AlignmentCheckpoint || null, 260, v1RoutePreviewAlignmentCommitHash),
      latestEvidenceWindowCheckpoint: commsSummary(evidenceWindowCheckpoint || null, 260, commsEvidenceWindowCommitHash),
      latestDirectChannelReadinessCheckpoint: commsSummary(directChannelReadinessCheckpoint || null, 260, directChannelReadinessContractCommitHash),
      latestDirectChannelReadinessAck: commsSummary(directChannelReadinessAck || null, 260, directChannelReadinessContractCommitHash),
      latestToolAppActionPlanCheckpoint: commsSummary(toolAppActionPlanCheckpoint || null, 260, toolAppActionPlanProofCommitHash),
      latestToolAppActionPlanAck: commsSummary(toolAppActionPlanAck || null, 260, toolAppActionPlanProofCommitHash),
      latestContinuityMemoryBoundaryCheckpoint: commsSummary(continuityMemoryBoundaryCheckpoint || null, 260, continuityMemoryBoundaryCommitHash),
      latestContinuityMemoryBoundaryAck: commsSummary(continuityMemoryBoundaryAck || null, 260, continuityMemoryBoundaryCommitHash),
      latestContinuityMemoryProofCheckpoint: commsSummary(continuityMemoryProofCheckpoint || null, 260, continuityMemoryProofCommitHash),
      latestContinuityMemoryProofAck: commsSummary(continuityMemoryProofAck || null, 260, continuityMemoryProofCommitHash),
      latestContinuityMemoryProofOracleAck: commsSummary(continuityMemoryProofOracleAck || null, 260, continuityMemoryProofCommitHash),
      latestCleanContextSelectionCheckpoint: commsSummary(cleanContextSelectionCheckpoint || null, 260, cleanContextSelectionCommitHash),
      latestCleanContextSelectionOracleAck: commsSummary(cleanContextSelectionOracleAck || null, 260, cleanContextSelectionCommitHash),
      latestDemoWorkbenchProofCheckpoint: commsSummary(demoWorkbenchProofCheckpoint || null, 260, demoWorkbenchProofCommitHash),
      latestDemoWorkbenchProofOracleAck: commsSummary(demoWorkbenchProofOracleAck || null, 260, demoWorkbenchProofCommitHash),
      latestWorkbenchSurfaceProofCheckpoint: commsSummary(workbenchSurfaceProofCheckpoint || null, 260, workbenchSurfaceProofCommitHash),
      latestWorkbenchSurfaceProofOracleAck: commsSummary(workbenchSurfaceProofOracleAck || null, 260, workbenchSurfaceProofCommitHash),
      latestCommandCardSurfaceCheckpoint: commsSummary(commandCardSurfaceCheckpoint || null, 260, commandCardSurfaceCommitHash),
      latestCommandCardSurfaceOracleAck: commsSummary(commandCardSurfaceOracleAck || null, 260, commandCardSurfaceCommitHash),
      latestCommandCardFollowThroughCheckpoint: commsSummary(commandCardFollowThroughCheckpoint || null, 260, commandCardFollowThroughCommitHash),
      latestCommandCardFollowThroughOracleAck: commsSummary(commandCardFollowThroughOracleAck || null, 260, commandCardFollowThroughCommitHash),
      latestCommandCardRoutePlanProofSurfaceCheckpoint: commsSummary(commandCardRoutePlanProofSurfaceCheckpoint || null, 260, commandCardRoutePlanProofSurfaceCommitHash),
      latestCommandCardRoutePlanProofSurfaceOracleAck: commsSummary(commandCardRoutePlanProofSurfaceOracleAck || null, 260, commandCardRoutePlanProofSurfaceCommitHash),
      latestInternalRoutePlanningCheckpoint: commsSummary(internalRoutePlanningCheckpoint || null, 260, internalRoutePlanningCommitHash),
      latestInternalRoutePlanningOracleAck: commsSummary(internalRoutePlanningOracleAck || null, 260, internalRoutePlanningCommitHash),
      latestInternalRoutePromotionPlanSurfaceCheckpoint: commsSummary(internalRoutePromotionPlanSurfaceCheckpoint || null, 260, internalRoutePromotionPlanSurfaceCommitHash),
      latestInternalRoutePromotionPlanSurfaceOracleAck: commsSummary(internalRoutePromotionPlanSurfaceOracleAck || null, 260, internalRoutePromotionPlanSurfaceCommitHash),
      latestInternalRouteAuditPlanningCheckpoint: commsSummary(internalRouteAuditPlanningCheckpoint || null, 260, internalRouteAuditPlanningCommitHash),
      latestInternalRouteAuditPlanningBuilderAck: commsSummary(internalRouteAuditPlanningBuilderAck || null, 260, internalRouteAuditPlanningCommitHash),
      latestInternalRouteAuditPlanningOracleAck: commsSummary(internalRouteAuditPlanningOracleAck || null, 260, internalRouteAuditPlanningCommitHash),
      latestPostAuditPlanningSelectorCheckpoint: commsSummary(postAuditPlanningSelectorCheckpoint || null, 260, postAuditPlanningSelectorCommitHash),
      latestPostAuditPlanningSelectorBuilderAck: commsSummary(postAuditPlanningSelectorBuilderAck || null, 260, postAuditPlanningSelectorCommitHash),
      latestPostAuditPlanningSelectorOracleAck: commsSummary(postAuditPlanningSelectorOracleAck || null, 260, postAuditPlanningSelectorCommitHash),
      latestInternalRouteAuditReviewLaneProofCheckpoint: commsSummary(internalRouteAuditReviewLaneProofCheckpoint || null, 260, internalRouteAuditReviewLaneProofCommitHash),
      latestInternalRouteAuditReviewLaneProofOracleAck: commsSummary(internalRouteAuditReviewLaneProofOracleAck || null, 260, internalRouteAuditReviewLaneProofCommitHash),
      latestJamesActionLineDedupCheckpoint: commsSummary(jamesActionLineDedupCheckpoint || null, 260, jamesActionLineDedupCommitHash),
      latestJamesActionLineDedupOracleAck: commsSummary(jamesActionLineDedupOracleAck || null, 260, jamesActionLineDedupCommitHash),
      latestInternalRoutePromotionDecisionGateCheckpoint: commsSummary(internalRoutePromotionDecisionGateCheckpoint || null, 260, internalRoutePromotionDecisionGateCommitHash),
      latestInternalRoutePromotionDecisionGateOracleAck: commsSummary(internalRoutePromotionDecisionGateOracleAck || null, 260, internalRoutePromotionDecisionGateCommitHash),
      latestInternalRoutePromotionDecisionGateSurfaceCheckpoint: commsSummary(internalRoutePromotionDecisionGateSurfaceCheckpoint || null, 260, internalRoutePromotionDecisionGateSurfaceCommitHash),
      latestInternalRoutePromotionDecisionGateSurfaceOracleAck: commsSummary(internalRoutePromotionDecisionGateSurfaceOracleAck || null, 260, internalRoutePromotionDecisionGateSurfaceCommitHash),
      oracleBenchmark: commsSummary(oracleBenchmark || null),
    };
  } catch {
    return {
      loaded: false,
      latestBuilderInstruction: null,
      latestCommitCheckpoint: null,
      latestBuilderAck: null,
      latestContinuationDelegation: null,
      latestContinuationSelectorCheckpoint: null,
      latestV1AlignmentDelegation: null,
      latestV1AlignmentCheckpoint: null,
      latestEvidenceWindowCheckpoint: null,
      latestDirectChannelReadinessCheckpoint: null,
      latestDirectChannelReadinessAck: null,
      latestToolAppActionPlanCheckpoint: null,
      latestToolAppActionPlanAck: null,
      latestContinuityMemoryBoundaryCheckpoint: null,
      latestContinuityMemoryBoundaryAck: null,
      latestContinuityMemoryProofCheckpoint: null,
      latestContinuityMemoryProofAck: null,
      latestContinuityMemoryProofOracleAck: null,
      latestCleanContextSelectionCheckpoint: null,
      latestCleanContextSelectionOracleAck: null,
      latestDemoWorkbenchProofCheckpoint: null,
      latestDemoWorkbenchProofOracleAck: null,
      latestWorkbenchSurfaceProofCheckpoint: null,
      latestWorkbenchSurfaceProofOracleAck: null,
      latestCommandCardSurfaceCheckpoint: null,
      latestCommandCardSurfaceOracleAck: null,
      latestCommandCardFollowThroughCheckpoint: null,
      latestCommandCardFollowThroughOracleAck: null,
      latestCommandCardRoutePlanProofSurfaceCheckpoint: null,
      latestCommandCardRoutePlanProofSurfaceOracleAck: null,
      latestInternalRoutePlanningCheckpoint: null,
      latestInternalRoutePlanningOracleAck: null,
      latestInternalRoutePromotionPlanSurfaceCheckpoint: null,
      latestInternalRoutePromotionPlanSurfaceOracleAck: null,
      latestInternalRouteAuditPlanningCheckpoint: null,
      latestInternalRouteAuditPlanningBuilderAck: null,
      latestInternalRouteAuditPlanningOracleAck: null,
      latestPostAuditPlanningSelectorCheckpoint: null,
      latestPostAuditPlanningSelectorBuilderAck: null,
      latestPostAuditPlanningSelectorOracleAck: null,
      latestInternalRouteAuditReviewLaneProofCheckpoint: null,
      latestInternalRouteAuditReviewLaneProofOracleAck: null,
      latestJamesActionLineDedupCheckpoint: null,
      latestJamesActionLineDedupOracleAck: null,
      latestInternalRoutePromotionDecisionGateCheckpoint: null,
      latestInternalRoutePromotionDecisionGateOracleAck: null,
      latestInternalRoutePromotionDecisionGateSurfaceCheckpoint: null,
      latestInternalRoutePromotionDecisionGateSurfaceOracleAck: null,
      oracleBenchmark: null,
    };
  }
}

function hasLaterEvidence(
  lane: SquidRunProjectContext["lane"],
  evidence: { sourceRef: string | null; timestampMs: number | null } | null,
): boolean {
  if (!evidence?.sourceRef || evidence.sourceRef === lane.sourceRef) return false;
  const laneNumber = sourceRefNumber(lane.sourceRef);
  const evidenceNumber = sourceRefNumber(evidence.sourceRef);
  const sameRole = sourceRefRole(lane.sourceRef) !== null && sourceRefRole(lane.sourceRef) === sourceRefRole(evidence.sourceRef);
  if (sameRole && laneNumber !== null && evidenceNumber !== null && evidenceNumber > laneNumber) return true;
  return lane.sourceTimestampMs !== null && evidence.timestampMs !== null && evidence.timestampMs > lane.sourceTimestampMs;
}

function buildContinuationDecision(input: {
  lane: SquidRunProjectContext["lane"];
  dirtyWork: SquidRunProjectContext["dirtyWork"];
  recentComms: SquidRunProjectContext["recentComms"];
}): SquidRunProjectContext["missionControl"]["continuationDecision"] {
  const commit = input.recentComms.latestCommitCheckpoint;
  const builderAck = input.recentComms.latestBuilderAck;
  const delegation = input.recentComms.latestContinuationDelegation;
  const commitHash = commit?.commitHash || builderAck?.commitHash || null;
  const cleanTree = input.dirtyWork.loaded === true && input.dirtyWork.files.length === 0;
  const hasRequiredCommit = commitHash === internalPaneActivationSeamCommitHash;
  const hasArchitectCheckpoint = Boolean(commit?.sourceRef && hasLaterEvidence(input.lane, commit));
  const hasBuilderAck = Boolean(builderAck?.sourceRef && hasLaterEvidence(input.lane, builderAck));
  const hasCurrentDelegation = Boolean(delegation?.sourceRef && hasLaterEvidence(input.lane, delegation));
  const oldObjective = input.lane.objective || "";
  const oldReviewNoSendSlice = /3-file|review\/no-send|review-no-send|no-send gate/i.test(oldObjective);
  const continuationCommandContext = Boolean(delegation?.sourceRef);

  if (
    input.lane.sourceRef
    && oldReviewNoSendSlice
    && cleanTree
    && hasRequiredCommit
    && hasArchitectCheckpoint
    && hasBuilderAck
    && hasCurrentDelegation
    && continuationCommandContext
  ) {
    return {
      status: "stale_handoff_superseded",
      preferredSourceRef: delegation?.sourceRef || commit?.sourceRef || builderAck?.sourceRef || null,
      committedSeam: `${internalPaneActivationSeamCommitHash} Add Mira internal pane activation attempt seam`,
      staleSourceRef: input.lane.sourceRef,
      staleObjective: input.lane.objective,
      reason: "The current-lane handoff still names the old review/no-send dirty slice, but later local evidence shows the internal-pane activation seam committed, Builder acknowledged the clean committed HEAD, and Architect delegated the continuation-aware command-context lane.",
    };
  }

  return {
    status: "current_handoff",
    preferredSourceRef: input.recentComms.latestBuilderInstruction?.sourceRef || input.lane.sourceRef || null,
    committedSeam: null,
    staleSourceRef: null,
    staleObjective: null,
    reason: "No complete later commit/checkpoint/ack/delegation chain supersedes the current handoff.",
  };
}

function buildMissionControl(input: {
  projectName: string;
  lane: SquidRunProjectContext["lane"];
  dirtyWork: SquidRunProjectContext["dirtyWork"];
  systemMap: SquidRunProjectContext["systemMap"];
  roadmap: SquidRunProjectContext["roadmap"];
  recentComms: SquidRunProjectContext["recentComms"];
  fallbackNextStep: string;
}): SquidRunProjectContext["missionControl"] {
  const continuationDecision = buildContinuationDecision(input);
  const continuationIsStaleSuperseded = continuationDecision.status === "stale_handoff_superseded";
  const continuationSelectorProofCommitted = continuationIsStaleSuperseded
    && input.recentComms.latestContinuationSelectorCheckpoint?.commitHash === continuationSelectorCommitHash;
  const directChannelBoundaryReady = continuationSelectorProofCommitted
    && input.recentComms.latestV1AlignmentDelegation?.sourceRef === "architect#87"
    && input.recentComms.latestV1AlignmentCheckpoint?.commitHash === v1RoutePreviewAlignmentCommitHash
    && input.recentComms.latestEvidenceWindowCheckpoint?.commitHash === commsEvidenceWindowCommitHash;
  const toolAppActionPlanningReady = directChannelBoundaryReady
    && input.recentComms.latestDirectChannelReadinessCheckpoint?.commitHash === directChannelReadinessContractCommitHash
    && input.recentComms.latestDirectChannelReadinessAck?.commitHash === directChannelReadinessContractCommitHash;
  const continuityMemoryPlanningReady = toolAppActionPlanningReady
    && input.recentComms.latestToolAppActionPlanCheckpoint?.commitHash === toolAppActionPlanProofCommitHash
    && input.recentComms.latestToolAppActionPlanAck?.commitHash === toolAppActionPlanProofCommitHash;
  const continuityMemoryProofReady = continuityMemoryPlanningReady
    && input.recentComms.latestContinuityMemoryBoundaryCheckpoint?.commitHash === continuityMemoryBoundaryCommitHash
    && input.recentComms.latestContinuityMemoryBoundaryAck?.commitHash === continuityMemoryBoundaryCommitHash;
  const demoWorkbenchPlanningReady = continuityMemoryProofReady
    && input.recentComms.latestContinuityMemoryProofCheckpoint?.commitHash === continuityMemoryProofCommitHash
    && input.recentComms.latestContinuityMemoryProofAck?.commitHash === continuityMemoryProofCommitHash
    && input.recentComms.latestContinuityMemoryProofOracleAck?.commitHash === continuityMemoryProofCommitHash;
  const demoWorkbenchProofReady = demoWorkbenchPlanningReady
    && input.recentComms.latestCleanContextSelectionCheckpoint?.commitHash === cleanContextSelectionCommitHash
    && input.recentComms.latestCleanContextSelectionOracleAck?.commitHash === cleanContextSelectionCommitHash;
  const workbenchSurfaceProofReady = demoWorkbenchProofReady
    && input.recentComms.latestDemoWorkbenchProofCheckpoint?.commitHash === demoWorkbenchProofCommitHash
    && input.recentComms.latestDemoWorkbenchProofOracleAck?.commitHash === demoWorkbenchProofCommitHash;
  const commandCardAcceptanceReady = workbenchSurfaceProofReady
    && input.recentComms.latestWorkbenchSurfaceProofCheckpoint?.commitHash === workbenchSurfaceProofCommitHash
    && input.recentComms.latestWorkbenchSurfaceProofOracleAck?.commitHash === workbenchSurfaceProofCommitHash;
  const commandCardSurfaceReady = commandCardAcceptanceReady
    && input.recentComms.latestCommandCardSurfaceCheckpoint?.commitHash === commandCardSurfaceCommitHash
    && input.recentComms.latestCommandCardSurfaceOracleAck?.commitHash === commandCardSurfaceCommitHash;
  const commandCardFollowThroughProofReady = commandCardSurfaceReady
    && input.recentComms.latestCommandCardFollowThroughCheckpoint?.commitHash === commandCardFollowThroughCommitHash
    && input.recentComms.latestCommandCardFollowThroughOracleAck?.commitHash === commandCardFollowThroughCommitHash;
  const commandCardRoutePlanProofSurfaceReady = commandCardFollowThroughProofReady
    && input.recentComms.latestCommandCardRoutePlanProofSurfaceCheckpoint?.commitHash === commandCardRoutePlanProofSurfaceCommitHash
    && input.recentComms.latestCommandCardRoutePlanProofSurfaceOracleAck?.commitHash === commandCardRoutePlanProofSurfaceCommitHash;
  const internalRoutePromotionReviewPlanReady = commandCardRoutePlanProofSurfaceReady
    && input.recentComms.latestInternalRoutePlanningCheckpoint?.commitHash === internalRoutePlanningCommitHash
    && input.recentComms.latestInternalRoutePlanningOracleAck?.commitHash === internalRoutePlanningCommitHash;
  const internalRouteAuditPlanningReady = internalRoutePromotionReviewPlanReady
    && input.recentComms.latestInternalRoutePromotionPlanSurfaceCheckpoint?.commitHash === internalRoutePromotionPlanSurfaceCommitHash
    && input.recentComms.latestInternalRoutePromotionPlanSurfaceOracleAck?.commitHash === internalRoutePromotionPlanSurfaceCommitHash;
  const internalRouteAuditPlanningCommitted = internalRouteAuditPlanningReady
    && input.recentComms.latestInternalRouteAuditPlanningCheckpoint?.commitHash === internalRouteAuditPlanningCommitHash
    && input.recentComms.latestInternalRouteAuditPlanningBuilderAck?.commitHash === internalRouteAuditPlanningCommitHash
    && input.recentComms.latestInternalRouteAuditPlanningOracleAck?.commitHash === internalRouteAuditPlanningCommitHash;
  const postAuditPlanningSelectorCommitted = internalRouteAuditPlanningCommitted
    && input.recentComms.latestPostAuditPlanningSelectorCheckpoint?.commitHash === postAuditPlanningSelectorCommitHash
    && input.recentComms.latestPostAuditPlanningSelectorBuilderAck?.commitHash === postAuditPlanningSelectorCommitHash
    && input.recentComms.latestPostAuditPlanningSelectorOracleAck?.commitHash === postAuditPlanningSelectorCommitHash;
  const internalRouteAuditReviewLaneProofReady = postAuditPlanningSelectorCommitted
    && input.recentComms.latestInternalRouteAuditReviewLaneProofCheckpoint?.commitHash === internalRouteAuditReviewLaneProofCommitHash
    && input.recentComms.latestInternalRouteAuditReviewLaneProofOracleAck?.commitHash === internalRouteAuditReviewLaneProofCommitHash;
  const internalRoutePromotionDecisionGatePlanningReady = internalRouteAuditReviewLaneProofReady
    && input.recentComms.latestJamesActionLineDedupCheckpoint?.commitHash === jamesActionLineDedupCommitHash
    && input.recentComms.latestJamesActionLineDedupOracleAck?.commitHash === jamesActionLineDedupCommitHash;
  const internalRoutePromotionDecisionGateProofReady = internalRoutePromotionDecisionGatePlanningReady
    && input.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint?.commitHash === internalRoutePromotionDecisionGateCommitHash
    && input.recentComms.latestInternalRoutePromotionDecisionGateOracleAck?.commitHash === internalRoutePromotionDecisionGateCommitHash;
  const internalRoutePromotionDecisionGateFollowThroughPlanningReady = internalRoutePromotionDecisionGateProofReady
    && input.recentComms.latestInternalRoutePromotionDecisionGateSurfaceCheckpoint?.commitHash === internalRoutePromotionDecisionGateSurfaceCommitHash
    && input.recentComms.latestInternalRoutePromotionDecisionGateSurfaceOracleAck?.commitHash === internalRoutePromotionDecisionGateSurfaceCommitHash;
  const laneLabel = continuationIsStaleSuperseded
    ? continuationDecision.preferredSourceRef || input.recentComms.latestBuilderInstruction?.sourceRef || "current continuation"
    : input.recentComms.latestBuilderInstruction?.sourceRef
    || input.lane.sourceRef
    || input.lane.status
    || "local lane";
  const laneText = continuationIsStaleSuperseded
    ? internalRoutePromotionDecisionGateFollowThroughPlanningReady
      ? "Mission Control internal route/audit promotion decision-gate proof is completed visible context; the active next boundary is one separate no-live-effect internal route/audit promotion decision-gate follow-through planning lane from the visible decision-gate proof only. James is the explicit control point before any real promotion; no route flip, hm-send/live send, execution, runtime, browser, workbench, UI/status action, fetch, POST, provider/model, credential, deploy, money, or trading effect happens here."
      : internalRoutePromotionDecisionGateProofReady
      ? "Mission Control internal route/audit promotion decision-gate proof is inspectable from mission-control-internal-route-audit-review-lane-proof-v0 only. James is the explicit control point before any real promotion; no route flip, hm-send/live send, execution, runtime, browser, workbench, UI/status action, fetch, POST, provider/model, credential, deploy, money, or trading effect happens here."
      : internalRoutePromotionDecisionGatePlanningReady
      ? "Mission Control internal route/audit review-lane proof is accepted completed context; the active next boundary is one separate no-live-effect internal route/audit promotion decision-gate planning lane from the visible audit-review proof only. James is the explicit control point before any real route/audit promotion, route flip, hm-send/live send, execution, runtime, browser, workbench, UI/status action, fetch, POST, provider/model, credential, deploy, money, or trading effect."
      : internalRouteAuditReviewLaneProofReady
      ? "Mission Control internal route/audit review-lane proof is inspectable from mission-control-internal-route-promotion-review-plan-v0 only. No live promotion, route flip, hm-send/live send, execution, runtime, browser, workbench, UI/status action, fetch, POST, provider/model, credential, deploy, money, or trading effect happens here."
      : internalRouteAuditPlanningReady
      ? "Mission Control internal-route promotion/review plan is completed visible context; the active next boundary is separate internal route/audit lane planning from the visible plan only. No send, promotion, route flip, execution, runtime, browser, workbench, UI/status action, fetch, POST, provider/model, credential, deploy, money, or trading effect happens here."
      : internalRoutePromotionReviewPlanReady
      ? "Mission Control internal-route promotion/review plan is inspectable as a local planning-only record from the visible mission-control-command-card-route-plan-follow-through-v0 proof. No send, promotion, route flip, execution, runtime, browser, workbench, UI/status action, fetch, POST, provider/model, credential, deploy, money, or trading effect happens here."
      : commandCardRoutePlanProofSurfaceReady
      ? "Mission Control route-plan follow-through proof is completed visible context: the local workbench renders mission-control-command-card-route-plan-follow-through-v0, and the active next boundary is internal-route promotion/review planning from the visible proof only. No send, promotion, execution, runtime, browser, workbench, UI/status action, fetch, POST, route, provider/model, credential, deploy, money, or trading effect happens here."
      : commandCardFollowThroughProofReady
      ? "Mission Control command-card route-plan follow-through proof is present and ready for Oracle review: it captures the existing coordinationDrafts/internalRoutePreview from the visible command card as local proof only. No send, promotion, execution, runtime, browser, workbench, UI/status action, fetch, POST, route, provider/model, credential, deploy, money, or trading effect happens here."
      : commandCardSurfaceReady
      ? "Mission Control v0 command-card surface is completed visible context; the active next boundary is one dry-run Builder/Oracle route-plan review/follow-through lane from the visible command card. No send, promotion, execution, runtime, browser, workbench, UI/status action, fetch, POST, route, provider/model, credential, deploy, money, or trading effect happens here."
      : commandCardAcceptanceReady
      ? "Mission Control v0 command-card acceptance is the active next boundary: the local answer/surface must expose a concise command card with current lane, why it matters, recent changes, Builder next move, Oracle next move, context-card dirty status, exactly one James-action line, and one dry-run route plan; no runtime, browser, workbench, UI/status action, POST, route, send, or provider action happens here."
      : workbenchSurfaceProofReady
      ? "Mission Control workbench surface proof is the active next boundary: the local New Mira Mission Control section must render mission-control-demo-workbench-proof-v0 from /squidrun/context, including the answer/surface question, completed proof contexts, next step, James control point, and exactly one JAMES ACTION line; no runtime, browser, workbench, UI/status action, write, POST, route, send, or provider action happens here."
      : demoWorkbenchProofReady
      ? "Mission Control demo/workbench proof is inspectable as mission-control-demo-workbench-proof-v0: James can review the local Mission Control answer/surface target for what is happening here and what should happen next from local evidence; no runtime, browser, workbench, UI, status, write, POST, route, send, or provider action happens here."
      : demoWorkbenchPlanningReady
      ? "First inspectable Mission Control demo/workbench proof planning is the next map boundary: James should be able to inspect the local Mission Control answer/surface for what is happening here and what should happen next from local evidence; nothing starts, opens a browser, imports, writes, posts, routes, sends, or executes here."
      : continuityMemoryPlanningReady
      ? "Continuity and memory is the next map boundary: New Mira command context should load sourced restart/current-lane truth and reject stale-only summaries; the completed tool/app action plan remains context, and nothing imports, writes, restarts, or executes here."
      : toolAppActionPlanningReady
      ? "Tool/app action planning from real local evidence is the next map boundary; owner is Builder, James control point is explicit approval before any real tool/app execution, and nothing executes here."
      : directChannelBoundaryReady
      ? "Separate New Mira direct-channel readiness/dry-run planning now aligns to the existing mira-direct-channel-readiness contract: current owner squidrun-telegram-guard-stack stays untouched, future candidate owner is new-mira-direct-channel, and the result is a future James-visible setup/test gate only."
      : continuationSelectorProofCommitted
      ? "Mission Control v1 dry-run coordination/follow-through route planning is the next map-backed product step; no sends or execution."
      : input.recentComms.latestContinuationDelegation?.excerpt
      || input.recentComms.latestBuilderInstruction?.excerpt
      || "Continue the current Mission Control command-context lane."
    : input.recentComms.latestBuilderInstruction?.excerpt
    || input.lane.objective
    || "No current lane objective found.";
  const hardTruth = input.roadmap.hardTruth
    || "Current New Mira is not holy-shit amazing.";
  const firstDemo = input.roadmap.firstDemo
    || "First inspectable demo: Mira Mission Control.";
  const nextTeamMove = continuationIsStaleSuperseded
    ? internalRoutePromotionDecisionGateFollowThroughPlanningReady
      ? "Builder should plan one no-live-effect internal route/audit promotion decision-gate follow-through lane from the visible mission-control-internal-route-audit-promotion-decision-gate-proof-v0 only; Oracle should review that it remains planning-only, no promotion, no route flip, no hm-send/live send, no runtime/browser/workbench/UI/status action, no fetch/POST, no provider/model, no credential/account/token/device/user/external target, no deploy, no money, and no trading."
      : internalRoutePromotionDecisionGateProofReady
      ? "Oracle should review mission-control-internal-route-audit-promotion-decision-gate-proof-v0 from the visible mission-control-internal-route-audit-review-lane-proof-v0 only; Builder should hold it as local planning-only context unless Oracle requests a narrow correction."
      : internalRoutePromotionDecisionGatePlanningReady
      ? "Builder should plan one no-live-effect internal route/audit promotion decision gate from the visible mission-control-internal-route-audit-review-lane-proof-v0 only; Oracle should review that James remains the explicit control point before any real route/audit promotion, route flip, send, runtime/browser/workbench/UI/status action, provider/model call, credential access, deploy, money, or trading effect."
      : internalRouteAuditReviewLaneProofReady
      ? "Oracle should review mission-control-internal-route-audit-review-lane-proof-v0 from the visible mission-control-internal-route-promotion-review-plan-v0; Builder should hold it as local planning-only context unless Oracle requests a narrow correction."
      : internalRouteAuditPlanningReady
      ? "Builder should plan one separate internal route/audit review lane from the visible mission-control-internal-route-promotion-review-plan-v0 only; Oracle should review that it stays planning-only, manual, local, no-send, no-promotion, no-route-flip, and no-execution before any future promotion proposal."
      : internalRoutePromotionReviewPlanReady
      ? "Oracle should review mission-control-internal-route-promotion-review-plan-v0 for source evidence, manual-only boundaries, no-send, no-promotion, no-route-flip, and no-execution; Builder should hold the plan as local context unless Oracle requests a narrow correction."
      : commandCardRoutePlanProofSurfaceReady
      ? "Builder should plan one internal-route promotion/review packet from the visible mission-control-command-card-route-plan-follow-through-v0 proof only; Oracle should review that it stays manual, local, no-send, no-promotion, no-route-flip, and no-execution."
      : commandCardFollowThroughProofReady
      ? "Oracle should review mission-control-command-card-route-plan-follow-through-v0 against the visible command card, coordinationDrafts, and internalRoutePreview; Builder should hold the proof as local context unless Oracle requests a narrow correction."
      : commandCardSurfaceReady
      ? "Builder should prepare one dry-run Builder/Oracle route-plan review/follow-through lane from the visible Mission Control v0 command card; Oracle should review that the follow-through stays local, useful, no-send, no-promotion, and no-execution."
      : commandCardAcceptanceReady
      ? "Builder should accept Mission Control v0 by pinning a concise local command card with current lane/why it matters, recent changes, Builder next move, Oracle next move, context-card dirty status, one James-action line, and one dry-run route plan; Oracle should review the card remains local/no-effect and does not rely on terminal logs."
      : workbenchSurfaceProofReady
      ? "Builder should prove the local New Mira workbench Mission Control section renders mission-control-demo-workbench-proof-v0 from /squidrun/context with the proof id, answer/surface question, completed toolAppActionPlan and continuityMemoryProof context, next step, and James control point; Oracle should review that the surface proof is read-only and performs no /turn POST or live action."
      : demoWorkbenchProofReady
      ? "Builder should review mission-control-demo-workbench-proof-v0 as the first inspectable Mission Control demo/workbench proof record from the local answer/surface, keep completed toolAppActionPlan and continuityMemoryProof as context, and wait for James approval before any runtime, browser, workbench, UI, write, POST, route, send, or execution."
      : demoWorkbenchPlanningReady
      ? "Builder should plan the first inspectable Mission Control demo/workbench proof from the local answer/surface: show what is happening here and what should happen next from local evidence, keep completed toolAppActionPlan and continuityMemoryProof as context, and do not start runtime, open a browser, write, POST, route, send, or execute."
      : continuityMemoryPlanningReady
      ? "Builder should plan the continuity/memory proof for New Mira command context: load sourced restart/current-lane truth, reject stale-only summaries, preserve provenance and James control points, and do not import state, copy .squidrun, write, restart, browse, route, send, or execute."
      : toolAppActionPlanningReady
      ? "Builder should draft one local tool/app action plan from real SquidRun evidence only. Owner: Builder. James control point: explicit review and approval before any app/tool execution. No browsing, app call, tool execution, route, send, or credential access happens in this slice."
      : directChannelBoundaryReady
      ? "Builder should align Mission Control to the existing direct-channel readiness contract: preserve currentOwner=squidrun-telegram-guard-stack, proposedFutureOwner=new-mira-direct-channel, blocked missing/reused candidate cases, and candidate_ready dry-run only with sendReady=false/liveActivationReady=false."
      : continuationSelectorProofCommitted
      ? "Builder should advance Mission Control v1 dry-run coordination/follow-through route planning from local evidence only; Oracle should review that it stays no-send/no-execution before commit."
      : "Builder should finish the continuation-aware Mission Control command-context proof; Oracle should challenge stale-handoff visibility-without-authority; after commit, the team should continue to the next map-backed Mira slice."
    : "Builder should finish the Mission Control v0 proof packet; Oracle should challenge it against the benchmark; after commit, the team should auto-open the next operator-like capability slice.";
  const jamesActionReason = "This is local, inspectable, dry-run Mission Control work; no bot, channel, account, token, external send, or route switch is needed.";
  const foundationVsProduct = "SquidRun context is foundation. The product test is whether Mira can operate as Mission Control for James's AI team.";
  const commandCardBuilderNextMove = "Pin the Mission Control v0 command card from local evidence: current lane/why it matters, recent changes, Builder next move, Oracle next move, context-card dirty status, one James-action line, and a dry-run route plan.";
  const commandCardOracleNextMove = "Review the command card for local evidence, no terminal-log dependency, dirty-context clarity, exactly one James-action line, and no runtime/browser/workbench/UI/status action, POST, route, send, provider/model, credential, deploy, money, or trading effect.";
  const commandCardRoutePlanBuilderMessage = "Prepare the dry-run Builder/Oracle route-plan review/follow-through from the visible Mission Control command card. Use local evidence only; do not send, promote, POST, route, execute, start runtime, open browser/workbench, perform UI/status actions, or call provider/model.";
  const commandCardRoutePlanOracleMessage = "Review the dry-run Builder/Oracle route-plan follow-through from the visible command card for useful next move, local evidence, exactly one James-action line, and no send, promotion, execution, runtime/browser/workbench/UI/status action, POST, route, provider/model, credential, deploy, money, or trading effect.";
  const commandCardRoutePlanProofBuilderMessage = "Hold mission-control-command-card-route-plan-follow-through-v0 as local proof context over the visible command card, coordinationDrafts, and internalRoutePreview. Do not send, promote, POST, route, execute, start runtime, open browser/workbench, perform UI/status actions, or call provider/model.";
  const commandCardRoutePlanProofOracleMessage = "Review mission-control-command-card-route-plan-follow-through-v0 against the visible command card, coordinationDrafts, and internalRoutePreview for exact target/purpose/message, source evidence, James control point, preconditions/no-go conditions, exactly one James-action line, and false live-effect audit flags; do not send, promote, POST, route, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRoutePromotionBuilderMessage = "Plan one internal-route promotion/review packet from the visible mission-control-command-card-route-plan-follow-through-v0 proof only. Keep it local/manual; do not POST, route, send, promote, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRoutePromotionOracleMessage = "Review the internal-route promotion/review plan from the visible mission-control-command-card-route-plan-follow-through-v0 proof for source evidence, manual review boundary, no-send, no-promotion, no-route-flip, no-execution, and exactly one James-action line; do not POST, route, send, promote, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRoutePromotionPlanBuilderMessage = "Hold mission-control-internal-route-promotion-review-plan-v0 as local planning-only context from the visible mission-control-command-card-route-plan-follow-through-v0 proof. Do not POST, route, send, promote, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRoutePromotionPlanOracleMessage = "Review mission-control-internal-route-promotion-review-plan-v0 against the visible mission-control-command-card-route-plan-follow-through-v0 proof for exact target/purpose/body, source evidence, James control point, preconditions/no-go conditions, manual-only/no-send/no-promotion/no-route-flip/no-execution audit flags, and exactly one James-action line; do not POST, route, send, promote, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRouteAuditPlanningBuilderMessage = "Plan one separate internal route/audit review lane from the visible mission-control-internal-route-promotion-review-plan-v0 only for any future promotion proposal. Keep it local/manual; do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRouteAuditPlanningOracleMessage = "Review the internal route/audit lane planning from the visible mission-control-internal-route-promotion-review-plan-v0 for source evidence, James control point, preconditions/no-go conditions, manual-only/no-send/no-promotion/no-route-flip/no-execution boundaries, and exactly one James-action line; do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRouteAuditReviewLaneProofBuilderMessage = "Hold mission-control-internal-route-audit-review-lane-proof-v0 as local planning-only context from mission-control-internal-route-promotion-review-plan-v0. Do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRouteAuditReviewLaneProofOracleMessage = "Review mission-control-internal-route-audit-review-lane-proof-v0 against mission-control-internal-route-promotion-review-plan-v0 for owner Builder, target Oracle, source evidence, James control point, preconditions/no-go conditions, manual-only/no-send/no-promotion/no-route-flip/no-execution audit flags, and exactly one James-action line; do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRoutePromotionDecisionGateBuilderMessage = "Plan one no-live-effect internal route/audit promotion decision gate from the visible mission-control-internal-route-audit-review-lane-proof-v0 only. James is the explicit control point before any real promotion. Do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRoutePromotionDecisionGateOracleMessage = "Review the internal route/audit promotion decision-gate planning lane from the visible mission-control-internal-route-audit-review-lane-proof-v0 only. PASS only if James remains the explicit control point before any real route/audit promotion and all live-effect flags remain false: no POST, route, send, promote, route flip, execution, runtime/browser/workbench/UI/status action, provider/model call, credential access, deploy, money, or trading.";
  const internalRouteAuditPromotionDecisionGateProofBuilderMessage = "Hold mission-control-internal-route-audit-promotion-decision-gate-proof-v0 as local planning-only context from mission-control-internal-route-audit-review-lane-proof-v0. Do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRouteAuditPromotionDecisionGateProofOracleMessage = "Review mission-control-internal-route-audit-promotion-decision-gate-proof-v0 from the visible mission-control-internal-route-audit-review-lane-proof-v0 only for owner Builder, target Oracle, source evidence, James control point before real promotion, preconditions/no-go conditions, manual-only/no-send/no-promotion/no-route-flip/no-execution audit flags, and exactly one James-action line; do not POST, route, send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials, deploy, move money, or touch trading.";
  const internalRouteAuditPromotionDecisionGateFollowThroughBuilderMessage = "Plan one no-live-effect internal route/audit promotion decision-gate follow-through lane from the visible mission-control-internal-route-audit-promotion-decision-gate-proof-v0 only. Keep the completed proof as local visible context; do not POST, route, send, hm-send, promote, flip routes, execute, start runtime, open browser/workbench, perform UI/status actions, call provider/model, touch credentials/accounts/tokens/devices/users/external targets, deploy, move money, or touch trading.";
  const internalRouteAuditPromotionDecisionGateFollowThroughOracleMessage = "Review the internal route/audit promotion decision-gate follow-through planning lane from the visible mission-control-internal-route-audit-promotion-decision-gate-proof-v0 only. PASS only if it is a separate planning lane with James as the explicit control point before any real promotion and all live-effect flags remain false: no POST, fetch, route, send, hm-send, promote, route flip, execution, runtime/browser/workbench/UI/status action, provider/model call, credential/account/token/device/user/external target, deploy, money, or trading.";
  const toolAppActionPlan: SquidRunProjectContext["missionControl"]["toolAppActionPlan"] = toolAppActionPlanningReady
    ? {
        id: "mission-control-tool-app-action-plan-v0",
        status: "planning_only",
        owner: "Builder",
        target: {
          actionCategory: "local_squidrun_evidence_review",
          action: "Inspect local SquidRun Mission Control evidence and prepare the first app/tool action candidate for James review.",
        },
        sourceEvidence: [
          {
            kind: "file",
            path: "docs/mira-north-star-roadmap.md",
            summary: "Roadmap says tool/app action planning must show one local tool/action plan with a clear owner and James-control point.",
          },
          {
            kind: "file",
            path: "docs/mira-system-map.md",
            summary: "System map keeps this lane read-only/no-execution and requires real local evidence before any tool/app action planning.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestContinuationDelegation?.sourceRef || "not found",
            summary: postAuditPlanningSelectorCommitted
              ? "Current Architect delegation keeps internal route/audit planning on the visible plan while 582ef1c6 selector hardening prevents WIP sanity/status/containment/closure rows from becoming active delegation authority."
              : internalRouteAuditPlanningCommitted
              ? "Current Architect delegation keeps internal route/audit planning on the visible plan while c1a05e07 selector hardening prevents red WIP containment rows from becoming active delegation authority."
              : internalRouteAuditPlanningReady
              ? "Current Architect delegation treats the internal-route promotion/review plan as completed visible context and asks for separate internal route/audit lane planning from that visible plan only."
              : internalRoutePromotionReviewPlanReady
              ? "Current Architect delegation asks for one inspectable internal-route promotion/review plan from the visible route-plan follow-through proof only."
              : commandCardRoutePlanProofSurfaceReady
              ? "Current Architect delegation treats the route-plan follow-through proof surface as completed visible context and asks for internal-route promotion/review planning from the visible proof only."
              : commandCardFollowThroughProofReady
              ? "Current Architect delegation treats the command-card route-plan lane as completed context and asks for an inspectable follow-through proof."
              : commandCardSurfaceReady
              ? "Current Architect delegation treats the command-card surface as completed context and asks for a dry-run route-plan review/follow-through lane."
              : commandCardAcceptanceReady
              ? "Current Architect delegation treats the completed proof context as ready for Mission Control v0 command-card acceptance."
              : workbenchSurfaceProofReady
              ? "Current Architect delegation asks Mission Control to keep completed proof context and prove the local workbench surface rendering."
              : demoWorkbenchPlanningReady
              ? "Current Architect delegation asks Mission Control to keep the completed proof context and advance to demo/workbench planning."
              : continuityMemoryPlanningReady
              ? "Current Architect delegation asks Mission Control to treat the tool/app plan as completed context and advance to continuity/memory planning."
              : "Current Architect delegation asks Mission Control to advance from completed readiness alignment into local tool/app action planning.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestDirectChannelReadinessCheckpoint?.sourceRef || "not found",
            commitHash: directChannelReadinessContractCommitHash,
            summary: "Direct-channel readiness alignment is already committed, so this plan does not create or configure a channel.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestDirectChannelReadinessAck?.sourceRef || "not found",
            commitHash: directChannelReadinessContractCommitHash,
            summary: "Builder acknowledged the completed readiness contract before this planning boundary.",
          },
          ...(continuityMemoryPlanningReady
            ? [
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestToolAppActionPlanCheckpoint?.sourceRef || "not found",
                  commitHash: toolAppActionPlanProofCommitHash,
                  summary: "Tool/app action-plan first proof is committed, so this plan is completed Mission Control context.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestToolAppActionPlanAck?.sourceRef || "not found",
                  commitHash: toolAppActionPlanProofCommitHash,
                  summary: "Builder acknowledged the completed tool/app action-plan proof before the continuity/memory boundary.",
                },
              ]
            : []),
        ],
        jamesControlPoint: "James must explicitly review and approve a separate future request before any real app/tool execution.",
        preconditions: [
          "Worktree is clean.",
          "Stale architect#11 handoff is visible but superseded by the committed Mission Control evidence chain.",
          "Direct-channel readiness checkpoint and Builder ACK are source-specific for 22e876dc.",
          "The plan remains a local Mission Control inspection record, not an execution request.",
        ],
        refusalNoGoConditions: [
          "Dirty worktree or missing committed evidence chain.",
          "Any attempt to browse, call an app/tool, POST, route, send, start runtime, touch credentials, deploy, or move money.",
          "Any target that is not a local SquidRun evidence-planning record for Builder review.",
          "Any request to skip James's explicit approval before real execution.",
        ],
        audit: {
          planningOnly: true,
          executed: false,
          browsed: false,
          appToolCalled: false,
          posted: false,
          routed: false,
          sent: false,
          runtimeStarted: false,
          credentialAccessed: false,
          deployed: false,
          moneyMovement: false,
        },
      }
    : null;
  const continuityMemoryProof: SquidRunProjectContext["missionControl"]["continuityMemoryProof"] = continuityMemoryProofReady
    ? {
        id: "mission-control-continuity-memory-proof-v0",
        status: "proof_only",
        owner: "Builder",
        sourceEvidence: [
          {
            kind: "file",
            path: "ui/modules/mira-core/typed-restart-continuity-context-v0.js",
            summary: "Typed restart continuity context is the current sourced restart/current-lane truth contract.",
          },
          {
            kind: "file",
            path: "ui/modules/mira-core/mira-presence-runtime-state-v0.js",
            summary: "Presence runtime state is current SquidRun continuity state, not a New Mira live import.",
          },
          {
            kind: "file",
            path: "ui/modules/startup-ai-briefing.js",
            summary: "Startup briefing materializes sourced restart context and stale markers for current SquidRun startup.",
          },
          {
            kind: "file",
            path: "mira/runtime/src/status.ts",
            summary: "New Mira runtime status exposes continuityLoaded/liveDataImported truth as read-only status provenance.",
          },
          {
            kind: "test",
            path: "ui/__tests__/mira-core-typed-restart-continuity-context-v0.test.js",
            summary: "Focused continuity test coverage anchors sourced restart/current-lane behavior.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestContinuityMemoryBoundaryCheckpoint?.sourceRef || "not found",
            commitHash: continuityMemoryBoundaryCommitHash,
            summary: "Continuity/memory boundary advancement is committed before this proof is exposed.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestContinuityMemoryBoundaryAck?.sourceRef || "not found",
            commitHash: continuityMemoryBoundaryCommitHash,
            summary: "Builder acknowledged the continuity/memory boundary before this proof record.",
          },
          ...(demoWorkbenchPlanningReady
            ? [
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestContinuityMemoryProofCheckpoint?.sourceRef || "not found",
                  commitHash: continuityMemoryProofCommitHash,
                  summary: "Continuity/memory first proof is committed, so this proof record is completed Mission Control context.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestContinuityMemoryProofAck?.sourceRef || "not found",
                  commitHash: continuityMemoryProofCommitHash,
                  summary: "Builder acknowledged the completed continuity/memory proof before the demo/workbench boundary.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestContinuityMemoryProofOracleAck?.sourceRef || "not found",
                  commitHash: continuityMemoryProofCommitHash,
                  summary: "Oracle acknowledged the completed continuity/memory proof before the demo/workbench boundary.",
                },
              ]
            : []),
        ],
        currentLaneTruth: {
          sourcePath: ".squidrun/handoffs/current-lane.json",
          loaded: input.lane.loaded,
          sourceRef: input.lane.sourceRef,
          objective: input.lane.objective,
          nextAction: input.lane.nextAction,
          generatedAt: input.lane.generatedAt,
          authority: "loaded_but_stale_superseded",
        },
        staleOnlySummaryRefusal: {
          refused: true,
          staleSourceRef: continuationDecision.staleSourceRef,
          staleObjective: continuationDecision.staleObjective,
          reason: "The current-lane file is loaded and visible, but Mission Control refuses to treat that stale-only summary as active because clean later checkpoint/ACK/delegation evidence supersedes architect#11.",
        },
        jamesControlPoint: "James must review and approve a separate future continuity promotion before New Mira imports, copies, writes, restarts, or promotes any memory state.",
        preconditions: [
          "Worktree is clean.",
          "Stale architect#11 current-lane truth is loaded with provenance.",
          "Later committed Mission Control chain through bf82cea4 is source-specific and acknowledged.",
          ...(demoWorkbenchPlanningReady
            ? ["Continuity/memory proof checkpoint plus Builder and Oracle ACKs are source-specific for d0bffd58."]
            : []),
          "Continuity evidence is read as local proof context only.",
        ],
        refusalNoGoConditions: [
          "Dirty worktree or missing source-specific bf82cea4 checkpoint/ACK evidence.",
          "Any stale-only summary without later sourced checkpoint/ACK/delegation support.",
          "Any request to import state, copy .squidrun, write memory, restart a process, browse, route, send, POST, call runtime/provider/model, touch credentials, deploy, move money, or touch trading.",
          "Any continuity promotion without James's explicit review and approval.",
        ],
        audit: {
          proofOnly: true,
          planningOnly: true,
          imported: false,
          copied: false,
          wrote: false,
          restarted: false,
          processStarted: false,
          browsed: false,
          appToolCalled: false,
          sent: false,
          routed: false,
          posted: false,
          runtimeStarted: false,
          providerInvoked: false,
          modelInvoked: false,
          accountAccessed: false,
          tokenAccessed: false,
          credentialAccessed: false,
          deviceTouched: false,
          userTargeted: false,
          externalTargeted: false,
          deployed: false,
          moneyMovement: false,
          tradingTouched: false,
        },
      }
    : null;
  const demoWorkbenchProof: SquidRunProjectContext["missionControl"]["demoWorkbenchProof"] = demoWorkbenchProofReady && toolAppActionPlan && continuityMemoryProof
    ? {
        id: "mission-control-demo-workbench-proof-v0",
        status: "proof_planning_only",
        owner: "Builder",
        target: {
          surface: "local_mission_control_answer_surface",
          question: "what is happening here, and what should happen next?",
          action: "Inspect the local Mission Control answer/surface produced from getSquidRunContext without starting runtime, opening a browser, or performing UI/workbench actions.",
        },
        sourceEvidence: [
          {
            kind: "file",
            path: "docs/mira-north-star-roadmap.md",
            summary: "Roadmap names the first inspectable demo as Mission Control answering the current situation and next move from local evidence.",
          },
          {
            kind: "file",
            path: "docs/mira-system-map.md",
            summary: "System map keeps demo/workbench inspection local and blocks runtime/browser/UI/status execution and live effects.",
          },
          {
            kind: "file",
            path: "mira/runtime/src/squidrun-context.ts",
            summary: "SquidRun context source builds the local Mission Control answer, summary, drafts, preview, and proof record.",
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${toolAppActionPlan.id} remains ${toolAppActionPlan.status}.`,
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${continuityMemoryProof.id} remains ${continuityMemoryProof.status}.`,
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestCleanContextSelectionCheckpoint?.sourceRef || "not found",
            commitHash: cleanContextSelectionCommitHash,
            summary: "Clean-context selector hardening is committed before exposing this demo/workbench proof record.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestCleanContextSelectionOracleAck?.sourceRef || "not found",
            commitHash: cleanContextSelectionCommitHash,
            summary: "Oracle acknowledged the clean-context selector hardening before this proof record.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestContinuationDelegation?.sourceRef || "not found",
            summary: commandCardFollowThroughProofReady
              ? "Current Architect delegation treats this demo/workbench proof and command-card acceptance as completed context for route-plan follow-through proof."
              : commandCardSurfaceReady
              ? "Current Architect delegation treats this demo/workbench proof and command-card acceptance as completed context for route-plan follow-through."
              : commandCardAcceptanceReady
              ? "Current Architect delegation treats this demo/workbench proof as completed context for command-card acceptance, not a live workbench action."
              : "Current Architect delegation asks for one inspectable demo/workbench proof record, not a live workbench action.",
          },
        ],
        completedContext: {
          toolAppActionPlanId: "mission-control-tool-app-action-plan-v0",
          continuityMemoryProofId: "mission-control-continuity-memory-proof-v0",
        },
        expectedJamesVisibleChecks: [
          "The local Mission Control answer names what is happening here from local evidence.",
          "The local Mission Control answer names what should happen next without reviving the stale architect#11 objective.",
          "The summary names this concrete demo/workbench proof record.",
          "The record keeps completed toolAppActionPlan and continuityMemoryProof as context.",
          "The audit flags show planning/proof only and no runtime, browser, workbench, UI, network, send, route, provider, credential, deploy, money, or trading effect.",
          "There is exactly one JAMES ACTION line and it remains NONE.",
        ],
        jamesControlPoint: "James must explicitly review and approve a separate future request before anyone starts runtime, opens a browser/workbench, performs UI/status actions, writes state, POSTs, routes, sends, or executes anything from this proof.",
        preconditions: [
          "Worktree is clean.",
          "Stale architect#11 is visible but has no active authority.",
          "Completed toolAppActionPlan and continuityMemoryProof are present as context.",
          "Clean-context selector hardening checkpoint and Oracle ACK are source-specific for 13c90817.",
          "The proof is built from local Mission Control answer/surface evidence only.",
        ],
        refusalNoGoConditions: [
          "Dirty worktree or missing completed context records.",
          "Missing source-specific 13c90817 checkpoint or Oracle ACK.",
          "Any request to start runtime, open a browser/workbench, perform UI/status actions, fetch, POST, route, send, call provider/model, touch accounts/tokens/credentials/devices/users/external targets, deploy, move money, or touch trading.",
          "Any attempt to treat this proof record as live action approval.",
        ],
        audit: {
          proofOnly: true,
          planningOnly: true,
          runtimeStarted: false,
          browserOpened: false,
          workbenchOpened: false,
          uiActionPerformed: false,
          fetched: false,
          posted: false,
          routed: false,
          sent: false,
          providerInvoked: false,
          modelInvoked: false,
          accountAccessed: false,
          tokenAccessed: false,
          credentialAccessed: false,
          deviceTouched: false,
          userTargeted: false,
          externalTargeted: false,
          deployed: false,
          moneyMovement: false,
          tradingTouched: false,
        },
      }
    : null;
  const commandCardAcceptance: SquidRunProjectContext["missionControl"]["commandCardAcceptance"] = commandCardAcceptanceReady && toolAppActionPlan && continuityMemoryProof && demoWorkbenchProof
    ? {
        id: "mission-control-v0-command-card-acceptance",
        status: "acceptance_planning_only",
        owner: "Builder",
        sourceEvidence: [
          {
            kind: "file",
            path: "docs/mira-north-star-roadmap.md",
            summary: "Roadmap acceptance requires a first inspectable Mission Control demo surface James can read without terminal logs.",
          },
          {
            kind: "file",
            path: "docs/mira-system-map.md",
            summary: "System map keeps command-card acceptance local/read-only and blocks runtime, workbench, UI/status, route, send, provider, credential, deploy, money, and trading effects.",
          },
          {
            kind: "file",
            path: "mira/runtime/src/squidrun-context.ts",
            summary: "SquidRun context source builds the command-card acceptance record, answer text, drafts, and reviewed route preview from local evidence.",
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${toolAppActionPlan.id} remains ${toolAppActionPlan.status}.`,
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${continuityMemoryProof.id} remains ${continuityMemoryProof.status}.`,
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${demoWorkbenchProof.id} remains ${demoWorkbenchProof.status}.`,
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestWorkbenchSurfaceProofCheckpoint?.sourceRef || "not found",
            commitHash: workbenchSurfaceProofCommitHash,
            summary: "Workbench surface proof is source-specific and committed before command-card acceptance can advance.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestWorkbenchSurfaceProofOracleAck?.sourceRef || "not found",
            commitHash: workbenchSurfaceProofCommitHash,
            summary: "Oracle acknowledged the committed workbench surface proof before command-card acceptance.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestContinuationDelegation?.sourceRef || "not found",
            summary: postAuditPlanningSelectorCommitted
              ? "Current Architect delegation keeps internal route/audit planning on the visible plan while 582ef1c6 evidence marks WIP sanity/status/containment/closure rows as diagnostic only."
              : internalRouteAuditPlanningCommitted
              ? "Current Architect delegation keeps internal route/audit planning on the visible plan while c1a05e07 evidence marks red WIP containment rows as diagnostic only."
              : internalRouteAuditPlanningReady
              ? "Current Architect delegation treats the internal-route promotion/review plan as completed visible context and asks for separate internal route/audit planning from that visible plan only."
              : internalRoutePromotionReviewPlanReady
              ? "Current Architect delegation asks for one inspectable internal-route promotion/review plan while commandCardAcceptance and route-plan follow-through proof remain completed visible context."
              : commandCardRoutePlanProofSurfaceReady
              ? "Current Architect delegation treats commandCardAcceptance and route-plan follow-through proof as completed visible context and asks for internal-route promotion/review planning from the visible proof only."
              : commandCardFollowThroughProofReady
              ? "Current Architect delegation treats commandCardAcceptance as completed visible context and asks for route-plan follow-through proof."
              : commandCardSurfaceReady
              ? "Current Architect delegation treats the command-card surface as completed context and asks for a dry-run route-plan review/follow-through lane."
              : "Current Architect delegation asks for Mission Control v0 command-card acceptance without live effects.",
          },
          ...(commandCardSurfaceReady
            ? [
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestCommandCardSurfaceCheckpoint?.sourceRef || "not found",
                  commitHash: commandCardSurfaceCommitHash,
                  summary: "Command-card surface rendering is source-specific and committed, so commandCardAcceptance is completed visible context.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestCommandCardSurfaceOracleAck?.sourceRef || "not found",
                  commitHash: commandCardSurfaceCommitHash,
                  summary: "Oracle acknowledged the committed command-card surface before the follow-through route-plan boundary.",
                },
              ]
            : []),
          ...(commandCardRoutePlanProofSurfaceReady
            ? [
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestCommandCardRoutePlanProofSurfaceCheckpoint?.sourceRef || "not found",
                  commitHash: commandCardRoutePlanProofSurfaceCommitHash,
                  summary: "Command-card route-plan proof surface rendering is source-specific and committed, so the proof is completed visible context.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestCommandCardRoutePlanProofSurfaceOracleAck?.sourceRef || "not found",
                  commitHash: commandCardRoutePlanProofSurfaceCommitHash,
                  summary: "Oracle acknowledged the committed route-plan proof surface before the internal-route promotion/review planning boundary.",
                },
              ]
            : []),
        ],
        completedContext: {
          toolAppActionPlanId: "mission-control-tool-app-action-plan-v0",
          continuityMemoryProofId: "mission-control-continuity-memory-proof-v0",
          demoWorkbenchProofId: "mission-control-demo-workbench-proof-v0",
        },
        cardFields: {
          currentLaneWhyItMatters: `Current lane ${continuationDecision.preferredSourceRef || "current continuation"} matters because Mission Control must turn local SquidRun evidence into a James-inspectable command card instead of terminal-log spelunking.`,
          whatChangedRecently: postAuditPlanningSelectorCommitted
            ? `Committed ${postAuditPlanningSelectorCommitHash} post-audit selector evidence (${input.recentComms.latestPostAuditPlanningSelectorCheckpoint?.sourceRef || "not found"} plus Builder ACK ${input.recentComms.latestPostAuditPlanningSelectorBuilderAck?.sourceRef || "not found"} and Oracle ACK ${input.recentComms.latestPostAuditPlanningSelectorOracleAck?.sourceRef || "not found"}) keeps the internal route/audit planning lane on the visible plan while WIP sanity/status/containment/closure rows remain diagnostic only.`
            : internalRouteAuditPlanningCommitted
            ? `Committed ${internalRouteAuditPlanningCommitHash} internal route/audit planning selector evidence (${input.recentComms.latestInternalRouteAuditPlanningCheckpoint?.sourceRef || "not found"} plus Builder ACK ${input.recentComms.latestInternalRouteAuditPlanningBuilderAck?.sourceRef || "not found"} and Oracle ACK ${input.recentComms.latestInternalRouteAuditPlanningOracleAck?.sourceRef || "not found"}) keeps commandCardAcceptance, command-card route-plan follow-through proof, and internal-route promotion/review plan completed visible context; red WIP containment rows are diagnostic only and the next boundary remains internal route/audit planning from the visible plan only.`
            : internalRouteAuditPlanningReady
            ? `Committed ${internalRoutePromotionPlanSurfaceCommitHash} internal-route promotion plan surface evidence (${input.recentComms.latestInternalRoutePromotionPlanSurfaceCheckpoint?.sourceRef || "not found"} plus Oracle ACK ${input.recentComms.latestInternalRoutePromotionPlanSurfaceOracleAck?.sourceRef || "not found"}) keeps commandCardAcceptance, command-card route-plan follow-through proof, and internal-route promotion/review plan completed visible context; the next boundary is separate internal route/audit lane planning from the visible plan only.`
            : internalRoutePromotionReviewPlanReady
            ? `Committed ${internalRoutePlanningCommitHash} internal-route planning evidence (${input.recentComms.latestInternalRoutePlanningCheckpoint?.sourceRef || "not found"} plus Oracle ACK ${input.recentComms.latestInternalRoutePlanningOracleAck?.sourceRef || "not found"}) keeps commandCardAcceptance and command-card route-plan follow-through proof completed visible context; the next boundary is one inspectable internal-route promotion/review plan from the visible proof only.`
            : commandCardRoutePlanProofSurfaceReady
            ? `Committed ${commandCardRoutePlanProofSurfaceCommitHash} route-plan proof surface evidence (${input.recentComms.latestCommandCardRoutePlanProofSurfaceCheckpoint?.sourceRef || "not found"} plus Oracle ACK ${input.recentComms.latestCommandCardRoutePlanProofSurfaceOracleAck?.sourceRef || "not found"}) keeps commandCardAcceptance and command-card route-plan follow-through proof completed visible context; the next boundary is internal-route promotion/review planning from the visible proof only.`
            : commandCardFollowThroughProofReady
            ? `Committed ${commandCardFollowThroughCommitHash} command-card follow-through evidence (${input.recentComms.latestCommandCardFollowThroughCheckpoint?.sourceRef || "not found"} plus Oracle ACK ${input.recentComms.latestCommandCardFollowThroughOracleAck?.sourceRef || "not found"}) keeps commandCardAcceptance completed visible context and exposes a local route-plan follow-through proof for Oracle review.`
            : commandCardSurfaceReady
            ? `Committed ${commandCardSurfaceCommitHash} command-card surface evidence (${input.recentComms.latestCommandCardSurfaceCheckpoint?.sourceRef || "not found"} plus Oracle ACK ${input.recentComms.latestCommandCardSurfaceOracleAck?.sourceRef || "not found"}) makes commandCardAcceptance completed visible context; the next boundary is dry-run route-plan review/follow-through.`
            : `Committed ${workbenchSurfaceProofCommitHash} workbench surface proof evidence (${input.recentComms.latestWorkbenchSurfaceProofCheckpoint?.sourceRef || "not found"} plus Oracle ACK ${input.recentComms.latestWorkbenchSurfaceProofOracleAck?.sourceRef || "not found"}) makes surface rendering completed context; the next acceptance is the command card.`,
          builderNextMove: commandCardBuilderNextMove,
          oracleNextMove: commandCardOracleNextMove,
          contextCardStatus: `Context-card/current dirty-context status: ${input.dirtyWork.summary}`,
          jamesActionLine: "JAMES ACTION: NONE",
          dryRunRoutePlan: {
            target: "oracle",
            purpose: "command-card no-effect review",
            manualExecutionRequired: true,
            sendPerformed: false,
            summary: "Dry-run route plan asks Oracle to review Mission Control v0 command-card fields from local context only; no hm-send, route flip, POST, provider/model call, or external send is performed.",
          },
        },
        jamesControlPoint: "James can inspect the local command card before any future runtime, browser, workbench, UI/status, route, send, provider/model, credential, deploy, money, or trading action is proposed.",
        preconditions: [
          "Worktree is clean.",
          "Stale architect#11 is visible but has no active authority.",
          "Completed toolAppActionPlan, continuityMemoryProof, and demoWorkbenchProof are present as context.",
          "Workbench surface proof checkpoint and Oracle ACK are source-specific for c301c1ac.",
          "The command card is built from local Mission Control answer/surface evidence only.",
        ],
        refusalNoGoConditions: [
          "Dirty worktree or missing completed context records.",
          "Missing source-specific c301c1ac checkpoint or Oracle ACK.",
          "Any request to start runtime, open a browser/workbench, perform UI/status actions, POST, route, send, call provider/model, touch accounts/tokens/credentials/devices/users/external targets, deploy, move money, or touch trading.",
          "Any command card that requires terminal logs instead of local surface/context evidence.",
        ],
        audit: {
          acceptanceOnly: true,
          planningOnly: true,
          runtimeStarted: false,
          browserOpened: false,
          workbenchOpened: false,
          uiActionPerformed: false,
          fetched: false,
          posted: false,
          routed: false,
          sent: false,
          providerInvoked: false,
          modelInvoked: false,
          accountAccessed: false,
          tokenAccessed: false,
          credentialAccessed: false,
          deviceTouched: false,
          userTargeted: false,
          externalTargeted: false,
          deployed: false,
          moneyMovement: false,
          tradingTouched: false,
        },
      }
    : null;
  const oracleLine = input.recentComms.oracleBenchmark?.sourceRef
    ? `Benchmark gate: ${input.recentComms.oracleBenchmark.sourceRef} says current New Mira is not impressive yet; the demo must prove command-layer usefulness.`
    : `Benchmark gate: ${hardTruth} ${firstDemo}`;
  const answerLines = [
    `Project/lane: ${input.projectName} / ${laneLabel}. ${laneText}`,
    ...(continuationIsStaleSuperseded
      ? [
          `Committed seam: ${continuationDecision.committedSeam}; checkpoint ${input.recentComms.latestCommitCheckpoint?.sourceRef || "not found"} and Builder ACK ${input.recentComms.latestBuilderAck?.sourceRef || "not found"} supersede the old handoff.`,
          ...(directChannelBoundaryReady
            ? toolAppActionPlanningReady
              ? [
                `Completed direct-channel readiness evidence: checkpoint ${input.recentComms.latestDirectChannelReadinessCheckpoint?.sourceRef || "not found"} ${directChannelReadinessContractCommitHash} and Builder ACK ${input.recentComms.latestDirectChannelReadinessAck?.sourceRef || "not found"} ${directChannelReadinessContractCommitHash}; the next boundary is tool/app action planning from the roadmap, not execution.`,
                ...(continuityMemoryPlanningReady
                  ? [`Completed tool/app action-plan evidence: checkpoint ${input.recentComms.latestToolAppActionPlanCheckpoint?.sourceRef || "not found"} ${toolAppActionPlanProofCommitHash} and Builder ACK ${input.recentComms.latestToolAppActionPlanAck?.sourceRef || "not found"} ${toolAppActionPlanProofCommitHash}; ${demoWorkbenchPlanningReady ? "the tool/app action plan remains completed context." : "the active next boundary is continuity/memory sourced restart/current-lane proof planning."}`]
                  : []),
                ...(demoWorkbenchPlanningReady
                  ? [`Completed continuity/memory proof evidence: checkpoint ${input.recentComms.latestContinuityMemoryProofCheckpoint?.sourceRef || "not found"} ${continuityMemoryProofCommitHash}, Builder ACK ${input.recentComms.latestContinuityMemoryProofAck?.sourceRef || "not found"} ${continuityMemoryProofCommitHash}, and Oracle ACK ${input.recentComms.latestContinuityMemoryProofOracleAck?.sourceRef || "not found"} ${continuityMemoryProofCommitHash}; continuityMemoryProof remains completed proof-only context while the active next boundary advances to Mission Control demo/workbench proof planning.`]
                  : []),
                ...(demoWorkbenchProof
                  ? [`Demo/workbench proof: ${demoWorkbenchProof.id}; owner ${demoWorkbenchProof.owner}; target ${demoWorkbenchProof.target.surface} asks "${demoWorkbenchProof.target.question}"; completed contexts ${demoWorkbenchProof.completedContext.toolAppActionPlanId} and ${demoWorkbenchProof.completedContext.continuityMemoryProofId}; James control point: ${demoWorkbenchProof.jamesControlPoint}; audit proofOnly=${demoWorkbenchProof.audit.proofOnly}, planningOnly=${demoWorkbenchProof.audit.planningOnly}, runtimeStarted=${demoWorkbenchProof.audit.runtimeStarted}, browserOpened=${demoWorkbenchProof.audit.browserOpened}, workbenchOpened=${demoWorkbenchProof.audit.workbenchOpened}, uiActionPerformed=${demoWorkbenchProof.audit.uiActionPerformed}, fetched=${demoWorkbenchProof.audit.fetched}, posted=${demoWorkbenchProof.audit.posted}, routed=${demoWorkbenchProof.audit.routed}, sent=${demoWorkbenchProof.audit.sent}, providerInvoked=${demoWorkbenchProof.audit.providerInvoked}, modelInvoked=${demoWorkbenchProof.audit.modelInvoked}, accountAccessed=${demoWorkbenchProof.audit.accountAccessed}, tokenAccessed=${demoWorkbenchProof.audit.tokenAccessed}, credentialAccessed=${demoWorkbenchProof.audit.credentialAccessed}, deviceTouched=${demoWorkbenchProof.audit.deviceTouched}, userTargeted=${demoWorkbenchProof.audit.userTargeted}, externalTargeted=${demoWorkbenchProof.audit.externalTargeted}, deployed=${demoWorkbenchProof.audit.deployed}, moneyMovement=${demoWorkbenchProof.audit.moneyMovement}, tradingTouched=${demoWorkbenchProof.audit.tradingTouched}.`]
                  : []),
                ...(workbenchSurfaceProofReady
                  ? commandCardAcceptanceReady
                    ? [`Workbench surface proof evidence: checkpoint ${input.recentComms.latestDemoWorkbenchProofCheckpoint?.sourceRef || "not found"} ${demoWorkbenchProofCommitHash} and Oracle ACK ${input.recentComms.latestDemoWorkbenchProofOracleAck?.sourceRef || "not found"} ${demoWorkbenchProofCommitHash}; demoWorkbenchProof and the c301c1ac surface render proof are completed context for command-card acceptance.`]
                    : [`Workbench surface proof evidence: checkpoint ${input.recentComms.latestDemoWorkbenchProofCheckpoint?.sourceRef || "not found"} ${demoWorkbenchProofCommitHash} and Oracle ACK ${input.recentComms.latestDemoWorkbenchProofOracleAck?.sourceRef || "not found"} ${demoWorkbenchProofCommitHash}; demoWorkbenchProof is completed context and the active next boundary is read-only local surface rendering from /squidrun/context.`]
                  : []),
                ...(commandCardSurfaceReady
                  ? postAuditPlanningSelectorCommitted
                    ? [
                      `Completed internal route/audit planning evidence: checkpoint ${input.recentComms.latestInternalRouteAuditPlanningCheckpoint?.sourceRef || "not found"} ${internalRouteAuditPlanningCommitHash}, Builder ACK ${input.recentComms.latestInternalRouteAuditPlanningBuilderAck?.sourceRef || "not found"} ${internalRouteAuditPlanningCommitHash}, and Oracle ACK ${input.recentComms.latestInternalRouteAuditPlanningOracleAck?.sourceRef || "not found"} ${internalRouteAuditPlanningCommitHash}; red WIP containment rows are diagnostic only while mission-control-internal-route-promotion-review-plan-v0 remains completed visible context and the active next boundary stays internal route/audit planning from the visible plan only.`,
                      `Completed post-audit selector evidence: checkpoint ${input.recentComms.latestPostAuditPlanningSelectorCheckpoint?.sourceRef || "not found"} ${postAuditPlanningSelectorCommitHash}, Builder ACK ${input.recentComms.latestPostAuditPlanningSelectorBuilderAck?.sourceRef || "not found"} ${postAuditPlanningSelectorCommitHash}, and Oracle ACK ${input.recentComms.latestPostAuditPlanningSelectorOracleAck?.sourceRef || "not found"} ${postAuditPlanningSelectorCommitHash}; WIP sanity/status/containment/closure rows are diagnostic only while mission-control-internal-route-promotion-review-plan-v0 remains completed visible context and the active next boundary stays internal route/audit planning from the visible plan only.`,
                    ]
                    : internalRouteAuditPlanningCommitted
                    ? [`Completed internal route/audit planning evidence: checkpoint ${input.recentComms.latestInternalRouteAuditPlanningCheckpoint?.sourceRef || "not found"} ${internalRouteAuditPlanningCommitHash}, Builder ACK ${input.recentComms.latestInternalRouteAuditPlanningBuilderAck?.sourceRef || "not found"} ${internalRouteAuditPlanningCommitHash}, and Oracle ACK ${input.recentComms.latestInternalRouteAuditPlanningOracleAck?.sourceRef || "not found"} ${internalRouteAuditPlanningCommitHash}; red WIP containment rows are diagnostic only while mission-control-internal-route-promotion-review-plan-v0 remains completed visible context and the active next boundary stays internal route/audit planning from the visible plan only.`]
                    : internalRouteAuditPlanningReady
                    ? [`Completed internal-route promotion plan surface evidence: checkpoint ${input.recentComms.latestInternalRoutePromotionPlanSurfaceCheckpoint?.sourceRef || "not found"} ${internalRoutePromotionPlanSurfaceCommitHash} and Oracle ACK ${input.recentComms.latestInternalRoutePromotionPlanSurfaceOracleAck?.sourceRef || "not found"} ${internalRoutePromotionPlanSurfaceCommitHash}; mission-control-internal-route-promotion-review-plan-v0 remains completed visible context while the active next boundary advances to internal route/audit planning from the visible plan only.`]
                    : internalRoutePromotionReviewPlanReady
                    ? [`Completed internal-route planning evidence: checkpoint ${input.recentComms.latestInternalRoutePlanningCheckpoint?.sourceRef || "not found"} ${internalRoutePlanningCommitHash} and Oracle ACK ${input.recentComms.latestInternalRoutePlanningOracleAck?.sourceRef || "not found"} ${internalRoutePlanningCommitHash}; commandCardAcceptance and mission-control-command-card-route-plan-follow-through-v0 remain completed visible context while Mission Control exposes mission-control-internal-route-promotion-review-plan-v0 as a local manual-only/no-send/no-promotion/no-route-flip/no-execution plan.`]
                    : commandCardRoutePlanProofSurfaceReady
                    ? [`Completed route-plan proof surface evidence: checkpoint ${input.recentComms.latestCommandCardRoutePlanProofSurfaceCheckpoint?.sourceRef || "not found"} ${commandCardRoutePlanProofSurfaceCommitHash} and Oracle ACK ${input.recentComms.latestCommandCardRoutePlanProofSurfaceOracleAck?.sourceRef || "not found"} ${commandCardRoutePlanProofSurfaceCommitHash}; commandCardAcceptance and mission-control-command-card-route-plan-follow-through-v0 remain completed visible context while the active next boundary advances to internal-route promotion/review planning from the visible proof only.`]
                    : commandCardFollowThroughProofReady
                    ? [`Completed command-card follow-through evidence: checkpoint ${input.recentComms.latestCommandCardFollowThroughCheckpoint?.sourceRef || "not found"} ${commandCardFollowThroughCommitHash} and Oracle ACK ${input.recentComms.latestCommandCardFollowThroughOracleAck?.sourceRef || "not found"} ${commandCardFollowThroughCommitHash}; commandCardAcceptance remains completed visible context and the route-plan follow-through proof is ready for Oracle review.`]
                    : [`Completed command-card surface evidence: checkpoint ${input.recentComms.latestCommandCardSurfaceCheckpoint?.sourceRef || "not found"} ${commandCardSurfaceCommitHash} and Oracle ACK ${input.recentComms.latestCommandCardSurfaceOracleAck?.sourceRef || "not found"} ${commandCardSurfaceCommitHash}; commandCardAcceptance remains completed visible context while the active next boundary advances to dry-run Builder/Oracle route-plan review/follow-through from the visible command card.`]
                  : []),
                ...(commandCardAcceptance
                  ? [`Command-card acceptance: ${commandCardAcceptance.id}; current lane/why it matters=${commandCardAcceptance.cardFields.currentLaneWhyItMatters}; what changed recently=${commandCardAcceptance.cardFields.whatChangedRecently}; Builder next move=${commandCardAcceptance.cardFields.builderNextMove}; Oracle next move=${commandCardAcceptance.cardFields.oracleNextMove}; ${commandCardAcceptance.cardFields.contextCardStatus}; James-action line=NONE; dry-run route plan=${commandCardAcceptance.cardFields.dryRunRoutePlan.summary}; audit acceptanceOnly=${commandCardAcceptance.audit.acceptanceOnly}, planningOnly=${commandCardAcceptance.audit.planningOnly}, runtimeStarted=${commandCardAcceptance.audit.runtimeStarted}, browserOpened=${commandCardAcceptance.audit.browserOpened}, workbenchOpened=${commandCardAcceptance.audit.workbenchOpened}, uiActionPerformed=${commandCardAcceptance.audit.uiActionPerformed}, fetched=${commandCardAcceptance.audit.fetched}, posted=${commandCardAcceptance.audit.posted}, routed=${commandCardAcceptance.audit.routed}, sent=${commandCardAcceptance.audit.sent}, providerInvoked=${commandCardAcceptance.audit.providerInvoked}, modelInvoked=${commandCardAcceptance.audit.modelInvoked}, accountAccessed=${commandCardAcceptance.audit.accountAccessed}, tokenAccessed=${commandCardAcceptance.audit.tokenAccessed}, credentialAccessed=${commandCardAcceptance.audit.credentialAccessed}, deviceTouched=${commandCardAcceptance.audit.deviceTouched}, userTargeted=${commandCardAcceptance.audit.userTargeted}, externalTargeted=${commandCardAcceptance.audit.externalTargeted}, deployed=${commandCardAcceptance.audit.deployed}, moneyMovement=${commandCardAcceptance.audit.moneyMovement}, tradingTouched=${commandCardAcceptance.audit.tradingTouched}.`]
                  : []),
                ...(internalRoutePromotionDecisionGatePlanningReady
                  ? [`Completed answer-shape closure evidence: checkpoint ${input.recentComms.latestJamesActionLineDedupCheckpoint?.sourceRef || "not found"} ${jamesActionLineDedupCommitHash} and Oracle acceptance ${input.recentComms.latestJamesActionLineDedupOracleAck?.sourceRef || "not found"} ${jamesActionLineDedupCommitHash}; mission-control-internal-route-audit-review-lane-proof-v0 is accepted completed context, and the active next boundary advances to internal route/audit promotion decision-gate planning from the visible audit-review proof only with James as the explicit control point before any real route/audit promotion.`]
                  : []),
                ...(internalRoutePromotionDecisionGateProofReady
                  ? internalRoutePromotionDecisionGateFollowThroughPlanningReady
                    ? [
                      `Completed route/audit decision proof surface evidence: checkpoint ${input.recentComms.latestInternalRoutePromotionDecisionGateSurfaceCheckpoint?.sourceRef || "not found"} ${internalRoutePromotionDecisionGateSurfaceCommitHash} and Oracle acceptance ${input.recentComms.latestInternalRoutePromotionDecisionGateSurfaceOracleAck?.sourceRef || "not found"} ${internalRoutePromotionDecisionGateSurfaceCommitHash}; mission-control-internal-route-audit-promotion-decision-gate-proof-v0 remains completed visible context while the active next boundary advances to one no-live-effect internal route/audit promotion decision-gate follow-through planning lane from that visible proof only.`,
                      `Completed internal route/audit promotion decision-gate proof context: mission-control-internal-route-audit-promotion-decision-gate-proof-v0; source evidence checkpoint ${input.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint?.sourceRef || "not found"} ${internalRoutePromotionDecisionGateCommitHash} plus Oracle ACK ${input.recentComms.latestInternalRoutePromotionDecisionGateOracleAck?.sourceRef || "not found"} ${internalRoutePromotionDecisionGateCommitHash}; completed context=mission-control-internal-route-audit-review-lane-proof-v0; James remains the explicit control point before any future route/audit promotion; follow-through planning is separate, no-promotion, no-route-flip, no-send, no-hm-send, no-runtime/browser/workbench/UI/status action, no-fetch, no-POST, no-provider/model, no-credential/account/token/device/user/external target, no-deploy, no-money, and no-trading.`,
                    ]
                    : [
                    `Completed route/audit decision-gate evidence: checkpoint ${input.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint?.sourceRef || "not found"} ${internalRoutePromotionDecisionGateCommitHash} and Oracle acceptance ${input.recentComms.latestInternalRoutePromotionDecisionGateOracleAck?.sourceRef || "not found"} ${internalRoutePromotionDecisionGateCommitHash}; mission-control-internal-route-audit-promotion-decision-gate-proof-v0 is inspectable from mission-control-internal-route-audit-review-lane-proof-v0 only, with James as the explicit control point before any real route/audit promotion.`,
                    `Internal route/audit promotion decision-gate proof: mission-control-internal-route-audit-promotion-decision-gate-proof-v0; owner=Builder; target=oracle; purpose=internal route/audit promotion decision-gate review; body=${internalRouteAuditPromotionDecisionGateProofOracleMessage}; source evidence checkpoint ${input.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint?.sourceRef || "not found"} ${internalRoutePromotionDecisionGateCommitHash} plus Oracle ACK ${input.recentComms.latestInternalRoutePromotionDecisionGateOracleAck?.sourceRef || "not found"} ${internalRoutePromotionDecisionGateCommitHash}; completed context=mission-control-internal-route-audit-review-lane-proof-v0; James control point: James must explicitly review and approve a separate future route/audit promotion before any real promotion, route flip, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed; audit planningOnly=true, manualOnly=true, sendPerformed=false, promotionPerformed=false, routeFlip=false, runtimeExecutes=false, runtimeStarted=false, browserOpened=false, workbenchOpened=false, uiActionPerformed=false, fetched=false, posted=false, routed=false, sent=false, providerInvoked=false, modelInvoked=false, accountAccessed=false, tokenAccessed=false, credentialAccessed=false, deviceTouched=false, userTargeted=false, externalTargeted=false, deployed=false, moneyMovement=false, tradingTouched=false.`,
                  ]
                  : []),
                ...(commandCardFollowThroughProofReady
                  ? [`Route-plan follow-through proof: mission-control-command-card-route-plan-follow-through-v0; target=oracle; purpose=${commandCardRoutePlanProofSurfaceReady ? "internal-route promotion no-send review" : "command-card route-plan proof review"}; message=${commandCardRoutePlanProofSurfaceReady ? internalRoutePromotionOracleMessage : commandCardRoutePlanProofOracleMessage}; source evidence checkpoint ${input.recentComms.latestCommandCardFollowThroughCheckpoint?.sourceRef || "not found"} ${commandCardFollowThroughCommitHash} plus Oracle ACK ${input.recentComms.latestCommandCardFollowThroughOracleAck?.sourceRef || "not found"} ${commandCardFollowThroughCommitHash}${commandCardRoutePlanProofSurfaceReady ? ` plus visible-surface checkpoint ${input.recentComms.latestCommandCardRoutePlanProofSurfaceCheckpoint?.sourceRef || "not found"} ${commandCardRoutePlanProofSurfaceCommitHash} and Oracle ACK ${input.recentComms.latestCommandCardRoutePlanProofSurfaceOracleAck?.sourceRef || "not found"} ${commandCardRoutePlanProofSurfaceCommitHash}` : ""}; completed context=${commandCardAcceptance?.id || "not found"}; James control point: James can inspect this local proof before any future route, send, promotion, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed; audit proofOnly=true, planningOnly=true, runtimeStarted=false, browserOpened=false, workbenchOpened=false, uiActionPerformed=false, fetched=false, posted=false, routed=false, sent=false, providerInvoked=false, modelInvoked=false, accountAccessed=false, tokenAccessed=false, credentialAccessed=false, deviceTouched=false, userTargeted=false, externalTargeted=false, deployed=false, moneyMovement=false, tradingTouched=false.`]
                  : []),
                ...(internalRoutePromotionReviewPlanReady
                  ? [`Internal-route promotion/review plan: mission-control-internal-route-promotion-review-plan-v0; owner=Builder; target=oracle; purpose=internal-route promotion no-send review; body=${internalRoutePromotionOracleMessage}; source evidence checkpoint ${input.recentComms.latestInternalRoutePlanningCheckpoint?.sourceRef || "not found"} ${internalRoutePlanningCommitHash} plus Oracle ACK ${input.recentComms.latestInternalRoutePlanningOracleAck?.sourceRef || "not found"} ${internalRoutePlanningCommitHash}${internalRouteAuditPlanningReady ? ` plus visible-plan surface checkpoint ${input.recentComms.latestInternalRoutePromotionPlanSurfaceCheckpoint?.sourceRef || "not found"} ${internalRoutePromotionPlanSurfaceCommitHash} and Oracle ACK ${input.recentComms.latestInternalRoutePromotionPlanSurfaceOracleAck?.sourceRef || "not found"} ${internalRoutePromotionPlanSurfaceCommitHash}` : ""}${internalRouteAuditPlanningCommitted ? ` plus audit-planning checkpoint ${input.recentComms.latestInternalRouteAuditPlanningCheckpoint?.sourceRef || "not found"} ${internalRouteAuditPlanningCommitHash}, Builder ACK ${input.recentComms.latestInternalRouteAuditPlanningBuilderAck?.sourceRef || "not found"} ${internalRouteAuditPlanningCommitHash}, and Oracle ACK ${input.recentComms.latestInternalRouteAuditPlanningOracleAck?.sourceRef || "not found"} ${internalRouteAuditPlanningCommitHash}` : ""}; completed contexts=${commandCardAcceptance?.id || "not found"} and mission-control-command-card-route-plan-follow-through-v0; James control point: James can inspect this local plan before any future promotion, route, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed; audit planningOnly=true, manualOnly=true, sendPerformed=false, promotionPerformed=false, routeFlip=false, runtimeExecutes=false, runtimeStarted=false, browserOpened=false, workbenchOpened=false, uiActionPerformed=false, fetched=false, posted=false, routed=false, sent=false, providerInvoked=false, modelInvoked=false, accountAccessed=false, tokenAccessed=false, credentialAccessed=false, deviceTouched=false, userTargeted=false, externalTargeted=false, deployed=false, moneyMovement=false, tradingTouched=false.`]
                  : []),
                ...(internalRouteAuditReviewLaneProofReady
                  ? [`Internal route/audit review-lane proof: mission-control-internal-route-audit-review-lane-proof-v0; owner=Builder; target=oracle; purpose=internal route/audit planning review; body=${internalRouteAuditReviewLaneProofOracleMessage}; source evidence checkpoint ${input.recentComms.latestInternalRouteAuditReviewLaneProofCheckpoint?.sourceRef || "not found"} ${internalRouteAuditReviewLaneProofCommitHash} plus Oracle ACK ${input.recentComms.latestInternalRouteAuditReviewLaneProofOracleAck?.sourceRef || "not found"} ${internalRouteAuditReviewLaneProofCommitHash}; completed context=mission-control-internal-route-promotion-review-plan-v0; James control point: James must explicitly review and approve a separate future route/audit promotion before any real promotion, route flip, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed; audit planningOnly=true, manualOnly=true, sendPerformed=false, promotionPerformed=false, routeFlip=false, runtimeExecutes=false, runtimeStarted=false, browserOpened=false, workbenchOpened=false, uiActionPerformed=false, fetched=false, posted=false, routed=false, sent=false, providerInvoked=false, modelInvoked=false, accountAccessed=false, tokenAccessed=false, credentialAccessed=false, deviceTouched=false, userTargeted=false, externalTargeted=false, deployed=false, moneyMovement=false, tradingTouched=false.`]
                  : []),
                ...(continuityMemoryProof
                  ? [`Continuity/memory proof: ${continuityMemoryProof.id}; owner ${continuityMemoryProof.owner}; current-lane truth ${continuityMemoryProof.currentLaneTruth.sourceRef || "not found"} is ${continuityMemoryProof.currentLaneTruth.authority}; stale-only summary refused=${continuityMemoryProof.staleOnlySummaryRefusal.refused}; James control point: ${continuityMemoryProof.jamesControlPoint}; audit proofOnly=${continuityMemoryProof.audit.proofOnly}, imported=${continuityMemoryProof.audit.imported}, copied=${continuityMemoryProof.audit.copied}, wrote=${continuityMemoryProof.audit.wrote}, restarted=${continuityMemoryProof.audit.restarted}, processStarted=${continuityMemoryProof.audit.processStarted}, browsed=${continuityMemoryProof.audit.browsed}, sent=${continuityMemoryProof.audit.sent}, routed=${continuityMemoryProof.audit.routed}, posted=${continuityMemoryProof.audit.posted}, runtimeStarted=${continuityMemoryProof.audit.runtimeStarted}, providerInvoked=${continuityMemoryProof.audit.providerInvoked}, modelInvoked=${continuityMemoryProof.audit.modelInvoked}, accountAccessed=${continuityMemoryProof.audit.accountAccessed}, tokenAccessed=${continuityMemoryProof.audit.tokenAccessed}, credentialAccessed=${continuityMemoryProof.audit.credentialAccessed}, deviceTouched=${continuityMemoryProof.audit.deviceTouched}, userTargeted=${continuityMemoryProof.audit.userTargeted}, externalTargeted=${continuityMemoryProof.audit.externalTargeted}, deployed=${continuityMemoryProof.audit.deployed}, moneyMovement=${continuityMemoryProof.audit.moneyMovement}, tradingTouched=${continuityMemoryProof.audit.tradingTouched}.`]
                  : []),
                toolAppActionPlan
                  ? `${continuityMemoryPlanningReady ? "Completed tool/app action plan context" : "Tool/app action plan"}: ${toolAppActionPlan.target.actionCategory} -> ${toolAppActionPlan.target.action}; owner ${toolAppActionPlan.owner}; James control point: ${toolAppActionPlan.jamesControlPoint}; audit planningOnly=${toolAppActionPlan.audit.planningOnly}, executed=${toolAppActionPlan.audit.executed}, browsed=${toolAppActionPlan.audit.browsed}, appToolCalled=${toolAppActionPlan.audit.appToolCalled}, routed=${toolAppActionPlan.audit.routed}, sent=${toolAppActionPlan.audit.sent}, runtimeStarted=${toolAppActionPlan.audit.runtimeStarted}, credentialAccessed=${toolAppActionPlan.audit.credentialAccessed}, deployed=${toolAppActionPlan.audit.deployed}, moneyMovement=${toolAppActionPlan.audit.moneyMovement}.`
                  : "",
              ]
              : [
                `Stabilized v1 evidence: delegation ${input.recentComms.latestV1AlignmentDelegation?.sourceRef || "not found"}, alignment checkpoint ${input.recentComms.latestV1AlignmentCheckpoint?.sourceRef || "not found"} ${v1RoutePreviewAlignmentCommitHash}, evidence-window checkpoint ${input.recentComms.latestEvidenceWindowCheckpoint?.sourceRef || "not found"} ${commsEvidenceWindowCommitHash}; the next boundary is separate direct-channel readiness/dry-run planning behind Telegram guard truth.`,
                "Readiness contract: ui/modules/mira-direct-channel-readiness.js blocks missing candidate config and current-channel reuse; a valid separate candidate is candidate_ready/dryRun only, never send-ready or activation-ready.",
              ]
            : continuationSelectorProofCommitted
            ? [`Selector proof: ${input.recentComms.latestContinuationSelectorCheckpoint?.sourceRef || "not found"} ${continuationSelectorCommitHash} is committed, so the next move advances to Mission Control v1 dry-run coordination/follow-through route planning.`]
            : []),
          `Stale handoff: ${continuationDecision.staleSourceRef} "${continuationDecision.staleObjective || "old lane"}" is stale/superseded evidence only; it has no active authority.`,
        ]
      : []),
    `Dirty work: ${input.dirtyWork.summary}`,
    oracleLine,
    `Foundation vs product: ${foundationVsProduct}`,
    `Next team move: ${nextTeamMove}`,
    `JAMES ACTION: NONE - ${jamesActionReason}`,
  ];
  const coordinationDrafts: SquidRunProjectContext["missionControl"]["coordinationDrafts"] = [
    {
      target: "builder",
      purpose: internalRoutePromotionDecisionGateFollowThroughPlanningReady
        ? "internal route/audit promotion decision-gate follow-through planning"
        : internalRoutePromotionDecisionGateProofReady
        ? "internal route/audit promotion decision-gate proof context"
        : internalRoutePromotionDecisionGatePlanningReady
        ? "internal route/audit promotion decision-gate planning"
        : internalRouteAuditReviewLaneProofReady
        ? "internal route/audit proof context"
        : internalRouteAuditPlanningReady
        ? "internal route/audit planning context"
        : internalRoutePromotionReviewPlanReady
        ? "internal-route promotion plan context"
        : commandCardRoutePlanProofSurfaceReady
        ? "internal-route promotion planning"
        : commandCardFollowThroughProofReady
        ? "command-card route-plan proof context"
        : commandCardSurfaceReady
        ? "command-card route-plan follow-through"
        : commandCardAcceptanceReady
        ? "command-card acceptance"
        : workbenchSurfaceProofReady
        ? "workbench surface proof"
        : demoWorkbenchProofReady
        ? "demo/workbench proof record"
        : demoWorkbenchPlanningReady
        ? "demo/workbench proof planning"
        : continuityMemoryPlanningReady
        ? "continuity/memory proof planning"
        : toolAppActionPlanningReady
        ? "tool/app action plan draft"
        : directChannelBoundaryReady
        ? "direct-channel readiness planning"
        : continuationSelectorProofCommitted ? "v1 dry-run planning" : "implementation",
      message: internalRoutePromotionDecisionGateFollowThroughPlanningReady
        ? internalRouteAuditPromotionDecisionGateFollowThroughBuilderMessage
        : internalRoutePromotionDecisionGateProofReady
        ? internalRouteAuditPromotionDecisionGateProofBuilderMessage
        : internalRoutePromotionDecisionGatePlanningReady
        ? internalRoutePromotionDecisionGateBuilderMessage
        : internalRouteAuditReviewLaneProofReady
        ? internalRouteAuditReviewLaneProofBuilderMessage
        : internalRouteAuditPlanningReady
        ? internalRouteAuditPlanningBuilderMessage
        : internalRoutePromotionReviewPlanReady
        ? internalRoutePromotionPlanBuilderMessage
        : commandCardRoutePlanProofSurfaceReady
        ? internalRoutePromotionBuilderMessage
        : commandCardFollowThroughProofReady
        ? commandCardRoutePlanProofBuilderMessage
        : commandCardSurfaceReady
        ? commandCardRoutePlanBuilderMessage
        : commandCardAcceptanceReady
        ? commandCardBuilderNextMove
        : workbenchSurfaceProofReady
        ? "Prove the local New Mira workbench Mission Control section renders mission-control-demo-workbench-proof-v0 from /squidrun/context with proof id, answer/surface question, completed toolAppActionPlan and continuityMemoryProof context, next step, James control point, and exactly one JAMES ACTION line. Use read-only UI boot coverage only; do not start runtime, open browser/workbench, perform UI/status actions, fetch beyond mocked local GET, POST, route, send, write, or execute."
        : demoWorkbenchProofReady
        ? "Review mission-control-demo-workbench-proof-v0 as the first inspectable Mission Control demo/workbench proof record from the local answer/surface. Keep completed toolAppActionPlan and continuityMemoryProof as context; do not start runtime, open browser/workbench, perform UI/status actions, fetch, POST, route, send, write, or execute."
        : demoWorkbenchPlanningReady
        ? "Plan the first inspectable Mission Control demo/workbench proof from local answer/surface evidence: show what is happening here and what should happen next, keep completed toolAppActionPlan and continuityMemoryProof as context, and do not start runtime, open browser, perform UI/status actions, POST, route, send, write, import, or execute."
        : continuityMemoryPlanningReady
        ? "Plan one New Mira command-context continuity/memory proof from sourced restart/current-lane truth. Reject stale-only summaries, keep provenance and James control points explicit, and do not import state, copy .squidrun, write, restart, browse, route, send, or execute."
        : toolAppActionPlanningReady
        ? "Draft one Mission Control tool/app action plan from real local SquidRun evidence only. Owner: Builder. James control point: explicit approval before any app/tool execution. Do not execute, browse, POST, route, send, start runtime, or touch credentials."
        : directChannelBoundaryReady
        ? "Align Mission Control with the existing direct-channel readiness contract: currentOwner=squidrun-telegram-guard-stack, proposedFutureOwner=new-mira-direct-channel, missing/reused candidate blocked, valid separate candidate candidate_ready/dryRun only, sendReady=false, liveActivationReady=false."
        : continuationSelectorProofCommitted
        ? "Advance Mission Control v1 dry-run coordination/follow-through route planning from local evidence only; keep it inspectable and no-send/no-execution."
        : "Build Mission Control v0 from local SquidRun evidence: lane, git dirt, map/roadmap truth, owned-work continuation, and recent Architect/Oracle checkpoints. Keep sends dry-run.",
    },
    {
      target: "oracle",
      purpose: internalRoutePromotionDecisionGateFollowThroughPlanningReady
        ? "internal route/audit promotion decision-gate follow-through no-effect review"
        : internalRoutePromotionDecisionGateProofReady
        ? "internal route/audit promotion decision-gate proof review"
        : internalRoutePromotionDecisionGatePlanningReady
        ? "internal route/audit promotion decision-gate no-effect review"
        : internalRouteAuditReviewLaneProofReady
        ? "internal route/audit proof review"
        : internalRouteAuditPlanningReady
        ? "internal route/audit planning review"
        : internalRoutePromotionReviewPlanReady
        ? "internal-route promotion plan review"
        : commandCardRoutePlanProofSurfaceReady
        ? "internal-route promotion no-send review"
        : commandCardFollowThroughProofReady
        ? "command-card route-plan proof review"
        : commandCardSurfaceReady
        ? "command-card route-plan no-effect review"
        : commandCardAcceptanceReady
        ? "command-card no-effect review"
        : workbenchSurfaceProofReady
        ? "workbench surface no-effect review"
        : demoWorkbenchProofReady
        ? "demo/workbench proof no-effect review"
        : demoWorkbenchPlanningReady
        ? "demo/workbench no-effect review"
        : continuityMemoryPlanningReady
        ? "continuity/memory no-effect review"
        : toolAppActionPlanningReady
        ? "tool/app no-execution review"
        : directChannelBoundaryReady
        ? "direct-channel dry-run review"
        : continuationSelectorProofCommitted ? "v1 no-send review" : "benchmark review",
      message: internalRoutePromotionDecisionGateFollowThroughPlanningReady
        ? internalRouteAuditPromotionDecisionGateFollowThroughOracleMessage
        : internalRoutePromotionDecisionGateProofReady
        ? internalRouteAuditPromotionDecisionGateProofOracleMessage
        : internalRoutePromotionDecisionGatePlanningReady
        ? internalRoutePromotionDecisionGateOracleMessage
        : internalRouteAuditReviewLaneProofReady
        ? internalRouteAuditReviewLaneProofOracleMessage
        : internalRouteAuditPlanningReady
        ? internalRouteAuditPlanningOracleMessage
        : internalRoutePromotionReviewPlanReady
        ? internalRoutePromotionPlanOracleMessage
        : commandCardRoutePlanProofSurfaceReady
        ? internalRoutePromotionOracleMessage
        : commandCardFollowThroughProofReady
        ? commandCardRoutePlanProofOracleMessage
        : commandCardSurfaceReady
        ? commandCardRoutePlanOracleMessage
        : commandCardAcceptanceReady
        ? commandCardOracleNextMove
        : workbenchSurfaceProofReady
        ? "Review that the local Mission Control workbench surface displays mission-control-demo-workbench-proof-v0 from mocked /squidrun/context, keeps completed proof records as context, shows the next step/control point and exactly one JAMES ACTION line, and performs no /turn POST, runtime start, browser/workbench open, live UI/status action, route, send, provider/model, credential, deploy, money, or trading effect."
        : demoWorkbenchProofReady
        ? "Review that mission-control-demo-workbench-proof-v0 is inspectable from the local Mission Control answer/surface, names expected James-visible checks, keeps completed proof records as context, and claims no runtime start, browser/workbench open, UI/status execution, fetch, POST, route, send, write, provider/model, credential, deploy, money, or trading effect."
        : demoWorkbenchPlanningReady
        ? "Review that the demo/workbench plan is inspectable from the local Mission Control answer/surface, keeps completed proof records as context, and claims no runtime start, browser open, UI/status execution, write, POST, route, send, import, or live effect."
        : continuityMemoryPlanningReady
        ? "Review that the continuity/memory plan loads sourced restart/current-lane truth, rejects stale-only summaries, keeps the completed tool/app plan as context, and claims no import, write, restart, route, send, or execution."
        : toolAppActionPlanningReady
        ? "Review that the tool/app action plan names a real local-evidence basis, owner, and James control point, and that it remains planning-only with no execution or live-effect claim."
        : directChannelBoundaryReady
        ? "Review Mission Control against mira-direct-channel-readiness.test.js: no token/env read, no bot/chat creation, no Telegram send, no route-owner flip, no provider/model/runtime start, and JAMES ACTION remains NONE."
        : continuationSelectorProofCommitted
        ? "Review Mission Control v1 for no-send/no-execution boundaries and useful next-move specificity before commit."
        : "Challenge Mission Control v0 against the external-agent benchmark. PASS only if it is more useful than a context card and does not overclaim current New Mira.",
    },
  ];
  const selectedDraft = coordinationDrafts.find((draft) => draft.target === "oracle") ?? coordinationDrafts[0]!;
  const evidence = [
    ".squidrun/link.json",
    ".squidrun/handoffs/current-lane.json",
    ".squidrun/runtime/agent-task-queue.json",
    "git status --short",
    "docs/mira-system-map.md",
    ...(demoWorkbenchPlanningReady
      ? [
          "mira/runtime/src/squidrun-context.ts",
          "ui/__tests__/mira-runtime-squidrun-context.test.js",
        ]
      : []),
    ...(workbenchSurfaceProofReady
      ? [
          "mira/ui/app.js",
          "mira/ui/index.html",
          "ui/__tests__/mira-runtime-ui-read-only-boot.test.js",
        ]
      : []),
    ...(directChannelBoundaryReady
      ? [
          "ui/modules/mira-direct-channel-readiness.js",
          "ui/__tests__/mira-direct-channel-readiness.test.js",
        ]
      : []),
    ...(continuityMemoryPlanningReady
      ? [
          "ui/modules/mira-core/typed-restart-continuity-context-v0.js",
          "ui/modules/mira-core/mira-presence-runtime-state-v0.js",
          "mira/runtime/src/status.ts",
        ]
      : []),
    "docs/mira-north-star-roadmap.md",
    `hm-comms history --last ${commsHistoryEvidenceLimit} --json`,
    continuationIsStaleSuperseded ? continuationDecision.reason : input.fallbackNextStep,
  ].filter(Boolean);
  const routePlan = planManualBridgeRequest({
    targetRole: selectedDraft.target,
    content: selectedDraft.message,
    messageId: "mira-mission-control-route-preview-v0",
    requestId: "req-mira-mission-control-route-preview-v0",
    evidence: evidence.slice(0, 10).map((item) => {
      const text = String(item);
      const isFile = text.includes(".") || text.includes("/");
      return {
        kind: isFile ? "file" : "summary",
        ...(isFile ? { path: text } : {}),
        summary: text,
      };
    }),
  });
  const commandCardRoutePlanProofPurpose = commandCardRoutePlanProofSurfaceReady
    ? "internal-route promotion no-send review"
    : "command-card route-plan proof review";
  const commandCardRoutePlanProofMessage = commandCardRoutePlanProofSurfaceReady
    ? internalRoutePromotionOracleMessage
    : commandCardRoutePlanProofOracleMessage;
  const commandCardRoutePlanFollowThroughProof: SquidRunProjectContext["missionControl"]["commandCardRoutePlanFollowThroughProof"] = commandCardFollowThroughProofReady && commandCardAcceptance
    ? {
        id: "mission-control-command-card-route-plan-follow-through-v0",
        status: "proof_ready_for_oracle_review",
        owner: "Builder",
        routePlan: {
          target: "oracle",
          purpose: commandCardRoutePlanProofPurpose,
          message: commandCardRoutePlanProofMessage,
          body: commandCardRoutePlanProofMessage,
          manualExecutionRequired: true,
          runtimeExecutes: false,
          sendPerformed: false,
        },
        sourceEvidence: [
          {
            kind: "file",
            path: "docs/mira-system-map.md",
            summary: "System map keeps command-card route-plan follow-through as local proof over existing drafts/preview with no live route or send authority.",
          },
          {
            kind: "file",
            path: "mira/runtime/src/squidrun-context.ts",
            summary: "SquidRun context source builds the command-card acceptance, coordinationDrafts, internalRoutePreview, and follow-through proof record.",
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${commandCardAcceptance.id} remains ${commandCardAcceptance.status}.`,
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestContinuationDelegation?.sourceRef || "not found",
            summary: commandCardRoutePlanProofSurfaceReady
              ? "Current Architect delegation treats the route-plan proof surface as completed context and asks for internal-route promotion/review planning from the visible proof only."
              : "Current Architect delegation asks for a no-live-effect route-plan follow-through proof over existing coordinationDrafts/internalRoutePreview.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestCommandCardFollowThroughCheckpoint?.sourceRef || "not found",
            commitHash: commandCardFollowThroughCommitHash,
            summary: "Command-card follow-through checkpoint is source-specific before exposing the route-plan proof.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestCommandCardFollowThroughOracleAck?.sourceRef || "not found",
            commitHash: commandCardFollowThroughCommitHash,
            summary: "Oracle acknowledged the committed command-card follow-through before this proof record.",
          },
          {
            kind: "summary",
            summary: `Existing command-card route-plan proof target=oracle, purpose=${commandCardRoutePlanProofPurpose}, manualExecutionRequired=true, runtimeExecutes=false.`,
          },
          ...(commandCardRoutePlanProofSurfaceReady
            ? [
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestCommandCardRoutePlanProofSurfaceCheckpoint?.sourceRef || "not found",
                  commitHash: commandCardRoutePlanProofSurfaceCommitHash,
                  summary: "Route-plan proof surface rendering is committed before internal-route promotion/review planning can advance.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestCommandCardRoutePlanProofSurfaceOracleAck?.sourceRef || "not found",
                  commitHash: commandCardRoutePlanProofSurfaceCommitHash,
                  summary: "Oracle acknowledged the committed route-plan proof surface before internal-route promotion/review planning.",
                },
              ]
            : []),
        ],
        completedContext: {
          commandCardAcceptanceId: "mission-control-v0-command-card-acceptance",
        },
        jamesControlPoint: "James can inspect this local proof before any future route, send, promotion, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.",
        preconditions: [
          "Worktree is clean.",
          "commandCardAcceptance is present as completed visible context.",
          "df0a47a6 checkpoint and Oracle ACK are source-specific and not report/name-drop rows.",
          ...(commandCardRoutePlanProofSurfaceReady
            ? ["120806b4 route-plan proof surface checkpoint and Oracle ACK are source-specific and not report/name-drop rows."]
            : []),
          "coordinationDrafts/internalRoutePreview are already reviewed_preview_only and manual.",
          "The proof is local evidence only, not a route system or execution request.",
        ],
        refusalNoGoConditions: [
          "Dirty worktree or missing commandCardAcceptance.",
          "Missing source-specific df0a47a6 checkpoint or Oracle ACK.",
          ...(commandCardRoutePlanProofSurfaceReady
            ? ["Missing source-specific 120806b4 route-plan proof surface checkpoint or Oracle ACK."]
            : []),
          "Any report/checkpoint/name-drop row trying to replace the active delegation or df0a47a6 authority.",
          "Any request to start runtime, open browser/workbench, perform UI/status actions, fetch, POST, route, send, call provider/model, touch accounts/tokens/credentials/devices/users/external targets, deploy, move money, or touch trading.",
          "Any attempt to treat this proof record as live route/send approval.",
        ],
        audit: {
          proofOnly: true,
          planningOnly: true,
          runtimeStarted: false,
          browserOpened: false,
          workbenchOpened: false,
          uiActionPerformed: false,
          fetched: false,
          posted: false,
          routed: false,
          sent: false,
          providerInvoked: false,
          modelInvoked: false,
          accountAccessed: false,
          tokenAccessed: false,
          credentialAccessed: false,
          deviceTouched: false,
          userTargeted: false,
          externalTargeted: false,
          deployed: false,
          moneyMovement: false,
          tradingTouched: false,
        },
      }
    : null;
  const internalRoutePromotionReviewPlan: SquidRunProjectContext["missionControl"]["internalRoutePromotionReviewPlan"] = internalRoutePromotionReviewPlanReady && commandCardAcceptance && commandCardRoutePlanFollowThroughProof
    ? {
        id: "mission-control-internal-route-promotion-review-plan-v0",
        status: "planning_only_ready_for_oracle_review",
        owner: "Builder",
        target: {
          role: "oracle",
          purpose: "internal-route promotion no-send review",
          message: internalRoutePromotionOracleMessage,
          body: internalRoutePromotionOracleMessage,
          manualExecutionRequired: true,
          runtimeExecutes: false,
          sendPerformed: false,
          promotionPerformed: false,
          routeFlip: false,
        },
        sourceEvidence: [
          {
            kind: "file",
            path: "docs/mira-system-map.md",
            summary: "System map keeps this internal-route promotion/review plan local, manual-only, no-send, no-promotion, no-route-flip, and no-execution.",
          },
          {
            kind: "file",
            path: "mira/runtime/src/squidrun-context.ts",
            summary: "SquidRun context source builds the internal-route promotion/review plan from completed visible Mission Control proof context.",
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${commandCardAcceptance.id} remains ${commandCardAcceptance.status}.`,
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${commandCardRoutePlanFollowThroughProof.id} remains ${commandCardRoutePlanFollowThroughProof.status}.`,
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestContinuationDelegation?.sourceRef || "not found",
            summary: internalRouteAuditPlanningReady
              ? "Current Architect delegation treats this plan as completed visible context and asks for separate internal route/audit lane planning from the visible plan only."
              : "Current Architect delegation asks for the first inspectable internal-route promotion/review plan from the visible route-plan follow-through proof only.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestInternalRoutePlanningCheckpoint?.sourceRef || "not found",
            commitHash: internalRoutePlanningCommitHash,
            summary: "Internal-route planning checkpoint is source-specific before exposing this plan.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestInternalRoutePlanningOracleAck?.sourceRef || "not found",
            commitHash: internalRoutePlanningCommitHash,
            summary: "Oracle acknowledged the committed internal-route planning boundary before this plan record.",
          },
          {
            kind: "summary",
            summary: "The plan is derived from the visible mission-control-command-card-route-plan-follow-through-v0 proof only.",
          },
          ...(internalRouteAuditPlanningReady
            ? [
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestInternalRoutePromotionPlanSurfaceCheckpoint?.sourceRef || "not found",
                  commitHash: internalRoutePromotionPlanSurfaceCommitHash,
                  summary: "Internal-route promotion plan surface rendering is source-specific and committed before internal route/audit planning can advance.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestInternalRoutePromotionPlanSurfaceOracleAck?.sourceRef || "not found",
                  commitHash: internalRoutePromotionPlanSurfaceCommitHash,
                  summary: "Oracle acknowledged the committed internal-route promotion plan surface before route/audit planning.",
                },
              ]
            : []),
          ...(internalRouteAuditPlanningCommitted
            ? [
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestInternalRouteAuditPlanningCheckpoint?.sourceRef || "not found",
                  commitHash: internalRouteAuditPlanningCommitHash,
                  summary: "Internal route/audit planning advancement is source-specific and committed before red WIP containment rows can be treated as diagnostic only.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestInternalRouteAuditPlanningBuilderAck?.sourceRef || "not found",
                  commitHash: internalRouteAuditPlanningCommitHash,
                  summary: "Builder acknowledged the committed internal route/audit planning selector boundary.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestInternalRouteAuditPlanningOracleAck?.sourceRef || "not found",
                  commitHash: internalRouteAuditPlanningCommitHash,
                  summary: "Oracle acknowledged the committed internal route/audit planning selector boundary.",
                },
              ]
            : []),
          ...(postAuditPlanningSelectorCommitted
            ? [
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestPostAuditPlanningSelectorCheckpoint?.sourceRef || "not found",
                  commitHash: postAuditPlanningSelectorCommitHash,
                  summary: "Post-audit selector hardening is source-specific and committed before WIP sanity/status/containment/closure rows can be treated as diagnostic only.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestPostAuditPlanningSelectorBuilderAck?.sourceRef || "not found",
                  commitHash: postAuditPlanningSelectorCommitHash,
                  summary: "Builder acknowledged the committed post-audit selector hardening boundary.",
                },
                {
                  kind: "comms" as const,
                  sourceRef: input.recentComms.latestPostAuditPlanningSelectorOracleAck?.sourceRef || "not found",
                  commitHash: postAuditPlanningSelectorCommitHash,
                  summary: "Oracle acknowledged the committed post-audit selector hardening boundary.",
                },
              ]
            : []),
        ],
        completedContext: {
          commandCardAcceptanceId: "mission-control-v0-command-card-acceptance",
          commandCardRoutePlanFollowThroughProofId: "mission-control-command-card-route-plan-follow-through-v0",
        },
        jamesControlPoint: "James can inspect this local plan before any future promotion, route, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.",
        preconditions: [
          "Worktree is clean.",
          "commandCardAcceptance is present as completed visible context.",
          "mission-control-command-card-route-plan-follow-through-v0 is present as completed visible context.",
          "0cb27b6b checkpoint and Oracle ACK are source-specific and not report/name-drop rows.",
          ...(internalRouteAuditPlanningReady
            ? ["f7352d10 internal-route promotion plan surface checkpoint and Oracle ACK are source-specific and not report/name-drop rows."]
            : []),
          ...(internalRouteAuditPlanningCommitted
            ? ["c1a05e07 internal route/audit planning checkpoint plus Builder/Oracle ACKs are source-specific and not report/name-drop rows."]
            : []),
          ...(postAuditPlanningSelectorCommitted
            ? ["582ef1c6 post-audit selector checkpoint plus Builder/Oracle ACKs are source-specific and not report/name-drop rows."]
            : []),
          "The plan is local evidence only and is not a route promotion request.",
        ],
        refusalNoGoConditions: [
          "Dirty worktree or missing completed visible proof context.",
          "Missing source-specific 0cb27b6b checkpoint or Oracle ACK.",
          ...(internalRouteAuditPlanningReady
            ? ["Missing source-specific f7352d10 internal-route promotion plan surface checkpoint or Oracle ACK."]
            : []),
          ...(internalRouteAuditPlanningCommitted
            ? ["Missing source-specific c1a05e07 internal route/audit planning checkpoint, Builder ACK, or Oracle ACK."]
            : []),
          ...(postAuditPlanningSelectorCommitted
            ? ["Missing source-specific 582ef1c6 post-audit selector checkpoint, Builder ACK, or Oracle ACK."]
            : []),
          internalRouteAuditPlanningReady
            ? "Any report/checkpoint/name-drop row trying to replace the active delegation, 0cb27b6b authority, or f7352d10 authority."
            : "Any report/checkpoint/name-drop row trying to replace the active delegation or 0cb27b6b authority.",
          "Any request to start runtime, open browser/workbench, perform UI/status actions, fetch, POST, route, send, promote, call provider/model, touch accounts/tokens/credentials/devices/users/external targets, deploy, move money, or touch trading.",
          "Any attempt to treat this plan as live route/send/promotion approval.",
        ],
        audit: {
          planningOnly: true,
          manualOnly: true,
          sendPerformed: false,
          promotionPerformed: false,
          routeFlip: false,
          runtimeExecutes: false,
          runtimeStarted: false,
          browserOpened: false,
          workbenchOpened: false,
          uiActionPerformed: false,
          fetched: false,
          posted: false,
          routed: false,
          sent: false,
          providerInvoked: false,
          modelInvoked: false,
          accountAccessed: false,
          tokenAccessed: false,
          credentialAccessed: false,
          deviceTouched: false,
          userTargeted: false,
          externalTargeted: false,
          deployed: false,
          moneyMovement: false,
          tradingTouched: false,
        },
      }
    : null;
  const internalRouteAuditReviewLaneProof: SquidRunProjectContext["missionControl"]["internalRouteAuditReviewLaneProof"] = internalRouteAuditReviewLaneProofReady && commandCardAcceptance && commandCardRoutePlanFollowThroughProof && internalRoutePromotionReviewPlan
    ? {
        id: "mission-control-internal-route-audit-review-lane-proof-v0",
        status: "planning_only_ready_for_oracle_review",
        owner: "Builder",
        review: {
          target: "oracle",
          purpose: "internal route/audit planning review",
          message: internalRouteAuditReviewLaneProofOracleMessage,
          body: internalRouteAuditReviewLaneProofOracleMessage,
          manualExecutionRequired: true,
          runtimeExecutes: false,
          sendPerformed: false,
          promotionPerformed: false,
          routeFlip: false,
        },
        sourceEvidence: [
          {
            kind: "file",
            path: "docs/mira-system-map.md",
            summary: "System map keeps this internal route/audit review-lane proof local, manual-only, no-send, no-promotion, no-route-flip, and no-execution.",
          },
          {
            kind: "file",
            path: "mira/runtime/src/squidrun-context.ts",
            summary: "SquidRun context source builds this review-lane proof from mission-control-internal-route-promotion-review-plan-v0 only.",
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${commandCardAcceptance.id} remains ${commandCardAcceptance.status}.`,
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${commandCardRoutePlanFollowThroughProof.id} remains ${commandCardRoutePlanFollowThroughProof.status}.`,
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${internalRoutePromotionReviewPlan.id} remains ${internalRoutePromotionReviewPlan.status}.`,
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestContinuationDelegation?.sourceRef || "not found",
            summary: "Current Architect delegation asks for one inspectable no-live-effect internal route/audit review-lane proof from mission-control-internal-route-promotion-review-plan-v0 only.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestInternalRouteAuditReviewLaneProofCheckpoint?.sourceRef || "not found",
            commitHash: internalRouteAuditReviewLaneProofCommitHash,
            summary: "b1acd4d7 checkpoint is source-specific evidence before exposing this internal route/audit review-lane proof.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestInternalRouteAuditReviewLaneProofOracleAck?.sourceRef || "not found",
            commitHash: internalRouteAuditReviewLaneProofCommitHash,
            summary: "Oracle acknowledged b1acd4d7 before this review-lane proof is exposed.",
          },
          {
            kind: "summary",
            summary: "The proof is derived from mission-control-internal-route-promotion-review-plan-v0 only and is not a route promotion request.",
          },
        ],
        completedContext: {
          commandCardAcceptanceId: "mission-control-v0-command-card-acceptance",
          commandCardRoutePlanFollowThroughProofId: "mission-control-command-card-route-plan-follow-through-v0",
          internalRoutePromotionReviewPlanId: "mission-control-internal-route-promotion-review-plan-v0",
        },
        jamesControlPoint: "James must explicitly review and approve a separate future route/audit promotion before any real promotion, route flip, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.",
        preconditions: [
          "Worktree is clean.",
          "mission-control-internal-route-promotion-review-plan-v0 is present as completed visible context.",
          "b1acd4d7 checkpoint and Oracle ACK are source-specific and not report/name-drop rows.",
          "No Builder b1acd4d7 ACK is required or invented for this gate.",
          "The proof is local planning/review evidence only and is not a route promotion request.",
        ],
        refusalNoGoConditions: [
          "Dirty worktree or missing completed internal-route promotion/review plan context.",
          "Missing source-specific b1acd4d7 checkpoint or Oracle ACK.",
          "Any report/checkpoint/name-drop row trying to replace the active delegation, b1acd4d7 checkpoint, or b1acd4d7 Oracle ACK authority.",
          "Any request to start runtime, open browser/workbench, perform UI/status actions, fetch, POST, route, send, promote, flip routes, call provider/model, touch accounts/tokens/credentials/devices/users/external targets, deploy, move money, or touch trading.",
          "Any attempt to treat this proof as live route/audit promotion approval.",
        ],
        audit: {
          planningOnly: true,
          manualOnly: true,
          sendPerformed: false,
          promotionPerformed: false,
          routeFlip: false,
          runtimeExecutes: false,
          runtimeStarted: false,
          browserOpened: false,
          workbenchOpened: false,
          uiActionPerformed: false,
          fetched: false,
          posted: false,
          routed: false,
          sent: false,
          providerInvoked: false,
          modelInvoked: false,
          accountAccessed: false,
          tokenAccessed: false,
          credentialAccessed: false,
          deviceTouched: false,
          userTargeted: false,
          externalTargeted: false,
          deployed: false,
          moneyMovement: false,
          tradingTouched: false,
        },
      }
    : null;
  const internalRouteAuditPromotionDecisionGateProof: SquidRunProjectContext["missionControl"]["internalRouteAuditPromotionDecisionGateProof"] = internalRoutePromotionDecisionGateProofReady && commandCardAcceptance && commandCardRoutePlanFollowThroughProof && internalRoutePromotionReviewPlan && internalRouteAuditReviewLaneProof
    ? {
        id: "mission-control-internal-route-audit-promotion-decision-gate-proof-v0",
        status: "planning_only_ready_for_oracle_review",
        owner: "Builder",
        decisionGate: {
          target: "oracle",
          reviewer: "oracle",
          purpose: "internal route/audit promotion decision-gate review",
          message: internalRouteAuditPromotionDecisionGateProofOracleMessage,
          body: internalRouteAuditPromotionDecisionGateProofOracleMessage,
          sourceProofId: "mission-control-internal-route-audit-review-lane-proof-v0",
          manualExecutionRequired: true,
          runtimeExecutes: false,
          sendPerformed: false,
          promotionPerformed: false,
          routeFlip: false,
        },
        sourceEvidence: [
          {
            kind: "file",
            path: "docs/mira-system-map.md",
            summary: "System map keeps this internal route/audit promotion decision-gate proof local, manual-only, no-send, no-promotion, no-route-flip, and no-execution.",
          },
          {
            kind: "file",
            path: "mira/runtime/src/squidrun-context.ts",
            summary: "SquidRun context source builds this decision-gate proof from the visible internal route/audit review-lane proof only.",
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${commandCardAcceptance.id} remains ${commandCardAcceptance.status}.`,
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${commandCardRoutePlanFollowThroughProof.id} remains ${commandCardRoutePlanFollowThroughProof.status}.`,
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${internalRoutePromotionReviewPlan.id} remains ${internalRoutePromotionReviewPlan.status}.`,
          },
          {
            kind: "completed_context",
            summary: `Completed context retained: ${internalRouteAuditReviewLaneProof.id} remains ${internalRouteAuditReviewLaneProof.status}.`,
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestContinuationDelegation?.sourceRef || "not found",
            summary: "Current Architect delegation asks for one inspectable no-live-effect internal route/audit promotion decision-gate plan/proof from the visible audit-review proof only.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestInternalRoutePromotionDecisionGateCheckpoint?.sourceRef || "not found",
            commitHash: internalRoutePromotionDecisionGateCommitHash,
            summary: "cbeb0d2f checkpoint is source-specific evidence before exposing this decision-gate proof.",
          },
          {
            kind: "comms",
            sourceRef: input.recentComms.latestInternalRoutePromotionDecisionGateOracleAck?.sourceRef || "not found",
            commitHash: internalRoutePromotionDecisionGateCommitHash,
            summary: "Oracle acknowledged cbeb0d2f before this decision-gate proof is exposed.",
          },
          {
            kind: "summary",
            summary: "The proof is derived from mission-control-internal-route-audit-review-lane-proof-v0 only and is not a route promotion request.",
          },
        ],
        completedContext: {
          commandCardAcceptanceId: "mission-control-v0-command-card-acceptance",
          commandCardRoutePlanFollowThroughProofId: "mission-control-command-card-route-plan-follow-through-v0",
          internalRoutePromotionReviewPlanId: "mission-control-internal-route-promotion-review-plan-v0",
          internalRouteAuditReviewLaneProofId: "mission-control-internal-route-audit-review-lane-proof-v0",
        },
        jamesControlPoint: "James must explicitly review and approve a separate future route/audit promotion before any real promotion, route flip, send, runtime, browser, workbench, UI/status, provider/model, credential, deploy, money, or trading action is proposed.",
        preconditions: [
          "Worktree is clean.",
          "mission-control-internal-route-audit-review-lane-proof-v0 is present as completed visible context.",
          "cbeb0d2f checkpoint and Oracle ACK are source-specific and not report/name-drop rows.",
          "No Builder cbeb0d2f ACK is required or invented for this gate.",
          "The proof is local planning/review evidence only and is not a route promotion request.",
        ],
        refusalNoGoConditions: [
          "Dirty worktree or missing completed internal route/audit review-lane proof context.",
          "Missing source-specific cbeb0d2f checkpoint or Oracle ACK.",
          "Any report/checkpoint/name-drop/closure row trying to replace the active delegation, cbeb0d2f checkpoint, or cbeb0d2f Oracle ACK authority.",
          "Any request to start runtime, open browser/workbench, perform UI/status actions, fetch, POST, route, send, promote, flip routes, call provider/model, touch accounts/tokens/credentials/devices/users/external targets, deploy, move money, or touch trading.",
          "Any attempt to treat this proof as live route/audit promotion approval.",
        ],
        audit: {
          planningOnly: true,
          manualOnly: true,
          sendPerformed: false,
          promotionPerformed: false,
          routeFlip: false,
          runtimeExecutes: false,
          runtimeStarted: false,
          browserOpened: false,
          workbenchOpened: false,
          uiActionPerformed: false,
          fetched: false,
          posted: false,
          routed: false,
          sent: false,
          providerInvoked: false,
          modelInvoked: false,
          accountAccessed: false,
          tokenAccessed: false,
          credentialAccessed: false,
          deviceTouched: false,
          userTargeted: false,
          externalTargeted: false,
          deployed: false,
          moneyMovement: false,
          tradingTouched: false,
        },
      }
    : null;

  return {
    question: "what is happening here, and what happens next?",
    foundationVsProduct,
    answer: answerLines.join("\n"),
    nextTeamMove,
    jamesAction: "NONE",
    jamesActionReason,
    coordinationDrafts,
    toolAppActionPlan,
    continuityMemoryProof,
    demoWorkbenchProof,
    commandCardAcceptance,
    commandCardRoutePlanFollowThroughProof,
    internalRoutePromotionReviewPlan,
    internalRouteAuditReviewLaneProof,
    internalRouteAuditPromotionDecisionGateProof,
    internalRoutePreview: {
      status: "reviewed_preview_only",
      selectedDraftTarget: selectedDraft.target,
      selectedDraftPurpose: selectedDraft.purpose,
      plan: routePlan,
      audit: {
        reviewStatus: "preview_ready",
        sendPerformed: false,
        runtimeExecutes: false,
        externalSend: false,
        routeFlip: false,
        providerInvoked: false,
        note: "Mission Control prepared this internal route preview for review only; no hm-send, Telegram, model/provider, or external route was invoked.",
      },
    },
    evidence,
    continuationDecision,
  };
}

export function getSquidRunContext(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): SquidRunProjectContext {
  const squidrunRoot = resolveSquidRunRoot(env, cwd);
  const link = readJsonObject(path.join(squidrunRoot, ".squidrun", "link.json"));
  const currentLane = readJsonObject(path.join(squidrunRoot, ".squidrun", "handoffs", "current-lane.json"));
  const queue = readJsonObject(path.join(squidrunRoot, ".squidrun", "runtime", "agent-task-queue.json"));
  const gitStatus = readGitStatus(squidrunRoot);
  const dirtyWork = summarizeDirtyWork(gitStatus);
  const systemMap = readSystemMapTruth(squidrunRoot);
  const roadmap = readRoadmapTruth(squidrunRoot);
  const recentComms = readRecentComms(squidrunRoot);

  const workspace = trimText(link?.workspace) || squidrunRoot;
  const projectName = path.basename(workspace || squidrunRoot) || "squidrun";
  const lane = summarizeLane(currentLane);
  const ownedWork = summarizeOwnedWork(queue);
  const fallbackNextStep = lane.nextAction
    || ownedWork.active[0]?.nextStep
    || "No current local next step found.";
  const missionControl = buildMissionControl({
    projectName,
    lane,
    dirtyWork,
    systemMap,
    roadmap,
    recentComms,
    fallbackNextStep,
  });
  const staleHandoff = missionControl.continuationDecision.status === "stale_handoff_superseded"
    && missionControl.continuationDecision.staleSourceRef
    ? {
        status: "stale_superseded" as const,
        sourceRef: missionControl.continuationDecision.staleSourceRef,
        sourceTimestampMs: lane.sourceTimestampMs,
        objective: missionControl.continuationDecision.staleObjective,
        supersededBySourceRef: missionControl.continuationDecision.preferredSourceRef || "latest continuation",
        supersededByCommit: missionControl.continuationDecision.committedSeam || "latest committed Mission Control seam",
        reason: missionControl.continuationDecision.reason,
      }
    : null;
  const laneWithStale = {
    ...lane,
    staleHandoff,
  };
  const laneLabel = missionControl.continuationDecision.preferredSourceRef || lane.sourceRef || lane.status || "local context";
  const happening = missionControl.continuationDecision.status === "stale_handoff_superseded"
    ? `Working in ${projectName} on ${laneLabel}: continuation-aware Mission Control command context; stale ${missionControl.continuationDecision.staleSourceRef} has no active authority after ${missionControl.continuationDecision.committedSeam}.`
    : lane.objective
      ? `Working in ${projectName} on ${laneLabel}: ${lane.objective}`
      : `${projectName} local project context is loaded.`;

  return {
    ok: true,
    protocol: "mira.squidrun_context.v0",
    source: "local_squidrun_files",
    project: {
      name: projectName,
      workspace,
      squidrunRoot,
      sessionId: trimText(link?.session_id),
    },
    lane: laneWithStale,
    ownedWork,
    git: gitStatus,
    dirtyWork,
    systemMap,
    roadmap,
    recentComms,
    missionControl,
    summary: {
      headline: `${projectName}: Mission Control local evidence loaded`,
      happening,
      nextStep: missionControl.nextTeamMove,
      toolAppActionPlan: missionControl.toolAppActionPlan
        ? `${missionControl.toolAppActionPlan.id}: ${missionControl.toolAppActionPlan.target.actionCategory} -> ${missionControl.toolAppActionPlan.target.action}; owner ${missionControl.toolAppActionPlan.owner}; ${missionControl.toolAppActionPlan.jamesControlPoint}`
        : null,
      continuityMemoryProof: missionControl.continuityMemoryProof
        ? `${missionControl.continuityMemoryProof.id}: current-lane truth ${missionControl.continuityMemoryProof.currentLaneTruth.sourceRef || "not found"} is ${missionControl.continuityMemoryProof.currentLaneTruth.authority}; stale-only summary refused=${missionControl.continuityMemoryProof.staleOnlySummaryRefusal.refused}; ${missionControl.continuityMemoryProof.jamesControlPoint}`
        : null,
      demoWorkbenchProof: missionControl.demoWorkbenchProof
        ? `${missionControl.demoWorkbenchProof.id}: ${missionControl.demoWorkbenchProof.target.surface} asks "${missionControl.demoWorkbenchProof.target.question}"; owner ${missionControl.demoWorkbenchProof.owner}; ${missionControl.demoWorkbenchProof.jamesControlPoint}`
        : null,
      commandCardAcceptance: missionControl.commandCardAcceptance
        ? `${missionControl.commandCardAcceptance.id}: completed visible command-card context with current lane card, recent changes, Builder/Oracle next moves, dirty-context status, one James-action line, and dry-run route plan; owner ${missionControl.commandCardAcceptance.owner}; ${missionControl.commandCardAcceptance.jamesControlPoint}`
        : null,
      commandCardRoutePlanFollowThroughProof: missionControl.commandCardRoutePlanFollowThroughProof
        ? `${missionControl.commandCardRoutePlanFollowThroughProof.id}: ${missionControl.commandCardRoutePlanFollowThroughProof.status}; target ${missionControl.commandCardRoutePlanFollowThroughProof.routePlan.target}; purpose ${missionControl.commandCardRoutePlanFollowThroughProof.routePlan.purpose}; ${missionControl.commandCardRoutePlanFollowThroughProof.jamesControlPoint}`
        : null,
      internalRoutePromotionReviewPlan: missionControl.internalRoutePromotionReviewPlan
        ? `${missionControl.internalRoutePromotionReviewPlan.id}: ${missionControl.internalRoutePromotionReviewPlan.status}; target ${missionControl.internalRoutePromotionReviewPlan.target.role}; purpose ${missionControl.internalRoutePromotionReviewPlan.target.purpose}; ${missionControl.internalRoutePromotionReviewPlan.jamesControlPoint}`
        : null,
      internalRouteAuditReviewLaneProof: missionControl.internalRouteAuditReviewLaneProof
        ? `${missionControl.internalRouteAuditReviewLaneProof.id}: ${missionControl.internalRouteAuditReviewLaneProof.status}; target ${missionControl.internalRouteAuditReviewLaneProof.review.target}; purpose ${missionControl.internalRouteAuditReviewLaneProof.review.purpose}; ${missionControl.internalRouteAuditReviewLaneProof.jamesControlPoint}`
        : null,
      internalRouteAuditPromotionDecisionGateProof: missionControl.internalRouteAuditPromotionDecisionGateProof
        ? `${missionControl.internalRouteAuditPromotionDecisionGateProof.id}: ${missionControl.internalRouteAuditPromotionDecisionGateProof.status}; target ${missionControl.internalRouteAuditPromotionDecisionGateProof.decisionGate.target}; purpose ${missionControl.internalRouteAuditPromotionDecisionGateProof.decisionGate.purpose}; ${missionControl.internalRouteAuditPromotionDecisionGateProof.jamesControlPoint}`
        : null,
      jamesAction: "NONE",
      jamesActionReason: missionControl.jamesActionReason,
    },
    reads: {
      link: Boolean(link),
      currentLane: Boolean(currentLane),
      ownedWorkQueue: Boolean(queue),
      gitStatus: gitStatus.loaded,
      systemMap: systemMap.loaded,
      roadmap: roadmap.loaded,
      recentComms: recentComms.loaded,
    },
  };
}
