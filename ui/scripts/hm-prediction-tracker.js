#!/usr/bin/env node
'use strict';

/**
 * hm-prediction-tracker.js — Log, score, and review trading predictions.
 *
 * Usage:
 *   node hm-prediction-tracker.js log --coin TON --direction SHORT --price 1.42 --confidence 0.64 --source oracle --setup peak_fade --reasoning "high-beta unwind"
 *   node hm-prediction-tracker.js score          (scores all pending predictions against live prices)
 *   node hm-prediction-tracker.js accuracy       (show accuracy summary)
 *   node hm-prediction-tracker.js tag --id pred-xxx --tag ignored_macro
 *   node hm-prediction-tracker.js list            (show recent predictions)
 */

const tracker = require('../modules/trading/prediction-tracker');

const args = process.argv.slice(2);
const command = args[0] || 'list';

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

async function main() {
  switch (command) {
    case 'log': {
      const pred = tracker.logPrediction({
        coin: getArg('coin') || 'BTC',
        direction: getArg('direction') || 'LONG',
        entryPrice: Number(getArg('price') || 0),
        confidence: Number(getArg('confidence') || 0.6),
        reasoning: getArg('reasoning') || '',
        source: getArg('source') || 'architect',
        setupType: getArg('setup') || 'unknown',
        macroState: getArg('macro') || 'unknown',
      });
      console.log('Prediction logged:', pred.id);
      console.log(`  ${pred.coin} ${pred.direction} @ $${pred.entryPrice} (conf ${pred.confidence})`);
      console.log(`  Source: ${pred.source}, Setup: ${pred.setupType}`);
      break;
    }

    case 'score': {
      // Pull live prices from Hyperliquid
      const https = require('https');
      const prices = await new Promise((resolve) => {
        const data = JSON.stringify({ type: 'metaAndAssetCtxs' });
        const req = https.request(
          { hostname: 'api.hyperliquid.xyz', path: '/info', method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            let b = '';
            res.on('data', (c) => (b += c));
            res.on('end', () => {
              try {
                const j = JSON.parse(b);
                const meta = j[0].universe;
                const ctx = j[1];
                const map = {};
                for (let i = 0; i < meta.length; i++) {
                  map[meta[i].name] = parseFloat(ctx[i].markPx);
                }
                resolve(map);
              } catch {
                resolve({});
              }
            });
          }
        );
        req.write(data);
        req.end();
      });

      const updated = tracker.scorePredictions(prices);
      console.log(`Scored ${updated} check(s) across pending predictions.`);
      break;
    }

    case 'accuracy': {
      const source = getArg('source');
      const setupType = getArg('setup');
      const lastN = getArg('last') ? Number(getArg('last')) : undefined;
      const acc = tracker.getAccuracy({ source, setupType, lastN });
      console.log('=== Prediction Accuracy ===');
      console.log(`Total scored: ${acc.total}`);
      console.log(`Correct: ${acc.correct} (${acc.accuracy}%)`);
      console.log(`Wrong: ${acc.wrong}`);
      if (acc.topMissReasons.length > 0) {
        console.log('Top miss reasons:');
        for (const [tag, count] of acc.topMissReasons) {
          console.log(`  ${tag}: ${count}`);
        }
      }
      break;
    }

    case 'tag': {
      const id = getArg('id');
      const tag = getArg('tag');
      if (!id || !tag) {
        console.log('Usage: node hm-prediction-tracker.js tag --id pred-xxx --tag ignored_macro');
        break;
      }
      const pred = tracker.tagMiss(id, tag);
      if (pred) {
        console.log(`Tagged ${pred.id} with root cause: ${tag}`);
      } else {
        console.log('Prediction not found:', id);
      }
      break;
    }

    case 'list': {
      const log = require('fs').existsSync(tracker.PREDICTIONS_FILE)
        ? JSON.parse(require('fs').readFileSync(tracker.PREDICTIONS_FILE, 'utf8'))
        : { predictions: [] };
      const recent = log.predictions.slice(-10);
      console.log(`=== Last ${recent.length} Predictions ===`);
      for (const p of recent) {
        const checks = Object.entries(p.checks || {}).map(([k, v]) => `${k}:${v.correct ? '✓' : '✗'}(${v.pnlPct}%)`).join(' ');
        console.log(`${p.timestamp.slice(0, 16)} ${p.source.padEnd(10)} ${p.coin.padEnd(8)} ${p.direction.padEnd(6)} @$${p.entryPrice} conf:${p.confidence} ${p.finalResult || 'pending'} ${checks}`);
        if (p.rootCauseTag) console.log(`  → miss tag: ${p.rootCauseTag}`);
      }
      break;
    }

    default:
      console.log('Unknown command:', command);
      console.log('Usage: log | score | accuracy | tag | list');
  }
}

main().catch(console.error);
