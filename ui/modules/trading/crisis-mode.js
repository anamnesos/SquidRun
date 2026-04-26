'use strict';

const CRISIS_TYPES = Object.freeze({
  NONE: 'none',
  INFLATIONARY: 'inflationary',
  DEFLATIONARY: 'deflationary',
  MIXED: 'mixed',
});

const INFLATIONARY_CRISIS_UNIVERSE = Object.freeze([
  'SQQQ',
  'BITI',
  'PSQ',
  'SH',
  'UVXY',
  'XLE',
  'ITA',
  'UUP',
]);

const DEFLATIONARY_CRISIS_UNIVERSE = Object.freeze([
  'SQQQ',
  'BITI',
  'PSQ',
  'SH',
  'UVXY',
  'ITA',
  'UUP',
  'TLT',
]);

const CRISIS_UNIVERSE_BY_TYPE = Object.freeze({
  [CRISIS_TYPES.INFLATIONARY]: INFLATIONARY_CRISIS_UNIVERSE,
  [CRISIS_TYPES.DEFLATIONARY]: DEFLATIONARY_CRISIS_UNIVERSE,
  [CRISIS_TYPES.MIXED]: Object.freeze(Array.from(new Set([
    ...INFLATIONARY_CRISIS_UNIVERSE,
    ...DEFLATIONARY_CRISIS_UNIVERSE,
  ]))),
  [CRISIS_TYPES.NONE]: INFLATIONARY_CRISIS_UNIVERSE,
});

const CRISIS_UNIVERSE = CRISIS_UNIVERSE_BY_TYPE[CRISIS_TYPES.INFLATIONARY];

const SUPPORTED_SIGNAL_DIRECTIONS = Object.freeze([
  'BUY',
  'SELL',
  'HOLD',
  'SHORT',
  'COVER',
  'BUY_PUT',
]);

const STRATEGY_MODES = Object.freeze({
  NORMAL: 'normal',
  DEFENSIVE: 'defensive',
  CRISIS: 'crisis',
});

const DEFAULT_CRISIS_LIMITS = Object.freeze({
  minPositionPct: 0.01,
  maxPositionPct: 0.025,
  maxBookPct: 0.08,
  maxOpenPositions: 3,
});

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toTicker(value) {
  return toText(value).toUpperCase();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeSignalDirection(value, options = {}) {
  const normalized = toText(value, options.fallback || 'HOLD').toUpperCase();
  if (SUPPORTED_SIGNAL_DIRECTIONS.includes(normalized)) {
    return normalized;
  }
  if (options.strict === true) {
    throw new Error(`Unsupported signal direction: ${value}`);
  }
  return toText(options.fallback, 'HOLD').toUpperCase();
}

function strategyModeForRegime(regime = '') {
  const normalized = toText(regime).toLowerCase();
  if (normalized === 'stay_cash') return STRATEGY_MODES.CRISIS;
  if (normalized === 'red' || normalized === 'yellow') return STRATEGY_MODES.DEFENSIVE;
  return STRATEGY_MODES.NORMAL;
}

function normalizeCrisisType(value, fallback = CRISIS_TYPES.NONE) {
  const normalized = toText(value, fallback).toLowerCase();
  if (Object.values(CRISIS_TYPES).includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function resolveCrisisUniverse(crisisType = CRISIS_TYPES.INFLATIONARY) {
  return CRISIS_UNIVERSE_BY_TYPE[normalizeCrisisType(crisisType, CRISIS_TYPES.INFLATIONARY)] || CRISIS_UNIVERSE;
}

function getCrisisUniverse(macroRisk = null) {
  const fromConstraints = Array.isArray(macroRisk?.constraints?.crisisUniverse)
    ? macroRisk.constraints.crisisUniverse
    : null;
  const fromRoot = Array.isArray(macroRisk?.crisisUniverse)
    ? macroRisk.crisisUniverse
    : null;
  const universe = fromConstraints
    || fromRoot
    || resolveCrisisUniverse(macroRisk?.crisisType || macroRisk?.constraints?.crisisType || CRISIS_TYPES.INFLATIONARY);
  return Array.from(new Set(universe.map(toTicker).filter(Boolean)));
}

function isCrisisTicker(ticker, universe = CRISIS_UNIVERSE) {
  return getCrisisUniverse({ crisisUniverse: universe }).includes(toTicker(ticker));
}

function deriveCrisisRiskLimits(baseLimits = {}) {
  return {
    ...baseLimits,
    maxPositionPct: Math.min(toNumber(baseLimits.maxPositionPct, 0.05), DEFAULT_CRISIS_LIMITS.maxPositionPct),
    maxOpenPositions: Math.min(toNumber(baseLimits.maxOpenPositions, 3), DEFAULT_CRISIS_LIMITS.maxOpenPositions),
    crisisBookPct: Math.min(toNumber(baseLimits.crisisBookPct, DEFAULT_CRISIS_LIMITS.maxBookPct), DEFAULT_CRISIS_LIMITS.maxBookPct),
    crisisMinPositionPct: Math.max(
      toNumber(baseLimits.crisisMinPositionPct, DEFAULT_CRISIS_LIMITS.minPositionPct),
      DEFAULT_CRISIS_LIMITS.minPositionPct
    ),
  };
}

function buildBrokerCapabilityPayload({ account = null, assets = new Map(), phase = 'phase1' } = {}) {
  const instruments = {};
  const supportedUniverse = [];
  const allCrisisTickers = Array.from(new Set(Object.values(CRISIS_UNIVERSE_BY_TYPE).flat()));

  for (const ticker of allCrisisTickers) {
    const asset = assets instanceof Map ? assets.get(ticker) : assets?.[ticker];
    const normalized = {
      tradable: Boolean(asset?.tradable),
      marginable: Boolean(asset?.marginable),
      shortable: Boolean(asset?.shortable),
      easyToBorrow: Boolean(asset?.easy_to_borrow || asset?.easyToBorrow),
      fractionable: Boolean(asset?.fractionable),
      class: toText(asset?.class),
      exchange: toText(asset?.exchange).toUpperCase(),
      status: toText(asset?.status).toLowerCase(),
      phase1Executable: Boolean(asset?.tradable),
    };
    instruments[ticker] = normalized;
    if (normalized.phase1Executable) {
      supportedUniverse.push(ticker);
    }
  }

  return {
    broker: 'ibkr',
    phase,
    account: {
      shortingEnabled: Boolean(account?.shorting_enabled || account?.shortingEnabled),
      optionsTradingLevel: toNumber(account?.options_trading_level ?? account?.optionsTradingLevel, 0),
      optionsApprovedLevel: toNumber(account?.options_approved_level ?? account?.optionsApprovedLevel, 0),
      patternDayTrader: Boolean(account?.pattern_day_trader || account?.patternDayTrader),
      daytradeCount: toNumber(account?.daytrade_count ?? account?.daytradeCount, 0),
      buyingPower: toNumber(account?.buying_power ?? account?.buyingPower, 0),
      equity: toNumber(account?.equity, 0),
      multiplier: toNumber(account?.multiplier, 1),
    },
    instruments,
    supportedUniverse,
    phase1Notes: [
      'Phase 1 execution is BUY-side only.',
      'Inverse ETFs and crisis longs are executable now.',
      'SHORT, COVER, and BUY_PUT are research-valid signal directions but not executable yet.',
    ],
  };
}

function validateCrisisSignalCapability(signal = {}, brokerCapabilities = null, macroRisk = null) {
  const direction = normalizeSignalDirection(signal.direction);
  const ticker = toTicker(signal.ticker);
  const assetClass = toText(signal.assetClass || signal.asset_class).toLowerCase();
  const broker = toText(signal.broker || signal.venue || signal.exchange).toLowerCase();
  const strategyMode = toText(macroRisk?.strategyMode || strategyModeForRegime(macroRisk?.regime), STRATEGY_MODES.NORMAL).toLowerCase();
  if (strategyMode !== STRATEGY_MODES.CRISIS) {
    return { ok: true, reason: 'strategy_not_crisis' };
  }
  if (direction === 'HOLD') {
    return { ok: true, reason: 'hold_allowed' };
  }
  const isHyperliquidCrypto = (assetClass === 'crypto' || ticker.endsWith('/USD'))
    && (broker === '' || broker === 'hyperliquid');
  if (isHyperliquidCrypto && (direction === 'SELL' || direction === 'SHORT')) {
    return { ok: true, reason: 'hyperliquid_crypto_short_allowed' };
  }

  const crisisUniverse = getCrisisUniverse(macroRisk);
  if (!crisisUniverse.includes(ticker)) {
    return { ok: false, reason: `${ticker} is outside the crisis universe` };
  }

  const capability = brokerCapabilities?.instruments?.[ticker] || {};
  if (direction === 'BUY') {
    if (capability.tradable !== true) {
      return { ok: false, reason: `${ticker} is not tradable on IBKR` };
    }
    if (capability.phase1Executable !== true) {
      return { ok: false, reason: `${ticker} is not Phase 1 executable` };
    }
    return { ok: true, reason: 'phase1_crisis_buy_allowed' };
  }
  if (direction === 'SHORT' || direction === 'COVER') {
    return { ok: false, reason: 'SHORT/COVER are Phase 2 features' };
  }
  if (direction === 'BUY_PUT') {
    return { ok: false, reason: 'BUY_PUT is a Phase 2 execution feature' };
  }
  if (direction === 'SELL') {
    return { ok: false, reason: 'SELL is reserved for exiting existing longs, not opening crisis trades' };
  }

  return { ok: false, reason: `Unsupported crisis action ${direction}` };
}

function estimateCrisisBookExposure(accountState = {}, universe = CRISIS_UNIVERSE) {
  const crisisTickers = new Set(getCrisisUniverse({ crisisUniverse: universe }));
  return (Array.isArray(accountState?.openPositions) ? accountState.openPositions : []).reduce((sum, position) => {
    if (!crisisTickers.has(toTicker(position?.ticker))) return sum;
    const marketValue = toNumber(position?.marketValue, null);
    if (marketValue != null && marketValue > 0) {
      return sum + marketValue;
    }
    return sum + (toNumber(position?.shares, 0) * toNumber(position?.avgPrice, 0));
  }, 0);
}

module.exports = {
  CRISIS_UNIVERSE,
  CRISIS_TYPES,
  CRISIS_UNIVERSE_BY_TYPE,
  DEFAULT_CRISIS_LIMITS,
  DEFLATIONARY_CRISIS_UNIVERSE,
  INFLATIONARY_CRISIS_UNIVERSE,
  STRATEGY_MODES,
  SUPPORTED_SIGNAL_DIRECTIONS,
  buildBrokerCapabilityPayload,
  deriveCrisisRiskLimits,
  estimateCrisisBookExposure,
  getCrisisUniverse,
  isCrisisTicker,
  normalizeCrisisType,
  normalizeSignalDirection,
  resolveCrisisUniverse,
  strategyModeForRegime,
  validateCrisisSignalCapability,
};
