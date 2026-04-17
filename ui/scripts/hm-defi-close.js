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
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const {
  formatPrice,
  executeHyperliquidOrder,
  executeHyperliquidCancel,
  toNonNegativeInteger,
} = require('./hm-defi-execute');

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
  return {
    asset: normalizeAssetName(getOption(options, 'asset', null)),
    size: Number(getOption(options, 'size', 0)) || null,
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
    '  --dry-run              Show what would close without sending orders',
    '  --retry-delay <ms>     Delay before retrying close submission',
    '  --help                 Show this help and exit safely',
    '  -h                     Alias for --help',
    '  --usage                Alias for --help',
  ].join('\n');
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
  const dryRun = Boolean(parsed.dryRun);
  const retryDelayMs = toNonNegativeInteger(parsed.retryDelayMs, 0);

  const wallet = privateKeyToAccount(privateKey);
  const transport = new HttpTransport();
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({ transport, wallet });

  const state = await info.clearinghouseState({ user: walletAddress });
  const meta = await info.meta();
  const mids = await info.allMids();

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
    const requestedCloseSize = requestedSize > 0
      ? Math.min(Math.abs(size), requestedSize)
      : Math.abs(size);

    const asset = meta.universe.find((entry) => normalizeAssetName(entry.name) === normalizeAssetName(coin));
    if (!asset) {
      console.error(`Asset ${coin} not found`);
      closeFailures += 1;
      continue;
    }
    const assetIndex = meta.universe.indexOf(asset);
    const midPrice = parseFloat(mids[coin]);
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
    }

    closeAttempted += 1;

    if (dryRun) {
      console.log('  [DRY RUN] No order sent');
      continue;
    }

    try {
      console.log('  Cancelling existing TP/SL orders...');
      const openOrders = await info.openOrders({ user: walletAddress });
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

      const newState = await info.clearinghouseState({ user: walletAddress });
      const newPos = newState.assetPositions.find((entry) => entry.position.coin === coin);
      const newSize = newPos ? parseFloat(newPos.position.szi) : 0;

      if (newSize === 0) {
        closedCount += 1;
        console.log(`  ✓ ${coin} position CLOSED successfully`);
        console.log(`  New account value: $${newState.marginSummary.accountValue}`);
      } else {
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
  main();
}

module.exports = {
  ensureDeFiSecrets,
  resolveWalletAddress,
  normalizeAssetName,
  parseCliArgs,
  parseCloseOptions,
  formatHelpText,
  buildCloseOrderPlan,
  closeHyperliquidPositions,
  main,
};
