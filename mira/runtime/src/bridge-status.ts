import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BridgeCapabilitySummary } from "./contracts.js";

const allowedRoles = ["architect", "builder", "oracle"] as const;

function getRepoRootFromRuntimeModule(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", "..", "..");
}

export function getBridgeCapabilityStatus(): BridgeCapabilitySummary {
  const repoRoot = getRepoRootFromRuntimeModule();
  const cliRelativePath = "mira/bridge/send-pane-message.js";
  const cliPath = path.join(repoRoot, cliRelativePath);
  const cliAvailable = fs.existsSync(cliPath);

  return {
    protocol: "mira.hm_send_adapter.v0",
    cliAvailable,
    cliPath,
    cliRelativePath,
    allowedRoles: [...allowedRoles],
    liveSendManualOnly: true,
    autoSend: false,
    runtimeInvokesSendCli: false,
    telegramRouteControl: false,
    uiSurfaceControl: false,
  };
}
