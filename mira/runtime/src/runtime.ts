import type {
  CapabilitiesResponse,
  HealthResponse,
  RuntimeCapability,
  SessionResponse,
} from "./contracts.js";
import { getImportReceiptSummary } from "./import-status.js";
import { getStateRootReadiness } from "./state-root.js";

const version = "0.1.0";

const capabilities: RuntimeCapability[] = [
  {
    id: "health",
    status: "available",
    notes: "Reports runtime liveness without reading or importing live Mira state.",
  },
  {
    id: "capabilities",
    status: "available",
    notes: "Reports scaffold readiness and explicit non-capabilities.",
  },
  {
    id: "session",
    status: "planned",
    notes: "Returns an empty session skeleton and state-root readiness without loading continuity data.",
  },
  {
    id: "model_behavior",
    status: "blocked",
    notes: "No model behavior migration in this milestone.",
  },
  {
    id: "live_data_import",
    status: "blocked",
    notes: "No runtime move, live data copy, or live data delete in this milestone.",
  },
  {
    id: "telegram_route",
    status: "blocked",
    notes: "Telegram route ownership is outside this runtime scaffold.",
  },
];

export function getHealth(startedAt: number): HealthResponse {
  const stateRoot = getStateRootReadiness();

  return {
    service: "mira-runtime",
    status: "ready",
    version,
    nodeVersion: process.version,
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    stateRootConfigured: stateRoot.configured,
    stateRoot,
  };
}

export function getStateRootStatus() {
  return {
    service: "mira-runtime" as const,
    stateRoot: getStateRootReadiness(),
  };
}

export function getCapabilities(): CapabilitiesResponse {
  return {
    service: "mira-runtime",
    capabilities,
  };
}

export function getSessionSkeleton(): SessionResponse {
  const stateRoot = getStateRootReadiness();
  const importReceipts = getImportReceiptSummary(stateRoot);

  return {
    service: "mira-runtime",
    session: {
      id: null,
      source: "none",
      modelBehaviorLoaded: false,
      liveDataImported: false,
      continuityLoaded: false,
      stateRootReady: stateRoot.ready,
      stateRootPath: stateRoot.path,
      stateRootError: stateRoot.error,
      importReceipts,
    },
  };
}
