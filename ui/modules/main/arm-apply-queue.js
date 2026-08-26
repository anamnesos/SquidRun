const path = require('path');
const {
  EvidenceLedgerStore,
  resolveDefaultDbPath,
} = require('./evidence-ledger-store');

const storeCache = new Map();

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function resolveStore(dbPath = null) {
  const targetPath = dbPath || resolveDefaultDbPath();
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

function enqueueArmApplyRequest(input = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    return {
      ok: false,
      status: 'unavailable',
      reason: storeResult.reason || 'store_unavailable',
      dbPath: storeResult.dbPath || null,
    };
  }
  const result = storeResult.store.enqueueArmApplyRequest(input, opts);
  return { ...result, dbPath: storeResult.dbPath };
}

function queryArmApplyRequests(filters = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return [];
  return storeResult.store.queryArmApplyRequests(filters || {});
}

function getArmApplyRequest(filters = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return null;
  return storeResult.store.getArmApplyRequest(filters || {});
}

function markArmApplyRequestExecutable(input = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    return {
      ok: false,
      status: 'unavailable',
      reason: storeResult.reason || 'store_unavailable',
      dbPath: storeResult.dbPath || null,
    };
  }
  const result = storeResult.store.markArmApplyRequestExecutable(input, opts);
  return { ...result, dbPath: storeResult.dbPath };
}

function dispatchArmApplyRequest(input = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    return {
      ok: false,
      status: 'unavailable',
      reason: storeResult.reason || 'store_unavailable',
      dbPath: storeResult.dbPath || null,
    };
  }
  const result = storeResult.store.dispatchArmApplyRequest(input, opts);
  return { ...result, dbPath: storeResult.dbPath };
}

function closeArmApplyQueueStores() {
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
  enqueueArmApplyRequest,
  queryArmApplyRequests,
  getArmApplyRequest,
  markArmApplyRequestExecutable,
  dispatchArmApplyRequest,
  closeArmApplyQueueStores,
};
