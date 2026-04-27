'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const hyperliquidClient = require('../modules/trading/hyperliquid-client');

describe('hyperliquid-client shared rate-limit governor', () => {
  let tempDir = null;

  function buildPaths() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-hl-client-'));
    return {
      requestPoolPath: path.join(tempDir, 'request-pool.json'),
      requestPoolLockPath: path.join(tempDir, 'request-pool.lock'),
      rateLimitStatePath: path.join(tempDir, 'rate-limit-state.json'),
    };
  }

  afterEach(() => {
    hyperliquidClient.__resetRequestPoolState();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = null;
  });

  test('reuses stale pooled market data while shared backoff is active', async () => {
    const paths = buildPaths();
    const firstFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ BTC: '100000.0', ETH: '3000.0' }),
    });
    const baseOptions = {
      ...paths,
      infoClient: {},
    };

    const initial = await hyperliquidClient.getAllMids({
      ...baseOptions,
      fetch: firstFetch,
    });

    expect(initial).toEqual({ BTC: '100000.0', ETH: '3000.0' });
    expect(firstFetch).toHaveBeenCalledTimes(1);

    hyperliquidClient.__writeSharedRateLimitState({
      consecutive429s: 2,
      backoffUntil: new Date(Date.now() + 60_000).toISOString(),
      last429At: new Date().toISOString(),
      lastBackoffMs: 60_000,
      lastError: 'Hyperliquid info request failed with status 429',
    }, baseOptions);

    const blockedFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ BTC: '99999.0' }),
    });

    const reused = await hyperliquidClient.getAllMids({
      ...baseOptions,
      fetch: blockedFetch,
    });

    expect(reused).toEqual(initial);
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  test('rejects stale pooled market data past maxStaleMs while shared backoff is active', async () => {
    const paths = buildPaths();
    const nowMs = Date.now();
    const baseOptions = {
      ...paths,
      infoClient: {},
    };

    fs.writeFileSync(paths.requestPoolPath, JSON.stringify({
      'info:allMids': {
        cachedAt: nowMs - (6 * 60_000),
        value: { BTC: '100000.0', ETH: '3000.0' },
      },
    }, null, 2));

    hyperliquidClient.__writeSharedRateLimitState({
      consecutive429s: 2,
      backoffUntil: new Date(nowMs + 60_000).toISOString(),
      last429At: new Date(nowMs).toISOString(),
      lastBackoffMs: 60_000,
      lastError: 'Hyperliquid info request failed with status 429',
    }, baseOptions);

    const blockedFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ BTC: '99999.0' }),
    });

    await expect(hyperliquidClient.getAllMids({
      ...baseOptions,
      fetch: blockedFetch,
    })).rejects.toMatchObject({
      code: 'HL_RATE_LIMIT_BACKOFF',
    });

    expect(blockedFetch).not.toHaveBeenCalled();
  });

  test('records shared backoff on 429 and blocks the next venue call', async () => {
    const paths = buildPaths();
    const rateLimitedFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });
    const baseOptions = {
      ...paths,
      fetch: rateLimitedFetch,
    };

    await expect(hyperliquidClient.postInfoRequest({ type: 'allMids' }, baseOptions))
      .rejects
      .toThrow('429');

    const rateLimitState = hyperliquidClient.__readSharedRateLimitState(baseOptions);
    expect(rateLimitState).toEqual(expect.objectContaining({
      consecutive429s: 1,
      backoffUntil: expect.any(String),
      last429At: expect.any(String),
      lastBackoffMs: expect.any(Number),
      lastError: expect.stringContaining('429'),
    }));

    const nextFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    await expect(hyperliquidClient.postInfoRequest(
      { type: 'metaAndAssetCtxs' },
      { ...paths, fetch: nextFetch }
    )).rejects.toMatchObject({
      code: 'HL_RATE_LIMIT_BACKOFF',
    });

    expect(nextFetch).not.toHaveBeenCalled();
  });

  test('self-heals stale shared backoff when fresher pooled success exists', () => {
    const paths = buildPaths();
    const nowMs = Date.now();
    hyperliquidClient.__writeSharedRateLimitState({
      consecutive429s: 12,
      backoffUntil: new Date(nowMs + 10 * 60_000).toISOString(),
      last429At: new Date(nowMs - 5_000).toISOString(),
      lastBackoffMs: 600_000,
      lastError: '429 Too Many Requests - null',
    }, paths);
    fs.writeFileSync(paths.requestPoolPath, JSON.stringify({
      'info:openOrders:test': {
        cachedAt: nowMs,
        value: [],
      },
    }, null, 2));

    const healed = hyperliquidClient.__readSharedRateLimitState(paths);

    expect(healed).toEqual(expect.objectContaining({
      consecutive429s: 0,
      backoffUntil: null,
      lastBackoffMs: 0,
      lastError: null,
      lastSuccessAt: expect.any(String),
    }));
  });
});
