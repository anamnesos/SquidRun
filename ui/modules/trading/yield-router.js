'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');

const DEFAULT_YIELD_ROUTER_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'yield-router-state.json'),
  { forWrite: true }
);
const DEFAULT_MIN_DEPOSIT_USD = 50;
const DEFAULT_MIN_VENUE_TVL_USD = 10_000_000;
const DEFAULT_YIELD_TARGET_RATIO = 0.35;
const DEFAULT_RESERVE_RATIO = 0.2;
const DEFAULT_MAX_SINGLE_VENUE_SHARE = 0.5;
const DEFAULT_EXPECTED_HOLD_DAYS = 30;

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function toRatio(value, fallback = 0) {
  const numeric = toNumber(value, fallback);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric > 1) return clamp(numeric / 100, 0, 1);
  return clamp(numeric, 0, 1);
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function formatTxHash(prefix, venueKey, amount, nowMs) {
  const key = toText(venueKey, 'venue').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return `${prefix}-${key}-${Math.floor(Math.max(0, toNumber(amount, 0)) * 100)}-${Math.floor(nowMs)}`;
}

function buildVenueKey(record = {}) {
  const providerId = toText(record.providerId || record.provider || record.protocol, 'provider').toLowerCase();
  const protocol = toText(record.protocol, providerId).toLowerCase();
  const chain = toText(record.chain, 'base').toLowerCase();
  return `${providerId}:${protocol}:${chain}`;
}

function normalizeVenue(record = {}, provider = null) {
  const providerId = toText(record.providerId || record.provider || provider?.id || record.protocol, 'provider').toLowerCase();
  const protocol = toText(record.protocol || provider?.name, providerId);
  const chain = toText(record.chain, 'base').toLowerCase();
  const minDeposit = Math.max(DEFAULT_MIN_DEPOSIT_USD, toNumber(record.minDeposit, DEFAULT_MIN_DEPOSIT_USD));
  const normalized = {
    protocol,
    chain,
    apy: toRatio(record.apy, 0),
    tvl: Math.max(0, toNumber(record.tvl, 0)),
    riskScore: clamp(toNumber(record.riskScore, 0)),
    minDeposit,
    lockupDays: Math.max(0, Math.floor(toNumber(record.lockupDays, 0))),
    audited: record.audited !== false,
    providerId,
    gasEstimateUsd: Math.max(0, toNumber(record.gasEstimateUsd, 0)),
    slippageEstimateUsd: Math.max(0, toNumber(record.slippageEstimateUsd, 0)),
    raw: record.raw || record,
  };
  normalized.venueKey = toText(record.venueKey, buildVenueKey(normalized));
  return normalized;
}

function defaultYieldRouterState() {
  return {
    deposits: [],
    updatedAt: null,
  };
}

function normalizeDeposit(record = {}, nowMs = Date.now()) {
  const currentValue = Math.max(0, toNumber(record.currentValue ?? record.amount, 0));
  const amount = Math.max(0, toNumber(record.amount ?? currentValue, 0));
  const depositedAt = toIsoTimestamp(record.depositedAt, null);
  const lockupEndsAt = toIsoTimestamp(record.lockupEndsAt, null);
  const locked = record.locked === true
    || (lockupEndsAt ? Date.parse(lockupEndsAt) > nowMs : false);
  const normalized = {
    venueKey: toText(record.venueKey || buildVenueKey(record)),
    protocol: toText(record.protocol, 'Venue'),
    chain: toText(record.chain, 'base').toLowerCase(),
    amount,
    currentValue,
    apy: toRatio(record.apy, 0),
    depositedAt,
    lockupEndsAt,
    locked,
    providerId: toText(record.providerId || record.provider || record.protocol, 'provider').toLowerCase(),
    txHash: toText(record.txHash),
    raw: record.raw || record,
  };
  return normalized;
}

function normalizeYieldRouterState(state = {}, nowMs = Date.now()) {
  return {
    ...defaultYieldRouterState(),
    ...state,
    deposits: Array.isArray(state.deposits)
      ? state.deposits.map((deposit) => normalizeDeposit(deposit, nowMs)).filter((deposit) => deposit.currentValue > 0)
      : [],
    updatedAt: toIsoTimestamp(state.updatedAt, null),
  };
}

function readYieldRouterState(statePath = DEFAULT_YIELD_ROUTER_STATE_PATH) {
  try {
    return normalizeYieldRouterState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return defaultYieldRouterState();
  }
}

function writeYieldRouterState(statePath = DEFAULT_YIELD_ROUTER_STATE_PATH, state = {}) {
  const normalized = normalizeYieldRouterState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    ...normalized,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function isVenueEligible(venue, options = {}) {
  if (!venue) return false;
  if (venue.audited === false) return false;
  if (venue.tvl < Math.max(0, toNumber(options.minVenueTvlUsd, DEFAULT_MIN_VENUE_TVL_USD))) return false;
  if (venue.minDeposit > Math.max(DEFAULT_MIN_DEPOSIT_USD, toNumber(options.maxMinimumDepositUsd, Number.MAX_SAFE_INTEGER))) return false;
  if (options.maxRiskScore != null && venue.riskScore > clamp(toNumber(options.maxRiskScore, 1), 0, 1)) return false;
  return true;
}

function sumDepositValue(deposits = [], matcher = null) {
  return deposits.reduce((sum, deposit) => {
    if (typeof matcher === 'function' && !matcher(deposit)) return sum;
    return sum + Math.max(0, toNumber(deposit.currentValue ?? deposit.amount, 0));
  }, 0);
}

function resolveTotalCapital(options = {}) {
  if (Number.isFinite(options.totalCapital)) return Math.max(0, toNumber(options.totalCapital, 0));
  const snapshot = options.portfolioSnapshot || {};
  if (Number.isFinite(snapshot.totalEquity)) return Math.max(0, toNumber(snapshot.totalEquity, 0));
  if (Number.isFinite(options.availableUsdc)) return Math.max(0, toNumber(options.availableUsdc, 0));
  if (Number.isFinite(snapshot.totalCash)) return Math.max(0, toNumber(snapshot.totalCash, 0));
  return 0;
}

function resolveKillSwitch(options = {}) {
  if (options.killSwitchTriggered === true) return true;
  return options.portfolioSnapshot?.risk?.killSwitchTriggered === true;
}

function estimateExpectedYield(amount, venue, options = {}) {
  const holdDays = Math.max(
    1,
    Math.floor(toNumber(options.expectedHoldDays, venue.lockupDays || DEFAULT_EXPECTED_HOLD_DAYS))
  );
  const expectedYield = Math.max(0, toNumber(amount, 0)) * toRatio(venue.apy, 0) * (holdDays / 365);
  return Number(expectedYield.toFixed(4));
}

function estimateRoundTripCost(venue, options = {}) {
  const gasEstimateUsd = Math.max(0, toNumber(
    options.gasEstimateUsd ?? venue.gasEstimateUsd,
    0
  ));
  const slippageEstimateUsd = Math.max(0, toNumber(
    options.slippageEstimateUsd ?? venue.slippageEstimateUsd,
    0
  ));
  return Number((gasEstimateUsd + slippageEstimateUsd).toFixed(4));
}

function createAaveProvider(options = {}) {
  const venues = Array.isArray(options.venues) && options.venues.length > 0
    ? options.venues
    : [{
      protocol: 'Aave',
      chain: toText(options.chain, 'base'),
      apy: 0.047,
      tvl: 52_000_000,
      riskScore: 0.12,
      minDeposit: DEFAULT_MIN_DEPOSIT_USD,
      lockupDays: 0,
      audited: true,
      gasEstimateUsd: 0.35,
      slippageEstimateUsd: 0.08,
    }];

  return {
    id: toText(options.id, 'aave'),
    name: 'Aave',
    async getAvailableVenues() {
      return venues.map((venue) => ({ ...venue, providerId: toText(options.id, 'aave') }));
    },
    async deposit(venue, amount, context = {}) {
      return {
        ok: true,
        txHash: formatTxHash('aave-deposit', venue?.venueKey, amount, context.nowMs || Date.now()),
        deposited: Number(toNumber(amount, 0).toFixed(2)),
        venue,
      };
    },
    async withdraw(venue, amount, context = {}) {
      return {
        ok: true,
        txHash: formatTxHash('aave-withdraw', venue?.venueKey, amount, context.nowMs || Date.now()),
        withdrawn: Number(toNumber(amount, 0).toFixed(2)),
        venue,
      };
    },
  };
}

function createMorphoProvider(options = {}) {
  const venues = Array.isArray(options.venues) && options.venues.length > 0
    ? options.venues
    : [{
      protocol: 'Morpho',
      chain: toText(options.chain, 'base'),
      apy: 0.061,
      tvl: 84_000_000,
      riskScore: 0.14,
      minDeposit: DEFAULT_MIN_DEPOSIT_USD,
      lockupDays: 0,
      audited: true,
      gasEstimateUsd: 0.4,
      slippageEstimateUsd: 0.08,
    }];

  return {
    id: toText(options.id, 'morpho'),
    name: 'Morpho',
    async getAvailableVenues() {
      return venues.map((venue) => ({ ...venue, providerId: toText(options.id, 'morpho') }));
    },
    async deposit(venue, amount, context = {}) {
      return {
        ok: true,
        txHash: formatTxHash('morpho-deposit', venue?.venueKey, amount, context.nowMs || Date.now()),
        deposited: Number(toNumber(amount, 0).toFixed(2)),
        venue,
      };
    },
    async withdraw(venue, amount, context = {}) {
      return {
        ok: true,
        txHash: formatTxHash('morpho-withdraw', venue?.venueKey, amount, context.nowMs || Date.now()),
        withdrawn: Number(toNumber(amount, 0).toFixed(2)),
        venue,
      };
    },
  };
}

function createStaticYieldProvider(options = {}) {
  const providerId = toText(options.id, 'static-yield');
  const providerName = toText(options.name, 'Static Yield');
  const rawVenues = Array.isArray(options.venues) ? options.venues : [];

  return {
    id: providerId,
    name: providerName,
    async getAvailableVenues() {
      return rawVenues.map((venue) => ({ ...venue, providerId }));
    },
    async deposit(venue, amount, context = {}) {
      if (typeof options.onDeposit === 'function') {
        const result = await options.onDeposit(venue, amount, context);
        if (result && typeof result === 'object') {
          return {
            ok: result.ok !== false,
            txHash: toText(result.txHash, formatTxHash(`${providerId}-deposit`, venue?.venueKey, amount, context.nowMs || Date.now())),
            deposited: Number(toNumber(result.deposited ?? amount, amount).toFixed(2)),
            venue,
            ...result,
          };
        }
      }
      return {
        ok: true,
        txHash: formatTxHash(`${providerId}-deposit`, venue?.venueKey, amount, context.nowMs || Date.now()),
        deposited: Number(toNumber(amount, 0).toFixed(2)),
        venue,
      };
    },
    async withdraw(venue, amount, context = {}) {
      if (typeof options.onWithdraw === 'function') {
        const result = await options.onWithdraw(venue, amount, context);
        if (result && typeof result === 'object') {
          return {
            ok: result.ok !== false,
            txHash: toText(result.txHash, formatTxHash(`${providerId}-withdraw`, venue?.venueKey, amount, context.nowMs || Date.now())),
            withdrawn: Number(toNumber(result.withdrawn ?? amount, amount).toFixed(2)),
            venue,
            ...result,
          };
        }
      }
      return {
        ok: true,
        txHash: formatTxHash(`${providerId}-withdraw`, venue?.venueKey, amount, context.nowMs || Date.now()),
        withdrawn: Number(toNumber(amount, 0).toFixed(2)),
        venue,
      };
    },
  };
}

class YieldRouter {
  constructor(options = {}) {
    this.options = { ...options };
    this.statePath = options.statePath || DEFAULT_YIELD_ROUTER_STATE_PATH;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.fetch = options.fetch || global.fetch;
    this.env = options.env || process.env;
    this.minDepositUsd = Math.max(DEFAULT_MIN_DEPOSIT_USD, toNumber(options.minDepositUsd, DEFAULT_MIN_DEPOSIT_USD));
    this.minVenueTvlUsd = Math.max(0, toNumber(options.minVenueTvlUsd, DEFAULT_MIN_VENUE_TVL_USD));
    this.yieldTargetRatio = clamp(toNumber(options.yieldTargetRatio, DEFAULT_YIELD_TARGET_RATIO), 0, 1);
    this.reserveRatio = clamp(toNumber(options.reserveRatio, DEFAULT_RESERVE_RATIO), 0, 1);
    this.maxSingleVenueShare = clamp(
      toNumber(options.maxSingleVenueShare, DEFAULT_MAX_SINGLE_VENUE_SHARE),
      0.01,
      1
    );
    this.expectedHoldDays = Math.max(1, Math.floor(toNumber(options.expectedHoldDays, DEFAULT_EXPECTED_HOLD_DAYS)));
    this.providers = Array.isArray(options.providers) && options.providers.length > 0
      ? options.providers.slice()
      : [
        createAaveProvider(options.aaveProviderOptions || {}),
        createMorphoProvider(options.morphoProviderOptions || {}),
      ];
    this.state = normalizeYieldRouterState(
      options.state || readYieldRouterState(this.statePath),
      this.now()
    );
  }

  getState() {
    return normalizeYieldRouterState(this.state, this.now());
  }

  persistState() {
    if (this.options.persist === false) return;
    writeYieldRouterState(this.statePath, this.state);
  }

  async getAvailableVenues(options = {}) {
    const entries = await Promise.all(this.providers.map(async (provider) => {
      if (!provider || typeof provider.getAvailableVenues !== 'function') return [];
      const venues = await provider.getAvailableVenues({
        fetch: this.fetch,
        env: this.env,
        options,
      });
      if (!Array.isArray(venues)) return [];
      return venues.map((venue) => normalizeVenue(venue, provider));
    }));

    const seen = new Map();
    for (const venue of entries.flat()) {
      if (!options.includeUnsafe && !isVenueEligible(venue, {
        minVenueTvlUsd: options.minVenueTvlUsd ?? this.minVenueTvlUsd,
        maxRiskScore: options.maxRiskScore,
        maxMinimumDepositUsd: options.maxMinimumDepositUsd,
      })) {
        continue;
      }
      const existing = seen.get(venue.venueKey);
      if (!existing || venue.apy > existing.apy) {
        seen.set(venue.venueKey, venue);
      }
    }

    const venues = Array.from(seen.values()).sort((left, right) => {
      if (right.apy !== left.apy) return right.apy - left.apy;
      if (right.tvl !== left.tvl) return right.tvl - left.tvl;
      return left.riskScore - right.riskScore;
    });

    const venueMap = new Map(venues.map((venue) => [venue.venueKey, venue]));
    this.state = normalizeYieldRouterState({
      ...this.state,
      deposits: this.state.deposits.map((deposit) => {
        const venue = venueMap.get(deposit.venueKey);
        if (!venue) return deposit;
        return normalizeDeposit({
          ...deposit,
          apy: venue.apy,
          providerId: venue.providerId,
          protocol: venue.protocol,
          chain: venue.chain,
          lockupEndsAt: deposit.lockupEndsAt,
        }, this.now());
      }),
    }, this.now());
    return venues;
  }

  getDeposits() {
    const nowMs = this.now();
    return this.state.deposits.map((deposit) => normalizeDeposit(deposit, nowMs));
  }

  getIdleCapital(options = {}) {
    if (Number.isFinite(options.idleCapital)) {
      return Number(Math.max(0, toNumber(options.idleCapital, 0)).toFixed(2));
    }

    const snapshot = options.portfolioSnapshot || {};
    const totalCapital = resolveTotalCapital(options);
    const totalCash = Math.max(0, toNumber(
      options.availableUsdc
      ?? snapshot.totalCash
      ?? snapshot.markets?.cash_reserve?.cash
      ?? snapshot.liquidCapital,
      0
    ));
    const activeTradeCapital = Math.max(0, toNumber(options.activeTradeCapital, 0));
    const lockedVaultCapital = Math.max(0, toNumber(
      options.lockedVaultCapital
      ?? snapshot.markets?.defi_yield?.lockedCapital,
      0
    ));
    const reserve = totalCapital * this.reserveRatio;
    const idleCapital = totalCash - activeTradeCapital - lockedVaultCapital - reserve;
    return Number(Math.max(0, idleCapital).toFixed(2));
  }

  resolveProviderForVenue(venue) {
    const venueKey = toText(venue?.venueKey);
    const providerId = toText(venue?.providerId || venue?.provider, '').toLowerCase();
    const protocol = toText(venue?.protocol, '').toLowerCase();
    return this.providers.find((provider) => {
      const id = toText(provider?.id, '').toLowerCase();
      const name = toText(provider?.name, '').toLowerCase();
      if (providerId && id === providerId) return true;
      if (protocol && (id === protocol || name === protocol)) return true;
      if (venueKey && venueKey.startsWith(`${id}:`)) return true;
      return false;
    }) || null;
  }

  getVenueCapacity(venue, options = {}) {
    const totalCapital = resolveTotalCapital(options);
    if (totalCapital <= 0) return Number.POSITIVE_INFINITY;
    const maxAllocation = totalCapital * this.yieldTargetRatio * this.maxSingleVenueShare;
    const currentExposure = sumDepositValue(this.state.deposits, (deposit) => deposit.venueKey === venue.venueKey);
    return Math.max(0, maxAllocation - currentExposure);
  }

  async deposit(venueInput, amount, options = {}) {
    const venue = normalizeVenue(venueInput, this.resolveProviderForVenue(venueInput));
    const depositAmount = Math.max(0, toNumber(amount, 0));
    const minimumDeposit = Math.max(this.minDepositUsd, venue.minDeposit);
    if (depositAmount < minimumDeposit) {
      return {
        ok: false,
        deposited: 0,
        venue,
        reason: 'below_min_deposit',
      };
    }
    if (!isVenueEligible(venue, { minVenueTvlUsd: this.minVenueTvlUsd })) {
      return {
        ok: false,
        deposited: 0,
        venue,
        reason: 'venue_not_eligible',
      };
    }

    const expectedYield = estimateExpectedYield(depositAmount, venue, {
      expectedHoldDays: options.expectedHoldDays ?? this.expectedHoldDays,
    });
    const roundTripCost = estimateRoundTripCost(venue, options);
    if (roundTripCost >= expectedYield) {
      return {
        ok: false,
        deposited: 0,
        venue,
        reason: 'round_trip_cost_exceeds_expected_yield',
        roundTripCost,
        expectedYield,
      };
    }

    const provider = this.resolveProviderForVenue(venue);
    if (!provider || typeof provider.deposit !== 'function') {
      return {
        ok: false,
        deposited: 0,
        venue,
        reason: 'provider_unavailable',
      };
    }

    const capacity = this.getVenueCapacity(venue, options);
    if (capacity <= 0) {
      return {
        ok: false,
        deposited: 0,
        venue,
        reason: 'venue_allocation_limit',
      };
    }

    const effectiveAmount = Number(Math.min(depositAmount, capacity).toFixed(2));
    if (effectiveAmount < minimumDeposit) {
      return {
        ok: false,
        deposited: 0,
        venue,
        reason: 'venue_allocation_limit',
      };
    }

    const nowMs = this.now();
    const providerResult = await provider.deposit(venue, effectiveAmount, {
      ...options,
      fetch: this.fetch,
      env: this.env,
      nowMs,
    });
    if (!providerResult || providerResult.ok === false) {
      return {
        ok: false,
        deposited: 0,
        venue,
        reason: providerResult?.reason || 'deposit_failed',
      };
    }

    const depositedAmount = Number(toNumber(providerResult.deposited ?? effectiveAmount, effectiveAmount).toFixed(2));
    const depositedAt = new Date(nowMs).toISOString();
    const lockupEndsAt = venue.lockupDays > 0
      ? new Date(nowMs + (venue.lockupDays * 24 * 60 * 60 * 1000)).toISOString()
      : null;
    const depositRecord = normalizeDeposit({
      venueKey: venue.venueKey,
      protocol: venue.protocol,
      chain: venue.chain,
      amount: depositedAmount,
      currentValue: depositedAmount,
      apy: venue.apy,
      depositedAt,
      lockupEndsAt,
      locked: venue.lockupDays > 0,
      providerId: venue.providerId,
      txHash: toText(providerResult.txHash),
      raw: providerResult.raw || providerResult,
    }, nowMs);

    this.state = normalizeYieldRouterState({
      ...this.state,
      deposits: [...this.state.deposits, depositRecord],
    }, nowMs);
    this.persistState();

    return {
      ok: true,
      txHash: depositRecord.txHash,
      deposited: depositedAmount,
      venue,
      roundTripCost,
      expectedYield,
    };
  }

  async withdraw(venueInput, amount, options = {}) {
    const nowMs = this.now();
    const deposits = this.getDeposits();
    const requestedAmount = Math.max(0, toNumber(amount, 0));
    const venueKey = typeof venueInput === 'string'
      ? toText(venueInput)
      : toText(venueInput?.venueKey || buildVenueKey(venueInput));
    const matching = deposits.filter((deposit) => {
      if (deposit.venueKey !== venueKey) return false;
      if (options.force === true) return true;
      return deposit.locked !== true;
    }).sort((left, right) => {
      return new Date(left.depositedAt || 0).getTime() - new Date(right.depositedAt || 0).getTime();
    });

    if (matching.length === 0) {
      return {
        ok: false,
        withdrawn: 0,
        venue: typeof venueInput === 'string' ? { venueKey } : normalizeVenue(venueInput, this.resolveProviderForVenue(venueInput)),
        reason: 'no_withdrawable_deposits',
      };
    }

    const venue = normalizeVenue({
      ...matching[0],
      protocol: matching[0].protocol,
      chain: matching[0].chain,
      providerId: matching[0].providerId,
      apy: matching[0].apy,
    }, this.resolveProviderForVenue(matching[0]));
    const provider = this.resolveProviderForVenue(venue);
    if (!provider || typeof provider.withdraw !== 'function') {
      return {
        ok: false,
        withdrawn: 0,
        venue,
        reason: 'provider_unavailable',
      };
    }

    const available = Number(sumDepositValue(matching).toFixed(2));
    const withdrawAmount = Number(Math.min(requestedAmount || available, available).toFixed(2));
    if (withdrawAmount <= 0) {
      return {
        ok: false,
        withdrawn: 0,
        venue,
        reason: 'nothing_to_withdraw',
      };
    }

    const providerResult = await provider.withdraw(venue, withdrawAmount, {
      ...options,
      fetch: this.fetch,
      env: this.env,
      nowMs,
    });
    if (!providerResult || providerResult.ok === false) {
      return {
        ok: false,
        withdrawn: 0,
        venue,
        reason: providerResult?.reason || 'withdraw_failed',
      };
    }

    let remainingToReduce = Number(toNumber(providerResult.withdrawn ?? withdrawAmount, withdrawAmount).toFixed(2));
    const nextDeposits = [];
    for (const deposit of deposits) {
      if (deposit.venueKey !== venueKey || remainingToReduce <= 0 || (deposit.locked && options.force !== true)) {
        nextDeposits.push(deposit);
        continue;
      }

      const currentValue = Math.max(0.01, toNumber(deposit.currentValue ?? deposit.amount, 0));
      const reduction = Math.min(currentValue, remainingToReduce);
      const remainingRatio = Math.max(0, (currentValue - reduction) / currentValue);
      const updatedCurrentValue = Number((currentValue - reduction).toFixed(2));
      const updatedAmount = Number((toNumber(deposit.amount, 0) * remainingRatio).toFixed(8));
      remainingToReduce = Number((remainingToReduce - reduction).toFixed(2));

      if (updatedCurrentValue > 0.009) {
        nextDeposits.push(normalizeDeposit({
          ...deposit,
          amount: updatedAmount,
          currentValue: updatedCurrentValue,
          locked: deposit.locked,
        }, nowMs));
      }
    }

    this.state = normalizeYieldRouterState({
      ...this.state,
      deposits: nextDeposits,
    }, nowMs);
    this.persistState();

    return {
      ok: true,
      txHash: toText(providerResult.txHash),
      withdrawn: Number(toNumber(providerResult.withdrawn ?? withdrawAmount, withdrawAmount).toFixed(2)),
      venue,
    };
  }

  async requestCapital(amount, options = {}) {
    const requestedAmount = Math.max(0, toNumber(amount, 0));
    const deposits = this.getDeposits();
    const killSwitchTriggered = resolveKillSwitch(options);
    const candidates = killSwitchTriggered
      ? deposits.slice().sort((left, right) => left.apy - right.apy)
      : deposits.filter((deposit) => deposit.locked !== true).sort((left, right) => {
        if (left.apy !== right.apy) return left.apy - right.apy;
        return new Date(left.depositedAt || 0).getTime() - new Date(right.depositedAt || 0).getTime();
      });

    const targetAmount = killSwitchTriggered
      ? Number(sumDepositValue(candidates).toFixed(2))
      : requestedAmount;
    const sources = [];
    let remaining = targetAmount;

    for (const deposit of candidates) {
      if (remaining <= 0) break;
      const withdrawAmount = Math.min(remaining, toNumber(deposit.currentValue ?? deposit.amount, 0));
      const result = await this.withdraw(deposit.venueKey, withdrawAmount, {
        ...options,
        force: killSwitchTriggered || options.force === true,
      });
      if (!result.ok || result.withdrawn <= 0) continue;
      sources.push({
        venue: result.venue,
        amount: result.withdrawn,
        txHash: result.txHash,
      });
      remaining = Number((remaining - result.withdrawn).toFixed(2));
    }

    const withdrawn = Number((targetAmount - remaining).toFixed(2));
    return {
      ok: withdrawn >= targetAmount && targetAmount > 0,
      withdrawn,
      sources,
      killSwitchTriggered,
      remaining: Number(Math.max(0, remaining).toFixed(2)),
    };
  }

  async returnCapital(amount, options = {}) {
    if (resolveKillSwitch(options)) {
      return {
        ok: false,
        deposited: 0,
        venue: null,
        reason: 'kill_switch_triggered',
      };
    }

    const totalCapital = resolveTotalCapital(options);
    const currentDeployed = sumDepositValue(this.state.deposits);
    const targetAllocation = totalCapital > 0
      ? totalCapital * this.yieldTargetRatio
      : Number.POSITIVE_INFINITY;
    const remainingTarget = Number.isFinite(targetAllocation)
      ? Math.max(0, targetAllocation - currentDeployed)
      : Math.max(0, toNumber(amount, 0));
    const idleCapital = this.getIdleCapital(options);
    const targetAmount = Math.min(
      Math.max(0, toNumber(amount, 0)),
      idleCapital > 0 ? idleCapital : Math.max(0, toNumber(amount, 0)),
      remainingTarget
    );

    if (targetAmount < this.minDepositUsd) {
      return {
        ok: false,
        deposited: 0,
        venue: null,
        reason: remainingTarget < this.minDepositUsd ? 'yield_target_reached' : 'below_min_deposit',
      };
    }

    const venues = await this.getAvailableVenues(options);
    const allocations = [];
    let remaining = Number(targetAmount.toFixed(2));

    for (const venue of venues) {
      if (remaining < this.minDepositUsd) break;
      const capacity = this.getVenueCapacity(venue, {
        ...options,
        totalCapital,
      });
      const allocationAmount = Number(Math.min(remaining, capacity).toFixed(2));
      if (allocationAmount < Math.max(this.minDepositUsd, venue.minDeposit)) continue;

      const result = await this.deposit(venue, allocationAmount, {
        ...options,
        totalCapital,
      });
      if (!result.ok || result.deposited <= 0) continue;
      allocations.push({
        venue: result.venue,
        amount: result.deposited,
        txHash: result.txHash,
      });
      remaining = Number((remaining - result.deposited).toFixed(2));
    }

    const deposited = Number((targetAmount - remaining).toFixed(2));
    return {
      ok: deposited >= targetAmount && deposited > 0,
      deposited,
      venue: allocations.length === 1 ? allocations[0].venue : (allocations.length > 1 ? 'multiple' : null),
      allocations,
      remaining: Number(Math.max(0, remaining).toFixed(2)),
    };
  }
}

function createYieldRouter(options = {}) {
  return new YieldRouter(options);
}

module.exports = {
  DEFAULT_EXPECTED_HOLD_DAYS,
  DEFAULT_MAX_SINGLE_VENUE_SHARE,
  DEFAULT_MIN_DEPOSIT_USD,
  DEFAULT_MIN_VENUE_TVL_USD,
  DEFAULT_RESERVE_RATIO,
  DEFAULT_YIELD_ROUTER_STATE_PATH,
  DEFAULT_YIELD_TARGET_RATIO,
  YieldRouter,
  buildVenueKey,
  createAaveProvider,
  createMorphoProvider,
  createStaticYieldProvider,
  createYieldRouter,
  defaultYieldRouterState,
  estimateExpectedYield,
  estimateRoundTripCost,
  isVenueEligible,
  normalizeDeposit,
  normalizeVenue,
  normalizeYieldRouterState,
  readYieldRouterState,
  writeYieldRouterState,
};
