/**
 * S492 Step 3 — the capture-only ledger session contract.
 *
 * TEMP DATABASES ONLY. The live evidence ledger is not a test fixture and
 * nothing here opens it.
 *
 * THE THEME: a terminal proof that could be written by anything is not a proof.
 * Every test below is an attempt to produce a row the successor would believe,
 * through a door other than the one process entitled to write it — the generic
 * memory API, the IPC dispatcher, raw SQL, a second close, a reopen, a delete
 * and a rewrite. The contract holds only if all of them are refused.
 *
 * The canonical encoder here is DELIBERATELY A SECOND IMPLEMENTATION, written
 * out below rather than imported. Everywhere else in this lane a second encoder
 * would be a defect; in a test it is the whole point, because a validator
 * checked with its own encoder can only ever agree with itself.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyTelegramAdmissionSchema,
  applyCaptureOnlySessionSchema,
  verifyInstalledSchema,
  normalizeInstalledSql,
  installedSqlDigest,
  CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS,
  CAPTURE_ONLY_SESSION_TRIGGER_SQL,
  CAPTURE_ONLY_SESSION_HOST_TABLE,
} = require('../modules/main/telegram-admission-store');
const {
  CAPTURE_ONLY_SESSION_MODE,
  TERMINAL_META_SCHEMA,
  TERMINAL_STATUS,
  TERMINAL_REASONS,
  validateTerminalMetaBytes,
} = require('../modules/main/capture-only-session-contract');
const { TelegramAdmissionWriter } = require('../modules/main/telegram-admission-writer');
const { EvidenceLedgerMemory } = require('../modules/main/evidence-ledger-memory');
const {
  executeEvidenceLedgerOperation,
  closeSharedRuntime,
} = require('../modules/ipc/evidence-ledger-runtime');

const tempRoots = [];
const openStores = [];

const NOW = 1_785_800_000_000;

function freshDb() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-only-session-'));
  tempRoots.push(root);
  const writer = new TelegramAdmissionWriter({ dbPath: path.join(root, 'ledger.db') });
  const opened = writer.open();
  if (!opened.ok) throw new Error(`admission writer open failed: ${JSON.stringify(opened)}`);
  openStores.push(writer);
  const applied = applyTelegramAdmissionSchema(writer.db);
  if (!applied.ok) throw new Error(`telegram schema apply failed: ${JSON.stringify(applied)}`);
  return { db: writer.db, writer, root };
}

afterEach(() => {
  while (openStores.length) { try { openStores.pop().close(); } catch { /* already closed */ } }
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

/** An independent canonical encoder. See the header — the duplication is the test. */
function testCanonicalJson(value) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * The minimum store surface the memory API and the shared runtime look for.
 * `close` is a no-op on purpose: the real handle belongs to the admission
 * writer, and the dispatcher's own teardown would otherwise close it early.
 */
function fakeStore(db) {
  return { db, isAvailable: () => true, close() { /* the writer owns this handle */ } };
}

function newSessionId() {
  return `ses_${crypto.randomUUID()}`;
}

function newCaptureId() {
  return `owc1_${crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex')}`;
}

function newFingerprint() {
  return crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');
}

/** The exact terminal document, restated here rather than imported from a builder. */
function terminalMeta({
  sessionId,
  sessionNumber,
  captureId,
  fingerprint,
  overrides = {},
  terminalOverrides = {},
} = {}) {
  const doc = {
    capture: { capabilityFingerprint: fingerprint, id: captureId },
    postcommitReread: { captureId, sessionId },
    schema: TERMINAL_META_SCHEMA,
    secondDiskRevalidation: { capabilityFingerprint: fingerprint },
    session: {
      appGeneration: `app-session-${sessionNumber}`,
      id: sessionId,
      number: sessionNumber,
    },
    terminal: {
      conflict: false,
      contextSnapshotCount: 0,
      degraded: false,
      fallback: false,
      replacement: false,
      retry: false,
      status: TERMINAL_STATUS,
      ...terminalOverrides,
    },
    ...overrides,
  };
  return doc;
}

function insertOpenCaptureSession(db, { sessionId, sessionNumber, startedAtMs = NOW } = {}) {
  db.prepare(`
    INSERT INTO ledger_sessions (
      session_id, session_number, mode, started_at_ms, ended_at_ms,
      summary, stats_json, team_json, meta_json
    ) VALUES (?, ?, ?, ?, NULL, NULL, '{}', '{}', '{}')
  `).run(sessionId, sessionNumber, CAPTURE_ONLY_SESSION_MODE, startedAtMs);
}

function closeCaptureSession(db, { sessionId, metaJson, endedAtMs = NOW + 10 }) {
  // The exact compare-and-set shape the ruling names: id + reserved mode +
  // still-open + still-empty metadata.
  return db.prepare(`
    UPDATE ledger_sessions
    SET ended_at_ms = ?, meta_json = ?
    WHERE session_id = ? AND mode = ? AND ended_at_ms IS NULL AND meta_json = '{}'
  `).run(endedAtMs, metaJson, sessionId, CAPTURE_ONLY_SESSION_MODE);
}

function expectAbort(fn, fragment) {
  let error = null;
  try { fn(); } catch (err) { error = err; }
  expect(error).not.toBeNull();
  expect(String(error.message)).toContain(fragment);
}

// =====================================================================
// SCHEMA INSTALLATION — ONE AUTHORITATIVE DDL, VERIFIED BY FULL SHAPE
// =====================================================================
//
// The previous version of this block tested a sparse-fragment verifier and
// passed. Oracle then broke that verifier by execution: a same-named close
// guard keeping every fragment while dropping the immutability, ordering and
// terminal clauses verified as HEALTHY, and then accepted state the real guard
// refuses. Everything below exists because a green test over a fragment list
// only ever proves the fragment list.

/** The one place a test may state a guard's body: by asking the module for it. */
function authoritativeDdl(name) {
  const sql = CAPTURE_ONLY_SESSION_TRIGGER_SQL[name];
  if (!sql) throw new Error(`no authoritative definition for ${name}`);
  return sql;
}

/** Replace an installed guard with a mutated body, keeping the name. */
function reinstallMutated(db, name, mutate) {
  const mutated = mutate(authoritativeDdl(name));
  expect(mutated).not.toBe(authoritativeDdl(name));
  db.exec(`DROP TRIGGER ${name}`);
  db.exec(mutated);
  return verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
}

describe('capture-only session schema installation', () => {
  test('installs the five guards and verifies them from sqlite_master', () => {
    const { db } = freshDb();
    const applied = applyCaptureOnlySessionSchema(db);
    expect(applied.ok).toBe(true);

    const verified = verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
    expect(verified.ok).toBe(true);

    const installed = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_ledger_writer_capture%' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(installed.sort()).toEqual([...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS].sort());
    expect(CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS).toHaveLength(5);
    expect(CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS)
      .toContain('trg_ledger_writer_capture_session_update_guard');
  });

  test('the exact installed SQL is reread after creation and equals the authoritative definition', () => {
    const { db } = freshDb();
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);

    for (const name of CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS) {
      const row = db
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name = ?')
        .get(name);
      expect(row).toBeTruthy();
      expect(row.type).toBe('trigger');
      expect(row.tbl_name).toBe(CAPTURE_ONLY_SESSION_HOST_TABLE);
      expect(row.name).toBe(name);
      // FULL equality, not inclusion. This is the assertion the fragment list
      // could not make.
      expect(normalizeInstalledSql(row.sql)).toBe(normalizeInstalledSql(authoritativeDdl(name)));
      // SQLite stores the CREATE without `IF NOT EXISTS` and without the
      // terminator, which is why the authoritative text is written in the
      // stored form rather than the typed form.
      expect(row.sql).not.toMatch(/IF\s+NOT\s+EXISTS/i);
    }
  });

  test('a verified shape returns a digest per object, as evidence and not as authority', () => {
    const { db } = freshDb();
    const applied = applyCaptureOnlySessionSchema(db);
    expect(Object.keys(applied.digests).sort())
      .toEqual([...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS].sort());
    for (const name of CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS) {
      const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name);
      expect(applied.digests[name]).toBe(installedSqlDigest(row.sql));
      expect(applied.digests[name]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('re-applying over a healthy install is idempotent and creates nothing new', () => {
    const { db } = freshDb();
    const first = applyCaptureOnlySessionSchema(db);
    expect(first.ok).toBe(true);
    const second = applyCaptureOnlySessionSchema(db);
    expect(second.ok).toBe(true);
    expect(second.digests).toEqual(first.digests);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_ledger_writer_capture%'")
      .get().c;
    expect(count).toBe(5);
  });

  test('refuses to install when the host table is absent instead of throwing raw DDL errors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-only-nohost-'));
    tempRoots.push(root);
    let Database;
    try { ({ DatabaseSync: Database } = require('node:sqlite')); } catch { Database = require('better-sqlite3'); }
    const bare = new Database(path.join(root, 'bare.db'));
    try {
      const applied = applyCaptureOnlySessionSchema(bare);
      expect(applied.ok).toBe(false);
      expect(applied.reason).toBe('capture_only_session_host_absent');
    } finally {
      bare.close();
    }
  });

  test('a same-named but WEAKENED trigger is a mismatch — the exact shape Oracle got past the fragment list', () => {
    const { db } = freshDb();
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);

    // Every fragment the retired verifier asked for is present here: the abort
    // name, `OLD.ended_at_ms IS NOT NULL`, and the terminal status literal. The
    // immutability, ordering and pristine clauses are gone.
    db.exec('DROP TRIGGER trg_ledger_writer_capture_session_close_guard');
    db.exec(`
      CREATE TRIGGER trg_ledger_writer_capture_session_close_guard
      BEFORE UPDATE ON ledger_sessions
      WHEN OLD.mode = 'writer_capture_only'
      BEGIN
        SELECT RAISE(ABORT, 'capture_only_session_close_invalid')
        WHERE OLD.ended_at_ms IS NOT NULL
           OR json_extract(NEW.meta_json, '$.terminal.status') IS NOT 'capture_committed_validated';
      END
    `);

    const verified = verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
    expect(verified.ok).toBe(false);
    expect(verified.reason).toBe('schema_shape_mismatch');
    expect(verified.detail.missing).toContain('trg_ledger_writer_capture_session_close_guard:mismatch');
    expect(verified.detail.allAbsent).toBe(false);
  });

  // EVERY GUARD, EVERY MUTATION CLASS. Not one representative trigger: a
  // verifier that happens to be exact about one object and sloppy about another
  // is exactly the defect this replaces.
  describe.each([...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS])('%s', (name) => {
    test('a removed critical clause is refused', () => {
      const { db } = freshDb();
      expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
      // NAMED PER GUARD, not found by a heuristic. A generic "drop a line"
      // mutator quietly no-ops on the guards whose body does not match its
      // pattern, and a no-op mutation makes this test pass by testing nothing.
      // Each removal below leaves VALID SQL and a materially weaker rule.
      const REMOVALS = {
        trg_ledger_writer_capture_session_insert_guard:
          (sql) => sql.replace("\n     OR NEW.meta_json IS NOT '{}'", ''),
        trg_ledger_writer_capture_session_number_reserved:
          (sql) => sql.replace(' AND session_number = NEW.session_number', ''),
        trg_ledger_writer_capture_session_close_guard:
          (sql) => sql.replace('\n     OR NEW.ended_at_ms < OLD.started_at_ms', ''),
        trg_ledger_writer_capture_session_update_guard:
          (sql) => sql.replace(
            /\(NEW\.mode IS '[^']*' AND OLD\.mode IS NOT '[^']*'\)\n {5}OR /,
            '',
          ),
        trg_ledger_writer_capture_session_no_delete:
          (sql) => sql.replace(/\nWHEN OLD\.mode = '[^']*'/, ''),
      };
      const verified = reinstallMutated(db, name, REMOVALS[name]);
      expect(verified.ok).toBe(false);
      expect(verified.detail.missing).toContain(`${name}:mismatch`);
    });

    test('a changed operator is refused', () => {
      const { db } = freshDb();
      expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
      const verified = reinstallMutated(db, name, (sql) => (sql.includes('IS NOT')
        ? sql.replace('IS NOT', 'IS')
        : sql.replace('=', '<>')));
      expect(verified.ok).toBe(false);
      expect(verified.detail.missing).toContain(`${name}:mismatch`);
    });

    test('a changed literal is refused', () => {
      const { db } = freshDb();
      expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
      const verified = reinstallMutated(db, name, (sql) => sql.replace(
        /RAISE\(ABORT, '([^']+)'\)/,
        (_, reason) => `RAISE(ABORT, '${reason}_mutated')`,
      ));
      expect(verified.ok).toBe(false);
      expect(verified.detail.missing).toContain(`${name}:mismatch`);
    });

    test('the wrong event is refused', () => {
      const { db } = freshDb();
      expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
      const verified = reinstallMutated(db, name, (sql) => sql
        .replace('BEFORE INSERT ON', 'AFTER INSERT ON')
        .replace('BEFORE UPDATE ON', 'AFTER UPDATE ON')
        .replace('BEFORE DELETE ON', 'AFTER DELETE ON'));
      expect(verified.ok).toBe(false);
      expect(verified.detail.missing).toContain(`${name}:mismatch`);
    });

    test('the wrong table is refused, by tbl_name and not by text', () => {
      const { db } = freshDb();
      expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
      db.exec('CREATE TABLE decoy_sessions AS SELECT * FROM ledger_sessions');
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(authoritativeDdl(name).replace(/ON ledger_sessions/, 'ON decoy_sessions'));
      const verified = verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
      expect(verified.ok).toBe(false);
      expect(verified.detail.missing).toContain(`${name}:wrong_table:decoy_sessions`);
    });

    test('a wholly different body under the same name is refused', () => {
      const { db } = freshDb();
      expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(`CREATE TRIGGER ${name} BEFORE UPDATE ON ledger_sessions BEGIN SELECT 1; END`);
      const verified = verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
      expect(verified.ok).toBe(false);
      expect(verified.detail.missing).toContain(`${name}:mismatch`);
    });

    test('an object of the wrong type under the same name is refused', () => {
      const { db } = freshDb();
      expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(`CREATE VIEW ${name} AS SELECT 1 AS x`);
      const verified = verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
      expect(verified.ok).toBe(false);
      expect(verified.detail.missing).toContain(`${name}:wrong_type:view`);
    });

    test('an absent object is absent, not stale — and ONE absent is not all-absent', () => {
      const { db } = freshDb();
      expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
      db.exec(`DROP TRIGGER ${name}`);
      const verified = verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
      expect(verified.ok).toBe(false);
      expect(verified.detail.missing).toContain(`${name}:absent`);
      // THIS ASSERTION USED TO SAY `true`, AND IT WAS CERTIFYING A BUG.
      // Four of the five guards are still installed here. `allAbsent` means
      // every REQUESTED object is absent, not "every defect happens to be an
      // absence" — and a test that demanded the old answer would have held the
      // defect in place through any repair. Oracle found this one; it is fixed
      // here rather than left as a follow-up.
      expect(verified.detail.allAbsent).toBe(false);
    });

    test('a whitespace-only reflow is still the same installed shape', () => {
      const { db } = freshDb();
      expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(authoritativeDdl(name).replace(/\n/g, '\n\t  ').replace(/ /g, '  '));
      const verified = verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
      expect(verified.ok).toBe(true);
    });
  });

  test('normalization loosens layout OUTSIDE quotes and nothing inside them', () => {
    expect(normalizeInstalledSql('a   b\n\t c ')).toBe('a b c');
    // Case and tokens still matter: normalization loosens whitespace only.
    expect(normalizeInstalledSql('SELECT  1')).not.toBe(normalizeInstalledSql('select 1'));
    // Whitespace inside a literal is DATA. Collapsing it would let a changed
    // string literal read as a reformat, which is the one way this function
    // could launder a semantic change into equality.
    expect(normalizeInstalledSql("SELECT   'a  b'")).toBe("SELECT 'a  b'");
    expect(normalizeInstalledSql("SELECT 'a  b'")).not.toBe(normalizeInstalledSql("SELECT 'a b'"));
    // Quoted identifiers too, in all three SQLite spellings.
    expect(normalizeInstalledSql('SELECT  "a  b"')).toBe('SELECT "a  b"');
    expect(normalizeInstalledSql('SELECT  `a  b`')).toBe('SELECT `a  b`');
    expect(normalizeInstalledSql('SELECT  [a  b]')).toBe('SELECT [a  b]');
    // The doubled-quote escape stays inside its own literal.
    expect(normalizeInstalledSql("SELECT  'it''s  here'")).toBe("SELECT 'it''s  here'");
  });

  test('a quoted-literal change is refused even though a whitespace reflow is not', () => {
    const { db } = freshDb();
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
    const name = 'trg_ledger_writer_capture_session_close_guard';
    const verified = reinstallMutated(db, name, (sql) => sql.replace(
      "'$.terminal.contextSnapshotCount'",
      "'$.terminal.contextSnapshot Count'",
    ));
    expect(verified.ok).toBe(false);
    expect(verified.detail.missing).toContain(`${name}:mismatch`);
  });

  test('ALL FIVE guards absent IS all-absent, and any survivor makes it false', () => {
    // The other side of the corrected aggregate, so the repair cannot be
    // satisfied by a predicate that simply always returns false.
    const { db } = freshDb();
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
    for (const name of CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS) db.exec(`DROP TRIGGER ${name}`);
    const all = verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
    expect(all.ok).toBe(false);
    expect(all.detail.allAbsent).toBe(true);

    // One survivor — and a MUTATED one, so it is present-but-untrustworthy
    // rather than healthy. Wrong-type/mismatch objects are PRESENT: they found
    // a real sqlite_master row, which is the opposite of never-written.
    const { db: partial } = freshDb();
    expect(applyCaptureOnlySessionSchema(partial).ok).toBe(true);
    for (const name of CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS) partial.exec(`DROP TRIGGER ${name}`);
    partial.exec(`CREATE VIEW ${CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS[0]} AS SELECT 1 AS x`);
    const survivor = verifyInstalledSchema(partial, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
    expect(survivor.ok).toBe(false);
    expect(survivor.detail.missing).toContain(`${CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS[0]}:wrong_type:view`);
    expect(survivor.detail.allAbsent).toBe(false);
  });

  // ------------------------------------------------------------------
  // THE PUBLISHED AUTHORITY CANNOT BE MOVED FROM OUTSIDE
  // ------------------------------------------------------------------
  //
  // The first version of this module exported the expected definitions as a
  // live `Map`. `const` protects the binding, not the object, so `.set()` on the
  // exported reference replaced a guard's expected body — and the installer then
  // installed the weakened trigger while the verifier called it healthy. That is
  // the retired sparse-fragment defect one layer up: installer and verifier
  // could no longer drift apart, but a caller could move them together.
  //
  // `Object.freeze(map)` is not the repair and is not what was done: freezing a
  // Map leaves `set`/`delete`/`clear` working, because they mutate internal
  // slots rather than properties.
  describe('the published DDL view is immutable and is not the authority', () => {
    const store = require('../modules/main/telegram-admission-store');

    test('the published view is a frozen plain object of strings, with no Map mutators', () => {
      const published = store.CAPTURE_ONLY_SESSION_TRIGGER_SQL;
      expect(published instanceof Map).toBe(false);
      expect(Object.isFrozen(published)).toBe(true);
      expect(published.set).toBeUndefined();
      expect(published.delete).toBeUndefined();
      expect(published.clear).toBeUndefined();
      for (const name of CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS) {
        // Strings are primitives, so freezing the container IS a deep freeze.
        expect(typeof published[name]).toBe('string');
      }
    });

    test.each(['set a key', 'delete a key', 'replace the whole export'])(
      'attempting to %s leaves the installed shape exactly as authoritative',
      (attack) => {
        const name = 'trg_ledger_writer_capture_session_update_guard';
        const original = store.CAPTURE_ONLY_SESSION_TRIGGER_SQL[name];
        const weakened = original.replace(/\n {9}AND session_id IS NOT OLD\.session_id/, '');
        expect(weakened).not.toBe(original);

        const descriptor = Object.getOwnPropertyDescriptor(store, 'CAPTURE_ONLY_SESSION_TRIGGER_SQL');
        try {
          if (attack === 'set a key') {
            try { store.CAPTURE_ONLY_SESSION_TRIGGER_SQL[name] = weakened; } catch { /* frozen throws in strict mode */ }
          } else if (attack === 'delete a key') {
            try { delete store.CAPTURE_ONLY_SESSION_TRIGGER_SQL[name]; } catch { /* frozen */ }
          } else {
            // The strongest version: swap the entire published object for a
            // weakened one. It still cannot reach the authority, because no code
            // inside the module resolves definitions through the export.
            try {
              Object.defineProperty(store, 'CAPTURE_ONLY_SESSION_TRIGGER_SQL', {
                value: Object.freeze({ ...original, [name]: weakened }),
                configurable: true,
                writable: true,
              });
            } catch { /* exports frozen is also an acceptable outcome */ }
          }

          // A fresh install still writes the CANONICAL body...
          const { db } = freshDb();
          expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
          const installed = db
            .prepare('SELECT sql FROM sqlite_master WHERE name = ?')
            .get(name);
          expect(normalizeInstalledSql(installed.sql)).toBe(normalizeInstalledSql(original));
          expect(normalizeInstalledSql(installed.sql)).not.toBe(normalizeInstalledSql(weakened));

          // ...and the weakened trigger is still REFUSED if someone installs it,
          // which is the property the Map mutation destroyed.
          const { db: attacked } = freshDb();
          expect(applyCaptureOnlySessionSchema(attacked).ok).toBe(true);
          attacked.exec(`DROP TRIGGER ${name}`);
          attacked.exec(weakened);
          const verified = verifyInstalledSchema(attacked, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
          expect(verified.ok).toBe(false);
          expect(verified.detail.missing).toContain(`${name}:mismatch`);
        } finally {
          if (descriptor) Object.defineProperty(store, 'CAPTURE_ONLY_SESSION_TRIGGER_SQL', descriptor);
        }
      },
    );

    test('the digests a healthy install reports are unchanged by any of that', () => {
      const { db } = freshDb();
      const applied = applyCaptureOnlySessionSchema(db);
      const baseline = { ...applied.digests };
      try { store.CAPTURE_ONLY_SESSION_TRIGGER_SQL.trg_ledger_writer_capture_session_no_delete = 'x'; } catch { /* frozen */ }
      const { db: after } = freshDb();
      expect(applyCaptureOnlySessionSchema(after).digests).toEqual(baseline);
    });
  });

  test('an unknown requested object is refused rather than answered emptily', () => {
    const { db } = freshDb();
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
    const verified = verifyInstalledSchema(db, ['trg_not_a_thing_here']);
    expect(verified.ok).toBe(false);
    expect(verified.reason).toBe('schema_probe_unknown_objects');
    expect(verified.detail.unknown).toEqual(['trg_not_a_thing_here']);
  });

  test('the authoritative map has no duplicate keys and no SQL comments in its bodies', () => {
    const names = Object.keys(CAPTURE_ONLY_SESSION_TRIGGER_SQL);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
    for (const sql of Object.values(CAPTURE_ONLY_SESSION_TRIGGER_SQL)) {
      // A comment would be stored verbatim in sqlite_master and become part of
      // the compared shape; worse, a `--` comment survives whitespace collapse
      // as a swallowed rest-of-line.
      expect(sql).not.toMatch(/--/);
      expect(sql).not.toMatch(/\/\*/);
    }
  });
});

// =====================================================================
// THE INSERT GUARD — PRISTINE OR NOT BORN
// =====================================================================

describe('capture-only session insert guard', () => {
  let db;
  beforeEach(() => {
    ({ db } = freshDb());
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
  });

  test('accepts one pristine open row', () => {
    const sessionId = newSessionId();
    insertOpenCaptureSession(db, { sessionId, sessionNumber: 5001 });
    const row = db.prepare('SELECT * FROM ledger_sessions WHERE session_id = ?').get(sessionId);
    expect(row.mode).toBe(CAPTURE_ONLY_SESSION_MODE);
    expect(row.ended_at_ms).toBeNull();
    expect(row.meta_json).toBe('{}');
  });

  test.each([
    ['born already ended', { endedAtMs: NOW + 1 }],
    ['born with a summary', { summary: 'anything' }],
    ['born with metadata', { metaJson: '{"schema":"whatever"}' }],
    ['born with stats', { statsJson: '{"a":1}' }],
    ['born with team', { teamJson: '{"a":1}' }],
  ])('refuses a reserved row %s', (_label, opts) => {
    expectAbort(() => {
      db.prepare(`
        INSERT INTO ledger_sessions (
          session_id, session_number, mode, started_at_ms, ended_at_ms,
          summary, stats_json, team_json, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newSessionId(),
        5002,
        CAPTURE_ONLY_SESSION_MODE,
        NOW,
        opts.endedAtMs ?? null,
        opts.summary ?? null,
        opts.statsJson ?? '{}',
        opts.teamJson ?? '{}',
        opts.metaJson ?? '{}'
      );
    }, 'capture_only_session_insert_not_pristine');
  });

  test.each([
    ['a non-ses id', 'not-a-session-id-aaaaaaaaaaaaaaaaaaaaaaa'],
    ['a short id', 'ses_short'],
  ])('refuses %s', (_label, sessionId) => {
    expectAbort(
      () => insertOpenCaptureSession(db, { sessionId, sessionNumber: 5003 }),
      'capture_only_session_insert_not_pristine'
    );
  });

  test('refuses a non-positive session number', () => {
    expectAbort(
      () => insertOpenCaptureSession(db, { sessionId: newSessionId(), sessionNumber: 0 }),
      'capture_only_session_insert_not_pristine'
    );
  });

  test('refuses a number any existing row of any mode already holds', () => {
    db.prepare(`
      INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms, meta_json)
      VALUES ('ses_ordinary_holder', 5004, 'APP', ?, '{}')
    `).run(NOW - 100);

    expectAbort(
      () => insertOpenCaptureSession(db, { sessionId: newSessionId(), sessionNumber: 5004 }),
      'capture_only_session_insert_not_pristine'
    );
  });
});

// =====================================================================
// THE NUMBER RESERVATION — FORWARD, ACROSS EVERY MODE
// =====================================================================

describe('capture-only session number reservation', () => {
  let db;
  beforeEach(() => {
    ({ db } = freshDb());
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
  });

  test('an ordinary later session may not reuse a reserved number', () => {
    insertOpenCaptureSession(db, { sessionId: newSessionId(), sessionNumber: 6001 });
    expectAbort(() => {
      db.prepare(`
        INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms, meta_json)
        VALUES ('ses_later_app', 6001, 'APP', ?, '{}')
      `).run(NOW + 500);
    }, 'capture_only_session_number_reserved');
  });

  test('a second capture-only session may not reuse it either', () => {
    insertOpenCaptureSession(db, { sessionId: newSessionId(), sessionNumber: 6002 });
    expectAbort(
      () => insertOpenCaptureSession(db, { sessionId: newSessionId(), sessionNumber: 6002 }),
      'capture_only_session'
    );
  });

  test('unrelated numbers are unaffected, and historical duplicates still insert', () => {
    insertOpenCaptureSession(db, { sessionId: newSessionId(), sessionNumber: 6003 });
    db.prepare(`
      INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms, meta_json)
      VALUES ('ses_app_a', 6004, 'APP', ?, '{}')
    `).run(NOW);
    // The live ledger already contains duplicate ORDINARY numbers; this contract
    // does not retroactively forbid them, and a unique index would have.
    db.prepare(`
      INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms, meta_json)
      VALUES ('ses_app_b', 6004, 'APP', ?, '{}')
    `).run(NOW + 1);
    const n = db.prepare('SELECT COUNT(*) AS n FROM ledger_sessions WHERE session_number = 6004').get();
    expect(Number(n.n)).toBe(2);
  });
});

// =====================================================================
// THE CLOSE GUARD — ONE TRANSITION, EVER
// =====================================================================

describe('capture-only session close guard', () => {
  let db;
  let sessionId;
  let captureId;
  let fingerprint;
  const sessionNumber = 7001;

  beforeEach(() => {
    ({ db } = freshDb());
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
    sessionId = newSessionId();
    captureId = newCaptureId();
    fingerprint = newFingerprint();
    insertOpenCaptureSession(db, { sessionId, sessionNumber });
  });

  function validMetaJson(extra = {}) {
    return testCanonicalJson(terminalMeta({
      sessionId, sessionNumber, captureId, fingerprint, ...extra,
    }));
  }

  test('accepts exactly one open -> ended transition', () => {
    const result = closeCaptureSession(db, { sessionId, metaJson: validMetaJson() });
    expect(Number(result.changes)).toBe(1);

    const row = db.prepare('SELECT * FROM ledger_sessions WHERE session_id = ?').get(sessionId);
    expect(Number(row.ended_at_ms)).toBe(NOW + 10);
    expect(row.summary).toBeNull();
    expect(row.stats_json).toBe('{}');
    expect(row.team_json).toBe('{}');
  });

  test('the CAS refuses a second close, and the stored terminal is unchanged', () => {
    expect(Number(closeCaptureSession(db, { sessionId, metaJson: validMetaJson() }).changes)).toBe(1);
    const first = db.prepare('SELECT meta_json, ended_at_ms FROM ledger_sessions WHERE session_id = ?').get(sessionId);

    // The compare-and-set matches zero rows, so nothing is rewritten and the
    // trigger is never even reached. Both facts matter: no change AND no abort.
    const second = closeCaptureSession(db, {
      sessionId,
      metaJson: validMetaJson(),
      endedAtMs: NOW + 999,
    });
    expect(Number(second.changes)).toBe(0);

    const after = db.prepare('SELECT meta_json, ended_at_ms FROM ledger_sessions WHERE session_id = ?').get(sessionId);
    expect(after.meta_json).toBe(first.meta_json);
    expect(Number(after.ended_at_ms)).toBe(Number(first.ended_at_ms));
  });

  test('a raw UPDATE that bypasses the CAS is aborted by the trigger', () => {
    expect(Number(closeCaptureSession(db, { sessionId, metaJson: validMetaJson() }).changes)).toBe(1);
    // No `ended_at_ms IS NULL` guard in the statement at all — the DDL is the
    // last line, and this is the test that it is actually holding it.
    expectAbort(() => {
      db.prepare('UPDATE ledger_sessions SET meta_json = ? WHERE session_id = ?')
        .run(validMetaJson(), sessionId);
    }, 'capture_only_session_close_invalid');
  });

  test('reopening an ended reserved session is aborted', () => {
    expect(Number(closeCaptureSession(db, { sessionId, metaJson: validMetaJson() }).changes)).toBe(1);
    expectAbort(() => {
      db.prepare('UPDATE ledger_sessions SET ended_at_ms = NULL WHERE session_id = ?').run(sessionId);
    }, 'capture_only_session_close_invalid');
  });

  test.each([
    ['a changed session number', 'UPDATE ledger_sessions SET ended_at_ms = ?, meta_json = ?, session_number = 7999 WHERE session_id = ?'],
    ['a changed mode', "UPDATE ledger_sessions SET ended_at_ms = ?, meta_json = ?, mode = 'APP' WHERE session_id = ?"],
    ['a changed start time', 'UPDATE ledger_sessions SET ended_at_ms = ?, meta_json = ?, started_at_ms = 1 WHERE session_id = ?'],
    ['an added summary', "UPDATE ledger_sessions SET ended_at_ms = ?, meta_json = ?, summary = 'note' WHERE session_id = ?"],
    ['added stats', `UPDATE ledger_sessions SET ended_at_ms = ?, meta_json = ?, stats_json = '{"a":1}' WHERE session_id = ?`],
    ['added team', `UPDATE ledger_sessions SET ended_at_ms = ?, meta_json = ?, team_json = '{"a":1}' WHERE session_id = ?`],
  ])('refuses a close carrying %s', (_label, sql) => {
    expectAbort(
      () => db.prepare(sql).run(NOW + 10, validMetaJson(), sessionId),
      'capture_only_session_close_invalid'
    );
  });

  test('refuses an end time before the start', () => {
    expectAbort(
      () => closeCaptureSession(db, { sessionId, metaJson: validMetaJson(), endedAtMs: NOW - 1 }),
      'capture_only_session_close_invalid'
    );
  });

  test.each([
    ['unparseable metadata', () => 'not json at all'],
    ['a foreign schema', () => testCanonicalJson({ schema: 'something.else.v1' })],
    ['the wrong terminal status', function wrongStatus() {
      return testCanonicalJson(terminalMeta({
        sessionId, sessionNumber, captureId, fingerprint,
        terminalOverrides: { status: 'capture_committed' },
      }));
    }],
    ['a set retry flag', function retrySet() {
      return testCanonicalJson(terminalMeta({
        sessionId, sessionNumber, captureId, fingerprint,
        terminalOverrides: { retry: true },
      }));
    }],
    ['a set conflict flag', function conflictSet() {
      return testCanonicalJson(terminalMeta({
        sessionId, sessionNumber, captureId, fingerprint,
        terminalOverrides: { conflict: true },
      }));
    }],
    ['a nonzero context count', function contextSet() {
      return testCanonicalJson(terminalMeta({
        sessionId, sessionNumber, captureId, fingerprint,
        terminalOverrides: { contextSnapshotCount: 1 },
      }));
    }],
  ])('refuses a close carrying %s', (_label, build) => {
    expectAbort(
      () => closeCaptureSession(db, { sessionId, metaJson: build() }),
      'capture_only_session_close_invalid'
    );
  });

  test('refuses metadata naming a different session', () => {
    const metaJson = testCanonicalJson(terminalMeta({
      sessionId: newSessionId(), sessionNumber, captureId, fingerprint,
    }));
    expectAbort(
      () => closeCaptureSession(db, { sessionId, metaJson }),
      'capture_only_session_close_invalid'
    );
  });

  test('refuses metadata naming a different session number', () => {
    const metaJson = testCanonicalJson(terminalMeta({
      sessionId, sessionNumber: sessionNumber + 1, captureId, fingerprint,
    }));
    expectAbort(
      () => closeCaptureSession(db, { sessionId, metaJson }),
      'capture_only_session_close_invalid'
    );
  });

  test('an ordinary session is untouched by any of this', () => {
    db.prepare(`
      INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms, meta_json)
      VALUES ('ses_ordinary_close', 7500, 'APP', ?, '{}')
    `).run(NOW);
    const result = db
      .prepare("UPDATE ledger_sessions SET ended_at_ms = ?, summary = 'done' WHERE session_id = 'ses_ordinary_close'")
      .run(NOW + 5);
    expect(Number(result.changes)).toBe(1);
  });
});

// =====================================================================
// THE UPDATE GUARD — THE DOOR THE FIRST FOUR LEFT OPEN
// =====================================================================
//
// Everything above this block keys on a row that is ALREADY reserved, or on a
// row being born. Neither covers the transition in between, and Oracle proved
// by execution that v6 accepted both halves of it: an ordinary row promoted
// into `writer_capture_only` by UPDATE, and an ordinary row renumbered onto a
// reserved number by UPDATE.
//
// Composed they are permanent. Once a second row sits on a reserved number the
// close and no-delete guards make it irreversible, and the successor's
// independent duplicate count then holds forever — correct detection, and a
// fence that can never be created.
//
// PREVENTION AND DETECTION ARE TWO CLAIMS. This block is about prevention: the
// FIRST contaminating statement never lands. The successor's count is a second,
// independent line that would catch contamination if these guards were ever
// absent, and it does not make prevention true.

describe('capture-only session update guard', () => {
  let db;
  const RESERVED = `ses_${'a'.repeat(36)}`;
  const ORDINARY = 'ses_ordinary_update_guard_0000000000000';
  const RESERVED_NUMBER = 7100;
  const ORDINARY_NUMBER = 7101;

  /** Every row, every column, in a stable order — the unchanged-row proof. */
  const snapshot = () => JSON.stringify(
    db.prepare('SELECT * FROM ledger_sessions ORDER BY session_id').all(),
  );

  beforeEach(() => {
    ({ db } = freshDb());
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
    insertOpenCaptureSession(db, { sessionId: RESERVED, sessionNumber: RESERVED_NUMBER });
    db.prepare(`
      INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms)
      VALUES (?, ?, 'PTY', ?)
    `).run(ORDINARY, ORDINARY_NUMBER, NOW);
  });

  test('refuses to promote an ordinary row into the reserved mode', () => {
    const before = snapshot();
    expectAbort(
      () => db.prepare("UPDATE ledger_sessions SET mode = 'writer_capture_only' WHERE session_id = ?").run(ORDINARY),
      'capture_only_session_update_forbidden',
    );
    expect(snapshot()).toBe(before);
  });

  test('refuses to move an ordinary row onto a reserved number', () => {
    const before = snapshot();
    expectAbort(
      () => db.prepare('UPDATE ledger_sessions SET session_number = ? WHERE session_id = ?')
        .run(RESERVED_NUMBER, ORDINARY),
      'capture_only_session_update_forbidden',
    );
    expect(snapshot()).toBe(before);
  });

  test('refuses both changes in one statement, in either written order', () => {
    const before = snapshot();
    expectAbort(
      () => db.prepare("UPDATE ledger_sessions SET mode = 'writer_capture_only', session_number = ? WHERE session_id = ?")
        .run(RESERVED_NUMBER, ORDINARY),
      'capture_only_session_update_forbidden',
    );
    expectAbort(
      () => db.prepare("UPDATE ledger_sessions SET session_number = ?, mode = 'writer_capture_only' WHERE session_id = ?")
        .run(RESERVED_NUMBER, ORDINARY),
      'capture_only_session_update_forbidden',
    );
    expect(snapshot()).toBe(before);
  });

  test('refuses a set-based UPDATE that would sweep every row at once', () => {
    const before = snapshot();
    // WHICH guard aborts depends on which row SQLite reaches first — the
    // ordinary row trips the fifth guard, the reserved row trips the close
    // guard on its null `ended_at_ms`. Asserting one exact name here would be a
    // test that passes on row order, so the assertion is the pair of facts that
    // actually matter: it is refused by name, and nothing moved.
    let error = null;
    try { db.prepare("UPDATE ledger_sessions SET mode = 'writer_capture_only'").run(); } catch (err) { error = err; }
    expect(error).not.toBeNull();
    expect(String(error.message)).toMatch(
      /capture_only_session_update_forbidden|capture_only_session_close_invalid/,
    );
    expect(snapshot()).toBe(before);
  });

  test('THE COMPOSED POISON NEVER LANDS ITS FIRST WRITE, so the reserved number is never ambiguous', () => {
    const before = snapshot();
    // The full sequence Oracle reproduced against v6: promote, then collide.
    expectAbort(
      () => db.prepare("UPDATE ledger_sessions SET mode = 'writer_capture_only' WHERE session_id = ?").run(ORDINARY),
      'capture_only_session_update_forbidden',
    );
    expectAbort(
      () => db.prepare('UPDATE ledger_sessions SET session_number = ? WHERE session_id = ?')
        .run(RESERVED_NUMBER, ORDINARY),
      'capture_only_session_update_forbidden',
    );
    // Prevention, stated as a count and not as a hope: exactly one row holds the
    // reserved number, so the successor's lookup is still a single-row question.
    const holders = db
      .prepare('SELECT COUNT(*) AS c FROM ledger_sessions WHERE session_number = ?')
      .get(RESERVED_NUMBER).c;
    expect(Number(holders)).toBe(1);
    const reservedRows = db
      .prepare("SELECT COUNT(*) AS c FROM ledger_sessions WHERE mode = 'writer_capture_only'")
      .get().c;
    expect(Number(reservedRows)).toBe(1);
    expect(snapshot()).toBe(before);
  });

  test('refuses reserved-row demotion, renumber, reopen and rewrite', () => {
    const before = snapshot();
    for (const [label, run] of [
      ['demotion', () => db.prepare("UPDATE ledger_sessions SET mode = 'PTY' WHERE session_id = ?").run(RESERVED)],
      ['renumber', () => db.prepare('UPDATE ledger_sessions SET session_number = 9999 WHERE session_id = ?').run(RESERVED)],
      ['rewrite', () => db.prepare("UPDATE ledger_sessions SET summary = 'backfilled' WHERE session_id = ?").run(RESERVED)],
      ['start rewrite', () => db.prepare('UPDATE ledger_sessions SET started_at_ms = 1 WHERE session_id = ?').run(RESERVED)],
    ]) {
      let error = null;
      try { run(); } catch (err) { error = err; }
      expect(`${label}:${error === null ? 'ACCEPTED' : 'refused'}`).toBe(`${label}:refused`);
    }
    expect(snapshot()).toBe(before);
  });

  test('refuses to delete either the open reserved row or its number holder', () => {
    const before = snapshot();
    expectAbort(
      () => db.prepare('DELETE FROM ledger_sessions WHERE session_id = ?').run(RESERVED),
      'capture_only_session_delete_forbidden',
    );
    expect(snapshot()).toBe(before);
  });

  // ------------------------------------------------------------------
  // AND THE OTHER HALF: what must STILL work. A guard that also breaks
  // ordinary session bookkeeping is not a narrower guard, it is an outage.
  // ------------------------------------------------------------------

  test('ordinary-to-ordinary updates outside the reserved boundary still succeed', () => {
    const result = db
      .prepare("UPDATE ledger_sessions SET summary = 'done', ended_at_ms = ? WHERE session_id = ?")
      .run(NOW + 5, ORDINARY);
    expect(Number(result.changes)).toBe(1);
    const row = db.prepare('SELECT * FROM ledger_sessions WHERE session_id = ?').get(ORDINARY);
    expect(row.summary).toBe('done');
    expect(Number(row.ended_at_ms)).toBe(NOW + 5);
  });

  test('the historical duplicate-number pattern is untouched, because it never reaches a reserved number', () => {
    // 444-446 each appear twice in the live ledger. Nothing here may make that
    // history unwritable or unrepairable.
    const first = 'ses_historical_duplicate_aaaaaaaaaaaaaaa';
    const second = 'ses_historical_duplicate_bbbbbbbbbbbbbbb';
    db.prepare("INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms) VALUES (?, 444, 'PTY', ?)")
      .run(first, NOW);
    db.prepare("INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms) VALUES (?, 445, 'PTY', ?)")
      .run(second, NOW);
    const result = db
      .prepare('UPDATE ledger_sessions SET session_number = 444 WHERE session_id = ?')
      .run(second);
    expect(Number(result.changes)).toBe(1);
    expect(Number(db.prepare('SELECT COUNT(*) AS c FROM ledger_sessions WHERE session_number = 444').get().c))
      .toBe(2);
  });

  test('the one legitimate reserved write — the close — still passes every guard', () => {
    const meta = testCanonicalJson(terminalMeta({
      sessionId: RESERVED,
      sessionNumber: RESERVED_NUMBER,
      captureId: newCaptureId(),
      fingerprint: newFingerprint(),
    }));
    const result = closeCaptureSession(db, { sessionId: RESERVED, metaJson: meta });
    expect(Number(result.changes)).toBe(1);
    const row = db.prepare('SELECT * FROM ledger_sessions WHERE session_id = ?').get(RESERVED);
    expect(row.meta_json).toBe(meta);

    // And it is still one-shot, proven both ways the second write can arrive.
    // Through the compare-and-set statement the row no longer matches, so the
    // honest result is zero changes and no abort — asserting an abort here
    // would be asserting against the WHERE clause, not against the guard.
    expect(Number(closeCaptureSession(db, { sessionId: RESERVED, metaJson: meta }).changes)).toBe(0);
    // Through a raw UPDATE that ignores the compare-and-set, the guard itself
    // is what refuses.
    expectAbort(
      () => db.prepare('UPDATE ledger_sessions SET ended_at_ms = ?, meta_json = ? WHERE session_id = ?')
        .run(NOW + 20, meta, RESERVED),
      'capture_only_session_close_invalid',
    );
  });

  test('a reserved row keeping its own number is not treated as colliding with itself', () => {
    // The `session_id IS NOT OLD.session_id` term in the fifth guard exists for
    // exactly this: without it the legitimate close finds its own row in the
    // reservation subquery and every close aborts.
    const meta = testCanonicalJson(terminalMeta({
      sessionId: RESERVED,
      sessionNumber: RESERVED_NUMBER,
      captureId: newCaptureId(),
      fingerprint: newFingerprint(),
    }));
    expect(Number(closeCaptureSession(db, { sessionId: RESERVED, metaJson: meta }).changes)).toBe(1);
  });
});

// =====================================================================
// THE DELETE GUARD
// =====================================================================

describe('capture-only session delete guard', () => {
  let db;
  beforeEach(() => {
    ({ db } = freshDb());
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
  });

  test('an OPEN reserved session cannot be deleted — that is the crash case', () => {
    const sessionId = newSessionId();
    insertOpenCaptureSession(db, { sessionId, sessionNumber: 8001 });
    expectAbort(
      () => db.prepare('DELETE FROM ledger_sessions WHERE session_id = ?').run(sessionId),
      'capture_only_session_delete_forbidden'
    );
  });

  test('an ENDED reserved session cannot be deleted either', () => {
    const sessionId = newSessionId();
    const captureId = newCaptureId();
    const fingerprint = newFingerprint();
    insertOpenCaptureSession(db, { sessionId, sessionNumber: 8002 });
    closeCaptureSession(db, {
      sessionId,
      metaJson: testCanonicalJson(terminalMeta({
        sessionId, sessionNumber: 8002, captureId, fingerprint,
      })),
    });
    expectAbort(
      () => db.prepare('DELETE FROM ledger_sessions WHERE session_id = ?').run(sessionId),
      'capture_only_session_delete_forbidden'
    );
  });

  test('ordinary sessions remain deletable', () => {
    db.prepare(`
      INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms, meta_json)
      VALUES ('ses_ordinary_del', 8003, 'APP', ?, '{}')
    `).run(NOW);
    const result = db.prepare("DELETE FROM ledger_sessions WHERE session_id = 'ses_ordinary_del'").run();
    expect(Number(result.changes)).toBe(1);
  });
});

// =====================================================================
// THE GENERIC API AND IPC GATES — TWO MORE DOORS, BOTH LOCKED
// =====================================================================

describe('generic session API refuses the reserved mode', () => {
  let db;
  let memory;

  beforeEach(() => {
    ({ db } = freshDb());
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
    memory = new EvidenceLedgerMemory(fakeStore(db));
  });

  test('recordSessionStart refuses the reserved mode outright', () => {
    const result = memory.recordSessionStart({
      sessionNumber: 9001,
      mode: CAPTURE_ONLY_SESSION_MODE,
      sessionId: newSessionId(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session_mode_reserved');
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM ledger_sessions WHERE mode = ?')
      .get(CAPTURE_ONLY_SESSION_MODE);
    expect(Number(count.n)).toBe(0);
  });

  test('recordSessionStart still works for ordinary modes', () => {
    const result = memory.recordSessionStart({ sessionNumber: 9002, mode: 'APP' });
    expect(result.ok).toBe(true);
  });

  test('recordSessionEnd refuses on the STORED mode, which no caller supplies', () => {
    const sessionId = newSessionId();
    insertOpenCaptureSession(db, { sessionId, sessionNumber: 9003 });

    const result = memory.recordSessionEnd(sessionId, { summary: 'forged terminal' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session_mode_reserved');

    const row = db.prepare('SELECT * FROM ledger_sessions WHERE session_id = ?').get(sessionId);
    expect(row.ended_at_ms).toBeNull();
    expect(row.meta_json).toBe('{}');
    expect(row.summary).toBeNull();
  });

  test('recordSessionEnd still closes ordinary sessions', () => {
    const started = memory.recordSessionStart({ sessionNumber: 9004, mode: 'APP' });
    expect(started.ok).toBe(true);
    expect(memory.recordSessionEnd(started.sessionId, { summary: 'done' }).ok).toBe(true);
  });
});

describe('evidence-ledger IPC dispatcher refuses the reserved mode at its own boundary', () => {
  let db;
  let memory;
  let store;

  beforeEach(() => {
    ({ db } = freshDb());
    expect(applyCaptureOnlySessionSchema(db).ok).toBe(true);
    store = fakeStore(db);
    memory = new EvidenceLedgerMemory(store);
  });

  afterEach(() => { closeSharedRuntime(); });

  /**
   * THE REAL DISPATCHER, over a planted runtime. The gate under test is inside
   * `executeEvidenceLedgerOperation`, so anything that reimplemented the switch
   * here would test the test.
   */
  function dispatch(operation, payload) {
    return executeEvidenceLedgerOperation(operation, payload, {
      deps: {
        createEvidenceLedgerRuntime: () => ({ memory, store, investigator: null }),
        forceRuntimeRecreate: true,
        recreateUnavailable: false,
      },
    });
  }

  test('record-session-start with the reserved mode is refused before memory is called', () => {
    const spy = jest.spyOn(memory, 'recordSessionStart');
    const result = dispatch('record-session-start', {
      sessionNumber: 9101,
      mode: CAPTURE_ONLY_SESSION_MODE,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session_mode_reserved');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('surrounding whitespace does not smuggle the reserved mode through', () => {
    const result = dispatch('record-session-start', {
      sessionNumber: 9102,
      mode: `  ${CAPTURE_ONLY_SESSION_MODE}  `,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session_mode_reserved');
  });

  test('record-session-end against a stored reserved row is refused before memory is called', () => {
    const sessionId = newSessionId();
    insertOpenCaptureSession(db, { sessionId, sessionNumber: 9103 });
    const spy = jest.spyOn(memory, 'recordSessionEnd');

    const result = dispatch('record-session-end', { sessionId, summary: 'forged' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session_mode_reserved');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    const row = db.prepare('SELECT * FROM ledger_sessions WHERE session_id = ?').get(sessionId);
    expect(row.ended_at_ms).toBeNull();
  });

  test('ordinary sessions still round-trip through the dispatcher', () => {
    const started = dispatch('record-session-start', { sessionNumber: 9104, mode: 'APP' });
    expect(started.ok).toBe(true);
    expect(dispatch('record-session-end', { sessionId: started.sessionId }).ok).toBe(true);
  });
});

// =====================================================================
// THE TERMINAL DOCUMENT VALIDATOR
// =====================================================================

describe('terminal metadata validation', () => {
  const sessionId = 'ses_00000000-0000-4000-8000-000000000000';
  const sessionNumber = 494;
  const captureId = `owc1_${'a'.repeat(64)}`;
  const fingerprint = 'b'.repeat(64);

  function valid(extra = {}) {
    return terminalMeta({ sessionId, sessionNumber, captureId, fingerprint, ...extra });
  }

  test('accepts the exact canonical document', () => {
    const result = validateTerminalMetaBytes(testCanonicalJson(valid()));
    expect(result.ok).toBe(true);
    expect(result.meta.session.number).toBe(sessionNumber);
  });

  test('refuses non-canonical bytes with identical content', () => {
    // THE SAME DOCUMENT, BUILT IN THE WRONG ORDER. Every field is correct, the
    // parsed object is deep-equal to the accepted one, and the bytes are not the
    // bytes — which is the entire difference between "a terminal proof" and "a
    // terminal proof with more than one spelling". Built key-by-key rather than
    // by reversing an object literal, because the canonical builder above
    // already emits sorted keys and `JSON.stringify` over it would agree.
    const source = valid();
    const noncanonical = JSON.stringify({
      terminal: source.terminal,
      session: source.session,
      secondDiskRevalidation: source.secondDiskRevalidation,
      schema: source.schema,
      postcommitReread: source.postcommitReread,
      capture: source.capture,
    });
    expect(JSON.parse(noncanonical)).toEqual(JSON.parse(testCanonicalJson(valid())));
    expect(noncanonical).not.toBe(testCanonicalJson(valid()));
    const result = validateTerminalMetaBytes(noncanonical);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.META_NONCANONICAL);
  });

  test('refuses an extra top-level key, which is where a conflicting history would hide', () => {
    const result = validateTerminalMetaBytes(testCanonicalJson({
      ...valid(),
      detail: { priorAttempt: 'redacted' },
    }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.META_SHAPE);
  });

  test('refuses an extra nested key', () => {
    const doc = valid();
    doc.terminal.note = 'harmless';
    const result = validateTerminalMetaBytes(testCanonicalJson(doc));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.META_SHAPE);
  });

  test.each([
    ['unparseable', 'not json', TERMINAL_REASONS.META_UNPARSEABLE],
    ['empty', '', TERMINAL_REASONS.META_UNPARSEABLE],
    ['an array', '[]', TERMINAL_REASONS.META_SHAPE],
  ])('refuses %s metadata', (_label, bytes, reason) => {
    const result = validateTerminalMetaBytes(bytes);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(reason);
  });

  test('refuses the wrong schema name', () => {
    const result = validateTerminalMetaBytes(testCanonicalJson(valid({
      overrides: { schema: 'squidrun.telegram_writer_capture.session_terminal.v2' },
    })));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.META_SCHEMA_WRONG);
  });

  test('refuses the wrong terminal status', () => {
    const result = validateTerminalMetaBytes(testCanonicalJson(valid({
      terminalOverrides: { status: 'capture_committed' },
    })));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.TERMINAL_STATUS_WRONG);
  });

  test.each([['conflict'], ['degraded'], ['fallback'], ['replacement'], ['retry']])(
    'refuses a set %s flag',
    (key) => {
      const result = validateTerminalMetaBytes(testCanonicalJson(valid({
        terminalOverrides: { [key]: true },
      })));
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(TERMINAL_REASONS.TERMINAL_FLAGS_SET);
      expect(result.detail.set).toEqual([key]);
    }
  );

  test('refuses a falsy-but-not-false flag, because 0 is not a recorded negative', () => {
    const result = validateTerminalMetaBytes(testCanonicalJson(valid({
      terminalOverrides: { degraded: 0 },
    })));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.TERMINAL_FLAGS_SET);
  });

  test('refuses a nonzero context snapshot claim', () => {
    const result = validateTerminalMetaBytes(testCanonicalJson(valid({
      terminalOverrides: { contextSnapshotCount: 2 },
    })));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.TERMINAL_FLAGS_SET);
  });

  test('refuses a session id that is not a real randomUUID v4', () => {
    // The store's ordinary `generateId('ses')` fallback shape. It is a perfectly
    // good id and it is not the one the ruling requires.
    const doc = valid();
    doc.session.id = 'ses_1785800000000-a1b2c3d4';
    doc.postcommitReread.sessionId = doc.session.id;
    const result = validateTerminalMetaBytes(testCanonicalJson(doc));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.META_SHAPE);
  });

  test('refuses an upper-case UUID', () => {
    const doc = valid();
    doc.session.id = 'ses_00000000-0000-4000-8000-00000000000A';
    doc.postcommitReread.sessionId = doc.session.id;
    const result = validateTerminalMetaBytes(testCanonicalJson(doc));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.META_SHAPE);
  });

  test('refuses an internally inconsistent document', () => {
    const doc = valid();
    doc.postcommitReread.captureId = `owc1_${'c'.repeat(64)}`;
    const result = validateTerminalMetaBytes(testCanonicalJson(doc));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(TERMINAL_REASONS.META_SHAPE);
    expect(result.detail.internal).toBe('capture_id_disagrees');
  });

  test('refuses a generation that does not match its own session number', () => {
    const doc = valid();
    doc.session.appGeneration = 'app-session-999';
    const result = validateTerminalMetaBytes(testCanonicalJson(doc));
    expect(result.ok).toBe(false);
    expect(result.detail.internal).toBe('generation_disagrees');
  });

  test('refuses a second-disk fingerprint that disagrees with the capture fingerprint', () => {
    const doc = valid();
    doc.secondDiskRevalidation.capabilityFingerprint = 'd'.repeat(64);
    const result = validateTerminalMetaBytes(testCanonicalJson(doc));
    expect(result.ok).toBe(false);
    expect(result.detail.internal).toBe('fingerprint_disagrees');
  });
});
