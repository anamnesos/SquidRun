'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../hyperliquid-client', () => ({
  createInfoClient: jest.fn((options = {}) => options.infoClient || {
    metaAndAssetCtxs: jest.fn().mockResolvedValue([null, []]),
    predictedFundings: jest.fn().mockResolvedValue([]),
    fundingHistory: jest.fn().mockResolvedValue([]),
  }),
  normalizeCoinSymbol: jest.fn((ticker) => {
    const normalized = String(ticker || '').trim().toUpperCase();
    return normalized.endsWith('/USD') ? normalized.slice(0, -4) : normalized;
  }),
}));

const cryptoMechBoard = require('../crypto-mech-board');

describe('crypto-mech-board', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-crypto-mech-board-'));
    statePath = path.join(tempDir, 'crypto-mech-board-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('builds a Hyperliquid mechanical scorecard from live perp context', async () => {
    const result = await cryptoMechBoard.buildCryptoMechBoard({
      symbols: ['ETH/USD'],
      statePath,
      now: '2026-03-28T00:00:00.000Z',
      infoClient: {},
      metaAndAssetCtxs: [
        { universe: [{ name: 'ETH' }] },
        [{
          funding: '0.0000125',
          openInterest: '1000',
          prevDayPx: '2005.5',
          dayNtlVlm: '391843324.86',
          premium: '-0.0004020505',
          oraclePx: '1989.8',
          markPx: '1988.8',
          midPx: '1988.95',
          impactPxs: ['1988.9', '1989.0'],
          dayBaseVlm: '195978.73',
        }],
      ],
      predictedFundings: [
        ['ETH', [
          ['HlPerp', { fundingRate: '0.0000073371', nextFundingTime: Date.parse('2026-03-28T01:00:00.000Z') }],
        ]],
      ],
      fundingHistoryByCoin: {
        ETH: [
          { coin: 'ETH', fundingRate: '0.000008', premium: '-0.00035', time: Date.parse('2026-03-27T01:00:00.000Z') },
          { coin: 'ETH', fundingRate: '0.00001', premium: '-0.00037', time: Date.parse('2026-03-27T12:00:00.000Z') },
          { coin: 'ETH', fundingRate: '0.0000117', premium: '-0.00040', time: Date.parse('2026-03-27T23:00:00.000Z') },
        ],
      },
      whaleTransfers: [
        {
          symbol: 'WETH',
          side: 'buy',
          usdValue: 250000,
          walletAddress: '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503',
        },
      ],
      defiStatus: {
        positions: [
          { coin: 'ETH', size: -1, side: 'short', liquidationPx: 2200 },
        ],
      },
    });

    expect(result).toEqual(expect.objectContaining({
      venue: 'hyperliquid',
      symbols: expect.objectContaining({
        'ETH/USD': expect.objectContaining({
          fundingRateBps: 0.125,
          liquidationClusterProximity: null,
          liquidationClusterSource: 'unavailable_from_hyperliquid_public_api',
          mechanicalDirectionBias: expect.any(String),
          tradeFlag: expect.any(String),
        }),
      }),
    }));
    expect(result.symbols['ETH/USD'].whaleExchangeFlowScore).toBeGreaterThan(0);
    expect(result.symbols['ETH/USD'].positionLiquidationDistancePct).toBeCloseTo(0.096, 3);
    expect(result.symbols['ETH/USD'].rationale.length).toBeGreaterThan(0);
  });

  test('uses cached history to compute 24h open-interest change on later runs', async () => {
    await cryptoMechBoard.buildCryptoMechBoard({
      symbols: ['BTC/USD'],
      statePath,
      now: '2026-03-28T00:00:00.000Z',
      infoClient: {},
      metaAndAssetCtxs: [
        { universe: [{ name: 'BTC' }] },
        [{
          funding: '0.000006',
          openInterest: '1000',
          prevDayPx: '66000',
          dayNtlVlm: '500000000',
          premium: '-0.0004',
          oraclePx: '66200',
          markPx: '66200',
          midPx: '66200',
          impactPxs: ['66199', '66201'],
          dayBaseVlm: '10000',
        }],
      ],
      predictedFundings: [
        ['BTC', [['HlPerp', { fundingRate: '0.000007', nextFundingTime: Date.parse('2026-03-28T01:00:00.000Z') }]]],
      ],
      fundingHistoryByCoin: {
        BTC: [
          { coin: 'BTC', fundingRate: '0.000005', premium: '-0.00035', time: Date.parse('2026-03-27T01:00:00.000Z') },
        ],
      },
    });

    const second = await cryptoMechBoard.buildCryptoMechBoard({
      symbols: ['BTC/USD'],
      statePath,
      now: '2026-03-29T00:00:00.000Z',
      infoClient: {},
      metaAndAssetCtxs: [
        { universe: [{ name: 'BTC' }] },
        [{
          funding: '0.000009',
          openInterest: '1100',
          prevDayPx: '66200',
          dayNtlVlm: '520000000',
          premium: '-0.0002',
          oraclePx: '67000',
          markPx: '67000',
          midPx: '67000',
          impactPxs: ['66998', '67002'],
          dayBaseVlm: '10500',
        }],
      ],
      predictedFundings: [
        ['BTC', [['HlPerp', { fundingRate: '0.00001', nextFundingTime: Date.parse('2026-03-29T01:00:00.000Z') }]]],
      ],
      fundingHistoryByCoin: {
        BTC: [
          { coin: 'BTC', fundingRate: '0.000007', premium: '-0.00012', time: Date.parse('2026-03-28T01:00:00.000Z') },
        ],
      },
    });

    expect(second.symbols['BTC/USD'].openInterestChange24h).toBeCloseTo(100, 4);
    expect(second.symbols['BTC/USD'].openInterestChange24hPct).toBeCloseTo(0.1, 4);
    expect(second.symbols['BTC/USD'].priceOiDivergence.label).toBe('trend_supported');
  });
});
