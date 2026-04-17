'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const hyperliquidClient = require('./hyperliquid-client');

const DEFAULT_CRYPTO_MECH_BOARD_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'crypto-mech-board-state.json'),
  { forWrite: true }
);
const DEFAULT_HISTORY_RETENTION_MS = 72 * 60 * 60 * 1000;
const TARGET_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_TOLERANCE_MS = 6 * 60 * 60 * 1000;

const SYMBOL_ALIASES = Object.freeze({
  AVAX: 'AVAX',
  BTC: 'BTC',
  DOGE: 'DOGE',
  ETH: 'ETH',
  LINK: 'LINK',
  SOL: 'SOL',
  WAVAX: 'AVAX',
  WBTC: 'BTC',
  WETH: 'ETH',
  WSOL: 'SOL',
  XBT: 'BTC',
});

const KNOWN_EXCHANGE_ADDRESSES = new Set([
  '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503',
  '0xbe0eb53f46cd790cd13851d5eff43d12404d33e8',
  '0xf977814e90da44bfa03b6295a0616a897441acec',
  '0x28c6c06298d514db089934071355e5743bf21d60',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d',
  '0x56eddb7aa87536c09ccc2793473599fd21a8b17f',
  '0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0',
]);

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, toNumber(value, min)));
}

function round(value, digits = 4) {
  const numeric = toNumber(value, NaN);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function score(value) {
  return Math.round(clamp(value, 0, 1) * 100);
}

function pctChange(current, baseline) {
  const currentNumber = toNumber(current, NaN);
  const baselineNumber = toNumber(baseline, NaN);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(baselineNumber) || baselineNumber === 0) {
    return null;
  }
  return round((currentNumber - baselineNumber) / baselineNumber, 4);
}

function normalizeTicker(value) {
  const normalized = toText(value).toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('/USD') ? normalized : `${normalized}/USD`;
}

function normalizeCoin(value) {
  const normalized = toText(value).toUpperCase();
  return SYMBOL_ALIASES[normalized] || normalized;
}

function getMapValue(collection, key) {
  if (collection instanceof Map) return collection.get(key);
  return collection?.[key];
}

function defaultBoardState() {
  return {
    updatedAt: null,
    history: {},
  };
}

function normalizeHistoryPoint(point = {}) {
  return {
    recordedAt: toIsoTimestamp(point.recordedAt, null),
    fundingRate: toNumber(point.fundingRate, 0),
    markPx: toNumber(point.markPx, 0),
    openInterest: toNumber(point.openInterest, 0),
  };
}

function normalizeBoardState(state = {}) {
  const history = state && typeof state.history === 'object' && state.history
    ? Object.fromEntries(Object.entries(state.history).map(([coin, entries]) => ([
      normalizeCoin(coin),
      Array.isArray(entries)
        ? entries.map(normalizeHistoryPoint).filter((entry) => entry.recordedAt)
        : [],
    ])))
    : {};
  return {
    ...defaultBoardState(),
    ...state,
    updatedAt: toIsoTimestamp(state.updatedAt, null),
    history,
  };
}

function readBoardState(statePath = DEFAULT_CRYPTO_MECH_BOARD_STATE_PATH) {
  try {
    return normalizeBoardState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return defaultBoardState();
  }
}

function writeBoardState(statePath = DEFAULT_CRYPTO_MECH_BOARD_STATE_PATH, state = {}) {
  const normalized = normalizeBoardState(state);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function pruneHistory(entries = [], nowMs = Date.now(), retentionMs = DEFAULT_HISTORY_RETENTION_MS) {
  return entries
    .filter((entry) => {
      const recordedAtMs = Date.parse(entry.recordedAt || '');
      return Number.isFinite(recordedAtMs) && (nowMs - recordedAtMs) <= retentionMs;
    })
    .sort((left, right) => Date.parse(left.recordedAt || 0) - Date.parse(right.recordedAt || 0));
}

function findLookbackSample(entries = [], targetMs, toleranceMs = LOOKBACK_TOLERANCE_MS) {
  let best = null;
  let bestDistance = Infinity;
  for (const entry of entries) {
    const recordedAtMs = Date.parse(entry.recordedAt || '');
    if (!Number.isFinite(recordedAtMs)) continue;
    const distance = Math.abs(recordedAtMs - targetMs);
    if (distance > toleranceMs) continue;
    if (distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

function appendHistoryPoint(entries = [], point = {}, options = {}) {
  const retentionMs = Math.max(60 * 60 * 1000, toNumber(options.retentionMs, DEFAULT_HISTORY_RETENTION_MS));
  const next = pruneHistory([...entries, normalizeHistoryPoint(point)], Date.parse(point.recordedAt || Date.now()), retentionMs);
  if (next.length > 120) {
    return next.slice(-120);
  }
  return next;
}

function buildCtxByCoin(metaAndAssetCtxs = []) {
  const [meta, assetCtxs] = Array.isArray(metaAndAssetCtxs) ? metaAndAssetCtxs : [null, []];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const contexts = Array.isArray(assetCtxs) ? assetCtxs : [];
  const byCoin = new Map();
  universe.forEach((asset, index) => {
    const coin = normalizeCoin(asset?.name || asset?.coin || asset);
    if (!coin) return;
    byCoin.set(coin, contexts[index] || null);
  });
  return byCoin;
}

function buildPredictedFundingByCoin(predictedFundings = []) {
  const byCoin = new Map();
  for (const entry of Array.isArray(predictedFundings) ? predictedFundings : []) {
    const coin = normalizeCoin(Array.isArray(entry) ? entry[0] : null);
    const venues = Array.isArray(entry?.[1]) ? entry[1] : [];
    const normalizedVenues = Object.fromEntries(venues.map(([venue, data]) => [venue, data || null]));
    byCoin.set(coin, normalizedVenues);
  }
  return byCoin;
}

function normalizeFundingHistory(history = []) {
  return (Array.isArray(history) ? history : [])
    .map((entry) => ({
      time: Number(entry?.time) || 0,
      fundingRate: toNumber(entry?.fundingRate, 0),
      premium: toNumber(entry?.premium, 0),
    }))
    .filter((entry) => entry.time > 0)
    .sort((left, right) => left.time - right.time);
}

function resolveCurrentPrice(ticker, ctx = {}, snapshots) {
  const markPx = toNumber(ctx?.markPx, 0);
  if (markPx > 0) return markPx;
  const snapshot = getMapValue(snapshots, ticker);
  return toNumber(snapshot?.tradePrice ?? snapshot?.dailyClose ?? snapshot?.minuteClose, 0);
}

function findMatchingDefiPosition(coin, defiStatus = {}) {
  const positions = Array.isArray(defiStatus?.positions) ? defiStatus.positions : [];
  return positions.find((position) => normalizeCoin(position?.coin) === coin) || null;
}

function computePositionLiquidationDistancePct(position = null, markPx = 0) {
  if (!position) return null;
  const liquidationPx = toNumber(position?.liquidationPx, 0);
  if (liquidationPx <= 0 || markPx <= 0) return null;
  return round(Math.abs(liquidationPx - markPx) / liquidationPx, 4);
}

function normalizeTransferSide(transfer = {}) {
  const raw = toText(transfer?.side || transfer?.direction).toLowerCase();
  if (raw === 'sell') return 'sell';
  if (raw === 'buy') return 'buy';
  return 'unknown';
}

function isExchangeTouch(transfer = {}) {
  const fields = [
    transfer?.walletAddress,
    transfer?.counterparty,
    transfer?.address,
    transfer?.to,
    transfer?.from,
  ];
  return fields.some((field) => KNOWN_EXCHANGE_ADDRESSES.has(toText(field).toLowerCase()));
}

function resolveTransferCoin(transfer = {}) {
  return normalizeCoin(transfer?.symbol || transfer?.token || transfer?.coin || transfer?.ticker);
}

function computeWhaleExchangeFlow(coin, transfers = []) {
  const relevant = (Array.isArray(transfers) ? transfers : []).filter((transfer) => resolveTransferCoin(transfer) === coin);
  if (relevant.length === 0) {
    return {
      score: 0,
      buyUsd: 0,
      sellUsd: 0,
      exchangeTouches: 0,
      transferCount: 0,
    };
  }

  let buyUsd = 0;
  let sellUsd = 0;
  let exchangeTouches = 0;
  for (const transfer of relevant) {
    const usdValue = Math.max(0, toNumber(transfer?.usdValue ?? transfer?.valueUsd ?? transfer?.value_usd, 0));
    const side = normalizeTransferSide(transfer);
    if (side === 'sell') {
      sellUsd += usdValue;
    } else if (side === 'buy') {
      buyUsd += usdValue;
    }
    if (isExchangeTouch(transfer)) {
      exchangeTouches += 1;
    }
  }
  const total = buyUsd + sellUsd;
  const rawScore = total > 0 ? ((buyUsd - sellUsd) / total) : 0;
  const exchangeWeight = relevant.length > 0 ? (exchangeTouches / relevant.length) : 0;
  return {
    score: round(rawScore * (0.7 + (exchangeWeight * 0.3)), 4) || 0,
    buyUsd: round(buyUsd, 2) || 0,
    sellUsd: round(sellUsd, 2) || 0,
    exchangeTouches,
    transferCount: relevant.length,
  };
}

function resolvePriceOiDivergence(priceChange24hPct, openInterestChange24hPct) {
  if (!Number.isFinite(priceChange24hPct) || !Number.isFinite(openInterestChange24hPct)) {
    return {
      label: 'insufficient_oi_history',
      bias: 'neutral',
    };
  }
  if (priceChange24hPct > 0 && openInterestChange24hPct > 0) {
    return { label: 'trend_supported', bias: 'bullish' };
  }
  if (priceChange24hPct > 0 && openInterestChange24hPct < 0) {
    return { label: 'short_covering_rally', bias: 'bearish' };
  }
  if (priceChange24hPct < 0 && openInterestChange24hPct > 0) {
    return { label: 'fresh_shorts_pressing', bias: 'bearish' };
  }
  if (priceChange24hPct < 0 && openInterestChange24hPct < 0) {
    return { label: 'long_liquidation_flush', bias: 'bullish' };
  }
  return {
    label: 'flat',
    bias: 'neutral',
  };
}

function buildReasons(context = {}) {
  const reasons = [];
  const {
    fundingRateBps,
    predictedFundingRateBps,
    priceChange24hPct,
    openInterestChange24hPct,
    priceOiDivergence,
    whaleExchangeFlow,
    positionLiquidationDistancePct,
  } = context;

  if (Math.abs(toNumber(fundingRateBps, 0)) >= 0.1) {
    reasons.push(`Funding is ${fundingRateBps > 0 ? '+' : ''}${round(fundingRateBps, 3)} bps on Hyperliquid.`);
  }
  if (Number.isFinite(predictedFundingRateBps) && Math.abs(predictedFundingRateBps - fundingRateBps) >= 0.05) {
    reasons.push(`Predicted funding is diverging to ${predictedFundingRateBps > 0 ? '+' : ''}${round(predictedFundingRateBps, 3)} bps.`);
  }
  if (Number.isFinite(priceChange24hPct) && Number.isFinite(openInterestChange24hPct)) {
    reasons.push(`Price/OI pattern is ${priceOiDivergence.label} (${round(priceChange24hPct * 100, 2)}% price, ${round(openInterestChange24hPct * 100, 2)}% OI).`);
  } else if (Number.isFinite(priceChange24hPct)) {
    reasons.push(`Price is ${round(priceChange24hPct * 100, 2)}% vs the previous day close.`);
  }
  if (Math.abs(toNumber(whaleExchangeFlow?.score, 0)) >= 0.2) {
    reasons.push(`Recent whale flow leans ${whaleExchangeFlow.score > 0 ? 'net buying' : 'net selling'}.`);
  }
  if (Number.isFinite(positionLiquidationDistancePct) && positionLiquidationDistancePct <= 0.2) {
    reasons.push(`Live position liquidation distance is only ${round(positionLiquidationDistancePct * 100, 2)}%.`);
  }
  return reasons.slice(0, 4);
}

function resolveMechanicalBias(context = {}) {
  const {
    fundingRate = 0,
    predictedFundingRate = null,
    priceChange24hPct = 0,
    openInterestChange24hPct = null,
    whaleExchangeFlowScore = 0,
    priceOiDivergence = { bias: 'neutral' },
  } = context;

  let biasScore = 0;
  biasScore += clamp(priceChange24hPct / 0.05, -1, 1) * 0.35;
  biasScore += clamp(-fundingRate / 0.00003, -1, 1) * 0.25;
  if (Number.isFinite(predictedFundingRate)) {
    biasScore += clamp(-predictedFundingRate / 0.00004, -1, 1) * 0.15;
  }
  biasScore += clamp(whaleExchangeFlowScore, -1, 1) * 0.2;

  if (priceOiDivergence.bias === 'bullish') {
    biasScore += 0.15;
  } else if (priceOiDivergence.bias === 'bearish') {
    biasScore -= 0.15;
  }

  if (Number.isFinite(openInterestChange24hPct) && Math.abs(openInterestChange24hPct) >= 0.08) {
    biasScore += clamp(openInterestChange24hPct / 0.2, -1, 1) * 0.05;
  }

  const clamped = clamp(biasScore, -1, 1);
  if (clamped >= 0.2) {
    return { label: 'bullish', score: round(clamped, 4) };
  }
  if (clamped <= -0.2) {
    return { label: 'bearish', score: round(clamped, 4) };
  }
  return { label: 'neutral', score: round(clamped, 4) };
}

function resolveTradeFlag(context = {}) {
  const biasScore = Math.abs(toNumber(context?.mechanicalBias?.score, 0));
  const maxRisk = Math.max(
    toNumber(context?.squeezeRiskScore, 0),
    toNumber(context?.overcrowdingScore, 0),
    toNumber(context?.cascadeRiskScore, 0)
  );
  const dataCompleteness = toNumber(context?.dataCompleteness, 0);

  if (biasScore >= 0.65 && maxRisk >= 60) {
    return 'trade';
  }
  if (biasScore >= 0.3 || maxRisk >= 45 || dataCompleteness < 0.5) {
    return 'watch';
  }
  return 'no-trade';
}

async function buildCryptoMechBoard(options = {}) {
  const symbols = Array.from(new Set((Array.isArray(options.symbols) ? options.symbols : []).map(normalizeTicker).filter(Boolean)));
  const statePath = options.statePath || DEFAULT_CRYPTO_MECH_BOARD_STATE_PATH;
  const resolvedNowMs = options.nowMs != null
    ? toNumber(options.nowMs, Date.now())
    : (options.now ? new Date(options.now).getTime() : Date.now());
  const nowMs = Number.isFinite(resolvedNowMs) ? resolvedNowMs : Date.now();
  const nowIso = toIsoTimestamp(options.now || new Date(nowMs), new Date(nowMs).toISOString());
  const targetLookbackMs = Math.max(60 * 60 * 1000, toNumber(options.targetLookbackMs, TARGET_LOOKBACK_MS));
  const historyToleranceMs = Math.max(30 * 60 * 1000, toNumber(options.historyToleranceMs, LOOKBACK_TOLERANCE_MS));

  if (symbols.length === 0) {
    return {
      venue: 'hyperliquid',
      asOf: nowIso,
      symbols: {},
      sourceNotes: {
        liquidationClusters: 'unavailable_from_hyperliquid_public_api',
      },
    };
  }

  const coins = symbols.map((ticker) => hyperliquidClient.normalizeCoinSymbol(ticker)).filter(Boolean);
  const client = hyperliquidClient.createInfoClient(options);
  const [metaAndAssetCtxs, predictedFundings, fundingHistories] = await Promise.all([
    options.metaAndAssetCtxs || client.metaAndAssetCtxs().catch(() => [null, []]),
    options.predictedFundings || client.predictedFundings().catch(() => []),
    Promise.all(coins.map(async (coin) => {
      if (options.fundingHistoryByCoin?.[coin]) {
        return [coin, normalizeFundingHistory(options.fundingHistoryByCoin[coin])];
      }
      const history = await client.fundingHistory({
        coin,
        startTime: nowMs - targetLookbackMs,
        endTime: nowMs,
      }).catch(() => []);
      return [coin, normalizeFundingHistory(history)];
    })),
  ]);

  const ctxByCoin = buildCtxByCoin(metaAndAssetCtxs);
  const predictedByCoin = buildPredictedFundingByCoin(predictedFundings);
  const fundingHistoryByCoin = new Map(fundingHistories);
  const boardState = readBoardState(statePath);
  const nextHistory = { ...boardState.history };
  const resultSymbols = {};

  for (const ticker of symbols) {
    const coin = hyperliquidClient.normalizeCoinSymbol(ticker);
    const ctx = ctxByCoin.get(coin) || {};
    const history = fundingHistoryByCoin.get(coin) || [];
    const predictedFunding = predictedByCoin.get(coin)?.HlPerp || null;
    const fundingRate = toNumber(ctx?.funding, 0);
    const predictedFundingRate = predictedFunding ? toNumber(predictedFunding?.fundingRate, fundingRate) : null;
    const fundingRateBps = round(fundingRate * 10_000, 4);
    const predictedFundingRateBps = Number.isFinite(predictedFundingRate)
      ? round(predictedFundingRate * 10_000, 4)
      : null;
    const fundingRate24hAvg = history.length > 0
      ? round(history.reduce((sum, entry) => sum + toNumber(entry.fundingRate, 0), 0) / history.length, 8)
      : null;
    const fundingRateChange24h = history.length > 0
      ? round(fundingRate - toNumber(history[0]?.fundingRate, fundingRate), 8)
      : null;
    const openInterest = toNumber(ctx?.openInterest, 0);
    const prevDayPx = toNumber(ctx?.prevDayPx, 0);
    const markPx = resolveCurrentPrice(ticker, ctx, options.snapshots);
    const openInterestUsd = markPx > 0 ? round(openInterest * markPx, 2) : null;
    const dayNtlVlm = toNumber(ctx?.dayNtlVlm, 0);
    const openInterestToVolumeRatio = dayNtlVlm > 0 && Number.isFinite(openInterestUsd)
      ? round(openInterestUsd / dayNtlVlm, 4)
      : null;
    const priceChange24hPct = pctChange(markPx, prevDayPx);
    const premium = toNumber(ctx?.premium, 0);
    const impactPxs = Array.isArray(ctx?.impactPxs) ? ctx.impactPxs.map((value) => toNumber(value, 0)).filter((value) => value > 0) : [];
    const impactSpreadBps = impactPxs.length >= 2 && markPx > 0
      ? round((Math.abs(impactPxs[1] - impactPxs[0]) / markPx) * 10_000, 4)
      : null;
    const previousHistory = Array.isArray(boardState.history?.[coin]) ? boardState.history[coin] : [];
    const lookbackPoint = findLookbackSample(previousHistory, nowMs - targetLookbackMs, historyToleranceMs);
    const openInterestChange24h = lookbackPoint
      ? round(openInterest - toNumber(lookbackPoint.openInterest, openInterest), 4)
      : null;
    const openInterestChange24hPct = lookbackPoint
      ? pctChange(openInterest, toNumber(lookbackPoint.openInterest, openInterest))
      : null;
    const priceOiDivergence = resolvePriceOiDivergence(priceChange24hPct, openInterestChange24hPct);
    const whaleExchangeFlow = computeWhaleExchangeFlow(coin, options.whaleTransfers || []);
    const whaleExchangeFlowScore = whaleExchangeFlow.score;
    const livePosition = findMatchingDefiPosition(coin, options.defiStatus);
    const positionLiquidationDistancePct = computePositionLiquidationDistancePct(livePosition, markPx);

    const fundingCrowdingFactor = clamp(Math.abs(fundingRate) / 0.00003);
    const predictedCrowdingFactor = Number.isFinite(predictedFundingRate)
      ? clamp(Math.abs(predictedFundingRate) / 0.00005)
      : 0;
    const oiPressureFactor = Number.isFinite(openInterestToVolumeRatio)
      ? clamp(openInterestToVolumeRatio / 0.6)
      : 0;
    const oiChangeFactor = Number.isFinite(openInterestChange24hPct)
      ? clamp(Math.abs(openInterestChange24hPct) / 0.2)
      : 0;
    const priceMoveFactor = Number.isFinite(priceChange24hPct)
      ? clamp(Math.abs(priceChange24hPct) / 0.06)
      : 0;
    const impactFactor = Number.isFinite(impactSpreadBps)
      ? clamp(impactSpreadBps / 1.5)
      : 0;
    const liquidationFactor = Number.isFinite(positionLiquidationDistancePct)
      ? clamp((0.2 - positionLiquidationDistancePct) / 0.2)
      : 0;
    const whaleAbsFactor = clamp(Math.abs(whaleExchangeFlowScore));
    const fundingDriftFactor = Number.isFinite(predictedFundingRate)
      ? clamp(Math.abs(predictedFundingRate - fundingRate) / 0.00004)
      : 0;

    const overcrowdingScore = score(
      (fundingCrowdingFactor * 0.35)
      + (predictedCrowdingFactor * 0.15)
      + (oiPressureFactor * 0.25)
      + (oiChangeFactor * 0.15)
      + (whaleAbsFactor * 0.1)
    );
    const squeezeRiskScore = score(
      (fundingCrowdingFactor * 0.35)
      + (fundingDriftFactor * 0.2)
      + (impactFactor * 0.2)
      + (whaleAbsFactor * 0.15)
      + (priceMoveFactor * 0.1)
    );
    const cascadeRiskScore = score(
      (oiPressureFactor * 0.25)
      + (oiChangeFactor * 0.2)
      + (priceMoveFactor * 0.2)
      + (impactFactor * 0.15)
      + (liquidationFactor * 0.15)
      + (whaleAbsFactor * 0.05)
    );
    const dataCompleteness = round(
      (
        1
        + (history.length > 0 ? 1 : 0)
        + (Number.isFinite(predictedFundingRate) ? 1 : 0)
        + (Number.isFinite(openInterestChange24hPct) ? 1 : 0)
      ) / 4,
      4
    );
    const mechanicalBias = resolveMechanicalBias({
      fundingRate,
      predictedFundingRate,
      priceChange24hPct,
      openInterestChange24hPct,
      whaleExchangeFlowScore,
      priceOiDivergence,
    });
    const tradeFlag = resolveTradeFlag({
      mechanicalBias,
      squeezeRiskScore,
      overcrowdingScore,
      cascadeRiskScore,
      dataCompleteness,
    });
    const rationale = buildReasons({
      fundingRateBps,
      predictedFundingRateBps,
      priceChange24hPct,
      openInterestChange24hPct,
      priceOiDivergence,
      whaleExchangeFlow,
      positionLiquidationDistancePct,
    });

    resultSymbols[ticker] = {
      ticker,
      coin,
      markPx: round(markPx, 6),
      prevDayPx: round(prevDayPx, 6),
      priceChange24hPct,
      fundingRate: round(fundingRate, 8),
      fundingRateBps,
      fundingRate24hAvg: fundingRate24hAvg == null ? null : round(fundingRate24hAvg, 8),
      fundingRateChange24h,
      fundingRateChange24hBps: fundingRateChange24h == null ? null : round(fundingRateChange24h * 10_000, 4),
      predictedFundingRate: Number.isFinite(predictedFundingRate) ? round(predictedFundingRate, 8) : null,
      predictedFundingRateBps,
      predictedFundingNextAt: predictedFunding?.nextFundingTime ? toIsoTimestamp(predictedFunding.nextFundingTime, null) : null,
      openInterest: round(openInterest, 4),
      openInterestUsd,
      openInterestToVolumeRatio,
      openInterestChange24h,
      openInterestChange24hPct,
      priceOiDivergence,
      dayNtlVlm: round(dayNtlVlm, 2),
      premium: round(premium, 8),
      impactSpreadBps,
      liquidationClusterProximity: null,
      liquidationClusterSource: 'unavailable_from_hyperliquid_public_api',
      positionLiquidationDistancePct,
      whaleExchangeFlowScore,
      whaleExchangeFlowBuyUsd: whaleExchangeFlow.buyUsd,
      whaleExchangeFlowSellUsd: whaleExchangeFlow.sellUsd,
      whaleExchangeTransferCount: whaleExchangeFlow.transferCount,
      squeezeRiskScore,
      overcrowdingScore,
      cascadeRiskScore,
      mechanicalDirectionBias: mechanicalBias.label,
      mechanicalBiasScore: mechanicalBias.score,
      tradeFlag,
      dataCompleteness,
      rationale,
    };

    nextHistory[coin] = appendHistoryPoint(previousHistory, {
      recordedAt: nowIso,
      fundingRate,
      markPx,
      openInterest,
    }, {
      retentionMs: options.historyRetentionMs,
    });
  }

  writeBoardState(statePath, {
    updatedAt: nowIso,
    history: nextHistory,
  });

  return {
    venue: 'hyperliquid',
    asOf: nowIso,
    symbols: resultSymbols,
    sourceNotes: {
      funding: 'hyperliquid_info.metaAndAssetCtxs + fundingHistory + predictedFundings',
      openInterest: 'hyperliquid_info.metaAndAssetCtxs + local_history_cache',
      liquidationClusters: 'unavailable_from_hyperliquid_public_api',
      whaleFlow: 'smart_money_scanner_recent_transfers',
    },
  };
}

module.exports = {
  DEFAULT_CRYPTO_MECH_BOARD_STATE_PATH,
  appendHistoryPoint,
  buildCryptoMechBoard,
  computeWhaleExchangeFlow,
  defaultBoardState,
  normalizeBoardState,
  readBoardState,
  resolvePriceOiDivergence,
  writeBoardState,
};
