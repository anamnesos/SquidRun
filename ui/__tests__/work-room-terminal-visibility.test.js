const {
  TRUSTQUOTE_ARM_PANE_IDS,
  filterTerminalsForWorkspace,
  isTrustQuotePaneId,
} = require('../modules/work-room-terminal-visibility');

describe('work-room terminal visibility', () => {
  const mainTerminal = { paneId: '2', alive: true, cwd: 'D:/projects/squidrun' };
  const trustQuoteLead = { paneId: 'trustquote-lead', alive: true };
  const trustQuoteApp = { paneId: 'trustquote-app', alive: true };

  test('main workspace hides live TrustQuote arm terminals', () => {
    expect(filterTerminalsForWorkspace([
      mainTerminal,
      trustQuoteLead,
      trustQuoteApp,
    ], 'main')).toEqual([mainTerminal]);
  });

  test('Squid Room workspace shows live TrustQuote arm terminals', () => {
    expect(filterTerminalsForWorkspace([
      mainTerminal,
      trustQuoteLead,
      trustQuoteApp,
    ], 'squid-room')).toEqual([
      mainTerminal,
      trustQuoteLead,
      trustQuoteApp,
    ]);
  });

  test('only live TrustQuote arm pane ids are TrustQuote pane ids', () => {
    expect(TRUSTQUOTE_ARM_PANE_IDS).toEqual([
      'trustquote-lead',
      'trustquote-schedule-dispatch',
      'trustquote-app',
      'trustquote-invoice',
    ]);
    expect(isTrustQuotePaneId('trustquote-lead')).toBe(true);
    expect(isTrustQuotePaneId('trustquote-app')).toBe(true);
    expect(isTrustQuotePaneId(`trustquote-${'builder'}`)).toBe(false);
    expect(isTrustQuotePaneId(`trustquote-${'oracle'}`)).toBe(false);
    expect(isTrustQuotePaneId('2')).toBe(false);
  });

  test('main workspace hides tagged TrustQuote pane ids even if route metadata is absent', () => {
    expect(filterTerminalsForWorkspace([
      mainTerminal,
      { paneId: 'trustquote-lead', alive: true },
      { paneId: 'trustquote-invoice', alive: true },
    ], 'main')).toEqual([mainTerminal]);
  });
});
