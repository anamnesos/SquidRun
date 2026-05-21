import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAutonomyStatus, runAutonomyFollowThrough, runAutonomyLoopOnce, runAutonomyTick } from "./autonomy.js";
import { planManualBridgeRequest } from "./bridge-request-plan.js";
import { getModelProviderList, getModelProviderStatus } from "./model-status.js";
import { getCapabilities, getHealth, getSessionSkeleton, getStateRootStatus } from "./runtime.js";
import { getSquidRunContext } from "./squidrun-context.js";
import { runRuntimeTurn, type RuntimeTurnInput, type RuntimeTurnResponse } from "./turn.js";
import { readRuntimeTurnMemorySummary, refreshRuntimeTurnMemorySummary } from "./turn-memory.js";
import { appendRuntimeTurnJournal, listRuntimeTurnJournal } from "./turn-journal.js";
import { captureVoiceCorrection, listVoiceCorrections } from "./voice-correction.js";
import { createWorkDraft, listWorkDrafts } from "./work-draft.js";
import {
  createWorkSendConfirmation,
  createWorkSendCheck,
  createWorkSendPacket,
  createWorkReadyPackage,
  createWorkTaskFromDraft,
  createWorkTaskReview,
  getWorkSendConfirmation,
  getWorkSendCheck,
  getWorkSendPacket,
  getWorkReadyPackage,
  getWorkTaskReviewDetail,
  listWorkSendConfirmations,
  listWorkSendChecks,
  listWorkSendPackets,
  listWorkReadyPackages,
  listWorkTasks,
} from "./work-task.js";

const startedAt = Date.now();
const port = Number.parseInt(process.env.MIRA_RUNTIME_PORT ?? "47373", 10);
const MAX_JSON_BODY_BYTES = 64 * 1024;
const DEFAULT_AUTONOMY_LOOP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_AUTONOMY_LOOP_STARTUP_DELAY_MS = 2000;
const staticUiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui");
const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function sendStatic(response: ServerResponse, filePath: string): void {
  const payload = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function trySendStaticUi(requestUrl: URL, response: ServerResponse): boolean {
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const allowed = new Set(["/index.html", "/app.js", "/styles.css"]);
  if (!allowed.has(pathname)) return false;

  const filePath = path.resolve(staticUiRoot, pathname.slice(1));
  const relative = path.relative(staticUiRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(filePath)) {
    sendJson(response, 404, { error: "not_found" });
    return true;
  }

  sendStatic(response, filePath);
  return true;
}

function errorPayload(error: unknown): { error: { code: string; message: string; retryable: false } } {
  const maybeError = error as { code?: unknown; message?: unknown };
  return {
    error: {
      code: typeof maybeError?.code === "string" ? maybeError.code : "invalid_request",
      message: typeof maybeError?.message === "string" ? maybeError.message : String(error || "invalid request"),
      retryable: false,
    },
  };
}

function includeInternalFields(requestUrl: URL): boolean {
  const value = requestUrl.searchParams.get("includeInternal") || requestUrl.searchParams.get("internal") || "";
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

function buildVisibleReplyStatus(input: {
  held?: boolean;
  checked?: boolean;
  contentReplaced?: boolean;
}): Record<string, unknown> {
  const held = input.held === true;
  return {
    checked: input.checked === true,
    held,
    reason: held ? "held_for_visible_reply_quality" : null,
    visibleContentReplaced: input.contentReplaced === true,
    rejectedTextVisible: false,
    violationIdsVisible: false,
    diagnosticsVisible: false,
  };
}

function publicJournalRecord(record: Record<string, unknown>): Record<string, unknown> {
  const visibleReplyGate = record.visible_reply_gate && typeof record.visible_reply_gate === "object" && !Array.isArray(record.visible_reply_gate)
    ? record.visible_reply_gate as Record<string, unknown>
    : null;
  const heldReplyAudit = record.held_reply_audit && typeof record.held_reply_audit === "object" && !Array.isArray(record.held_reply_audit)
    ? record.held_reply_audit as Record<string, unknown>
    : null;
  const publicRecord = { ...record };
  delete publicRecord.visible_reply_gate;
  delete publicRecord.held_reply_audit;
  publicRecord.visible_reply_status = buildVisibleReplyStatus({
    held: visibleReplyGate?.held === true || heldReplyAudit?.held === true,
    checked: visibleReplyGate?.checked === true || heldReplyAudit?.checked === true,
    contentReplaced: heldReplyAudit?.visibleContentReplaced === true,
  });
  return publicRecord;
}

function publicJournalResult(journal: unknown): unknown {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return journal;
  const publicJournal = { ...journal } as Record<string, unknown>;
  if (publicJournal.record && typeof publicJournal.record === "object" && !Array.isArray(publicJournal.record)) {
    publicJournal.record = publicJournalRecord(publicJournal.record as Record<string, unknown>);
  }
  return publicJournal;
}

function publicJournalList(journal: ReturnType<typeof listRuntimeTurnJournal>): Record<string, unknown> & {
  records: Record<string, unknown>[];
} {
  return {
    ...journal,
    records: journal.records.map((record) => publicJournalRecord(record as unknown as Record<string, unknown>)),
  };
}

function publicRuntimeTurnResponse(turnResponse: RuntimeTurnResponse): Record<string, unknown> {
  const payload = { ...turnResponse } as Record<string, unknown>;
  const content = turnResponse.response.content;
  payload.visibleReply = {
    role: "mira",
    content,
    held: turnResponse.visibleReplyGate.held,
  };
  payload.visibleReplyStatus = buildVisibleReplyStatus({
    held: turnResponse.visibleReplyGate.held,
    checked: turnResponse.visibleReplyGate.checked,
    contentReplaced: turnResponse.heldReplyAudit.visibleContentReplaced,
  });
  delete payload.visibleReplyGate;
  delete payload.heldReplyAudit;
  if (payload.journal) {
    payload.journal = publicJournalResult(payload.journal);
  }
  return payload;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        reject(Object.assign(new Error("Request body exceeds maximum size."), { code: "request_body_too_large" }));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const rawBody = await readRequestBody(request);
  if (!rawBody.trim()) return {};
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new Error("Request body must be a JSON object."), { code: "invalid_json_body" });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const existingCode = (error as { code?: unknown })?.code;
    throw Object.assign(error instanceof Error ? error : new Error("Invalid JSON request body."), {
      code: typeof existingCode === "string" ? existingCode : "invalid_json",
    });
  }
}

function parseModelProvider(value: unknown): RuntimeTurnInput["modelProvider"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (["ollama", "ollama_chat", "local", "gemma", "openai", "openai_responses"].includes(normalized)) {
    return normalized as RuntimeTurnInput["modelProvider"];
  }
  throw Object.assign(new Error(`Unsupported Mira model provider: ${normalized}.`), { code: "unsupported_model_provider" });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function autonomyLoopDisabled(env: NodeJS.ProcessEnv): boolean {
  return ["0", "false", "off", "disabled"].includes(String(env.MIRA_AUTONOMY_LOOP || "").trim().toLowerCase());
}

export function startAutonomyBackgroundLoop(env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  if (autonomyLoopDisabled(env)) return null;

  const intervalMs = parsePositiveInteger(env.MIRA_AUTONOMY_LOOP_INTERVAL_MS, DEFAULT_AUTONOMY_LOOP_INTERVAL_MS);
  const startupDelayMs = parsePositiveInteger(env.MIRA_AUTONOMY_LOOP_STARTUP_DELAY_MS, DEFAULT_AUTONOMY_LOOP_STARTUP_DELAY_MS);
  let stopped = false;
  const run = (): void => {
    if (stopped) return;
    const nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    try {
      runAutonomyLoopOnce(env, { source: "timer", nextRunAt });
    } catch (error) {
      const maybeError = error as { message?: unknown };
      console.warn(`mira autonomy loop skipped: ${String(maybeError?.message || error)}`);
    }
  };

  const startupTimer = setTimeout(run, startupDelayMs);
  const intervalTimer = setInterval(run, intervalMs);
  startupTimer.unref?.();
  intervalTimer.unref?.();

  return () => {
    stopped = true;
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
  };
}

export async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (request.method === "POST" && requestUrl.pathname === "/bridge/manual-plan") {
    try {
      const body = await readJsonBody(request);
      const planInput = {
        targetRole: String(body.targetRole || body.target || body.role || ""),
        content: String(body.content || ""),
        sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
      };
      if (typeof body.messageId === "string") {
        Object.assign(planInput, { messageId: body.messageId });
      }
      if (typeof body.requestId === "string") {
        Object.assign(planInput, { requestId: body.requestId });
      }
      if (Array.isArray(body.evidence)) {
        Object.assign(planInput, { evidence: body.evidence as { kind: string; path?: string; summary?: string }[] });
      }
      const plan = planManualBridgeRequest(planInput);
      sendJson(response, 200, plan);
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/turn") {
    const startedAt = Date.now();
    let turnInput: RuntimeTurnInput | null = null;
    try {
      const body = await readJsonBody(request);
      turnInput = {
        text: String(body.text || body.message || ""),
      };
      if (typeof body.sessionId === "string") {
        Object.assign(turnInput, { sessionId: body.sessionId });
      }
      if (typeof body.messageId === "string") {
        Object.assign(turnInput, { messageId: body.messageId });
      }
      if (typeof body.requestId === "string") {
        Object.assign(turnInput, { requestId: body.requestId });
      }
      if (typeof body.suggestTeamPlanFor === "string") {
        Object.assign(turnInput, { suggestTeamPlanFor: body.suggestTeamPlanFor });
      }
      if (body.useModel === true || body.model === true || body.mode === "model") {
        Object.assign(turnInput, { useModel: true });
      }
      const modelProvider = parseModelProvider(body.modelProvider);
      if (modelProvider) {
        Object.assign(turnInput, { modelProvider });
      }
      if (typeof body.modelName === "string") {
        Object.assign(turnInput, { modelName: body.modelName });
      }
      const turnResponse = await runRuntimeTurn(turnInput);
      const journal = appendRuntimeTurnJournal({
        turnInput,
        startedAt,
        response: turnResponse,
      });
      const recentMemory = journal.written
        ? refreshRuntimeTurnMemorySummary()
        : readRuntimeTurnMemorySummary();
      Object.assign(turnResponse, {
        journal,
        recentMemory: {
          loaded: recentMemory.loaded,
          summary: recentMemory.summary?.summary || null,
          topics: recentMemory.summary?.topics || [],
          openLoops: recentMemory.summary?.open_loops || [],
          qualityNotes: recentMemory.summary?.quality_notes || [],
          sourceRecordCount: recentMemory.summary?.source_record_count || 0,
        },
      });
      sendJson(
        response,
        200,
        includeInternalFields(requestUrl) ? turnResponse : publicRuntimeTurnResponse(turnResponse),
      );
    } catch (error) {
      if (turnInput) {
        const journal = appendRuntimeTurnJournal({
          turnInput,
          startedAt,
          error,
        });
        if (journal.written) refreshRuntimeTurnMemorySummary();
      }
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/voice/correction") {
    try {
      const body = await readJsonBody(request);
      const capture = captureVoiceCorrection({
        prompt: String(body.prompt || body.text || ""),
        soundedFake: String(body.soundedFake || body.sounded_fake || body.response || ""),
        better: String(body.better || body.betterPhrasing || body.better_phrasing || ""),
        caseId: typeof body.caseId === "string" ? body.caseId : null,
        source: typeof body.source === "string" ? body.source : "runtime-ui",
        turnMetadata: body.turnMetadata && typeof body.turnMetadata === "object" && !Array.isArray(body.turnMetadata)
          ? body.turnMetadata as Record<string, unknown>
          : null,
      });
      sendJson(response, 200, capture);
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/work/drafts") {
    try {
      const body = await readJsonBody(request);
      const draft = createWorkDraft({
        text: String(body.text || body.request || body.prompt || ""),
        kind: typeof body.kind === "string" ? body.kind : "customer_reply",
        sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
        messageId: typeof body.messageId === "string" ? body.messageId : null,
        source: typeof body.source === "string" ? body.source : "runtime-ui",
      });
      sendJson(response, 200, draft);
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/work/tasks") {
    try {
      const body = await readJsonBody(request);
      const taskInput = {
        sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
        messageId: typeof body.messageId === "string" ? body.messageId : null,
        source: typeof body.source === "string" ? body.source : "runtime-ui",
      };
      if (typeof body.sourceDraftId === "string") {
        Object.assign(taskInput, { sourceDraftId: body.sourceDraftId });
      }
      if (typeof body.sourceDraftPath === "string") {
        Object.assign(taskInput, { sourceDraftPath: body.sourceDraftPath });
      }
      if (typeof body.sourceDraftToken === "string") {
        Object.assign(taskInput, { sourceDraftToken: body.sourceDraftToken });
      }
      const task = createWorkTaskFromDraft(taskInput);
      sendJson(response, 200, task);
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/work/task-review") {
    try {
      const body = await readJsonBody(request);
      const reviewInput = {
        decision: body.decision,
        editedDraftText: typeof body.editedDraftText === "string" ? body.editedDraftText : null,
        note: typeof body.note === "string" ? body.note : null,
      };
      if (typeof body.taskToken === "string") {
        Object.assign(reviewInput, { taskToken: body.taskToken });
      }
      if (typeof body.taskId === "string") {
        Object.assign(reviewInput, { taskId: body.taskId });
      }
      const review = createWorkTaskReview(reviewInput);
      sendJson(response, 200, review);
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/work/ready") {
    try {
      const body = await readJsonBody(request);
      const readyInput = {};
      if (typeof body.taskToken === "string") {
        Object.assign(readyInput, { taskToken: body.taskToken });
      }
      if (typeof body.taskId === "string") {
        Object.assign(readyInput, { taskId: body.taskId });
      }
      if (typeof body.reviewToken === "string") {
        Object.assign(readyInput, { reviewToken: body.reviewToken });
      }
      const ready = createWorkReadyPackage(readyInput);
      sendJson(response, 200, ready);
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/work/send-packets") {
    try {
      const body = await readJsonBody(request);
      const packet = createWorkSendPacket({
        readyToken: typeof body.readyToken === "string" ? body.readyToken : "",
        recipient: body.recipient,
        channel: body.channel,
      });
      sendJson(response, 200, packet);
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/work/send-confirmations") {
    try {
      const body = await readJsonBody(request);
      const confirmation = createWorkSendConfirmation({
        packetToken: typeof body.packetToken === "string" ? body.packetToken : "",
        confirmText: body.confirmText,
        confirmedBy: body.confirmedBy,
        status: body.status,
      });
      sendJson(response, 200, confirmation);
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/work/send-checks") {
    try {
      const body = await readJsonBody(request);
      const check = createWorkSendCheck({
        confirmationToken: typeof body.confirmationToken === "string" ? body.confirmationToken : "",
        refresh: body.refresh === true,
      });
      sendJson(response, 200, check);
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/autonomy/tick") {
    try {
      sendJson(response, 200, runAutonomyTick());
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/autonomy/follow-through") {
    try {
      sendJson(response, 200, runAutonomyFollowThrough());
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/autonomy/loop/run") {
    try {
      sendJson(response, 200, runAutonomyLoopOnce(process.env, { source: "manual" }));
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  if (trySendStaticUi(requestUrl, response)) {
    return;
  }

  if (requestUrl.pathname === "/voice/corrections") {
    sendJson(response, 200, listVoiceCorrections());
    return;
  }

  if (requestUrl.pathname === "/conversation/recent") {
    const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "20", 10);
    const journal = listRuntimeTurnJournal({ limit });
    sendJson(response, 200, includeInternalFields(requestUrl) ? journal : publicJournalList(journal));
    return;
  }

  if (requestUrl.pathname === "/conversation/memory") {
    const memory = readRuntimeTurnMemorySummary();
    sendJson(response, 200, memory.loaded ? memory : refreshRuntimeTurnMemorySummary());
    return;
  }

  if (requestUrl.pathname === "/model/status") {
    sendJson(response, 200, await getModelProviderStatus());
    return;
  }

  if (requestUrl.pathname === "/model/providers") {
    sendJson(response, 200, await getModelProviderList());
    return;
  }

  if (requestUrl.pathname === "/work/drafts") {
    sendJson(response, 200, listWorkDrafts(process.env, { includeInternal: includeInternalFields(requestUrl) }));
    return;
  }

  if (requestUrl.pathname === "/work/tasks") {
    sendJson(response, 200, listWorkTasks(process.env, { includeInternal: includeInternalFields(requestUrl) }));
    return;
  }

  if (requestUrl.pathname === "/work/task-review") {
    try {
      const detailInput = {};
      const taskToken = requestUrl.searchParams.get("taskToken");
      const taskId = requestUrl.searchParams.get("taskId");
      if (taskToken) Object.assign(detailInput, { taskToken });
      if (taskId) Object.assign(detailInput, { taskId });
      sendJson(response, 200, getWorkTaskReviewDetail(detailInput));
    } catch (error) {
      sendJson(response, 400, errorPayload(error));
    }
    return;
  }

  if (requestUrl.pathname === "/work/ready") {
    const readyToken = requestUrl.searchParams.get("readyToken");
    if (readyToken) {
      try {
        sendJson(response, 200, getWorkReadyPackage({ readyToken }));
      } catch (error) {
        sendJson(response, 400, errorPayload(error));
      }
      return;
    }
    sendJson(response, 200, listWorkReadyPackages());
    return;
  }

  if (requestUrl.pathname === "/work/send-packets") {
    const packetToken = requestUrl.searchParams.get("packetToken");
    if (packetToken) {
      try {
        sendJson(response, 200, getWorkSendPacket({ packetToken }));
      } catch (error) {
        sendJson(response, 400, errorPayload(error));
      }
      return;
    }
    sendJson(response, 200, listWorkSendPackets());
    return;
  }

  if (requestUrl.pathname === "/work/send-confirmations") {
    const confirmationToken = requestUrl.searchParams.get("confirmationToken");
    if (confirmationToken) {
      try {
        sendJson(response, 200, getWorkSendConfirmation({ confirmationToken }));
      } catch (error) {
        sendJson(response, 400, errorPayload(error));
      }
      return;
    }
    sendJson(response, 200, listWorkSendConfirmations());
    return;
  }

  if (requestUrl.pathname === "/work/send-checks") {
    const checkToken = requestUrl.searchParams.get("checkToken");
    if (checkToken) {
      try {
        sendJson(response, 200, getWorkSendCheck({ checkToken }));
      } catch (error) {
        sendJson(response, 400, errorPayload(error));
      }
      return;
    }
    sendJson(response, 200, listWorkSendChecks());
    return;
  }

  if (requestUrl.pathname === "/autonomy/status") {
    sendJson(response, 200, getAutonomyStatus());
    return;
  }

  if (requestUrl.pathname === "/squidrun/context") {
    sendJson(response, 200, getSquidRunContext());
    return;
  }

  if (requestUrl.pathname === "/health") {
    sendJson(response, 200, getHealth(startedAt));
    return;
  }

  if (requestUrl.pathname === "/capabilities") {
    sendJson(response, 200, getCapabilities());
    return;
  }

  if (requestUrl.pathname === "/session") {
    sendJson(response, 200, getSessionSkeleton());
    return;
  }

  if (requestUrl.pathname === "/state-root") {
    sendJson(response, 200, getStateRootStatus());
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

export function createMiraRuntimeServer(): http.Server {
  return http.createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      sendJson(response, 500, errorPayload(error));
    });
  });
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const server = createMiraRuntimeServer();
  const stopAutonomyLoop = startAutonomyBackgroundLoop();
  server.on("close", () => {
    stopAutonomyLoop?.();
  });
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    console.log(`mira-runtime listening on http://127.0.0.1:${boundPort}`);
  });
}
