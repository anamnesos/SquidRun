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
const ALLOWED_TRADE_DIRECTIONS = Object.freeze(['BUY', 'SELL', 'SHORT', 'COVER']);
const TRADE_DIRECTION_CHECK_SQL = `CHECK(direction IN (${ALLOWED_TRADE_DIRECTIONS.map((value) => `'${value}'`).join(',')}))`;
const LIVE_SOURCE_SCOPE = 'live';
const DRY_RUN_SOURCE_SCOPE = 'dry_run';
const ARCHIVE_STATIC_SCOPE = 'archive_static';

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
  'source_scope',
  'archived_at',
  'archive_reason',
]);

const POSITION_TABLE_COLUMNS = Object.freeze([
  'id',
  'ticker',
  'shares',
  'avg_price',
  'stop_loss_price',
  'opened_at',
  'updated_at',
  'source_scope',
  'archived_at',
  'archive_reason',
]);

const TRADES_TABLE_SQL = `
  CREATE TABLE trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    ticker TEXT NOT NULL,
    direction TEXT NOT NULL ${TRADE_DIRECTION_CHECK_SQL},
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
    outcome_recorded_at TEXT,
    source_scope TEXT NOT NULL DEFAULT 'live',
    archived_at TEXT,
    archive_reason TEXT
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
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    source_scope TEXT NOT NULL DEFAULT 'live',
    archived_at TEXT,
    archive_reason TEXT
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
      direction TEXT NOT NULL ${TRADE_DIRECTION_CHECK_SQL},
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      source_scope TEXT NOT NULL DEFAULT 'live',
      archived_at TEXT,
      archive_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS execution_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      market_date TEXT,
      phase TEXT NOT NULL,
      report_type TEXT,
      ticker TEXT NOT NULL,
      direction TEXT,
      broker TEXT,
      asset_class TEXT,
      status TEXT,
      ok INTEGER NOT NULL DEFAULT 0,
      trade_id INTEGER,
      entry_price REAL,
      exit_price REAL,
      realized_pnl REAL,
      confidence REAL,
      report_json TEXT NOT NULL
    );
  `);

  migrateLegacySchemaIfNeeded(db);
  ensureColumnExists(db, 'trades', 'filled_at', 'TEXT');
  ensureColumnExists(db, 'trades', 'reconciled_at', 'TEXT');
  ensureColumnExists(db, 'trades', 'realized_pnl', 'REAL');
  ensureColumnExists(db, 'trades', 'outcome_recorded_at', 'TEXT');
  ensureColumnExists(db, 'trades', 'source_scope', "TEXT NOT NULL DEFAULT 'live'");
  ensureColumnExists(db, 'trades', 'archived_at', 'TEXT');
  ensureColumnExists(db, 'trades', 'archive_reason', 'TEXT');
  ensureColumnExists(db, 'positions', 'source_scope', "TEXT NOT NULL DEFAULT 'live'");
  ensureColumnExists(db, 'positions', 'archived_at', 'TEXT');
  ensureColumnExists(db, 'positions', 'archive_reason', 'TEXT');
  ensureColumnExists(db, 'daily_summary', 'best_trade_ticker', 'TEXT');
  ensureColumnExists(db, 'daily_summary', 'best_trade_pnl', 'REAL');
  ensureColumnExists(db, 'daily_summary', 'worst_trade_ticker', 'TEXT');
  ensureColumnExists(db, 'daily_summary', 'worst_trade_pnl', 'REAL');
  ensureColumnExists(db, 'execution_reports', 'report_type', 'TEXT');
  ensureColumnExists(db, 'execution_reports', 'entry_price', 'REAL');
  ensureColumnExists(db, 'execution_reports', 'exit_price', 'REAL');
  ensureColumnExists(db, 'execution_reports', 'realized_pnl', 'REAL');
  ensureColumnExists(db, 'execution_reports', 'confidence', 'REAL');
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

function normalizeSourceScope(value, fallback = LIVE_SOURCE_SCOPE) {
  const normalized = String(value || fallback || LIVE_SOURCE_SCOPE)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback || LIVE_SOURCE_SCOPE;
}

// Keep non-live filters after the one-time cleanup: future DRY_RUN/test rows
// must stay inert unless a caller explicitly opts into archived/non-live state.
function buildTradeVisibilityWhere(options = {}) {
  const includeArchived = options.includeArchived === true;
  const includeNonLive = options.includeNonLive === true || includeArchived;
  const includeDryRun = options.includeDryRun === true || includeArchived;
  const clauses = [];
  if (!includeArchived) {
    clauses.push('archived_at IS NULL');
  }
  if (!includeNonLive) {
    clauses.push("COALESCE(source_scope, 'live') = 'live'");
  }
  if (!includeDryRun) {
    clauses.push("UPPER(COALESCE(status, '')) <> 'DRY_RUN'");
  }
  return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
}

function buildPositionVisibilityWhere(options = {}) {
  const includeArchived = options.includeArchived === true;
  const includeNonLive = options.includeNonLive === true || includeArchived;
  const clauses = [];
  if (!includeArchived) {
    clauses.push('archived_at IS NULL');
  }
  if (!includeNonLive) {
    clauses.push("COALESCE(source_scope, 'live') = 'live'");
  }
  return clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
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
  const hasLegacyStatusCheck = /\bstatus\s+TEXT\b[^,]*\bCHECK\s*\(\s*status\s+IN\s*\(/i.test(normalized);
  const directionMatch = normalized.match(/\bdirection\s+TEXT\b[^,]*\bCHECK\s*\(\s*direction\s+IN\s*\(([^)]*)\)\)/i);
  const directionSql = String(directionMatch?.[1] || '');
  const missingDirection = ALLOWED_TRADE_DIRECTIONS.some((direction) => !new RegExp(`'${direction}'`, 'i').test(directionSql));
  return hasLegacyStatusCheck || missingDirection;
}

function requiresPositionsMigration(tableSql = '') {
  const normalized = String(tableSql || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return /\bshares\s+INTEGER\b/i.test(normalized);
}

function getBrokerOrderId(record = {}) {
  return record.brokerOrderId || record.alpacaOrderId || null;
}

/**
 * Record a trade execution.
 */
function recordTrade(db, trade) {
  const direction = String(trade.direction || '').trim().toUpperCase();
  if (!ALLOWED_TRADE_DIRECTIONS.includes(direction)) {
    throw new Error(`Unsupported trade direction for journal: ${trade.direction}`);
  }
  const status = normalizeTradeStatus(trade.status);
  const sourceScope = normalizeSourceScope(
    trade.sourceScope || (status === 'DRY_RUN' ? DRY_RUN_SOURCE_SCOPE : LIVE_SOURCE_SCOPE)
  );
  const stmt = db.prepare(`
    INSERT INTO trades (
      ticker,
      direction,
      shares,
      price,
      stop_loss_price,
      total_value,
      consensus_detail,
      risk_check_detail,
      status,
      alpaca_order_id,
      notes,
      source_scope
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    trade.ticker,
    direction,
    trade.shares,
    trade.price,
    trade.stopLossPrice || null,
    trade.shares * trade.price,
    trade.consensusDetail ? JSON.stringify(trade.consensusDetail) : null,
    trade.riskCheckDetail ? JSON.stringify(trade.riskCheckDetail) : null,
    status,
    getBrokerOrderId(trade),
    trade.notes || null,
    sourceScope,
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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

function recordExecutionReport(db, report = {}) {
  const payload = {
    ...report,
    timestamp: report.timestamp || new Date().toISOString(),
  };
  const entryPrice = Number.isFinite(Number(
    payload.entryPrice
      ?? payload.referencePrice
      ?? payload.postTradeReport?.entry?.price
      ?? payload.execution?.entryPrice
      ?? payload.execution?.referencePrice
  ))
    ? Number(
      payload.entryPrice
        ?? payload.referencePrice
        ?? payload.postTradeReport?.entry?.price
        ?? payload.execution?.entryPrice
        ?? payload.execution?.referencePrice
    )
    : null;
  const exitPrice = Number.isFinite(Number(
    payload.exitPrice
      ?? payload.postTradeReport?.exit?.price
      ?? payload.execution?.exitPrice
  ))
    ? Number(
      payload.exitPrice
        ?? payload.postTradeReport?.exit?.price
        ?? payload.execution?.exitPrice
    )
    : null;
  const realizedPnl = Number.isFinite(Number(payload.realizedPnl ?? payload.postTradeReport?.realizedPnl))
    ? Number(payload.realizedPnl ?? payload.postTradeReport?.realizedPnl)
    : null;
  const confidence = Number.isFinite(Number(
    payload.confidence
      ?? payload.consensus?.averageAgreeConfidence
      ?? payload.consensus?.confidence
      ?? payload.postTradeReport?.confidence
  ))
    ? Number(
      payload.confidence
        ?? payload.consensus?.averageAgreeConfidence
        ?? payload.consensus?.confidence
        ?? payload.postTradeReport?.confidence
    )
    : null;
  const stmt = db.prepare(`
    INSERT INTO execution_reports (
      timestamp,
      market_date,
      phase,
      report_type,
      ticker,
      direction,
      broker,
      asset_class,
      status,
      ok,
      trade_id,
      entry_price,
      exit_price,
      realized_pnl,
      confidence,
      report_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    payload.timestamp,
    payload.marketDate || null,
    payload.phase || 'unknown',
    payload.reportType || null,
    payload.ticker || '',
    payload.direction || null,
    payload.broker || null,
    payload.assetClass || null,
    payload.status || null,
    payload.ok ? 1 : 0,
    payload.tradeId ?? null,
    entryPrice,
    exitPrice,
    realizedPnl,
    confidence,
    JSON.stringify(payload)
  );
}

function getExecutionReports(db, limit = 50) {
  return db.prepare(`
    SELECT *
    FROM execution_reports
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Update or insert a position.
 */
function upsertPosition(db, position) {
  const sourceScope = normalizeSourceScope(position.sourceScope || LIVE_SOURCE_SCOPE);
  const stmt = db.prepare(`
    INSERT INTO positions (
      ticker,
      shares,
      avg_price,
      stop_loss_price,
      opened_at,
      updated_at,
      source_scope,
      archived_at,
      archive_reason
    )
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?, NULL, NULL)
    ON CONFLICT(ticker) DO UPDATE SET
      shares = excluded.shares,
      avg_price = excluded.avg_price,
      stop_loss_price = excluded.stop_loss_price,
      source_scope = excluded.source_scope,
      archived_at = NULL,
      archive_reason = NULL,
      updated_at = datetime('now')
  `);
  return stmt.run(
    position.ticker,
    position.shares,
    position.avgPrice,
    position.stopLossPrice || null,
    sourceScope,
  );
}

/**
 * Remove a closed position.
 */
function closePosition(db, ticker) {
  return db.prepare('DELETE FROM positions WHERE ticker = ?').run(ticker);
}

/**
 * Mark a position as archived/static so it cannot leak into live-position reasoning.
 */
function archivePosition(db, ticker, reason = 'stale_non_live_position', options = {}) {
  const archivedAt = options.archivedAt || new Date().toISOString();
  const sourceScope = normalizeSourceScope(options.sourceScope || ARCHIVE_STATIC_SCOPE, ARCHIVE_STATIC_SCOPE);
  return db.prepare(`
    UPDATE positions
    SET
      source_scope = ?,
      archived_at = ?,
      archive_reason = ?,
      updated_at = datetime('now')
    WHERE UPPER(ticker) = UPPER(?)
  `).run(sourceScope, archivedAt, reason, ticker);
}

function archiveDryRunTrades(db, options = {}) {
  const archivedAt = options.archivedAt || new Date().toISOString();
  const reason = options.reason || 'dry_run_cleanup';
  const clauses = ["UPPER(COALESCE(status, '')) = 'DRY_RUN'"];
  const values = [DRY_RUN_SOURCE_SCOPE, archivedAt, reason];
  if (options.includeAlreadyArchived !== true) {
    clauses.push('archived_at IS NULL');
  }
  if (options.ticker) {
    clauses.push('UPPER(ticker) = UPPER(?)');
    values.push(options.ticker);
  }
  if (options.since) {
    clauses.push('timestamp >= ?');
    values.push(options.since);
  }
  if (options.until) {
    clauses.push('timestamp < ?');
    values.push(options.until);
  }
  return db.prepare(`
    UPDATE trades
    SET
      source_scope = ?,
      archived_at = ?,
      archive_reason = ?
    WHERE ${clauses.join(' AND ')}
  `).run(...values);
}

/**
 * Get live open positions by default. Archived/static rows require includeArchived.
 */
function getOpenPositions(db, options = {}) {
  const visibilityWhere = buildPositionVisibilityWhere(options);
  return db.prepare(`SELECT * FROM positions ${visibilityWhere} ORDER BY ticker`).all();
}

/**
 * Get recent live trades. Archived/static and DRY_RUN rows are hidden by default.
 */
function getRecentTrades(db, limit = 10, options = {}) {
  const visibilityWhere = buildTradeVisibilityWhere(options);
  return db.prepare(`SELECT * FROM trades ${visibilityWhere} ORDER BY timestamp DESC LIMIT ?`).all(limit);
}

function getAllTrades(db, options = {}) {
  const visibilityWhere = buildTradeVisibilityWhere(options);
  return db.prepare(`SELECT * FROM trades ${visibilityWhere} ORDER BY timestamp ASC, id ASC`).all();
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
      AND archived_at IS NULL
      AND COALESCE(source_scope, 'live') = 'live'
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
  assign('alpaca_order_id', patch.brokerOrderId !== undefined ? patch.brokerOrderId : patch.alpacaOrderId);
  assign('notes', patch.notes);
  assign('filled_at', patch.filledAt);
  assign('reconciled_at', patch.reconciledAt);
  assign('realized_pnl', patch.realizedPnl);
  assign('outcome_recorded_at', patch.outcomeRecordedAt);
  assign('source_scope', patch.sourceScope !== undefined ? normalizeSourceScope(patch.sourceScope) : undefined);
  assign('archived_at', patch.archivedAt);
  assign('archive_reason', patch.archiveReason);

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
      SUM(CASE WHEN direction = 'SELL' THEN 1 ELSE 0 END) as sells,
      SUM(CASE WHEN direction = 'SHORT' THEN 1 ELSE 0 END) as shorts,
      SUM(CASE WHEN direction = 'COVER' THEN 1 ELSE 0 END) as covers
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
  normalizeSourceScope,
  recordTrade,
  recordConsensus,
  recordDailySummary,
  recordExecutionReport,
  upsertPosition,
  closePosition,
  archivePosition,
  archiveDryRunTrades,
  getOpenPositions,
  getRecentTrades,
  getAllTrades,
  getExecutionReports,
  getTradeById,
  getPendingTrades,
  updateTrade,
  getDailySummaries,
  getPerformanceStats,
};
