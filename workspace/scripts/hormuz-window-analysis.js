'use strict';

const fs = require('fs');
const path = require('path');

const { getProjectRoot } = require('../../ui/config');
const hyperliquidClient = require('../../ui/modules/trading/hyperliquid-client');

const DEFAULT_START = '2026-03-28T00:00:00.000Z';
const DEFAULT_NOTIONAL = 200;
const DEFAULT_CONCURRENCY = 10;
const FOUR_HOUR_BARS_FOR_DAY = 6;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(digits));
}

function pctChange(current, baseline) {
  const currentNumber = toNumber(current, NaN);
  const baselineNumber = toNumber(baseline, NaN);
  if (!Number.isFinite(currentNumber) || !Number.isFinite(baselineNumber) || baselineNumber === 0) {
    return null;
  }
  return (currentNumber - baselineNumber) / baselineNumber;
}

function ensureDir(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

async function mapWithConcurrency(items, limit, task) {
  const queue = Array.from(items);
  const results = [];
  const width = Math.max(1, Math.floor(Number(limit) || 1));

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      results.push(await task(item));
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, queue.length || width) }, () => worker()));
  return results;
}

async function withRateLimitRetry(task, options = {}) {
  const maxAttempts = Math.max(1, Math.floor(toNumber(options.maxAttempts, 6)));
  let attempt = 0;
  let delayMs = Math.max(500, Math.floor(toNumber(options.initialDelayMs, 1000)));
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      const message = String(error?.message || '');
      const isRateLimit = message.includes('429') || message.toLowerCase().includes('rate limit');
      if (!isRateLimit || attempt >= maxAttempts) {
        throw error;
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 10000);
    }
  }
  throw new Error('Retry state exhausted unexpectedly.');
}

function normalizeBars(ticker, bars = []) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      ticker,
      timestamp: new Date(Number(bar.t)).toISOString(),
      open: toNumber(bar.o, NaN),
      close: toNumber(bar.c, NaN),
      high: toNumber(bar.h, NaN),
      low: toNumber(bar.l, NaN),
      volume: toNumber(bar.v, NaN),
      tradeCount: toNumber(bar.n, NaN),
    }))
    .filter((bar) => Number.isFinite(Date.parse(bar.timestamp)) && Number.isFinite(bar.close) && bar.close > 0)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
}

async function fetchTickerBars(infoClient, ticker, startMs, endMs) {
  const coin = hyperliquidClient.normalizeCoinSymbol(ticker);
  const bars = await withRateLimitRetry(
    () => infoClient.candleSnapshot({
      coin,
      interval: '4h',
      startTime: startMs,
      endTime: endMs,
    }),
    {
      maxAttempts: 8,
      initialDelayMs: 1200,
    }
  ).catch(() => []);
  return normalizeBars(ticker, bars);
}

function buildFlagEvent(ticker, bars, index, notional) {
  const current = bars[index];
  const previous = bars[index - 1] || null;
  const priorDay = bars[index - FOUR_HOUR_BARS_FOR_DAY] || null;
  if (!current || !previous) return null;

  const change4hPct = pctChange(current.close, previous.close);
  const change24hPct = priorDay ? pctChange(current.close, priorDay.close) : null;
  const flagged4h = Number.isFinite(change4hPct) && change4hPct <= -0.03;
  const flagged24h = Number.isFinite(change24hPct) && change24hPct <= -0.05;
  if (!flagged4h && !flagged24h) return null;

  const exit4hBar = bars[index + 1] || null;
  const exit24hBar = bars[index + FOUR_HOUR_BARS_FOR_DAY] || null;
  const shortReturn4h = exit4hBar ? -pctChange(exit4hBar.close, current.close) : null;
  const shortReturn24h = exit24hBar ? -pctChange(exit24hBar.close, current.close) : null;

  return {
    ticker,
    timestamp: current.timestamp,
    entryPrice: round(current.close, 6),
    change4hPct: change4hPct == null ? null : round(change4hPct, 6),
    change24hPct: change24hPct == null ? null : round(change24hPct, 6),
    triggerWindow: flagged4h && flagged24h ? '4h_and_24h' : (flagged4h ? '4h' : '24h'),
    immediateConsultation: flagged4h,
    architectAlert: true,
    nextConsultationInclusion: true,
    promotedTtlHours: 4,
    exit4hPrice: exit4hBar ? round(exit4hBar.close, 6) : null,
    exit24hPrice: exit24hBar ? round(exit24hBar.close, 6) : null,
    shortReturn4hPct: shortReturn4h == null ? null : round(shortReturn4h, 6),
    shortReturn24hPct: shortReturn24h == null ? null : round(shortReturn24h, 6),
    pnl4hUsd: shortReturn4h == null ? null : round(notional * shortReturn4h, 2),
    pnl24hUsd: shortReturn24h == null ? null : round(notional * shortReturn24h, 2),
  };
}

function analyzeTicker(ticker, bars, notional) {
  if (!Array.isArray(bars) || bars.length < 2) {
    return null;
  }

  const startBar = bars[0];
  const endBar = bars[bars.length - 1];
  const lowestLow = bars.reduce((best, bar) => {
    if (!best || toNumber(bar.low, Infinity) < toNumber(best.low, Infinity)) return bar;
    return best;
  }, null);

  const events = [];
  for (let index = 1; index < bars.length; index += 1) {
    const event = buildFlagEvent(ticker, bars, index, notional);
    if (event) events.push(event);
  }

  const bestShort24h = events
    .filter((event) => Number.isFinite(event.pnl24hUsd))
    .sort((left, right) => toNumber(right.pnl24hUsd, -Infinity) - toNumber(left.pnl24hUsd, -Infinity))[0] || null;

  return {
    ticker,
    bars: bars.length,
    start: {
      timestamp: startBar.timestamp,
      price: round(startBar.close, 6),
    },
    end: {
      timestamp: endBar.timestamp,
      price: round(endBar.close, 6),
    },
    windowReturnPct: round(pctChange(endBar.close, startBar.close), 6),
    troughDropPct: lowestLow ? round(pctChange(lowestLow.low, startBar.close), 6) : null,
    trough: lowestLow ? {
      timestamp: lowestLow.timestamp,
      price: round(lowestLow.low, 6),
    } : null,
    firstFlagEvent: events[0] || null,
    bestShort24h,
    flaggedEvents: events,
  };
}

function buildReport(run) {
  const missed = run.topMissedShorts.map((entry) => (
    `| ${entry.ticker} | ${entry.timestamp} | ${entry.triggerWindow} | ${(entry.change4hPct * 100).toFixed(2)}% | ${entry.change24hPct == null ? 'n/a' : `${(entry.change24hPct * 100).toFixed(2)}%`} | $${entry.entryPrice.toFixed(4)} | ${entry.exit24hPrice == null ? 'n/a' : `$${entry.exit24hPrice.toFixed(4)}`} | ${entry.pnl24hUsd == null ? 'n/a' : `$${entry.pnl24hUsd.toFixed(2)}`} | ${entry.immediateConsultation ? 'yes' : 'no'} |`
  )).join('\n');

  const losers = run.topWindowLosers.map((entry) => (
    `| ${entry.ticker} | $${entry.start.price.toFixed(4)} | $${entry.end.price.toFixed(4)} | ${(entry.windowReturnPct * 100).toFixed(2)}% | ${(entry.troughDropPct * 100).toFixed(2)}% | ${entry.trough?.timestamp || 'n/a'} |`
  )).join('\n');

  return [
    '# Hormuz Crisis Hyperliquid Window Study',
    '',
    `Window: ${run.window.start} to ${run.window.end}`,
    `Universe scanned: ${run.universeCount} tickers`,
    `4h bar coverage: ${run.coveredTickers} tickers`,
    `Short notional assumption: $${run.notional.toFixed(2)}`,
    '',
    '## Top Window Losers',
    '',
    '| Ticker | Start | End | Window Return | Worst Trough From Start | Trough Time |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    losers || '| n/a | n/a | n/a | n/a | n/a | n/a |',
    '',
    '## Missed Scanner-Triggered Short Setups',
    '',
    '| Ticker | First Flag Time | Trigger | 4h Move | 24h Move | Entry | Exit +24h | PnL @ $200 | Immediate Mini-Consult? |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    missed || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |',
    '',
    `Top-5 missed short PnL total @ $200 each: $${run.topFivePnl.toFixed(2)}`,
    '',
    '## Method',
    '',
    '- Hyperliquid perp universe from live `metaAndAssetCtxs`/`allMids` universe membership.',
    '- 4h candles from the official Hyperliquid info endpoint for the full window.',
    '- A mover is treated as scanner-flagged when 4h move <= -3% or 24h move <= -5%, matching the current scanner thresholds.',
    '- `immediateConsultation=yes` means the current daemon would have triggered a mini-consultation because the 4h move magnitude was at least 3%.',
    '- Every flagged mover would also alert Architect on first appearance and be promoted into the consultation basket with a 4-hour TTL under the current code.',
    '',
    '## Limits',
    '',
    '- This is a window study, not venue-grade execution replay.',
    '- PnL is raw move capture on $200 short notional from first flag close to the close 24h later; fees, slippage, and funding carry are not subtracted here.',
    '- If a symbol launched during the window and lacks early bars, it can only be evaluated from its first available 4h candle onward.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const start = new Date(args.start || DEFAULT_START);
  const end = args.end ? new Date(args.end) : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new Error('Invalid analysis window.');
  }

  const notional = Math.max(1, toNumber(args.notional, DEFAULT_NOTIONAL));
  const concurrency = Math.max(1, Math.floor(toNumber(args.concurrency, DEFAULT_CONCURRENCY)));
  const runId = `hormuz-crisis-${Date.now()}`;
  const outputDir = ensureDir(path.join(getProjectRoot(), '.squidrun', 'runtime', 'backtests', runId));

  const infoClient = hyperliquidClient.createInfoClient();
  const universe = await withRateLimitRetry(
    () => hyperliquidClient.getUniverseMarketData({ infoClient }),
    {
      maxAttempts: 8,
      initialDelayMs: 1500,
    }
  );
  const tickers = Array.from(new Set(universe.map((entry) => entry.ticker).filter(Boolean))).sort();
  const startMs = start.getTime();
  const endMs = end.getTime();

  const analyses = (await mapWithConcurrency(tickers, concurrency, async (ticker) => {
    const bars = await fetchTickerBars(infoClient, ticker, startMs, endMs);
    return analyzeTicker(ticker, bars, notional);
  })).filter(Boolean);

  const topWindowLosers = analyses
    .filter((entry) => Number.isFinite(entry.windowReturnPct))
    .sort((left, right) => toNumber(left.windowReturnPct, Infinity) - toNumber(right.windowReturnPct, Infinity))
    .slice(0, 15);

  const topMissedShorts = analyses
    .map((entry) => entry.bestShort24h || entry.firstFlagEvent)
    .filter((entry) => entry && Number.isFinite(entry.pnl24hUsd))
    .sort((left, right) => toNumber(right.pnl24hUsd, -Infinity) - toNumber(left.pnl24hUsd, -Infinity))
    .slice(0, 15);

  const report = {
    runId,
    window: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    generatedAt: new Date().toISOString(),
    notional,
    universeCount: tickers.length,
    coveredTickers: analyses.length,
    topWindowLosers,
    topMissedShorts,
    topFivePnl: round(
      topMissedShorts.slice(0, 5).reduce((sum, entry) => sum + toNumber(entry.pnl24hUsd, 0), 0),
      2
    ) || 0,
    analyses,
  };

  const reportPath = path.join(outputDir, 'report.md');
  const summaryPath = path.join(outputDir, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(reportPath, `${buildReport(report)}\n`);

  process.stdout.write(`${JSON.stringify({
    runId,
    window: report.window,
    universeCount: report.universeCount,
    coveredTickers: report.coveredTickers,
    topFivePnl: report.topFivePnl,
    reportPath,
    summaryPath,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
