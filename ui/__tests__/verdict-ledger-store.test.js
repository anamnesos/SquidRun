'use strict';

/**
 * Store contracts (Builder's half of organ #2): the store is dumb, durable,
 * and never eats history to stay green.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../modules/verdict-ledger-store');

describe('verdict ledger store', () => {
  let dir;
  let storePath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-store-'));
    storePath = path.join(dir, 'verdict-ledger.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips records atomically', () => {
    const records = [{ id: 'v-1', statement: 'x' }, { id: 'v-2', statement: 'y' }];
    store.saveRecords(records, { storePath });
    expect(store.loadRecords({ storePath })).toEqual(records);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  test('upsert replaces by id and appends when new', () => {
    store.saveRecords([{ id: 'v-1', v: 1 }], { storePath });
    const replaced = store.upsertRecord({ id: 'v-1', v: 2 }, { storePath });
    expect(replaced.replaced).toBe(true);
    const appended = store.upsertRecord({ id: 'v-9', v: 1 }, { storePath });
    expect(appended.replaced).toBe(false);
    expect(store.loadRecords({ storePath })).toHaveLength(2);
    expect(store.findRecordById('v-1', { storePath }).v).toBe(2);
  });

  test('corrupt store is moved ASIDE, never silently replaced', () => {
    fs.writeFileSync(storePath, '{ not json [', 'utf8');
    const records = store.loadRecords({ storePath });
    expect(records).toEqual([]);
    const aside = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(aside).toHaveLength(1); // history preserved in the aside file
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toContain('not json');
  });

  test('empty store seeds from backfill when one exists', () => {
    const backfillPath = path.join(dir, 'backfill.json');
    fs.writeFileSync(backfillPath, JSON.stringify({ records: [{ id: 'v-b1' }, { id: 'v-b2' }] }), 'utf8');
    const records = store.loadRecords({ storePath, backfillPath });
    expect(records).toHaveLength(2);
    // The seed is DURABLE: the store file now exists on its own.
    expect(JSON.parse(fs.readFileSync(storePath, 'utf8'))).toHaveLength(2);
  });

  test('missing store and missing backfill start empty without error', () => {
    expect(store.loadRecords({ storePath, backfillPath: path.join(dir, 'nope.json') })).toEqual([]);
  });
});
