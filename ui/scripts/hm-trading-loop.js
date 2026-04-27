#!/usr/bin/env node
'use strict';

/**
 * hm-trading-loop.js — Dumb-hand sidecar live executor.
 *
 * NOT A TRADER. NOT A BRAIN. Has no opinions about structure, edge, confidence,
 * or universe. Reads commands written by the agent (Oracle/Architect) and executes
 * them mechanically: place, protect, report, close.
 *
 * Per cycle:
 *   1. Wallet snapshot (positions + open orders).
 *   2. Reconcile on-exchange protection per position. Report missing/orphan.
 *   3. Diff vs prior cycle to detect closes (stop/TP fills). Report.
 *   4. Read .squidrun/runtime/sidecar-orders.json. For any pending command, execute
 *      it verbatim (open with explicit margin/leverage/stop/tp, close, cancel),
 *      then mark it done with the outcome.
 *   5. Watchlist mids (read-only price snapshot for the agent to consume).
 *   6. Sleep, repeat.
 *
 * Defensive guardrail (NOT strategy): refuses opens if hard-risk-state mode is
 * paused/halted or daily loss budget is exhausted. This is account-protection, not
 * trade selection.
 *
 * Defaults to --observe-only: snapshot + reconcile + read-only command queue
 * (commands logged but not executed). Pass --enable-execution to actually act on
 * commands. The dumb hand is unarmed by default.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const fs = require('fs');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const bracketManager = require('../modules/trading/bracket-manager');
const hmDefiExecute = require('./hm-defi-execute');
const hmDefiClose = require('./hm-defi-close');

const DEFAULT_LOOP_MS = 60_000;
const DEFAULT_WATCHLIST = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
const HARD_RISK_STATE_PATH = path.resolve(__dirname, '..', '..', '.squidrun', 'runtime', 'hard-risk-state.json');
const ORDERS_FILE_PATH = path.resolve(__dirname, '..', '..', '.squidrun', 'runtime', 'sidecar-orders.json');
const HISTORY_FILE_PATH = path.resolve(__dirname, '..', '..', '.squidrun', 'runtime', 'sidecar-history.json');
const UNMANAGED_POSITION_EVENTS_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '.squidrun',
  'runtime',
  'unmanaged-position-events.jsonl'
);

function parseCli(argv = process.argv.slice(2)) {
  const opts = {
    observeOnly: true,
    loopMs: DEFAULT_LOOP_MS,
    watchlist: [],
    maxCycles: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--enable-execution') opts.observeOnly = false;
    else if (tok === '--observe-only') opts.observeOnly = true;
    else if (tok === '--once') opts.maxCycles = 1;
    else if (tok === '--loop-ms') opts.loopMs = Math.max(15_000, Number(argv[++i]) || DEFAULT_LOOP_MS);
    else if (tok === '--watchlist') opts.watchlist = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (tok === '--max-cycles') opts.maxCycles = Math.max(1, Number(argv[++i]) || 1);
  }
  if (!opts.watchlist.length) opts.watchlist = DEFAULT_WATCHLIST;
  return opts;
}

function fmt(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function logCycle(line) {
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, payload) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return true;
  } catch {
    return false;
  }
}

function appendJsonLineSafe(filePath, payload) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
    return true;
  } catch {
    return false;
  }
}

async function fetchWalletSnapshot() {
  const [orders, accounts] = await Promise.all([
    hyperliquidClient.getOpenOrders({ ttlMs: 0 }),
    hyperliquidClient.getAllClearinghouseStates({ ttlMs: 0 }),
  ]);
  const positions = [];
  for (const acc of accounts || []) {
    for (const ap of acc?.state?.assetPositions || []) {
      const p = ap?.position || {};
      const size = Number(p.szi || 0);
      if (!size) continue;
      positions.push({
        coin: String(p.coin || '').toUpperCase(),
        size,
        side: size < 0 ? 'short' : 'long',
        entryPx: Number(p.entryPx),
        unrealizedPnl: Number(p.unrealizedPnl),
        liquidationPx: Number(p.liquidationPx),
        dex: acc.dex,
      });
    }
  }
  return { orders: Array.isArray(orders) ? orders : [], positions };
}

function reconcileProtection(snapshot) {
  const findings = [];
  for (const position of snapshot.positions) {
    const reduceOnly = snapshot.orders.filter(
      (o) => String(o.coin || '').toUpperCase() === position.coin && o.reduceOnly === true
    );
    const protection = bracketManager.deriveExchangeProtection(position, reduceOnly);
    findings.push({
      coin: position.coin,
      side: position.side,
      size: position.size,
      entryPx: position.entryPx,
      unrealizedPnl: position.unrealizedPnl,
      protectionVerified: protection.verified,
      activeStopPrice: protection.activeStopPrice,
      activeTakeProfitPrice: protection.activeTakeProfitPrice,
      reduceOnlyOrderCount: reduceOnly.length,
    });
  }
  const positionCoins = new Set(snapshot.positions.map((p) => p.coin));
  const orphanReduceOnlyCoins = new Set();
  for (const order of snapshot.orders) {
    if (!order.reduceOnly) continue;
    const coin = String(order.coin || '').toUpperCase();
    if (!positionCoins.has(coin)) orphanReduceOnlyCoins.add(coin);
  }
  return { findings, orphanReduceOnlyCoins: Array.from(orphanReduceOnlyCoins) };
}

function detectCloses(prevPositions, currPositions) {
  const closed = [];
  const currCoins = new Set((currPositions || []).map((p) => p.coin));
  for (const prev of prevPositions || []) {
    if (!currCoins.has(prev.coin)) closed.push(prev);
  }
  return closed;
}

const UNMANAGED_MATCH_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
const UNMANAGED_NOTIONAL_MULTIPLE_LIMIT = 2; // notional > 2x expected = outsized
const OUTSIZED_UNMANAGED_EQUITY_FRACTION = 0.25; // notional > 25% equity = account-risk
const seenUnmanagedPositionKeys = new Set();

function findMatchingOpenCommand(coin, nowMs) {
  const hist = readJsonSafe(HISTORY_FILE_PATH, { entries: [] });
  const cutoff = nowMs - UNMANAGED_MATCH_WINDOW_MS;
  const matches = [];
  for (const e of (hist.entries || [])) {
    if (e?.action !== 'open') continue;
    if (String(e?.asset || '').toUpperCase() !== String(coin || '').toUpperCase()) continue;
    const tsMs = Date.parse(e?.ts || '') || 0;
    if (tsMs < cutoff) continue;
    if (e?.outcome?.ok !== true) continue;
    matches.push({ ...e, tsMs });
  }
  // Also check currently-pending or just-completed orders file in case history has lag
  const orders = readJsonSafe(ORDERS_FILE_PATH, { commands: [] });
  for (const c of (orders.commands || [])) {
    if (c?.action !== 'open') continue;
    if (String(c?.asset || '').toUpperCase() !== String(coin || '').toUpperCase()) continue;
    const tsMs = Number(c?.completedAtMs || c?.createdAtMs || 0);
    if (tsMs < cutoff) continue;
    if (c?.status !== 'done' && c?.outcome?.ok !== true) continue;
    matches.push({ ts: new Date(tsMs).toISOString(), ...c, tsMs });
  }
  matches.sort((a, b) => b.tsMs - a.tsMs);
  return matches[0] || null;
}

function reportAlerts(reconciled, closes, snapshot) {
  const alerts = [];
  const nowMs = Date.now();
  const equity = Number(snapshot?.equity || 0);
  for (const f of reconciled.findings) {
    if (!f.protectionVerified) {
      alerts.push(`UNPROTECTED ${f.coin} ${f.side} size=${f.size}`);
    }
    // Unmanaged-position guard: cross-check against recent 'open' commands.
    const matched = findMatchingOpenCommand(f.coin, nowMs);
    const absSize = Math.abs(Number(f.size) || 0);
    const notional = absSize * Math.abs(Number(f.entryPx) || 0);
    if (!matched) {
      alerts.push(`UNMANAGED_POSITION ${f.coin} ${f.side} size=${f.size} entry=${fmt(f.entryPx, 6)} notional=$${fmt(notional, 2)} no_matching_open_command_in_last_${Math.round(UNMANAGED_MATCH_WINDOW_MS / 60000)}m`);
      const unmanagedKey = `${f.coin}:${f.side}:${fmt(f.entryPx, 6)}:${fmt(absSize, 4)}`;
      if (!seenUnmanagedPositionKeys.has(unmanagedKey)) {
        seenUnmanagedPositionKeys.add(unmanagedKey);
        appendJsonLineSafe(UNMANAGED_POSITION_EVENTS_PATH, {
          detectedAt: new Date(nowMs).toISOString(),
          coin: f.coin,
          side: f.side,
          size: f.size,
          entryPx: f.entryPx,
          notionalUsd: Number(notional.toFixed(2)),
          unrealizedPnl: f.unrealizedPnl,
          activeStopPrice: f.activeStopPrice,
          activeTakeProfitPrice: f.activeTakeProfitPrice,
          protectionVerified: f.protectionVerified,
          reduceOnlyOrderCount: f.reduceOnlyOrderCount,
          alert: 'UNMANAGED_POSITION',
          matchWindowMinutes: Math.round(UNMANAGED_MATCH_WINDOW_MS / 60000),
          source: 'hm-trading-loop',
        });
      }
    } else {
      const expectedMargin = Number(matched.margin || matched?.cmd?.margin || 0);
      const expectedLeverage = Number(matched.leverage || matched?.cmd?.leverage || 1) || 1;
      const expectedNotional = expectedMargin * expectedLeverage;
      if (expectedNotional > 0 && notional > expectedNotional * UNMANAGED_NOTIONAL_MULTIPLE_LIMIT) {
        alerts.push(`UNMANAGED_POSITION_OUTSIZED ${f.coin} notional=$${fmt(notional, 2)} vs expected=$${fmt(expectedNotional, 2)} (>${UNMANAGED_NOTIONAL_MULTIPLE_LIMIT}x) matched_cmd=${matched.commandId || matched.cmdId || 'unknown'}`);
      }
      // Direction mismatch check
      const expectedDir = String(matched.direction || matched?.cmd?.direction || '').toUpperCase();
      const actualDir = f.side === 'short' ? 'SHORT' : 'LONG';
      if (expectedDir && expectedDir !== actualDir) {
        alerts.push(`UNMANAGED_POSITION_DIRECTION_MISMATCH ${f.coin} actual=${actualDir} expected=${expectedDir} matched_cmd=${matched.commandId || 'unknown'}`);
      }
    }
    // Account-risk guard: any single position whose notional exceeds equity fraction cap.
    if (equity > 0 && notional > equity * OUTSIZED_UNMANAGED_EQUITY_FRACTION) {
      alerts.push(`ACCOUNT_RISK_OUTSIZED ${f.coin} notional=$${fmt(notional, 2)} exceeds ${Math.round(OUTSIZED_UNMANAGED_EQUITY_FRACTION * 100)}% of equity $${fmt(equity, 2)}`);
    }
  }
  for (const coin of reconciled.orphanReduceOnlyCoins) {
    alerts.push(`ORPHAN reduce-only orders for ${coin} (no live position)`);
  }
  for (const c of closes) {
    alerts.push(`CLOSED ${c.coin} ${c.side} size=${c.size} lastPnl=${fmt(c.unrealizedPnl, 2)}`);
  }
  return alerts;
}

async function scanWatchlist(watchlist) {
  if (!watchlist.length) return [];
  const mids = await hyperliquidClient.getAllMids({ ttlMs: 0 });
  const out = [];
  for (const ticker of watchlist) {
    const coin = ticker.replace('/USD', '').toUpperCase();
    const price = Number(mids?.[coin]);
    if (Number.isFinite(price)) out.push({ ticker, coin, price });
  }
  return out;
}

// Defensive account-level guardrail. Not strategy. Refuses opens only when the
// account itself is under hard-risk-state pause/halt or budget exhausted.
function accountSafetyOk() {
  const state = readJsonSafe(HARD_RISK_STATE_PATH, null);
  if (!state) return { ok: true, reason: 'no_hard_risk_state_file' };
  const mode = String(state.mode || 'normal').toLowerCase();
  if (mode === 'paused' || mode === 'halted') {
    return { ok: false, reason: `account_safety: risk_mode=${mode}` };
  }
  if (Number(state.remainingLossBudgetUsd || 0) <= 0) {
    return { ok: false, reason: 'account_safety: remainingLossBudgetUsd<=0' };
  }
  return { ok: true, reason: 'account_safety_ok', mode };
}

function readPendingCommands() {
  const raw = readJsonSafe(ORDERS_FILE_PATH, null);
  if (!raw || !Array.isArray(raw.commands)) return [];
  const now = Date.now();
  return raw.commands.filter((c) => {
    if (!c || c.status && c.status !== 'pending') return false;
    if (c.expiresAtMs && Number(c.expiresAtMs) < now) return false;
    return true;
  });
}

function appendHistory(entry) {
  const hist = readJsonSafe(HISTORY_FILE_PATH, { entries: [] });
  hist.entries = (hist.entries || []).slice(-499);
  hist.entries.push({ ts: new Date().toISOString(), ...entry });
  writeJsonSafe(HISTORY_FILE_PATH, hist);
}

function markCommandDone(commandId, outcome) {
  const raw = readJsonSafe(ORDERS_FILE_PATH, null);
  if (!raw || !Array.isArray(raw.commands)) return;
  for (const c of raw.commands) {
    if (c && c.commandId === commandId) {
      c.status = outcome.ok ? 'done' : 'failed';
      c.completedAtMs = Date.now();
      c.outcome = outcome;
    }
  }
  writeJsonSafe(ORDERS_FILE_PATH, raw);
}

async function executeCommand(cmd, opts) {
  const action = String(cmd?.action || '').toLowerCase();
  if (action === 'open') {
    const safety = accountSafetyOk();
    if (!safety.ok) {
      return { ok: false, reason: safety.reason };
    }
    if (!cmd.asset || !cmd.direction || !cmd.margin || !cmd.stopLossPrice) {
      return { ok: false, reason: 'open_missing_required_fields (asset, direction, margin, stopLossPrice)' };
    }
    const result = await hmDefiExecute.openHyperliquidPosition({
      asset: String(cmd.asset).toUpperCase(),
      requestedDirection: String(cmd.direction).toUpperCase(),
      direction: String(cmd.direction).toUpperCase(),
      margin: Number(cmd.margin),
      leverage: Number(cmd.leverage) || 5,
      stopLossPrice: Number(cmd.stopLossPrice),
      takeProfitPrice: cmd.takeProfitPrice ? Number(cmd.takeProfitPrice) : null,
      signalConfidence: cmd.signalConfidence != null ? Number(cmd.signalConfidence) : null,
      strategyLane: 'sidecar_loop',
      clientOrderId: cmd.clientOrderId || `sidecar-${cmd.asset}-${Date.now()}`,
      originatingAgentId: String(cmd.originatingAgentId || 'oracle').toLowerCase(),
      attributionSource: cmd.attributionSource || 'sidecar_command_queue',
      attributionReasoning: cmd.attributionReasoning || cmd.note || '',
    });
    return { ok: result?.ok !== false, action: 'open', result: result?.summary || result || null };
  }
  if (action === 'close') {
    if (!cmd.asset) return { ok: false, reason: 'close_missing_asset' };
    const result = await hmDefiClose.closeHyperliquidPositions({
      asset: String(cmd.asset).toUpperCase(),
      closePct: Number(cmd.closePct) || 1,
    }).catch((err) => ({ ok: false, error: err?.message || String(err) }));
    return { ok: result?.ok !== false, action: 'close', result };
  }
  return { ok: false, reason: `unknown_action:${action}` };
}

async function processCommandQueue(opts) {
  const pending = readPendingCommands();
  if (pending.length === 0) return { processed: 0 };
  if (opts.observeOnly) {
    return {
      processed: 0,
      observedPending: pending.map((c) => ({ commandId: c.commandId, action: c.action, asset: c.asset, direction: c.direction })),
    };
  }
  const outcomes = [];
  for (const cmd of pending) {
    const outcome = await executeCommand(cmd, opts).catch((err) => ({ ok: false, reason: err?.message || String(err) }));
    markCommandDone(cmd.commandId, outcome);
    appendHistory({ commandId: cmd.commandId, action: cmd.action, asset: cmd.asset, outcome });
    outcomes.push({ commandId: cmd.commandId, action: cmd.action, asset: cmd.asset, ...outcome });
  }
  return { processed: outcomes.length, outcomes };
}

let priorPositions = [];

async function runCycle(opts, cycleIndex) {
  const startedAt = Date.now();
  let snapshot = { positions: [], orders: [] };
  let snapshotError = null;
  try {
    snapshot = await fetchWalletSnapshot();
  } catch (err) {
    snapshotError = err?.message || String(err);
    logCycle(`cycle=${cycleIndex} snapshot_error=${snapshotError} (continuing for command queue)`);
  }

  const reconciled = reconcileProtection(snapshot);
  const closes = detectCloses(priorPositions, snapshot.positions);
  const alerts = reportAlerts(reconciled, closes, { equity: snapshot?.equity });
  priorPositions = snapshot.positions;

  let watchlistResult = [];
  try {
    watchlistResult = await scanWatchlist(opts.watchlist);
  } catch (err) {
    logCycle(`cycle=${cycleIndex} scan_error=${err?.message || String(err)}`);
  }

  const commandResult = await processCommandQueue(opts).catch((err) => ({ processed: 0, error: err?.message || String(err) }));

  const elapsedMs = Date.now() - startedAt;
  const positionLine = reconciled.findings.length === 0
    ? 'positions=none'
    : reconciled.findings.map((f) => (
      `${f.coin}:${f.side}@${fmt(f.entryPx, 6)} pnl=${fmt(f.unrealizedPnl, 2)} stop=${fmt(f.activeStopPrice, 6)} tp=${fmt(f.activeTakeProfitPrice, 6)} verified=${f.protectionVerified}`
    )).join(' | ');
  const watchlistLine = watchlistResult.map((w) => `${w.ticker}=${fmt(w.price, 4)}`).join(' ');
  const cmdLine = commandResult.processed > 0
    ? `commands_executed=${commandResult.processed}`
    : (commandResult.observedPending && commandResult.observedPending.length > 0
      ? `commands_observed_only=${commandResult.observedPending.length}`
      : 'commands_pending=0');

  logCycle(
    `cycle=${cycleIndex} elapsed=${elapsedMs}ms mode=${opts.observeOnly ? 'observe' : 'execute'} ` +
    `${positionLine} | watch=${watchlistLine || 'none'} | ${cmdLine}`
  );
  for (const a of alerts) logCycle(`cycle=${cycleIndex} ALERT: ${a}`);
  if (commandResult.outcomes) {
    for (const o of commandResult.outcomes) {
      logCycle(`cycle=${cycleIndex} CMD ${o.commandId} ${o.action} ${o.asset || ''} ok=${o.ok} ${o.reason || ''}`);
    }
  }

  return { ok: true, snapshot, reconciled, alerts, watchlistResult, commandResult, elapsedMs };
}

async function main() {
  const opts = parseCli();
  logCycle(
    `hm-trading-loop start observeOnly=${opts.observeOnly} loopMs=${opts.loopMs} ` +
    `watchlist=${opts.watchlist.join(',')} maxCycles=${opts.maxCycles ?? 'unbounded'} ` +
    `ordersFile=${ORDERS_FILE_PATH}`
  );
  let i = 0;
  while (true) {
    i += 1;
    await runCycle(opts, i);
    if (opts.maxCycles && i >= opts.maxCycles) break;
    await new Promise((resolve) => setTimeout(resolve, opts.loopMs));
  }
  logCycle(`hm-trading-loop end totalCycles=${i}`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[FATAL] ${err?.stack || err?.message || String(err)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseCli,
  fetchWalletSnapshot,
  reconcileProtection,
  detectCloses,
  reportAlerts,
  scanWatchlist,
  accountSafetyOk,
  readPendingCommands,
  executeCommand,
  processCommandQueue,
  runCycle,
};
