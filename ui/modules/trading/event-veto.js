'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');
const dataIngestion = require('./data-ingestion');

const GDELT_API_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const DEFAULT_GDELT_TIMESPAN = '24h';
const DEFAULT_GDELT_MAX_RECORDS = 10;
const DEFAULT_SUPPLEMENTAL_LIMIT = 8;
const DEFAULT_X_WATCHLIST_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'x-watchlist-state.json'),
  { forWrite: true }
);

const SUPPLEMENTAL_NEWS_FEEDS = Object.freeze([
  {
    id: 'reuters_best',
    kind: 'rss',
    scope: 'all',
    url: 'https://reutersbest.com/feed/',
    source: 'Reuters Best',
  },
  {
    id: 'fed_press',
    kind: 'rss',
    scope: 'all',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    source: 'Federal Reserve',
  },
  {
    id: 'sec_press',
    kind: 'rss',
    scope: 'all',
    url: 'https://www.sec.gov/news/pressreleases.rss',
    source: 'SEC',
  },
  {
    id: 'coindesk_rss',
    kind: 'rss',
    scope: 'crypto',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    source: 'CoinDesk',
  },
  {
    id: 'coingecko_news',
    kind: 'coingecko',
    scope: 'crypto',
    url: 'https://api.coingecko.com/api/v3/news?per_page=12&page=1',
    source: 'CoinGecko',
  },
  {
    id: 'coinbase_status',
    kind: 'atom',
    scope: 'crypto',
    url: 'https://status.coinbase.com/history.atom',
    source: 'Coinbase Status',
  },
  {
    id: 'kraken_status',
    kind: 'atom',
    scope: 'crypto',
    url: 'https://status.kraken.com/history.atom',
    source: 'Kraken Status',
  },
  {
    id: 'x_watchlist',
    kind: 'x_watchlist',
    scope: 'crypto',
    source: 'X Watchlist',
    statePath: DEFAULT_X_WATCHLIST_STATE_PATH,
  },
]);

const TIER1_SOURCE_RULES = Object.freeze([
  { match: /reuters/i, tier: 'tier1' },
  { match: /reuters best/i, tier: 'tier1' },
  { match: /\bap\b|associated press|apnews/i, tier: 'tier1' },
  { match: /bloomberg/i, tier: 'tier1' },
  { match: /federal reserve|fed\b/i, tier: 'official' },
  { match: /\bcme\b|cme group/i, tier: 'official' },
  { match: /\bsec\b|securities and exchange commission/i, tier: 'official' },
  { match: /u\.?s\.? treasury|treasury/i, tier: 'official' },
  { match: /coinbase/i, tier: 'official' },
  { match: /binance/i, tier: 'official' },
  { match: /kraken/i, tier: 'official' },
  { match: /bybit/i, tier: 'official' },
  { match: /\bokx\b/i, tier: 'official' },
  { match: /hyperliquid/i, tier: 'official' },
  { match: /\bx @coinbase\b|\bx @krakenfx\b|\bx @hyperliquidx\b|\bx @cz_binance\b/i, tier: 'official' },
  { match: /\bx @saylor\b|\bx @vitalikbuterin\b/i, tier: 'tier1' },
  { match: /\bx @whale_alert\b|\bx @lookonchain\b/i, tier: 'aggregated' },
  { match: /coindesk/i, tier: 'crypto_media' },
  { match: /cointelegraph/i, tier: 'crypto_media' },
  { match: /crypto\.news|crypto news/i, tier: 'crypto_media' },
  { match: /newsbtc/i, tier: 'crypto_media' },
  { match: /beincrypto/i, tier: 'crypto_media' },
  { match: /bitcoin\.com|news\.bitcoin\.com/i, tier: 'crypto_media' },
  { match: /coingecko/i, tier: 'aggregated' },
]);

const GDELT_CONFLICT_QUERY_TERMS = Object.freeze([
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
  'Kharg Island',
  '"South Pars"',
  '"Al Udeid"',
  'Aramco',
  '"Ras Tanura"',
]);

const GDELT_MACRO_QUERY_TERMS = Object.freeze([
  '"Federal Reserve"',
  'Fed',
  '"CME Group"',
  '"rate decision"',
  '"surprise hike"',
  '"unexpected cut"',
  'tariff',
  'tariffs',
  'OPEC',
  'oil',
  '"options expiry"',
  '"options expire"',
  '"max pain"',
  'derivatives',
]);

const GDELT_EXCHANGE_QUERY_TERMS = Object.freeze([
  'Coinbase',
  'Binance',
  'Kraken',
  'Bybit',
  'OKX',
  'Hyperliquid',
  'outage',
  'maintenance',
  'halt',
  'suspended',
  'advisory',
  'notice',
  '"withdrawals paused"',
  '"margin requirement"',
]);

const EVENT_RULES = Object.freeze([
  {
    severity: 'VETO',
    label: 'major_geopolitical_disruption',
    patterns: [/strait of hormuz/i, /\bhormuz\b/i, /military strike/i, /airstrike/i, /missile/i, /war\b/i],
  },
  {
    severity: 'VETO',
    label: 'fed_rate_shock',
    patterns: [/federal reserve/i, /\bfed\b/i, /rate decision/i, /emergency/i, /surprise hike/i, /unexpected cut/i],
  },
  {
    severity: 'VETO',
    label: 'exchange_outage_or_halt',
    patterns: [/halt/i, /suspend/i, /outage/i, /degraded/i, /withdrawals paused/i],
  },
  {
    severity: 'CAUTION',
    label: 'options_or_expiry_event',
    patterns: [/options expire/i, /options expiry/i, /max pain/i, /derivatives expir/i],
    affectedAssets: ['BTC/USD', 'ETH/USD'],
  },
  {
    severity: 'CAUTION',
    label: 'exchange_notice',
    patterns: [/notice/i, /advisory/i, /maintenance/i, /margin requirement/i, /risk parameter/i, /funding interval/i],
  },
  {
    severity: 'VETO',
    label: 'security_incident',
    patterns: [/exploit/i, /\bhack\b/i, /breach/i, /drain(ed)?/i],
  },
  {
    severity: 'CAUTION',
    label: 'treasury_purchase_signal',
    patterns: [/buy bitcoin/i, /bought bitcoin/i, /treasury purchase/i, /treasury reserve/i, /acquire(?:d|s)? .*bitcoin/i, /added .*btc/i],
    affectedAssets: ['BTC/USD'],
  },
  {
    severity: 'CAUTION',
    label: 'token_catalyst_event',
    patterns: [/\blisting\b/i, /\blists\b/i, /\bairdrop\b/i, /\bunlock\b/i],
  },
  {
    severity: 'CAUTION',
    label: 'macro_policy_event',
    patterns: [/tariff/i, /sanction/i, /opec/i, /oil/i, /cpi/i, /payrolls/i],
  },
]);

const KNOWN_ASSET_ALIASES = Object.freeze({
  'BTC/USD': ['BTC', 'BITCOIN'],
  'ETH/USD': ['ETH', 'ETHEREUM'],
  'SOL/USD': ['SOL', 'SOLANA'],
  'AVAX/USD': ['AVAX', 'AVALANCHE'],
  'LINK/USD': ['LINK', 'CHAINLINK'],
  'DOGE/USD': ['DOGE', 'DOGECOIN'],
  'ADA/USD': ['ADA', 'CARDANO'],
  'XRP/USD': ['XRP', 'RIPPLE'],
  'LTC/USD': ['LTC', 'LITECOIN'],
  'BNB/USD': ['BNB', 'BINANCE COIN'],
});

const DEFAULT_BREAKING_EVENT_HORIZON_MS = 60 * 60 * 1000;
const MARKET_BREAKING_EVENT_LABELS = new Set([
  'major_geopolitical_disruption',
  'fed_rate_shock',
  'exchange_outage_or_halt',
  'security_incident',
]);

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
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

function normalizeTicker(value) {
  const normalized = toText(value).toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('/USD') ? normalized : normalized;
}

function resolveDecisionSizeMultiplier(decision) {
  const normalized = toText(decision).toUpperCase();
  if (normalized === 'VETO') return 0.25;
  if (normalized === 'CAUTION' || normalized === 'DEGRADED') return 0.5;
  return 1;
}

function normalizeNewsItem(item = {}) {
  return {
    id: toText(item.id),
    headline: toText(item.headline || item.title),
    summary: toText(item.summary),
    source: toText(item.source),
    url: toText(item.url),
    createdAt: toIsoTimestamp(item.createdAt || item.publishedAt || item.updatedAt, null),
    symbols: Array.isArray(item.symbols) ? item.symbols.map(normalizeTicker).filter(Boolean) : [],
  };
}

function normalizeUniqueItems(items = []) {
  const deduped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeNewsItem(item);
    if (!normalized.headline && !normalized.url) continue;
    const key = `${normalized.id}::${normalized.url}::${normalized.headline}`.trim().toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }
  return Array.from(deduped.values());
}

function resolveSourceTier(source = '', url = '') {
  let host = '';
  try {
    host = url ? new URL(url).hostname : '';
  } catch {
    host = '';
  }
  const haystack = `${source} ${host}`;
  for (const rule of TIER1_SOURCE_RULES) {
    if (rule.match.test(haystack)) {
      return rule.tier;
    }
  }
  return null;
}

function buildGdeltQuery(queryTerms = []) {
  return `(${queryTerms.join(' OR ')})`;
}

async function fetchJson(url, timeoutMs = 8_000) {
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SquidRun/0.1.34',
        Accept: 'application/json',
      },
    });
    if (!response.ok) return null;
    if (typeof response.json === 'function') {
      const parsed = await response.json().catch(() => null);
      if (parsed != null) return parsed;
    }
    if (typeof response.text === 'function') {
      const text = await response.text().catch(() => null);
      if (!text) return null;
      return JSON.parse(text);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 8_000) {
  let timer = null;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SquidRun/0.1.34',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain;q=0.9, */*;q=0.8',
      },
    });
    if (!response.ok) return null;
    if (typeof response.text === 'function') {
      return response.text().catch(() => null);
    }
    if (typeof response.json === 'function') {
      const parsed = await response.json().catch(() => null);
      return parsed == null ? null : JSON.stringify(parsed);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toGdeltIsoTimestamp(value, fallback = null) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) {
    return direct.toISOString();
  }
  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) return fallback;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10)
  )).toISOString();
}

function normalizeGdeltArticle(article = {}) {
  return normalizeNewsItem({
    headline: article.title || article.headline || '',
    summary: article.snippet || article.summary || '',
    source: article.domain || article.domainname || article.source || '',
    url: article.url || '',
    createdAt: toGdeltIsoTimestamp(article.seendate || article.createdAt || article.publishedAt, null),
    symbols: [],
  });
}

function decodeXmlEntities(value = '') {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function stripXmlTags(value = '') {
  return decodeXmlEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractXmlValue(block = '', tagNames = []) {
  for (const tagName of tagNames) {
    const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = String(block || '').match(pattern);
    if (match) {
      const value = stripXmlTags(match[1]);
      if (value) return value;
    }
  }
  return '';
}

function extractXmlLink(block = '') {
  const attrMatch = String(block || '').match(/<link\b[^>]*href=['"]([^'"]+)['"][^>]*\/?>/i);
  if (attrMatch?.[1]) return decodeXmlEntities(attrMatch[1]).trim();
  return extractXmlValue(block, ['link', 'id']);
}

function parseXmlFeedItems(xmlText = '', source = '') {
  const xml = String(xmlText || '').trim();
  if (!xml) return [];
  const itemBlocks = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)).map((match) => match[0]);
  const entryBlocks = Array.from(xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)).map((match) => match[0]);
  const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks;
  return blocks.map((block) => normalizeNewsItem({
    headline: extractXmlValue(block, ['title']),
    summary: extractXmlValue(block, ['description', 'summary', 'content']),
    source,
    url: extractXmlLink(block),
    createdAt: extractXmlValue(block, ['pubDate', 'updated', 'published']),
    symbols: [],
  })).filter((item) => item.headline || item.url);
}

function normalizeCoinGeckoArticle(article = {}, source = 'CoinGecko') {
  return normalizeNewsItem({
    headline: article.title || article.headline || '',
    summary: article.description || article.summary || '',
    source: article.author || source,
    url: article.url || '',
    createdAt: article.updated_at || article.created_at || null,
    symbols: [],
  });
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeXWatchlistItem(item = {}) {
  return normalizeNewsItem({
    id: item.id || item.tweetId || '',
    headline: item.headline || item.text || '',
    summary: item.summary || item.text || '',
    source: item.source || (item.account ? `X @${item.account}` : 'X Watchlist'),
    url: item.url || '',
    createdAt: item.createdAt || null,
    symbols: Array.isArray(item.symbols) ? item.symbols : [],
  });
}

function inferNewsScope(symbols = []) {
  return symbols.some((symbol) => /\/USD$/i.test(String(symbol || '').trim())) ? 'crypto' : 'all';
}

function shouldFetchSupplementalFeed(feed = {}, symbols = []) {
  const scope = String(feed.scope || 'all').trim().toLowerCase();
  if (scope === 'all') return true;
  return inferNewsScope(symbols) === scope;
}

async function fetchSupplementalFeed(feed = {}, options = {}) {
  const timeoutMs = options.timeoutMs || 8_000;
  if (feed.kind === 'coingecko') {
    const payload = await fetchJson(feed.url, timeoutMs).catch(() => null);
    const articles = Array.isArray(payload?.data) ? payload.data : [];
    return articles.map((article) => normalizeCoinGeckoArticle(article, feed.source));
  }
  if (feed.kind === 'x_watchlist') {
    const seeded = Array.isArray(options.xWatchlistItems) ? options.xWatchlistItems : null;
    if (seeded) {
      return seeded.map(normalizeXWatchlistItem);
    }
    if (process.env.NODE_ENV === 'test' && !options.xWatchlistStatePath) {
      return [];
    }
    const statePath = toText(options.xWatchlistStatePath, feed.statePath || DEFAULT_X_WATCHLIST_STATE_PATH);
    const payload = readJsonFile(statePath, {});
    const items = Array.isArray(payload?.recentItems) ? payload.recentItems : [];
    return items.map(normalizeXWatchlistItem);
  }

  const xmlText = await fetchText(feed.url, timeoutMs).catch(() => null);
  return parseXmlFeedItems(xmlText, feed.source);
}

async function fetchSupplementalNews(options = {}) {
  const symbols = Array.isArray(options.symbols) ? options.symbols.map(normalizeTicker).filter(Boolean) : [];
  const feeds = SUPPLEMENTAL_NEWS_FEEDS.filter((feed) => shouldFetchSupplementalFeed(feed, symbols));
  const payloads = await Promise.all(feeds.map(async (feed) => {
    const items = await fetchSupplementalFeed(feed, options).catch(() => []);
    return Array.isArray(items) ? items.slice(0, options.supplementalMaxRecords || DEFAULT_SUPPLEMENTAL_LIMIT) : [];
  }));
  return normalizeUniqueItems(payloads.flat());
}

function isFreshNewsItem(item = {}, nowMs = Date.now(), staleAfterMs = 6 * 60 * 60 * 1000) {
  const itemTimeMs = item?.createdAt ? Date.parse(item.createdAt) : NaN;
  if (!Number.isFinite(itemTimeMs)) return false;
  return (nowMs - itemTimeMs) <= staleAfterMs;
}

async function fetchGdeltTier1News(options = {}) {
  const queries = Array.isArray(options.gdeltQueries) && options.gdeltQueries.length > 0
    ? options.gdeltQueries
    : [
      buildGdeltQuery(GDELT_CONFLICT_QUERY_TERMS),
      buildGdeltQuery(GDELT_MACRO_QUERY_TERMS),
      buildGdeltQuery(GDELT_EXCHANGE_QUERY_TERMS),
    ];

  const payloads = await Promise.all(queries.map(async (query) => {
    const params = new URLSearchParams({
      query,
      mode: 'artlist',
      format: 'json',
      maxrecords: String(options.gdeltMaxRecords || DEFAULT_GDELT_MAX_RECORDS),
      timespan: String(options.gdeltTimespan || DEFAULT_GDELT_TIMESPAN),
    });
    const payload = await fetchJson(`${GDELT_API_URL}?${params.toString()}`, options.timeoutMs || 8_000);
    const articles = Array.isArray(payload?.articles) ? payload.articles : [];
    return articles.map(normalizeGdeltArticle);
  }));

  return normalizeUniqueItems(payloads.flat());
}

function matchesSymbolScope(item = {}, symbols = []) {
  if (!Array.isArray(symbols) || symbols.length === 0) return true;
  if (!Array.isArray(item.symbols) || item.symbols.length === 0) return true;
  const symbolSet = new Set(symbols.map(normalizeTicker));
  return item.symbols.some((symbol) => symbolSet.has(normalizeTicker(symbol)));
}

function isBroadCryptoEventRule(rule = {}) {
  return ['major_geopolitical_disruption', 'fed_rate_shock', 'macro_policy_event'].includes(String(rule.label || '').trim());
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAliasesForSymbol(symbol = '') {
  const normalized = normalizeTicker(symbol);
  if (!normalized) return [];
  const direct = KNOWN_ASSET_ALIASES[normalized];
  if (Array.isArray(direct) && direct.length > 0) {
    return direct;
  }
  const base = normalized.replace(/\/USD$/i, '');
  return base ? [base] : [];
}

function textMentionsAlias(text = '', alias = '') {
  const cleanedAlias = String(alias || '').trim();
  if (!cleanedAlias) return false;
  const normalizedText = String(text || '').toUpperCase();
  if (!normalizedText) return false;
  if (/^[A-Z0-9]+$/.test(cleanedAlias)) {
    return new RegExp(`(^|[^A-Z0-9])${escapeRegExp(cleanedAlias)}([^A-Z0-9]|$)`, 'i').test(normalizedText);
  }
  return normalizedText.includes(cleanedAlias.toUpperCase());
}

function inferMentionedTrackedAssets(text = '', symbols = []) {
  return symbols.filter((symbol) => buildAliasesForSymbol(symbol).some((alias) => textMentionsAlias(text, alias)));
}

function mentionsOtherKnownAsset(text = '', symbols = []) {
  const inScope = new Set(symbols.map(normalizeTicker));
  return Object.entries(KNOWN_ASSET_ALIASES).some(([symbol, aliases]) => {
    if (inScope.has(symbol)) return false;
    return aliases.some((alias) => textMentionsAlias(text, alias));
  });
}

function matchEvent(item = {}, symbols = []) {
  const text = `${item.headline} ${item.summary}`.trim();
  if (!text) return null;
  for (const rule of EVENT_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(text))) {
      continue;
    }
    let affectedAssets = [];
    if (isBroadCryptoEventRule(rule)) {
      affectedAssets = symbols;
    } else if (Array.isArray(rule.affectedAssets)) {
      affectedAssets = rule.affectedAssets.filter((asset) => symbols.length === 0 || symbols.includes(asset));
    }
    if (rule.label === 'exchange_outage_or_halt' || rule.label === 'exchange_notice') {
      const scopedAssets = inferMentionedTrackedAssets(text, symbols);
      const venueAppliesBroadly = /hyperliquid/i.test(text);
      if (scopedAssets.length > 0) {
        affectedAssets = scopedAssets;
      } else if (mentionsOtherKnownAsset(text, symbols)) {
        continue;
      } else if (venueAppliesBroadly) {
        affectedAssets = symbols;
      } else {
        continue;
      }
    }
    if (rule.label === 'token_catalyst_event') {
      const scopedAssets = inferMentionedTrackedAssets(text, symbols);
      if (scopedAssets.length === 0) {
        continue;
      }
      affectedAssets = scopedAssets;
    }
    if (rule.label === 'treasury_purchase_signal') {
      const scopedAssets = inferMentionedTrackedAssets(text, symbols);
      if (scopedAssets.length > 0) {
        affectedAssets = scopedAssets;
      } else if (symbols.includes('BTC/USD') && /\bbtc\b|bitcoin/i.test(text)) {
        affectedAssets = ['BTC/USD'];
      } else {
        continue;
      }
    }
    return {
      severity: rule.severity,
      label: rule.label,
      affectedAssets: affectedAssets.length > 0 ? affectedAssets : symbols,
    };
  }
  return null;
}

async function fetchTier1News(options = {}) {
  const nowIso = toIsoTimestamp(options.now, new Date().toISOString());
  const nowMs = new Date(nowIso).getTime();
  const staleAfterMs = Math.max(60 * 60 * 1000, Number(options.staleAfterMs) || (6 * 60 * 60 * 1000));
  const collected = [];
  if (Array.isArray(options.newsItems) && options.newsItems.length > 0) {
    collected.push(...options.newsItems.map(normalizeNewsItem));
  }
  if (typeof options.newsProvider === 'function') {
    const provided = await options.newsProvider(options).catch(() => []);
    if (Array.isArray(provided)) {
      collected.push(...provided.map(normalizeNewsItem));
    }
  }
  if (collected.length === 0) {
    const fetched = await dataIngestion.getNews({
      ...options,
      symbols: options.symbols,
      limit: options.limit || 25,
    }).catch(() => []);
    if (Array.isArray(fetched)) {
      collected.push(...fetched.map(normalizeNewsItem));
    }
  }

  const normalized = normalizeUniqueItems(collected);
  const freshTier1Exists = normalized.some((item) => {
    return resolveSourceTier(item.source, item.url)
      && isFreshNewsItem(item, nowMs, staleAfterMs);
  });
  if (!freshTier1Exists) {
    const supplemental = await fetchSupplementalNews(options).catch(() => []);
    if (supplemental.length > 0) {
      normalized.push(...supplemental);
    }
  }

  const supplemented = normalizeUniqueItems(normalized);
  const freshRecognizedExists = supplemented.some((item) => {
    return resolveSourceTier(item.source, item.url)
      && isFreshNewsItem(item, nowMs, staleAfterMs);
  });
  if (freshRecognizedExists) {
    return supplemented;
  }

  const fallbackItems = await fetchGdeltTier1News(options).catch(() => []);
  return normalizeUniqueItems([...supplemented, ...fallbackItems]);
}

function buildMacroRiskFallbackEvent(options = {}, symbols = []) {
  const geopolitics = options?.macroRisk?.intelligence?.geopolitics;
  if (!geopolitics || typeof geopolitics !== 'object') return null;
  const sampleHeadlines = Array.isArray(geopolitics.sampleHeadlines) ? geopolitics.sampleHeadlines.filter(Boolean) : [];
  const articleCount = Number(geopolitics.articleCount) || 0;
  const riskScore = Number(geopolitics.riskScore) || 0;
  const activeKineticConflict = Boolean(geopolitics.activeKineticConflict);
  if (!articleCount && sampleHeadlines.length === 0) return null;
  if (!activeKineticConflict && riskScore < 60) return null;

  const decision = activeKineticConflict || riskScore >= 80 ? 'VETO' : 'CAUTION';
  const summaryHeadline = sampleHeadlines[0] || 'Live macro conflict feed detected elevated geopolitical risk.';
  return {
    decision,
    sizeMultiplier: resolveDecisionSizeMultiplier(decision),
    eventSummary: `macro_conflict_feed: ${summaryHeadline}`,
    sourceTier: 'aggregated',
    stale: false,
    affectedAssets: symbols,
    matchedEvents: sampleHeadlines.slice(0, 5).map((headline) => ({
      headline,
      summary: '',
      source: String(geopolitics.source || 'macro_feed'),
      sourceTier: 'aggregated',
      createdAt: null,
      stale: false,
      severity: decision,
      label: activeKineticConflict ? 'active_kinetic_conflict' : 'elevated_geopolitical_risk',
      affectedAssets: symbols,
    })),
  };
}

async function buildEventVeto(options = {}) {
  const symbols = Array.isArray(options.symbols) ? options.symbols.map(normalizeTicker).filter(Boolean) : [];
  const nowIso = toIsoTimestamp(options.now, new Date().toISOString());
  const nowMs = new Date(nowIso).getTime();
  const staleAfterMs = Math.max(60 * 60 * 1000, Number(options.staleAfterMs) || (6 * 60 * 60 * 1000));
  const breakingHorizonMs = Math.max(
    60 * 1000,
    Number(options.breakingHorizonMs) || DEFAULT_BREAKING_EVENT_HORIZON_MS
  );
  const newsItems = await fetchTier1News(options);
  const recognizedItems = newsItems.filter((item) => resolveSourceTier(item.source, item.url) && matchesSymbolScope(item, symbols));

  const matchedEvents = recognizedItems.map((item) => {
    const event = matchEvent(item, symbols);
    if (!event) return null;
    const sourceTier = resolveSourceTier(item.source, item.url);
    const itemTimeMs = item.createdAt ? Date.parse(item.createdAt) : NaN;
    const stale = Number.isFinite(itemTimeMs) ? (nowMs - itemTimeMs) > staleAfterMs : true;
    return {
      headline: item.headline,
      summary: item.summary,
      source: item.source,
      sourceTier,
      createdAt: item.createdAt,
      stale,
      ...event,
    };
  }).filter(Boolean);

  const freshRecognizedItems = recognizedItems.filter((item) => isFreshNewsItem(item, nowMs, staleAfterMs));
  const activeEvents = matchedEvents.filter((event) => !event.stale);
  const activeBreakingEvents = activeEvents.filter((event) => {
    if (!MARKET_BREAKING_EVENT_LABELS.has(String(event.label || '').trim())) {
      return false;
    }
    const createdAtMs = event.createdAt ? Date.parse(event.createdAt) : NaN;
    if (!Number.isFinite(createdAtMs)) {
      return false;
    }
    return (nowMs - createdAtMs) <= breakingHorizonMs;
  });
  const topEvent = activeBreakingEvents.sort((left, right) => {
    const severityRank = { VETO: 2, CAUTION: 1, CLEAR: 0 };
    return severityRank[right.severity] - severityRank[left.severity];
  })[0] || null;

  if (!topEvent) {
    return {
      decision: 'CLEAR',
      sizeMultiplier: resolveDecisionSizeMultiplier('CLEAR'),
      eventSummary: 'No market-breaking event in the next hour.',
      sourceTier: freshRecognizedItems.length > 0 ? 'feeds_checked' : (recognizedItems.length > 0 ? 'feeds_stale' : 'none'),
      stale: freshRecognizedItems.length === 0,
      affectedAssets: [],
      matchedEvents: matchedEvents.slice(0, 5),
    };
  }

  return {
    decision: topEvent.severity,
    sizeMultiplier: resolveDecisionSizeMultiplier(topEvent.severity),
    eventSummary: `${topEvent.label}: ${topEvent.headline || topEvent.summary || 'market-breaking event detected'}`,
    sourceTier: topEvent.sourceTier,
    stale: false,
    affectedAssets: Array.isArray(topEvent.affectedAssets) ? topEvent.affectedAssets : [],
    matchedEvents: activeBreakingEvents.slice(0, 5),
  };
}

module.exports = {
  DEFAULT_X_WATCHLIST_STATE_PATH,
  SUPPLEMENTAL_NEWS_FEEDS,
  TIER1_SOURCE_RULES,
  buildEventVeto,
  fetchTier1News,
  resolveSourceTier,
};
