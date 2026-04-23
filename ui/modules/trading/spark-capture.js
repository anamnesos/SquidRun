'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const hyperliquidClient = require('./hyperliquid-client');
const { runScan: scanTokenUnlocks } = require('../../scripts/hm-tokenomist-unlocks');
const {
  DEFAULT_TOKENOMIST_SOURCE_PATH,
  TOKENOMIST_SOURCE_STALE_MS,
  TOKENOMIST_SOURCE_WARN_MS,
  inspectTokenomistSource,
} = require('../../scripts/hm-tokenomist-source');

const DEFAULT_SPARK_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'spark-state.json'),
  { forWrite: true }
);
const DEFAULT_SPARK_EVENTS_PATH = resolveCoordPath(
  path.join('runtime', 'spark-events.jsonl'),
  { forWrite: true }
);
const DEFAULT_SPARK_FIREPLANS_PATH = resolveCoordPath(
  path.join('runtime', 'spark-fireplans.json'),
  { forWrite: true }
);
const DEFAULT_SPARK_WATCHLIST_PATH = resolveCoordPath(
  path.join('runtime', 'spark-watchlist.json'),
  { forWrite: true }
);
const DEFAULT_UPBIT_ANNOUNCEMENTS_URL = 'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=all';
const DEFAULT_INITIAL_ALERT_LOOKBACK_MINUTES = 90;
const DEFAULT_ACTIVE_UPBIT_PLAN_LOOKBACK_HOURS = 72;

const UPBIT_LISTING_PATTERNS = [
  /신규\s*거래지원\s*안내/i,
  /KRW\s*마켓\s*디지털\s*자산\s*추가/i,
  /BTC\s*마켓\s*디지털\s*자산\s*추가/i,
  /USDT\s*마켓\s*디지털\s*자산\s*추가/i,
  /원화\s*마켓\s*디지털\s*자산\s*추가/i,
];
const EXCLUDED_TICKER_MARKERS = new Set([
  'KRW',
  'BTC',
  'USDT',
  'NFT',
  'USD',
]);

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toFiniteNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, digits = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function ensureDirectoryForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDirectoryForFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function appendJsonLine(filePath, payload) {
  ensureDirectoryForFile(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function defaultSparkWatchlist() {
  return {
    version: 1,
    updatedAt: null,
    defaults: {
      maxMarginUsd: 250,
      entryBufferPct: 0.01,
      longTp1Pct: 0.20,
      longTp2Pct: 0.50,
      longRunnerPct: 1.00,
      shortTp1Pct: 0.20,
      shortTp2Pct: 0.35,
      shortRunnerPct: 0.50,
      maxPreferredLeverage: 10,
    },
    watchlist: [],
  };
}

function normalizeWatchlist(payload = {}) {
  const defaults = {
    ...defaultSparkWatchlist().defaults,
    ...(payload?.defaults && typeof payload.defaults === 'object' ? payload.defaults : {}),
  };
  const watchlist = Array.isArray(payload?.watchlist)
    ? payload.watchlist.map((entry) => ({
      ticker: toTicker(entry?.ticker),
      notes: toText(entry?.notes),
      catalystTypes: Array.isArray(entry?.catalystTypes) ? entry.catalystTypes.map((value) => toText(value).toLowerCase()).filter(Boolean) : [],
      maxMarginUsd: toNumber(entry?.maxMarginUsd, defaults.maxMarginUsd),
      maxPreferredLeverage: Math.max(1, Math.floor(toNumber(entry?.maxPreferredLeverage, defaults.maxPreferredLeverage))),
    })).filter((entry) => entry.ticker)
    : [];
  return {
    version: 1,
    updatedAt: toText(payload?.updatedAt, null),
    defaults,
    watchlist,
  };
}

function ensureSparkWatchlist(options = {}) {
  const watchlistPath = toText(options.watchlistPath, DEFAULT_SPARK_WATCHLIST_PATH);
  const existing = readJsonFile(watchlistPath, null);
  const normalized = normalizeWatchlist(existing || defaultSparkWatchlist());
  if (!existing) {
    writeJsonFile(watchlistPath, {
      ...normalized,
      updatedAt: new Date().toISOString(),
    });
  }
  return {
    path: watchlistPath,
    config: normalized,
  };
}

function defaultSparkState() {
  return {
    lastRunAt: null,
    upbit: {
      seenNoticeIds: [],
    },
    hyperliquid: {
      knownUniverseCoins: [],
    },
    tokenomist: {
      seenUnlockKeys: [],
    },
    seenEventKeys: [],
    updatedAt: null,
  };
}

function normalizeSparkState(payload = {}) {
  return {
    ...defaultSparkState(),
    ...payload,
    upbit: {
      ...defaultSparkState().upbit,
      ...(payload?.upbit && typeof payload.upbit === 'object' ? payload.upbit : {}),
      seenNoticeIds: Array.isArray(payload?.upbit?.seenNoticeIds)
        ? payload.upbit.seenNoticeIds.map((value) => Math.floor(Number(value) || 0)).filter((value) => value > 0)
        : [],
    },
    hyperliquid: {
      ...defaultSparkState().hyperliquid,
      ...(payload?.hyperliquid && typeof payload.hyperliquid === 'object' ? payload.hyperliquid : {}),
      knownUniverseCoins: Array.isArray(payload?.hyperliquid?.knownUniverseCoins)
        ? payload.hyperliquid.knownUniverseCoins.map((value) => toText(value).toUpperCase()).filter(Boolean)
        : [],
    },
    tokenomist: {
      ...defaultSparkState().tokenomist,
      ...(payload?.tokenomist && typeof payload.tokenomist === 'object' ? payload.tokenomist : {}),
      seenUnlockKeys: Array.isArray(payload?.tokenomist?.seenUnlockKeys)
        ? payload.tokenomist.seenUnlockKeys.map((value) => normalizeTokenomistSeenKey(value)).filter(Boolean)
        : [],
    },
    seenEventKeys: Array.isArray(payload?.seenEventKeys)
      ? payload.seenEventKeys.map((value) => normalizeTokenomistSeenKey(value)).filter(Boolean)
      : [],
    updatedAt: toText(payload?.updatedAt, null),
  };
}

function readSparkState(statePath = DEFAULT_SPARK_STATE_PATH) {
  return normalizeSparkState(readJsonFile(statePath, defaultSparkState()));
}

function writeSparkState(statePath = DEFAULT_SPARK_STATE_PATH, payload = {}) {
  const normalized = normalizeSparkState({
    ...payload,
    updatedAt: new Date().toISOString(),
  });
  writeJsonFile(statePath, normalized);
  return normalized;
}

function toTicker(value) {
  const normalized = toText(value).toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('/USD') ? normalized : `${normalized}/USD`;
}

function toTimestampMs(value) {
  const numeric = Date.parse(toText(value));
  return Number.isFinite(numeric) ? numeric : null;
}

function toIsoHourBucket(value) {
  const timestampMs = toTimestampMs(value);
  if (!Number.isFinite(timestampMs)) return '';
  const bucket = new Date(timestampMs);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket.toISOString().slice(0, 13);
}

function normalizeTokenomistSeenKey(value) {
  const normalized = toText(value);
  const match = normalized.match(/^tokenomist:([^:]+):(.+)$/i);
  if (!match) return normalized;
  const token = toText(match[1]).toUpperCase();
  const hourBucket = toIsoHourBucket(match[2]);
  return hourBucket ? `tokenomist:${token}:${hourBucket}` : normalized;
}

function isWithinLookback(timestamp, now, lookbackMinutes) {
  const eventMs = toTimestampMs(timestamp);
  const nowMs = toTimestampMs(now) || Date.now();
  const safeLookbackMinutes = Math.max(1, Math.floor(toNumber(lookbackMinutes, DEFAULT_INITIAL_ALERT_LOOKBACK_MINUTES)));
  if (!Number.isFinite(eventMs)) return false;
  return eventMs >= (nowMs - (safeLookbackMinutes * 60 * 1000));
}

function isWithinLookbackHours(timestamp, now, lookbackHours) {
  const eventMs = toTimestampMs(timestamp);
  const nowMs = toTimestampMs(now) || Date.now();
  const safeLookbackHours = Math.max(1, Math.floor(toNumber(lookbackHours, DEFAULT_ACTIVE_UPBIT_PLAN_LOOKBACK_HOURS)));
  if (!Number.isFinite(eventMs)) return false;
  return eventMs >= (nowMs - (safeLookbackHours * 60 * 60 * 1000));
}

function parseTickerCandidatesFromTitle(title = '') {
  return Array.from(String(title || '').matchAll(/\(([A-Z0-9]{2,15})\)/g))
    .map((match) => toText(match[1]).toUpperCase())
    .filter((ticker) => ticker && !EXCLUDED_TICKER_MARKERS.has(ticker));
}

function isUpbitListingNotice(notice = {}) {
  const category = toText(notice.category);
  const title = toText(notice.title);
  if (category !== '거래') return false;
  return UPBIT_LISTING_PATTERNS.some((pattern) => pattern.test(title));
}

function normalizeUpbitNotice(notice = {}) {
  const id = Math.floor(toNumber(notice.id, 0));
  const title = toText(notice.title);
  const tickers = parseTickerCandidatesFromTitle(title);
  return {
    source: 'upbit',
    catalystType: 'upbit_listing',
    eventKey: `upbit:${id}`,
    id,
    title,
    category: toText(notice.category),
    detectedAt: new Date().toISOString(),
    publishedAt: toText(notice.listed_at || notice.first_listed_at),
    url: id > 0 ? `https://www.upbit.com/service_center/notice?id=${id}` : 'https://www.upbit.com/service_center/notice',
    tickers: tickers.map((ticker) => toTicker(ticker)),
    raw: notice,
  };
}

async function fetchJson(url, options = {}) {
  const fetchFn = options.fetch || global.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch_unavailable');
  }
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`http_${response.status}`);
  }
  return response.json();
}

async function pollUpbitAnnouncements(options = {}) {
  const url = toText(options.upbitAnnouncementsUrl, DEFAULT_UPBIT_ANNOUNCEMENTS_URL);
  const payload = await fetchJson(url, options);
  const notices = Array.isArray(payload?.data?.notices) ? payload.data.notices : [];
  return notices
    .filter((notice) => isUpbitListingNotice(notice))
    .map((notice) => normalizeUpbitNotice(notice));
}

function detectNewUpbitEvents(notices = [], state = defaultSparkState(), options = {}) {
  const seenIds = new Set(Array.isArray(state?.upbit?.seenNoticeIds) ? state.upbit.seenNoticeIds : []);
  const initialBaseline = seenIds.size === 0 && !state?.lastRunAt;
  const now = toText(options.now, new Date().toISOString());
  return notices.filter((notice) => {
    if (!(notice.id > 0) || seenIds.has(notice.id)) {
      return false;
    }
    if (!initialBaseline) {
      return true;
    }
    return isWithinLookback(
      notice.publishedAt,
      now,
      options.initialAlertLookbackMinutes
    );
  });
}

function buildHyperliquidListingEvent(coin, now = new Date().toISOString()) {
  const normalizedCoin = toText(coin).toUpperCase();
  return {
    source: 'hyperliquid',
    catalystType: 'hyperliquid_new_listing',
    eventKey: `hyperliquid:${normalizedCoin}`,
    id: normalizedCoin,
    title: `Hyperliquid new coin detected: ${normalizedCoin}`,
    detectedAt: now,
    publishedAt: now,
    url: null,
    tickers: [toTicker(normalizedCoin)],
    raw: {
      coin: normalizedCoin,
    },
  };
}

function detectHyperliquidListingEvents(universeMarketData = [], state = defaultSparkState(), options = {}) {
  const now = toText(options.now, new Date().toISOString());
  const currentCoins = Array.from(new Set(
    (Array.isArray(universeMarketData) ? universeMarketData : [])
      .filter((entry) => entry?.raw?.asset?.isDelisted !== true)
      .map((entry) => toText(entry?.coin).toUpperCase())
      .filter(Boolean)
  ));
  const knownCoins = new Set(Array.isArray(state?.hyperliquid?.knownUniverseCoins) ? state.hyperliquid.knownUniverseCoins : []);
  const isInitialBaseline = knownCoins.size === 0;
  const events = isInitialBaseline
    ? []
    : currentCoins.filter((coin) => !knownCoins.has(coin)).map((coin) => buildHyperliquidListingEvent(coin, now));
  return {
    currentCoins,
    events,
    initialized: !isInitialBaseline,
  };
}

function normalizeTokenUnlockEvent(unlock = {}, now = new Date().toISOString()) {
  const ticker = toTicker(unlock?.ticker || unlock?.token);
  const token = toText(unlock?.token, ticker.replace('/USD', ''));
  const unlockAt = toText(unlock?.unlockAt);
  const countdownText = toText(unlock?.countdownText);
  const unlockSizeText = toText(unlock?.unlockSizeText);
  const unlockPctSupplyText = toText(unlock?.unlockPctSupplyText);
  const unlockHourBucket = toIsoHourBucket(unlockAt);
  const stableKey = unlockHourBucket
    ? `${token}:${unlockHourBucket}`
    : [
      token,
      countdownText,
      unlockSizeText,
      unlockPctSupplyText,
    ].filter(Boolean).join(':');
  return {
    source: 'tokenomist',
    catalystType: 'token_unlock',
    eventKey: `tokenomist:${stableKey || `${token}:${unlockAt}`}`,
    id: stableKey || `${token}:${unlockAt}`,
    title: `${token} token unlock scheduled at ${unlockAt}`,
    detectedAt: now,
    publishedAt: unlockAt || now,
    url: null,
    tickers: ticker ? [ticker] : [],
    raw: unlock,
  };
}

async function buildTokenomistEvents(state = defaultSparkState(), options = {}) {
  const now = toText(options.now, new Date().toISOString());
  const sourceStatus = inspectTokenomistSource(options.tokenomistSourcePath, {
    ...options,
    tokenomistSourceWarnMs: options.tokenomistSourceWarnMs || TOKENOMIST_SOURCE_WARN_MS,
    tokenomistSourceStaleMs: options.tokenomistSourceStaleMs || TOKENOMIST_SOURCE_STALE_MS,
  });
  if (sourceStatus.stale) {
    const warning = sourceStatus.warning;
    return {
      scanResult: {
        ok: false,
        sourcePath: warning?.path || path.resolve(String(options.tokenomistSourcePath || DEFAULT_TOKENOMIST_SOURCE_PATH)),
        unlockCount: 0,
        suppressed: true,
        suppressionReason: warning?.kind || 'tokenomist_source_unavailable',
        sourceFreshness: sourceStatus,
      },
      unlocks: [],
      allEvents: [],
      events: [],
      warnings: warning ? [warning] : [],
      warningMessage: warning?.kind === 'stale_tokenomist_source'
        ? `[LIVE SPARK] Warning\n- Tokenomist unlock catalysts suppressed: source is stale (${warning.ageHours}h old, ${warning.path}).`
        : `[LIVE SPARK] Warning\n- Tokenomist unlock catalysts suppressed: source file missing (${warning?.path || 'unknown path'}).`,
    };
  }

  const scanResult = await scanTokenUnlocks({
    sourcePath: options.tokenomistSourcePath,
    maxHours: options.tokenomistMaxHours || 48,
    marketData: options.universeMarketData,
  });
  const unlocks = Array.isArray(scanResult?.unlocks) ? scanResult.unlocks : [];
  const seenKeys = new Set(Array.isArray(state?.tokenomist?.seenUnlockKeys) ? state.tokenomist.seenUnlockKeys : []);
  const allEvents = unlocks
    .map((unlock) => normalizeTokenUnlockEvent(unlock, now))
    .filter((event) => event.tickers.length > 0);
  const initialBaseline = seenKeys.size === 0 && !state?.lastRunAt;
  const events = allEvents.filter((event) => {
    if (initialBaseline) {
      return false;
    }
    if (seenKeys.has(event.eventKey)) {
      return false;
    }
    return true;
  });
  return {
    scanResult,
    unlocks,
    allEvents,
    events,
    warnings: sourceStatus.warning ? [sourceStatus.warning] : [],
    warningMessage: sourceStatus.warning?.kind === 'aging_tokenomist_source'
      ? `[LIVE SPARK] Warning\n- Tokenomist source is aging (${sourceStatus.warning.ageHours}h old, ${sourceStatus.warning.path}). Verify unlock catalysts against a second live source before acting.`
      : '',
  };
}

function getWatchlistOverride(config = {}, ticker = '', catalystType = '') {
  const watchlist = Array.isArray(config?.watchlist) ? config.watchlist : [];
  return watchlist.find((entry) => {
    if (entry.ticker !== ticker) return false;
    if (!Array.isArray(entry.catalystTypes) || entry.catalystTypes.length === 0) return true;
    return entry.catalystTypes.includes(catalystType);
  }) || null;
}

function buildBarStats(bars = []) {
  const normalized = (Array.isArray(bars) ? bars : []).filter((bar) => toFiniteNumberOrNull(bar?.close) != null);
  if (normalized.length === 0) {
    return {
      high: null,
      low: null,
      close: null,
    };
  }
  return {
    high: normalized.reduce((max, bar) => Math.max(max, toFiniteNumberOrNull(bar?.high) ?? max), -Infinity),
    low: normalized.reduce((min, bar) => Math.min(min, toFiniteNumberOrNull(bar?.low) ?? min), Infinity),
    close: toFiniteNumberOrNull(normalized[normalized.length - 1]?.close),
  };
}

function buildFirePlan(event = {}, context = {}) {
  const ticker = toTicker(event?.tickers?.[0] || event?.ticker);
  if (!ticker) {
    return null;
  }
  const catalystType = toText(event?.catalystType).toLowerCase();
  const watchlistConfig = context.watchlistConfig || defaultSparkWatchlist();
  const defaults = watchlistConfig.defaults || defaultSparkWatchlist().defaults;
  const override = getWatchlistOverride(watchlistConfig, ticker, catalystType);
  const universeByTicker = context.universeByTicker instanceof Map ? context.universeByTicker : new Map();
  const universeEntry = universeByTicker.get(ticker) || null;
  const price = toNumber(
    universeEntry?.price,
    toNumber(universeEntry?.midPx, toNumber(universeEntry?.markPx, 0))
  );
  const tradeableOnHyperliquid = price > 0 && universeEntry != null && universeEntry?.raw?.asset?.isDelisted !== true;
  const bars5m = (context.bars5m instanceof Map ? context.bars5m.get(ticker) : null) || [];
  const bars1h = (context.bars1h instanceof Map ? context.bars1h.get(ticker) : null) || [];
  const stats5m = buildBarStats(bars5m.slice(-3));
  const stats1h = buildBarStats(bars1h.slice(-24));
  const direction = catalystType === 'token_unlock' ? 'SELL' : 'BUY';
  const entryBufferPct = toNumber(override?.entryBufferPct, defaults.entryBufferPct);
  const baseEntry = price > 0 ? price : toNumber(stats5m.close, toNumber(stats1h.close, 0));
  if (!(baseEntry > 0)) {
    return {
      ticker,
      source: event.source || null,
      catalystType,
      tradeableOnHyperliquid,
      ready: false,
      reason: 'price_unavailable',
    };
  }

  let entryLower = baseEntry;
  let entryUpper = baseEntry * (1 + entryBufferPct);
  let stopPrice = null;
  let tp1 = null;
  let tp2 = null;
  let runner = null;

  if (direction === 'BUY') {
    entryUpper = Math.max(entryUpper, stats5m.high ?? entryUpper);
    stopPrice = Math.min(
      entryLower * 0.97,
      stats1h.low ?? (entryLower * 0.97)
    );
    tp1 = entryUpper * (1 + toNumber(override?.longTp1Pct, defaults.longTp1Pct));
    tp2 = entryUpper * (1 + toNumber(override?.longTp2Pct, defaults.longTp2Pct));
    runner = entryUpper * (1 + toNumber(override?.longRunnerPct, defaults.longRunnerPct));
  } else {
    entryLower = Math.min(baseEntry * (1 - entryBufferPct), stats5m.low ?? (baseEntry * (1 - entryBufferPct)));
    entryUpper = baseEntry;
    stopPrice = Math.max(
      entryUpper * 1.03,
      stats1h.high ?? (entryUpper * 1.03)
    );
    tp1 = entryLower * (1 - toNumber(override?.shortTp1Pct, defaults.shortTp1Pct));
    tp2 = entryLower * (1 - toNumber(override?.shortTp2Pct, defaults.shortTp2Pct));
    runner = entryLower * (1 - toNumber(override?.shortRunnerPct, defaults.shortRunnerPct));
  }

  const maxLeverage = Math.max(
    1,
    Math.min(
      Math.floor(toNumber(universeEntry?.raw?.asset?.maxLeverage, 1)),
      Math.floor(toNumber(override?.maxPreferredLeverage, defaults.maxPreferredLeverage))
    )
  );
  const confidence = catalystType === 'upbit_listing'
    ? 0.86
    : catalystType === 'hyperliquid_new_listing'
      ? 0.74
      : 0.58;

  return {
    ticker,
    source: event.source || null,
    catalystType,
    title: toText(event.title),
    direction,
    confidence,
    tradeableOnHyperliquid,
    ready: tradeableOnHyperliquid,
    detectedAt: toText(event.detectedAt),
    publishedAt: toText(event.publishedAt),
    url: toText(event.url, null),
    currentPrice: round(baseEntry, 8),
    entryZone: {
      lower: round(Math.min(entryLower, entryUpper), 8),
      upper: round(Math.max(entryLower, entryUpper), 8),
    },
    stopPrice: round(stopPrice, 8),
    takeProfit1: round(tp1, 8),
    takeProfit2: round(tp2, 8),
    runnerTarget: round(runner, 8),
    maxMarginUsd: round(toNumber(override?.maxMarginUsd, defaults.maxMarginUsd), 2),
    maxLeverage,
    envelope: {
      recent5mHigh: round(stats5m.high, 8),
      recent5mLow: round(stats5m.low, 8),
      trailing1hHigh: round(stats1h.high, 8),
      trailing1hLow: round(stats1h.low, 8),
    },
    note: '',
  };
}

function buildUniverseByTicker(universeMarketData = []) {
  return new Map(
    (Array.isArray(universeMarketData) ? universeMarketData : [])
      .map((entry) => [toTicker(entry?.ticker || entry?.coin), entry])
      .filter(([ticker]) => ticker)
  );
}

function dedupeEvents(events = []) {
  const seen = new Set();
  const deduped = [];
  for (const event of events) {
    const key = toText(event?.eventKey);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function buildAlertMessage(result = {}) {
  const alerts = Array.isArray(result?.newAlertEvents) ? result.newAlertEvents : [];
  if (alerts.length === 0) return '';
  const lines = [
    '[LIVE SPARK] New catalyst alerts',
  ];
  for (const event of alerts.slice(0, 6)) {
    const plan = Array.isArray(result?.firePlans)
      ? result.firePlans.find((entry) => entry.ticker === event.tickers?.[0] && entry.catalystType === event.catalystType)
      : null;
    lines.push(
      `- ${event.source.toUpperCase()} ${toText(event.title)}`
      + `${event.tickers?.length ? ` | ${event.tickers.join(', ')}` : ''}`
      + `${plan?.ready ? ` | entry ${plan.entryZone.lower}-${plan.entryZone.upper} stop ${plan.stopPrice} tp1 ${plan.takeProfit1}` : ' | plan pending / non-tradeable on HL'}`
    );
  }
  return lines.join('\n');
}

async function runSparkScan(options = {}) {
  const now = toText(options.now, new Date().toISOString());
  const statePath = toText(options.statePath, DEFAULT_SPARK_STATE_PATH);
  const eventsPath = toText(options.eventsPath, DEFAULT_SPARK_EVENTS_PATH);
  const firePlansPath = toText(options.firePlansPath, DEFAULT_SPARK_FIREPLANS_PATH);
  const state = normalizeSparkState(options.state || readSparkState(statePath));
  const { path: watchlistPath, config: watchlistConfig } = ensureSparkWatchlist({
    watchlistPath: options.watchlistPath,
  });

  const universeMarketData = Array.isArray(options.universeMarketData)
    ? options.universeMarketData
    : await hyperliquidClient.getUniverseMarketData(options).catch(() => []);
  const universeByTicker = buildUniverseByTicker(universeMarketData);

  const [upbitNotices, tokenomistResult] = await Promise.all([
    pollUpbitAnnouncements(options).catch((error) => ({
      error: error.message,
      notices: [],
    })),
    buildTokenomistEvents(state, {
      ...options,
      now,
      universeMarketData,
    }).catch((error) => ({
      error: error.message,
      scanResult: { ok: false, error: error.message },
      unlocks: [],
      events: [],
    })),
  ]);

  const currentUpbitEvents = Array.isArray(upbitNotices)
    ? upbitNotices.filter((notice) => isWithinLookbackHours(
      notice.publishedAt,
      now,
      options.activeUpbitPlanLookbackHours
    ))
    : [];
  const upbitEvents = Array.isArray(upbitNotices)
    ? detectNewUpbitEvents(upbitNotices, state, {
      now,
      initialAlertLookbackMinutes: options.initialAlertLookbackMinutes,
    })
    : [];
  const hyperliquidResult = detectHyperliquidListingEvents(universeMarketData, state, { now });
  const tokenomistEvents = Array.isArray(tokenomistResult?.events) ? tokenomistResult.events : [];
  const currentTokenomistEvents = Array.isArray(tokenomistResult?.allEvents) ? tokenomistResult.allEvents : [];
  const warnings = Array.isArray(tokenomistResult?.warnings) ? tokenomistResult.warnings : [];

  const candidateEvents = dedupeEvents([
    ...upbitEvents,
    ...hyperliquidResult.events,
    ...tokenomistEvents,
  ]);

  const seenEventKeys = new Set(Array.isArray(state.seenEventKeys) ? state.seenEventKeys : []);
  const newAlertEvents = candidateEvents.filter((event) => !seenEventKeys.has(event.eventKey));
  const tickersNeedingBars = Array.from(new Set(
    dedupeEvents([
      ...candidateEvents,
      ...(Array.isArray(watchlistConfig.watchlist) ? watchlistConfig.watchlist.map((entry) => ({
        tickers: [entry.ticker],
        eventKey: `watchlist:${entry.ticker}`,
        catalystType: 'watchlist',
        source: 'watchlist',
      })) : []),
    ])
      .flatMap((event) => Array.isArray(event?.tickers) ? event.tickers : [])
      .filter((ticker) => universeByTicker.has(ticker))
  ));

  const [bars5m, bars1h] = await Promise.all([
    tickersNeedingBars.length > 0
      ? hyperliquidClient.getHistoricalBars({
        ...options,
        symbols: tickersNeedingBars,
        timeframe: '5m',
        limit: 48,
      }).catch(() => new Map())
      : Promise.resolve(new Map()),
    tickersNeedingBars.length > 0
      ? hyperliquidClient.getHistoricalBars({
        ...options,
        symbols: tickersNeedingBars,
        timeframe: '1Hour',
        limit: 48,
      }).catch(() => new Map())
      : Promise.resolve(new Map()),
  ]);

  const firePlans = dedupeEvents([
    ...currentUpbitEvents,
    ...hyperliquidResult.events,
    ...currentTokenomistEvents,
    ...(Array.isArray(watchlistConfig.watchlist) ? watchlistConfig.watchlist.map((entry) => ({
      source: 'watchlist',
      catalystType: 'watchlist',
      eventKey: `watchlist:${entry.ticker}`,
      title: entry.notes || `${entry.ticker} watchlist`,
      tickers: [entry.ticker],
      detectedAt: now,
      publishedAt: now,
    })) : []),
  ])
    .map((event) => buildFirePlan(event, {
      watchlistConfig,
      universeByTicker,
      bars5m,
      bars1h,
    }))
    .filter(Boolean);

  const nextState = normalizeSparkState({
    ...state,
    lastRunAt: now,
    upbit: {
      seenNoticeIds: Array.from(new Set([
        ...state.upbit.seenNoticeIds,
        ...(Array.isArray(upbitNotices) ? upbitNotices.map((event) => event.id) : []),
      ])).slice(-200),
    },
    hyperliquid: {
      knownUniverseCoins: hyperliquidResult.currentCoins.slice(-1000),
    },
    tokenomist: {
      seenUnlockKeys: Array.from(new Set([
        ...state.tokenomist.seenUnlockKeys,
        ...currentTokenomistEvents.map((event) => event.eventKey),
      ])).slice(-1000),
    },
    seenEventKeys: Array.from(new Set([
      ...state.seenEventKeys,
      ...newAlertEvents.map((event) => event.eventKey),
    ])).slice(-2000),
  });
  writeSparkState(statePath, nextState);

  for (const event of newAlertEvents) {
    appendJsonLine(eventsPath, {
      ...event,
      recordedAt: now,
    });
  }

  const firePlanPayload = {
    generatedAt: now,
    watchlistPath,
    eventCount: candidateEvents.length,
    firePlans,
  };
  writeJsonFile(firePlansPath, firePlanPayload);

  return {
    ok: true,
    scannedAt: now,
    statePath,
    eventsPath,
    firePlansPath,
    watchlistPath,
    upbitListingCount: currentUpbitEvents.length,
    hyperliquidListingCount: hyperliquidResult.events.length,
    tokenUnlockCount: currentTokenomistEvents.length,
    newAlertEvents,
    allCandidateEvents: candidateEvents,
    firePlans,
    warnings,
    warningMessage: toText(tokenomistResult?.warningMessage, ''),
    alertMessage: buildAlertMessage({
      newAlertEvents,
      firePlans,
    }),
    tokenomist: tokenomistResult?.scanResult || null,
  };
}

module.exports = {
  DEFAULT_SPARK_STATE_PATH,
  DEFAULT_SPARK_EVENTS_PATH,
  DEFAULT_SPARK_FIREPLANS_PATH,
  DEFAULT_SPARK_WATCHLIST_PATH,
  DEFAULT_TOKENOMIST_SOURCE_PATH,
  DEFAULT_UPBIT_ANNOUNCEMENTS_URL,
  DEFAULT_INITIAL_ALERT_LOOKBACK_MINUTES,
  DEFAULT_ACTIVE_UPBIT_PLAN_LOOKBACK_HOURS,
  TOKENOMIST_SOURCE_STALE_MS,
  TOKENOMIST_SOURCE_WARN_MS,
  buildAlertMessage,
  buildFirePlan,
  defaultSparkState,
  defaultSparkWatchlist,
  detectHyperliquidListingEvents,
  detectNewUpbitEvents,
  ensureSparkWatchlist,
  inspectTokenomistSource,
  isUpbitListingNotice,
  normalizeSparkState,
  normalizeUpbitNotice,
  pollUpbitAnnouncements,
  readSparkState,
  runSparkScan,
  writeSparkState,
};
