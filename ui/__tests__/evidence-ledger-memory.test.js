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

maybeDescribe('evidence-ledger-memory', () => {
  let tempDir;
  let store;
  let memory;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-ledger-memory-'));
    store = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger.db'),
      maxRows: 5000,
      retentionMs: 24 * 60 * 60 * 1000,
      sessionId: 'memory-test-session',
    });
    expect(store.init().ok).toBe(true);
    memory = new EvidenceLedgerMemory(store);
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('decision CRUD + category filtering + search', () => {
    const recorded = memory.recordDecision({
      category: 'directive',
      title: 'Always use Opus teammates',
      body: 'User directive from Session 90',
      author: 'user',
      tags: ['ops', 'models'],
      sessionId: 'ses-90',
      nowMs: 1000,
    });
    expect(recorded.ok).toBe(true);

    const loaded = memory.getDecision(recorded.decisionId);
    expect(loaded.title).toBe('Always use Opus teammates');
    expect(loaded.category).toBe('directive');
    expect(loaded.tags).toEqual(['ops', 'models']);

    const updated = memory.updateDecision(recorded.decisionId, {
      body: 'Persistent user directive',
      nowMs: 1100,
    });
    expect(updated.ok).toBe(true);

    const directives = memory.getActiveDirectives();
    expect(Array.isArray(directives)).toBe(true);
    expect(directives.some((item) => item.decisionId === recorded.decisionId)).toBe(true);

    const search = memory.searchDecisions('opus');
    expect(search.some((item) => item.decisionId === recorded.decisionId)).toBe(true);
  });

  test('supersession chain updates old decision to superseded', () => {
    const original = memory.recordDecision({
      category: 'issue',
      title: 'ERR-008: Submit race',
      body: 'Detected in runtime validation',
      author: 'oracle',
      nowMs: 2000,
    });
    expect(original.ok).toBe(true);

    const superseded = memory.supersedeDecision(original.decisionId, {
      title: 'ERR-008 CLOSED',
      body: 'Fixed and verified',
      category: 'issue',
      author: 'architect',
      nowMs: 2100,
    });
    expect(superseded.ok).toBe(true);
    expect(typeof superseded.newDecisionId).toBe('string');

    const oldDecision = memory.getDecision(original.decisionId);
    const newDecision = memory.getDecision(superseded.newDecisionId);
    expect(oldDecision.status).toBe('superseded');
    expect(oldDecision.supersededBy).toBe(newDecision.decisionId);
    expect(newDecision.status).toBe('active');
  });

  test('session lifecycle + context assembly matches handoff-like shape', () => {
    // Use a real date (Feb 14 2026 noon local) so local-date conversion is testable
    const baseMs = new Date(2026, 1, 14, 12, 0, 0).getTime(); // month is 0-indexed
    const session = memory.recordSessionStart({
      sessionNumber: 114,
      sessionId: 'ses-114',
      mode: 'PTY',
      startedAtMs: baseMs,
      stats: { test_suites: 114, tests_passed: 3337 },
      team: { '1': 'Architect', '2': 'Builder', '5': 'Oracle' },
    });
    expect(session.ok).toBe(true);

    expect(memory.recordDecision({
      category: 'architecture',
      title: 'Event kernel promoted',
      body: 'Kernel bridge is primary transport',
      author: 'architect',
      sessionId: 'ses-114',
      nowMs: baseMs + 10,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'directive',
      title: 'Do not use subagents',
      body: 'User preference',
      author: 'user',
      sessionId: 'ses-114',
      nowMs: baseMs + 20,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'completion',
      title: 'Slice 2 Phase C committed',
      body: 'IPC + CLI complete',
      author: 'builder',
      sessionId: 'ses-114',
      nowMs: baseMs + 30,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'issue',
      title: 'ERR-009',
      body: 'Investigating startup race',
      author: 'oracle',
      sessionId: 'ses-114',
      nowMs: baseMs + 40,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'roadmap',
      title: 'Slice 3 Phase B',
      body: 'IPC + hm-memory CLI',
      author: 'architect',
      sessionId: 'ses-114',
      nowMs: baseMs + 50,
    }).ok).toBe(true);

    expect(memory.recordSessionEnd('ses-114', {
      summary: 'Completed Slice 3 Phase A',
      endedAtMs: baseMs + 999,
      stats: { test_suites: 115, tests_passed: 3340 },
    }).ok).toBe(true);

    const context = memory.getLatestContext();
    expect(context.source).toBe('ledger');
    expect(context.session).toBe(114);
    expect(context.date).toBe('2026-02-14');
    expect(context.mode).toBe('PTY');
    expect(Array.isArray(context.completed)).toBe(true);
    expect(typeof context.architecture).toBe('object');
    expect(Array.isArray(context.not_yet_done)).toBe(true);
    expect(Array.isArray(context.roadmap)).toBe(true);
    expect(typeof context.known_issues).toBe('object');
    expect(typeof context.stats).toBe('object');
    expect(Array.isArray(context.important_notes)).toBe(true);
    expect(typeof context.team).toBe('object');
    expect(context.important_notes.some((item) => item.includes('subagents'))).toBe(true);
  });

  test('snapshot roundtrip and latest snapshot retrieval', () => {
    const start = memory.recordSessionStart({
      sessionNumber: 115,
      sessionId: 'ses-115',
      mode: 'PTY',
      startedAtMs: 4000,
    });
    expect(start.ok).toBe(true);

    const snap = memory.snapshotContext('ses-115', {
      trigger: 'manual',
      content: {
        session: 115,
        source: 'ledger',
        completed: ['demo'],
      },
      nowMs: 4010,
    });
    expect(snap.ok).toBe(true);

    const latest = memory.getLatestSnapshot({ sessionId: 'ses-115' });
    expect(latest.snapshotId).toBe(snap.snapshotId);
    expect(latest.trigger).toBe('manual');
    expect(latest.content.session).toBe(115);
  });

  test('session_start snapshot assembles startup context for context windows', () => {
    expect(memory.recordSessionStart({
      sessionNumber: 116,
      sessionId: 'ses-116',
      mode: 'PTY',
      startedAtMs: 5000,
      stats: { test_suites: 116, tests_passed: 3349 },
      team: { '1': 'Architect', '2': 'Builder', '5': 'Oracle' },
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'directive',
      title: 'Keep startup context concise',
      body: 'Use decision memory on startup',
      author: 'user',
      sessionId: 'ses-116',
      nowMs: 5010,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'completion',
      title: 'Phase B shipped',
      body: 'IPC + CLI landed',
      author: 'builder',
      sessionId: 'ses-116',
      nowMs: 5020,
    }).ok).toBe(true);

    expect(memory.recordSessionEnd('ses-116', {
      endedAtMs: 5100,
      summary: 'Session complete',
      stats: { test_suites: 116, tests_passed: 3350 },
    }).ok).toBe(true);

    expect(memory.snapshotContext('ses-116', {
      trigger: 'session_end',
      nowMs: 5110,
    }).ok).toBe(true);

    expect(memory.recordSessionStart({
      sessionNumber: 117,
      sessionId: 'ses-117',
      mode: 'PTY',
      startedAtMs: 5200,
      stats: { test_suites: 117, tests_passed: 3351 },
      team: { '1': 'Architect', '2': 'Builder', '5': 'Oracle' },
    }).ok).toBe(true);

    const startupSnap = memory.snapshotContext('ses-117', {
      trigger: 'session_start',
      nowMs: 5210,
    });
    expect(startupSnap.ok).toBe(true);

    const latest = memory.getLatestSnapshot({ sessionId: 'ses-117' });
    expect(latest.snapshotId).toBe(startupSnap.snapshotId);
    expect(latest.trigger).toBe('session_start');
    expect(latest.content.source).toBe('ledger.session_start_snapshot');
    expect(latest.content.session).toBe(117);
    expect(latest.content.mode).toBe('PTY');
    expect(latest.content.important_notes.some((item) => item.includes('Keep startup context concise'))).toBe(true);
    expect(latest.content.completed.some((item) => item.includes('Phase B shipped'))).toBe(true);
  });

  test('getLatestContext scopes decisions to recent sessions and avoids stale seed completions', () => {
    expect(memory.recordSessionStart({
      sessionNumber: 115,
      sessionId: 'ses-115',
      mode: 'PTY',
      startedAtMs: 1000,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'completion',
      title: 'Seed-era completion',
      body: 'Old seeded record',
      author: 'system',
      sessionId: 'ses-115',
      nowMs: 2000,
    }).ok).toBe(true);

    expect(memory.recordSessionStart({
      sessionNumber: 122,
      sessionId: 'ses-122',
      mode: 'PTY',
      startedAtMs: 0,
    }).ok).toBe(true);

    // Simulate historical bad timestamp coercion from older runtimes.
    expect(memory.recordDecision({
      category: 'completion',
      title: 'Recent completion with bad timestamp',
      body: 'Should still be represented by latest snapshot context',
      author: 'builder',
      sessionId: 'ses-122',
      nowMs: 0,
    }).ok).toBe(true);

    expect(memory.snapshotContext('ses-122', {
      trigger: 'session_end',
      content: {
        session: 122,
        source: 'ledger',
        completed: ['S122: runtime bridge updated'],
        not_yet_done: ['S123: follow-up'],
        roadmap: ['S123: follow-up'],
      },
      nowMs: 0,
    }).ok).toBe(true);

    const context = memory.getLatestContext();
    expect(context.source).toBe('ledger');
    expect(context.session).toBe(122);
    expect(context.completed.some((item) => String(item).includes('Recent completion with bad timestamp'))).toBe(true);
    expect(context.completed.some((item) => String(item).includes('Seed-era completion'))).toBe(false);
  });

  test('edge cases: invalid category and invalid session start payload', () => {
    const invalidDecision = memory.recordDecision({
      category: 'not_a_category',
      title: 'Invalid',
      author: 'builder',
    });
    expect(invalidDecision.ok).toBe(false);
    expect(invalidDecision.reason).toBe('invalid_category');

    const invalidSession = memory.recordSessionStart({
      sessionNumber: 'abc',
      mode: 'PTY',
    });
    expect(invalidSession.ok).toBe(false);
    expect(invalidSession.reason).toBe('session_number_required');
  });

  test('null timestamp inputs fall back to current time instead of zero', () => {
    const before = Date.now();
    const session = memory.recordSessionStart({
      sessionNumber: 201,
      sessionId: 'ses-201',
      mode: 'PTY',
      startedAtMs: null,
    });
    expect(session.ok).toBe(true);

    const loadedSession = memory.getSession('ses-201');
    expect(loadedSession.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(loadedSession.startedAtMs).not.toBe(0);

    const decision = memory.recordDecision({
      category: 'directive',
      title: 'Timestamp fallback check',
      author: 'system',
      sessionId: 'ses-201',
      nowMs: null,
    });
    expect(decision.ok).toBe(true);

    const loadedDecision = memory.getDecision(decision.decisionId);
    expect(loadedDecision.createdAtMs).toBeGreaterThanOrEqual(before);
    expect(loadedDecision.createdAtMs).not.toBe(0);
  });
});

describe('evidence-ledger-memory context restore transactions', () => {
  function createStubbedMemory() {
    const db = { exec: jest.fn() };
    const store = {
      isAvailable: () => true,
      db,
    };
    const memory = new EvidenceLedgerMemory(store);
    return { memory, db };
  }

  test('getLatestContext runs inside a single read transaction', () => {
    const { memory, db } = createStubbedMemory();
    memory.getLatestSnapshot = jest.fn(() => null);
    memory.listSessions = jest.fn(() => [{
      sessionNumber: 122,
      startedAtMs: 1700000000000,
      mode: 'PTY',
      endedAtMs: null,
      stats: { test_suites: 1, tests_passed: 1 },
      team: { '1': 'Architect' },
    }]);
    memory.getActiveDirectives = jest.fn(() => [{ title: 'Directive', body: 'Body', decisionId: 'dec-1' }]);
    memory.getKnownIssues = jest.fn(() => [{ title: 'ERR-TEST', body: 'Investigating', status: 'open', decisionId: 'iss-1' }]);
    memory.getRoadmap = jest.fn(() => [{ title: 'Roadmap item', body: 'Pending' }]);
    memory.getRecentCompletions = jest.fn(() => [{ title: 'Completed item', body: 'Done' }]);
    memory.getArchitectureDecisions = jest.fn(() => [{ decisionId: 'arc-1', title: 'Architecture', body: 'Decision', updatedAtMs: 1 }]);

    const context = memory.getLatestContext();

    expect(context.ok).not.toBe(false);
    expect(context.source).toBe('ledger');
    expect(db.exec.mock.calls.map((call) => call[0])).toEqual(['BEGIN;', 'COMMIT;']);
  });

  test('getLatestContext rolls back transaction when restore assembly throws', () => {
    const { memory, db } = createStubbedMemory();
    memory.getLatestSnapshot = jest.fn(() => {
      throw new Error('restore exploded');
    });

    const result = memory.getLatestContext();

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('db_error');
    expect(result.error).toContain('restore exploded');
    expect(db.exec.mock.calls.map((call) => call[0])).toEqual(['BEGIN;', 'ROLLBACK;']);
  });
});

describe('evidence-ledger-memory degraded mode', () => {
  test('all operations degrade when store unavailable', () => {
    const disabledStore = new EvidenceLedgerStore({ enabled: false });
    const init = disabledStore.init();
    expect(init.ok).toBe(false);

    const memory = new EvidenceLedgerMemory(disabledStore);
    expect(memory.recordDecision({ category: 'directive', title: 'x', author: 'system' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(memory.recordSessionStart({ sessionNumber: 1 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(memory.getLatestContext()).toEqual({ ok: false, reason: 'unavailable' });
    expect(memory.searchDecisions('opus')).toEqual({ ok: false, reason: 'unavailable' });
  });
});
