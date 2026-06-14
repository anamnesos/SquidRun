const { getTrustQuoteDayToDayArmSpecs } = require('../modules/trustquote-arm-specs');

describe('TrustQuote arm specs', () => {
  test('pins lead-funnel startup convention', () => {
    const specs = getTrustQuoteDayToDayArmSpecs();
    const lead = specs.find((spec) => spec.armKind === 'lead');
    const domainArms = specs.filter((spec) => spec.armKind === 'domain');

    expect(lead.startupMessage).toContain('ONE consolidated update to the Architect');

    expect(domainArms.map((spec) => spec.reportsTo)).toEqual([
      'trustquote-lead',
      'trustquote-lead',
      'trustquote-lead',
    ]);
    for (const spec of domainArms) {
      expect(spec.startupMessage).toContain('hm-send trustquote-lead');
      expect(spec.startupMessage).toContain('not directly to the Architect');
    }
  });
});
