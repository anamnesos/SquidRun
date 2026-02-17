const path = require('path');
const { WORKSPACE_PATH, resolveCoordPath } = require('../../config');
const { EvidenceLedgerStore } = require('./evidence-ledger-store');

const storeCache = new Map();

function resolveDefaultEvidenceLedgerDbPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(path.join('runtime', 'evidence-ledger.db'), { forWrite: true });
  }
  return path.join(WORKSPACE_PATH, 'runtime', 'evidence-ledger.db');
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
  appendCommsJournalEntry,
  closeCommsJournalStores,
  resolveDefaultEvidenceLedgerDbPath,
};

