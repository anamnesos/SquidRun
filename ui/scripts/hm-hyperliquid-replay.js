'use strict';

const replay = require('../modules/trading/hyperliquid-replay-backtest');

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
  if (!value) return replay.DEFAULT_SYMBOLS;
  return String(value)
    .split(',')
    .map((symbol) => symbol.trim())
    .filter(Boolean);
}

function parseForwardHours(value) {
  if (!value) return replay.DEFAULT_FORWARD_HOURS;
  return String(value)
    .split(',')
    .map((hours) => Math.round(toNumber(hours, 0)))
    .filter((hours) => hours > 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await replay.runHyperliquidHistoricalReplay({
    symbols: parseSymbols(args.symbols),
    start: args.start,
    end: args.end,
    lookbackDays: toNumber(args.days, replay.DEFAULT_LOOKBACK_DAYS),
    stepHours: toNumber(args['step-hours'], replay.DEFAULT_STEP_HOURS),
    entryMode: args['entry-mode'] || replay.DEFAULT_ENTRY_MODE,
    minAgreeConfidence: toNumber(args['min-confidence'], replay.DEFAULT_MIN_AGREE_CONFIDENCE),
    forwardHours: parseForwardHours(args['forward-hours']),
    runtimeDir: args['runtime-dir'],
  });

  process.stdout.write(`${JSON.stringify({
    runId: result.runId,
    window: result.window,
    symbols: result.symbols,
    coverage: result.coverage,
    summary: result.summary,
    artifacts: result.artifacts,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
