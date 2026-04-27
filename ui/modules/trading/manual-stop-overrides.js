'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');

const DEFAULT_MANUAL_STOP_OVERRIDES_PATH = resolveCoordPath(
  path.join('runtime', 'manual-stop-overrides.json'),
  { forWrite: true }
);
const EPSILON = 1e-6;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeTicker(value) {
  const raw = toText(value).toUpperCase().replace('-', '/');
  if (!raw) return '';
  return raw.endsWith('/USD') ? raw : `${raw}/USD`;
}

function toIsoTimestamp(value, fallback = null) {
  const raw = value == null ? fallback : value;
  if (!raw) return fallback;
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function defaultManualStopOverrideState() {
  return {
    version: 1,
    overrides: {},
    updatedAt: null,
  };
}

function normalizeManualStopOverride(record = {}) {
  const ticker = normalizeTicker(record.ticker || record.asset || record.coin);
  return {
    ticker,
    ownerAgentId: toText(record.ownerAgentId || record.owner || record.agentId || '').toLowerCase() || null,
    mode: toText(record.mode || 'manual_stop_override'),
    reason: toText(record.reason || ''),
    stopOrderId: toText(record.stopOrderId || record.orderId || '') || null,
    stopPrice: record.stopPrice == null ? null : toNumber(record.stopPrice, null),
    entryPrice: record.entryPrice == null ? null : toNumber(record.entryPrice, null),
    setAt: toIsoTimestamp(record.setAt, null),
    updatedAt: toIsoTimestamp(record.updatedAt, new Date().toISOString()),
  };
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadManualStopOverrideState(options = {}) {
  const statePath = options.statePath || DEFAULT_MANUAL_STOP_OVERRIDES_PATH;
  const parsed = readJson(statePath, defaultManualStopOverrideState());
  const overrides = {};
  for (const [ticker, record] of Object.entries(parsed?.overrides || {})) {
    const normalized = normalizeManualStopOverride({ ticker, ...record });
    if (normalized.ticker) {
      overrides[normalized.ticker] = normalized;
    }
  }
  return {
    path: statePath,
    version: Number(parsed?.version) || 1,
    overrides,
    updatedAt: toIsoTimestamp(parsed?.updatedAt, null),
  };
}

function writeManualStopOverrideState(state = {}, options = {}) {
  const statePath = options.statePath || DEFAULT_MANUAL_STOP_OVERRIDES_PATH;
  const overrides = {};
  for (const [ticker, record] of Object.entries(state?.overrides || {})) {
    const normalized = normalizeManualStopOverride({ ticker, ...record });
    if (normalized.ticker) {
      overrides[normalized.ticker] = normalized;
    }
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    overrides,
    updatedAt: new Date().toISOString(),
  }, null, 2));
  return statePath;
}

function registerManualStopOverride(record = {}, options = {}) {
  const state = loadManualStopOverrideState(options);
  const normalized = normalizeManualStopOverride({
    ...record,
    setAt: record.setAt || new Date().toISOString(),
  });
  if (!normalized.ticker) return null;
  state.overrides[normalized.ticker] = normalized;
  writeManualStopOverrideState(state, options);
  return normalized;
}

function clearManualStopOverride(tickerOrAsset = '', options = {}) {
  const ticker = normalizeTicker(tickerOrAsset);
  if (!ticker) return false;
  const state = loadManualStopOverrideState(options);
  if (!state.overrides[ticker]) return false;
  delete state.overrides[ticker];
  writeManualStopOverrideState(state, options);
  return true;
}

function resolveBreakEvenReference(position = {}, override = null) {
  const positionEntry = toNumber(position?.entryPx ?? position?.entryPrice, 0);
  if (positionEntry > 0) return positionEntry;
  const overrideEntry = toNumber(override?.entryPrice, 0);
  return overrideEntry > 0 ? overrideEntry : null;
}

function isBreakEvenOrBetter(position = {}, stopPrice, entryPrice) {
  const numericStop = toNumber(stopPrice, 0);
  const numericEntry = toNumber(entryPrice, 0);
  const isLong = position?.isLong === true || toText(position?.side, '').toLowerCase() === 'long' || toNumber(position?.signedSize, 0) > 0;
  if (!(numericStop > 0) || !(numericEntry > 0)) return false;
  return isLong
    ? numericStop >= (numericEntry - EPSILON)
    : numericStop <= (numericEntry + EPSILON);
}

function evaluateManualStopOverrideGuard(override = null, {
  livePosition = null,
  activeStopOrder = null,
  candidateStop = null,
} = {}) {
  const normalizedOverride = override ? normalizeManualStopOverride(override) : null;
  if (!normalizedOverride?.ticker) {
    return {
      blocked: false,
      clearOverride: false,
      reason: 'no_manual_override',
      override: null,
    };
  }

  const absSize = Math.abs(toNumber(livePosition?.absSize ?? livePosition?.signedSize ?? livePosition?.size, 0));
  if (!(absSize > 0)) {
    return {
      blocked: false,
      clearOverride: true,
      reason: 'manual_override_position_closed',
      override: normalizedOverride,
    };
  }

  const activeOrderId = toText(activeStopOrder?.oid, '');
  if (normalizedOverride.stopOrderId && activeOrderId && normalizedOverride.stopOrderId !== activeOrderId) {
    return {
      blocked: false,
      clearOverride: true,
      reason: 'manual_override_replaced',
      override: normalizedOverride,
    };
  }

  const breakEvenReference = resolveBreakEvenReference(livePosition, normalizedOverride);
  if (isBreakEvenOrBetter(livePosition, activeStopOrder?.price, breakEvenReference)) {
    return {
      blocked: false,
      clearOverride: true,
      reason: 'manual_override_already_break_even_or_better',
      override: normalizedOverride,
    };
  }

  if (isBreakEvenOrBetter(livePosition, candidateStop, breakEvenReference)) {
    return {
      blocked: false,
      clearOverride: true,
      reason: 'manual_override_released_break_even_or_better',
      override: normalizedOverride,
    };
  }

  return {
    blocked: true,
    clearOverride: false,
    reason: 'manual_stop_override_guard_active',
    override: normalizedOverride,
  };
}

function maybeBlockTrailingStopTighten({
  asset = '',
  livePosition = null,
  activeStopOrder = null,
  candidateStop = null,
} = {}, options = {}) {
  const ticker = normalizeTicker(asset || livePosition?.coin || livePosition?.ticker);
  if (!ticker) {
    return {
      blocked: false,
      clearOverride: false,
      reason: 'no_manual_override',
      override: null,
    };
  }
  const state = loadManualStopOverrideState(options);
  const override = state.overrides[ticker] || null;
  const evaluation = evaluateManualStopOverrideGuard(override, {
    livePosition,
    activeStopOrder,
    candidateStop,
  });
  if (evaluation.clearOverride) {
    clearManualStopOverride(ticker, options);
  }
  return evaluation;
}

module.exports = {
  DEFAULT_MANUAL_STOP_OVERRIDES_PATH,
  defaultManualStopOverrideState,
  normalizeManualStopOverride,
  loadManualStopOverrideState,
  writeManualStopOverrideState,
  registerManualStopOverride,
  clearManualStopOverride,
  isBreakEvenOrBetter,
  evaluateManualStopOverrideGuard,
  maybeBlockTrailingStopTighten,
};
