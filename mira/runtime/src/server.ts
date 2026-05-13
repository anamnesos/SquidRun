import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { getCapabilities, getHealth, getSessionSkeleton, getStateRootStatus } from "./runtime.js";

const startedAt = Date.now();
const port = Number.parseInt(process.env.MIRA_RUNTIME_PORT ?? "47373", 10);

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);

  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

function route(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

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

const server = http.createServer(route);

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  console.log(`mira-runtime listening on http://127.0.0.1:${boundPort}`);
});
