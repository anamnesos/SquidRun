/**
 * Evidence Ledger Ingest
 * Canonical envelope normalization + validation + storage preparation.
 */

const crypto = require('crypto');

const REQUIRED_FIELDS = Object.freeze([
  'eventId',
  'traceId',
  'type',
  'stage',
  'source',
  'ts',
]);

const ALLOWED_EDGE_TYPES = new Set(['parent', 'ack_of', 'retry_of']);

function generateId(prefix = 'evt') {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function toMsTimestamp(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  return fallback;
}

function sanitizeString(value, fallback = '') {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

function normalizePayload(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return { value };
}

function normalizeEvidenceRefs(value) {
  if (!Array.isArray(value)) return [];
  const refs = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const kind = sanitizeString(item.kind, '');
    if (!kind) continue;
    refs.push({
      kind,
      path: sanitizeString(item.path, ''),
      line: Number.isFinite(Number(item.line)) ? Number(item.line) : null,
      hash: sanitizeString(item.hash, ''),
      note: sanitizeString(item.note, ''),
    });
  }
  return refs;
}

function normalizeMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function normalizeEnvelope(input, options = {}) {
  const now = toMsTimestamp(options.nowMs, Date.now());
  const src = (input && typeof input === 'object') ? input : {};

  const traceId = sanitizeString(src.traceId, sanitizeString(src.correlationId, generateId('trc')));
  const parentEventId = sanitizeString(
    src.parentEventId,
    sanitizeString(src.causationId, '')
  ) || null;

  const payload = normalizePayload(src.payload);
  const evidenceRefs = normalizeEvidenceRefs(src.evidenceRefs);
  const meta = normalizeMeta(src.meta);
  const correlationId = sanitizeString(src.correlationId, traceId);
  const causationId = (src.causationId !== undefined && src.causationId !== null)
    ? sanitizeString(src.causationId, parentEventId || '') || null
    : parentEventId;

  return {
    eventId: sanitizeString(src.eventId, generateId('evt')),
    traceId,
    spanId: sanitizeString(src.spanId, generateId('spn')),
    parentEventId,
    correlationId,
    causationId,
    type: sanitizeString(src.type, options.defaultType || 'event.unknown'),
    stage: sanitizeString(src.stage, options.defaultStage || 'system'),
    source: sanitizeString(src.source, options.defaultSource || 'unknown'),
    paneId: sanitizeString(src.paneId, options.defaultPaneId || 'system'),
    role: sanitizeString(src.role, options.defaultRole || 'unknown'),
    ts: toMsTimestamp(src.ts, now),
    seq: Number.isFinite(Number(src.seq)) ? Number(src.seq) : null,
    direction: sanitizeString(src.direction, options.defaultDirection || 'internal'),
    payload,
    evidenceRefs,
    meta,
  };
}

function validateEnvelope(envelope) {
  const errors = [];
  const value = (envelope && typeof envelope === 'object') ? envelope : {};

  for (const field of REQUIRED_FIELDS) {
    if (field === 'ts') {
      if (!Number.isFinite(Number(value.ts))) {
        errors.push('ts must be a finite number');
      }
      continue;
    }
    if (!sanitizeString(value[field], '')) {
      errors.push(`${field} is required`);
    }
  }

  if (value.parentEventId !== null && value.parentEventId !== undefined) {
    if (!sanitizeString(value.parentEventId, '')) {
      errors.push('parentEventId must be null or non-empty string');
    }
  }

  if (value.evidenceRefs && !Array.isArray(value.evidenceRefs)) {
    errors.push('evidenceRefs must be an array when provided');
  }

  if (value.payload && typeof value.payload !== 'object') {
    errors.push('payload must be an object');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function payloadHash(payloadJson) {
  return `sha256:${crypto.createHash('sha256').update(payloadJson).digest('hex')}`;
}

function buildEdgeRows(envelope, options = {}) {
  const now = toMsTimestamp(options.nowMs, Date.now());
  if (!envelope || typeof envelope !== 'object') return [];

  const rows = [];
  const toEventId = sanitizeString(envelope.eventId, '');
  const traceId = sanitizeString(envelope.traceId, '');
  if (!toEventId || !traceId) return [];

  const parentEventId = sanitizeString(envelope.parentEventId, '');
  if (parentEventId) {
    rows.push({
      trace_id: traceId,
      from_event_id: parentEventId,
      to_event_id: toEventId,
      edge_type: 'parent',
      created_at_ms: now,
    });
  }

  const ackOf = sanitizeString(envelope?.meta?.ackOfEventId, '');
  if (ackOf) {
    rows.push({
      trace_id: traceId,
      from_event_id: ackOf,
      to_event_id: toEventId,
      edge_type: 'ack_of',
      created_at_ms: now,
    });
  }

  const retryOf = sanitizeString(envelope?.meta?.retryOfEventId, '');
  if (retryOf) {
    rows.push({
      trace_id: traceId,
      from_event_id: retryOf,
      to_event_id: toEventId,
      edge_type: 'retry_of',
      created_at_ms: now,
    });
  }

  const dedup = new Set();
  return rows.filter((row) => {
    if (!ALLOWED_EDGE_TYPES.has(row.edge_type)) return false;
    const key = `${row.trace_id}|${row.from_event_id}|${row.to_event_id}|${row.edge_type}`;
    if (dedup.has(key)) return false;
    dedup.add(key);
    return true;
  });
}

function serializeForStorage(envelope, options = {}) {
  const normalized = normalizeEnvelope(envelope, options);
  const validation = validateEnvelope(normalized);
  const payloadJson = JSON.stringify(normalized.payload || {});
  const evidenceRefsJson = JSON.stringify(normalized.evidenceRefs || []);
  const metaJson = JSON.stringify(normalized.meta || {});

  return {
    normalized,
    validation,
    row: {
      event_id: normalized.eventId,
      trace_id: normalized.traceId,
      span_id: normalized.spanId,
      parent_event_id: normalized.parentEventId,
      correlation_id: normalized.correlationId,
      causation_id: normalized.causationId,
      type: normalized.type,
      stage: normalized.stage,
      source: normalized.source,
      pane_id: normalized.paneId,
      role: normalized.role,
      ts_ms: normalized.ts,
      seq: normalized.seq,
      direction: normalized.direction,
      payload_json: payloadJson,
      payload_hash: payloadHash(payloadJson),
      evidence_refs_json: evidenceRefsJson,
      meta_json: metaJson,
      ingested_at_ms: toMsTimestamp(options.ingestedAtMs, Date.now()),
      session_id: sanitizeString(options.sessionId, ''),
    },
  };
}

function prepareEventForStorage(input, options = {}) {
  const serialized = serializeForStorage(input, options);
  const edges = buildEdgeRows(serialized.normalized, options);
  return {
    normalized: serialized.normalized,
    validation: serialized.validation,
    row: serialized.row,
    edges,
  };
}

module.exports = {
  REQUIRED_FIELDS,
  normalizeEnvelope,
  validateEnvelope,
  buildEdgeRows,
  serializeForStorage,
  prepareEventForStorage,
  generateId,
};
