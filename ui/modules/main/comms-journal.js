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
  // STRICT callers cannot tell "store unavailable" from "genuinely empty" if
  // both answer []. For proof lookups that difference is everything: an empty
  // result means "never delivered" and sends the message again. Strict mode
  // throws so the caller HOLDS.
  const strict = opts.strict === true;
  const storeResult = resolveStore(opts.dbPath || null);
  if (!storeResult.ok || !storeResult.store) {
    if (strict) throw new Error(`comms journal store unavailable: ${storeResult.reason || 'unknown'}`);
    return [];
  }
  if (typeof storeResult.store.queryCommsJournal !== 'function') {
    if (strict) throw new Error('comms journal store cannot query');
    return [];
  }
  // NON-STRICT BEHAVIOUR IS UNCHANGED: a real query throw propagates exactly as
  // it always did. Swallowing it into [] would have silently altered every
  // legacy caller — a different, unrequested change riding along with this one.
  let rows;
  if (strict) {
    try {
      rows = storeResult.store.queryCommsJournal(filters || {});
    } catch (err) {
      throw new Error(`comms journal query failed: ${err.message}`);
    }
  } else {
    rows = storeResult.store.queryCommsJournal(filters || {});
  }
  if (strict && !Array.isArray(rows)) {
    throw new Error('comms journal query returned a non-array result');
  }
  return rows;
}


/** Test seam: the store-shape branches, without needing a real database. */
function _queryWithStore(store, filters, strict) {
  if (!store) {
    if (strict) throw new Error('comms journal store unavailable');
    return [];
  }
  if (typeof store.queryCommsJournal !== 'function') {
    if (strict) throw new Error('comms journal store cannot query');
    return [];
  }
  let rows;
  if (strict) {
    try {
      rows = store.queryCommsJournal(filters || {});
    } catch (err) {
      throw new Error(`comms journal query failed: ${err.message}`);
    }
  } else {
    rows = store.queryCommsJournal(filters || {});
  }
  if (strict && !Array.isArray(rows)) {
    throw new Error('comms journal query returned a non-array result');
  }
  return rows;
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
  _queryWithStore,
  appendCommsJournalEntry,
  queryCommsJournalEntries,
  closeCommsJournalStores,
  resolveDefaultEvidenceLedgerDbPath,
};
