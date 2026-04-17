#!/usr/bin/env node
'use strict';

const hyperliquidClient = require('../modules/trading/hyperliquid-client');

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function sortByAbsFunding(entries = []) {
  return entries.slice().sort((left, right) => Math.abs(toNumber(right.fundingBps, 0)) - Math.abs(toNumber(left.fundingBps, 0)));
}

function isFiniteNumber(value) {
  return value != null && Number.isFinite(Number(value));
}

function collectVenueFundingBps(funding = {}) {
  const venues = funding?.venues || {};
  const toBps = (...venueNames) => {
    const matchedVenue = venueNames.find((venueName) => venues?.[venueName]?.fundingRate != null);
    const rate = toNumber(matchedVenue ? venues[matchedVenue].fundingRate : undefined, NaN);
    return Number.isFinite(rate) ? rate * 10_000 : null;
  };
  return {
    HlPerp: round(toBps('HlPerp'), 4),
    Binance: round(toBps('BinPerp', 'Binance'), 4),
    Bybit: round(toBps('BybitPerp', 'Bybit'), 4),
  };
}

function buildFundingExtremes(predictedFundingSnapshot = {}, universeMarketData = []) {
  const byCoin = predictedFundingSnapshot?.byCoin || {};
  const marketByCoin = new Map(
    (Array.isArray(universeMarketData) ? universeMarketData : [])
      .map((entry) => [String(entry?.coin || '').trim().toUpperCase(), entry])
  );

  const rows = Object.entries(byCoin).map(([coin, funding]) => {
    const market = marketByCoin.get(String(coin || '').trim().toUpperCase()) || {};
    const fundingRate = toNumber(funding?.fundingRate, NaN);
    const fundingBps = Number.isFinite(fundingRate) ? fundingRate * 10_000 : null;
    const dayNtlVlm = toNumber(market.volumeUsd24h, 0);
    const openInterest = toNumber(market.openInterest, 0);
    return {
      coin,
      fundingRate: round(fundingRate, 8),
      fundingBps: round(fundingBps, 4),
      predictedFundingNextAt: funding?.nextFundingTime || null,
      openInterest: round(openInterest, 4),
      dayNtlVlm: round(dayNtlVlm, 4),
      openInterestToVolume: dayNtlVlm > 0 ? round(openInterest / dayNtlVlm, 4) : null,
      premium: round(market.premium, 8),
      oraclePx: round(market.oraclePx, 8),
      markPx: round(market.markPx, 8),
    };
  }).filter((entry) => Number.isFinite(toNumber(entry.fundingBps, NaN)));

  return {
    topAbs: sortByAbsFunding(rows).slice(0, 20),
    topPositive: rows.filter((entry) => toNumber(entry.fundingBps, 0) > 0).sort((a, b) => toNumber(b.fundingBps, 0) - toNumber(a.fundingBps, 0)).slice(0, 20),
    topNegative: rows.filter((entry) => toNumber(entry.fundingBps, 0) < 0).sort((a, b) => toNumber(a.fundingBps, 0) - toNumber(b.fundingBps, 0)).slice(0, 20),
  };
}

function buildCrossVenueFundingExtremes(predictedFundingSnapshot = {}, universeMarketData = []) {
  const byCoin = predictedFundingSnapshot?.byCoin || {};
  const marketByCoin = new Map(
    (Array.isArray(universeMarketData) ? universeMarketData : [])
      .map((entry) => [String(entry?.coin || '').trim().toUpperCase(), entry])
  );
  const rows = Object.entries(byCoin).map(([coin, funding]) => {
    const market = marketByCoin.get(String(coin || '').trim().toUpperCase()) || {};
    const venueBps = collectVenueFundingBps(funding);
    const available = Object.entries(venueBps).filter(([, value]) => isFiniteNumber(value));
    if (available.length < 2) return null;
    const sorted = available.slice().sort((left, right) => toNumber(left[1], 0) - toNumber(right[1], 0));
    const lowest = sorted[0];
    const highest = sorted[sorted.length - 1];
    const hlFundingBps = isFiniteNumber(venueBps.HlPerp) ? venueBps.HlPerp : null;
    const vsHl = available
      .filter(([venue]) => venue !== 'HlPerp' && hlFundingBps != null)
      .map(([venue, value]) => ({
        venue,
        venueFundingBps: value,
        spreadBps: round(hlFundingBps - value, 4),
        absoluteSpreadBps: round(Math.abs(hlFundingBps - value), 4),
      }))
      .sort((a, b) => toNumber(b.absoluteSpreadBps, 0) - toNumber(a.absoluteSpreadBps, 0));
    const strongestVsHl = vsHl[0] || null;
    return {
      coin,
      hlFundingBps: venueBps.HlPerp,
      binanceFundingBps: venueBps.Binance,
      bybitFundingBps: venueBps.Bybit,
      basisSpreadBps: round(Math.abs(toNumber(highest[1], 0) - toNumber(lowest[1], 0)), 4),
      strongestVsHl,
      premium: round(market.premium, 8),
      openInterest: round(market.openInterest, 4),
      dayNtlVlm: round(market.volumeUsd24h, 4),
      openInterestToVolume: toNumber(market.volumeUsd24h, 0) > 0 ? round(toNumber(market.openInterest, 0) / toNumber(market.volumeUsd24h, 0), 4) : null,
    };
  }).filter(Boolean);

  return rows
    .sort((a, b) => toNumber(b.strongestVsHl?.absoluteSpreadBps ?? b.basisSpreadBps, 0) - toNumber(a.strongestVsHl?.absoluteSpreadBps ?? a.basisSpreadBps, 0))
    .slice(0, 20);
}

function buildCrowdingExtremes(universeMarketData = []) {
  const rows = (Array.isArray(universeMarketData) ? universeMarketData : []).map((entry) => ({
    coin: entry.coin,
    markPx: round(entry.markPx, 8),
    premium: round(entry.premium, 8),
    openInterest: round(entry.openInterest, 4),
    dayNtlVlm: round(entry.volumeUsd24h, 4),
    openInterestToVolume: toNumber(entry.volumeUsd24h, 0) > 0
      ? round(toNumber(entry.openInterest, 0) / toNumber(entry.volumeUsd24h, 0), 4)
      : null,
  })).filter((entry) => Number.isFinite(toNumber(entry.openInterestToVolume, NaN)));

  return rows.sort((a, b) => toNumber(b.openInterestToVolume, 0) - toNumber(a.openInterestToVolume, 0)).slice(0, 20);
}

function buildDexSummary(perpDexs = []) {
  return (Array.isArray(perpDexs) ? perpDexs : [])
    .filter(Boolean)
    .map((entry) => ({
      name: entry.name || null,
      fullName: entry.fullName || null,
      deployer: entry.deployer || null,
      feeRecipient: entry.feeRecipient || null,
      assetCount: Array.isArray(entry.assetToStreamingOiCap) ? entry.assetToStreamingOiCap.length : 0,
      nonZeroFundingMultipliers: Array.isArray(entry.assetToFundingMultiplier)
        ? entry.assetToFundingMultiplier.filter(([, value]) => Math.abs(toNumber(value, 0)) > 0).length
        : 0,
      nonZeroFundingInterestRates: Array.isArray(entry.assetToFundingInterestRate)
        ? entry.assetToFundingInterestRate.filter(([, value]) => Math.abs(toNumber(value, 0)) > 0).length
        : 0,
    }));
}

async function main() {
  const walletAddress = hyperliquidClient.resolveWalletAddress(process.env) || null;
  const [
    predictedFundingSnapshot,
    universeMarketData,
    perpDexs,
    perpsAtOpenInterestCap,
    userVaultEquities,
    portfolio,
    vaultSummaries,
  ] = await Promise.all([
    hyperliquidClient.getPredictedFundings().catch((error) => ({ error: error.message })),
    hyperliquidClient.getUniverseMarketData().catch((error) => ({ error: error.message })),
    hyperliquidClient.postInfoRequest({ type: 'perpDexs' }).catch((error) => ({ error: error.message })),
    hyperliquidClient.postInfoRequest({ type: 'perpsAtOpenInterestCap' }).catch((error) => ({ error: error.message })),
    walletAddress
      ? hyperliquidClient.getUserVaultEquities({ walletAddress }).catch((error) => ({ error: error.message }))
      : Promise.resolve({ skipped: true, reason: 'missing_wallet_address' }),
    walletAddress
      ? hyperliquidClient.postInfoRequest({ type: 'portfolio', user: walletAddress }).catch((error) => ({ error: error.message }))
      : Promise.resolve({ skipped: true, reason: 'missing_wallet_address' }),
    hyperliquidClient.postInfoRequest({ type: 'vaultSummaries' }).catch((error) => ({ error: error.message })),
  ]);

  const output = {
    generatedAt: new Date().toISOString(),
    walletAddress,
    officialSources: {
      docsInfoEndpoint: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint',
      docsWebsocketSubscriptions: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions',
      apiBase: 'https://api.hyperliquid.xyz/info',
    },
    fundingExtremes: Array.isArray(universeMarketData)
      ? buildFundingExtremes(predictedFundingSnapshot, universeMarketData)
      : { error: universeMarketData?.error || 'universe_market_data_unavailable' },
    crossVenueFundingExtremes: Array.isArray(universeMarketData)
      ? buildCrossVenueFundingExtremes(predictedFundingSnapshot, universeMarketData)
      : { error: universeMarketData?.error || 'universe_market_data_unavailable' },
    crowdingExtremes: Array.isArray(universeMarketData)
      ? buildCrowdingExtremes(universeMarketData)
      : { error: universeMarketData?.error || 'universe_market_data_unavailable' },
    openInterestCaps: Array.isArray(perpsAtOpenInterestCap) ? perpsAtOpenInterestCap : { error: perpsAtOpenInterestCap?.error || 'oi_cap_query_failed' },
    perpDexs: Array.isArray(perpDexs) ? buildDexSummary(perpDexs) : { error: perpDexs?.error || 'perp_dex_query_failed' },
    userVaultEquities,
    portfolio,
    vaultSurface: {
      vaultSummariesCount: Array.isArray(vaultSummaries) ? vaultSummaries.length : null,
      vaultSummariesPreview: Array.isArray(vaultSummaries) ? vaultSummaries.slice(0, 10) : null,
      note: Array.isArray(vaultSummaries) && vaultSummaries.length === 0
        ? 'Official vaultSummaries query currently returns an empty array; treat public vault leaderboard claims carefully until a confirmed source is identified.'
        : null,
      error: vaultSummaries?.error || null,
    },
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
