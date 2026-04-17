jest.mock('../modules/trading/hyperliquid-client', () => ({
  getUniverseMarketData: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const {
  parseTokenUnlockRows,
  runScan,
} = require('../scripts/hm-tokenomist-unlocks');

describe('hm-tokenomist-unlocks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('parses upcoming unlock rows with countdowns from the Tokenomist page dump format', () => {
    const rows = parseTokenUnlockRows(
      [
        'row "Picture of APT token APT $0.867 +2.46% $689.27M 64.13% $9.81M 0.68% 1 D 2 H 33 M 51 S $10.77M 0.75%"',
        'row "Picture of ARB token ARB $0.112 +1.11% $440.00M 52.10% $10.77M 1.50% 0 D 18 H 33 M 51 S $10.77M 1.50%"',
      ].join('\n'),
      { referenceTimeMs: Date.parse('2026-04-15T00:00:00.000Z') }
    );

    expect(rows).toEqual([
      expect.objectContaining({
        token: 'ARB',
        unlockSizeText: '$10.77M',
        unlockPctSupplyText: '1.50%',
        countdownText: '0 D 18 H 33 M 51 S',
      }),
      expect.objectContaining({
        token: 'APT',
        unlockSizeText: '$9.81M',
        unlockPctSupplyText: '0.68%',
        countdownText: '1 D 2 H 33 M 51 S',
      }),
    ]);
  });

  test('filters to Hyperliquid-tradeable unlocks inside the next 48 hours and joins 24h volume', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-tokenomist-test-'));
    const sourcePath = path.join(tempRoot, 'tokenomist-current.yml');
    fs.writeFileSync(sourcePath, [
      'row "Picture of APT token APT $0.867 +2.46% $689.27M 64.13% $9.81M 0.68% 1 D 2 H 33 M 51 S $10.77M 0.75%"',
      'row "Picture of ARB token ARB $0.112 +1.11% $440.00M 52.10% $10.77M 1.50% 0 D 18 H 33 M 51 S $10.77M 1.50%"',
    ].join('\n'));

    hyperliquidClient.getUniverseMarketData.mockResolvedValue([
      { coin: 'APT', volumeUsd24h: 123456789 },
      { coin: 'ARB', volumeUsd24h: 45678901 },
    ]);

    try {
      const result = await runScan({
        now: '2026-04-15T00:00:00.000Z',
        sourcePath,
        maxHours: 48,
      });

      expect(result.ok).toBe(true);
      expect(result.unlocks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          token: 'APT',
          hyperliquidVolumeUsd24h: 123456789,
        }),
        expect.objectContaining({
          token: 'ARB',
          hyperliquidVolumeUsd24h: 45678901,
        }),
      ]));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
