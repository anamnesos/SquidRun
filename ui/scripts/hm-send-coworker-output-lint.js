'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');

// ARCH #60.4 / task #2 — Coworker Output Lint v0.
// Scope: cross-agent messages on the hm-send bus (architect/builder/oracle
// senders, architect/builder/oracle receivers). Inspects the FIRST ~50
// chars of the message (after stripping the standard `(SENDER -> RECEIVER #N):`
// envelope prefix) for helpdesk-shape openers: apology preamble,
// sycophancy/validation openers, feeling-ack, status preamble, hedge
// cascade.
//
// Preserves: action statements, direct answers, technical nouns. The
// canonical example from the original ARCH #19 spec:
//   input "the build is broken again"
//     reply "Sorry about that ..." → FAIL the lint (apology preamble)
//     reply leading with a fix or technical noun → PASS
//
// Default behavior: SOFT — log violations to coworker-lint-violations.jsonl
// so hm-send can continue the send. This lint is permanently warn-only for
// agent-to-agent sends; user-facing permission asks are enforced by the
// separate permission-ask guard.
//
// Skips:
//   - Telegram / user / self-routing targets.
//   - Messages starting with established envelope-overrides
//     ("(PEER CALL-OUT):", "(PERMISSION GUARD):", "(COWORKER LINT):").
//   - Messages routed via cli sender unless the cli sender is acting AS an
//     agent (handled by the same ENFORCED_SENDER_ROLES gate as the
//     permission-ask guard).

const DEFAULT_COWORKER_LINT_VIOLATIONS_PATH = resolveCoordPath(
  path.join('runtime', 'coworker-lint-violations.jsonl'),
  { forWrite: true }
);
const DEFAULT_COWORKER_LINT_BYPASSES_PATH = resolveCoordPath(
  path.join('runtime', 'coworker-lint-bypasses.jsonl'),
  { forWrite: true }
);

const CORE_AGENT_ROLES = new Set(['architect', 'builder', 'oracle']);
const ENFORCED_SENDER_ROLES = new Set([...CORE_AGENT_ROLES, 'cli']);
const ENFORCED_TARGET_ROLES = new Set([...CORE_AGENT_ROLES]); // not telegram/user
const SKIP_PREFIXES = ['(PEER CALL-OUT):', '(PERMISSION GUARD):', '(COWORKER LINT):'];

// Envelope prefix pattern: `(BUILDER -> ARCH #N):`, `(BUILDER -> ARCH):`,
// `(Oracle to Builder):`, etc. Strip these so the first-50-char window
// looks at actual message content, not envelope ceremony.
const ENVELOPE_PREFIX_PATTERN =
  /^\s*\((?:[A-Za-z]+(?:\s+[A-Za-z]+)?\s*(?:->|to|→)\s*[A-Za-z]+(?:\s+[A-Za-z]+)?(?:\s*#\d+)?|[A-Z]+\s*#\d+)\):\s*/i;

// First-50-char window after envelope strip. Patterns target the OPENER
// shape — substring matches anywhere in the body don't fire, only opener-
// position matches do.
const COWORKER_LINT_PATTERNS = Object.freeze([
  // Apology preamble — the architect's canonical "Sorry about that" case.
  { id: 'apology_preamble', re: /^(?:sorry\b|i'?m\s+sorry\b|apolog(?:y|ies|ize)\b|my\s+(?:bad|fault|apologies)\b)/i },
  // Feeling-acknowledgment preamble.
  { id: 'feeling_ack_preamble', re: /^(?:i\s+hear\s+you\b|i\s+get\s+(?:it|that|where)|i\s+understand\b|i\s+see\s+where\s+you|i\s+appreciate\b)/i },
  // Sycophancy / validation opener.
  { id: 'sycophancy_opener', re: /^(?:great\s+(?:point|question|catch|call)|good\s+(?:point|question|catch|call|one)|fair\s+point|that'?s\s+a\s+(?:great|good|fair|valid)\s+(?:point|question|call|catch)|you'?re\s+(?:absolutely|completely|totally|exactly|so|100%)\s+right)\b/i },
  // Status preamble — "I'm working on it / Let me start by / On it".
  { id: 'status_preamble', re: /^(?:working\s+on\s+(?:it|that|this)\b|i'?m\s+working\s+on\b|let\s+me\s+(?:start|begin)\b|i'?ll\s+(?:start|begin)\s+by\b|on\s+it\s*[.!,;:]|just\s+to\s+(?:clarify|confirm|check)\b)/i },
  // Sure/Happy/Of course family — assistant compliance opener.
  { id: 'assistant_compliance_opener', re: /^(?:sure[\s,.!\-—:]|of\s+course[\s,.!\-—:]|happy\s+to\b|absolutely[\s,.!\-—:]|totally[\s,.!\-—:])/i },
  // Hedge cascade — "I think maybe perhaps we could possibly..."
  { id: 'hedge_cascade', re: /^(?:i\s+think\s+(?:maybe|perhaps)|perhaps\s+we\s+(?:could|might)|maybe\s+we\s+(?:could|should)|i'?m\s+not\s+sure\s+but|tentatively\s+i\b)/i },
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

function stripEnvelopePrefix(content = '') {
  const text = toText(content, '');
  if (!text) return '';
  return text.replace(ENVELOPE_PREFIX_PATTERN, '').replace(/^[\s]+/, '');
}

function firstWindow(content, charLimit = 50) {
  const stripped = stripEnvelopePrefix(content);
  return stripped.slice(0, charLimit);
}

function findCoworkerLintMatch(content = '') {
  const window = firstWindow(content, 50);
  if (!window) return null;
  for (const { id, re } of COWORKER_LINT_PATTERNS) {
    const match = window.match(re);
    if (match && match[0]) {
      return {
        violation_class: id,
        phrase: match[0],
        pattern: String(re),
        window,
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

function shouldEnforceCoworkerLint(input = {}) {
  const senderRole = normalizeRole(input.senderRole);
  const targetRole = normalizeRole(input.targetRole || input.targetRaw);
  const bypass = String(input.bypass || '').trim() === '1';
  if (bypass) return false;
  if (!ENFORCED_SENDER_ROLES.has(senderRole)) return false;
  if (!ENFORCED_TARGET_ROLES.has(targetRole)) return false;
  if (shouldSkipContent(input.content)) return false;
  return true;
}

function detectCoworkerLintViolation(input = {}) {
  if (!shouldEnforceCoworkerLint(input)) return null;
  const match = findCoworkerLintMatch(input.content);
  if (!match) return null;
  return {
    type: 'coworker_lint',
    senderRole: normalizeRole(input.senderRole),
    targetRole: normalizeRole(input.targetRole || input.targetRaw),
    targetRaw: toText(input.targetRaw, null),
    violation_class: match.violation_class,
    phrase: match.phrase,
    pattern: match.pattern,
    window: match.window,
    contentPreview: toText(input.content, '').slice(0, 240),
    occurredAt: new Date().toISOString(),
  };
}

function appendCoworkerLintViolation(record = {}, options = {}) {
  const logPath = toText(options.logPath, DEFAULT_COWORKER_LINT_VIOLATIONS_PATH);
  const payload = {
    type: 'coworker_lint',
    senderRole: normalizeRole(record.senderRole),
    targetRole: normalizeRole(record.targetRole),
    targetRaw: toText(record.targetRaw, null),
    messageId: toText(record.messageId, null),
    violation_class: toText(record.violation_class, null),
    phrase: toText(record.phrase, null),
    pattern: toText(record.pattern, null),
    window: toText(record.window, ''),
    contentPreview: toText(record.contentPreview, ''),
    enforcement_mode: 'soft_warn',
    occurredAt: toText(record.occurredAt, new Date().toISOString()),
  };
  appendJsonLine(logPath, payload);
  return {
    ok: true,
    path: logPath,
    record: payload,
  };
}

function appendCoworkerLintBypass(record = {}, options = {}) {
  const logPath = toText(options.logPath, DEFAULT_COWORKER_LINT_BYPASSES_PATH);
  const payload = {
    type: 'coworker_lint_bypass',
    senderRole: normalizeRole(record.senderRole),
    targetRole: normalizeRole(record.targetRole),
    targetRaw: toText(record.targetRaw, null),
    messageId: toText(record.messageId, null),
    violation_class: toText(record.violation_class, null),
    phrase: toText(record.phrase, null),
    pattern: toText(record.pattern, null),
    window: toText(record.window, ''),
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

function summarizeCoworkerLintViolations(options = {}) {
  const logPath = toText(options.logPath, DEFAULT_COWORKER_LINT_VIOLATIONS_PATH);
  const sinceMs = options.since
    ? new Date(options.since).getTime()
    : (Number.isFinite(Number(options.hours))
      ? Date.now() - (Number(options.hours) * 60 * 60 * 1000)
      : null);
  const countsByRole = {};
  const countsByClass = {};
  const recent = [];

  for (const entry of readJsonLines(logPath)) {
    const timestampMs = new Date(entry.occurredAt || 0).getTime();
    if (Number.isFinite(sinceMs) && Number.isFinite(timestampMs) && timestampMs < sinceMs) {
      continue;
    }
    const senderRole = normalizeRole(entry.senderRole || 'unknown');
    countsByRole[senderRole] = (countsByRole[senderRole] || 0) + 1;
    const klass = toText(entry.violation_class, 'unknown');
    countsByClass[klass] = (countsByClass[klass] || 0) + 1;
    recent.push(entry);
  }

  return {
    ok: true,
    path: logPath,
    total: recent.length,
    countsByRole,
    countsByClass,
    recent: recent.slice(-20),
  };
}

module.exports = {
  DEFAULT_COWORKER_LINT_VIOLATIONS_PATH,
  DEFAULT_COWORKER_LINT_BYPASSES_PATH,
  CORE_AGENT_ROLES,
  COWORKER_LINT_PATTERNS,
  ENVELOPE_PREFIX_PATTERN,
  detectCoworkerLintViolation,
  appendCoworkerLintViolation,
  appendCoworkerLintBypass,
  summarizeCoworkerLintViolations,
  _internals: {
    findCoworkerLintMatch,
    firstWindow,
    stripEnvelopePrefix,
    shouldEnforceCoworkerLint,
    shouldSkipContent,
    readJsonLines,
  },
};
