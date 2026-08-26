'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { KNOWN_ROLES } = require('../role-scope-core');
const { getExampleAppDayToDayArmSpecs } = require('../exampleapp-arm-specs');

const EXPECTED_CLASSES = Object.freeze(['verdict', 'ack', 'packet', 'answer', 'receipt']);
const STALENESS_CLASSES = Object.freeze(['turn', 'beat', 'day', 'open']);
const OBLIGATION_STATUSES = Object.freeze(['open', 'fulfilled', 'released', 'lapsed']);
const PROOF_QUALIFIED_COMMS_STATUSES = new Set(['routed', 'acked']);
const ROOM_AUDIENCE = Object.freeze(['architect', 'builder', 'oracle']);

const STATIC_ROLE_ADDRESSES = new Set([
  ...KNOWN_ROLES,
  'mira',
  'builder-bg-1',
  'builder-bg-2',
  'builder-bg-3',
  ...getExampleAppDayToDayArmSpecs().flatMap((spec) => [
    spec.role,
    spec.routeTarget,
    spec.paneId,
  ]),
].filter(Boolean).map((value) => String(value).trim().toLowerCase()));

const FORBIDDEN_EXACT_KEYS = new Set([
  'who_failed',
  'fault',
  'blame',
  'missed_by',
  'failed_by',
  'failures',
  'failure_count',
  'failure_counts',
  'failure_counter',
  'failure_counters',
  'fail_count',
  'fail_counts',
  'fail_counter',
  'fail_counters',
  'misses',
  'miss_count',
  'miss_counts',
  'miss_counter',
  'miss_counters',
  'missed_count',
  'missed_counts',
  'missed_counter',
  'missed_counters',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asNonEmptyString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizeFieldKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
}

function isForbiddenObligationField(value) {
  const key = normalizeFieldKey(value);
  if (FORBIDDEN_EXACT_KEYS.has(key)) return true;
  return /(?:^|_)(?:failure|fail|miss|missed)s?_(?:count|counter)s?(?:_|$)/.test(key)
    || /(?:^|_)(?:count|counter)s?_(?:of_|by_)?(?:failure|fail|miss|missed)(?:es|s)?(?:_|$)/.test(key)
    || /^(?:[a-z0-9]+_)*(?:agent|role|obligor|architect|builder|oracle)_(?:failures?|fails?|misses|missed)$/.test(key)
    || /^(?:failures?|fails?|misses|missed)_(?:by_)?(?:agent|role|obligor|architect|builder|oracle)$/.test(key)
    || /_(?:failures|misses)$/.test(key);
}

function findForbiddenObligationFields(value, options = {}) {
  const found = [];
  const seen = new WeakSet();
  const rootPath = asNonEmptyString(options.rootPath, '$');

  function visit(candidate, currentPath) {
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate)) return;
    seen.add(candidate);

    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`));
      return;
    }

    for (const [key, entry] of Object.entries(candidate)) {
      const fieldPath = `${currentPath}.${key}`;
      if (isForbiddenObligationField(key)) {
        found.push(fieldPath);
        continue;
      }
      visit(entry, fieldPath);
    }
  }

  visit(value, rootPath);
  return found;
}

function validateObligationWritePayload(value) {
  const forbiddenFields = findForbiddenObligationFields(value);
  if (forbiddenFields.length > 0) {
    return {
      ok: false,
      reason: 'blame_field_forbidden',
      forbiddenFields,
    };
  }
  return { ok: true, forbiddenFields: [] };
}

function sanitizeObligationRead(value) {
  const redactedFields = [];
  const seen = new WeakMap();

  function sanitize(candidate, currentPath) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    if (seen.has(candidate)) return seen.get(candidate);

    if (Array.isArray(candidate)) {
      const output = [];
      seen.set(candidate, output);
      candidate.forEach((entry, index) => {
        output.push(sanitize(entry, `${currentPath}[${index}]`));
      });
      return output;
    }

    const output = {};
    seen.set(candidate, output);
    for (const [key, entry] of Object.entries(candidate)) {
      const fieldPath = `${currentPath}.${key}`;
      if (isForbiddenObligationField(key)) {
        redactedFields.push(fieldPath);
        continue;
      }
      output[key] = sanitize(entry, fieldPath);
    }
    return output;
  }

  return {
    value: sanitize(value, '$'),
    flagged: redactedFields.length > 0,
    redactedFields,
  };
}

function normalizeExpectedClass(value) {
  const normalized = asNonEmptyString(value, '')?.toLowerCase() || '';
  return EXPECTED_CLASSES.includes(normalized) ? normalized : null;
}

function normalizeStalenessClass(value) {
  const normalized = asNonEmptyString(value, '')?.toLowerCase() || '';
  return STALENESS_CLASSES.includes(normalized) ? normalized : null;
}

function normalizeObligationStatus(value) {
  const normalized = asNonEmptyString(value, '')?.toLowerCase() || '';
  return OBLIGATION_STATUSES.includes(normalized) ? normalized : null;
}

function normalizeExpectation(value) {
  const source = asObject(value);
  const expectedClass = normalizeExpectedClass(source.class || source.expected_class || source.expectedClass);
  const stalenessClass = normalizeStalenessClass(
    source.staleness_class || source.stalenessClass || source.staleness
  );
  if (!expectedClass || !stalenessClass) return null;
  return {
    class: expectedClass,
    staleness_class: stalenessClass,
  };
}

function parseExpectationFlag(value) {
  const text = asNonEmptyString(value, '');
  const parts = text ? text.split(':') : [];
  if (parts.length !== 2) {
    return {
      ok: false,
      reason: 'expects_format_invalid',
      expected: '<verdict|ack|packet|answer|receipt>:<turn|beat|day|open>',
    };
  }
  const expectation = normalizeExpectation({ class: parts[0], staleness_class: parts[1] });
  if (!expectation) {
    return {
      ok: false,
      reason: 'expects_value_invalid',
      expected: '<verdict|ack|packet|answer|receipt>:<turn|beat|day|open>',
    };
  }
  return { ok: true, expectation };
}

function normalizeFulfillmentDeclaration(value) {
  if (typeof value === 'string') {
    const obligationId = asNonEmptyString(value, null);
    return obligationId ? { obligation_id: obligationId } : null;
  }
  const source = asObject(value);
  const obligationId = asNonEmptyString(source.obligation_id || source.obligationId, null);
  return obligationId ? { obligation_id: obligationId } : null;
}

function extractExpectationFromMetadata(value) {
  const metadata = asObject(value);
  const envelope = asObject(metadata.envelope);
  if (metadata.expects !== undefined && metadata.expects !== null) {
    return normalizeExpectation(metadata.expects);
  }
  if (envelope.expects !== undefined && envelope.expects !== null) {
    return normalizeExpectation(envelope.expects);
  }
  return null;
}

function metadataDeclaresExpectation(value) {
  const metadata = asObject(value);
  const envelope = asObject(metadata.envelope);
  return (metadata.expects !== undefined && metadata.expects !== null)
    || (envelope.expects !== undefined && envelope.expects !== null);
}

function extractFulfillmentFromMetadata(value) {
  const metadata = asObject(value);
  const envelope = asObject(metadata.envelope);
  if (metadata.fulfills !== undefined && metadata.fulfills !== null) {
    return normalizeFulfillmentDeclaration(metadata.fulfills);
  }
  if (envelope.fulfills !== undefined && envelope.fulfills !== null) {
    return normalizeFulfillmentDeclaration(envelope.fulfills);
  }
  return null;
}

function metadataDeclaresFulfillment(value) {
  const metadata = asObject(value);
  const envelope = asObject(metadata.envelope);
  return (metadata.fulfills !== undefined && metadata.fulfills !== null)
    || (envelope.fulfills !== undefined && envelope.fulfills !== null);
}

function normalizeObligationAddress(value, options = {}) {
  const normalized = asNonEmptyString(value, '')?.toLowerCase() || '';
  if (!normalized) return null;
  if (options.creditor === true && ['operator', 'room'].includes(normalized)) return normalized;
  if (normalized === 'operator' || normalized === 'room') return null;
  if (STATIC_ROLE_ADDRESSES.has(normalized)) return normalized;
  return null;
}

function stableDigest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function buildObligationId(input = {}) {
  const canonical = [
    toPositiveInteger(input.createdFromRowId || input.created_from_row_id),
    asNonEmptyString(input.creditorAddress || input.creditor_address, ''),
    asNonEmptyString(input.obligorAddress || input.obligor_address, ''),
    normalizeExpectedClass(input.expectedClass || input.expected_class) || '',
    normalizeStalenessClass(input.stalenessClass || input.staleness_class) || '',
    asNonEmptyString(input.leaseId || input.lease_id, ''),
  ].join('\u0000');
  return `obl_${stableDigest(canonical)}`;
}

function buildObligationEventId(obligationId, transition, discriminator = '') {
  return `oble_${stableDigest([
    asNonEmptyString(obligationId, ''),
    asNonEmptyString(transition, ''),
    asNonEmptyString(discriminator, ''),
  ].join('\u0000'))}`;
}

function isProofQualifiedCommsStatus(value) {
  return PROOF_QUALIFIED_COMMS_STATUSES.has(String(value || '').trim().toLowerCase());
}

function canonicalSessionBoundary(value) {
  const text = asNonEmptyString(value, null);
  if (!text) return null;
  const match = text.match(/^app-session-(\d+)(?::|$)/i);
  return match ? `app-session-${Number.parseInt(match[1], 10)}` : text;
}

function obligationOutlivedAtBeat(obligation = {}, sourceRow = {}, beatRow = {}) {
  const sourceRowId = toPositiveInteger(obligation.createdFromRowId || obligation.created_from_row_id);
  const beatRowId = toPositiveInteger(beatRow.rowId || beatRow.row_id);
  const stalenessClass = normalizeStalenessClass(
    obligation.stalenessClass || obligation.staleness_class
  );
  if (!sourceRowId || !beatRowId || beatRowId <= sourceRowId || !stalenessClass) return false;
  if (stalenessClass === 'open') return false;
  if (stalenessClass === 'turn' || stalenessClass === 'beat') return true;
  const sourceBoundary = canonicalSessionBoundary(sourceRow.sessionId || sourceRow.session_id);
  const beatBoundary = canonicalSessionBoundary(beatRow.sessionId || beatRow.session_id);
  return Boolean(sourceBoundary && beatBoundary && sourceBoundary !== beatBoundary);
}

function mapObligationRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    obligationId: row.obligation_id,
    createdFromRowId: row.created_from_row_id,
    creditorAddress: row.creditor_address,
    obligorAddress: row.obligor_address,
    expectedClass: row.expected_class,
    stalenessClass: row.staleness_class,
    leaseId: row.lease_id,
    status: row.status,
    fulfilledByRowId: row.fulfilled_by_row_id,
    releasedReason: row.released_reason,
    createdEventId: row.created_event_id,
    lastEventId: row.last_event_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(tempPath); } catch {}
  }
}

function buildLapseNotice(obligation = {}, beatRow = {}, options = {}) {
  const obligationId = asNonEmptyString(obligation.obligationId || obligation.obligation_id, null);
  const sourceRowId = toPositiveInteger(
    obligation.createdFromRowId || obligation.created_from_row_id
  );
  const beatRowId = toPositiveInteger(beatRow.rowId || beatRow.row_id);
  const expectedClass = normalizeExpectedClass(
    obligation.expectedClass || obligation.expected_class
  );
  const createdAtMs = Number.isFinite(Number(options.nowMs))
    ? Math.floor(Number(options.nowMs))
    : Date.now();
  if (!obligationId || !sourceRowId || !beatRowId || !expectedClass) return null;
  return {
    schema: 'squidrun.next_session_notice.v1',
    topic: `obligation:${obligationId}`,
    status: 'lapsed',
    createdAt: new Date(createdAtMs).toISOString(),
    message: `Obligation ${obligationId} (${expectedClass}) from comms row ${sourceRowId} remains unresolved at natural beat row ${beatRowId}; room re-drive required.`,
    audience: ROOM_AUDIENCE.slice(),
    obligationId,
    thread: {
      createdFromRowId: sourceRowId,
      naturalBeatRowId: beatRowId,
    },
    acknowledgements: {},
  };
}

function writeLapseNotice(obligation = {}, beatRow = {}, options = {}) {
  const spoolPath = asNonEmptyString(options.spoolPath, null);
  if (!spoolPath) return { ok: false, reason: 'notice_spool_path_required' };
  const notice = buildLapseNotice(obligation, beatRow, options);
  if (!notice) return { ok: false, reason: 'notice_payload_invalid' };
  if (typeof options.validateNotice === 'function') {
    const validation = options.validateNotice(notice);
    if (!validation?.ok) {
      return { ok: false, reason: validation?.reason || 'notice_schema_invalid' };
    }
  }
  const safeId = notice.obligationId.replace(/[^A-Za-z0-9_-]/g, '-');
  const noticePath = path.join(path.resolve(spoolPath), `obligation-${safeId}-lapsed.json`);
  if (fs.existsSync(noticePath)) {
    return { ok: true, status: 'existing', noticePath, notice };
  }
  writeJsonAtomic(noticePath, notice);
  return { ok: true, status: 'written', noticePath, notice };
}

module.exports = {
  EXPECTED_CLASSES,
  STALENESS_CLASSES,
  OBLIGATION_STATUSES,
  PROOF_QUALIFIED_COMMS_STATUSES,
  ROOM_AUDIENCE,
  asObject,
  asNonEmptyString,
  toPositiveInteger,
  isForbiddenObligationField,
  findForbiddenObligationFields,
  validateObligationWritePayload,
  sanitizeObligationRead,
  normalizeExpectedClass,
  normalizeStalenessClass,
  normalizeObligationStatus,
  normalizeExpectation,
  parseExpectationFlag,
  normalizeFulfillmentDeclaration,
  extractExpectationFromMetadata,
  metadataDeclaresExpectation,
  extractFulfillmentFromMetadata,
  metadataDeclaresFulfillment,
  normalizeObligationAddress,
  buildObligationId,
  buildObligationEventId,
  isProofQualifiedCommsStatus,
  canonicalSessionBoundary,
  obligationOutlivedAtBeat,
  mapObligationRow,
  buildLapseNotice,
  writeLapseNotice,
};
