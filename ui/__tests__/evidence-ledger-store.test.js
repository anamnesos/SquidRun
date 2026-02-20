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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-ledger-'));
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

  test('upsertCommsJournal is idempotent and keeps progressed status', () => {
    expect(store.init().ok).toBe(true);

    const first = store.upsertCommsJournal({
      messageId: 'hm-1',
      sessionId: 's_1',
      senderRole: 'builder',
      targetRole: 'architect',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: 1000,
      rawBody: '(BUILDER #1): hello',
      status: 'recorded',
      attempt: 1,
      metadata: { source: 'hm-send' },
    });
    expect(first.ok).toBe(true);
    expect(first.status).toBe('inserted');

    const second = store.upsertCommsJournal({
      messageId: 'hm-1',
      channel: 'ws',
      direction: 'outbound',
      brokeredAtMs: 1050,
      status: 'brokered',
      attempt: 2,
      metadata: { source: 'websocket-broker' },
    });
    expect(second.ok).toBe(true);
    expect(second.status).toBe('updated');

    const downgraded = store.upsertCommsJournal({
      messageId: 'hm-1',
      channel: 'ws',
      direction: 'outbound',
      status: 'recorded',
      attempt: 1,
    });
    expect(downgraded.ok).toBe(true);

    const row = store.db.prepare(`
      SELECT * FROM comms_journal WHERE message_id = ?
    `).get('hm-1');
    expect(row).toBeTruthy();
    expect(row.status).toBe('brokered');
    expect(row.attempt).toBe(2);
    expect(row.body_hash).toBeTruthy();
    expect(row.body_bytes).toBeGreaterThan(0);
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      source: 'websocket-broker',
    });
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

  test('prune removes archived decisions and stale snapshots while preserving sessions', () => {
    expect(store.init().ok).toBe(true);

    store.db.prepare(`
      INSERT INTO ledger_sessions (
        session_id, session_number, mode, started_at_ms, ended_at_ms,
        summary, stats_json, team_json, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'ses-a',
      501,
      'PTY',
      100,
      200,
      'Session A',
      '{}',
      '{}',
      '{}'
    );

    store.db.prepare(`
      INSERT INTO ledger_sessions (
        session_id, session_number, mode, started_at_ms, ended_at_ms,
        summary, stats_json, team_json, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'ses-b',
      502,
      'PTY',
      300,
      null,
      null,
      '{}',
      '{}',
      '{}'
    );

    store.db.prepare(`
      INSERT INTO ledger_decisions (
        decision_id, session_id, category, title, body, author, status, superseded_by,
        incident_id, tags_json, meta_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'dec-archived-old',
      'ses-a',
      'issue',
      'Old archived issue',
      'prune me',
      'oracle',
      'archived',
      null,
      null,
      '[]',
      '{}',
      100,
      100
    );

    store.db.prepare(`
      INSERT INTO ledger_decisions (
        decision_id, session_id, category, title, body, author, status, superseded_by,
        incident_id, tags_json, meta_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'dec-active-old',
      'ses-a',
      'directive',
      'Persistent directive',
      'do not prune',
      'user',
      'active',
      null,
      null,
      '[]',
      '{}',
      100,
      100
    );

    store.db.prepare(`
      INSERT INTO ledger_decisions (
        decision_id, session_id, category, title, body, author, status, superseded_by,
        incident_id, tags_json, meta_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'dec-archived-recent',
      'ses-b',
      'completion',
      'Recent archived completion',
      'still within retention',
      'builder',
      'archived',
      null,
      null,
      '[]',
      '{}',
      9500,
      9500
    );

    store.db.prepare(`
      INSERT INTO ledger_context_snapshots (
        snapshot_id, session_id, content_json, created_at_ms, trigger
      ) VALUES (?, ?, ?, ?, ?)
    `).run('snap-a-old-1', 'ses-a', '{"v":1}', 100, 'manual');

    store.db.prepare(`
      INSERT INTO ledger_context_snapshots (
        snapshot_id, session_id, content_json, created_at_ms, trigger
      ) VALUES (?, ?, ?, ?, ?)
    `).run('snap-a-old-2', 'ses-a', '{"v":2}', 200, 'manual');

    store.db.prepare(`
      INSERT INTO ledger_context_snapshots (
        snapshot_id, session_id, content_json, created_at_ms, trigger
      ) VALUES (?, ?, ?, ?, ?)
    `).run('snap-a-latest', 'ses-a', '{"v":3}', 9800, 'session_end');

    store.db.prepare(`
      INSERT INTO ledger_context_snapshots (
        snapshot_id, session_id, content_json, created_at_ms, trigger
      ) VALUES (?, ?, ?, ?, ?)
    `).run('snap-b-only-old', 'ses-b', '{"v":4}', 300, 'manual');

    const pruned = store.prune({ nowMs: 10000, retentionMs: 1000, maxRows: 1000 });
    expect(pruned.ok).toBe(true);
    expect(pruned.removedArchivedDecisions).toBe(1);
    expect(pruned.removedSnapshots).toBe(2);

    const decisions = store.db.prepare(`
      SELECT decision_id, status
      FROM ledger_decisions
      ORDER BY decision_id ASC
    `).all();
    expect(decisions).toEqual([
      { decision_id: 'dec-active-old', status: 'active' },
      { decision_id: 'dec-archived-recent', status: 'archived' },
    ]);

    const snapshots = store.db.prepare(`
      SELECT snapshot_id
      FROM ledger_context_snapshots
      ORDER BY snapshot_id ASC
    `).all();
    expect(snapshots.map((row) => row.snapshot_id)).toEqual(['snap-a-latest', 'snap-b-only-old']);

    const sessions = store.db.prepare(`
      SELECT session_id
      FROM ledger_sessions
      ORDER BY session_id ASC
    `).all();
    expect(sessions.map((row) => row.session_id)).toEqual(['ses-a', 'ses-b']);
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
