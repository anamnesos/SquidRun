'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const walletTracker = require('../wallet-tracker');

describe('wallet-tracker', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-wallet-tracker-'));
    statePath = path.join(tempDir, 'wallet-tracker-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('tracks wallets and filters them by chain', () => {
    walletTracker.trackWallet('So11111111111111111111111111111111111111112', {
      statePath,
      chain: 'solana',
      label: 'SOL Whale',
      pnlScore: 87,
    });
    walletTracker.trackWallet('0xABCDEF1234567890ABCDEF1234567890ABCDEF12', {
      statePath,
      chain: 'ethereum',
      label: 'ETH Whale',
      pnlScore: 91,
    });

    expect(walletTracker.getTrackedWallets({ statePath, chain: 'solana' })).toEqual([
      expect.objectContaining({
        address: 'So11111111111111111111111111111111111111112',
        chain: 'solana',
        label: 'SOL Whale',
        pnlScore: 87,
      }),
    ]);
    expect(walletTracker.getTrackedWallets({ statePath, chain: 'ethereum' })).toEqual([
      expect.objectContaining({
        address: '0xabcdef1234567890abcdef1234567890abcdef12',
        chain: 'ethereum',
        label: 'ETH Whale',
        pnlScore: 91,
      }),
    ]);
  });

  test('returns recent moves from mock data for tracked wallets only', async () => {
    walletTracker.trackWallet('wallet-1', {
      statePath,
      chain: 'solana',
      label: 'Sniper 1',
      pnlScore: 92,
    });

    const moves = await walletTracker.getRecentMoves({
      statePath,
      chain: 'solana',
      minValue: 5000,
      mockMoves: [
        {
          address: 'wallet-1',
          chain: 'solana',
          symbol: 'BONK',
          tokenAddress: 'bonk-token',
          side: 'buy',
          usdValue: 7000,
          quantity: 1000000,
          timestamp: '2026-03-18T18:00:00.000Z',
        },
        {
          address: 'wallet-2',
          chain: 'solana',
          symbol: 'WIF',
          tokenAddress: 'wif-token',
          side: 'buy',
          usdValue: 9000,
          quantity: 1000,
          timestamp: '2026-03-18T18:05:00.000Z',
        },
        {
          address: 'wallet-1',
          chain: 'solana',
          symbol: 'JUP',
          tokenAddress: 'jup-token',
          side: 'sell',
          usdValue: 1200,
          quantity: 200,
          timestamp: '2026-03-18T18:10:00.000Z',
        },
      ],
    });

    expect(moves).toEqual([
      expect.objectContaining({
        address: 'wallet-1',
        chain: 'solana',
        symbol: 'BONK',
        usdValue: 7000,
        walletLabel: 'Sniper 1',
        walletPnlScore: 92,
      }),
    ]);
  });

  test('builds convergence signals from multiple smart-money buys', async () => {
    walletTracker.trackWallet('wallet-a', {
      statePath,
      chain: 'solana',
      label: 'Wallet A',
      pnlScore: 95,
    });
    walletTracker.trackWallet('wallet-b', {
      statePath,
      chain: 'solana',
      label: 'Wallet B',
      pnlScore: 88,
    });
    walletTracker.trackWallet('wallet-c', {
      statePath,
      chain: 'solana',
      label: 'Wallet C',
      pnlScore: 60,
    });

    const signals = await walletTracker.getConvergenceSignals({
      statePath,
      chain: 'solana',
      minWalletCount: 2,
      minUsdValue: 10000,
      moves: [
        {
          address: 'wallet-a',
          chain: 'solana',
          symbol: 'BONK',
          tokenAddress: 'bonk-token',
          side: 'buy',
          usdValue: 7000,
          timestamp: '2026-03-18T18:00:00.000Z',
        },
        {
          address: 'wallet-b',
          chain: 'solana',
          symbol: 'BONK',
          tokenAddress: 'bonk-token',
          side: 'buy',
          usdValue: 9000,
          timestamp: '2026-03-18T18:02:00.000Z',
        },
        {
          address: 'wallet-c',
          chain: 'solana',
          symbol: 'WIF',
          tokenAddress: 'wif-token',
          side: 'buy',
          usdValue: 2000,
          timestamp: '2026-03-18T18:03:00.000Z',
        },
      ],
    });

    expect(signals).toEqual([
      expect.objectContaining({
        symbol: 'BONK',
        chain: 'solana',
        walletCount: 2,
        totalUsdValue: 16000,
      }),
    ]);
    expect(signals[0].strength).toBeGreaterThan(0.5);
    expect(signals[0].confidence).toBeGreaterThan(0.4);
    expect(signals[0].wallets).toEqual([
      expect.objectContaining({ label: 'Wallet A', pnlScore: 95 }),
      expect.objectContaining({ label: 'Wallet B', pnlScore: 88 }),
    ]);
  });

  test('reports mock mode when API keys are unavailable', () => {
    expect(walletTracker.resolveWalletTrackerConfig({})).toMatchObject({
      configured: false,
      mockMode: true,
      availableChains: {
        solana: false,
        ethereum: false,
      },
    });
  });
});
