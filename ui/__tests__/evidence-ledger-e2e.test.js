const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const { EvidenceLedgerMemory } = require('../modules/main/evidence-ledger-memory');

function hasSqliteDriver() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return true;
  } catch {
    // Continue to fallback.
  }
  try {
    // eslint-disable-next-line global-require
    require('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}

const maybeDescribe = hasSqliteDriver() ? describe : describe.skip;

maybeDescribe('evidence-ledger e2e lifecycle', () => {
  let tempDir;
  let store;
  let memory;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-ledger-e2e-'));
    store = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger-e2e.db'),
      maxRows: 5000,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      sessionId: 'e2e-session',
    });
    expect(store.init().ok).toBe(true);
    memory = new EvidenceLedgerMemory(store);
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('full lifecycle: decisions -> close -> startup snapshot assembly -> prune -> integrity', () => {
    const sessionOneStart = memory.recordSessionStart({
      sessionId: 'ses-301',
      sessionNumber: 301,
      mode: 'PTY',
      startedAtMs: 1700000000000,
      stats: { test_suites: 117, tests_passed: 3347 },
      team: { '1': 'Architect', '2': 'Builder', '3': 'Oracle' },
    });
    expect(sessionOneStart.ok).toBe(true);

    const decisions = [
      {
        category: 'architecture',
        title: 'Decision memory is source of truth',
        body: 'Agents restore startup context via ledger',
        author: 'architect',
      },
      {
        category: 'directive',
        title: 'Always run full jest before closeout',
        body: 'Persistent user directive',
        author: 'user',
      },
      {
        category: 'completion',
        title: 'Evidence Ledger Slice 3 Phase C complete',
        body: 'Snapshots + prune + e2e validated',
        author: 'builder',
      },
      {
        category: 'issue',
        title: 'ERR-E2E-001',
        body: 'Example tracked issue for continuity',
        author: 'oracle',
      },
      {
        category: 'roadmap',
        title: 'Runtime promotion engine wiring',
        body: 'Pending backlog integration task',
        author: 'architect',
      },
    ];

    const recordedDecisionIds = [];
    decisions.forEach((decision, index) => {
      const recorded = memory.recordDecision({
        ...decision,
        sessionId: 'ses-301',
        nowMs: 1700000000100 + index,
      });
      expect(recorded.ok).toBe(true);
      recordedDecisionIds.push(recorded.decisionId);
    });

    const archiveOneDecision = memory.updateDecision(recordedDecisionIds[2], {
      status: 'archived',
      nowMs: 1700000000150,
    });
    expect(archiveOneDecision.ok).toBe(true);

    const olderSnapshot = memory.snapshotContext('ses-301', {
      trigger: 'manual',
      nowMs: 1700000000180,
    });
    expect(olderSnapshot.ok).toBe(true);

    const sessionEndSnapshot = memory.snapshotContext('ses-301', {
      trigger: 'session_end',
      nowMs: 1700000000200,
    });
    expect(sessionEndSnapshot.ok).toBe(true);

    const latestSessionOneSnapshot = memory.getLatestSnapshot({ sessionId: 'ses-301' });
    expect(latestSessionOneSnapshot).not.toBeNull();
    expect(latestSessionOneSnapshot.snapshotId).toBe(sessionEndSnapshot.snapshotId);
    expect(latestSessionOneSnapshot.trigger).toBe('session_end');
    expect(latestSessionOneSnapshot.content.source).toBe('ledger');
    expect(Array.isArray(latestSessionOneSnapshot.content.completed)).toBe(true);
    expect(Array.isArray(latestSessionOneSnapshot.content.important_notes)).toBe(true);

    const sessionOneEnd = memory.recordSessionEnd('ses-301', {
      endedAtMs: 1700000000300,
      summary: 'Completed Phase C implementation',
      stats: { test_suites: 117, tests_passed: 3347 },
      team: { '1': 'Architect', '2': 'Builder', '3': 'Oracle' },
    });
    expect(sessionOneEnd.ok).toBe(true);

    const sessionTwoStart = memory.recordSessionStart({
      sessionId: 'ses-302',
      sessionNumber: 302,
      mode: 'PTY',
      startedAtMs: 1700001000000,
      stats: { test_suites: 117, tests_passed: 3347 },
      team: { '1': 'Architect', '2': 'Builder', '3': 'Oracle' },
    });
    expect(sessionTwoStart.ok).toBe(true);

    const startupSnapshot = memory.snapshotContext('ses-302', {
      trigger: 'session_start',
      nowMs: 1700001000010,
    });
    expect(startupSnapshot.ok).toBe(true);

    const latestSessionTwoSnapshot = memory.getLatestSnapshot({ sessionId: 'ses-302' });
    expect(latestSessionTwoSnapshot).not.toBeNull();
    expect(latestSessionTwoSnapshot.snapshotId).toBe(startupSnapshot.snapshotId);
    expect(latestSessionTwoSnapshot.trigger).toBe('session_start');
    expect(latestSessionTwoSnapshot.content.source).toBe('ledger.session_start_snapshot');
    expect(latestSessionTwoSnapshot.content.session).toBe(302);

    const newCompletion = memory.recordDecision({
      category: 'completion',
      title: 'Session 302 startup complete',
      body: 'Startup snapshot assembled for context windows',
      author: 'builder',
      sessionId: 'ses-302',
      nowMs: 1700001000020,
    });
    expect(newCompletion.ok).toBe(true);

    const pruned = store.prune({
      nowMs: 1700002000000,
      retentionMs: 60 * 1000,
      maxRows: 5000,
    });
    expect(pruned.ok).toBe(true);
    expect(pruned.removedArchivedDecisions).toBe(1);
    expect(pruned.removedSnapshots).toBe(1);

    const survivingSnapshots = store.db.prepare(`
      SELECT snapshot_id
      FROM ledger_context_snapshots
      ORDER BY snapshot_id ASC
    `).all().map((row) => row.snapshot_id);
    expect(survivingSnapshots).toEqual([sessionEndSnapshot.snapshotId, startupSnapshot.snapshotId].sort());

    const survivingSessions = store.db.prepare(`
      SELECT session_id
      FROM ledger_sessions
      ORDER BY session_id ASC
    `).all().map((row) => row.session_id);
    expect(survivingSessions).toEqual(['ses-301', 'ses-302']);

    const restored = memory.getLatestContext();
    expect(restored.source).toBe('ledger');
    expect(restored.session).toBe(302);
    expect(restored.mode).toBe('PTY');
    expect(Array.isArray(restored.completed)).toBe(true);
    expect(Array.isArray(restored.important_notes)).toBe(true);
    expect(Array.isArray(restored.roadmap)).toBe(true);
    expect(Array.isArray(restored.not_yet_done)).toBe(true);
    expect(typeof restored.known_issues).toBe('object');
    expect(typeof restored.architecture).toBe('object');
    expect(typeof restored.stats).toBe('object');
    expect(typeof restored.team).toBe('object');

    expect(restored.completed.some((item) => item.includes('Session 302 startup complete'))).toBe(true);
    expect(restored.completed.some((item) => item.includes('Evidence Ledger Slice 3 Phase C complete'))).toBe(false);
    expect(restored.important_notes.some((item) => item.includes('Always run full jest before closeout'))).toBe(true);
    expect(restored.roadmap.some((item) => item.includes('Runtime promotion engine wiring'))).toBe(true);
    expect(restored.not_yet_done.some((item) => item.includes('Runtime promotion engine wiring'))).toBe(true);
    expect(restored.known_issues['ERR-E2E-001']).toBe('Example tracked issue for continuity');
    expect(restored.architecture.decisions.some((item) => item.title.includes('Decision memory is source of truth'))).toBe(true);
  });
});
