const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');

function hasSqliteDriver() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return true;
  } catch {
    // Continue to next fallback.
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

maybeDescribe('evidence-ledger-store', () => {
  let tempDir;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-ledger-'));
    store = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger.db'),
      maxRows: 100,
      retentionMs: 24 * 60 * 60 * 1000,
      sessionId: 'test-session',
    });
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('initializes sqlite store with migrations', () => {
    const result = store.init();
    expect(result.ok).toBe(true);
    expect(store.isAvailable()).toBe(true);
  });

  test('appends event and queries trace chain', () => {
    expect(store.init().ok).toBe(true);

    const append = store.appendEvent({
      eventId: 'evt-1',
      traceId: 'trc-1',
      type: 'inject.submit.sent',
      stage: 'inject',
      source: 'injection.js',
      payload: { textLen: 42 },
    });
    expect(append.ok).toBe(true);
    expect(append.status).toBe('inserted');

    const trace = store.queryTrace('trc-1');
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0].eventId).toBe('evt-1');
    expect(trace.events[0].payload.textLen).toBe(42);
  });

  test('appendBatch reports duplicates', () => {
    expect(store.init().ok).toBe(true);

    const batch = store.appendBatch([
      {
        eventId: 'evt-a',
        traceId: 'trc-a',
        type: 'ws.message.received',
        stage: 'ws',
        source: 'websocket-server.js',
      },
      {
        eventId: 'evt-a',
        traceId: 'trc-a',
        type: 'ws.message.received',
        stage: 'ws',
        source: 'websocket-server.js',
      },
      {
        eventId: 'evt-b',
        traceId: 'trc-a',
        parentEventId: 'evt-a',
        type: 'inject.requested',
        stage: 'inject',
        source: 'injection.js',
      },
    ]);

    expect(batch.ok).toBe(true);
    expect(batch.inserted).toBe(2);
    expect(batch.duplicates).toBe(1);
    expect(batch.invalid).toBe(0);
  });

  test('prune applies ttl and hard-cap', () => {
    store.close();
    store = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'prune.db'),
      maxRows: 3,
      retentionMs: 1000,
    });
    expect(store.init().ok).toBe(true);

    const events = [
      { eventId: 'evt-1', traceId: 'trc-p', ts: 100, type: 'a', stage: 'system', source: 't' },
      { eventId: 'evt-2', traceId: 'trc-p', ts: 200, type: 'a', stage: 'system', source: 't' },
      { eventId: 'evt-3', traceId: 'trc-p', ts: 300, type: 'a', stage: 'system', source: 't' },
      { eventId: 'evt-4', traceId: 'trc-p', ts: 9500, type: 'a', stage: 'system', source: 't' },
      { eventId: 'evt-5', traceId: 'trc-p', ts: 9600, type: 'a', stage: 'system', source: 't' },
      { eventId: 'evt-6', traceId: 'trc-p', ts: 9700, type: 'a', stage: 'system', source: 't' },
      { eventId: 'evt-7', traceId: 'trc-p', ts: 9800, type: 'a', stage: 'system', source: 't' },
    ];
    expect(store.appendBatch(events).ok).toBe(true);

    const pruned = store.prune({ nowMs: 10000, retentionMs: 1000, maxRows: 3 });
    expect(pruned.ok).toBe(true);
    expect(pruned.removedByAge + pruned.removedByCap).toBeGreaterThanOrEqual(4);

    const all = store.queryEvents({ traceId: 'trc-p', limit: 20 });
    expect(all.length).toBeLessThanOrEqual(3);
    expect(all.every((evt) => evt.ts >= 9000)).toBe(true);
  });
});

describe('evidence-ledger-store degraded mode', () => {
  test('returns unavailable when disabled', () => {
    const disabled = new EvidenceLedgerStore({ enabled: false });
    const result = disabled.init();
    expect(result.ok).toBe(false);
    expect(disabled.isAvailable()).toBe(false);
  });
});
