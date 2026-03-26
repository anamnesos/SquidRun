#!/usr/bin/env node
'use strict';

/**
 * hm-defi-close.js — Close an open Hyperliquid position
 *
 * Usage:
 *   node ui/scripts/hm-defi-close.js           — Close ETH position (market order)
 *   node ui/scripts/hm-defi-close.js --dry-run  — Show what would happen
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const WALLET_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS;
const isDryRun = process.argv.includes('--dry-run');

async function main() {
  const { HttpTransport, ExchangeClient, InfoClient } = await import('@nktkas/hyperliquid');
  const { privateKeyToAccount } = require('viem/accounts');

  const wallet = privateKeyToAccount(PRIVATE_KEY);
  const transport = new HttpTransport();
  const info = new InfoClient({ transport });
  const exchange = new ExchangeClient({ transport, wallet });

  // Get current positions
  const state = await info.clearinghouseState({ user: WALLET_ADDRESS });
  const meta = await info.meta();
  let closeAttempted = 0;
  let closeFailures = 0;
  let closedCount = 0;

  for (const pos of state.assetPositions) {
    const p = pos.position;
    const size = parseFloat(p.szi);
    if (size === 0) continue;

    const coin = p.coin;
    const asset = meta.universe.find(a => a.name === coin);
    if (!asset) { console.error(`Asset ${coin} not found`); continue; }
    const assetIndex = meta.universe.indexOf(asset);

    // Get current price
    const mids = await info.allMids();
    const midPrice = parseFloat(mids[coin]);

    console.log(`Closing ${coin} position:`);
    console.log(`  Size: ${p.szi} (${size < 0 ? 'SHORT' : 'LONG'})`);
    console.log(`  Entry: $${p.entryPx}`);
    console.log(`  Current mid: $${midPrice.toFixed(2)}`);
    console.log(`  Unrealized PnL: $${p.unrealizedPnl}`);

    // To close: buy if short, sell if long
    const isBuy = size < 0; // buy to cover short
    const absSize = Math.abs(size);
    // Use aggressive price: 1% above mid for buy, 1% below for sell
    const limitPrice = isBuy
      ? (midPrice * 1.01).toFixed(1)
      : (midPrice * 0.99).toFixed(1);

    console.log(`  Action: ${isBuy ? 'BUY' : 'SELL'} ${absSize} ${coin} @ limit $${limitPrice} (IOC, reduce-only)`);

    if (isDryRun) {
      closeAttempted += 1;
      console.log('  [DRY RUN] No order sent');
      continue;
    }

    try {
      closeAttempted += 1;
      // First cancel any existing TP/SL orders
      console.log('  Cancelling existing TP/SL orders...');
      const openOrders = await info.openOrders({ user: WALLET_ADDRESS });
      for (const order of openOrders) {
        if (order.coin === coin) {
          try {
            await exchange.cancel({ cancels: [{ a: assetIndex, o: order.oid }] });
            console.log(`  Cancelled order ${order.oid}`);
          } catch (e) {
            console.log(`  Failed to cancel order ${order.oid}: ${e.message}`);
          }
        }
      }

      // Close the position
      const result = await exchange.order({
        orders: [{
          a: assetIndex,
          b: isBuy,
          p: limitPrice,
          s: absSize.toString(),
          r: true, // reduceOnly
          t: { limit: { tif: 'Ioc' } },
        }],
        grouping: 'na',
      });

      console.log(`  Order result: ${JSON.stringify(result)}`);

      // Verify position is closed
      const newState = await info.clearinghouseState({ user: WALLET_ADDRESS });
      const newPos = newState.assetPositions.find(ap => ap.position.coin === coin);
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

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
