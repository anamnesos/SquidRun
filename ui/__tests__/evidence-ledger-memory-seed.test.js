const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const { EvidenceLedgerMemory } = require('../modules/main/evidence-ledger-memory');
const { deriveSeedRecords, seedDecisionMemory } = require('../modules/main/evidence-ledger-memory-seed');

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

maybeDescribe('evidence-ledger-memory seed utility', () => {
  let tempDir;
  let store;
  let memory;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-ledger-seed-'));
    store = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger-seed.db'),
      maxRows: 5000,
      retentionMs: 24 * 60 * 60 * 1000,
      sessionId: 'seed-test-session',
    });
    expect(store.init().ok).toBe(true);
    memory = new EvidenceLedgerMemory(store);
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('deriveSeedRecords maps handoff structure to deterministic decision records', () => {
    const handoff = {
      session: 114,
      date: '2026-02-11',
      mode: 'PTY',
      completed: ['Phase A complete'],
      important_notes: ['Always use Opus teammates'],
      roadmap: ['Slice 3 Phase B'],
      not_yet_done: ['Slice 3 Phase C'],
      known_issues: {
        'ERR-005': 'Memory growth under load',
      },
      architecture: {
        decisions: [
          { title: 'Event kernel first', body: 'Use canonical envelope everywhere' },
        ],
      },
    };

    const recordsA = deriveSeedRecords(handoff);
    const recordsB = deriveSeedRecords(handoff);

    expect(recordsA.session.sessionId).toBe('ses_seed_114');
    expect(recordsA.decisions.length).toBeGreaterThanOrEqual(6);
    expect(recordsA.decisions.map((item) => item.decisionId)).toEqual(
      recordsB.decisions.map((item) => item.decisionId)
    );
  });

  test('seedDecisionMemory is idempotent and preserves context assembly shape', () => {
    const handoff = {
      session: 115,
      date: '2026-02-12',
      mode: 'PTY',
      status: 'ACTIVE',
      completed: ['Slice 2 Phase C committed'],
      important_notes: ['Do not use subagents'],
      roadmap: ['Slice 3 Phase B'],
      known_issues: {
        'ERR-009': 'Investigating startup race',
      },
      architecture: {
        decisions: [
          'Bridge tab is comms dashboard',
        ],
      },
      stats: {
        test_suites: 114,
        tests_passed: 3336,
      },
      team: {
        '1': 'Architect',
        '2': 'DevOps',
        '5': 'Analyst',
      },
    };

    const first = seedDecisionMemory(memory, handoff, { markSessionEnded: true });
    expect(first.ok).toBe(true);
    expect(first.inserted).toBeGreaterThan(0);
    expect(first.failed).toBe(0);

    const second = seedDecisionMemory(memory, handoff, { markSessionEnded: true });
    expect(second.ok).toBe(true);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(second.failed).toBe(0);

    const context = memory.getLatestContext();
    expect(context.source).toBe('ledger');
    expect(context.session).toBe(115);
    expect(context.mode).toBe('PTY');
    expect(Array.isArray(context.completed)).toBe(true);
    expect(Array.isArray(context.important_notes)).toBe(true);
    expect(context.known_issues['ERR-009']).toBe('Investigating startup race');
    expect(context.completed.some((item) => item.includes('Slice 2 Phase C committed'))).toBe(true);
    expect(context.important_notes.some((item) => item.includes('Do not use subagents'))).toBe(true);
  });
});
