jest.mock('../modules/trading/hyperliquid-client', () => ({
  getUniverseMarketData: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const {
  inspectTokenomistSource,
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
      expect(result.sourceFreshness).toEqual(expect.objectContaining({
        exists: true,
        stale: false,
      }));
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

  test('reports stale source metadata after the 12 hour hard block threshold', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-tokenomist-source-test-'));
    const sourcePath = path.join(tempRoot, 'tokenomist-current.yml');
    fs.writeFileSync(sourcePath, 'row "Picture of OP token OP $0.123 +1.23% $123.00M 50.00% $9.81M 0.68% 0 D 4 H 3 M 51 S $10.77M 0.75%"');
    const staleTime = Date.parse('2026-04-15T00:00:00.000Z') - (13 * 60 * 60 * 1000);
    fs.utimesSync(sourcePath, staleTime / 1000, staleTime / 1000);

    try {
      const status = inspectTokenomistSource(sourcePath, {
        now: '2026-04-15T00:00:00.000Z',
      });

      expect(status).toEqual(expect.objectContaining({
        exists: true,
        stale: true,
        warn: true,
        warning: expect.objectContaining({
          kind: 'stale_tokenomist_source',
        }),
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
