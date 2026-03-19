'use strict';

/**
 * Circuit Breaker — Continuous position monitor with automatic stop-loss execution.
 *
 * Polls open positions at a configurable interval (default 30s), checks each against:
 *   1. Hard stop-loss: exits if position drops below a fixed % from entry (default 4%)
 *   2. Trailing stop: exits if position drops a % from its high-water mark (default 3%)
 *   3. Flash crash detector: emergency sell-all if portfolio drops >5% in a single pass
 *
 * Uses the same EventEmitter + setInterval pattern as SmartMoneyScanner.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { resolveCoordPath } = require('../../config');

const DEFAULT_STATE_PATH = resolveCoordPath(
  path.join('runtime', 'circuit-breaker-state.json'),
  { forWrite: true }
);

const DEFAULT_POLL_MS = 30_000; // 30 seconds
const DEFAULT_HARD_STOP_PCT = 0.04; // 4% loss from entry → sell
const DEFAULT_TRAILING_STOP_PCT = 0.03; // 3% drop from high-water mark → sell
const DEFAULT_FLASH_CRASH_PCT = 0.05; // 5% portfolio drop in one pass → sell all
const DEFAULT_MIN_POSITION_VALUE_USD = 10; // Skip dust positions below $10
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown per ticker after exit

/**
 * Read persisted state from disk.
 * @param {string} statePath
 * @returns {Object}
 */
function readState(statePath) {
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }
  } catch {
    // Corrupt state file — start fresh
  }
  return {};
}

/**
 * Write state to disk.
 * @param {string} statePath
 * @param {Object} state
 */
function writeState(statePath, state) {
  try {
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal — state will be rebuilt on next pass
  }
}

/**
 * Normalize a ticker for comparison (strip slashes/dashes, uppercase).
 * @param {string} ticker
 * @returns {string}
 */
function normTicker(ticker) {
  return String(ticker || '').replace(/[/\-]/g, '').toUpperCase();
}

class CircuitBreaker extends EventEmitter {
  /**
   * @param {Object} options
   * @param {number} [options.pollMs=30000] - Poll interval in ms
   * @param {number} [options.hardStopPct=0.04] - Hard stop-loss % from entry
   * @param {number} [options.trailingStopPct=0.03] - Trailing stop % from high-water
   * @param {number} [options.flashCrashPct=0.05] - Portfolio-level flash crash threshold
   * @param {number} [options.minPositionValueUsd=10] - Minimum position value to monitor
   * @param {number} [options.cooldownMs=300000] - Cooldown per ticker after exit
   * @param {string} [options.statePath] - Path to persist high-water marks
   * @param {Function} [options.getPositions] - async () => positions[]
   * @param {Function} [options.getSnapshots] - async (symbols) => Map<ticker, snapshot>
   * @param {Function} [options.executeSell] - async (ticker, shares, reason) => result
   * @param {Function} [options.getAccountEquity] - async () => number
   * @param {Object} [options.logger] - Logger with .info(), .warn(), .error()
   * @param {Function} [options.now] - () => number (ms), for testing
   */
  constructor(options = {}) {
    super();
    this.pollMs = Math.max(10_000, Math.floor(Number(options.pollMs) || DEFAULT_POLL_MS));
    this.hardStopPct = Math.max(0.005, Number(options.hardStopPct) || DEFAULT_HARD_STOP_PCT);
    this.trailingStopPct = Math.max(0.005, Number(options.trailingStopPct) || DEFAULT_TRAILING_STOP_PCT);
    this.flashCrashPct = Math.max(0.01, Number(options.flashCrashPct) || DEFAULT_FLASH_CRASH_PCT);
    this.minPositionValueUsd = Math.max(1, Number(options.minPositionValueUsd) || DEFAULT_MIN_POSITION_VALUE_USD);
    this.cooldownMs = Math.max(30_000, Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS);
    this.statePath = options.statePath || DEFAULT_STATE_PATH;

    // Required callbacks
    this.getPositions = options.getPositions || null;
    this.getSnapshots = options.getSnapshots || null;
    this.executeSell = options.executeSell || null;
    this.getAccountEquity = options.getAccountEquity || null;

    this.logger = options.logger || console;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();

    // Internal state
    this.timer = null;
    this.pollPromise = null;
    this.running = false;

    // High-water marks: { [normTicker]: { price: number, updatedAt: string } }
    // Cooldowns: { [normTicker]: number (ms timestamp) }
    // Last equity: for flash crash detection
    const persisted = options.state || readState(this.statePath);
    this.highWaterMarks = persisted.highWaterMarks || {};
    this.cooldowns = persisted.cooldowns || {};
    this.lastEquity = persisted.lastEquity || null;
    this.exits = persisted.exits || [];
    this.passCount = persisted.passCount || 0;
  }

  getState() {
    return {
      highWaterMarks: { ...this.highWaterMarks },
      cooldowns: { ...this.cooldowns },
      lastEquity: this.lastEquity,
      exits: [...this.exits],
      passCount: this.passCount,
    };
  }

  persistState() {
    writeState(this.statePath, this.getState());
  }

  start(options = {}) {
    if (this.running) return this;
    this.running = true;
    if (options.immediate !== false) {
      void this.pollNow({ reason: 'startup' });
    }
    this.timer = setInterval(() => {
      void this.pollNow({ reason: 'interval' });
    }, this.pollMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this;
  }

  async pollNow(options = {}) {
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = this.runMonitorPass(options)
      .finally(() => { this.pollPromise = null; });
    return this.pollPromise;
  }

  /**
   * Core monitoring pass. Checks all open positions against stop rules.
   * @param {Object} [options]
   * @returns {Promise<Object>} Pass result summary
   */
  async runMonitorPass(options = {}) {
    const startedAt = new Date(this.now()).toISOString();
    this.passCount++;

    try {
      if (!this.getPositions || !this.getSnapshots || !this.executeSell) {
        return { ok: false, reason: 'missing_callbacks', startedAt };
      }

      // 1. Fetch open positions
      const positions = await this.getPositions();
      if (!Array.isArray(positions) || positions.length === 0) {
        // Clean up high-water marks for closed positions
        this.highWaterMarks = {};
        this.persistState();
        return { ok: true, positions: 0, checked: 0, exits: 0, startedAt };
      }

      // 2. Filter to meaningful positions
      const meaningful = positions.filter((p) => {
        const value = Math.abs(Number(p.marketValue) || 0);
        return value >= this.minPositionValueUsd;
      });

      if (meaningful.length === 0) {
        return { ok: true, positions: positions.length, checked: 0, exits: 0, reason: 'all_dust', startedAt };
      }

      // 3. Fetch current prices for monitored positions
      const symbols = meaningful.map((p) => p.ticker);
      const snapshots = await this.getSnapshots(symbols);

      // 4. Flash crash check — portfolio-level
      let flashCrashTriggered = false;
      if (this.getAccountEquity) {
        try {
          const currentEquity = await this.getAccountEquity();
          if (this.lastEquity && currentEquity > 0 && this.lastEquity > 0) {
            const drawdown = (this.lastEquity - currentEquity) / this.lastEquity;
            if (drawdown >= this.flashCrashPct) {
              this.logger.warn(
                `[circuit-breaker] FLASH CRASH: equity dropped ${(drawdown * 100).toFixed(1)}% ` +
                `($${this.lastEquity.toFixed(2)} → $${currentEquity.toFixed(2)}). Liquidating all positions.`
              );
              flashCrashTriggered = true;
            }
          }
          this.lastEquity = currentEquity;
        } catch (err) {
          this.logger.warn(`[circuit-breaker] Failed to fetch equity: ${err.message}`);
        }
      }

      // 5. Check each position
      const exitResults = [];
      const now = this.now();

      for (const position of meaningful) {
        const ticker = normTicker(position.ticker);
        const shares = Number(position.shares) || 0;
        const avgPrice = Number(position.avgPrice) || 0;
        if (shares <= 0 || avgPrice <= 0) continue;

        // Check cooldown
        if (this.cooldowns[ticker] && (now - this.cooldowns[ticker]) < this.cooldownMs) {
          continue;
        }

        // Get current price from snapshot
        const snapshot = snapshots instanceof Map ? snapshots.get(position.ticker) : snapshots?.[position.ticker];
        const currentPrice = pickPrice(snapshot);
        if (!currentPrice || currentPrice <= 0) continue;

        // Update high-water mark
        const hwm = this.highWaterMarks[ticker];
        if (!hwm || currentPrice > hwm.price) {
          this.highWaterMarks[ticker] = { price: currentPrice, updatedAt: new Date(now).toISOString() };
        }

        let exitReason = null;

        // Flash crash → immediate exit
        if (flashCrashTriggered) {
          exitReason = 'flash_crash';
        }

        // Hard stop-loss check
        if (!exitReason) {
          const lossPct = (avgPrice - currentPrice) / avgPrice;
          if (lossPct >= this.hardStopPct) {
            exitReason = `hard_stop:${(lossPct * 100).toFixed(1)}%_loss_from_entry`;
          }
        }

        // Trailing stop check
        if (!exitReason && this.highWaterMarks[ticker]) {
          const hwmPrice = this.highWaterMarks[ticker].price;
          const dropFromHwm = (hwmPrice - currentPrice) / hwmPrice;
          if (dropFromHwm >= this.trailingStopPct) {
            exitReason = `trailing_stop:${(dropFromHwm * 100).toFixed(1)}%_drop_from_high_${hwmPrice.toFixed(2)}`;
          }
        }

        if (exitReason) {
          this.logger.warn(
            `[circuit-breaker] EXIT ${position.ticker}: ${exitReason} ` +
            `(entry: $${avgPrice.toFixed(2)}, current: $${currentPrice.toFixed(2)}, shares: ${shares})`
          );

          try {
            const result = await this.executeSell(position.ticker, shares, exitReason);
            const exitRecord = {
              ticker: position.ticker,
              shares,
              avgPrice,
              exitPrice: currentPrice,
              reason: exitReason,
              result: result?.ok ? 'success' : 'failed',
              error: result?.error || null,
              at: new Date(now).toISOString(),
            };
            exitResults.push(exitRecord);
            this.exits.push(exitRecord);

            // Set cooldown
            this.cooldowns[ticker] = now;

            // Clear high-water mark
            delete this.highWaterMarks[ticker];

            this.emit('exit', exitRecord);
          } catch (err) {
            this.logger.error(`[circuit-breaker] Failed to execute exit for ${position.ticker}: ${err.message}`);
            exitResults.push({
              ticker: position.ticker,
              reason: exitReason,
              result: 'error',
              error: err.message,
              at: new Date(now).toISOString(),
            });
          }
        }
      }

      // Trim exit history to last 100
      if (this.exits.length > 100) {
        this.exits = this.exits.slice(-100);
      }

      // Clean up high-water marks for positions we no longer hold
      const heldTickers = new Set(positions.map((p) => normTicker(p.ticker)));
      for (const key of Object.keys(this.highWaterMarks)) {
        if (!heldTickers.has(key)) delete this.highWaterMarks[key];
      }

      // Clean up expired cooldowns
      for (const [key, ts] of Object.entries(this.cooldowns)) {
        if ((now - ts) >= this.cooldownMs) delete this.cooldowns[key];
      }

      this.persistState();

      const result = {
        ok: true,
        positions: positions.length,
        checked: meaningful.length,
        exits: exitResults.length,
        flashCrash: flashCrashTriggered,
        exitDetails: exitResults.length > 0 ? exitResults : undefined,
        startedAt,
      };

      if (exitResults.length > 0) {
        this.emit('exits', exitResults);
      }

      return result;
    } catch (err) {
      this.logger.error(`[circuit-breaker] Monitor pass failed: ${err.message}`);
      return { ok: false, error: err.message, startedAt };
    }
  }
}

/**
 * Pick the best available price from a snapshot.
 * @param {Object} snapshot
 * @returns {number|null}
 */
function pickPrice(snapshot) {
  if (!snapshot) return null;
  const candidates = [
    snapshot.tradePrice,
    snapshot.askPrice,
    snapshot.bidPrice,
    snapshot.minuteClose,
    snapshot.dailyClose,
  ];
  for (const price of candidates) {
    const numeric = Number(price);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
}

module.exports = {
  CircuitBreaker,
  // Exported for testing
  _internals: {
    pickPrice,
    normTicker,
    readState,
    writeState,
    DEFAULT_POLL_MS,
    DEFAULT_HARD_STOP_PCT,
    DEFAULT_TRAILING_STOP_PCT,
    DEFAULT_FLASH_CRASH_PCT,
    DEFAULT_MIN_POSITION_VALUE_USD,
    DEFAULT_COOLDOWN_MS,
  },
};
