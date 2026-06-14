const {
  TRUSTQUOTE_HM_SEND_COMMAND,
  TRUSTQUOTE_HM_SEND_SCOPE_NOTE,
  getTrustQuoteDayToDayArmSpecs,
} = require('../modules/trustquote-arm-specs');

describe('TrustQuote arm specs', () => {
  test('pins lead-funnel startup convention', () => {
    const specs = getTrustQuoteDayToDayArmSpecs();
    const lead = specs.find((spec) => spec.armKind === 'lead');
    const domainArms = specs.filter((spec) => spec.armKind === 'domain');

    expect(lead.startupMessage).toContain('ONE consolidated update to the Architect');
    expect(lead.startupMessage).toContain(
      `${TRUSTQUOTE_HM_SEND_COMMAND} architect --stdin --role trustquote-lead`
    );
    expect(lead.startupMessage).toContain(
      `${TRUSTQUOTE_HM_SEND_COMMAND} trustquote-app --stdin --role trustquote-lead`
    );
    expect(lead.startupMessage).toContain('trustquote-invoice / trustquote-schedule-dispatch');
    expect(lead.startupMessage).toContain(TRUSTQUOTE_HM_SEND_SCOPE_NOTE);
    expect(lead.startupMessage).not.toContain('--target-profile trustquote');

    expect(domainArms.map((spec) => spec.reportsTo)).toEqual([
      'trustquote-lead',
      'trustquote-lead',
      'trustquote-lead',
    ]);
    for (const spec of domainArms) {
      expect(spec.startupMessage).toContain(
        `${TRUSTQUOTE_HM_SEND_COMMAND} trustquote-lead --stdin --role ${spec.role}`
      );
      expect(spec.startupMessage).toContain('Do not report directly to the Architect');
      expect(spec.startupMessage).toContain(TRUSTQUOTE_HM_SEND_SCOPE_NOTE);
      expect(spec.startupMessage).not.toContain('--target-profile trustquote');
    }
  });
});
