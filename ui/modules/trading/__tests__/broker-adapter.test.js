'use strict';

jest.mock('../ibkr-client', () => ({
  connect: jest.fn(),
  disconnect: jest.fn(),
  getAccount: jest.fn().mockResolvedValue({ id: 'ibkr-account' }),
  getPositions: jest.fn().mockResolvedValue([{ ticker: '5801', broker: 'ibkr' }]),
  submitOrder: jest.fn().mockResolvedValue({ ok: true, order: { id: 101 } }),
  getSnapshots: jest.fn().mockResolvedValue(new Map([['5801', { symbol: '5801' }]])),
  getNews: jest.fn().mockResolvedValue([{ id: 'ibkr-news' }]),
}));

jest.mock('../executor', () => ({
  submitHyperliquidOrder: jest.fn().mockResolvedValue({ ok: true, status: 'accepted', order: { id: 'hl-1' } }),
}));

jest.mock('../hyperliquid-client', () => ({
  getAccountSnapshot: jest.fn().mockResolvedValue({ id: 'hyperliquid-account' }),
  getOpenPositions: jest.fn().mockResolvedValue([{ ticker: 'BTC/USD', broker: 'hyperliquid' }]),
  getSnapshots: jest.fn().mockResolvedValue(new Map([['BTC/USD', { symbol: 'BTC/USD' }]])),
  getLatestBars: jest.fn().mockResolvedValue(new Map([['BTC/USD', { symbol: 'BTC/USD' }]])),
  getHistoricalBars: jest.fn().mockResolvedValue(new Map([['BTC/USD', [{ symbol: 'BTC/USD' }]]])),
}));

const executor = require('../executor');
const hyperliquidClient = require('../hyperliquid-client');
const ibkrClient = require('../ibkr-client');
const { createBroker } = require('../broker-adapter');

describe('broker-adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('defaults to the IBKR broker when broker type is unset', async () => {
    const broker = createBroker();

    expect(broker.type).toBe('ibkr');
    await broker.getSnapshots({ symbols: ['5801'] });
    await broker.getNews({ symbols: ['5801'] });
    await broker.getAccount();
    await broker.getPositions();
    await broker.submitOrder({ ticker: '5801', direction: 'BUY', shares: 100 });

    expect(ibkrClient.getSnapshots).toHaveBeenCalled();
    expect(ibkrClient.getNews).toHaveBeenCalled();
    expect(ibkrClient.getAccount).toHaveBeenCalled();
    expect(ibkrClient.getPositions).toHaveBeenCalled();
    expect(ibkrClient.submitOrder).toHaveBeenCalled();
  });

  test('routes IBKR operations to the IBKR client', async () => {
    const broker = createBroker('ibkr');

    expect(broker.type).toBe('ibkr');
    await broker.connect();
    await broker.disconnect();
    await broker.getAccount();
    await broker.getPositions();
    await broker.submitOrder({ ticker: '5801', direction: 'BUY', shares: 100 });
    await broker.getSnapshots({ symbols: ['5801'] });
    await broker.getNews({ symbols: ['5801'] });

    expect(ibkrClient.connect).toHaveBeenCalled();
    expect(ibkrClient.disconnect).toHaveBeenCalled();
    expect(ibkrClient.getAccount).toHaveBeenCalled();
    expect(ibkrClient.getPositions).toHaveBeenCalled();
    expect(ibkrClient.submitOrder).toHaveBeenCalled();
    expect(ibkrClient.getSnapshots).toHaveBeenCalled();
    expect(ibkrClient.getNews).toHaveBeenCalled();
  });

  test('routes crypto market data and account reads to Hyperliquid', async () => {
    const broker = createBroker('hyperliquid');

    expect(broker.type).toBe('hyperliquid');
    await broker.getAccount();
    await broker.getPositions();
    await broker.getSnapshots({ symbols: ['BTC/USD'] });
    await broker.getLatestBars({ symbols: ['BTC/USD'] });
    await broker.getHistoricalBars({ symbols: ['BTC/USD'] });
    await broker.submitOrder({ ticker: 'BTC/USD', direction: 'BUY', shares: 0.01 }, { hyperliquidScalpModeArmed: true });

    expect(hyperliquidClient.getAccountSnapshot).toHaveBeenCalled();
    expect(hyperliquidClient.getOpenPositions).toHaveBeenCalled();
    expect(hyperliquidClient.getSnapshots).toHaveBeenCalled();
    expect(hyperliquidClient.getLatestBars).toHaveBeenCalled();
    expect(hyperliquidClient.getHistoricalBars).toHaveBeenCalled();
    expect(executor.submitHyperliquidOrder).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'BTC/USD', direction: 'BUY', shares: 0.01 }),
      expect.objectContaining({ hyperliquidScalpModeArmed: true })
    );
  });

  test('throws on unsupported broker types', () => {
    expect(() => createBroker('unknown')).toThrow('Unsupported broker type');
  });
});
