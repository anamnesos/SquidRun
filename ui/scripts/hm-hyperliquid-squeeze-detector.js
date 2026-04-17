#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

process.env.DOTENV_CONFIG_QUIET = 'true';

const { resolveCoordPath } = require('../config');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const { DEFAULT_AGENT_TARGETS, normalizeTargets: normalizeAgentTargets, sendAgentAlert } = require('./hm-agent-alert');
const { sendTelegram } = require('./hm-telegram');

const DEFAULT_CHAT_ID = '5613428850';
const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'hyperliquid-squeeze-detector-state.json'), { forWrite: true });
const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL'];
const DEFAULT_PRICE_MOVE_THRESHOLD_PCT = 0.005;
const DEFAULT_OPEN_INTEREST_THRESHOLD_PCT = 0.01;
const DEFAULT_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
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

function normalizeSymbols(value = DEFAULT_SYMBOLS) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return Array.from(new Set(raw.map((entry) => toText(entry).toUpperCase()).filter(Boolean)));
}

function pctChange(current, previous) {
  const currentValue = toNumber(current, NaN);
  const previousValue = toNumber(previous, NaN);
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue) || previousValue === 0) {
    return null;
  }
  return (currentValue - previousValue) / previousValue;
}

function summarizeMarketEntry(entry = {}) {
  return {
    coin: toText(entry.coin).toUpperCase(),
    ticker: toText(entry.ticker).toUpperCase(),
    price: toNumber(entry.price, NaN),
    fundingRate: toNumber(entry.fundingRate, NaN),
    openInterest: toNumber(entry.openInterest, NaN),
    volumeUsd24h: toNumber(entry.volumeUsd24h, NaN),
    recordedAt: new Date().toISOString(),
  };
}

function defaultState() {
  return {
    initialized: false,
    snapshots: {},
    lastAlerts: {},
    updatedAt: null,
  };
}

function shouldRespectCooldown(state = {}, key = '', nowMs = Date.now(), cooldownMs = DEFAULT_ALERT_COOLDOWN_MS) {
  const lastAlertAtMs = toNumber(state?.lastAlerts?.[key]?.atMs, 0);
  return lastAlertAtMs > 0 && (nowMs - lastAlertAtMs) < cooldownMs;
}

function analyzeTransition(previous = {}, current = {}, options = {}) {
  const priceChangePct = pctChange(current.price, previous.price);
  const openInterestChangePct = pctChange(current.openInterest, previous.openInterest);
  const previousFundingRate = toNumber(previous.fundingRate, NaN);
  const currentFundingRate = toNumber(current.fundingRate, NaN);
  const minPriceMovePct = Number.isFinite(Number(options.minPriceMovePct))
    ? Number(options.minPriceMovePct)
    : DEFAULT_PRICE_MOVE_THRESHOLD_PCT;
  const minOpenInterestMovePct = Number.isFinite(Number(options.minOpenInterestMovePct))
    ? Number(options.minOpenInterestMovePct)
    : DEFAULT_OPEN_INTEREST_THRESHOLD_PCT;

  if (!Number.isFinite(priceChangePct) || !Number.isFinite(openInterestChangePct)) {
    return null;
  }

  const coin = toText(current.coin || previous.coin).toUpperCase();
  const currentFundingBps = Number.isFinite(currentFundingRate) ? currentFundingRate * 10_000 : null;
  const previousFundingBps = Number.isFinite(previousFundingRate) ? previousFundingRate * 10_000 : null;
  const common = {
    coin,
    ticker: `${coin}/USD`,
    price: round(current.price, 4),
    previousPrice: round(previous.price, 4),
    priceChangePct: round(priceChangePct, 4),
    openInterest: round(current.openInterest, 4),
    previousOpenInterest: round(previous.openInterest, 4),
    openInterestChangePct: round(openInterestChangePct, 4),
    fundingRate: round(currentFundingRate, 8),
    fundingRateBps: round(currentFundingBps, 4),
    previousFundingRate: round(previousFundingRate, 8),
    previousFundingRateBps: round(previousFundingBps, 4),
    volumeUsd24h: round(current.volumeUsd24h, 2),
    recordedAt: current.recordedAt || new Date().toISOString(),
  };

  const squeezeStarting = priceChangePct >= minPriceMovePct
    && openInterestChangePct >= minOpenInterestMovePct
    && Number.isFinite(currentFundingRate)
    && currentFundingRate > 0
    && (!Number.isFinite(previousFundingRate) || previousFundingRate <= 0);
  if (squeezeStarting) {
    return {
      ...common,
      type: 'squeeze_starting',
      message: `${coin} squeeze starting: price +${(priceChangePct * 100).toFixed(2)}%, OI +${(openInterestChangePct * 100).toFixed(2)}%, funding flipped to +${(currentFundingRate * 10_000).toFixed(3)} bps.`,
    };
  }

  const cascadeStarting = priceChangePct <= -minPriceMovePct
    && openInterestChangePct >= minOpenInterestMovePct
    && Number.isFinite(currentFundingRate)
    && currentFundingRate < 0;
  if (cascadeStarting) {
    return {
      ...common,
      type: 'cascade_starting',
      message: `${coin} cascade starting: price ${(priceChangePct * 100).toFixed(2)}%, OI +${(openInterestChangePct * 100).toFixed(2)}%, funding ${currentFundingRate > 0 ? '+' : ''}${(currentFundingRate * 10_000).toFixed(3)} bps.`,
    };
  }

  return null;
}

function buildAlertMessage(detections = []) {
  const lines = ['[HYPERLIQUID SQUEEZE DETECTOR]'];
  for (const detection of detections) {
    lines.push(`- ${detection.message}`);
    lines.push(`  ${detection.ticker} @ $${Number(detection.price).toFixed(2)} | 24h vol $${toNumber(detection.volumeUsd24h, 0).toFixed(0)}`);
  }
  return lines.join('\n');
}

function buildAgentAlertMessage(detections = []) {
  return [
    '[TRADING][AGENT ALERT] Hyperliquid squeeze detector flagged a live setup.',
    'Route this to agent action, not James. Architect coordinate. Oracle verify whether it matters for open positions or the watchlist.',
    buildAlertMessage(detections),
  ].join('\n');
}

async function runDetector(options = {}) {
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const state = {
    ...defaultState(),
    ...(readJsonFile(statePath, defaultState()) || {}),
  };
  const symbols = normalizeSymbols(options.symbols || DEFAULT_SYMBOLS);
  const marketData = await hyperliquidClient.getUniverseMarketData({
    fetch: options.fetch || global.fetch,
  });
  const currentByCoin = new Map(
    marketData
      .filter((entry) => symbols.includes(toText(entry.coin).toUpperCase()))
      .map((entry) => [toText(entry.coin).toUpperCase(), summarizeMarketEntry(entry)])
  );

  const nowMs = Date.now();
  const detections = [];
  for (const symbol of symbols) {
    const previous = state.snapshots?.[symbol] || null;
    const current = currentByCoin.get(symbol) || null;
    if (!previous || !current) continue;
    const detection = analyzeTransition(previous, current, options);
    if (!detection) continue;
    const alertKey = `${symbol}:${detection.type}`;
    if (shouldRespectCooldown(state, alertKey, nowMs, toNumber(options.alertCooldownMs, DEFAULT_ALERT_COOLDOWN_MS))) {
      continue;
    }
    detections.push(detection);
  }

  const summary = {
    ok: true,
    scannedAt: new Date(nowMs).toISOString(),
    initialized: state.initialized === true,
    symbols,
    detections,
    detectionCount: detections.length,
    alerted: false,
    statePath,
    snapshots: Object.fromEntries(Array.from(currentByCoin.entries())),
  };

  if (detections.length > 0 && options.sendAgents !== false) {
    const result = sendAgentAlert(buildAgentAlertMessage(detections), {
      env: process.env,
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      hmSendScriptPath: options.hmSendScriptPath,
      targets: options.agentTargets || DEFAULT_AGENT_TARGETS,
      role: toText(options.alertRole, 'builder'),
    });
    summary.agentAlerts = result;
    summary.alerted = Boolean(result?.ok);
  }

  if (detections.length > 0 && options.sendTelegram === true) {
    const result = await sendTelegram(buildAlertMessage(detections), process.env, {
      chatId: toText(options.chatId, DEFAULT_CHAT_ID),
    });
    summary.telegram = result;
    summary.telegramAlerted = Boolean(result?.ok);
  }

  const nextState = {
    initialized: true,
    snapshots: Object.fromEntries(Array.from(currentByCoin.entries())),
    lastAlerts: {
      ...(state.lastAlerts || {}),
    },
    updatedAt: summary.scannedAt,
  };
  for (const detection of detections) {
    nextState.lastAlerts[`${detection.coin}:${detection.type}`] = {
      atMs: nowMs,
      price: detection.price,
      fundingRate: detection.fundingRate,
      openInterest: detection.openInterest,
    };
  }
  writeJsonFile(statePath, nextState);
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
    symbols: DEFAULT_SYMBOLS,
    minPriceMovePct: DEFAULT_PRICE_MOVE_THRESHOLD_PCT,
    minOpenInterestMovePct: DEFAULT_OPEN_INTEREST_THRESHOLD_PCT,
    alertCooldownMs: DEFAULT_ALERT_COOLDOWN_MS,
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
    } else if (token === '--symbols') {
      options.symbols = normalizeSymbols(args[index + 1] || DEFAULT_SYMBOLS);
      index += 1;
    } else if (token === '--min-price-move-pct') {
      options.minPriceMovePct = Number(args[index + 1] || DEFAULT_PRICE_MOVE_THRESHOLD_PCT);
      index += 1;
    } else if (token === '--min-oi-move-pct') {
      options.minOpenInterestMovePct = Number(args[index + 1] || DEFAULT_OPEN_INTEREST_THRESHOLD_PCT);
      index += 1;
    } else if (token === '--alert-cooldown-ms') {
      options.alertCooldownMs = Number(args[index + 1] || DEFAULT_ALERT_COOLDOWN_MS);
      index += 1;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runDetector(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Hyperliquid squeeze detector scanned at ${summary.scannedAt}\n`);
  process.stdout.write(`Detections: ${summary.detectionCount}\n`);
  if (summary.detectionCount > 0) {
    process.stdout.write(`${buildAlertMessage(summary.detections)}\n`);
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
  DEFAULT_SYMBOLS,
  DEFAULT_PRICE_MOVE_THRESHOLD_PCT,
  DEFAULT_OPEN_INTEREST_THRESHOLD_PCT,
  DEFAULT_ALERT_COOLDOWN_MS,
  analyzeTransition,
  buildAgentAlertMessage,
  buildAlertMessage,
  defaultState,
  normalizeSymbols,
  parseArgs,
  pctChange,
  runDetector,
  summarizeMarketEntry,
};
