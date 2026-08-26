const crypto = require('crypto');

const MEMORY_CLASSES = Object.freeze([
  'user_preference',
  'environment_quirk',
  'procedural_rule',
  'architecture_decision',
  'solution_trace',
  'historical_outcome',
  'active_task_state',
  'cross_device_handoff',
  'codebase_inventory',
  'system_health_state',
]);

const MEMORY_TIERS = Object.freeze(['tier1', 'tier3', 'tier4']);

const MEMORY_STATUSES = Object.freeze([
  'active',
  'pending',
  'stale',
  'superseded',
  'corrected',
  'rejected',
  'expired',
]);

const MEMORY_CLAIM_TYPES = Object.freeze([
  'preference',
  'operational_correction',
  'objective_fact',
]);

function generateId(prefix = 'mem') {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function clampConfidence(value, fallback = 0.5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function parseSessionOrdinal(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.floor(numeric));
}

function parseExpiresAt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Number.isFinite(Number(value))) {
    return Math.max(0, Math.floor(Number(value)));
  }
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(normalizeText(content), 'utf8').digest('hex');
}

function normalizeClaimType(value) {
  const normalized = asString(value, '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return null;
  if (normalized === 'intent') return 'preference';
  if (normalized === 'preference_intent') return 'preference';
  if (normalized === 'direct_preference') return 'preference';
  if (normalized === 'preference_override') return 'preference';
  if (normalized === 'correction') return 'operational_correction';
  if (normalized === 'operational') return 'operational_correction';
  if (normalized === 'fact') return 'objective_fact';
  if (normalized === 'objective_fact_contradiction') return 'objective_fact';
  if (normalized === 'fact_contradiction') return 'objective_fact';
  if (MEMORY_CLAIM_TYPES.includes(normalized)) return normalized;
  return null;
}

function normalizeScope(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return { value: value.trim() };
  if (Array.isArray(value)) return { values: value.map((entry) => String(entry).trim()).filter(Boolean) };
  if (typeof value === 'object') return value;
  return { value: String(value) };
}

function normalizeProvenance(value) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? { source: normalized } : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const copy = { ...value };
    if (copy.source) copy.source = normalizeText(copy.source);
    if (copy.kind) copy.kind = normalizeText(copy.kind).toLowerCase();
    if (copy.actor) copy.actor = normalizeText(copy.actor).toLowerCase();
    if (copy.claim_type || copy.claimType) {
      copy.claim_type = normalizeClaimType(copy.claim_type || copy.claimType);
      delete copy.claimType;
    }
    return copy;
  }
  return null;
}

function validateMemoryPayload(payload = {}) {
  const errors = [];
  const normalized = asObject(payload);
  const content = normalizeText(normalized.content);
  const memoryClass = asString(normalized.memory_class || normalized.memoryClass, '').toLowerCase();
  const provenance = normalizeProvenance(normalized.provenance);
  const sourceTrace = normalizeText(normalized.source_trace || normalized.sourceTrace || '');
  const confidence = clampConfidence(normalized.confidence, NaN);
  const claimTypeInput = normalized.claim_type || normalized.claimType || provenance?.claim_type;
  const claimType = normalizeClaimType(claimTypeInput);

  if (!content) errors.push('content is required');
  if (!memoryClass) {
    errors.push('memory_class is required');
  } else if (!MEMORY_CLASSES.includes(memoryClass)) {
    errors.push(`memory_class must be one of: ${MEMORY_CLASSES.join(', ')}`);
  }
  if (!provenance) errors.push('provenance is required');
  if (!sourceTrace) errors.push('source_trace is required');
  if (!Number.isFinite(Number(normalized.confidence))) errors.push('confidence must be a number between 0 and 1');
  if (claimTypeInput && !claimType) {
    errors.push(`claim_type must be one of: ${MEMORY_CLAIM_TYPES.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      content,
      memoryClass,
      provenance,
      sourceTrace,
      confidence: clampConfidence(normalized.confidence, 0.5),
      claimType,
    },
  };
}

function buildCanonicalMemoryObject(payload = {}, options = {}) {
  const validation = validateMemoryPayload(payload);
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'invalid_payload',
      errors: validation.errors,
    };
  }

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
  const normalized = validation.normalized;
  const scope = normalizeScope(payload.scope);
  const deviceId = asString(payload.device_id || payload.deviceId || options.deviceId || process.env.SQUIDRUN_DEVICE_ID || '', '') || null;
  const sessionId = asString(payload.session_id || payload.sessionId || options.sessionId || '', '') || null;
  const expiresAt = parseExpiresAt(payload.expires_at || payload.expiresAt);
  const correctionOf = asString(payload.correction_of || payload.correctionOf || '', '') || null;
  const supersedes = asString(payload.supersedes || '', '') || null;
  const callerDedupeKey = asString(payload.dedupe_key || payload.dedupeKey || '', '') || null;
  const sessionOrdinal = parseSessionOrdinal(payload.session_ordinal || payload.sessionOrdinal);
  const contentHash = hashContent(normalized.content);

  const memory = {
    ingest_id: asString(payload.ingest_id || payload.ingestId || '', '') || generateId('ingest'),
    memory_id: asString(payload.memory_id || payload.memoryId || '', '') || generateId('memory'),
    memory_class: normalized.memoryClass,
    tier: null,
    status: 'pending',
    authority_level: 'derived',
    content: normalized.content,
    content_hash: contentHash,
    provenance: normalized.provenance,
    source_trace: normalized.sourceTrace,
    created_at: nowMs,
    updated_at: nowMs,
    freshness_at: nowMs,
    confidence: normalized.confidence,
    scope,
    device_id: deviceId,
    device_scope: deviceId,
    session_id: sessionId,
    session_scope: sessionId,
    session_ordinal: sessionOrdinal,
    correction_of: correctionOf,
    supersedes,
    claim_type: normalized.claimType,
    dedupe_key: callerDedupeKey,
    expires_at: expiresAt,
    result_refs: asArray(payload.result_refs || payload.resultRefs),
  };

  return {
    ok: true,
    memory,
  };
}

module.exports = {
  MEMORY_CLASSES,
  MEMORY_CLAIM_TYPES,
  MEMORY_TIERS,
  MEMORY_STATUSES,
  buildCanonicalMemoryObject,
  clampConfidence,
  generateId,
  hashContent,
  normalizeClaimType,
  normalizeProvenance,
  parseSessionOrdinal,
  validateMemoryPayload,
};
