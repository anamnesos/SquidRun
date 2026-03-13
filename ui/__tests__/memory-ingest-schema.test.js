const { buildCanonicalMemoryObject, MEMORY_CLASSES } = require('../modules/memory-ingest/schema');

describe('memory-ingest schema', () => {
  test('builds canonical object with required and packetization fields', () => {
    const result = buildCanonicalMemoryObject({
      content: 'Use workspace/knowledge for shared memory.',
      memory_class: 'procedural_rule',
      provenance: { source: 'builder', kind: 'observed' },
      confidence: 0.8,
      source_trace: 'trace-123',
      scope: { project: 'squidrun' },
      device_id: 'VIGIL',
      session_id: 'app-session-217',
      expires_at: '2026-03-13T00:00:00.000Z',
    }, { nowMs: 1000 });

    expect(result.ok).toBe(true);
    expect(result.memory.memory_class).toBe('procedural_rule');
    expect(result.memory.content_hash).toHaveLength(64);
    expect(result.memory.scope).toEqual({ project: 'squidrun' });
    expect(result.memory.device_id).toBe('VIGIL');
    expect(result.memory.session_id).toBe('app-session-217');
    expect(result.memory.expires_at).toBe(1773360000000);
    expect(Array.isArray(result.memory.result_refs)).toBe(true);
  });

  test('rejects unsupported class and missing required fields', () => {
    const result = buildCanonicalMemoryObject({
      content: '',
      memory_class: 'made_up_class',
      provenance: null,
      confidence: 'nope',
      source_trace: '',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'content is required',
      `memory_class must be one of: ${MEMORY_CLASSES.join(', ')}`,
      'provenance is required',
      'source_trace is required',
      'confidence must be a number between 0 and 1',
    ]));
  });

  test('accepts startup health memory classes', () => {
    const inventory = buildCanonicalMemoryObject({
      content: 'ui/modules contains 312 JS files and recovery-manager is present.',
      memory_class: 'codebase_inventory',
      provenance: { source: 'startup-health', kind: 'observed', claim_type: 'objective_fact' },
      confidence: 0.62,
      source_trace: 'startup-health:inventory',
    }, { nowMs: 2000 });
    const health = buildCanonicalMemoryObject({
      content: 'Evidence ledger DB present with rows; Jest lists 195 suites.',
      memory_class: 'system_health_state',
      provenance: { source: 'startup-health', kind: 'observed', claim_type: 'objective_fact' },
      confidence: 0.61,
      source_trace: 'startup-health:health',
    }, { nowMs: 2001 });

    expect(inventory.ok).toBe(true);
    expect(inventory.memory.memory_class).toBe('codebase_inventory');
    expect(health.ok).toBe(true);
    expect(health.memory.memory_class).toBe('system_health_state');
  });
});
