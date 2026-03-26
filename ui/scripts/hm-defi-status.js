#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const WALLET_ADDRESS = process.env.POLYMARKET_FUNDER_ADDRESS;

async function main() {
  const { HttpTransport, InfoClient } = await import('@nktkas/hyperliquid');
  const transport = new HttpTransport();
  const info = new InfoClient({ transport });
  const state = await info.clearinghouseState({ user: WALLET_ADDRESS });

  console.log('Account value:', state.marginSummary.accountValue);
  console.log('Total margin used:', state.marginSummary.totalMarginUsed);
  console.log('Withdrawable:', state.withdrawable);
  console.log('\nPositions:');

  for (const pos of state.assetPositions) {
    const p = pos.position;
    if (parseFloat(p.szi) !== 0) {
      console.log(`  ${p.coin}: size=${p.szi}, entry=${p.entryPx}, unrealizedPnl=${p.unrealizedPnl}, liquidationPx=${p.liquidationPx}`);
    }
  }

  if (state.assetPositions.every(p => parseFloat(p.position.szi) === 0)) {
    console.log('  (no open positions)');
  }
}

main().catch(e => console.error('Error:', e.message));
