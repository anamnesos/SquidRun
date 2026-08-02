const path = require('path');
const { resolveCoordPath } = require('../../config');
const { EvidenceLedgerStore } = require('./evidence-ledger-store');

const storeCache = new Map();

function resolveDefaultEvidenceLedgerDbPath() {
  if (typeof resolveCoordPath !== 'function') {
    throw new Error('resolveCoordPath unavailable; cannot resolve runtime/evidence-ledger.db');
  }
  return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function resolveStore(dbPath = null) {
  const targetPath = dbPath || resolveDefaultEvidenceLedgerDbPath();
  const cacheKey = path.resolve(String(targetPath));
  const cached = storeCache.get(cacheKey);
  if (cached?.store?.isAvailable()) {
    return { ok: true, store: cached.store, dbPath: cacheKey };
  }

  const store = new EvidenceLedgerStore({
    dbPath: cacheKey,
    enabled: true,
  });
  const init = store.init();
  if (!init?.ok) {
    try { store.close(); } catch {}
    return {
      ok: false,
      reason: init?.reason || 'init_failed',
      dbPath: cacheKey,
    };
  }

  storeCache.set(cacheKey, { store });
  return { ok: true, store, dbPath: cacheKey };
}

function appendCommsJournalEntry(entry = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    return {
      ok: false,
      reason: storeResult.reason || 'store_unavailable',
      dbPath: storeResult.dbPath || null,
    };
  }

  const result = storeResult.store.upsertCommsJournal(entry, {
    nowMs: opts.nowMs,
  });
  return {
    ...result,
    dbPath: storeResult.dbPath,
  };
}

/**
 * Atomic claim for one outbound send. Exposed deliberately as its OWN function:
 * inferring a claim from appendCommsJournalEntry's ok would authorize a second
 * HTTP send for a message that is already recorded or already delivered.
 */
function claimCommsSend(entry = {}, options = {}) {
  const storeResult = resolveStore(options.dbPath || null);
  if (!storeResult?.store) {
    return { ok: false, acquired: false, sendAllowed: false, outcome: 'unavailable' };
  }
  if (typeof storeResult.store.claimCommsSend !== 'function') {
    return { ok: false, acquired: false, sendAllowed: false, outcome: 'unsupported' };
  }
  return storeResult.store.claimCommsSend(entry, options);
}

function queryCommsJournalEntries(filters = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    return [];
  }
  if (typeof storeResult.store.queryCommsJournal !== 'function') {
    return [];
  }
  return storeResult.store.queryCommsJournal(filters || {});
}

function closeCommsJournalStores() {
  for (const { store } of storeCache.values()) {
    try {
      store.close();
    } catch {
      // best-effort cleanup
    }
  }
  storeCache.clear();
}

module.exports = {
  claimCommsSend,
  appendCommsJournalEntry,
  queryCommsJournalEntries,
  closeCommsJournalStores,
  resolveDefaultEvidenceLedgerDbPath,
};
