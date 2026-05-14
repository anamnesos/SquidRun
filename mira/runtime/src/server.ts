import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planManualBridgeRequest } from "./bridge-request-plan.js";
import { getCapabilities, getHealth, getSessionSkeleton, getStateRootStatus } from "./runtime.js";

const startedAt = Date.now();
const port = Number.parseInt(process.env.MIRA_RUNTIME_PORT ?? "47373", 10);
const MAX_JSON_BODY_BYTES = 64 * 1024;

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
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

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
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
