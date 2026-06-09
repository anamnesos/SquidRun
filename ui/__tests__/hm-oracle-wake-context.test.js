'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildOracleWakeContext,
  buildOracleWakeMessage,
  evaluateScanLiveness,
} = require('../scripts/hm-oracle-wake-context');

// The exact shape of the real defect: public-core scanner is off by design, a ~9s
// heartbeat keeps re-stamping updatedAt, but lastScanAt is a month old and the cached
// flaggedMovers still hold frozen May-1 prices. These must NEVER surface as live movers.
const FROZEN_MOVERS = [
  { coin: 'PENDLE', ticker: 'PENDLE/USD', price: 1.57695, change24hPct: 0.1638, flagged: true },
  { coin: 'ZEC', ticker: 'ZEC/USD', price: 386.525, change24hPct: 0.123, flagged: true },
];

function makeScannerState(overrides = {}) {
  return {
    enabled: false,
    status: 'disabled',
    updatedAt: '2026-06-09T08:16:05.147Z',
    lastScanAt: '2026-05-01T18:00:06.919Z',
    lastScan: { ok: false, error: 'live_ops_removed_from_public_core', topMovers: [] },
    flaggedMovers: FROZEN_MOVERS,
    assets: FROZEN_MOVERS,
    ...overrides,
  };
}

describe('hm-oracle-wake-context — stale-as-live market gate', () => {
  let tempDir;
  let scannerPath;
  const NOW = Date.parse('2026-06-09T08:16:05.147Z');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-wake-ctx-'));
    scannerPath = path.join(tempDir, 'market-scanner-state.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function buildCtx(state, extra = {}) {
    fs.writeFileSync(scannerPath, JSON.stringify(state));
    return buildOracleWakeContext({
      marketScannerStatePath: scannerPath,
      watchRulesPath: path.join(tempDir, 'missing-rules.json'),
      watchStatePath: path.join(tempDir, 'missing-state.json'),
      now: NOW,
      ...extra,
    });
  }

  test('REGRESSION: disabled + stale scan emits topMovers=disabled, never frozen prices', async () => {
    const ctx = await buildCtx(makeScannerState());

    expect(ctx.topMovers).toEqual([]);
    expect(ctx.moversStatus).toBe('disabled');
    expect(ctx.moversSummary).toBe('disabled');
    // Hard assertion: no frozen ticker leaks into the emitted summary.
    expect(ctx.moversSummary).not.toMatch(/PENDLE|ZEC/);
  });

  test('REGRESSION: wake message string reports topMovers=disabled and leaks no frozen numbers', async () => {
    fs.writeFileSync(scannerPath, JSON.stringify(makeScannerState()));
    const message = await buildOracleWakeMessage('(WAKE):', {
      marketScannerStatePath: scannerPath,
      watchRulesPath: path.join(tempDir, 'missing-rules.json'),
      watchStatePath: path.join(tempDir, 'missing-state.json'),
      now: NOW,
    });

    expect(message).toContain('topMovers=disabled');
    expect(message).not.toMatch(/PENDLE|1\.5769|386\.52/);
  });

  test('a fresh, live scan still surfaces its cached movers', async () => {
    const live = makeScannerState({
      enabled: true,
      status: 'enabled',
      lastScanAt: new Date(NOW - 60 * 1000).toISOString(), // 1 min old
      lastScan: { ok: true, topMovers: [] },
    });
    const ctx = await buildCtx(live);

    expect(ctx.moversStatus).toBe('live');
    expect(ctx.moversSummary).toContain('PENDLE');
    expect(ctx.topMovers.length).toBeGreaterThan(0);
  });

  test('a live scan whose lastScanAt has gone stale is gated even if status=enabled', async () => {
    const stale = makeScannerState({
      enabled: true,
      status: 'enabled',
      lastScan: { ok: true, topMovers: [] },
      lastScanAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(), // 2h old, past 30m window
    });
    const ctx = await buildCtx(stale);

    expect(ctx.moversStatus).toBe('disabled');
    expect(ctx.moversDisabledReason).toBe('scan_stale');
    expect(ctx.moversSummary).toBe('disabled');
  });
});

describe('evaluateScanLiveness reasons', () => {
  const NOW = Date.parse('2026-06-09T08:16:05.147Z');
  const fresh = new Date(NOW - 60 * 1000).toISOString();

  test.each([
    ['status disabled', { status: 'disabled', lastScan: { ok: true }, lastScanAt: fresh }, false, 'status_disabled'],
    ['enabled false', { enabled: false, lastScan: { ok: true }, lastScanAt: fresh }, false, 'scanner_disabled'],
    ['last scan failed', { status: 'enabled', lastScan: { ok: false }, lastScanAt: fresh }, false, 'last_scan_failed'],
    ['missing lastScanAt', { status: 'enabled', lastScan: { ok: true } }, false, 'no_last_scan_at'],
    ['stale lastScanAt', { status: 'enabled', lastScan: { ok: true }, lastScanAt: '2026-05-01T18:00:06.919Z' }, false, 'scan_stale'],
    ['live', { status: 'enabled', enabled: true, lastScan: { ok: true }, lastScanAt: fresh }, true, 'live'],
  ])('%s', (_label, state, live, reason) => {
    const result = evaluateScanLiveness(state, { now: NOW });
    expect(result.live).toBe(live);
    expect(result.reason).toBe(reason);
  });
});
