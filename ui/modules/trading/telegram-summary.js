/**
 * Telegram Trading Summary — Formats and sends daily trading reports.
 *
 * Generates end-of-day summaries and kill switch alerts
 * for delivery via the existing hm-send Telegram bridge.
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getProjectRoot } = require('../../config');

function resolveHmSendPath() {
  return path.join(getProjectRoot(), 'ui', 'scripts', 'hm-send.js');
}

function resolveTradingTelegramChatId(env = process.env) {
  const chatId = typeof env?.TELEGRAM_CHAT_ID === 'string' ? env.TELEGRAM_CHAT_ID.trim() : '';
  return chatId || null;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * Send a message to James via Telegram.
 * Uses --file for long messages to avoid truncation.
 * @param {string} message
 */
function sendTelegram(message) {
  const hmSendPath = resolveHmSendPath();
  const cwd = getProjectRoot();
  const chatId = resolveTradingTelegramChatId(process.env);
  if (!chatId) {
    console.warn('Trading Telegram notify suppressed: TELEGRAM_CHAT_ID is not configured.');
    return;
  }
  if (message.length > 400) {
    const tmpFile = path.join(os.tmpdir(), `trading-summary-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, message, 'utf8');
    try {
      execFileSync('node', [hmSendPath, 'telegram', '--file', tmpFile, '--chat-id', chatId], {
        timeout: 15_000,
        cwd,
      });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore */ }
    }
  } else {
    execFileSync('node', [hmSendPath, 'telegram', message, '--chat-id', chatId], {
      timeout: 15_000,
      cwd,
    });
  }
}

/**
 * Format and send the daily trading summary.
 * @param {Object} data
 * @param {string} data.date
 * @param {number} data.equity
 * @param {number} data.pnl
 * @param {number} data.pnlPct
 * @param {Object[]} data.trades - Today's trades
 * @param {Object[]} data.openPositions
 * @param {number} data.peakEquity
 * @param {number} data.weekPnlPct
 * @param {Object} [data.consensusStats]
 */
function sendDailySummary(data) {
  const equity = toNumber(data?.equity, 0);
  const pnl = toNumber(data?.pnl, 0);
  const pnlPct = toNumber(data?.pnlPct, 0);
  const weekPnlPct = toNumber(data?.weekPnlPct, 0);
  const peakEquity = toNumber(data?.peakEquity, 0);
  const sign = pnl >= 0 ? '+' : '';
  const weekSign = weekPnlPct >= 0 ? '+' : '';

  let tradesSection = 'No trades today';
  if (data.trades && data.trades.length > 0) {
    tradesSection = data.trades.map(t =>
      `${t.direction} ${t.shares}x ${t.ticker} @ $${toNumber(t?.price, 0).toFixed(2)}`
    ).join('\n');
  }

  let positionsSection = 'No open positions (100% cash)';
  if (data.openPositions && data.openPositions.length > 0) {
    positionsSection = data.openPositions.map(p =>
      `${p.ticker}: ${toNumber(p?.shares, 0)} shares @ $${toNumber(p?.avgPrice ?? p?.avg_price, 0).toFixed(2)} (stop: $${toNumber(p?.stopLossPrice ?? p?.stop_loss_price, 0).toFixed(2)})`
    ).join('\n');
  }

  let consensusSection = '';
  if (data.consensusStats) {
    const cs = data.consensusStats;
    consensusSection = `\nConsensus: ${cs.unanimous || 0} unanimous, ${cs.majority || 0} majority, ${cs.noConsensus || 0} no-consensus`;
  }

  const message = [
    `Trading Day Summary - ${data.date}`,
    '',
    `Portfolio: $${equity.toFixed(2)} (${sign}${(pnlPct * 100).toFixed(2)}%)`,
    `Day P&L: ${sign}$${pnl.toFixed(2)}`,
    `Week-to-date: ${weekSign}${(weekPnlPct * 100).toFixed(2)}%`,
    `Peak: $${peakEquity.toFixed(2)}`,
    '',
    `Trades:`,
    tradesSection,
    '',
    `Positions:`,
    positionsSection,
    consensusSection,
  ].join('\n');

  sendTelegram(message);
}

/**
 * Send kill switch alert.
 * @param {Object} data
 * @param {number} data.equity
 * @param {number} data.peakEquity
 * @param {number} data.drawdownPct
 */
function sendKillSwitchAlert(data) {
  const message = [
    'KILL SWITCH TRIGGERED',
    '',
    `Portfolio down ${(data.drawdownPct * 100).toFixed(1)}% from peak.`,
    `All positions sold. System paused.`,
    `Current balance: $${data.equity.toFixed(2)}`,
    `Peak was: $${data.peakEquity.toFixed(2)}`,
    '',
    `System will not trade until manually restarted.`,
  ].join('\n');

  sendTelegram(message);
}

/**
 * Send a trade execution notification (optional, for significant trades).
 * @param {Object} trade
 */
function sendTradeNotification(trade) {
  const message = `Trade: ${trade.direction} ${trade.shares}x ${trade.ticker} @ $${trade.price.toFixed(2)}. Consensus: ${trade.consensusSummary}`;
  sendTelegram(message);
}

module.exports = { sendTelegram, sendDailySummary, sendKillSwitchAlert, sendTradeNotification };
