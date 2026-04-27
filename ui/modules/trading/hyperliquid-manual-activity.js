'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { resolveCoordPath } = require('../../config');

const DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_PATH = resolveCoordPath(
  path.join('runtime', 'hyperliquid-manual-activity.json'),
  { forWrite: true }
);
const DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_TTL_MS = 45_000;
const DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_HEARTBEAT_MS = 5_000;

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function readJsonFileSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFileSafe(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function readManualHyperliquidActivity(filePath = DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_PATH) {
  return readJsonFileSafe(filePath);
}

function isManualHyperliquidActivityActive(activity = null, options = {}) {
  const candidate = activity && typeof activity === 'object' ? activity : null;
  if (!candidate) {
    return false;
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const expiresAtMs = Date.parse(candidate.expiresAt || '');
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

function buildManualHyperliquidActivityRecord({
  ownerId,
  command = 'hyperliquid_manual',
  caller = 'manual',
  metadata = {},
  pid = process.pid,
  ttlMs = DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_TTL_MS,
} = {}) {
  const startedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  return {
    ownerId,
    command,
    caller,
    pid,
    startedAt,
    lastHeartbeatAt: startedAt,
    expiresAt,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };
}

function refreshManualHyperliquidActivityLease(lease = {}) {
  const existing = readManualHyperliquidActivity(lease.filePath);
  if (existing?.ownerId !== lease.ownerId) {
    return false;
  }
  const refreshed = {
    ...existing,
    lastHeartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + lease.ttlMs).toISOString(),
  };
  writeJsonFileSafe(lease.filePath, refreshed);
  return true;
}

function clearManualHyperliquidActivityLease(lease = {}) {
  try {
    const existing = readManualHyperliquidActivity(lease.filePath);
    if (existing?.ownerId !== lease.ownerId) {
      return false;
    }
    fs.unlinkSync(lease.filePath);
    return true;
  } catch {
    return false;
  }
}

async function withManualHyperliquidActivity(task, options = {}) {
  if (typeof task !== 'function') {
    throw new Error('withManualHyperliquidActivity requires a task function');
  }

  const caller = String(options.caller || process.env.SQUIDRUN_HYPERLIQUID_CALLER || 'manual')
    .trim()
    .toLowerCase();
  if (caller === 'supervisor') {
    return task();
  }

  const filePath = options.filePath || DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_PATH;
  const ttlMs = toPositiveInteger(options.ttlMs, DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_TTL_MS);
  const heartbeatMs = Math.min(
    ttlMs,
    toPositiveInteger(options.heartbeatMs, DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_HEARTBEAT_MS)
  );
  const ownerId = crypto.randomUUID();
  const initialRecord = buildManualHyperliquidActivityRecord({
    ownerId,
    command: options.command || 'hyperliquid_manual',
    caller,
    metadata: options.metadata,
    pid: options.pid || process.pid,
    ttlMs,
  });
  const lease = {
    ownerId,
    filePath,
    ttlMs,
  };

  writeJsonFileSafe(filePath, initialRecord);

  let heartbeatTimer = null;
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      try {
        const stillOwned = refreshManualHyperliquidActivityLease(lease);
        if (!stillOwned && heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      } catch {}
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  try {
    return await task();
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    clearManualHyperliquidActivityLease(lease);
  }
}

module.exports = {
  DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_PATH,
  DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_TTL_MS,
  DEFAULT_HYPERLIQUID_MANUAL_ACTIVITY_HEARTBEAT_MS,
  readManualHyperliquidActivity,
  isManualHyperliquidActivityActive,
  withManualHyperliquidActivity,
};
