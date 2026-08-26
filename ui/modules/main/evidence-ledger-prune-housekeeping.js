const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 60 * 1000;

function resolvePruneIntervalMs(env = process.env) {
  return Math.max(
    MIN_INTERVAL_MS,
    Number.parseInt(env.SQUIDRUN_EVIDENCE_LEDGER_PRUNE_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10)
      || DEFAULT_INTERVAL_MS
  );
}

function normalizePayload(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
}

function formatReclaimStatus(reclaim) {
  if (!reclaim?.attempted) return 'skipped';
  if (reclaim.ok === false) return 'failed';
  if (reclaim.incrementalVacuum?.effective === true) return 'incremental_vacuum_effective';
  if (reclaim.walCheckpoint?.ok === true) return 'wal_checkpoint_only';
  return 'attempted_no_effect';
}

function createEvidenceLedgerPruneHousekeeping(options = {}) {
  const executeEvidenceLedgerOperation = options.executeEvidenceLedgerOperation;
  const log = options.log || console;
  const env = options.env || process.env;
  const setIntervalFn = options.setIntervalFn || ((callback, delayMs) => setInterval(callback, delayMs));
  const clearIntervalFn = options.clearIntervalFn || ((timer) => clearInterval(timer));

  return {
    enabled: options.enabled ?? (process.env.NODE_ENV !== 'test' && env.SQUIDRUN_EVIDENCE_LEDGER_PRUNE_ENABLED !== '0'),
    intervalMs: options.intervalMs || resolvePruneIntervalMs(env),
    timer: null,
    inFlight: false,
    promise: null,

    async run(reason = 'timer', payload = {}) {
      if (!this.enabled) {
        return { ok: false, reason: 'disabled' };
      }
      if (this.inFlight) {
        return this.promise || { ok: false, reason: 'in_flight' };
      }
      if (typeof executeEvidenceLedgerOperation !== 'function') {
        return { ok: false, reason: 'missing_executor' };
      }

      const pruneReason = String(reason || 'timer');
      this.inFlight = true;
      this.promise = (async () => {
        try {
          const result = await executeEvidenceLedgerOperation(
            'prune',
            {
              ...normalizePayload(payload),
              reason: pruneReason,
            },
            {
              source: {
                via: 'evidence-ledger-housekeeping',
                role: 'system',
                paneId: null,
              },
            }
          );
          if (result?.ok === false) {
            log.warn?.('EvidenceLedger', `Prune failed (${pruneReason}): ${result.reason || result.error || 'unknown'}`);
          } else {
            log.info?.(
              'EvidenceLedger',
              `Prune complete (${pruneReason}): removed=${result?.removedTotal ?? 'unknown'} reclaim=${formatReclaimStatus(result?.reclaim)}`
            );
          }
          return result;
        } catch (err) {
          log.warn?.('EvidenceLedger', `Prune error (${pruneReason}): ${err.message}`);
          return { ok: false, reason: 'prune_error', error: err.message };
        } finally {
          this.inFlight = false;
          this.promise = null;
        }
      })();

      return this.promise;
    },

    start() {
      this.stop();
      if (!this.enabled) return;
      void this.run('startup');
      this.timer = setIntervalFn(() => {
        void this.run('timer');
      }, this.intervalMs);
      if (typeof this.timer?.unref === 'function') {
        this.timer.unref();
      }
    },

    stop(options = {}) {
      if (this.timer) {
        clearIntervalFn(this.timer);
        this.timer = null;
      }
      if (options.wait === true && this.promise) {
        return this.promise;
      }
      return { ok: true, reason: 'stopped' };
    },
  };
}

module.exports = {
  createEvidenceLedgerPruneHousekeeping,
  formatReclaimStatus,
  resolvePruneIntervalMs,
};
