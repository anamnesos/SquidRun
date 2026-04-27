#!/usr/bin/env node
'use strict';

const path = require('path');

const regimeModule = require('../modules/trading/oracle-watch-regime');

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

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

async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const command = parsed.positional[0] || 'apply';
  const statePath = path.resolve(toText(getOption(parsed.options, 'state', regimeModule.DEFAULT_SHARED_SHORT_REGIME_STATE_PATH), regimeModule.DEFAULT_SHARED_SHORT_REGIME_STATE_PATH));
  const rulesPath = path.resolve(toText(getOption(parsed.options, 'rules', regimeModule.DEFAULT_ORACLE_WATCH_RULES_PATH), regimeModule.DEFAULT_ORACLE_WATCH_RULES_PATH));
  const watchStatePath = path.resolve(toText(getOption(parsed.options, 'watch-state', regimeModule.DEFAULT_ORACLE_WATCH_STATE_PATH), regimeModule.DEFAULT_ORACLE_WATCH_STATE_PATH));
  const marketScannerStatePath = path.resolve(toText(getOption(parsed.options, 'market-state', regimeModule.DEFAULT_MARKET_SCANNER_STATE_PATH), regimeModule.DEFAULT_MARKET_SCANNER_STATE_PATH));

  if (command === 'apply') {
    const result = await regimeModule.applySharedShortRegime({
      statePath,
      rulesPath,
      watchStatePath,
      marketScannerStatePath,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'show') {
    const fs = require('fs');
    if (!fs.existsSync(statePath)) {
      console.log(JSON.stringify({ ok: false, reason: 'state_missing', statePath }, null, 2));
      return;
    }
    console.log(fs.readFileSync(statePath, 'utf8'));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  main,
  parseCliArgs,
};
