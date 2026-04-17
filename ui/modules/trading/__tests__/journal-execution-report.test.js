'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const journal = require('../journal');

describe('journal execution reports', () => {
  let tempDir;
  let dbPath;

  beforeEach(() => {
    journal.closeDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-execution-report-'));
    dbPath = path.join(tempDir, 'trade-journal.db');
  });

  afterEach(() => {
    journal.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('persists rich execution report payloads for later inspection', () => {
    const db = journal.getDb(dbPath);

    journal.recordExecutionReport(db, {
      timestamp: '2026-04-05T21:00:00.000Z',
      marketDate: '2026-04-05',
      phase: 'consensus_auto_execution',
      ticker: 'ETH/USD',
      direction: 'SELL',
      broker: 'hyperliquid',
      assetClass: 'crypto',
      status: 'executed',
      ok: true,
      tradeId: 42,
      reportType: 'auto_execution',
      execution: { ok: true, action: 'open', issue: null },
      referencePrice: 2100,
      confidence: 0.74,
      signalLookup: { architect: { direction: 'SELL', confidence: 0.74 } },
      macroRisk: { regime: 'red', score: 88 },
      eventVeto: { decision: 'CLEAR' },
      mechanical: { tradeFlag: 'trade' },
      riskCheck: { stopLossPrice: 2100 },
      sizeGuide: { bucket: 'small' },
      realizedPnl: 12.34,
    });

    const reports = journal.getExecutionReports(db, 5);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(expect.objectContaining({
      timestamp: '2026-04-05T21:00:00.000Z',
      phase: 'consensus_auto_execution',
      report_type: 'auto_execution',
      ticker: 'ETH/USD',
      direction: 'SELL',
      broker: 'hyperliquid',
      asset_class: 'crypto',
      status: 'executed',
      ok: 1,
      trade_id: 42,
      entry_price: 2100,
      realized_pnl: 12.34,
      confidence: 0.74,
    }));

    const payload = JSON.parse(reports[0].report_json);
    expect(payload).toEqual(expect.objectContaining({
      reportType: 'auto_execution',
      execution: { ok: true, action: 'open', issue: null },
      signalLookup: { architect: { direction: 'SELL', confidence: 0.74 } },
      macroRisk: { regime: 'red', score: 88 },
      eventVeto: { decision: 'CLEAR' },
      mechanical: { tradeFlag: 'trade' },
      riskCheck: { stopLossPrice: 2100 },
      sizeGuide: { bucket: 'small' },
      realizedPnl: 12.34,
    }));
  });
});
