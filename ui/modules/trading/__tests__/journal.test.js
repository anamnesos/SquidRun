'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const journal = require('../journal');

describe('trade journal execution reports', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-trade-journal-'));
    dbPath = path.join(tempDir, 'trade-journal.db');
    journal.closeDb();
  });

  afterEach(() => {
    journal.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('records and reads execution reports', () => {
    const db = journal.getDb(dbPath);

    journal.recordExecutionReport(db, {
      timestamp: '2026-04-05T21:00:00.000Z',
      marketDate: '2026-04-05',
      phase: 'market_open',
      ticker: 'ETH/USD',
      direction: 'SELL',
      broker: 'hyperliquid',
      assetClass: 'crypto',
      status: 'executed',
      ok: true,
      reportType: 'market_open_execution',
      execution: {
        ok: true,
        status: 'filled',
      },
      referencePrice: 2100.5,
      confidence: 0.73,
      realizedPnl: 12.5,
      macroRisk: {
        regime: 'red',
      },
    });

    const rows = journal.getExecutionReports(db, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      timestamp: '2026-04-05T21:00:00.000Z',
      phase: 'market_open',
      report_type: 'market_open_execution',
      ticker: 'ETH/USD',
      ok: 1,
      status: 'executed',
      entry_price: 2100.5,
      realized_pnl: 12.5,
      confidence: 0.73,
    }));
    const payload = JSON.parse(rows[0].report_json);
    expect(payload).toEqual(expect.objectContaining({
      timestamp: '2026-04-05T21:00:00.000Z',
      reportType: 'market_open_execution',
      broker: 'hyperliquid',
      assetClass: 'crypto',
      macroRisk: expect.objectContaining({
        regime: 'red',
      }),
    }));
  });

  test('records SHORT trades after schema migration', () => {
    const db = journal.getDb(dbPath);

    journal.recordTrade(db, {
      ticker: 'ETH/USD',
      direction: 'SHORT',
      shares: 0.15,
      price: 2400,
      status: 'FILLED',
      notes: 'open-short',
    });

    const trades = journal.getAllTrades(db);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toEqual(expect.objectContaining({
      ticker: 'ETH/USD',
      direction: 'SHORT',
      shares: 0.15,
      price: 2400,
    }));
  });

  test('hides archived static positions from live open-position reads', () => {
    const db = journal.getDb(dbPath);

    journal.upsertPosition(db, {
      ticker: 'ETH/USD',
      shares: -2.1169,
      avgPrice: 2352.48,
      stopLossPrice: 2500,
    });

    expect(journal.getOpenPositions(db)).toEqual([
      expect.objectContaining({
        ticker: 'ETH/USD',
        source_scope: 'live',
        archived_at: null,
      }),
    ]);

    journal.archivePosition(db, 'ETH/USD', 'stale_non_live_position', {
      archivedAt: '2026-04-25T23:45:00.000Z',
      sourceScope: 'archive_static',
    });

    expect(journal.getOpenPositions(db)).toEqual([]);
    expect(journal.getOpenPositions(db, { includeArchived: true })).toEqual([
      expect.objectContaining({
        ticker: 'ETH/USD',
        source_scope: 'archive_static',
        archived_at: '2026-04-25T23:45:00.000Z',
        archive_reason: 'stale_non_live_position',
      }),
    ]);
  });

  test('quarantines DRY_RUN trades from live trade reads', () => {
    const db = journal.getDb(dbPath);

    journal.recordTrade(db, {
      ticker: 'BTC/USD',
      direction: 'BUY',
      shares: 0.01,
      price: 65000,
      status: 'FILLED',
      notes: 'live-fill',
    });
    journal.recordTrade(db, {
      ticker: 'ETH/USD',
      direction: 'SELL',
      shares: 0.132812,
      price: 2000,
      status: 'DRY_RUN',
      notes: 'dry run residue',
    });

    expect(journal.getAllTrades(db)).toEqual([
      expect.objectContaining({
        ticker: 'BTC/USD',
        status: 'FILLED',
      }),
    ]);

    const archiveResult = journal.archiveDryRunTrades(db, {
      ticker: 'ETH/USD',
      archivedAt: '2026-04-25T23:46:00.000Z',
      reason: 'dry_run_cleanup_2026-04-22',
    });
    expect(archiveResult.changes).toBe(1);

    expect(journal.getRecentTrades(db, 10)).toEqual([
      expect.objectContaining({
        ticker: 'BTC/USD',
        status: 'FILLED',
      }),
    ]);
    expect(journal.getAllTrades(db, { includeArchived: true })).toEqual([
      expect.objectContaining({
        ticker: 'BTC/USD',
        status: 'FILLED',
      }),
      expect.objectContaining({
        ticker: 'ETH/USD',
        status: 'DRY_RUN',
        source_scope: 'dry_run',
        archived_at: '2026-04-25T23:46:00.000Z',
        archive_reason: 'dry_run_cleanup_2026-04-22',
      }),
    ]);
  });
});
