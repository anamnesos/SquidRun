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

function upsertArmRegistryManifest(input = {}, options = {}) {
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
  const result = storeResult.store.upsertArmRegistryManifest(input, opts);
  return { ...result, dbPath: storeResult.dbPath };
}

function getArmRegistryManifest(filters = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return null;
  return storeResult.store.getArmRegistryManifest(filters || {});
}

function queryArmRegistryManifests(filters = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return [];
  return storeResult.store.queryArmRegistries(filters || {});
}

function queryArmRegistryArms(filters = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return [];
  return storeResult.store.queryArmRegistryArms(filters || {});
}

function recordArmCheckinProof(input = {}, options = {}) {
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
  const result = storeResult.store.recordArmCheckinProof(input, opts);
  return { ...result, dbPath: storeResult.dbPath };
}

function queryArmCheckinProofs(filters = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return [];
  return storeResult.store.queryArmCheckinProofs(filters || {});
}

function evaluateArmRegistryReadiness(filters = {}, options = {}) {
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
  const result = storeResult.store.evaluateArmRegistryReadiness(filters || {}, opts);
  return { ...result, dbPath: storeResult.dbPath };
}

function closeArmRegistryStores() {
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
  upsertArmRegistryManifest,
  getArmRegistryManifest,
  queryArmRegistryManifests,
  queryArmRegistryArms,
  recordArmCheckinProof,
  queryArmCheckinProofs,
  evaluateArmRegistryReadiness,
  closeArmRegistryStores,
};
