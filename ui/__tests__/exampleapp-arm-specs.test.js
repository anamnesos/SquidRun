const {
  EXAMPLEAPP_HM_SEND_COMMAND,
  EXAMPLEAPP_HM_SEND_SCOPE_NOTE,
  getExampleAppDayToDayArmSpecs,
} = require('../modules/exampleapp-arm-specs');

describe('ExampleApp arm specs', () => {
  test('pins lead-funnel startup convention', () => {
    const specs = getExampleAppDayToDayArmSpecs();
    const lead = specs.find((spec) => spec.armKind === 'lead');
    const domainArms = specs.filter((spec) => spec.armKind === 'domain');

    expect(lead.startupMessage).toContain('ONE consolidated update to the Architect');
    expect(lead.startupMessage).toContain(
      `${EXAMPLEAPP_HM_SEND_COMMAND} architect --stdin --role exampleapp-lead`
    );
    expect(lead.startupMessage).toContain(
      `${EXAMPLEAPP_HM_SEND_COMMAND} exampleapp-app --stdin --role exampleapp-lead`
    );
    expect(lead.startupMessage).toContain('exampleapp-invoice / exampleapp-schedule-dispatch');
    expect(lead.startupMessage).toContain(EXAMPLEAPP_HM_SEND_SCOPE_NOTE);
    expect(lead.startupMessage).not.toContain('--target-profile');

    expect(domainArms.map((spec) => spec.reportsTo)).toEqual([
      'exampleapp-lead',
      'exampleapp-lead',
      'exampleapp-lead',
    ]);
    for (const spec of domainArms) {
      expect(spec.startupMessage).toContain(
        `${EXAMPLEAPP_HM_SEND_COMMAND} exampleapp-lead --stdin --role ${spec.role}`
      );
      expect(spec.startupMessage).toContain('Do not report directly to the Architect');
      expect(spec.startupMessage).toContain(EXAMPLEAPP_HM_SEND_SCOPE_NOTE);
      expect(spec.startupMessage).not.toContain('--target-profile');
    }
  });
});
