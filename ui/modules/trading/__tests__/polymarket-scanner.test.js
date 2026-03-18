'use strict';

const mockGetMarketBook = jest.fn();
const mockGetMarkets = jest.fn();

jest.mock('../polymarket-client', () => ({
  getMarkets: mockGetMarkets,
  getMarketBook: mockGetMarketBook,
}));

const {
  scanMarkets,
  rankByEdge,
  getMarketContext,
} = require('../polymarket-scanner');

describe('polymarket-scanner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('scanMarkets filters to liquid short-dated binary markets with reasonable spreads', async () => {
    mockGetMarkets.mockResolvedValue([
      {
        conditionId: 'market-good',
        question: 'Will BTC close above $120k by June 2026?',
        category: 'crypto',
        volume24h: 54000,
        liquidity: 125000,
        endDate: '2026-04-15T00:00:00.000Z',
        tokens: [
          { tokenId: 'yes-good', outcome: 'Yes', price: 0.61 },
          { tokenId: 'no-good', outcome: 'No', price: 0.39 },
        ],
      },
      {
        conditionId: 'market-wide-spread',
        question: 'Will team X win the title?',
        category: 'sports',
        volume24h: 88000,
        liquidity: 150000,
        endDate: '2026-04-10T00:00:00.000Z',
        tokens: [
          { tokenId: 'yes-wide', outcome: 'Yes', price: 0.52 },
          { tokenId: 'no-wide', outcome: 'No', price: 0.48 },
        ],
      },
      {
        conditionId: 'market-long-dated',
        question: 'Will candidate Y win in 2027?',
        category: 'politics',
        volume24h: 125000,
        liquidity: 220000,
        endDate: '2027-08-01T00:00:00.000Z',
        tokens: [
          { tokenId: 'yes-long', outcome: 'Yes', price: 0.44 },
          { tokenId: 'no-long', outcome: 'No', price: 0.56 },
        ],
      },
    ]);

    mockGetMarketBook.mockImplementation(async (tokenId) => {
      switch (tokenId) {
        case 'yes-good':
          return { bestBid: 0.6, bestAsk: 0.62, midpoint: 0.61 };
        case 'no-good':
          return { bestBid: 0.38, bestAsk: 0.4, midpoint: 0.39 };
        case 'yes-wide':
          return { bestBid: 0.4, bestAsk: 0.58, midpoint: 0.49 };
        case 'no-wide':
          return { bestBid: 0.42, bestAsk: 0.6, midpoint: 0.51 };
        case 'yes-long':
          return { bestBid: 0.43, bestAsk: 0.45, midpoint: 0.44 };
        case 'no-long':
          return { bestBid: 0.55, bestAsk: 0.57, midpoint: 0.56 };
        default:
          return {};
      }
    });

    const results = await scanMarkets({
      now: '2026-03-18T00:00:00.000Z',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      conditionId: 'market-good',
      category: 'crypto',
      tokens: { yes: 'yes-good', no: 'no-good' },
      currentPrices: { yes: 0.61, no: 0.39 },
      volume24h: 54000,
      liquidity: 125000,
    });
    expect(results[0].spread.max).toBeCloseTo(0.02, 4);
    expect(results[0].daysToResolution).toBeCloseTo(28, 1);
  });

  test('rankByEdge sorts markets by absolute edge and maps action direction', () => {
    const ranked = rankByEdge([
      {
        conditionId: 'market-1',
        question: 'Will event A happen?',
        currentPrices: { yes: 0.42, no: 0.58 },
      },
      {
        conditionId: 'market-2',
        question: 'Will event B happen?',
        currentPrices: { yes: 0.71, no: 0.29 },
      },
    ], [
      { conditionId: 'market-1', probability: 0.6, confidence: 0.78 },
      { conditionId: 'market-2', probability: 0.52, confidence: 0.66 },
    ]);

    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toMatchObject({
      conditionId: 'market-2',
      action: 'BUY_NO',
      edge: -0.19,
    });
    expect(ranked[1]).toMatchObject({
      conditionId: 'market-1',
      action: 'BUY_YES',
      edge: 0.18,
    });
  });

  test('getMarketContext returns an agent-friendly summary payload', () => {
    const context = getMarketContext({
      conditionId: 'market-ctx',
      question: 'Will ETH be above $8k on July 1?',
      category: 'crypto',
      currentPrices: { yes: 0.57, no: 0.43 },
      volume24h: 32100,
      liquidity: 88000,
      resolutionDate: '2026-07-01T00:00:00.000Z',
      daysToResolution: 42.3,
      spread: { max: 0.03 },
    });

    expect(context).toMatchObject({
      conditionId: 'market-ctx',
      category: 'crypto',
      currentPrices: { yes: 0.57, no: 0.43 },
      volume24h: 32100,
      liquidity: 88000,
      daysToResolution: 42.3,
      spread: 0.03,
    });
    expect(context.summary).toContain('Will ETH be above $8k on July 1?');
    expect(context.summary).toContain('YES 0.57');
    expect(context.summary).toContain('resolves 2026-07-01');
  });
});
