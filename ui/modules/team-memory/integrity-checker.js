const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WORKSPACE_PATH, resolveCoordPath } = require('../../config');
const { EvidenceLedgerStore } = require('../main/evidence-ledger-store');

function resolveDefaultEvidenceLedgerDbPath() {
  if (typeof resolveCoordPath !== 'function') {
    throw new Error('resolveCoordPath unavailable; cannot resolve runtime/evidence-ledger.db');
  }
  return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
}

function resolveDefaultErrorsPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('build', 'errors.md'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'build', 'errors.md');
}

const DEFAULT_EVIDENCE_LEDGER_DB_PATH = resolveDefaultEvidenceLedgerDbPath();
const DEFAULT_ERRORS_MD_PATH = resolveDefaultErrorsPath();
const INTEGRITY_BLOCK_START = '<!-- TEAM_MEMORY_EVIDENCE_REF_CHECK_START -->';
const INTEGRITY_BLOCK_END = '<!-- TEAM_MEMORY_EVIDENCE_REF_CHECK_END -->';

function asPositiveInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function asFiniteMs(value, fallback = Date.now()) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.floor(fallback);
  return Math.floor(numeric);
}

function safeSlug(value, fallback = 'unknown') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const slug = raw.replace(/[^A-Za-z0-9._:-]+/g, '-');
  return slug || fallback;
}

function buildRepairTraceId(orphan = {}) {
  const evidenceRef = String(orphan?.evidenceRef || '').trim();
  if (evidenceRef) {
    const compact = safeSlug(evidenceRef, 'evidence');
    return `trc_tm_integrity_${compact}`;
  }
  try {
    return `trc_tm_integrity_${crypto.randomUUID()}`;
  } catch {
    return `trc_tm_integrity_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function buildRepairPayload(claimInfo = {}, orphan = {}, nowMs = Date.now()) {
  return {
    reason: 'orphaned_evidence_ref_backfill',
    claimId: String(orphan?.claimId || '').trim() || null,
    evidenceRef: String(orphan?.evidenceRef || '').trim() || null,
    claimStatus: String(claimInfo?.status || '').trim() || null,
    claimType: String(claimInfo?.claimType || '').trim() || null,
    claimOwner: String(claimInfo?.owner || '').trim() || null,
    claimStatement: String(claimInfo?.statement || '').trim() || null,
    repairedAt: new Date(asFiniteMs(nowMs)).toISOString(),
  };
}

function loadClaimInfoById(teamDb, claimId) {
  if (!teamDb || typeof teamDb.prepare !== 'function') return null;
  const normalizedId = String(claimId || '').trim();
  if (!normalizedId) return null;
  const row = teamDb.prepare(`
    SELECT id, statement, claim_type, owner, status, session
    FROM claims
    WHERE id = ?
    LIMIT 1
  `).get(normalizedId);
  if (!row) return null;
  return {
    id: String(row.id || '').trim(),
    statement: String(row.statement || '').trim(),
    claimType: String(row.claim_type || '').trim(),
    owner: String(row.owner || '').trim(),
    status: String(row.status || '').trim(),
    session: String(row.session || '').trim() || null,
  };
}

function repairOrphanedEvidenceRefs(options = {}) {
  const ledgerStore = options.ledgerStore;
  if (!ledgerStore || typeof ledgerStore.appendEvent !== 'function') {
    return {
      ok: false,
      reason: 'evidence_ledger_unavailable',
      attempted: 0,
      inserted: 0,
      duplicated: 0,
      failed: 0,
      repairedCount: 0,
      failures: [],
    };
  }

  const teamDb = options.teamDb;
  const nowMs = asFiniteMs(options.nowMs);
  const claimInfoCache = new Map();
  const orphans = Array.isArray(options.orphans) ? options.orphans : [];

  let attempted = 0;
  let inserted = 0;
  let duplicated = 0;
  let failed = 0;
  const failures = [];

  for (const orphan of orphans) {
    const claimId = String(orphan?.claimId || '').trim();
    const evidenceRef = String(orphan?.evidenceRef || '').trim();
    if (!evidenceRef) continue;
    attempted += 1;

    let claimInfo = claimInfoCache.get(claimId);
    if (claimInfo === undefined) {
      claimInfo = loadClaimInfoById(teamDb, claimId);
      claimInfoCache.set(claimId, claimInfo || null);
    }

    const appendResult = ledgerStore.appendEvent({
      eventId: evidenceRef,
      traceId: buildRepairTraceId(orphan),
      type: 'team-memory.integrity.backfill',
      stage: 'team_memory',
      source: 'team-memory.integrity-checker',
      paneId: 'system',
      role: 'system',
      ts: nowMs,
      direction: 'internal',
      payload: buildRepairPayload(claimInfo, orphan, nowMs),
      meta: {
        integrityRepair: true,
        repairCode: 'ERR-TM-001',
        claimId: claimId || null,
      },
    }, {
      nowMs,
      sessionId: claimInfo?.session || null,
    });

    if (appendResult?.ok === true && appendResult?.status === 'inserted') {
      inserted += 1;
      continue;
    }
    if (appendResult?.ok === true && appendResult?.status === 'duplicate') {
      duplicated += 1;
      continue;
    }

    failed += 1;
    failures.push({
      claimId: claimId || 'unknown-claim',
      evidenceRef,
      reason: appendResult?.reason || appendResult?.status || 'repair_failed',
    });
  }

  return {
    ok: true,
    attempted,
    inserted,
    duplicated,
    failed,
    repairedCount: inserted + duplicated,
    failures,
  };
}

function scanOrphanedEvidenceRefs(options = {}) {
  const teamDb = options.teamDb;
  if (!teamDb || typeof teamDb.prepare !== 'function') {
    return { ok: false, reason: 'team_memory_unavailable' };
  }

  const limit = asPositiveInt(options.limit, 5000);
  const evidenceLedgerDbPath = options.evidenceLedgerDbPath || DEFAULT_EVIDENCE_LEDGER_DB_PATH;
  const repairOrphans = options.repairOrphans === true;
  const nowMs = asFiniteMs(options.nowMs);
  const refs = teamDb.prepare(`
    SELECT claim_id AS claimId, evidence_ref AS evidenceRef
    FROM claim_evidence
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

  if (!Array.isArray(refs) || refs.length === 0) {
    return {
      ok: true,
      totalChecked: 0,
      orphanCount: 0,
      orphans: [],
    };
  }

  const ledgerStore = new EvidenceLedgerStore({
    dbPath: evidenceLedgerDbPath,
    enabled: true,
  });
  const ledgerInit = ledgerStore.init();
  if (!ledgerInit.ok || !ledgerStore.db) {
    ledgerStore.close();
    return {
      ok: false,
      reason: 'evidence_ledger_unavailable',
      ledgerReason: ledgerInit.reason,
      totalChecked: refs.length,
      orphanCount: 0,
      orphans: [],
    };
  }

  const lookupStmt = ledgerStore.db.prepare(`
    SELECT event_id
    FROM ledger_events
    WHERE event_id = ?
    LIMIT 1
  `);

  const orphans = [];
  for (const ref of refs) {
    const evidenceRef = String(ref?.evidenceRef || '').trim();
    if (!evidenceRef) continue;
    const exists = lookupStmt.get(evidenceRef);
    if (!exists) {
      orphans.push({
        claimId: String(ref?.claimId || '').trim() || 'unknown-claim',
        evidenceRef,
      });
    }
  }

  const initialOrphans = orphans;
  let repair = null;
  let unresolvedOrphans = initialOrphans;
  if (repairOrphans && initialOrphans.length > 0) {
    repair = repairOrphanedEvidenceRefs({
      teamDb,
      ledgerStore,
      orphans: initialOrphans,
      nowMs,
    });
    unresolvedOrphans = [];
    for (const orphan of initialOrphans) {
      const exists = lookupStmt.get(orphan.evidenceRef);
      if (!exists) {
        unresolvedOrphans.push(orphan);
      }
    }
  }

  ledgerStore.close();
  return {
    ok: true,
    totalChecked: refs.length,
    orphanCount: unresolvedOrphans.length,
    orphans: unresolvedOrphans,
    initialOrphanCount: initialOrphans.length,
    repair,
  };
}

function removeIntegrityBlock(content) {
  return String(content || '').replace(
    /<!-- TEAM_MEMORY_EVIDENCE_REF_CHECK_START -->[\s\S]*?<!-- TEAM_MEMORY_EVIDENCE_REF_CHECK_END -->\r?\n?/g,
    ''
  );
}

function buildIntegrityBlock(scanResult, options = {}) {
  const nowIso = options.nowIso || new Date().toISOString();
  const maxList = asPositiveInt(options.maxList, 25);
  const orphans = Array.isArray(scanResult?.orphans) ? scanResult.orphans : [];
  const listed = orphans.slice(0, maxList);

  const lines = [
    INTEGRITY_BLOCK_START,
    `- [ERR-TM-001] Team Memory evidence_ref integrity scan (${nowIso}) found ${orphans.length} orphan reference(s).`,
    `- Scan details: checked ${Number(scanResult?.totalChecked || 0)} claim_evidence row(s) against Evidence Ledger.`,
  ];

  for (const orphan of listed) {
    lines.push(`- Orphan ref: claim \`${orphan.claimId}\` -> missing evidence \`${orphan.evidenceRef}\``);
  }
  if (orphans.length > listed.length) {
    lines.push(`- Additional orphan refs not listed: ${orphans.length - listed.length}`);
  }

  lines.push(INTEGRITY_BLOCK_END);
  return lines.join('\n');
}

function upsertIntegrityReport(scanResult, options = {}) {
  const errorsPath = options.errorsPath || DEFAULT_ERRORS_MD_PATH;

  let content = '';
  if (fs.existsSync(errorsPath)) {
    content = fs.readFileSync(errorsPath, 'utf-8');
  } else {
    fs.mkdirSync(path.dirname(errorsPath), { recursive: true });
    content = '# Active Errors\n\n## ACTIVE (Max 5)\n\n(No active errors.)\n';
  }

  const cleaned = removeIntegrityBlock(content);
  const orphanCount = Number(scanResult?.orphanCount || 0);
  let next = cleaned;

  if (orphanCount > 0) {
    const block = buildIntegrityBlock(scanResult, {
      nowIso: options.nowIso,
      maxList: options.maxList,
    });

    const recentResolvedMarker = '## Recently Resolved';
    const idx = cleaned.indexOf(recentResolvedMarker);
    if (idx >= 0) {
      const head = cleaned.slice(0, idx).trimEnd();
      const tail = cleaned.slice(idx).trimStart();
      next = `${head}\n\n${block}\n\n${tail}`;
    } else {
      next = `${cleaned.trimEnd()}\n\n${block}\n`;
    }
  }

  if (next !== content) {
    fs.writeFileSync(errorsPath, next, 'utf-8');
  }

  return {
    ok: true,
    updated: next !== content,
    orphanCount,
    errorsPath,
  };
}

module.exports = {
  scanOrphanedEvidenceRefs,
  repairOrphanedEvidenceRefs,
  upsertIntegrityReport,
  resolveDefaultEvidenceLedgerDbPath,
  resolveDefaultErrorsPath,
};
