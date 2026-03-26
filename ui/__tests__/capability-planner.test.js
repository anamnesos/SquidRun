const { buildCapabilityPlan, resolveCapabilityDomain } = require('../modules/capability-planner');

describe('capability-planner', () => {
  test('builds a legal capability plan', () => {
    const plan = buildCapabilityPlan({
      domain: 'legal',
      institutions: ['landlord'],
      moneyAmounts: ['$2,000'],
    });

    expect(plan.domain).toBe('legal');
    expect(plan.actions.length).toBeGreaterThan(2);
    expect(plan.shortNotice).toContain('Here is what we can do');
    expect(plan.markdown).toContain('Context: landlord');
  });

  test('falls back to general domain for unknown inputs', () => {
    expect(resolveCapabilityDomain('business')).toBe('general');
  });
});
