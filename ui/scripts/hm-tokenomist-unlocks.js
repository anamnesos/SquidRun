#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const hyperliquidClient = require('../modules/trading/hyperliquid-client');

const DEFAULT_SOURCE_PATH = path.resolve(__dirname, '..', '..', 'tokenomist-current.yml');
const DEFAULT_MAX_HOURS = 48;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatUsdCompact(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric >= 1_000_000_000) return `$${(numeric / 1_000_000_000).toFixed(2)}B`;
  if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(2)}M`;
  if (numeric >= 1_000) return `$${(numeric / 1_000).toFixed(2)}K`;
  return `$${numeric.toFixed(2)}`;
}

function parseCompactUsd(value = '') {
  const match = String(value || '').trim().match(/^\$?([\d,.]+)\s*([KMBT])?$/i);
  if (!match) return null;
  const base = Number.parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const unit = String(match[2] || '').toUpperCase();
  const multiplier = unit === 'T'
    ? 1_000_000_000_000
    : unit === 'B'
      ? 1_000_000_000
      : unit === 'M'
        ? 1_000_000
        : unit === 'K'
          ? 1_000
          : 1;
  return base * multiplier;
}

function parsePercent(value = '') {
  const match = String(value || '').trim().match(/^([\d.]+)%$/);
  if (!match) return null;
  const numeric = Number.parseFloat(match[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseCountdownMs(value = '') {
  const match = String(value || '').match(/(\d+)\s+D\s+(\d+)\s+H\s+(\d+)\s+M\s+(\d+)\s+S/i);
  if (!match) return null;
  const days = Number.parseInt(match[1], 10) || 0;
  const hours = Number.parseInt(match[2], 10) || 0;
  const minutes = Number.parseInt(match[3], 10) || 0;
  const seconds = Number.parseInt(match[4], 10) || 0;
  return (((days * 24) + hours) * 60 * 60 + (minutes * 60) + seconds) * 1000;
}

function parseRowSymbol(rowText = '') {
  const matches = Array.from(String(rowText || '').matchAll(/token\s+([A-Za-z0-9]+)/g));
  if (matches.length === 0) return '';
  return toText(matches[matches.length - 1][1]).toUpperCase();
}

function parseTokenUnlockRows(raw = '', options = {}) {
  const referenceTimeMs = Number.isFinite(Number(options.referenceTimeMs))
    ? Number(options.referenceTimeMs)
    : Date.now();
  const rows = Array.from(String(raw || '').matchAll(/row "([^"]+)"/g)).map((match) => match[1]);
  const parsed = [];

  for (const rowText of rows) {
    const symbol = parseRowSymbol(rowText);
    if (!symbol) continue;
    const unlockMatch = rowText.match(/(\$[\d.,]+(?:[KMBT])?)\s+([\d.]+%)\s+(\d+\s+D\s+\d+\s+H\s+\d+\s+M\s+\d+\s+S)/i);
    if (!unlockMatch) continue;
    const countdownMs = parseCountdownMs(unlockMatch[3]);
    if (!Number.isFinite(countdownMs)) continue;
    const unlockAtMs = referenceTimeMs + countdownMs;
    parsed.push({
      token: symbol,
      ticker: `${symbol}/USD`,
      unlockSizeUsd: parseCompactUsd(unlockMatch[1]),
      unlockSizeText: unlockMatch[1],
      unlockPctSupply: parsePercent(unlockMatch[2]),
      unlockPctSupplyText: unlockMatch[2],
      countdownText: unlockMatch[3],
      unlockAt: new Date(unlockAtMs).toISOString(),
      unlockAtMs,
      recipientType: 'unknown',
      source: 'tokenomist-current.yml',
      rowText,
    });
  }

  const deduped = new Map();
  for (const entry of parsed) {
    const key = `${entry.token}:${entry.unlockAt}`;
    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }
  return Array.from(deduped.values()).sort((left, right) => left.unlockAtMs - right.unlockAtMs);
}

async function runScan(options = {}) {
  const sourcePath = path.resolve(String(options.sourcePath || DEFAULT_SOURCE_PATH));
  const maxHours = Math.max(1, Number.parseInt(options.maxHours || `${DEFAULT_MAX_HOURS}`, 10) || DEFAULT_MAX_HOURS);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const nowMs = now.getTime();
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const marketData = Array.isArray(options.marketData)
    ? options.marketData
    : await hyperliquidClient.getUniverseMarketData(options).catch(() => []);
  const marketByCoin = new Map(
    (Array.isArray(marketData) ? marketData : [])
      .map((entry) => [toText(entry?.coin).toUpperCase(), entry])
      .filter(([coin]) => coin)
  );
  const unlocks = parseTokenUnlockRows(raw, { referenceTimeMs: nowMs })
    .filter((entry) => (entry.unlockAtMs - nowMs) <= (maxHours * 60 * 60 * 1000))
    .map((entry) => {
      const market = marketByCoin.get(entry.token) || null;
      return {
        token: entry.token,
        ticker: entry.ticker,
        unlockAt: entry.unlockAt,
        countdownText: entry.countdownText,
        unlockSizeUsd: entry.unlockSizeUsd,
        unlockSizeText: entry.unlockSizeText,
        unlockPctSupply: entry.unlockPctSupply,
        unlockPctSupplyText: entry.unlockPctSupplyText,
        recipientType: entry.recipientType,
        hyperliquidVolumeUsd24h: toNumber(market?.volumeUsd24h, 0) || null,
        hyperliquidVolumeUsd24hText: formatUsdCompact(market?.volumeUsd24h),
      };
    })
    .filter((entry) => entry.hyperliquidVolumeUsd24h != null);

  return {
    ok: true,
    scannedAt: now.toISOString(),
    sourcePath,
    maxHours,
    unlockCount: unlocks.length,
    unlocks,
  };
}

function formatReport(result = {}) {
  const unlocks = Array.isArray(result.unlocks) ? result.unlocks : [];
  if (unlocks.length === 0) {
    return 'No Hyperliquid-tradeable Tokenomist unlocks in the next 48 hours.';
  }
  return unlocks.map((entry) => (
    `${entry.token} | ${entry.unlockAt} | ${entry.unlockSizeText} | ${entry.recipientType} | ${entry.hyperliquidVolumeUsd24hText || 'n/a'}`
  )).join('\n');
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const parsed = {
    sourcePath: DEFAULT_SOURCE_PATH,
    maxHours: DEFAULT_MAX_HOURS,
    json: false,
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--source' && args.length > 0) {
      parsed.sourcePath = args.shift();
      continue;
    }
    if (token === '--hours' && args.length > 0) {
      parsed.maxHours = args.shift();
      continue;
    }
  }
  return parsed;
}

async function main() {
  const options = parseCliArgs();
  const result = await runScan(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatReport(result));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SOURCE_PATH,
  DEFAULT_MAX_HOURS,
  parseCompactUsd,
  parseCountdownMs,
  parseTokenUnlockRows,
  runScan,
  formatReport,
};
