import path from "node:path";
import { fileURLToPath } from "node:url";

const allowedRoles = {
  architect: { role: "architect", paneId: "1" },
  builder: { role: "builder", paneId: "2" },
  oracle: { role: "oracle", paneId: "3" },
} as const;

type AllowedRole = keyof typeof allowedRoles;

export type ManualBridgeRequestInput = {
  targetRole?: string;
  content?: string;
  sessionId?: string | null;
  messageId?: string;
  requestId?: string;
  evidence?: { kind: string; path?: string; summary?: string }[];
};

export type ManualBridgeRequestPlan = {
  ok: true;
  protocol: "mira.runtime_bridge_request_plan.v0";
  manualExecutionRequired: true;
  runtimeExecutes: false;
  target: {
    role: AllowedRole;
    paneId: "1" | "2" | "3";
  };
  envelope: {
    protocol: "mira.hm_send_adapter.v0";
    request_id: string;
    message_id: string;
    session_id: string | null;
    source: {
      service: "mira-runtime";
      surface: "runtime-manual-bridge-planner";
    };
    target: {
      system: "squidrun";
      role: AllowedRole;
      pane_id: "1" | "2" | "3";
    };
    evidence: { kind: string; path?: string; summary?: string }[];
    body: {
      content: string;
    };
  };
  command: {
    executable: string;
    args: string[];
    cwd: string;
  };
};

function getRepoRootFromRuntimeModule(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", "..", "..");
}

function assertAllowedRole(value: unknown): AllowedRole {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "architect" || normalized === "builder" || normalized === "oracle") {
    return normalized;
  }

  const externalTargets = new Set(["telegram", "user", "external", "web", "browser", "mira"]);
  const code = externalTargets.has(normalized)
    || normalized.startsWith("@")
    || /^https?:\/\//i.test(normalized)
    ? "external_target_refused"
    : "invalid_pane_target";

  throw Object.assign(new Error(`Manual Mira bridge requests only target SquidRun panes: architect, builder, oracle. Refused '${value}'.`), {
    code,
    targetRole: value,
  });
}

export function planManualBridgeRequest(input: ManualBridgeRequestInput = {}): ManualBridgeRequestPlan {
  const role = assertAllowedRole(input.targetRole);
  const content = String(input.content || "").trim();
  if (!content) {
    throw Object.assign(new Error("Manual Mira bridge request content cannot be empty."), { code: "empty_message" });
  }

  const repoRoot = getRepoRootFromRuntimeModule();
  const cliRelativePath = "mira/bridge/send-pane-message.js";
  const cliPath = path.join(repoRoot, cliRelativePath);
  const target = allowedRoles[role];
  const messageId = String(input.messageId || `mira-runtime-manual-${Date.now()}`);
  const requestId = String(input.requestId || `req-${messageId}`);
  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  const args = [
    cliPath,
    "--target",
    role,
    "--content",
    content,
    "--message-id",
    messageId,
    "--request-id",
    requestId,
  ];

  if (input.sessionId) {
    args.push("--session-id", input.sessionId);
  }

  for (const item of evidence) {
    if (item?.kind === "file" && item.path) {
      args.push("--evidence-file", item.path);
    }
  }

  return {
    ok: true,
    protocol: "mira.runtime_bridge_request_plan.v0",
    manualExecutionRequired: true,
    runtimeExecutes: false,
    target: {
      role,
      paneId: target.paneId,
    },
    envelope: {
      protocol: "mira.hm_send_adapter.v0",
      request_id: requestId,
      message_id: messageId,
      session_id: input.sessionId || null,
      source: {
        service: "mira-runtime",
        surface: "runtime-manual-bridge-planner",
      },
      target: {
        system: "squidrun",
        role,
        pane_id: target.paneId,
      },
      evidence,
      body: {
        content,
      },
    },
    command: {
      executable: process.execPath,
      args,
      cwd: repoRoot,
    },
  };
}
