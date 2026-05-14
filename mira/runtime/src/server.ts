import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planManualBridgeRequest } from "./bridge-request-plan.js";
import { getModelProviderStatus } from "./model-status.js";
import { getCapabilities, getHealth, getSessionSkeleton, getStateRootStatus } from "./runtime.js";
import { runRuntimeTurn } from "./turn.js";
import { captureVoiceCorrection, listVoiceCorrections } from "./voice-correction.js";
import { createWorkDraft, listWorkDrafts } from "./work-draft.js";
import { createWorkTaskFromDraft, listWorkTasks } from "./work-task.js";

const startedAt = Date.now();
const port = Number.parseInt(process.env.MIRA_RUNTIME_PORT ?? "47373", 10);
const MAX_JSON_BODY_BYTES = 64 * 1024;
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
    try {
      const body = await readJsonBody(request);
      const turnInput = {
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
      sendJson(response, 200, await runRuntimeTurn(turnInput));
    } catch (error) {
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
      const task = createWorkTaskFromDraft(taskInput);
      sendJson(response, 200, task);
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

  if (requestUrl.pathname === "/model/status") {
    sendJson(response, 200, await getModelProviderStatus());
    return;
  }

  if (requestUrl.pathname === "/work/drafts") {
    sendJson(response, 200, listWorkDrafts());
    return;
  }

  if (requestUrl.pathname === "/work/tasks") {
    sendJson(response, 200, listWorkTasks());
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
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;
    console.log(`mira-runtime listening on http://127.0.0.1:${boundPort}`);
  });
}
