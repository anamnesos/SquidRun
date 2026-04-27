#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');
const dynamicWatchlist = require('../modules/trading/dynamic-watchlist');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const manualActivity = require('../modules/trading/hyperliquid-manual-activity');
const symbolMicrodata = require('../modules/trading/symbol-microdata');
const rulesEngine = require('../modules/trading/rules-engine');

const DEFAULT_CORE_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
const DEFAULT_SUPERVISOR_STATUS_PATH = resolveCoordPath(path.join('runtime', 'supervisor-status.json'));
const DEFAULT_ANOMALY_PATH = resolveCoordPath(path.join('coord', 'anomalies.jsonl'), { forWrite: true });
const DEFAULT_SPARK_EVENTS_PATH = resolveCoordPath(path.join('runtime', 'spark-events.jsonl'));
const DEFAULT_SUPERVISOR_FRESH_MS = 90 * 1000;
const DEFAULT_RECENT_ACTIVITY_MS = 30 * 60 * 1000;

function toText(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeTicker(symbol) {
  const normalized = toText(symbol).toUpperCase();
  if (!normalized) return '';
  return normalized.endsWith('/USD') ? normalized : `${normalized}/USD`;
}

function normalizeCoin(symbol) {
  const ticker = normalizeTicker(symbol);
  return ticker.endsWith('/USD') ? ticker.slice(0, -4) : ticker;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    json: false,
    symbols: null,
    maxSymbols: null,
    executeScriptPath: path.resolve(__dirname, 'hm-defi-execute.js'),
    anomalyScriptPath: path.resolve(__dirname, 'hm-anomaly.js'),
    supervisorStatusPath: DEFAULT_SUPERVISOR_STATUS_PATH,
    anomalyPath: DEFAULT_ANOMALY_PATH,
    sparkEventsPath: DEFAULT_SPARK_EVENTS_PATH,
    nowMs: Date.now(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    const next = argv[index + 1];
    if (token === '--symbols' && next) {
      options.symbols = String(next).split(',').map(normalizeTicker).filter(Boolean);
      index += 1;
      continue;
    }
    if (token === '--max-symbols' && next) {
      options.maxSymbols = Math.max(1, Number.parseInt(next, 10) || 0);
      index += 1;
      continue;
    }
    if (token === '--execute-script' && next) {
      options.executeScriptPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (token === '--anomaly-script' && next) {
      options.anomalyScriptPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (token === '--supervisor-status' && next) {
      options.supervisorStatusPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (token === '--anomaly-path' && next) {
      options.anomalyPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (token === '--spark-events' && next) {
      options.sparkEventsPath = path.resolve(next);
      index += 1;
      continue;
    }
  }

  return options;
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonLines(filePath, limit = 500) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, limit)).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function resolveSymbols(options = {}) {
  const explicit = Array.isArray(options.symbols) ? options.symbols : [];
  if (explicit.length > 0) {
    return explicit.slice(0, options.maxSymbols || explicit.length);
  }
  const core = DEFAULT_CORE_SYMBOLS;
  const dynamic = dynamicWatchlist.getActiveEntries({ assetClass: 'crypto' })
    .map((entry) => normalizeTicker(entry.ticker))
    .filter(Boolean);
  const staticCrypto = (dynamicWatchlist.DEFAULT_CRYPTO_WATCHLIST || [])
    .map((entry) => normalizeTicker(entry.ticker))
    .filter(Boolean);
  const symbols = Array.from(new Set([...core, ...staticCrypto, ...dynamic]));
  return symbols.slice(0, options.maxSymbols || symbols.length);
}

function buildSupervisorContext(statusPath = DEFAULT_SUPERVISOR_STATUS_PATH, nowMs = Date.now()) {
  const status = readJsonFile(statusPath, null);
  const heartbeatAtMs = toNumber(status?.heartbeatAtMs, NaN);
  const staleMs = Number.isFinite(heartbeatAtMs) ? nowMs - heartbeatAtMs : Infinity;
  return {
    running: Boolean(status?.pid && Number.isFinite(heartbeatAtMs) && staleMs <= DEFAULT_SUPERVISOR_FRESH_MS),
    pid: status?.pid || null,
    sessionId: status?.sessionId ?? null,
    heartbeatAtMs: Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : null,
    staleMs: Number.isFinite(staleMs) ? staleMs : null,
  };
}

function buildRateLimitContext(nowMs = Date.now()) {
  const state = hyperliquidClient.__readSharedRateLimitState();
  const backoffUntilMs = Date.parse(toText(state?.backoffUntil, ''));
  return {
    ...state,
    active: Number.isFinite(backoffUntilMs) && backoffUntilMs > nowMs,
  };
}

function normalizeActivityEntry(record = {}) {
  const details = record.details && typeof record.details === 'object' ? record.details : {};
  const ticker = normalizeTicker(details.ticker || details.symbol || details.coin || record.ticker || record.symbol || record.coin);
  return {
    ticker,
    coin: normalizeCoin(ticker),
    ts: record.ts || record.timestamp || details.ts || details.timestamp || null,
    type: record.type || details.type || null,
    source: record.src || details.source || null,
  };
}

function readRecentSymbolActivity(options = {}) {
  const nowMs = toNumber(options.nowMs, Date.now());
  const windowMs = toNumber(options.recentActivityMs, DEFAULT_RECENT_ACTIVITY_MS);
  const interestingTypes = new Set([
    'live_position_opened',
    'live_position_closed',
    'manual_position_opened',
    'manual_position_closed',
    'rules_engine_fired',
  ]);
  const entries = readJsonLines(options.anomalyPath || DEFAULT_ANOMALY_PATH, 1000)
    .filter((record) => interestingTypes.has(String(record.type || '').trim()))
    .map(normalizeActivityEntry)
    .filter((entry) => {
      const timestampMs = Date.parse(toText(entry.ts));
      return entry.ticker && Number.isFinite(timestampMs) && nowMs - timestampMs <= windowMs;
    });

  const activeManual = manualActivity.isManualHyperliquidActivityActive(
    manualActivity.readManualHyperliquidActivity(),
    { nowMs }
  );
  if (activeManual && Array.isArray(options.symbols)) {
    const ts = new Date(nowMs).toISOString();
    for (const symbol of options.symbols) {
      entries.push({
        ticker: normalizeTicker(symbol),
        coin: normalizeCoin(symbol),
        ts,
        type: 'active_manual_hyperliquid_activity',
        source: 'manual_activity_lease',
      });
    }
  }

  return entries;
}

function readCatalysts(options = {}) {
  const nowMs = toNumber(options.nowMs, Date.now());
  return readJsonLines(options.sparkEventsPath || DEFAULT_SPARK_EVENTS_PATH, 1000)
    .map((record) => {
      const assets = Array.isArray(record.tickers)
        ? record.tickers.map(normalizeTicker).filter(Boolean)
        : [normalizeTicker(record.ticker || record.symbol || record.coin)].filter(Boolean);
      return {
        assets,
        ts: record.detectedAt || record.publishedAt || record.recordedAt || record.ts || null,
        source: record.source || null,
        catalystType: record.catalystType || null,
        title: record.title || null,
      };
    })
    .filter((event) => {
      const timestampMs = Date.parse(toText(event.ts));
      return event.assets.length > 0 && Number.isFinite(timestampMs) && nowMs - timestampMs <= (24 * 60 * 60 * 1000);
    });
}

async function buildAccountContext(options = {}) {
  const [account, positions] = await Promise.all([
    hyperliquidClient.getAccountSnapshot(options),
    hyperliquidClient.getOpenPositions(options),
  ]);
  return {
    account: {
      accountValue: account.equity,
      totalMarginUsed: account.raw?.marginSummary?.totalMarginUsed ?? 0,
      withdrawable: account.cash,
    },
    positions,
  };
}

function execFileAsync(file, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: options.timeoutMs || 120_000,
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
    }, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        error: error?.message || null,
        code: error?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function buildExecuteArgs(symbol, signal = {}) {
  const side = String(signal.side || '').toLowerCase() === 'short' ? 'SHORT' : 'LONG';
  return [
    'trade',
    '--asset',
    normalizeCoin(symbol),
    '--direction',
    side,
    '--margin',
    String(signal.sizeUsd),
    '--confidence',
    String(signal.score || 0.65),
    '--stop-loss',
    String(signal.stopPx),
    '--take-profit',
    String(signal.tpPx),
    '--client-order-id',
    `rules-engine:${normalizeCoin(symbol)}:${side}:${new Date().toISOString().slice(0, 16)}`,
  ];
}

async function recordRulesEngineFire(symbol, signal, executionResult, options = {}) {
  const details = {
    symbol: normalizeTicker(symbol),
    side: signal.side,
    score: signal.score ?? null,
    sizeUsd: signal.sizeUsd,
    stopPx: signal.stopPx,
    tpPx: signal.tpPx,
    tp2Px: signal.tp2Px ?? null,
    entryPx: signal.entryPx ?? null,
    reason: signal.reason,
    dryRun: options.dryRun === true,
    execution: executionResult ? {
      ok: executionResult.ok,
      code: executionResult.code ?? null,
      error: executionResult.error || null,
    } : null,
  };
  return execFileAsync(process.execPath, [
    options.anomalyScriptPath || path.resolve(__dirname, 'hm-anomaly.js'),
    'type=rules_engine_fired',
    'src=rules-engine',
    'sev=medium',
    `details=${JSON.stringify(details)}`,
    '--json',
  ], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    timeoutMs: 15_000,
  });
}

async function runTradingTick(options = {}) {
  const nowMs = toNumber(options.nowMs, Date.now());
  const symbols = resolveSymbols(options);
  const supervisor = buildSupervisorContext(options.supervisorStatusPath, nowMs);
  const rateLimit = buildRateLimitContext(nowMs);
  const recentSymbolActivity = readRecentSymbolActivity({ ...options, symbols, nowMs });
  const catalysts = readCatalysts({ ...options, nowMs });
  const accountContext = await buildAccountContext(options);
  const evaluations = [];
  const fired = [];

  for (const symbol of symbols) {
    const microdata = await symbolMicrodata.getMicroDataForSymbol(symbol, options);
    const enrichedMicrodata = {
      ...microdata,
      ...accountContext,
      supervisor,
      rateLimit,
      recentSymbolActivity,
      catalysts,
      eventVeto: options.eventVeto || { decision: 'CLEAR', affectedAssets: [] },
      nowMs,
    };
    const signal = rulesEngine.evaluateLongShortSetup(symbol, enrichedMicrodata, { nowMs });
    evaluations.push({ symbol, signal });
    if (!signal?.fire) continue;

    const executeArgs = buildExecuteArgs(symbol, signal);
    if (options.dryRun) {
      fired.push({ symbol, signal, dryRun: true, executeArgs });
      continue;
    }

    const executionResult = await execFileAsync(process.execPath, [
      options.executeScriptPath || path.resolve(__dirname, 'hm-defi-execute.js'),
      ...executeArgs,
    ], {
      cwd: options.cwd || process.cwd(),
      env: { ...(options.env || process.env), SQUIDRUN_HYPERLIQUID_CALLER: 'supervisor' },
      timeoutMs: 180_000,
    });
    await recordRulesEngineFire(symbol, signal, executionResult, options);
    fired.push({ symbol, signal, executionResult });
  }

  const summary = {
    ok: true,
    dryRun: options.dryRun === true,
    checked: evaluations.length,
    fired: fired.length,
    firedSignals: fired,
    supervisor,
    rateLimit: {
      active: rateLimit.active,
      backoffUntil: rateLimit.backoffUntil || null,
    },
    asOf: new Date(nowMs).toISOString(),
  };

  if (options.dryRun || options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  return runTradingTick(options);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_CORE_SYMBOLS,
  buildExecuteArgs,
  buildSupervisorContext,
  parseArgs,
  readCatalysts,
  readRecentSymbolActivity,
  resolveSymbols,
  runTradingTick,
};
