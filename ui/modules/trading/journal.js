/**
 * Trade Journal — SQLite-backed trade log and performance tracking.
 *
 * Records every trade decision (including HOLDs and rejections),
 * consensus details, and daily P&L for learning and reporting.
 */

'use strict';

const path = require('path');

/** @type {import('node:sqlite').DatabaseSync | null} */
let _db = null;

const TRADE_TABLE_COLUMNS = Object.freeze([
  'id',
  'timestamp',
  'ticker',
  'direction',
  'shares',
  'price',
  'stop_loss_price',
  'total_value',
  'consensus_detail',
  'risk_check_detail',
  'status',
  'alpaca_order_id',
  'notes',
  'filled_at',
  'reconciled_at',
  'realized_pnl',
  'outcome_recorded_at',
]);

const POSITION_TABLE_COLUMNS = Object.freeze([
  'id',
  'ticker',
  'shares',
  'avg_price',
  'stop_loss_price',
  'opened_at',
  'updated_at',
]);

const TRADES_TABLE_SQL = `
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
    status TEXT NOT NULL DEFAULT 'FILLED',
    alpaca_order_id TEXT,
    notes TEXT,
    filled_at TEXT,
    reconciled_at TEXT,
    realized_pnl REAL,
    outcome_recorded_at TEXT
  )
`;

const POSITIONS_TABLE_SQL = `
  CREATE TABLE positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL UNIQUE,
    shares REAL NOT NULL,
    avg_price REAL NOT NULL,
    stop_loss_price REAL,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

function getDb(dbPath) {
  if (_db) return _db;
  const { openDatabase } = require('../sqlite-compat');
  _db = openDatabase(dbPath || path.join(process.cwd(), '.squidrun', 'runtime', 'trade-journal.db'));
  _db.exec('PRAGMA journal_mode=WAL');
  _db.exec('PRAGMA foreign_keys=ON');
  ensureSchema(_db);
  return _db;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
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
      status TEXT NOT NULL DEFAULT 'FILLED',
      alpaca_order_id TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS consensus_log (
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

    CREATE TABLE IF NOT EXISTS daily_summary (
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
      best_trade_ticker TEXT,
      best_trade_pnl REAL,
      worst_trade_ticker TEXT,
      worst_trade_pnl REAL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL UNIQUE,
      shares REAL NOT NULL,
      avg_price REAL NOT NULL,
      stop_loss_price REAL,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  migrateLegacySchemaIfNeeded(db);
  ensureColumnExists(db, 'trades', 'filled_at', 'TEXT');
  ensureColumnExists(db, 'trades', 'reconciled_at', 'TEXT');
  ensureColumnExists(db, 'trades', 'realized_pnl', 'REAL');
  ensureColumnExists(db, 'trades', 'outcome_recorded_at', 'TEXT');
  ensureColumnExists(db, 'daily_summary', 'best_trade_ticker', 'TEXT');
  ensureColumnExists(db, 'daily_summary', 'best_trade_pnl', 'REAL');
  ensureColumnExists(db, 'daily_summary', 'worst_trade_ticker', 'TEXT');
  ensureColumnExists(db, 'daily_summary', 'worst_trade_pnl', 'REAL');
}

function closeDb() {
  if (!_db) return;
  try {
    _db.close();
  } catch {}
  _db = null;
}

function ensureColumnExists(db, tableName, columnName, columnSql) {
  const existingColumns = new Set(getTableColumns(db, tableName));
  if (existingColumns.has(columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
}

function normalizeTradeStatus(value) {
  const normalized = String(value || 'FILLED').trim().toUpperCase();
  return normalized || 'FILLED';
}

function getTableSql(db, tableName) {
  const row = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);
  return String(row?.sql || '');
}

function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name || '').trim()).filter(Boolean);
}

function rebuildTable(db, tableName, createTableSql, desiredColumns) {
  const existingColumns = new Set(getTableColumns(db, tableName));
  const copyColumns = desiredColumns.filter((columnName) => existingColumns.has(columnName));
  const legacyTableName = `${tableName}__legacy_migration`;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`DROP TABLE IF EXISTS ${legacyTableName}`);
    db.exec(`ALTER TABLE ${tableName} RENAME TO ${legacyTableName}`);
    db.exec(createTableSql);
    if (copyColumns.length > 0) {
      const columnList = copyColumns.join(', ');
      db.exec(`INSERT INTO ${tableName} (${columnList}) SELECT ${columnList} FROM ${legacyTableName}`);
    }
    db.exec(`DROP TABLE ${legacyTableName}`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

function migrateLegacySchemaIfNeeded(db) {
  const tradesSql = getTableSql(db, 'trades');
  if (requiresTradesMigration(tradesSql)) {
    rebuildTable(db, 'trades', TRADES_TABLE_SQL, TRADE_TABLE_COLUMNS);
  }

  const positionsSql = getTableSql(db, 'positions');
  if (requiresPositionsMigration(positionsSql)) {
    rebuildTable(db, 'positions', POSITIONS_TABLE_SQL, POSITION_TABLE_COLUMNS);
  }
}

function requiresTradesMigration(tableSql = '') {
  const normalized = String(tableSql || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /\bstatus\s+TEXT\b[^,]*\bCHECK\s*\(\s*status\s+IN\s*\(/i.test(normalized);
}

function requiresPositionsMigration(tableSql = '') {
  const normalized = String(tableSql || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /\bshares\s+INTEGER\b/i.test(normalized);
}

/**
 * Record a trade execution.
 */
function recordTrade(db, trade) {
  const stmt = db.prepare(`
    INSERT INTO trades (ticker, direction, shares, price, stop_loss_price, total_value, consensus_detail, risk_check_detail, status, alpaca_order_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    trade.ticker,
    trade.direction,
    trade.shares,
    trade.price,
    trade.stopLossPrice || null,
    trade.shares * trade.price,
    trade.consensusDetail ? JSON.stringify(trade.consensusDetail) : null,
    trade.riskCheckDetail ? JSON.stringify(trade.riskCheckDetail) : null,
    normalizeTradeStatus(trade.status),
    trade.alpacaOrderId || null,
    trade.notes || null,
  );
}

/**
 * Record a consensus evaluation (including no-trade HOLDs).
 */
function recordConsensus(db, entry) {
  const stmt = db.prepare(`
    INSERT INTO consensus_log (ticker, decision, consensus_reached, agreement_count, architect_signal, builder_signal, oracle_signal, dissent_reasoning, acted_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    entry.ticker,
    entry.decision,
    entry.consensusReached ? 1 : 0,
    entry.agreementCount || 0,
    entry.architectSignal ? JSON.stringify(entry.architectSignal) : null,
    entry.builderSignal ? JSON.stringify(entry.builderSignal) : null,
    entry.oracleSignal ? JSON.stringify(entry.oracleSignal) : null,
    entry.dissentReasoning || null,
    entry.actedOn ? 1 : 0,
  );
}

/**
 * Record end-of-day summary.
 */
function recordDailySummary(db, summary) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO daily_summary (
      date,
      start_equity,
      end_equity,
      pnl,
      pnl_pct,
      trades_count,
      wins,
      losses,
      peak_equity,
      drawdown_pct,
      best_trade_ticker,
      best_trade_pnl,
      worst_trade_ticker,
      worst_trade_pnl,
      notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    summary.date,
    summary.startEquity,
    summary.endEquity,
    summary.pnl,
    summary.pnlPct,
    summary.tradesCount || 0,
    summary.wins || 0,
    summary.losses || 0,
    summary.peakEquity,
    summary.drawdownPct || 0,
    summary.bestTradeTicker || null,
    summary.bestTradePnl ?? null,
    summary.worstTradeTicker || null,
    summary.worstTradePnl ?? null,
    summary.notes || null,
  );
}

/**
 * Update or insert a position.
 */
function upsertPosition(db, position) {
  const stmt = db.prepare(`
    INSERT INTO positions (ticker, shares, avg_price, stop_loss_price, opened_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(ticker) DO UPDATE SET
      shares = excluded.shares,
      avg_price = excluded.avg_price,
      stop_loss_price = excluded.stop_loss_price,
      updated_at = datetime('now')
  `);
  return stmt.run(
    position.ticker,
    position.shares,
    position.avgPrice,
    position.stopLossPrice || null,
  );
}

/**
 * Remove a closed position.
 */
function closePosition(db, ticker) {
  return db.prepare('DELETE FROM positions WHERE ticker = ?').run(ticker);
}

/**
 * Get all open positions.
 */
function getOpenPositions(db) {
  return db.prepare('SELECT * FROM positions ORDER BY ticker').all();
}

/**
 * Get recent trades.
 */
function getRecentTrades(db, limit = 10) {
  return db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit);
}

function getAllTrades(db) {
  return db.prepare('SELECT * FROM trades ORDER BY timestamp ASC, id ASC').all();
}

function getTradeById(db, tradeId) {
  return db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId) || null;
}

function getPendingTrades(db, statuses = ['PENDING_NEW', 'PENDING', 'ACCEPTED', 'NEW', 'PARTIALLY_FILLED']) {
  const normalizedStatuses = Array.from(new Set(
    (Array.isArray(statuses) ? statuses : [statuses])
      .map((status) => normalizeTradeStatus(status))
      .filter(Boolean)
  ));
  if (normalizedStatuses.length === 0) {
    return [];
  }

  const placeholders = normalizedStatuses.map(() => '?').join(', ');
  return db.prepare(`
    SELECT *
    FROM trades
    WHERE status IN (${placeholders})
    ORDER BY timestamp ASC, id ASC
  `).all(...normalizedStatuses);
}

function updateTrade(db, tradeId, patch = {}) {
  const current = getTradeById(db, tradeId);
  if (!current) return null;

  const nextShares = patch.shares !== undefined ? Number(patch.shares) : Number(current.shares || 0);
  const nextPrice = patch.price !== undefined ? Number(patch.price) : Number(current.price || 0);
  const updates = [];
  const values = [];
  const assign = (column, value) => {
    if (value === undefined) return;
    updates.push(`${column} = ?`);
    values.push(value);
  };

  assign('shares', patch.shares !== undefined ? nextShares : undefined);
  assign('price', patch.price !== undefined ? nextPrice : undefined);
  assign('stop_loss_price', patch.stopLossPrice);
  assign(
    'total_value',
    patch.totalValue !== undefined
      ? Number(patch.totalValue)
      : ((patch.shares !== undefined || patch.price !== undefined) ? Number((nextShares * nextPrice).toFixed(6)) : undefined)
  );
  assign('consensus_detail', patch.consensusDetail !== undefined
    ? (patch.consensusDetail ? JSON.stringify(patch.consensusDetail) : null)
    : undefined);
  assign('risk_check_detail', patch.riskCheckDetail !== undefined
    ? (patch.riskCheckDetail ? JSON.stringify(patch.riskCheckDetail) : null)
    : undefined);
  assign('status', patch.status !== undefined ? normalizeTradeStatus(patch.status) : undefined);
  assign('alpaca_order_id', patch.alpacaOrderId);
  assign('notes', patch.notes);
  assign('filled_at', patch.filledAt);
  assign('reconciled_at', patch.reconciledAt);
  assign('realized_pnl', patch.realizedPnl);
  assign('outcome_recorded_at', patch.outcomeRecordedAt);

  if (updates.length === 0) {
    return current;
  }

  values.push(tradeId);
  db.prepare(`UPDATE trades SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return getTradeById(db, tradeId);
}

/**
 * Get daily summaries for a date range.
 */
function getDailySummaries(db, fromDate, toDate) {
  return db.prepare('SELECT * FROM daily_summary WHERE date >= ? AND date <= ? ORDER BY date').all(fromDate, toDate);
}

/**
 * Get performance stats.
 */
function getPerformanceStats(db) {
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_days,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_days,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losing_days,
      SUM(pnl) as total_pnl,
      AVG(pnl_pct) as avg_daily_return,
      MAX(peak_equity) as all_time_peak,
      MAX(drawdown_pct) as max_drawdown
    FROM daily_summary
  `).get();

  const tradeStats = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN direction = 'BUY' THEN 1 ELSE 0 END) as buys,
      SUM(CASE WHEN direction = 'SELL' THEN 1 ELSE 0 END) as sells
    FROM trades WHERE status = 'FILLED'
  `).get();

  return { ...totals, ...tradeStats };
}

module.exports = {
  closeDb,
  getDb,
  ensureSchema,
  migrateLegacySchemaIfNeeded,
  normalizeTradeStatus,
  recordTrade,
  recordConsensus,
  recordDailySummary,
  upsertPosition,
  closePosition,
  getOpenPositions,
  getRecentTrades,
  getAllTrades,
  getTradeById,
  getPendingTrades,
  updateTrade,
  getDailySummaries,
  getPerformanceStats,
};
