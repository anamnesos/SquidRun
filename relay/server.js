#!/usr/bin/env node

const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number.parseInt(process.env.PORT || '8788', 10);
const HOST = process.env.HOST || '0.0.0.0';
const RELAY_SHARED_SECRET = String(
  process.env.RELAY_SHARED_SECRET
  || process.env.SQUIDRUN_RELAY_SECRET
  || ''
).trim();
const RELAY_DEVICE_ALLOWLIST_RAW = String(
  process.env.RELAY_DEVICE_ALLOWLIST
  || process.env.SQUIDRUN_RELAY_DEVICE_ALLOWLIST
  || ''
).trim();
const RELAY_ALLOWED_TARGET_ROLE = 'architect';
const PENDING_TTL_MS = Number.parseInt(process.env.RELAY_PENDING_TTL_MS || '20000', 10);
const STRUCTURED_BRIDGE_TYPE_ALIASES = Object.freeze({
  fyi: 'FYI',
  conflictcheck: 'ConflictCheck',
  blocker: 'Blocker',
  approval: 'Approval',
  conflictresult: 'ConflictResult',
  approvalresult: 'ApprovalResult',
});

if (!RELAY_SHARED_SECRET) {
  console.error('[relay] Missing RELAY_SHARED_SECRET (or SQUIDRUN_RELAY_SECRET).');
  process.exit(1);
}

function nowMs() {
  return Date.now();
}

function asText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeDeviceId(value) {
  const text = asText(value).toUpperCase();
  if (!text) return '';
  return text.replace(/[^A-Z0-9_-]/g, '');
}

function parseFrame(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch (_) {
    return null;
  }
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function normalizeStructuredBridgeType(typeInput) {
  const key = asText(typeInput).toLowerCase();
  if (!key) return null;
  return STRUCTURED_BRIDGE_TYPE_ALIASES[key] || null;
}

function normalizeStructuredBridgeMessage(structuredInput, fallbackContent = '') {
  const structured = asObject(structuredInput);
  if (!structured) return null;

  const normalizedType = normalizeStructuredBridgeType(structured.type);
  const payloadInput = asObject(structured.payload);
  const payload = payloadInput ? { ...payloadInput } : {};
  if (normalizedType) {
    return { type: normalizedType, payload };
  }

  const originalType = asText(structured.type) || null;
  return {
    type: 'FYI',
    payload: {
      category: asText(payload.category) || 'status',
      detail: asText(payload.detail) || asText(fallbackContent) || 'Structured message update',
      impact: asText(payload.impact) || 'context-only',
      ...payload,
      originalType,
    },
  };
}

function normalizeBridgeMetadata(metadataInput, fallbackContent = '', options = {}) {
  const ensureStructured = options && options.ensureStructured === true;
  const metadata = asObject(metadataInput);
  const normalized = metadata ? { ...metadata } : {};

  if (ensureStructured || Object.prototype.hasOwnProperty.call(normalized, 'structured')) {
    const structured = normalizeStructuredBridgeMessage(normalized.structured, fallbackContent);
    normalized.structured = structured || {
      type: 'FYI',
      payload: {
        category: 'status',
        detail: asText(fallbackContent) || 'Structured message update',
        impact: 'context-only',
        originalType: null,
      },
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function parseAllowlistedDevices(raw) {
  if (!raw) return new Set();
  const set = new Set();
  for (const token of String(raw).split(/[,\s]+/)) {
    const normalized = normalizeDeviceId(token);
    if (normalized) set.add(normalized);
  }
  return set;
}

function resolveTargetRole(frame = {}) {
  const direct = asText(frame.targetRole).toLowerCase();
  if (direct) return direct;
  const metadata = asObject(frame.metadata);
  if (!metadata) return '';
  const metadataTargetRole = asText(
    metadata.targetRole
    || metadata.target_role
    || metadata?.envelope?.target?.role
  ).toLowerCase();
  return metadataTargetRole;
}

function sendJson(ws, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (_) {
    return false;
  }
}

const wss = new WebSocketServer({ host: HOST, port: PORT });
const clients = new Map(); // ws -> { id, deviceId, registered }
const socketsByDevice = new Map(); // deviceId -> ws
const pendingByMessageId = new Map(); // messageId -> { senderWs, fromDevice, toDevice, createdAt, timer }
const allowlistedDevices = parseAllowlistedDevices(RELAY_DEVICE_ALLOWLIST_RAW);
let clientSeq = 0;

function listConnectedDeviceIds() {
  const connected = [];
  for (const [deviceId, socket] of socketsByDevice.entries()) {
    if (!deviceId) continue;
    if (!socket || socket.readyState !== WebSocket.OPEN) continue;
    connected.push(deviceId);
  }
  connected.sort();
  return connected;
}

function clearPending(messageId) {
  const pending = pendingByMessageId.get(messageId);
  if (!pending) return null;
  pendingByMessageId.delete(messageId);
  if (pending.timer) clearTimeout(pending.timer);
  return pending;
}

function createPendingAckTimeout(messageId) {
  return setTimeout(() => {
    const pending = clearPending(messageId);
    if (!pending) return;
    sendJson(pending.senderWs, {
      type: 'xack',
      messageId,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'target_ack_timeout',
      error: 'Target did not acknowledge in time',
      fromDevice: pending.fromDevice,
      toDevice: pending.toDevice,
    });
  }, Math.max(1000, PENDING_TTL_MS));
}

function evictClient(ws, reason = 'disconnect') {
  const info = clients.get(ws);
  if (!info) return;

  clients.delete(ws);
  if (info.deviceId && socketsByDevice.get(info.deviceId) === ws) {
    socketsByDevice.delete(info.deviceId);
  }

  for (const [messageId, pending] of pendingByMessageId.entries()) {
    if (!pending) continue;

    if (pending.senderWs === ws) {
      clearPending(messageId);
      continue;
    }

    if (pending.toDevice === info.deviceId) {
      clearPending(messageId);
      sendJson(pending.senderWs, {
        type: 'xack',
        messageId,
        ok: false,
        accepted: false,
        queued: false,
        verified: false,
        status: 'target_disconnected',
        error: `Target ${info.deviceId} disconnected (${reason})`,
        fromDevice: pending.fromDevice,
        toDevice: pending.toDevice,
      });
    }
  }
}

function handleRegister(ws, frame) {
  const deviceId = normalizeDeviceId(frame.deviceId);
  const sharedSecret = asText(frame.sharedSecret);
  if (!deviceId || !sharedSecret) {
    sendJson(ws, { type: 'register-ack', ok: false, error: 'deviceId and sharedSecret are required' });
    ws.close(1008, 'invalid register');
    return;
  }
  if (sharedSecret !== RELAY_SHARED_SECRET) {
    sendJson(ws, { type: 'register-ack', ok: false, error: 'invalid shared secret' });
    ws.close(1008, 'auth failed');
    return;
  }
  if (allowlistedDevices.size > 0 && !allowlistedDevices.has(deviceId)) {
    sendJson(ws, { type: 'register-ack', ok: false, error: `device ${deviceId} is not in allowlist` });
    ws.close(1008, 'device not allowlisted');
    return;
  }

  const previousSocket = socketsByDevice.get(deviceId);
  if (previousSocket && previousSocket !== ws) {
    sendJson(previousSocket, { type: 'info', status: 'replaced_by_new_connection', deviceId });
    try {
      previousSocket.close(1000, 'replaced');
    } catch (_) {
      // Best effort.
    }
  }

  const info = clients.get(ws) || { id: 0, deviceId: null, registered: false };
  info.deviceId = deviceId;
  info.registered = true;
  clients.set(ws, info);
  socketsByDevice.set(deviceId, ws);

  sendJson(ws, { type: 'register-ack', ok: true, deviceId });
}

function handleSend(ws, frame) {
  const sender = clients.get(ws);
  if (!sender?.registered || !sender.deviceId) {
    sendJson(ws, {
      type: 'xack',
      messageId: asText(frame.messageId) || null,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'sender_not_registered',
      error: 'Register first',
    });
    return;
  }

  const messageId = asText(frame.messageId);
  const fromDevice = normalizeDeviceId(frame.fromDevice) || sender.deviceId;
  const toDevice = normalizeDeviceId(frame.toDevice);
  const targetRole = resolveTargetRole(frame);
  const content = asText(frame.content);
  const metadata = normalizeBridgeMetadata(frame.metadata, content, {
    ensureStructured: true,
  });

  if (!messageId || !toDevice || !content) {
    sendJson(ws, {
      type: 'xack',
      messageId: messageId || null,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'invalid_payload',
      error: 'messageId, toDevice, and content are required',
      fromDevice: sender.deviceId,
      toDevice: toDevice || null,
    });
    return;
  }
  if (fromDevice !== sender.deviceId) {
    sendJson(ws, {
      type: 'xack',
      messageId,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'sender_mismatch',
      error: 'fromDevice must match registered device',
      fromDevice: sender.deviceId,
      toDevice,
    });
    return;
  }
  if (targetRole !== RELAY_ALLOWED_TARGET_ROLE) {
    sendJson(ws, {
      type: 'xack',
      messageId,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'target_role_rejected',
      error: `relay only forwards to ${RELAY_ALLOWED_TARGET_ROLE} targets`,
      fromDevice: sender.deviceId,
      toDevice,
    });
    return;
  }

  const targetSocket = socketsByDevice.get(toDevice);
  if (!targetSocket || targetSocket.readyState !== WebSocket.OPEN) {
    const connectedDevices = listConnectedDeviceIds();
    const isKnownDevice = socketsByDevice.has(toDevice);
    const connectedList = connectedDevices.length > 0 ? connectedDevices.join(', ') : 'none';
    const unknownDevice = isKnownDevice ? null : toDevice;
    const error = unknownDevice
      ? `Unknown device ${toDevice}. Connected devices: ${connectedList}`
      : `Target ${toDevice} is offline. Connected devices: ${connectedList}`;
    sendJson(ws, {
      type: 'xack',
      messageId,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'target_offline',
      error,
      fromDevice: sender.deviceId,
      toDevice,
      unknownDevice,
      connectedDevices,
    });
    return;
  }

  const existing = clearPending(messageId);
  if (existing) {
    sendJson(existing.senderWs, {
      type: 'xack',
      messageId,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'superseded',
      error: 'Pending message replaced by newer send',
      fromDevice: existing.fromDevice,
      toDevice: existing.toDevice,
    });
  }

  pendingByMessageId.set(messageId, {
    senderWs: ws,
    fromDevice: sender.deviceId,
    toDevice,
    createdAt: nowMs(),
    timer: createPendingAckTimeout(messageId),
  });

  const deliveredToTarget = sendJson(targetSocket, {
    type: 'xdeliver',
    messageId,
    fromDevice: sender.deviceId,
    toDevice,
    fromRole: asText(frame.fromRole) || 'architect',
    targetRole: RELAY_ALLOWED_TARGET_ROLE,
    content,
    metadata,
  });

  if (!deliveredToTarget) {
    clearPending(messageId);
    sendJson(ws, {
      type: 'xack',
      messageId,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'target_send_failed',
      error: `Failed sending to ${toDevice}`,
      fromDevice: sender.deviceId,
      toDevice,
    });
  }
}

function handleAck(ws, frame) {
  const sender = clients.get(ws);
  if (!sender?.registered || !sender.deviceId) return;
  const messageId = asText(frame.messageId);
  if (!messageId) return;
  const pending = clearPending(messageId);
  if (!pending) return;

  if (pending.toDevice !== sender.deviceId) {
    sendJson(pending.senderWs, {
      type: 'xack',
      messageId,
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'ack_sender_mismatch',
      error: `ACK from ${sender.deviceId} did not match target ${pending.toDevice}`,
      fromDevice: pending.fromDevice,
      toDevice: pending.toDevice,
    });
    return;
  }

  sendJson(pending.senderWs, {
    type: 'xack',
    messageId,
    ok: frame.ok === true,
    accepted: frame.accepted === true || frame.ok === true,
    queued: frame.queued === true || frame.accepted === true || frame.ok === true,
    verified: frame.verified === true || frame.ok === true,
    status: asText(frame.status) || (frame.ok ? 'bridge_delivered' : 'bridge_delivery_failed'),
    error: asText(frame.error) || null,
    fromDevice: pending.fromDevice,
    toDevice: pending.toDevice,
  });
}

wss.on('connection', (ws, req) => {
  clientSeq += 1;
  clients.set(ws, {
    id: clientSeq,
    deviceId: null,
    registered: false,
  });
  console.log(`[relay] client #${clientSeq} connected from ${req.socket.remoteAddress}`);

  ws.on('message', (raw) => {
    const frame = parseFrame(raw);
    if (!frame || typeof frame !== 'object') {
      sendJson(ws, { type: 'error', error: 'invalid_json' });
      return;
    }

    if (frame.type === 'register') {
      handleRegister(ws, frame);
      return;
    }
    if (frame.type === 'xsend') {
      handleSend(ws, frame);
      return;
    }
    if (frame.type === 'xack') {
      handleAck(ws, frame);
      return;
    }
    if (frame.type === 'ping') {
      sendJson(ws, { type: 'pong', ts: nowMs() });
      return;
    }

    sendJson(ws, { type: 'error', error: `unsupported_type:${asText(frame.type) || 'unknown'}` });
  });

  ws.on('close', (_code, reasonBuffer) => {
    const reasonText = reasonBuffer?.toString?.() || 'closed';
    evictClient(ws, reasonText);
  });

  ws.on('error', () => {
    evictClient(ws, 'socket_error');
  });
});

wss.on('listening', () => {
  console.log(`[relay] listening on ws://${HOST}:${PORT}`);
});

wss.on('error', (err) => {
  console.error(`[relay] server error: ${err.message}`);
});
