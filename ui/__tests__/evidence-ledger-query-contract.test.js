const fs = require('fs');
const os = require('os');
const path = require('path');

const { EvidenceLedgerStore } = require('../modules/main/evidence-ledger-store');
const {
  normalizeEnvelope,
  validateEnvelope,
  buildEdgeRows,
} = require('../modules/main/evidence-ledger-ingest');

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
const JOURNEY_STAGES = ['ws', 'trigger', 'route', 'inject', 'ipc', 'pty', 'ack', 'verify'];

function inferFailureClass(event) {
  const type = String(event?.type || '').toLowerCase();
  if (type.includes('contract.violation')) return 'contract.violation';
  if (type.includes('ack_missing') || type.includes('ack.missing')) return 'ack_missing';
  if (type.includes('timeout')) return 'timeout';
  if (type.includes('dropped')) return 'dropped';
  if (type.includes('failed')) return 'failed';
  return null;
}

function inferReasonClassification(event) {
  const allowed = new Set([
    'ownership_conflict',
    'focus_lock',
    'compaction_gate',
    'bridge_drop',
    'ack_gap',
    'unknown',
  ]);
  const reasonCode = String(event?.payload?.reasonCode || '').trim();
  if (allowed.has(reasonCode)) {
    return { reason: reasonCode, confidence: 1, reasonInputs: ['payload.reasonCode'] };
  }

  const type = String(event?.type || '').toLowerCase();
  if (type.includes('focus')) {
    return { reason: 'focus_lock', confidence: 0.8, reasonInputs: ['type.contains(focus)'] };
  }
  if (type.includes('compaction')) {
    return { reason: 'compaction_gate', confidence: 0.8, reasonInputs: ['type.contains(compaction)'] };
  }
  if (type.includes('ack')) {
    return { reason: 'ack_gap', confidence: 0.6, reasonInputs: ['type.contains(ack)'] };
  }
  if (type.includes('bridge') || type.includes('ws')) {
    return { reason: 'bridge_drop', confidence: 0.6, reasonInputs: ['type.contains(bridge/ws)'] };
  }
  return { reason: 'unknown', confidence: 0.2, reasonInputs: ['fallback'] };
}

function normalizeJourneyStage(stage) {
  const value = String(stage || '').trim().toLowerCase();
  if (JOURNEY_STAGES.includes(value)) return value;
  return 'system';
}

function buildDescendants(rootEventId, events, edges) {
  const allEdges = Array.isArray(edges) ? [...edges] : [];

  // Parent-link fallback if edges are missing or partial.
  for (const event of events) {
    if (event.parentEventId) {
      allEdges.push({
        from_event_id: event.parentEventId,
        to_event_id: event.eventId,
      });
    }
  }

  const adjacency = new Map();
  for (const edge of allEdges) {
    const from = edge.from_event_id;
    const to = edge.to_event_id;
    if (!from || !to) continue;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  }

  const byId = new Map(events.map((event) => [event.eventId, event]));
  const visited = new Set([rootEventId]);
  const queue = [rootEventId];
  const descendants = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const next = adjacency.get(current) || new Set();
    for (const childId of next) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      queue.push(childId);
      if (byId.has(childId)) descendants.push(byId.get(childId));
    }
  }

  return descendants;
}

function queryFailurePathComposed(store, filters = {}) {
  const trace = filters.traceId ? store.queryTrace(filters.traceId) : { events: store.queryEvents(filters), edges: [] };
  const events = trace.events || [];
  const failureClasses = Array.isArray(filters.failureClass)
    ? filters.failureClass
    : (filters.failureClass ? [filters.failureClass] : null);

  const filtered = events.filter((event) => {
    if (filters.paneId && String(event.paneId) !== String(filters.paneId)) return false;
    if (filters.sinceMs !== undefined && Number(event.ts) < Number(filters.sinceMs)) return false;
    if (filters.untilMs !== undefined && Number(event.ts) > Number(filters.untilMs)) return false;
    const failureClass = inferFailureClass(event);
    if (!failureClass) return false;
    if (!failureClasses) return true;
    return failureClasses.includes(failureClass);
  });

  const firstFailure = filtered[0] || null;
  if (!firstFailure) {
    return {
      firstFailure: null,
      downstreamImpact: [],
      classification: { reason: 'unknown', confidence: 0, reasonInputs: ['no_failure'] },
    };
  }

  return {
    firstFailure: {
      eventId: firstFailure.eventId,
      type: firstFailure.type,
      stage: firstFailure.stage,
      paneId: firstFailure.paneId,
      ts: firstFailure.ts,
      failureClass: inferFailureClass(firstFailure),
      reasonCode: firstFailure?.payload?.reasonCode || null,
    },
    downstreamImpact: buildDescendants(firstFailure.eventId, events, trace.edges),
    classification: inferReasonClassification(firstFailure),
  };
}

function queryJourneyComposed(store, traceId) {
  const trace = store.queryTrace(traceId);
  const events = trace.events || [];

  const byStage = new Map();
  for (const event of events) {
    const normalized = normalizeJourneyStage(event.stage);
    if (normalized === 'system') continue;
    if (!byStage.has(normalized)) byStage.set(normalized, []);
    byStage.get(normalized).push(event);
  }

  for (const [stage, stageEvents] of byStage.entries()) {
    stageEvents.sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.rowId || 0) - Number(b.rowId || 0));
    byStage.set(stage, stageEvents);
  }

  const rows = [];
  for (const stage of JOURNEY_STAGES) {
    const event = byStage.get(stage)?.[0] || null;
    rows.push({
      stage,
      status: event ? (inferFailureClass(event) ? 'failed' : 'seen') : 'missing',
      eventId: event ? event.eventId : null,
      spanId: event ? event.spanId : null,
      ts: event ? event.ts : null,
    });
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.status !== 'missing') continue;

    const hasEarlierSeen = rows.slice(0, i).some((candidate) => candidate.status === 'seen' || candidate.status === 'failed');
    const hasLaterSeen = rows.slice(i + 1).some((candidate) => candidate.status === 'seen' || candidate.status === 'failed');
    if (hasEarlierSeen && hasLaterSeen) {
      row.status = 'inferred';
    }
  }

  let previousSeenTs = null;
  for (const row of rows) {
    if (row.ts !== null && previousSeenTs !== null) {
      row.deltaFromPrevMs = Math.max(0, Number(row.ts) - Number(previousSeenTs));
    } else {
      row.deltaFromPrevMs = null;
    }

    if (row.ts !== null) {
      previousSeenTs = row.ts;
    }
  }

  return rows;
}

describe('evidence-ledger-query-contract TC-ENV', () => {
  test('TC-ENV-001 normalizes legacy aliases into canonical envelope', () => {
    const normalized = normalizeEnvelope({
      correlationId: 'corr-legacy-1',
      causationId: 'evt-parent-1',
      type: 'inject.requested',
      stage: 'inject',
      source: 'ui/modules/terminal/injection.js',
      payload: { textLen: 42 },
      evidenceRefs: [
        { kind: 'file_line', path: 'ui/modules/terminal/injection.js', line: 321 },
        { path: 'missing-kind' },
      ],
    });

    expect(normalized.traceId).toBe('corr-legacy-1');
    expect(normalized.parentEventId).toBe('evt-parent-1');
    expect(normalized.correlationId).toBe('corr-legacy-1');
    expect(normalized.causationId).toBe('evt-parent-1');
    expect(typeof normalized.eventId).toBe('string');
    expect(typeof normalized.spanId).toBe('string');
    expect(normalized.evidenceRefs).toHaveLength(1);
    expect(normalized.evidenceRefs[0]).toMatchObject({
      kind: 'file_line',
      path: 'ui/modules/terminal/injection.js',
      line: 321,
    });
  });

  test('TC-ENV-002 validateEnvelope rejects missing required canonical fields', () => {
    const result = validateEnvelope({
      eventId: '',
      traceId: '',
      type: '',
      stage: '',
      source: '',
      ts: 'not-a-number',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((msg) => msg.includes('eventId'))).toBe(true);
    expect(result.errors.some((msg) => msg.includes('traceId'))).toBe(true);
    expect(result.errors.some((msg) => msg.includes('type'))).toBe(true);
    expect(result.errors.some((msg) => msg.includes('stage'))).toBe(true);
    expect(result.errors.some((msg) => msg.includes('source'))).toBe(true);
    expect(result.errors.some((msg) => msg.includes('ts'))).toBe(true);
  });

  test('TC-ENV-003 derive edge rows for parent + ack + retry', () => {
    const edges = buildEdgeRows({
      eventId: 'evt-3',
      traceId: 'trc-3',
      parentEventId: 'evt-2',
      meta: {
        ackOfEventId: 'evt-2',
        retryOfEventId: 'evt-1',
      },
    }, { nowMs: 1700000000000 });

    expect(edges).toHaveLength(3);
    expect(edges.map((edge) => edge.edge_type).sort()).toEqual(['ack_of', 'parent', 'retry_of']);
    expect(edges.every((edge) => edge.trace_id === 'trc-3')).toBe(true);
  });
});

maybeDescribe('evidence-ledger-query-contract TC-Q1', () => {
  let tempDir;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-ledger-contract-'));
    store = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger.db'),
      maxRows: 500,
      retentionMs: 24 * 60 * 60 * 1000,
      sessionId: 'contract-test-session',
    });
    expect(store.init().ok).toBe(true);
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('TC-Q1-001 queryTrace returns full trace chain with edges', () => {
    const result = store.appendBatch([
      {
        eventId: 'evt-ws-1',
        traceId: 'trc-q1-1',
        type: 'ws.message.received',
        stage: 'ws',
        source: 'ui/modules/websocket-server.js',
        ts: 1000,
      },
      {
        eventId: 'evt-inject-1',
        traceId: 'trc-q1-1',
        parentEventId: 'evt-ws-1',
        type: 'inject.requested',
        stage: 'inject',
        source: 'ui/modules/terminal/injection.js',
        ts: 1010,
      },
      {
        eventId: 'evt-ack-1',
        traceId: 'trc-q1-1',
        parentEventId: 'evt-inject-1',
        type: 'daemon.write.ack',
        stage: 'ack',
        source: 'ui/terminal-daemon.js',
        ts: 1020,
        meta: {
          ackOfEventId: 'evt-inject-1',
        },
      },
    ]);

    expect(result.ok).toBe(true);
    expect(result.inserted).toBe(3);

    const trace = store.queryTrace('trc-q1-1');
    expect(trace.traceId).toBe('trc-q1-1');
    expect(trace.events).toHaveLength(3);
    expect(trace.events.map((event) => event.eventId)).toEqual([
      'evt-ws-1',
      'evt-inject-1',
      'evt-ack-1',
    ]);

    expect(trace.edges).toHaveLength(3);
    expect(trace.edges.map((edge) => edge.edge_type).sort()).toEqual(['ack_of', 'parent', 'parent']);
  });

  test('TC-Q1-002 supports legacy correlation alias lookups via canonical traceId', () => {
    const append = store.appendEvent({
      eventId: 'evt-legacy-1',
      correlationId: 'corr-q1-legacy-1',
      type: 'inject.submit.sent',
      stage: 'inject',
      source: 'ui/modules/terminal/injection.js',
      ts: 2000,
    });

    expect(append.ok).toBe(true);
    expect(append.traceId).toBe('corr-q1-legacy-1');

    const trace = store.queryTrace('corr-q1-legacy-1');
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0].traceId).toBe('corr-q1-legacy-1');
    expect(trace.events[0].correlationId).toBe('corr-q1-legacy-1');
  });

  test('TC-Q1-003 queryTrace supports limit and includeEdges toggle', () => {
    const events = Array.from({ length: 5 }, (_, index) => ({
      eventId: `evt-limit-${index + 1}`,
      traceId: 'trc-q1-limit',
      parentEventId: index === 0 ? null : `evt-limit-${index}`,
      type: 'inject.requested',
      stage: 'inject',
      source: 'ui/modules/terminal/injection.js',
      ts: 3000 + index,
    }));

    const batch = store.appendBatch(events);
    expect(batch.ok).toBe(true);
    expect(batch.inserted).toBe(5);

    const limited = store.queryTrace('trc-q1-limit', { limit: 2, includeEdges: false });
    expect(limited.events).toHaveLength(2);
    expect(limited.edges).toEqual([]);
    expect(limited.events.map((event) => event.eventId)).toEqual(['evt-limit-1', 'evt-limit-2']);
  });
});

maybeDescribe('evidence-ledger-query-contract TC-Q2', () => {
  let tempDir;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-ledger-contract-q2-'));
    store = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger.db'),
      maxRows: 500,
      retentionMs: 24 * 60 * 60 * 1000,
      sessionId: 'contract-test-session-q2',
    });
    expect(store.init().ok).toBe(true);
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('TC-Q2-001 identifies first causal failure and TC-Q2-002 downstream impact', () => {
    const batch = store.appendBatch([
      {
        eventId: 'evt-q2-1',
        traceId: 'trc-q2-main',
        type: 'ws.message.received',
        stage: 'ws',
        source: 'ui/modules/websocket-server.js',
        paneId: '1',
        ts: 1000,
      },
      {
        eventId: 'evt-q2-2',
        traceId: 'trc-q2-main',
        parentEventId: 'evt-q2-1',
        type: 'inject.submit.failed',
        stage: 'inject',
        source: 'ui/modules/terminal/injection.js',
        paneId: '1',
        ts: 1010,
        payload: { reasonCode: 'focus_lock' },
      },
      {
        eventId: 'evt-q2-3',
        traceId: 'trc-q2-main',
        parentEventId: 'evt-q2-2',
        type: 'daemon.write.timeout',
        stage: 'ack',
        source: 'ui/terminal-daemon.js',
        paneId: '1',
        ts: 1020,
      },
      {
        eventId: 'evt-q2-4',
        traceId: 'trc-q2-main',
        parentEventId: 'evt-q2-2',
        type: 'verify.failed',
        stage: 'verify',
        source: 'ui/modules/terminal/injection.js',
        paneId: '1',
        ts: 1030,
      },
    ]);
    expect(batch.ok).toBe(true);

    const result = queryFailurePathComposed(store, { traceId: 'trc-q2-main' });
    expect(result.firstFailure).toMatchObject({
      eventId: 'evt-q2-2',
      failureClass: 'failed',
      stage: 'inject',
    });
    expect(result.downstreamImpact.map((event) => event.eventId).sort()).toEqual(['evt-q2-3', 'evt-q2-4']);
  });

  test('TC-Q2-003 applies failure-class, pane, and time-window filters', () => {
    const batch = store.appendBatch([
      {
        eventId: 'evt-q2f-1',
        traceId: 'trc-q2-filter',
        type: 'inject.submit.failed',
        stage: 'inject',
        source: 'ui/modules/terminal/injection.js',
        paneId: '1',
        ts: 2000,
      },
      {
        eventId: 'evt-q2f-2',
        traceId: 'trc-q2-filter',
        type: 'daemon.write.timeout',
        stage: 'ack',
        source: 'ui/terminal-daemon.js',
        paneId: '2',
        ts: 2050,
      },
    ]);
    expect(batch.ok).toBe(true);

    const timeoutPane2 = queryFailurePathComposed(store, {
      traceId: 'trc-q2-filter',
      paneId: '2',
      failureClass: 'timeout',
      sinceMs: 2040,
      untilMs: 2100,
    });

    expect(timeoutPane2.firstFailure).toMatchObject({
      eventId: 'evt-q2f-2',
      failureClass: 'timeout',
      paneId: '2',
    });
  });

  test('TC-Q2-004 emits deterministic reason classification and confidence', () => {
    const append = store.appendEvent({
      eventId: 'evt-q2r-1',
      traceId: 'trc-q2-reason',
      type: 'inject.submit.failed',
      stage: 'inject',
      source: 'ui/modules/terminal/injection.js',
      paneId: '1',
      ts: 3000,
      payload: { reasonCode: 'compaction_gate' },
    });
    expect(append.ok).toBe(true);

    const result = queryFailurePathComposed(store, { traceId: 'trc-q2-reason' });
    expect(result.classification.reason).toBe('compaction_gate');
    expect(result.classification.confidence).toBe(1);
    expect(Array.isArray(result.classification.reasonInputs)).toBe(true);
    expect(result.classification.reasonInputs.length).toBeGreaterThan(0);
    expect(result.classification.confidence).toBeGreaterThanOrEqual(0);
    expect(result.classification.confidence).toBeLessThanOrEqual(1);
  });
});

maybeDescribe('evidence-ledger-query-contract TC-Q3', () => {
  let tempDir;
  let store;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-ledger-contract-q3-'));
    store = new EvidenceLedgerStore({
      dbPath: path.join(tempDir, 'evidence-ledger.db'),
      maxRows: 500,
      retentionMs: 24 * 60 * 60 * 1000,
      sessionId: 'contract-test-session-q3',
    });
    expect(store.init().ok).toBe(true);
  });

  afterEach(() => {
    if (store) store.close();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('TC-Q3-001 returns strict baseline stage rows with allowed statuses', () => {
    const append = store.appendBatch([
      {
        eventId: 'evt-q3-1',
        traceId: 'trc-q3-main',
        type: 'ws.message.received',
        stage: 'ws',
        source: 'ui/modules/websocket-server.js',
        ts: 4000,
      },
      {
        eventId: 'evt-q3-2',
        traceId: 'trc-q3-main',
        parentEventId: 'evt-q3-1',
        type: 'inject.requested',
        stage: 'inject',
        source: 'ui/modules/terminal/injection.js',
        ts: 4010,
      },
      {
        eventId: 'evt-q3-3',
        traceId: 'trc-q3-main',
        parentEventId: 'evt-q3-2',
        type: 'daemon.write.ack',
        stage: 'ack',
        source: 'ui/terminal-daemon.js',
        ts: 4020,
      },
      {
        eventId: 'evt-q3-unknown',
        traceId: 'trc-q3-main',
        parentEventId: 'evt-q3-3',
        type: 'custom.stage.event',
        stage: 'my_custom_stage',
        source: 'custom/source.js',
        ts: 4030,
      },
    ]);
    expect(append.ok).toBe(true);

    const journey = queryJourneyComposed(store, 'trc-q3-main');
    expect(journey.map((row) => row.stage)).toEqual(JOURNEY_STAGES);
    expect(journey.every((row) => ['seen', 'missing', 'failed', 'inferred'].includes(row.status))).toBe(true);
  });

  test('TC-Q3-002 marks trigger stage seen on fallback-shaped traces', () => {
    const append = store.appendBatch([
      {
        eventId: 'evt-q3t-1',
        traceId: 'trc-q3-trigger',
        type: 'trigger.file.detected',
        stage: 'trigger',
        source: 'ui/modules/watcher.js',
        ts: 5000,
      },
      {
        eventId: 'evt-q3t-2',
        traceId: 'trc-q3-trigger',
        parentEventId: 'evt-q3t-1',
        type: 'inject.requested',
        stage: 'inject',
        source: 'ui/modules/terminal/injection.js',
        ts: 5010,
      },
    ]);
    expect(append.ok).toBe(true);

    const journey = queryJourneyComposed(store, 'trc-q3-trigger');
    const triggerRow = journey.find((row) => row.stage === 'trigger');
    expect(triggerRow.status).toBe('seen');
  });

  test('TC-Q3-003 provides event/span backing refs and non-negative deltas for seen stages', () => {
    const append = store.appendBatch([
      {
        eventId: 'evt-q3d-1',
        traceId: 'trc-q3-delta',
        spanId: 'spn-q3-1',
        type: 'ws.message.received',
        stage: 'ws',
        source: 'ui/modules/websocket-server.js',
        ts: 6000,
      },
      {
        eventId: 'evt-q3d-2',
        traceId: 'trc-q3-delta',
        parentEventId: 'evt-q3d-1',
        spanId: 'spn-q3-2',
        type: 'inject.requested',
        stage: 'inject',
        source: 'ui/modules/terminal/injection.js',
        ts: 6010,
      },
      {
        eventId: 'evt-q3d-3',
        traceId: 'trc-q3-delta',
        parentEventId: 'evt-q3d-2',
        spanId: 'spn-q3-3',
        type: 'daemon.write.ack',
        stage: 'ack',
        source: 'ui/terminal-daemon.js',
        ts: 6030,
      },
    ]);
    expect(append.ok).toBe(true);

    const journey = queryJourneyComposed(store, 'trc-q3-delta');
    const seenRows = journey.filter((row) => row.status === 'seen' || row.status === 'failed');
    expect(seenRows.length).toBeGreaterThan(0);
    expect(seenRows.every((row) => typeof row.eventId === 'string' && row.eventId.length > 0)).toBe(true);
    expect(seenRows.every((row) => typeof row.spanId === 'string' && row.spanId.length > 0)).toBe(true);

    const rowsWithDelta = seenRows.filter((row) => row.deltaFromPrevMs !== null);
    expect(rowsWithDelta.every((row) => row.deltaFromPrevMs >= 0)).toBe(true);
  });
});
