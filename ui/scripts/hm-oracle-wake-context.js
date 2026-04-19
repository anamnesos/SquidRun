#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');
const { runScan: scanTokenUnlocks } = require('./hm-tokenomist-unlocks');
const {
  DEFAULT_RULES_PATH,
  DEFAULT_STATE_PATH,
  loadRulesConfig,
  loadWatchState,
  collectStaleRules,
} = require('./hm-oracle-watch-engine');

const DEFAULT_MARKET_SCANNER_STATE_PATH = resolveCoordPath(path.join('runtime', 'market-scanner-state.json'), { forWrite: true });
const DEFAULT_STALE_RULE_DISTANCE_PCT = 0.015;
const DEFAULT_TOP_MOVER_LIMIT = 5;
const DEFAULT_UNLOCK_LIMIT = 3;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function formatSignedPct(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  const pct = numeric * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

function formatPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  if (numeric >= 1000) return numeric.toFixed(2);
  if (numeric >= 1) return numeric.toFixed(4);
  return numeric.toFixed(6);
}

function formatUnlockInline(entry = {}) {
  const token = toText(entry.token, 'UNK');
  const countdown = toText(entry.countdownText, 'n/a');
  const size = toText(entry.unlockSizeText, 'n/a');
  const supply = toText(entry.unlockPctSupplyText, '');
  return `${token} ${countdown} ${size}${supply ? ` ${supply}` : ''}`.trim();
}

function formatMoverInline(entry = {}) {
  const ticker = toText(entry.ticker || entry.coin, 'UNK');
  return `${ticker} ${formatSignedPct(entry.change24hPct)} @ ${formatPrice(entry.price)}`;
}

function formatStaleRuleInline(entry = {}) {
  return `${toText(entry.ticker, 'UNK')} ${toText(entry.anchorLabel, 'n/a')} vs ${formatPrice(entry.livePrice)} (${formatSignedPct(entry.distancePct)})`;
}

function extractCachedMarketData(scannerState = {}) {
  if (Array.isArray(scannerState.assets) && scannerState.assets.length > 0) {
    return scannerState.assets.map((entry) => ({
      coin: toText(entry.coin),
      ticker: toText(entry.ticker),
      volumeUsd24h: toNumber(entry.volumeUsd24h, 0),
    }));
  }
  const topMovers = Array.isArray(scannerState?.lastResult?.topMovers) ? scannerState.lastResult.topMovers : [];
  return topMovers.map((entry) => ({
    coin: toText(entry.coin),
    ticker: toText(entry.ticker),
    volumeUsd24h: toNumber(entry.volumeUsd24h, 0),
  }));
}

function extractTopMovers(scannerState = {}, limit = DEFAULT_TOP_MOVER_LIMIT) {
  const movers = Array.isArray(scannerState?.lastResult?.topMovers)
    ? scannerState.lastResult.topMovers
    : (Array.isArray(scannerState.topMovers) ? scannerState.topMovers : []);
  return movers.slice(0, Math.max(1, limit));
}

async function buildOracleWakeContext(options = {}) {
  const marketScannerStatePath = path.resolve(toText(options.marketScannerStatePath, DEFAULT_MARKET_SCANNER_STATE_PATH));
  const rulesPath = path.resolve(toText(options.watchRulesPath || options.rulesPath, DEFAULT_RULES_PATH));
  const statePath = path.resolve(toText(options.watchStatePath || options.statePath, DEFAULT_STATE_PATH));
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();

  const marketScannerState = readJson(marketScannerStatePath, {});
  const cachedMarketData = extractCachedMarketData(marketScannerState);
  const unlockResult = await scanTokenUnlocks({
    maxHours: 24,
    marketData: cachedMarketData,
    now: nowMs,
  }).catch(() => ({ unlocks: [] }));
  const topMovers = extractTopMovers(marketScannerState, Number(options.topMoverLimit) || DEFAULT_TOP_MOVER_LIMIT);
  const watchConfig = loadRulesConfig(rulesPath);
  const watchState = loadWatchState(statePath);
  const staleRules = collectStaleRules(watchConfig, watchState, {
    nowMs,
    distancePct: Number(options.staleDistancePct) || DEFAULT_STALE_RULE_DISTANCE_PCT,
    persistAfterMs: 0,
  });

  const unlocksSummary = Array.isArray(unlockResult.unlocks) && unlockResult.unlocks.length > 0
    ? unlockResult.unlocks.slice(0, Number(options.unlockLimit) || DEFAULT_UNLOCK_LIMIT).map(formatUnlockInline).join('; ')
    : 'none';
  const moversSummary = topMovers.length > 0
    ? topMovers.map(formatMoverInline).join('; ')
    : 'none';
  const staleRulesSummary = staleRules.length > 0
    ? staleRules.slice(0, 5).map(formatStaleRuleInline).join('; ')
    : 'none';

  return {
    unlocks: Array.isArray(unlockResult.unlocks) ? unlockResult.unlocks : [],
    topMovers,
    staleRules,
    unlocksSummary,
    moversSummary,
    staleRulesSummary,
  };
}

async function buildOracleWakeMessage(baseMessage, options = {}) {
  const context = await buildOracleWakeContext(options);
  const base = toText(baseMessage, '(ARCHITECT ORACLE-WAKE): scan now and emit signal directly to architect if any name is armed.');
  return `${base} | unlocks24h=${context.unlocksSummary} | topMovers=${context.moversSummary} | staleRules=${context.staleRulesSummary}`;
}

module.exports = {
  DEFAULT_MARKET_SCANNER_STATE_PATH,
  DEFAULT_STALE_RULE_DISTANCE_PCT,
  buildOracleWakeContext,
  buildOracleWakeMessage,
  extractTopMovers,
  extractCachedMarketData,
  formatUnlockInline,
  formatMoverInline,
  formatStaleRuleInline,
};
