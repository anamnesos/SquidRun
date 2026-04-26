#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveCoordPath } = require('../config');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const bracketManager = require('../modules/trading/bracket-manager');
const agentPositionAttribution = require('../modules/trading/agent-position-attribution');
const oracleWatchRegime = require('../modules/trading/oracle-watch-regime');
const {
  MIN_EXECUTABLE_MARGIN_USD,
  buildRuleTriggerFingerprint,
  resolveExecutableCommandGate,
  shouldSuppressAfterPriorVeto,
} = require('../modules/trading/oracle-watch-execution-gate');
const { evaluateTooLateShortRule } = require('../modules/trading/oracle-watch-too-late-filter');
const { sendAgentAlert } = require('./hm-agent-alert');
const hmDefiExecute = require('./hm-defi-execute');
const hmDefiClose = require('./hm-defi-close');
const hmTrailingStop = require('./hm-trailing-stop');

const DEFAULT_RULES_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-rules.json'), { forWrite: true });
const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-state.json'), { forWrite: true });
const DEFAULT_OPERATING_RULES_PATH = resolveCoordPath(path.join('runtime', 'agent-operating-rules.json'), { forWrite: true });
const DEFAULT_HARD_RISK_STATE_PATH = resolveCoordPath(path.join('runtime', 'hard-risk-state.json'), { forWrite: true });
const DEFAULT_PROMOTION_DECISIONS_PATH = resolveCoordPath(path.join('runtime', 'oracle-watch-promotion-decisions.jsonl'), { forWrite: true });
const DEFAULT_ARCH_QUIET_STATE_PATH = resolveCoordPath(path.join('runtime', 'architect-quiet-watch-state.json'), { forWrite: true });
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
const DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS = 60 * 1000;
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
const DEFAULT_EXECUTION_CARRY_FORWARD_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_AUTO_EXECUTE_MIN_MARGIN_USD = MIN_EXECUTABLE_MARGIN_USD;
const DEFAULT_CONTINUATION_SHORT_STOP_BUFFER_PCT = 0.0035;
const DEFAULT_ORACLE_POSITION_TRAIL_PCT = 0.6;
const DEFAULT_ORACLE_HARVEST_CLOSE_PCT = 50;
const DEFAULT_DEGRADED_CONTEXT_MAX_AGE_MS = Math.max(
  60 * 1000,
  Number.parseInt(process.env.SQUIDRUN_ORACLE_WATCH_DEGRADED_CONTEXT_MAX_AGE_MS || '1800000', 10) || 1800000
);

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

function normalizeRuleIdPriceFragment(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return numeric
    .toFixed(Math.max(0, digits))
    .replace(/\.?0+$/, '')
    .replace(/^-/, 'm')
    .replace('.', 'p');
}

function buildCanonicalRuleIdentity(rule = {}) {
  if (toText(rule?.sourceTag || rule?.source, '') === oracleWatchRegime.AUTO_RULE_SOURCE) {
    return null;
  }
  const ticker = normalizeTicker(rule?.ticker);
  const trigger = toText(rule?.trigger, '').toLowerCase();
  if (!ticker || !trigger) return null;
  const coin = ticker.replace('/USD', '');
  const digits = resolveRulePrecision(rule);
  const timeframe = toText(rule?.timeframe, '1m');
  const confirmCloses = Math.max(1, Number(rule?.confirmCloses) || 2);
  if (trigger === 'reclaim_hold' && Number.isFinite(Number(rule?.level))) {
    const level = Number(rule.level);
    const levelText = formatPrice(level, digits);
    const suffix = toText(rule?.name, '').toLowerCase().includes('alert-only')
      ? ' (alert-only under short-bias)'
      : '';
    return {
      id: `${coin.toLowerCase()}-long-reclaim-${normalizeRuleIdPriceFragment(level, digits)}`,
      name: `${coin} long alert — reclaim ${levelText} hold ${confirmCloses}x ${timeframe}${suffix}`,
    };
  }
  if (
    trigger === 'lose_fail_retest'
    && Number.isFinite(Number(rule?.loseLevel))
    && Number.isFinite(Number(rule?.retestMin))
    && Number.isFinite(Number(rule?.retestMax))
  ) {
    const loseLevel = Number(rule.loseLevel);
    const retestMin = Number(rule.retestMin);
    const retestMax = Number(rule.retestMax);
    return {
      id: `${coin.toLowerCase()}-short-lose-${normalizeRuleIdPriceFragment(loseLevel, digits)}-fail-retest`,
      name: `${coin} short — lose ${formatPrice(loseLevel, digits)} (${timeframe}) then fail retest ${formatPrice(retestMin, digits)}-${formatPrice(retestMax, digits)}`,
    };
  }
  if (
    trigger === 'reclaim_hold'
    && Number.isFinite(Number(rule?.zone?.min))
    && Number.isFinite(Number(rule?.zone?.max))
  ) {
    const min = Number(rule.zone.min);
    const max = Number(rule.zone.max);
    return {
      id: `${coin.toLowerCase()}-reclaim-${normalizeRuleIdPriceFragment(min, digits)}-${normalizeRuleIdPriceFragment(max, digits)}`,
      name: `${coin} reclaim ${formatPrice(min, digits)}-${formatPrice(max, digits)}`,
    };
  }
  return null;
}

function normalizeRuleCatalog(config = {}, options = {}) {
  const currentRules = Array.isArray(config?.rules) ? config.rules : [];
  const idMap = {};
  let changed = false;
  const nextRules = currentRules.map((rule = {}) => {
    const canonical = buildCanonicalRuleIdentity(rule);
    if (!canonical) return rule;
    const nextRule = {
      ...rule,
      id: canonical.id,
      name: canonical.name,
    };
    if (nextRule.id !== rule.id) {
      idMap[rule.id] = nextRule.id;
      changed = true;
    }
    if (nextRule.name !== rule.name) {
      changed = true;
    }
    return nextRule;
  });

  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  let stateChanged = false;
  if (Object.keys(idMap).length > 0) {
    const watchState = readJsonFile(statePath, null);
    if (watchState && typeof watchState === 'object') {
      const nextRulesState = { ...(watchState.rules || {}) };
      for (const [oldId, nextId] of Object.entries(idMap)) {
        if (oldId === nextId) continue;
        if (Object.prototype.hasOwnProperty.call(nextRulesState, oldId) && !Object.prototype.hasOwnProperty.call(nextRulesState, nextId)) {
          nextRulesState[nextId] = nextRulesState[oldId];
        }
        delete nextRulesState[oldId];
      }
      watchState.rules = nextRulesState;
      if (Array.isArray(watchState.staleRules)) {
        watchState.staleRules = watchState.staleRules.map((entry = {}) => ({
          ...entry,
          ruleId: idMap[entry.ruleId] || entry.ruleId,
        }));
      }
      writeJsonFile(statePath, watchState);
      stateChanged = true;
    }
  }

  return {
    config: changed ? {
      ...config,
      rules: nextRules,
    } : config,
    changed,
    idMap,
    stateChanged,
  };
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
    rateLimit: {
      consecutive429s: 0,
      backoffUntil: null,
      last429At: null,
      lastBackoffMs: 0,
      lastError: null,
    },
    marketByTicker: {},
    watchContextSnapshot: null,
    rules: {},
    staleRules: [],
  };
}

function summarizeWatchContextByTicker(contextByTicker = {}) {
  const entries = Object.entries(contextByTicker || {});
  return Object.fromEntries(entries.map(([ticker, entry]) => {
    const bars1m = Array.isArray(entry?.bars1m) ? entry.bars1m : [];
    const bars5m = Array.isArray(entry?.bars5m) ? entry.bars5m : [];
    const latest1m = bars1m.length > 0 ? bars1m[bars1m.length - 1] : null;
    const latest5m = bars5m.length > 0 ? bars5m[bars5m.length - 1] : null;
    return [ticker, {
      ticker,
      coin: toText(entry?.coin, ticker.split('/')[0]),
      market: entry?.market || null,
      predictedFunding: entry?.predictedFunding || null,
      hasLivePosition: entry?.hasLivePosition === true,
      latest1mClose: pickFiniteNumber(latest1m?.close, null),
      latest5mClose: pickFiniteNumber(latest5m?.close, null),
      latest5mBarAt: toText(latest5m?.timestamp, null),
    }];
  }));
}

function buildWatchContextSnapshot(context = null, nowMs = Date.now()) {
  if (!context || typeof context !== 'object') return null;
  return {
    capturedAt: new Date(nowMs).toISOString(),
    tickers: Array.isArray(context.tickers) ? context.tickers.slice() : [],
    marketByTicker: context.marketByTicker || {},
    byTicker: summarizeWatchContextByTicker(context.byTicker || {}),
    openPositions: Array.isArray(context.openPositions)
      ? context.openPositions.map((position = {}) => ({
        ticker: normalizeTicker(position?.ticker || `${toText(position?.coin, '')}/USD`),
        coin: toText(position?.coin, position?.ticker ? position.ticker.split('/')[0] : ''),
        size: pickFiniteNumber(position?.size, 0),
        side: toText(position?.side, ''),
        avgPrice: pickFiniteNumber(position?.avgPrice, null),
        unrealizedPnl: pickFiniteNumber(position?.unrealizedPnl, null),
      }))
      : [],
  };
}

function resolveUsableWatchContextSnapshot(state = {}, nowMs = Date.now(), maxAgeMs = DEFAULT_DEGRADED_CONTEXT_MAX_AGE_MS) {
  const snapshot = state?.watchContextSnapshot;
  const capturedAtMs = Date.parse(toText(snapshot?.capturedAt, ''));
  if (!snapshot || !Number.isFinite(capturedAtMs)) {
    return null;
  }
  const ageMs = Math.max(0, nowMs - capturedAtMs);
  if (ageMs > Math.max(60 * 1000, toNumber(maxAgeMs, DEFAULT_DEGRADED_CONTEXT_MAX_AGE_MS))) {
    return null;
  }
  return {
    snapshot,
    ageMs,
  };
}

function buildDegradedWatchState(state = {}, nowMs = Date.now(), intervalMs = DEFAULT_POLL_INTERVAL_MS, mode = 'normal', rateLimit = {}, snapshotMeta = null, executionResult = null) {
  const snapshot = snapshotMeta?.snapshot || null;
  const snapshotAgeMs = Number(snapshotMeta?.ageMs || 0);
  const nextState = {
    ...state,
    updatedAt: new Date(nowMs).toISOString(),
    mode,
    heartbeat: {
      ...(state.heartbeat || {}),
      lastTickAt: new Date(nowMs).toISOString(),
      intervalMs,
      stale: false,
      state: 'degraded_backoff',
      lastObservedAt: new Date(nowMs).toISOString(),
      lastErrorAt: toText(rateLimit?.last429At, new Date(nowMs).toISOString()),
      backoffUntil: toText(rateLimit?.backoffUntil, null),
      degradedFromSnapshotAt: toText(snapshot?.capturedAt, null),
      degradedSnapshotAgeMs: snapshotAgeMs,
    },
    rateLimit,
    marketByTicker: snapshot?.marketByTicker || state.marketByTicker || {},
    watchContextSnapshot: snapshot || state.watchContextSnapshot || null,
    execution: executionResult ? {
      attempted: Number(executionResult.attempted || 0),
      succeeded: Number(executionResult.succeeded || 0),
      executions: Array.isArray(executionResult.executions) ? executionResult.executions.slice(-12) : [],
      updatedAt: new Date(nowMs).toISOString(),
    } : (state.execution || {
      attempted: 0,
      succeeded: 0,
      executions: [],
      updatedAt: new Date(nowMs).toISOString(),
    }),
    positionManagement: {
      ...(state.positionManagement || {
        reviewed: 0,
        acted: 0,
        actions: [],
      }),
      skippedReason: 'degraded_backoff',
      updatedAt: new Date(nowMs).toISOString(),
    },
    lastError: rateLimit?.lastError || '429_backoff_active',
    lastFailureAt: toText(rateLimit?.last429At, new Date(nowMs).toISOString()),
  };
  return nextState;
}

function extractOracleBoardSymbolsFromOperatingRules(payload = null) {
  const primaryScopeRule = Array.isArray(payload?.roles?.oracle?.rules)
    ? payload.roles.oracle.rules.find((rule) => /primary live scope/i.test(toText(rule)))
    : '';
  const match = toText(primaryScopeRule).match(/:\s*(.+?)\.\s*$/);
  if (!match) return [];
  return Array.from(new Set(
    String(match[1] || '')
      .split(',')
      .map((entry) => normalizeTicker(entry))
      .filter(Boolean)
  ));
}

function reconcileRulesConfig(config = {}, options = {}) {
  const operatingRulesPath = path.resolve(toText(options.operatingRulesPath, DEFAULT_OPERATING_RULES_PATH));
  const operatingRules = readJsonFile(operatingRulesPath, null);
  const oracleBoardSymbols = extractOracleBoardSymbolsFromOperatingRules(operatingRules);
  if (oracleBoardSymbols.length === 0) {
    return {
      config,
      changed: false,
      oracleBoardSymbols: [],
      operatingRulesPath,
    };
  }

  const currentSymbols = Array.isArray(config.symbols) ? config.symbols : [];
  const mergedSymbols = Array.from(new Set(
    [...oracleBoardSymbols, ...currentSymbols]
      .map((entry) => normalizeTicker(entry))
      .filter(Boolean)
  ));
  const changed = JSON.stringify(mergedSymbols) !== JSON.stringify(currentSymbols);
  return {
    config: changed ? {
      ...config,
      symbols: mergedSymbols,
    } : config,
    changed,
    oracleBoardSymbols,
    operatingRulesPath,
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
  const leverage = Number.isFinite(Number(rule?.suggestedLeverage))
    ? Number(rule.suggestedLeverage)
    : (majors.has(asset) ? 25 : asset === 'SOL' ? 20 : 10);
  const margin = Number.isFinite(Number(rule?.suggestedMarginUsd))
    ? Number(rule.suggestedMarginUsd)
    : (majors.has(asset) ? 12 : asset === 'SOL' ? 10 : 8);
  const executionGate = resolveExecutableCommandGate(rule, {
    fallbackMarginUsd: margin,
  });
  if (!executionGate.executable) {
    return null;
  }
  let direction = 'LONG';
  let stopLoss = null;
  if (rule.trigger === 'lose_fail_retest') {
    direction = 'SHORT';
    stopLoss = resolveWatchExecutionStopLoss(rule, payload);
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
  const command = buildSuggestedCommand(rule, payload, eventType);
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
    executionReady: eventType === 'fired' && chartLocation.executable === true && command != null,
    command,
  };
  return `(ORACLE WATCH): ${JSON.stringify(compact)}`;
}

function resolveTradeDirection(rule = {}) {
  return rule.trigger === 'lose_fail_retest' ? 'SHORT' : 'LONG';
}

function getRuleActivityTimestamp(ruleState = {}) {
  const candidates = [
    ruleState?.lastEventAt,
    ruleState?.firedAt,
    ruleState?.armedAt,
    ruleState?.lastSeenAt,
  ]
    .map((value) => new Date(value || 0).getTime())
    .filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

function getRuleActivityRank(ruleState = {}) {
  if (ruleState?.status === 'fired') return 2;
  if (ruleState?.status === 'armed') return 1;
  return 0;
}

function reconcileDirectionalConflicts(config = {}, nextRulesState = {}, nowMs = Date.now()) {
  const rules = Array.isArray(config.rules) ? config.rules : [];
  const grouped = new Map();
  for (const rule of rules) {
    const ticker = normalizeTicker(rule?.ticker);
    if (!ticker || !rule?.enabled) continue;
    const direction = resolveTradeDirection(rule);
    if (!grouped.has(ticker)) {
      grouped.set(ticker, { LONG: [], SHORT: [] });
    }
    grouped.get(ticker)[direction].push(rule);
  }

  let invalidatedCount = 0;
  for (const [, directions] of grouped.entries()) {
    const activeLongs = directions.LONG
      .map((rule) => ({ rule, state: nextRulesState?.[rule.id] || {} }))
      .filter(({ state }) => state?.status === 'armed' || state?.status === 'fired');
    const activeShorts = directions.SHORT
      .map((rule) => ({ rule, state: nextRulesState?.[rule.id] || {} }))
      .filter(({ state }) => state?.status === 'armed' || state?.status === 'fired');
    if (activeLongs.length === 0 || activeShorts.length === 0) continue;

    const compareActiveRules = (left, right) => {
      const rankDiff = getRuleActivityRank(right.state) - getRuleActivityRank(left.state);
      if (rankDiff !== 0) return rankDiff;
      return getRuleActivityTimestamp(right.state) - getRuleActivityTimestamp(left.state);
    };

    const winner = [...activeLongs, ...activeShorts].sort(compareActiveRules)[0];
    const losers = [...activeLongs, ...activeShorts].filter(({ rule }) => rule.id !== winner.rule.id);
    for (const loser of losers) {
      const previousState = nextRulesState?.[loser.rule.id] || {};
      if (previousState.status !== 'armed' && previousState.status !== 'fired') continue;
      nextRulesState[loser.rule.id] = {
        ...previousState,
        status: 'idle',
        armedAt: null,
        invalidatedAt: nowMs,
        lastEventType: 'invalidated',
        lastEventAt: new Date(nowMs).toISOString(),
        eventCounts: {
          ...(previousState.eventCounts || {}),
          invalidated: Number(previousState?.eventCounts?.invalidated || 0) + 1,
        },
        conflictResolution: {
          status: 'superseded',
          supersededAt: new Date(nowMs).toISOString(),
          supersededByRuleId: winner.rule.id,
          supersededByDirection: resolveTradeDirection(winner.rule),
        },
      };
      invalidatedCount += 1;
    }
  }

  return { nextRulesState, invalidatedCount };
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

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function resolveExecutionRiskState(options = {}) {
  const hardRiskState = readJsonFile(
    path.resolve(toText(options.hardRiskStatePath, DEFAULT_HARD_RISK_STATE_PATH)),
    {}
  ) || {};
  const quietWatchState = readJsonFile(
    path.resolve(toText(options.architectQuietStatePath, DEFAULT_ARCH_QUIET_STATE_PATH)),
    {}
  ) || {};
  const quietRiskState = quietWatchState?.risk && typeof quietWatchState.risk === 'object'
    ? quietWatchState.risk
    : null;
  const hardUpdatedAt = Date.parse(toText(hardRiskState.updatedAt, ''));
  const quietUpdatedAt = Date.parse(toText(quietRiskState?.updatedAt || quietWatchState?.updatedAt, ''));
  return (Number.isFinite(quietUpdatedAt) && quietUpdatedAt >= (Number.isFinite(hardUpdatedAt) ? hardUpdatedAt : 0))
    ? { ...(quietRiskState || {}) }
    : { ...hardRiskState };
}

function buildExecutionAttemptKey(alert = {}, ruleState = {}) {
  const firedAt = toText(ruleState?.lastEventAt || ruleState?.firedAt, '');
  return `${toText(alert.ruleId, '')}:${firedAt}`;
}

function resolveWatchExecutionMargin(rule = {}, riskState = {}, options = {}) {
  const suggested = pickFiniteNumber(rule?.suggestedMarginUsd, NaN);
  const fallback = pickFiniteNumber(
    buildSuggestedCommand(rule, { ticker: rule?.ticker }, 'fired')
      ?.match(/--margin\s+([0-9.]+)/)?.[1],
    NaN
  );
  const requestedMarginUsd = Number.isFinite(suggested) ? suggested : fallback;
  const cappedByDesk = pickFiniteNumber(riskState?.remainingPerTradeMarginCapUsd, requestedMarginUsd);
  const minMarginUsd = Math.max(
    0,
    pickFiniteNumber(options.minMarginUsd, DEFAULT_AUTO_EXECUTE_MIN_MARGIN_USD)
  );
  if (!Number.isFinite(requestedMarginUsd) || requestedMarginUsd <= 0) {
    return {
      marginUsd: null,
      requestedMarginUsd: null,
      minMarginUsd,
      cappedByDesk,
      blockReason: 'missing_requested_margin',
    };
  }
  const normalizedRequestedMarginUsd = requestedMarginUsd;
  if (normalizedRequestedMarginUsd < minMarginUsd) {
    return {
      marginUsd: null,
      requestedMarginUsd: normalizedRequestedMarginUsd,
      minMarginUsd,
      cappedByDesk,
      blockReason: 'below_mission_floor',
    };
  }
  if (!Number.isFinite(cappedByDesk) || cappedByDesk <= 0) {
    return {
      marginUsd: null,
      requestedMarginUsd,
      minMarginUsd,
      cappedByDesk,
      blockReason: 'missing_desk_cap',
    };
  }
  const effectiveMarginUsd = round(Math.min(normalizedRequestedMarginUsd, cappedByDesk), 2);
  return {
    marginUsd: effectiveMarginUsd,
    requestedMarginUsd: normalizedRequestedMarginUsd,
    minMarginUsd,
    cappedByDesk,
    blockReason: (effectiveMarginUsd < minMarginUsd)
      ? 'desk_cap_below_mission_floor'
      : null,
  };
}

function resolveWatchExecutionLeverage(rule = {}, payload = {}) {
  const asset = normalizeTicker(payload?.ticker || rule?.ticker).split('/')[0] || '';
  const majors = new Set(['BTC', 'ETH']);
  if (Number.isFinite(Number(rule?.suggestedLeverage)) && Number(rule.suggestedLeverage) > 0) {
    return Math.max(1, Math.floor(Number(rule.suggestedLeverage)));
  }
  if (majors.has(asset)) return 25;
  if (asset === 'SOL') return 20;
  return 10;
}

function resolveWatchExecutionStopLoss(rule = {}, payload = {}) {
  if (rule.trigger === 'lose_fail_retest') {
    const retestMax = pickFiniteNumber(rule?.retestMax, NaN);
    if (!Number.isFinite(retestMax)) return null;

    const isSharedContinuation = (
      toText(rule?.sourceTag, '') === 'shared_regime_auto'
      || toText(rule?.metadata?.regime, '') === 'shared_short_continuation'
    );
    if (!isSharedContinuation) {
      return retestMax;
    }

    const digits = resolveRulePrecision(rule);
    const retestMin = pickFiniteNumber(rule?.retestMin, retestMax);
    const structureHigh = pickFiniteNumber(
      rule?.metadata?.generatedStructureHigh,
      pickFiniteNumber(rule?.metadata?.structureHigh, NaN)
    );
    const anchorPrice = pickFiniteNumber(
      payload?.livePrice,
      pickFiniteNumber(
        rule?.metadata?.generatedFromPrice,
        pickFiniteNumber(rule?.loseLevel, retestMax)
      )
    );
    const buffer = Math.max(
      Math.max(0, retestMax - retestMin),
      Math.max(0, anchorPrice * DEFAULT_CONTINUATION_SHORT_STOP_BUFFER_PCT)
    );
    const ceiling = Math.max(
      retestMax,
      Number.isFinite(structureHigh) ? structureHigh : retestMax
    );
    return roundToPrecision(ceiling + buffer, digits);
  }
  if (rule.trigger === 'reclaim_hold') {
    return Number.isFinite(Number(rule.level)) ? Number(rule.level) : null;
  }
  return null;
}

function resolveWatchExecutionConfidence(rule = {}) {
  return clamp(
    pickFiniteNumber(
      rule?.signalConfidence,
      pickFiniteNumber(rule?.confidence, rule?.sourceTag === 'shared_regime_auto' ? 0.68 : 0.65)
    ),
    0.5,
    0.95
  );
}

async function buildSharedExecutionSnapshot(options = {}) {
  const requestOptions = {
    ...(options.context?.requestOptions || {}),
    ...(options.clientOptions || {}),
  };
  const byTicker = options.context?.byTicker || {};
  const allMids = {};
  for (const entry of Object.values(byTicker)) {
    const coin = toText(entry?.coin, '');
    const price = pickFiniteNumber(entry?.market?.price, NaN);
    if (coin && Number.isFinite(price) && price > 0) {
      allMids[coin] = String(price);
    }
  }

  const [clearinghouseState, metaAndAssetCtxs] = await Promise.all([
    hyperliquidClient.getClearinghouseState(requestOptions).catch(() => null),
    hyperliquidClient.getMetaAndAssetCtxs(requestOptions).catch(() => null),
  ]);
  const [meta] = Array.isArray(metaAndAssetCtxs) ? metaAndAssetCtxs : [null];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const resolvedAssetsByTicker = new Map(
    universe.map((asset, assetIndex) => [
      normalizeTicker(`${toText(asset?.name || asset?.coin || '', '')}/USD`),
      { asset, assetIndex },
    ]).filter(([ticker]) => Boolean(ticker))
  );

  return {
    clearinghouseState,
    meta,
    allMids,
    resolvedAssetsByTicker,
  };
}

async function runQuietly(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const capturedStdout = [];
  const capturedStderr = [];
  console.log = (...args) => {
    capturedStdout.push(args.map((value) => String(value)).join(' '));
  };
  console.error = (...args) => {
    capturedStderr.push(args.map((value) => String(value)).join(' '));
  };
  try {
    const result = await fn();
    return {
      result,
      capturedStdout,
      capturedStderr,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function maybeAutoExecuteFiredAlerts(alerts = [], nextRulesState = {}, options = {}) {
  if (options.autoExecuteFiredSignals === false) {
    return {
      attempted: 0,
      succeeded: 0,
      executions: [],
      skippedReason: 'auto_execute_disabled',
    };
  }

  const riskState = resolveExecutionRiskState(options);
  if (toText(riskState.mode, 'normal') === 'paused' || pickFiniteNumber(riskState.remainingLossBudgetUsd, 0) <= 0) {
    return {
      attempted: 0,
      succeeded: 0,
      executions: [],
      skippedReason: 'risk_paused',
      riskState,
    };
  }

  const executionCandidates = new Map();
  const forcedOutcomeExecutions = [];
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    if (alert?.eventType !== 'fired') continue;
    executionCandidates.set(toText(alert.ruleId, ''), alert);
  }

  const nowMs = Date.now();
  const freshnessWindowMs = Math.max(
    60 * 1000,
    Number(options.executionCarryForwardWindowMs || DEFAULT_EXECUTION_CARRY_FORWARD_WINDOW_MS) || DEFAULT_EXECUTION_CARRY_FORWARD_WINDOW_MS
  );
  const configRules = Array.isArray(options.config?.rules) ? options.config.rules : [];
  for (const rule of configRules) {
    if (!rule?.id || executionCandidates.has(rule.id)) continue;
    const ruleState = nextRulesState?.[rule.id] || {};
    if (ruleState?.status !== 'fired') continue;
    if (Number(ruleState?.actedOnCount || 0) > 0) continue;
    if (ruleState?.conflictResolution?.status === 'superseded') continue;
    const firedAtMs = Number(ruleState?.firedAt) || Date.parse(toText(ruleState?.lastEventAt, ''));
    if (!Number.isFinite(firedAtMs) || (nowMs - firedAtMs) > freshnessWindowMs) continue;
    const ticker = normalizeTicker(rule.ticker);
    const isSharedRegimeAuto = toText(rule?.sourceTag, '') === 'shared_regime_auto';
    if (isSharedRegimeAuto) {
      const executionSummary = {
        ruleId: rule.id,
        ticker,
        status: 'invalidated_missed_same_cycle',
        carriedForward: true,
        attemptedAt: new Date(nowMs).toISOString(),
        triggerFingerprint: buildRuleTriggerFingerprint(rule),
        lastAttemptKey: buildExecutionAttemptKey({
          ruleId: rule.id,
          ticker,
          payload: { ticker },
        }, ruleState),
        riskMode: toText(riskState.mode, 'normal'),
        remainingPerTradeMarginCapUsd: pickFiniteNumber(riskState.remainingPerTradeMarginCapUsd, null),
        requestedMarginUsd: pickFiniteNumber(rule?.suggestedMarginUsd, null),
        minMarginUsd: pickFiniteNumber(options.autoExecuteMinMarginUsd, null),
        marginUsd: null,
        leverage: pickFiniteNumber(rule?.suggestedLeverage, null),
        stopLossPrice: null,
        error: 'shared_regime_auto_requires_same_cycle_outcome',
        execution: null,
      };
      nextRulesState[rule.id] = {
        ...ruleState,
        status: 'idle',
        armedAt: null,
        firedAt: null,
        invalidatedAt: executionSummary.attemptedAt,
        execution: executionSummary,
        actedOnAt: executionSummary.attemptedAt,
        actedOnCount: Number(ruleState?.actedOnCount || 0),
        actedOnNote: executionSummary.status,
      };
      forcedOutcomeExecutions.push(executionSummary);
      continue;
    }
    const symbolContext = options.context?.byTicker?.[ticker]
      || (options.previousState?.marketByTicker?.[ticker]
        ? {
          ticker,
          market: options.previousState.marketByTicker[ticker],
          previousMarket: options.previousState.marketByTicker[ticker],
          bars1m: [],
          bars5m: [],
          bar5m: null,
          l2Book: null,
          predictedFunding: null,
          hasLivePosition: false,
        }
        : null);
    if (!symbolContext) continue;
    executionCandidates.set(rule.id, {
      eventType: 'fired',
      ruleId: rule.id,
      ticker,
      rule,
      payload: buildAlertPayload(
        rule,
        symbolContext,
        options.previousState?.marketByTicker?.[ticker] || {}
      ),
      carriedForward: true,
    });
  }

  const executions = [];
  const sharedExecutionSnapshot = executionCandidates.size > 0
    ? await buildSharedExecutionSnapshot(options).catch(() => ({
      clearinghouseState: null,
      meta: null,
      allMids: {},
      resolvedAssetsByTicker: new Map(),
    }))
    : {
      clearinghouseState: null,
      meta: null,
      allMids: {},
      resolvedAssetsByTicker: new Map(),
    };
  for (const alert of executionCandidates.values()) {
    const rule = alert?.rule || {};
    const payload = alert?.payload || {};
    const ruleState = nextRulesState?.[alert.ruleId] || {};
    const previousExecutionSummary = ruleState?.execution || null;
    const executionAttemptKey = buildExecutionAttemptKey(alert, ruleState);
    const chartLocation = evaluateChartLocation(rule, payload);
    const marginResolution = resolveWatchExecutionMargin(rule, riskState, {
      minMarginUsd: options.autoExecuteMinMarginUsd,
    });
    const sameCycleMandatory = toText(rule?.sourceTag, '') === 'shared_regime_auto';
    let status = 'skipped';
    let error = null;
    let execution = null;

    if (payload?.hasLivePosition) {
      status = 'skipped_live_position';
    } else if (chartLocation.executable !== true) {
      status = 'skipped_not_executable';
    } else if (rule.autoExecute === false) {
      status = 'skipped_manual_rule';
    } else if (toText(ruleState?.execution?.lastAttemptKey, '') === executionAttemptKey) {
      status = 'skipped_duplicate_attempt';
    } else if (marginResolution.blockReason === 'below_mission_floor' || marginResolution.blockReason === 'desk_cap_below_mission_floor') {
      status = 'deferred_below_mission_floor';
      error = `requested_margin_${marginResolution.requestedMarginUsd}_below_min_${marginResolution.minMarginUsd}`;
    } else {
      const marginUsd = marginResolution.marginUsd;
      const leverage = resolveWatchExecutionLeverage(rule, payload);
      const stopLossPrice = resolveWatchExecutionStopLoss(rule, alert?.payload || {});
      const ticker = normalizeTicker(payload?.ticker || rule?.ticker);
      const asset = ticker.split('/')[0] || '';
      if (!asset || !marginUsd || marginUsd <= 0 || !Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(stopLossPrice) || stopLossPrice <= 0) {
        status = 'skipped_missing_execution_inputs';
      } else {
        status = 'attempted';
        try {
          const ticker = normalizeTicker(payload?.ticker || rule?.ticker);
          const symbolContext = options.context?.byTicker?.[ticker] || null;
          const resolvedAsset = sharedExecutionSnapshot.resolvedAssetsByTicker.get(ticker) || null;
          const quietExecution = await runQuietly(() => hmDefiExecute.openHyperliquidPosition({
            asset,
            requestedDirection: resolveTradeDirection(rule),
            directionInput: resolveTradeDirection(rule),
            margin: marginUsd,
            leverage,
            stopLossPrice,
            signalConfidence: resolveWatchExecutionConfidence(rule),
            strategyLane: 'oracle_watch',
            clientOrderId: `oracle-watch-${alert.ruleId}-${Date.parse(toText(ruleState?.lastEventAt, '')) || Date.now()}`,
            originatingAgentId: 'oracle',
            attributionSource: 'oracle_watch_auto',
            attributionReasoning: JSON.stringify({
              triggerId: alert.ruleId,
              ticker,
              sourceTag: toText(rule.sourceTag, null),
              firedAt: toText(ruleState?.lastEventAt, null),
            }),
            executionSnapshot: {
              clearinghouseState: sharedExecutionSnapshot.clearinghouseState,
              meta: sharedExecutionSnapshot.meta,
              allMids: sharedExecutionSnapshot.allMids,
              resolvedAsset,
            },
            historicalBars: Array.isArray(symbolContext?.bars1m) ? symbolContext.bars1m : [],
            skipDuplicateCheck: true,
          }));
          execution = {
            ...(quietExecution.result || {}),
            watchExecutionCapturedStdout: quietExecution.capturedStdout,
            watchExecutionCapturedStderr: quietExecution.capturedStderr,
          };
        } catch (attemptError) {
          error = toText(attemptError?.stack || attemptError?.message, 'execution_failed');
        }
      }
    }

    if (sameCycleMandatory) {
      if (status === 'attempted') {
        const hasProtectedFill = execution
          && execution.duplicatePrevented !== true
          && Number(execution.size || 0) > 0
          && execution.stopLossConfigured === true
          && execution.takeProfitConfigured === true;
        if (hasProtectedFill) {
          status = 'filled_protected';
        } else if (execution?.duplicatePrevented === true) {
          status = 'invalidated_duplicate_attempt';
          error = error || 'shared_regime_auto_duplicate_attempt';
        } else if (execution) {
          status = 'protection_fault';
          error = error || 'shared_regime_auto_fill_without_verified_protection';
        } else {
          status = 'invalidated_execution_failed';
          error = error || 'shared_regime_auto_execution_failed';
        }
      } else if (status === 'skipped_not_executable') {
        status = 'invalidated_not_executable';
      } else if (status === 'skipped_duplicate_attempt') {
        status = 'invalidated_duplicate_attempt';
      } else if (status === 'skipped_missing_execution_inputs') {
        status = 'invalidated_missing_execution_inputs';
      }
    }

    const mergedExecution = execution && execution.duplicatePrevented && previousExecutionSummary?.execution
      ? {
        ...execution,
        stopLossConfigured: Boolean(execution.stopLossConfigured || previousExecutionSummary.execution.stopLossConfigured),
        takeProfitConfigured: Boolean(execution.takeProfitConfigured || previousExecutionSummary.execution.takeProfitConfigured),
        stopPrice: execution.stopPrice || previousExecutionSummary.execution.stopPrice || null,
        takeProfitPrice: execution.takeProfitPrice || previousExecutionSummary.execution.takeProfitPrice || null,
        firstTakeProfitPrice: execution.firstTakeProfitPrice || previousExecutionSummary.execution.firstTakeProfitPrice || null,
        runnerTakeProfitPrice: execution.runnerTakeProfitPrice || previousExecutionSummary.execution.runnerTakeProfitPrice || null,
      }
      : execution;

    const executionSummary = {
      ruleId: alert.ruleId,
      ticker: normalizeTicker(payload?.ticker || rule?.ticker),
      status,
      carriedForward: alert?.carriedForward === true,
      attemptedAt: new Date().toISOString(),
      lastAttemptKey: executionAttemptKey,
      triggerFingerprint: buildRuleTriggerFingerprint(rule),
      riskMode: toText(riskState.mode, 'normal'),
      remainingPerTradeMarginCapUsd: pickFiniteNumber(riskState.remainingPerTradeMarginCapUsd, null),
      requestedMarginUsd: marginResolution.requestedMarginUsd,
      minMarginUsd: marginResolution.minMarginUsd,
      marginUsd: marginResolution.marginUsd,
      leverage: resolveWatchExecutionLeverage(rule, payload),
      stopLossPrice: resolveWatchExecutionStopLoss(rule, alert?.payload || {}),
      error,
      execution: mergedExecution,
    };
    nextRulesState[alert.ruleId] = {
      ...ruleState,
      status: sameCycleMandatory && status !== 'filled_protected' ? 'idle' : ruleState?.status,
      armedAt: sameCycleMandatory && status !== 'filled_protected' ? null : ruleState?.armedAt,
      firedAt: sameCycleMandatory && status !== 'filled_protected' ? null : ruleState?.firedAt,
      invalidatedAt: sameCycleMandatory && status !== 'filled_protected'
        ? executionSummary.attemptedAt
        : ruleState?.invalidatedAt,
      execution: executionSummary,
      actedOnAt: executionSummary.attemptedAt,
      actedOnCount: Number(ruleState?.actedOnCount || 0) + ((status === 'attempted' || status === 'filled_protected') ? 1 : 0),
      actedOnNote: status,
    };
    executions.push(executionSummary);
  }

  return {
    attempted: executions.filter((entry) => entry.status === 'attempted' || entry.status === 'filled_protected').length,
    succeeded: executions.filter((entry) => entry.status === 'filled_protected' || (entry.status === 'attempted' && entry.execution)).length,
    executions: [...forcedOutcomeExecutions, ...executions],
    riskState,
  };
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

function logPromotionDecision(payload) {
  try {
    fs.mkdirSync(path.dirname(DEFAULT_PROMOTION_DECISIONS_PATH), { recursive: true });
    fs.appendFileSync(DEFAULT_PROMOTION_DECISIONS_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // non-fatal: decision log is observability only
  }
}

function evaluateLoseFailRetest(rule = {}, symbolContext = {}, ruleState = {}, nowMs = Date.now(), anchorContext = null) {
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
    const filter = evaluateTooLateShortRule({
      rule,
      symbolContext,
      btcContext: anchorContext,
      nowMs,
    });
    if (filter.decision === 'hard_block' && ruleState.status !== 'fired') {
      logPromotionDecision({
        ts: new Date(nowMs).toISOString(),
        event: 'fire_blocked',
        ticker: rule.ticker,
        ruleId: rule.id,
        reject_reason: 'too_late_short',
        reasons: filter.reasons,
        flaggedFeatures: filter.flaggedFeatures,
      });
      // stay armed; don't transition to fired
      return { state: nextState, events };
    }
    if (ruleState.status !== 'fired') {
      nextState.status = 'fired';
      nextState.firedAt = nowMs;
      nextState.retestTouched = true;
      if (filter.decision === 'soft_block') {
        nextState.tooLateSoftBlock = {
          reasons: filter.reasons,
          recordedAt: new Date(nowMs).toISOString(),
        };
        logPromotionDecision({
          ts: new Date(nowMs).toISOString(),
          event: 'fire_soft_blocked',
          ticker: rule.ticker,
          ruleId: rule.id,
          reject_reason: 'too_late_short_soft',
          reasons: filter.reasons,
        });
      }
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
    const anchorContext = context.byTicker?.[normalizeTicker('BTC/USD')] || null;
    return evaluateLoseFailRetest(rule, symbolContext, ruleState, nowMs, anchorContext);
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
  const ruleSymbols = Array.isArray(config.rules)
    ? config.rules.flatMap((rule) => [rule?.ticker, rule?.anchorTicker])
    : [];
  return Array.from(new Set(
    [...primary, ...hot, ...ruleSymbols]
      .map((entry) => normalizeTicker(entry))
      .filter(Boolean)
  ));
}

function resolveCycleIntervalMs(config = {}, mode = 'normal', overrideMs = 0) {
  const configured = overrideMs > 0
    ? overrideMs
    : (mode === 'macro_release'
      ? Number(config.macroPollIntervalMs) || DEFAULT_MACRO_POLL_INTERVAL_MS
      : Number(config.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  return Math.max(1000, configured);
}

function isRateLimitError(error) {
  const text = toText(error?.stack || error?.message || error, '').toLowerCase();
  return text.includes('429') || text.includes('too many requests');
}

function buildRateLimitBackoff(previousRateLimit = {}, baseIntervalMs = DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS, nowMs = Date.now(), error = null) {
  const previousCount = Math.max(0, toNumber(previousRateLimit?.consecutive429s, 0));
  const consecutive429s = previousCount + 1;
  const baseBackoffMs = Math.max(DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS, baseIntervalMs * 2);
  const nextBackoffMs = Math.min(
    MAX_RATE_LIMIT_BACKOFF_MS,
    baseBackoffMs * (2 ** Math.max(0, consecutive429s - 1))
  );
  return {
    consecutive429s,
    backoffUntil: new Date(nowMs + nextBackoffMs).toISOString(),
    last429At: new Date(nowMs).toISOString(),
    lastBackoffMs: nextBackoffMs,
    lastError: toText(error?.message || error, '429'),
  };
}

function clearRateLimitBackoff(previousRateLimit = {}) {
  return {
    ...previousRateLimit,
    consecutive429s: 0,
    backoffUntil: null,
    last429At: previousRateLimit?.last429At || null,
    lastBackoffMs: 0,
    lastError: null,
  };
}

function getLatestClose(bars = []) {
  const latestBar = Array.isArray(bars) && bars.length > 0 ? bars[bars.length - 1] : null;
  return pickFiniteNumber(latestBar?.close, null);
}

function getPreviousClose(bars = []) {
  const previousBar = Array.isArray(bars) && bars.length > 1 ? bars[bars.length - 2] : null;
  return pickFiniteNumber(previousBar?.close, null);
}

function isReversalAgainstPosition(position = {}, bars = []) {
  const latestClose = getLatestClose(bars);
  const previousClose = getPreviousClose(bars);
  if (!Number.isFinite(latestClose) || !Number.isFinite(previousClose)) {
    return false;
  }
  const side = toText(position?.side, '').toLowerCase();
  if (side === 'short' || Number(position?.size) < 0) {
    return latestClose > previousClose;
  }
  return latestClose < previousClose;
}

function isNearTakeProfit(position = {}, livePrice = null, takeProfitPrice = null) {
  const numericLivePrice = pickFiniteNumber(livePrice, null);
  const numericTakeProfit = pickFiniteNumber(takeProfitPrice, null);
  if (!Number.isFinite(numericLivePrice) || !Number.isFinite(numericTakeProfit) || numericTakeProfit <= 0) {
    return false;
  }
  const side = toText(position?.side, '').toLowerCase();
  if (side === 'short' || Number(position?.size) < 0) {
    return numericLivePrice <= (numericTakeProfit * 1.004);
  }
  return numericLivePrice >= (numericTakeProfit * 0.996);
}

function normalizeOpenPositionForProtection(position = {}) {
  return {
    coin: toText(position?.coin, position?.ticker ? position.ticker.split('/')[0] : ''),
    size: pickFiniteNumber(position?.size, 0),
    entryPx: pickFiniteNumber(position?.avgPrice, 0),
    side: toText(position?.side, ''),
    stopLossPrice: pickFiniteNumber(position?.stopLossPrice, null),
    takeProfitPrice: pickFiniteNumber(position?.takeProfitPrice, null),
  };
}

function decideOraclePositionManagementAction(position = {}, symbolContext = null, protection = {}, options = {}) {
  const livePrice = pickFiniteNumber(symbolContext?.market?.price, pickFiniteNumber(position?.avgPrice, null));
  const unrealizedPnl = pickFiniteNumber(position?.unrealizedPnl, 0);
  const verifiedProtection = Boolean(
    protection?.verified
    && Number.isFinite(pickFiniteNumber(protection?.activeStopPrice, null))
    && Number.isFinite(pickFiniteNumber(protection?.activeTakeProfitPrice, null))
  );
  if (!verifiedProtection) {
    return {
      action: 'close',
      reason: 'protection_fault',
      closePct: 100,
      livePrice,
      unrealizedPnl,
    };
  }
  if (unrealizedPnl > 0 && isNearTakeProfit(position, livePrice, protection.activeTakeProfitPrice)) {
    return {
      action: 'harvest',
      reason: 'near_take_profit',
      closePct: Math.max(
        1,
        Math.min(
          100,
          Number(options.harvestClosePct || DEFAULT_ORACLE_HARVEST_CLOSE_PCT) || DEFAULT_ORACLE_HARVEST_CLOSE_PCT
        )
      ),
      livePrice,
      unrealizedPnl,
    };
  }
  if (unrealizedPnl > 0 && isReversalAgainstPosition(position, symbolContext?.bars1m || [])) {
    return {
      action: 'tighten',
      reason: 'profitable_reversal_against_position',
      trailPct: pickFiniteNumber(options.trailPct, DEFAULT_ORACLE_POSITION_TRAIL_PCT) || DEFAULT_ORACLE_POSITION_TRAIL_PCT,
      livePrice,
      unrealizedPnl,
    };
  }
  return {
    action: 'hold',
    reason: 'structure_intact',
    livePrice,
    unrealizedPnl,
  };
}

async function maybeManageOracleOwnedPositions(context = null, options = {}) {
  if (options.manageOracleOwnedPositions === false) {
    return {
      reviewed: 0,
      acted: 0,
      actions: [],
      skippedReason: 'position_management_disabled',
    };
  }

  const openPositions = Array.isArray(context?.openPositions) ? context.openPositions : [];
  if (openPositions.length === 0) {
    return {
      reviewed: 0,
      acted: 0,
      actions: [],
      skippedReason: 'no_open_positions',
    };
  }

  const ownership = agentPositionAttribution.resolveAgentPositionOwnership(openPositions);
  const oraclePositions = openPositions.filter((position) => {
    const ticker = normalizeTicker(position?.ticker);
    return ticker && ownership.ownersByTicker[ticker] === 'oracle';
  });
  if (oraclePositions.length === 0) {
    return {
      reviewed: 0,
      acted: 0,
      actions: [],
      skippedReason: 'no_oracle_owned_positions',
    };
  }

  const walletAddress = hmDefiClose.resolveWalletAddress(process.env);
  let openOrders = [];
  let protectionReadError = null;
  if (walletAddress) {
    try {
      openOrders = await hyperliquidClient.getOpenOrders({
        walletAddress,
        ...(context?.requestOptions || {}),
      });
    } catch (error) {
      protectionReadError = toText(error?.message || error, 'open_orders_unavailable');
    }
  } else {
    protectionReadError = 'wallet_address_missing';
  }

  const actions = [];
  let acted = 0;
  for (const position of oraclePositions) {
    const ticker = normalizeTicker(position?.ticker);
    const asset = toText(position?.coin, ticker.split('/')[0]);
    const symbolContext = context?.byTicker?.[ticker] || null;
    const normalizedPosition = normalizeOpenPositionForProtection(position);
    const protection = protectionReadError
      ? { verified: false, activeStopPrice: null, activeTakeProfitPrice: null }
      : bracketManager.deriveExchangeProtection(normalizedPosition, openOrders);
    const decision = decideOraclePositionManagementAction(position, symbolContext, protection, options);
    const actionSummary = {
      ticker,
      owner: 'oracle',
      action: decision.action,
      reason: protectionReadError ? `protection_read_failed:${protectionReadError}` : decision.reason,
      livePrice: decision.livePrice,
      unrealizedPnl: decision.unrealizedPnl,
      protectionVerified: Boolean(protection?.verified),
      activeStopPrice: pickFiniteNumber(protection?.activeStopPrice, null),
      activeTakeProfitPrice: pickFiniteNumber(protection?.activeTakeProfitPrice, null),
      reviewedAt: new Date().toISOString(),
      status: decision.action,
      result: null,
    };

    if (protectionReadError) {
      actionSummary.action = 'hold';
      actionSummary.status = 'hold';
      actions.push(actionSummary);
      continue;
    }

    if (decision.action === 'tighten') {
      const quietResult = await runQuietly(() => hmTrailingStop.manageTrailingStop({
        asset,
        trailPct: decision.trailPct,
        dryRun: false,
      })).catch((error) => ({
        result: {
          ok: false,
          action: 'error',
          reason: toText(error?.message || error, 'tighten_failed'),
        },
        capturedStdout: [],
        capturedStderr: [],
      }));
      const tightenResult = quietResult.result || {};
      actionSummary.result = tightenResult;
      if (tightenResult.ok && tightenResult.action === 'replace_stop') {
        actionSummary.status = 'tightened';
        acted += 1;
      } else {
        actionSummary.action = 'hold';
        actionSummary.status = 'hold';
        actionSummary.reason = `tighten_not_applied:${toText(tightenResult.reason, 'no_change')}`;
      }
      actions.push(actionSummary);
      continue;
    }

    if (decision.action === 'harvest' || decision.action === 'close') {
      const quietResult = await runQuietly(() => hmDefiClose.closeHyperliquidPositions({
        asset,
        closePct: decision.closePct,
      })).catch((error) => ({
        result: {
          ok: false,
          closeAttempted: 0,
          closedCount: 0,
          reason: toText(error?.message || error, 'close_failed'),
        },
        capturedStdout: [],
        capturedStderr: [],
      }));
      const closeResult = quietResult.result || {};
      actionSummary.result = closeResult;
      if (closeResult.ok && Number(closeResult.closeAttempted || 0) > 0) {
        actionSummary.status = decision.action === 'harvest' ? 'harvested' : 'closed';
        acted += 1;
      } else {
        actionSummary.status = 'fault';
      }
      actions.push(actionSummary);
      continue;
    }

    actions.push(actionSummary);
  }

  return {
    reviewed: oraclePositions.length,
    acted,
    actions,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchWatchContext(config = {}, previousState = {}, options = {}) {
  const tickers = resolveWatchedTickers(config);
  const mode = normalizeMode(options.mode || config.mode || previousState.mode || 'normal');
  const requestOptions = {
    ...(options.clientOptions || {}),
    requestPoolTtlMs: Math.max(
      0,
      Number(options.requestPoolTtlMs || resolveCycleIntervalMs(config, mode)) || DEFAULT_POLL_INTERVAL_MS
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

  const byTicker = {};
  for (const ticker of tickers) {
    const market = marketByTicker[ticker] || null;
    const coin = toText(market?.coin, ticker.split('/')[0]);
    const previousMarket = previousState?.marketByTicker?.[ticker] || null;
    const bars1m = bars1mMap instanceof Map ? (bars1mMap.get(ticker) || []) : [];
    const bars5m = bars5mMap instanceof Map ? (bars5mMap.get(ticker) || []) : [];
    byTicker[ticker] = {
      ticker,
      coin,
      market,
      previousMarket,
      bars1m,
      bars5m,
      bar5m: getLatestBar(bars5m),
      l2Book: null,
      predictedFunding: predictedFundings?.byCoin?.[coin.toUpperCase()] || null,
      hasLivePosition: positionsByTicker.has(ticker),
    };
  }
  return {
    tickers,
    byTicker,
    openPositions,
    requestOptions,
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

function loadRulesConfig(filePath = DEFAULT_RULES_PATH, options = {}) {
  const existing = readJsonFile(filePath, null);
  const baseline = existing || defaultRulesConfig();
  const reconciled = reconcileRulesConfig(baseline, options);
  const normalized = normalizeRuleCatalog(reconciled.config, {
    ...options,
    statePath: options.statePath || DEFAULT_STATE_PATH,
  });
  if (!existing || reconciled.changed || normalized.changed) {
    writeJsonFile(filePath, normalized.config);
  }
  return normalized.config;
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
  const isDefaultRuntimePath = rulesPath === path.resolve(DEFAULT_RULES_PATH)
    && statePath === path.resolve(DEFAULT_STATE_PATH);
  const autoExecuteFrozenBySentinel = isDefaultRuntimePath
    ? (() => {
      const autoExecuteFreezeFlagPath = resolveCoordPath(
        path.join('runtime', 'oracle-watch-auto-execute-frozen.flag'),
        { forWrite: false }
      );
      try { return fs.existsSync(autoExecuteFreezeFlagPath); } catch { return false; }
    })()
    : false;
  const autoExecuteFiredSignals = options.autoExecuteFiredSignals === true
    ? true
    : (options.autoExecuteFiredSignals === false
      ? false
      : (!autoExecuteFrozenBySentinel && isDefaultRuntimePath));
  const manageOracleOwnedPositions = options.manageOracleOwnedPositions === true
    || (options.manageOracleOwnedPositions !== false && isDefaultRuntimePath);
  if (options.autoRefreshSharedShortRegime !== false && isDefaultRuntimePath) {
    try {
      await oracleWatchRegime.applySharedShortRegime({
        rulesPath,
        watchStatePath: statePath,
      });
    } catch {}
  }
  const config = loadRulesConfig(rulesPath, { statePath });
  const state = loadWatchState(statePath);
  const mode = normalizeMode(options.mode || config.mode || state.mode || 'normal');
  const nowMs = Date.now();
  const intervalMs = resolveCycleIntervalMs(config, mode, Number(options.pollMs) || 0);
  const currentRateLimit = state.rateLimit || defaultState().rateLimit;
  const backoffUntilMs = Date.parse(toText(currentRateLimit.backoffUntil, ''));
  if (Number.isFinite(backoffUntilMs) && backoffUntilMs > nowMs) {
    const snapshotMeta = resolveUsableWatchContextSnapshot(state, nowMs);
    const executionResult = autoExecuteFiredSignals
      ? await maybeAutoExecuteFiredAlerts([], { ...(state.rules || {}) }, {
        ...options,
        autoExecuteFiredSignals,
        config,
        context: null,
        previousState: state,
      })
      : {
        attempted: 0,
        succeeded: 0,
        executions: [],
      };
    if (snapshotMeta) {
      const degradedState = buildDegradedWatchState(
        state,
        nowMs,
        intervalMs,
        mode,
        currentRateLimit,
        snapshotMeta,
        executionResult
      );
      for (const execution of executionResult.executions || []) {
        if (!execution?.ruleId) continue;
        degradedState.rules = degradedState.rules || { ...(state.rules || {}) };
        degradedState.rules[execution.ruleId] = {
          ...(degradedState.rules[execution.ruleId] || {}),
          execution,
          actedOnAt: execution.attemptedAt,
          actedOnCount: Number(degradedState.rules?.[execution.ruleId]?.actedOnCount || 0) + (execution.status === 'attempted' ? 1 : 0),
          actedOnNote: execution.status,
        };
      }
      writeJsonFile(statePath, degradedState);
      return {
        ok: true,
        status: 'degraded',
        rulesPath,
        statePath,
        mode,
        executionResult,
        positionManagement: degradedState.positionManagement,
        cachedContextAgeMs: snapshotMeta.ageMs,
        tickers: Array.isArray(snapshotMeta.snapshot?.tickers) ? snapshotMeta.snapshot.tickers : resolveWatchedTickers(config),
        nextPollMs: Math.max(1000, backoffUntilMs - nowMs),
      };
    }
    const skippedState = {
      ...state,
      updatedAt: new Date(nowMs).toISOString(),
      mode,
      heartbeat: {
        ...(state.heartbeat || {}),
        lastTickAt: new Date(nowMs).toISOString(),
        intervalMs,
        stale: false,
        state: 'backoff',
        lastErrorAt: toText(currentRateLimit.last429At, new Date(nowMs).toISOString()),
        backoffUntil: new Date(backoffUntilMs).toISOString(),
      },
      counters: {
        ...(state.counters || {}),
        triggersActedOn: Number(state?.counters?.triggersActedOn || 0) + Number(executionResult.attempted || 0),
        lastCycleActedOn: Number(executionResult.attempted || 0),
      },
      rateLimit: currentRateLimit,
      rules: { ...(state.rules || {}) },
      execution: {
        attempted: Number(executionResult.attempted || 0),
        succeeded: Number(executionResult.succeeded || 0),
        executions: Array.isArray(executionResult.executions) ? executionResult.executions.slice(-12) : [],
        updatedAt: new Date(nowMs).toISOString(),
      },
      positionManagement: state.positionManagement || {
        reviewed: 0,
        acted: 0,
        actions: [],
        skippedReason: 'backoff',
        updatedAt: new Date(nowMs).toISOString(),
      },
      lastError: currentRateLimit.lastError || '429_backoff_active',
      lastFailureAt: toText(currentRateLimit.last429At, null),
    };
    for (const execution of executionResult.executions || []) {
      if (!execution?.ruleId) continue;
      skippedState.rules[execution.ruleId] = {
        ...(skippedState.rules[execution.ruleId] || {}),
        execution,
        actedOnAt: execution.attemptedAt,
        actedOnCount: Number(skippedState.rules?.[execution.ruleId]?.actedOnCount || 0) + (execution.status === 'attempted' ? 1 : 0),
        actedOnNote: execution.status,
      };
    }
    writeJsonFile(statePath, skippedState);
    return {
      ok: true,
      status: 'backoff',
      rulesPath,
      statePath,
      mode,
      executionResult,
      positionManagement: skippedState.positionManagement,
      nextPollMs: Math.max(1000, backoffUntilMs - nowMs),
      tickers: resolveWatchedTickers(config),
    };
  }
  let context = null;
  try {
    context = await fetchWatchContext(config, state, { ...options, mode });
  } catch (error) {
    const snapshotMeta = isRateLimitError(error)
      ? resolveUsableWatchContextSnapshot(state, nowMs)
      : null;
    const executionResult = isRateLimitError(error) && autoExecuteFiredSignals
      ? await maybeAutoExecuteFiredAlerts([], { ...(state.rules || {}) }, {
        ...options,
        autoExecuteFiredSignals,
        config,
        context: null,
        previousState: state,
      })
      : {
        attempted: 0,
        succeeded: 0,
        executions: [],
      };
    const rateLimit = isRateLimitError(error)
      ? buildRateLimitBackoff(currentRateLimit, intervalMs, nowMs, error)
      : clearRateLimitBackoff(currentRateLimit);
    if (snapshotMeta) {
      const degradedState = buildDegradedWatchState(
        state,
        nowMs,
        intervalMs,
        mode,
        rateLimit,
        snapshotMeta,
        executionResult
      );
      if (executionResult.attempted > 0) {
        degradedState.rules = { ...(state.rules || {}) };
        for (const execution of executionResult.executions || []) {
          if (!execution?.ruleId) continue;
          degradedState.rules[execution.ruleId] = {
            ...(degradedState.rules[execution.ruleId] || {}),
            execution,
            actedOnAt: execution.attemptedAt,
            actedOnCount: Number(degradedState.rules?.[execution.ruleId]?.actedOnCount || 0) + (execution.status === 'attempted' ? 1 : 0),
            actedOnNote: execution.status,
          };
        }
      }
      writeJsonFile(statePath, degradedState);
      return {
        ok: true,
        status: 'degraded',
        rulesPath,
        statePath,
        mode,
        error: degradedState.lastError,
        executionResult,
        positionManagement: degradedState.positionManagement,
        cachedContextAgeMs: snapshotMeta.ageMs,
        nextPollMs: Math.max(1000, Date.parse(rateLimit.backoffUntil) - nowMs),
        tickers: Array.isArray(snapshotMeta.snapshot?.tickers) ? snapshotMeta.snapshot.tickers : resolveWatchedTickers(config),
      };
    }
    const failedState = {
      ...state,
      updatedAt: new Date(nowMs).toISOString(),
      mode,
      heartbeat: {
        lastTickAt: new Date(nowMs).toISOString(),
        intervalMs,
        stale: !isRateLimitError(error),
        state: isRateLimitError(error) ? 'backoff' : 'red',
        lastErrorAt: new Date(nowMs).toISOString(),
        backoffUntil: rateLimit.backoffUntil || null,
      },
      counters: {
        ...(state.counters || {}),
        triggersActedOn: Number(state?.counters?.triggersActedOn || 0) + Number(executionResult.attempted || 0),
        lastCycleActedOn: Number(executionResult.attempted || 0),
      },
      rateLimit,
      rules: executionResult.attempted > 0
        ? { ...(state.rules || {}) }
        : (state.rules || {}),
      execution: {
        attempted: Number(executionResult.attempted || 0),
        succeeded: Number(executionResult.succeeded || 0),
        executions: Array.isArray(executionResult.executions) ? executionResult.executions.slice(-12) : [],
        updatedAt: new Date(nowMs).toISOString(),
      },
      positionManagement: state.positionManagement || {
        reviewed: 0,
        acted: 0,
        actions: [],
        skippedReason: 'cycle_failed',
        updatedAt: new Date(nowMs).toISOString(),
      },
      lastError: String(error?.stack || error?.message || error || 'unknown_watch_cycle_error'),
      lastFailureAt: new Date(nowMs).toISOString(),
    };
    if (executionResult.attempted > 0) {
      failedState.rules = { ...(state.rules || {}) };
      for (const execution of executionResult.executions || []) {
        if (!execution?.ruleId) continue;
        failedState.rules[execution.ruleId] = {
          ...(failedState.rules[execution.ruleId] || {}),
          execution,
          actedOnAt: execution.attemptedAt,
          actedOnCount: Number(failedState.rules?.[execution.ruleId]?.actedOnCount || 0) + (execution.status === 'attempted' ? 1 : 0),
          actedOnNote: execution.status,
        };
      }
    }
    writeJsonFile(statePath, failedState);
    return {
      ok: !isRateLimitError(error),
      status: isRateLimitError(error) ? 'backoff' : 'failed',
      error: failedState.lastError,
      rulesPath,
      statePath,
      mode,
      executionResult,
      positionManagement: failedState.positionManagement,
      nextPollMs: isRateLimitError(error)
        ? Math.max(1000, Date.parse(rateLimit.backoffUntil) - nowMs)
        : intervalMs,
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
  const l2BookCache = new Map();
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
    let payload = symbolContext
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
      if (eventType === 'fired') {
        const priorVetoSuppression = shouldSuppressAfterPriorVeto(rule, previousRuleState, nowMs, options);
        if (priorVetoSuppression.suppress) {
          nextRuleState.execution = {
            ...(previousRuleState.execution || {}),
            status: 'suppressed_prior_veto',
            attemptedAt: new Date(nowMs).toISOString(),
            triggerFingerprint: priorVetoSuppression.triggerFingerprint,
            previousStatus: priorVetoSuppression.previousStatus,
            error: priorVetoSuppression.reason,
          };
          nextRuleState.actedOnAt = nextRuleState.execution.attemptedAt;
          nextRuleState.actedOnNote = 'suppressed_prior_veto';
          continue;
        }
      }
      const ticker = normalizeTicker(rule.ticker);
      if (!l2BookCache.has(ticker)) {
        try {
          l2BookCache.set(ticker, await hyperliquidClient.getL2Book({
            ...(context.requestOptions || {}),
            ticker,
          }));
        } catch {
          l2BookCache.set(ticker, null);
        }
      }
      if (symbolContext) {
        payload = buildAlertPayload(
          rule,
          {
            ...symbolContext,
            l2Book: l2BookCache.get(ticker),
          },
          state.marketByTicker?.[ticker] || {}
        );
      }
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
  const conflictResolution = reconcileDirectionalConflicts(config, nextRulesState, nowMs);
  cycleCounters.triggersInvalidated += Number(conflictResolution.invalidatedCount || 0);
  const suppressedRuleIds = new Set(
    Object.entries(conflictResolution.nextRulesState || {})
      .filter(([, ruleState]) => ruleState?.conflictResolution?.status === 'superseded')
      .map(([ruleId]) => ruleId)
  );
  const filteredAlerts = suppressedRuleIds.size > 0
    ? alerts.filter((entry) => !suppressedRuleIds.has(entry.ruleId))
    : alerts;

  let alertResult = null;
  let telegramAlertResult = null;
  let executionResult = {
    attempted: 0,
    succeeded: 0,
    executions: [],
  };
  let positionManagementResult = {
    reviewed: 0,
    acted: 0,
    actions: [],
    skippedReason: 'position_management_disabled',
  };
  if (filteredAlerts.length > 0 && autoExecuteFiredSignals) {
    executionResult = await maybeAutoExecuteFiredAlerts(filteredAlerts, nextRulesState, {
      ...options,
      autoExecuteFiredSignals,
      config,
      context,
      previousState: state,
    });
  } else if (autoExecuteFiredSignals) {
    executionResult = await maybeAutoExecuteFiredAlerts([], nextRulesState, {
      ...options,
      autoExecuteFiredSignals,
      config,
      context,
      previousState: state,
    });
  }
  if (manageOracleOwnedPositions) {
    positionManagementResult = await maybeManageOracleOwnedPositions(context, {
      ...options,
      config,
    });
  }
  if (filteredAlerts.length > 0 && options.sendAlerts !== false) {
    alertResult = sendAgentAlert(
      filteredAlerts.map((entry) => entry.message).join('\n'),
      {
        targets: normalizeTargets(options.targets || config.targets || DEFAULT_TARGETS),
        env: process.env,
        cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
        hmSendScriptPath: options.hmSendScriptPath,
        role: 'oracle-watch',
      }
    );
    telegramAlertResult = sendTelegramTradeAlerts(filteredAlerts, {
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
      intervalMs,
      stale: false,
      state: 'green',
    },
    counters: {
      triggersSeen: Number(counters.triggersSeen || 0) + cycleCounters.triggersSeen,
      triggersArmed: Number(counters.triggersArmed || 0) + cycleCounters.triggersArmed,
      triggersFired: Number(counters.triggersFired || 0) + cycleCounters.triggersFired,
      triggersInvalidated: Number(counters.triggersInvalidated || 0) + cycleCounters.triggersInvalidated,
      triggersActedOn: Number(counters.triggersActedOn || 0) + Number(executionResult.attempted || 0),
      alertsSent: Number(counters.alertsSent || 0) + filteredAlerts.length,
      staleRulesDetected: Number(counters.staleRulesDetected || 0) + cycleCounters.staleRulesDetected,
      lastCycleSeen: cycleCounters.triggersSeen,
      lastCycleFired: cycleCounters.triggersFired,
      lastCycleAlertCount: filteredAlerts.length,
      lastCycleStaleCount: staleRules.length,
      lastCycleActedOn: Number(executionResult.attempted || 0),
    },
    rateLimit: clearRateLimitBackoff(currentRateLimit),
    marketByTicker: context.marketByTicker,
    watchContextSnapshot: buildWatchContextSnapshot(context, nowMs),
    rules: nextRulesState,
    staleRules,
    execution: {
      attempted: Number(executionResult.attempted || 0),
      succeeded: Number(executionResult.succeeded || 0),
      executions: Array.isArray(executionResult.executions) ? executionResult.executions.slice(-12) : [],
      updatedAt: new Date(nowMs).toISOString(),
    },
    positionManagement: {
      reviewed: Number(positionManagementResult.reviewed || 0),
      acted: Number(positionManagementResult.acted || 0),
      actions: Array.isArray(positionManagementResult.actions) ? positionManagementResult.actions.slice(-12) : [],
      skippedReason: toText(positionManagementResult.skippedReason, null),
      updatedAt: toText(positionManagementResult.updatedAt, new Date(nowMs).toISOString()),
    },
    lastError: null,
    lastFailureAt: null,
  };
  writeJsonFile(statePath, nextState);

  return {
    ok: true,
    mode,
    rulesPath,
    statePath,
    alertCount: filteredAlerts.length,
    alerts: filteredAlerts,
    alertResult,
    telegramAlertResult,
    executionResult,
    positionManagement: nextState.positionManagement,
    tickers: context.tickers,
    nextPollMs: intervalMs,
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
      const intervalMs = Math.max(
        1000,
        Number(result?.nextPollMs)
        || pollIntervalMs
        || resolveCycleIntervalMs(config, mode)
      );
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
  buildSuggestedCommand,
  resolveWatchExecutionStopLoss,
  decideOraclePositionManagementAction,
  maybeManageOracleOwnedPositions,
  resolveWatchedTickers,
  shouldSendTelegramTradeAlert,
  sendTelegramTradeAlerts,
  fetchWatchContext,
  runWatchCycle,
  runCli,
};
