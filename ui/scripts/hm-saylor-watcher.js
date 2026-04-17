#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

process.env.DOTENV_CONFIG_QUIET = 'true';

const { resolveCoordPath } = require('../config');
const { DEFAULT_AGENT_TARGETS, normalizeTargets: normalizeAgentTargets, sendAgentAlert } = require('./hm-agent-alert');
const { sendTelegram } = require('./hm-telegram');

const DEFAULT_CHAT_ID = '5613428850';
const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'saylor-watcher-state.json'), { forWrite: true });
const STRATEGY_PRESS_URL = 'https://www.strategy.com/press';
const STRATEGY_X_URL = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/saylor';
const STRATEGY_SEC_CIK = '0001050446';
const STRATEGY_SEC_SUBMISSIONS_URL = `https://data.sec.gov/submissions/CIK${STRATEGY_SEC_CIK}.json`;
const DEFAULT_BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36';
const SEC_USER_AGENT = 'SquidRun/1.0 james@example.com';

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
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
      'user-agent': options.userAgent || SEC_USER_AGENT,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`);
  }
  return response.text();
}

async function fetchJson(url, options = {}) {
  const body = await fetchText(url, options);
  return JSON.parse(body);
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

function humanizePressSlug(slug = '') {
  const trimmed = toText(slug).replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  const lastSegment = trimmed.split('/').pop() || trimmed;
  const base = lastSegment.replace(/_\d{1,2}-\d{1,2}-\d{4}$/i, '');
  return decodeHtmlEntities(base.replace(/-/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseStrategyPressEntries(html = '') {
  const matches = [];
  const regex = /\/press\/([a-z0-9-]+_\d{1,2}-\d{1,2}-\d{4})/gi;
  let match = regex.exec(String(html || ''));
  while (match) {
    const slug = match[1];
    const url = `https://www.strategy.com/press/${slug}`;
    matches.push({
      id: `press:${slug}`,
      slug,
      title: humanizePressSlug(slug),
      url,
      source: 'strategy_press',
    });
    match = regex.exec(String(html || ''));
  }
  return uniqueById(matches);
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

function parseSaylorTimelineEntries(html = '') {
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
        return {
          id: `tweet:${id}`,
          tweetId: id,
          createdAt: toText(tweet.created_at) || null,
          text: decodeHtmlEntities(toText(tweet.full_text || tweet.text)),
          url: permalink
            ? `https://x.com${permalink}`
            : `https://x.com/saylor/status/${id}`,
          source: 'saylor_x',
        };
      })
  );
}

function parseStrategySec8KEntries(payload = {}) {
  const recent = payload?.filings?.recent || {};
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const accessionNumbers = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const filingDates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const primaryDocuments = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [];
  const primaryDescriptions = Array.isArray(recent.primaryDocDescription) ? recent.primaryDocDescription : [];

  const entries = [];
  for (let index = 0; index < forms.length; index += 1) {
    if (String(forms[index] || '').trim().toUpperCase() !== '8-K') continue;
    const accession = toText(accessionNumbers[index]);
    if (!accession) continue;
    entries.push({
      id: `sec:${accession}`,
      accessionNumber: accession,
      filingDate: toText(filingDates[index]) || null,
      form: '8-K',
      primaryDocument: toText(primaryDocuments[index]) || null,
      primaryDocDescription: toText(primaryDescriptions[index]) || 'Strategy 8-K filing',
      url: `https://www.sec.gov/Archives/edgar/data/${String(payload?.cik || STRATEGY_SEC_CIK).replace(/^0+/, '')}/${accession.replace(/-/g, '')}/${toText(primaryDocuments[index])}`,
      source: 'sec_edgar',
    });
  }
  return entries;
}

function collectNewEntries(entries = [], lastSeenId = null) {
  const output = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (lastSeenId && entry.id === lastSeenId) break;
    output.push(entry);
  }
  return output;
}

function truncateText(value = '', maxChars = 220) {
  const text = toText(value);
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildAlertMessage(summary = {}) {
  const lines = ['[SAYLOR WATCHER] New Strategy / Saylor signal detected'];
  for (const entry of summary.newStrategyPress || []) {
    lines.push(`- Strategy press: ${entry.title || entry.slug}`);
    lines.push(`  ${entry.url}`);
  }
  for (const entry of summary.newSec8K || []) {
    lines.push(`- Strategy 8-K: ${entry.filingDate || 'unknown date'} — ${entry.primaryDocDescription || 'new filing'}`);
    lines.push(`  ${entry.url}`);
  }
  for (const entry of summary.newTweets || []) {
    lines.push(`- Saylor X: ${truncateText(entry.text, 180)}`);
    lines.push(`  ${entry.url}`);
  }
  return lines.join('\n');
}

function buildAgentAlertMessage(summary = {}) {
  return [
    '[TRADING][AGENT ALERT] New Strategy / Saylor signal detected.',
    'Do not dump this to James. Architect decide if it changes the plan. Oracle verify the signal and impact on BTC / crypto positioning.',
    buildAlertMessage(summary),
  ].join('\n');
}

function defaultState() {
  return {
    initialized: false,
    lastStrategyPressId: null,
    lastTweetId: null,
    lastSec8KId: null,
    lastAlertFingerprint: null,
    updatedAt: null,
  };
}

function buildFingerprint(summary = {}) {
  return JSON.stringify({
    press: (summary.newStrategyPress || []).map((entry) => entry.id),
    sec: (summary.newSec8K || []).map((entry) => entry.id),
    tweets: (summary.newTweets || []).map((entry) => entry.id),
  });
}

async function runWatcher(options = {}) {
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const state = {
    ...defaultState(),
    ...(readJsonFile(statePath, defaultState()) || {}),
  };
  const scannedAt = new Date().toISOString();

  const [pressHtml, xHtml, secPayload] = await Promise.all([
    fetchText(STRATEGY_PRESS_URL, {
      ...options,
      userAgent: DEFAULT_BROWSER_USER_AGENT,
    }),
    fetchText(STRATEGY_X_URL, {
      ...options,
      userAgent: DEFAULT_BROWSER_USER_AGENT,
    }),
    fetchJson(STRATEGY_SEC_SUBMISSIONS_URL, {
      ...options,
      userAgent: SEC_USER_AGENT,
    }),
  ]);

  const pressEntries = parseStrategyPressEntries(pressHtml);
  const tweetEntries = parseSaylorTimelineEntries(xHtml);
  const sec8KEntries = parseStrategySec8KEntries(secPayload);

  const latestPressId = pressEntries[0]?.id || state.lastStrategyPressId || null;
  const latestTweetId = tweetEntries[0]?.id || state.lastTweetId || null;
  const latestSec8KId = sec8KEntries[0]?.id || state.lastSec8KId || null;

  const initialized = state.initialized === true;
  const newStrategyPress = initialized ? collectNewEntries(pressEntries, state.lastStrategyPressId) : [];
  const newTweets = initialized ? collectNewEntries(tweetEntries, state.lastTweetId) : [];
  const newSec8K = initialized ? collectNewEntries(sec8KEntries, state.lastSec8KId) : [];

  const summary = {
    ok: true,
    scannedAt,
    initialized: initialized || false,
    sources: {
      strategyPress: STRATEGY_PRESS_URL,
      saylorX: STRATEGY_X_URL,
      secEdgar: STRATEGY_SEC_SUBMISSIONS_URL,
    },
    latest: {
      strategyPress: pressEntries[0] || null,
      saylorTweet: tweetEntries[0] || null,
      sec8K: sec8KEntries[0] || null,
    },
    newStrategyPress,
    newTweets,
    newSec8K,
    alertCount: newStrategyPress.length + newTweets.length + newSec8K.length,
    alerted: false,
    statePath,
  };

  const fingerprint = buildFingerprint(summary);
  const shouldAlert = summary.alertCount > 0 && fingerprint !== state.lastAlertFingerprint;
  if (shouldAlert && options.sendAgents !== false) {
    const result = sendAgentAlert(buildAgentAlertMessage(summary), {
      env: process.env,
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      hmSendScriptPath: options.hmSendScriptPath,
      targets: options.agentTargets || DEFAULT_AGENT_TARGETS,
      role: toText(options.alertRole, 'builder'),
    });
    summary.agentAlerts = result;
    summary.alerted = Boolean(result?.ok);
  }

  if (shouldAlert && options.sendTelegram === true) {
    const result = await sendTelegram(buildAlertMessage(summary), process.env, {
      chatId: toText(options.chatId, DEFAULT_CHAT_ID),
    });
    summary.telegram = result;
    summary.telegramAlerted = Boolean(result?.ok);
  }

  writeJsonFile(statePath, {
    initialized: true,
    lastStrategyPressId: latestPressId,
    lastTweetId: latestTweetId,
    lastSec8KId: latestSec8KId,
    lastAlertFingerprint: shouldAlert ? fingerprint : state.lastAlertFingerprint,
    updatedAt: scannedAt,
  });

  return summary;
}

function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const options = {
    json: false,
    sendAgents: true,
    sendTelegram: false,
    agentTargets: DEFAULT_AGENT_TARGETS,
    chatId: DEFAULT_CHAT_ID,
    statePath: DEFAULT_STATE_PATH,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = toText(args[index]);
    if (token === '--json') {
      options.json = true;
    } else if (token === '--no-agents') {
      options.sendAgents = false;
    } else if (token === '--targets') {
      options.agentTargets = normalizeAgentTargets(args[index + 1] || DEFAULT_AGENT_TARGETS);
      index += 1;
    } else if (token === '--send-telegram') {
      options.sendTelegram = true;
    } else if (token === '--no-telegram') {
      options.sendTelegram = false;
    } else if (token === '--chat-id') {
      options.chatId = toText(args[index + 1], DEFAULT_CHAT_ID);
      index += 1;
    } else if (token === '--state-path') {
      options.statePath = toText(args[index + 1], DEFAULT_STATE_PATH);
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
  process.stdout.write(`Saylor watcher scanned at ${summary.scannedAt}\n`);
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
  DEFAULT_AGENT_TARGETS,
  DEFAULT_CHAT_ID,
  DEFAULT_STATE_PATH,
  STRATEGY_PRESS_URL,
  STRATEGY_X_URL,
  STRATEGY_SEC_SUBMISSIONS_URL,
  buildAgentAlertMessage,
  parseStrategyPressEntries,
  parseSaylorTimelineEntries,
  parseStrategySec8KEntries,
  collectNewEntries,
  buildAlertMessage,
  runWatcher,
  parseArgs,
  extractNextDataJson,
};
