#!/usr/bin/env node
'use strict';

/**
 * hm-defi-close.js - Close open Hyperliquid positions.
 *
 * Usage:
 *   node ui/scripts/hm-defi-close.js --asset WTI
 *   node ui/scripts/hm-defi-close.js --dry-run
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const {
  formatPrice,
  executeHyperliquidOrder,
  executeHyperliquidCancel,
  executeHyperliquidInfoCall,
  toNonNegativeInteger,
} = require('./hm-defi-execute');
const { withManualHyperliquidActivity } = require('../modules/trading/hyperliquid-manual-activity');
const agentPositionAttribution = require('../modules/trading/agent-position-attribution');

function resolveWalletAddress(env = process.env) {
  return String(
    env.HYPERLIQUID_WALLET_ADDRESS
    || env.HYPERLIQUID_ADDRESS
    || env.POLYMARKET_FUNDER_ADDRESS
    || ''
  ).trim();
}

function ensureDeFiSecrets() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  const walletAddress = resolveWalletAddress(process.env);
  if (!privateKey || !walletAddress) {
    throw new Error('Missing POLYMARKET_PRIVATE_KEY or Hyperliquid wallet address in .env');
  }
  return { privateKey, walletAddress };
}

function normalizeAssetName(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? raw.toUpperCase() : null;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h') {
      options.set('help', true);
      continue;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const rawKey = token.slice(2).trim();
    const key = rawKey === 'usage' ? 'help' : rawKey;
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

function parseCloseOptions(argv = parseCliArgs()) {
  const options = argv?.options instanceof Map ? argv.options : new Map();
  const closePct = Number(getOption(options, 'close-pct', NaN));
  return {
    asset: normalizeAssetName(getOption(options, 'asset', null)),
    size: Number(getOption(options, 'size', 0)) || null,
    closePct: Number.isFinite(closePct) && closePct > 0
      ? Math.max(0, Math.min(100, closePct))
      : null,
    dryRun: Boolean(getOption(options, 'dry-run', false)),
    help: Boolean(getOption(options, 'help', false)),
    retryDelayMs: toNonNegativeInteger(getOption(options, 'retry-delay', 0), 0),
  };
}

function formatHelpText() {
  return [
    'hm-defi-close.js - Close open Hyperliquid positions.',
    '',
    'Usage:',
    '  node ui/scripts/hm-defi-close.js --asset WTI',
    '  node ui/scripts/hm-defi-close.js --dry-run',
    '  node ui/scripts/hm-defi-close.js --help',
    '  node ui/scripts/hm-defi-close.js -h',
    '  node ui/scripts/hm-defi-close.js --usage',
    '',
    'Options:',
    '  --asset <SYMBOL>       Close only one asset',
    '  --size <AMOUNT>        Partially close up to this size',
    '  --close-pct <0-100>    Close this percent of the live position size',
    '  --dry-run              Show what would close without sending orders',
    '  --retry-delay <ms>     Delay before retrying close submission',
    '  --help                 Show this help and exit safely',
    '  -h                     Alias for --help',
    '  --usage                Alias for --help',
  ].join('\n');
}

function resolveRequestedCloseSize(positionSize, requestedSize = 0, closePct = null) {
  const absPositionSize = Math.abs(Number(positionSize) || 0);
  if (!(absPositionSize > 0)) return 0;
  const numericRequestedSize = Number(requestedSize) || 0;
  if (numericRequestedSize > 0) {
    return Math.min(absPositionSize, numericRequestedSize);
  }
  const numericClosePct = Number(closePct);
  if (Number.isFinite(numericClosePct) && numericClosePct > 0) {
    return absPositionSize * Math.max(0, Math.min(100, numericClosePct)) / 100;
  }
  return absPositionSize;
}

function buildCloseOrderPlan({ size, midPrice, szDecimals = 0 }) {
  const numericSize = Number(size);
  const numericMidPrice = Number(midPrice);
  if (!Number.isFinite(numericSize) || numericSize === 0) {
    throw new Error('Position size must be non-zero');
  }
  if (!Number.isFinite(numericMidPrice) || numericMidPrice <= 0) {
    throw new Error('Mid price must be positive');
  }

  const isBuy = numericSize < 0;
  const absSize = Math.abs(numericSize);
  const rawLimitPrice = isBuy
    ? numericMidPrice * 1.01
    : numericMidPrice * 0.99;
  const limitPrice = formatPrice(rawLimitPrice, numericMidPrice, szDecimals);

  return {
    isBuy,
    absSize,
    limitPrice,
    sideLabel: isBuy ? 'BUY' : 'SELL',
  };
}

async function closeHyperliquidPositions(options = {}) {
  const { privateKey, walletAddress } = ensureDeFiSecrets();
  const { HttpTransport, ExchangeClient, InfoClient } = await import('@nktkas/hyperliquid');
  const { privateKeyToAccount } = require('viem/accounts');

  const parsed = {
    ...parseCloseOptions(),
    ...options,
  };
  const assetFilter = normalizeAssetName(parsed.asset);
  const requestedSize = Number(parsed.size || 0) || 0;
  const requestedClosePct = Number(parsed.closePct);
  const dryRun = Boolean(parsed.dryRun);
  const retryDelayMs = toNonNegativeInteger(parsed.retryDelayMs, 0);

  const wallet = privateKeyToAccount(privateKey);
  const transport = new HttpTransport();
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({ transport, wallet });

  const state = await executeHyperliquidInfoCall(() => info.clearinghouseState({ user: walletAddress }), { label: 'close_clearinghouseState' });
  const meta = await executeHyperliquidInfoCall(() => info.meta(), { label: 'close_meta' });
  const mids = await executeHyperliquidInfoCall(() => info.allMids(), { label: 'close_allMids' });

  let closeAttempted = 0;
  let closeFailures = 0;
  let closedCount = 0;

  for (const pos of state.assetPositions) {
    const position = pos.position;
    const coin = position.coin;
    if (assetFilter && normalizeAssetName(coin) !== assetFilter) {
      continue;
    }

    const size = parseFloat(position.szi);
    if (size === 0) continue;
    const requestedCloseSize = resolveRequestedCloseSize(size, requestedSize, requestedClosePct);

    const asset = meta.universe.find((entry) => normalizeAssetName(entry.name) === normalizeAssetName(coin));
    if (!asset) {
      console.error(`Asset ${coin} not found`);
      closeFailures += 1;
      continue;
    }
    const assetIndex = meta.universe.indexOf(asset);
    const midPrice = parseFloat(mids[coin]);
    const ticker = `${normalizeAssetName(coin)}/USD`;
    const ownerByTicker = agentPositionAttribution.resolveAgentPositionOwnership([
      { ticker, coin },
    ]).ownersByTicker;
    const ownerAgentId = String(ownerByTicker[ticker] || '').trim().toLowerCase();
    const orderPlan = buildCloseOrderPlan({
      size: size < 0 ? -requestedCloseSize : requestedCloseSize,
      midPrice,
      szDecimals: Number(asset.szDecimals) || 0,
    });

    console.log(`Closing ${coin} position:`);
    console.log(`  Size: ${position.szi} (${size < 0 ? 'SHORT' : 'LONG'})`);
    console.log(`  Entry: $${position.entryPx}`);
    console.log(`  Current mid: $${formatPrice(midPrice, midPrice, Number(asset.szDecimals) || 0)}`);
    console.log(`  Unrealized PnL: $${position.unrealizedPnl}`);
    console.log(`  Action: ${orderPlan.sideLabel} ${orderPlan.absSize} ${coin} @ limit $${orderPlan.limitPrice} (IOC, reduce-only)`);
    if (requestedSize > 0 && requestedCloseSize < Math.abs(size)) {
      console.log(`  Partial close requested: ${requestedCloseSize} / ${Math.abs(size)} ${coin}`);
    } else if (Number.isFinite(requestedClosePct) && requestedClosePct > 0 && requestedClosePct < 100) {
      console.log(`  Partial close requested: ${requestedClosePct}% = ${requestedCloseSize} / ${Math.abs(size)} ${coin}`);
    }

    closeAttempted += 1;

    if (dryRun) {
      console.log('  [DRY RUN] No order sent');
      continue;
    }

    try {
      console.log('  Cancelling existing TP/SL orders...');
      const openOrders = await require('../modules/trading/hyperliquid-client').getOpenOrders({
        walletAddress,
        infoClient: info,
      });
      for (const order of openOrders) {
        if (order.coin === coin) {
          try {
            await executeHyperliquidCancel(exchange, { cancels: [{ a: assetIndex, o: order.oid }] }, {
              label: `close_cancel_${coin}_${order.oid}`,
            });
            console.log(`  Cancelled order ${order.oid}`);
          } catch (e) {
            console.log(`  Failed to cancel order ${order.oid}: ${e.message}`);
          }
        }
      }

      const result = await executeHyperliquidOrder(exchange, {
        orders: [{
          a: assetIndex,
          b: orderPlan.isBuy,
          p: orderPlan.limitPrice,
          s: orderPlan.absSize.toString(),
          r: true,
          t: { limit: { tif: 'Ioc' } },
        }],
        grouping: 'na',
      }, {
        retryDelayMs,
        label: `close_${coin}`,
      });

      console.log(`  Order result: ${JSON.stringify(result)}`);

      const newState = await executeHyperliquidInfoCall(() => info.clearinghouseState({ user: walletAddress }), { label: 'close_verify_clearinghouseState' });
      const newPos = newState.assetPositions.find((entry) => entry.position.coin === coin);
      const newSize = newPos ? parseFloat(newPos.position.szi) : 0;

      if (newSize === 0) {
        agentPositionAttribution.recordClosedPosition({
          ticker,
          agentId: ownerAgentId,
          direction: size < 0 ? 'SHORT' : 'LONG',
          entryPrice: Number(position.entryPx || 0),
          exitPrice: midPrice,
          closedSize: requestedCloseSize,
          currentSize: 0,
          marginUsd: Number(position.marginUsed || 0),
          leverage: Number(position?.leverage?.value || 0),
          source: 'hm-defi-close',
          closeOrderId: null,
          walletAddress,
        });
        closedCount += 1;
        console.log(`  ✓ ${coin} position CLOSED successfully`);
        console.log(`  New account value: $${newState.marginSummary.accountValue}`);
      } else {
        agentPositionAttribution.upsertOpenPosition({
          ticker,
          agentId: ownerAgentId,
          direction: newSize < 0 ? 'SHORT' : 'LONG',
          entryPrice: Number(newPos?.position?.entryPx || position.entryPx || 0),
          currentSize: Math.abs(newSize),
          initialSize: Math.abs(size),
          marginUsd: Number(newPos?.position?.marginUsed || position.marginUsed || 0),
          leverage: Number(newPos?.position?.leverage?.value || position?.leverage?.value || 0),
          source: 'hm-defi-close',
          walletAddress,
        });
        closeFailures += 1;
        console.log(`  ⚠ Position partially closed. Remaining: ${newSize}`);
      }
    } catch (e) {
      closeFailures += 1;
      console.error(`  ERROR closing ${coin}: ${e.message}`);
    }
  }

  if (closeFailures > 0) {
    process.exitCode = 1;
  }

  return {
    ok: closeFailures === 0,
    closeAttempted,
    closedCount,
  };
}

async function main(argv = parseCliArgs()) {
  try {
    const options = parseCloseOptions(argv);
    if (options.help) {
      console.log(formatHelpText());
      return { ok: true, help: true };
    }
    const result = await closeHyperliquidPositions(options);
    return result;
  } catch (e) {
    console.error('Fatal:', e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  withManualHyperliquidActivity(
    () => main(),
    {
      command: 'hm-defi-close',
      caller: process.env.SQUIDRUN_HYPERLIQUID_CALLER || 'manual',
      metadata: {
        argv: process.argv.slice(2),
      },
    }
  );
}

module.exports = {
  ensureDeFiSecrets,
  resolveWalletAddress,
  normalizeAssetName,
  parseCliArgs,
  parseCloseOptions,
  formatHelpText,
  resolveRequestedCloseSize,
  buildCloseOrderPlan,
  closeHyperliquidPositions,
  main,
};
