import { fileURLToPath } from "node:url";
import { getSessionSkeleton } from "./runtime.js";

export function getRuntimeStatus() {
  const session = getSessionSkeleton().session;

  return {
    service: "mira-runtime" as const,
    stateRootReady: session.stateRootReady,
    stateRootPath: session.stateRootPath,
    stateRootError: session.stateRootError,
    receiptCount: session.importReceipts.receiptCount,
    recordCount: session.importReceipts.recordCount,
    acceptanceContinuity: {
      loaded: session.acceptanceContinuity.loaded,
      documentCount: session.acceptanceContinuity.documentCount,
      documents: session.acceptanceContinuity.documents,
      continuityLoaded: session.acceptanceContinuity.continuityLoaded,
      runtimeSessionClaimAllowed: session.acceptanceContinuity.runtimeSessionClaimAllowed,
      error: session.acceptanceContinuity.error,
    },
    continuityLoaded: session.continuityLoaded,
    liveDataImported: session.liveDataImported,
  };
}

export function formatRuntimeStatus(status = getRuntimeStatus()): string {
  return [
    "Mira runtime status",
    `state_root_ready=${status.stateRootReady}`,
    `state_root=${status.stateRootPath || "null"}`,
    `receipt_count=${status.receiptCount}`,
    `record_count=${status.recordCount}`,
    `acceptance_continuity_loaded=${status.acceptanceContinuity.loaded}`,
    `acceptance_document_count=${status.acceptanceContinuity.documentCount}`,
    `continuity_loaded=${status.continuityLoaded}`,
    `runtime_session_claim_allowed=${status.acceptanceContinuity.runtimeSessionClaimAllowed}`,
    status.stateRootError ? `state_root_error=${status.stateRootError}` : null,
    status.acceptanceContinuity.error ? `acceptance_error=${status.acceptanceContinuity.error}` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isMain) {
  const status = getRuntimeStatus();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log(formatRuntimeStatus(status));
  }
}
