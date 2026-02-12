#!/usr/bin/env node
/**
 * hm-send: CLI tool for instant WebSocket messaging between agents
 * Usage: node hm-send.js <target> <message> [--role <role>] [--priority urgent]
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH, LEGACY_ROLE_ALIASES, ROLE_ID_MAP } = require('../config');

const parsedPort = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : 9900;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_ACK_TIMEOUT_MS = 1200;
const DEFAULT_HEALTH_TIMEOUT_MS = 500;
const TARGET_HEARTBEAT_STALE_MS = 60000;
const TARGET_HEARTBEAT_INTERVAL_MS = 30000;
const DEFAULT_RETRIES = 3;
const MAX_RETRIES = 5;
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: node hm-send.js <target> <message> [--role <role>] [--priority urgent]');
  console.log('  target: paneId (1,2,5) or role name (architect, devops, analyst)');
  console.log('  message: text to send');
  console.log('  --role: your role (for identification)');
  console.log('  --priority: normal or urgent');
  console.log('  --timeout: ack timeout in ms (default: 1200)');
  console.log('  --retries: retry count after first send (default: 3)');
  console.log('  --no-fallback: disable trigger file fallback');
  process.exit(1);
}

const target = args[0];
let role = 'cli';
let priority = 'normal';
let ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS;
let retries = DEFAULT_RETRIES;
let enableFallback = true;

// Collect message from all args between target and first --flag
// This handles PowerShell splitting quoted strings into multiple args
const messageParts = [];
let i = 1;
for (; i < args.length; i++) {
  if (args[i].startsWith('--')) break;
  messageParts.push(args[i]);
}

// Parse remaining --flags
for (; i < args.length; i++) {
  if (args[i] === '--role' && args[i+1]) {
    role = args[i+1];
    i++;
  }
  if (args[i] === '--priority' && args[i+1]) {
    priority = args[i+1];
    i++;
  }
  if (args[i] === '--timeout' && args[i+1]) {
    const parsed = Number.parseInt(args[i + 1], 10);
    if (Number.isFinite(parsed) && parsed >= 100) {
      ackTimeoutMs = parsed;
    }
    i++;
  }
  if (args[i] === '--retries' && args[i+1]) {
    const parsed = Number.parseInt(args[i + 1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      retries = Math.min(parsed, MAX_RETRIES);
    }
    i++;
  }
  if (args[i] === '--no-fallback') {
    enableFallback = false;
  }
}

const message = messageParts.join(' ');
if (!message) {
  console.error('Message cannot be empty.');
  process.exit(1);
}

function inferRoleFromMessage(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(/\(([A-Za-z-]+)\s+#\d+\):/);
  if (!match || !match[1]) return null;
  return normalizeRole(match[1]);
}

if (role === 'cli') {
  const inferred = inferRoleFromMessage(message);
  if (inferred) {
    role = inferred;
  }
}

function parseJSON(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (err) {
    return null;
  }
}

function waitForMatch(ws, predicate, timeoutMs, timeoutLabel) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutLabel || 'Timed out waiting for socket response'));
    }, timeoutMs);

    const onMessage = (raw) => {
      const msg = parseJSON(raw);
      if (!msg) return;
      if (!predicate(msg)) return;
      cleanup();
      resolve(msg);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed before response'));
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    function cleanup() {
      clearTimeout(timeout);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    }

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  });
}

function closeSocket(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === ws.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      try {
        ws.terminate();
      } catch (err) {
        // no-op
      }
      resolve();
    }, 250);

    ws.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      ws.close();
    } catch (err) {
      clearTimeout(timeout);
      resolve();
    }
  });
}

function normalizeRole(targetInput) {
  const paneToRole = {
    '1': 'architect',
    '2': 'devops',
    '5': 'analyst',
  };

  const targetValue = String(targetInput || '').trim().toLowerCase();
  if (!targetValue) return null;
  if (paneToRole[targetValue]) return paneToRole[targetValue];

  if (targetValue === 'architect' || targetValue === 'devops' || targetValue === 'analyst') {
    return targetValue;
  }

  if (LEGACY_ROLE_ALIASES[targetValue]) {
    return LEGACY_ROLE_ALIASES[targetValue];
  }

  const mappedPane = ROLE_ID_MAP[targetValue];
  if (mappedPane && paneToRole[String(mappedPane)]) {
    return paneToRole[String(mappedPane)];
  }

  return null;
}

function writeTriggerFallback(targetInput, content) {
  const roleName = normalizeRole(targetInput);
  if (!roleName) {
    return {
      ok: false,
      error: `Cannot map target '${targetInput}' to trigger file`,
    };
  }

  const triggersDir = path.join(WORKSPACE_PATH, 'triggers');
  const triggerPath = path.join(triggersDir, `${roleName}.txt`);
  const tempPath = path.join(
    triggersDir,
    `.${roleName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    fs.mkdirSync(triggersDir, { recursive: true });
    fs.writeFileSync(tempPath, content, 'utf8');
    try {
      fs.renameSync(tempPath, triggerPath);
    } catch (renameErr) {
      // Windows rename does not replace existing files; unlink then retry.
      if (renameErr.code === 'EEXIST' || renameErr.code === 'EPERM' || renameErr.code === 'EACCES') {
        try {
          fs.unlinkSync(triggerPath);
        } catch (unlinkErr) {
          if (unlinkErr.code !== 'ENOENT') {
            throw unlinkErr;
          }
        }
        fs.renameSync(tempPath, triggerPath);
      } else {
        throw renameErr;
      }
    }
    return { ok: true, role: roleName, path: triggerPath };
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Best-effort cleanup only.
    }
    return { ok: false, error: err.message };
  }
}

function shouldRetryAck(ack) {
  if (!ack || ack.ok) return false;
  const status = String(ack.status || '').toLowerCase();
  if (!status) return true;
  if (status === 'invalid_target') return false;
  return true;
}

function previewMessage(content) {
  if (content.length <= 50) return content;
  return `${content.substring(0, 50)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffDelayMs(baseTimeoutMs, attempt) {
  return baseTimeoutMs * Math.pow(2, attempt - 1);
}

async function emitHeartbeatBestEffort(ws, senderRole) {
  const normalizedRole = normalizeRole(senderRole);
  const paneId = normalizedRole ? String(ROLE_ID_MAP[normalizedRole] || '') : '';
  const heartbeatPayload = {
    type: 'heartbeat',
    role: normalizedRole || senderRole || null,
    paneId: paneId || null,
    intervalMs: TARGET_HEARTBEAT_INTERVAL_MS,
  };

  try {
    ws.send(JSON.stringify(heartbeatPayload));
    await waitForMatch(
      ws,
      (msg) => msg.type === 'heartbeat-ack',
      DEFAULT_HEALTH_TIMEOUT_MS,
      'Heartbeat ack timeout'
    );
  } catch (err) {
    // Health support can lag server/client versions; proceed without heartbeat gating.
  }
}

async function queryTargetHealthBestEffort(ws) {
  const requestId = `health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    ws.send(JSON.stringify({
      type: 'health-check',
      target,
      requestId,
      staleAfterMs: TARGET_HEARTBEAT_STALE_MS,
    }));

    const health = await waitForMatch(
      ws,
      (msg) => msg.type === 'health-check-result' && msg.requestId === requestId,
      DEFAULT_HEALTH_TIMEOUT_MS,
      'Health check timeout'
    );
    return health;
  } catch (err) {
    return null;
  }
}

function isTargetHealthBlocking(health) {
  if (!health || typeof health !== 'object') return false;
  const status = String(health.status || '').toLowerCase();
  if (status === 'invalid_target') {
    return true;
  }
  return false;
}

async function emitCommsEventBestEffort(eventType, payload = {}) {
  const socketUrl = `ws://127.0.0.1:${PORT}`;
  let ws = null;
  try {
    ws = new WebSocket(socketUrl);
    await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');

    ws.send(JSON.stringify({ type: 'register', role }));
    await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

    ws.send(JSON.stringify({
      type: 'comms-event',
      eventType,
      payload,
    }));

    // Give the socket a short tick to flush before closing.
    await sleep(25);
    await closeSocket(ws);
    return true;
  } catch (err) {
    if (ws) {
      try {
        await closeSocket(ws);
      } catch {
        // ignore close failures
      }
    }
    return false;
  }
}

async function sendViaWebSocketWithAck() {
  const socketUrl = `ws://127.0.0.1:${PORT}`;
  const ws = new WebSocket(socketUrl);

  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');

  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');
  await emitHeartbeatBestEffort(ws, role);

  const health = await queryTargetHealthBestEffort(ws);
  if (isTargetHealthBlocking(health)) {
    await closeSocket(ws);
    return {
      ok: false,
      skippedByHealth: true,
      health,
      attemptsUsed: 0,
      messageId: null,
    };
  }

  const messageId = `hm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const attempts = retries + 1;
  let lastAck = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    ws.send(JSON.stringify({
      type: 'send',
      target,
      content: message,
      priority,
      messageId,
      ackRequired: true,
      attempt,
      maxAttempts: attempts,
    }));

    try {
      const ack = await waitForMatch(
        ws,
        (msg) => msg.type === 'send-ack' && msg.messageId === messageId,
        ackTimeoutMs,
        `ACK timeout after ${ackTimeoutMs}ms`
      );
      lastAck = ack;

      if (ack.ok) {
        await closeSocket(ws);
        return {
          ok: true,
          messageId,
          ack,
          attemptsUsed: attempt,
        };
      }

      if (attempt >= attempts || !shouldRetryAck(ack)) {
        break;
      }

      const backoffDelay = getBackoffDelayMs(ackTimeoutMs, attempt);
      await sleep(backoffDelay);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts) {
        break;
      }

      const backoffDelay = getBackoffDelayMs(ackTimeoutMs, attempt);
      await sleep(backoffDelay);
    }
  }

  await closeSocket(ws);
  return {
    ok: false,
    messageId,
    ack: lastAck,
    error: lastError ? lastError.message : null,
    attemptsUsed: attempts,
  };
}

async function main() {
  let sendResult = null;
  let wsError = null;

  try {
    sendResult = await sendViaWebSocketWithAck();
  } catch (err) {
    wsError = err;
  }

  if (sendResult?.ok) {
    console.log(`Sent to ${target}: ${previewMessage(message)} (ack: ${sendResult.ack.status}, attempt ${sendResult.attemptsUsed})`);
    process.exit(0);
  }

  if (enableFallback) {
    const fallbackResult = writeTriggerFallback(target, message);
    if (fallbackResult.ok) {
      const reason = sendResult?.ack
        ? `ack=${sendResult.ack.status}`
        : sendResult?.skippedByHealth
          ? `health=${sendResult?.health?.status || 'unknown'}`
        : (sendResult?.error || wsError?.message || 'no_ack');
      await emitCommsEventBestEffort('comms.delivery.failed', {
        messageId: sendResult?.messageId || null,
        target,
        role,
        reason,
        attemptsUsed: sendResult?.attemptsUsed ?? (retries + 1),
        maxAttempts: retries + 1,
        fallbackUsed: true,
        fallbackPath: fallbackResult.path,
        ts: Date.now(),
      });
      console.warn(`WebSocket send unverified (${reason}). Wrote trigger fallback: ${fallbackResult.path}`);
      process.exit(0);
    }
    console.error(`WebSocket failed and fallback failed: ${fallbackResult.error}`);
    process.exit(1);
  }

  const reason = sendResult?.ack
    ? `ACK failed (${sendResult.ack.status})`
    : sendResult?.skippedByHealth
      ? `target health ${sendResult?.health?.status || 'unhealthy'}`
    : (sendResult?.error || wsError?.message || 'unknown error');
  console.error(`Send failed: ${reason}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
