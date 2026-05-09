'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIRA_PREAMBLE_BLOCKLIST = Object.freeze([
  /^i\s+understand[\s,.\-—:]/i,
  /^sure[\s,.\-—:]/i,
  /^of\s+course[\s,.\-—:]/i,
  /^happy\s+to[\s,.\-—:]/i,
  /^let\s+me\s/i,
  /^got\s+it[\s,.\-—:]/i,
  /^right[\s,.\-—:]/i,
  /^absolutely[\s,.\-—:]/i,
  /^great[\s,.\-—:]/i,
  /^totally[\s,.\-—:]/i,
  /^here(?:'s|\s+(?:is|are))\s/i,
  /^here\s+you\s+go[\s,.\-—:]/i,
]);

const MIRA_POSTAMBLE_BLOCKLIST = Object.freeze([
  /hope\s+(that|this)\s+helps[.!]?\s*$/i,
  /anything\s+else\??\s*$/i,
  /(let\s+me\s+know|just\s+let\s+me\s+know|happy\s+to\s+help)[^.!?]*[.!?]?\s*$/i,
  /(feel\s+free\s+to|don'?t\s+hesitate\s+to)[^.!?]*[.!?]?\s*$/i,
]);

const MIRA_TONE_EXPLANATION_BLOCKLIST = Object.freeze([
  /\b(speaking\s+plainly|to\s+be\s+honest|let\s+me\s+be\s+direct|warmly|gently|softly)\s*[,.\-—:]/i,
  /\bi'?ll\s+be\s+(honest|direct|blunt|brief|warm|plain)[\s,.\-—:]/i,
  /\bin\s+plain\s+english[\s,.\-—:]/i,
]);

const MIRA_ASSISTANT_SHAPE_BLOCKLIST = Object.freeze([
  /^i\s+just\s+want(?:ed)?\s+to/i,
  /^to\s+clarify[\s,.\-—:]/i,
  /^to\s+be\s+clear[\s,.\-—:]/i,
  /^for\s+clarity[\s,.\-—:]/i,
  /^just\s+to\s+be\s+clear[\s,.\-—:]/i,
  /^that'?s\s+(valid|fair|good|true)[\s,.\-—:!]/i,
  /^if\s+(?:you'?d\s+like|you\s+(?:want|need))[\s,.\-—:]/i,
  /^would\s+you\s+like\s+me\s+to/i,
  /\bi'?m\s+(trying|attempting)\s+(not\s+to|to)\s+(sound|be|seem|come\s+across)/i,
  /\bi'?m\s+not\s+(your|a|just\s+a)\s*(typical|usual|ordinary|generic)?\s*(ai|assistant|chatbot|bot)/i,
  /\bi\s+hear\s+you[\s,.\-—:]/i,
  /\bi\s+get\s+(it|that)[\s,.\-—:]/i,
  /\b(good|great|fair|valid)\s+point[\s,.\-—:]/i,
  /\bthat'?s\s+a\s+(good|great|fair|valid)\s+point[\s,.\-—:]/i,
  /\bi\s+want\s+to\s+(make\s+sure|be\s+clear|be\s+careful|push\s+back)/i,
]);

const MIRA_MAX_REPLY_CHARS = 800;

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

function evaluateMiraVisibleReply(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { ok: false, violations: ['empty_reply'], text: trimmed };
  const violations = [];
  for (const re of MIRA_PREAMBLE_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('preamble'); break; }
  }
  for (const re of MIRA_POSTAMBLE_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('postamble'); break; }
  }
  for (const re of MIRA_TONE_EXPLANATION_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('tone_explanation'); break; }
  }
  for (const re of MIRA_ASSISTANT_SHAPE_BLOCKLIST) {
    if (re.test(trimmed)) { violations.push('assistant_shape'); break; }
  }
  if (trimmed.length > MIRA_MAX_REPLY_CHARS) {
    violations.push('reply_too_long');
  }
  return { ok: violations.length === 0, violations, text: trimmed };
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

function findMiraReplyEvent({ rows, miraIntentId }) {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (row?.mira_intent_id !== miraIntentId) continue;
    if (row?.kind !== 'architect_reply') continue;
    if (!rowTargetsMira(row)) continue;
    return row;
  }
  return null;
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
  findMiraReplyEvent,
  isIntentAlreadyResolved,
};
