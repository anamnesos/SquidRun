const {
  EXAMPLEAPP_ARM_PANE_IDS,
  filterTerminalsForWorkspace,
  isExampleAppPaneId,
} = require('../modules/work-room-terminal-visibility');

describe('work-room terminal visibility', () => {
  const mainTerminal = { paneId: '2', alive: true, cwd: 'D:/projects/squidrun' };
  const exampleAppLead = { paneId: 'exampleapp-lead', alive: true };
  const exampleAppApp = { paneId: 'exampleapp-app', alive: true };

  test('main workspace hides live ExampleApp arm terminals', () => {
    expect(filterTerminalsForWorkspace([
      mainTerminal,
      exampleAppLead,
      exampleAppApp,
    ], 'main')).toEqual([mainTerminal]);
  });

  test('Squid Room workspace shows live ExampleApp arm terminals', () => {
    expect(filterTerminalsForWorkspace([
      mainTerminal,
      exampleAppLead,
      exampleAppApp,
    ], 'squid-room')).toEqual([
      mainTerminal,
      exampleAppLead,
      exampleAppApp,
    ]);
  });

  test('only live ExampleApp arm pane ids are ExampleApp pane ids', () => {
    expect(EXAMPLEAPP_ARM_PANE_IDS).toEqual([
      'exampleapp-lead',
      'exampleapp-schedule-dispatch',
      'exampleapp-app',
      'exampleapp-invoice',
    ]);
    expect(isExampleAppPaneId('exampleapp-lead')).toBe(true);
    expect(isExampleAppPaneId('exampleapp-app')).toBe(true);
    expect(isExampleAppPaneId(`exampleapp-${'builder'}`)).toBe(false);
    expect(isExampleAppPaneId(`exampleapp-${'oracle'}`)).toBe(false);
    expect(isExampleAppPaneId('2')).toBe(false);
  });

  test('main workspace hides tagged ExampleApp pane ids even if route metadata is absent', () => {
    expect(filterTerminalsForWorkspace([
      mainTerminal,
      { paneId: 'exampleapp-lead', alive: true },
      { paneId: 'exampleapp-invoice', alive: true },
    ], 'main')).toEqual([mainTerminal]);
  });
});
