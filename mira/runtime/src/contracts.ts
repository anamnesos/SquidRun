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
  };
};
