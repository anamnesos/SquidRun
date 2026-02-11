const {
  normalizeEnvelope,
  validateEnvelope,
  buildEdgeRows,
  prepareEventForStorage,
} = require('../modules/main/evidence-ledger-ingest');

describe('evidence-ledger-ingest', () => {
  test('normalizes legacy correlation aliases into canonical fields', () => {
    const normalized = normalizeEnvelope({
      correlationId: 'corr-1',
      causationId: 'evt-parent',
      type: 'inject.submit.sent',
      stage: 'inject',
      source: 'injection.js',
      payload: { ok: true },
    });

    expect(normalized.traceId).toBe('corr-1');
    expect(normalized.parentEventId).toBe('evt-parent');
    expect(normalized.correlationId).toBe('corr-1');
    expect(normalized.causationId).toBe('evt-parent');
    expect(typeof normalized.eventId).toBe('string');
    expect(typeof normalized.spanId).toBe('string');
  });

  test('validateEnvelope reports missing required fields', () => {
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
    expect(result.errors.some((msg) => msg.includes('ts'))).toBe(true);
  });

  test('buildEdgeRows derives parent/ack/retry edges', () => {
    const rows = buildEdgeRows({
      eventId: 'evt-2',
      traceId: 'trc-1',
      parentEventId: 'evt-1',
      meta: {
        ackOfEventId: 'evt-ack',
        retryOfEventId: 'evt-retry',
      },
    }, { nowMs: 1234 });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.edge_type).sort()).toEqual(['ack_of', 'parent', 'retry_of']);
    expect(rows.every((row) => row.trace_id === 'trc-1')).toBe(true);
  });

  test('prepareEventForStorage returns normalized row + edges', () => {
    const prepared = prepareEventForStorage({
      eventId: 'evt-store-1',
      traceId: 'trc-store-1',
      parentEventId: 'evt-parent-1',
      type: 'daemon.write.ack',
      stage: 'ack',
      source: 'terminal-daemon.js',
      payload: { status: 'accepted' },
      meta: { ackOfEventId: 'evt-write-1' },
    }, { ingestedAtMs: 9999, sessionId: 'session-test' });

    expect(prepared.validation.valid).toBe(true);
    expect(prepared.row.event_id).toBe('evt-store-1');
    expect(prepared.row.trace_id).toBe('trc-store-1');
    expect(prepared.row.payload_hash.startsWith('sha256:')).toBe(true);
    expect(prepared.row.ingested_at_ms).toBe(9999);
    expect(prepared.row.session_id).toBe('session-test');
    expect(prepared.edges).toHaveLength(2); // parent + ack_of
  });
});
