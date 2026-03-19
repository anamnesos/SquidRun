/**
 * Risk Engine — Hard limits that are NEVER overridden.
 *
 * Enforces per-trade, per-day, and per-account risk limits.
 * The kill switch triggers at 20% drawdown from peak equity.
 */

'use strict';

/**
 * @typedef {Object} RiskLimits
 * @property {number} maxPositionPct - Max % of account per trade (default 0.05 = 5%)
 * @property {number} stopLossPct - Stop loss per position (default 0.03 = 3%)
 * @property {number} maxDailyLossPct - Max daily loss before pause (default 0.10 = 10%)
 * @property {number} maxDrawdownPct - Kill switch drawdown from peak (default 0.20 = 20%)
 * @property {number} maxTradesPerDay - Max trades per day (default 3)
 * @property {number} maxOpenPositions - Max concurrent positions (default 3)
 * @property {number} minStockPrice - Min stock price (default 5)
 * @property {number} minMarketCap - Min market cap in billions (default 1)
 * @property {boolean} allowLeverage - Never true
 * @property {boolean} allowShorting - Never true
 * @property {boolean} allowOptions - Never true
 */

const DEFAULT_LIMITS = Object.freeze({
  maxPositionPct: 0.05,
  stopLossPct: 0.03,
  maxDailyLossPct: 0.10,
  maxDrawdownPct: 0.20,
  maxTradesPerDay: 3,
  maxOpenPositions: 3,
  minStockPrice: 5,
  minMarketCap: 1_000_000_000,
  allowLeverage: false,
  allowShorting: false,
  allowOptions: false,
});

const DEFAULT_CRYPTO_LIMITS = Object.freeze({
  ...DEFAULT_LIMITS,
  maxPositionPct: 0.03,
  stopLossPct: 0.04,
  minStockPrice: 0,
  minMarketCap: 0,
});

function normalizeAssetClass(value, fallback = 'us_equity') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === 'crypto' ? 'crypto' : 'us_equity';
}

function resolveRiskLimits(limits = DEFAULT_LIMITS, assetClass = 'us_equity') {
  const normalizedAssetClass = normalizeAssetClass(assetClass);
  const customLimits = limits && limits !== DEFAULT_LIMITS ? limits : {};
  if (normalizedAssetClass === 'crypto') {
    return {
      ...DEFAULT_CRYPTO_LIMITS,
      ...customLimits,
      assetClass: normalizedAssetClass,
    };
  }

  return {
    ...DEFAULT_LIMITS,
    ...customLimits,
    assetClass: normalizedAssetClass,
  };
}

function roundDownQuantity(value, decimals = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  const factor = 10 ** decimals;
  return Math.floor(numeric * factor) / factor;
}

/**
 * @typedef {Object} AccountState
 * @property {number} equity - Current account equity
 * @property {number} peakEquity - Highest equity ever recorded
 * @property {number} dayStartEquity - Equity at start of trading day
 * @property {number} tradesToday - Number of trades executed today
 * @property {Object[]} openPositions - Current open positions
 */

/**
 * @typedef {Object} RiskCheck
 * @property {boolean} approved
 * @property {string[]} violations - Reasons for rejection (empty if approved)
 * @property {number|null} maxShares - Max shares allowed for this trade (null if rejected)
 * @property {number|null} stopLossPrice - Calculated stop loss price
 */

/**
 * Check if a proposed trade passes all risk limits.
 * @param {Object} trade - Proposed trade
 * @param {string} trade.ticker
 * @param {'BUY'|'SELL'} trade.direction
 * @param {number} trade.price - Current price per share
 * @param {number} [trade.marketCap] - Market cap (optional, skips check if missing)
 * @param {AccountState} account
 * @param {RiskLimits} [limits]
 * @returns {RiskCheck}
 */
function checkTrade(trade, account, limits = DEFAULT_LIMITS) {
  const assetClass = normalizeAssetClass(trade.assetClass || trade.asset_class);
  const effectiveLimits = resolveRiskLimits(limits, assetClass);
  const violations = [];

  // --- ABSOLUTE PROHIBITIONS ---
  const normTicker = (t) => String(t || '').replace(/[\/\-]/g, '').toUpperCase();
  const tradeTicker = normTicker(trade.ticker);
  if (trade.direction === 'SELL' && !account.openPositions?.some(p => normTicker(p.ticker) === tradeTicker)) {
    // Shorting check — can only sell what we own
    violations.push('SHORT_PROHIBITED: Cannot sell a stock we do not own');
  }

  if (assetClass !== 'crypto' && trade.price < effectiveLimits.minStockPrice) {
    violations.push(`PENNY_STOCK: Price $${trade.price} below minimum $${effectiveLimits.minStockPrice}`);
  }

  if (assetClass !== 'crypto' && trade.marketCap != null && trade.marketCap < effectiveLimits.minMarketCap) {
    violations.push(`SMALL_CAP: Market cap $${trade.marketCap} below minimum $${effectiveLimits.minMarketCap}`);
  }

  // --- KILL SWITCH ---
  const drawdownPct = account.peakEquity > 0
    ? (account.peakEquity - account.equity) / account.peakEquity
    : 0;
  if (drawdownPct >= effectiveLimits.maxDrawdownPct) {
    violations.push(`KILL_SWITCH: Account down ${(drawdownPct * 100).toFixed(1)}% from peak (limit: ${effectiveLimits.maxDrawdownPct * 100}%)`);
  }

  // --- DAILY LOSS LIMIT ---
  const dayLossPct = account.dayStartEquity > 0
    ? (account.dayStartEquity - account.equity) / account.dayStartEquity
    : 0;
  if (dayLossPct >= effectiveLimits.maxDailyLossPct) {
    violations.push(`DAILY_LOSS: Down ${(dayLossPct * 100).toFixed(1)}% today (limit: ${effectiveLimits.maxDailyLossPct * 100}%)`);
  }

  // --- TRADE COUNT ---
  if (account.tradesToday >= effectiveLimits.maxTradesPerDay) {
    violations.push(`MAX_TRADES: ${account.tradesToday} trades today (limit: ${effectiveLimits.maxTradesPerDay})`);
  }

  // --- POSITION COUNT ---
  if (trade.direction === 'BUY') {
    const openCount = account.openPositions?.length || 0;
    if (openCount >= effectiveLimits.maxOpenPositions) {
      violations.push(`MAX_POSITIONS: ${openCount} open positions (limit: ${effectiveLimits.maxOpenPositions})`);
    }
  }

  // --- POSITION SIZE ---
  const maxDollars = account.equity * effectiveLimits.maxPositionPct;
  const maxShares = trade.price > 0
    ? (assetClass === 'crypto'
      ? roundDownQuantity(maxDollars / trade.price, 6)
      : Math.floor(maxDollars / trade.price))
    : 0;

  if (trade.direction === 'BUY' && maxShares <= 0) {
    const minimumQuantityText = assetClass === 'crypto' ? 'the minimum crypto quantity' : '1 share';
    violations.push(`POSITION_TOO_SMALL: Max position $${maxDollars.toFixed(2)} cannot buy ${minimumQuantityText} at $${trade.price}`);
  }

  // --- STOP LOSS CALCULATION ---
  const stopLossPrice = trade.direction === 'BUY'
    ? trade.price * (1 - effectiveLimits.stopLossPct)
    : null;

  return {
    approved: violations.length === 0,
    violations,
    maxShares: violations.length === 0 ? maxShares : null,
    stopLossPrice,
  };
}

/**
 * Check if the kill switch should trigger (go 100% cash).
 * @param {AccountState} account
 * @param {RiskLimits} [limits]
 * @returns {{ triggered: boolean, drawdownPct: number, message: string }}
 */
function checkKillSwitch(account, limits = DEFAULT_LIMITS) {
  const effectiveLimits = resolveRiskLimits(limits, limits?.assetClass);
  const drawdownPct = account.peakEquity > 0
    ? (account.peakEquity - account.equity) / account.peakEquity
    : 0;
  const triggered = drawdownPct >= effectiveLimits.maxDrawdownPct;
  return {
    triggered,
    drawdownPct,
    message: triggered
      ? `KILL SWITCH: Portfolio down ${(drawdownPct * 100).toFixed(1)}% from peak $${account.peakEquity.toFixed(2)}. Selling all positions.`
      : `Drawdown: ${(drawdownPct * 100).toFixed(1)}% (limit: ${effectiveLimits.maxDrawdownPct * 100}%)`,
  };
}

/**
 * Check if trading should pause for the day.
 * @param {AccountState} account
 * @param {RiskLimits} [limits]
 * @returns {{ paused: boolean, dayLossPct: number, message: string }}
 */
function checkDailyPause(account, limits = DEFAULT_LIMITS) {
  const effectiveLimits = resolveRiskLimits(limits, limits?.assetClass);
  const dayLossPct = account.dayStartEquity > 0
    ? (account.dayStartEquity - account.equity) / account.dayStartEquity
    : 0;
  const paused = dayLossPct >= effectiveLimits.maxDailyLossPct;
  return {
    paused,
    dayLossPct,
    message: paused
      ? `DAILY PAUSE: Down ${(dayLossPct * 100).toFixed(1)}% today. No more trades until tomorrow.`
      : `Day P&L: ${dayLossPct > 0 ? '-' : '+'}${(Math.abs(dayLossPct) * 100).toFixed(1)}%`,
  };
}

module.exports = {
  DEFAULT_LIMITS,
  DEFAULT_CRYPTO_LIMITS,
  resolveRiskLimits,
  checkTrade,
  checkKillSwitch,
  checkDailyPause,
};
