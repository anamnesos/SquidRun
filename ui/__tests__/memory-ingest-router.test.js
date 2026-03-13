const { resolveMemoryRoute } = require('../modules/memory-ingest/router');

describe('memory-ingest router', () => {
  test('routes all eight classes deterministically', () => {
    const expectations = new Map([
      ['user_preference', 'tier1'],
      ['environment_quirk', 'tier1'],
      ['procedural_rule', 'tier1'],
      ['architecture_decision', 'tier1'],
      ['solution_trace', 'tier3'],
      ['historical_outcome', 'tier3'],
      ['active_task_state', 'tier4'],
      ['cross_device_handoff', 'tier4'],
    ]);

    for (const [memoryClass, tier] of expectations) {
      const route = resolveMemoryRoute({
        memory_class: memoryClass,
        provenance: { source: 'builder', kind: 'observed' },
      });
      expect(route.ok).toBe(true);
      expect(route.tier).toBe(tier);
    }
  });

  test('user preference direct correction bypasses review requirement', () => {
    const route = resolveMemoryRoute({
      memory_class: 'user_preference',
      provenance: { source: 'user', kind: 'direct_user_correction' },
    });

    expect(route.ok).toBe(true);
    expect(route.promotionRequired).toBe(false);
    expect(route.tier).toBe('tier1');
  });
});
