'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');

const DEFAULT_PERMISSION_ASK_VIOLATIONS_PATH = resolveCoordPath(
  path.join('runtime', 'permission-ask-violations.jsonl'),
  { forWrite: true }
);
const DEFAULT_PERMISSION_ASK_BYPASSES_PATH = resolveCoordPath(
  path.join('runtime', 'permission-ask-bypasses.jsonl'),
  { forWrite: true }
);

const CORE_AGENT_ROLES = new Set(['architect', 'builder', 'oracle']);
const ENFORCED_SENDER_ROLES = new Set([...CORE_AGENT_ROLES, 'cli']);
const SPECIAL_TARGETS = new Set(['user', 'telegram']);
const SKIP_PREFIXES = ['(PEER CALL-OUT):', '(PERMISSION GUARD):'];
const PERMISSION_ASK_PATTERNS = Object.freeze([
  /\bdo you want\b/i,
  /\bwant me to\b/i,
  /\bshould I\b/i,
  /\byour call\b/i,
  /\blet me know if\b/i,
  /\bif you want me to\b/i,
  /\bpermission to\b/i,
  /\bis it ok to\b/i,
  /\bshall I\b/i,
  /\bshould we\b/i,
]);

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function normalizeRole(value) {
  return toText(value).toLowerCase();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function appendJsonLine(filePath, payload) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
  return filePath;
}

function readJsonLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findPermissionAskMatch(content = '') {
  const text = toText(content, '');
  if (!text) return null;
  for (const pattern of PERMISSION_ASK_PATTERNS) {
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

function shouldSkipContent(content = '') {
  const text = toText(content, '');
  if (!text) return true;
  return SKIP_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function shouldEnforcePermissionGuard(input = {}) {
  const senderRole = normalizeRole(input.senderRole);
  const targetRole = normalizeRole(input.targetRole || input.targetRaw);
  const bypass = String(input.bypass || '').trim() === '1';
  if (bypass) return false;
  if (!ENFORCED_SENDER_ROLES.has(senderRole)) return false;
  if (!(CORE_AGENT_ROLES.has(targetRole) || SPECIAL_TARGETS.has(targetRole))) return false;
  if (shouldSkipContent(input.content)) return false;
  return true;
}

function detectPermissionAskViolation(input = {}) {
  if (!shouldEnforcePermissionGuard(input)) return null;
  const match = findPermissionAskMatch(input.content);
  if (!match) return null;
  return {
    type: 'permission_ask',
    senderRole: normalizeRole(input.senderRole),
    targetRole: normalizeRole(input.targetRole || input.targetRaw),
    targetRaw: toText(input.targetRaw, null),
    phrase: match.phrase,
    pattern: match.pattern,
    contentPreview: toText(input.content, '').slice(0, 240),
    occurredAt: new Date().toISOString(),
  };
}

function appendPermissionAskViolation(record = {}, options = {}) {
  const logPath = toText(options.logPath, DEFAULT_PERMISSION_ASK_VIOLATIONS_PATH);
  const payload = {
    type: 'permission_ask',
    senderRole: normalizeRole(record.senderRole),
    targetRole: normalizeRole(record.targetRole),
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

function appendPermissionAskBypass(record = {}, options = {}) {
  const logPath = toText(options.logPath, DEFAULT_PERMISSION_ASK_BYPASSES_PATH);
  const payload = {
    type: 'permission_ask_bypass',
    senderRole: normalizeRole(record.senderRole),
    targetRole: normalizeRole(record.targetRole),
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

function summarizePermissionAskViolations(options = {}) {
  const logPath = toText(options.logPath, DEFAULT_PERMISSION_ASK_VIOLATIONS_PATH);
  const sinceMs = options.since
    ? new Date(options.since).getTime()
    : (Number.isFinite(Number(options.hours))
      ? Date.now() - (Number(options.hours) * 60 * 60 * 1000)
      : null);
  const countsByRole = {};
  const recent = [];

  for (const entry of readJsonLines(logPath)) {
    const timestampMs = new Date(entry.occurredAt || 0).getTime();
    if (Number.isFinite(sinceMs) && Number.isFinite(timestampMs) && timestampMs < sinceMs) {
      continue;
    }
    const senderRole = normalizeRole(entry.senderRole || 'unknown');
    countsByRole[senderRole] = (countsByRole[senderRole] || 0) + 1;
    recent.push(entry);
  }

  return {
    ok: true,
    path: logPath,
    total: recent.length,
    countsByRole,
    recent: recent.slice(-20),
  };
}

module.exports = {
  DEFAULT_PERMISSION_ASK_VIOLATIONS_PATH,
  DEFAULT_PERMISSION_ASK_BYPASSES_PATH,
  CORE_AGENT_ROLES,
  PERMISSION_ASK_PATTERNS,
  detectPermissionAskViolation,
  appendPermissionAskViolation,
  appendPermissionAskBypass,
  summarizePermissionAskViolations,
  _internals: {
    findPermissionAskMatch,
    shouldEnforcePermissionGuard,
    shouldSkipContent,
    readJsonLines,
  },
};
