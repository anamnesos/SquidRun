#!/usr/bin/env node
'use strict';

installProcessDiagnostics();

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const agentPositionAttribution = require('../modules/trading/agent-position-attribution');
const bracketManager = require('../modules/trading/bracket-manager');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const hardRiskGuard = require('../modules/trading/hard-risk-guard');
const macroRiskGate = require('../modules/trading/macro-risk-gate');
const suggestionTracker = require('../modules/trading/setup-suggestion-tracker');
const hmDefiExecute = require('./hm-defi-execute');
const { sendAgentAlert } = require('./hm-agent-alert');

const DEFAULT_CONFIG_PATH = resolveCoordPath(path.join('runtime', 'architect-quiet-watch.json'), { forWrite: true });
const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'architect-quiet-watch-state.json'), { forWrite: true });
const DEFAULT_CANDIDATE_BOARD_PATH = resolveCoordPath(path.join('runtime', 'candidate-board.json'), { forWrite: true });
const DEFAULT_POWWOW_REQUESTS_DIR = resolveCoordPath(path.join('runtime', 'powwow-requests'), { forWrite: true });
const DEFAULT_POWWOW_RESULTS_PATH = resolveCoordPath(path.join('runtime', 'powwow-results.jsonl'), { forWrite: true });
const DEFAULT_LOOP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_POSITION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const ACTIVE_POSITION_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCALP_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SETUP_SCAN_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_PACE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_MACRO_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const HEARTBEAT_STALE_AFTER_MS = 12 * 60 * 1000;
const POSITION_MOVE_ALERT_PCT = 0.003;
const NEAR_LEVEL_PCT = 0.01;
const PEAK_GIVEBACK_PCT = 0.30;
const PEAK_GIVEBACK_NEAR_TP_PCT = 0.015;
const PEAK_GIVEBACK_MIN_ENTRY_AGE_MS = 10 * 60 * 1000;
const POSITION_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const SCALP_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const SETUP_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const PACE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_POWWOW_ACTIVE_WINDOW_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POWWOW_QUIET_WINDOW_INTERVAL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_POWWOW_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POWWOW_RECURRING_THRESHOLD = 3;
const DEFAULT_POWWOW_PACE_DELTA_THRESHOLD_USD = 50;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function pctDistance(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) return null;
  return Math.abs((left - right) / right);
}

function normalizeTicker(value) {
  const raw = toText(value).toUpperCase().replace('-', '/');
  if (!raw) return '';
  return raw.endsWith('/USD') ? raw : `${raw}/USD`;
}

function normalizeTargets(value = ['architect']) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return Array.from(new Set(
    raw
      .map((entry) => toText(entry).toLowerCase())
      .filter((entry) => ['architect', 'builder', 'oracle'].includes(entry))
  ));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function appendJsonLine(filePath, payload) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
  return filePath;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(baseValue, overrideValue) {
  if (Array.isArray(baseValue)) {
    return Array.isArray(overrideValue) ? overrideValue.slice() : baseValue.slice();
  }
  if (isPlainObject(baseValue)) {
    const merged = { ...baseValue };
    const overrideObject = isPlainObject(overrideValue) ? overrideValue : {};
    for (const [key, value] of Object.entries(overrideObject)) {
      merged[key] = key in baseValue
        ? mergeDeep(baseValue[key], value)
        : value;
    }
    return merged;
  }
  return overrideValue === undefined ? baseValue : overrideValue;
}

function formatErrorForLog(error) {
  if (error && typeof error === 'object') {
    return error.stack || error.message || JSON.stringify(error);
  }
  return String(error);
}

function installProcessDiagnostics(prefix = 'ARCH WATCH') {
  if (global.__ARCHITECT_WATCH_PROCESS_DIAGNOSTICS_INSTALLED__) return;
  global.__ARCHITECT_WATCH_PROCESS_DIAGNOSTICS_INSTALLED__ = true;

  process.on('unhandledRejection', (reason) => {
    console.error(`[${prefix}] unhandledRejection: ${formatErrorForLog(reason)}`);
  });

  process.on('uncaughtException', (error) => {
    console.error(`[${prefix}] uncaughtException: ${formatErrorForLog(error)}`);
    process.exit(1);
  });

  process.on('beforeExit', (code) => {
    console.error(`[${prefix}] beforeExit code=${code}`);
  });

  process.on('exit', (code) => {
    console.error(`[${prefix}] exit code=${code}`);
  });

  ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach((signalName) => {
    process.on(signalName, () => {
      console.error(`[${prefix}] signal=${signalName}`);
    });
  });
}

function computeHeartbeatStale(lastTickAt = null, nowMs = Date.now(), staleAfterMs = HEARTBEAT_STALE_AFTER_MS) {
  const tickMs = new Date(toText(lastTickAt, '')).getTime();
  if (!Number.isFinite(tickMs) || tickMs <= 0) return true;
  return (nowMs - tickMs) > Math.max(1, toNumber(staleAfterMs, HEARTBEAT_STALE_AFTER_MS));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    targets: ['architect'],
    loopIntervalMs: DEFAULT_LOOP_INTERVAL_MS,
    cadences: {
      positionCheckMs: DEFAULT_POSITION_CHECK_INTERVAL_MS,
      macroCheckMs: DEFAULT_MACRO_CHECK_INTERVAL_MS,
      scalpScanMs: DEFAULT_SCALP_SCAN_INTERVAL_MS,
      setupScanMs: DEFAULT_SETUP_SCAN_INTERVAL_MS,
      paceCheckMs: DEFAULT_PACE_CHECK_INTERVAL_MS,
    },
    sessionStartAt: new Date().toISOString(),
    paceWindow: 'day',
    quotaPerHourUsd: 8.33,
    trackedPnlAssets: [],
    realizedPnlAdjustmentsUsd: 0,
    positions: [],
    userPositionLevels: [],
    macroWatch: {
      enabled: true,
      oil: {
        enabled: true,
        symbol: 'CL=F',
        dumpWindowMinutes: 15,
        dumpThresholdPct: -0.01,
        breakBelowLevels: [81],
        action: 'oil macro breaking down; if BTC is bidding, re-check the high-conviction BTC long immediately',
      },
    },
    scalpDiscovery: {
      enabled: true,
      symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      aTierScoreThreshold: 70,
      scoreThreshold: 65,
      bTierScoreThreshold: 58,
      minNetMovePct: 0.002,
      minEfficiency: 0.58,
      resistanceBufferPct: 0.0015,
      supportBufferPct: 0.0015,
      leverage: 10,
      minProjectedGrossUsd: 15,
      marginUsd: {
        min: 100,
        max: 200,
        default: 125,
      },
      macroRegime: 'neutral',
      macroBias: 'risk_on',
    },
    setupDiscovery: {
      minVolumeUsd24h: 0,
      scoreThreshold: 58,
      aTierScoreThreshold: 70,
      bTierScoreThreshold: 58,
      maxSpreadBps: 8,
      minTop5DepthPerSideUsd: 5000,
      minTop10CombinedDepthUsd: 30000,
      aTierMarginUsd: {
        min: 300,
        max: 450,
        default: 350,
      },
      bTierMarginUsd: {
        min: 125,
        max: 225,
        default: 175,
      },
      leverage: 10,
      minProjectedGrossUsd: 20,
      candidateBoardPath: DEFAULT_CANDIDATE_BOARD_PATH,
      maxPerTier: 8,
      excludeTickers: ['ORDI/USD'],
    },
    suggestionTracking: {
      enabled: true,
      logPath: suggestionTracker.DEFAULT_SUGGESTION_LOG_PATH,
      horizonsMinutes: suggestionTracker.DEFAULT_HORIZONS_MINUTES,
      settlementIntervalMs: 5 * 60 * 1000,
    },
    autonomousHandoff: {
      enabled: true,
      watchTicker: 'ORDI/USD',
      eventTargets: ['builder', 'oracle'],
      maxEventAgeMinutes: 15,
      minOracleScore: 50,
    },
    powwow: {
      enabled: true,
      targets: ['architect', 'builder', 'oracle'],
      activeWindowIntervalMs: DEFAULT_POWWOW_ACTIVE_WINDOW_INTERVAL_MS,
      quietWindowIntervalMs: DEFAULT_POWWOW_QUIET_WINDOW_INTERVAL_MS,
      responseTimeoutMs: DEFAULT_POWWOW_RESPONSE_TIMEOUT_MS,
      paceDeltaThresholdUsd: DEFAULT_POWWOW_PACE_DELTA_THRESHOLD_USD,
      recurringProposalThreshold: DEFAULT_POWWOW_RECURRING_THRESHOLD,
      requestsDir: DEFAULT_POWWOW_REQUESTS_DIR,
      resultsPath: DEFAULT_POWWOW_RESULTS_PATH,
    },
  };
}

function getAgentPositions(config = {}) {
  return Array.isArray(config.positions) ? config.positions : [];
}

function getUserPositionLevels(config = {}) {
  return Array.isArray(config.userPositionLevels) ? config.userPositionLevels : [];
}

function getWatchedPositions(config = {}) {
  return [
    ...getAgentPositions(config).map((position) => ({ ...position, watcherScope: 'agent' })),
    ...getUserPositionLevels(config).map((position) => ({ ...position, watcherScope: 'user' })),
  ];
}

function defaultState() {
  return {
    version: 1,
    updatedAt: null,
    heartbeat: {
      lastTickAt: null,
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
      state: 'idle',
      stale: false,
    },
    cadence: {
      lastPositionCheckAt: null,
      lastMacroCheckAt: null,
      lastScalpScanAt: null,
      lastSetupScanAt: null,
      lastPaceCheckAt: null,
    },
    positions: {},
    scalp: {
      lastScanAt: null,
      lastAlertHashesByTicker: {},
      lastCandidates: [],
      lastSummary: null,
    },
    setup: {
      lastScanAt: null,
      lastAlertHash: null,
      lastCandidates: [],
      lastSummary: null,
      universeScanned: 0,
    },
    candidateBoard: {
      lastBuiltAt: null,
      path: DEFAULT_CANDIDATE_BOARD_PATH,
      universeScanned: 0,
      tiers: {
        aTier: [],
        bTier: [],
        scalp: [],
      },
    },
    pace: {
      lastAlertAt: null,
      lastRealizedPnlUsd: 0,
      lastQuotaUsd: 0,
    },
    macro: {
      oil: {
        lastCheckedAt: null,
        lastObservedAt: null,
        lastFetchedAt: null,
        lastPrice: null,
        lastSource: null,
        stale: false,
        staleReason: null,
        observationAgeMs: null,
        samples: [],
        levelStates: {},
        lastAlertAtByKey: {},
      },
    },
    autonomy: {
      tracked: {},
      lastFreedMarginEventAt: null,
      lastFreedMarginEvent: null,
    },
    suggestionTracking: {
      lastSettlementAt: null,
      lastSettlementCount: 0,
      lastSettlementPath: null,
    },
    risk: hardRiskGuard.defaultRiskState(),
    powwow: {
      lastTriggeredAt: null,
      lastTimedPowwowAt: null,
      lastFireAt: null,
      lastValidSetupAt: null,
      lastPaceDeltaUsd: 0,
      lastOpenAgentPositionKeys: [],
      recurringProposalCountsByTicker: {},
      openRequest: null,
      lastCompletedAt: null,
      lastSynthesis: null,
    },
  };
}

function loadConfig(filePath = DEFAULT_CONFIG_PATH) {
  const defaults = defaultConfig();
  const config = readJson(filePath, null);
  if (config) return mergeDeep(defaults, config);
  writeJson(filePath, defaults);
  return defaults;
}

function loadState(filePath = DEFAULT_STATE_PATH) {
  return mergeDeep(defaultState(), readJson(filePath, defaultState()) || {});
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[index + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) index += 1;
    options.set(key, value);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

function formatUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  return `$${numeric.toFixed(2)}`;
}

function formatPct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  return `${(numeric * 100).toFixed(2)}%`;
}

function formatProjectionUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  return `$${numeric.toFixed(2)}`;
}

function getPacificHour(nowMs = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    hour12: false,
  });
  return Number(formatter.format(new Date(nowMs)));
}

function isActiveWindow(nowMs = Date.now()) {
  const hour = getPacificHour(nowMs);
  return (hour >= 0 && hour < 3)
    || (hour >= 5 && hour < 9)
    || (hour >= 16 && hour < 20);
}

function extractJsonObjectFromText(raw = '') {
  const text = String(raw || '').trim();
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

function deriveRiskUsd(configPosition = {}, livePosition = {}) {
  const explicit = Number(configPosition.riskUsd);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const entryPrice = toNumber(configPosition.entryPrice, toNumber(livePosition.entryPx, 0));
  const stopPrice = toNumber(configPosition.stopPrice, 0);
  const size = Math.abs(toNumber(livePosition.size, toNumber(configPosition.size, 0)));
  if (!(entryPrice > 0 && stopPrice > 0 && size > 0)) return 0;
  return Math.abs(entryPrice - stopPrice) * size;
}

function deriveMarginUsd(configPosition = {}) {
  const explicit = Number(configPosition.marginUsd);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : 0;
}

function bucketizeRiskMultiple(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'flat';
  if (numeric <= -1) return 'loss_gt_1r';
  if (numeric <= -0.5) return 'loss_half_r';
  if (numeric >= 1) return 'gain_gt_1r';
  if (numeric >= 0.5) return 'gain_half_r';
  return 'inside';
}

function pickActionForGainTrigger(triggerId, configPosition = {}) {
  const entryPrice = Number(configPosition.entryPrice);
  if (triggerId === 'gain_30_margin') {
    return `scale out 25%, lock cushion${Number.isFinite(entryPrice) ? `, keep stop under ${entryPrice}` : ''}`;
  }
  if (triggerId === 'gain_60_margin') {
    return `scale out 50%, move stop to breakeven${Number.isFinite(entryPrice) ? ` @ ${entryPrice}` : ''}`;
  }
  if (triggerId === 'gain_100_margin') {
    return 'scale out 75%, leave runner only, trail stop';
  }
  return 'review and manage actively';
}

function getAlertProfile(configPosition = {}) {
  return toText(configPosition.alertProfile, 'full').toLowerCase();
}

function shouldSuppressAlert(positionState = {}, key, nowMs, cooldownMs = POSITION_ALERT_COOLDOWN_MS) {
  const last = Number(positionState?.lastAlertAtByKey?.[key] || 0);
  if (!(last > 0)) return false;
  return Number.isFinite(last) && (nowMs - last) < cooldownMs;
}

function markAlert(positionState = {}, key, nowMs) {
  return {
    ...positionState,
    lastAlertAtByKey: {
      ...(positionState.lastAlertAtByKey || {}),
      [key]: nowMs,
    },
  };
}

function normalizeOrderPrice(order = {}) {
  return toNumber(order?.limitPx ?? order?.triggerPx ?? order?.px, 0);
}

function isLongPosition(configPosition = {}, livePosition = {}) {
  if (toText(livePosition?.side).toLowerCase() === 'long') return true;
  if (toText(livePosition?.side).toLowerCase() === 'short') return false;
  const size = toNumber(livePosition?.size, 0);
  if (size > 0) return true;
  if (size < 0) return false;
  return toText(configPosition?.side, 'LONG').toUpperCase() !== 'SHORT';
}

function findNearestUnfilledTakeProfitPct(input = {}) {
  const configPosition = input.configPosition || {};
  const livePosition = input.livePosition || {};
  const currentPrice = toNumber(input.currentPrice, 0);
  const entryPrice = toNumber(configPosition.entryPrice, toNumber(livePosition.entryPx, 0));
  if (!(currentPrice > 0 && entryPrice > 0)) {
    return null;
  }

  const isLong = isLongPosition(configPosition, livePosition);
  const tickerCoin = toText(configPosition.ticker || livePosition.ticker).split('/')[0].toUpperCase();
  const orderCandidates = (Array.isArray(input.openOrders) ? input.openOrders : [])
    .filter((order) => {
      const orderCoin = toText(order?.coin || '').toUpperCase();
      return !tickerCoin || !orderCoin || orderCoin === tickerCoin;
    })
    .filter((order) => order?.reduceOnly === true)
    .map((order) => normalizeOrderPrice(order))
    .filter((price) => price > 0)
    .filter((price) => (isLong ? price > entryPrice : price < entryPrice));

  const fallbackCandidates = [
    toNumber(configPosition.takeProfit1Price, 0),
    toNumber(configPosition.takeProfit2Price, 0),
  ].filter((price) => price > 0 && (isLong ? price > entryPrice : price < entryPrice));

  const candidates = orderCandidates.length > 0 ? orderCandidates : fallbackCandidates;
  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((best, price) => {
    const distance = pctDistance(currentPrice, price);
    if (distance == null) return best;
    if (best == null || distance < best) return distance;
    return best;
  }, null);
}

function resolveEntryDetectedAtMs(configPosition = {}, previousState = {}, livePosition = null, nowMs = Date.now()) {
  if (!livePosition) return null;
  const configured = new Date(toText(configPosition.entryAt, '')).getTime();
  if (Number.isFinite(configured) && configured > 0) return configured;
  const previous = new Date(toText(previousState.entryDetectedAt, '')).getTime();
  if (Number.isFinite(previous) && previous > 0) return previous;
  return nowMs;
}

function evaluatePositionTriggers(input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const configPosition = input.configPosition || {};
  const livePosition = input.livePosition || null;
  const previousState = input.previousState || {};
  const openOrders = Array.isArray(input.openOrders) ? input.openOrders : [];
  const currentPrice = toNumber(input.currentPrice, 0);
  const previousPrice = toNumber(previousState.lastPrice, 0);
  const stopPrice = toNumber(configPosition.stopPrice, 0);
  const tp1Price = toNumber(configPosition.takeProfit1Price, 0);
  const tp2Price = toNumber(configPosition.takeProfit2Price, 0);
  const marginUsd = deriveMarginUsd(configPosition);
  const riskUsd = deriveRiskUsd(configPosition, livePosition || {});
  const currentPnlUsd = Number.isFinite(Number(livePosition?.unrealizedPnl))
    ? Number(livePosition.unrealizedPnl)
    : toNumber(previousState.currentPnlUsd, 0);
  const previousPeak = toNumber(previousState.peakUnrealizedPnlUsd, 0);
  const peakUnrealizedPnlUsd = Math.max(previousPeak, currentPnlUsd);
  const gainMarginPct = marginUsd > 0 ? (currentPnlUsd / marginUsd) : 0;
  const riskMultiple = riskUsd > 0 ? (currentPnlUsd / riskUsd) : 0;
  const peakGivebackPct = peakUnrealizedPnlUsd > 0
    ? ((peakUnrealizedPnlUsd - currentPnlUsd) / peakUnrealizedPnlUsd)
    : 0;
  const entryDetectedAtMs = resolveEntryDetectedAtMs(configPosition, previousState, livePosition, nowMs);
  const entryAgeMs = entryDetectedAtMs ? Math.max(0, nowMs - entryDetectedAtMs) : Number.MAX_SAFE_INTEGER;
  const nearestUnfilledTpPct = findNearestUnfilledTakeProfitPct({
    configPosition,
    livePosition,
    currentPrice,
    openOrders,
  });
  const nextState = {
    ...previousState,
    lastPrice: currentPrice || previousPrice || null,
    currentPnlUsd,
    peakUnrealizedPnlUsd,
    riskMultipleBucket: bucketizeRiskMultiple(riskMultiple),
    entryDetectedAt: entryDetectedAtMs ? new Date(entryDetectedAtMs).toISOString() : null,
  };

  const triggers = [];
  const alertProfile = getAlertProfile(configPosition);
  const isStreamlinedUser = alertProfile === 'streamlined_user';
  const isFlatWatchOnly = !livePosition && configPosition.watchWhenFlat === true;
  const queueTrigger = (trigger) => {
    if (!trigger || !trigger.id) return;
    if (shouldSuppressAlert(nextState, trigger.id, nowMs, trigger.cooldownMs || POSITION_ALERT_COOLDOWN_MS)) {
      return;
    }
    triggers.push(trigger);
  };

  if (!isStreamlinedUser && !isFlatWatchOnly && previousPrice > 0 && currentPrice > 0) {
    const movePct = Math.abs((currentPrice - previousPrice) / previousPrice);
    if (movePct >= POSITION_MOVE_ALERT_PCT) {
      queueTrigger({
        id: 'material_move',
        label: 'material_move',
        action: 're-check stop/TP placement and decide whether to reduce or hold',
        detail: `price moved ${formatPct(movePct)} since last 5m check`,
      });
    }
  }

  const nearStopPct = pctDistance(currentPrice, stopPrice);
  if (!isStreamlinedUser && !isFlatWatchOnly && currentPrice > 0 && stopPrice > 0 && nearStopPct != null && nearStopPct <= NEAR_LEVEL_PCT) {
    queueTrigger({
      id: 'near_stop',
      label: 'near_stop',
      action: 'danger: review stop immediately and decide reduce/close',
      detail: `stop ${stopPrice} is ${formatPct(nearStopPct)} away`,
    });
  }

  const nearTp1Pct = pctDistance(currentPrice, tp1Price);
  if (!isStreamlinedUser && !isFlatWatchOnly && currentPrice > 0 && tp1Price > 0 && nearTp1Pct != null && nearTp1Pct <= NEAR_LEVEL_PCT) {
    queueTrigger({
      id: 'near_tp1',
      label: 'near_tp1',
      action: 'prepare TP1/partial scale-out',
      detail: `TP1 ${tp1Price} is ${formatPct(nearTp1Pct)} away`,
    });
  }

  const nearTp2Pct = pctDistance(currentPrice, tp2Price);
  if (!isStreamlinedUser && !isFlatWatchOnly && currentPrice > 0 && tp2Price > 0 && nearTp2Pct != null && nearTp2Pct <= NEAR_LEVEL_PCT) {
    queueTrigger({
      id: 'near_tp2',
      label: 'near_tp2',
      action: 'runner near TP2 zone, decide whether to trail or flatten',
      detail: `TP2 ${tp2Price} is ${formatPct(nearTp2Pct)} away`,
    });
  }

  const gainThresholds = [
    { id: 'gain_30_margin', threshold: 0.30 },
    { id: 'gain_60_margin', threshold: 0.60 },
    { id: 'gain_100_margin', threshold: 1.00 },
  ];
  nextState.firedGainThresholds = { ...(previousState.firedGainThresholds || {}) };
  if (!isStreamlinedUser && !isFlatWatchOnly) {
    for (const threshold of gainThresholds) {
      if (gainMarginPct >= threshold.threshold && nextState.firedGainThresholds[threshold.id] !== true) {
        queueTrigger({
          id: threshold.id,
          label: threshold.id,
          action: pickActionForGainTrigger(threshold.id, configPosition),
          detail: `unrealized ${formatUsd(currentPnlUsd)} = ${formatPct(gainMarginPct)} of margin`,
          cooldownMs: Number.MAX_SAFE_INTEGER,
        });
        nextState.firedGainThresholds[threshold.id] = true;
      }
    }
  }

  const givebackAllowed = entryAgeMs >= PEAK_GIVEBACK_MIN_ENTRY_AGE_MS
    && !(nearestUnfilledTpPct != null && nearestUnfilledTpPct <= PEAK_GIVEBACK_NEAR_TP_PCT);
  if (!isStreamlinedUser && !isFlatWatchOnly && peakUnrealizedPnlUsd > 0 && peakGivebackPct >= PEAK_GIVEBACK_PCT && givebackAllowed) {
    const priorPeakAlert = toNumber(previousState.lastPeakGivebackAlertPeakUsd, 0);
    if (peakUnrealizedPnlUsd > priorPeakAlert * 1.1 || priorPeakAlert === 0) {
      queueTrigger({
        id: 'peak_giveback',
        label: 'peak_giveback',
        action: 'winner giving back, scale or close instead of hold-and-hope',
        detail: `peak ${formatUsd(peakUnrealizedPnlUsd)} to ${formatUsd(currentPnlUsd)} = ${formatPct(peakGivebackPct)} giveback`,
      });
      nextState.lastPeakGivebackAlertPeakUsd = peakUnrealizedPnlUsd;
    }
  }

  const priorRiskBucket = toText(previousState.riskMultipleBucket, 'flat');
  const currentRiskBucket = toText(nextState.riskMultipleBucket, 'flat');
  if (!isStreamlinedUser && !isFlatWatchOnly && currentRiskBucket !== priorRiskBucket && (currentRiskBucket === 'loss_half_r' || currentRiskBucket === 'gain_half_r')) {
    queueTrigger({
      id: `risk_bucket_${currentRiskBucket}`,
      label: `risk_bucket_${currentRiskBucket}`,
      action: currentRiskBucket === 'loss_half_r'
        ? 'loss reached 0.5R, decide whether thesis still holds'
        : 'gain reached 0.5R, decide whether to pay yourself',
      detail: `PnL ${formatUsd(currentPnlUsd)} = ${riskMultiple.toFixed(2)}R`,
    });
  }

  const watchLevels = Array.isArray(configPosition.watchLevels) ? configPosition.watchLevels : [];
  nextState.levelStates = { ...(previousState.levelStates || {}) };
  for (const level of watchLevels) {
    const levelId = toText(level.id);
    if (toText(previousState.levelStates?.[levelId], '') === 'invalidated') {
      nextState.levelStates[levelId] = 'invalidated';
      continue;
    }
    if (toText(nextState.levelStates?.[levelId], '') === 'invalidated') {
      continue;
    }
    const levelPrice = toNumber(level.price, 0);
    const direction = toText(level.direction, '').toLowerCase();
    const bandMin = toNumber(level.bandMin, 0);
    const bandMax = toNumber(level.bandMax, 0);
    const expiresAtMs = new Date(toText(level.expiresAt, '')).getTime();
    if (Number.isFinite(expiresAtMs) && nowMs > expiresAtMs) {
      continue;
    }
    if (!levelId || !(previousPrice > 0 && currentPrice > 0)) {
      continue;
    }
    if (direction === 'inside') {
      if (!(bandMin > 0 && bandMax > bandMin)) {
        continue;
      }
      const priorInside = previousPrice >= bandMin && previousPrice <= bandMax;
      const currentInside = currentPrice >= bandMin && currentPrice <= bandMax;
      nextState.levelStates[levelId] = currentInside ? 'inside' : (currentPrice < bandMin ? 'below' : 'above');
      if (!priorInside && currentInside) {
        queueTrigger({
          id: `level_${levelId}`,
          label: levelId,
          action: toText(level.action, 'review immediately'),
          detail: `${toText(level.label, levelId)} entered ${round(bandMin, 6)}-${round(bandMax, 6)}`,
          cooldownMs: Number.MAX_SAFE_INTEGER,
          exactMessage: toText(level.exactMessage, ''),
        });
      }
      continue;
    }
    if (!(levelPrice > 0)) {
      continue;
    }
    const priorSide = toText(previousState.levelStates?.[levelId], previousPrice >= levelPrice ? 'above' : 'below');
    const currentSide = currentPrice >= levelPrice ? 'above' : 'below';
    nextState.levelStates[levelId] = currentSide;
    const crossedAbove = priorSide === 'below' && currentSide === 'above';
    const crossedBelow = priorSide === 'above' && currentSide === 'below';
    const crossed = direction === 'above' ? crossedAbove : direction === 'below' ? crossedBelow : (crossedAbove || crossedBelow);
    if (crossed) {
      const invalidates = Array.isArray(level.invalidates) ? level.invalidates.map((entry) => toText(entry)).filter(Boolean) : [];
      for (const invalidatedId of invalidates) {
        nextState.levelStates[invalidatedId] = 'invalidated';
      }
      if (level.silent !== true) {
        queueTrigger({
          id: `level_${levelId}`,
          label: levelId,
          action: toText(level.action, 'review immediately'),
          detail: `${toText(level.label, levelId)} crossed ${levelPrice}`,
          cooldownMs: Number.MAX_SAFE_INTEGER,
          exactMessage: toText(level.exactMessage, ''),
          routeTargets: normalizeTargets(level.routeTargets || []),
          routeMessage: toText(level.routeMessage, ''),
        });
      }
    }
  }

  for (const trigger of triggers) {
    Object.assign(nextState, markAlert(nextState, trigger.id, nowMs));
  }

  return {
    nextState,
    triggers,
    metrics: {
      currentPrice,
      currentPnlUsd,
      peakUnrealizedPnlUsd,
      gainMarginPct,
      riskMultiple,
      nearStopPct,
      nearTp1Pct,
      nearTp2Pct,
      peakGivebackPct,
      nearestUnfilledTpPct,
      entryAgeMs,
    },
  };
}

function buildPositionAlert(position = {}, livePosition = {}, evaluation = {}) {
  const exactMessage = (evaluation.triggers || []).find((trigger) => toText(trigger.exactMessage, ''))?.exactMessage;
  if (exactMessage) {
    return exactMessage;
  }
  const normalizedPosition = position || {};
  const normalizedLivePosition = livePosition || {};
  const metrics = evaluation.metrics || {};
  const triggerText = (evaluation.triggers || [])
    .map((trigger) => `${trigger.label}: ${trigger.detail}; action=${trigger.action}`)
    .join(' | ');
  return [
    `(ARCH WATCH): ${toText(normalizedPosition.ticker, toText(normalizedLivePosition.ticker, 'UNKNOWN/USD'))} ${toText(normalizedPosition.side, normalizedLivePosition?.side || '').toUpperCase()} check`,
    `price=${round(metrics.currentPrice, 6)} pnl=${formatUsd(metrics.currentPnlUsd)} peak=${formatUsd(metrics.peakUnrealizedPnlUsd)} margin_gain=${formatPct(metrics.gainMarginPct)}`,
    `stop=${normalizedPosition.stopPrice || 'n/a'} tp1=${normalizedPosition.takeProfit1Price || 'n/a'} tp2=${normalizedPosition.takeProfit2Price || 'n/a'}`,
    `fast_reduce=node ui/scripts/hm-defi-close.js --asset ${toText(normalizedLivePosition.coin, '').toUpperCase()} --close-pct 50`,
    `fast_close=node ui/scripts/hm-defi-close.js --asset ${toText(normalizedLivePosition.coin, '').toUpperCase()} --close-pct 100`,
    triggerText,
  ].join(' | ');
}

function buildFlatLevelAlert(position = {}, evaluation = {}) {
  const exactMessage = (evaluation.triggers || []).find((trigger) => toText(trigger.exactMessage, ''))?.exactMessage;
  if (exactMessage) {
    return exactMessage;
  }
  const metrics = evaluation.metrics || {};
  const triggerText = (evaluation.triggers || [])
    .map((trigger) => `${trigger.label}: ${trigger.detail}; action=${trigger.action}`)
    .join(' | ');
  return [
    `(ARCH WATCH): ${position.ticker} level watch`,
    `price=${round(metrics.currentPrice, 6)}`,
    triggerText,
  ].join(' | ');
}

function buildPositionClosedAlert(position = {}, previousState = {}) {
  return [
    `(ARCH WATCH): ${position.ticker} closed`,
    `last_price=${round(previousState.lastPrice, 6)}`,
    `last_pnl=${formatUsd(previousState.currentPnlUsd)}`,
    `action=${toText(position.closeAction, 'position closed for any reason, verify whether stop fired and reassess immediately')}`,
  ].join(' | ');
}

function resolvePositionCadenceMs(config = {}, state = {}) {
  const configuredMs = Math.max(
    1_000,
    toNumber(config?.cadences?.positionCheckMs, DEFAULT_POSITION_CHECK_INTERVAL_MS)
  );
  const trackedPositions = Object.values(state?.positions || {});
  const hasOpenPosition = trackedPositions.some((position) => position?.wasOpen === true);
  if (!hasOpenPosition) {
    return configuredMs;
  }
  return Math.min(configuredMs, ACTIVE_POSITION_CHECK_INTERVAL_MS);
}

function computeFlatteningMetrics(closes = []) {
  const numeric = (Array.isArray(closes) ? closes : []).map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  if (numeric.length < 6) {
    return null;
  }
  const midpoint = Math.floor(numeric.length / 2);
  const first = numeric.slice(0, midpoint + 1);
  const second = numeric.slice(midpoint);
  const firstReturn = (first[first.length - 1] - first[0]) / first[0];
  const secondReturn = (second[second.length - 1] - second[0]) / second[0];
  const recentReturn = (numeric[numeric.length - 1] - numeric[numeric.length - 2]) / numeric[numeric.length - 2];
  const recentLow = Math.min(...numeric.slice(-4));
  const recentHigh = Math.max(...numeric.slice(-4));
  return {
    firstReturn,
    secondReturn,
    recentReturn,
    recentLow,
    recentHigh,
  };
}

function scoreSetupCandidate(candidate = {}) {
  const discovery = candidate.discovery || {};
  const metrics = computeFlatteningMetrics(candidate.closes5m || []);
  if (!metrics) {
    return null;
  }
  const fundingBps = toNumber(candidate.fundingBps, 0);
  const dayMovePct = toNumber(candidate.dayMovePct, 0);
  let direction = null;
  let score = 0;

  if (dayMovePct <= -0.10 && metrics.firstReturn < 0 && metrics.secondReturn > metrics.firstReturn) {
    direction = 'BUY';
    score += Math.min(35, Math.abs(dayMovePct) * 150);
    score += Math.min(25, Math.max(0, (metrics.secondReturn - metrics.firstReturn) * 1000));
    if (fundingBps <= -10) score += 20;
    if (metrics.recentReturn > 0) score += 10;
    if (Math.abs(dayMovePct) >= 0.15) score += 10;
  } else if (dayMovePct >= 0.10 && metrics.firstReturn > 0 && metrics.secondReturn < metrics.firstReturn) {
    direction = 'SELL';
    score += Math.min(35, Math.abs(dayMovePct) * 150);
    score += Math.min(25, Math.max(0, (metrics.firstReturn - metrics.secondReturn) * 1000));
    if (fundingBps >= 10) score += 20;
    if (metrics.recentReturn < 0) score += 10;
    if (Math.abs(dayMovePct) >= 0.15) score += 10;
  }

  if (!direction) {
    return null;
  }

  const price = toNumber(candidate.price, 0);
  const stopPrice = direction === 'BUY'
    ? Math.min(metrics.recentLow, price * 0.985)
    : Math.max(metrics.recentHigh, price * 1.015);
  const riskPerUnit = Math.abs(price - stopPrice);
  const takeProfitPrice = direction === 'BUY'
    ? price + (riskPerUnit * 2)
    : price - (riskPerUnit * 2);
  const takeProfitPct = price > 0 ? Math.abs((takeProfitPrice - price) / price) : 0;
  const tier = classifyCandidateTier(score, {
    aTierScoreThreshold: discovery.aTierScoreThreshold,
    bTierScoreThreshold: discovery.bTierScoreThreshold,
  });
  const marginRange = tier === 'A'
    ? (discovery.aTierMarginUsd || { min: 300, max: 450, default: 350 })
    : (discovery.bTierMarginUsd || { min: 125, max: 225, default: 175 });
  const suggestedMarginUsd = clamp(
    tier === 'A'
      ? (score >= 82 ? Math.max(toNumber(marginRange.default, 350), 400) : Math.max(toNumber(marginRange.default, 350), 325))
      : (score >= 64 ? Math.max(toNumber(marginRange.default, 175), 200) : Math.max(toNumber(marginRange.default, 175), 150)),
    toNumber(marginRange.min, tier === 'A' ? 300 : 125),
    toNumber(marginRange.max, tier === 'A' ? 450 : 225)
  );
  const leverage = Math.max(1, toNumber(discovery.leverage, 10));
  const projectedGrossUsd = estimateProjectedGrossUsd({
    marginUsd: suggestedMarginUsd,
    leverage,
    takeProfitPct,
  });

  return {
    ticker: candidate.ticker,
    direction,
    score: round(score, 2),
    price,
    stopPrice: round(stopPrice, 6),
    takeProfitPrice: round(takeProfitPrice, 6),
    takeProfitPct: round(takeProfitPct, 4),
    tier,
    suggestedMarginUsd: round(suggestedMarginUsd, 2),
    projectedGrossUsd: round(projectedGrossUsd, 2),
    fundingBps: round(fundingBps, 2),
    dayMovePct: round(dayMovePct, 4),
    firstReturn: round(metrics.firstReturn, 4),
    secondReturn: round(metrics.secondReturn, 4),
    recentReturn: round(metrics.recentReturn, 4),
  };
}

function buildSetupAlert(candidates = [], riskState = {}) {
  const summary = candidates
    .map((candidate) => `${candidate.ticker} ${candidate.direction} score=${candidate.score} entry=${candidate.price} stop=${candidate.stopPrice} tp=${candidate.takeProfitPrice} funding=${candidate.fundingBps}bps 24h=${formatPct(candidate.dayMovePct)} margin=${formatUsd(candidate.suggestedMarginUsd)}`)
    .join(' | ');
  return `(ARCH WATCH): contrarian setup(s) found | risk_mode=${toText(riskState.mode, 'normal')} | ${summary}`;
}

function passesSetupExecutionFilter(candidate = {}, book = {}, discovery = {}) {
  const maxSpreadBps = Math.max(0, toNumber(discovery.maxSpreadBps, 8));
  const minTop5DepthPerSideUsd = Math.max(0, toNumber(discovery.minTop5DepthPerSideUsd, 5000));
  const minTop10CombinedDepthUsd = Math.max(0, toNumber(discovery.minTop10CombinedDepthUsd, 30000));
  const spreadBps = toNumber(book?.spreadPct, 0) * 10_000;
  const top5BidUsd = toNumber(book?.top5BidUsd, 0);
  const top5AskUsd = toNumber(book?.top5AskUsd, 0);
  const top10CombinedDepthUsd = toNumber(book?.top10BidUsd, 0) + toNumber(book?.top10AskUsd, 0);

  if (!(spreadBps > 0) || spreadBps > maxSpreadBps) {
    return false;
  }
  if (top5BidUsd < minTop5DepthPerSideUsd || top5AskUsd < minTop5DepthPerSideUsd) {
    return false;
  }
  if (top10CombinedDepthUsd < minTop10CombinedDepthUsd) {
    return false;
  }
  return true;
}

function hashSetupCandidates(candidates = []) {
  return JSON.stringify(candidates.map((candidate) => [
    candidate.ticker,
    candidate.direction,
    candidate.score,
    candidate.price,
    candidate.stopPrice,
    candidate.takeProfitPrice,
  ]));
}

function normalizeBars(bars = []) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      open: toNumber(bar?.open ?? bar?.o, 0),
      high: toNumber(bar?.high ?? bar?.h, 0),
      low: toNumber(bar?.low ?? bar?.l, 0),
      close: toNumber(bar?.close ?? bar?.c, 0),
    }))
    .filter((bar) => bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0);
}

function countDirectionalStreak(bars = []) {
  const normalized = normalizeBars(bars);
  if (normalized.length === 0) return { direction: null, count: 0 };
  const candles = normalized.map((bar) => (
    bar.close > bar.open ? 'green' : bar.close < bar.open ? 'red' : 'flat'
  ));
  const last = candles[candles.length - 1];
  if (last === 'flat') return { direction: null, count: 0 };
  let count = 0;
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    if (candles[index] !== last) break;
    count += 1;
  }
  return { direction: last === 'green' ? 'BUY' : 'SELL', count };
}

function summarizeScalpCandidate(candidate = {}) {
  const sideLabel = candidate.direction === 'BUY' ? 'long' : 'short';
  return `${candidate.ticker} scalp ${sideLabel}: entry ${candidate.price}, stop ${candidate.stopPrice} (${formatPct(candidate.stopPct)}), tp ${candidate.takeProfitPrice} (${formatPct(candidate.takeProfitPct)}), gross ${formatUsd(candidate.projectedGrossUsd)}, suggested margin ${formatUsd(candidate.suggestedMarginUsd)}`;
}

function buildScalpAlert(candidates = [], riskState = {}) {
  const summary = candidates.map((candidate) => summarizeScalpCandidate(candidate)).join(' | ');
  return `(ARCH WATCH): scalp setup(s) found | risk_mode=${toText(riskState.mode, 'normal')} | ${summary}`;
}

function hashScalpCandidate(candidate = {}) {
  return JSON.stringify([
    candidate.ticker,
    candidate.direction,
    candidate.price,
    candidate.stopPrice,
    candidate.takeProfitPrice,
    candidate.projectedGrossUsd,
    candidate.suggestedMarginUsd,
  ]);
}

function estimateProjectedGrossUsd(input = {}) {
  const marginUsd = toNumber(input.marginUsd, 0);
  const leverage = Math.max(1, toNumber(input.leverage, 1));
  const takeProfitPct = Math.abs(toNumber(input.takeProfitPct, 0));
  if (!(marginUsd > 0 && leverage > 0 && takeProfitPct > 0)) {
    return 0;
  }
  return marginUsd * leverage * takeProfitPct;
}

function classifyCandidateTier(score, thresholds = {}) {
  const normalizedScore = toNumber(score, 0);
  const aTierScoreThreshold = Math.max(1, toNumber(thresholds.aTierScoreThreshold, 70));
  const bTierScoreThreshold = Math.max(1, toNumber(thresholds.bTierScoreThreshold, 58));
  if (normalizedScore >= aTierScoreThreshold) return 'A';
  if (normalizedScore >= bTierScoreThreshold) return 'B';
  return 'watch';
}

function buildCandidateBoard(summary = {}, config = {}, nowMs = Date.now()) {
  const discovery = config.setupDiscovery || {};
  const boardPath = toText(discovery.candidateBoardPath, DEFAULT_CANDIDATE_BOARD_PATH);
  const maxPerTier = Math.max(1, toNumber(discovery.maxPerTier, 8));
  const aTier = (Array.isArray(summary.setupCandidates) ? summary.setupCandidates : [])
    .filter((candidate) => candidate.tier === 'A')
    .slice(0, maxPerTier);
  const bTier = (Array.isArray(summary.setupCandidates) ? summary.setupCandidates : [])
    .filter((candidate) => candidate.tier === 'B')
    .slice(0, maxPerTier);
  const scalp = (Array.isArray(summary.scalpCandidates) ? summary.scalpCandidates : [])
    .slice(0, maxPerTier);
  return {
    version: 1,
    updatedAt: new Date(nowMs).toISOString(),
    universeScanned: toNumber(summary.universeScanned, 0),
    scanCadenceMs: {
      setup: toNumber(config?.cadences?.setupScanMs, DEFAULT_SETUP_SCAN_INTERVAL_MS),
      scalp: toNumber(config?.cadences?.scalpScanMs, DEFAULT_SCALP_SCAN_INTERVAL_MS),
    },
    tiers: {
      aTier,
      bTier,
      scalp,
    },
    summary: {
      aTierTop: aTier[0] || null,
      bTierTop: bTier[0] || null,
      scalpTop: scalp[0] || null,
    },
    path: boardPath,
  };
}

function persistCandidateBoard(board = {}, config = {}) {
  const boardPath = toText(board.path, toText(config?.setupDiscovery?.candidateBoardPath, DEFAULT_CANDIDATE_BOARD_PATH));
  const payload = {
    ...board,
    path: boardPath,
  };
  writeJson(boardPath, payload);
  return payload;
}

function scoreScalpCandidate(candidate = {}, options = {}) {
  const bars = normalizeBars(candidate.bars5m || []);
  if (bars.length < 6) {
    return null;
  }
  const discovery = options.discovery || {};
  const price = toNumber(candidate.price, 0);
  if (!(price > 0)) {
    return null;
  }
  const streak = countDirectionalStreak(bars);
  if (streak.count < 3 || !streak.direction) {
    return null;
  }

  const window = bars.slice(-Math.max(3, streak.count));
  const firstOpen = toNumber(window[0]?.open, 0);
  const lastClose = toNumber(window[window.length - 1]?.close, 0);
  if (!(firstOpen > 0 && lastClose > 0)) {
    return null;
  }
  const netMovePct = Math.abs((lastClose - firstOpen) / firstOpen);
  const grossMovePct = window.reduce((sum, bar) => {
    return sum + Math.abs((bar.close - bar.open) / Math.max(bar.open, 0.0000001));
  }, 0);
  const efficiency = grossMovePct > 0 ? (netMovePct / grossMovePct) : 0;
  const minNetMovePct = Math.max(0.0005, toNumber(discovery.minNetMovePct, 0.002));
  const minEfficiency = Math.max(0.1, toNumber(discovery.minEfficiency, 0.58));
  if (netMovePct < minNetMovePct || efficiency < minEfficiency) {
    return null;
  }

  const recentHigh = Math.max(...bars.map((bar) => bar.high));
  const recentLow = Math.min(...bars.map((bar) => bar.low));
  const resistanceBufferPct = Math.max(0.0005, toNumber(discovery.resistanceBufferPct, 0.0015));
  const supportBufferPct = Math.max(0.0005, toNumber(discovery.supportBufferPct, 0.0015));
  if (streak.direction === 'BUY' && price >= recentHigh * (1 - resistanceBufferPct)) {
    return null;
  }
  if (streak.direction === 'SELL' && price <= recentLow * (1 + supportBufferPct)) {
    return null;
  }

  const macroRegime = toText(discovery.macroRegime, 'neutral').toLowerCase();
  const macroBias = toText(discovery.macroBias, 'risk_on').toLowerCase();
  const isCounterMacro = macroRegime === 'red'
    && ((macroBias === 'risk_off' && streak.direction === 'BUY')
      || (macroBias === 'risk_on' && streak.direction === 'SELL'));
  if (isCounterMacro) {
    return null;
  }

  const atrPct = bars
    .slice(-6)
    .reduce((sum, bar) => sum + ((bar.high - bar.low) / Math.max(bar.close, 0.0000001)), 0) / Math.min(6, bars.length);
  const stopPct = clamp(Math.max(0.002, atrPct * 0.65), 0.002, 0.0045);
  const takeProfitPct = clamp(Math.max(stopPct * 2, atrPct * 1.25), 0.004, 0.008);
  const stopPrice = streak.direction === 'BUY'
    ? price * (1 - stopPct)
    : price * (1 + stopPct);
  const takeProfitPrice = streak.direction === 'BUY'
    ? price * (1 + takeProfitPct)
    : price * (1 - takeProfitPct);

  let score = 0;
  score += Math.min(35, streak.count * 10);
  score += Math.min(25, netMovePct * 10_000);
  score += Math.min(20, efficiency * 20);
  const fundingBps = toNumber(candidate.fundingBps, 0);
  if ((streak.direction === 'BUY' && fundingBps <= 0) || (streak.direction === 'SELL' && fundingBps >= 0)) {
    score += Math.min(10, Math.abs(fundingBps) * 0.5);
  }
  const marginConfig = discovery.marginUsd || {};
  const suggestedMarginUsd = clamp(
    toNumber(marginConfig.default, 75)
      + (score >= 85 ? 15 : score >= 75 ? 5 : 0),
    toNumber(marginConfig.min, 50),
    toNumber(marginConfig.max, 100)
  );
  const projectedGrossUsd = estimateProjectedGrossUsd({
    marginUsd: suggestedMarginUsd,
    leverage: Math.max(1, toNumber(discovery.leverage, 10)),
    takeProfitPct,
  });
  const minProjectedGrossUsd = Math.max(0, toNumber(discovery.minProjectedGrossUsd, 0));
  if (projectedGrossUsd < minProjectedGrossUsd) {
    return null;
  }
  const tier = classifyCandidateTier(score, {
    aTierScoreThreshold: discovery.aTierScoreThreshold ?? 70,
    bTierScoreThreshold: discovery.bTierScoreThreshold ?? discovery.scoreThreshold ?? 65,
  });

  return {
    ticker: normalizeTicker(candidate.ticker),
    direction: streak.direction,
    score: round(score, 2),
    price: round(price, 6),
    stopPrice: round(stopPrice, 6),
    takeProfitPrice: round(takeProfitPrice, 6),
    stopPct: round(stopPct, 4),
    takeProfitPct: round(takeProfitPct, 4),
    fundingBps: round(fundingBps, 2),
    consecutiveCandles: streak.count,
    netMovePct: round(netMovePct, 4),
    efficiency: round(efficiency, 4),
    tier,
    projectedGrossUsd: round(projectedGrossUsd, 2),
    suggestedMarginUsd: round(suggestedMarginUsd, 2),
  };
}

async function fetchRuntime() {
  return hmDefiExecute.resolveHyperliquidRuntime({});
}

function normalizeLivePosition(position = {}) {
  const raw = position.raw || position;
  const size = toNumber(raw.szi ?? position.size, 0);
  return {
    coin: toText(raw.coin || position.coin).toUpperCase(),
    ticker: `${toText(raw.coin || position.coin).toUpperCase()}/USD`,
    size,
    absSize: Math.abs(size),
    side: size < 0 ? 'short' : (size > 0 ? 'long' : 'flat'),
    entryPx: toNumber(raw.entryPx ?? position.entryPx, 0),
    unrealizedPnl: toNumber(raw.unrealizedPnl ?? position.unrealizedPnl, 0),
    marginUsed: toNumber(raw.marginUsed, 0),
    positionValue: toNumber(raw.positionValue, 0),
    leverage: toNumber(raw?.leverage?.value, 0),
  };
}

async function fetchPositionContext(runtime, config) {
  const [account, positionsRaw, universe] = await Promise.all([
    hyperliquidClient.getAccountSnapshot({ walletAddress: runtime.walletAddress }),
    hyperliquidClient.getOpenPositions({ walletAddress: runtime.walletAddress }),
    hyperliquidClient.getUniverseMarketData({}),
  ]);
  const openOrders = await hyperliquidClient.getOpenOrders({ walletAddress: runtime.walletAddress }).catch(() => []);
  const positions = (Array.isArray(positionsRaw) ? positionsRaw : []).map((position) => normalizeLivePosition(position));
  const universeByTicker = new Map((Array.isArray(universe) ? universe : []).map((entry) => [normalizeTicker(entry.ticker || `${entry.coin}/USD`), entry]));
  const positionsByTicker = new Map(positions.map((position) => [position.ticker, position]));
  return {
    account,
    openOrders: Array.isArray(openOrders) ? openOrders : [],
    positionsByTicker,
    universeByTicker,
    positions,
  };
}

function resolvePaceWindowStartMs(config = {}, nowMs = Date.now()) {
  const configuredStartMs = new Date(toText(config.sessionStartAt, new Date(nowMs).toISOString())).getTime();
  const paceWindow = toText(config.paceWindow, 'day').toLowerCase();
  if (paceWindow === 'session') {
    return configuredStartMs;
  }
  const now = new Date(nowMs);
  const localDayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (!Number.isFinite(configuredStartMs)) {
    return localDayStartMs;
  }
  return Math.max(localDayStartMs, configuredStartMs);
}

async function fetchUserFillsSafely(runtime, startTimeMs = 0) {
  try {
    if (typeof runtime?.info?.userFillsByTime === 'function') {
      return await runtime.info.userFillsByTime({
        user: runtime.walletAddress,
        startTime: startTimeMs,
        aggregateByTime: false,
        reversed: true,
      });
    }
    if (typeof runtime?.info?.userFills === 'function') {
      const allFills = await runtime.info.userFills({
        user: runtime.walletAddress,
        aggregateByTime: false,
      });
      return (Array.isArray(allFills) ? allFills : []).filter((fill) => Number(fill?.time || 0) >= startTimeMs);
    }
  } catch (error) {
    console.error(`[ARCH WATCH] user fills unavailable: ${formatErrorForLog(error)}`);
  }
  return [];
}

function resolveTrackedAgentAssets(config = {}, options = {}) {
  const nowMs = toNumber(options.nowMs, Date.now());
  const startTimeMs = toNumber(options.startTimeMs, resolvePaceWindowStartMs(config, nowMs));
  const lookbackMs = Math.max(60_000, nowMs - startTimeMs);
  const tracked = new Set(
    (Array.isArray(config.trackedPnlAssets) ? config.trackedPnlAssets : [])
      .map((entry) => normalizeTicker(entry))
      .filter(Boolean)
  );

  for (const position of getAgentPositions(config)) {
    const normalized = normalizeTicker(position?.ticker);
    if (normalized) tracked.add(normalized);
  }

  for (const ticker of agentPositionAttribution.resolveTrackedAgentAssets({ lookbackMs })) {
    const normalized = normalizeTicker(ticker);
    if (normalized) tracked.add(normalized);
  }

  return tracked;
}

async function computeTrackedRealizedPnl(runtime, config) {
  const startTimeMs = resolvePaceWindowStartMs(config, Date.now());
  const assets = Array.from(resolveTrackedAgentAssets(config, { startTimeMs }))
    .map((entry) => toText(entry).replace('/USD', '').toUpperCase())
    .filter(Boolean);
  if (assets.length === 0) {
    return {
      realizedPnlUsd: round(toNumber(config.realizedPnlAdjustmentsUsd, 0), 2),
      fills: [],
      trackedAssets: [],
    };
  }

  const fills = await fetchUserFillsSafely(runtime, startTimeMs);

  const realizedPnlUsd = (Array.isArray(fills) ? fills : []).reduce((sum, fill) => {
    const coin = toText(fill?.coin).toUpperCase();
    const closedPnl = Number(fill?.closedPnl);
    if (!assets.includes(coin) || !Number.isFinite(closedPnl)) {
      return sum;
    }
    return sum + closedPnl;
  }, toNumber(config.realizedPnlAdjustmentsUsd, 0));

  return {
    realizedPnlUsd: round(realizedPnlUsd, 2),
    fills: Array.isArray(fills) ? fills : [],
    trackedAssets: assets,
  };
}

function buildActionPrompt(positionSummaries = [], setupSummary = null) {
  const positionPrompt = positionSummaries
    .filter(Boolean)
    .slice(0, 2)
    .join(', ');
  if (setupSummary) {
    return positionPrompt ? `${positionPrompt}, ${setupSummary}` : setupSummary;
  }
  return positionPrompt || 'no new setup recommended';
}

function summarizeWalletPositions(context = {}, config = {}) {
  const allPositions = Array.from(context?.positionsByTicker?.values?.() || context?.positions || []);
  const configuredAgentTickers = new Set(
    getAgentPositions(config)
      .map((entry) => normalizeTicker(entry.ticker))
      .filter(Boolean)
  );
  const attributedAgentTickers = agentPositionAttribution.resolveAgentPositionOwnership(allPositions).tickers;
  const agentTickers = new Set([
    ...configuredAgentTickers,
    ...attributedAgentTickers,
  ]);
  const agentPositions = allPositions.filter((position) => agentTickers.has(normalizeTicker(position.ticker)));
  const userPositions = allPositions.filter((position) => !agentTickers.has(normalizeTicker(position.ticker)));
  const sumUnrealized = (positions = []) => round(positions.reduce((sum, position) => {
    return sum + toNumber(position?.unrealizedPnl, 0);
  }, 0), 2);
  const detail = (positions = []) => positions
    .slice(0, 3)
    .map((position) => `${position.coin} ${formatUsd(position.unrealizedPnl)}`)
    .join(', ');

  return {
    totalCount: allPositions.length,
    totalUnrealizedPnlUsd: sumUnrealized(allPositions),
    agentCount: agentPositions.length,
    agentUnrealizedPnlUsd: sumUnrealized(agentPositions),
    userCount: userPositions.length,
    userUnrealizedPnlUsd: sumUnrealized(userPositions),
    agentDetail: detail(agentPositions) || 'none',
    userDetail: detail(userPositions) || 'none',
    actionPromptSummaries: allPositions.slice(0, 2).map((position) => `${position.coin} pnl ${formatUsd(position.unrealizedPnl)}`),
  };
}

function buildPaceAlert(payload = {}) {
  return [
    '(ARCH WATCH): pace behind quota',
    `risk_mode=${toText(payload.riskMode, 'normal')}`,
    `risk_trigger=${toText(payload.riskTriggerCause, 'none')}`,
    `daily_loss_cap=${formatUsd(payload.dailyLossCapUsd)}`,
    `daily_realized=${formatUsd(payload.dailyRealizedUsd)}`,
    `remaining_loss_budget=${formatUsd(payload.remainingLossBudgetUsd)}`,
    `per_trade_cap=${formatUsd(payload.remainingPerTradeMarginCapUsd)}`,
    `account=${formatUsd(payload.accountValue)}`,
    `realized_since_session=${formatUsd(payload.realizedPnlUsd)}`,
    `quota=${formatUsd(payload.quotaUsd)}`,
    `delta=${formatUsd(payload.realizedPnlUsd - payload.quotaUsd)}`,
    `open_positions_total=${payload.openPositionsTotalCount || 0} total_unrealized=${formatUsd(payload.openPositionsTotalUnrealizedPnlUsd)}`,
    `agent=${payload.agentOpenPositionsCount || 0} positions ${formatUsd(payload.agentOpenPositionsUnrealizedPnlUsd)} (${payload.agentOpenPositionsDetail || 'none'})`,
    `user=${payload.userOpenPositionsCount || 0} positions ${formatUsd(payload.userOpenPositionsUnrealizedPnlUsd)} (${payload.userOpenPositionsDetail || 'none'})`,
    `action=${payload.actionPrompt || 'reduce churn, wait for higher-score setup'}`,
  ].join(' | ');
}

function filterCandidatesForRiskMode(candidates = [], riskState = {}) {
  const mode = toText(riskState.mode, 'normal').toLowerCase();
  if (mode === 'halted' || mode === 'paused') return [];
  if (mode === 'defensive') {
    return (Array.isArray(candidates) ? candidates : []).filter((candidate) => toText(candidate.tier, '').toUpperCase() === 'A');
  }
  return Array.isArray(candidates) ? candidates : [];
}

async function runRiskLane(config, state, nowMs, context = null, runtime = null) {
  const riskConfig = hardRiskGuard.loadRiskConfig();
  const previousRiskState = hardRiskGuard.loadRiskState(toText(riskConfig.statePath, hardRiskGuard.DEFAULT_RISK_STATE_PATH));
  const accountEquityUsd = toNumber(context?.account?.equity, toNumber(previousRiskState.accountEquityUsd, 0));
  const trackedAgentTickers = resolveTrackedAgentAssets(config, { nowMs });
  const trackedAgentCount = Array.from(context?.positionsByTicker?.keys?.() || [])
    .filter((ticker) => trackedAgentTickers.has(normalizeTicker(ticker)))
    .length;
  const trackedAssets = Array.from(trackedAgentTickers)
    .map((asset) => toText(asset).replace('/USD', '').toUpperCase())
    .filter(Boolean);
  let weeklyFills = [];
  const weeklyLookbackDays = Math.max(1, Number(riskConfig.weeklyMetrics?.lookbackDays) || 7);
  if (runtime?.info) {
    const startTime = nowMs - (weeklyLookbackDays * 24 * 60 * 60 * 1000);
    weeklyFills = await fetchUserFillsSafely(runtime, startTime);
  }
  const filteredWeeklyFills = (Array.isArray(weeklyFills) ? weeklyFills : []).filter((fill) => {
    if (trackedAssets.length === 0) return true;
    return trackedAssets.includes(toText(fill?.coin).toUpperCase());
  });
  let nextRiskState = hardRiskGuard.refreshRiskState({
    config: riskConfig,
    previousState: previousRiskState,
    updatedAt: new Date(nowMs).toISOString(),
    marketDate: hardRiskGuard.getPacificDateKey(nowMs),
    accountEquityUsd,
    dailyRealizedPnlUsd: toNumber(state.pace?.lastRealizedPnlUsd, 0),
    currentAgentPositionCount: trackedAgentCount || (context?.positionsByTicker instanceof Map ? 0 : 0),
  });
  const weeklyMetrics = hardRiskGuard.computeWeeklyMetrics({
    fills: filteredWeeklyFills,
    dailyCycles: nextRiskState.dailyCycles,
    accountEquityUsd: nextRiskState.accountEquityUsd,
    maxObservedDrawdownPct: nextRiskState.maxObservedDrawdownPct,
    lookbackDays: weeklyLookbackDays,
    largestSingleLossFlagPct: riskConfig.weeklyMetrics?.largestSingleLossFlagPct,
    updatedAt: new Date(nowMs).toISOString(),
  });
  nextRiskState = {
    ...nextRiskState,
    weekly: {
      ...(nextRiskState.weekly || {}),
      ...weeklyMetrics,
      updatedAt: new Date(nowMs).toISOString(),
      path: toText(riskConfig.weeklyReportPath, hardRiskGuard.DEFAULT_WEEKLY_RISK_REPORT_PATH),
    },
  };
  hardRiskGuard.persistRiskState(nextRiskState, {
    config: riskConfig,
    statePath: riskConfig.statePath,
    weeklyReportPath: riskConfig.weeklyReportPath,
  });

  const previousMode = toText(previousRiskState.mode, 'normal');
  const alerts = [];
  if (previousMode !== nextRiskState.mode) {
    hardRiskGuard.recordRiskEvent({
      config: riskConfig,
      type: 'risk_mode_transition',
      occurredAt: nextRiskState.updatedAt,
      mode: nextRiskState.mode,
      triggerCause: nextRiskState.triggerCause,
      thresholdCrossed: nextRiskState.triggerCause,
      accountState: {
        equityUsd: nextRiskState.accountEquityUsd,
        dailyRealizedPnlUsd: nextRiskState.dailyRealizedPnlUsd,
        dailyLossCapUsd: nextRiskState.dailyLossCapUsd,
        remainingLossBudgetUsd: nextRiskState.remainingLossBudgetUsd,
        peakEquityUsd: nextRiskState.peakEquityUsd,
        drawdownPct: nextRiskState.drawdownPct,
      },
      details: {
        previousMode,
        nextMode: nextRiskState.mode,
        pausedUntil: nextRiskState.pausedUntil,
      },
    });
    alerts.push(
      `(ARCH WATCH): hard risk mode ${previousMode} -> ${nextRiskState.mode} `
      + `| trigger=${toText(nextRiskState.triggerCause, 'none')} `
      + `| account=${formatUsd(nextRiskState.accountEquityUsd)} `
      + `| daily_realized=${formatUsd(nextRiskState.dailyRealizedPnlUsd)} `
      + `| daily_loss_cap=${formatUsd(nextRiskState.dailyLossCapUsd)} `
      + `| remaining_loss_budget=${formatUsd(nextRiskState.remainingLossBudgetUsd)} `
      + `| peak=${formatUsd(nextRiskState.peakEquityUsd)} `
      + `| cap=${formatUsd(nextRiskState.remainingPerTradeMarginCapUsd)}`
    );
  }

  return {
    alerts,
    nextState: {
      ...state,
      risk: nextRiskState,
    },
  };
}

function buildFreedMarginAlert(event = {}) {
  return [
    '(DESK EVENT): freed_margin',
    `ticker=${event.ticker || 'ORDI/USD'}`,
    `freed_margin=${formatUsd(event.freedMarginUsd)}`,
    `previous_size=${round(event.previousSize, 4)}`,
    `previous_margin_used=${formatUsd(event.previousMarginUsedUsd)}`,
    `cash_before=${formatUsd(event.previousCashUsd)}`,
    `cash_now=${formatUsd(event.currentCashUsd)}`,
    `event_age_window=${event.maxEventAgeMinutes || 15}m`,
    'action=scan immediately and return one ranked executable setup',
  ].join(' | ');
}

function buildPowwowRequestId(nowMs = Date.now()) {
  return `powwow-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
}

function collectProposalTickers(state = {}) {
  return Array.from(new Set([
    ...((Array.isArray(state.setup?.lastCandidates) ? state.setup.lastCandidates : []).map((candidate) => normalizeTicker(candidate.ticker))),
    ...((Array.isArray(state.scalp?.lastCandidates) ? state.scalp.lastCandidates : []).map((candidate) => normalizeTicker(candidate.ticker))),
  ].filter(Boolean)));
}

function updateRecurringProposalCounts(previousCounts = {}, currentTickers = []) {
  const nextCounts = {};
  const currentSet = new Set(currentTickers.map((ticker) => normalizeTicker(ticker)).filter(Boolean));
  for (const ticker of currentSet) {
    nextCounts[ticker] = toNumber(previousCounts?.[ticker], 0) + 1;
  }
  return nextCounts;
}

function buildPowwowBlockerFlags(state = {}, payload = {}) {
  return {
    macro_stale: state.macro?.oil?.stale === true,
    recycler: Object.values(payload.recurringProposalCounts || {}).some((count) => toNumber(count, 0) >= DEFAULT_POWWOW_RECURRING_THRESHOLD),
    no_armed_setup: !(payload.topCandidates?.aTier || payload.topCandidates?.bTier || payload.topCandidates?.scalp),
    execution_constraint: ['defensive', 'halted', 'paused'].includes(toText(payload.risk?.mode, 'normal')),
    loss_drift_flag: payload.risk?.largestSingleLossAutoFlag === true,
  };
}

function buildPowwowPayload(config = {}, state = {}, nowMs = Date.now(), context = null) {
  const sessionStartMs = resolvePaceWindowStartMs(config, nowMs);
  const elapsedHours = Math.max(0.0001, (nowMs - sessionStartMs) / (60 * 60 * 1000));
  const realizedPnlUsd = toNumber(state.pace?.lastRealizedPnlUsd, 0);
  const quotaUsd = toNumber(state.pace?.lastQuotaUsd, elapsedHours * toNumber(config.quotaPerHourUsd, 8.33));
  const paceDeltaUsd = round(realizedPnlUsd - quotaUsd, 2);
  const projectionUsd = round((realizedPnlUsd / elapsedHours) * 24, 2);
  const recurringCounts = Object.fromEntries(
    Object.entries(state.powwow?.recurringProposalCountsByTicker || {})
      .filter(([, count]) => toNumber(count, 0) > 0)
      .sort((left, right) => toNumber(right[1], 0) - toNumber(left[1], 0))
      .slice(0, 8)
  );
  const payload = {
    triggerReason: null,
    realizedPnlUsd,
    quotaUsd: round(quotaUsd, 2),
    paceDeltaUsd,
    projectionUsd,
    activeWindow: isActiveWindow(nowMs),
    lastFireTimestamp: toText(state.powwow?.lastFireAt, null),
    lastValidSetupTimestamp: toText(state.powwow?.lastValidSetupAt, null),
    recurringProposalCounts: recurringCounts,
    blockerFlags: {},
    risk: {
      mode: toText(state.risk?.mode, 'normal'),
      triggerCause: toText(state.risk?.triggerCause, null),
      currentAccountUsd: round(toNumber(state.risk?.accountEquityUsd, context?.account?.equity), 2),
      currentDailyRealizedUsd: round(toNumber(state.risk?.dailyRealizedPnlUsd, state.pace?.lastRealizedPnlUsd), 2),
      dailyLossCapUsd: round(toNumber(state.risk?.dailyLossCapUsd, 0), 2),
      remainingLossBudgetUsd: round(toNumber(state.risk?.remainingLossBudgetUsd, 0), 2),
      peakEquityAnchorUsd: round(toNumber(state.risk?.peakEquityUsd, 0), 2),
      remainingPerTradeMarginCapUsd: round(toNumber(state.risk?.remainingPerTradeMarginCapUsd, 0), 2),
      pausedUntil: toText(state.risk?.pausedUntil, null),
      largestSingleLossPct: round(toNumber(state.risk?.weekly?.largestSingleLossPct, 0), 6),
      largestSingleLossAutoFlag: state.risk?.weekly?.largestSingleLossAutoFlag === true,
      scoreboard: state.risk?.scoreboard || null,
    },
    topCandidates: {
      aTier: state.candidateBoard?.summary?.aTierTop || null,
      bTier: state.candidateBoard?.summary?.bTierTop || null,
      scalp: state.candidateBoard?.summary?.scalpTop || null,
    },
    openPositions: summarizeWalletPositions(context || {}, config),
  };
  payload.blockerFlags = buildPowwowBlockerFlags(state, payload);
  return payload;
}

function buildPowwowPrompt(request = {}) {
  const payload = request.payload || {};
  const recurringNote = request.recurringProposal
    ? ` recurring=${request.recurringProposal.ticker}:${request.recurringProposal.count}`
    : '';
  return [
    `(ARCH WATCH POWWOW): trigger=${request.triggerReason}${recurringNote} requestId=${request.requestId}`,
    `payload=${JSON.stringify(payload)}`,
    `reply_window_ms=${request.responseTimeoutMs}`,
    'reply with JSON only; builder/oracle via hm-send architect, architect local recorded/self-send also counts:',
    JSON.stringify({
      requestId: request.requestId,
      agentId: 'builder',
      paceStatus: 'realized/quota/delta and current read',
      blockerCheck: 'biggest blocker right now',
      next30mAction: 'one concrete action commitment',
    }),
  ].join(' | ');
}

function resolvePowwowPaths(config = {}) {
  const powwow = config.powwow || {};
  return {
    requestsDir: path.resolve(toText(powwow.requestsDir, DEFAULT_POWWOW_REQUESTS_DIR)),
    resultsPath: path.resolve(toText(powwow.resultsPath, DEFAULT_POWWOW_RESULTS_PATH)),
  };
}

function persistPowwowRequest(request = {}, config = {}) {
  const { requestsDir } = resolvePowwowPaths(config);
  const requestPath = path.join(requestsDir, `${request.requestId}.json`);
  writeJson(requestPath, request);
  return requestPath;
}

function persistPowwowResult(result = {}, config = {}) {
  const { resultsPath } = resolvePowwowPaths(config);
  appendJsonLine(resultsPath, result);
  return resultsPath;
}

function parsePowwowResponseEntry(entry = {}, requestId) {
  const parsed = extractJsonObjectFromText(entry.rawBody || '');
  if (!parsed || toText(parsed.requestId) !== toText(requestId)) return null;
  const agentId = toText(parsed.agentId).toLowerCase();
  if (!['architect', 'builder', 'oracle'].includes(agentId)) return null;
  return {
    agentId,
    paceStatus: toText(parsed.paceStatus),
    blockerCheck: toText(parsed.blockerCheck),
    next30mAction: toText(parsed.next30mAction),
    receivedAt: entry.brokeredAtMs || entry.sentAtMs || null,
    rawBody: entry.rawBody || '',
  };
}

function collectPowwowResponses(request = {}) {
  const sentAtMs = new Date(toText(request.sentAt, 0)).getTime() || 0;
  const inboundRows = queryCommsJournalEntries({
    targetRole: 'architect',
    sinceMs: Math.max(0, sentAtMs - 1000),
    order: 'asc',
    limit: 500,
  });
  const architectRows = queryCommsJournalEntries({
    senderRole: 'architect',
    sinceMs: Math.max(0, sentAtMs - 1000),
    order: 'asc',
    limit: 500,
  });
  const seenKeys = new Set();
  const rows = [...inboundRows, ...architectRows].filter((entry) => {
    const key = [
      toText(entry.messageId, ''),
      toText(entry.rawBody, ''),
      toText(entry.senderRole, ''),
      toText(entry.targetRole, ''),
      Number(entry.brokeredAtMs || entry.sentAtMs || 0),
    ].join('|');
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  const responsesByRole = {};
  for (const entry of rows) {
    const senderRole = toText(entry.senderRole).toLowerCase();
    if (!['architect', 'builder', 'oracle'].includes(senderRole)) continue;
    const parsed = parsePowwowResponseEntry(entry, request.requestId);
    if (!parsed) continue;
    responsesByRole[parsed.agentId] = parsed;
  }
  return responsesByRole;
}

function buildPowwowSynthesis(request = {}, responsesByRole = {}) {
  const targets = normalizeTargets(request.targets || ['architect', 'builder', 'oracle']);
  const missingRoles = targets.filter((role) => !responsesByRole[role]);
  if (missingRoles.length > 0) {
    return `powwow ${request.requestId}: missing ${missingRoles.join(', ')}; no fake consensus.`;
  }
  const blockerSummary = Array.from(new Set(
    Object.values(responsesByRole)
      .map((response) => response.blockerCheck)
      .filter(Boolean)
  )).slice(0, 2).join(' / ');
  const actionSummary = Object.values(responsesByRole)
    .map((response) => `${response.agentId}:${response.next30mAction}`)
    .filter(Boolean)
    .join(' ; ');
  const lossDriftFlag = request?.payload?.risk?.largestSingleLossAutoFlag === true
    ? ' | drift=largest_single_loss_flag'
    : '';
  return `powwow ${request.requestId}: blockers=${blockerSummary || 'none flagged'} | next=${actionSummary || 'none committed'}${lossDriftFlag}`;
}

async function runPowwowLane(config, state, nowMs, context = null) {
  const powwowConfig = config.powwow || {};
  const targets = normalizeTargets(powwowConfig.targets || ['architect', 'builder', 'oracle']);
  if (powwowConfig.enabled === false || targets.length === 0) {
    return { alerts: [], routedAlerts: [], nextState: state };
  }

  const activeWindow = isActiveWindow(nowMs);
  const cadenceMs = activeWindow
    ? Math.max(60_000, toNumber(powwowConfig.activeWindowIntervalMs, DEFAULT_POWWOW_ACTIVE_WINDOW_INTERVAL_MS))
    : Math.max(60_000, toNumber(powwowConfig.quietWindowIntervalMs, DEFAULT_POWWOW_QUIET_WINDOW_INTERVAL_MS));
  const paceDeltaThresholdUsd = Math.max(1, toNumber(powwowConfig.paceDeltaThresholdUsd, DEFAULT_POWWOW_PACE_DELTA_THRESHOLD_USD));
  const recurringThreshold = Math.max(2, toNumber(powwowConfig.recurringProposalThreshold, DEFAULT_POWWOW_RECURRING_THRESHOLD));
  const currentProposalTickers = collectProposalTickers(state);
  const recurringCounts = updateRecurringProposalCounts(
    state.powwow?.recurringProposalCountsByTicker || {},
    currentProposalTickers
  );
  const currentAgentPositionKeys = getAgentPositions(config)
    .map((position) => normalizeTicker(position.ticker))
    .filter((ticker) => ticker && context?.positionsByTicker?.has(ticker))
    .sort();
  const previousAgentPositionKeys = Array.isArray(state.powwow?.lastOpenAgentPositionKeys)
    ? state.powwow.lastOpenAgentPositionKeys.slice().sort()
    : [];
  const newlyOpenedAgentPositions = currentAgentPositionKeys.filter((ticker) => !previousAgentPositionKeys.includes(ticker));
  const payload = buildPowwowPayload(config, state, nowMs, context);
  const nextPowwow = {
    ...(state.powwow || {}),
    lastPaceDeltaUsd: payload.paceDeltaUsd,
    lastOpenAgentPositionKeys: currentAgentPositionKeys,
    recurringProposalCountsByTicker: recurringCounts,
    lastValidSetupAt: payload.topCandidates.aTier || payload.topCandidates.bTier || payload.topCandidates.scalp
      ? new Date(nowMs).toISOString()
      : toText(state.powwow?.lastValidSetupAt, null),
    lastFireAt: newlyOpenedAgentPositions.length > 0
      ? new Date(nowMs).toISOString()
      : toText(state.powwow?.lastFireAt, null),
  };

  const alerts = [];
  const routedAlerts = [];
  const openRequest = state.powwow?.openRequest || null;
  let finalizedThisCycle = false;

  if (openRequest) {
    const responsesByRole = collectPowwowResponses(openRequest);
    const responseCount = Object.keys(responsesByRole).length;
    const deadlineMs = new Date(toText(openRequest.deadlineAt, 0)).getTime() || 0;
    const readyToFinalize = responseCount >= targets.length || (deadlineMs > 0 && nowMs >= deadlineMs);
    if (readyToFinalize) {
      const synthesis = buildPowwowSynthesis(openRequest, responsesByRole);
      const missingRoles = targets.filter((role) => !responsesByRole[role]);
      const result = {
        requestId: openRequest.requestId,
        triggerReason: openRequest.triggerReason,
        completedAt: new Date(nowMs).toISOString(),
        payload: openRequest.payload,
        responsesByRole,
        missingRoles,
        synthesis,
      };
      persistPowwowResult(result, config);
      nextPowwow.openRequest = null;
      nextPowwow.lastCompletedAt = result.completedAt;
      nextPowwow.lastSynthesis = synthesis;
      finalizedThisCycle = true;
      alerts.push(`(ARCH WATCH POWWOW): ${synthesis}`);
    } else {
      nextPowwow.openRequest = openRequest;
    }
  }

  if (!nextPowwow.openRequest && !finalizedThisCycle) {
    const lastTimedPowwowMs = new Date(toText(state.powwow?.lastTimedPowwowAt, 0)).getTime() || 0;
    const timedDue = !lastTimedPowwowMs || (nowMs - lastTimedPowwowMs) >= cadenceMs;
    const previousDelta = toNumber(state.powwow?.lastPaceDeltaUsd, 0);
    const paceBehindTrigger = payload.paceDeltaUsd <= -paceDeltaThresholdUsd && previousDelta > -paceDeltaThresholdUsd;
    const paceAheadTrigger = payload.paceDeltaUsd >= paceDeltaThresholdUsd && previousDelta < paceDeltaThresholdUsd;
    const previousRecurringCounts = state.powwow?.recurringProposalCountsByTicker || {};
    const recurringProposal = Object.entries(recurringCounts)
      .filter(([ticker, count]) => {
        return toNumber(count, 0) >= recurringThreshold
          && toNumber(previousRecurringCounts[ticker], 0) < recurringThreshold;
      })
      .sort((left, right) => toNumber(right[1], 0) - toNumber(left[1], 0))[0];

    let triggerReason = null;
    if (newlyOpenedAgentPositions.length > 0) {
      triggerReason = 'after_agent_fire';
    } else if (paceBehindTrigger) {
      triggerReason = 'pace_behind';
    } else if (paceAheadTrigger) {
      triggerReason = 'pace_ahead';
    } else if (recurringProposal) {
      triggerReason = 'recurring_proposal';
    } else if (timedDue) {
      triggerReason = activeWindow ? 'timed_active_window' : 'timed_quiet_window';
    }

    if (triggerReason) {
      const requestId = buildPowwowRequestId(nowMs);
      const responseTimeoutMs = Math.max(60_000, toNumber(powwowConfig.responseTimeoutMs, DEFAULT_POWWOW_RESPONSE_TIMEOUT_MS));
      payload.triggerReason = triggerReason;
      const request = {
        requestId,
        triggerReason,
        createdAt: new Date(nowMs).toISOString(),
        sentAt: new Date(nowMs).toISOString(),
        deadlineAt: new Date(nowMs + responseTimeoutMs).toISOString(),
        responseTimeoutMs,
        targets,
        recurringProposal: recurringProposal
          ? { ticker: recurringProposal[0], count: recurringProposal[1] }
          : null,
        payload,
      };
      const requestPath = persistPowwowRequest(request, config);
      nextPowwow.openRequest = { ...request, requestPath };
      nextPowwow.lastTriggeredAt = request.createdAt;
      if (triggerReason.startsWith('timed_')) {
        nextPowwow.lastTimedPowwowAt = request.createdAt;
      }
      routedAlerts.push({
        targets,
        message: buildPowwowPrompt(request),
      });
    }
  }

  return {
    alerts,
    routedAlerts,
    nextState: {
      ...state,
      powwow: nextPowwow,
    },
  };
}

function evaluateOilMacroTriggers(input = {}) {
  const nowMs = Number(input.nowMs || Date.now());
  const config = input.config || {};
  const previousState = input.previousState || {};
  const currentPrice = toNumber(input.currentPrice, 0);
  const fetchedAt = toText(input.fetchedAt, new Date(nowMs).toISOString());
  const isStale = input.stale === true;
  const staleReason = toText(input.staleReason, null);
  const observationAgeMs = Number.isFinite(Number(input.observationAgeMs))
    ? Number(input.observationAgeMs)
    : null;
  const observedAtMs = new Date(toText(input.observedAt, new Date(nowMs).toISOString())).getTime();
  const sampleTimeMs = Number.isFinite(observedAtMs) ? observedAtMs : nowMs;
  const dumpWindowMinutes = Math.max(1, toNumber(config.dumpWindowMinutes, 15));
  const dumpThresholdPct = Math.min(0, toNumber(config.dumpThresholdPct, -0.01));
  const breakBelowLevels = Array.isArray(config.breakBelowLevels) ? config.breakBelowLevels : [];
  const windowMs = dumpWindowMinutes * 60 * 1000;
  const retainSinceMs = nowMs - Math.max(windowMs * 4, 60 * 60 * 1000);
  const samples = Array.isArray(previousState.samples) ? previousState.samples : [];
  const normalizedSamples = samples
    .map((sample) => ({
      price: toNumber(sample.price, 0),
      observedAtMs: new Date(toText(sample.observedAt, '')).getTime(),
    }))
    .filter((sample) => sample.price > 0 && Number.isFinite(sample.observedAtMs) && sample.observedAtMs >= retainSinceMs);

  const nextSamples = [
    ...normalizedSamples,
    ...(currentPrice > 0 ? [{ price: currentPrice, observedAtMs: sampleTimeMs }] : []),
  ];
  const dedupedSamples = [];
  for (const sample of nextSamples) {
    const prior = dedupedSamples[dedupedSamples.length - 1];
    if (prior && prior.observedAtMs === sample.observedAtMs) {
      dedupedSamples[dedupedSamples.length - 1] = sample;
    } else {
      dedupedSamples.push(sample);
    }
  }

  const nextState = {
    ...previousState,
    lastCheckedAt: new Date(nowMs).toISOString(),
    lastFetchedAt: fetchedAt,
    lastObservedAt: currentPrice > 0 ? new Date(sampleTimeMs).toISOString() : toText(previousState.lastObservedAt, null),
    lastPrice: currentPrice > 0 ? currentPrice : toNumber(previousState.lastPrice, null),
    lastSource: toText(input.source, toText(previousState.lastSource, '')),
    stale: isStale,
    staleReason,
    observationAgeMs,
    samples: dedupedSamples.map((sample) => ({
      price: round(sample.price, 4),
      observedAt: new Date(sample.observedAtMs).toISOString(),
    })),
    levelStates: { ...(previousState.levelStates || {}) },
    lastAlertAtByKey: { ...(previousState.lastAlertAtByKey || {}) },
  };

  if (!(currentPrice > 0)) {
    return {
      nextState,
      triggers: [],
      metrics: {
        currentPrice: null,
        change15mPct: null,
        referencePrice: null,
      },
    };
  }

  if (isStale) {
    return {
      nextState,
      triggers: [],
      metrics: {
        currentPrice,
        change15mPct: null,
        referencePrice: null,
      },
    };
  }

  const referenceCutoffMs = sampleTimeMs - windowMs;
  const referenceSample = dedupedSamples.find((sample) => sample.observedAtMs >= retainSinceMs && sample.observedAtMs <= referenceCutoffMs) || null;
  const change15mPct = referenceSample && referenceSample.price > 0
    ? ((currentPrice - referenceSample.price) / referenceSample.price)
    : null;
  const triggers = [];

  const queueTrigger = (trigger) => {
    if (!trigger || !trigger.id) return;
    if (shouldSuppressAlert(nextState, trigger.id, nowMs, trigger.cooldownMs || POSITION_ALERT_COOLDOWN_MS)) {
      return;
    }
    triggers.push(trigger);
  };

  if (change15mPct != null && change15mPct <= dumpThresholdPct) {
    queueTrigger({
      id: 'oil_drop_15m',
      label: 'oil_drop_15m',
      action: toText(config.action, 'oil macro breaking down; re-check BTC long immediately'),
      detail: `WTI ${formatPct(change15mPct)} over ${dumpWindowMinutes}m (${round(referenceSample.price, 4)} -> ${round(currentPrice, 4)})`,
      cooldownMs: windowMs,
    });
  }

  const previousPrice = toNumber(previousState.lastPrice, 0);
  for (const level of breakBelowLevels) {
    const priceLevel = toNumber(level, 0);
    if (!(priceLevel > 0 && previousPrice > 0 && currentPrice > 0)) continue;
    const levelId = `oil_break_below_${String(priceLevel).replace('.', '_')}`;
    const priorSide = toText(previousState.levelStates?.[levelId], previousPrice > priceLevel ? 'above' : 'below');
    const currentSide = currentPrice > priceLevel ? 'above' : 'below';
    nextState.levelStates[levelId] = currentSide;
    if (priorSide === 'above' && currentSide === 'below') {
      queueTrigger({
        id: levelId,
        label: levelId,
        action: toText(config.action, 'oil macro breaking down; re-check BTC long immediately'),
        detail: `WTI broke below ${round(priceLevel, 4)} (now ${round(currentPrice, 4)})`,
        cooldownMs: windowMs,
      });
    }
  }

  for (const trigger of triggers) {
    Object.assign(nextState, markAlert(nextState, trigger.id, nowMs));
  }

  return {
    nextState,
    triggers,
    metrics: {
      currentPrice,
      change15mPct,
      referencePrice: referenceSample ? referenceSample.price : null,
    },
  };
}

function buildOilMacroAlert(evaluation = {}, indicator = {}, config = {}) {
  const triggerText = (evaluation.triggers || [])
    .map((trigger) => `${trigger.label}: ${trigger.detail}; action=${trigger.action}`)
    .join(' | ');
  return [
    '(ARCH WATCH): WTI macro check',
    `oil=${round(evaluation.metrics?.currentPrice, 4)}`,
    `change_15m=${evaluation.metrics?.change15mPct == null ? 'n/a' : formatPct(evaluation.metrics.change15mPct)}`,
    `source=${toText(indicator.source, 'unknown')}`,
    `fetched_at=${toText(indicator.fetchedAt, 'n/a')}`,
    `observed_at=${toText(indicator.observedAt, 'n/a')}`,
    `stale=${indicator?.stale === true ? 'yes' : 'no'}`,
    triggerText,
  ].join(' | ');
}

function appendSuggestionProposals(proposals = [], config = {}) {
  const tracking = config.suggestionTracking || {};
  if (tracking.enabled === false) {
    return { ok: true, count: 0, path: tracking.logPath || suggestionTracker.DEFAULT_SUGGESTION_LOG_PATH };
  }
  try {
    return suggestionTracker.appendSuggestionProposalRecords(proposals, {
      suggestionLogPath: tracking.logPath || suggestionTracker.DEFAULT_SUGGESTION_LOG_PATH,
    });
  } catch (error) {
    console.error(`[ARCH WATCH] suggestion proposal logging failed: ${formatErrorForLog(error)}`);
    return { ok: false, count: 0, path: tracking.logPath || suggestionTracker.DEFAULT_SUGGESTION_LOG_PATH };
  }
}

async function settleSuggestionTracking(config = {}, state = {}, nowMs = Date.now()) {
  const tracking = config.suggestionTracking || {};
  if (tracking.enabled === false) {
    return {
      result: { ok: true, settledCount: 0, path: tracking.logPath || suggestionTracker.DEFAULT_SUGGESTION_LOG_PATH },
      nextState: state,
    };
  }
  const lastSettlementAtMs = new Date(state.suggestionTracking?.lastSettlementAt || 0).getTime();
  const settlementIntervalMs = Math.max(60_000, toNumber(tracking.settlementIntervalMs, 5 * 60 * 1000));
  if (Number.isFinite(lastSettlementAtMs) && (nowMs - lastSettlementAtMs) < settlementIntervalMs) {
    return {
      result: { ok: true, settledCount: 0, path: tracking.logPath || suggestionTracker.DEFAULT_SUGGESTION_LOG_PATH },
      nextState: state,
    };
  }
  let result;
  try {
    result = await suggestionTracker.settleSuggestionOutcomes({
      suggestionLogPath: tracking.logPath || suggestionTracker.DEFAULT_SUGGESTION_LOG_PATH,
      horizonsMinutes: tracking.horizonsMinutes || suggestionTracker.DEFAULT_HORIZONS_MINUTES,
      now: new Date(nowMs).toISOString(),
    });
  } catch (error) {
    console.error(`[ARCH WATCH] suggestion outcome settlement failed: ${formatErrorForLog(error)}`);
    result = { ok: false, settledCount: 0, path: tracking.logPath || suggestionTracker.DEFAULT_SUGGESTION_LOG_PATH };
  }
  return {
    result,
    nextState: {
      ...state,
      suggestionTracking: {
        ...(state.suggestionTracking || {}),
        lastSettlementAt: new Date(nowMs).toISOString(),
        lastSettlementCount: toNumber(result?.settledCount, 0),
        lastSettlementPath: result?.path || tracking.logPath || suggestionTracker.DEFAULT_SUGGESTION_LOG_PATH,
      },
    },
  };
}

function detectFreedMarginEvent(config = {}, state = {}, context = {}, nowMs = Date.now()) {
  const handoff = config.autonomousHandoff || {};
  if (handoff.enabled === false) {
    return { nextAutonomy: state.autonomy || defaultState().autonomy, event: null };
  }

  const watchTicker = normalizeTicker(handoff.watchTicker || 'ORDI/USD');
  const tracked = { ...((state.autonomy || {}).tracked || {}) };
  const previousTracked = tracked[watchTicker] || {};
  const currentPosition = context?.positionsByTicker?.get(watchTicker) || null;
  const currentCashUsd = toNumber(context?.account?.cash, 0);
  const currentMarginUsedUsd = toNumber(context?.account?.raw?.marginSummary?.totalMarginUsed, 0);

  const nextTracked = {
    ticker: watchTicker,
    lastSeenAt: new Date(nowMs).toISOString(),
    wasOpen: Boolean(currentPosition),
    lastKnownSize: currentPosition ? toNumber(currentPosition.absSize, 0) : 0,
    lastKnownMarginUsedUsd: currentPosition ? toNumber(currentPosition.marginUsed, 0) : 0,
    lastKnownCashUsd: currentCashUsd,
    lastKnownTotalMarginUsedUsd: currentMarginUsedUsd,
  };
  tracked[watchTicker] = nextTracked;

  const previousWasOpen = previousTracked.wasOpen === true && toNumber(previousTracked.lastKnownSize, 0) > 0;
  const justClosed = previousWasOpen && !currentPosition;
  if (!justClosed) {
    return {
      nextAutonomy: {
        ...((state.autonomy || {}) || {}),
        tracked,
      },
      event: null,
    };
  }

  const previousMarginUsedUsd = toNumber(previousTracked.lastKnownMarginUsedUsd, 0);
  const previousCashUsd = toNumber(previousTracked.lastKnownCashUsd, 0);
  const previousTotalMarginUsedUsd = toNumber(previousTracked.lastKnownTotalMarginUsedUsd, 0);
  const freedMarginUsd = round(Math.max(
    previousMarginUsedUsd,
    currentCashUsd - previousCashUsd,
    previousTotalMarginUsedUsd - currentMarginUsedUsd,
    0
  ), 2);

  const event = {
    type: 'freed_margin',
    ticker: watchTicker,
    firedAt: new Date(nowMs).toISOString(),
    previousSize: round(toNumber(previousTracked.lastKnownSize, 0), 4),
    previousMarginUsedUsd: round(previousMarginUsedUsd, 2),
    previousCashUsd: round(previousCashUsd, 2),
    currentCashUsd: round(currentCashUsd, 2),
    currentTotalMarginUsedUsd: round(currentMarginUsedUsd, 2),
    freedMarginUsd,
    maxEventAgeMinutes: Math.max(1, toNumber(handoff.maxEventAgeMinutes, 15)),
  };

  return {
    nextAutonomy: {
      ...((state.autonomy || {}) || {}),
      tracked,
      lastFreedMarginEventAt: event.firedAt,
      lastFreedMarginEvent: event,
    },
    event,
  };
}

async function runPositionLane(config, state, runtime, nowMs, context = null) {
  let activeContext = context;
  if (!activeContext) {
    try {
      activeContext = await fetchPositionContext(runtime, config);
    } catch (fetchErr) {
      if (String(fetchErr?.message || '').includes('429')) {
        return { nextState: state, alerts: [], routedAlerts: [], positionSummaries: [], context: null };
      }
      throw fetchErr;
    }
  }
  const alerts = [];
  const routedAlerts = [];
  const nextPositions = { ...(state.positions || {}) };
  const watchedPositions = getWatchedPositions(config);

  for (const watchedPosition of watchedPositions) {
    const ticker = normalizeTicker(watchedPosition.ticker);
    const livePosition = activeContext.positionsByTicker.get(ticker) || null;
    const marketEntry = activeContext.universeByTicker.get(ticker) || null;
    const openOrders = activeContext.openOrders.filter((order) => normalizeTicker(`${order.coin}/USD`) === ticker);
    const protection = livePosition
      ? bracketManager.deriveExchangeProtection(livePosition, openOrders)
      : { activeStopPrice: null, activeTakeProfitPrice: null, verified: false };
    const effectiveWatchedPosition = livePosition
      ? {
        ...watchedPosition,
        stopPrice: protection.activeStopPrice,
        takeProfit1Price: protection.activeTakeProfitPrice,
      }
      : watchedPosition;
    const currentPrice = toNumber(marketEntry?.markPx ?? marketEntry?.midPx ?? marketEntry?.price, 0);
    const previousState = nextPositions[ticker] || {};
    const evaluation = evaluatePositionTriggers({
      nowMs,
      configPosition: effectiveWatchedPosition,
      livePosition,
      previousState,
      currentPrice,
      openOrders,
    });
    nextPositions[ticker] = {
      ...evaluation.nextState,
      lastCheckedAt: new Date(nowMs).toISOString(),
      wasOpen: Boolean(livePosition),
      stopPrice: protection.activeStopPrice,
      takeProfit1Price: protection.activeTakeProfitPrice,
      protectionVerifiedAt: protection.verified ? new Date(nowMs).toISOString() : null,
    };
    const previousWasOpen = previousState.wasOpen === true;
    const watchWhenFlat = watchedPosition.watchWhenFlat === true;
    if (!livePosition) {
      if (getAlertProfile(watchedPosition) === 'streamlined_user' && previousWasOpen) {
        alerts.push(buildPositionClosedAlert(watchedPosition, previousState));
      }
      if (watchWhenFlat && evaluation.triggers.length > 0) {
        alerts.push(buildFlatLevelAlert(watchedPosition, evaluation));
        for (const trigger of evaluation.triggers) {
          const targets = normalizeTargets(trigger.routeTargets || []);
          if (targets.length > 0) {
            routedAlerts.push({
              message: toText(trigger.routeMessage, buildFlatLevelAlert(watchedPosition, { triggers: [trigger], metrics: evaluation.metrics })),
              targets,
            });
          }
        }
      }
      continue;
    }
    if (evaluation.triggers.length === 0) {
      continue;
    }
    alerts.push(buildPositionAlert(effectiveWatchedPosition, livePosition, evaluation));
    for (const trigger of evaluation.triggers) {
      const targets = normalizeTargets(trigger.routeTargets || []);
      if (targets.length > 0) {
        routedAlerts.push({
          message: toText(trigger.routeMessage, buildPositionAlert(effectiveWatchedPosition, livePosition, { triggers: [trigger], metrics: evaluation.metrics })),
          targets,
        });
      }
    }
  }

  const positionSummaries = Array.from(activeContext.positionsByTicker.values()).map((position) => {
    const watchedPosition = watchedPositions.find((entry) => normalizeTicker(entry.ticker) === position.ticker);
    if (!watchedPosition) return null;
    const marketEntry = activeContext.universeByTicker.get(position.ticker) || null;
    const currentPrice = toNumber(marketEntry?.markPx ?? marketEntry?.midPx ?? marketEntry?.price, 0);
    const openOrders = activeContext.openOrders.filter((order) => normalizeTicker(`${order.coin}/USD`) === position.ticker);
    const protection = bracketManager.deriveExchangeProtection(position, openOrders);
    const tp1Price = toNumber(protection.activeTakeProfitPrice, 0);
    const distanceToTp1 = pctDistance(currentPrice, tp1Price);
    return `${position.coin} pnl ${formatUsd(position.unrealizedPnl)}, TP1 ${distanceToTp1 == null ? 'n/a' : formatPct(distanceToTp1)} away`;
  }).filter(Boolean);

  return {
    alerts,
    nextState: {
      ...state,
      updatedAt: new Date(nowMs).toISOString(),
      positions: nextPositions,
      cadence: {
        ...(state.cadence || {}),
        lastPositionCheckAt: new Date(nowMs).toISOString(),
      },
    },
    context: activeContext,
    positionSummaries,
    routedAlerts,
  };
}

async function runMacroLane(config, state, nowMs) {
  const macroWatch = config.macroWatch || {};
  const oilConfig = macroWatch.oil || {};
  if (macroWatch.enabled === false || oilConfig.enabled === false) {
    return {
      alerts: [],
      nextState: {
        ...state,
        cadence: {
          ...(state.cadence || {}),
          lastMacroCheckAt: new Date(nowMs).toISOString(),
        },
      },
    };
  }

  const indicator = await macroRiskGate._internals.fetchOilPrice({
    now: new Date(nowMs),
    skipCache: true,
  }).catch(() => null);
  const previousOilState = state.macro?.oil || defaultState().macro.oil;
  const evaluation = evaluateOilMacroTriggers({
    nowMs,
    config: oilConfig,
    previousState: previousOilState,
    currentPrice: toNumber(indicator?.value, 0),
    observedAt: indicator?.observedAt,
    fetchedAt: indicator?.fetchedAt,
    source: indicator?.source,
    stale: indicator?.stale === true,
    staleReason: indicator?.staleReason,
    observationAgeMs: indicator?.observationAgeMs,
  });

  const nextState = {
    ...state,
    updatedAt: new Date(nowMs).toISOString(),
    cadence: {
      ...(state.cadence || {}),
      lastMacroCheckAt: new Date(nowMs).toISOString(),
    },
    macro: {
      ...(state.macro || {}),
      oil: evaluation.nextState,
    },
  };

  return {
    alerts: evaluation.triggers.length > 0 ? [buildOilMacroAlert(evaluation, indicator, oilConfig)] : [],
    nextState,
  };
}

async function runScalpLane(config, state, nowMs, context = null, riskState = {}) {
  const discovery = config.scalpDiscovery || {};
  if (discovery.enabled === false) {
    return { alerts: [], nextState: state };
  }
  const watchedSymbols = Array.from(new Set(
    (Array.isArray(discovery.symbols) ? discovery.symbols : ['BTC/USD', 'ETH/USD', 'SOL/USD'])
      .map((ticker) => normalizeTicker(ticker))
      .filter(Boolean)
  ));
  if (watchedSymbols.length === 0) {
    return { alerts: [], nextState: state };
  }

  const [barsByTicker, predictedFundings] = await Promise.all([
    hyperliquidClient.getHistoricalBars({
      symbols: watchedSymbols,
      timeframe: '5m',
      limit: 12,
      disableRequestPool: true,
      requestPoolTtlMs: 0,
    }),
    hyperliquidClient.getPredictedFundings({}),
  ]);

  const scored = watchedSymbols
    .filter((ticker) => !(context?.positionsByTicker?.has(ticker)))
    .map((ticker) => {
      const marketEntry = context?.universeByTicker?.get(ticker) || null;
      const coin = toText(marketEntry?.coin || ticker.split('/')[0]).toUpperCase();
      return scoreScalpCandidate({
        ticker,
        price: toNumber(marketEntry?.markPx ?? marketEntry?.midPx ?? marketEntry?.price, 0),
        fundingBps: toNumber(
          predictedFundings?.byCoin?.[coin]?.fundingRate,
          toNumber(marketEntry?.fundingRate, 0)
        ) * 10_000,
        bars5m: barsByTicker instanceof Map ? (barsByTicker.get(ticker) || []) : [],
      }, {
        discovery,
      });
    })
    .filter(Boolean)
    .sort((left, right) => toNumber(right.score, 0) - toNumber(left.score, 0));

  const scoreThreshold = Math.max(1, toNumber(discovery.scoreThreshold, 65));
  const top = filterCandidatesForRiskMode(
    scored.filter((candidate) => candidate.score >= scoreThreshold),
    riskState
  ).slice(0, 3);
  const nextState = {
    ...state,
    updatedAt: new Date(nowMs).toISOString(),
    cadence: {
      ...(state.cadence || {}),
      lastScalpScanAt: new Date(nowMs).toISOString(),
    },
    scalp: {
      ...(state.scalp || {}),
      lastScanAt: new Date(nowMs).toISOString(),
      lastCandidates: top,
      lastSummary: top.length > 0 ? summarizeScalpCandidate(top[0]) : null,
      lastAlertHashesByTicker: {
        ...((state.scalp || {}).lastAlertHashesByTicker || {}),
      },
      lastAlertAtByTicker: {
        ...((state.scalp || {}).lastAlertAtByTicker || {}),
      },
    },
  };

  const fresh = top.filter((candidate) => {
    const ticker = candidate.ticker;
    const hash = hashScalpCandidate(candidate);
    const lastHash = toText(state.scalp?.lastAlertHashesByTicker?.[ticker], '');
    const lastAlertAt = Number(state.scalp?.lastAlertAtByTicker?.[ticker] || 0);
    const cooledDown = !Number.isFinite(lastAlertAt) || (nowMs - lastAlertAt) >= SCALP_ALERT_COOLDOWN_MS;
    if (hash === lastHash && !cooledDown) {
      return false;
    }
    nextState.scalp.lastAlertHashesByTicker[ticker] = hash;
    nextState.scalp.lastAlertAtByTicker[ticker] = nowMs;
    return true;
  });

  if (fresh.length > 0) {
    appendSuggestionProposals(fresh.map((candidate) => ({
      observedAt: new Date(nowMs).toISOString(),
      ticker: candidate.ticker,
      direction: candidate.direction,
      setupType: 'scalp',
      sourceLane: 'scalp',
      referencePrice: candidate.price,
      stopPrice: candidate.stopPrice,
      takeProfitPrice: candidate.takeProfitPrice,
      score: candidate.score,
      marginRecommendedUsd: candidate.suggestedMarginUsd,
      confidence: candidate.score / 100,
      metadata: {
        fundingBps: candidate.fundingBps,
        stopPct: candidate.stopPct,
        takeProfitPct: candidate.takeProfitPct,
        consecutiveCandles: candidate.consecutiveCandles,
        netMovePct: candidate.netMovePct,
        efficiency: candidate.efficiency,
      },
    })), config);
  }

  return {
    alerts: fresh.length > 0 ? [buildScalpAlert(fresh, riskState)] : [],
    nextState,
  };
}

async function runSetupLane(config, state, nowMs, riskState = {}) {
  const discovery = config.setupDiscovery || {};
  const minVolumeUsd24h = Math.max(0, toNumber(discovery.minVolumeUsd24h, 3_000_000));
  const excludeTickers = new Set(
    (Array.isArray(discovery.excludeTickers) ? discovery.excludeTickers : [])
      .map((ticker) => normalizeTicker(ticker))
  );
  const [universe, predictedFundings] = await Promise.all([
    hyperliquidClient.getUniverseMarketData({}),
    hyperliquidClient.getPredictedFundings({}),
  ]);

  const rows = (Array.isArray(universe) ? universe : [])
    .map((entry) => {
      const ticker = normalizeTicker(entry.ticker || `${entry.coin}/USD`);
      const price = toNumber(entry.markPx ?? entry.midPx ?? entry.price, 0);
      const prevDayPx = toNumber(entry.prevDayPx, 0);
      const dayMovePct = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) : null;
      const fundingBps = toNumber(
        (predictedFundings?.byCoin?.[toText(entry.coin).toUpperCase()] || {}).fundingRate,
        toNumber(entry.fundingRate, 0)
      ) * 10_000;
      return {
        ticker,
        price,
        dayMovePct,
        fundingBps,
        volumeUsd24h: toNumber(entry.volumeUsd24h, 0),
      };
    })
    .filter((row) => row.price > 0 && row.volumeUsd24h >= minVolumeUsd24h && !excludeTickers.has(row.ticker));
  const rowsByTicker = new Map(rows.map((row) => [row.ticker, row]));

  const candidatesToFetch = rows.map((row) => row.ticker);
  const barsByTicker = await hyperliquidClient.getHistoricalBars({
    symbols: candidatesToFetch,
    timeframe: '5m',
    limit: 10,
    disableRequestPool: true,
    requestPoolTtlMs: 0,
  });

  const scored = candidatesToFetch
    .map((ticker) => {
      const row = rowsByTicker.get(ticker);
      if (!row) return null;
      return scoreSetupCandidate({
        ticker: row.ticker,
        price: row.price,
        dayMovePct: row.dayMovePct,
        fundingBps: row.fundingBps,
        closes5m: (barsByTicker.get(ticker) || []).map((bar) => Number(bar.close)),
        discovery,
      });
    })
    .filter(Boolean)
    .sort((left, right) => toNumber(right.score, 0) - toNumber(left.score, 0));

  const prequalified = scored
    .filter((candidate) => candidate.tier !== 'watch')
    .filter((candidate) => candidate.projectedGrossUsd >= Math.max(0, toNumber(discovery.minProjectedGrossUsd, 0)))
    .filter((candidate) => candidate.score >= Math.max(1, Number(discovery.scoreThreshold) || 55))
    .slice(0, Math.max(6, toNumber(discovery.maxPerTier, 8) * 3));

  const books = await Promise.all(prequalified.map(async (candidate) => {
    try {
      const book = await hyperliquidClient.getL2Book({
        ticker: candidate.ticker,
        disableRequestPool: true,
        requestPoolTtlMs: 0,
      });
      return [candidate.ticker, book];
    } catch {
      return [candidate.ticker, null];
    }
  }));
  const booksByTicker = new Map(books);

  const highScore = filterCandidatesForRiskMode(prequalified
    .filter((candidate) => passesSetupExecutionFilter(candidate, booksByTicker.get(candidate.ticker), discovery))
  , riskState).slice(0, 6);
  const candidateBoard = persistCandidateBoard(buildCandidateBoard({
    setupCandidates: highScore,
    scalpCandidates: state.scalp?.lastCandidates || [],
    universeScanned: rows.length,
  }, config, nowMs), config);
  const nextState = {
    ...state,
    updatedAt: new Date(nowMs).toISOString(),
    cadence: {
      ...(state.cadence || {}),
      lastSetupScanAt: new Date(nowMs).toISOString(),
    },
    setup: {
      ...(state.setup || {}),
      lastScanAt: new Date(nowMs).toISOString(),
      lastCandidates: highScore,
      lastSummary: highScore.length > 0
        ? `${highScore[0].ticker} ${highScore[0].direction} score ${highScore[0].score} tier ${highScore[0].tier}`
        : null,
      universeScanned: rows.length,
    },
    candidateBoard: {
      ...(state.candidateBoard || {}),
      lastBuiltAt: candidateBoard.updatedAt,
      path: candidateBoard.path,
      universeScanned: candidateBoard.universeScanned,
      tiers: candidateBoard.tiers,
    },
  };

  if (highScore.length === 0) {
    nextState.setup.lastAlertHash = null;
    return { alerts: [], nextState };
  }

  const alertHash = hashSetupCandidates(highScore);
  const suppress = toText(state.setup?.lastAlertHash) === alertHash
    && Number.isFinite(Number(state.setup?.lastAlertAtMs || 0))
    && (nowMs - Number(state.setup.lastAlertAtMs || 0)) < SETUP_ALERT_COOLDOWN_MS;
  if (suppress) {
    return { alerts: [], nextState };
  }

  nextState.setup.lastAlertHash = alertHash;
  nextState.setup.lastAlertAtMs = nowMs;
  appendSuggestionProposals(highScore.map((candidate) => ({
    observedAt: new Date(nowMs).toISOString(),
    ticker: candidate.ticker,
    direction: candidate.direction,
    setupType: 'contrarian',
    sourceLane: 'setup',
    referencePrice: candidate.price,
    stopPrice: candidate.stopPrice,
    takeProfitPrice: candidate.takeProfitPrice,
    score: candidate.score,
    marginRecommendedUsd: candidate.suggestedMarginUsd,
    confidence: candidate.score / 100,
    metadata: {
      fundingBps: candidate.fundingBps,
      dayMovePct: candidate.dayMovePct,
      firstReturn: candidate.firstReturn,
      secondReturn: candidate.secondReturn,
      recentReturn: candidate.recentReturn,
    },
  })), config);
  return {
    alerts: [buildSetupAlert(highScore, riskState)],
    nextState,
  };
}

async function runPaceLane(config, state, runtime, nowMs, positionSummaries = [], context = null, riskState = {}) {
  let activeContext = context;
  if (!activeContext) {
    try {
      activeContext = await fetchPositionContext(runtime, config);
    } catch (fetchErr) {
      if (String(fetchErr?.message || '').includes('429')) {
        return { nextState: state, alerts: [], routedAlerts: [] };
      }
      throw fetchErr;
    }
  }
  const [account, realized] = await Promise.all([
    Promise.resolve(activeContext.account || null).then((value) => value || hyperliquidClient.getAccountSnapshot({
      walletAddress: runtime.walletAddress,
    })),
    computeTrackedRealizedPnl(runtime, config),
  ]);
  const sessionStartMs = resolvePaceWindowStartMs(config, nowMs);
  const elapsedHours = Math.max(0, (nowMs - sessionStartMs) / (60 * 60 * 1000));
  const quotaUsd = elapsedHours * toNumber(config.quotaPerHourUsd, 8.33);
  const realizedPnlUsd = toNumber(realized.realizedPnlUsd, 0);
  const walletSummary = summarizeWalletPositions(activeContext, config);
  const nextState = {
    ...state,
    updatedAt: new Date(nowMs).toISOString(),
    cadence: {
      ...(state.cadence || {}),
      lastPaceCheckAt: new Date(nowMs).toISOString(),
    },
    pace: {
      ...(state.pace || {}),
      lastRealizedPnlUsd: realizedPnlUsd,
      lastQuotaUsd: round(quotaUsd, 2),
    },
  };

  if (realizedPnlUsd >= quotaUsd) {
    return { alerts: [], nextState };
  }

  const lastAlertAt = Number(state.pace?.lastAlertAt || 0);
  if (Number.isFinite(lastAlertAt) && (nowMs - lastAlertAt) < PACE_ALERT_COOLDOWN_MS) {
    return { alerts: [], nextState };
  }
  nextState.pace.lastAlertAt = nowMs;
  const actionPrompt = buildActionPrompt(
    positionSummaries.length > 0 ? positionSummaries : walletSummary.actionPromptSummaries,
    state.setup?.lastSummary || state.scalp?.lastSummary
  );
  return {
    alerts: [buildPaceAlert({
      accountValue: toNumber(account?.equity, 0),
      riskMode: riskState.mode,
      riskTriggerCause: riskState.triggerCause,
      dailyLossCapUsd: riskState.dailyLossCapUsd,
      dailyRealizedUsd: riskState.dailyRealizedPnlUsd,
      remainingLossBudgetUsd: riskState.remainingLossBudgetUsd,
      remainingPerTradeMarginCapUsd: riskState.remainingPerTradeMarginCapUsd,
      realizedPnlUsd,
      quotaUsd,
      openPositionsTotalCount: walletSummary.totalCount,
      openPositionsTotalUnrealizedPnlUsd: walletSummary.totalUnrealizedPnlUsd,
      agentOpenPositionsCount: walletSummary.agentCount,
      agentOpenPositionsUnrealizedPnlUsd: walletSummary.agentUnrealizedPnlUsd,
      agentOpenPositionsDetail: walletSummary.agentDetail,
      userOpenPositionsCount: walletSummary.userCount,
      userOpenPositionsUnrealizedPnlUsd: walletSummary.userUnrealizedPnlUsd,
      userOpenPositionsDetail: walletSummary.userDetail,
      actionPrompt,
    })],
    nextState,
  };
}

async function runCycle(options = {}) {
  const nowMs = Date.now();
  const configPath = path.resolve(toText(options.configPath, DEFAULT_CONFIG_PATH));
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const config = loadConfig(configPath);
  let state = loadState(statePath);
  const runtime = await fetchRuntime();
  const alerts = [];
  const routedAlerts = [];
  let positionSummaries = [];
  let sharedPositionContext = null;
  let activeRiskState = state.risk || hardRiskGuard.defaultRiskState();

  if (config.enabled !== false) {
    const positionDue = nowMs - new Date(state.cadence?.lastPositionCheckAt || 0).getTime() >= resolvePositionCadenceMs(config, state);
    const macroDue = nowMs - new Date(state.cadence?.lastMacroCheckAt || 0).getTime() >= toNumber(config.cadences?.macroCheckMs, DEFAULT_MACRO_CHECK_INTERVAL_MS);
    const scalpDue = nowMs - new Date(state.cadence?.lastScalpScanAt || 0).getTime() >= toNumber(config.cadences?.scalpScanMs, DEFAULT_SCALP_SCAN_INTERVAL_MS);
    const setupDue = nowMs - new Date(state.cadence?.lastSetupScanAt || 0).getTime() >= toNumber(config.cadences?.setupScanMs, DEFAULT_SETUP_SCAN_INTERVAL_MS);
    const paceDue = nowMs - new Date(state.cadence?.lastPaceCheckAt || 0).getTime() >= toNumber(config.cadences?.paceCheckMs, DEFAULT_PACE_CHECK_INTERVAL_MS);

    if (positionDue || scalpDue) {
      try {
        sharedPositionContext = await fetchPositionContext(runtime, config);
      } catch (fetchErr) {
        if (String(fetchErr?.message || '').includes('429')) {
          sharedPositionContext = null;
        } else {
          throw fetchErr;
        }
      }
    }

    if (positionDue) {
      const positionResult = await runPositionLane(config, state, runtime, nowMs, sharedPositionContext);
      state = positionResult.nextState;
      alerts.push(...positionResult.alerts);
      routedAlerts.push(...(positionResult.routedAlerts || []));
      positionSummaries = positionResult.positionSummaries;
      sharedPositionContext = positionResult.context;

      const autonomyResult = detectFreedMarginEvent(config, state, sharedPositionContext, nowMs);
      state = {
        ...state,
        autonomy: autonomyResult.nextAutonomy,
      };
      if (autonomyResult.event) {
        routedAlerts.push({
          message: buildFreedMarginAlert(autonomyResult.event),
          targets: normalizeTargets(config.autonomousHandoff?.eventTargets || ['builder', 'oracle']),
        });
      }
    }

    if (macroDue) {
      const macroResult = await runMacroLane(config, state, nowMs);
      state = macroResult.nextState;
      alerts.push(...macroResult.alerts);
    }

    if (!sharedPositionContext) {
      try {
        sharedPositionContext = await fetchPositionContext(runtime, config);
      } catch (fetchErr) {
        const isRateLimit = String(fetchErr?.message || '').includes('429');
        if (isRateLimit) {
          sharedPositionContext = null;
        } else {
          throw fetchErr;
        }
      }
    }
    if (!sharedPositionContext) {
      state.heartbeat = state.heartbeat || {};
      state.heartbeat.lastSkipReason = 'rate_limit_429';
      writeJson(statePath, state);
      return { ok: true, state, alerts: [], routedAlerts: [] };
    }
    const riskResult = await runRiskLane(config, state, nowMs, sharedPositionContext, runtime);
    state = riskResult.nextState;
    activeRiskState = state.risk || activeRiskState;
    alerts.push(...riskResult.alerts);

    if (scalpDue) {
      const scalpResult = await runScalpLane(config, state, nowMs, sharedPositionContext, activeRiskState);
      state = scalpResult.nextState;
      alerts.push(...scalpResult.alerts);
    }

    if (setupDue) {
      const setupResult = await runSetupLane(config, state, nowMs, activeRiskState);
      state = setupResult.nextState;
      alerts.push(...setupResult.alerts);
    }

    if (paceDue) {
      if (!sharedPositionContext) {
        sharedPositionContext = await fetchPositionContext(runtime, config);
      }
      const paceResult = await runPaceLane(config, state, runtime, nowMs, positionSummaries, sharedPositionContext, activeRiskState);
      state = paceResult.nextState;
      alerts.push(...paceResult.alerts);
    }

    const powwowResult = await runPowwowLane(config, state, nowMs, sharedPositionContext);
    state = powwowResult.nextState;
    alerts.push(...powwowResult.alerts);
    routedAlerts.push(...(powwowResult.routedAlerts || []));
  }

  const suggestionSettlement = await settleSuggestionTracking(config, state, nowMs);
  state = suggestionSettlement.nextState;

  state.updatedAt = new Date(nowMs).toISOString();
  const lastTickAt = new Date(nowMs).toISOString();
  state.heartbeat = {
    lastTickAt,
    lastObservedAt: lastTickAt,
    intervalMs: toNumber(config.loopIntervalMs, DEFAULT_LOOP_INTERVAL_MS),
    staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
    expiresAt: new Date(nowMs + HEARTBEAT_STALE_AFTER_MS).toISOString(),
    pid: process.pid,
    state: 'green',
    staleReason: null,
    stale: computeHeartbeatStale(lastTickAt, nowMs),
  };
  writeJson(statePath, state);

  if (alerts.length > 0 && options.sendAlerts !== false) {
    sendAgentAlert(alerts.join('\n'), {
      targets: normalizeTargets(options.targets || config.targets || ['architect']),
      role: 'architect-watch',
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      env: process.env,
    });
  }

  if (routedAlerts.length > 0 && options.sendAlerts !== false) {
    for (const alert of routedAlerts) {
      sendAgentAlert(alert.message, {
        targets: alert.targets,
        role: 'architect-watch',
        cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
        env: process.env,
      });
    }
  }

  return {
    ok: true,
    configPath,
    statePath,
    alertCount: alerts.length + routedAlerts.length,
    alerts,
    routedAlerts,
  };
}

async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const command = parsed.positional[0] || 'run';
  const configPath = toText(getOption(parsed.options, 'config', DEFAULT_CONFIG_PATH), DEFAULT_CONFIG_PATH);
  const statePath = toText(getOption(parsed.options, 'state', DEFAULT_STATE_PATH), DEFAULT_STATE_PATH);

  if (command === 'init') {
    const config = loadConfig(configPath);
    const state = loadState(statePath);
    writeJson(configPath, config);
    writeJson(statePath, state);
    const result = { ok: true, configPath: path.resolve(configPath), statePath: path.resolve(statePath) };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'run') {
    const once = getOption(parsed.options, 'once', false) === true;
    const loopIntervalMs = Math.max(5_000, Number(getOption(parsed.options, 'loop-ms', DEFAULT_LOOP_INTERVAL_MS)) || DEFAULT_LOOP_INTERVAL_MS);
    const safeRunCycle = async () => {
      try {
        return await runCycle({ configPath, statePath });
      } catch (cycleErr) {
        if (String(cycleErr?.message || '').includes('429')) {
          const skipResult = { ok: false, skipped: true, reason: '429', error: String(cycleErr?.message || cycleErr) };
          try {
            const state = loadState(statePath);
            const lastTickAt = new Date().toISOString();
            state.heartbeat = {
              ...(state.heartbeat || {}),
              lastTickAt,
              lastObservedAt: lastTickAt,
              intervalMs: loopIntervalMs,
              staleAfterMs: HEARTBEAT_STALE_AFTER_MS,
              expiresAt: new Date(Date.now() + HEARTBEAT_STALE_AFTER_MS).toISOString(),
              pid: process.pid,
              state: 'rate_limited',
              staleReason: '429_skip',
              stale: false,
            };
            writeJson(statePath, state);
          } catch {}
          return skipResult;
        }
        throw cycleErr;
      }
    };
    let result = await safeRunCycle();
    console.log(JSON.stringify(result, null, 2));
    if (once) return result;

    while (true) {
      await sleep(loopIntervalMs);
      result = await safeRunCycle();
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
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
  defaultConfig,
  defaultState,
  loadConfig,
  loadState,
  HEARTBEAT_STALE_AFTER_MS,
  computeHeartbeatStale,
  buildPositionAlert,
  buildFlatLevelAlert,
  resolvePositionCadenceMs,
  evaluatePositionTriggers,
  evaluateOilMacroTriggers,
  detectFreedMarginEvent,
  scoreSetupCandidate,
  scoreScalpCandidate,
  buildActionPrompt,
  resolveTrackedAgentAssets,
  computeTrackedRealizedPnl,
  summarizeWalletPositions,
  runPowwowLane,
  runCycle,
  runCli,
};
