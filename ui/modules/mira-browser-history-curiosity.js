'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('./sqlite-compat');

const MIRA_BROWSER_HISTORY_CURIOSITY_SCHEMA = 'squidrun.mira.browser_history_curiosity_read_v0';
const CHROME_EPOCH_OFFSET_MS = Date.UTC(1601, 0, 1);

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function oneLine(value, max = 180) {
  const text = trimText(value).replace(/\s+/g, ' ');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

function defaultBrowserHistoryCandidates(homeDir = os.homedir()) {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    return [
      { browser: 'chrome', profile: 'Default', path: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'History') },
      { browser: 'chrome', profile: 'Profile 1', path: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Profile 1', 'History') },
      { browser: 'edge', profile: 'Default', path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'History') },
    ];
  }
  if (process.platform === 'darwin') {
    return [
      { browser: 'chrome', profile: 'Default', path: path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'History') },
      { browser: 'edge', profile: 'Default', path: path.join(homeDir, 'Library', 'Application Support', 'Microsoft Edge', 'Default', 'History') },
    ];
  }
  return [
    { browser: 'chrome', profile: 'Default', path: path.join(homeDir, '.config', 'google-chrome', 'Default', 'History') },
    { browser: 'chromium', profile: 'Default', path: path.join(homeDir, '.config', 'chromium', 'Default', 'History') },
    { browser: 'edge', profile: 'Default', path: path.join(homeDir, '.config', 'microsoft-edge', 'Default', 'History') },
  ];
}

function normalizeHistoryCandidates(payload = {}, options = {}) {
  const raw = options.historyPaths || payload.historyPaths || options.history_path || payload.history_path;
  if (raw) {
    const values = Array.isArray(raw) ? raw : [raw];
    return values.map((entry, index) => {
      if (entry && typeof entry === 'object') {
        const historyPath = trimText(entry.path || entry.historyPath || entry.history_path);
        if (!historyPath) return null;
        return {
          browser: trimText(entry.browser || `browser_${index + 1}`),
          profile: trimText(entry.profile || 'profile'),
          path: path.resolve(historyPath),
        };
      }
      const historyPath = trimText(entry);
      if (!historyPath) return null;
      return {
        browser: `browser_${index + 1}`,
        profile: 'profile',
        path: path.resolve(historyPath),
      };
    }).filter((entry) => entry?.path);
  }
  return defaultBrowserHistoryCandidates(options.homeDir || payload.homeDir || process.env.SQUIDRUN_MIRA_BROWSER_HISTORY_HOME);
}

function chromeTimeToIso(value) {
  try {
    const micros = typeof value === 'bigint' ? value : BigInt(String(value || '').trim());
    if (micros <= 0n) return null;
    const unixMs = BigInt(CHROME_EPOCH_OFFSET_MS) + (micros / 1000n);
    const number = Number(unixMs);
    if (!Number.isFinite(number)) return null;
    return new Date(number).toISOString();
  } catch {
    return null;
  }
}

function safeHostname(value) {
  try {
    return new URL(String(value)).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function safeUrlForOutput(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return null;
  }
}

function copyHistoryForRead(historyPath, tempRoot) {
  const tempDir = fs.mkdtempSync(path.join(tempRoot || os.tmpdir(), 'sq-mira-browser-history-'));
  const copyPath = path.join(tempDir, 'History');
  fs.copyFileSync(historyPath, copyPath);
  return { tempDir, copyPath };
}

function readHistoryRows(historyPath, limit, options = {}) {
  let readPath = historyPath;
  let tempDir = null;
  let db;
  try {
    if (options.copyBeforeRead !== false) {
      const copy = copyHistoryForRead(historyPath, options.tempRoot);
      readPath = copy.copyPath;
      tempDir = copy.tempDir;
    }
    db = openDatabase(readPath);
    const tableInfo = db.prepare("PRAGMA table_info('urls')").all();
    const columns = new Set(tableInfo.map((row) => String(row.name || '')));
    if (!columns.has('url') || !columns.has('title')) {
      return { ok: false, reason: 'browser_history_urls_table_missing', rows: [] };
    }
    const rows = db.prepare(`
      SELECT url, title, visit_count, typed_count, CAST(last_visit_time AS TEXT) AS last_visit_time
      FROM urls
      WHERE url IS NOT NULL AND url != ''
      ORDER BY COALESCE(last_visit_time, 0) DESC
      LIMIT ?
    `).all(limit);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, reason: 'browser_history_read_failed', error: err?.message || String(err), rows: [] };
  } finally {
    try { if (db) db.close(); } catch {}
    if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

function readMiraBrowserHistoryCuriosity(payload = {}, options = {}) {
  const candidates = normalizeHistoryCandidates(payload, options);
  const limit = Math.max(1, Math.min(25, Number(payload.limit || options.limit || 10) || 10));
  const existing = candidates.find((candidate) => fs.existsSync(candidate.path));
  if (!existing) {
    return {
      schema: MIRA_BROWSER_HISTORY_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: 'browser_history_missing',
      checked_count: candidates.length,
      checked_profiles: candidates.map((candidate) => ({
        browser: candidate.browser,
        profile: candidate.profile,
        exists: false,
      })),
      result_count: 0,
      results: [],
      no_mutation_performed: true,
    };
  }

  const read = readHistoryRows(existing.path, limit, options);
  if (!read.ok) {
    return {
      schema: MIRA_BROWSER_HISTORY_CURIOSITY_SCHEMA,
      ok: false,
      decision: 'unavailable_in_this_runtime',
      reason: read.reason,
      error: read.error || null,
      browser: existing.browser,
      profile: existing.profile,
      result_count: 0,
      results: [],
      no_mutation_performed: true,
    };
  }

  const results = read.rows.map((row) => ({
    host: safeHostname(row.url),
    title: oneLine(row.title || safeHostname(row.url) || 'untitled', 140),
    safe_url: safeUrlForOutput(row.url),
    visit_count: Number(row.visit_count || 0),
    typed_count: Number(row.typed_count || 0),
    last_visit_at: chromeTimeToIso(row.last_visit_time),
  })).filter((row) => row.host);
  const hostCounts = results.reduce((acc, row) => {
    acc[row.host] = (acc[row.host] || 0) + 1;
    return acc;
  }, {});
  const top_hosts = Object.entries(hostCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([host, count]) => ({ host, count }));

  return {
    schema: MIRA_BROWSER_HISTORY_CURIOSITY_SCHEMA,
    ok: true,
    decision: 'browser_history_read_only',
    browser: existing.browser,
    profile: existing.profile,
    result_count: results.length,
    top_hosts,
    results,
    no_mutation_performed: true,
    consequence_controls: {
      internal_only: true,
      read_only: true,
      browser_mutation_performed: false,
      cookies_read: false,
      auth_store_read: false,
      external_send_performed: false,
    },
  };
}

module.exports = {
  MIRA_BROWSER_HISTORY_CURIOSITY_SCHEMA,
  chromeTimeToIso,
  defaultBrowserHistoryCandidates,
  readMiraBrowserHistoryCuriosity,
};
