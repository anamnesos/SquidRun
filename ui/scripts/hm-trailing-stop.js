#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const bracketManager = require('../modules/trading/bracket-manager');
const hyperliquidClient = require('../modules/trading/hyperliquid-client');
const hmDefiExecute = require('./hm-defi-execute');
const hyperliquidBracketManager = require('./hm-hyperliquid-bracket-manager');

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeAsset(value) {
  return hmDefiExecute.normalizeAssetName(value, '');
}

function toTrailFraction(value, fallback = NaN) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric / 100;
}

function formatHelpText() {
  return [
    'Usage: node ui/scripts/hm-trailing-stop.js --asset <ASSET> --trail-pct <PERCENT> [--dry-run]',
    '',
    'Examples:',
    '  node ui/scripts/hm-trailing-stop.js --asset SUI --trail-pct 0.5 --dry-run',
    '  node ui/scripts/hm-trailing-stop.js --asset ETH --trail-pct 0.8',
    '',
    'Notes:',
    '  --trail-pct is expressed as a percent, so 0.5 means 0.5%',
    '  The script only tightens protection. It never widens an existing stop.',
  ].join('\n');
}

function parseTrailingStopOptions(argv = hmDefiExecute.parseCliArgs()) {
  const options = argv?.options instanceof Map ? argv.options : new Map();
  const trailPctInput = toNumber(getOption(options, 'trail-pct', NaN), NaN);
  return {
    asset: normalizeAsset(getOption(options, 'asset', '')),
    trailPct: trailPctInput,
    trailFraction: toTrailFraction(trailPctInput, NaN),
    dryRun: Boolean(getOption(options, 'dry-run', false)),
    help: Boolean(getOption(options, 'help', false)),
  };
}

function resolveLivePrice(position = null, assetCtx = {}) {
  const markPx = toNumber(assetCtx?.markPx, 0);
  if (markPx > 0) return markPx;

  const midPx = toNumber(assetCtx?.midPx, 0);
  if (midPx > 0) return midPx;

  const oraclePx = toNumber(assetCtx?.oraclePx, 0);
  if (oraclePx > 0) return oraclePx;

  const absSize = Math.abs(toNumber(position?.signedSize, 0));
  const positionValue = toNumber(position?.positionValue, 0);
  if (absSize > 0 && positionValue > 0) {
    return positionValue / absSize;
  }

  return toNumber(position?.entryPx, 0) || null;
}

function findActiveStopOrder(position = null, openOrders = []) {
  if (!position) {
    return { activeStopOrder: null, stopOrders: [] };
  }

  const bracketPosition = {
    coin: position.coin,
    size: position.signedSize,
    entryPx: position.entryPx,
  };
  const { stopOrders } = bracketManager.splitReduceOnlyOrders(bracketPosition, openOrders);
  const activeStopOrder = position.isLong
    ? (stopOrders[stopOrders.length - 1] || null)
    : (stopOrders[0] || null);

  return { activeStopOrder, stopOrders };
}

function computeTrailingStopPrice({
  isLong = true,
  livePrice = 0,
  trailFraction = 0,
  szDecimals = 0,
} = {}) {
  const numericLivePrice = toNumber(livePrice, 0);
  const numericTrailFraction = toNumber(trailFraction, 0);
  if (!(numericLivePrice > 0) || !(numericTrailFraction > 0)) return null;

  const rawStop = isLong
    ? numericLivePrice * (1 - numericTrailFraction)
    : numericLivePrice * (1 + numericTrailFraction);

  const roundedStop = hmDefiExecute.roundPrice(rawStop, numericLivePrice, szDecimals);
  return Number.isFinite(roundedStop) && roundedStop > 0 ? roundedStop : null;
}

function evaluateTrailingStopMove({
  isLong = true,
  livePrice = 0,
  currentStop = null,
  candidateStop = null,
} = {}) {
  const numericLivePrice = toNumber(livePrice, 0);
  const numericCurrentStop = toNumber(currentStop, 0);
  const numericCandidateStop = toNumber(candidateStop, 0);

  if (!(numericCurrentStop > 0)) {
    return { shouldMove: false, reason: 'no_existing_stop' };
  }
  if (!(numericLivePrice > 0)) {
    return { shouldMove: false, reason: 'live_price_unavailable' };
  }
  if (!(numericCandidateStop > 0)) {
    return { shouldMove: false, reason: 'candidate_stop_unavailable' };
  }

  if (isLong) {
    if (numericCandidateStop >= numericLivePrice) {
      return { shouldMove: false, reason: 'candidate_stop_would_trigger_immediately' };
    }
    if (numericCandidateStop <= numericCurrentStop) {
      return { shouldMove: false, reason: 'candidate_stop_not_tighter' };
    }
  } else {
    if (numericCandidateStop <= numericLivePrice) {
      return { shouldMove: false, reason: 'candidate_stop_would_trigger_immediately' };
    }
    if (numericCandidateStop >= numericCurrentStop) {
      return { shouldMove: false, reason: 'candidate_stop_not_tighter' };
    }
  }

  return { shouldMove: true, reason: 'trailing_stop_tightened' };
}

async function manageTrailingStop(input = {}, options = {}) {
  const params = { ...parseTrailingStopOptions(), ...input };
  if (!params.asset) {
    throw new Error('Trailing stop manager requires --asset');
  }
  if (!(Number(params.trailFraction) > 0)) {
    throw new Error('Trailing stop manager requires a positive --trail-pct');
  }

  const runtime = await hmDefiExecute.resolveHyperliquidRuntime(options);
  const { walletAddress, info, exchange } = runtime;
  const timeoutMs = hmDefiExecute.toNonNegativeInteger(
    options.hyperliquidCallTimeoutMs,
    45_000
  ) || 45_000;

  const [meta, assetCtxs] = await hmDefiExecute.withTimeout(
    hyperliquidClient.getMetaAndAssetCtxs({
      requestPoolTtlMs: 8_000,
    }),
    timeoutMs,
    'trailingStopMetaAndAssetCtxs'
  );
  const resolvedAsset = hmDefiExecute.findAssetMeta(meta, params.asset);
  if (!resolvedAsset) {
    throw new Error(`${params.asset} not found in Hyperliquid universe`);
  }

  const clearinghouseState = await hmDefiExecute.withTimeout(
    info.clearinghouseState({ user: walletAddress }),
    timeoutMs,
    'trailingStopClearinghouseState'
  );
  const livePosition = hmDefiExecute.extractOpenHyperliquidPosition(clearinghouseState, params.asset);
  if (!livePosition || livePosition.absSize <= 0) {
    return {
      ok: true,
      asset: params.asset,
      livePrice: null,
      oldStop: null,
      newStop: null,
      action: 'none',
      reason: 'no_open_position',
    };
  }

  const openOrders = await hmDefiExecute.withTimeout(
    info.openOrders({ user: walletAddress }),
    timeoutMs,
    'trailingStopOpenOrders'
  ).catch(() => []);
  const { activeStopOrder, stopOrders } = findActiveStopOrder(livePosition, openOrders);

  const assetCtx = Array.isArray(assetCtxs) ? assetCtxs[resolvedAsset.assetIndex] : null;
  const livePrice = resolveLivePrice(livePosition, assetCtx || {});
  const oldStop = activeStopOrder?.price || null;
  const szDecimals = hmDefiExecute.resolveAssetSzDecimals(resolvedAsset, 4);
  const newStop = computeTrailingStopPrice({
    isLong: livePosition.isLong,
    livePrice,
    trailFraction: params.trailFraction,
    szDecimals,
  });

  const decision = evaluateTrailingStopMove({
    isLong: livePosition.isLong,
    livePrice,
    currentStop: oldStop,
    candidateStop: newStop,
  });

  const response = {
    ok: true,
    asset: params.asset,
    livePrice,
    oldStop,
    newStop,
    action: 'none',
    reason: decision.reason,
  };

  if (!decision.shouldMove) {
    return response;
  }

  response.action = params.dryRun ? 'dry_run' : 'replace_stop';

  if (params.dryRun) {
    return response;
  }

  const cancelOrderIds = stopOrders
    .map((order) => order?.oid)
    .filter((value) => value != null);
  const cancelResult = await hyperliquidBracketManager.cancelHyperliquidOrders(
    exchange,
    resolvedAsset.assetIndex,
    cancelOrderIds
  );
  if (!cancelResult.ok) {
    throw new Error(`Failed to cancel existing ${params.asset} stop order(s)`);
  }

  try {
    const replacementStopResult = await hmDefiExecute.placeHyperliquidStopLoss({
      exchange,
      assetIndex: resolvedAsset.assetIndex,
      isLong: livePosition.isLong,
      size: livePosition.absSize,
      stopPrice: newStop,
      referencePrice: livePrice || livePosition.entryPx || newStop,
      szDecimals,
      executionOptions: {
        label: `trailing_stop_${params.asset}`,
        timeoutMs,
        state: { lastOrderAt: 0 },
      },
    });
    response.replacementStopOrderId = hmDefiExecute.extractHyperliquidOrderId(replacementStopResult);
    return response;
  } catch (replacementError) {
    if (oldStop > 0) {
      try {
        await hmDefiExecute.placeHyperliquidStopLoss({
          exchange,
          assetIndex: resolvedAsset.assetIndex,
          isLong: livePosition.isLong,
          size: livePosition.absSize,
          stopPrice: oldStop,
          referencePrice: livePrice || livePosition.entryPx || oldStop,
          szDecimals,
          executionOptions: {
            label: `restore_trailing_stop_${params.asset}`,
            timeoutMs,
            state: { lastOrderAt: 0 },
          },
        });
      } catch (restoreError) {
        throw new Error(
          `Trailing stop replacement failed (${replacementError?.message || replacementError}); `
          + `original stop restore failed (${restoreError?.message || restoreError})`
        );
      }
      return {
        ...response,
        ok: false,
        action: 'restore_old_stop',
        reason: 'replacement_failed_restored_old_stop',
      };
    }
    throw replacementError;
  }
}

async function main(argv = hmDefiExecute.parseCliArgs()) {
  const params = parseTrailingStopOptions(argv);
  if (params.help) {
    console.log(formatHelpText());
    return { ok: true, help: true };
  }

  try {
    const result = await manageTrailingStop(params);
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    const failure = {
      ok: false,
      asset: params.asset || null,
      livePrice: null,
      oldStop: null,
      newStop: null,
      action: 'error',
      reason: error?.message || String(error),
    };
    console.log(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
    return failure;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseTrailingStopOptions,
  toTrailFraction,
  formatHelpText,
  resolveLivePrice,
  findActiveStopOrder,
  computeTrailingStopPrice,
  evaluateTrailingStopMove,
  manageTrailingStop,
  main,
};
