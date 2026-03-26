/**
 * Risk Engine — Hard limits that are NEVER overridden.
 *
 * Enforces per-trade, per-day, and per-account risk limits.
 * The kill switch triggers at 20% drawdown from peak equity.
 */

'use strict';

const { normalizeSignalDirection } = require('./crisis-mode');

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
  maxTradesPerDay: 10,
  minStockPrice: 0,
  minMarketCap: 0,
});

function normalizeAssetClass(value, fallback = 'us_equity') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['crypto', 'prediction_market', 'solana_token', 'defi_yield', 'us_equity'].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function resolveRiskLimits(limits = DEFAULT_LIMITS, assetClass = 'us_equity') {
  const normalizedAssetClass = normalizeAssetClass(assetClass);
  const customLimits = limits && limits !== DEFAULT_LIMITS ? limits : {};
  if (normalizedAssetClass === 'crypto' || normalizedAssetClass === 'prediction_market' || normalizedAssetClass === 'solana_token') {
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

function normalizeTradeDirection(direction, assetClass = 'us_equity') {
  const normalized = normalizeSignalDirection(direction, { fallback: '' });
  if (normalized === 'BUY' || normalized === 'SELL' || normalized === 'HOLD' || normalized === 'SHORT' || normalized === 'COVER' || normalized === 'BUY_PUT') {
    return normalized;
  }
  if (normalizeAssetClass(assetClass) === 'prediction_market' && (normalized === 'BUY_YES' || normalized === 'BUY_NO')) {
    return normalized;
  }
  return normalized;
}

function normalizeOpenPosition(position = {}) {
  return {
    ...position,
    ticker: String(position.ticker || position.symbol || position.market || position.tokenId || '').trim().toUpperCase(),
    shares: Number(position.shares ?? position.qty ?? position.size ?? 0) || 0,
    assetClass: normalizeAssetClass(position.assetClass || position.asset_class, 'us_equity'),
  };
}

function normalizeAccountState(account = {}) {
  if (account && typeof account === 'object' && (
    account.totalEquity != null
    || account.risk
    || account.markets
    || Array.isArray(account.positions)
  )) {
    const totalEquity = Number(account.totalEquity ?? account.equity ?? 0) || 0;
    const peakEquity = Number(account.risk?.peakEquity ?? account.peakEquity ?? totalEquity) || totalEquity;
    const dayStartEquity = Number(account.risk?.dayStartEquity ?? account.dayStartEquity ?? totalEquity) || totalEquity;
    return {
      equity: totalEquity,
      peakEquity,
      dayStartEquity,
      tradesToday: Number(account.tradesToday || 0) || 0,
      openPositions: Array.isArray(account.positions) ? account.positions.map(normalizeOpenPosition) : [],
    };
  }

  return {
    equity: Number(account?.equity || 0) || 0,
    peakEquity: Number(account?.peakEquity || account?.equity || 0) || 0,
    dayStartEquity: Number(account?.dayStartEquity || account?.equity || 0) || 0,
    tradesToday: Number(account?.tradesToday || 0) || 0,
    openPositions: Array.isArray(account?.openPositions) ? account.openPositions.map(normalizeOpenPosition) : [],
  };
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
  const normalizedAccount = normalizeAccountState(account);
  const direction = normalizeTradeDirection(trade.direction, assetClass);
  const effectiveLimits = resolveRiskLimits(limits, assetClass);
  const violations = [];
  const isBuyExposure = direction === 'BUY' || direction === 'BUY_YES' || direction === 'BUY_NO';

  // --- ABSOLUTE PROHIBITIONS ---
  const normTicker = (t) => String(t || '').replace(/[\/\-]/g, '').toUpperCase();
  const tradeTicker = normTicker(trade.ticker);
  if (direction === 'SELL' && !normalizedAccount.openPositions?.some(p => normTicker(p.ticker) === tradeTicker)) {
    // Shorting check — can only sell what we own
    violations.push('SHORT_PROHIBITED: Cannot sell a stock we do not own');
  }
  if (direction === 'SHORT' && effectiveLimits.allowShorting !== true) {
    violations.push('SHORT_PROHIBITED: Crisis short execution is disabled until phase 2');
  }
  if (direction === 'COVER') {
    violations.push('COVER_PROHIBITED: Crisis short cover flow is disabled until phase 2');
  }
  if (direction === 'BUY_PUT' && effectiveLimits.allowOptions !== true) {
    violations.push('OPTIONS_PROHIBITED: BUY_PUT execution is disabled until phase 2');
  }

  if (assetClass === 'us_equity' && trade.price < effectiveLimits.minStockPrice) {
    violations.push(`PENNY_STOCK: Price $${trade.price} below minimum $${effectiveLimits.minStockPrice}`);
  }

  if (assetClass === 'us_equity' && trade.marketCap != null && trade.marketCap < effectiveLimits.minMarketCap) {
    violations.push(`SMALL_CAP: Market cap $${trade.marketCap} below minimum $${effectiveLimits.minMarketCap}`);
  }

  // --- KILL SWITCH ---
  const drawdownPct = normalizedAccount.peakEquity > 0
    ? (normalizedAccount.peakEquity - normalizedAccount.equity) / normalizedAccount.peakEquity
    : 0;
  if (drawdownPct >= effectiveLimits.maxDrawdownPct) {
    violations.push(`KILL_SWITCH: Account down ${(drawdownPct * 100).toFixed(1)}% from peak (limit: ${effectiveLimits.maxDrawdownPct * 100}%)`);
  }

  // --- DAILY LOSS LIMIT ---
  const dayLossPct = normalizedAccount.dayStartEquity > 0
    ? (normalizedAccount.dayStartEquity - normalizedAccount.equity) / normalizedAccount.dayStartEquity
    : 0;
  if (dayLossPct >= effectiveLimits.maxDailyLossPct) {
    violations.push(`DAILY_LOSS: Down ${(dayLossPct * 100).toFixed(1)}% today (limit: ${effectiveLimits.maxDailyLossPct * 100}%)`);
  }

  // --- TRADE COUNT ---
  if (normalizedAccount.tradesToday >= effectiveLimits.maxTradesPerDay) {
    violations.push(`MAX_TRADES: ${normalizedAccount.tradesToday} trades today (limit: ${effectiveLimits.maxTradesPerDay})`);
  }

  // --- POSITION COUNT ---
  if (isBuyExposure) {
    const openCount = normalizedAccount.openPositions?.length || 0;
    if (openCount >= effectiveLimits.maxOpenPositions) {
      violations.push(`MAX_POSITIONS: ${openCount} open positions (limit: ${effectiveLimits.maxOpenPositions})`);
    }
  }

  // --- POSITION SIZE ---
  const maxDollars = normalizedAccount.equity * effectiveLimits.maxPositionPct;
  const maxShares = trade.price > 0
    ? (assetClass === 'crypto'
      ? roundDownQuantity(maxDollars / trade.price, 6)
      : (assetClass === 'prediction_market'
        ? roundDownQuantity(maxDollars / trade.price, 4)
      : Math.floor(maxDollars / trade.price))
    )
    : 0;

  if (isBuyExposure && maxShares <= 0) {
    const minimumQuantityText = assetClass === 'crypto' ? 'the minimum crypto quantity' : '1 share';
    violations.push(`POSITION_TOO_SMALL: Max position $${maxDollars.toFixed(2)} cannot buy ${minimumQuantityText} at $${trade.price}`);
  }

  // --- MINIMUM NOTIONAL (Alpaca crypto requires >= $10 per order) ---
  if (assetClass === 'crypto' && direction === 'SELL' && trade.price > 0) {
    const position = normalizedAccount.openPositions?.find(p => normTicker(p.ticker) === tradeTicker);
    const positionValue = (position?.shares || 0) * trade.price;
    if (positionValue > 0 && positionValue < 10) {
      violations.push(`DUST_POSITION: ${tradeTicker} position worth $${positionValue.toFixed(2)} below $10 minimum order`);
    }
  }

  // --- STOP LOSS CALCULATION ---
  const stopLossPrice = isBuyExposure
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
  const normalizedAccount = normalizeAccountState(account);
  const effectiveLimits = resolveRiskLimits(limits, limits?.assetClass);
  const drawdownPct = normalizedAccount.peakEquity > 0
    ? (normalizedAccount.peakEquity - normalizedAccount.equity) / normalizedAccount.peakEquity
    : 0;
  const triggered = drawdownPct >= effectiveLimits.maxDrawdownPct;
  return {
    triggered,
    drawdownPct,
    message: triggered
      ? `KILL SWITCH: Portfolio down ${(drawdownPct * 100).toFixed(1)}% from peak $${normalizedAccount.peakEquity.toFixed(2)}. Selling all positions.`
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
  const normalizedAccount = normalizeAccountState(account);
  const effectiveLimits = resolveRiskLimits(limits, limits?.assetClass);
  const dayLossPct = normalizedAccount.dayStartEquity > 0
    ? (normalizedAccount.dayStartEquity - normalizedAccount.equity) / normalizedAccount.dayStartEquity
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
  normalizeAccountState,
  resolveRiskLimits,
  checkTrade,
  checkKillSwitch,
  checkDailyPause,
};
