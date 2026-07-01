'use strict';

const crypto = require('crypto');

const SALIENCE_SCHEMA_VERSION = 'squidrun.salience_engine.v0';
const DEFAULT_PICK_LIMIT = 3;
const DEFAULT_PICK_THRESHOLD = 0.35;
const FACTOR_KEYS = Object.freeze(['S', 'B', 'W', 'C']);
const FACTOR_LABELS = Object.freeze({
  S: 'severity',
  B: 'blindness',
  W: 'actionability_window',
  C: 'confidence',
});
const RISK_SEVERITY = Object.freeze({
  approval_required: 1,
  caution: 0.72,
  safe: 0.45,
});
const ACTIVE_STATES = new Set(['open', 'active', 'waiting_codex_visual', 'blocked']);
const TERMINAL_STATES = new Set(['closed', 'failed', 'canceled']);

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text ? text : fallback;
}

function normalizeToken(value, fallback = null) {
  const text = toOptionalString(value, null);
  if (!text) return fallback;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || fallback;
}

function uniqueStrings(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : [values]) {
    const text = toOptionalString(value, null);
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function splitListValue(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => splitListValue(entry));
  const text = toOptionalString(value, null);
  if (!text) return [];
  return text.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function geomean(values = []) {
  if (!values.length) return 0;
  const product = values.reduce((acc, value) => acc * clamp01(value), 1);
  return product <= 0 ? 0 : Math.pow(product, 1 / values.length);
}

function hashShort(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function toTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = toOptionalString(value, null);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function compactObject(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

function normalizeEvidenceRefs(input = [], fallback = null) {
  const refs = [];
  for (const raw of Array.isArray(input) ? input : [input]) {
    if (!raw) continue;
    if (typeof raw === 'string') {
      refs.push({ ref: raw });
      continue;
    }
    if (typeof raw !== 'object') continue;
    const ref = {
      type: toOptionalString(raw.type || raw.kind, null),
      ref: toOptionalString(raw.ref || raw.id || raw.path || raw.messageId || raw.rowId, null),
      rowId: toOptionalString(raw.rowId, null),
      messageId: toOptionalString(raw.messageId, null),
      deliveryId: toOptionalString(raw.deliveryId, null),
      status: toOptionalString(raw.status, null),
      path: toOptionalString(raw.path || raw.file, null),
    };
    refs.push(compactObject(ref));
  }
  if (!refs.length && fallback) refs.push(compactObject(fallback));
  return refs;
}

function normalizeSource(input = {}) {
  const source = input.source && typeof input.source === 'object' ? input.source : {};
  return compactObject({
    type: toOptionalString(source.type || input.sourceType || input.kind || input.type, null),
    id: toOptionalString(source.id || input.sourceId || input.id || input.key, null),
    rowId: toOptionalString(source.rowId || input.rowId, null),
    messageId: toOptionalString(source.messageId || input.messageId, null),
    deliveryId: toOptionalString(source.deliveryId || input.deliveryId, null),
    path: toOptionalString(source.path || input.path || input.file, null),
  });
}

function severityFromRisk(riskClass, fallback = 0.45) {
  return RISK_SEVERITY[normalizeToken(riskClass, '')] ?? fallback;
}

function statusConfidence(status, fallback = 0.75) {
  const normalized = normalizeToken(status, '');
  if (normalized === 'routed') return 1;
  if (normalized === 'recorded') return 0.65;
  if (normalized.includes('failed')) return 0.85;
  if (normalized.includes('unverified')) return 0.72;
  if (normalized.includes('pending')) return 0.7;
  return fallback;
}

function numericFactor(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function normalizeFactors(raw = {}, fallback = {}) {
  const source = raw.factors && typeof raw.factors === 'object' ? raw.factors : raw;
  return {
    S: clamp01(numericFactor(source.S, source.severity, source.impact, fallback.S, fallback.severity)),
    B: clamp01(numericFactor(source.B, source.blindness, source.visibilityGap, fallback.B, fallback.blindness)),
    W: clamp01(numericFactor(source.W, source.actionabilityWindow, source.windowFactor, fallback.W, fallback.actionabilityWindow)),
    C: clamp01(numericFactor(source.C, source.confidence, source.evidenceConfidence, fallback.C, fallback.confidence)),
  };
}

function firstZeroFactor(factors = {}) {
  return FACTOR_KEYS.find((key) => clamp01(factors[key]) <= 0) || null;
}

function buildSemanticKey(input = {}) {
  const explicit = toOptionalString(input.semanticKey || input.key, null);
  if (explicit) return explicit;
  const source = normalizeSource(input);
  const stable = source.messageId
    || source.rowId
    || source.id
    || source.path
    || input.workItemId
    || input.title
    || input.summary
    || input.kind
    || input.type;
  const kind = normalizeToken(input.kind || input.type || source.type, 'candidate');
  return `${kind}:${normalizeToken(stable, 'candidate')}`;
}

function normalizeMetadata(input = {}) {
  const meta = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const session = input.session && typeof input.session === 'object' ? input.session.id : input.session;
  const windowValue = input.window && typeof input.window === 'object' ? input.window.key : input.window;
  return compactObject({
    ...safeJson(meta, {}),
    sessionId: toOptionalString(meta.sessionId || input.sessionId || session, null),
    profile: normalizeToken(meta.profile || input.profile || input.profileName, null),
    windowKey: normalizeToken(meta.windowKey || input.windowKey || windowValue, null),
    routeKind: toOptionalString(meta.routeKind || input.routeKind, null),
    status: toOptionalString(meta.status || input.status, null),
    riskClass: normalizeToken(meta.riskClass || input.riskClass, null),
    ownerRoles: uniqueStrings(splitListValue(meta.ownerRoles || input.ownerRoles || input.ownerRole)),
  });
}

function normalizeCandidate(input = {}, options = {}) {
  const kind = normalizeToken(input.kind || input.type || input.sourceType, 'candidate');
  const key = buildSemanticKey({ ...input, kind });
  const factors = normalizeFactors(input, options.defaultFactors);
  const score = geomean(FACTOR_KEYS.map((factor) => factors[factor]));
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs || input.artifactRefs, {
    type: kind,
    ref: key,
  });
  const observedAtMs = toTimestampMs(input.observedAtMs || input.createdAt || input.updatedAt || input.timestamp);
  return {
    schema: 'squidrun.salience_candidate.v0',
    key,
    semanticKey: key,
    id: toOptionalString(input.id, key),
    kind,
    type: toOptionalString(input.type, kind),
    title: toOptionalString(input.title || input.summary || input.objective || input.body, key),
    summary: toOptionalString(input.summary || input.description || input.body || input.objective, null),
    suggestedNextCommand: toOptionalString(input.suggestedNextCommand || input.nextCommand, null),
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
    riskClass: normalizeToken(input.riskClass, null),
    source: normalizeSource({ ...input, kind }),
    metadata: normalizeMetadata(input),
    evidenceRefs,
    factors,
    factorLabels: FACTOR_LABELS,
    score,
    threshold: Number.isFinite(Number(options.pickThreshold)) ? Number(options.pickThreshold) : DEFAULT_PICK_THRESHOLD,
    observedAtMs,
    authority: buildNoAuthorityPolicy(input),
  };
}

function buildNoAuthorityPolicy(input = {}) {
  const riskClass = normalizeToken(input.riskClass, null);
  return {
    mode: 'rank_only_no_permission',
    grantsPermission: false,
    dispatcherPhase: 'phase3_james_checkpoint',
    jamesCheckpointRequired: riskClass === 'approval_required',
  };
}

function scoreCandidate(input = {}, options = {}) {
  return normalizeCandidate(input, options);
}

function compareCandidates(left, right) {
  const byScore = right.score - left.score;
  if (Math.abs(byScore) > 1e-12) return byScore;
  const byPriority = right.priority - left.priority;
  if (Math.abs(byPriority) > 1e-12) return byPriority;
  const leftTs = left.observedAtMs || Number.MAX_SAFE_INTEGER;
  const rightTs = right.observedAtMs || Number.MAX_SAFE_INTEGER;
  if (leftTs !== rightTs) return leftTs - rightTs;
  return String(left.key).localeCompare(String(right.key));
}

function buildDecision(candidate, rank, reason) {
  return {
    rank,
    key: candidate.key,
    kind: candidate.kind,
    type: candidate.type,
    title: candidate.title,
    summary: candidate.summary,
    score: candidate.score,
    factors: candidate.factors,
    factorLabels: candidate.factorLabels,
    reason,
    suggestedNextCommand: candidate.suggestedNextCommand,
    source: candidate.source,
    metadata: candidate.metadata,
    evidenceRefs: candidate.evidenceRefs,
    authority: candidate.authority,
  };
}

function buildSwallowed(candidate, reason, details = {}) {
  return {
    key: candidate.key,
    kind: candidate.kind,
    type: candidate.type,
    title: candidate.title,
    summary: candidate.summary,
    score: candidate.score,
    factors: candidate.factors,
    factorLabels: candidate.factorLabels,
    reason,
    source: candidate.source,
    metadata: candidate.metadata,
    evidenceRefs: candidate.evidenceRefs,
    wouldHaveSaid: candidate.title,
    ...compactObject(details),
  };
}

function dedupeCandidates(candidates = []) {
  const byKey = new Map();
  const duplicateRows = [];
  for (const candidate of candidates) {
    const existing = byKey.get(candidate.key);
    if (!existing) {
      byKey.set(candidate.key, candidate);
      continue;
    }
    const sorted = [existing, candidate].sort(compareCandidates);
    const winner = sorted[0];
    const loser = sorted[1];
    byKey.set(candidate.key, winner);
    duplicateRows.push(buildSwallowed(loser, 'semantic_duplicate_lower_salience', {
      duplicateOf: winner.key,
      lostTo: winner.key,
    }));
  }
  return {
    unique: Array.from(byKey.values()),
    duplicateRows,
  };
}

function pickTopSalience(input = {}, options = {}) {
  const rawCandidates = Array.isArray(input) ? input : (input.candidates || []);
  const limit = Math.max(0, Math.floor(Number(options.limit ?? input.limit ?? DEFAULT_PICK_LIMIT)) || 0);
  const pickThreshold = Number.isFinite(Number(options.pickThreshold ?? input.pickThreshold))
    ? Number(options.pickThreshold ?? input.pickThreshold)
    : DEFAULT_PICK_THRESHOLD;
  const normalized = rawCandidates.map((candidate) => normalizeCandidate(candidate, { ...options, pickThreshold }));
  const { unique, duplicateRows } = dedupeCandidates(normalized);
  const ranked = unique.slice().sort(compareCandidates);
  const eligible = ranked.filter((candidate) => (
    candidate.score >= pickThreshold && !firstZeroFactor(candidate.factors)
  ));
  const pickedCandidates = eligible.slice(0, limit);
  const pickedKeys = new Set(pickedCandidates.map((candidate) => candidate.key));
  const thirdPicked = pickedCandidates[pickedCandidates.length - 1] || null;
  const swallowed = duplicateRows.slice();

  for (const candidate of ranked) {
    if (pickedKeys.has(candidate.key)) continue;
    const zeroFactor = firstZeroFactor(candidate.factors);
    if (zeroFactor) {
      swallowed.push(buildSwallowed(candidate, `factor_${zeroFactor}_zero`, {
        blockedFactor: zeroFactor,
      }));
    } else if (candidate.score < pickThreshold) {
      swallowed.push(buildSwallowed(candidate, 'score_below_pick_threshold', {
        threshold: pickThreshold,
      }));
    } else {
      const rank = ranked.findIndex((entry) => entry.key === candidate.key) + 1;
      swallowed.push(buildSwallowed(candidate, `rank_${rank}_below_top_${limit}`, {
        lostTo: thirdPicked ? thirdPicked.key : null,
      }));
    }
  }

  return {
    schema: SALIENCE_SCHEMA_VERSION,
    generatedAt: toOptionalString(options.generatedAt || input.generatedAt, null) || new Date().toISOString(),
    scoringModel: 'the_tell_regret_spine_generalized',
    authorityPolicy: 'salience_only_no_dispatch',
    limit,
    pickThreshold,
    picked: pickedCandidates.map((candidate, index) => buildDecision(
      candidate,
      index + 1,
      'ranked_top_3_by_regret_of_silence'
    )),
    swallowed,
    audit: {
      candidateCount: normalized.length,
      uniqueCandidateCount: unique.length,
      duplicateCount: duplicateRows.length,
      pickedCount: pickedCandidates.length,
      swallowedCount: swallowed.length,
      tieBreakers: ['score_desc', 'priority_desc', 'observedAtMs_asc', 'key_asc'],
      factorLabels: FACTOR_LABELS,
    },
  };
}

function candidateFromCommsRow(row = {}) {
  const rowId = toOptionalString(row.rowId || row.row_id, null);
  const messageId = toOptionalString(row.messageId || row.message_id, null);
  const deliveryId = toOptionalString(row.deliveryId || row.delivery_id, null);
  const status = toOptionalString(row.status, null);
  const routeKind = toOptionalString(row.routeKind || row.route_kind || row.route?.kind, null);
  const from = toOptionalString(row.from || row.sender || row.sourceRole, null);
  const to = toOptionalString(row.to || row.target || row.targetRole, null);
  const body = toOptionalString(row.body || row.content || row.message, null);
  const keyStable = messageId || (rowId ? `row:${rowId}` : body);
  const factors = normalizeFactors(row, {
    S: row.requiresReply === false ? 0.45 : 0.68,
    B: status === 'routed' ? 0.25 : 0.95,
    W: TERMINAL_STATES.has(normalizeToken(row.state, '')) ? 0 : 0.85,
    C: statusConfidence(status, 0.75),
  });
  return normalizeCandidate({
    id: messageId || rowId,
    kind: 'comms_row',
    type: 'comms_row',
    semanticKey: `comms_row:${normalizeToken(keyStable, 'unknown')}`,
    title: toOptionalString(row.title, null) || (body ? body.slice(0, 140) : `Comms row ${rowId || messageId || 'unknown'}`),
    summary: body,
    suggestedNextCommand: row.suggestedNextCommand,
    priority: row.priority,
    riskClass: row.riskClass,
    source: { type: 'comms_journal', rowId, messageId, deliveryId },
    metadata: {
      sessionId: row.sessionId || row.session,
      profile: row.profile,
      windowKey: row.windowKey || row.window,
      routeKind,
      status,
      ackStatus: row.ackStatus || row.ack_status,
      from,
      to,
    },
    evidenceRefs: [{
      type: 'comms_journal_row',
      rowId,
      messageId,
      deliveryId,
      status,
    }],
    factors,
    observedAtMs: row.observedAtMs || row.createdAt || row.ts || row.timestamp,
  });
}

function candidateFromWorkItem(item = {}) {
  const id = toOptionalString(item.id || item.workItemId, null);
  const state = normalizeToken(item.state, 'active');
  const missingProofs = Array.isArray(item.proofState?.missingRoles)
    ? item.proofState.missingRoles
    : [];
  const riskClass = normalizeToken(item.riskClass, 'caution');
  const active = ACTIVE_STATES.has(state);
  const factors = normalizeFactors(item, {
    S: severityFromRisk(riskClass, 0.72),
    B: active && missingProofs.length ? 0.92 : (active ? 0.7 : 0.1),
    W: TERMINAL_STATES.has(state) ? 0 : 0.88,
    C: id && item.objective ? 1 : 0.5,
  });
  return normalizeCandidate({
    id,
    kind: 'work_item',
    type: 'work_item',
    semanticKey: `work_item:${normalizeToken(id, 'unknown')}`,
    title: item.objective || id,
    summary: item.objective,
    suggestedNextCommand: item.suggestedNextCommand || (
      missingProofs.length ? `Attach missing proofs: ${missingProofs.join(', ')}` : null
    ),
    priority: item.priority ?? (active ? 50 : 0),
    riskClass,
    source: { type: 'work_item', id },
    metadata: {
      sessionId: item.session?.id || item.sessionId,
      profile: item.profile,
      windowKey: item.window?.key || item.windowKey,
      status: state,
      riskClass,
      ownerRoles: item.ownerRoles,
      missingProofs,
      requiredProofs: item.requiredProofs,
    },
    evidenceRefs: [{
      type: 'work_item',
      ref: id,
      path: item.path,
      status: state,
    }],
    factors,
    observedAtMs: item.updatedAt || item.createdAt,
  });
}

function candidateFromAuditEvent(event = {}) {
  const id = toOptionalString(event.id || event.eventId || event.key, null);
  const type = normalizeToken(event.type || event.kind, 'audit_event');
  const riskClass = normalizeToken(event.riskClass, 'caution');
  const factors = normalizeFactors(event, {
    S: severityFromRisk(riskClass, 0.6),
    B: event.status === 'open' || event.status === 'untriaged' ? 0.9 : 0.65,
    W: event.expired === true ? 0 : 0.8,
    C: event.evidenceRefs || event.source ? 0.9 : 0.6,
  });
  return normalizeCandidate({
    id,
    kind: 'audit_event',
    type,
    semanticKey: event.semanticKey || `audit_event:${normalizeToken(id || event.title || type, 'unknown')}`,
    title: event.title || event.summary || type,
    summary: event.summary || event.description,
    suggestedNextCommand: event.suggestedNextCommand,
    priority: event.priority,
    riskClass,
    source: event.source || { type: 'audit_event', id },
    metadata: {
      sessionId: event.sessionId || event.session?.id,
      profile: event.profile,
      windowKey: event.windowKey || event.window?.key,
      status: event.status,
      riskClass,
      ownerRoles: event.ownerRoles,
    },
    evidenceRefs: normalizeEvidenceRefs(event.evidenceRefs, {
      type: 'audit_event',
      ref: id || type,
      status: event.status,
    }),
    factors,
    observedAtMs: event.observedAtMs || event.createdAt || event.updatedAt || event.timestamp,
  });
}

module.exports = {
  DEFAULT_PICK_LIMIT,
  DEFAULT_PICK_THRESHOLD,
  FACTOR_LABELS,
  FACTOR_KEYS,
  SALIENCE_SCHEMA_VERSION,
  buildSemanticKey,
  candidateFromAuditEvent,
  candidateFromCommsRow,
  candidateFromWorkItem,
  compareCandidates,
  geomean,
  normalizeCandidate,
  normalizeFactors,
  pickTopSalience,
  scoreCandidate,
};
