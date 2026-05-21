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

const allowedRoles = new Set(["architect", "builder", "oracle"]);

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function previewsDir(rootPath: string): string {
  return path.resolve(rootPath, "mission-control", "route-previews");
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

function toPublicRecord(record: MissionControlRoutePreviewRecord): MissionControlRoutePreviewRecord & { actionToken: string } {
  return {
    ...record,
    actionToken: buildActionToken(record.id),
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
  const dir = previewsDir(rootPath);
  const previews = !isInside(rootPath, dir) || !fs.existsSync(dir)
    ? []
    : fs.readdirSync(dir)
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => {
        const absolutePath = path.resolve(dir, fileName);
        if (!isInside(rootPath, absolutePath)) return null;
        const record = parseStoredRecord(fs.readFileSync(absolutePath, "utf8"));
        if (!record) return null;
        const publicRecord = toPublicRecord(record);
        if (!options.includeInternal) return publicRecord;
        return {
          ...publicRecord,
          relativePath: path.relative(rootPath, absolutePath).replace(/\\/g, "/"),
          absolutePath,
        };
      })
      .filter((record): record is NonNullable<typeof record> => Boolean(record))
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));

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
