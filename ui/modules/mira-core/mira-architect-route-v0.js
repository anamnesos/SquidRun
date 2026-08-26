'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  MIRA_PREAMBLE_BLOCKLIST,
  MIRA_POSTAMBLE_BLOCKLIST,
  MIRA_TONE_EXPLANATION_BLOCKLIST,
  MIRA_ASSISTANT_SHAPE_BLOCKLIST,
  MIRA_MAX_REPLY_CHARS_DEFAULT,
  MIRA_MAX_REPLY_CHARS_EXPERIENCE,
  evaluateMiraVisibleReply,
} = require('./mira-language-rules-v0');

const MIRA_MAX_REPLY_CHARS = MIRA_MAX_REPLY_CHARS_DEFAULT;

const DEFAULT_PENDING_RELATIVE_PATH = path.join('runtime', 'mira-pending-intents.jsonl');
const DEFAULT_EVENT_QUEUE_RELATIVE_PATH = path.join('runtime', 'mira-event-queue.jsonl');

function newMiraIntentId() {
  return `mira-intent-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildMiraIntentEnvelope({
  intentText,
  sessionId,
  profile,
  windowKey,
  deviceId,
  nowMs,
  intentIdFactory = newMiraIntentId,
} = {}) {
  const text = String(intentText || '').trim();
  if (!text) return { ok: false, reason: 'intent_text_required' };
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const envelope = {
    mira_intent_id: intentIdFactory(),
    created_at_ms: now,
    sender: { role: 'mira' },
    target: { role: 'architect' },
    content: text,
    metadata: {
      profile: nonEmptyString(profile) ? profile.trim() : 'main',
      windowKey: nonEmptyString(windowKey) ? windowKey.trim() : 'main',
      sessionId: nonEmptyString(sessionId) ? sessionId.trim() : `mira-${now}`,
      deviceId: nonEmptyString(deviceId) ? deviceId.trim() : 'VIGIL',
      provenance: 'mira-architect-route-v0',
    },
  };
  return { ok: true, envelope };
}

function validateMiraEnvelopeShape(envelope = {}) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'envelope_required' };
  if (envelope.sender?.role !== 'mira') return { ok: false, reason: 'sender_role_must_be_mira' };
  if (envelope.target?.role !== 'architect') return { ok: false, reason: 'target_role_must_be_architect' };
  if (typeof envelope.mira_intent_id !== 'string' || !/^mira-intent-/.test(envelope.mira_intent_id)) {
    return { ok: false, reason: 'mira_intent_id_required' };
  }
  if (typeof envelope.content !== 'string' || envelope.content.trim() === '') {
    return { ok: false, reason: 'content_required' };
  }
  const md = envelope.metadata || {};
  for (const field of ['profile', 'windowKey', 'sessionId', 'deviceId', 'provenance']) {
    if (!nonEmptyString(md[field])) return { ok: false, reason: `metadata_${field}_required` };
  }
  if (md.provenance !== 'mira-architect-route-v0') {
    return { ok: false, reason: 'metadata_provenance_unknown' };
  }
  return { ok: true };
}


function appendJsonlRow({ filePath, row, fsImpl }) {
  const impl = fsImpl || fs;
  impl.mkdirSync(path.dirname(filePath), { recursive: true });
  impl.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function readJsonlRows({ filePath, fsImpl }) {
  const impl = fsImpl || fs;
  let raw = '';
  try {
    raw = impl.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = String(raw).split(/\r?\n/).filter((line) => line.length > 0);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

function getIntentResolutionState(rows, miraIntentId) {
  if (!Array.isArray(rows)) return { state: 'unknown' };
  let state = 'unknown';
  let lastRow = null;
  for (const row of rows) {
    if (!row || row.mira_intent_id !== miraIntentId) continue;
    if (row.kind === 'emitted' && state === 'unknown') {
      state = 'pending';
      lastRow = row;
    } else if (row.kind === 'resolved' || row.kind === 'failed' || row.kind === 'timeout') {
      state = row.kind;
      lastRow = row;
    }
  }
  return { state, row: lastRow };
}

function rowTargetsMira(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.target_role === 'mira') return true;
  if (row.target && typeof row.target === 'object' && row.target.role === 'mira') return true;
  return false;
}

function rowSenderIsArchitect(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.sender_role === 'architect') return true;
  if (row.sender && typeof row.sender === 'object' && row.sender.role === 'architect') return true;
  return false;
}

function findMiraReplyEvent({ rows, miraIntentId }) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row?.mira_intent_id !== miraIntentId) continue;
    if (row?.kind !== 'architect_reply') continue;
    if (!rowTargetsMira(row)) continue;
    if (!rowSenderIsArchitect(row)) continue;
    return row;
  }
  return null;
}

function buildArchitectReplyRow({
  miraIntentId,
  replyText,
  senderRole,
  nowMs,
}) {
  if (typeof miraIntentId !== 'string' || !/^mira-intent-/.test(miraIntentId)) {
    return { ok: false, reason: 'mira_intent_id_required' };
  }
  const text = String(replyText == null ? '' : replyText).trim();
  if (text.length === 0) {
    return { ok: false, reason: 'reply_text_required' };
  }
  if (senderRole !== undefined && senderRole !== null) {
    const requested = nonEmptyString(senderRole) ? senderRole.trim() : '';
    if (requested && requested !== 'architect') {
      return { ok: false, reason: 'sender_role_must_be_architect' };
    }
  }
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  return {
    ok: true,
    row: {
      mira_intent_id: miraIntentId,
      kind: 'architect_reply',
      target_role: 'mira',
      sender_role: 'architect',
      reply_text: text,
      occurred_at_ms: now,
    },
  };
}

function isIntentAlreadyResolved(pendingRows, miraIntentId) {
  const state = getIntentResolutionState(pendingRows, miraIntentId);
  return state.state === 'resolved' || state.state === 'failed' || state.state === 'timeout';
}

module.exports = {
  DEFAULT_PENDING_RELATIVE_PATH,
  DEFAULT_EVENT_QUEUE_RELATIVE_PATH,
  MIRA_PREAMBLE_BLOCKLIST,
  MIRA_POSTAMBLE_BLOCKLIST,
  MIRA_TONE_EXPLANATION_BLOCKLIST,
  MIRA_ASSISTANT_SHAPE_BLOCKLIST,
  MIRA_MAX_REPLY_CHARS,
  newMiraIntentId,
  buildMiraIntentEnvelope,
  validateMiraEnvelopeShape,
  evaluateMiraVisibleReply,
  appendJsonlRow,
  readJsonlRows,
  getIntentResolutionState,
  rowTargetsMira,
  rowSenderIsArchitect,
  findMiraReplyEvent,
  buildArchitectReplyRow,
  isIntentAlreadyResolved,
};
