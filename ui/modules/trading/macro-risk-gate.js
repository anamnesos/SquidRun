/**
 * Macro Risk Gate - Assesses macro-economic and geopolitical conditions
 * to adjust trading constraints before technical signals execute.
 *
 * Sources:
 * - Alternative.me Fear & Greed
 * - FRED VIX + fallback WTI oil
 * - Yahoo Finance live WTI futures
 * - GDELT DOC API 2.0 for conflict / tone
 * - Static 2026 FOMC decision calendar
 *
 * Results are cached for 15 minutes to avoid hammering APIs every round.
 */

'use strict';

const {
  CRISIS_UNIVERSE,
  CRISIS_TYPES,
  getCrisisUniverse,
  isCrisisTicker,
  normalizeSignalDirection,
  resolveCrisisUniverse,
  strategyModeForRegime,
} = require('./crisis-mode');

const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const GDELT_API_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_TIMESPAN = '48h';
const GDELT_MAX_RECORDS = 25;
const LIVE_OIL_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1m&range=1d';
const FED_TIME_ZONE = 'America/New_York';
const INDICATOR_STALE_AFTER_MS = Object.freeze({
  fredDaily: 3 * 24 * 60 * 60 * 1000,
  vixFred: 48 * 60 * 60 * 1000,
  fearGreed: 36 * 60 * 60 * 1000,
  liveOil: 2 * 60 * 60 * 1000,
});
const FOMC_DECISION_DATES_2026 = Object.freeze([
  '2026-01-28',
  '2026-03-18',
  '2026-04-29',
  '2026-06-17',
  '2026-07-29',
  '2026-09-16',
  '2026-10-28',
  '2026-12-09',
]);
const KINETIC_KEYWORDS = Object.freeze([
  'missile',
  'missiles',
  'strike',
  'strikes',
  'attack',
  'attacks',
  'drone',
  'drones',
  'naval',
  'military',
  'troops',
  'bomb',
  'bombing',
  'rocket',
  'rockets',
  'shelling',
  'warship',
  'warships',
  'seized',
  'seizure',
  'blockade',
  'conflict',
  'clash',
  'clashes',
]);
const CHOKEPOINT_KEYWORDS = Object.freeze([
  'strait of hormuz',
  'hormuz',
  'bab el-mandeb',
  'red sea',
  'suez canal',
  'taiwan strait',
  'shipping lane',
  'shipping route',
  'shipping chokepoint',
  'oil transit',
  'tanker',
  'tankers',
]);
const SANCTIONS_KEYWORDS = Object.freeze([
  'sanction',
  'sanctions',
  'embargo',
  'export control',
  'export controls',
  'tariff',
  'tariffs',
  'blacklist',
  'blocked exports',
]);
const CONFLICT_QUERY_TERMS = Object.freeze([
  '"Strait of Hormuz"',
  '"Bab el-Mandeb"',
  '"Red Sea"',
  '"Suez Canal"',
  '"Taiwan Strait"',
  'Iran',
  'Israel',
  'Houthi',
  'shipping',
  'tanker',
  'sanctions',
  'missile',
  'naval',
]);

const FALLBACK_VALUES = Object.freeze({
  vix: 18,
  fearGreed: 50,
  oilPrice: 70,
  geopolitics: Object.freeze({
    riskScore: 45,
    sentiment: 0,
    avgTone: 0,
    minTone: 0,
    articleCount: 0,
    kineticHitCount: 0,
    chokepointHitCount: 0,
    sanctionsHitCount: 0,
    activeKineticConflict: false,
    stayCashTrigger: false,
    source: 'fallback',
    query: '',
    sampleHeadlines: [],
  }),
});

let _cache = null;
let _inflight = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toDirection(value) {
  return normalizeSignalDirection(value);
}

function toDateKeyInZone(value = new Date(), timeZone = FED_TIME_ZONE) {
  const parts = partsFromFormatter(
    getFormatter(timeZone),
    value instanceof Date ? value : new Date(value)
  );
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getFormatter(timeZone = FED_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function getTimeParts(timeString = '') {
  const match = String(timeString || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid time string: ${timeString}`);
  return {
    hour: Number.parseInt(match[1], 10),
    minute: Number.parseInt(match[2], 10),
  };
}

function getDateParts(dateString = '') {
  const match = String(dateString || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date string: ${dateString}`);
  return {
    year: Number.parseInt(match[1], 10),
    month: Number.parseInt(match[2], 10),
    day: Number.parseInt(match[3], 10),
  };
}

function partsFromFormatter(formatter, date) {
  const lookup = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number.parseInt(lookup.year, 10),
    month: Number.parseInt(lookup.month, 10),
    day: Number.parseInt(lookup.day, 10),
    hour: Number.parseInt(lookup.hour, 10),
    minute: Number.parseInt(lookup.minute, 10),
    second: Number.parseInt(lookup.second, 10),
  };
}

function zonedDateTimeToUtc(dateString, timeString, timeZone = FED_TIME_ZONE) {
  const dateParts = getDateParts(dateString);
  const timeParts = getTimeParts(timeString);
  let guess = Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, timeParts.hour, timeParts.minute, 0);
  const formatter = getFormatter(timeZone);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsFromFormatter(formatter, new Date(guess));
    const desiredUtc = Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, timeParts.hour, timeParts.minute, 0);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const delta = actualUtc - desiredUtc;
    if (delta === 0) break;
    guess -= delta;
  }

  return new Date(guess);
}

function normalizeConfidence(value) {
  return clamp(toNumber(value, 0), 0, 1);
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = value > 10_000_000_000 ? value : value * 1000;
    return new Date(normalized).toISOString();
  }
  const numericString = String(value).trim();
  if (/^\d{10,13}$/.test(numericString)) {
    const numericValue = Number.parseInt(numericString, 10);
    if (Number.isFinite(numericValue)) {
      const normalized = numericString.length >= 13 ? numericValue : numericValue * 1000;
      return new Date(normalized).toISOString();
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function dateStringToIsoStart(dateString, fallback = null) {
  const normalized = String(dateString || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return fallback;
  return new Date(`${normalized}T00:00:00.000Z`).toISOString();
}

function firstFiniteValue(candidates = [], fallback = null) {
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return fallback;
}

function computeDeltaPct(currentValue, previousValue) {
  const current = Number(currentValue);
  const previous = Number(previousValue);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return 0;
  return (current - previous) / previous;
}

function buildIndicatorPayload({
  value,
  source,
  observedAt = null,
  fetchedAt = null,
  previousValue = null,
  deltaPct = 0,
  stale = false,
  staleReason = null,
  staleAfterMs = 0,
  staleReasonIfTooOld = 'observed_at_too_old',
  requireObservedAt = true,
} = {}) {
  const normalizedValue = Number(value);
  const normalizedFetchedAt = toIsoTimestamp(fetchedAt, new Date().toISOString());
  const normalizedObservedAt = toIsoTimestamp(observedAt, null);
  const normalizedPreviousValue = Number(previousValue);
  const normalizedDeltaPct = Number(deltaPct);
  const observationAgeMs = normalizedObservedAt
    ? Math.max(0, Date.parse(normalizedFetchedAt) - Date.parse(normalizedObservedAt))
    : null;

  let nextStale = stale === true;
  let nextStaleReason = staleReason || null;

  if (!normalizedObservedAt && requireObservedAt) {
    nextStale = true;
    nextStaleReason = nextStaleReason || 'missing_observed_at';
  } else if (!nextStale && normalizedObservedAt && staleAfterMs > 0 && observationAgeMs > staleAfterMs) {
    nextStale = true;
    nextStaleReason = nextStaleReason || staleReasonIfTooOld;
  }

  return {
    value: Number.isFinite(normalizedValue) ? normalizedValue : 0,
    source: String(source || 'unknown'),
    observedAt: normalizedObservedAt,
    fetchedAt: normalizedFetchedAt,
    stale: nextStale,
    staleReason: nextStaleReason,
    previousValue: Number.isFinite(normalizedPreviousValue) ? normalizedPreviousValue : null,
    deltaPct: Number.isFinite(normalizedDeltaPct) ? normalizedDeltaPct : 0,
    observationAgeMs,
  };
}

function buildIndicatorStaleReason(label, indicator = {}) {
  if (!indicator || indicator.stale !== true) return null;
  const reason = String(indicator.staleReason || 'unknown_staleness').replace(/_/g, ' ');
  const observedAt = indicator.observedAt ? ` (observed ${indicator.observedAt})` : '';
  return `${label} data stale: ${reason}${observedAt}`;
}

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SquidRun/0.1.34',
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return {
        _rawText: text,
      };
    }
  } catch {
    return null;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function fetchFearGreed(options = {}) {
  const fetchedAt = toIsoTimestamp(options.now, new Date().toISOString());
  const data = await fetchJson('https://api.alternative.me/fng/?limit=1');
  if (data?.data?.[0]?.value != null) {
    const latest = data.data[0];
    return buildIndicatorPayload({
      value: Number(latest.value),
      source: 'alternative_me',
      observedAt: latest.timestamp,
      fetchedAt,
      staleAfterMs: INDICATOR_STALE_AFTER_MS.fearGreed,
      staleReasonIfTooOld: 'fear_greed_observation_stale',
    });
  }
  console.warn('[macro-risk-gate] Fear & Greed API failed, using fallback');
  return buildIndicatorPayload({
    value: FALLBACK_VALUES.fearGreed,
    source: 'fallback',
    fetchedAt,
    stale: true,
    staleReason: 'fear_greed_api_failed',
    requireObservedAt: false,
  });
}

async function fetchFredSeries(seriesId, label, fallback, options = {}) {
  const fetchedAt = toIsoTimestamp(options.now, new Date().toISOString());
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.warn(`[macro-risk-gate] FRED_API_KEY missing, using fallback for ${label}`);
    return buildIndicatorPayload({
      value: fallback,
      previousValue: fallback,
      deltaPct: 0,
      source: 'fallback',
      fetchedAt,
      stale: true,
      staleReason: 'fred_api_key_missing',
      requireObservedAt: false,
    });
  }
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=5&file_type=json&api_key=${apiKey}`;
  const data = await fetchJson(url);
  const observations = Array.isArray(data?.observations) ? data.observations : [];
  const usable = observations
    .map((obs) => ({
      value: Number(obs?.value),
      observedAt: dateStringToIsoStart(obs?.date, null),
    }))
    .filter((obs) => Number.isFinite(obs.value));
  if (usable.length > 0) {
    const latest = usable[0];
    const previous = usable[1] || latest;
    return buildIndicatorPayload({
      value: latest.value,
      previousValue: previous.value,
      deltaPct: computeDeltaPct(latest.value, previous.value),
      source: `fred:${seriesId}`,
      observedAt: latest.observedAt,
      fetchedAt,
      staleAfterMs: Number.isFinite(Number(options.staleAfterMs))
        ? Number(options.staleAfterMs)
        : INDICATOR_STALE_AFTER_MS.fredDaily,
      staleReasonIfTooOld: options.staleReasonIfTooOld || `${seriesId.toLowerCase()}_observation_stale`,
    });
  }
  console.warn(`[macro-risk-gate] FRED ${seriesId} returned no data, using fallback for ${label}`);
  return buildIndicatorPayload({
    value: fallback,
    previousValue: fallback,
    deltaPct: 0,
    source: 'fallback',
    fetchedAt,
    stale: true,
    staleReason: `${seriesId.toLowerCase()}_no_data`,
    requireObservedAt: false,
  });
}

async function fetchLiveOilPrice(options = {}) {
  const fetchedAt = toIsoTimestamp(options.now, new Date().toISOString());
  const data = await fetchJson(LIVE_OIL_CHART_URL);
  const result = data?.chart?.result?.[0];
  const meta = result?.meta || {};
  const regularSession = meta?.currentTradingPeriod?.regular || {};
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] || {};
  const closes = Array.isArray(quote?.close) ? quote.close : [];
  const finiteCloses = closes.map((value, index) => ({
    value: Number(value),
    timestamp: timestamps[index],
  })).filter((entry) => Number.isFinite(entry.value));
  const latestClose = finiteCloses[finiteCloses.length - 1] || null;
  const previousCloseEntry = finiteCloses.length >= 2 ? finiteCloses[finiteCloses.length - 2] : latestClose;
  const liveValue = firstFiniteValue([
    meta.regularMarketPrice,
    latestClose?.value,
  ], null);

  if (!Number.isFinite(liveValue)) {
    return null;
  }

  const previousValue = firstFiniteValue([
    meta.chartPreviousClose,
    meta.previousClose,
    previousCloseEntry?.value,
    liveValue,
  ], liveValue);
  const candidateObservedAt = toIsoTimestamp(
    firstFiniteValue([meta.regularMarketTime, latestClose?.timestamp], null),
    null
  );
  const regularSessionStartMs = Number(regularSession?.start) * 1000;
  const regularSessionEndMs = Number(regularSession?.end) * 1000;
  const fetchedAtMs = Date.parse(fetchedAt);
  const candidateObservedAtMs = Date.parse(candidateObservedAt || '');
  const sessionSnapshotFallbackActive = Number.isFinite(fetchedAtMs)
    && Number.isFinite(regularSessionStartMs)
    && Number.isFinite(regularSessionEndMs)
    && regularSessionStartMs > 0
    && regularSessionEndMs >= regularSessionStartMs
    && fetchedAtMs >= regularSessionStartMs
    && fetchedAtMs <= regularSessionEndMs
    && (
      !Number.isFinite(candidateObservedAtMs)
      || (fetchedAtMs - candidateObservedAtMs) > INDICATOR_STALE_AFTER_MS.liveOil
    );
  const observedAt = sessionSnapshotFallbackActive ? fetchedAt : candidateObservedAt;
  const source = sessionSnapshotFallbackActive
    ? 'yahoo_finance:CL=F:session_snapshot'
    : 'yahoo_finance:CL=F';

  return buildIndicatorPayload({
    value: liveValue,
    previousValue,
    deltaPct: computeDeltaPct(liveValue, previousValue),
    source,
    observedAt,
    fetchedAt,
    staleAfterMs: INDICATOR_STALE_AFTER_MS.liveOil,
    staleReasonIfTooOld: 'live_oil_quote_stale',
  });
}

async function fetchOilPrice(options = {}) {
  const liveResult = await fetchLiveOilPrice(options).catch(() => null);
  if (liveResult) {
    return liveResult;
  }
  const fredFallback = await fetchFredSeries('DCOILWTICO', 'Oil (WTI)', FALLBACK_VALUES.oilPrice, {
    ...options,
    staleAfterMs: INDICATOR_STALE_AFTER_MS.fredDaily,
    staleReasonIfTooOld: 'fred_oil_observation_stale',
  });
  return {
    ...fredFallback,
    source: fredFallback.source === 'fallback' ? 'fallback' : 'fred:DCOILWTICO:fallback',
    stale: true,
    staleReason: fredFallback.staleReason || 'live_oil_unavailable_using_fred_fallback',
  };
}

function buildGdeltQuery(queryTerms = CONFLICT_QUERY_TERMS) {
  return `(${queryTerms.join(' OR ')})`;
}

function extractArrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.articles)) return payload.articles;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.timeline)) return payload.timeline;
  return Object.values(payload).find((value) => Array.isArray(value)) || [];
}

function toLowerText(value) {
  return String(value || '').trim().toLowerCase();
}

function articleText(article = {}) {
  return [
    article.title,
    article.seendate,
    article.url,
    article.domain,
    article.domainname,
    article.sourcecountry,
    article.language,
    article.text,
    article.snippet,
    article.summary,
  ].map((value) => String(value || '')).join(' ').toLowerCase();
}

function containsAny(text = '', keywords = []) {
  return keywords.some((keyword) => text.includes(String(keyword).toLowerCase()));
}

function extractTone(article = {}) {
  const candidates = [
    article.tone,
    article.avgTone,
    article.averageTone,
    article.Tone,
    article.toneavg,
    article.tone_avg,
    article.sourceTone,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function extractGoldstein(article = {}) {
  const candidates = [
    article.goldstein,
    article.goldsteinscale,
    article.goldsteinScale,
    article.GoldsteinScale,
    article.goldstein_score,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function buildToneRiskScore(avgTone, minTone, articleStats = {}) {
  let score = 35;
  if (avgTone <= -3 || minTone <= -5) {
    score = 92;
  } else if (avgTone <= -2) {
    score = 85;
  } else if (avgTone <= -1) {
    score = 70;
  } else if (avgTone < 0) {
    score = 55;
  }

  if (articleStats.kineticHitCount > 0) {
    score += 6;
  }
  if (articleStats.chokepointHitCount > 0) {
    score += 8;
  }
  if (articleStats.sanctionsHitCount > 0) {
    score += 4;
  }
  if (minTone <= -5.5) {
    score += 6;
  }

  return clamp(Math.round(score), 0, 100);
}

function normalizeGdeltArticles(payload = {}, query = '') {
  const articles = extractArrayPayload(payload);
  const tones = [];
  const goldstein = [];
  const sampleHeadlines = [];
  let kineticHitCount = 0;
  let chokepointHitCount = 0;
  let sanctionsHitCount = 0;

  for (const rawArticle of articles) {
    const article = rawArticle && typeof rawArticle === 'object' ? rawArticle : {};
    const text = articleText(article);
    const tone = extractTone(article);
    const goldsteinValue = extractGoldstein(article);
    const title = String(article.title || article.headline || '').trim();

    if (Number.isFinite(tone)) tones.push(tone);
    if (Number.isFinite(goldsteinValue)) goldstein.push(goldsteinValue);
    if (title) {
      sampleHeadlines.push(title);
    }
    if (containsAny(text, KINETIC_KEYWORDS)) {
      kineticHitCount += 1;
    }
    if (containsAny(text, CHOKEPOINT_KEYWORDS)) {
      chokepointHitCount += 1;
    }
    if (containsAny(text, SANCTIONS_KEYWORDS)) {
      sanctionsHitCount += 1;
    }
  }

  const avgTone = tones.length > 0
    ? tones.reduce((sum, value) => sum + value, 0) / tones.length
    : 0;
  const minTone = tones.length > 0 ? Math.min(...tones) : 0;
  const avgGoldstein = goldstein.length > 0
    ? goldstein.reduce((sum, value) => sum + value, 0) / goldstein.length
    : 0;
  const activeKineticConflict = kineticHitCount > 0 && chokepointHitCount > 0;
  const riskScore = buildToneRiskScore(avgTone, minTone, {
    kineticHitCount,
    chokepointHitCount,
    sanctionsHitCount,
  });
  const stayCashTrigger = activeKineticConflict && (avgTone <= -3 || minTone <= -5);

  return {
    riskScore: stayCashTrigger ? Math.max(92, riskScore) : riskScore,
    sentiment: clamp(avgTone / 10, -1, 1),
    avgTone: Number(avgTone.toFixed(2)),
    minTone: Number(minTone.toFixed(2)),
    avgGoldstein: Number(avgGoldstein.toFixed(2)),
    articleCount: articles.length,
    kineticHitCount,
    chokepointHitCount,
    sanctionsHitCount,
    activeKineticConflict,
    stayCashTrigger,
    source: 'gdelt',
    query,
    sampleHeadlines: sampleHeadlines.slice(0, 5),
  };
}

async function fetchGeopoliticalIntelligence(options = {}) {
  const query = options.gdeltQuery || buildGdeltQuery(options.queryTerms || CONFLICT_QUERY_TERMS);
  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(options.maxRecords || GDELT_MAX_RECORDS),
    timespan: String(options.timespan || GDELT_TIMESPAN),
  });
  const url = `${GDELT_API_URL}?${params.toString()}`;
  const payload = await fetchJson(url, options.timeoutMs || DEFAULT_TIMEOUT_MS);
  if (!payload || String(payload?._rawText || '').toLowerCase().includes('please limit requests')) {
    return {
      ...FALLBACK_VALUES.geopolitics,
      source: payload?._rawText ? 'rate_limited' : 'fallback',
      query,
      note: payload?._rawText || 'gdelt unavailable',
    };
  }
  return normalizeGdeltArticles(payload, query);
}

function getFedEventState(now = new Date()) {
  const reference = now instanceof Date ? now : new Date(now);
  const dateKey = toDateKeyInZone(reference, FED_TIME_ZONE);
  const isEventDay = FOMC_DECISION_DATES_2026.includes(dateKey);
  const trackedDecisionDate = isEventDay
    ? dateKey
    : (FOMC_DECISION_DATES_2026.find((decisionDate) => {
      const decisionAt = zonedDateTimeToUtc(decisionDate, '14:00', FED_TIME_ZONE);
      return decisionAt.getTime() >= reference.getTime();
    }) || null);
  const trackedDecisionAt = trackedDecisionDate
    ? zonedDateTimeToUtc(trackedDecisionDate, '14:00', FED_TIME_ZONE)
    : null;
  const hoursUntilDecision = trackedDecisionAt
    ? Number(((trackedDecisionAt.getTime() - reference.getTime()) / (60 * 60 * 1000)).toFixed(2))
    : null;
  const dayFormatter = getFormatter(FED_TIME_ZONE);
  const parts = partsFromFormatter(dayFormatter, reference);
  const minuteOfDay = (parts.hour * 60) + parts.minute;
  const inDangerZone = isEventDay && minuteOfDay >= (12 * 60) && minuteOfDay <= (15 * 60);

  return {
    isEventDay,
    hoursUntilDecision,
    nextDecisionAt: trackedDecisionAt ? trackedDecisionAt.toISOString() : null,
    inDangerZone,
    decisionWindow: isEventDay ? '12:00-15:00 America/New_York' : null,
  };
}

function classifyCrisisType(vix, oilPrice, marketState = {}) {
  const vixDeltaPct = toNumber(marketState.vixDeltaPct, 0);
  const oilDeltaPct = toNumber(marketState.oilDeltaPct, 0);
  const elevatedVix = vix >= 20 || vixDeltaPct >= 0.03;
  if (!elevatedVix) {
    return CRISIS_TYPES.NONE;
  }
  if (oilDeltaPct >= 0.01 || oilPrice >= 85) {
    return CRISIS_TYPES.INFLATIONARY;
  }
  if (oilDeltaPct <= -0.01 || oilPrice <= 68) {
    return CRISIS_TYPES.DEFLATIONARY;
  }
  return CRISIS_TYPES.MIXED;
}

function classifyRegime(vix, fearGreed, oilPrice, intelligence = {}, now = new Date()) {
  const reasons = [];
  let worstRegime = 'green';
  const geopolitics = intelligence.geopolitics || FALLBACK_VALUES.geopolitics;
  const fed = intelligence.fed || getFedEventState(now);
  const market = intelligence.market || {};

  function escalate(regime, reason) {
    reasons.push(reason);
    const priority = {
      green: 0,
      yellow: 1,
      red: 2,
      stay_cash: 3,
    };
    if ((priority[regime] || 0) > (priority[worstRegime] || 0)) {
      worstRegime = regime;
    }
  }

  if (geopolitics.stayCashTrigger) {
    escalate('stay_cash', `GDELT conflict tone ${toNumber(geopolitics.avgTone, 0).toFixed(2)} with chokepoint kinetic keywords - STAY_CASH`);
  } else if (geopolitics.riskScore > 80) {
    escalate('red', `GDELT geopolitical risk ${geopolitics.riskScore}/100 (hard RED)`);
  } else if (geopolitics.riskScore >= 60) {
    escalate('yellow', `GDELT geopolitical risk ${geopolitics.riskScore}/100 (elevated)`);
  }

  if (fed.inDangerZone) {
    escalate('red', 'Fed decision day danger window (12:00-15:00 ET)');
  } else if (fed.isEventDay) {
    escalate('yellow', 'Fed decision day');
  }

  if (vix > 30) {
    escalate('red', `VIX at ${vix.toFixed(1)} (>30 = extreme fear)`);
  } else if (vix >= 20) {
    escalate('yellow', `VIX at ${vix.toFixed(1)} (20-30 = elevated)`);
  }

  if (fearGreed < 25) {
    escalate('red', `Fear & Greed at ${fearGreed} (<25 = extreme fear)`);
  } else if (fearGreed <= 40) {
    escalate('yellow', `Fear & Greed at ${fearGreed} (25-40 = fear)`);
  }

  if (oilPrice > 100) {
    escalate('red', `Oil at $${oilPrice.toFixed(2)} (>$100 = supply shock risk)`);
  } else if (oilPrice >= 85) {
    escalate('yellow', `Oil at $${oilPrice.toFixed(2)} ($85-100 = elevated)`);
  }

  if (reasons.length === 0) {
    reasons.push(`All clear: VIX ${vix.toFixed(1)}, F&G ${fearGreed}, Oil $${oilPrice.toFixed(2)}, GDELT ${geopolitics.riskScore}/100`);
  }

  const crisisType = worstRegime === 'stay_cash'
    ? classifyCrisisType(vix, oilPrice, market)
    : CRISIS_TYPES.NONE;

  if (worstRegime === 'stay_cash' && crisisType === CRISIS_TYPES.INFLATIONARY) {
    reasons.push(`Crisis type: INFLATIONARY shock (oil ${(toNumber(market.oilDeltaPct, 0) * 100).toFixed(1)}%, VIX elevated)`);
  } else if (worstRegime === 'stay_cash' && crisisType === CRISIS_TYPES.DEFLATIONARY) {
    reasons.push(`Crisis type: DEFLATIONARY shock (oil ${(toNumber(market.oilDeltaPct, 0) * 100).toFixed(1)}%, VIX elevated)`);
  }

  return { regime: worstRegime, reason: reasons, crisisType };
}

function computeRiskScore(vix, fearGreed, oilPrice, intelligence = {}) {
  const geopolitics = intelligence.geopolitics || FALLBACK_VALUES.geopolitics;
  const fed = intelligence.fed || {};
  const vixScore = Math.min(100, Math.max(0, ((vix - 10) / 30) * 100));
  const fgScore = Math.min(100, Math.max(0, 100 - fearGreed));
  const oilScore = Math.min(100, Math.max(0, ((oilPrice - 50) / 70) * 100));
  const geopoliticsScore = clamp(toNumber(geopolitics.riskScore, 0), 0, 100);
  const sentiment = clamp(toNumber(geopolitics.sentiment, 0), -1, 1);
  const sentimentScore = clamp(((1 - sentiment) / 2) * 100, 0, 100);

  let score = Math.round(
    (vixScore * 0.35)
    + (geopoliticsScore * 0.30)
    + (sentimentScore * 0.15)
    + (fgScore * 0.10)
    + (oilScore * 0.10)
  );

  if (geopolitics.stayCashTrigger) {
    score = Math.max(score, 95);
  } else if (fed.inDangerZone) {
    score = Math.max(score, 82);
  } else if (fed.isEventDay) {
    score = Math.max(score, 60);
  }

  return clamp(score, 0, 100);
}

function regimeConstraints(regime, options = {}) {
  const strategyMode = strategyModeForRegime(regime);
  const crisisType = String(options.crisisType || CRISIS_TYPES.NONE).trim().toLowerCase() || CRISIS_TYPES.NONE;
  const crisisUniverse = resolveCrisisUniverse(crisisType);
  switch (String(regime || '').toLowerCase()) {
    case 'stay_cash':
      return {
        strategyMode,
        crisisType,
        allowLongs: true,
        blockNewPositions: false,
        allowCrisisTrades: true,
        positionSizeMultiplier: 0.25,
        buyConfidenceMultiplier: 0.85,
        sellConfidenceMultiplier: 1.15,
        crisisUniverse,
        crisisTradeDirections: ['BUY', 'SHORT', 'COVER', 'BUY_PUT', 'HOLD'],
        crisisPhaseOneDirections: ['BUY', 'HOLD'],
        crisisPositionMinPct: 0.01,
        crisisPositionMaxPct: 0.025,
        crisisBookMaxPct: 0.08,
      };
    case 'red':
      return {
        strategyMode,
        crisisType,
        allowLongs: true,
        blockNewPositions: false,
        positionSizeMultiplier: 0.25,
        buyConfidenceMultiplier: 0.9,
        sellConfidenceMultiplier: 1.05,
        crisisUniverse,
      };
    case 'yellow':
      return {
        strategyMode,
        crisisType,
        allowLongs: true,
        blockNewPositions: false,
        positionSizeMultiplier: 0.5,
        buyConfidenceMultiplier: 0.95,
        sellConfidenceMultiplier: 1.0,
        crisisUniverse,
      };
    default:
      return {
        strategyMode,
        crisisType,
        allowLongs: true,
        blockNewPositions: false,
        positionSizeMultiplier: 1.0,
        buyConfidenceMultiplier: 1.0,
        sellConfidenceMultiplier: 1.0,
        crisisUniverse: CRISIS_UNIVERSE,
      };
  }
}

function applyMacroRiskToSignal(signal = {}, macroRisk = null) {
  const normalized = {
    ...signal,
    ticker: String(signal.ticker || '').trim().toUpperCase(),
    direction: toDirection(signal.direction),
    confidence: normalizeConfidence(signal.confidence),
    reasoning: String(signal.reasoning || '').trim(),
  };

  if (!macroRisk || !macroRisk.constraints) {
    return normalized;
  }

  const regime = String(macroRisk.regime || '').trim().toLowerCase();
  const strategyMode = String(macroRisk.strategyMode || strategyModeForRegime(regime)).trim().toLowerCase();
  const constraints = macroRisk.constraints || {};
  const crisisUniverse = getCrisisUniverse(macroRisk);
  let { direction, confidence, reasoning } = normalized;
  const sizeMultiplier = clamp(toNumber(constraints.positionSizeMultiplier, 1), 0, 1);
  const reducedSizeNote = sizeMultiplier < 1
    ? `Macro ${String(macroRisk.regime || regime).toUpperCase()} keeps ${direction || 'this setup'} live but trims size to ${(sizeMultiplier * 100).toFixed(0)}% of normal.`
    : '';

  if (direction === 'BUY') {
    const crisisEligibleBuy = strategyMode === 'crisis' && isCrisisTicker(normalized.ticker, crisisUniverse);
    confidence = normalizeConfidence(confidence * toNumber(constraints.buyConfidenceMultiplier, 1));
    if (crisisEligibleBuy) {
      reasoning = reasoning
        ? `${reasoning} Macro CRISIS mode allows crisis-universe hedge buys. ${reducedSizeNote}`.trim()
        : `Macro CRISIS mode allows crisis-universe hedge buys. ${reducedSizeNote}`.trim();
    } else if (reducedSizeNote) {
      reasoning = reasoning
        ? `${reasoning} ${reducedSizeNote}`
        : reducedSizeNote;
    }
  } else if (direction === 'SELL') {
    confidence = normalizeConfidence(confidence * toNumber(constraints.sellConfidenceMultiplier, 1));
    if (regime === 'red' || regime === 'stay_cash') {
      reasoning = reasoning
        ? `${reasoning} Macro regime favors defensive de-risking.${reducedSizeNote ? ` ${reducedSizeNote}` : ''}`
        : `Macro regime favors defensive de-risking.${reducedSizeNote ? ` ${reducedSizeNote}` : ''}`;
    } else if (reducedSizeNote) {
      reasoning = reasoning
        ? `${reasoning} ${reducedSizeNote}`
        : reducedSizeNote;
    }
  } else if (direction === 'SHORT' || direction === 'COVER' || direction === 'BUY_PUT') {
    const redShortAllowed = regime === 'red' && (direction === 'SHORT' || direction === 'COVER');
    if (strategyMode === 'crisis' || redShortAllowed) {
      reasoning = reasoning
        ? `${reasoning} ${redShortAllowed ? 'Macro RED regime permits defensive short exposure at reduced size.' : 'Macro CRISIS mode permits bearish hedge analysis.'}`
        : (redShortAllowed ? 'Macro RED regime permits defensive short exposure at reduced size.' : 'Macro CRISIS mode permits bearish hedge analysis.');
    } else {
      direction = 'HOLD';
      reasoning = reasoning
        ? `${reasoning} Bearish hedge signals are reserved for CRISIS mode.`
        : 'Bearish hedge signals are reserved for CRISIS mode.';
      confidence = clamp(Math.max(confidence, 0.7), 0, 1);
    }
  }

  return {
    ...normalized,
    direction,
    confidence: Number(confidence.toFixed(2)),
    reasoning: reasoning.trim(),
  };
}

async function assessMacroRisk(options = {}) {
  const { skipCache = false } = options;
  const now = options.now || new Date();

  if (!skipCache && _cache && (Date.now() - _cache.timestamp) < CACHE_TTL_MS) {
    return _cache.result;
  }
  if (!skipCache && _inflight) {
    return _inflight;
  }

  _inflight = (async () => {
    const [fearGreedResult, vixResult, oilResult, geopolitics] = await Promise.all([
      fetchFearGreed({ now }),
      fetchFredSeries('VIXCLS', 'VIX', FALLBACK_VALUES.vix, {
        now,
        staleAfterMs: INDICATOR_STALE_AFTER_MS.vixFred,
        staleReasonIfTooOld: 'fred_vix_observation_stale',
      }),
      fetchOilPrice({ now }),
      fetchGeopoliticalIntelligence(options),
    ]);

    const intelligence = {
      geopolitics,
      fed: getFedEventState(now),
      market: {
        vixDeltaPct: toNumber(vixResult.deltaPct, 0),
        oilDeltaPct: toNumber(oilResult.deltaPct, 0),
        vixObservedAt: vixResult.observedAt,
        oilObservedAt: oilResult.observedAt,
        fearGreedObservedAt: fearGreedResult.observedAt,
        vixStale: vixResult.stale === true,
        oilStale: oilResult.stale === true,
        fearGreedStale: fearGreedResult.stale === true,
      },
    };
    const vix = vixResult.value;
    const fearGreed = fearGreedResult.value;
    const oilPrice = oilResult.value;
    const { regime, reason, crisisType } = classifyRegime(vix, fearGreed, oilPrice, intelligence, now);
    const score = computeRiskScore(vix, fearGreed, oilPrice, intelligence);
    const constraints = regimeConstraints(regime, { crisisType });
    const strategyMode = strategyModeForRegime(regime);
    const fetchedAt = new Date().toISOString();
    const reasons = [
      buildIndicatorStaleReason('VIX', vixResult),
      buildIndicatorStaleReason('Fear & Greed', fearGreedResult),
      buildIndicatorStaleReason('Oil', oilResult),
      ...reason,
    ].filter(Boolean);

    const result = {
      regime,
      strategyMode,
      crisisType,
      score,
      indicators: {
        vix: { ...vixResult, value: vix },
        fearGreed: { ...fearGreedResult, value: fearGreed },
        oilPrice: { ...oilResult, value: oilPrice },
      },
      intelligence,
      constraints,
      crisisUniverse: getCrisisUniverse({ crisisType, constraints }),
      reason: reasons.join('; '),
      fetchedAt,
    };

    _cache = { result, timestamp: Date.now() };
    return result;
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

function clearCache() {
  _cache = null;
  _inflight = null;
}

module.exports = {
  assessMacroRisk,
  applyMacroRiskToSignal,
  clearCache,
  _internals: {
    classifyRegime,
    computeRiskScore,
    regimeConstraints,
    strategyModeForRegime,
    fetchFearGreed,
    fetchFredSeries,
    fetchLiveOilPrice,
    fetchOilPrice,
    fetchGeopoliticalIntelligence,
    classifyCrisisType,
    getFedEventState,
    normalizeGdeltArticles,
    buildToneRiskScore,
    buildGdeltQuery,
    FALLBACK_VALUES,
    INDICATOR_STALE_AFTER_MS,
    CACHE_TTL_MS,
    FOMC_DECISION_DATES_2026,
  },
};
