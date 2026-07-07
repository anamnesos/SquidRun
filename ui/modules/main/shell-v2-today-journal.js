'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getCoordRoot } = require('../../config');
const { queryCommsJournalEntries } = require('./comms-journal');

const FULL_AGENT_MESSAGE_REL_DIR = path.join('coord', 'full-agent-messages');
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 50000;

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asFiniteMs(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.floor(numeric);
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, parsed));
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function normalizeScopeKey(value) {
  const normalized = asString(value, 'main').toLowerCase();
  return normalized || 'main';
}

function extractSessionScopeSuffix(value) {
  const text = asString(value, '').toLowerCase();
  if (!text || !text.includes(':')) return '';
  const suffix = text.split(':').pop().trim();
  return suffix || '';
}

function extractRowScopeKey(row = {}) {
  const metadata = parseJsonObject(row.metadata ?? row.metadata_json);
  const directScope = normalizeScopeKey(
    metadata.windowKey
    || metadata.window_key
    || metadata.profile
    || metadata.profileName
    || metadata.profile_name
  );
  if (directScope !== 'main') return directScope;

  const sessionScope = extractSessionScopeSuffix(
    metadata.sessionScopeId
    || metadata.session_scope_id
    || metadata.sessionId
    || metadata.session_id
    || row.sessionId
    || row.session_id
  );
  if (sessionScope && sessionScope !== 'main') return sessionScope;

  return 'main';
}

function rowTimestampMs(row = {}) {
  return asFiniteMs(row.brokeredAtMs ?? row.brokered_at_ms, null)
    ?? asFiniteMs(row.sentAtMs ?? row.sent_at_ms, null)
    ?? asFiniteMs(row.updatedAtMs ?? row.updated_at_ms, null)
    ?? 0;
}

function normalizeDayWindow(payload = {}) {
  const input = asObject(payload);
  const explicitStart = asFiniteMs(input.dayStartMs ?? input.sinceMs, null);
  const explicitEnd = asFiniteMs(input.dayEndMs ?? input.untilMs, null);
  if (explicitStart !== null && explicitEnd !== null && explicitEnd > explicitStart) {
    return { dayStartMs: explicitStart, dayEndMs: explicitEnd };
  }

  const nowMs = asFiniteMs(input.nowMs, Date.now());
  const day = new Date(nowMs);
  day.setHours(0, 0, 0, 0);
  const dayStartMs = day.getTime();
  return {
    dayStartMs,
    dayEndMs: dayStartMs + 24 * 60 * 60 * 1000,
  };
}

function normalizeRow(row = {}) {
  const metadata = parseJsonObject(row.metadata ?? row.metadata_json);
  const normalized = {
    rowId: row.rowId ?? row.row_id ?? null,
    messageId: row.messageId ?? row.message_id ?? null,
    sessionId: row.sessionId ?? row.session_id ?? null,
    senderRole: row.senderRole ?? row.sender_role ?? null,
    targetRole: row.targetRole ?? row.target_role ?? null,
    channel: row.channel ?? null,
    direction: row.direction ?? null,
    sentAtMs: row.sentAtMs ?? row.sent_at_ms ?? null,
    brokeredAtMs: row.brokeredAtMs ?? row.brokered_at_ms ?? null,
    rawBody: typeof row.rawBody === 'string'
      ? row.rawBody
      : (typeof row.raw_body === 'string' ? row.raw_body : ''),
    bodyHash: row.bodyHash ?? row.body_hash ?? null,
    bodyBytes: row.bodyBytes ?? row.body_bytes ?? null,
    status: row.status ?? null,
    ackStatus: row.ackStatus ?? row.ack_status ?? null,
    errorCode: row.errorCode ?? row.error_code ?? null,
    attempt: row.attempt ?? null,
    metadata,
    updatedAtMs: row.updatedAtMs ?? row.updated_at_ms ?? null,
  };
  normalized.timestampMs = rowTimestampMs(normalized);
  normalized.scope = extractRowScopeKey(normalized);
  normalized.hasFullFile = hasMaterializedFullMessageSignal(normalized);
  return normalized;
}

function hasFullAgentMessagePath(value) {
  return /(?:^|\s)(?:\.squidrun[\\/]+)?coord[\\/]+full-agent-messages[\\/]+[A-Za-z0-9._-]+\.txt\b/i
    .test(String(value || ''));
}

function hasMaterializedFullMessageSignal(row = {}) {
  const metadata = asObject(row.metadata);
  const rawBody = String(row.rawBody || '');
  const metadataPath = metadata.materializedFullPayloadPath
    || metadata.fullPayloadPath
    || metadata.fullPayload_path
    || metadata.fullPayload
    || '';
  return Boolean(
    metadata.materializedFullPayload === true
    || metadata.materialized === true
    || hasFullAgentMessagePath(metadataPath)
    || /\bFULL MSG AT\s+/i.test(rawBody) && hasFullAgentMessagePath(rawBody)
  );
}

function queryShellV2TodayJournal(payload = {}, deps = {}) {
  const { dayStartMs, dayEndMs } = normalizeDayWindow(payload);
  const queryEntries = typeof deps.queryEntries === 'function'
    ? deps.queryEntries
    : queryCommsJournalEntries;
  const limit = clampLimit(payload.limit, DEFAULT_LIMIT);
  const queryLimit = Math.min(MAX_LIMIT, Math.max(limit, limit * 2));
  const rows = queryEntries({
    sinceMs: dayStartMs,
    untilMs: dayEndMs - 1,
    order: 'desc',
    limit: queryLimit,
  });

  const mainRows = (Array.isArray(rows) ? rows : [])
    .map(normalizeRow)
    .filter((row) => row.scope === 'main')
    .slice(0, limit);

  return {
    ok: true,
    scope: 'main',
    dayStartMs,
    dayEndMs,
    count: mainRows.length,
    rows: mainRows,
  };
}

function sanitizeMessageId(value) {
  const id = asString(value, '');
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) return '';
  return id.slice(0, 160);
}

function resolveFullMessagePath(messageId, deps = {}) {
  const safeId = sanitizeMessageId(messageId);
  if (!safeId) return null;
  const coordRoot = asString(deps.coordRoot, '')
    || (typeof getCoordRoot === 'function' ? getCoordRoot() : '');
  if (!coordRoot) return null;

  const fullDir = path.resolve(coordRoot, FULL_AGENT_MESSAGE_REL_DIR);
  const filePath = path.resolve(fullDir, `${safeId}.txt`);
  if (!filePath.startsWith(`${fullDir}${path.sep}`)) return null;
  return filePath;
}

function readTodayFullMessage(payload = {}, deps = {}) {
  const messageId = sanitizeMessageId(payload.messageId);
  if (!messageId) {
    return { ok: false, reason: 'invalid_message_id' };
  }
  const filePath = resolveFullMessagePath(messageId, deps);
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, reason: 'full_file_missing', messageId };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  return {
    ok: true,
    messageId,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256,
    shaShort: sha256.slice(0, 12),
    content,
  };
}

module.exports = {
  FULL_AGENT_MESSAGE_REL_DIR,
  extractRowScopeKey,
  hasMaterializedFullMessageSignal,
  normalizeDayWindow,
  queryShellV2TodayJournal,
  readTodayFullMessage,
  resolveFullMessagePath,
};
