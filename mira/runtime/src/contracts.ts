export type RuntimeStatus = "starting" | "ready";

export type HealthResponse = {
  service: "mira-runtime";
  status: RuntimeStatus;
  version: string;
  nodeVersion: string;
  uptimeSeconds: number;
  stateRootConfigured: boolean;
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
  };
};
