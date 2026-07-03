'use strict';

/**
 * VERDICT LEDGER STORE (Organism Charter S465 — Builder's half of organ #2).
 * Dumb by design: ALL laws (create/resolve/supersede/sweep/credibility) live
 * in verdict-ledger.js pure functions; this module only makes the record
 * array durable. Plain JSON, atomic writes, corruption never silently eaten.
 */

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../config');
const log = require('./logger');

const DEFAULT_STORE_RELATIVE_PATH = path.join('runtime', 'verdict-ledger.json');
const DEFAULT_BACKFILL_RELATIVE_PATH = path.join('coord', 'verdict-ledger-backfill-s465.json');

function resolveStorePath(options = {}) {
  if (options.storePath) return path.resolve(String(options.storePath));
  return resolveCoordPath(DEFAULT_STORE_RELATIVE_PATH, { forWrite: true });
}

/**
 * Load the record array. A corrupt store is backed up aside and reported -
 * never silently replaced (the store must not eat history to stay green).
 */
function loadRecords(options = {}) {
  const storePath = resolveStorePath(options);
  if (!fs.existsSync(storePath)) {
    return seedFromBackfill(storePath, options);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('store root is not an array');
    return parsed;
  } catch (err) {
    const asidePath = `${storePath}.corrupt-${Date.now()}`;
    try { fs.renameSync(storePath, asidePath); } catch { /* rename best-effort */ }
    log.error('VerdictLedger', `Store corrupt (${err.message}) - moved aside to ${asidePath}; starting empty. History is IN THE ASIDE FILE, not lost.`);
    return [];
  }
}

function seedFromBackfill(storePath, options = {}) {
  const backfillPath = options.backfillPath
    ? path.resolve(String(options.backfillPath))
    : resolveCoordPath(DEFAULT_BACKFILL_RELATIVE_PATH, { forWrite: false });
  try {
    if (fs.existsSync(backfillPath)) {
      const parsed = JSON.parse(fs.readFileSync(backfillPath, 'utf8'));
      const records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.records) ? parsed.records : []);
      if (records.length > 0) {
        saveRecords(records, { ...options, storePath });
        log.info('VerdictLedger', `Store seeded from backfill: ${records.length} records (${backfillPath})`);
        return records;
      }
    }
  } catch (err) {
    log.warn('VerdictLedger', `Backfill seed failed (${err.message}) - starting empty`);
  }
  return [];
}

/** Atomic save: tmp file + rename, so a crash mid-write never truncates. */
function saveRecords(records, options = {}) {
  if (!Array.isArray(records)) throw new Error('verdict-ledger-store: records must be an array');
  const storePath = resolveStorePath(options);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(records, null, 1)}\n`, 'utf8');
  fs.renameSync(tmpPath, storePath);
  return { storePath, count: records.length };
}

/**
 * Upsert by id: replace the record if present, append if new. The LAWS of
 * what may replace what (resolution immutability, supersede-not-overwrite)
 * are the pure module's job - callers go through verdict-ledger.js first.
 */
function upsertRecord(record, options = {}) {
  if (!record || typeof record !== 'object' || !record.id) {
    throw new Error('verdict-ledger-store: record with id required');
  }
  const records = loadRecords(options);
  const index = records.findIndex((existing) => existing?.id === record.id);
  if (index >= 0) records[index] = record;
  else records.push(record);
  saveRecords(records, options);
  return { record, total: records.length, replaced: index >= 0 };
}

function findRecordById(id, options = {}) {
  return loadRecords(options).find((record) => record?.id === String(id)) || null;
}

module.exports = {
  loadRecords,
  saveRecords,
  upsertRecord,
  findRecordById,
  resolveStorePath,
};
