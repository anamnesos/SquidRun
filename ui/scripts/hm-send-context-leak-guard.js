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

const SCOPED_PROFILE_REFERENCE_PATTERNS = Object.freeze([
  /은별/i,
  /private-profile/i,
  /private-profile/i,
]);

const CASE_CONTENT_PATTERNS = Object.freeze([
  /NurseCura/i,
  /힐스테이트/i,
  /Hillstate/i,
  /전명삼/i,
  /Jeon Myeongsam/i,
  /Qeline/i,
  /큐라인/i,
  /case-operations/i,
]);

const CONTEXT_LEAK_PATTERNS = Object.freeze([
  ...SCOPED_PROFILE_REFERENCE_PATTERNS,
  ...CASE_CONTENT_PATTERNS,
]);

const INTERNAL_AGENT_ROLES = new Set(['architect', 'builder', 'oracle']);

const OPERATIONAL_CONTEXT_PATTERNS = Object.freeze([
  /\bTASK\b/i,
  /\bOBJECTIVE\b/i,
  /\bSCOPE\s+IN\b/i,
  /\bSCOPE\s+OUT\b/i,
  /\bdiagnos(?:e|is|tic|tics)\b/i,
  /\bdebug(?:ging)?\b/i,
  /\brout(?:e|ing)\b/i,
  /\bside[-\s]?window\b/i,
  /\bwindowKey\b/i,
  /\bprofile\b/i,
  /\bstartup\b/i,
  /\bqueued?\b/i,
  /\breplay\b/i,
  /\bpoller\b/i,
  /\binbound\b/i,
  /\bvalidation\b/i,
  /\btests?\b/i,
  /\bpatch\b/i,
  /\blog evidence\b/i,
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

function findPatternMatch(content = '', patterns = []) {
  const text = toText(content, '');
  if (!text) return null;
  for (const pattern of patterns) {
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

function isInternalOperationalMessage(input = {}, content = '') {
  const targetRole = normalizeLower(input.targetRole || input.targetRaw);
  if (!INTERNAL_AGENT_ROLES.has(targetRole)) return false;
  return OPERATIONAL_CONTEXT_PATTERNS.some((pattern) => pattern.test(toText(content, '')));
}

function findContextLeakMatch(content = '', input = {}) {
  const caseContentMatch = findPatternMatch(content, CASE_CONTENT_PATTERNS);
  if (caseContentMatch) return caseContentMatch;

  const profileReferenceMatch = findPatternMatch(content, SCOPED_PROFILE_REFERENCE_PATTERNS);
  if (!profileReferenceMatch) return null;
  if (isInternalOperationalMessage(input, content)) return null;
  return profileReferenceMatch;
}

function shouldEnforceContextLeakGuard(input = {}) {
  const bypass = String(input.bypass || '').trim() === '1';
  if (bypass) return false;
  const profile = normalizeProfileName(input.profile || process.env.SQUIDRUN_PROFILE || 'main');
  if (profile === 'private-profile') return false;
  return Boolean(toText(input.content, ''));
}

function detectContextLeakViolation(input = {}) {
  if (!shouldEnforceContextLeakGuard(input)) return null;
  const match = findContextLeakMatch(input.content, input);
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
    isInternalOperationalMessage,
    shouldEnforceContextLeakGuard,
  },
};
