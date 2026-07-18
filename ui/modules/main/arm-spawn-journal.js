'use strict';

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

  const store = new EvidenceLedgerStore({ dbPath: cacheKey, enabled: true });
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

function unavailable(storeResult) {
  return {
    ok: false,
    status: 'unavailable',
    reason: storeResult.reason || 'store_unavailable',
    dbPath: storeResult.dbPath || null,
  };
}

function recordArmSpawnStarted(input = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return unavailable(storeResult);
  return {
    ...storeResult.store.recordArmSpawnStarted(input, opts),
    dbPath: storeResult.dbPath,
  };
}

function recordArmSpawnLifecycle(input = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return unavailable(storeResult);
  return {
    ...storeResult.store.recordArmSpawnLifecycle(input, opts),
    dbPath: storeResult.dbPath,
  };
}

function recordArmSpawnLivenessProof(input = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return unavailable(storeResult);
  return {
    ...storeResult.store.recordArmSpawnLivenessProof(input, opts),
    dbPath: storeResult.dbPath,
  };
}

function queryArmSpawnSessions(filters = {}, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return [];
  return storeResult.store.queryArmSpawnSessions(filters || {});
}

function getActiveArmSpawnSession(durableAddress, options = {}) {
  const opts = asObject(options);
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) return null;
  return storeResult.store.getActiveArmSpawnSession(durableAddress);
}

function closeArmSpawnJournalStores() {
  for (const { store } of storeCache.values()) {
    try { store.close(); } catch {}
  }
  storeCache.clear();
}

module.exports = {
  recordArmSpawnStarted,
  recordArmSpawnLifecycle,
  recordArmSpawnLivenessProof,
  queryArmSpawnSessions,
  getActiveArmSpawnSession,
  closeArmSpawnJournalStores,
};
