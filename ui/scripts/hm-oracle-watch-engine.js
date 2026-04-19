#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveCoordPath } = require('../config');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const { sendAgentAlert } = require('./hm-agent-alert');

const DEFAULT_RULES_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-rules.json'), { forWrite: true });
const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-state.json'), { forWrite: true });
const DEFAULT_TARGETS = ['oracle'];
const DEFAULT_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MACRO_POLL_INTERVAL_MS = 5_000;
const DEFAULT_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_ALERT_TIMEOUT_MS = 15_000;
const DEFAULT_TELEGRAM_ALERT_TICKERS = ['SUI/USD', 'ZEC/USD'];
const MAX_HOT_SYMBOLS = 2;
const DEFAULT_STALE_RULE_DISTANCE_PCT = 0.015;
const DEFAULT_STALE_RULE_PERSIST_AFTER_MS = 15 * 60 * 1000;
const DEFAULT_STALE_RULE_RECLAIM_OFFSET_PCT = 0.006;
const DEFAULT_STALE_RULE_LOSE_OFFSET_PCT = 0.006;
const DEFAULT_STALE_RULE_MIN_RETEST_BAND_PCT = 0.0015;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function pickFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTicker(value) {
  const raw = toText(value).toUpperCase().replace('-', '/');
  if (!raw) return '';
  return raw.endsWith('/USD') ? raw : `${raw}/USD`;
}

function normalizeTargets(value = DEFAULT_TARGETS) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return Array.from(new Set(
    raw
      .map((entry) => toText(entry).toLowerCase())
      .filter((entry) => ['architect', 'builder', 'oracle'].includes(entry))
  ));
}

function normalizeAlertTickers(value = DEFAULT_TELEGRAM_ALERT_TICKERS) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return Array.from(new Set(
    raw
      .map((entry) => normalizeTicker(entry))
      .filter(Boolean)
  ));
}

function normalizeMode(value, fallback = 'normal') {
  const normalized = toText(value, fallback).toLowerCase();
  return normalized === 'macro-release' || normalized === 'macro_release'
    ? 'macro_release'
    : 'normal';
}

function defaultRulesConfig() {
  return {
    version: 1,
    mode: 'normal',
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    macroPollIntervalMs: DEFAULT_MACRO_POLL_INTERVAL_MS,
    staleRulePolicy: {
      enabled: true,
      distancePct: DEFAULT_STALE_RULE_DISTANCE_PCT,
      persistAfterMs: DEFAULT_STALE_RULE_PERSIST_AFTER_MS,
      reclaimOffsetPct: DEFAULT_STALE_RULE_RECLAIM_OFFSET_PCT,
      loseOffsetPct: DEFAULT_STALE_RULE_LOSE_OFFSET_PCT,
      minRetestBandPct: DEFAULT_STALE_RULE_MIN_RETEST_BAND_PCT,
    },
    targets: DEFAULT_TARGETS,
    symbols: DEFAULT_SYMBOLS,
    hotSymbols: [],
    rules: [
      {
        id: 'btc-reclaim-74020',
        name: 'BTC reclaim above 74020 and hold 2x 1m closes',
        enabled: true,
        ticker: 'BTC/USD',
        trigger: 'reclaim_hold',
        level: 74020,
        confirmCloses: 2,
        timeframe: '1m',
        cooldownMs: DEFAULT_ALERT_COOLDOWN_MS,
      },
      {
        id: 'btc-lose-73520-fail-retest',
        name: 'BTC lose 73520 then fail retest into 73520-73560',
        enabled: true,
        ticker: 'BTC/USD',
        trigger: 'lose_fail_retest',
        loseLevel: 73520,
        retestMin: 73520,
        retestMax: 73560,
        timeframe: '1m',
        cooldownMs: DEFAULT_ALERT_COOLDOWN_MS,
      },
      {
        id: 'eth-reclaim-2368-2370',
        name: 'ETH reclaim 2368-2370',
        enabled: true,
        ticker: 'ETH/USD',
        trigger: 'reclaim_hold',
        zone: { min: 2368, max: 2370 },
        confirmCloses: 2,
        timeframe: '1m',
        cooldownMs: DEFAULT_ALERT_COOLDOWN_MS,
      },
      {
        id: 'sol-relative-strength-vs-btc',
        name: 'SOL green while BTC red over same 5m window',
        enabled: true,
        ticker: 'SOL/USD',
        trigger: 'relative_strength',
        anchorTicker: 'BTC/USD',
        timeframe: '5m',
        altMinChangePct: 0.002,
        anchorMaxChangePct: -0.001,
        chartLocation: {
          bias: 'long_only',
          dayRange: { min: 89.0, max: 90.0 },
          validLongZones: [
            { label: 'support_reclaim', min: 89.0, max: 89.1 },
            { label: 'breakout_reclaim', min: 89.7, max: 89.8 },
          ],
          invalidLabel: 'midrange_watch_only',
          invalidNote: 'SOL relative strength is watch-only here. Valid long zones are 89.00-89.10 support reclaim or 89.70-89.80 breakout reclaim.',
        },
        cooldownMs: DEFAULT_ALERT_COOLDOWN_MS,
      },
    ],
  };
}

function defaultState() {
  return {
    version: 3,
    updatedAt: null,
    mode: 'normal',
    heartbeat: {
      lastTickAt: null,
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
      stale: false,
      state: 'idle',
    },
    counters: {
      triggersSeen: 0,
      triggersArmed: 0,
      triggersFired: 0,
      triggersInvalidated: 0,
      triggersActedOn: 0,
      alertsSent: 0,
      staleRulesDetected: 0,
      lastCycleSeen: 0,
      lastCycleFired: 0,
      lastCycleAlertCount: 0,
      lastCycleStaleCount: 0,
    },
    marketByTicker: {},
    rules: {},
    staleRules: [],
  };
}

function countDecimals(value) {
  const text = String(value ?? '');
  if (!text.includes('.')) return 0;
  return text.split('.')[1].replace(/0+$/, '').length;
}

function roundToPrecision(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(Math.max(0, digits)));
}

function resolveRulePrecision(rule = {}) {
  const values = [
    rule.level,
    rule.loseLevel,
    rule.retestMin,
    rule.retestMax,
    rule?.zone?.min,
    rule?.zone?.max,
    ...(Array.isArray(rule?.chartLocation?.validLongZones)
      ? rule.chartLocation.validLongZones.flatMap((zone) => [zone?.min, zone?.max])
      : []),
  ].filter((value) => Number.isFinite(Number(value)));
  return values.length > 0 ? Math.max(...values.map((value) => countDecimals(value))) : 4;
}

function resolveStaleRulePolicy(config = {}, overrides = {}) {
  const policy = {
    ...(config?.staleRulePolicy || {}),
    ...(overrides || {}),
  };
  return {
    enabled: policy.enabled !== false,
    distancePct: Math.max(0.001, pickFiniteNumber(policy.distancePct, DEFAULT_STALE_RULE_DISTANCE_PCT)),
    persistAfterMs: Math.max(0, pickFiniteNumber(policy.persistAfterMs, DEFAULT_STALE_RULE_PERSIST_AFTER_MS)),
    reclaimOffsetPct: Math.max(0.001, pickFiniteNumber(policy.reclaimOffsetPct, DEFAULT_STALE_RULE_RECLAIM_OFFSET_PCT)),
    loseOffsetPct: Math.max(0.001, pickFiniteNumber(policy.loseOffsetPct, DEFAULT_STALE_RULE_LOSE_OFFSET_PCT)),
    minRetestBandPct: Math.max(0.0005, pickFiniteNumber(policy.minRetestBandPct, DEFAULT_STALE_RULE_MIN_RETEST_BAND_PCT)),
  };
}

function formatAnchorLabel(anchor = {}, digits = 4) {
  if (Number.isFinite(Number(anchor.floor)) && Number.isFinite(Number(anchor.ceiling)) && anchor.floor !== anchor.ceiling) {
    return `${formatPrice(anchor.floor, digits)}-${formatPrice(anchor.ceiling, digits)}`;
  }
  return formatPrice(anchor.anchorPrice, digits);
}

function getRuleReference(rule = {}, livePrice = NaN) {
  if (rule.trigger === 'lose_fail_retest' && Number.isFinite(Number(rule.loseLevel))) {
    const loseLevel = Number(rule.loseLevel);
    return {
      supported: true,
      kind: 'lose_level',
      anchorPrice: loseLevel,
      floor: Number.isFinite(Number(rule.retestMin)) ? Number(rule.retestMin) : loseLevel,
      ceiling: Number.isFinite(Number(rule.retestMax)) ? Number(rule.retestMax) : loseLevel,
    };
  }

  if (Number.isFinite(Number(rule.level))) {
    const level = Number(rule.level);
    return {
      supported: true,
      kind: 'level',
      anchorPrice: level,
      floor: level,
      ceiling: level,
    };
  }

  if (rule.zone && Number.isFinite(Number(rule.zone.min)) && Number.isFinite(Number(rule.zone.max))) {
    const min = Number(rule.zone.min);
    const max = Number(rule.zone.max);
    return {
      supported: true,
      kind: 'zone',
      anchorPrice: (min + max) / 2,
      floor: min,
      ceiling: max,
    };
  }

  const validZones = Array.isArray(rule?.chartLocation?.validLongZones)
    ? rule.chartLocation.validLongZones.filter((zone) => Number.isFinite(Number(zone?.min)) && Number.isFinite(Number(zone?.max)))
    : [];
  if (validZones.length > 0) {
    const fallbackZone = validZones[0];
    const targetZone = Number.isFinite(livePrice)
      ? (validZones.reduce((best, zone) => {
        const zoneCenter = (Number(zone.min) + Number(zone.max)) / 2;
        const bestCenter = (Number(best.min) + Number(best.max)) / 2;
        return Math.abs(zoneCenter - livePrice) < Math.abs(bestCenter - livePrice) ? zone : best;
      }, fallbackZone))
      : fallbackZone;
    const min = Number(targetZone.min);
    const max = Number(targetZone.max);
    return {
      supported: true,
      kind: 'chart_zone',
      anchorPrice: (min + max) / 2,
      floor: min,
      ceiling: max,
      label: toText(targetZone.label, 'chart_zone'),
    };
  }

  return {
    supported: false,
    kind: 'unsupported',
    anchorPrice: NaN,
    floor: NaN,
    ceiling: NaN,
  };
}

function buildRuleRefreshProposal(rule = {}, livePrice, policy = {}) {
  const numericLivePrice = Number(livePrice);
  if (!Number.isFinite(numericLivePrice) || numericLivePrice <= 0) return null;
  const digits = resolveRulePrecision(rule);

  if (rule.trigger === 'reclaim_hold') {
    if (rule.zone && Number.isFinite(Number(rule.zone.min)) && Number.isFinite(Number(rule.zone.max))) {
      const width = Math.max(
        Math.abs(Number(rule.zone.max) - Number(rule.zone.min)),
        numericLivePrice * Number(policy.minRetestBandPct || DEFAULT_STALE_RULE_MIN_RETEST_BAND_PCT)
      );
      const nextMin = roundToPrecision(numericLivePrice * (1 + Number(policy.reclaimOffsetPct || DEFAULT_STALE_RULE_RECLAIM_OFFSET_PCT)), digits);
      const nextMax = roundToPrecision(nextMin + width, digits);
      return {
        mode: 'manual_validation',
        summary: `shift reclaim zone to ${formatPrice(nextMin, digits)}-${formatPrice(nextMax, digits)}`,
        proposedFields: {
          zone: {
            min: nextMin,
            max: nextMax,
          },
        },
      };
    }

    const nextLevel = roundToPrecision(
      numericLivePrice * (1 + Number(policy.reclaimOffsetPct || DEFAULT_STALE_RULE_RECLAIM_OFFSET_PCT)),
      digits
    );
    return {
      mode: 'manual_validation',
      summary: `raise reclaim to ${formatPrice(nextLevel, digits)}`,
      proposedFields: {
        level: nextLevel,
      },
    };
  }

  if (rule.trigger === 'lose_fail_retest') {
    const existingBand = Number.isFinite(Number(rule.retestMax)) && Number.isFinite(Number(rule.retestMin))
      ? Math.abs(Number(rule.retestMax) - Number(rule.retestMin))
      : 0;
    const bandWidth = Math.max(
      existingBand,
      numericLivePrice * Number(policy.minRetestBandPct || DEFAULT_STALE_RULE_MIN_RETEST_BAND_PCT)
    );
    const nextLoseLevel = roundToPrecision(
      numericLivePrice * (1 - Number(policy.loseOffsetPct || DEFAULT_STALE_RULE_LOSE_OFFSET_PCT)),
      digits
    );
    const nextRetestMax = roundToPrecision(nextLoseLevel + bandWidth, digits);
    return {
      mode: 'manual_validation',
      summary: `reset lose/retest to ${formatPrice(nextLoseLevel, digits)}-${formatPrice(nextRetestMax, digits)}`,
      proposedFields: {
        loseLevel: nextLoseLevel,
        retestMin: nextLoseLevel,
        retestMax: nextRetestMax,
      },
    };
  }

  if (rule.trigger === 'relative_strength') {
    const zones = Array.isArray(rule?.chartLocation?.validLongZones)
      ? rule.chartLocation.validLongZones.filter((zone) => Number.isFinite(Number(zone?.min)) && Number.isFinite(Number(zone?.max)))
      : [];
    if (zones.length === 0) return null;
    const firstZone = zones[0];
    const nextCenter = numericLivePrice * (1 + Number(policy.reclaimOffsetPct || DEFAULT_STALE_RULE_RECLAIM_OFFSET_PCT));
    const firstCenter = (Number(firstZone.min) + Number(firstZone.max)) / 2;
    const delta = nextCenter - firstCenter;
    const shiftedZones = zones.map((zone) => ({
      ...zone,
      min: roundToPrecision(Number(zone.min) + delta, digits),
      max: roundToPrecision(Number(zone.max) + delta, digits),
    }));
    const nextChartLocation = {
      ...(rule.chartLocation || {}),
      validLongZones: shiftedZones,
    };
    if (Number.isFinite(Number(rule?.chartLocation?.dayRange?.min)) && Number.isFinite(Number(rule?.chartLocation?.dayRange?.max))) {
      nextChartLocation.dayRange = {
        min: roundToPrecision(Number(rule.chartLocation.dayRange.min) + delta, digits),
        max: roundToPrecision(Number(rule.chartLocation.dayRange.max) + delta, digits),
      };
    }
    return {
      mode: 'manual_validation',
      summary: `shift relative-strength framework nearer ${formatPrice(nextCenter, digits)}`,
      proposedFields: {
        chartLocation: nextChartLocation,
      },
    };
  }

  return null;
}

function evaluateRuleStaleness(rule = {}, symbolContext = {}, ruleState = {}, policy = {}, nowMs = Date.now()) {
  const livePrice = Number(symbolContext?.market?.price ?? symbolContext?.snapshot?.tradePrice);
  const nowIso = new Date(nowMs).toISOString();
  const previousStaleState = ruleState?.stale || null;

  if (!policy.enabled || !rule.enabled || !Number.isFinite(livePrice) || livePrice <= 0 || symbolContext?.hasLivePosition) {
    return {
      state: previousStaleState?.active
        ? {
          stale: {
            ...previousStaleState,
            active: false,
            resolvedAt: nowIso,
            lastSeenAt: nowIso,
          },
        }
        : {},
      summary: null,
      event: null,
    };
  }

  const anchor = getRuleReference(rule, livePrice);
  if (!anchor.supported || !Number.isFinite(anchor.anchorPrice) || anchor.anchorPrice <= 0) {
    return { state: {}, summary: null, event: null };
  }

  const distancePct = Math.abs(livePrice - anchor.anchorPrice) / anchor.anchorPrice;
  const digits = Math.max(resolveRulePrecision(rule), 2);
  if (distancePct < Number(policy.distancePct || DEFAULT_STALE_RULE_DISTANCE_PCT)) {
    return {
      state: previousStaleState?.active
        ? {
          stale: {
            ...previousStaleState,
            active: false,
            resolvedAt: nowIso,
            lastSeenAt: nowIso,
            distancePct: round(distancePct, 4),
            livePrice: round(livePrice, 6),
            anchorPrice: round(anchor.anchorPrice, 6),
            anchorLabel: formatAnchorLabel(anchor, digits),
          },
        }
        : {},
      summary: null,
      event: null,
    };
  }

  const detectedAt = toText(previousStaleState?.detectedAt, nowIso);
  const detectedAtMs = Date.parse(detectedAt);
  const persistedEnough = Number.isFinite(detectedAtMs)
    ? (nowMs - detectedAtMs) >= pickFiniteNumber(policy.persistAfterMs, DEFAULT_STALE_RULE_PERSIST_AFTER_MS)
    : false;
  const proposal = buildRuleRefreshProposal(rule, livePrice, policy);
  const nextStaleState = {
    active: persistedEnough,
    detectedAt,
    lastSeenAt: nowIso,
    resolvedAt: null,
    distancePct: round(distancePct, 4),
    livePrice: round(livePrice, 6),
    anchorPrice: round(anchor.anchorPrice, 6),
    anchorLabel: formatAnchorLabel(anchor, digits),
    proposal,
  };

  const summary = persistedEnough
    ? {
      ruleId: rule.id,
      ticker: normalizeTicker(rule.ticker),
      trigger: toText(rule.trigger),
      livePrice: nextStaleState.livePrice,
      anchorPrice: nextStaleState.anchorPrice,
      anchorLabel: nextStaleState.anchorLabel,
      distancePct: nextStaleState.distancePct,
      detectedAt,
      proposal,
    }
    : null;

  return {
    state: {
      stale: nextStaleState,
    },
    summary,
    event: persistedEnough && previousStaleState?.active !== true ? 'stale' : null,
  };
}

function collectStaleRules(config = {}, state = {}, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const policy = resolveStaleRulePolicy(config, {
    distancePct: options.distancePct,
    persistAfterMs: options.persistAfterMs,
  });
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  const staleRules = [];

  for (const rule of rules) {
    const ticker = normalizeTicker(rule.ticker);
    const market = state?.marketByTicker?.[ticker] || null;
    if (!market) continue;
    const evaluation = evaluateRuleStaleness(
      rule,
      { ticker, market, hasLivePosition: false },
      state?.rules?.[rule.id] || {},
      policy,
      nowMs
    );
    if (evaluation.summary) {
      staleRules.push(evaluation.summary);
    }
  }

  return staleRules.sort((left, right) => Number(right.distancePct || 0) - Number(left.distancePct || 0));
}

function getRuleThreshold(rule = {}) {
  if (Number.isFinite(Number(rule.level))) {
    return Number(rule.level);
  }
  if (rule.zone && Number.isFinite(Number(rule.zone.max))) {
    return Number(rule.zone.max);
  }
  return NaN;
}

function getRuleFloor(rule = {}) {
  if (rule.zone && Number.isFinite(Number(rule.zone.min))) {
    return Number(rule.zone.min);
  }
  if (Number.isFinite(Number(rule.level))) {
    return Number(rule.level);
  }
  return NaN;
}

function getLastCloses(bars = [], count = 3) {
  return (Array.isArray(bars) ? bars : [])
    .slice(-count)
    .map((bar) => round(bar?.close, 6))
    .filter((value) => Number.isFinite(value));
}

function getLatestBar(bars = []) {
  return Array.isArray(bars) && bars.length > 0 ? bars[bars.length - 1] : null;
}

function getPreviousBar(bars = []) {
  return Array.isArray(bars) && bars.length > 1 ? bars[bars.length - 2] : null;
}

function determineFundingDirection(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'unknown';
  if (numeric > 0) return 'positive';
  if (numeric < 0) return 'negative';
  return 'flat';
}

function evaluateChartLocation(rule = {}, payload = {}) {
  const chartLocation = rule?.chartLocation || null;
  const livePrice = Number(payload?.livePrice);
  if (!chartLocation || !Number.isFinite(livePrice) || livePrice <= 0) {
    return {
      bias: toText(chartLocation?.bias, ''),
      label: null,
      executable: true,
      note: null,
    };
  }

  const zones = Array.isArray(chartLocation.validLongZones)
    ? chartLocation.validLongZones.filter((zone) => Number.isFinite(Number(zone?.min)) && Number.isFinite(Number(zone?.max)))
    : [];
  const matchingZone = zones.find((zone) => livePrice >= Number(zone.min) && livePrice <= Number(zone.max)) || null;
  if (matchingZone) {
    return {
      bias: toText(chartLocation.bias, ''),
      label: toText(matchingZone.label, 'valid_zone'),
      executable: true,
      note: null,
    };
  }

  const dayRangeMin = Number(chartLocation?.dayRange?.min);
  const dayRangeMax = Number(chartLocation?.dayRange?.max);
  const insideDayRange = Number.isFinite(dayRangeMin)
    && Number.isFinite(dayRangeMax)
    && livePrice >= dayRangeMin
    && livePrice <= dayRangeMax;

  return {
    bias: toText(chartLocation.bias, ''),
    label: insideDayRange
      ? toText(chartLocation.invalidLabel, 'watch_only')
      : 'out_of_framework',
    executable: false,
    note: insideDayRange
      ? toText(chartLocation.invalidNote, null)
      : 'Current price is outside the active chart-location framework for this trigger.',
  };
}

function buildSuggestedCommand(rule = {}, payload = {}, eventType = 'fired') {
  const chartLocation = evaluateChartLocation(rule, payload);
  if (eventType !== 'fired' || chartLocation.executable !== true) {
    return null;
  }
  const asset = toText(payload.ticker).split('/')[0];
  if (!asset) return null;
  const majors = new Set(['BTC', 'ETH']);
  const leverage = majors.has(asset) ? 25 : asset === 'SOL' ? 20 : 10;
  const margin = majors.has(asset) ? 12 : asset === 'SOL' ? 10 : 8;
  let direction = 'LONG';
  let stopLoss = null;
  if (rule.trigger === 'lose_fail_retest') {
    direction = 'SHORT';
    stopLoss = Number.isFinite(Number(rule.retestMax)) ? Number(rule.retestMax) : null;
  } else {
    direction = 'LONG';
    stopLoss = Number.isFinite(Number(rule.level))
      ? Number(rule.level)
      : (Number.isFinite(Number(rule?.zone?.min)) ? Number(rule.zone.min) : null);
  }
  const parts = [
    'node',
    'ui/scripts/hm-defi-execute.js',
    'trade',
    '--asset', asset,
    '--direction', direction,
    '--leverage', String(leverage),
    '--margin', String(margin),
  ];
  if (stopLoss != null) {
    parts.push('--stop-loss', String(stopLoss));
  }
  return parts.join(' ');
}

function buildAlertPayload(rule = {}, symbolContext = {}, previousMarket = {}) {
  const fundingRate = symbolContext?.market?.fundingRate ?? symbolContext?.predictedFunding?.fundingRate ?? null;
  const openInterest = toNumber(symbolContext?.market?.openInterest, NaN);
  const previousOpenInterest = toNumber(previousMarket?.openInterest, NaN);
  const openInterestChangePct = Number.isFinite(openInterest) && Number.isFinite(previousOpenInterest) && previousOpenInterest > 0
    ? (openInterest - previousOpenInterest) / previousOpenInterest
    : null;
  return {
    ticker: symbolContext.ticker,
    trigger: rule.name || rule.id,
    triggerId: rule.id,
    livePrice: round(symbolContext?.market?.price ?? symbolContext?.snapshot?.tradePrice, 6),
    last1mCloses: getLastCloses(symbolContext?.bars1m, 3),
    candle5m: symbolContext?.bar5m
      ? {
        open: round(symbolContext.bar5m.open, 6),
        high: round(symbolContext.bar5m.high, 6),
        low: round(symbolContext.bar5m.low, 6),
        close: round(symbolContext.bar5m.close, 6),
      }
      : null,
    book: symbolContext?.l2Book
      ? {
        skew: symbolContext.l2Book.nearTouchSkew,
        imbalanceTop5: symbolContext.l2Book.depthImbalanceTop5,
        bestBid: round(symbolContext.l2Book.bestBid, 6),
        bestAsk: round(symbolContext.l2Book.bestAsk, 6),
      }
      : null,
    fundingDirection: determineFundingDirection(fundingRate),
    fundingRateBps: Number.isFinite(Number(fundingRate)) ? round(Number(fundingRate) * 10_000, 4) : null,
    openInterestChangePct: openInterestChangePct == null ? null : round(openInterestChangePct, 4),
    hasLivePosition: Boolean(symbolContext?.hasLivePosition),
  };
}

function formatOracleAlert(eventType, rule = {}, payload = {}, mode = 'normal') {
  if (eventType === 'stale') {
    return `(ORACLE WATCH): ${JSON.stringify({
      mode,
      ticker: payload.ticker,
      state: 'stale',
      trigger: payload.trigger,
      livePrice: payload.livePrice,
      staleRule: payload.staleRule || null,
      executionReady: false,
      command: null,
    })}`;
  }
  const chartLocation = evaluateChartLocation(rule, payload);
  const compact = {
    mode,
    ticker: payload.ticker,
    state: eventType,
    trigger: payload.trigger,
    livePrice: payload.livePrice,
    last1mCloses: payload.last1mCloses,
    candle5m: payload.candle5m,
    book: payload.book,
    fundingDirection: payload.fundingDirection,
    fundingRateBps: payload.fundingRateBps,
    openInterestChangePct: payload.openInterestChangePct,
    hasLivePosition: payload.hasLivePosition,
    chartLocation,
    executionReady: eventType === 'fired' && chartLocation.executable === true,
    command: buildSuggestedCommand(rule, payload, eventType),
  };
  return `(ORACLE WATCH): ${JSON.stringify(compact)}`;
}

function resolveTradeDirection(rule = {}) {
  return rule.trigger === 'lose_fail_retest' ? 'SHORT' : 'LONG';
}

function formatPrice(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  return numeric.toFixed(digits);
}

function shouldSendTelegramTradeAlert(alert = {}, options = {}) {
  const eligibleTickers = normalizeAlertTickers(options.telegramTradeAlertTickers || DEFAULT_TELEGRAM_ALERT_TICKERS);
  if (!eligibleTickers.includes(normalizeTicker(alert?.payload?.ticker || alert?.ticker))) {
    return false;
  }
  return alert.eventType === 'fired' || alert.eventType === 'invalidated';
}

function formatTelegramTradeAlert(alert = {}) {
  const ticker = normalizeTicker(alert?.payload?.ticker || alert?.ticker);
  const baseAsset = ticker.split('/')[0] || 'UNKNOWN';
  const direction = resolveTradeDirection(alert?.rule || {});
  const livePrice = formatPrice(alert?.payload?.livePrice, 5);

  if (alert.eventType === 'fired') {
    return `TRADE ALERT: ${baseAsset} ${direction} entry confirmed @ ${livePrice}. Trigger live now.`;
  }

  if (alert.eventType === 'invalidated') {
    if (alert?.payload?.hasLivePosition) {
      return `TRADE ALERT: ${baseAsset} ${direction} invalidated / hard-stop touch @ ${livePrice}. Exit now.`;
    }
    return `TRADE ALERT: ${baseAsset} ${direction} invalidated @ ${livePrice}. Stand down.`;
  }

  return '';
}

function sendTelegramTradeAlerts(alerts = [], options = {}) {
  const eligibleAlerts = (Array.isArray(alerts) ? alerts : [])
    .filter((alert) => shouldSendTelegramTradeAlert(alert, options))
    .map((alert) => ({
      ...alert,
      telegramMessage: formatTelegramTradeAlert(alert),
    }))
    .filter((alert) => toText(alert.telegramMessage));

  if (eligibleAlerts.length === 0) {
    return {
      ok: true,
      sent: 0,
      results: [],
    };
  }

  const hmSendScriptPath = path.resolve(
    toText(options.hmSendScriptPath, path.join(__dirname, 'hm-send.js'))
  );
  const cwd = path.resolve(
    toText(options.cwd, process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'))
  );
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_ALERT_TIMEOUT_MS);
  const role = toText(options.role, 'oracle-watch');
  const results = [];

  for (const alert of eligibleAlerts) {
    const args = [hmSendScriptPath, 'telegram', alert.telegramMessage];
    if (role) {
      args.push('--role', role);
    }
    try {
      const stdout = execFileSync(process.execPath, args, {
        cwd,
        env: options.env || process.env,
        timeout: timeoutMs,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      results.push({
        ticker: alert.ticker,
        eventType: alert.eventType,
        ok: true,
        stdout: toText(stdout, null),
      });
    } catch (error) {
      results.push({
        ticker: alert.ticker,
        eventType: alert.eventType,
        ok: false,
        error: toText(error?.stderr, '') || toText(error?.message, 'hm_send_telegram_failed'),
      });
    }
  }

  return {
    ok: results.every((entry) => entry.ok === true),
    sent: results.length,
    results,
  };
}

function shouldAlert(lastAlertAt, cooldownMs, nowMs) {
  if (!Number.isFinite(Number(lastAlertAt))) return true;
  return (nowMs - Number(lastAlertAt)) >= Math.max(1, Number(cooldownMs) || DEFAULT_ALERT_COOLDOWN_MS);
}

function evaluateReclaimHold(rule = {}, symbolContext = {}, ruleState = {}, nowMs = Date.now()) {
  const threshold = getRuleThreshold(rule);
  const latestBar = getLatestBar(symbolContext?.bars1m);
  const closes = getLastCloses(symbolContext?.bars1m, Math.max(2, Number(rule.confirmCloses) || 2));
  const lookbackCloses = getLastCloses(symbolContext?.bars1m, 6);
  if (!Number.isFinite(threshold) || !latestBar || closes.length === 0) {
    return { state: ruleState, events: [] };
  }
  const confirmCloses = Math.max(1, Number(rule.confirmCloses) || 2);
  const heldAbove = closes.length >= confirmCloses && closes.slice(-confirmCloses).every((close) => close > threshold);
  const recentBelow = lookbackCloses.some((close) => close < threshold);
  const latestClose = closes[closes.length - 1];
  const nextState = { ...ruleState };
  const events = [];

  if (heldAbove && recentBelow) {
    if (ruleState.status !== 'fired') {
      nextState.status = 'fired';
      nextState.armedAt = nextState.armedAt || nowMs;
      nextState.firedAt = nowMs;
      events.push('fired');
    }
    return { state: nextState, events };
  }

  if (latestClose > threshold && recentBelow) {
    if (ruleState.status !== 'armed' && ruleState.status !== 'fired') {
      nextState.status = 'armed';
      nextState.armedAt = nowMs;
      events.push('armed');
    }
    return { state: nextState, events };
  }

  if ((ruleState.status === 'armed' || ruleState.status === 'fired') && latestClose < getRuleFloor(rule)) {
    nextState.status = 'idle';
    nextState.invalidatedAt = nowMs;
    nextState.armedAt = null;
    events.push('invalidated');
  }

  return { state: nextState, events };
}

function evaluateLoseFailRetest(rule = {}, symbolContext = {}, ruleState = {}, nowMs = Date.now()) {
  const loseLevel = Number(rule.loseLevel);
  const retestMin = Number(rule.retestMin);
  const retestMax = Number(rule.retestMax);
  const bars = Array.isArray(symbolContext?.bars1m) ? symbolContext.bars1m : [];
  const latestBar = getLatestBar(bars);
  const previousBar = getPreviousBar(bars);
  if (!latestBar || !Number.isFinite(loseLevel) || !Number.isFinite(retestMin) || !Number.isFinite(retestMax)) {
    return { state: ruleState, events: [] };
  }
  const nextState = { ...ruleState };
  const events = [];
  const breakdownNow = previousBar && Number(previousBar.close) >= loseLevel && Number(latestBar.close) < loseLevel;
  const retestTouched = bars.some((bar) => Number(bar.high) >= retestMin && Number(bar.low) <= retestMax);
  const failedRetest = retestTouched && Number(latestBar.close) < retestMin;
  const invalidated = Number(latestBar.close) > retestMax;

  if (breakdownNow && ruleState.status !== 'armed' && ruleState.status !== 'fired') {
    nextState.status = 'armed';
    nextState.armedAt = nowMs;
    events.push('armed');
    return { state: nextState, events };
  }

  if ((ruleState.status === 'armed' || ruleState.status === 'fired') && failedRetest) {
    if (ruleState.status !== 'fired') {
      nextState.status = 'fired';
      nextState.firedAt = nowMs;
      nextState.retestTouched = true;
      events.push('fired');
    }
    return { state: nextState, events };
  }

  if ((ruleState.status === 'armed' || ruleState.status === 'fired') && invalidated) {
    nextState.status = 'idle';
    nextState.invalidatedAt = nowMs;
    nextState.armedAt = null;
    events.push('invalidated');
  }

  return { state: nextState, events };
}

function evaluateRelativeStrength(rule = {}, symbolContext = {}, anchorContext = {}, ruleState = {}, nowMs = Date.now()) {
  const altBar = symbolContext?.bar5m;
  const anchorBar = anchorContext?.bar5m;
  if (!altBar || !anchorBar) {
    return { state: ruleState, events: [] };
  }
  const altChangePct = Number(altBar.open) > 0 ? (Number(altBar.close) - Number(altBar.open)) / Number(altBar.open) : null;
  const anchorChangePct = Number(anchorBar.open) > 0 ? (Number(anchorBar.close) - Number(anchorBar.open)) / Number(anchorBar.open) : null;
  if (!Number.isFinite(altChangePct) || !Number.isFinite(anchorChangePct)) {
    return { state: ruleState, events: [] };
  }

  const altMinChangePct = Number.isFinite(Number(rule.altMinChangePct)) ? Number(rule.altMinChangePct) : 0.002;
  const anchorMaxChangePct = Number.isFinite(Number(rule.anchorMaxChangePct)) ? Number(rule.anchorMaxChangePct) : -0.001;
  const nextState = { ...ruleState };
  const events = [];
  const anchorRed = anchorChangePct <= anchorMaxChangePct;
  const altPositive = altChangePct > 0;
  const altStrong = altChangePct >= altMinChangePct;

  if (anchorRed && altPositive && !altStrong && ruleState.status !== 'armed') {
    nextState.status = 'armed';
    nextState.armedAt = nowMs;
    events.push('armed');
    return { state: nextState, events };
  }

  if (anchorRed && altStrong) {
    if (ruleState.status !== 'fired') {
      nextState.status = 'fired';
      nextState.firedAt = nowMs;
      events.push('fired');
    }
    return { state: nextState, events };
  }

  if ((ruleState.status === 'armed' || ruleState.status === 'fired') && (!anchorRed || altChangePct <= 0)) {
    nextState.status = 'idle';
    nextState.invalidatedAt = nowMs;
    nextState.armedAt = null;
    events.push('invalidated');
  }

  return { state: nextState, events };
}

function evaluateRule(rule = {}, context = {}, ruleState = {}, nowMs = Date.now()) {
  const symbolContext = context.byTicker?.[normalizeTicker(rule.ticker)] || null;
  if (!rule.enabled || !symbolContext) {
    return { state: ruleState, events: [] };
  }
  if (rule.trigger === 'reclaim_hold') {
    return evaluateReclaimHold(rule, symbolContext, ruleState, nowMs);
  }
  if (rule.trigger === 'lose_fail_retest') {
    return evaluateLoseFailRetest(rule, symbolContext, ruleState, nowMs);
  }
  if (rule.trigger === 'relative_strength') {
    const anchorTicker = normalizeTicker(rule.anchorTicker || 'BTC/USD');
    return evaluateRelativeStrength(
      rule,
      symbolContext,
      context.byTicker?.[anchorTicker] || null,
      ruleState,
      nowMs
    );
  }
  return { state: ruleState, events: [] };
}

function resolveWatchedTickers(config = {}) {
  const primary = Array.isArray(config.symbols) ? config.symbols : DEFAULT_SYMBOLS;
  const hot = Array.isArray(config.hotSymbols) ? config.hotSymbols.slice(0, MAX_HOT_SYMBOLS) : [];
  return Array.from(new Set(
    [...primary, ...hot]
      .map((entry) => normalizeTicker(entry))
      .filter(Boolean)
  ));
}

async function fetchWatchContext(config = {}, previousState = {}, options = {}) {
  const tickers = resolveWatchedTickers(config);
  const mode = normalizeMode(options.mode || config.mode || previousState.mode || 'normal');
  const requestOptions = {
    ...(options.clientOptions || {}),
    requestPoolTtlMs: Math.max(
      0,
      Number(
        options.requestPoolTtlMs
        || (mode === 'macro_release'
          ? (config.macroPollIntervalMs || DEFAULT_MACRO_POLL_INTERVAL_MS)
          : (config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS))
      ) || DEFAULT_POLL_INTERVAL_MS
    ),
  };
  const [marketData, bars1mMap, bars5mMap, predictedFundings, openPositions] = await Promise.all([
    hyperliquidClient.getUniverseMarketData(requestOptions),
    hyperliquidClient.getHistoricalBars({
      ...requestOptions,
      symbols: tickers,
      timeframe: '1m',
      limit: 12,
    }),
    hyperliquidClient.getHistoricalBars({
      ...requestOptions,
      symbols: tickers,
      timeframe: '5m',
      limit: 2,
    }),
    hyperliquidClient.getPredictedFundings(requestOptions).catch(() => ({ byCoin: {} })),
    hyperliquidClient.getOpenPositions(requestOptions).catch(() => []),
  ]);

  const marketByTicker = Object.fromEntries(
    (Array.isArray(marketData) ? marketData : []).map((entry) => [normalizeTicker(entry.ticker || `${entry.coin}/USD`), entry])
  );
  const positionsByTicker = new Set(
    (Array.isArray(openPositions) ? openPositions : [])
      .map((position) => normalizeTicker(position.ticker))
      .filter(Boolean)
  );
  const l2Books = await Promise.all(tickers.map(async (ticker) => {
    try {
      const book = await hyperliquidClient.getL2Book({
        ...requestOptions,
        ticker,
      });
      return [ticker, book];
    } catch {
      return [ticker, null];
    }
  }));

  const byTicker = {};
  for (const ticker of tickers) {
    const market = marketByTicker[ticker] || null;
    const coin = toText(market?.coin, ticker.split('/')[0]);
    const previousMarket = previousState?.marketByTicker?.[ticker] || null;
    const bars1m = bars1mMap instanceof Map ? (bars1mMap.get(ticker) || []) : [];
    const bars5m = bars5mMap instanceof Map ? (bars5mMap.get(ticker) || []) : [];
    const l2Book = Object.fromEntries(l2Books)[ticker] || null;
    byTicker[ticker] = {
      ticker,
      coin,
      market,
      previousMarket,
      bars1m,
      bars5m,
      bar5m: getLatestBar(bars5m),
      l2Book,
      predictedFunding: predictedFundings?.byCoin?.[coin.toUpperCase()] || null,
      hasLivePosition: positionsByTicker.has(ticker),
    };
  }
  return {
    tickers,
    byTicker,
    marketByTicker: Object.fromEntries(
      Object.entries(byTicker).map(([ticker, entry]) => [ticker, {
        price: entry?.market?.price ?? null,
        openInterest: entry?.market?.openInterest ?? null,
        fundingRate: entry?.market?.fundingRate ?? null,
        checkedAt: new Date().toISOString(),
      }])
    ),
  };
}

function loadRulesConfig(filePath = DEFAULT_RULES_PATH) {
  const config = readJsonFile(filePath, null);
  if (config) return config;
  const defaults = defaultRulesConfig();
  writeJsonFile(filePath, defaults);
  return defaults;
}

function loadWatchState(filePath = DEFAULT_STATE_PATH) {
  return {
    ...defaultState(),
    ...(readJsonFile(filePath, defaultState()) || {}),
  };
}

async function runWatchCycle(options = {}) {
  const rulesPath = path.resolve(toText(options.rulesPath, DEFAULT_RULES_PATH));
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const config = loadRulesConfig(rulesPath);
  const state = loadWatchState(statePath);
  const mode = normalizeMode(options.mode || config.mode || state.mode || 'normal');
  const nowMs = Date.now();
  let context = null;
  try {
    context = await fetchWatchContext(config, state, { ...options, mode });
  } catch (error) {
    const failedState = {
      ...state,
      updatedAt: new Date(nowMs).toISOString(),
      mode,
      heartbeat: {
        lastTickAt: state?.heartbeat?.lastTickAt || null,
        intervalMs: mode === 'macro_release'
          ? Math.max(1000, Number(config.macroPollIntervalMs) || DEFAULT_MACRO_POLL_INTERVAL_MS)
          : Math.max(1000, Number(config.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS),
        stale: true,
        state: 'red',
        lastErrorAt: new Date(nowMs).toISOString(),
      },
      lastError: String(error?.stack || error?.message || error || 'unknown_watch_cycle_error'),
      lastFailureAt: new Date(nowMs).toISOString(),
    };
    writeJsonFile(statePath, failedState);
    return {
      ok: false,
      status: 'failed',
      error: failedState.lastError,
      rulesPath,
      statePath,
      mode,
    };
  }
  const alerts = [];
  const counters = {
    ...(state.counters || {}),
  };
  const cycleCounters = {
    triggersSeen: 0,
    triggersArmed: 0,
    triggersFired: 0,
    triggersInvalidated: 0,
    staleRulesDetected: 0,
  };
  const nextRulesState = {
    ...(state.rules || {}),
  };
  const staleRules = [];

  for (const rule of Array.isArray(config.rules) ? config.rules : []) {
    const previousRuleState = nextRulesState[rule.id] || {};
    const evaluation = evaluateRule(rule, context, previousRuleState, nowMs);
    const staleEvaluation = evaluateRuleStaleness(
      rule,
      context.byTicker?.[normalizeTicker(rule.ticker)] || null,
      previousRuleState,
      resolveStaleRulePolicy(config),
      nowMs
    );
    const nextRuleState = {
      ...previousRuleState,
      ...evaluation.state,
      ...staleEvaluation.state,
      lastSeenAt: new Date(nowMs).toISOString(),
    };
    const symbolContext = context.byTicker?.[normalizeTicker(rule.ticker)] || null;
    const payload = symbolContext
      ? buildAlertPayload(rule, symbolContext, state.marketByTicker?.[normalizeTicker(rule.ticker)] || {})
      : null;
    const cooldownMs = Math.max(1000, Number(rule.cooldownMs) || DEFAULT_ALERT_COOLDOWN_MS);
    if (staleEvaluation.summary) {
      staleRules.push(staleEvaluation.summary);
    }

    for (const eventType of evaluation.events) {
      cycleCounters.triggersSeen += 1;
      if (eventType === 'armed') cycleCounters.triggersArmed += 1;
      if (eventType === 'fired') cycleCounters.triggersFired += 1;
      if (eventType === 'invalidated') cycleCounters.triggersInvalidated += 1;
      nextRuleState.eventCounts = {
        ...(nextRuleState.eventCounts || {}),
        [eventType]: Number(nextRuleState?.eventCounts?.[eventType] || 0) + 1,
      };
      nextRuleState.lastEventType = eventType;
      nextRuleState.lastEventAt = new Date(nowMs).toISOString();
      const lastAlertAt = previousRuleState?.lastAlertAtByType?.[eventType];
      if (!shouldAlert(lastAlertAt, cooldownMs, nowMs)) {
        continue;
      }
      if (!payload) continue;
      alerts.push({
        eventType,
        ruleId: rule.id,
        ticker: payload.ticker,
        rule,
        message: formatOracleAlert(eventType, rule, payload, mode),
        payload,
      });
      nextRuleState.lastAlertAtByType = {
        ...(nextRuleState.lastAlertAtByType || {}),
        [eventType]: nowMs,
      };
    }

    if (staleEvaluation.event === 'stale' && payload) {
      cycleCounters.staleRulesDetected += 1;
      const lastAlertAt = previousRuleState?.lastAlertAtByType?.stale;
      if (shouldAlert(lastAlertAt, cooldownMs, nowMs)) {
        const stalePayload = {
          ...payload,
          staleRule: staleEvaluation.summary,
        };
        alerts.push({
          eventType: 'stale',
          ruleId: rule.id,
          ticker: payload.ticker,
          rule,
          message: formatOracleAlert('stale', rule, stalePayload, mode),
          payload: stalePayload,
        });
        nextRuleState.lastAlertAtByType = {
          ...(nextRuleState.lastAlertAtByType || {}),
          stale: nowMs,
        };
      }
    }
    nextRulesState[rule.id] = nextRuleState;
  }

  let alertResult = null;
  let telegramAlertResult = null;
  if (alerts.length > 0 && options.sendAlerts !== false) {
    alertResult = sendAgentAlert(
      alerts.map((entry) => entry.message).join('\n'),
      {
        targets: normalizeTargets(options.targets || config.targets || DEFAULT_TARGETS),
        env: process.env,
        cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
        hmSendScriptPath: options.hmSendScriptPath,
        role: 'oracle-watch',
      }
    );
    telegramAlertResult = sendTelegramTradeAlerts(alerts, {
      telegramTradeAlertTickers: options.telegramTradeAlertTickers || config.telegramTradeAlertTickers,
      env: process.env,
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      hmSendScriptPath: options.hmSendScriptPath,
      role: 'oracle-watch',
    });
  }

  const nextState = {
    version: 2,
    updatedAt: new Date(nowMs).toISOString(),
    mode,
    heartbeat: {
      lastTickAt: new Date(nowMs).toISOString(),
      intervalMs: mode === 'macro_release'
        ? Math.max(1000, Number(config.macroPollIntervalMs) || DEFAULT_MACRO_POLL_INTERVAL_MS)
        : Math.max(1000, Number(config.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS),
      stale: false,
      state: 'green',
    },
    counters: {
      triggersSeen: Number(counters.triggersSeen || 0) + cycleCounters.triggersSeen,
      triggersArmed: Number(counters.triggersArmed || 0) + cycleCounters.triggersArmed,
      triggersFired: Number(counters.triggersFired || 0) + cycleCounters.triggersFired,
      triggersInvalidated: Number(counters.triggersInvalidated || 0) + cycleCounters.triggersInvalidated,
      triggersActedOn: Number(counters.triggersActedOn || 0),
      alertsSent: Number(counters.alertsSent || 0) + alerts.length,
      staleRulesDetected: Number(counters.staleRulesDetected || 0) + cycleCounters.staleRulesDetected,
      lastCycleSeen: cycleCounters.triggersSeen,
      lastCycleFired: cycleCounters.triggersFired,
      lastCycleAlertCount: alerts.length,
      lastCycleStaleCount: staleRules.length,
    },
    marketByTicker: context.marketByTicker,
    rules: nextRulesState,
    staleRules,
    lastError: null,
    lastFailureAt: null,
  };
  writeJsonFile(statePath, nextState);

  return {
    ok: true,
    mode,
    rulesPath,
    statePath,
    alertCount: alerts.length,
    alerts,
    alertResult,
    telegramAlertResult,
    tickers: context.tickers,
  };
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;
    options.set(key, value);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const command = parsed.positional[0] || 'run';
  const rulesPath = toText(getOption(parsed.options, 'rules', DEFAULT_RULES_PATH), DEFAULT_RULES_PATH);
  const statePath = toText(getOption(parsed.options, 'state', DEFAULT_STATE_PATH), DEFAULT_STATE_PATH);

  if (command === 'init') {
    const config = loadRulesConfig(rulesPath);
    const state = loadWatchState(statePath);
    writeJsonFile(rulesPath, config);
    writeJsonFile(statePath, state);
    const result = { ok: true, rulesPath: path.resolve(rulesPath), statePath: path.resolve(statePath) };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'run') {
    const once = getOption(parsed.options, 'once', false) === true;
    const pollIntervalMs = Math.max(1000, Number(getOption(parsed.options, 'poll-ms', 0)) || 0);
    let result = await runWatchCycle({
      rulesPath,
      statePath,
      mode: getOption(parsed.options, 'mode', null),
    });
    console.log(JSON.stringify(result, null, 2));
    if (once) return result;

    while (true) {
      const config = loadRulesConfig(rulesPath);
      const mode = normalizeMode(config.mode || 'normal');
      const intervalMs = pollIntervalMs || (mode === 'macro_release'
        ? Math.max(1000, Number(config.macroPollIntervalMs) || DEFAULT_MACRO_POLL_INTERVAL_MS)
        : Math.max(1000, Number(config.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS));
      await sleep(intervalMs);
      result = await runWatchCycle({
        rulesPath,
        statePath,
      });
      console.log(JSON.stringify(result, null, 2));
    }
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_RULES_PATH,
  DEFAULT_STATE_PATH,
  DEFAULT_SYMBOLS,
  defaultRulesConfig,
  defaultState,
  normalizeTicker,
  normalizeTargets,
  normalizeMode,
  loadRulesConfig,
  loadWatchState,
  resolveStaleRulePolicy,
  getRuleThreshold,
  getRuleFloor,
  getRuleReference,
  buildRuleRefreshProposal,
  evaluateRuleStaleness,
  collectStaleRules,
  getLastCloses,
  buildAlertPayload,
  formatOracleAlert,
  formatTelegramTradeAlert,
  evaluateReclaimHold,
  evaluateLoseFailRetest,
  evaluateRelativeStrength,
  evaluateRule,
  resolveWatchedTickers,
  shouldSendTelegramTradeAlert,
  sendTelegramTradeAlerts,
  fetchWatchContext,
  runWatchCycle,
  runCli,
};
