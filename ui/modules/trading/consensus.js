/**
 * Consensus Engine — Adversarial multi-model trading consensus.
 *
 * 3 models independently produce signals. A trade only executes
 * when 2-of-3 agree on direction AND the risk engine approves.
 * Dissenting opinions are logged to cognitive memory for learning.
 */

'use strict';

const path = require('path');

/**
 * @typedef {Object} Signal
 * @property {string} ticker
 * @property {'BUY'|'SELL'|'HOLD'} direction
 * @property {number} confidence - 0 to 1
 * @property {string} timeframe - e.g. "1-5 days"
 * @property {string} reasoning
 * @property {string} agent - 'architect' | 'builder' | 'oracle'
 * @property {string} model - e.g. 'claude-opus-4-6', 'gpt-5.4', 'gemini-3.1'
 * @property {number} timestamp
 */

/**
 * @typedef {Object} ConsensusResult
 * @property {string} ticker
 * @property {'BUY'|'SELL'|'HOLD'} decision
 * @property {boolean} consensus - true if 2-of-3 agreed
 * @property {number} agreementCount - 2 or 3
 * @property {number} confidence - average confidence of agreeing signals when consensus exists, else 0
 * @property {number} averageAgreeConfidence - same as confidence, retained for downstream sizing/execution
 * @property {number} averageSignalConfidence - average confidence across all submitted signals
 * @property {Signal[]} agreeing
 * @property {Signal[]} dissenting
 * @property {string} summary
 */

function averageConfidence(signals = []) {
  const values = Array.isArray(signals)
    ? signals
      .map((signal) => Number(signal?.confidence))
      .filter((value) => Number.isFinite(value))
    : [];
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Evaluate consensus from 3 agent signals for a single ticker.
 * @param {Signal[]} signals - 2 or 3 signals, one per agent
 * @returns {ConsensusResult}
 */
function evaluateConsensus(signals) {
  if (!Array.isArray(signals) || signals.length < 2 || signals.length > 3) {
    throw new Error(`Consensus requires 2 or 3 signals, got ${signals?.length}`);
  }

  const ticker = signals[0].ticker;
  if (!signals.every(s => s.ticker === ticker)) {
    throw new Error('All signals must be for the same ticker');
  }

  // Count votes by direction
  const votes = { BUY: [], SELL: [], HOLD: [] };
  for (const signal of signals) {
    const dir = signal.direction?.toUpperCase();
    if (!votes[dir]) {
      votes[dir] = [];
    }
    votes[dir].push(signal);
  }

  // Find majority direction
  let decision = 'HOLD';
  let agreeing = [];
  let dissenting = [];
  let consensus = false;

  for (const [direction, voters] of Object.entries(votes)) {
    if (voters.length >= 2) {
      decision = direction;
      agreeing = voters;
      dissenting = signals.filter(s => s.direction?.toUpperCase() !== direction);
      consensus = true;
      break;
    }
  }

  // No 2-of-3 majority — but HOLD is not a vote AGAINST a direction.
  // HOLD means "no opinion." Only BUY vs SELL is real disagreement.
  if (!consensus) {
    const buyVotes = votes.BUY || [];
    const sellVotes = votes.SELL || [];

    if (sellVotes.length >= 1 && buyVotes.length === 0) {
      // 1+ SELL, 0 BUY, rest HOLD → weak SELL consensus (no opposing view)
      decision = 'SELL';
      agreeing = sellVotes;
      dissenting = signals.filter(s => s.direction?.toUpperCase() !== 'SELL');
      consensus = true;
    } else if (buyVotes.length >= 1 && sellVotes.length === 0) {
      // 1+ BUY, 0 SELL, rest HOLD → weak BUY consensus (no opposing view)
      decision = 'BUY';
      agreeing = buyVotes;
      dissenting = signals.filter(s => s.direction?.toUpperCase() !== 'BUY');
      consensus = true;
    } else {
      // Genuine BUY vs SELL disagreement → real no_consensus
      decision = 'HOLD';
      agreeing = [];
      dissenting = signals;
    }
  }

  const averageAgreeConfidence = consensus ? averageConfidence(agreeing) : 0;
  const averageSignalConfidence = averageConfidence(signals);

  // Build summary
  const agreeNames = agreeing.map(s => s.agent).join(' + ');
  const dissentNames = dissenting.map(s => s.agent).join(' + ');
  let summary;
  if (consensus && agreeing.length === 3) {
    summary = `${ticker}: UNANIMOUS ${decision} — all 3 models agree`;
  } else if (consensus && signals.length === 2 && agreeing.length === 2) {
    summary = `${ticker}: ${decision} — 2-signal real-agent quorum agrees`;
  } else if (consensus) {
    const dissentReason = dissenting[0]?.reasoning || 'no reason given';
    summary = `${ticker}: ${decision} — ${agreeNames} agree, ${dissentNames} dissents (${dissentReason})`;
  } else {
    summary = `${ticker}: HOLD — no consensus (3-way split)`;
  }

  return {
    ticker,
    decision,
    consensus,
    agreementCount: agreeing.length,
    confidence: averageAgreeConfidence,
    averageAgreeConfidence,
    averageSignalConfidence,
    agreeing,
    dissenting,
    summary,
  };
}

/**
 * Evaluate consensus for multiple tickers.
 * @param {Map<string, Signal[]>} signalsByTicker - ticker → [3 signals]
 * @returns {ConsensusResult[]}
 */
function evaluateAll(signalsByTicker) {
  const results = [];
  for (const [ticker, signals] of signalsByTicker) {
    results.push(evaluateConsensus(signals));
  }
  return results;
}

/**
 * Filter consensus results to only actionable trades (BUY or SELL with consensus).
 * @param {ConsensusResult[]} results
 * @returns {ConsensusResult[]}
 */
function actionableOnly(results) {
  return results.filter(r => r.consensus && r.decision !== 'HOLD');
}

module.exports = { evaluateConsensus, evaluateAll, actionableOnly };
