'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const { getProjectRoot } = require('../config');
const backtesting = require('../modules/trading/backtesting');

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !String(next).startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseSymbols(value) {
  if (!value) return null;
  return String(value)
    .split(',')
    .map((symbol) => symbol.trim())
    .filter(Boolean);
}

function maybePullData(options = {}) {
  if (options['pull-data'] !== true) return;
  const scriptPath = path.join(getProjectRoot(), 'workspace', 'scripts', 'pull-backtest-data.py');
  execFileSync('python', [scriptPath], {
    cwd: getProjectRoot(),
    stdio: 'inherit',
    windowsHide: true,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  maybePullData(args);

  const runOptions = {
    dataDir: args['data-dir'],
    book: args.book || 'all',
    interval: args.interval || '1h',
    period: args.period || '6mo',
    lookbackBars: toNumber(args.lookback, backtesting.DEFAULT_LOOKBACK_BARS),
    stepBars: toNumber(args.step, backtesting.DEFAULT_STEP_BARS),
    initialEquity: toNumber(args.equity, backtesting.DEFAULT_INITIAL_EQUITY),
    macroRegime: args['macro-regime'] || 'green',
    dynamicMacro: args['dynamic-macro'] === true,
    entryMode: args['entry-mode'] || 'majority',
    minAgreeConfidence: toNumber(args['min-confidence'], 0.72),
    exitMode: args['exit-mode'] || 'baseline',
    profitTakePct: toNumber(args['profit-take'], 0.08),
    trailingStopPct: toNumber(args['trailing-stop'], 0.04),
    maxIdeasPerStep: toNumber(args['max-ideas'], 0),
    crisisActivation: args['crisis-on-red'] === true,
    symbols: parseSymbols(args.symbols),
  };

  const report = args['walk-forward'] === true
    ? await backtesting.runWalkForwardBacktest({
      ...runOptions,
      splitRatio: toNumber(args['split-ratio'], 0.7),
    })
    : await backtesting.runBacktest(runOptions);

  process.stdout.write(`${JSON.stringify(report.summary || report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
