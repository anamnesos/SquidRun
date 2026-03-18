'use strict';

const DEFAULT_MAX_POSITION_PCT = 0.15;
const DEFAULT_MAX_TOTAL_EXPOSURE_PCT = 0.8;
const DEFAULT_MAX_CONCURRENT_POSITIONS = 5;
const DEFAULT_MIN_BET = 1;
const DEFAULT_STOP_LOSS_PCT = 0.2;
const DEFAULT_MAX_DAILY_LOSS_PCT = 0.25;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundDown(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.floor(toNumber(value, 0) * factor) / factor;
}

function kellyFraction(probability, marketPrice) {
  const p = clamp(toNumber(probability, 0), 0, 1);
  const price = clamp(toNumber(marketPrice, 0), 0.0001, 0.9999);
  const b = (1 - price) / price;
  const q = 1 - p;
  const fraction = ((b * p) - q) / b;
  return Number(fraction.toFixed(6));
}

function positionSize(bankroll, probability, marketPrice, options = {}) {
  const bankrollValue = Math.max(0, toNumber(bankroll, 0));
  const rawKelly = kellyFraction(probability, marketPrice);
  const halfKellyFraction = Math.max(0, rawKelly / 2);
  const maxPositionPct = clamp(toNumber(options.maxPositionPct, DEFAULT_MAX_POSITION_PCT), 0, 1);
  const maxTotalExposurePct = clamp(toNumber(options.maxTotalExposurePct, DEFAULT_MAX_TOTAL_EXPOSURE_PCT), 0, 1);
  const minBet = Math.max(0, toNumber(options.minBet, DEFAULT_MIN_BET));
  const openPositions = Array.isArray(options.openPositions) ? options.openPositions : [];
  const currentExposure = Math.max(0, toNumber(
    options.currentExposure,
    openPositions.reduce((sum, position) => sum + Math.max(0, toNumber(position.costBasis, position.sizeUsd)), 0)
  ));
  const exposureFraction = bankrollValue > 0 ? currentExposure / bankrollValue : 0;
  const remainingExposurePct = Math.max(0, maxTotalExposurePct - exposureFraction);
  const maxConcurrentPositions = Math.max(1, Math.floor(toNumber(options.maxConcurrentPositions, DEFAULT_MAX_CONCURRENT_POSITIONS)));
  const dailyLossPct = Math.max(0, toNumber(options.dailyLossPct, 0));
  const maxDailyLossPct = clamp(toNumber(options.maxDailyLossPct, DEFAULT_MAX_DAILY_LOSS_PCT), 0, 1);

  const cappedFraction = Math.min(halfKellyFraction, maxPositionPct, remainingExposurePct);
  const stake = roundDown(bankrollValue * cappedFraction, 2);
  const shareCount = marketPrice > 0 ? roundDown(stake / toNumber(marketPrice, 0.01), 4) : 0;
  const reasons = [];

  if (bankrollValue <= 0) reasons.push('Bankroll is zero');
  if (rawKelly <= 0) reasons.push('No positive edge after Kelly calculation');
  if (openPositions.length >= maxConcurrentPositions) reasons.push(`Concurrent position cap reached (${maxConcurrentPositions})`);
  if (dailyLossPct >= maxDailyLossPct) reasons.push(`Daily loss pause active at ${(dailyLossPct * 100).toFixed(1)}%`);
  if (remainingExposurePct <= 0) reasons.push(`Total exposure cap reached (${(maxTotalExposurePct * 100).toFixed(1)}%)`);
  if (stake > 0 && stake < minBet) reasons.push(`Stake $${stake.toFixed(2)} is below the minimum bet of $${minBet.toFixed(2)}`);

  const executable = reasons.length === 0 && stake >= minBet && shareCount > 0;

  return {
    executable,
    bankroll: bankrollValue,
    probability: Number(toNumber(probability, 0).toFixed(4)),
    marketPrice: Number(toNumber(marketPrice, 0).toFixed(4)),
    rawKellyFraction: rawKelly,
    halfKellyFraction: Number(halfKellyFraction.toFixed(6)),
    targetFraction: Number(cappedFraction.toFixed(6)),
    maxPositionPct,
    maxTotalExposurePct,
    remainingExposurePct: Number(remainingExposurePct.toFixed(6)),
    currentExposure: Number(currentExposure.toFixed(2)),
    stake,
    shares: shareCount,
    minBet,
    reasons,
  };
}

function shouldExit(position = {}, currentPrice, options = {}) {
  const entryPrice = Math.max(0, toNumber(position.avgEntryPrice, position.entryPrice));
  const latestPrice = Math.max(0, toNumber(currentPrice, 0));
  const stopLossPct = clamp(toNumber(options.stopLossPct, DEFAULT_STOP_LOSS_PCT), 0, 1);
  const stopPrice = entryPrice * (1 - stopLossPct);
  const resolutionBufferHours = Math.max(0, toNumber(options.resolutionBufferHours, 12));
  const now = options.now ? new Date(options.now) : new Date();
  const resolutionDate = position.resolutionDate ? new Date(position.resolutionDate) : null;
  const expiresSoon = resolutionDate
    ? (resolutionDate.getTime() - now.getTime()) <= resolutionBufferHours * 60 * 60 * 1000
    : false;
  const reason = latestPrice <= stopPrice
    ? `Stop loss triggered at ${latestPrice.toFixed(4)} (threshold ${stopPrice.toFixed(4)})`
    : expiresSoon && latestPrice < entryPrice
      ? 'Resolution is near and the position is still underwater'
      : '';

  return {
    exit: Boolean(reason),
    reason: reason || 'Hold',
    stopPrice: Number(stopPrice.toFixed(4)),
    adverseMovePct: entryPrice > 0 ? Number((((entryPrice - latestPrice) / entryPrice) * 100).toFixed(2)) : 0,
  };
}

module.exports = {
  DEFAULT_MAX_POSITION_PCT,
  DEFAULT_MAX_TOTAL_EXPOSURE_PCT,
  DEFAULT_MAX_CONCURRENT_POSITIONS,
  DEFAULT_MIN_BET,
  DEFAULT_STOP_LOSS_PCT,
  DEFAULT_MAX_DAILY_LOSS_PCT,
  kellyFraction,
  positionSize,
  shouldExit,
};
