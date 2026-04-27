#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const bracketManager = require('../modules/trading/bracket-manager');
const journal = require('../modules/trading/journal');
const manualStopOverrides = require('../modules/trading/manual-stop-overrides');
const hmDefiExecute = require('./hm-defi-execute');

function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) i += 1;
    options.set(key, value);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeAsset(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeOrderId(value) {
  if (value == null) return '';
  return String(value).trim();
}

function parseManageOptions(argv = parseCliArgs()) {
  const options = argv?.options instanceof Map ? argv.options : new Map();
  return {
    asset: normalizeAsset(getOption(options, 'asset', '')),
    entryPrice: toNumber(getOption(options, 'entry-price', 0), 0),
    stopPrice: toNumber(getOption(options, 'stop-loss', 0), 0),
    takeProfitPrice1: toNumber(getOption(options, 'take-profit-1', 0), 0),
    takeProfitPrice2: toNumber(getOption(options, 'take-profit-2', 0), 0),
    size: toNumber(getOption(options, 'size', 0), 0),
    direction: String(getOption(options, 'direction', 'LONG')).trim().toUpperCase(),
    breakEvenStopPrice: toNumber(getOption(options, 'break-even-stop', 0), 0),
    firstTakeProfitOrderId: getOption(options, 'tp1-order-id', null),
    firstTakeProfitRatio: toNumber(getOption(options, 'first-tp-ratio', bracketManager.DEFAULT_FIRST_TP_RATIO), bracketManager.DEFAULT_FIRST_TP_RATIO),
    dryRun: Boolean(getOption(options, 'dry-run', false)),
    journalPath: getOption(options, 'journal-path', null),
  };
}

async function fetchOpenOrders(info, walletAddress) {
  if (!info || typeof info.openOrders !== 'function') return [];
  const hyperliquidClient = require('../modules/trading/hyperliquid-client');
  const orders = await hyperliquidClient.getOpenOrders({
    walletAddress,
    infoClient: info,
  });
  return Array.isArray(orders) ? orders : [];
}

async function cancelHyperliquidOrders(exchange, assetIndex, orderIds = []) {
  const ids = Array.from(new Set((Array.isArray(orderIds) ? orderIds : []).filter((value) => value != null)));
  if (ids.length === 0) return { ok: true, canceled: [] };
  const result = await hmDefiExecute.executeHyperliquidCancel(exchange, {
    cancels: ids.map((oid) => ({ a: assetIndex, o: oid })),
  }, {
    label: `bracket_cancel_${assetIndex}`,
  });
  const normalizedStatus = String(result?.status || '').trim().toLowerCase();
  const ok = !result?.error && (!normalizedStatus || normalizedStatus === 'ok' || normalizedStatus === 'success');
  return {
    ok,
    canceled: ok ? ids : [],
    result,
  };
}

function parseExecutionReportPayload(row = null) {
  if (!row?.report_json) return null;
  try {
    return JSON.parse(row.report_json);
  } catch {
    return null;
  }
}

function getRecentBracketReports(db, ticker, limit = 25) {
  if (!db || typeof db.prepare !== 'function') return [];
  return db.prepare(`
    SELECT id, timestamp, report_type, report_json
    FROM execution_reports
    WHERE ticker = ?
      AND report_type IN ('hyperliquid_bracket_stop_move', 'hyperliquid_bracket_final_exit')
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(ticker, limit);
}

function findPendingBracketFinalExit(db, {
  ticker,
  entryPrice = 0,
} = {}) {
  const normalizedTicker = String(ticker || '').trim();
  if (!normalizedTicker) return null;

  const reports = getRecentBracketReports(db, normalizedTicker, 50);
  const parsedReports = reports
    .map((row) => ({
      row,
      payload: parseExecutionReportPayload(row),
    }))
    .filter((entry) => entry.payload);

  const latestStopMove = parsedReports.find((entry) => {
    if (entry.row.report_type !== 'hyperliquid_bracket_stop_move') return false;
    const reportEntryPrice = Number(
      entry.payload?.entryPrice
      ?? entry.payload?.execution?.entryPrice
      ?? entry.payload?.execution?.bracketPlan?.entryPrice
    );
    if (!Number.isFinite(reportEntryPrice) || reportEntryPrice <= 0) return true;
    if (!Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) return true;
    return Math.abs(reportEntryPrice - Number(entryPrice)) <= 0.5;
  }) || null;

  if (!latestStopMove) {
    return null;
  }

  const stopMoveOrderId = normalizeOrderId(
    latestStopMove.payload?.replacementStopOrderId
    ?? latestStopMove.payload?.execution?.replacementStopOrderId
  );
  const stopMoveTimestamp = new Date(
    latestStopMove.payload?.timestamp
    || latestStopMove.row.timestamp
    || 0
  ).getTime();

  const finalExitAlreadyRecorded = parsedReports.some((entry) => {
    if (entry.row.report_type !== 'hyperliquid_bracket_final_exit') return false;
    const exitOrderId = normalizeOrderId(
      entry.payload?.exitOrderId
      ?? entry.payload?.execution?.exitOrderId
    );
    const exitTimestamp = new Date(entry.payload?.timestamp || entry.row.timestamp || 0).getTime();
    if (stopMoveOrderId && exitOrderId && exitOrderId === stopMoveOrderId) {
      return true;
    }
    return Number.isFinite(stopMoveTimestamp)
      && Number.isFinite(exitTimestamp)
      && exitTimestamp >= stopMoveTimestamp;
  });

  if (finalExitAlreadyRecorded) {
    return null;
  }

  return {
    stopMoveRow: latestStopMove.row,
    stopMovePayload: latestStopMove.payload,
    replacementStopOrderId: stopMoveOrderId || null,
    replacementStopPrice: Number(
      latestStopMove.payload?.replacementStopPrice
      ?? latestStopMove.payload?.execution?.replacementStopPrice
      ?? latestStopMove.payload?.exitPrice
    ) || null,
    timestampMs: Number.isFinite(stopMoveTimestamp) ? stopMoveTimestamp : Date.now(),
  };
}

async function fetchRecentUserFills(info, walletAddress, startTimeMs) {
  const normalizedStartTime = Math.max(0, Number(startTimeMs) || 0);
  if (info && typeof info.userFillsByTime === 'function') {
    const fills = await info.userFillsByTime({
      user: walletAddress,
      startTime: normalizedStartTime,
      aggregateByTime: false,
      reversed: true,
    });
    return Array.isArray(fills) ? fills : [];
  }
  if (info && typeof info.userFills === 'function') {
    const fills = await info.userFills({
      user: walletAddress,
      aggregateByTime: false,
    });
    return Array.isArray(fills)
      ? fills.filter((fill) => Number(fill?.time || 0) >= normalizedStartTime)
      : [];
  }
  return [];
}

function aggregateMatchingFills(fills = [], {
  asset,
  orderId,
} = {}) {
  const normalizedAsset = normalizeAsset(asset);
  const normalizedOrderId = normalizeOrderId(orderId);
  const matchingFills = (Array.isArray(fills) ? fills : []).filter((fill) => {
    return normalizeAsset(fill?.coin) === normalizedAsset
      && normalizeOrderId(fill?.oid) === normalizedOrderId;
  });
  if (matchingFills.length === 0) {
    return null;
  }

  let closedSize = 0;
  let realizedPnl = 0;
  let hasRealizedPnl = false;
  let weightedExitValue = 0;
  let latestFillTime = 0;

  for (const fill of matchingFills) {
    const fillSize = Math.abs(Number(fill?.sz || 0)) || 0;
    const fillPrice = Number(fill?.px || 0) || 0;
    const fillPnl = Number(fill?.closedPnl);
    closedSize += fillSize;
    weightedExitValue += fillSize * fillPrice;
    if (Number.isFinite(fillPnl)) {
      realizedPnl += fillPnl;
      hasRealizedPnl = true;
    }
    latestFillTime = Math.max(latestFillTime, Number(fill?.time || 0) || 0);
  }

  return {
    fills: matchingFills,
    closedSize,
    exitPrice: closedSize > 0 ? (weightedExitValue / closedSize) : null,
    realizedPnl: hasRealizedPnl ? realizedPnl : null,
    fillTimestamp: latestFillTime || null,
  };
}

async function reconcileBracketFinalExit({
  db,
  info,
  walletAddress,
  asset,
  direction,
  bracketPlan,
} = {}) {
  const ticker = `${asset}/USD`;
  const pendingExit = findPendingBracketFinalExit(db, {
    ticker,
    entryPrice: bracketPlan?.entryPrice,
  });
  if (!pendingExit?.replacementStopOrderId) {
    return null;
  }

  const fills = await fetchRecentUserFills(
    info,
    walletAddress,
    Math.max(0, pendingExit.timestampMs - (5 * 60 * 1000))
  );
  const aggregatedFill = aggregateMatchingFills(fills, {
    asset,
    orderId: pendingExit.replacementStopOrderId,
  });

  if (!aggregatedFill) {
    return null;
  }

  const exitPrice = Number(aggregatedFill.exitPrice || 0) || pendingExit.replacementStopPrice || null;
  const exitSize = Number(aggregatedFill.closedSize || 0) || bracketPlan?.runnerSize || null;
  const realizedPnl = Number(aggregatedFill.realizedPnl);
  recordBracketExecutionReport({ journalDb: db }, {
    reportType: 'hyperliquid_bracket_final_exit',
    asset,
    ticker,
    direction: direction === 'SHORT' ? 'BUY' : 'SELL',
    status: 'filled',
    entryPrice: bracketPlan?.entryPrice || null,
    exitPrice,
    realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : null,
    exitOrderId: pendingExit.replacementStopOrderId,
    closedSize: exitSize,
    managementAction: 'runner_exit',
    bracketPlan,
    fill: aggregatedFill.fills[0] || null,
    fills: aggregatedFill.fills,
  });

  return {
    reportType: 'hyperliquid_bracket_final_exit',
    exitOrderId: pendingExit.replacementStopOrderId,
    exitPrice,
    realizedPnl: Number.isFinite(realizedPnl) ? realizedPnl : null,
    closedSize: exitSize,
    fillTimestamp: aggregatedFill.fillTimestamp,
  };
}

function recordBracketExecutionReport(options = {}, payload = {}) {
  if (options.recordJournal === false) return null;
  const db = options.journalDb || journal.getDb(options.journalPath);
  return journal.recordExecutionReport(db, {
    timestamp: new Date().toISOString(),
    phase: 'position_management',
    reportType: payload.reportType || 'hyperliquid_bracket_manager',
    ticker: payload.ticker || `${payload.asset}/USD`,
    direction: payload.direction || null,
    broker: 'hyperliquid',
    assetClass: 'crypto',
    status: payload.status || 'accepted',
    ok: payload.ok !== false,
    entryPrice: payload.entryPrice ?? null,
    exitPrice: payload.exitPrice ?? null,
    realizedPnl: payload.realizedPnl ?? null,
    report_json: undefined,
    execution: payload,
  });
}

async function manageHyperliquidBracket(input = {}, options = {}) {
  const params = { ...parseManageOptions(), ...input };
  if (!params.asset) {
    throw new Error('Bracket manager requires --asset');
  }

  const runtime = await hmDefiExecute.resolveHyperliquidRuntime(options);
  const { walletAddress, info, exchange } = runtime;
  const journalDb = options.recordJournal === false ? null : (options.journalDb || journal.getDb(options.journalPath));
  const meta = await info.meta();
  const resolvedAsset = hmDefiExecute.findAssetMeta(meta, params.asset);
  if (!resolvedAsset) {
    throw new Error(`${params.asset} not found in Hyperliquid universe`);
  }

  const state = await info.clearinghouseState({ user: walletAddress });
  const livePosition = hmDefiExecute.extractOpenHyperliquidPosition(state, params.asset);
  const openOrders = await fetchOpenOrders(info, walletAddress);
  const bracketState = bracketManager.deriveBracketState({
    asset: params.asset,
    direction: params.direction,
    entryPrice: params.entryPrice || livePosition?.entryPx || 0,
    stopPrice: params.stopPrice,
    takeProfitPrice1: params.takeProfitPrice1,
    takeProfitPrice2: params.takeProfitPrice2,
    size: params.size || livePosition?.absSize || 0,
    breakEvenStopPrice: params.breakEvenStopPrice || params.entryPrice || livePosition?.entryPx || 0,
    firstTakeProfitOrderId: params.firstTakeProfitOrderId,
    firstTakeProfitRatio: params.firstTakeProfitRatio,
    szDecimals: hmDefiExecute.resolveAssetSzDecimals(resolvedAsset, 4),
    position: livePosition ? {
      coin: livePosition.coin,
      size: livePosition.signedSize,
      side: livePosition.side.toLowerCase(),
      entryPx: livePosition.entryPx,
    } : {
      coin: params.asset,
      size: 0,
      side: params.direction === 'SHORT' ? 'short' : 'long',
      entryPx: params.entryPrice,
    },
    openOrders,
  });

  if (bracketState.flat) {
    const finalExit = journalDb
      ? await reconcileBracketFinalExit({
        db: journalDb,
        info,
        walletAddress,
        asset: params.asset,
        direction: params.direction,
        bracketPlan: bracketState.bracketPlan,
      })
      : null;
    return {
      ok: true,
      action: finalExit ? 'record_final_exit' : 'none',
      state: 'closed',
      asset: params.asset,
      bracketPlan: bracketState.bracketPlan,
      finalExit,
    };
  }

  if (!bracketState.needsBreakEvenStopMove) {
    return {
      ok: true,
      action: 'none',
      state: bracketState.state,
      asset: params.asset,
      bracketPlan: bracketState.bracketPlan,
    };
  }

  if (!livePosition || livePosition.absSize <= 0) {
    return {
      ok: false,
      action: 'none',
      state: 'closed',
      error: `No open ${params.asset} position found for bracket management`,
      bracketPlan: bracketState.bracketPlan,
    };
  }

  const response = {
    ok: true,
    action: 'move_stop_to_breakeven',
    state: bracketState.state,
    asset: params.asset,
    bracketPlan: bracketState.bracketPlan,
    canceledStopOrderIds: bracketState.cancelOrderIds,
    replacementStopPrice: bracketState.replacementStopPrice,
    remainingSize: livePosition.absSize,
  };

  if (params.dryRun) {
    response.status = 'dry_run';
    return response;
  }

  const originalStopOrder = bracketState.activeStopOrder;
  const cancelResult = await cancelHyperliquidOrders(exchange, resolvedAsset.assetIndex, bracketState.cancelOrderIds);
  if (!cancelResult.ok) {
    throw new Error(`Failed to cancel original stop order(s) for ${params.asset}`);
  }

  try {
    const replacementStopResult = await hmDefiExecute.placeHyperliquidStopLoss({
      exchange,
      assetIndex: resolvedAsset.assetIndex,
      isLong: livePosition.isLong,
      size: livePosition.absSize,
      stopPrice: bracketState.replacementStopPrice,
      referencePrice: livePosition.entryPx || bracketState.bracketPlan.entryPrice,
      szDecimals: hmDefiExecute.resolveAssetSzDecimals(resolvedAsset, 4),
      executionOptions: {
        label: `move_stop_to_breakeven_${params.asset}`,
        timeoutMs: options.hyperliquidCallTimeoutMs,
        state: { lastOrderAt: 0 },
      },
    });
    response.replacementStopOrderId = hmDefiExecute.extractHyperliquidOrderId(replacementStopResult);
    manualStopOverrides.clearManualStopOverride(params.asset);
  } catch (replacementError) {
    if (originalStopOrder?.price > 0) {
      try {
        await hmDefiExecute.placeHyperliquidStopLoss({
          exchange,
          assetIndex: resolvedAsset.assetIndex,
          isLong: livePosition.isLong,
          size: livePosition.absSize,
          stopPrice: originalStopOrder.price,
          referencePrice: livePosition.entryPx || bracketState.bracketPlan.entryPrice,
          szDecimals: hmDefiExecute.resolveAssetSzDecimals(resolvedAsset, 4),
          executionOptions: {
            label: `restore_original_stop_${params.asset}`,
            timeoutMs: options.hyperliquidCallTimeoutMs,
            state: { lastOrderAt: 0 },
          },
        });
      } catch (restoreError) {
        throw new Error(
          `Replacement stop failed (${replacementError?.message || replacementError}); `
          + `original stop restore failed (${restoreError?.message || restoreError})`
        );
      }
    }

    return {
      ...response,
      ok: false,
      status: 'restored_original_stop',
      restoredOriginalStop: true,
      restoredStopPrice: originalStopOrder?.price || null,
      error: replacementError?.message || String(replacementError),
    };
  }

  recordBracketExecutionReport({
    ...options,
    journalDb,
  }, {
    reportType: 'hyperliquid_bracket_stop_move',
    asset: params.asset,
    ticker: `${params.asset}/USD`,
    direction: livePosition.isLong ? 'SELL' : 'BUY',
    status: 'accepted',
    entryPrice: livePosition.entryPx || bracketState.bracketPlan.entryPrice,
    exitPrice: bracketState.replacementStopPrice,
    remainingSize: livePosition.absSize,
    canceledStopOrderIds: bracketState.cancelOrderIds,
    replacementStopOrderId: response.replacementStopOrderId || null,
    replacementStopPrice: bracketState.replacementStopPrice,
    managementAction: 'move_stop_to_breakeven',
    bracketPlan: bracketState.bracketPlan,
  });

  response.status = 'accepted';
  return response;
}

async function main() {
  try {
    const result = await manageHyperliquidBracket();
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseCliArgs,
  parseManageOptions,
  cancelHyperliquidOrders,
  manageHyperliquidBracket,
};
