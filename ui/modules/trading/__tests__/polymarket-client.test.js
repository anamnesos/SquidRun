'use strict';

const mockCreateOrDeriveApiKey = jest.fn().mockResolvedValue({
  key: 'poly-key',
  secret: 'poly-secret',
  passphrase: 'poly-passphrase',
});
const mockGetBalanceAllowance = jest.fn().mockResolvedValue({
  balance: '162',
  allowance: '150',
});
const mockCreateAndPostOrder = jest.fn();

const mockClobClient = jest.fn().mockImplementation((_host, _chainId, _signer, creds) => ({
  createOrDeriveApiKey: mockCreateOrDeriveApiKey,
  getBalanceAllowance: mockGetBalanceAllowance,
  createAndPostOrder: mockCreateAndPostOrder,
  getTickSize: jest.fn().mockResolvedValue('0.01'),
  getNegRisk: jest.fn().mockResolvedValue(true),
  getTrades: jest.fn().mockResolvedValue([]),
  getOpenOrders: jest.fn().mockResolvedValue([]),
  getOrderBook: jest.fn().mockResolvedValue({ bids: [], asks: [], last_trade_price: '0.45' }),
}));

jest.mock('@polymarket/clob-client', () => ({
  AssetType: {
    COLLATERAL: 'COLLATERAL',
  },
  Side: {
    BUY: 'BUY',
    SELL: 'SELL',
  },
  SignatureType: {
    EOA: 0,
  },
  OrderType: {
    GTC: 'GTC',
  },
  ClobClient: mockClobClient,
}));

const mockWallet = jest.fn().mockImplementation((privateKey) => ({ address: '0xwallet', privateKey }));
jest.mock('ethers', () => ({
  Wallet: mockWallet,
}));

const polymarketClient = require('../polymarket-client');

describe('polymarket-client', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await polymarketClient.disconnect();
  });

  test('resolves env config with dry-run enabled by default', () => {
    const config = polymarketClient.resolvePolymarketConfig({
      POLYMARKET_PRIVATE_KEY: 'abc123',
      POLYMARKET_FUNDER_ADDRESS: '0xfunder',
    });

    expect(config.privateKey).toBe('0xabc123');
    expect(config.funderAddress).toBe('0xfunder');
    expect(config.chainId).toBe(137);
    expect(config.dryRun).toBe(true);
    expect(config.configured).toBe(true);
  });

  test('connect derives api credentials and constructs the authenticated client', async () => {
    const client = await polymarketClient.connect({
      privateKey: '0xabc123',
      funderAddress: '0xfunder',
    });

    expect(client).toBeTruthy();
    expect(mockWallet).toHaveBeenCalledWith('0xabc123');
    expect(mockCreateOrDeriveApiKey).toHaveBeenCalled();
    expect(mockClobClient).toHaveBeenCalledTimes(2);
  });

  test('getBalance normalizes collateral balance allowance', async () => {
    const balance = await polymarketClient.getBalance({
      privateKey: '0xabc123',
      funderAddress: '0xfunder',
    });

    expect(mockGetBalanceAllowance).toHaveBeenCalledWith({ asset_type: 'COLLATERAL' });
    expect(balance).toMatchObject({
      currency: 'USDC.e',
      network: 'Polygon',
      balance: 162,
      allowance: 150,
      available: 150,
    });
  });

  test('createOrder stays in dry-run mode until explicitly enabled', async () => {
    const result = await polymarketClient.createOrder('token-1', 'BUY', 0.55, 10, {
      privateKey: '0xabc123',
      funderAddress: '0xfunder',
    });

    expect(result.status).toBe('dry_run');
    expect(mockCreateAndPostOrder).not.toHaveBeenCalled();
    expect(result.payload).toMatchObject({
      tokenID: 'token-1',
      price: 0.55,
      side: 'BUY',
      size: 10,
    });
  });
});
