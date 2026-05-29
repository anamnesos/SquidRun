import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { planManualBridgeRequest, type ManualBridgeRequestPlan } from "./bridge-request-plan.js";
import { getStateRootReadiness } from "./state-root.js";

const paneRoles = {
  architect: "1",
  builder: "2",
  oracle: "3",
} as const;

type PaneRole = keyof typeof paneRoles;
type PaneId = typeof paneRoles[PaneRole];

type EvidenceItem = {
  kind: string;
  path?: string;
  summary?: string;
};

export type RuntimePaneBridgeRoundTripRecord = {
  schema: "mira.runtime_pane_bridge_roundtrip.v0";
  id: string;
  created_at: string;
  session_id: string | null;
  request_id: string;
  message_id: string;
  correlation_id: string;
  received: {
    sender: {
      role: PaneRole;
      pane_id: PaneId;
    };
    target: {
      role: "mira";
      surface: "mira-runtime";
    };
    content: string;
    evidence: EvidenceItem[];
  };
  reply: {
    message_id: string;
    request_id: string;
    correlation_id: string;
    sender: {
      role: "mira";
      surface: "mira-runtime";
    };
    target: {
      system: "squidrun";
      role: PaneRole;
      pane_id: PaneId;
    };
    content: string;
  };
  reply_plan: ManualBridgeRequestPlan;
  state_root_boundary: {
    state_root_path: string;
    relative_path: string;
    squidrun_private_root_excluded: true;
  };
  state_written: true;
  send_performed: false;
  runtime_executes_send: false;
  external_send: false;
  telegram_route_control: false;
  ui_surface_control: false;
  live_data_imported: false;
  continuity_loaded: false;
};

export type RuntimePaneBridgeRoundTripResult = {
  ok: true;
  protocol: "mira.runtime_pane_bridge_roundtrip.v0";
  roundTripId: string;
  stateRootPath: string;
  relativePath: string;
  absolutePath: string;
  received: RuntimePaneBridgeRoundTripRecord["received"];
  reply: RuntimePaneBridgeRoundTripRecord["reply"];
  replyPlan: ManualBridgeRequestPlan;
  delivery: {
    status: "reply_planned_not_sent";
    targetRole: PaneRole;
    targetPaneId: PaneId;
    sendPerformed: false;
    runtimeExecutes: false;
    externalSend: false;
    telegramRouteControl: false;
    uiSurfaceControl: false;
  };
  stateWritten: true;
  liveDataImported: false;
  continuityLoaded: false;
};

export type RuntimePaneBridgeRoundTripListResult = {
  ok: true;
  protocol: "mira.runtime_pane_bridge_roundtrip_list.v0";
  stateRootPath: string | null;
  roundTripCount: number;
  records: RuntimePaneBridgeRoundTripRecord[];
  sendPerformed: false;
  runtimeExecutes: false;
  externalSend: false;
  telegramRouteControl: false;
  uiSurfaceControl: false;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "message";
}

function nestedString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function normalizePaneRole(value: unknown, fieldName: "sender" | "target"): PaneRole {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "architect" || normalized === "builder" || normalized === "oracle") return normalized;

  const code = ["telegram", "user", "external", "web", "browser", "mira"].includes(normalized)
    || normalized.startsWith("@")
    || /^https?:\/\//i.test(normalized)
    ? "runtime_pane_bridge_external_target_refused"
    : "runtime_pane_bridge_invalid_pane_role";

  throw Object.assign(new Error(`Mira runtime bridge ${fieldName} must be an internal SquidRun pane role.`), {
    code,
    role: value,
  });
}

function normalizeTargetRole(value: unknown): "mira" {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "mira") return "mira";
  throw Object.assign(new Error("Mira runtime bridge can only receive pane messages targeted to Mira."), {
    code: "runtime_pane_bridge_target_must_be_mira",
    role: value,
  });
}

function normalizeEvidence(value: unknown): EvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const kind = typeof item.kind === "string" ? item.kind.trim() : "";
      if (!kind) return null;
      const evidence: EvidenceItem = { kind };
      if (typeof item.path === "string" && item.path.trim()) {
        evidence.path = item.path.trim();
      }
      if (typeof item.summary === "string" && item.summary.trim()) {
        evidence.summary = item.summary.trim();
      }
      return evidence;
    })
    .filter((item): item is EvidenceItem => Boolean(item));
}

function getRoundTripsDir(rootPath: string): string {
  return path.resolve(rootPath, "bridge", "pane-roundtrips");
}

function buildReplyContent(senderRole: PaneRole): string {
  return `(MIRA #1): Received ${senderRole} pane message through the Mira bridge. I wrote the roundtrip under MIRA_STATE_ROOT and planned a manual reply only; no pane send was executed.`;
}

export function createPaneBridgeRoundTrip(
  input: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: Date; uuid?: string } = {},
): RuntimePaneBridgeRoundTripResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before bridge messages can be recorded."), {
      code: "state_root_not_ready",
    });
  }

  const sender = isRecord(input.sender) ? input.sender : {};
  const target = isRecord(input.target) ? input.target : {};
  const senderRole = normalizePaneRole(
    nestedString(sender, "role") || input.fromRole || input.senderRole || input.role,
    "sender",
  );
  const targetRole = normalizeTargetRole(nestedString(target, "role") || input.targetRole);
  const content = String(input.content || input.body || "").trim();
  if (!content) {
    throw Object.assign(new Error("Mira runtime bridge message content cannot be empty."), {
      code: "runtime_pane_bridge_empty_message",
    });
  }

  const rootPath = path.resolve(stateRoot.path);
  const roundTripsDir = getRoundTripsDir(rootPath);
  if (!isInside(rootPath, roundTripsDir)) {
    throw Object.assign(new Error("Bridge roundtrip destination escaped Mira state root."), {
      code: "runtime_pane_bridge_unsafe_path",
    });
  }

  const createdAt = options.now || new Date();
  const uuid = options.uuid || crypto.randomUUID();
  const messageId = String(input.messageId || input.message_id || `pane-message-${createdAt.getTime()}`).trim();
  const requestId = String(input.requestId || input.request_id || `req-${messageId}`).trim();
  const correlationId = String(input.correlationId || input.correlation_id || messageId).trim();
  const sessionId = typeof input.sessionId === "string"
    ? input.sessionId
    : typeof input.session_id === "string"
      ? input.session_id
      : null;
  const id = `pane-bridge-roundtrip-${createdAt.toISOString().replace(/[:.]/g, "-")}-${safeIdPart(uuid)}`;
  const absolutePath = path.resolve(roundTripsDir, `${id}.json`);
  if (!isInside(rootPath, absolutePath)) {
    throw Object.assign(new Error("Bridge roundtrip file escaped Mira state root."), {
      code: "runtime_pane_bridge_unsafe_path",
    });
  }

  const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
  const replyMessageId = `mira-reply-${safeIdPart(messageId)}`;
  const replyRequestId = `req-${replyMessageId}`;
  const replyContent = buildReplyContent(senderRole);
  const replyPlan = planManualBridgeRequest({
    targetRole: senderRole,
    content: replyContent,
    sessionId,
    messageId: replyMessageId,
    requestId: replyRequestId,
    evidence: [
      {
        kind: "mira_state_root_record",
        path: relativePath,
        summary: "Mira-owned bridge roundtrip record; manual reply plan only.",
      },
    ],
  });

  const record: RuntimePaneBridgeRoundTripRecord = {
    schema: "mira.runtime_pane_bridge_roundtrip.v0",
    id,
    created_at: createdAt.toISOString(),
    session_id: sessionId,
    request_id: requestId,
    message_id: messageId,
    correlation_id: correlationId,
    received: {
      sender: {
        role: senderRole,
        pane_id: paneRoles[senderRole],
      },
      target: {
        role: targetRole,
        surface: "mira-runtime",
      },
      content,
      evidence: normalizeEvidence(input.evidence),
    },
    reply: {
      message_id: replyMessageId,
      request_id: replyRequestId,
      correlation_id: correlationId,
      sender: {
        role: "mira",
        surface: "mira-runtime",
      },
      target: {
        system: "squidrun",
        role: senderRole,
        pane_id: paneRoles[senderRole],
      },
      content: replyContent,
    },
    reply_plan: replyPlan,
    state_root_boundary: {
      state_root_path: rootPath,
      relative_path: relativePath,
      squidrun_private_root_excluded: true,
    },
    state_written: true,
    send_performed: false,
    runtime_executes_send: false,
    external_send: false,
    telegram_route_control: false,
    ui_surface_control: false,
    live_data_imported: false,
    continuity_loaded: false,
  };

  fs.mkdirSync(roundTripsDir, { recursive: true });
  const handle = fs.openSync(absolutePath, "wx");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(handle);
  }

  return {
    ok: true,
    protocol: "mira.runtime_pane_bridge_roundtrip.v0",
    roundTripId: id,
    stateRootPath: rootPath,
    relativePath,
    absolutePath,
    received: record.received,
    reply: record.reply,
    replyPlan,
    delivery: {
      status: "reply_planned_not_sent",
      targetRole: senderRole,
      targetPaneId: paneRoles[senderRole],
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
    },
    stateWritten: true,
    liveDataImported: false,
    continuityLoaded: false,
  };
}

export function listPaneBridgeRoundTrips(
  env: NodeJS.ProcessEnv = process.env,
  options: { limit?: number; includeInternal?: boolean } = {},
): RuntimePaneBridgeRoundTripListResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    return {
      ok: true,
      protocol: "mira.runtime_pane_bridge_roundtrip_list.v0",
      stateRootPath: options.includeInternal ? stateRoot.path : null,
      roundTripCount: 0,
      records: [],
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
    };
  }

  const rootPath = path.resolve(stateRoot.path);
  const roundTripsDir = getRoundTripsDir(rootPath);
  if (!isInside(rootPath, roundTripsDir) || !fs.existsSync(roundTripsDir)) {
    return {
      ok: true,
      protocol: "mira.runtime_pane_bridge_roundtrip_list.v0",
      stateRootPath: options.includeInternal ? rootPath : null,
      roundTripCount: 0,
      records: [],
      sendPerformed: false,
      runtimeExecutes: false,
      externalSend: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
    };
  }

  const limit = Math.max(1, Math.min(100, Number.parseInt(String(options.limit || 20), 10) || 20));
  const records = fs.readdirSync(roundTripsDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(roundTripsDir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      try {
        return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as RuntimePaneBridgeRoundTripRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is RuntimePaneBridgeRoundTripRecord => Boolean(record))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));

  return {
    ok: true,
    protocol: "mira.runtime_pane_bridge_roundtrip_list.v0",
    stateRootPath: options.includeInternal ? rootPath : null,
    roundTripCount: records.length,
    records: records.slice(0, limit),
    sendPerformed: false,
    runtimeExecutes: false,
    externalSend: false,
    telegramRouteControl: false,
    uiSurfaceControl: false,
  };
}
