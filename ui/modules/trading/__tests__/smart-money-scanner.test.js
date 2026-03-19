'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createSmartMoneyScanner,
  createStaticSmartMoneyProvider,
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
});
