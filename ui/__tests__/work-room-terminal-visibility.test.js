const {
  filterTerminalsForWorkspace,
  isTrustQuoteWorkRoomTerminal,
} = require('../modules/work-room-terminal-visibility');

describe('work-room terminal visibility', () => {
  const mainTerminal = { paneId: '2', alive: true, cwd: 'D:/projects/squidrun' };
  const trustQuoteBuilder = {
    paneId: 'trustquote-builder',
    alive: true,
    workRoomRouteOwner: true,
    roomId: 'trustquote',
    profileName: 'trustquote',
    windowKey: 'trustquote',
  };
  const trustQuoteOracle = {
    paneId: 'trustquote-oracle',
    alive: true,
    routeOwner: 'trustquote-work-room-route-owner',
    roomId: 'trustquote',
  };
  const trustQuoteLead = { paneId: 'trustquote-lead', alive: true };

  test('main workspace hides TrustQuote route-owner terminals', () => {
    expect(filterTerminalsForWorkspace([
      mainTerminal,
      trustQuoteBuilder,
      trustQuoteOracle,
    ], 'main')).toEqual([mainTerminal]);
  });

  test('TrustQuote workspace shows tagged Builder, Oracle, and arm terminals', () => {
    expect(filterTerminalsForWorkspace([
      mainTerminal,
      trustQuoteBuilder,
      trustQuoteOracle,
      trustQuoteLead,
    ], 'trustquote')).toEqual([trustQuoteBuilder, trustQuoteOracle, trustQuoteLead]);
  });

  test('TrustQuote pane ids count as real work-room terminals even without preview UI data', () => {
    expect(isTrustQuoteWorkRoomTerminal({ paneId: 'trustquote-builder', alive: true })).toBe(true);
    expect(isTrustQuoteWorkRoomTerminal({ paneId: 'trustquote-oracle', alive: true })).toBe(true);
    expect(isTrustQuoteWorkRoomTerminal({ paneId: 'trustquote-lead', alive: true })).toBe(true);
    expect(isTrustQuoteWorkRoomTerminal({ paneId: '2', alive: true })).toBe(false);
  });

  test('main workspace hides tagged TrustQuote pane ids even if route metadata is absent', () => {
    expect(filterTerminalsForWorkspace([
      mainTerminal,
      { paneId: 'trustquote-builder', alive: true },
      { paneId: 'trustquote-oracle', alive: true },
    ], 'main')).toEqual([mainTerminal]);
  });
});
