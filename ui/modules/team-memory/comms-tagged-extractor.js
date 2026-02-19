const crypto = require('crypto');
const path = require('path');
const { WORKSPACE_PATH, resolveCoordPath } = require('../../config');
const { EvidenceLedgerStore } = require('../main/evidence-ledger-store');

const TAG_RULES = Object.freeze({
  DECISION: {
    claimType: 'decision',
    confidence: 0.9,
    prefix: 'Decision',
  },
  TASK: {
    claimType: 'hypothesis',
    confidence: 0.66,
    prefix: 'Task',
  },
  FINDING: {
    claimType: 'fact',
    confidence: 0.78,
    prefix: 'Finding',
  },
  BLOCKER: {
    claimType: 'negative',
    confidence: 0.88,
    prefix: 'Blocker',
  },
});

const TAG_PATTERN = /^(DECISION|TASK|FINDING|BLOCKER)\s*:\s*(.+)$/i;
const KNOWN_TAG_PREFIX_PATTERNS = [
  /^\[[^\]]+\]\s*/,
  /^\([^)]+#\d+\)\s*:\s*/i,
  /^[-*]\s+/,
];
const DEFAULT_EXTRACT_LIMIT = 5000;

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
  ['system', 'system'],
  ['user', 'user'],
]);

function resolveDefaultEvidenceLedgerDbPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'runtime', 'evidence-ledger.db');
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeOwner(rawOwner = '') {
  const normalized = asString(rawOwner, '').toLowerCase();
  if (!normalized) return 'system';
  return OWNER_ALIAS_MAP.get(normalized) || normalized;
}

function normalizeDetail(rawDetail = '') {
  const normalized = String(rawDetail || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  if (normalized.length <= 320) return normalized;
  return `${normalized.slice(0, 317)}...`;
}

function stripKnownTagPrefixes(line) {
  let normalized = String(line || '').trim();
  if (!normalized) return '';
  for (let i = 0; i < 6; i += 1) {
    let changed = false;
    for (const pattern of KNOWN_TAG_PREFIX_PATTERNS) {
      const next = normalized.replace(pattern, '');
      if (next !== normalized) {
        normalized = next.trimStart();
        changed = true;
      }
    }
    if (!changed) break;
  }
  return normalized;
}

function toEventTsMs(row = {}, nowMs = Date.now()) {
  const candidates = [row.brokeredAtMs, row.sentAtMs, row.updatedAtMs, nowMs];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return Math.floor(numeric);
    }
  }
  return Math.floor(nowMs);
}

function extractTaggedItems(rawBody = '') {
  const lines = String(rawBody || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const items = [];
  for (const line of lines) {
    const normalizedLine = stripKnownTagPrefixes(line);
    const match = normalizedLine.match(TAG_PATTERN);
    if (!match) continue;
    const tag = String(match[1] || '').toUpperCase();
    const detail = normalizeDetail(match[2] || '');
    if (!TAG_RULES[tag] || !detail) continue;
    items.push({ tag, detail });
  }
  return items;
}

function deterministicHash(input = '') {
  return crypto.createHash('sha1').update(String(input)).digest('hex');
}

function buildStatement(owner, tag, detail) {
  const rule = TAG_RULES[tag];
  const prefix = rule?.prefix || tag;
  return `${prefix} noted by ${owner}: ${detail}`;
}

function buildTaggedClaimRecord(row, tagItem, index = 0, nowMs = Date.now()) {
  const tag = tagItem.tag;
  const rule = TAG_RULES[tag];
  const owner = normalizeOwner(row?.senderRole || row?.targetRole || 'system');
  const messageId = asString(row?.messageId, 'unknown-message');
  const detailKey = normalizeDetail(tagItem.detail).toLowerCase();
  const idempotencyKey = `comms-tag:${messageId}:${tag}:${index}:${deterministicHash(detailKey).slice(0, 16)}`;
  const claimId = `clm_${deterministicHash(idempotencyKey).slice(0, 24)}`;
  const createdAt = toEventTsMs(row, nowMs);

  const scopes = [
    `channel:${asString(row?.channel, 'ws').toLowerCase()}`,
    `tag:${tag.toLowerCase()}`,
  ];
  const targetRole = asString(row?.targetRole, '').toLowerCase();
  if (targetRole) scopes.push(`target:${targetRole}`);

  return {
    claimId,
    idempotencyKey,
    statement: buildStatement(owner, tag, tagItem.detail),
    claimType: rule.claimType,
    owner,
    confidence: rule.confidence,
    status: 'proposed',
    supersedes: null,
    session: asString(row?.sessionId, '') || null,
    ttlHours: null,
    createdAt,
    updatedAt: nowMs,
    scopes,
    tag,
    messageId,
    tsMs: createdAt,
  };
}

function extractTaggedClaimsFromComms(options = {}) {
  const teamDb = options.teamDb;
  if (!teamDb || typeof teamDb.prepare !== 'function') {
    return { ok: false, reason: 'team_memory_unavailable' };
  }

  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const limit = Math.max(1, Math.min(50_000, Number(options.limit) || DEFAULT_EXTRACT_LIMIT));
  const evidenceLedgerDbPath = options.evidenceLedgerDbPath || resolveDefaultEvidenceLedgerDbPath();

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

  const journalRows = ledgerStore.queryCommsJournal({
    sessionId: options.sessionId,
    sinceMs: options.sinceMs,
    untilMs: options.untilMs,
    order: 'asc',
    limit,
  });

  if (!Array.isArray(journalRows) || journalRows.length === 0) {
    ledgerStore.close();
    return {
      ok: true,
      status: 'no_rows',
      scannedMessages: 0,
      taggedMessages: 0,
      insertedClaims: 0,
      duplicateClaims: 0,
      newestTsMs: null,
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

  let taggedMessages = 0;
  let insertedClaims = 0;
  let duplicateClaims = 0;
  let newestTsMs = null;

  try {
    teamDb.exec('BEGIN IMMEDIATE;');
    for (const row of journalRows) {
      const taggedItems = extractTaggedItems(row?.rawBody || '');
      if (taggedItems.length === 0) continue;

      taggedMessages += 1;
      for (let index = 0; index < taggedItems.length; index += 1) {
        const tagged = taggedItems[index];
        const record = buildTaggedClaimRecord(row, tagged, index, nowMs);

        const claimResult = insertClaim.run(
          record.claimId,
          record.idempotencyKey,
          record.statement,
          record.claimType,
          record.owner,
          record.confidence,
          record.status,
          record.supersedes,
          record.session,
          record.ttlHours,
          record.createdAt,
          record.updatedAt
        );

        if (Number(claimResult?.changes || 0) > 0) {
          insertedClaims += 1;
          for (const scope of record.scopes) {
            insertScope.run(record.claimId, scope);
          }
        } else {
          duplicateClaims += 1;
        }

        if (newestTsMs === null || record.tsMs > newestTsMs) {
          newestTsMs = record.tsMs;
        }
      }
    }
    teamDb.exec('COMMIT;');
  } catch (err) {
    try { teamDb.exec('ROLLBACK;'); } catch {}
    ledgerStore.close();
    return {
      ok: false,
      reason: 'tagged_extract_failed',
      error: err.message,
      scannedMessages: journalRows.length,
      taggedMessages,
      insertedClaims,
      duplicateClaims,
      newestTsMs,
    };
  }

  ledgerStore.close();
  return {
    ok: true,
    status: 'extracted',
    scannedMessages: journalRows.length,
    taggedMessages,
    insertedClaims,
    duplicateClaims,
    newestTsMs,
  };
}

module.exports = {
  TAG_RULES,
  extractTaggedItems,
  buildTaggedClaimRecord,
  extractTaggedClaimsFromComms,
  resolveDefaultEvidenceLedgerDbPath,
};
