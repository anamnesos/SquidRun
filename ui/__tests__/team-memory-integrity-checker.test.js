const fs = require('fs');
const os = require('os');
const path = require('path');

const { TeamMemoryStore, loadSqliteDriver } = require('../modules/team-memory/store');
const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  scanOrphanedEvidenceRefs,
  upsertIntegrityReport,
} = require('../modules/team-memory/integrity-checker');

const maybeDescribe = loadSqliteDriver() ? describe : describe.skip;

maybeDescribe('team-memory integrity checker', () => {
  let tempDir;
  let teamStore;
  let evidenceStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-team-integrity-'));
    teamStore = new TeamMemoryStore({
      dbPath: path.join(tempDir, 'team-memory.sqlite'),
    });
    evidenceStore = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger.db'),
      enabled: true,
    });
    expect(teamStore.init().ok).toBe(true);
    expect(evidenceStore.init().ok).toBe(true);
  });

  afterEach(() => {
    if (teamStore) teamStore.close();
    if (evidenceStore) evidenceStore.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('detects orphan evidence refs and upserts errors.md marker block', () => {
    evidenceStore.appendEvent({
      eventId: 'evt-existing',
      traceId: 'trc-existing',
      type: 'test.event',
      stage: 'test',
      source: 'test-suite',
    });

    teamStore.db.prepare(`
      INSERT INTO claims (
        id, idempotency_key, statement, claim_type, owner, confidence,
        status, supersedes, session, ttl_hours, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'claim-1',
      'idemp-1',
      'Test claim',
      'fact',
      'builder',
      1.0,
      'proposed',
      null,
      's_1',
      null,
      Date.now(),
      Date.now()
    );

    teamStore.db.prepare(`
      INSERT INTO claim_evidence (claim_id, evidence_ref, added_by, relation, weight, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('claim-1', 'evt-existing', 'builder', 'supports', 1.0, Date.now());
    teamStore.db.prepare(`
      INSERT INTO claim_evidence (claim_id, evidence_ref, added_by, relation, weight, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('claim-1', 'evt-missing', 'builder', 'supports', 1.0, Date.now());

    const scan = scanOrphanedEvidenceRefs({
      teamDb: teamStore.db,
      evidenceLedgerDbPath: path.join(tempDir, 'evidence-ledger.db'),
    });

    expect(scan.ok).toBe(true);
    expect(scan.orphanCount).toBe(1);
    expect(scan.orphans[0]).toEqual({
      claimId: 'claim-1',
      evidenceRef: 'evt-missing',
    });

    const errorsPath = path.join(tempDir, 'errors.md');
    fs.writeFileSync(errorsPath, [
      '# Active Errors',
      '',
      '## ACTIVE (Max 5)',
      '',
      '(No active errors.)',
      '',
      '## Recently Resolved',
      '- none',
      '',
    ].join('\n'), 'utf-8');

    const report = upsertIntegrityReport(scan, { errorsPath, nowIso: '2026-02-13T00:00:00.000Z' });
    expect(report.ok).toBe(true);
    expect(report.updated).toBe(true);

    const withBlock = fs.readFileSync(errorsPath, 'utf-8');
    expect(withBlock).toContain('TEAM_MEMORY_EVIDENCE_REF_CHECK_START');
    expect(withBlock).toContain('evt-missing');

    const cleared = upsertIntegrityReport({
      ok: true,
      totalChecked: 2,
      orphanCount: 0,
      orphans: [],
    }, { errorsPath });
    expect(cleared.ok).toBe(true);
    const finalContent = fs.readFileSync(errorsPath, 'utf-8');
    expect(finalContent).not.toContain('TEAM_MEMORY_EVIDENCE_REF_CHECK_START');
  });
});
