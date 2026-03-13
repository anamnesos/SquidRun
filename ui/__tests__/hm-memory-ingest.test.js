const { buildPayloadFromFlags, parseArgs } = require('../scripts/hm-memory-ingest');

describe('hm-memory-ingest CLI helpers', () => {
  test('parses strict flags into ingest payload', () => {
    const { options } = parseArgs([
      '--content', 'Use hm-send for agent messaging',
      '--memory-class', 'procedural_rule',
      '--provenance-json', '{"source":"builder","kind":"observed"}',
      '--confidence', '0.9',
      '--source-trace', 'trace-1',
      '--device-id', 'VIGIL',
      '--session-id', 'app-session-217',
    ]);

    expect(buildPayloadFromFlags(options)).toEqual({
      content: 'Use hm-send for agent messaging',
      memory_class: 'procedural_rule',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.9,
      source_trace: 'trace-1',
      device_id: 'VIGIL',
      session_id: 'app-session-217',
    });
  });

  test('supports optional correction and expiry fields', () => {
    const { options } = parseArgs([
      '--content', 'corrected',
      '--memory-class', 'user_preference',
      '--provenance-json', '{"source":"user","kind":"direct_user_correction"}',
      '--confidence', '1',
      '--source-trace', 'trace-2',
      '--correction-of', 'memory-old',
      '--supersedes', 'memory-older',
      '--dedupe-key', 'pref-key',
      '--expires-at', '2026-03-13T00:00:00.000Z',
    ]);

    expect(buildPayloadFromFlags(options)).toEqual(expect.objectContaining({
      correction_of: 'memory-old',
      supersedes: 'memory-older',
      dedupe_key: 'pref-key',
      expires_at: '2026-03-13T00:00:00.000Z',
    }));
  });

  test('supports claim_type in strict flags mode', () => {
    const { options } = parseArgs([
      '--content', 'James prefers concise updates',
      '--memory-class', 'user_preference',
      '--provenance-json', '{"source":"user","kind":"direct_user_correction"}',
      '--confidence', '1',
      '--source-trace', 'trace-3',
      '--claim-type', 'direct_preference',
    ]);

    expect(buildPayloadFromFlags(options)).toEqual(expect.objectContaining({
      claim_type: 'direct_preference',
    }));
  });
});
