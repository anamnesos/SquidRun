'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCoordPath } = require('../../config');

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ago(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const abs = Math.abs(ms);
  const future = ms < 0;
  const seconds = Math.floor(abs / 1000);
  if (seconds < 60) return future ? `in ${seconds}s` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  const label = remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
  if (hours < 24) return future ? `in ${label}` : `${label} ago`;
  const days = Math.floor(hours / 24);
  const dayLabel = `${days}d ${hours % 24}h`;
  return future ? `in ${dayLabel}` : `${dayLabel} ago`;
}

function formatPT(date) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Returns a complete time orientation snapshot.
 * Call this after every context compaction or at the start of any time-sensitive operation.
 */
function getTimeOrientation() {
  const now = Date.now();
  const nowPT = formatPT(now);

  const result = {
    now: new Date(now).toISOString(),
    nowPT,
    nowUnixMs: now,
    supervisor: null,
    lastCryptoTrade: null,
    lastStockTrade: null,
    nextCryptoEvent: null,
    nextStockEvent: null,
    positions: null,
    walletLastChecked: null,
  };

  // Supervisor status
  const statusPath = resolveCoordPath(path.join('runtime', 'supervisor-status.json'), { forWrite: false });
  const status = readJsonSafe(statusPath);
  if (status) {
    const heartbeatAge = now - (status.heartbeatAtMs || 0);
    result.supervisor = {
      pid: status.pid,
      alive: heartbeatAge < 60_000,
      heartbeat: ago(heartbeatAge),
      uptime: ago(now - (status.startedAtMs || now)),
    };
  }

  // Crypto trading state
  const cryptoStatePath = resolveCoordPath(path.join('runtime', 'crypto-trading-supervisor-state.json'), { forWrite: false });
  const cryptoState = readJsonSafe(cryptoStatePath);
  if (cryptoState) {
    if (cryptoState.lastProcessedAt) {
      const lastMs = Date.parse(cryptoState.lastProcessedAt);
      result.lastCryptoTrade = {
        at: formatPT(lastMs),
        ago: ago(now - lastMs),
        iso: cryptoState.lastProcessedAt,
        approvedTrades: cryptoState.lastResult?.summary?.approvedTrades ?? null,
      };
    }
    if (cryptoState.nextEvent) {
      const nextMs = Date.parse(cryptoState.nextEvent.scheduledAt);
      result.nextCryptoEvent = {
        at: formatPT(nextMs),
        inMs: nextMs - now,
        in: ago(now - nextMs),
        label: cryptoState.nextEvent.label,
      };
    }
  }

  // Stock trading state
  const tradingStatePath = resolveCoordPath(path.join('runtime', 'trading-supervisor-state.json'), { forWrite: false });
  const tradingState = readJsonSafe(tradingStatePath);
  if (tradingState) {
    if (tradingState.nextEvent) {
      const nextMs = Date.parse(tradingState.nextEvent.scheduledAt);
      result.nextStockEvent = {
        at: formatPT(nextMs),
        inMs: nextMs - now,
        in: ago(now - nextMs),
        label: tradingState.nextEvent.label,
      };
    }
    result.lastStockTrade = {
      marketDate: tradingState.marketDate,
      sleeping: tradingState.sleeping,
    };
  }

  // Trading journal — last trade
  const journalPath = resolveCoordPath(path.join('runtime', 'trade-journal.db'), { forWrite: false });
  if (fs.existsSync(journalPath)) {
    try {
      const { getDatabaseSync } = require('../sqlite-compat');
      const DatabaseSync = getDatabaseSync();
      const db = new DatabaseSync(journalPath, { open: true, readOnly: true });
      const row = db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT 1').get();
      if (row) {
        const tradeMs = Date.parse(row.created_at);
        result.lastExecutedTrade = {
          ticker: row.ticker,
          direction: row.direction,
          shares: row.shares,
          price: row.price,
          at: formatPT(tradeMs),
          ago: ago(now - tradeMs),
        };
      }
      db.close();
    } catch {
      // Journal may not exist yet or be locked
    }
  }

  return result;
}

/**
 * Prints a human-readable time orientation summary.
 */
function printOrientation() {
  const o = getTimeOrientation();
  const lines = [];
  lines.push(`=== TIME ORIENTATION ===`);
  lines.push(`Now: ${o.nowPT} (${o.now})`);

  if (o.supervisor) {
    lines.push(`Supervisor: PID ${o.supervisor.pid}, ${o.supervisor.alive ? 'ALIVE' : 'DEAD'} (heartbeat ${o.supervisor.heartbeat}), uptime ${o.supervisor.uptime}`);
  }

  if (o.lastCryptoTrade) {
    lines.push(`Last crypto round: ${o.lastCryptoTrade.at} (${o.lastCryptoTrade.ago}) — ${o.lastCryptoTrade.approvedTrades ?? '?'} trades approved`);
  }
  if (o.nextCryptoEvent) {
    lines.push(`Next crypto event: ${o.nextCryptoEvent.at} (${o.nextCryptoEvent.in}) — ${o.nextCryptoEvent.label}`);
  }

  if (o.lastStockTrade) {
    lines.push(`Stock market date: ${o.lastStockTrade.marketDate}, sleeping: ${o.lastStockTrade.sleeping}`);
  }
  if (o.nextStockEvent) {
    lines.push(`Next stock event: ${o.nextStockEvent.at} (${o.nextStockEvent.in}) — ${o.nextStockEvent.label}`);
  }

  if (o.lastExecutedTrade) {
    lines.push(`Last executed trade: ${o.lastExecutedTrade.direction} ${o.lastExecutedTrade.shares} ${o.lastExecutedTrade.ticker} @ $${o.lastExecutedTrade.price} — ${o.lastExecutedTrade.at} (${o.lastExecutedTrade.ago})`);
  } else {
    lines.push(`Last executed trade: none recorded`);
  }

  return lines.join('\n');
}

module.exports = {
  getTimeOrientation,
  printOrientation,
  ago,
  formatPT,
};
