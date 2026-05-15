import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateRootReadiness } from "./state-root.js";
import { readRuntimeTurnMemorySummary } from "./turn-memory.js";
import { listWorkDrafts } from "./work-draft.js";
import {
  listWorkReadyPackages,
  listWorkSendChecks,
  listWorkSendConfirmations,
  listWorkSendPackets,
  listWorkTasks,
} from "./work-task.js";

export type AutonomyQueueItem = {
  token: string;
  status: "pending";
  createdAt: string;
  key: string;
  title: string;
  reason: string;
  nextMove: string;
  permissionUsed: string;
  needsJames: false;
  blockedActions: string[];
};

export type AutonomyPolicy = {
  protocol: "mira.autonomy_policy.v0";
  standingPermissions: Array<{
    id: string;
    label: string;
    scope: string;
  }>;
  approvalRequiredFor: string[];
  localLoopAllowed: true;
  externalActionsAllowed: false;
  customerContactAllowed: false;
  moneyOrLegalAllowed: false;
};

export type AutonomyStatus = {
  ok: true;
  protocol: "mira.autonomy_status.v0";
  stateRootReady: boolean;
  policy: AutonomyPolicy;
  queueCount: number;
  queue: AutonomyQueueItem[];
  followThroughCount: number;
  followThrough: AutonomyFollowThroughItem[];
  brief: {
    available: boolean;
    title: string;
    lines: string[];
  };
  externalSend: false;
  crmMutation: false;
  telegramSend: false;
  runtimeExecutesExternalAction: false;
};

export type AutonomyTickResult = Omit<AutonomyStatus, "protocol"> & {
  protocol: "mira.autonomy_tick.v0";
  createdCount: number;
  reusedCount: number;
  briefWritten: boolean;
};

export type AutonomyFollowThroughItem = {
  token: string;
  status: "local_step_prepared";
  createdAt: string;
  queueToken: string;
  queueTitle: string;
  resultTitle: string;
  result: string;
  nextVisibleStep: string;
  evidence: string[];
  localOnly: true;
  externalSend: false;
  crmMutation: false;
  telegramSend: false;
  runtimeExecutesExternalAction: false;
};

export type AutonomyFollowThroughResult = Omit<AutonomyStatus, "protocol"> & {
  protocol: "mira.autonomy_follow_through.v0";
  createdCount: number;
  reusedCount: number;
};

type StoredAutonomyQueueItem = Omit<AutonomyQueueItem, "token"> & {
  protocol: "mira.autonomy_queue_item.v0";
  id: string;
};

type StoredAutonomyFollowThroughItem = Omit<AutonomyFollowThroughItem, "token" | "queueToken"> & {
  protocol: "mira.autonomy_follow_through_item.v0";
  id: string;
  queueItemId: string;
};

const blockedActions = [
  "customer send",
  "Telegram/user send",
  "CRM/ERP mutation",
  "money movement",
  "legal/tax filing",
  "delete or move live data",
  "deploy/trade/external network action",
];

export function defaultAutonomyPolicy(): AutonomyPolicy {
  return {
    protocol: "mira.autonomy_policy.v0",
    standingPermissions: [
      {
        id: "local_state_read",
        label: "Read Mira-owned local state",
        scope: "Mira may inspect her own state root, recent turns, local work queues, receipts, and review artifacts without asking again.",
      },
      {
        id: "local_state_write",
        label: "Write local notes, queues, briefs, and review artifacts",
        scope: "Mira may create local-only files under MIRA_STATE_ROOT for drafts, tasks, checks, briefs, and next-move queues.",
      },
      {
        id: "internal_team_plan",
        label: "Prepare internal agent nudges",
        scope: "Mira may prepare Builder/Oracle/Architect message plans for stuck work. Sending them remains an explicit internal lane until separately enabled.",
      },
    ],
    approvalRequiredFor: blockedActions,
    localLoopAllowed: true,
    externalActionsAllowed: false,
    customerContactAllowed: false,
    moneyOrLegalAllowed: false,
  };
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function autonomyRoot(rootPath: string): string {
  return path.resolve(rootPath, "autonomy");
}

function queueDir(rootPath: string): string {
  return path.resolve(autonomyRoot(rootPath), "queue");
}

function briefDir(rootPath: string): string {
  return path.resolve(autonomyRoot(rootPath), "briefs");
}

function followThroughDir(rootPath: string): string {
  return path.resolve(autonomyRoot(rootPath), "follow-through");
}

function policyPath(rootPath: string): string {
  return path.resolve(autonomyRoot(rootPath), "standing-permissions.json");
}

function todayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function actionToken(id: string): string {
  return `auto-${crypto.createHash("sha256").update(`mira.autonomy_queue_item.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function followThroughToken(id: string): string {
  return `follow-${crypto.createHash("sha256").update(`mira.autonomy_follow_through_item.v0:${id}`).digest("base64url").slice(0, 18)}`;
}

function publicQueueItem(record: StoredAutonomyQueueItem): AutonomyQueueItem {
  const { id: _id, protocol: _protocol, ...rest } = record;
  return {
    ...rest,
    token: actionToken(record.id),
  };
}

function parseQueueItem(value: string): StoredAutonomyQueueItem | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredAutonomyQueueItem>;
    if (parsed.protocol !== "mira.autonomy_queue_item.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "pending") return null;
    if (parsed.needsJames !== false) return null;
    return parsed as StoredAutonomyQueueItem;
  } catch {
    return null;
  }
}

function readStoredQueue(rootPath: string): StoredAutonomyQueueItem[] {
  const dir = queueDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseQueueItem(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is StoredAutonomyQueueItem => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

function readQueue(rootPath: string): AutonomyQueueItem[] {
  return readStoredQueue(rootPath).map(publicQueueItem);
}

function publicFollowThroughItem(record: StoredAutonomyFollowThroughItem): AutonomyFollowThroughItem {
  const { id: _id, protocol: _protocol, queueItemId, ...rest } = record;
  return {
    ...rest,
    token: followThroughToken(record.id),
    queueToken: actionToken(queueItemId),
  };
}

function parseFollowThroughItem(value: string): StoredAutonomyFollowThroughItem | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredAutonomyFollowThroughItem>;
    if (parsed.protocol !== "mira.autonomy_follow_through_item.v0" || typeof parsed.id !== "string") return null;
    if (parsed.status !== "local_step_prepared") return null;
    if (parsed.localOnly !== true) return null;
    if (parsed.externalSend !== false || parsed.crmMutation !== false || parsed.telegramSend !== false || parsed.runtimeExecutesExternalAction !== false) return null;
    return parsed as StoredAutonomyFollowThroughItem;
  } catch {
    return null;
  }
}

function readFollowThrough(rootPath: string): AutonomyFollowThroughItem[] {
  const dir = followThroughDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => {
      const absolutePath = path.resolve(dir, fileName);
      if (!isInside(rootPath, absolutePath)) return null;
      return parseFollowThroughItem(fs.readFileSync(absolutePath, "utf8"));
    })
    .filter((record): record is StoredAutonomyFollowThroughItem => Boolean(record))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
    .map(publicFollowThroughItem);
}

function writePolicyIfMissing(rootPath: string): boolean {
  const filePath = policyPath(rootPath);
  if (!isInside(rootPath, filePath) || fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(filePath, "wx");
  try {
    fs.writeFileSync(handle, `${JSON.stringify(defaultAutonomyPolicy(), null, 2)}\n`, "utf8");
  } finally {
    fs.closeSync(handle);
  }
  return true;
}

function workSnapshot(env: NodeJS.ProcessEnv): {
  drafts: number;
  pendingTasks: number;
  ready: number;
  notSent: number;
  confirmed: number;
  checked: number;
} {
  const tasks = listWorkTasks(env);
  return {
    drafts: listWorkDrafts(env).draftCount,
    pendingTasks: tasks.pendingCount,
    ready: listWorkReadyPackages(env).readyCount,
    notSent: listWorkSendPackets(env).packetCount,
    confirmed: listWorkSendConfirmations(env).confirmationCount,
    checked: listWorkSendChecks(env).checkCount,
  };
}

function buildBriefLines(env: NodeJS.ProcessEnv): string[] {
  const memory = readRuntimeTurnMemorySummary({ env });
  const work = workSnapshot(env);
  const rawSummary = memory.loaded && memory.summary?.summary
    ? memory.summary.summary
    : "No useful recent thread summary yet.";
  const summary = rawSummary.replace(/^Most recent thread:\s*/i, "");
  const pendingLabel = work.pendingTasks === 1 ? "1 pending task" : `${work.pendingTasks} pending tasks`;
  return [
    `Recent thread: ${summary}`,
    `Work state: ${work.drafts} drafts, ${pendingLabel}, ${work.ready} ready, ${work.notSent} not sent, ${work.confirmed} confirmed, ${work.checked} checked.`,
    "Standing local permissions are active for local state reads/writes, queue creation, and brief creation.",
    "Approval is still required for customer sends, money/legal actions, deletes, deploys, trades, and external system changes.",
  ];
}

function writeBrief(rootPath: string, env: NodeJS.ProcessEnv, now = new Date()): boolean {
  const dir = briefDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Autonomy brief destination escaped Mira state root."), { code: "unsafe_autonomy_path" });
  }
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.resolve(dir, `brief-${todayKey(now)}.json`);
  if (!isInside(rootPath, filePath)) {
    throw Object.assign(new Error("Autonomy brief file escaped Mira state root."), { code: "unsafe_autonomy_path" });
  }
  const payload = {
    protocol: "mira.autonomy_brief.v0",
    createdAt: now.toISOString(),
    title: "What Mira can keep moving",
    lines: buildBriefLines(env),
    externalSend: false,
    crmMutation: false,
    telegramSend: false,
    runtimeExecutesExternalAction: false,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return true;
}

function readLatestBrief(rootPath: string): AutonomyStatus["brief"] {
  const dir = briefDir(rootPath);
  if (!isInside(rootPath, dir) || !fs.existsSync(dir)) {
    return { available: false, title: "No autonomy brief yet", lines: [] };
  }
  const files = fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .reverse();
  for (const fileName of files) {
    const absolutePath = path.resolve(dir, fileName);
    if (!isInside(rootPath, absolutePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8")) as { title?: unknown; lines?: unknown };
      if (Array.isArray(parsed.lines)) {
        return {
          available: true,
          title: String(parsed.title || "Autonomy brief"),
          lines: parsed.lines.map((line) => String(line)).slice(0, 6),
        };
      }
    } catch {
      // Ignore malformed local evidence and keep looking.
    }
  }
  return { available: false, title: "No autonomy brief yet", lines: [] };
}

function queueTemplates(env: NodeJS.ProcessEnv, now = new Date()): Array<Omit<StoredAutonomyQueueItem, "id" | "createdAt" | "protocol">> {
  const work = workSnapshot(env);
  const day = todayKey(now);
  const workReason = work.pendingTasks > 0 || work.ready > 0 || work.notSent > 0
    ? `There is active local work: ${work.pendingTasks} pending, ${work.ready} ready, ${work.notSent} not sent.`
    : "No active work is moving; Mira should create a useful next target instead of waiting.";
  return [
    {
      key: `${day}:recent-memory-next-move`,
      status: "pending",
      title: "Use recent memory instead of waiting",
      reason: "James approved a non-frozen local loop. Recent thread memory should produce one next move without another prompt.",
      nextMove: "Read the recent memory summary, pick the most useful unresolved product/work gap, and create a local plan or draft for it.",
      permissionUsed: "local_state_read",
      needsJames: false,
      blockedActions,
    },
    {
      key: `${day}:work-queue-follow-through`,
      status: "pending",
      title: "Follow through on local work queue",
      reason: workReason,
      nextMove: "Inspect drafts/tasks/ready/send-checks and advance the next local-only step that does not contact a customer or mutate an external system.",
      permissionUsed: "local_state_read",
      needsJames: false,
      blockedActions,
    },
    {
      key: `${day}:agent-motion-watch`,
      status: "pending",
      title: "Watch agent motion",
      reason: "The repeated failure mode is agents parking after a green patch.",
      nextMove: "Prepare an internal Builder/Oracle nudge if the next lane stalls, with exact product gap and expected proof. Do not send externally.",
      permissionUsed: "internal_team_plan",
      needsJames: false,
      blockedActions,
    },
  ];
}

function createQueueItems(rootPath: string, env: NodeJS.ProcessEnv, now = new Date()): { created: number; reused: number } {
  const dir = queueDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Autonomy queue destination escaped Mira state root."), { code: "unsafe_autonomy_path" });
  }
  fs.mkdirSync(dir, { recursive: true });
  let created = 0;
  let reused = 0;
  for (const template of queueTemplates(env, now)) {
    const id = `autonomy-${crypto.createHash("sha256").update(template.key).digest("hex").slice(0, 16)}`;
    const filePath = path.resolve(dir, `${id}.json`);
    if (!isInside(rootPath, filePath)) {
      throw Object.assign(new Error("Autonomy queue file escaped Mira state root."), { code: "unsafe_autonomy_path" });
    }
    if (fs.existsSync(filePath)) {
      reused += 1;
      continue;
    }
    const record: StoredAutonomyQueueItem = {
      protocol: "mira.autonomy_queue_item.v0",
      id,
      createdAt: now.toISOString(),
      ...template,
    };
    const handle = fs.openSync(filePath, "wx");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(handle);
    }
    created += 1;
  }
  return { created, reused };
}

function followThroughForQueueItem(queueItem: StoredAutonomyQueueItem, env: NodeJS.ProcessEnv, now = new Date()): StoredAutonomyFollowThroughItem {
  const work = workSnapshot(env);
  const memory = readRuntimeTurnMemorySummary({ env });
  const memoryLine = memory.loaded && memory.summary?.summary
    ? memory.summary.summary.replace(/^Most recent thread:\s*/i, "")
    : "No useful recent thread summary yet.";
  const id = `follow-through-${crypto.createHash("sha256").update(queueItem.key).digest("hex").slice(0, 16)}`;

  let resultTitle = "Prepare the next local move";
  let result = queueItem.nextMove;
  let nextVisibleStep = "Open the Autonomy panel and choose the next local item to advance.";
  let evidence = [
    `Queue: ${queueItem.title}`,
    `Reason: ${queueItem.reason}`,
  ];

  if (queueItem.key.includes("recent-memory-next-move")) {
    resultTitle = "Carry the thread into the next answer";
    result = "Use the recent thread as live context, then answer the next user prompt from that context instead of re-quoting old messages or narrating the system.";
    nextVisibleStep = "Ask Mira one normal question in the chat and check whether she uses the recent thread naturally.";
    evidence = [
      `Recent thread: ${memoryLine}`,
      "Known product pressure: answer quality and useful follow-through matter more than status narration.",
    ];
  } else if (queueItem.key.includes("work-queue-follow-through")) {
    resultTitle = "Advance the local work queue";
    result = work.pendingTasks > 0
      ? "A pending review task exists. Open it, decide approve/edit/reject, then produce the next local artifact."
      : work.ready > 0
        ? "A ready item exists. Prepare the next local check or packet without sending it."
        : "No active local work is waiting. Create one useful local draft or plan from the current thread.";
    nextVisibleStep = work.pendingTasks > 0
      ? "Open the Review panel and handle the pending task."
      : work.ready > 0
        ? "Open Ready/Send prep and run the next local check."
        : "Use the chat or Draft button to create the next local work item.";
    evidence = [
      `Work counts: ${work.drafts} drafts, ${work.pendingTasks} pending, ${work.ready} ready, ${work.notSent} not sent, ${work.confirmed} confirmed, ${work.checked} checked.`,
    ];
  } else if (queueItem.key.includes("agent-motion-watch")) {
    resultTitle = "Keep the Windows team from parking";
    result = "If a lane goes quiet after a green patch, prepare a short internal nudge with the product gap, the next file/API/UI proof needed, and no ceremony.";
    nextVisibleStep = "Use this when Windows agents go quiet: send one exact nudge to the relevant pane, then keep moving.";
    evidence = [
      "Repeated failure mode: treating a green patch as a stopping point.",
      "Better loop: next product gap, next proof, then action.",
    ];
  }

  return {
    protocol: "mira.autonomy_follow_through_item.v0",
    id,
    status: "local_step_prepared",
    createdAt: now.toISOString(),
    queueItemId: queueItem.id,
    queueTitle: queueItem.title,
    resultTitle,
    result,
    nextVisibleStep,
    evidence,
    localOnly: true,
    externalSend: false,
    crmMutation: false,
    telegramSend: false,
    runtimeExecutesExternalAction: false,
  };
}

function createFollowThroughItems(rootPath: string, env: NodeJS.ProcessEnv): { created: number; reused: number } {
  const dir = followThroughDir(rootPath);
  if (!isInside(rootPath, dir)) {
    throw Object.assign(new Error("Autonomy follow-through destination escaped Mira state root."), { code: "unsafe_autonomy_path" });
  }
  fs.mkdirSync(dir, { recursive: true });
  let created = 0;
  let reused = 0;
  for (const queueItem of readStoredQueue(rootPath)) {
    const record = followThroughForQueueItem(queueItem, env);
    const filePath = path.resolve(dir, `${record.id}.json`);
    if (!isInside(rootPath, filePath)) {
      throw Object.assign(new Error("Autonomy follow-through file escaped Mira state root."), { code: "unsafe_autonomy_path" });
    }
    if (fs.existsSync(filePath)) {
      reused += 1;
      continue;
    }
    const handle = fs.openSync(filePath, "wx");
    try {
      fs.writeFileSync(handle, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(handle);
    }
    created += 1;
  }
  return { created, reused };
}

export function getAutonomyStatus(env: NodeJS.ProcessEnv = process.env): AutonomyStatus {
  const stateRoot = getStateRootReadiness(env);
  const rootPath = stateRoot.ready && stateRoot.path ? path.resolve(stateRoot.path) : null;
  const queue = rootPath ? readQueue(rootPath) : [];
  const followThrough = rootPath ? readFollowThrough(rootPath) : [];
  const brief = rootPath ? readLatestBrief(rootPath) : { available: false, title: "No autonomy brief yet", lines: [] };
  return {
    ok: true,
    protocol: "mira.autonomy_status.v0",
    stateRootReady: Boolean(rootPath),
    policy: defaultAutonomyPolicy(),
    queueCount: queue.length,
    queue,
    followThroughCount: followThrough.length,
    followThrough,
    brief,
    externalSend: false,
    crmMutation: false,
    telegramSend: false,
    runtimeExecutesExternalAction: false,
  };
}

export function runAutonomyFollowThrough(env: NodeJS.ProcessEnv = process.env): AutonomyFollowThroughResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before autonomy follow-through can run."), {
      code: "state_root_not_ready",
    });
  }
  const rootPath = path.resolve(stateRoot.path);
  const queue = readStoredQueue(rootPath);
  if (queue.length < 1) {
    runAutonomyTick(env);
  }
  const { created, reused } = createFollowThroughItems(rootPath, env);
  const status = getAutonomyStatus(env);
  return {
    ...status,
    protocol: "mira.autonomy_follow_through.v0",
    createdCount: created,
    reusedCount: reused,
  };
}

export function runAutonomyTick(env: NodeJS.ProcessEnv = process.env): AutonomyTickResult {
  const stateRoot = getStateRootReadiness(env);
  if (!stateRoot.ready || !stateRoot.path) {
    throw Object.assign(new Error(stateRoot.error || "MIRA_STATE_ROOT is required before autonomy ticks can run."), {
      code: "state_root_not_ready",
    });
  }
  const rootPath = path.resolve(stateRoot.path);
  const root = autonomyRoot(rootPath);
  if (!isInside(rootPath, root)) {
    throw Object.assign(new Error("Autonomy root escaped Mira state root."), { code: "unsafe_autonomy_path" });
  }
  fs.mkdirSync(root, { recursive: true });
  writePolicyIfMissing(rootPath);
  const { created, reused } = createQueueItems(rootPath, env);
  const briefWritten = writeBrief(rootPath, env);
  const status = getAutonomyStatus(env);
  return {
    ...status,
    protocol: "mira.autonomy_tick.v0",
    createdCount: created,
    reusedCount: reused,
    briefWritten,
  };
}
