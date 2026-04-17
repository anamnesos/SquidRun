#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

process.env.DOTENV_CONFIG_QUIET = 'true';

const { resolveCoordPath } = require('../config');
const { sendTelegram } = require('./hm-telegram');

const DEFAULT_CHAT_ID = '5613428850';
const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'x-watchlist-state.json'), { forWrite: true });
const DEFAULT_HM_SEND_SCRIPT_PATH = path.resolve(__dirname, 'hm-send.js');
const DEFAULT_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36';
const DEFAULT_RECENT_WINDOW_HOURS = 6;
const DEFAULT_WATCHLIST = Object.freeze([
  'saylor',
  'cz_binance',
  'VitalikButerin',
  'coinbase',
  'krakenfx',
  'whale_alert',
  'lookonchain',
]);

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function loadProjectEnv() {
  try {
    const envPath = path.join(process.env.SQUIDRUN_PROJECT_ROOT || path.resolve(__dirname, '..', '..'), '.env');
    if (!fs.existsSync(envPath)) return;
    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] == null) {
        process.env[key] = value;
      }
    }
  } catch {}
}

async function fetchText(url, options = {}) {
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      'user-agent': options.userAgent || DEFAULT_BROWSER_USER_AGENT,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`);
  }
  return response.text();
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, '\'')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseTimestampMs(value = '') {
  const timestampMs = Date.parse(String(value || ''));
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function uniqueById(entries = []) {
  const seen = new Set();
  const output = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = toText(entry?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(entry);
  }
  return output;
}

function normalizeAccount(value = '') {
  return toText(value).replace(/^@+/, '');
}

function resolveWatchlist(accounts = DEFAULT_WATCHLIST) {
  const list = Array.isArray(accounts) ? accounts : String(accounts || '').split(',');
  const seen = new Set();
  const normalized = [];
  for (const entry of list) {
    const account = normalizeAccount(entry);
    const key = account.toLowerCase();
    if (!account || seen.has(key)) continue;
    seen.add(key);
    normalized.push(account);
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_WATCHLIST];
}

function buildTimelineUrl(account = '') {
  return `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(normalizeAccount(account))}`;
}

function extractNextDataJson(html = '') {
  const match = String(html || '').match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseTimelineEntries(html = '', account = '') {
  const normalizedAccount = normalizeAccount(account);
  const nextData = extractNextDataJson(html);
  const entries = nextData?.props?.pageProps?.timeline?.entries;
  if (!Array.isArray(entries)) return [];
  return uniqueById(
    entries
      .filter((entry) => entry?.type === 'tweet' && entry?.content?.tweet)
      .map((entry) => {
        const tweet = entry.content.tweet || {};
        const id = toText(tweet.id_str || tweet.conversation_id_str || entry.entry_id);
        const permalink = toText(tweet.permalink);
        const text = decodeHtmlEntities(toText(tweet.full_text || tweet.text));
        if (!id || !text) return null;
        return {
          id: `tweet:${normalizedAccount.toLowerCase()}:${id}`,
          tweetId: id,
          account: normalizedAccount,
          createdAt: toText(tweet.created_at) || null,
          text,
          headline: text,
          summary: text,
          url: permalink
            ? `https://x.com${permalink}`
            : `https://x.com/${normalizedAccount}/status/${id}`,
          source: `X @${normalizedAccount}`,
          symbols: [],
        };
      })
      .filter(Boolean)
  );
}

function sortEntriesByCreatedAt(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry, index) => ({
      entry,
      index,
      createdAtMs: parseTimestampMs(entry?.createdAt),
    }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.createdAtMs) ? left.createdAtMs : Number.NEGATIVE_INFINITY;
      const rightTime = Number.isFinite(right.createdAtMs) ? right.createdAtMs : Number.NEGATIVE_INFINITY;
      if (leftTime === rightTime) {
        return left.index - right.index;
      }
      return rightTime - leftTime;
    })
    .map((item) => item.entry);
}

function collectNewEntries(entries = [], lastSeenId = null) {
  const output = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (lastSeenId && entry.id === lastSeenId) break;
    output.push(entry);
  }
  return output;
}

function resolveRecentWindowMs(options = {}) {
  const hours = Number.parseFloat(options.recentHours);
  const normalizedHours = Number.isFinite(hours) && hours > 0
    ? hours
    : DEFAULT_RECENT_WINDOW_HOURS;
  return normalizedHours * 60 * 60 * 1000;
}

function isRecentEntry(entry = {}, nowIso = new Date().toISOString(), maxAgeMs = resolveRecentWindowMs()) {
  const nowMs = parseTimestampMs(nowIso);
  const createdAtMs = parseTimestampMs(entry?.createdAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(createdAtMs) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return false;
  }
  return createdAtMs <= nowMs && (nowMs - createdAtMs) <= maxAgeMs;
}

function filterRecentEntries(entries = [], nowIso = new Date().toISOString(), maxAgeMs = resolveRecentWindowMs()) {
  return sortEntriesByCreatedAt(entries).filter((entry) => isRecentEntry(entry, nowIso, maxAgeMs));
}

function defaultState(accounts = DEFAULT_WATCHLIST) {
  return {
    initialized: false,
    accounts: Object.fromEntries(resolveWatchlist(accounts).map((account) => ([account, {
      lastTweetId: null,
      updatedAt: null,
      latestTweet: null,
      lastError: null,
    }]))),
    lastAlertFingerprint: null,
    nextArchitectSequence: 1,
    updatedAt: null,
    recentItems: [],
  };
}

function normalizeAccountState(accountState = {}) {
  return {
    lastTweetId: toText(accountState.lastTweetId, null),
    updatedAt: toText(accountState.updatedAt, null),
    latestTweet: accountState.latestTweet && typeof accountState.latestTweet === 'object'
      ? accountState.latestTweet
      : null,
    lastError: toText(accountState.lastError, null),
  };
}

function normalizeState(state = {}, accounts = DEFAULT_WATCHLIST) {
  const watchlist = resolveWatchlist(accounts);
  const nextAccounts = {};
  const current = state && typeof state.accounts === 'object' ? state.accounts : {};
  for (const account of watchlist) {
    nextAccounts[account] = normalizeAccountState(current[account] || {});
  }
  return {
    initialized: state?.initialized === true,
    accounts: nextAccounts,
    lastAlertFingerprint: toText(state?.lastAlertFingerprint, null),
    nextArchitectSequence: Math.max(1, Number.parseInt(state?.nextArchitectSequence, 10) || 1),
    updatedAt: toText(state?.updatedAt, null),
    recentItems: Array.isArray(state?.recentItems) ? state.recentItems.filter(Boolean) : [],
  };
}

function pruneRecentItems(items = [], nowIso = new Date().toISOString(), maxItems = 160, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const nowMs = Date.parse(nowIso);
  const deduped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = toText(item?.id || item?.url || item?.headline);
    if (!id) continue;
    const createdAtMs = Date.parse(item?.createdAt || '');
    if (Number.isFinite(nowMs) && Number.isFinite(createdAtMs) && (nowMs - createdAtMs) > maxAgeMs) {
      continue;
    }
    if (!deduped.has(id)) {
      deduped.set(id, item);
    }
  }
  return Array.from(deduped.values())
    .sort((left, right) => Date.parse(right?.createdAt || 0) - Date.parse(left?.createdAt || 0))
    .slice(0, maxItems);
}

function truncateText(value = '', maxChars = 180) {
  const text = toText(value);
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizePosition(position = {}) {
  const size = Number(position?.size || 0);
  const coin = toText(position?.coin).toUpperCase();
  return {
    coin,
    ticker: coin ? `${coin}/USD` : '',
    side: size < 0 ? 'short' : (size > 0 ? 'long' : toText(position?.side, 'flat')),
    size,
  };
}

function inferAlertContext(entry = {}) {
  const account = normalizeAccount(entry.account);
  const text = toText(entry.text);
  const lowered = text.toLowerCase();
  const context = {
    affectedTickers: [],
    whyItMatters: 'This could move crypto sentiment short-term.',
    watchNote: 'Watch for a fast reaction across the crypto tape.',
    marketBias: 'neutral',
  };

  if (account.toLowerCase() === 'saylor' || /bitcoin|btc|treasury purchase|buy bitcoin|added .*btc|acquire(?:d|s)? .*bitcoin/i.test(text)) {
    context.affectedTickers = ['BTC/USD'];
    context.whyItMatters = 'This could move BTC and broad crypto sentiment short-term.';
    context.watchNote = 'Watch for a BTC-led squeeze higher across majors and high-beta alts.';
    context.marketBias = 'bullish_crypto';
    return context;
  }

  if (/listing|lists|goes live|perps|perpetual/i.test(text)) {
    const matches = Array.from(text.matchAll(/\b[A-Z]{2,10}\b/g)).map((match) => match[0]).filter((value) => value !== 'USD');
    context.affectedTickers = Array.from(new Set(matches.slice(0, 3).map((value) => `${value}/USD`)));
    context.whyItMatters = 'Listings and product launches can trigger sharp moves and squeeze positioning.';
    context.watchNote = context.affectedTickers.length > 0
      ? `Watch ${context.affectedTickers.join(', ')} for a volatility spike.`
      : 'Watch the newly mentioned market for a volatility spike.';
    context.marketBias = 'listing';
    return context;
  }

  if (/halt|outage|maintenance|withdrawals paused|degraded/i.test(lowered)) {
    context.whyItMatters = 'Operational issues can hit liquidity fast and spill into related markets.';
    context.watchNote = 'Watch for sudden spreads, forced unwinds, and correlated downside.';
    context.marketBias = 'risk_off';
    return context;
  }

  if (/exploit|hack|breach|drain/i.test(lowered)) {
    context.whyItMatters = 'Security headlines can trigger fast risk-off moves and force repricing.';
    context.watchNote = 'Watch the named token first, then broader alt sentiment.';
    context.marketBias = 'risk_off';
    return context;
  }

  if (/airdrop|unlock/i.test(lowered)) {
    context.whyItMatters = 'Airdrop and unlock headlines can shift supply expectations quickly.';
    context.watchNote = 'Watch for supply-driven selling or a short-lived squeeze if positioning is crowded.';
    context.marketBias = 'token_specific';
    return context;
  }

  return context;
}

function formatPositionReference(position = {}) {
  const normalized = normalizePosition(position);
  if (!normalized.coin || normalized.side === 'flat') return '';
  return `${normalized.coin} ${normalized.side}`;
}

function buildPositionWatchLine(positions = [], context = {}) {
  const normalizedPositions = (Array.isArray(positions) ? positions : [])
    .map(normalizePosition)
    .filter((position) => position.coin && position.side !== 'flat');
  if (normalizedPositions.length === 0) {
    return 'You have no open Hyperliquid positions right now.';
  }

  const directMatches = normalizedPositions.filter((position) => context.affectedTickers.includes(position.ticker));
  if (directMatches.length > 0) {
    const joined = directMatches.map(formatPositionReference).filter(Boolean).join(', ');
    return `You have an open ${joined}. Watch it closely for an immediate reaction.`;
  }

  if (context.marketBias === 'bullish_crypto') {
    const shorts = normalizedPositions.filter((position) => position.side === 'short');
    if (shorts.length > 0) {
      const joined = shorts.slice(0, 2).map(formatPositionReference).join(', ');
      return `You have an open ${joined}. A BTC-led squeeze could spill into alt shorts too.`;
    }
  }

  if (context.marketBias === 'risk_off') {
    const longs = normalizedPositions.filter((position) => position.side === 'long');
    if (longs.length > 0) {
      const joined = longs.slice(0, 2).map(formatPositionReference).join(', ');
      return `You have an open ${joined}. Risk-off headlines can pressure longs quickly.`;
    }
  }

  const joined = normalizedPositions.slice(0, 2).map(formatPositionReference).join(', ');
  return `You have an open ${joined}. Watch for correlated volatility.`;
}

function loadOpenPositions(options = {}) {
  if (typeof options.positionProvider === 'function') {
    try {
      return options.positionProvider(options) || [];
    } catch {
      return [];
    }
  }
  const statusScriptPath = path.resolve(toText(
    options.defiStatusScriptPath,
    path.join(__dirname, 'hm-defi-status.js')
  ));
  try {
    const result = spawnSync(process.execPath, [statusScriptPath, '--json'], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      timeout: 25_000,
      windowsHide: true,
    });
    const stdout = toText(result.stdout);
    if (!stdout) return [];
    const payload = JSON.parse(stdout);
    return Array.isArray(payload?.positions) ? payload.positions : [];
  } catch {
    return [];
  }
}

function buildAlertMessage(summary = {}, options = {}) {
  const positions = loadOpenPositions(options);
  const blocks = [];
  for (const entry of summary.newTweets || []) {
    const context = inferAlertContext(entry);
    blocks.push([
      `[X ALERT] @${entry.account} just tweeted: "${truncateText(entry.text, 140)}"`,
      `Why it matters: ${context.whyItMatters}`,
      buildPositionWatchLine(positions, context),
      `Link: ${entry.url}`,
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

function buildArchitectAlertMessage(summary = {}, options = {}) {
  const body = buildAlertMessage(summary, options);
  const sequence = Math.max(1, Number.parseInt(options.sequence, 10) || 1);
  return [
    `(SUPERVISOR #${sequence}): X watchlist alert for review.`,
    body,
    'Action: decide whether this matters to James before sending any Telegram summary.',
  ].join('\n\n');
}

function sendArchitectAlert(message = '', options = {}) {
  if (typeof options.agentMessageSender === 'function') {
    return options.agentMessageSender(message, options);
  }
  const hmSendScriptPath = path.resolve(toText(options.hmSendScriptPath, DEFAULT_HM_SEND_SCRIPT_PATH));
  try {
    const result = spawnSync(process.execPath, [hmSendScriptPath, 'architect', '--stdin'], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      input: message,
      timeout: 20_000,
      windowsHide: true,
    });
    return {
      ok: result.status === 0,
      exitCode: result.status,
      stdout: toText(result.stdout),
      stderr: toText(result.stderr),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
}

function buildFingerprint(summary = {}) {
  return JSON.stringify({
    tweets: (summary.newTweets || []).map((entry) => entry.id),
  });
}

async function runWatcher(options = {}) {
  const watchlist = resolveWatchlist(options.accounts || options.watchlist);
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const state = normalizeState(readJsonFile(statePath, defaultState(watchlist)) || {}, watchlist);
  const scannedAt = toText(options.nowIso, new Date().toISOString());
  const recentWindowMs = resolveRecentWindowMs(options);

  const accountResults = await Promise.all(watchlist.map(async (account) => {
    try {
      const html = await fetchText(buildTimelineUrl(account), options);
      return [account, { entries: parseTimelineEntries(html, account), error: null }];
    } catch (error) {
      return [account, { entries: [], error: error?.message || String(error) }];
    }
  }));

  const initialized = state.initialized === true;
  const latestByAccount = {};
  const newTweets = [];
  const nextAccounts = {};
  const recentItems = [...state.recentItems];

  for (const [account, result] of accountResults) {
    const entries = Array.isArray(result.entries) ? result.entries : [];
    const recentEntries = filterRecentEntries(entries, scannedAt, recentWindowMs);
    const previous = state.accounts?.[account] || {};
    const previousLatestTweet = isRecentEntry(previous.latestTweet, scannedAt, recentWindowMs)
      ? previous.latestTweet
      : null;
    const canCompare = initialized
      && toText(previous.lastTweetId)
      && recentEntries.some((entry) => entry.id === previous.lastTweetId);
    const latestTweet = recentEntries[0] || previousLatestTweet || null;
    const latestTweetId = latestTweet?.id || null;
    const delta = canCompare ? collectNewEntries(recentEntries, previous.lastTweetId) : [];
    latestByAccount[account] = latestTweet;
    newTweets.push(...delta);
    recentItems.push(...recentEntries.slice(0, 12));
    nextAccounts[account] = {
      lastTweetId: latestTweetId,
      updatedAt: scannedAt,
      latestTweet,
      lastError: result.error,
    };
  }

  const summary = {
    ok: true,
    scannedAt,
    initialized,
    accounts: watchlist,
    recentWindowHours: recentWindowMs / (60 * 60 * 1000),
    latestByAccount,
    newTweets,
    alertCount: newTweets.length,
    alerted: false,
    statePath,
    recentItems: pruneRecentItems(recentItems, scannedAt, 160, recentWindowMs),
  };

  const fingerprint = buildFingerprint(summary);
  const shouldAlert = summary.alertCount > 0 && fingerprint !== state.lastAlertFingerprint;
  let nextArchitectSequence = state.nextArchitectSequence;
  if (shouldAlert && options.sendArchitect !== false) {
    const architectMessage = buildArchitectAlertMessage(summary, {
      ...options,
      sequence: nextArchitectSequence,
    });
    const result = sendArchitectAlert(architectMessage, options);
    summary.architect = result;
    summary.alerted = Boolean(result?.ok);
    nextArchitectSequence += 1;
  }
  if (shouldAlert && options.sendTelegram === true) {
    const result = await sendTelegram(buildAlertMessage(summary, options), process.env, {
      chatId: toText(options.chatId, DEFAULT_CHAT_ID),
    });
    summary.telegram = result;
    summary.alerted = summary.alerted || Boolean(result?.ok);
  }

  writeJsonFile(statePath, {
    initialized: true,
    accounts: nextAccounts,
    updatedAt: scannedAt,
    recentItems: summary.recentItems,
    nextArchitectSequence,
    lastAlertFingerprint: shouldAlert ? fingerprint : state.lastAlertFingerprint,
  });

  return summary;
}

function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const options = {
    accounts: [...DEFAULT_WATCHLIST],
    chatId: DEFAULT_CHAT_ID,
    json: false,
    recentHours: DEFAULT_RECENT_WINDOW_HOURS,
    sendArchitect: true,
    sendTelegram: false,
    statePath: DEFAULT_STATE_PATH,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = toText(args[index]);
    if (token === '--json') {
      options.json = true;
    } else if (token === '--telegram') {
      options.sendTelegram = true;
    } else if (token === '--no-telegram') {
      options.sendTelegram = false;
    } else if (token === '--no-architect') {
      options.sendArchitect = false;
    } else if (token === '--chat-id') {
      options.chatId = toText(args[index + 1], DEFAULT_CHAT_ID);
      index += 1;
    } else if (token === '--state-path') {
      options.statePath = toText(args[index + 1], DEFAULT_STATE_PATH);
      index += 1;
    } else if (token === '--recent-hours') {
      options.recentHours = Number.parseFloat(args[index + 1]) || DEFAULT_RECENT_WINDOW_HOURS;
      index += 1;
    } else if (token === '--accounts') {
      options.accounts = resolveWatchlist(toText(args[index + 1], '').split(','));
      index += 1;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runWatcher(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(`X watchlist scanned at ${summary.scannedAt}\n`);
  process.stdout.write(`Accounts: ${summary.accounts.join(', ')}\n`);
  process.stdout.write(`Alerts: ${summary.alertCount}\n`);
  if (summary.alertCount > 0) {
    process.stdout.write(`${buildAlertMessage(summary)}\n`);
  }
}

if (require.main === module) {
  loadProjectEnv();
  main().catch((error) => {
    const summary = {
      ok: false,
      error: error?.message || String(error),
      stack: error?.stack || null,
    };
    process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_CHAT_ID,
  DEFAULT_HM_SEND_SCRIPT_PATH,
  DEFAULT_STATE_PATH,
  DEFAULT_WATCHLIST,
  buildAlertMessage,
  buildArchitectAlertMessage,
  buildTimelineUrl,
  collectNewEntries,
  extractNextDataJson,
  filterRecentEntries,
  isRecentEntry,
  parseArgs,
  parseTimelineEntries,
  runWatcher,
  sortEntriesByCreatedAt,
};
