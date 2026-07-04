'use strict';

/**
 * VERDICT LEDGER v0 (Organism Charter S465, organ #2 — Oracle owns).
 * The auditor audited: every gate verdict / verify / banked claim becomes a
 * scored prediction with an outcome column that resolves later. Pure logic —
 * storage is Builder's; this module defines the record law and the math.
 *
 * Laws encoded here (contracts in __tests__/verdict-ledger.test.js):
 * - NO UNSOURCED VERDICTS: every record carries evidence (provenance seed).
 * - RESOLUTION IS IMMUTABLE: a resolved outcome is never overwritten —
 *   corrections happen by superseding with a NEW record that cites the old.
 * - SMALL-N APPLIES TO US: credibility below 5 resolutions reports
 *   INSUFFICIENT, not a number — the same floor we gave James's pricing.
 * - EVIDENCE EXPIRES: records may declare expiresAt; unresolved past expiry
 *   become 'expired' — visible, excluded from accuracy, never silently green.
 */

const KINDS = Object.freeze(['gate', 'verify', 'audit-finding', 'claim', 'constitution']);
const OPEN_STATUSES = Object.freeze(['open', 'pends']);
const RESOLVED_STATUSES = Object.freeze(['held', 'failed', 'mixed', 'expired', 'superseded']);
const MIN_RESOLUTIONS_FOR_CREDIBILITY = 5;

function createVerdict(input = {}) {
  const evidence = String(input.evidence || '').trim();
  if (!evidence) {
    throw new Error('verdict-ledger: unsourced verdict rejected — evidence is required');
  }
  const kind = String(input.kind || '').trim();
  if (!KINDS.includes(kind)) {
    throw new Error(`verdict-ledger: unknown kind '${kind}'`);
  }
  const statement = String(input.statement || '').trim();
  if (!statement) throw new Error('verdict-ledger: empty statement rejected');
  const issuer = String(input.issuer || '').trim();
  if (!issuer) throw new Error('verdict-ledger: issuer required');
  const issuedAt = String(input.issuedAt || '').trim();
  if (!issuedAt || Number.isNaN(Date.parse(issuedAt))) {
    throw new Error('verdict-ledger: valid issuedAt required');
  }
  return {
    id: String(input.id || `v-${issuedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${statement.length}-${issuer}`),
    issuedAt,
    issuer,
    kind,
    subject: String(input.subject || '').trim(),
    statement,
    evidence,
    source: String(input.source || 'live'),
    expiresAt: input.expiresAt ? String(input.expiresAt) : null,
    outcome: {
      status: input.pendsOn ? 'pends' : 'open',
      pendsOn: input.pendsOn ? String(input.pendsOn) : null,
      resolvedAt: null,
      resolver: null,
      note: null,
      supersededBy: null,
    },
  };
}

function resolveVerdict(record, resolution = {}) {
  if (!record || !record.outcome) throw new Error('verdict-ledger: no record');
  if (!OPEN_STATUSES.includes(record.outcome.status)) {
    throw new Error(
      `verdict-ledger: resolution is immutable — '${record.id}' is already '${record.outcome.status}'; supersede instead`
    );
  }
  const status = String(resolution.status || '').trim();
  if (!['held', 'failed', 'mixed'].includes(status)) {
    throw new Error(`verdict-ledger: invalid resolution status '${status}'`);
  }
  const resolver = String(resolution.resolver || '').trim();
  const note = String(resolution.note || '').trim();
  if (!resolver || !note) {
    throw new Error('verdict-ledger: resolver and note required — outcomes carry provenance too');
  }
  const resolvedAt = String(resolution.resolvedAt || '').trim();
  if (!resolvedAt || Number.isNaN(Date.parse(resolvedAt))) {
    throw new Error('verdict-ledger: valid resolvedAt required');
  }
  record.outcome = {
    ...record.outcome, status, resolvedAt, resolver, note,
  };
  return record;
}

/** Correction path: the old record stays; a new one supersedes it. */
function supersedeVerdict(oldRecord, newRecord) {
  if (!RESOLVED_STATUSES.includes(oldRecord.outcome.status)
    && !OPEN_STATUSES.includes(oldRecord.outcome.status)) {
    throw new Error('verdict-ledger: cannot supersede unknown status');
  }
  oldRecord.outcome = { ...oldRecord.outcome, status: 'superseded', supersededBy: newRecord.id };
  return oldRecord;
}

/** Sweep: unresolved records past expiry become 'expired' — visible, never green. */
function sweepExpired(records, nowIso) {
  const now = Date.parse(nowIso);
  let swept = 0;
  for (const r of records) {
    if (!OPEN_STATUSES.includes(r.outcome.status)) continue;
    if (r.expiresAt && Date.parse(r.expiresAt) < now) {
      r.outcome = { ...r.outcome, status: 'expired', note: 'evidence window closed unresolved' };
      swept += 1;
    }
  }
  return swept;
}

/**
 * Credibility: computed ONLY from resolved outcomes (held/failed/mixed).
 * Below the floor -> INSUFFICIENT, not a flattering number.
 */
function credibility(records, issuer) {
  const scored = records.filter((r) => r.issuer === issuer
    && ['held', 'failed', 'mixed'].includes(r.outcome.status));
  const open = records.filter((r) => r.issuer === issuer
    && OPEN_STATUSES.includes(r.outcome.status)).length;
  const expired = records.filter((r) => r.issuer === issuer
    && r.outcome.status === 'expired').length;
  if (scored.length < MIN_RESOLUTIONS_FOR_CREDIBILITY) {
    return {
      issuer, status: 'insufficient', resolved: scored.length, open, expired, accuracy: null,
    };
  }
  const held = scored.filter((r) => r.outcome.status === 'held').length;
  const mixed = scored.filter((r) => r.outcome.status === 'mixed').length;
  return {
    issuer,
    status: 'scored',
    resolved: scored.length,
    open,
    expired,
    accuracy: (held + 0.5 * mixed) / scored.length,
  };
}

module.exports = {
  KINDS,
  MIN_RESOLUTIONS_FOR_CREDIBILITY,
  createVerdict,
  credibility,
  resolveVerdict,
  supersedeVerdict,
  sweepExpired,
};
