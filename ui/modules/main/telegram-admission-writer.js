/**
 * THE DEDICATED ADMISSION WRITER — one connection, one transaction, one lane.
 *
 * =====================================================================
 * WHY A SEPARATE CONNECTION AND NOT A PRAGMA CHANGE
 * =====================================================================
 * The admission state machine promises durability: once a Telegram message is
 * `admitted_owned`, the kernel holds that debt across a crash. In WAL mode that
 * promise resolves to `synchronous=FULL`, which syncs the WAL on every commit.
 * `EvidenceLedgerStore` opens at `synchronous=NORMAL`, which does not.
 *
 * There were two obvious moves and both were wrong. Raising the global default
 * to FULL imposes this lane's durability cost on every unrelated ledger writer.
 * Leaving it at NORMAL makes the admission promise unbackable.
 *
 * So: a THIRD option. Open a connection of our own to the EXACT SAME physical
 * database, set FULL on THAT handle only, and assert it. `PRAGMA synchronous`
 * is per-connection, so unrelated writers keep NORMAL and no blast radius
 * escapes this file.
 *
 * =====================================================================
 * THE BINDING CONSTRAINT
 * =====================================================================
 * EVERY row of an atomic admission transition must be written by THIS ONE
 * connection. A transaction split across two handles is not a transaction: the
 * four-authority rollback silently stops being atomic while every test that
 * checks rows-exist still passes. That is why the canonical kernel primitive is
 * reached through `this.store`, whose `db` IS this handle, rather than through
 * some other store instance that happens to point at the same file.
 *
 * And durability is ASSERTED, never assumed. A pragma we set but never read
 * back is a declaration, and this lane's entire defect history is declarations
 * accepted in place of verified effects.
 */
const fs = require('node:fs');
const path = require('node:path');

const { EvidenceLedgerStore, resolveDefaultDbPath } = require('./evidence-ledger-store');

function fail(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * Resolve to a comparable absolute identity. `realpathSync` matters on this
 * machine specifically: the workspace is reached through a junction, so two
 * different-looking paths are routinely the same file, and a naive string
 * compare would report a false identity mismatch.
 */
function canonicalPath(target) {
  try {
    return fs.realpathSync.native(path.resolve(target)).toLowerCase();
  } catch {
    return path.resolve(target).toLowerCase();
  }
}

/**
 * Read a pragma back off the handle. Drivers disagree about the returned column
 * name (`node:sqlite` and better-sqlite3 differ), so take the first value rather
 * than trusting a key.
 */
function readPragma(db, pragma) {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  if (!row || typeof row !== 'object') return null;
  const direct = row[pragma];
  if (direct !== undefined) return direct;
  const values = Object.values(row);
  return values.length > 0 ? values[0] : null;
}

class TelegramAdmissionWriter {
  constructor(options = {}) {
    this.dbPath = options.dbPath || resolveDefaultDbPath();
    this.sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    this.store = null;
    this.db = null;
    this.opened = false;
  }

  /**
   * Open, harden and VERIFY. Any failure returns structurally rather than
   * throwing, because a caller that cannot get a durable handle must be able to
   * refuse the admission cleanly instead of unwinding through a stack trace.
   */
  open() {
    if (this.opened) return { ok: true, dbPath: this.dbPath, reused: true };

    const store = new EvidenceLedgerStore({ dbPath: this.dbPath, sessionId: this.sessionId });
    const init = store.init();
    if (!init.ok) return fail('writer_open_failed', { reason: init.reason });

    const db = store.db;
    if (!db) return fail('writer_open_failed', { reason: 'no_handle' });

    // OUR handle's durability. The global default is deliberately left alone.
    try {
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec('PRAGMA synchronous=FULL;');
      db.exec('PRAGMA foreign_keys=ON;');
    } catch (err) {
      return fail('writer_pragma_failed', { message: err.message });
    }

    // ASSERT ALL THREE BY READING THEM BACK.
    let journalMode;
    let synchronous;
    let foreignKeys;
    try {
      journalMode = String(readPragma(db, 'journal_mode') || '').toLowerCase();
      synchronous = Number(readPragma(db, 'synchronous'));
      foreignKeys = Number(readPragma(db, 'foreign_keys'));
    } catch (err) {
      return fail('writer_durability_probe_failed', { message: err.message });
    }
    if (journalMode !== 'wal') return fail('writer_not_wal', { journalMode });
    if (synchronous !== 2) return fail('writer_not_full_synchronous', { synchronous });
    if (foreignKeys !== 1) return fail('writer_foreign_keys_off', { foreignKeys });

    // DB IDENTITY. A durable handle onto the wrong file is worse than no handle:
    // it writes a perfect, fully-attested admission into a database nobody reads.
    const identity = this.verifyDatabaseIdentity(db);
    if (!identity.ok) return identity;

    this.store = store;
    this.db = db;
    this.opened = true;
    return {
      ok: true,
      dbPath: this.dbPath,
      journalMode,
      synchronous,
      foreignKeys,
      mainFile: identity.mainFile,
    };
  }

  /** The file this handle is really attached to, per SQLite itself. */
  verifyDatabaseIdentity(handle = this.db) {
    let rows;
    try {
      rows = handle.prepare('PRAGMA database_list').all();
    } catch (err) {
      return fail('writer_identity_probe_failed', { message: err.message });
    }
    const main = (rows || []).find((row) => String(row.name) === 'main');
    if (!main || !main.file) return fail('writer_identity_unknown');
    const actual = canonicalPath(main.file);
    const intended = canonicalPath(this.dbPath);
    if (actual !== intended) {
      return fail('writer_database_identity_mismatch', { actual, intended });
    }
    return { ok: true, mainFile: main.file };
  }

  /**
   * Run `fn` inside ONE `BEGIN IMMEDIATE` transaction on THIS handle.
   *
   * IMMEDIATE rather than deferred: the write lock is taken up front, so two
   * concurrent admissions collide at BEGIN instead of half-way through a
   * multi-authority write.
   *
   * `fn` returning a falsy `ok` rolls back — a refusal reached on the last of
   * the four authorities must not leave the first three committed.
   */
  transaction(fn) {
    if (!this.opened || !this.db) return fail('writer_not_open');
    const db = this.db;
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      return fail('writer_begin_failed', { message: err.message });
    }
    let result;
    try {
      result = fn(db, this.store);
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
      return fail('writer_transaction_threw', { message: err.message });
    }
    if (!result || result.ok !== true) {
      try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
      return result || fail('writer_transaction_no_result');
    }
    try {
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already unwound */ }
      return fail('writer_commit_failed', { message: err.message });
    }
    return result;
  }

  close() {
    if (this.store && typeof this.store.close === 'function') {
      try { this.store.close(); } catch { /* closing is best-effort */ }
    }
    this.store = null;
    this.db = null;
    this.opened = false;
  }
}

module.exports = { TelegramAdmissionWriter, canonicalPath, readPragma };
