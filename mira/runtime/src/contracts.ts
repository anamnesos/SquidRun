export type RuntimeStatus = "starting" | "ready";

export type StateRootBucket = {
  id: string;
  relativePath: string;
  purpose: string;
};

export type StateRootReadiness = {
  configured: boolean;
  ready: boolean;
  path: string | null;
  error: string | null;
  requiredBuckets: StateRootBucket[];
  importsLoaded: false;
};

export type ImportReceiptSummary = {
  receiptsDir: string | null;
  receiptCount: number;
  recordCount: number;
  receiptsRead: boolean;
  continuityLoaded: false;
  error: string | null;
};

export type AcceptanceContinuityDocument = {
  relativePath: string;
  title: string | null;
  bytes: number;
};

export type AcceptanceContinuitySummary = {
  loaded: boolean;
  scope: "acceptance_docs_only";
  batchId: "acceptance-permission-contracts-v1";
  documentCount: number;
  documents: AcceptanceContinuityDocument[];
  continuityLoaded: false;
  runtimeSessionClaimAllowed: false;
  error: string | null;
};

export type NormalizedCoreDocument = {
  id: "mira_self_profile" | "james_relationship_state" | "relationship_presence_permissions";
  relativePath: string;
  schema: string;
  bytes: number;
  metadataOnly: boolean;
  liveContinuityExcluded: boolean;
  sourceFocusSummaryMetadataOnly: boolean | null;
  localStoreWriteScoped: boolean | null;
  blanketRuntimeWritePermission: boolean;
};

export type NormalizedCoreSummary = {
  loaded: boolean;
  scope: "normalized_core_state_only";
  batchId: "normalized-core-state-v1";
  documentCount: number;
  documents: NormalizedCoreDocument[];
  continuityLoaded: false;
  runtimeSessionClaimAllowed: false;
  error: string | null;
};

export type BridgeCapabilitySummary = {
  protocol: "mira.hm_send_adapter.v0";
  cliAvailable: boolean;
  cliPath: string;
  cliRelativePath: "mira/bridge/send-pane-message.js";
  allowedRoles: ("architect" | "builder" | "oracle")[];
  liveSendManualOnly: true;
  autoSend: false;
  runtimeInvokesSendCli: false;
  telegramRouteControl: false;
  uiSurfaceControl: false;
};

export type HealthResponse = {
  service: "mira-runtime";
  status: RuntimeStatus;
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
  stateRootConfigured: boolean;
  stateRoot: StateRootReadiness;
};

export type CapabilityStatus = "available" | "planned" | "blocked";

export type RuntimeCapability = {
  id: string;
  status: CapabilityStatus;
  notes: string;
};

export type CapabilitiesResponse = {
  service: "mira-runtime";
  capabilities: RuntimeCapability[];
};

export type SessionResponse = {
  service: "mira-runtime";
  session: {
    id: string | null;
    source: "none";
    modelBehaviorLoaded: false;
    liveDataImported: false;
    continuityLoaded: false;
    stateRootReady: boolean;
    stateRootPath: string | null;
    stateRootError: string | null;
    importReceipts: ImportReceiptSummary;
    acceptanceContinuity: AcceptanceContinuitySummary;
    normalizedCore: NormalizedCoreSummary;
    bridge: BridgeCapabilitySummary;
  };
};
