jest.mock('../scripts/hm-agent-alert', () => ({
  sendAgentAlert: jest.fn(() => ({ ok: true, targets: ['oracle'], results: [] })),
}));

jest.mock('../modules/trading/hyperliquid-client', () => ({
  getUniverseMarketData: jest.fn(),
  getHistoricalBars: jest.fn(),
  getPredictedFundings: jest.fn(),
  getOpenPositions: jest.fn(),
  getL2Book: jest.fn(),
}));

const {
  buildSuggestedCommand,
  formatOracleAlert,
} = require('../scripts/hm-oracle-watch-engine');

describe('hm-oracle-watch command gate', () => {
  test('does not emit executable commands below the mission margin floor', () => {
    const rule = {
      id: 'btc-reclaim-74020',
      name: 'BTC reclaim above 74020 and hold 2x 1m closes',
      enabled: true,
      ticker: 'BTC/USD',
      trigger: 'reclaim_hold',
      level: 74020,
      confirmCloses: 2,
    };
    const payload = {
      ticker: 'BTC/USD',
      trigger: rule.name,
      livePrice: 74045,
    };

    expect(buildSuggestedCommand(rule, payload, 'fired')).toBeNull();
    expect(formatOracleAlert('fired', rule, payload)).toContain('"executionReady":false');
  });

  test('keeps explicit executable commands at or above the mission margin floor', () => {
    const rule = {
      id: 'btc-reclaim-74020',
      name: 'BTC reclaim above 74020 and hold 2x 1m closes',
      enabled: true,
      ticker: 'BTC/USD',
      trigger: 'reclaim_hold',
      level: 74020,
      confirmCloses: 2,
      suggestedMarginUsd: 200,
    };
    const payload = {
      ticker: 'BTC/USD',
      trigger: rule.name,
      livePrice: 74045,
    };

    expect(buildSuggestedCommand(rule, payload, 'fired')).toContain('--margin 200');
    expect(formatOracleAlert('fired', rule, payload)).toContain('"executionReady":true');
  });
});
