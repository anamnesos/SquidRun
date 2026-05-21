import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { planManualBridgeRequest, type ManualBridgeRequestPlan } from "./bridge-request-plan.js";

type JsonObject = Record<string, unknown>;

export type SquidRunProjectContext = {
  ok: true;
  protocol: "mira.squidrun_context.v0";
  source: "local_squidrun_files";
  project: {
    name: string;
    workspace: string | null;
    squidrunRoot: string;
    sessionId: string | null;
  };
  lane: {
    loaded: boolean;
    status: string | null;
    sourceRef: string | null;
    targetRole: string | null;
    objective: string | null;
    nextAction: string | null;
    generatedAt: string | null;
  };
  ownedWork: {
    loaded: boolean;
    active: Array<{
      agent: string;
      taskId: string | null;
      title: string | null;
      nextStep: string | null;
    }>;
    pendingCount: number;
  };
  git: {
    loaded: boolean;
    branch: string | null;
    dirtyCount: number;
    shortStat: string | null;
    statusPreview: string[];
  };
  dirtyWork: {
    loaded: boolean;
    summary: string;
    files: string[];
  };
  systemMap: {
    loaded: boolean;
    relativePath: "docs/mira-system-map.md";
    truth: string | null;
    nextGate: string | null;
  };
  roadmap: {
    loaded: boolean;
    relativePath: "docs/mira-north-star-roadmap.md";
    hardTruth: string | null;
    firstDemo: string | null;
    stopPivot: string | null;
  };
  recentComms: {
    loaded: boolean;
    latestBuilderInstruction: {
      sourceRef: string | null;
      excerpt: string | null;
    } | null;
    oracleBenchmark: {
      sourceRef: string | null;
      excerpt: string | null;
    } | null;
  };
  missionControl: {
    question: "what is happening here, and what happens next?";
    foundationVsProduct: string;
    answer: string;
    nextTeamMove: string;
    jamesAction: "NONE" | "DO THIS";
    jamesActionReason: string;
    coordinationDrafts: Array<{
      target: "architect" | "builder" | "oracle";
      purpose: string;
      message: string;
    }>;
    internalRoutePreview: {
      status: "reviewed_preview_only";
      selectedDraftTarget: "architect" | "builder" | "oracle";
      selectedDraftPurpose: string;
      plan: ManualBridgeRequestPlan;
      audit: {
        reviewStatus: "preview_ready";
        sendPerformed: false;
        runtimeExecutes: false;
        externalSend: false;
        routeFlip: false;
        providerInvoked: false;
        note: string;
      };
    };
    evidence: string[];
  };
  summary: {
    headline: string;
    happening: string;
    nextStep: string;
    jamesAction: "NONE" | "DO THIS";
    jamesActionReason: string;
  };
  reads: {
    link: boolean;
    currentLane: boolean;
    ownedWorkQueue: boolean;
    gitStatus: boolean;
    systemMap: boolean;
    roadmap: boolean;
    recentComms: boolean;
  };
};

function trimText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text || null;
}

function preview(value: unknown, maxLength = 190): string | null {
  const text = trimText(value);
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function safeCommsPreview(value: unknown, maxLength = 260): string | null {
  return preview(value, maxLength)
    ?.replace(/`?JAMES ACTION:[^`.\n]*`?/gi, "James-action line")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function readJsonObject(filePath: string): JsonObject | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function readText(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function hasSquidRunLink(candidate: string): boolean {
  return fs.existsSync(path.join(candidate, ".squidrun", "link.json"));
}

function findSquidRunRoot(startPath: string): string {
  let current = path.resolve(startPath || process.cwd());
  if (!fs.existsSync(current)) current = process.cwd();
  const stats = fs.existsSync(current) ? fs.statSync(current) : null;
  if (stats?.isFile()) current = path.dirname(current);

  for (;;) {
    if (hasSquidRunLink(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startPath || process.cwd());
    current = parent;
  }
}

function resolveSquidRunRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  const candidates = [
    env.SQUIDRUN_WORKSPACE,
    env.SQUIDRUN_PROJECT_ROOT,
    env.SQUIDRUN_ROOT,
    cwd,
  ].map((value) => trimText(value)).filter(Boolean) as string[];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (hasSquidRunLink(resolved)) return resolved;
  }

  return findSquidRunRoot(cwd);
}

function objectValue(input: JsonObject | null, key: string): JsonObject | null {
  const value = input?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function arrayValue(input: JsonObject | null, key: string): unknown[] {
  const value = input?.[key];
  return Array.isArray(value) ? value : [];
}

function summarizeLane(currentLane: JsonObject | null): SquidRunProjectContext["lane"] {
  const activeLane = objectValue(currentLane, "activeLane");
  const continuity = objectValue(currentLane, "continuity");
  return {
    loaded: Boolean(currentLane),
    status: trimText(currentLane?.status),
    sourceRef: trimText(activeLane?.sourceRef),
    targetRole: trimText(activeLane?.targetRole),
    objective: preview(activeLane?.objective),
    nextAction: preview(continuity?.next_action),
    generatedAt: trimText(currentLane?.generatedAt),
  };
}

function summarizeOwnedWork(queue: JsonObject | null): SquidRunProjectContext["ownedWork"] {
  const agents = objectValue(queue, "agents");
  const active: SquidRunProjectContext["ownedWork"]["active"] = [];
  let pendingCount = 0;

  for (const [agent, rawBucket] of Object.entries(agents || {})) {
    const bucket = rawBucket && typeof rawBucket === "object" && !Array.isArray(rawBucket)
      ? rawBucket as JsonObject
      : null;
    const activeTask = objectValue(bucket, "active");
    if (activeTask) {
      active.push({
        agent,
        taskId: trimText(activeTask.taskId || activeTask.id),
        title: preview(activeTask.title || activeTask.message, 120),
        nextStep: preview(activeTask.nextStep, 160),
      });
    }
    pendingCount += arrayValue(bucket, "pending").length;
  }

  return {
    loaded: Boolean(queue),
    active,
    pendingCount,
  };
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return null;
  }
}

function readGitStatus(squidrunRoot: string): SquidRunProjectContext["git"] {
  const branch = git(["branch", "--show-current"], squidrunRoot);
  const status = git(["status", "--short"], squidrunRoot);
  const shortStat = git(["diff", "--shortstat"], squidrunRoot);
  if (branch === null && status === null) {
    return {
      loaded: false,
      branch: null,
      dirtyCount: 0,
      shortStat: null,
      statusPreview: [],
    };
  }

  const lines = (status || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    loaded: true,
    branch: branch || null,
    dirtyCount: lines.length,
    shortStat: shortStat || null,
    statusPreview: lines.slice(0, 8),
  };
}

function statusLinePath(line: string): string {
  return line
    .replace(/^([?AMDRCU ]{1,2})\s+/, "")
    .replace(/^(.+)\s+->\s+/, "")
    .trim();
}

function summarizeDirtyWork(gitStatus: SquidRunProjectContext["git"]): SquidRunProjectContext["dirtyWork"] {
  if (!gitStatus.loaded) {
    return {
      loaded: false,
      summary: "Git status is not available.",
      files: [],
    };
  }

  const files = gitStatus.statusPreview.map(statusLinePath).filter(Boolean);
  if (gitStatus.dirtyCount === 0) {
    return {
      loaded: true,
      summary: "Worktree is clean.",
      files,
    };
  }

  const fileText = files.length > 0 ? files.slice(0, 5).join(", ") : "files not listed";
  const more = gitStatus.dirtyCount > files.length ? ` and ${gitStatus.dirtyCount - files.length} more` : "";
  return {
    loaded: true,
    summary: `${gitStatus.dirtyCount} changed file(s): ${fileText}${more}.`,
    files,
  };
}

function firstLineContaining(text: string, pattern: RegExp): string | null {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-|]\s*/, "").trim())
    .find((line) => pattern.test(line)) || null;
}

function readSystemMapTruth(squidrunRoot: string): SquidRunProjectContext["systemMap"] {
  const relativePath = "docs/mira-system-map.md" as const;
  const text = readText(path.join(squidrunRoot, relativePath));
  if (!text) {
    return {
      loaded: false,
      relativePath,
      truth: null,
      nextGate: null,
    };
  }

  return {
    loaded: true,
    relativePath,
    truth: preview(
      firstLineContaining(text, /not impressive yet|New Mira .*local workbench|inside James|actual SquidRun|generic agents/i)
        || firstLineContaining(text, /New Mira .*prototype|local workbench/i),
      220,
    ),
    nextGate: preview(
      firstLineContaining(text, /Usefulness next gate|current next slices|product-surface|workbench/i),
      220,
    ),
  };
}

function readRoadmapTruth(squidrunRoot: string): SquidRunProjectContext["roadmap"] {
  const relativePath = "docs/mira-north-star-roadmap.md" as const;
  const text = readText(path.join(squidrunRoot, relativePath));
  if (!text) {
    return {
      loaded: false,
      relativePath,
      hardTruth: null,
      firstDemo: null,
      stopPivot: null,
    };
  }

  return {
    loaded: true,
    relativePath,
    hardTruth: preview(firstLineContaining(text, /Current New Mira is not holy-shit amazing/i), 220),
    firstDemo: preview(firstLineContaining(text, /Mira Mission Control|Mission Control v0|First Inspectable Demo/i), 220),
    stopPivot: preview(firstLineContaining(text, /Stop or pivot|Stop \/ Pivot Criteria|three product lanes/i), 220),
  };
}

function sourceRefFromBody(rawBody: string | null, sender: string | null): string | null {
  if (!rawBody || !sender) return null;
  const match = rawBody.match(/\(([A-Z]+)\s+#(\d+)\)/);
  if (!match) return sender;
  return `${match[1]?.toLowerCase()}#${match[2]}`;
}

function readRecentComms(squidrunRoot: string): SquidRunProjectContext["recentComms"] {
  const scriptPath = path.join(squidrunRoot, "ui", "scripts", "hm-comms.js");
  if (!fs.existsSync(scriptPath)) {
    return {
      loaded: false,
      latestBuilderInstruction: null,
      oracleBenchmark: null,
    };
  }

  try {
    const stdout = execFileSync(process.execPath, [
      scriptPath,
      "history",
      "--last",
      "30",
      "--json",
    ], {
      cwd: squidrunRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2500,
    });
    const parsed = JSON.parse(stdout) as JsonObject;
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const mapped = rows
      .map((row) => row && typeof row === "object" && !Array.isArray(row) ? row as JsonObject : null)
      .filter(Boolean) as JsonObject[];
    const builderRows = mapped.filter((row) => trimText(row.sender) === "architect" && trimText(row.target) === "builder");
    const builderInstruction = builderRows.find((row) => {
      const body = trimText(row.rawBody) || "";
      return /Mission Control|north-star|holy-shit|first inspectable demo|operator surface/i.test(body)
        && !/status ping|status check/i.test(body);
    }) || builderRows[0];
    const oracleBenchmark = mapped.find((row) => {
      const body = trimText(row.rawBody) || "";
      return trimText(row.sender) === "oracle" && /benchmark|holy-shit|not impressive|current New Mira/i.test(body);
    });

    return {
      loaded: true,
      latestBuilderInstruction: builderInstruction ? {
        sourceRef: sourceRefFromBody(trimText(builderInstruction.rawBody), trimText(builderInstruction.sender)),
        excerpt: safeCommsPreview(builderInstruction.rawBody, 260),
      } : null,
      oracleBenchmark: oracleBenchmark ? {
        sourceRef: sourceRefFromBody(trimText(oracleBenchmark.rawBody), trimText(oracleBenchmark.sender)),
        excerpt: safeCommsPreview(oracleBenchmark.rawBody, 260),
      } : null,
    };
  } catch {
    return {
      loaded: false,
      latestBuilderInstruction: null,
      oracleBenchmark: null,
    };
  }
}

function buildMissionControl(input: {
  projectName: string;
  lane: SquidRunProjectContext["lane"];
  dirtyWork: SquidRunProjectContext["dirtyWork"];
  systemMap: SquidRunProjectContext["systemMap"];
  roadmap: SquidRunProjectContext["roadmap"];
  recentComms: SquidRunProjectContext["recentComms"];
  fallbackNextStep: string;
}): SquidRunProjectContext["missionControl"] {
  const laneLabel = input.recentComms.latestBuilderInstruction?.sourceRef
    || input.lane.sourceRef
    || input.lane.status
    || "local lane";
  const laneText = input.recentComms.latestBuilderInstruction?.excerpt
    || input.lane.objective
    || "No current lane objective found.";
  const hardTruth = input.roadmap.hardTruth
    || "Current New Mira is not holy-shit amazing.";
  const firstDemo = input.roadmap.firstDemo
    || "First inspectable demo: Mira Mission Control.";
  const nextTeamMove = "Builder should finish the Mission Control v0 proof packet; Oracle should challenge it against the benchmark; after commit, the team should auto-open the next operator-like capability slice.";
  const jamesActionReason = "This is local, inspectable, dry-run Mission Control work; no bot, channel, account, token, external send, or route switch is needed.";
  const foundationVsProduct = "SquidRun context is foundation. The product test is whether Mira can operate as Mission Control for James's AI team.";
  const oracleLine = input.recentComms.oracleBenchmark?.sourceRef
    ? `Benchmark gate: ${input.recentComms.oracleBenchmark.sourceRef} says current New Mira is not impressive yet; the demo must prove command-layer usefulness.`
    : `Benchmark gate: ${hardTruth} ${firstDemo}`;
  const answerLines = [
    `Project/lane: ${input.projectName} / ${laneLabel}. ${laneText}`,
    `Dirty work: ${input.dirtyWork.summary}`,
    oracleLine,
    `Foundation vs product: ${foundationVsProduct}`,
    `Next team move: ${nextTeamMove}`,
    `JAMES ACTION: NONE - ${jamesActionReason}`,
  ];
  const coordinationDrafts: SquidRunProjectContext["missionControl"]["coordinationDrafts"] = [
    {
      target: "builder",
      purpose: "implementation",
      message: "Build Mission Control v0 from local SquidRun evidence: lane, git dirt, map/roadmap truth, owned-work continuation, and recent Architect/Oracle checkpoints. Keep sends dry-run.",
    },
    {
      target: "oracle",
      purpose: "benchmark review",
      message: "Challenge Mission Control v0 against the external-agent benchmark. PASS only if it is more useful than a context card and does not overclaim current New Mira.",
    },
  ];
  const selectedDraft = coordinationDrafts.find((draft) => draft.target === "oracle") ?? coordinationDrafts[0]!;
  const evidence = [
    ".squidrun/link.json",
    ".squidrun/handoffs/current-lane.json",
    ".squidrun/runtime/agent-task-queue.json",
    "git status --short",
    "docs/mira-system-map.md",
    "docs/mira-north-star-roadmap.md",
    "hm-comms history --last 30 --json",
    input.fallbackNextStep,
  ].filter(Boolean);
  const routePlan = planManualBridgeRequest({
    targetRole: selectedDraft.target,
    content: selectedDraft.message,
    messageId: "mira-mission-control-route-preview-v0",
    requestId: "req-mira-mission-control-route-preview-v0",
    evidence: evidence.slice(0, 6).map((item) => {
      const text = String(item);
      const isFile = text.includes(".") || text.includes("/");
      return {
        kind: isFile ? "file" : "summary",
        ...(isFile ? { path: text } : {}),
        summary: text,
      };
    }),
  });

  return {
    question: "what is happening here, and what happens next?",
    foundationVsProduct,
    answer: answerLines.join("\n"),
    nextTeamMove,
    jamesAction: "NONE",
    jamesActionReason,
    coordinationDrafts,
    internalRoutePreview: {
      status: "reviewed_preview_only",
      selectedDraftTarget: selectedDraft.target,
      selectedDraftPurpose: selectedDraft.purpose,
      plan: routePlan,
      audit: {
        reviewStatus: "preview_ready",
        sendPerformed: false,
        runtimeExecutes: false,
        externalSend: false,
        routeFlip: false,
        providerInvoked: false,
        note: "Mission Control prepared this internal route preview for review only; no hm-send, Telegram, model/provider, or external route was invoked.",
      },
    },
    evidence,
  };
}

export function getSquidRunContext(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): SquidRunProjectContext {
  const squidrunRoot = resolveSquidRunRoot(env, cwd);
  const link = readJsonObject(path.join(squidrunRoot, ".squidrun", "link.json"));
  const currentLane = readJsonObject(path.join(squidrunRoot, ".squidrun", "handoffs", "current-lane.json"));
  const queue = readJsonObject(path.join(squidrunRoot, ".squidrun", "runtime", "agent-task-queue.json"));
  const gitStatus = readGitStatus(squidrunRoot);
  const dirtyWork = summarizeDirtyWork(gitStatus);
  const systemMap = readSystemMapTruth(squidrunRoot);
  const roadmap = readRoadmapTruth(squidrunRoot);
  const recentComms = readRecentComms(squidrunRoot);

  const workspace = trimText(link?.workspace) || squidrunRoot;
  const projectName = path.basename(workspace || squidrunRoot) || "squidrun";
  const lane = summarizeLane(currentLane);
  const ownedWork = summarizeOwnedWork(queue);
  const fallbackNextStep = lane.nextAction
    || ownedWork.active[0]?.nextStep
    || "No current local next step found.";
  const missionControl = buildMissionControl({
    projectName,
    lane,
    dirtyWork,
    systemMap,
    roadmap,
    recentComms,
    fallbackNextStep,
  });
  const laneLabel = lane.sourceRef ? `${lane.sourceRef}` : lane.status || "local context";
  const happening = lane.objective
    ? `Working in ${projectName} on ${laneLabel}: ${lane.objective}`
    : `${projectName} local project context is loaded.`;

  return {
    ok: true,
    protocol: "mira.squidrun_context.v0",
    source: "local_squidrun_files",
    project: {
      name: projectName,
      workspace,
      squidrunRoot,
      sessionId: trimText(link?.session_id),
    },
    lane,
    ownedWork,
    git: gitStatus,
    dirtyWork,
    systemMap,
    roadmap,
    recentComms,
    missionControl,
    summary: {
      headline: `${projectName}: Mission Control local evidence loaded`,
      happening,
      nextStep: missionControl.nextTeamMove,
      jamesAction: "NONE",
      jamesActionReason: missionControl.jamesActionReason,
    },
    reads: {
      link: Boolean(link),
      currentLane: Boolean(currentLane),
      ownedWorkQueue: Boolean(queue),
      gitStatus: gitStatus.loaded,
      systemMap: systemMap.loaded,
      roadmap: roadmap.loaded,
      recentComms: recentComms.loaded,
    },
  };
}
