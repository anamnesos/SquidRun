const crypto = require('crypto');
const path = require('path');
const { resolveCoordPath } = require('../../config');
const { EvidenceLedgerStore } = require('../main/evidence-ledger-store');

function resolveDefaultEvidenceLedgerDbPath() {
  if (typeof resolveCoordPath !== 'function') {
    throw new Error('resolveCoordPath unavailable; cannot resolve runtime/evidence-ledger.db');
  }
  return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
}

const DEFAULT_EVIDENCE_LEDGER_DB_PATH = resolveDefaultEvidenceLedgerDbPath();
const DEFAULT_BACKFILL_LIMIT = 5000;

const OWNER_ALIAS_MAP = new Map([
  ['arch', 'architect'],
  ['architect', 'architect'],
  ['builder', 'builder'],
  ['devops', 'builder'],
  ['infra', 'builder'],
  ['backend', 'builder'],
  ['oracle', 'oracle'],
  ['ana', 'oracle'],
  ['analyst', 'oracle'],
  ['frontend', 'frontend'],
  ['reviewer', 'reviewer'],
]);

function normalizeOwner(rawOwner = '') {
  const normalized = String(rawOwner || '').trim().toLowerCase();
  if (!normalized) return 'system';
  return OWNER_ALIAS_MAP.get(normalized) || normalized;
}

function inferClaimType(eventType, payload = {}) {
  const type = String(eventType || '').toLowerCase();
  const text = [
    type,
    payload?.status,
    payload?.outcome,
    payload?.error,
    payload?.severity,
  ].filter(Boolean).join(' ').toLowerCase();

  if (text.includes('decision') || text.includes('promot')) return 'decision';
  if (text.includes('hypothesis') || text.includes('assumption')) return 'hypothesis';
  if (text.includes('error') || text.includes('fail') || text.includes('block') || text.includes('incident')) {
    return 'negative';
  }
  return 'fact';
}

function toClaimStatement(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const candidate = [
    payload.statement,
    payload.summary,
    payload.title,
    payload.message,
    payload.error,
    payload.reason,
    event?.type,
  ].find((value) => typeof value === 'string' && value.trim().length > 0);

  const base = String(candidate || event?.type || 'unknown_event').replace(/\s+/g, ' ').trim();
  return base.length > 280 ? `${base.slice(0, 277)}...` : base;
}

function toSessionId(sessionId) {
  const session = String(sessionId || '').trim();
  return session || null;
}

function toDeterministicClaimId(idempotencyKey) {
  const digest = crypto.createHash('sha1').update(idempotencyKey).digest('hex').slice(0, 24);
  return `clm-${digest}`;
}

function buildBackfillRecord(event, nowMs) {
  const eventId = String(event?.eventId || '').trim();
  const eventType = String(event?.type || 'unknown').trim() || 'unknown';
  const idempotencyKey = `backfill:${eventType}:${eventId}`;
  const claimId = toDeterministicClaimId(idempotencyKey);
  const owner = normalizeOwner(event?.role || event?.source || 'system');
  const claimType = inferClaimType(eventType, event?.payload || {});
  const statement = toClaimStatement(event);
  const session = toSessionId(event?.sessionId);
  const scope = typeof event?.source === 'string' && event.source.trim() ? event.source.trim() : null;

  return {
    claimId,
    idempotencyKey,
    statement,
    claimType,
    owner,
    session,
    scope,
    evidenceRef: eventId,
    createdAt: (event?.ts !== null && event?.ts !== undefined && Number.isFinite(Number(event?.ts))) ? Number(event.ts) : nowMs,
    updatedAt: nowMs,
  };
}

function runBackfill(options = {}) {
  const teamDb = options.teamDb;
  if (!teamDb || typeof teamDb.prepare !== 'function') {
    return { ok: false, reason: 'team_memory_unavailable' };
  }

  const limit = Math.max(1, Math.min(50000, Number(options.limit) || DEFAULT_BACKFILL_LIMIT));
  const nowMs = (options.nowMs !== null && options.nowMs !== undefined && Number.isFinite(Number(options.nowMs)))
    ? Number(options.nowMs)
    : Date.now();
  const evidenceLedgerDbPath = options.evidenceLedgerDbPath || DEFAULT_EVIDENCE_LEDGER_DB_PATH;

  const ledgerStore = new EvidenceLedgerStore({
    dbPath: evidenceLedgerDbPath,
    enabled: true,
  });
  const ledgerInit = ledgerStore.init();
  if (!ledgerInit.ok) {
    ledgerStore.close();
    return {
      ok: false,
      reason: 'evidence_ledger_unavailable',
      ledgerReason: ledgerInit.reason,
    };
  }

  const events = ledgerStore.queryEvents({
    limit,
    order: 'asc',
  });

  if (!Array.isArray(events) || events.length === 0) {
    ledgerStore.close();
    return {
      ok: true,
      status: 'no_events',
      scannedEvents: 0,
      insertedClaims: 0,
      duplicateClaims: 0,
      linkedEvidenceRows: 0,
    };
  }

  const insertClaim = teamDb.prepare(`
    INSERT OR IGNORE INTO claims (
      id, idempotency_key, statement, claim_type, owner, confidence, status,
      supersedes, session, ttl_hours, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertScope = teamDb.prepare(`
    INSERT OR IGNORE INTO claim_scopes (claim_id, scope)
    VALUES (?, ?)
  `);
  const insertEvidence = teamDb.prepare(`
    INSERT OR IGNORE INTO claim_evidence (claim_id, evidence_ref, added_by, relation, weight, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let insertedClaims = 0;
  let duplicateClaims = 0;
  let linkedEvidenceRows = 0;

  try {
    teamDb.exec('BEGIN IMMEDIATE;');
    for (const event of events) {
      const eventId = String(event?.eventId || '').trim();
      if (!eventId) continue;
      const record = buildBackfillRecord(event, nowMs);

      const claimResult = insertClaim.run(
        record.claimId,
        record.idempotencyKey,
        record.statement,
        record.claimType,
        record.owner,
        1.0,
        'proposed',
        null,
        record.session,
        null,
        record.createdAt,
        record.updatedAt
      );
      if (Number(claimResult?.changes || 0) > 0) {
        insertedClaims += 1;
      } else {
        duplicateClaims += 1;
      }

      if (record.scope) {
        insertScope.run(record.claimId, record.scope);
      }

      const evidenceResult = insertEvidence.run(
        record.claimId,
        record.evidenceRef,
        record.owner,
        'supports',
        1.0,
        nowMs
      );
      if (Number(evidenceResult?.changes || 0) > 0) {
        linkedEvidenceRows += 1;
      }
    }
    teamDb.exec('COMMIT;');
  } catch (err) {
    try { teamDb.exec('ROLLBACK;'); } catch {}
    ledgerStore.close();
    return {
      ok: false,
      reason: 'backfill_failed',
      error: err.message,
      scannedEvents: events.length,
      insertedClaims,
      duplicateClaims,
      linkedEvidenceRows,
    };
  }

  ledgerStore.close();
  return {
    ok: true,
    status: 'backfilled',
    scannedEvents: events.length,
    insertedClaims,
    duplicateClaims,
    linkedEvidenceRows,
  };
}

module.exports = {
  runBackfill,
  buildBackfillRecord,
  resolveDefaultEvidenceLedgerDbPath,
};
