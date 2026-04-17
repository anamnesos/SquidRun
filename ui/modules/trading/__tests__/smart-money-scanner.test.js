'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSmartMoneyScanner,
  createStaticSmartMoneyProvider,
  createEtherscanProvider,
  detectConvergenceSignals,
  readScannerState,
} = require('../smart-money-scanner');

describe('smart-money-scanner', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-smart-money-scanner-'));
    statePath = path.join(tempDir, 'smart-money-scanner-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('detects convergence when multiple large wallets buy the same token', () => {
    const signals = detectConvergenceSignals([
      {
        walletAddress: '0xaaa',
        chain: 'ethereum',
        symbol: 'PEPE',
        tokenAddress: '0xpepe',
        side: 'buy',
        usdValue: 80_000,
        timestamp: '2026-03-18T20:00:00.000Z',
      },
      {
        walletAddress: '0xbbb',
        chain: 'ethereum',
        symbol: 'PEPE',
        tokenAddress: '0xpepe',
        side: 'buy',
        usdValue: 65_000,
        timestamp: '2026-03-18T20:03:00.000Z',
      },
      {
        walletAddress: '0xccc',
        chain: 'ethereum',
        symbol: 'LINK',
        tokenAddress: '0xlink',
        side: 'buy',
        usdValue: 30_000,
        timestamp: '2026-03-18T20:04:00.000Z',
      },
    ], {
      nowMs: Date.parse('2026-03-18T20:05:00.000Z'),
      minUsdValue: 50_000,
      minWalletCount: 2,
      convergenceWindowMs: 15 * 60 * 1000,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      chain: 'ethereum',
      symbol: 'PEPE',
      tokenAddress: '0xpepe',
      walletCount: 2,
      totalUsdValue: 145000,
    });
    expect(signals[0].confidence).toBeGreaterThan(0.3);
  });

  test('polls a provider, persists state, and emits a single trigger per convergence window', async () => {
    const onTrigger = jest.fn().mockResolvedValue(undefined);
    const scanner = createSmartMoneyScanner({
      statePath,
      persist: true,
      provider: createStaticSmartMoneyProvider([
        {
          transferId: 'tx-1',
          walletAddress: '0xaaa',
          chain: 'ethereum',
          symbol: 'UNI',
          tokenAddress: '0xuni',
          side: 'buy',
          usdValue: 90_000,
          timestamp: '2026-03-18T20:00:00.000Z',
        },
        {
          transferId: 'tx-2',
          walletAddress: '0xbbb',
          chain: 'ethereum',
          symbol: 'UNI',
          tokenAddress: '0xuni',
          side: 'buy',
          usdValue: 75_000,
          timestamp: '2026-03-18T20:04:00.000Z',
        },
      ]),
      now: () => Date.parse('2026-03-18T20:05:00.000Z'),
      onTrigger,
      minUsdValue: 50_000,
      minWalletCount: 2,
      triggerCooldownMs: 15 * 60 * 1000,
      convergenceWindowMs: 15 * 60 * 1000,
    });

    const triggerEvents = [];
    scanner.on('trigger', (payload) => {
      triggerEvents.push(payload);
    });

    const firstResult = await scanner.pollNow({ reason: 'test-1' });
    expect(firstResult.ok).toBe(true);
    expect(firstResult.freshSignals).toHaveLength(1);
    expect(triggerEvents).toHaveLength(1);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    const secondResult = await scanner.pollNow({ reason: 'test-2' });
    expect(secondResult.ok).toBe(true);
    expect(secondResult.newTransfers).toHaveLength(0);
    expect(secondResult.freshSignals).toHaveLength(0);
    expect(triggerEvents).toHaveLength(1);
    expect(onTrigger).toHaveBeenCalledTimes(1);

    const persisted = readScannerState(statePath);
    expect(persisted.lastPollAt).toBe('2026-03-18T20:05:00.000Z');
    expect(persisted.recentTransfers).toHaveLength(2);
    expect(persisted.recentSignalKeys).toHaveLength(1);
  });

  test('returns a clear error when no provider or mock transfer source is configured', async () => {
    const scanner = createSmartMoneyScanner({
      statePath,
      persist: false,
    });

    const result = await scanner.pollNow();
    expect(result).toMatchObject({
      ok: false,
      error: 'smart_money_provider_required',
    });
  });

  test('persists degraded provider failures instead of silently pretending nothing happened', async () => {
    const scanner = createSmartMoneyScanner({
      statePath,
      persist: true,
      provider: async () => ({
        transfers: [],
        cursor: 12,
        degraded: true,
        error: 'rpc timeout',
        reason: 'ethereum_rpc_failed',
      }),
    });

    const result = await scanner.pollNow();

    expect(result).toMatchObject({
      ok: false,
      error: 'rpc timeout',
      degraded: true,
    });

    const persisted = readScannerState(statePath);
    expect(persisted).toMatchObject({
      health: 'degraded',
      lastError: 'rpc timeout',
      lastResult: expect.objectContaining({
        ok: false,
        degraded: true,
        error: 'rpc timeout',
      }),
    });
  });

  test('surfaces non-JSON RPC rate-limit bodies as degraded provider errors', async () => {
    const provider = createEtherscanProvider({
      rpcUrl: 'https://rpc.example.test',
      blocksPerPoll: 1,
    });

    const result = await provider({
      cursor: 0,
      fetch: jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Too many calls per second',
      }),
    });

    expect(result).toMatchObject({
      degraded: true,
      reason: 'ethereum_rpc_failed',
      error: expect.stringContaining('rpc_http_429'),
    });
    expect(result.error).toContain('Too many calls per second');
  });

  test('uses live WETH pricing and block timestamps instead of hardcoded poll-time assumptions', async () => {
    const provider = createEtherscanProvider({
      rpcUrl: 'https://rpc.example.test',
      blocksPerPoll: 1,
    });
    const twentyWethHex = `0x${(20n * (10n ** 18n)).toString(16)}`;
    const fetchMock = jest.fn(async (url, options = {}) => {
      if (url === 'https://api.hyperliquid.xyz/info') {
        return {
          ok: true,
          text: async () => JSON.stringify({ ETH: '3000' }),
        };
      }

      const payload = JSON.parse(options.body);
      if (payload.method === 'eth_blockNumber') {
        return {
          ok: true,
          text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }),
        };
      }
      if (payload.method === 'eth_getLogs') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: [{
              address: '0xC02aaA39B223FE8D0A0E5C4F27eAD9083C756Cc2',
              blockNumber: '0x10',
              transactionHash: '0xabc123',
              logIndex: '0x1',
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x0000000000000000000000001111111111111111111111111111111111111111',
                '0x0000000000000000000000007758e507850da48cd47df1fb5f875c23e3340c50',
              ],
              data: twentyWethHex,
            }],
          }),
        };
      }
      if (payload.method === 'eth_getBlockByNumber') {
        return {
          ok: true,
          text: async () => JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              timestamp: '0x69ded500',
            },
          }),
        };
      }
      throw new Error(`Unexpected URL/method: ${url} ${options.body}`);
    });

    const result = await provider({
      cursor: 0,
      fetch: fetchMock,
    });

    expect(result.degraded).not.toBe(true);
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({
      symbol: 'WETH',
      usdValue: 60000,
      timestamp: '2026-04-15T00:00:00.000Z',
      observedAt: '2026-04-15T00:00:00.000Z',
      priceSource: 'hyperliquid:allMids',
      priceObservedAt: expect.any(String),
      priceStale: false,
    });
    expect(result.transfers[0].transferId).toBe('0xabc123:1');
  });
});
