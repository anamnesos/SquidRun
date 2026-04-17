#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const hyperliquidClient = require('../modules/trading/hyperliquid-client');

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
    options.set(key, true);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

function formatHelpText() {
  return [
    'hm-defi-status.js - Show Hyperliquid account and position status.',
    '',
    'Usage:',
    '  node ui/scripts/hm-defi-status.js',
    '  node ui/scripts/hm-defi-status.js --json',
    '  node ui/scripts/hm-defi-status.js --help',
    '  node ui/scripts/hm-defi-status.js -h',
    '  node ui/scripts/hm-defi-status.js --usage',
  ].join('\n');
}

function resolveWalletAddress(env = process.env) {
  return String(
    env.HYPERLIQUID_WALLET_ADDRESS
    || env.HYPERLIQUID_ADDRESS
    || env.POLYMARKET_FUNDER_ADDRESS
    || ''
  ).trim();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizePosition(position = {}) {
  const raw = position?.raw || position;
  const size = toNumber(raw?.szi ?? position?.size, 0);
  return {
    coin: String(raw?.coin || position?.coin || '').trim().toUpperCase(),
    dex: String(position?.dex || '').trim() || null,
    size,
    side: size < 0 ? 'short' : (size > 0 ? 'long' : 'flat'),
    entryPx: toNumber(raw?.entryPx ?? position?.entryPx, 0),
    unrealizedPnl: toNumber(raw?.unrealizedPnl ?? position?.unrealizedPnl, 0),
    liquidationPx: toNumber(raw?.liquidationPx ?? position?.liquidationPx, 0),
  };
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main(argv = parseCliArgs()) {
  const jsonMode = Boolean(getOption(argv.options, 'json', false));
  if (getOption(argv.options, 'help', false)) {
    console.log(formatHelpText());
    return { ok: true, help: true };
  }

  const walletAddress = resolveWalletAddress(process.env);
  if (!walletAddress) {
    const payload = {
      ok: false,
      checkedAt: new Date().toISOString(),
      error: 'Missing Hyperliquid wallet address (POLYMARKET_FUNDER_ADDRESS / HYPERLIQUID_WALLET_ADDRESS).',
      positions: [],
    };
    if (jsonMode) {
      printJson(payload);
      return;
    }
    throw new Error(payload.error);
  }

  const [account, positions] = await Promise.all([
    hyperliquidClient.getAccountSnapshot({ walletAddress }),
    hyperliquidClient.getOpenPositions({ walletAddress }),
  ]);
  const state = account?.raw || {};
  const normalizedPositions = positions
    .map((position) => normalizePosition(position?.raw || {}))
    .filter((position) => Math.abs(position.size) > 0);

  if (jsonMode) {
    printJson({
      ok: true,
      checkedAt: new Date().toISOString(),
      walletAddress: walletAddress,
      accountValue: toNumber(account?.equity, toNumber(state?.marginSummary?.accountValue, 0)),
      totalMarginUsed: toNumber(state?.marginSummary?.totalMarginUsed, 0),
      withdrawable: toNumber(account?.cash, toNumber(state?.withdrawable, 0)),
      dexAccounts: Array.isArray(state?.dexAccounts) ? state.dexAccounts : [],
      positions: normalizedPositions,
    });
    return;
  }

  console.log('Account value:', toNumber(account?.equity, toNumber(state?.marginSummary?.accountValue, 0)));
  console.log('Total margin used:', toNumber(state?.marginSummary?.totalMarginUsed, 0));
  console.log('Withdrawable:', toNumber(account?.cash, toNumber(state?.withdrawable, 0)));
  if (Array.isArray(state?.dexAccounts) && state.dexAccounts.length > 0) {
    console.log('\nDEX accounts:');
    for (const dexAccount of state.dexAccounts) {
      console.log(
        `  ${String(dexAccount?.label || dexAccount?.dex || 'main')}: accountValue=${toNumber(dexAccount?.accountValue, 0)}, marginUsed=${toNumber(dexAccount?.totalMarginUsed, 0)}, withdrawable=${toNumber(dexAccount?.withdrawable, 0)}`
      );
    }
  }
  console.log('\nPositions:');

  for (const position of normalizedPositions) {
    console.log(`  ${position.dex ? `${position.dex} ` : ''}${position.coin}: size=${position.size}, entry=${position.entryPx}, unrealizedPnl=${position.unrealizedPnl}, liquidationPx=${position.liquidationPx}`);
  }

  if (normalizedPositions.length === 0) {
    console.log('  (no open positions)');
  }
}

main().catch((error) => {
  const argv = parseCliArgs();
  if (getOption(argv.options, 'json', false)) {
    printJson({
      ok: false,
      checkedAt: new Date().toISOString(),
      error: error?.message || String(error),
      positions: [],
    });
    return;
  }
  console.error('Error:', error?.message || String(error));
  process.exitCode = 1;
});

module.exports = {
  parseCliArgs,
  formatHelpText,
  main,
};
