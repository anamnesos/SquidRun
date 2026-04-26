'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');
const { normalizeProfileName } = require('../profile');

const DEFAULT_CONTEXT_LEAK_VIOLATIONS_PATH = resolveCoordPath(
  path.join('runtime', 'context-leak-violations.jsonl'),
  { forWrite: true }
);
const DEFAULT_CONTEXT_LEAK_BYPASSES_PATH = resolveCoordPath(
  path.join('runtime', 'context-leak-bypasses.jsonl'),
  { forWrite: true }
);

const CONTEXT_LEAK_PATTERNS = Object.freeze([
  /은별/i,
  /eunbyul/i,
  /eunbyeol/i,
  /NurseCura/i,
  /힐스테이트/i,
  /Hillstate/i,
  /전명삼/i,
  /Jeon Myeongsam/i,
  /Qeline/i,
  /큐라인/i,
  /case-operations/i,
]);

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function normalizeLower(value, fallback = null) {
  const text = toText(value, fallback);
  return typeof text === 'string' ? text.toLowerCase() : fallback;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function appendJsonLine(filePath, payload) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
  return filePath;
}

function findContextLeakMatch(content = '') {
  const text = toText(content, '');
  if (!text) return null;
  for (const pattern of CONTEXT_LEAK_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[0]) {
      return {
        phrase: match[0],
        pattern: String(pattern),
      };
    }
  }
  return null;
}

function shouldEnforceContextLeakGuard(input = {}) {
  const bypass = String(input.bypass || '').trim() === '1';
  if (bypass) return false;
  const profile = normalizeProfileName(input.profile || process.env.SQUIDRUN_PROFILE || 'main');
  if (profile === 'eunbyeol') return false;
  return Boolean(toText(input.content, ''));
}

function detectContextLeakViolation(input = {}) {
  if (!shouldEnforceContextLeakGuard(input)) return null;
  const match = findContextLeakMatch(input.content);
  if (!match) return null;
  return {
    type: 'context_leak',
    profile: normalizeProfileName(input.profile || process.env.SQUIDRUN_PROFILE || 'main'),
    senderRole: normalizeLower(input.senderRole),
    targetRole: normalizeLower(input.targetRole || input.targetRaw),
    targetRaw: toText(input.targetRaw, null),
    phrase: match.phrase,
    pattern: match.pattern,
    contentPreview: toText(input.content, '').slice(0, 240),
    occurredAt: new Date().toISOString(),
  };
}

function appendContextLeakViolation(record = {}, options = {}) {
  const logPath = toText(options.logPath, DEFAULT_CONTEXT_LEAK_VIOLATIONS_PATH);
  const payload = {
    type: 'context_leak',
    profile: normalizeProfileName(record.profile || process.env.SQUIDRUN_PROFILE || 'main'),
    senderRole: normalizeLower(record.senderRole),
    targetRole: normalizeLower(record.targetRole),
    targetRaw: toText(record.targetRaw, null),
    messageId: toText(record.messageId, null),
    phrase: toText(record.phrase, null),
    pattern: toText(record.pattern, null),
    contentPreview: toText(record.contentPreview, ''),
    occurredAt: toText(record.occurredAt, new Date().toISOString()),
  };
  appendJsonLine(logPath, payload);
  return {
    ok: true,
    path: logPath,
    record: payload,
  };
}

function appendContextLeakBypass(record = {}, options = {}) {
  const logPath = toText(options.logPath, DEFAULT_CONTEXT_LEAK_BYPASSES_PATH);
  const payload = {
    type: 'context_leak_bypass',
    profile: normalizeProfileName(record.profile || process.env.SQUIDRUN_PROFILE || 'main'),
    senderRole: normalizeLower(record.senderRole),
    targetRole: normalizeLower(record.targetRole),
    targetRaw: toText(record.targetRaw, null),
    messageId: toText(record.messageId, null),
    phrase: toText(record.phrase, null),
    pattern: toText(record.pattern, null),
    contentPreview: toText(record.contentPreview, ''),
    occurredAt: toText(record.occurredAt, new Date().toISOString()),
    bypassReason: toText(record.bypassReason, 'bypass_guard'),
  };
  appendJsonLine(logPath, payload);
  return {
    ok: true,
    path: logPath,
    record: payload,
  };
}

module.exports = {
  DEFAULT_CONTEXT_LEAK_VIOLATIONS_PATH,
  DEFAULT_CONTEXT_LEAK_BYPASSES_PATH,
  CONTEXT_LEAK_PATTERNS,
  detectContextLeakViolation,
  appendContextLeakViolation,
  appendContextLeakBypass,
  _internals: {
    findContextLeakMatch,
    shouldEnforceContextLeakGuard,
  },
};
