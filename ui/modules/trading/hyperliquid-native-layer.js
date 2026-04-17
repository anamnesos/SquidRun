'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const hyperliquidClient = require('./hyperliquid-client');
const multiTimeframeConfirmation = require('./multi-timeframe-confirmation');

const DEFAULT_NATIVE_STATE_PATH = resolveCoordPath(path.join('runtime', 'hyperliquid-native-state.json'), { forWrite: true });

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function round(value, digits = 4) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function pickSnapshotEntry(snapshots, ticker) {
  if (snapshots instanceof Map) return snapshots.get(ticker) || null;
  return snapshots?.[ticker] || null;
}

function readState(statePath = DEFAULT_NATIVE_STATE_PATH) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {
      asOf: null,
      symbols: {},
      trackedVaults: [],
      degradedSources: [],
    };
  }
}

function writeState(statePath = DEFAULT_NATIVE_STATE_PATH, payload = {}) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(payload, null, 2));
  return payload;
}

function normalizeTrackedVaults(input = [], env = process.env) {
  const explicit = Array.isArray(input) ? input : [];
  const envList = toText(env?.SQUIDRUN_HYPERLIQUID_TRACKED_VAULTS)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return Array.from(new Set([...explicit, ...envList].map((value) => toText(value).toLowerCase()).filter(Boolean)));
}

async function getMultiTimeframeBars(symbols = [], options = {}) {
  const collections = await Promise.all((Array.isArray(symbols) ? symbols : []).map(async (ticker) => {
    const [hourly, fourHour, daily] = await Promise.all([
      hyperliquidClient.getHistoricalBars({ ...options, symbols: [ticker], timeframe: '1Hour', limit: 48 }).catch(() => new Map()),
      hyperliquidClient.getHistoricalBars({ ...options, symbols: [ticker], timeframe: '4Hour', limit: 42 }).catch(() => new Map()),
      hyperliquidClient.getHistoricalBars({ ...options, symbols: [ticker], timeframe: '1Day', limit: 30 }).catch(() => new Map()),
    ]);
    return [ticker, {
      hourly: hourly instanceof Map ? (hourly.get(ticker) || []) : [],
      fourHour: fourHour instanceof Map ? (fourHour.get(ticker) || []) : [],
      daily: daily instanceof Map ? (daily.get(ticker) || []) : [],
    }];
  }));
  return new Map(collections);
}

function pickUniverseEntry(universeMarketData = [], ticker = '') {
  const coin = hyperliquidClient.normalizeCoinSymbol(ticker);
  return (Array.isArray(universeMarketData) ? universeMarketData : []).find((entry) => {
    const entryCoin = hyperliquidClient.normalizeCoinSymbol(entry?.coin || entry?.ticker);
    return entryCoin && entryCoin === coin;
  }) || null;
}

function extractFundingRateBps(venues = {}, venueNames = []) {
  const candidates = Array.isArray(venueNames) ? venueNames : [venueNames];
  const matchedVenue = candidates.find((name) => venues?.[name]?.fundingRate != null);
  const fundingRate = toNumber(matchedVenue ? venues[matchedVenue].fundingRate : undefined, NaN);
  return Number.isFinite(fundingRate) ? fundingRate * 10_000 : null;
}

function buildCrossVenueFundingSignal(predictedFunding = null, ticker = '') {
  const venues = predictedFunding?.venues || {};
  const venueBps = {
    HlPerp: round(extractFundingRateBps(venues, ['HlPerp']), 4),
    Binance: round(extractFundingRateBps(venues, ['BinPerp', 'Binance']), 4),
    Bybit: round(extractFundingRateBps(venues, ['BybitPerp', 'Bybit']), 4),
  };
  const available = Object.entries(venueBps).filter(([, value]) => value != null && Number.isFinite(Number(value)));
  if (available.length === 0) {
    return {
      ticker,
      availableVenues: [],
      basisSpreadBps: null,
      strongestVsHl: null,
      divergenceScore: 0,
      directionalBias: 'neutral',
      note: 'Cross-venue funding unavailable for this symbol.',
    };
  }

  const hlFundingBps = venueBps.HlPerp != null && Number.isFinite(Number(venueBps.HlPerp)) ? venueBps.HlPerp : null;
  const sorted = available.slice().sort((left, right) => left[1] - right[1]);
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  const basisSpreadBps = round(Math.abs(highest[1] - lowest[1]), 4);
  const vsHl = available
    .filter(([venue]) => venue !== 'HlPerp' && hlFundingBps != null)
    .map(([venue, value]) => ({
      venue,
      spreadBps: round(hlFundingBps - value, 4),
      absoluteSpreadBps: round(Math.abs(hlFundingBps - value), 4),
      venueFundingBps: value,
    }))
    .sort((left, right) => toNumber(right.absoluteSpreadBps, 0) - toNumber(left.absoluteSpreadBps, 0));
  const strongestVsHl = vsHl[0] || null;
  const divergenceScore = strongestVsHl
    ? clamp(toNumber(strongestVsHl.absoluteSpreadBps, 0) / 40, 0, 1)
    : clamp(toNumber(basisSpreadBps, 0) / 50, 0, 1);
  const directionalBias = strongestVsHl
    ? (toNumber(strongestVsHl.spreadBps, 0) < 0 ? 'short_crowded_elsewhere' : 'short_crowded_on_hl')
    : 'neutral';
  const note = strongestVsHl
    ? `HL funding differs most from ${strongestVsHl.venue} by ${round(strongestVsHl.absoluteSpreadBps, 2)} bps.`
    : `Funding is available on ${available.length} venues but HL comparison is incomplete.`;

  return {
    ticker,
    hlFundingBps,
    binanceFundingBps: venueBps.Binance,
    bybitFundingBps: venueBps.Bybit,
    availableVenues: available.map(([venue]) => venue),
    basisSpreadBps,
    strongestVsHl,
    divergenceScore: round(divergenceScore, 4),
    directionalBias,
    note,
  };
}

function classifyCrowdingBias(premiumBps, l2Skew) {
  if (premiumBps <= -5 || l2Skew === 'ask_heavy') return 'downside_crowding';
  if (premiumBps >= 5 || l2Skew === 'bid_heavy') return 'upside_crowding';
  return 'balanced';
}

function buildLiquidityAdjustedCrowdingSignal(ticker, marketEntry = null, l2Book = null, fundingSignal = null) {
  const openInterest = toNumber(marketEntry?.openInterest, 0);
  const volumeUsd24h = toNumber(marketEntry?.volumeUsd24h, 0);
  const oiToVolume = volumeUsd24h > 0 ? openInterest / volumeUsd24h : null;
  const oiToVolumeScore = oiToVolume == null ? 0 : clamp(oiToVolume / 3000, 0, 1);
  const premiumBps = round(toNumber(marketEntry?.premium, 0) * 10_000, 4);
  const premiumScore = clamp(Math.abs(toNumber(premiumBps, 0)) / 25, 0, 1);
  const spreadBps = round(toNumber(l2Book?.spreadPct, 0) * 10_000, 4);
  const spreadCostScore = clamp(toNumber(spreadBps, 0) / 30, 0, 1);
  const imbalance = toNumber(l2Book?.depthImbalanceTop5, 0);
  const imbalanceScore = clamp(Math.abs(imbalance) / 0.4, 0, 1);
  const fundingDivergenceScore = clamp(toNumber(fundingSignal?.divergenceScore, 0), 0, 1);
  const score = round(
    (oiToVolumeScore * 0.35)
    + (fundingDivergenceScore * 0.25)
    + (premiumScore * 0.15)
    + (imbalanceScore * 0.15)
    + (spreadCostScore * 0.10),
    4
  );
  const l2Skew = toText(l2Book?.nearTouchSkew, 'balanced');
  const crowdingBias = classifyCrowdingBias(toNumber(premiumBps, 0), l2Skew);
  const direction = crowdingBias === 'downside_crowding'
    ? 'short_continuation_or_relief_squeeze_risk'
    : crowdingBias === 'upside_crowding'
      ? 'long_crowding_or_flush_risk'
      : 'neutral';
  const reasons = [];
  if (fundingDivergenceScore >= 0.5) reasons.push('cross_venue_funding_divergence');
  if (oiToVolumeScore >= 0.5) reasons.push('oi_to_volume_extreme');
  if (premiumScore >= 0.5) reasons.push('premium_extreme');
  if (imbalanceScore >= 0.5) reasons.push(`l2_${l2Skew}`);
  if (spreadCostScore >= 0.5) reasons.push('spread_cost_wide');

  return {
    ticker,
    score,
    crowdingBias,
    direction,
    openInterestToVolume: round(oiToVolume, 4),
    premiumBps,
    spreadBps,
    l2Skew,
    depthImbalanceTop5: round(l2Book?.depthImbalanceTop5, 4),
    depthImbalanceTop10: round(l2Book?.depthImbalanceTop10, 4),
    components: {
      oiToVolumeScore: round(oiToVolumeScore, 4),
      fundingDivergenceScore: round(fundingDivergenceScore, 4),
      premiumScore: round(premiumScore, 4),
      imbalanceScore: round(imbalanceScore, 4),
      spreadCostScore: round(spreadCostScore, 4),
    },
    reasons,
  };
}

function buildVaultOverlay(ticker, vaultDetailsByAddress = new Map(), userVaultEquities = null) {
  const configuredVaults = Array.from(vaultDetailsByAddress.values()).filter(Boolean);
  const matchedEquities = Array.isArray(userVaultEquities?.entries)
    ? userVaultEquities.entries.filter((entry) => entry?.vaultAddress)
    : [];
  return {
    trackedVaultCount: configuredVaults.length,
    userExposureCount: matchedEquities.length,
    informational: configuredVaults.length > 0 || matchedEquities.length > 0,
    details: configuredVaults.map((entry) => ({
      vaultAddress: entry.vaultAddress,
      leader: entry.leader,
      name: entry.name,
      accountValue: entry.accountValue,
    })),
    note: configuredVaults.length > 0
      ? `Tracked vault context attached for ${ticker}; attribution remains informational unless symbol linkage is explicit.`
      : 'No tracked vault context configured.',
  };
}

async function buildNativeFeatureBundle(options = {}) {
  const asOf = toText(options.now, new Date().toISOString());
  const symbols = Array.from(new Set((Array.isArray(options.symbols) ? options.symbols : []).map((ticker) => toText(ticker).toUpperCase()).filter(Boolean)));
  const detailSymbols = Array.from(new Set((Array.isArray(options.detailSymbols) ? options.detailSymbols : symbols).map((ticker) => toText(ticker).toUpperCase()).filter(Boolean)));
  const trackedVaults = normalizeTrackedVaults(options.trackedVaults, options.env || process.env);
  const degradedSources = [];

  const [predictedFundingSnapshot, timeframeBars, userVaultEquities, universeMarketData] = await Promise.all([
    hyperliquidClient.getPredictedFundings(options).catch((error) => {
      degradedSources.push(`predictedFundings:${error?.message || String(error)}`);
      return { asOf, byCoin: {}, raw: [] };
    }),
    options.multiTimeframeBars instanceof Map
      ? Promise.resolve(options.multiTimeframeBars)
      : getMultiTimeframeBars(symbols, options).catch((error) => {
        degradedSources.push(`multiTimeframeBars:${error?.message || String(error)}`);
        return new Map();
      }),
    trackedVaults.length > 0 && (toText(options.user) || toText(options.walletAddress) || hyperliquidClient.resolveWalletAddress(options.env || process.env))
      ? hyperliquidClient.getUserVaultEquities(options).catch((error) => {
        degradedSources.push(`userVaultEquities:${error?.message || String(error)}`);
        return null;
      })
      : Promise.resolve(null),
    Array.isArray(options.universeMarketData)
      ? Promise.resolve(options.universeMarketData)
      : hyperliquidClient.getUniverseMarketData(options).catch((error) => {
        degradedSources.push(`universeMarketData:${error?.message || String(error)}`);
        return [];
      }),
  ]);

  const l2Entries = await Promise.all(detailSymbols.map(async (ticker) => {
    try {
      return [ticker, await hyperliquidClient.getL2Book({ ...options, ticker })];
    } catch (error) {
      degradedSources.push(`l2Book:${ticker}:${error?.message || String(error)}`);
      return [ticker, null];
    }
  }));
  const l2ByTicker = new Map(l2Entries);

  const vaultDetailEntries = await Promise.all(trackedVaults.map(async (vaultAddress) => {
    try {
      return [vaultAddress, await hyperliquidClient.getVaultDetails({ ...options, vaultAddress })];
    } catch (error) {
      degradedSources.push(`vaultDetails:${vaultAddress}:${error?.message || String(error)}`);
      return [vaultAddress, null];
    }
  }));
  const vaultDetailsByAddress = new Map(vaultDetailEntries);

  const bySymbol = {};
  for (const ticker of symbols) {
    const coin = hyperliquidClient.normalizeCoinSymbol(ticker);
    const predictedFunding = predictedFundingSnapshot.byCoin?.[coin] || null;
    const l2Book = l2ByTicker.get(ticker) || null;
    const marketEntry = pickUniverseEntry(universeMarketData, ticker);
    const crossVenueFunding = buildCrossVenueFundingSignal(predictedFunding, ticker);
    const crowdingSignal = buildLiquidityAdjustedCrowdingSignal(ticker, marketEntry, l2Book, crossVenueFunding);
    const mtf = multiTimeframeConfirmation.buildMultiTimeframeConfirmation({
      ticker,
      snapshot: pickSnapshotEntry(options.snapshots, ticker) || {},
      timeframeBars: timeframeBars.get(ticker) || {},
      decision: options.decisionByTicker?.[ticker] || null,
      asOf,
    });
    bySymbol[ticker] = {
      predictedFunding,
      crossVenueFunding,
      crowdingLiquidity: crowdingSignal,
      universeMarket: marketEntry ? {
        coin: marketEntry.coin,
        price: marketEntry.price,
        markPx: marketEntry.markPx,
        oraclePx: marketEntry.oraclePx,
        premium: marketEntry.premium,
        openInterest: marketEntry.openInterest,
        volumeUsd24h: marketEntry.volumeUsd24h,
      } : null,
      l2Book,
      multiTimeframe: mtf,
      vaultOverlay: buildVaultOverlay(ticker, vaultDetailsByAddress, userVaultEquities),
    };
  }

  return {
    ok: true,
    asOf,
    statePath: options.statePath || DEFAULT_NATIVE_STATE_PATH,
    symbols: bySymbol,
    trackedVaults: trackedVaults.map((vaultAddress) => vaultDetailsByAddress.get(vaultAddress) || { vaultAddress }),
    userVaultEquities,
    degradedSources: Array.from(new Set(degradedSources)),
  };
}

function recordNativeFeatureSnapshot(bundle = {}, options = {}) {
  const statePath = options.statePath || bundle.statePath || DEFAULT_NATIVE_STATE_PATH;
  const current = readState(statePath);
  const next = {
    ...current,
    asOf: bundle.asOf || new Date().toISOString(),
    symbols: bundle.symbols || {},
    trackedVaults: bundle.trackedVaults || [],
    userVaultEquities: bundle.userVaultEquities || null,
    degradedSources: bundle.degradedSources || [],
  };
  writeState(statePath, next);
  return {
    ok: true,
    path: statePath,
    symbolCount: Object.keys(next.symbols || {}).length,
  };
}

module.exports = {
  DEFAULT_NATIVE_STATE_PATH,
  buildNativeFeatureBundle,
  normalizeTrackedVaults,
  readState,
  recordNativeFeatureSnapshot,
  writeState,
};
