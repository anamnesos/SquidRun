'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const journal = require('../journal');

describe('trading journal schema migration', () => {
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

  test('rebuilds legacy trades tables that restrict Alpaca order statuses', () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        ticker TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('BUY','SELL')),
        shares REAL NOT NULL,
        price REAL NOT NULL,
        stop_loss_price REAL,
        total_value REAL NOT NULL,
        consensus_detail TEXT,
        risk_check_detail TEXT,
        status TEXT NOT NULL DEFAULT 'FILLED' CHECK(status IN ('FILLED','PENDING','CANCELED','REJECTED')),
        alpaca_order_id TEXT,
        notes TEXT
      );

      CREATE TABLE consensus_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        ticker TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('BUY','SELL','HOLD')),
        consensus_reached INTEGER NOT NULL DEFAULT 0,
        agreement_count INTEGER NOT NULL DEFAULT 0,
        architect_signal TEXT,
        builder_signal TEXT,
        oracle_signal TEXT,
        dissent_reasoning TEXT,
        acted_on INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE daily_summary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        start_equity REAL NOT NULL,
        end_equity REAL NOT NULL,
        pnl REAL NOT NULL,
        pnl_pct REAL NOT NULL,
        trades_count INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        peak_equity REAL NOT NULL,
        drawdown_pct REAL NOT NULL DEFAULT 0,
        notes TEXT
      );

      CREATE TABLE positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL UNIQUE,
        shares INTEGER NOT NULL,
        avg_price REAL NOT NULL,
        stop_loss_price REAL,
        opened_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(`
      INSERT INTO trades (ticker, direction, shares, price, total_value, status, alpaca_order_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('SOL/USD', 'BUY', 2.5, 90, 225, 'PENDING', 'legacy-order-1');
    db.close();

    const migratedDb = journal.getDb(dbPath);
    journal.recordTrade(migratedDb, {
      ticker: 'ETH/USD',
      direction: 'BUY',
      shares: 1.25,
      price: 2200,
      status: 'partially_filled',
      alpacaOrderId: 'new-order-2',
    });

    const tradesSql = migratedDb.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'trades'
    `).get()?.sql;
    const positionsInfo = migratedDb.prepare('PRAGMA table_info(positions)').all();
    const rows = migratedDb.prepare(`
      SELECT ticker, status
      FROM trades
      ORDER BY id
    `).all();

    expect(String(tradesSql)).not.toMatch(/CHECK\s*\(\s*status\s+IN/i);
    expect(positionsInfo.find((column) => column.name === 'shares')).toMatchObject({ type: 'REAL' });
    expect(rows).toEqual([
      { ticker: 'SOL/USD', status: 'PENDING' },
      { ticker: 'ETH/USD', status: 'PARTIALLY_FILLED' },
    ]);
  });
});
