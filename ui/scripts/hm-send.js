#!/usr/bin/env node
/**
 * hm-send: CLI tool for instant WebSocket messaging between agents
 * Usage: node hm-send.js <target> <message> [--role <role>] [--priority urgent]
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const {
  WORKSPACE_PATH,
  LEGACY_ROLE_ALIASES,
  ROLE_ID_MAP,
  setProjectRoot,
  resolveCoordPath,
} = require('../config');
const {
  appendCommsJournalEntry,
  closeCommsJournalStores,
} = require('../modules/main/comms-journal');

const parsedPort = Number.parseInt(process.env.HM_SEND_PORT || '9900', 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : 9900;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_HEALTH_TIMEOUT_MS = 500;
const TARGET_HEARTBEAT_STALE_MS = 60000;
const DEFAULT_TRIGGER_VERIFY_TIMEOUT_MS = Number.parseInt(
  process.env.HIVEMIND_DELIVERY_VERIFY_TIMEOUT_MS || '7000',
  10
);
const DEFAULT_ACK_TIMEOUT_BUFFER_MS = Number.parseInt(
  process.env.HM_SEND_ACK_TIMEOUT_BUFFER_MS || '1500',
  10
);
const DEFAULT_ACK_TIMEOUT_MS = Math.max(
  1200,
  (Number.isFinite(DEFAULT_TRIGGER_VERIFY_TIMEOUT_MS) ? DEFAULT_TRIGGER_VERIFY_TIMEOUT_MS : 5000)
    + (Number.isFinite(DEFAULT_ACK_TIMEOUT_BUFFER_MS) ? DEFAULT_ACK_TIMEOUT_BUFFER_MS : 1500)
);
const DEFAULT_DELIVERY_CHECK_TIMEOUT_MS = Number.parseInt(
  process.env.HM_SEND_DELIVERY_CHECK_TIMEOUT_MS || '1200',
  10
);
const DEFAULT_DELIVERY_CHECK_MAX_CHECKS = Number.parseInt(
  process.env.HM_SEND_DELIVERY_CHECK_MAX_CHECKS || '6',
  10
);
const DELIVERY_CHECK_RETRY_DELAY_MS = Number.parseInt(
  process.env.HM_SEND_DELIVERY_CHECK_RETRY_MS || '250',
  10
);
const FORCE_FALLBACK_ON_UNVERIFIED = process.env.HM_SEND_FORCE_FALLBACK_ON_UNVERIFIED !== '0';
const DEFAULT_RETRIES = 3;
const MAX_RETRIES = 5;
const FALLBACK_MESSAGE_ID_PREFIX = '[HM-MESSAGE-ID:';
const SPECIAL_USER_TARGETS = new Set(['user', 'telegram']);
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Usage: node hm-send.js <target> <message> [--role <role>] [--priority urgent]');
  console.log('  target: paneId (1,2,5), role name (architect, builder, oracle), or user/telegram');
  console.log('  message: text to send');
  console.log('  --role: your role (for identification)');
  console.log('  --priority: normal or urgent');
  console.log(`  --timeout: ack timeout in ms (default: ${DEFAULT_ACK_TIMEOUT_MS})`);
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
    if (Number.isFinite(parsed) && parsed >= 10) {
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

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function findNearestProjectLinkFile(startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(currentDir, '.hivemind', 'link.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function resolveProjectContextFromLink(startDir = process.cwd()) {
  const linkPath = findNearestProjectLinkFile(startDir);
  if (!linkPath) return null;

  const payload = readJsonFileSafe(linkPath);
  if (!payload || typeof payload !== 'object') return null;

  const fallbackProjectPath = path.resolve(path.join(path.dirname(linkPath), '..'));
  const workspaceValue = typeof payload.workspace === 'string'
    ? payload.workspace.trim()
    : '';
  const projectPath = workspaceValue
    ? path.resolve(workspaceValue)
    : fallbackProjectPath;
  const sessionId = typeof payload.session_id === 'string'
    ? payload.session_id.trim()
    : (typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '');

  if (!projectPath) return null;

  return {
    source: 'link.json',
    linkPath,
    projectPath,
    projectName: path.basename(projectPath),
    sessionId: sessionId || null,
  };
}

function readProjectContextFromState() {
  const candidates = [];
  if (typeof resolveCoordPath === 'function') {
    candidates.push(resolveCoordPath('state.json'));
  }
  candidates.push(path.join(WORKSPACE_PATH, 'state.json'));

  for (const candidate of candidates) {
    const parsed = readJsonFileSafe(candidate);
    const projectValue = typeof parsed?.project === 'string'
      ? parsed.project.trim()
      : '';
    if (!projectValue) continue;
    const projectPath = path.resolve(projectValue);
    return {
      source: 'state.json',
      statePath: candidate,
      projectPath,
      projectName: path.basename(projectPath),
    };
  }

  return null;
}

function resolveLocalProjectContext(startDir = process.cwd()) {
  const fromLink = resolveProjectContextFromLink(startDir);
  if (fromLink?.projectPath) return fromLink;

  const fromState = readProjectContextFromState();
  if (fromState?.projectPath) return fromState;

  const cwdPath = path.resolve(startDir);
  return {
    source: 'cwd',
    projectPath: cwdPath,
    projectName: path.basename(cwdPath),
  };
}

function applyProjectContext(projectContext = null) {
  if (!projectContext?.projectPath) return null;
  if (typeof setProjectRoot === 'function') {
    try {
      setProjectRoot(projectContext.projectPath);
    } catch (_) {
      // Best-effort only; keep hm-send resilient.
    }
  }
  return projectContext;
}

const localProjectContext = applyProjectContext(resolveLocalProjectContext(process.cwd()));

function buildProjectMetadata(context = localProjectContext) {
  if (!context?.projectPath) return null;
  const projectPath = String(context.projectPath || '').trim();
  const projectName = String(context.projectName || path.basename(projectPath) || '').trim();
  const sessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : '';
  if (!projectPath && !projectName) return null;
  return {
    name: projectName || null,
    path: projectPath || null,
    session_id: sessionId || null,
    source: String(context.source || 'unknown'),
  };
}

const projectMetadata = buildProjectMetadata(localProjectContext);

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
    '2': 'builder',
    '5': 'oracle',
  };

  const targetValue = String(targetInput || '').trim().toLowerCase();
  if (!targetValue) return null;
  if (paneToRole[targetValue]) return paneToRole[targetValue];

  if (targetValue === 'architect' || targetValue === 'builder' || targetValue === 'oracle') {
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

function isSpecialTarget(targetInput) {
  const normalized = String(targetInput || '').trim().toLowerCase();
  return SPECIAL_USER_TARGETS.has(normalized);
}

function buildTriggerFallbackContent(content, messageId) {
  if (typeof messageId !== 'string' || !messageId.trim()) {
    return content;
  }
  return `${FALLBACK_MESSAGE_ID_PREFIX}${messageId.trim()}]\n${content}`;
}

function writeTriggerFallback(targetInput, content, options = {}) {
  const roleName = normalizeRole(targetInput);
  if (!roleName) {
    return {
      ok: false,
      error: `Cannot map target '${targetInput}' to trigger file`,
    };
  }

  const triggersDir = typeof resolveCoordPath === 'function'
    ? resolveCoordPath('triggers', { forWrite: true })
    : path.join(WORKSPACE_PATH, 'triggers');
  const triggerPath = path.join(triggersDir, `${roleName}.txt`);
  const tempPath = path.join(
    triggersDir,
    `.${roleName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  const payload = buildTriggerFallbackContent(content, options.messageId);
  try {
    fs.mkdirSync(triggersDir, { recursive: true });
    fs.writeFileSync(tempPath, payload, 'utf8');
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
  if (ack.accepted === true) return false;
  const status = String(ack.status || '').toLowerCase();
  if (!status) return true;
  if (status === 'invalid_target' || status === 'submit_not_accepted' || status === 'accepted.unverified') return false;
  return true;
}

function previewMessage(content) {
  if (content.length <= 50) return content;
  return `${content.substring(0, 50)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldFallbackForUnverifiedSend(result, targetInput) {
  if (!FORCE_FALLBACK_ON_UNVERIFIED) return false;
  if (!result || result.ok !== true) return false;
  if (result.delivered !== false) return false;
  if (isSpecialTarget(targetInput)) return false;
  const status = String(result?.ack?.status || '').toLowerCase();
  if (!status) return true;
  return (
    status.includes('unverified')
    || status.includes('timeout')
    || status.includes('pending')
    || status.includes('routed')
  );
}

function getBackoffDelayMs(baseTimeoutMs, attempt) {
  return baseTimeoutMs * Math.pow(2, attempt - 1);
}

function normalizePositiveInt(value, fallback, min = 1) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
}

function getDeliveryCheckOptions(ackTimeoutValue) {
  const ackTimeout = Number.isFinite(ackTimeoutValue) ? ackTimeoutValue : DEFAULT_ACK_TIMEOUT_MS;
  const perCheckTimeoutMs = Math.max(
    200,
    Math.min(
      normalizePositiveInt(DEFAULT_DELIVERY_CHECK_TIMEOUT_MS, 1200),
      Math.max(DEFAULT_HEALTH_TIMEOUT_MS, ackTimeout)
    )
  );
  const maxChecks = ackTimeout < 1000
    ? 2
    : normalizePositiveInt(DEFAULT_DELIVERY_CHECK_MAX_CHECKS, 6);
  return {
    perCheckTimeoutMs,
    maxChecks,
    retryDelayMs: normalizePositiveInt(DELIVERY_CHECK_RETRY_DELAY_MS, 250, 0),
  };
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

async function queryDeliveryCheckBestEffort(ws, messageId, options = {}) {
  if (!messageId) return null;
  const maxChecks = normalizePositiveInt(options.maxChecks, 2);
  const perCheckTimeoutMs = normalizePositiveInt(options.perCheckTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS);
  const retryDelayMs = normalizePositiveInt(options.retryDelayMs, DELIVERY_CHECK_RETRY_DELAY_MS, 0);

  for (let check = 1; check <= maxChecks; check++) {
    const requestId = `delivery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      ws.send(JSON.stringify({
        type: 'delivery-check',
        requestId,
        messageId,
      }));

      const result = await waitForMatch(
        ws,
        (msg) => msg.type === 'delivery-check-result' && msg.requestId === requestId,
        perCheckTimeoutMs,
        'Delivery check timeout'
      );

      if (result?.status === 'pending' && check < maxChecks) {
        await sleep(retryDelayMs);
        continue;
      }

      return result;
    } catch (err) {
      return null;
    }
  }

  return null;
}

function isTargetHealthBlocking(health, targetInput = target) {
  if (!health || typeof health !== 'object') return false;
  const status = String(health.status || '').toLowerCase();
  if (status === 'invalid_target') {
    if (isSpecialTarget(targetInput)) {
      return false;
    }
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

async function sendViaWebSocketWithAck(messageId) {
  const socketUrl = `ws://127.0.0.1:${PORT}`;
  const ws = new WebSocket(socketUrl);

  await waitForMatch(ws, (msg) => msg.type === 'welcome', DEFAULT_CONNECT_TIMEOUT_MS, 'Connection timeout');

  ws.send(JSON.stringify({ type: 'register', role }));
  await waitForMatch(ws, (msg) => msg.type === 'registered', DEFAULT_CONNECT_TIMEOUT_MS, 'Registration timeout');

  const health = await queryTargetHealthBestEffort(ws);
  if (isTargetHealthBlocking(health, target)) {
    await closeSocket(ws);
    return {
      ok: false,
      skippedByHealth: true,
      health,
      attemptsUsed: 0,
      messageId,
    };
  }

  const attempts = retries + 1;
  let lastAck = null;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    ws.send(JSON.stringify({
      type: 'send',
      target,
      content: message,
      priority,
      metadata: projectMetadata ? { project: projectMetadata } : undefined,
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
          delivered: true,
          accepted: true,
          messageId,
          ack,
          attemptsUsed: attempt,
        };
      }

      if (ack.accepted === true) {
        await closeSocket(ws);
        return {
          ok: true,
          delivered: false,
          accepted: true,
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

  const deliveryCheck = await queryDeliveryCheckBestEffort(
    ws,
    messageId,
    getDeliveryCheckOptions(ackTimeoutMs)
  );
  if (deliveryCheck?.known && (deliveryCheck?.ack?.ok || deliveryCheck?.ack?.accepted === true)) {
    await closeSocket(ws);
    return {
      ok: true,
      delivered: Boolean(deliveryCheck?.ack?.ok),
      accepted: true,
      messageId,
      ack: deliveryCheck.ack,
      attemptsUsed: attempts,
      deliveryCheck,
    };
  }

  await closeSocket(ws);
  return {
    ok: false,
    messageId,
    ack: lastAck,
    deliveryCheck,
    error: lastError ? lastError.message : null,
    attemptsUsed: attempts,
  };
}

async function main() {
  const messageId = `hm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const targetRole = normalizeRole(target)
    || (isSpecialTarget(target) ? String(target).trim().toLowerCase() : null);
  const preSendJournal = appendCommsJournalEntry({
    messageId,
    sessionId: projectMetadata?.session_id || null,
    senderRole: role || 'cli',
    targetRole,
    channel: 'ws',
    direction: 'outbound',
    sentAtMs: Date.now(),
    rawBody: message,
    status: 'recorded',
    attempt: 1,
    metadata: {
      source: 'hm-send',
      priority,
      maxAttempts: retries + 1,
      project: projectMetadata || null,
      targetRaw: target,
    },
  });

  if (preSendJournal?.ok !== true) {
    console.warn(`Comms journal pre-send record unavailable: ${preSendJournal?.reason || 'unknown'}`);
  }

  let sendResult = null;
  let wsError = null;

  try {
    sendResult = await sendViaWebSocketWithAck(messageId);
  } catch (err) {
    wsError = err;
  }

  if (sendResult?.ok) {
    if (enableFallback && shouldFallbackForUnverifiedSend(sendResult, target)) {
      const fallbackResult = writeTriggerFallback(target, message, {
        messageId: sendResult?.messageId || null,
      });
      if (fallbackResult.ok) {
        const reason = sendResult?.ack?.status
          ? `ack=${sendResult.ack.status}`
          : 'accepted_unverified';
        await emitCommsEventBestEffort('comms.delivery.failed', {
          messageId: sendResult?.messageId || null,
          target,
          role,
          project: projectMetadata || null,
          reason,
          attemptsUsed: sendResult?.attemptsUsed ?? (retries + 1),
          maxAttempts: retries + 1,
          fallbackUsed: true,
          fallbackPath: fallbackResult.path,
          ts: Date.now(),
        });
        console.warn(
          `Accepted by ${target} but unverified: ${previewMessage(message)} `
          + `(ack: ${sendResult.ack.status}, attempt ${sendResult.attemptsUsed}). `
          + `Forced trigger fallback: ${fallbackResult.path}`
        );
        closeCommsJournalStores();
        process.exit(0);
      }
      console.warn(
        `Accepted by ${target} but unverified: ${previewMessage(message)} `
        + `(ack: ${sendResult.ack.status}, attempt ${sendResult.attemptsUsed}). `
        + `Forced fallback failed: ${fallbackResult.error}`
      );
      closeCommsJournalStores();
      process.exit(0);
    }

    if (sendResult.delivered === false) {
      console.log(
        `Accepted by ${target} but unverified: ${previewMessage(message)} `
        + `(ack: ${sendResult.ack.status}, attempt ${sendResult.attemptsUsed}). `
        + 'Delivery may already have happened; avoid immediate resend.'
      );
    } else {
      console.log(`Delivered to ${target}: ${previewMessage(message)} (ack: ${sendResult.ack.status}, attempt ${sendResult.attemptsUsed})`);
    }
    closeCommsJournalStores();
    process.exit(0);
  }

  if (enableFallback) {
    const fallbackResult = writeTriggerFallback(target, message, {
      messageId: sendResult?.messageId || null,
    });
    if (fallbackResult.ok) {
      const reason = sendResult?.ack
        ? `ack=${sendResult.ack.status}`
        : sendResult?.deliveryCheck
          ? `delivery-check=${sendResult.deliveryCheck.status || 'unknown'}`
        : sendResult?.skippedByHealth
          ? `health=${sendResult?.health?.status || 'unknown'}`
        : (sendResult?.error || wsError?.message || 'no_ack');
      await emitCommsEventBestEffort('comms.delivery.failed', {
        messageId: sendResult?.messageId || null,
        target,
        role,
        project: projectMetadata || null,
        reason,
        attemptsUsed: sendResult?.attemptsUsed ?? (retries + 1),
        maxAttempts: retries + 1,
        fallbackUsed: true,
        fallbackPath: fallbackResult.path,
        ts: Date.now(),
      });
      console.warn(`WebSocket send unverified (${reason}). Wrote trigger fallback: ${fallbackResult.path}`);
      closeCommsJournalStores();
      process.exit(0);
    }
    console.error(`WebSocket failed and fallback failed: ${fallbackResult.error}`);
    closeCommsJournalStores();
    process.exit(1);
  }

  const reason = sendResult?.ack
    ? `ACK failed (${sendResult.ack.status})`
    : sendResult?.deliveryCheck
      ? `delivery-check ${sendResult.deliveryCheck.status || 'unknown'}`
    : sendResult?.skippedByHealth
      ? `target health ${sendResult?.health?.status || 'unhealthy'}`
    : (sendResult?.error || wsError?.message || 'unknown error');
  console.error(`Send failed: ${reason}`);
  closeCommsJournalStores();
  process.exit(1);
}

main().catch((err) => {
  closeCommsJournalStores();
  console.error('Fatal error:', err.message);
  process.exit(1);
});
