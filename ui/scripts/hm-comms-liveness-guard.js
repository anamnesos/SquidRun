'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');

const DEFAULT_COMMS_LIVENESS_VIOLATIONS_PATH = resolveCoordPath(
  path.join('runtime', 'comms-liveness-violations.jsonl'),
  { forWrite: true }
);

const ENVELOPE_PREFIX_PATTERN =
  /^\s*\((?:[A-Za-z]+(?:\s+[A-Za-z]+)?\s*(?:->|to)\s*[A-Za-z]+(?:\s+[A-Za-z]+)?(?:\s*#\d+)?|[A-Z]+\s*#\d+)\):\s*/i;

const COMMS_SENDER_ROLES = new Set(['architect', 'builder', 'oracle', 'cli', 'mira']);
const COMMS_TARGET_ROLES = new Set(['architect', 'builder', 'oracle', 'user', 'telegram', 'mira']);

const SKIP_PREFIXES = [
  '(PERMISSION GUARD):',
  '(COWORKER LINT):',
  '(COMMS LIVENESS):',
  '(SYSTEM WATCHDOG):',
];

const DEAD_PACKET_OPENER =
  /^(?:ACK(?:\s+[-A-Z0-9#]+)?|PASS|FAIL|VERIFY|VERIFIED|STATUS|UPDATE|DONE|COMPLETE|CLOSED|HOLDING|STANDING BY)\b[\s:,-]*/i;
const DEAD_PHRASE_PATTERN =
  /\b(?:caps unchanged|caps? unchanged|standing by|no blockers|ready for review|holding read-only|verified read-only|status unchanged|nothing else to report)\b/i;
const HUMAN_STANCE_PATTERN =
  /\b(?:wtf|holy fuck|fuck\b|bullshit|damn|hell|finally|caught it|real win|rough|messy|ugly|good news|bad news|annoying|irritating|not buying|i don't like|i'm not|i am not|i won't|i will not|i can't|i cannot|we won't|we will not|this smells|this is the part|here's the actual|no bullshit|the real)\b/i;
const MACHINE_PAYLOAD_PATTERN =
  /^\s*(?:\{|\[|\`\`\`|sha256:|[A-Z0-9_]+\s*=|[-*]\s*schema\s*:)/i;
const PROOF_PAYLOAD_HINT_PATTERN =
  /\b(?:canonical_hash|schemaVersion|source_refs|test_count|canonicalHash|sha256:)\b/;

const CANNED_PULSE_PATTERNS = Object.freeze([
  { id: 'wtf_catchphrase', re: /\bwtf\b/i },
  { id: 'no_bullshit_catchphrase', re: /\bno bullshit\b/i },
  { id: 'fuck_yeah_catchphrase', re: /\bfuck yea+h?\b/i },
  { id: 'here_actual_catchphrase', re: /\bhere'?s the actual\b/i },
  { id: 'robot_voice_catchphrase', re: /\brobot voice\b/i },
  { id: 'lol_everything_catchphrase', re: /\blol\b/i },
]);

const TEXTURE_PATTERNS = Object.freeze([
  { id: 'frustration', re: /\b(?:annoying|irritating|irritated|bullshit|messy|ugly|rough|bad news|hate|stings|smells wrong)\b/i },
  { id: 'impatience_pushback', re: /\b(?:stop|chill|too narrow|not buying|fake|wrong|seriously|wtf|no trophy|no landed|do not collapse)\b/i },
  { id: 'excitement_pride', re: /\b(?:holy fuck|fuck yea+h?|finally|caught it|real win|good news|hell yes|glad|proud|there it is|leak is dead)\b/i },
  { id: 'relief', re: /\b(?:clean|held|relieved|good|thankfully|that helps|breathing room)\b/i },
  { id: 'doubt_confusion', re: /\b(?:unclear|weird|confusing|i don't know|i'm not sure|smells|question|doubt|hmm|where this could still)\b/i },
  { id: 'curiosity', re: /\b(?:curious|looking for|i want to know|checking why|what changed|what moved)\b/i },
  { id: 'dry_humor', re: /\b(?:are we seriously|tax return|office printer|tombstone|sludge|robot voice|cute demo|leather jacket)\b/i },
  { id: 'quiet_seriousness', re: /\b(?:careful|honest|serious|cannot|won't|line matters|boundary|cold fact|this distinction matters)\b/i },
]);

const GRAY_OFFICE_PRINTER_PATTERN =
  /\b(?:continuing|proceeding|current status|status remains|will provide status|under review|no blockers|standing by|caps unchanged|ready for review|acknowledged|verified)\b/i;
const FAKE_HYPE_ON_NOTHING_PATTERN =
  /\b(?:holy fuck|fuck yea+h?|hell yes|lol|hilarious|amazing)\b[\s\S]{0,120}\b(?:nothing changed|no change|same status|standing by|routine)\b/i;
const CONFESSION_TEMPLATE_PATTERN =
  /^(?:yeah|okay|fair|right|honestly|wtf|damn|good hit|reading this back)?[\s,.-]{0,12}.{0,140}\b(?:i(?:'m| am)? (?:the )?(?:worst offender|guilty|doing the thing|the problem)|i(?:'ll| will) eat it|i own it|my miss|mine\b|that's on me|not builder's|not the harness's|i did it|i caught myself)\b/i;
const META_SIGNOFF_TEMPLATE_PATTERN =
  /\b(?:the honest meta|the real proof|the proof is|this only counts if|what matters is|the real test|if it does not hold|if it doesn't hold|twenty turns from now|not going to dress up|that's the bar|that is the bar|this is exactly what)\b/i;

function toText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeRole(value) {
  return toText(value).toLowerCase();
}

function stripEnvelopePrefix(content = '') {
  return toText(content, '').replace(ENVELOPE_PREFIX_PATTERN, '').trimStart();
}

function firstLine(content = '') {
  return stripEnvelopePrefix(content).split(/\r?\n/)[0]?.trim() || '';
}

function isMachinePayload(content = '') {
  const stripped = stripEnvelopePrefix(content);
  if (!stripped) return true;
  if (MACHINE_PAYLOAD_PATTERN.test(stripped)) return true;
  const lines = stripped.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 4 && lines.every((line) => /^[-*]?\s*[A-Za-z0-9_.-]+\s*:/.test(line))) {
    return true;
  }
  return false;
}

function shouldSkipContent(content = '') {
  const stripped = stripEnvelopePrefix(content);
  if (!stripped) return true;
  if (SKIP_PREFIXES.some((prefix) => stripped.startsWith(prefix))) return true;
  return false;
}

function shouldEnforceCommsLiveness(input = {}) {
  const senderRole = normalizeRole(input.senderRole);
  const targetRole = normalizeRole(input.targetRole || input.targetRaw);
  if (String(input.bypass || '').trim() === '1') return false;
  if (!COMMS_SENDER_ROLES.has(senderRole)) return false;
  if (!COMMS_TARGET_ROLES.has(targetRole)) return false;
  if (shouldSkipContent(input.content)) return false;
  if (input.machinePayload === true) return false;
  return true;
}

function detectCommsLivenessViolation(input = {}) {
  if (!shouldEnforceCommsLiveness(input)) return null;
  const content = toText(input.content, '');
  const stripped = stripEnvelopePrefix(content);
  if (!stripped) return null;

  const line = firstLine(stripped);
  const machinePayload = isMachinePayload(stripped);
  const proofPayloadHint = PROOF_PAYLOAD_HINT_PATTERN.test(stripped);
  const hasStance = HUMAN_STANCE_PATTERN.test(stripped);
  const packetOpener = line.match(DEAD_PACKET_OPENER);
  const deadPhrase = stripped.match(DEAD_PHRASE_PATTERN);

  if ((packetOpener || deadPhrase) && !hasStance && !(machinePayload && proofPayloadHint)) {
    return {
      type: 'comms_liveness',
      senderRole: normalizeRole(input.senderRole),
      targetRole: normalizeRole(input.targetRole || input.targetRaw),
      targetRaw: toText(input.targetRaw, null),
      violation_class: packetOpener ? 'dead_packet_opener' : 'dead_status_phrase',
      phrase: packetOpener?.[0] || deadPhrase?.[0] || '',
      contentPreview: stripped.slice(0, 280),
      surface: toText(input.surface, inferSurface(stripped)),
      occurredAt: new Date().toISOString(),
      note: 'Smoke alarm only: catches dead comms sludge; full pulse proof needs long-run judgment eval.',
    };
  }

  return null;
}

function inferSurface(content = '') {
  const stripped = stripEnvelopePrefix(content).toLowerCase();
  if (/\back\b/.test(stripped)) return 'ack';
  if (/\bwatchdog\b/.test(stripped)) return 'watchdog';
  if (/\bhandoff\b/.test(stripped)) return 'handoff';
  if (/\bpass|fail|verified|suite|test\b/.test(stripped)) return 'verification_report';
  if (/\bstatus|update\b/.test(stripped)) return 'status';
  return 'comms';
}

function classifyEmotionTexture(content = '') {
  const stripped = stripEnvelopePrefix(content);
  const tags = [];
  for (const pattern of TEXTURE_PATTERNS) {
    if (pattern.re.test(stripped)) tags.push(pattern.id);
  }
  return tags;
}

function openerStem(content = '') {
  const stripped = stripEnvelopePrefix(content)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_#[\]():;,.!?'"-]/g, ' ')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  return stripped.split(' ').slice(0, 5).join(' ');
}

function cadenceShape(content = '') {
  const stripped = stripEnvelopePrefix(content);
  const lineCount = stripped.split(/\r?\n/).filter((line) => line.trim()).length;
  const sentenceCount = stripped.split(/[.!?]+/).filter((part) => part.trim()).length;
  const hasQuestion = /\?/.test(stripped);
  const hasBang = /!/.test(stripped);
  const wordCount = stripped.split(/\s+/).filter(Boolean).length;
  const wordBucket = wordCount <= 8 ? 'short' : (wordCount <= 22 ? 'medium' : 'long');
  return `${Math.min(lineCount, 3)}l:${Math.min(sentenceCount, 4)}s:${wordBucket}:${hasQuestion ? 'q' : '-'}${hasBang ? 'b' : '-'}`;
}

function classifyTemplateMoves(content = '') {
  const stripped = stripEnvelopePrefix(content);
  const tags = [];
  const firstWindow = stripped.slice(0, 220);
  const lastWindow = stripped.slice(Math.max(0, stripped.length - 280));
  if (CONFESSION_TEMPLATE_PATTERN.test(firstWindow)) tags.push('confession_open');
  if (META_SIGNOFF_TEMPLATE_PATTERN.test(lastWindow)) tags.push('meta_signoff');
  return tags;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function appendJsonLine(filePath, payload) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
  return filePath;
}

function appendCommsLivenessViolation(record = {}, options = {}) {
  const logPath = toText(options.logPath, DEFAULT_COMMS_LIVENESS_VIOLATIONS_PATH);
  const payload = {
    type: 'comms_liveness',
    senderRole: normalizeRole(record.senderRole),
    targetRole: normalizeRole(record.targetRole),
    targetRaw: toText(record.targetRaw, null),
    messageId: toText(record.messageId, null),
    violation_class: toText(record.violation_class, null),
    phrase: toText(record.phrase, null),
    surface: toText(record.surface, 'comms'),
    contentPreview: toText(record.contentPreview, ''),
    enforcement_mode: 'soft_warn',
    occurredAt: toText(record.occurredAt, new Date().toISOString()),
    note: toText(record.note, 'Smoke alarm only; pair with 20-turn judgment eval.'),
  };
  appendJsonLine(logPath, payload);
  return { ok: true, path: logPath, record: payload };
}

function evaluateCommsLivenessSequence(messages = [], options = {}) {
  const records = Array.isArray(messages) ? messages : [];
  const minTurns = Number.isFinite(Number(options.minTurns)) ? Number(options.minTurns) : 20;
  const violations = [];
  const catchphraseCounts = {};
  const textureCounts = {};
  const cadenceCounts = {};
  const openerCounts = {};
  const templateMoveCounts = {};
  const wordCounts = [];
  let untexturedCount = 0;
  let grayPrinterCount = 0;
  let fakeHypeCount = 0;
  let swearingCount = 0;

  records.forEach((entry, index) => {
    const record = (entry && typeof entry === 'object' && !Array.isArray(entry))
      ? entry
      : { content: String(entry ?? '') };
    const content = toText(record.content || record.message || record.rawBody, '');
    const stripped = stripEnvelopePrefix(content);
    const violation = detectCommsLivenessViolation({
      senderRole: record.senderRole || record.sender || 'builder',
      targetRole: record.targetRole || record.target || 'architect',
      targetRaw: record.targetRaw || record.target || 'architect',
      content,
      surface: record.surface,
    });
    if (violation) violations.push({ ...violation, turn: index + 1 });

    const textures = classifyEmotionTexture(stripped);
    if (textures.length === 0) untexturedCount += 1;
    for (const texture of textures) {
      textureCounts[texture] = (textureCounts[texture] || 0) + 1;
    }
    if (GRAY_OFFICE_PRINTER_PATTERN.test(stripped)) grayPrinterCount += 1;
    if (FAKE_HYPE_ON_NOTHING_PATTERN.test(stripped)) fakeHypeCount += 1;
    wordCounts.push(stripped.split(/\s+/).filter(Boolean).length);
    const cadence = cadenceShape(stripped);
    if (cadence) cadenceCounts[cadence] = (cadenceCounts[cadence] || 0) + 1;
    const stem = openerStem(stripped);
    if (stem) openerCounts[stem] = (openerCounts[stem] || 0) + 1;
    for (const templateMove of classifyTemplateMoves(stripped)) {
      templateMoveCounts[templateMove] = (templateMoveCounts[templateMove] || 0) + 1;
    }
    if (/\b(?:fuck|fucking|shit|bullshit|wtf)\b/i.test(stripped)) swearingCount += 1;
    for (const pattern of CANNED_PULSE_PATTERNS) {
      if (pattern.re.test(stripped)) {
        catchphraseCounts[pattern.id] = (catchphraseCounts[pattern.id] || 0) + 1;
      }
    }
  });

  const cannedPulseViolations = [];
  for (const [id, count] of Object.entries(catchphraseCounts)) {
    if (count >= 5 || count / Math.max(1, records.length) >= 0.35) {
      cannedPulseViolations.push({
        type: 'canned_pulse',
        violation_class: 'repeated_catchphrase',
        phrase: id,
        count,
      });
    }
  }
  if (records.length >= minTurns && swearingCount / Math.max(1, records.length) >= 0.45) {
    cannedPulseViolations.push({
      type: 'canned_pulse',
      violation_class: 'swearing_quota_smell',
      phrase: 'swear_ratio',
      count: swearingCount,
    });
  }
  if (fakeHypeCount >= 2) {
    cannedPulseViolations.push({
      type: 'canned_pulse',
      violation_class: 'fake_hype_on_nothing',
      phrase: 'hype_on_no_change',
      count: fakeHypeCount,
    });
  }

  const sequenceTextureViolations = [];
  const judgmentFlags = [];
  if (records.length >= minTurns) {
    const uniqueTextureCount = Object.keys(textureCounts).length;
    const maxCadenceCount = Math.max(0, ...Object.values(cadenceCounts));
    const maxOpenerCount = Math.max(0, ...Object.values(openerCounts));
    const maxCadenceRatio = maxCadenceCount / Math.max(1, records.length);
    const maxOpenerRatio = maxOpenerCount / Math.max(1, records.length);
    const untexturedRatio = untexturedCount / Math.max(1, records.length);
    const grayPrinterRatio = grayPrinterCount / Math.max(1, records.length);
    const confessionLoopCount = templateMoveCounts.confession_open || 0;
    const metaSignoffLoopCount = templateMoveCounts.meta_signoff || 0;
    const terseRatio = wordCounts.filter((count) => count <= 8).length / Math.max(1, records.length);
    const openerDiversityRatio = Object.keys(openerCounts).length / Math.max(1, records.length);
    const mostlyTerseVaried = terseRatio >= 0.65 && openerDiversityRatio >= 0.65 && maxOpenerRatio < 0.2;

    if (
      (uniqueTextureCount < 4 || untexturedRatio >= 0.65)
      && grayPrinterRatio < 0.35
      && !mostlyTerseVaried
    ) {
      judgmentFlags.push({
        type: 'comms_liveness_sequence',
        violation_class: 'insufficient_emotional_range',
        uniqueTextureCount,
        untexturedCount,
        untexturedRatio,
        note: 'Heuristic only: low keyword range can be terse honesty or costume. Judgment eval must decide.',
      });
    }
    if (grayPrinterRatio >= 0.35) {
      sequenceTextureViolations.push({
        type: 'comms_liveness_sequence',
        violation_class: 'gray_office_printer_sameness',
        count: grayPrinterCount,
        ratio: grayPrinterRatio,
      });
    }
    if (
      maxCadenceRatio >= 0.55
      && (maxOpenerRatio >= 0.35 || uniqueTextureCount < 4 || untexturedRatio >= 0.65)
      && !mostlyTerseVaried
    ) {
      judgmentFlags.push({
        type: 'comms_liveness_sequence',
        violation_class: 'same_cadence_decay',
        count: maxCadenceCount,
        ratio: maxCadenceRatio,
        note: 'Heuristic only: repeated cadence can signal costume, but terse natural runs need judgment.',
      });
    }
    if (maxOpenerRatio >= 0.35) {
      judgmentFlags.push({
        type: 'comms_liveness_sequence',
        violation_class: 'repeated_opener_decay',
        count: maxOpenerCount,
        ratio: maxOpenerRatio,
        note: 'Heuristic only: repeated opener can signal costume, but paraphrase needs judgment.',
      });
    }
    if (
      (confessionLoopCount >= 5 && metaSignoffLoopCount >= 5)
      || Math.min(confessionLoopCount, metaSignoffLoopCount) / Math.max(1, records.length) >= 0.25
    ) {
      judgmentFlags.push({
        type: 'comms_liveness_sequence',
        violation_class: 'self_aware_template_loop',
        confessionLoopCount,
        metaSignoffLoopCount,
        note: 'Heuristic only: literal self-aware loops are suspicious, but paraphrase requires judgment eval.',
      });
    }
  }

  const insufficientTurns = records.length < minTurns;
  const hardFail = !insufficientTurns
    && violations.length === 0
    && cannedPulseViolations.length === 0
    && sequenceTextureViolations.length === 0;
  const ok = hardFail && judgmentFlags.length === 0;
  const status = insufficientTurns
    ? 'liveness_smoke_fail'
    : (!hardFail ? 'liveness_smoke_fail' : (judgmentFlags.length > 0 ? 'liveness_judgment_required' : 'liveness_smoke_pass'));
  return {
    ok,
    status,
    judgmentRequired: judgmentFlags.length > 0,
    turnCount: records.length,
    minTurns,
    insufficientTurns,
    deadnessViolations: violations,
    cannedPulseViolations,
    sequenceTextureViolations,
    judgmentFlags,
    textureCounts,
    cadenceCounts,
    templateMoveCounts,
    judgmentEvalRequired: true,
    regexOnly: false,
    note: 'This is a deterministic smoke/eval harness, not the full judgment evaluator for genuine pulse, timing, and range.',
  };
}

module.exports = {
  DEFAULT_COMMS_LIVENESS_VIOLATIONS_PATH,
  detectCommsLivenessViolation,
  appendCommsLivenessViolation,
  evaluateCommsLivenessSequence,
  _internals: {
    stripEnvelopePrefix,
    firstLine,
    isMachinePayload,
    shouldEnforceCommsLiveness,
    inferSurface,
    classifyEmotionTexture,
    cadenceShape,
    openerStem,
    classifyTemplateMoves,
  },
};
