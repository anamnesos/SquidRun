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
});
