'use strict';

const polymarketClient = require('./polymarket-client');

const DEFAULT_ALLOWED_CATEGORIES = Object.freeze([
  'politics',
  'crypto',
  'finance',
  'sports',
  'world',
  'world events',
]);

const DEFAULT_MIN_LIQUIDITY = 10000;
const DEFAULT_MIN_VOLUME = 10000;
const DEFAULT_MIN_DAYS_TO_RESOLUTION = 1;
const DEFAULT_MAX_DAYS_TO_RESOLUTION = 90;
const DEFAULT_MAX_SPREAD = 0.12;
const DEFAULT_MIN_EDGE = 0.1;

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeCategory(value) {
  const normalized = toText(value, 'general').toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized.startsWith('world')) return 'world';
  return normalized;
}

function normalizeOutcome(value) {
  const normalized = toText(value).toLowerCase();
  if (['yes', 'y'].includes(normalized)) return 'yes';
  if (['no', 'n'].includes(normalized)) return 'no';
  return normalized;
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function differenceInDays(fromDate, toDate) {
  const ms = toDate.getTime() - fromDate.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function getSpread(book = {}) {
  const bestBid = toNumber(book.bestBid, NaN);
  const bestAsk = toNumber(book.bestAsk, NaN);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  return Number((bestAsk - bestBid).toFixed(4));
}

function getMidpointPrice(token = {}, book = {}) {
  const bookMidpoint = toNumber(book.midpoint, NaN);
  if (Number.isFinite(bookMidpoint) && bookMidpoint >= 0 && bookMidpoint <= 1) {
    return Number(bookMidpoint.toFixed(4));
  }

  const fallback = toNumber(token.price, NaN);
  if (Number.isFinite(fallback) && fallback >= 0 && fallback <= 1) {
    return Number(fallback.toFixed(4));
  }

  return null;
}

function selectBinaryTokens(tokens = []) {
  const normalized = tokens.map((token) => ({
    ...token,
    outcomeKey: normalizeOutcome(token?.outcome),
  }));
  const yesToken = normalized.find((token) => token.outcomeKey === 'yes');
  const noToken = normalized.find((token) => token.outcomeKey === 'no');
  if (!yesToken || !noToken) return null;
  return { yesToken, noToken };
}

function sortByMarketQuality(a, b) {
  return (
    toNumber(b.liquidity, 0) - toNumber(a.liquidity, 0)
    || toNumber(b.volume24h, 0) - toNumber(a.volume24h, 0)
    || toNumber(a.daysToResolution, 999) - toNumber(b.daysToResolution, 999)
  );
}

async function enrichMarket(rawMarket, options = {}) {
  const binaryTokens = selectBinaryTokens(rawMarket.tokens);
  if (!binaryTokens) return null;

  const [yesBook, noBook] = await Promise.all([
    polymarketClient.getMarketBook(binaryTokens.yesToken.tokenId, options).catch(() => ({})),
    polymarketClient.getMarketBook(binaryTokens.noToken.tokenId, options).catch(() => ({})),
  ]);

  let yesPrice = getMidpointPrice(binaryTokens.yesToken, yesBook);
  let noPrice = getMidpointPrice(binaryTokens.noToken, noBook);
  if (yesPrice == null && noPrice != null) yesPrice = Number((1 - noPrice).toFixed(4));
  if (noPrice == null && yesPrice != null) noPrice = Number((1 - yesPrice).toFixed(4));

  return {
    conditionId: rawMarket.conditionId,
    question: rawMarket.question,
    outcomes: ['Yes', 'No'],
    tokens: {
      yes: binaryTokens.yesToken.tokenId,
      no: binaryTokens.noToken.tokenId,
    },
    currentPrices: {
      yes: yesPrice,
      no: noPrice,
    },
    volume24h: Math.max(toNumber(rawMarket.volume24h, 0), toNumber(rawMarket.volume, 0)),
    liquidity: toNumber(rawMarket.liquidity, 0),
    resolutionDate: rawMarket.endDate || null,
    category: normalizeCategory(rawMarket.category),
    spread: {
      yes: getSpread(yesBook),
      no: getSpread(noBook),
      max: Math.max(getSpread(yesBook) ?? 0, getSpread(noBook) ?? 0),
    },
    tickSize: toText(rawMarket.tickSize),
    description: toText(rawMarket.description),
    slug: toText(rawMarket.slug),
    icon: toText(rawMarket.icon),
    raw: rawMarket.raw || rawMarket,
  };
}

function passesFilters(market, options = {}) {
  if (!market) return false;

  const now = normalizeDate(options.now) || new Date();
  const resolutionDate = normalizeDate(market.resolutionDate);
  if (!resolutionDate) return false;

  const daysToResolution = differenceInDays(now, resolutionDate);
  market.daysToResolution = Number(daysToResolution.toFixed(2));

  const minDays = toNumber(options.minDaysToResolution, DEFAULT_MIN_DAYS_TO_RESOLUTION);
  const maxDays = toNumber(options.maxDaysToResolution, DEFAULT_MAX_DAYS_TO_RESOLUTION);
  if (daysToResolution < minDays || daysToResolution > maxDays) return false;

  const minLiquidity = toNumber(options.minLiquidity, DEFAULT_MIN_LIQUIDITY);
  if (market.liquidity < minLiquidity) return false;

  const minVolume = toNumber(options.minVolume, DEFAULT_MIN_VOLUME);
  if (market.volume24h < minVolume) return false;

  const allowedCategories = new Set(
    (Array.isArray(options.categories) && options.categories.length > 0
      ? options.categories
      : DEFAULT_ALLOWED_CATEGORIES).map(normalizeCategory)
  );
  if (!allowedCategories.has(market.category)) return false;

  const maxSpread = toNumber(options.maxSpread, DEFAULT_MAX_SPREAD);
  if (market.spread.max > maxSpread) return false;

  return market.currentPrices.yes != null && market.currentPrices.no != null;
}

async function scanMarkets(options = {}) {
  const limit = Math.max(1, Number.parseInt(String(options.limit || 25), 10) || 25);
  const rawMarkets = await polymarketClient.getMarkets({
    activeOnly: true,
    acceptingOrdersOnly: true,
    minLiquidity: toNumber(options.minLiquidity, DEFAULT_MIN_LIQUIDITY),
    minVolume: toNumber(options.minVolume, DEFAULT_MIN_VOLUME),
    limitPages: options.limitPages,
  }, options);

  const enriched = await Promise.all(rawMarkets.map((market) => enrichMarket(market, options)));
  return enriched
    .filter((market) => passesFilters(market, options))
    .sort(sortByMarketQuality)
    .slice(0, limit);
}

function normalizeProbabilityEntry(entry) {
  if (!entry) return null;

  if (Array.isArray(entry) && entry.length >= 2) {
    return normalizeProbabilityEntry({ conditionId: entry[0], probability: entry[1] });
  }

  const conditionId = toText(entry.conditionId || entry.marketId || entry.id);
  const probability = toNumber(entry.probability, NaN);
  if (!conditionId || !Number.isFinite(probability)) return null;

  return {
    conditionId,
    probability,
    confidence: toNumber(entry.confidence, 0.5),
  };
}

function toProbabilityMap(agentProbabilities) {
  if (agentProbabilities instanceof Map) {
    return new Map(
      Array.from(agentProbabilities.entries())
        .map((entry) => normalizeProbabilityEntry(entry))
        .filter(Boolean)
        .map((entry) => [entry.conditionId, entry])
    );
  }

  if (Array.isArray(agentProbabilities)) {
    return new Map(
      agentProbabilities
        .map((entry) => normalizeProbabilityEntry(entry))
        .filter(Boolean)
        .map((entry) => [entry.conditionId, entry])
    );
  }

  if (agentProbabilities && typeof agentProbabilities === 'object') {
    return new Map(
      Object.entries(agentProbabilities)
        .map(([conditionId, value]) => normalizeProbabilityEntry(
          value && typeof value === 'object'
            ? { conditionId, ...value }
            : { conditionId, probability: value }
        ))
        .filter(Boolean)
        .map((entry) => [entry.conditionId, entry])
    );
  }

  return new Map();
}

function rankByEdge(markets = [], agentProbabilities = [], options = {}) {
  const probabilityMap = toProbabilityMap(agentProbabilities);
  const minEdge = toNumber(options.minEdge, DEFAULT_MIN_EDGE);

  return markets
    .map((market) => {
      const estimate = probabilityMap.get(market.conditionId);
      if (!estimate) return null;

      const marketPrice = toNumber(market.currentPrices?.yes, NaN);
      if (!Number.isFinite(marketPrice)) return null;

      const edge = Number((estimate.probability - marketPrice).toFixed(4));
      const absoluteEdge = Math.abs(edge);
      if (absoluteEdge < minEdge) return null;

      return {
        ...market,
        consensusProbability: Number(estimate.probability.toFixed(4)),
        confidence: Number(estimate.confidence.toFixed(2)),
        marketPrice,
        edge,
        absoluteEdge: Number(absoluteEdge.toFixed(4)),
        expectedValue: Number(((estimate.probability - marketPrice) * 100).toFixed(2)),
        action: edge > 0 ? 'BUY_YES' : 'BUY_NO',
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.absoluteEdge - a.absoluteEdge || b.confidence - a.confidence);
}

function getMarketContext(market = {}) {
  const yesPrice = toNumber(market.currentPrices?.yes, NaN);
  const noPrice = toNumber(market.currentPrices?.no, NaN);
  const spread = toNumber(market.spread?.max, 0);
  const daysToResolution = toNumber(market.daysToResolution, NaN);
  const resolutionDate = normalizeDate(market.resolutionDate);

  return {
    conditionId: toText(market.conditionId),
    question: toText(market.question),
    category: normalizeCategory(market.category),
    currentPrices: {
      yes: Number.isFinite(yesPrice) ? yesPrice : null,
      no: Number.isFinite(noPrice) ? noPrice : null,
    },
    volume24h: toNumber(market.volume24h, 0),
    liquidity: toNumber(market.liquidity, 0),
    resolutionDate: resolutionDate ? resolutionDate.toISOString() : null,
    daysToResolution: Number.isFinite(daysToResolution) ? Number(daysToResolution.toFixed(2)) : null,
    spread: Number(spread.toFixed(4)),
    summary: `${toText(market.question)} | YES ${Number.isFinite(yesPrice) ? yesPrice.toFixed(2) : 'n/a'} | NO ${Number.isFinite(noPrice) ? noPrice.toFixed(2) : 'n/a'} | vol $${Math.round(toNumber(market.volume24h, 0)).toLocaleString('en-US')} | resolves ${resolutionDate ? resolutionDate.toISOString().slice(0, 10) : 'unknown'}`,
  };
}

module.exports = {
  DEFAULT_ALLOWED_CATEGORIES,
  DEFAULT_MIN_LIQUIDITY,
  DEFAULT_MIN_VOLUME,
  DEFAULT_MIN_DAYS_TO_RESOLUTION,
  DEFAULT_MAX_DAYS_TO_RESOLUTION,
  DEFAULT_MAX_SPREAD,
  DEFAULT_MIN_EDGE,
  scanMarkets,
  rankByEdge,
  getMarketContext,
};
