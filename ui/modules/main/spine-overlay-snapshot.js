'use strict';

const fs = require('fs');
const path = require('path');
const { evaluate, normalizeSource, THRESHOLDS } = require('../the-tell/scorer');
const { fetchTrustQuoteReadOnlySignals } = require('./trustquote-tell-feed');

const DEFAULT_THRESHOLD = THRESHOLDS.SPEAK;
const LIVE_MAX_AGE_MS = 5 * 60 * 1000;
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, '.squidrun', 'runtime');
const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const TRADING_PARKED_REASON = 'parked_by_user';
const SUPPORTED_SIGNAL_TYPES = new Set([
  'trustquote:job-margin',
  'trustquote:invoice-aging',
  'promise:collision',
]);

const RUNTIME_PATHS = Object.freeze({
  supervisor: path.join(RUNTIME_ROOT, 'crypto-trading-supervisor-state.json'),
  attribution: path.join(RUNTIME_ROOT, 'agent-position-attribution.json'),
  native: path.join(RUNTIME_ROOT, 'hyperliquid-native-state.json'),
  manualStops: path.join(RUNTIME_ROOT, 'manual-stop-overrides.json'),
});

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'missing_file', filePath };
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, filePath, data: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, reason: error.message || 'read_failed', filePath };
  }
}

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function parseTimestampMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageMs(value, nowMs = Date.now()) {
  const timestampMs = parseTimestampMs(value);
  return Number.isFinite(timestampMs) ? Math.max(0, nowMs - timestampMs) : null;
}

function formatUsd(value) {
  const numeric = toNumber(value, null);
  if (numeric === null) return 'unknown';
  return `$${numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function extractSupervisorAccount(supervisorData) {
  return supervisorData?.lastResult?.preMarket?.accountSnapshot || null;
}

function extractSupervisorPositions(supervisorData) {
  const positions = extractSupervisorAccount(supervisorData)?.raw?.mainState?.assetPositions;
  return Array.isArray(positions) ? positions : [];
}

function extractSupervisorCheckedAt(supervisorData) {
  return supervisorData?.lastProcessedAt || supervisorData?.updatedAt || supervisorData?.lastResult?.asOf || null;
}

function extractAttributionPositions(attributionData) {
  const rawPositions = attributionData?.positions;
  if (!rawPositions || typeof rawPositions !== 'object') return [];
  return Object.values(rawPositions).filter((position) => {
    if (!position || typeof position !== 'object') return false;
    if (position.closedAt) return false;
    if (position.quarantineReason) return false;
    return Math.abs(toNumber(position.currentSize, 0) || 0) > 0;
  });
}

function extractWalletAddress(...sources) {
  const envWallet = toText(process.env.LIVE_OPS_WALLET_ADDRESS || process.env.HYPERLIQUID_WALLET_ADDRESS, '');
  if (envWallet) return envWallet;
  for (const source of sources) {
    const states = source?.lastResult?.preMarket?.accountSnapshot?.raw?.states;
    if (Array.isArray(states)) {
      const found = states.find((state) => toText(state?.walletAddress, ''));
      if (found?.walletAddress) return found.walletAddress;
    }
    const positions = source?.positions;
    if (positions && typeof positions === 'object') {
      const found = Object.values(positions).find((position) => toText(position?.walletAddress, ''));
      if (found?.walletAddress) return found.walletAddress;
    }
  }
  return null;
}

function coinToTicker(coin) {
  const text = toText(coin, 'UNKNOWN');
  return /\/USD$/i.test(text) ? text : `${text}/USD`;
}

function normalizeHlPosition(assetPosition) {
  const position = assetPosition?.position || assetPosition;
  if (!position || typeof position !== 'object') return null;
  const szi = toNumber(position.szi, null);
  if (!Number.isFinite(szi) || szi === 0) return null;
  return {
    coin: toText(position.coin, 'UNKNOWN'),
    szi,
    entryPx: toNumber(position.entryPx, null),
    liquidationPx: toNumber(position.liquidationPx, null),
    markPx: toNumber(position.markPx, null),
    unrealizedPnl: toNumber(position.unrealizedPnl, null),
    positionValue: toNumber(position.positionValue, null),
    leverage: position.leverage,
  };
}

function extractHlPositions(accountState) {
  const positions = accountState?.assetPositions || accountState?.mainState?.assetPositions || [];
  return Array.isArray(positions) ? positions.map(normalizeHlPosition).filter(Boolean) : [];
}

function extractAccountValue(accountState) {
  return toNumber(
    accountState?.marginSummary?.accountValue
      ?? accountState?.crossMarginSummary?.accountValue
      ?? accountState?.accountValue
      ?? accountState?.equity,
    null,
  );
}

function extractMarkByCoin(allMids = {}) {
  const markByCoin = {};
  if (!allMids || typeof allMids !== 'object') return markByCoin;
  for (const [coin, value] of Object.entries(allMids)) {
    const mark = toNumber(value, null);
    if (mark !== null) markByCoin[coin] = mark;
  }
  return markByCoin;
}

function orderTriggerPx(order) {
  return toNumber(order?.triggerPx ?? order?.orderType?.trigger?.triggerPx, null);
}

function isReduceOnlyTrigger(order) {
  return Boolean(order?.reduceOnly || order?.isTrigger || order?.orderType?.trigger);
}

function extractStopByCoin(openOrders = [], manualStopData = {}) {
  const stopByCoin = {};
  const overrides = manualStopData?.overrides || manualStopData || {};
  if (overrides && typeof overrides === 'object') {
    for (const [coin, value] of Object.entries(overrides)) {
      const stop = toNumber(value?.stop ?? value?.triggerPx ?? value, null);
      if (stop !== null) stopByCoin[coin.replace(/\/USD$/i, '')] = stop;
    }
  }
  if (!Array.isArray(openOrders)) return stopByCoin;
  for (const order of openOrders) {
    if (!isReduceOnlyTrigger(order)) continue;
    const coin = toText(order.coin, '');
    const stop = orderTriggerPx(order);
    if (coin && stop !== null) stopByCoin[coin] = stop;
  }
  return stopByCoin;
}

function buildQuietArtifact({ trustQuoteRead, activeSignalCount, sourceKind }) {
  const checkedAt = trustQuoteRead?.checkedAt || null;
  const source = trustQuoteRead?.root || 'configured work/life feeds';
  return {
    regretScore: 0,
    context: 'work-life:none',
    threshold: DEFAULT_THRESHOLD,
    speak: false,
    source: sourceKind || (trustQuoteRead?.ok === true ? 'live' : 'unverified'),
    mode: 'read_only_overlay',
    claim: 'No interrupt earned.',
    whyNow: activeSignalCount > 0
      ? 'Verified work/life facts are present, but the scorer withheld speech. Trading is parked.'
      : 'No verified work/life signal crossed threshold. Trading is parked; The Tell is watching jobs, invoices, and promises only.',
    receipts: [
      { label: 'active work/life signals', value: String(activeSignalCount || 0), source },
      { label: 'trading feed', value: 'PARKED', source: 'James directive' },
      { label: 'checked', value: checkedAt || 'unknown', source },
    ],
    proposedAction: {
      text: 'Stay quiet. Keep watching read-only status.',
      reversible: true,
      executionMode: 'dry-run',
    },
  };
}

function normalizeEmission(emission, fallbackArtifact) {
  const proposedAction = {
    ...(emission.proposedAction || fallbackArtifact.proposedAction || {}),
    reversible: true,
    executionMode: 'dry-run',
  };
  return {
    regretScore: toNumber(emission.regretScore, fallbackArtifact.regretScore),
    context: emission.context || fallbackArtifact.context,
    threshold: DEFAULT_THRESHOLD,
    speak: emission.speak === true,
    source: emission.source || fallbackArtifact.source || 'live',
    mode: 'read_only_overlay',
    claim: emission.claim || fallbackArtifact.claim,
    whyNow: emission.whyNow || fallbackArtifact.whyNow,
    receipts: Array.isArray(emission.receipts) ? emission.receipts : fallbackArtifact.receipts,
    proposedAction,
    pushback: emission.pushback || fallbackArtifact.pushback,
  };
}

function buildAttributionSwallowed(attributionRead, nowMs) {
  if (!attributionRead.ok) {
    return [{
      signal: 'position_attribution',
      reason: `silent: ${attributionRead.reason || 'runtime file unavailable'}`,
      regretScore: 0.1,
      wouldHaveSaid: 'Position attribution unavailable; refusing to invent an open-position claim.',
    }];
  }
  const positions = Object.values(attributionRead.data?.positions || {});
  const staleOpen = positions.filter((position) => {
    if (!position || typeof position !== 'object') return false;
    if (position.closedAt) return false;
    return Math.abs(toNumber(position.currentSize, 0) || 0) > 0;
  });
  if (staleOpen.length === 0) return [];
  return staleOpen.slice(0, 2).map((position) => ({
    signal: `attribution:${coinToTicker(position.ticker || position.coin)}`,
    reason: position.quarantineReason
      ? `rejected: ${position.quarantineReason}`
      : 'rejected: attribution row lacks fresh clearinghouseState confirmation',
    regretScore: 0.14,
    wouldHaveSaid: `${coinToTicker(position.ticker || position.coin)} looked open in attribution, but live proof is required before speaking.`,
    ageMs: ageMs(position.lastLiveSeenAt || position.updatedAt, nowMs),
  }));
}

function buildExecutionSwallowed() {
  return {
    signal: 'autonomous_execution',
    reason: 'blocked by design: overlay is read-only and has no write/send/execute channel',
    regretScore: 1,
    wouldHaveSaid: 'Execution path requested, but v0 only drafts/logs for confirmation.',
  };
}

function buildTradingParkedSwallowed() {
  return {
    signal: 'trading:hyperliquid',
    reason: TRADING_PARKED_REASON,
    regretScore: 0,
    wouldHaveSaid: 'Trading is deliberately outside The Tell active watch set.',
  };
}

function supportedScorerSignals(signals = []) {
  return Array.isArray(signals) ? signals.filter((signal) => SUPPORTED_SIGNAL_TYPES.has(signal?.type)) : [];
}

function deriveFeedSource({ explicitSource, liveRead, trustQuoteRead, trustQuoteSignals, tradingEnabled }) {
  const explicit = toText(explicitSource, '');
  if (explicit) return normalizeSource(explicit);
  if (trustQuoteSignals.length > 0) {
    const allVerifiedLive = trustQuoteRead?.ok === true
      && trustQuoteSignals.every((signal) => normalizeSource(signal?.source) === 'live');
    return allVerifiedLive ? 'live' : 'unverified';
  }
  if (tradingEnabled && liveRead?.ok === true) return 'live';
  return trustQuoteRead?.ok === true ? 'live' : 'unverified';
}

function buildUnsupportedSignalSwallowed(signals = []) {
  if (!Array.isArray(signals)) return [];
  return signals
    .filter((signal) => signal?.type && !SUPPORTED_SIGNAL_TYPES.has(signal.type))
    .slice(0, 4)
    .map((signal) => ({
      signal: signal.type,
      reason: 'held: scorer does not support this signal type yet',
      regretScore: 0,
      wouldHaveSaid: null,
      context: signal.rawRefs?.docId || signal.id || signal.type,
    }));
}

function buildSpineOverlaySnapshot(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const supervisorRead = options.supervisorRead || safeReadJson(RUNTIME_PATHS.supervisor);
  const attributionRead = options.attributionRead || safeReadJson(RUNTIME_PATHS.attribution);
  const nativeRead = options.nativeRead || safeReadJson(RUNTIME_PATHS.native);
  const manualStopsRead = options.manualStopsRead || safeReadJson(RUNTIME_PATHS.manualStops);
  const tradingEnabled = options.enableTradingFeed === true;
  const liveRead = tradingEnabled ? (options.liveRead || null) : null;
  const trustQuoteRead = options.trustQuoteRead || null;
  const trustQuoteSignals = supportedScorerSignals(options.signals || trustQuoteRead?.data?.signals || []);
  const unsupportedSignals = buildUnsupportedSignalSwallowed(options.signals || trustQuoteRead?.data?.signals || []);
  const feedSource = deriveFeedSource({
    explicitSource: options.source,
    liveRead,
    trustQuoteRead,
    trustQuoteSignals,
    tradingEnabled,
  });

  const liveAccountState = liveRead?.data?.clearinghouseState || null;
  const supervisorAccount = extractSupervisorAccount(supervisorRead.data);
  const supervisorCheckedAt = extractSupervisorCheckedAt(supervisorRead.data);
  const supervisorFresh = Number.isFinite(ageMs(supervisorCheckedAt, nowMs)) && ageMs(supervisorCheckedAt, nowMs) <= LIVE_MAX_AGE_MS;
  const accountState = tradingEnabled ? (liveAccountState || (supervisorFresh ? supervisorAccount?.raw?.mainState : null)) : null;
  const positions = extractHlPositions(accountState);
  const accountValue = extractAccountValue(accountState) ?? extractAccountValue(supervisorAccount);
  const markByCoin = {
    ...extractMarkByCoin(nativeRead.data?.allMids || nativeRead.data?.mids),
    ...extractMarkByCoin(liveRead?.data?.allMids),
    ...(options.markByCoin || {}),
  };
  const stopByCoin = {
    ...extractStopByCoin(liveRead?.data?.openOrders, manualStopsRead.data),
    ...(options.stopByCoin || {}),
  };
  const fallbackArtifact = buildQuietArtifact({
    trustQuoteRead,
    activeSignalCount: trustQuoteSignals.length,
    sourceKind: feedSource,
  });

  let emission = {};
  if (positions.length > 0 || trustQuoteSignals.length > 0) {
    emission = evaluate({
      positions,
      signals: trustQuoteSignals,
      accountValue,
      nowMs,
      glanceAtMs: Number.isFinite(Number(options.glanceAtMs)) ? Number(options.glanceAtMs) : nowMs - 30 * 60 * 1000,
      markByCoin,
      stopByCoin,
      priceHistByCoin: options.priceHistByCoin || {},
      state: options.scorerState || {},
      source: feedSource,
    });
  }
  const artifact = normalizeEmission(emission, fallbackArtifact);
  const scorerSwallowed = Array.isArray(emission.swallowed) ? emission.swallowed : [];
  const swallowed = [
    ...scorerSwallowed,
    ...unsupportedSignals,
    buildTradingParkedSwallowed(),
    ...(tradingEnabled ? buildAttributionSwallowed(attributionRead, nowMs) : []),
    buildExecutionSwallowed(),
  ];

  return {
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    surface: 'spine-overlay-v0',
    safety: {
      readOnly: true,
      executionChannels: [],
      note: 'This surface reads configured work/life sources only. Trading is parked. It cannot send messages, charge invoices, modify jobs, or place orders.',
    },
    live: {
      ok: trustQuoteRead?.ok === true || (tradingEnabled && liveRead?.ok === true),
      checkedAt: liveRead?.checkedAt || null,
      positionCount: positions.length,
      tradingParked: !tradingEnabled,
      trustQuoteOk: trustQuoteRead?.ok === true,
      trustQuoteCheckedAt: trustQuoteRead?.checkedAt || null,
      trustQuoteSignalCount: trustQuoteSignals.length,
      parkedTrustQuoteCount: trustQuoteRead?.data?.parkedCount || 0,
      staleLocalCacheRejected: !liveAccountState && !supervisorFresh,
    },
    regretScore: artifact.regretScore,
    context: artifact.context,
    speak: Boolean(artifact.speak),
    source: artifact.source,
    claim: artifact.claim,
    whyNow: artifact.whyNow,
    receipts: artifact.receipts,
    proposedAction: artifact.proposedAction,
    pushback: artifact.pushback,
    artifact,
    swallowed,
    sources: [
      { label: 'trading_hyperliquid', ok: false, path: HYPERLIQUID_INFO_URL, reason: tradingEnabled ? null : TRADING_PARKED_REASON, speakEligible: tradingEnabled },
      ...(tradingEnabled ? [
        { label: 'hl_live_read', ok: liveRead?.ok === true, path: liveRead?.source || HYPERLIQUID_INFO_URL, reason: liveRead?.reason || null },
        { label: 'hl_supervisor_snapshot', ok: supervisorRead.ok, path: supervisorRead.filePath || RUNTIME_PATHS.supervisor, reason: supervisorRead.reason || null, staleRejected: !supervisorFresh },
        { label: 'position_attribution', ok: attributionRead.ok, path: attributionRead.filePath || RUNTIME_PATHS.attribution, reason: attributionRead.reason || null, speakEligible: false },
        { label: 'hl_native_market_state', ok: nativeRead.ok, path: nativeRead.filePath || RUNTIME_PATHS.native, reason: nativeRead.reason || null },
      ] : []),
      { label: 'trustquote_live_read', ok: trustQuoteRead?.ok === true, path: trustQuoteRead?.root || 'D:\\projects\\TrustQuote', reason: trustQuoteRead?.reason || null, parkedCount: trustQuoteRead?.data?.parkedCount || 0 },
    ],
  };
}

async function postHyperliquidInfo(body, { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`hyperliquid_${response.status}:${text.slice(0, 160)}`);
    return JSON.parse(text);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchHyperliquidReadOnlySnapshot(options = {}) {
  const supervisorRead = options.supervisorRead || safeReadJson(RUNTIME_PATHS.supervisor);
  const attributionRead = options.attributionRead || safeReadJson(RUNTIME_PATHS.attribution);
  const walletAddress = options.walletAddress || extractWalletAddress(supervisorRead.data, attributionRead.data);
  if (!walletAddress) return { ok: false, reason: 'wallet_address_unavailable', checkedAt: new Date().toISOString() };
  try {
    const [clearinghouseState, allMids, openOrders] = await Promise.all([
      postHyperliquidInfo({ type: 'clearinghouseState', user: walletAddress }, options),
      postHyperliquidInfo({ type: 'allMids' }, options),
      postHyperliquidInfo({ type: 'openOrders', user: walletAddress }, options),
    ]);
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      source: HYPERLIQUID_INFO_URL,
      walletAddress,
      data: { clearinghouseState, allMids, openOrders },
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt: new Date().toISOString(),
      source: HYPERLIQUID_INFO_URL,
      walletAddress,
      reason: error.message || 'hyperliquid_read_failed',
    };
  }
}

async function buildSpineOverlaySnapshotAsync(options = {}) {
  const supervisorRead = options.supervisorRead || safeReadJson(RUNTIME_PATHS.supervisor);
  const attributionRead = options.attributionRead || safeReadJson(RUNTIME_PATHS.attribution);
  const tradingEnabled = options.enableTradingFeed === true;
  const [liveRead, trustQuoteRead] = await Promise.all([
    tradingEnabled ? (options.liveRead || fetchHyperliquidReadOnlySnapshot({ ...options, supervisorRead, attributionRead })) : Promise.resolve(null),
    options.trustQuoteRead || fetchTrustQuoteReadOnlySignals({ ...options }),
  ]);
  return buildSpineOverlaySnapshot({ ...options, supervisorRead, attributionRead, liveRead, trustQuoteRead });
}

module.exports = {
  DEFAULT_THRESHOLD,
  HYPERLIQUID_INFO_URL,
  LIVE_MAX_AGE_MS,
  RUNTIME_PATHS,
  TRADING_PARKED_REASON,
  buildSpineOverlaySnapshot,
  buildSpineOverlaySnapshotAsync,
  extractAttributionPositions,
  extractSupervisorPositions,
  extractWalletAddress,
  fetchHyperliquidReadOnlySnapshot,
  supportedScorerSignals,
};
