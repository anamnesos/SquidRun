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
      author: 'analyst',
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
    const session = memory.recordSessionStart({
      sessionNumber: 114,
      sessionId: 'ses-114',
      mode: 'PTY',
      startedAtMs: 3000,
      stats: { test_suites: 114, tests_passed: 3337 },
      team: { '1': 'Architect', '2': 'DevOps', '5': 'Analyst' },
    });
    expect(session.ok).toBe(true);

    expect(memory.recordDecision({
      category: 'architecture',
      title: 'Event kernel promoted',
      body: 'Kernel bridge is primary transport',
      author: 'architect',
      sessionId: 'ses-114',
      nowMs: 3010,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'directive',
      title: 'Do not use subagents',
      body: 'User preference',
      author: 'user',
      sessionId: 'ses-114',
      nowMs: 3020,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'completion',
      title: 'Slice 2 Phase C committed',
      body: 'IPC + CLI complete',
      author: 'devops',
      sessionId: 'ses-114',
      nowMs: 3030,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'issue',
      title: 'ERR-009',
      body: 'Investigating startup race',
      author: 'analyst',
      sessionId: 'ses-114',
      nowMs: 3040,
    }).ok).toBe(true);

    expect(memory.recordDecision({
      category: 'roadmap',
      title: 'Slice 3 Phase B',
      body: 'IPC + hm-memory CLI',
      author: 'architect',
      sessionId: 'ses-114',
      nowMs: 3050,
    }).ok).toBe(true);

    expect(memory.recordSessionEnd('ses-114', {
      summary: 'Completed Slice 3 Phase A',
      endedAtMs: 3999,
      stats: { test_suites: 115, tests_passed: 3340 },
    }).ok).toBe(true);

    const context = memory.getLatestContext();
    expect(context.source).toBe('ledger');
    expect(context.session).toBe(114);
    expect(context.date).toBe('1970-01-01');
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

  test('edge cases: invalid category and invalid session start payload', () => {
    const invalidDecision = memory.recordDecision({
      category: 'not_a_category',
      title: 'Invalid',
      author: 'devops',
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
