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

jest.mock('../data-ingestion', () => ({
  getAlpacaWatchlistSnapshots: jest.fn().mockResolvedValue(new Map([['AAPL', { symbol: 'AAPL' }]])),
  getAlpacaNews: jest.fn().mockResolvedValue([{ id: 'alpaca-news' }]),
}));

jest.mock('../executor', () => ({
  getAlpacaAccountSnapshot: jest.fn().mockResolvedValue({ id: 'alpaca-account' }),
  getAlpacaOpenPositions: jest.fn().mockResolvedValue([{ ticker: 'AAPL', broker: 'alpaca' }]),
  submitAlpacaOrder: jest.fn().mockResolvedValue({ ok: true, order: { id: 'alpaca-1' } }),
}));

const dataIngestion = require('../data-ingestion');
const executor = require('../executor');
const ibkrClient = require('../ibkr-client');
const { createBroker } = require('../broker-adapter');

describe('broker-adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('defaults to the Alpaca broker when broker type is unset', async () => {
    const broker = createBroker();

    expect(broker.type).toBe('alpaca');
    await broker.getSnapshots({ symbols: ['AAPL'] });
    await broker.getNews({ symbols: ['AAPL'] });
    await broker.getAccount();
    await broker.getPositions();
    await broker.submitOrder({ ticker: 'AAPL', direction: 'BUY', shares: 1 });

    expect(dataIngestion.getAlpacaWatchlistSnapshots).toHaveBeenCalled();
    expect(dataIngestion.getAlpacaNews).toHaveBeenCalled();
    expect(executor.getAlpacaAccountSnapshot).toHaveBeenCalled();
    expect(executor.getAlpacaOpenPositions).toHaveBeenCalled();
    expect(executor.submitAlpacaOrder).toHaveBeenCalled();
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

  test('throws on unsupported broker types', () => {
    expect(() => createBroker('unknown')).toThrow('Unsupported broker type');
  });
});
