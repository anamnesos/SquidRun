const fs = require('fs');
const path = require('path');
const { WORKSPACE_PATH, resolveCoordPath } = require('../../config');
const { EvidenceLedgerStore } = require('../main/evidence-ledger-store');

function resolveDefaultEvidenceLedgerDbPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'runtime', 'evidence-ledger.db');
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

function scanOrphanedEvidenceRefs(options = {}) {
  const teamDb = options.teamDb;
  if (!teamDb || typeof teamDb.prepare !== 'function') {
    return { ok: false, reason: 'team_memory_unavailable' };
  }

  const limit = asPositiveInt(options.limit, 5000);
  const evidenceLedgerDbPath = options.evidenceLedgerDbPath || DEFAULT_EVIDENCE_LEDGER_DB_PATH;
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

  ledgerStore.close();
  return {
    ok: true,
    totalChecked: refs.length,
    orphanCount: orphans.length,
    orphans,
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
  upsertIntegrityReport,
  resolveDefaultEvidenceLedgerDbPath,
  resolveDefaultErrorsPath,
};
