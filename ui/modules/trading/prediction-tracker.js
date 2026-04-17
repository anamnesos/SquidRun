'use strict';

const fs = require('fs');
const path = require('path');

const PREDICTIONS_FILE = path.join(__dirname, '..', '..', '..', '.squidrun', 'runtime', 'prediction-log.json');
const CHECK_INTERVALS_MS = [2 * 3600000, 4 * 3600000, 8 * 3600000, 24 * 3600000]; // 2h, 4h, 8h, 24h

function ensureFile() {
  const dir = path.dirname(PREDICTIONS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(PREDICTIONS_FILE)) fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify({ predictions: [] }, null, 2));
}

function readLog() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(PREDICTIONS_FILE, 'utf8'));
  } catch {
    return { predictions: [] };
  }
}

function writeLog(log) {
  ensureFile();
  fs.writeFileSync(PREDICTIONS_FILE, JSON.stringify(log, null, 2));
}

/**
 * Log a new prediction.
 * @param {Object} params
 * @param {string} params.coin - e.g. 'TON'
 * @param {string} params.direction - 'LONG' or 'SHORT'
 * @param {number} params.entryPrice - price at time of call
 * @param {number} params.confidence - 0.55-0.99
 * @param {string} params.reasoning - short explanation
 * @param {string} params.source - 'architect' | 'oracle' | 'james'
 * @param {string} [params.setupType] - 'continuation_long' | 'peak_fade' | 'flush_short' | 'squeeze_long' | 'unlock_trade'
 * @param {string} [params.macroState] - 'risk_on' | 'risk_off' | 'mixed'
 */
function logPrediction({ coin, direction, entryPrice, confidence, reasoning, source, setupType, macroState }) {
  const log = readLog();
  const normalizedDirection = String(direction || '').toUpperCase() || 'HOLD';
  const prediction = {
    id: `pred-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    coin: String(coin).toUpperCase(),
    direction: normalizedDirection,
    entryPrice: Number(entryPrice),
    confidence: Number(confidence),
    reasoning: String(reasoning || ''),
    source: String(source || 'architect'),
    setupType: String(setupType || 'unknown'),
    macroState: String(macroState || 'unknown'),
    checks: {},     // { '2h': { price, pnlPct, correct }, '4h': {...}, ... }
    finalResult: null, // 'correct' | 'wrong' | 'pending'
    rootCauseTag: null, // filled on miss: 'early_short', 'late_chase', 'ignored_macro', etc.
  };
  log.predictions.push(prediction);
  writeLog(log);
  return prediction;
}

/**
 * Score pending predictions against current prices.
 * @param {Object} currentPrices - { 'TON': 1.42, 'ETH': 2300, ... }
 */
function scorePredictions(currentPrices = {}) {
  const log = readLog();
  const now = Date.now();
  let updated = 0;

  for (const pred of log.predictions) {
    if (pred.finalResult && pred.finalResult !== 'pending') continue;
    const predTime = new Date(pred.timestamp).getTime();
    const currentPrice = currentPrices[pred.coin];
    if (!currentPrice) continue;
    const normalizedDirection = String(pred.direction || '').toUpperCase();
    const directional = normalizedDirection === 'LONG' || normalizedDirection === 'SHORT';

    for (const intervalMs of CHECK_INTERVALS_MS) {
      const label = `${intervalMs / 3600000}h`;
      if (pred.checks[label]) continue; // already scored
      if (now - predTime < intervalMs) continue; // not time yet

      if (!directional) {
        pred.checks[label] = {
          price: currentPrice,
          pnlPct: 0,
          correct: null,
          scoredAt: new Date().toISOString(),
          skipped: true,
          reason: 'non_directional',
        };
        updated++;
        continue;
      }

      const pnlPct = normalizedDirection === 'LONG'
        ? ((currentPrice - pred.entryPrice) / pred.entryPrice) * 100
        : ((pred.entryPrice - currentPrice) / pred.entryPrice) * 100;

      pred.checks[label] = {
        price: currentPrice,
        pnlPct: Math.round(pnlPct * 100) / 100,
        correct: pnlPct > 0,
        scoredAt: new Date().toISOString(),
      };
      updated++;
    }

    // Set final result after 24h check
    if (pred.checks['24h']) {
      pred.finalResult = pred.checks['24h'].skipped
        ? 'skipped'
        : (pred.checks['24h'].correct ? 'correct' : 'wrong');
    }
  }

  if (updated > 0) writeLog(log);
  return updated;
}

/**
 * Tag a prediction miss with a root cause.
 * @param {string} predictionId
 * @param {string} tag - 'early_short' | 'late_chase' | 'ignored_macro' | 'wrong_timeframe' | 'crowding_misread' | 'bad_management'
 */
function tagMiss(predictionId, tag) {
  const log = readLog();
  const pred = log.predictions.find(p => p.id === predictionId);
  if (!pred) return null;
  pred.rootCauseTag = tag;
  writeLog(log);
  return pred;
}

/**
 * Get accuracy summary.
 * @param {Object} [options]
 * @param {string} [options.source] - filter by source
 * @param {string} [options.setupType] - filter by setup type
 * @param {number} [options.lastN] - only last N predictions
 */
function getAccuracy(options = {}) {
  const log = readLog();
  const skipped = log.predictions.filter(p => p.finalResult === 'skipped').length;
  let preds = log.predictions.filter(p => p.finalResult && p.finalResult !== 'pending' && p.finalResult !== 'skipped');

  if (options.source) preds = preds.filter(p => p.source === options.source);
  if (options.setupType) preds = preds.filter(p => p.setupType === options.setupType);
  if (options.lastN) preds = preds.slice(-options.lastN);

  const total = preds.length;
  const correct = preds.filter(p => p.finalResult === 'correct').length;
  const wrong = preds.filter(p => p.finalResult === 'wrong').length;

  const byTag = {};
  for (const p of preds.filter(pr => pr.rootCauseTag)) {
    byTag[p.rootCauseTag] = (byTag[p.rootCauseTag] || 0) + 1;
  }

  return {
    total,
    correct,
    wrong,
    skipped,
    accuracy: total > 0 ? Math.round((correct / total) * 100) : 0,
    topMissReasons: Object.entries(byTag).sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

/**
 * Generate macro header for cycle start.
 * @param {Object} params
 * @param {number} params.btcPrice
 * @param {number} [params.btcKeyLevel] - nearest key round number
 * @param {string} params.tapeState - 'risk_on' | 'risk_off' | 'mixed'
 * @param {string} params.eventStatus - 'CLEAR' | 'CAUTION' | 'VETO'
 * @param {string} params.tradingDirection - 'WITH' | 'AGAINST' | 'NEUTRAL'
 */
function macroHeader({ btcPrice, btcKeyLevel, tapeState, eventStatus, tradingDirection, oilPrice, oilPrev }) {
  const oilDelta = oilPrev ? ((oilPrice - oilPrev) / oilPrev * 100).toFixed(1) : '0.0';
  const oilAlert = Math.abs(oilPrice - (oilPrev || oilPrice)) >= 2 ? ' ⚠️ MOVED $2+' : '';
  return [
    `BTC: $${btcPrice} vs key level $${btcKeyLevel || 'N/A'}`,
    `Oil: $${oilPrice} (${oilDelta > 0 ? '+' : ''}${oilDelta}% from last check)${oilAlert}`,
    `Tape: ${tapeState}`,
    `Event: ${eventStatus}`,
    `Direction: trading ${tradingDirection} the tape`,
  ].join('\n');
}

const OIL_STATE_FILE = path.join(path.dirname(PREDICTIONS_FILE), 'oil-monitor.json');

function normalizeOilSource(value) {
  return String(value || '').trim().toLowerCase();
}

function isFallbackOilSource(source = '') {
  const normalized = normalizeOilSource(source);
  return normalized === 'fallback' || normalized.endsWith(':fallback');
}

function checkOilPrice(currentOilPrice, options = {}) {
  let previousState = null;
  let prev = null;
  try {
    previousState = JSON.parse(fs.readFileSync(OIL_STATE_FILE, 'utf8'));
    const numericPrev = Number(previousState?.lastPrice);
    prev = Number.isFinite(numericPrev) && numericPrev > 0 ? numericPrev : null;
  } catch { /* first run */ }

  const delta = Number.isFinite(prev) ? (currentOilPrice - prev) : 0;
  const currentSource = normalizeOilSource(options.source);
  const previousSource = normalizeOilSource(previousState?.source);
  const currentStale = options.stale === true;
  const previousStale = previousState?.stale === true;
  let suppressReason = null;

  if (!Number.isFinite(prev)) {
    suppressReason = 'seed_baseline';
  } else if (!previousSource) {
    suppressReason = 'legacy_baseline_missing_source';
  } else if (currentStale) {
    suppressReason = options.staleReason || 'current_oil_stale';
  } else if (isFallbackOilSource(currentSource)) {
    suppressReason = 'current_oil_fallback';
  } else if (previousStale) {
    suppressReason = previousState?.staleReason || 'previous_oil_stale';
  } else if (isFallbackOilSource(previousSource)) {
    suppressReason = 'previous_oil_fallback';
  }

  const alert = !suppressReason && Math.abs(delta) >= 2;

  fs.writeFileSync(OIL_STATE_FILE, JSON.stringify({
    lastPrice: currentOilPrice,
    lastCheck: new Date().toISOString(),
    prevPrice: Number.isFinite(prev) ? prev : null,
    source: currentSource || null,
    observedAt: options.observedAt || null,
    fetchedAt: options.fetchedAt || null,
    stale: currentStale,
    staleReason: options.staleReason || null,
  }, null, 2));

  return {
    currentPrice: currentOilPrice,
    prevPrice: Number.isFinite(prev) ? prev : null,
    delta,
    alert,
    suppressed: Boolean(suppressReason),
    suppressReason,
    source: currentSource || null,
    stale: currentStale,
  };
}

const EVENT_WATCH_FILE = path.join(path.dirname(PREDICTIONS_FILE), 'event-watch.json');

function getEventWatch() {
  try {
    return JSON.parse(fs.readFileSync(EVENT_WATCH_FILE, 'utf8'));
  } catch {
    return { nextMacro: null, nextCrypto: null, geopoliticalWatch: [], updatedAt: null };
  }
}

function setEventWatch({ nextMacro, nextCrypto, geopoliticalWatch }) {
  const watch = {
    nextMacro: nextMacro || null,
    nextCrypto: nextCrypto || null,
    geopoliticalWatch: Array.isArray(geopoliticalWatch) ? geopoliticalWatch : [],
    updatedAt: new Date().toISOString(),
  };
  const dir = path.dirname(EVENT_WATCH_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(EVENT_WATCH_FILE, JSON.stringify(watch, null, 2));
  return watch;
}

function eventHeader() {
  const w = getEventWatch();
  return [
    `Next macro: ${w.nextMacro || 'None in 24h'}`,
    `Next crypto catalyst: ${w.nextCrypto || 'None flagged'}`,
    `Geopolitical watch: ${w.geopoliticalWatch.length > 0 ? w.geopoliticalWatch.join(', ') : 'None active'}`,
  ].join('\n');
}

module.exports = {
  logPrediction,
  scorePredictions,
  tagMiss,
  getAccuracy,
  macroHeader,
  checkOilPrice,
  eventHeader,
  getEventWatch,
  setEventWatch,
  PREDICTIONS_FILE,
};
