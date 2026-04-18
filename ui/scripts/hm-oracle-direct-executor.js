#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const { sendAgentAlert } = require('./hm-agent-alert');
const { sendTelegram } = require('./hm-telegram');
const hmDefiExecute = require('./hm-defi-execute');
const hmDefiClose = require('./hm-defi-close');

const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'oracle-direct-execution-state.json'), { forWrite: true });
const DEFAULT_INTERVAL_MS = 15 * 1000;
const DEFAULT_ARCHITECT_RESPONSE_TIMEOUT_MS = 90 * 1000;
const DEFAULT_CONVICTION_FLOOR = 0.60;
const DEFAULT_MARGIN_CAP_USD = 200;
const DIRECT_EXECUTOR_ROLE = 'oracle-direct-executor';

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function normalizeTicker(value) {
  const raw = toText(value).toUpperCase().replace('-', '/');
  if (!raw) return '';
  return raw.endsWith('/USD') ? raw : `${raw}/USD`;
}

function normalizeDirection(value) {
  const raw = toText(value).toUpperCase();
  if (['BUY', 'LONG'].includes(raw)) return 'LONG';
  if (['SELL', 'SHORT'].includes(raw)) return 'SHORT';
  return '';
}

function normalizeCloseAction(value) {
  const raw = toText(value).toUpperCase();
  if (raw === 'INVALIDATED') return 'INVALIDATED';
  if (raw === 'CLOSE_NOW') return 'CLOSE_NOW';
  return '';
}

function normalizeConviction(value) {
  const numeric = toNumber(value, NaN);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 1 && numeric <= 100) return Number((numeric / 100).toFixed(4));
  if (numeric >= 0 && numeric <= 1) return Number(numeric.toFixed(4));
  return null;
}

function defaultState() {
  return {
    version: 1,
    lastScanAt: null,
    updatedAt: null,
    signals: {},
  };
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  return {
    ...defaultState(),
    ...(readJson(statePath, defaultState()) || {}),
    signals: { ...((readJson(statePath, defaultState()) || {}).signals || {}) },
  };
}

function persistState(statePath, state) {
  writeJson(statePath, {
    ...defaultState(),
    ...(state || {}),
    signals: { ...((state || {}).signals || {}) },
  });
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[index + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) index += 1;
    options.set(key, value);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTradeTicketBlock(rawBody = '') {
  const raw = String(rawBody || '');
  const markerMatch = raw.match(/TRADE TICKET:\s*([\s\S]*)/i);
  if (!markerMatch) return null;
  let block = markerMatch[1].trim();
  const fenceMatch = block.match(/^```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    block = fenceMatch[1].trim();
  }
  return block || null;
}

function parseKeyValueTradeTicket(block = '') {
  const lines = String(block || '').split(/\r?\n/);
  const parsed = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(?:[-*]\s*)?([A-Za-z0-9_./ -]+?)\s*:\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/[ .-]+/g, '_');
    parsed[key] = match[2].trim();
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

function parseTradeTicket(rawBody = '') {
  const block = extractTradeTicketBlock(rawBody);
  if (!block) return null;
  let parsed = null;
  if (block.startsWith('{')) {
    try {
      parsed = JSON.parse(block);
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    parsed = parseKeyValueTradeTicket(block);
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const ticker = normalizeTicker(
    parsed.ticker
    || parsed.symbol
    || parsed.asset
  );
  const direction = normalizeDirection(
    parsed.direction
    || parsed.side
  );
  const entryPrice = toNumber(parsed.entry || parsed.entry_price || parsed.entryprice, NaN);
  const stopPrice = toNumber(
    parsed.stop
    || parsed.stop_price
    || parsed.stoploss
    || parsed.stop_loss,
    NaN
  );
  const takeProfitPrice = toNumber(
    parsed.tp1
    || parsed.tp
    || parsed.take_profit
    || parsed.take_profit_price
    || parsed.target,
    NaN
  );
  const marginUsd = toNumber(parsed.margin || parsed.margin_usd || parsed.marginusd, NaN);
  const leverage = toNumber(parsed.leverage || parsed.lev, NaN);
  const conviction = normalizeConviction(
    parsed.conviction
    || parsed.confidence
    || parsed.score
  );

  if (!ticker || !direction || !Number.isFinite(entryPrice) || !Number.isFinite(stopPrice) || !Number.isFinite(marginUsd) || !Number.isFinite(leverage)) {
    return null;
  }

  return {
    ticker,
    asset: ticker.split('/')[0],
    direction,
    entryPrice: Number(entryPrice),
    stopPrice: Number(stopPrice),
    takeProfitPrice: Number.isFinite(takeProfitPrice) ? Number(takeProfitPrice) : null,
    marginUsd: Number(marginUsd),
    leverage: Number(leverage),
    conviction,
    rawBlock: block,
  };
}

function parseCloseSignal(rawBody = '') {
  const raw = String(rawBody || '');
  const match = raw.match(/\b(INVALIDATED|CLOSE_NOW)\s*:\s*([A-Z0-9/_-]+)/i);
  if (!match) return null;
  const ticker = normalizeTicker(match[2]);
  if (!ticker) return null;
  const convictionMatch = raw.match(/\b(?:conviction|confidence|score)\s*[:=]\s*([0-9.]+)/i);
  const conviction = normalizeConviction(convictionMatch ? convictionMatch[1] : null);
  return {
    action: normalizeCloseAction(match[1]),
    ticker,
    asset: ticker.split('/')[0],
    conviction,
    rawText: raw.trim(),
  };
}

function createSignalId(entry = {}, ticket = {}) {
  const base = [
    toText(entry.messageId, ''),
    toText(entry.senderRole, ''),
    toText(entry.targetRole, ''),
    toText(ticket.ticker, ''),
    toText(ticket.direction, ''),
    toText(entry.rawBody, ''),
    toNumber(entry.sentAtMs || entry.brokeredAtMs, 0),
  ].join('|');
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

function createCloseSignalId(entry = {}, signal = {}) {
  const base = [
    toText(entry.messageId, ''),
    toText(entry.senderRole, ''),
    toText(entry.targetRole, ''),
    toText(signal.action, ''),
    toText(signal.ticker, ''),
    toText(entry.rawBody, ''),
    toNumber(entry.sentAtMs || entry.brokeredAtMs, 0),
  ].join('|');
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

function evaluateTradeTicketEligibility(ticket = {}, options = {}) {
  const convictionFloor = toNumber(options.convictionFloor, DEFAULT_CONVICTION_FLOOR);
  const marginCapUsd = Math.max(1, toNumber(options.marginCapUsd, DEFAULT_MARGIN_CAP_USD));
  const reasons = [];
  if (!ticket || typeof ticket !== 'object') reasons.push('ticket_missing');
  if (!ticket.ticker) reasons.push('ticker_missing');
  if (!ticket.direction) reasons.push('direction_missing');
  if (!Number.isFinite(ticket.entryPrice) || ticket.entryPrice <= 0) reasons.push('entry_missing');
  if (!Number.isFinite(ticket.stopPrice) || ticket.stopPrice <= 0) reasons.push('stop_missing');
  if (!Number.isFinite(ticket.marginUsd) || ticket.marginUsd <= 0) reasons.push('margin_missing');
  if (!Number.isFinite(ticket.leverage) || ticket.leverage <= 0) reasons.push('leverage_missing');
  if (!Number.isFinite(ticket.conviction) || ticket.conviction < convictionFloor) reasons.push('conviction_below_floor');
  return {
    allowed: reasons.length === 0,
    reasons,
    convictionFloor,
    cappedMarginUsd: Math.min(marginCapUsd, Math.max(1, toNumber(ticket.marginUsd, marginCapUsd))),
  };
}

function matchesArchitectResponse(entry = {}, signal = {}) {
  const body = toText(entry.rawBody, '').toUpperCase();
  const ticker = toText(signal.ticket?.ticker, '').toUpperCase();
  const asset = ticker.split('/')[0];
  return Boolean(
    body.includes(toText(signal.id, '').toUpperCase())
    || (ticker && body.includes(ticker))
    || (asset && body.includes(asset))
  );
}

function hasArchitectResponse(signal = {}) {
  const rows = queryCommsJournalEntries({
    senderRole: 'architect',
    sinceMs: Math.max(0, toNumber(signal.sentAtMs, 0) - 1000),
    order: 'asc',
    limit: 200,
  });
  return (Array.isArray(rows) ? rows : []).find((entry) => matchesArchitectResponse(entry, signal)) || null;
}

async function executeSignal(signal = {}, options = {}) {
  const eligibility = evaluateTradeTicketEligibility(signal.ticket, options);
  if (!eligibility.allowed) {
    return {
      ok: false,
      error: `signal_not_eligible:${eligibility.reasons.join(',')}`,
      eligibility,
    };
  }
  const ticket = signal.ticket;
  const result = await hmDefiExecute.openHyperliquidPosition({
    asset: ticket.asset,
    requestedDirection: ticket.direction,
    directionInput: ticket.direction,
    margin: eligibility.cappedMarginUsd,
    leverage: ticket.leverage,
    stopLossPrice: ticket.stopPrice,
    takeProfitPrice: ticket.takeProfitPrice,
    signalConfidence: ticket.conviction,
    entryLimitPrice: ticket.entryPrice,
    entryTimeInForce: 'IOC',
    retryDelayMs: 2000,
    maxRetries: 2,
    strategyLane: 'oracle_direct',
    clientOrderId: `oracle-direct-${signal.id}`,
    originatingAgentId: 'oracle',
    attributionSource: 'oracle_direct',
    attributionReasoning: signal.rawBody || ticket.rawBlock || '',
  });
  return {
    ok: Boolean(result),
    result,
    eligibility,
  };
}

async function hasOpenPositionForAsset(asset, walletAddress) {
  const positions = await hyperliquidClient.getOpenPositions({
    walletAddress,
    disableRequestPool: true,
    requestPoolTtlMs: 0,
  });
  const normalizedAsset = toText(asset).toUpperCase();
  return (Array.isArray(positions) ? positions : []).some((position) => {
    const raw = position?.raw || position || {};
    const coin = toText(raw.coin || position.coin).toUpperCase();
    const size = Math.abs(toNumber(raw.szi ?? position.size, 0));
    return coin === normalizedAsset && size > 0;
  });
}

async function executeCloseSignal(signal = {}, options = {}) {
  const convictionFloor = toNumber(options.convictionFloor, DEFAULT_CONVICTION_FLOOR);
  if (!signal?.ticker || !signal?.asset) {
    return {
      ok: false,
      error: 'close_signal_missing_asset',
    };
  }
  if (!Number.isFinite(signal.conviction) || signal.conviction < convictionFloor) {
    return {
      ok: false,
      error: 'close_signal_below_floor',
      convictionFloor,
    };
  }
  const runtime = await hmDefiExecute.resolveHyperliquidRuntime({});
  const hasPosition = await hasOpenPositionForAsset(signal.asset, runtime.walletAddress);
  if (!hasPosition) {
    return {
      ok: false,
      skipped: true,
      error: 'no_open_position',
    };
  }
  const closeResult = await hmDefiClose.closeHyperliquidPositions({
    asset: signal.asset,
    retryDelayMs: options.retryDelayMs,
  });
  return {
    ok: Boolean(closeResult?.ok),
    closeResult,
  };
}

function buildSignalFromEntry(entry = {}, ticket = {}) {
  const sentAtMs = toNumber(entry.sentAtMs || entry.brokeredAtMs, Date.now());
  return {
    id: createSignalId(entry, ticket),
    senderRole: toText(entry.senderRole, 'oracle'),
    targetRole: toText(entry.targetRole, ''),
    rawBody: toText(entry.rawBody, ''),
    sentAtMs,
    sentAt: new Date(sentAtMs).toISOString(),
    ticket,
    status: 'new',
    architectResponseAt: null,
    executionResult: null,
    telegramAlertAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function buildCloseSignalFromEntry(entry = {}, closeSignal = {}) {
  const sentAtMs = toNumber(entry.sentAtMs || entry.brokeredAtMs, Date.now());
  return {
    id: createCloseSignalId(entry, closeSignal),
    senderRole: toText(entry.senderRole, 'oracle'),
    targetRole: toText(entry.targetRole, ''),
    rawBody: toText(entry.rawBody, ''),
    sentAtMs,
    sentAt: new Date(sentAtMs).toISOString(),
    closeSignal,
    status: 'new_close',
    updatedAt: new Date().toISOString(),
  };
}

async function maybeSurfaceLowConviction(signal = {}) {
  return sendAgentAlert(
    `(BUILDER ORACLE-DIRECT): Oracle trade ticket below auto-fire floor for ${signal.ticket?.ticker || 'unknown'} (conviction ${signal.ticket?.conviction ?? 'n/a'}). Architect review only.`,
    {
      targets: ['architect'],
      role: DIRECT_EXECUTOR_ROLE,
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      env: process.env,
    }
  );
}

async function alertArchitectBottleneck(signal = {}) {
  return sendTelegram(
    `Architect bottleneck alert: Oracle signal for ${signal.ticket?.ticker || 'unknown'} sat ${Math.round((Date.now() - signal.sentAtMs) / 1000)}s without Architect response. Promoting direct Builder execution now.`,
    process.env,
    {
      senderRole: 'builder',
      targetRole: 'user',
      metadata: {
        source: 'oracle-direct-executor',
        signalId: signal.id,
        ticker: signal.ticket?.ticker || null,
      },
    }
  );
}

async function runDirectExecutionCycle(options = {}) {
  const nowMs = Date.now();
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const convictionFloor = toNumber(options.convictionFloor, DEFAULT_CONVICTION_FLOOR);
  const marginCapUsd = Math.max(1, toNumber(options.marginCapUsd, DEFAULT_MARGIN_CAP_USD));
  const architectTimeoutMs = Math.max(1000, toNumber(options.architectTimeoutMs, DEFAULT_ARCHITECT_RESPONSE_TIMEOUT_MS));
  const state = loadState(statePath);
  const sinceMs = Math.max(0, (new Date(toText(state.lastScanAt, 0)).getTime() || 0) - 1000);
  const oracleRows = queryCommsJournalEntries({
    senderRole: 'oracle',
    sinceMs,
    order: 'asc',
    limit: 500,
  });
  const alerts = [];

  for (const entry of Array.isArray(oracleRows) ? oracleRows : []) {
    const closeSignal = parseCloseSignal(entry.rawBody);
    if (closeSignal) {
      const builtCloseSignal = buildCloseSignalFromEntry(entry, closeSignal);
      const existingCloseSignal = state.signals[builtCloseSignal.id];
      if (!existingCloseSignal) {
        const execution = await executeCloseSignal(closeSignal, {
          convictionFloor,
          retryDelayMs: options.retryDelayMs,
        });
        state.signals[builtCloseSignal.id] = {
          ...builtCloseSignal,
          status: execution.ok
            ? 'closed_direct'
            : (execution.skipped ? 'close_skipped' : 'close_failed'),
          executionResult: execution,
          executedAt: new Date(nowMs).toISOString(),
          updatedAt: new Date(nowMs).toISOString(),
        };
        if (execution.ok) {
          alerts.push({ type: 'closed_direct', signalId: builtCloseSignal.id, ticker: closeSignal.ticker });
        }
      }
      continue;
    }

    const ticket = parseTradeTicket(entry.rawBody);
    if (!ticket) continue;
    const signal = buildSignalFromEntry(entry, ticket);
    const existing = state.signals[signal.id];
    if (existing) continue;
    const eligibility = evaluateTradeTicketEligibility(ticket, { convictionFloor, marginCapUsd });
    if (!eligibility.allowed && eligibility.reasons.includes('conviction_below_floor')) {
      await maybeSurfaceLowConviction(signal);
      state.signals[signal.id] = {
        ...signal,
        status: 'below_floor',
        eligibility,
        updatedAt: new Date(nowMs).toISOString(),
      };
      continue;
    }
    if (!eligibility.allowed) {
      state.signals[signal.id] = {
        ...signal,
        status: 'invalid',
        eligibility,
        updatedAt: new Date(nowMs).toISOString(),
      };
      continue;
    }
    if (toText(signal.targetRole).toLowerCase() === 'builder') {
      const execution = await executeSignal(signal, { convictionFloor, marginCapUsd });
      state.signals[signal.id] = {
        ...signal,
        status: execution.ok ? 'executed_direct' : 'execution_failed',
        eligibility: execution.eligibility,
        executionResult: execution,
        executedAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      };
      alerts.push({ type: 'executed_direct', signalId: signal.id, ticker: signal.ticket.ticker });
      continue;
    }
    state.signals[signal.id] = {
      ...signal,
      status: 'pending_architect',
      eligibility,
      updatedAt: new Date(nowMs).toISOString(),
    };
  }

  for (const [signalId, signal] of Object.entries(state.signals || {})) {
    if (signal.status !== 'pending_architect') continue;
    const architectEntry = hasArchitectResponse(signal);
    if (architectEntry) {
      state.signals[signalId] = {
        ...signal,
        status: 'architect_responded',
        architectResponseAt: new Date(toNumber(architectEntry.sentAtMs || architectEntry.brokeredAtMs, nowMs)).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      };
      continue;
    }
    if ((nowMs - toNumber(signal.sentAtMs, nowMs)) < architectTimeoutMs) {
      continue;
    }
    const telegramResult = await alertArchitectBottleneck(signal);
    const execution = await executeSignal(signal, { convictionFloor, marginCapUsd });
    state.signals[signalId] = {
      ...signal,
      status: execution.ok ? 'executed_after_timeout' : 'execution_failed_after_timeout',
      telegramAlertAt: new Date(nowMs).toISOString(),
      telegramResult,
      executionResult: execution,
      executedAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
    };
    alerts.push({ type: 'executed_after_timeout', signalId, ticker: signal.ticket?.ticker || null });
  }

  state.lastScanAt = new Date(nowMs).toISOString();
  state.updatedAt = new Date(nowMs).toISOString();
  persistState(statePath, state);
  return {
    ok: true,
    statePath,
    state,
    alerts,
  };
}

async function runCli(argv = parseCliArgs()) {
  const command = toText(argv.positional[0], 'run').toLowerCase();
  const statePath = path.resolve(toText(getOption(argv.options, 'state', DEFAULT_STATE_PATH)));
  const intervalMs = Math.max(5000, toNumber(getOption(argv.options, 'interval-ms', DEFAULT_INTERVAL_MS), DEFAULT_INTERVAL_MS));
  const convictionFloor = toNumber(getOption(argv.options, 'conviction-floor', DEFAULT_CONVICTION_FLOOR), DEFAULT_CONVICTION_FLOOR);
  const marginCapUsd = Math.max(1, toNumber(getOption(argv.options, 'margin-cap', DEFAULT_MARGIN_CAP_USD), DEFAULT_MARGIN_CAP_USD));
  const architectTimeoutMs = Math.max(1000, toNumber(getOption(argv.options, 'architect-timeout-ms', DEFAULT_ARCHITECT_RESPONSE_TIMEOUT_MS), DEFAULT_ARCHITECT_RESPONSE_TIMEOUT_MS));

  if (command === 'once') {
    const result = await runDirectExecutionCycle({
      statePath,
      convictionFloor,
      marginCapUsd,
      architectTimeoutMs,
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  while (true) {
    const result = await runDirectExecutionCycle({
      statePath,
      convictionFloor,
      marginCapUsd,
      architectTimeoutMs,
    });
    console.log(JSON.stringify(result, null, 2));
    await sleep(intervalMs);
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_ARCHITECT_RESPONSE_TIMEOUT_MS,
  DEFAULT_CONVICTION_FLOOR,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MARGIN_CAP_USD,
  DEFAULT_STATE_PATH,
  createSignalId,
  createCloseSignalId,
  defaultState,
  evaluateTradeTicketEligibility,
  executeSignal,
  executeCloseSignal,
  extractTradeTicketBlock,
  hasArchitectResponse,
  loadState,
  matchesArchitectResponse,
  normalizeConviction,
  parseCloseSignal,
  parseCliArgs,
  parseTradeTicket,
  persistState,
  runCli,
  runDirectExecutionCycle,
};
