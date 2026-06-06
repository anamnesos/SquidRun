#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');

const DEFAULT_MARKET_SCANNER_STATE_PATH = resolveCoordPath(path.join('runtime', 'market-scanner-state.json'), { forWrite: true });
const DEFAULT_WATCH_RULES_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-rules.json'), { forWrite: true });
const DEFAULT_WATCH_STATE_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-state.json'), { forWrite: true });
const DEFAULT_STALE_RULE_DISTANCE_PCT = 0.015;
const DEFAULT_TOP_MOVER_LIMIT = 5;
const DEFAULT_STALE_RULE_LIMIT = 5;

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

function formatMoverInline(entry = {}) {
  const ticker = toText(entry.ticker || entry.coin, 'UNK');
  return `${ticker} ${formatSignedPct(entry.change24hPct)} @ ${formatPrice(entry.price)}`;
}

function formatStaleRuleInline(entry = {}) {
  return `${toText(entry.ticker, 'UNK')} ${toText(entry.anchorLabel, 'n/a')} vs ${formatPrice(entry.livePrice)} (${formatSignedPct(entry.distancePct)})`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractCachedMarketData(scannerState = {}) {
  return asArray(scannerState.assets).map((entry) => ({
    coin: toText(entry.coin),
    ticker: toText(entry.ticker || entry.coin),
    volumeUsd24h: toNumber(entry.volumeUsd24h, 0),
    price: toNumber(entry.price, 0),
    change24hPct: toNumber(entry.change24hPct, 0),
  }));
}

function sortMovers(entries = []) {
  return asArray(entries)
    .filter((entry) => toText(entry.ticker || entry.coin))
    .slice()
    .sort((left, right) => Math.abs(toNumber(right.change24hPct, 0)) - Math.abs(toNumber(left.change24hPct, 0)));
}

function extractTopMovers(scannerState = {}, limit = DEFAULT_TOP_MOVER_LIMIT) {
  const max = Math.max(1, Math.floor(Number(limit) || DEFAULT_TOP_MOVER_LIMIT));
  const lastResultMovers = asArray(scannerState?.lastResult?.topMovers);
  const rootTopMovers = asArray(scannerState.topMovers);
  const flaggedMovers = asArray(scannerState.flaggedMovers);
  const flaggedAssets = asArray(scannerState.assets).filter((entry) => entry?.flagged === true);
  const assetMovers = asArray(scannerState.assets);

  return sortMovers(
    lastResultMovers.length > 0
      ? lastResultMovers
      : rootTopMovers.length > 0
        ? rootTopMovers
        : flaggedMovers.length > 0
          ? flaggedMovers
          : flaggedAssets.length > 0
            ? flaggedAssets
            : assetMovers
  ).slice(0, max);
}

function normalizeTicker(value = '') {
  const text = toText(value).toUpperCase();
  if (!text) return '';
  return text.includes('/') ? text : `${text}/USD`;
}

function getMarketByTicker(watchState = {}) {
  return {
    ...(watchState.watchContextSnapshot?.marketByTicker || {}),
    ...(watchState.marketByTicker || {}),
  };
}

function loadRulesConfig(filePath = DEFAULT_WATCH_RULES_PATH) {
  const config = readJson(filePath, { rules: [] }) || { rules: [] };
  return {
    ...config,
    rules: asArray(config.rules),
  };
}

function loadWatchState(filePath = DEFAULT_WATCH_STATE_PATH) {
  const state = readJson(filePath, {}) || {};
  return {
    ...state,
    rules: state.rules || {},
  };
}

function getRuleAnchor(rule = {}) {
  const retestMin = Number(rule.retestMin);
  const retestMax = Number(rule.retestMax);
  if (Number.isFinite(retestMin) && Number.isFinite(retestMax)) {
    return {
      anchorPrice: (retestMin + retestMax) / 2,
      anchorLabel: `${formatPrice(retestMin)}-${formatPrice(retestMax)}`,
    };
  }

  const candidates = [
    rule.level,
    rule.loseLevel,
    rule.reclaimLevel,
    rule.anchorPrice,
    rule.price,
  ];
  const anchorPrice = candidates.map(Number).find((value) => Number.isFinite(value) && value > 0);
  return {
    anchorPrice: anchorPrice || null,
    anchorLabel: Number.isFinite(anchorPrice) ? formatPrice(anchorPrice) : '',
  };
}

function staleRuleFromState(rule = {}, stateEntry = {}) {
  const stale = stateEntry?.stale;
  if (!stale || stale.active === false) return null;
  return {
    ticker: normalizeTicker(rule.ticker || stale.ticker),
    anchorLabel: toText(stale.anchorLabel, ''),
    anchorPrice: toNumber(stale.anchorPrice, 0),
    livePrice: toNumber(stale.livePrice, 0),
    distancePct: toNumber(stale.distancePct, 0),
  };
}

function staleRuleFromMarket(rule = {}, marketByTicker = {}, distancePct = DEFAULT_STALE_RULE_DISTANCE_PCT) {
  if (rule.enabled === false) return null;
  const ticker = normalizeTicker(rule.ticker || rule.symbol);
  if (!ticker) return null;

  const marketEntry = marketByTicker[ticker] || marketByTicker[ticker.replace('/USD', '')];
  const livePrice = toNumber(marketEntry?.price, NaN);
  if (!Number.isFinite(livePrice) || livePrice <= 0) return null;

  const anchor = getRuleAnchor(rule);
  if (!Number.isFinite(anchor.anchorPrice) || anchor.anchorPrice <= 0) return null;

  const distance = (livePrice - anchor.anchorPrice) / anchor.anchorPrice;
  if (Math.abs(distance) < distancePct) return null;
  return {
    ticker,
    anchorLabel: anchor.anchorLabel,
    anchorPrice: anchor.anchorPrice,
    livePrice,
    distancePct: distance,
  };
}

function collectStaleRules(rulesConfig = {}, watchState = {}, options = {}) {
  const distancePct = Math.max(0, Number(options.distancePct) || DEFAULT_STALE_RULE_DISTANCE_PCT);
  const stateRules = watchState.rules || {};
  const marketByTicker = getMarketByTicker(watchState);

  return asArray(rulesConfig.rules)
    .map((rule) => staleRuleFromState(rule, stateRules[rule.id]) || staleRuleFromMarket(rule, marketByTicker, distancePct))
    .filter(Boolean);
}

async function buildOracleWakeContext(options = {}) {
  const marketScannerStatePath = path.resolve(toText(options.marketScannerStatePath, DEFAULT_MARKET_SCANNER_STATE_PATH));
  const rulesPath = path.resolve(toText(options.watchRulesPath || options.rulesPath, DEFAULT_WATCH_RULES_PATH));
  const statePath = path.resolve(toText(options.watchStatePath || options.statePath, DEFAULT_WATCH_STATE_PATH));
  const staleDistancePct = Math.max(0, Number(options.staleDistancePct) || DEFAULT_STALE_RULE_DISTANCE_PCT);

  const marketScannerState = readJson(marketScannerStatePath, {}) || {};
  const watchConfig = loadRulesConfig(rulesPath);
  const watchState = loadWatchState(statePath);
  const topMovers = extractTopMovers(marketScannerState, Number(options.topMoverLimit) || DEFAULT_TOP_MOVER_LIMIT);
  const staleRules = collectStaleRules(watchConfig, watchState, {
    distancePct: staleDistancePct,
  });

  return {
    unlocks: [],
    topMovers,
    staleRules,
    unlocksSummary: 'none',
    moversSummary: topMovers.length > 0 ? topMovers.map(formatMoverInline).join('; ') : 'none',
    staleRulesSummary: staleRules.length > 0
      ? staleRules.slice(0, Number(options.staleRuleLimit) || DEFAULT_STALE_RULE_LIMIT).map(formatStaleRuleInline).join('; ')
      : 'none',
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
  DEFAULT_WATCH_RULES_PATH,
  DEFAULT_WATCH_STATE_PATH,
  buildOracleWakeContext,
  buildOracleWakeMessage,
  collectStaleRules,
  extractCachedMarketData,
  extractTopMovers,
  formatMoverInline,
  formatPrice,
  formatSignedPct,
  formatStaleRuleInline,
  loadRulesConfig,
  loadWatchState,
};
