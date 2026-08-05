/**
 * S492 Step 3 — the terminal gate, driven through the PUBLIC fence surface.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `proveCaptureOnlyTerminalSession` is module-private and stays that way
 * (Oracle review v1 F3, terminal ruling v2). The previous suite therefore tested
 * everything around it — the leaf contract, the DDL, both generic boundaries —
 * and NONE of its branches, because the only honest route to them is the
 * no-argument production entry points.
 *
 * So this suite plants a whole world: a pinned `SQUIDRUN_DATA_ROOT`, one spool
 * route with both journals, a published generation/session, the frozen startup
 * release, an admission database with the real migration, an immutable capture
 * row, a terminal `ledger_sessions` row, and a mocked OS probe at the existing
 * module boundary. Then it calls `createOrReuseLegacyFence()` and
 * `evaluateFenceHealth()` — which take no arguments — and reads what production
 * wiring returns.
 *
 * TEMP DATA ROOTS ONLY. Nothing here touches the live `.squidrun` root, the live
 * ledger, the live queue, or any live process. The OS probe is mocked precisely
 * so that no real process is ever interrogated.
 *
 * EXPORTS ARE NOT WIDENED FOR TESTABILITY. If a branch below is unreachable, the
 * fixture is wrong — not the module's surface.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoots = [];

/**
 * The one thing this suite mocks: the operating system. Named `mockProbe` so the
 * factory below may close over it — jest hoists `jest.mock` above every other
 * statement, and only `mock`-prefixed names are allowed to cross that hoist.
 */
const mockProbe = jest.fn();
jest.mock('../modules/main/windows-process-identity', () => {
  const actual = jest.requireActual('../modules/main/windows-process-identity');
  return { ...actual, probeProcessStartIdentity: (...args) => mockProbe(...args) };
});

const RELEASE_ANCHOR_MODULES = [
  '../modules/telegram-inbound-durable-queue',
  '../modules/main/telegram-ingress-drain',
  '../modules/main/telegram-ingress-spool',
  '../modules/main/telegram-source-protocol',
  '../modules/main/telegram-legacy-cutover-fence',
  '../modules/main/telegram-loaded-release',
  '../modules/main/squidrun-app',
];

const NOW = 1_785_800_000_000;
const PREDECESSOR_PID = 424_242;

function canonical(value) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
    return out;
  };
  return JSON.stringify(walk(value));
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * A synthetic capability evidence blob in the exact stored shape. Synthetic on
 * purpose: its fingerprint must NOT be this release's, or the successor would
 * be reading a capture issued by the code that is reading it.
 */
function buildEvidence(seed) {
  const evidence = {
    anchors: [{ path: 'modules/main/telegram-ingress-drain.js', sha256: sha256(`anchor-${seed}`) }],
    capability: {
      outsideOwnerReferences: [
        { path: 'modules/main/a-caller.js', references: ['const { appendAttempt } = require(...)'] },
        { path: 'modules/main/b-caller.js', references: ['queue.appendAttempt(dir, record)'] },
      ],
      owner: 'modules/telegram-inbound-durable-queue.js',
      ownerDefinition: 'function appendAttempt(dir, record)',
      ownerExport: 'appendAttempt',
      symbol: 'appendAttempt',
    },
    fileCount: 7,
    manifestSha256: sha256(`manifest-${seed}`),
    scanner: 'legacy_writer_capability_v1',
    schema: 'squidrun.telegram_legacy_writer_capability.v1',
    totalBytes: 4096,
  };
  return { evidence, fingerprint: sha256(canonical(evidence)) };
}

/** The capture row exactly as a real `P` would have written it, minus P. */
function plantCaptureRow(db, {
  sessionId,
  appGeneration,
  createdAtMs,
  seed = 'default',
} = {}) {
  const { evidence, fingerprint } = buildEvidence(seed);
  const material = {
    capability: {
      fingerprint,
      manifestSha256: evidence.manifestSha256,
      scanner: evidence.scanner,
      schema: evidence.schema,
    },
    captureVersion: 'legacy_writer_capture_v1',
    decisionCutoverId: 'tg-decision-cutover-v1',
    schema: 'squidrun.telegram_legacy_writer_capture.material.v1',
    writer: {
      appGeneration,
      commandLineSha256: sha256(`cmdline-${seed}`),
      executablePath: 'D:\\legacy\\electron.exe',
      identitySchema: 'squidrun.windows_process_identity.v1',
      pid: PREDECESSOR_PID,
      processCreatedAt: '2026-08-01T00:00:00.000Z',
      sessionId,
    },
  };
  const canonicalMaterial = canonical(material);
  const captureId = `owc1_${sha256(canonicalMaterial)}`;
  db.prepare(`
    INSERT INTO telegram_legacy_writer_captures (
      capture_id, capture_slot, capture_version, decision_cutover_id, identity_schema,
      writer_app_generation, writer_session_id, writer_pid, writer_process_created_at,
      writer_executable_path, writer_command_line_sha256, capability_schema,
      capability_scanner, capability_manifest_sha256, capability_fingerprint,
      capability_reference_count, capability_evidence_json, canonical_material_json, created_at_ms
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    captureId, material.captureVersion, material.decisionCutoverId, material.writer.identitySchema,
    appGeneration, sessionId, PREDECESSOR_PID, material.writer.processCreatedAt,
    material.writer.executablePath, material.writer.commandLineSha256, evidence.schema,
    evidence.scanner, evidence.manifestSha256, fingerprint,
    2, JSON.stringify(evidence), canonicalMaterial, createdAtMs,
  );
  return { captureId, fingerprint, material };
}

/** The exact terminal document, written out rather than imported from a builder. */
function terminalMeta({ sessionId, sessionNumber, appGeneration, captureId, fingerprint }) {
  return {
    capture: { capabilityFingerprint: fingerprint, id: captureId },
    postcommitReread: { captureId, sessionId },
    schema: 'squidrun.telegram_writer_capture.session_terminal.v1',
    secondDiskRevalidation: { capabilityFingerprint: fingerprint },
    session: { appGeneration, id: sessionId, number: sessionNumber },
    terminal: {
      conflict: false,
      contextSnapshotCount: 0,
      degraded: false,
      fallback: false,
      replacement: false,
      retry: false,
      status: 'capture_committed_validated',
    },
  };
}

/**
 * Build one complete world and run `body` inside it with a fresh module
 * registry. Every module-level freeze — the release capture, the published
 * activation mode — is per-world, which is why the registry is reset rather
 * than shared.
 */
async function withWorld(options, body) {
  const {
    plant = () => {},
    sessionNumber = 8099,
    predecessorGeneration = `app-session-${options.sessionNumber || 8099}`,
    // THE PREDECESSOR'S SESSION ID IS THE TERMINAL ROW'S PRIMARY KEY. The
    // successor looks the row up by `capture.writer_session_id` and nothing
    // else, and the insert guard requires a 40-character `ses_`-prefixed id —
    // so the capture and the ledger row must agree on one real id, which is the
    // production shape rather than a test convenience.
    predecessorSessionId = `ses_${crypto.randomUUID()}`,
    currentGeneration = 'app-session-8100-current',
    currentSession = 'fixture-scheduling-session',
    probeResult = { absent: true },
    installCaptureOnlySchema = true,
  } = options;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-orchestrator-'));
  tempRoots.push(root);
  const previousEnv = { ...process.env };
  process.env.SQUIDRUN_DATA_ROOT = root;

  mockProbe.mockReset();
  mockProbe.mockResolvedValue(probeResult);

  let result;
  let worldCapture = null;
  jest.resetModules();
  try {
    const {
      publishAppGeneration,
      publishAppSchedulingSession,
    } = require('../modules/main/app-generation');
    publishAppGeneration(currentGeneration);
    publishAppSchedulingSession(currentSession);

    // The spool route and both journals, before anything reads them.
    const routeDir = path.join(root, '.squidrun', 'runtime', 'telegram-inbound', 'fixtureroute');
    fs.mkdirSync(routeDir, { recursive: true });
    fs.writeFileSync(path.join(routeDir, 'delivery-attempts.jsonl'), '');
    fs.writeFileSync(path.join(routeDir, 'terminal-dispositions.jsonl'), '');

    // The database, through the production writer and its real migration.
    const { TelegramAdmissionWriter } = require('../modules/main/telegram-admission-writer');
    const store = require('../modules/main/telegram-admission-store');
    const writer = new TelegramAdmissionWriter({ sessionId: currentSession });
    const opened = writer.open();
    if (!opened.ok) throw new Error(`writer open failed: ${JSON.stringify(opened)}`);
    try {
      const applied = store.applyTelegramAdmissionSchema(writer.db);
      if (!applied.ok) throw new Error(`telegram schema failed: ${JSON.stringify(applied)}`);
      if (installCaptureOnlySchema) {
        const guards = store.applyCaptureOnlySessionSchema(writer.db);
        if (!guards.ok) throw new Error(`capture-only schema failed: ${JSON.stringify(guards)}`);
      }

      const sessionId = predecessorSessionId;
      const capture = plantCaptureRow(writer.db, {
        sessionId: predecessorSessionId,
        appGeneration: predecessorGeneration,
        createdAtMs: NOW + 5,
      });
      worldCapture = capture;

      /** Same suspension contract the health matrix uses, available at plant time. */
      const suspendGuardsAtPlant = (db, fn) => {
        for (const name of store.CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS) {
          db.exec(`DROP TRIGGER IF EXISTS ${name}`);
        }
        try { return fn(); } finally {
          for (const name of store.CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS) {
            db.exec(store.CAPTURE_ONLY_SESSION_TRIGGER_SQL[name]);
          }
          const restored = store.verifyInstalledSchema(
            db, [...store.CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS],
          );
          if (!restored.ok) throw new Error(`guard restore failed: ${JSON.stringify(restored.detail)}`);
        }
      };

      plant({
        db: writer.db,
        root,
        routeDir,
        capture,
        sessionId,
        sessionNumber,
        suspendGuards: suspendGuardsAtPlant,
        predecessorGeneration,
        predecessorSessionId,
        meta: (overrides = {}) => canonical({
          ...terminalMeta({
            sessionId,
            sessionNumber,
            appGeneration: predecessorGeneration,
            captureId: capture.captureId,
            fingerprint: capture.fingerprint,
          }),
          ...overrides,
        }),
      });
    } finally {
      writer.close();
    }

    // The release anchors have to be LOADED for the startup capture to locate
    // this release; that is production's rule, not the fixture's.
    for (const anchor of RELEASE_ANCHOR_MODULES) require(anchor);
    const fence = require('../modules/main/telegram-legacy-cutover-fence');
    const activation = require('../modules/main/telegram-activation-mode');
    activation.publishFrozenActivationMode(activation.LEGACY_SETTLEMENT);
    const frozen = fence.captureStartupRelease();
    if (!frozen.ok) throw new Error(`release freeze failed: ${JSON.stringify(frozen)}`);

    /**
     * Reopen the same temp ledger AFTER a fence exists, so a health case can
     * plant its defect against real stored state instead of a world that never
     * had a fence at all (Oracle review v2, F2).
     */
    const withDb = (fn) => {
      const handle = new (require('../modules/main/telegram-admission-writer').TelegramAdmissionWriter)(
        { sessionId: currentSession },
      );
      const reopened = handle.open();
      if (!reopened.ok) throw new Error(`reopen failed: ${JSON.stringify(reopened)}`);
      try { return fn(handle.db); } finally { handle.close(); }
    };

    const context = {
      root,
      routeDir,
      withDb,
      /**
       * EVERY COLUMN OF EVERY STORED FENCE, ordered, for before/after equality.
       * `SELECT *` on purpose: a column added later must enter this comparison
       * automatically rather than needing someone to remember to list it.
       */
      storedFenceRows: () => withDb((db) => db
        .prepare('SELECT * FROM telegram_legacy_cutover_fences ORDER BY fence_id')
        .all()
        .map((row) => ({ ...row }))),
      sessionId: predecessorSessionId,
      sessionNumber,
      predecessorGeneration,
      capture: worldCapture,
      meta: (overrides = {}) => canonical({
        ...terminalMeta({
          sessionId: predecessorSessionId,
          sessionNumber,
          appGeneration: predecessorGeneration,
          captureId: worldCapture.captureId,
          fingerprint: worldCapture.fingerprint,
        }),
        ...overrides,
      }),
      /**
       * THE GUARDS FORBID THE VERY STATES A HEALTH CASE HAS TO PLANT, which is
       * the point of them. Suspending them for the plant and REINSTALLING THE
       * EXACT AUTHORITATIVE BODIES afterwards keeps the schema half of the proof
       * honest: when the case is about row evidence, the installed shape must
       * still verify, or the successor would refuse for the wrong reason.
       */
      suspendGuards: (db, fn) => {
        const store2 = require('../modules/main/telegram-admission-store');
        for (const name of store2.CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS) {
          db.exec(`DROP TRIGGER IF EXISTS ${name}`);
        }
        try { return fn(); } finally {
          for (const name of store2.CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS) {
            db.exec(store2.CAPTURE_ONLY_SESSION_TRIGGER_SQL[name]);
          }
          const restored = store2.verifyInstalledSchema(
            db, [...store2.CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS],
          );
          if (!restored.ok) {
            throw new Error(`guard restore failed: ${JSON.stringify(restored.detail)}`);
          }
        }
      },
    };

    result = await body(fence, context);
  } finally {
    process.env = previousEnv;
  }
  return result;
}

/** Plant an open reserved row and close it with the given terminal document. */
function plantTerminalSession(db, { sessionId, sessionNumber, metaJson, endedAtMs = NOW + 10 }) {
  db.prepare(`
    INSERT INTO ledger_sessions (
      session_id, session_number, mode, started_at_ms, ended_at_ms, summary, stats_json, team_json, meta_json
    ) VALUES (?, ?, 'writer_capture_only', ?, NULL, NULL, '{}', '{}', '{}')
  `).run(sessionId, sessionNumber, NOW);
  if (metaJson === null) return;
  const closed = db.prepare(`
    UPDATE ledger_sessions SET ended_at_ms = ?, meta_json = ?
    WHERE session_id = ? AND mode = 'writer_capture_only' AND ended_at_ms IS NULL AND meta_json = '{}'
  `).run(endedAtMs, metaJson, sessionId);
  if (Number(closed.changes) !== 1) throw new Error('fixture could not close the planted session');
}

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows handle lag */ }
  }
});

// =====================================================================
// THE VALID PATH — AND THE PROOF THAT THE FIXTURE REACHES THE GATE
// =====================================================================

describe('fence creation through the public no-argument entry point', () => {
  test('a valid terminal session lets the fence be created, and health agrees', async () => {
    await withWorld({
      plant: ({ db, sessionId, sessionNumber, meta }) => {
        plantTerminalSession(db, { sessionId, sessionNumber, metaJson: meta() });
      },
    }, async (fence) => {
      const created = await fence.createOrReuseLegacyFence();
      expect(created.ok).toBe(true);
      expect(created.created).toBe(true);
      expect(created.fenceId).toMatch(/^[a-z0-9_]+/i);
      // A fence existing is not the decision path being on.
      expect(created.schedulingEnabled).toBe(false);

      // The OS probe was reached, which is what proves the terminal gate PASSED
      // rather than being skipped.
      expect(mockProbe).toHaveBeenCalledWith(PREDECESSOR_PID);

      const health = await fence.evaluateFenceHealth();
      expect(health.ok).toBe(true);
      expect(health.healthy).toBe(true);
      expect(health.fenceId).toBe(created.fenceId);
      expect(health.schedulingEnabled).toBe(false);

      // Reuse, not a second mint.
      const again = await fence.createOrReuseLegacyFence();
      expect(again.ok).toBe(true);
      expect(again.created).toBe(false);
      expect(again.fenceId).toBe(created.fenceId);
    });
  });
});

// =====================================================================
// EVERY TERMINAL FAILURE, THROUGH THE SAME PUBLIC CALL GRAPH
// =====================================================================
//
// Each case asserts three things, and the third is the one that would otherwise
// rot: the exact named reason, that NO fence was created, and that the OS probe
// was never called — because the terminal proof runs BEFORE it, and a world
// where the probe fires is a world where the gate ran in the wrong order.

const TERMINAL_FAILURES = [
  ['the session row is absent', 'capture_only_session_absent',
    () => { /* plant no session at all */ }],

  ['the session is still open', 'capture_only_session_not_ended',
    ({ db, sessionId, sessionNumber }) => {
      plantTerminalSession(db, { sessionId, sessionNumber, metaJson: null });
    }],

  ['the session number is duplicated', 'capture_only_session_number_duplicated',
    ({ db, sessionId, sessionNumber, meta }) => {
      plantTerminalSession(db, { sessionId, sessionNumber, metaJson: meta() });
      // A second holder planted BEFORE the guards would have refused it: the
      // guards are dropped for exactly this row, because the point of the check
      // is what the successor does when prevention was absent.
      db.exec('DROP TRIGGER trg_ledger_writer_capture_session_number_reserved');
      db.exec('DROP TRIGGER trg_ledger_writer_capture_session_update_guard');
      db.prepare(`INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms)
        VALUES (?, ?, 'PTY', ?)`).run(`ses_${crypto.randomUUID()}`, sessionNumber, NOW);
      // And then reinstalled, so the schema the successor verifies is intact and
      // the ONLY defect under test is the duplicate row.
      const store = require('../modules/main/telegram-admission-store');
      for (const name of ['trg_ledger_writer_capture_session_number_reserved',
        'trg_ledger_writer_capture_session_update_guard']) {
        db.exec(store.CAPTURE_ONLY_SESSION_TRIGGER_SQL[name]);
      }
    }],

  ['a context snapshot exists', 'capture_only_session_context_snapshots_present',
    ({ db, sessionId, sessionNumber, meta }) => {
      plantTerminalSession(db, { sessionId, sessionNumber, metaJson: meta() });
      db.prepare(`INSERT INTO ledger_context_snapshots (snapshot_id, session_id, content_json, created_at_ms, trigger)
        VALUES (?, ?, '{}', ?, 'manual')`).run(`snap_${crypto.randomUUID()}`, sessionId, NOW + 3);
    }],

  ['the terminal document is not canonical', 'capture_only_terminal_meta_noncanonical',
    ({ db, sessionId, sessionNumber, capture, predecessorGeneration }) => {
      // EXACTLY THE SAME CONTENT, WRONG BYTE ORDER. `terminalMeta` is already
      // written in sorted order, so producing a non-canonical document takes a
      // deliberate reordering — reversing the top-level keys — rather than
      // "whatever JSON.stringify happens to emit", which is how this case
      // silently passed as canonical the first time it was written.
      const doc = terminalMeta({
        sessionId,
        sessionNumber,
        appGeneration: predecessorGeneration,
        captureId: capture.captureId,
        fingerprint: capture.fingerprint,
      });
      const reversed = {};
      for (const key of Object.keys(doc).reverse()) reversed[key] = doc[key];
      const bytes = JSON.stringify(reversed);
      if (bytes === canonical(doc)) throw new Error('fixture failed to produce noncanonical bytes');
      plantTerminalSession(db, { sessionId, sessionNumber, metaJson: bytes });
    }],

  ['the capture id in the document is not the stored one', 'capture_only_terminal_capture_id_mismatch',
    ({ db, sessionId, sessionNumber, capture, predecessorGeneration }) => {
      plantTerminalSession(db, {
        sessionId,
        sessionNumber,
        metaJson: canonical(terminalMeta({
          sessionId,
          sessionNumber,
          appGeneration: predecessorGeneration,
          captureId: `owc1_${sha256('a different capture')}`,
          fingerprint: capture.fingerprint,
        })),
      });
    }],

  ['the capability fingerprint disagrees with the capture row', 'capture_only_terminal_fingerprint_mismatch',
    ({ db, sessionId, sessionNumber, capture, predecessorGeneration }) => {
      plantTerminalSession(db, {
        sessionId,
        sessionNumber,
        metaJson: canonical(terminalMeta({
          sessionId,
          sessionNumber,
          appGeneration: predecessorGeneration,
          captureId: capture.captureId,
          fingerprint: sha256('a different release'),
        })),
      });
    }],

  ['the generation in the document is not the capture\'s', 'capture_only_terminal_generation_mismatch',
    ({ db, sessionId, sessionNumber, capture }) => {
      plantTerminalSession(db, {
        sessionId,
        sessionNumber,
        metaJson: canonical(terminalMeta({
          sessionId,
          sessionNumber,
          // INTERNALLY PERFECT ON PURPOSE: the generation matches its own
          // session number, so the document passes every self-consistency rule
          // in the validator. It still loses, because the CAPTURE row names a
          // different generation. A malformed generation would only have proved
          // that the shape check works.
          appGeneration: `app-session-${sessionNumber}`,
          captureId: capture.captureId,
          fingerprint: capture.fingerprint,
        })),
      });
    },
    // ==================================================================
    // THIS WORLD ADMITS NO VALID TERMINAL DOCUMENT, AND THAT IS NOT A BUG
    // ==================================================================
    // Read this before concluding the case is dead.
    // `capture-only-session-contract.js:218` requires
    // `session.appGeneration === 'app-session-' + session.number`, so a
    // document's generation is LOCKED to its own session number. Here the
    // capture names `app-session-7777` while the ledger row's number is 8099, so
    // NO document can satisfy both that internal rule and the cross-check
    // against the capture. There is therefore no "same world, defect removed"
    // control to write, and one faked by dropping the override would be a
    // control from a different world wearing the reachability label.
    //
    // The impossibility is NOT vacuity. Vacuity would mean the case returns the
    // same answer whether or not the target check exists. This one does not: the
    // planted document is internally valid, matches the row's id and number, and
    // matches the capture's id and fingerprint — remove the capture-generation
    // cross-check from the prover and it passes and a fence is created. THE
    // IMPOSSIBILITY AND THE CHECK ARE THE SAME FACT: the check fires exactly when
    // capture generation and row number disagree, and that disagreement is what
    // makes a valid document impossible.
    //
    // The control is the COMPLEMENTARY WORLD — same document construction, the
    // capture generation changed to match the row number — and it is the test
    // immediately after this matrix. The paired post-fence health case is `the
    // capture names a different generation` in HEALTH_FAILURES.
    //
    // This note lives here rather than only in the checkpoint because the wrong
    // inference was actually made, from the outside, with full context and two
    // agents available to correct it. A later reader has less and will get there
    // faster.
    { predecessorGeneration: 'app-session-7777' }],

  // ------------------------------------------------------------------
  // THE CASES RULING v2 REQUIRED THROUGH THE PUBLIC PATH, which the first
  // version of this matrix only covered at the leaf (Oracle review v2, F3).
  // Leaf coverage proves the validator; it does not prove reachability.
  //
  // The guards refuse most of these rows on purpose, so each one suspends them,
  // plants, and reinstalls the exact authoritative bodies — with the installed
  // shape re-verified during restore, so a row case cannot pass because the
  // schema was left broken.
  // ------------------------------------------------------------------

  ['the session ended before it started', 'capture_only_session_times_unordered',
    ({ db, sessionId, sessionNumber, meta, suspendGuards }) => suspendGuards(db, () => {
      db.prepare(`INSERT INTO ledger_sessions (
        session_id, session_number, mode, started_at_ms, ended_at_ms, summary, stats_json, team_json, meta_json
      ) VALUES (?, ?, 'writer_capture_only', ?, ?, NULL, '{}', '{}', ?)`)
        .run(sessionId, sessionNumber, NOW + 100, NOW + 1, meta());
    })],

  ['the session end time is not a positive integer', 'capture_only_session_times_invalid',
    ({ db, sessionId, sessionNumber, meta, suspendGuards }) => suspendGuards(db, () => {
      db.prepare(`INSERT INTO ledger_sessions (
        session_id, session_number, mode, started_at_ms, ended_at_ms, summary, stats_json, team_json, meta_json
      ) VALUES (?, ?, 'writer_capture_only', ?, ?, NULL, '{}', '{}', ?)`)
        .run(sessionId, sessionNumber, NOW, -1, meta());
    })],

  ['the session carries a summary', 'capture_only_session_not_pristine',
    ({ db, sessionId, sessionNumber, meta, suspendGuards }) => suspendGuards(db, () => {
      db.prepare(`INSERT INTO ledger_sessions (
        session_id, session_number, mode, started_at_ms, ended_at_ms, summary, stats_json, team_json, meta_json
      ) VALUES (?, ?, 'writer_capture_only', ?, ?, 'backfilled', '{}', '{}', ?)`)
        .run(sessionId, sessionNumber, NOW, NOW + 10, meta());
    })],

  ['the session carries stats and team payloads', 'capture_only_session_not_pristine',
    ({ db, sessionId, sessionNumber, meta, suspendGuards }) => suspendGuards(db, () => {
      db.prepare(`INSERT INTO ledger_sessions (
        session_id, session_number, mode, started_at_ms, ended_at_ms, summary, stats_json, team_json, meta_json
      ) VALUES (?, ?, 'writer_capture_only', ?, ?, NULL, '{"a":1}', '{"b":2}', ?)`)
        .run(sessionId, sessionNumber, NOW, NOW + 10, meta());
    })],

  // THESE TWO ARE UNREACHABLE THROUGH THE GUARDED CLOSE, AND THAT IS A RESULT.
  //
  // I first planted them through the normal close path and both were refused by
  // `capture_only_session_close_invalid`: the close guard already compares
  // `json_extract(NEW.meta_json,'$.session.id')` and `'$.session.number'`
  // against the row. So on a database that HAS the guards, a document naming a
  // different session can never land — prevention holds — and the successor's
  // cross-check is reachable only on a database where the guard was absent when
  // the row was written. That is precisely the case the successor exists for, so
  // these plant with the guards suspended and reinstall them afterwards: the
  // schema is verified-healthy at read time, and the only defect is the row.
  ['the document names a different session id', 'capture_only_terminal_session_id_mismatch',
    ({ db, sessionId, sessionNumber, capture, predecessorGeneration, suspendGuards }) => {
      // Internally consistent throughout — a different `ses_` id in EVERY field
      // that mentions one — so the document passes its own shape rules and dies
      // on the cross-check against the row and the capture.
      const other = `ses_${crypto.randomUUID()}`;
      suspendGuards(db, () => {
        db.prepare(`INSERT INTO ledger_sessions (
          session_id, session_number, mode, started_at_ms, ended_at_ms, summary, stats_json, team_json, meta_json
        ) VALUES (?, ?, 'writer_capture_only', ?, ?, NULL, '{}', '{}', ?)`)
          .run(sessionId, sessionNumber, NOW, NOW + 10, canonical(terminalMeta({
            sessionId: other,
            sessionNumber,
            appGeneration: predecessorGeneration,
            captureId: capture.captureId,
            fingerprint: capture.fingerprint,
          })));
      });
    }],

  ['the document names a different session number', 'capture_only_terminal_session_id_mismatch',
    ({ db, sessionId, sessionNumber, capture, suspendGuards }) => {
      // The generation moves with the number so the document stays internally
      // valid; the row's number is what it disagrees with.
      suspendGuards(db, () => {
        db.prepare(`INSERT INTO ledger_sessions (
          session_id, session_number, mode, started_at_ms, ended_at_ms, summary, stats_json, team_json, meta_json
        ) VALUES (?, ?, 'writer_capture_only', ?, ?, NULL, '{}', '{}', ?)`)
          .run(sessionId, sessionNumber, NOW, NOW + 10, canonical(terminalMeta({
            sessionId,
            sessionNumber: sessionNumber + 1,
            appGeneration: `app-session-${sessionNumber + 1}`,
            captureId: capture.captureId,
            fingerprint: capture.fingerprint,
          })));
      });
    }],

  ['a guard is present under the right name as the WRONG TYPE', 'writer_capture_schema_unverified',
    ({ db, sessionId, sessionNumber, meta }) => {
      plantTerminalSession(db, { sessionId, sessionNumber, metaJson: meta() });
      const name = 'trg_ledger_writer_capture_session_no_delete';
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(`CREATE VIEW ${name} AS SELECT 1 AS x`);
    }],
];

describe.each(TERMINAL_FAILURES)('the terminal gate refuses: %s', (label, reason, plant, world = {}) => {
  test('creation returns the exact reason, mints no fence, and never probes the OS', async () => {
    await withWorld({ ...world, plant }, async (fence) => {
      const created = await fence.createOrReuseLegacyFence();
      expect(created.ok).toBe(false);
      expect(created.reason).toBe(reason);
      expect(created.fenceId).toBeUndefined();
      expect(mockProbe).not.toHaveBeenCalled();
    });
  });

  test('health in a world with no fence refuses at the stored-fence row, BEFORE this gate', async () => {
    await withWorld({ ...world, plant }, async (fence) => {
      // NAMED FOR WHAT IT ACTUALLY PROVES. The previous version of this test was
      // called "health returns the same reason through the same authority" and
      // asserted no reason at all — production returns `fence_row_missing` at
      // the stored-fence read, two proofs before `proveStoredWriterRetired`, so
      // eight green cases never reached the terminal gate they claimed to cover.
      // Oracle caught it (review v2 F2). The reachable health coverage now lives
      // in the post-fence matrix below; this case exists to pin the ordering.
      const health = await fence.evaluateFenceHealth();
      expect(health.ok).toBe(true);
      expect(health.healthy).toBe(false);
      expect(health.reason).toBe('fence_row_missing');
      expect(mockProbe).not.toHaveBeenCalled();
    });
  });
});

// =====================================================================
// THE COMPLEMENTARY WORLD FOR THE GENERATION CASE
// =====================================================================
//
// The control the generation failure cannot have inside its own world. Same
// document construction, one variable changed — the capture's generation, which
// IS the variable under test rather than incidental scaffolding. Changing the
// variable under test between control and subject is what a control is for.
//
// Subject: capture generation `app-session-7777`, row number 8099, document
// generation `app-session-8099` -> refused `capture_only_terminal_generation_mismatch`.
// Control: capture generation `app-session-8099`, same row number, same document
// construction -> fence created.

describe('the generation cross-check is the only thing separating those two worlds', () => {
  test('with the capture generation matching the row number, the same document creates a fence', async () => {
    await withWorld({
      // No `predecessorGeneration` override: it defaults to
      // `app-session-${sessionNumber}`, which is exactly "changed to match the
      // row number" and nothing else.
      plant: ({ db, sessionId, sessionNumber, capture, predecessorGeneration }) => {
        plantTerminalSession(db, {
          sessionId,
          sessionNumber,
          // Byte-for-byte the construction the failing case uses.
          metaJson: canonical(terminalMeta({
            sessionId,
            sessionNumber,
            appGeneration: `app-session-${sessionNumber}`,
            captureId: capture.captureId,
            fingerprint: capture.fingerprint,
          })),
        });
        expect(predecessorGeneration).toBe(`app-session-${sessionNumber}`);
      },
    }, async (fence) => {
      const created = await fence.createOrReuseLegacyFence();
      expect(created.ok).toBe(true);
      expect(created.created).toBe(true);
      // The gate was reached and PASSED, which is what the probe firing proves.
      expect(mockProbe).toHaveBeenCalledWith(PREDECESSOR_PID);
    });
  });
});

// =====================================================================
// HEALTH, WITH A REAL FENCE UNDERNEATH IT
// =====================================================================
//
// Every case here creates a VALID fence first, then breaks the world, then asks
// health. That is the only arrangement in which `evaluateFenceHealth` reaches
// `proveStoredWriterRetired` and therefore the private terminal gate — the
// arrangement Oracle's F2 required after the first version asserted nothing.
//
// The guards forbid most of these states, so the row-evidence cases suspend the
// five triggers, plant, and reinstall the exact authoritative bodies; the schema
// half is re-verified during restore, so a case about a row cannot pass because
// the schema was quietly left broken.

const HEALTH_FAILURES = [
  ['the terminal session row is gone', 'capture_only_session_absent',
    ({ db, sessionId, suspendGuards }) => suspendGuards(db, () => {
      db.prepare('DELETE FROM ledger_sessions WHERE session_id = ?').run(sessionId);
    })],

  ['the terminal session was reopened', 'capture_only_session_not_ended',
    ({ db, sessionId, suspendGuards }) => suspendGuards(db, () => {
      db.prepare("UPDATE ledger_sessions SET ended_at_ms = NULL, meta_json = '{}' WHERE session_id = ?")
        .run(sessionId);
    })],

  ['a second row took the reserved number', 'capture_only_session_number_duplicated',
    ({ db, sessionNumber, suspendGuards }) => suspendGuards(db, () => {
      db.prepare("INSERT INTO ledger_sessions (session_id, session_number, mode, started_at_ms) VALUES (?, ?, 'PTY', ?)")
        .run(`ses_${crypto.randomUUID()}`, sessionNumber, NOW);
    })],

  ['a context snapshot appeared', 'capture_only_session_context_snapshots_present',
    ({ db, sessionId }) => {
      // No guard suspension: `ledger_context_snapshots` is not one of the five.
      db.prepare(`INSERT INTO ledger_context_snapshots (snapshot_id, session_id, content_json, created_at_ms, trigger)
        VALUES (?, ?, '{}', ?, 'manual')`).run(`snap_${crypto.randomUUID()}`, sessionId, NOW + 3);
    }],

  ['the terminal document was rewritten noncanonically', 'capture_only_terminal_meta_noncanonical',
    ({ db, sessionId, sessionNumber, capture, predecessorGeneration, suspendGuards }) => suspendGuards(db, () => {
      const doc = terminalMeta({
        sessionId,
        sessionNumber,
        appGeneration: predecessorGeneration,
        captureId: capture.captureId,
        fingerprint: capture.fingerprint,
      });
      const reversed = {};
      for (const key of Object.keys(doc).reverse()) reversed[key] = doc[key];
      db.prepare('UPDATE ledger_sessions SET meta_json = ? WHERE session_id = ?')
        .run(JSON.stringify(reversed), sessionId);
    })],

  ['a guard was token-mutated under its own name', 'writer_capture_schema_unverified',
    ({ db }) => {
      const store2 = require('../modules/main/telegram-admission-store');
      const name = 'trg_ledger_writer_capture_session_close_guard';
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(store2.CAPTURE_ONLY_SESSION_TRIGGER_SQL[name]
        .replace(/RAISE\(ABORT, '([^']+)'\)/, (_, r) => `RAISE(ABORT, '${r}_mutated')`));
    }],

  // ------------------------------------------------------------------
  // THE ELEVEN v2 SEMANTIC SHAPES, AFTER A REAL FENCE EXISTS
  // ------------------------------------------------------------------
  //
  // All eleven already had public CREATION evidence. Review v3 B2 is that
  // creation evidence is only half the gate: the paired no-fence health test
  // returns `fence_row_missing` and proves ordering, not that health reaches the
  // terminal gate once a fence is stored. A no-defect creation control does not
  // close it either — that proves the gate is reachable in another world.
  //
  // Each case below mints a real fence, snapshots the complete stored row,
  // plants exactly ONE defect, and the shared harness asserts the exact reason,
  // no post-defect OS probe, one fence row, and byte-for-byte row equality.
  //
  // The guards forbid most of these rows, so row-evidence cases suspend the five
  // triggers and reinstall the exact authoritative bodies, with the installed
  // shape re-verified during restore. A row case therefore cannot pass because
  // the schema was quietly left broken.

  ['the document names a different capture id', 'capture_only_terminal_capture_id_mismatch',
    ({ db, sessionId, sessionNumber, predecessorGeneration, capture, suspendGuards }) => suspendGuards(db, () => {
      // Internally consistent: BOTH places the document names a capture id move
      // together, so it dies on the cross-check against the stored capture row
      // rather than on its own shape rule.
      db.prepare('UPDATE ledger_sessions SET meta_json = ? WHERE session_id = ?').run(
        canonical(terminalMeta({
          sessionId,
          sessionNumber,
          appGeneration: predecessorGeneration,
          captureId: `owc1_${sha256('a different capture entirely')}`,
          fingerprint: capture.fingerprint,
        })),
        sessionId,
      );
    })],

  ['the document names a different capability fingerprint', 'capture_only_terminal_fingerprint_mismatch',
    ({ db, sessionId, sessionNumber, predecessorGeneration, capture, suspendGuards }) => suspendGuards(db, () => {
      // Both fingerprint fields move together for the same reason.
      db.prepare('UPDATE ledger_sessions SET meta_json = ? WHERE session_id = ?').run(
        canonical(terminalMeta({
          sessionId,
          sessionNumber,
          appGeneration: predecessorGeneration,
          captureId: capture.captureId,
          fingerprint: sha256('a different release entirely'),
        })),
        sessionId,
      );
    })],

  // THE GENERATION CASE ORACLE REQUIRED SEPARATELY (review v3, generation ruling).
  //
  // The document's generation is locked to its own session number, so the
  // mismatch cannot be introduced by editing the generation alone — that would
  // fail the document's internal rule and return a shape error instead. Both the
  // ROW's number and the document's number/generation move together to a new
  // consistent pair, which leaves the CAPTURE's generation as the only
  // disagreement. That is the exact relationship the cross-check exists to catch.
  ['the capture names a different generation', 'capture_only_terminal_generation_mismatch',
    ({ db, sessionId, suspendGuards }) => suspendGuards(db, () => {
      const renumbered = 8123;
      db.prepare('UPDATE ledger_sessions SET session_number = ? WHERE session_id = ?')
        .run(renumbered, sessionId);
      const row = db.prepare('SELECT * FROM ledger_sessions WHERE session_id = ?').get(sessionId);
      const meta = JSON.parse(row.meta_json);
      db.prepare('UPDATE ledger_sessions SET meta_json = ? WHERE session_id = ?').run(
        canonical(terminalMeta({
          sessionId,
          sessionNumber: renumbered,
          appGeneration: `app-session-${renumbered}`,
          captureId: meta.capture.id,
          fingerprint: meta.capture.capabilityFingerprint,
        })),
        sessionId,
      );
    })],

  ['the session ended before it started', 'capture_only_session_times_unordered',
    ({ db, sessionId, suspendGuards }) => suspendGuards(db, () => {
      db.prepare('UPDATE ledger_sessions SET started_at_ms = ? WHERE session_id = ?')
        .run(NOW + 500, sessionId);
    })],

  ['the session end time is not a positive integer', 'capture_only_session_times_invalid',
    ({ db, sessionId, suspendGuards }) => suspendGuards(db, () => {
      db.prepare('UPDATE ledger_sessions SET ended_at_ms = -1 WHERE session_id = ?').run(sessionId);
    })],

  ['the session acquired a summary', 'capture_only_session_not_pristine',
    ({ db, sessionId, suspendGuards }) => suspendGuards(db, () => {
      db.prepare("UPDATE ledger_sessions SET summary = 'backfilled' WHERE session_id = ?")
        .run(sessionId);
    })],

  ['the session acquired stats and team payloads', 'capture_only_session_not_pristine',
    ({ db, sessionId, suspendGuards }) => suspendGuards(db, () => {
      db.prepare(`UPDATE ledger_sessions SET stats_json = '{"a":1}', team_json = '{"b":2}'
        WHERE session_id = ?`).run(sessionId);
    })],

  ['the document names a different session id', 'capture_only_terminal_session_id_mismatch',
    ({ db, sessionId, sessionNumber, predecessorGeneration, capture, suspendGuards }) => suspendGuards(db, () => {
      db.prepare('UPDATE ledger_sessions SET meta_json = ? WHERE session_id = ?').run(
        canonical(terminalMeta({
          sessionId: `ses_${crypto.randomUUID()}`,
          sessionNumber,
          appGeneration: predecessorGeneration,
          captureId: capture.captureId,
          fingerprint: capture.fingerprint,
        })),
        sessionId,
      );
    })],

  ['the document names a different session number', 'capture_only_terminal_session_id_mismatch',
    ({ db, sessionId, sessionNumber, capture, suspendGuards }) => suspendGuards(db, () => {
      // Number and generation move together so the document stays internally
      // valid; the ROW's number is what it now disagrees with.
      db.prepare('UPDATE ledger_sessions SET meta_json = ? WHERE session_id = ?').run(
        canonical(terminalMeta({
          sessionId,
          sessionNumber: sessionNumber + 1,
          appGeneration: `app-session-${sessionNumber + 1}`,
          captureId: capture.captureId,
          fingerprint: capture.fingerprint,
        })),
        sessionId,
      );
    })],

  ['a guard is absent entirely', 'writer_capture_schema_unverified',
    ({ db }) => {
      db.exec('DROP TRIGGER trg_ledger_writer_capture_session_update_guard');
    }],

  ['an object of the wrong type sits under a guard name', 'writer_capture_schema_unverified',
    ({ db }) => {
      const name = 'trg_ledger_writer_capture_session_no_delete';
      db.exec(`DROP TRIGGER ${name}`);
      db.exec(`CREATE VIEW ${name} AS SELECT 1 AS x`);
    }],
];

describe.each(HEALTH_FAILURES)('health refuses after the fence exists: %s', (label, reason, breakIt) => {
  test('the exact reason comes back through the real health path, with the fence intact', async () => {
    await withWorld({
      plant: ({ db, sessionId, sessionNumber, meta }) => {
        plantTerminalSession(db, { sessionId, sessionNumber, metaJson: meta() });
      },
    }, async (fence, ctx) => {
      // 1. A real fence, minted through the public entry point.
      const created = await fence.createOrReuseLegacyFence();
      expect(created.ok).toBe(true);
      expect(mockProbe).toHaveBeenCalledWith(PREDECESSOR_PID);

      // 2. THE COMPLETE STORED ROW, BEFORE ANYTHING IS BROKEN.
      const before = ctx.storedFenceRows();
      expect(before).toHaveLength(1);

      // 3. Break the world.
      ctx.withDb((db) => breakIt({ ...ctx, db }));

      // 4. Forget that creation probed, so the assertion below is about health.
      mockProbe.mockClear();

      const health = await fence.evaluateFenceHealth();
      expect(health.ok).toBe(true);
      expect(health.healthy).toBe(false);
      expect(health.reason).toBe(reason);
      // The terminal gate runs BEFORE the OS probe, so a refusal here must not
      // have interrogated the operating system.
      expect(mockProbe).not.toHaveBeenCalled();

      // 5. THE STORED FENCE IS UNCHANGED, FIELD BY FIELD — not merely still one
      //    row. Health reports; it does not repair, rewrite or remint. A
      //    count-only assertion stays green while an implementation rewrites the
      //    sole row, which is the gap Oracle review v3 B1 named. Every case in
      //    this matrix goes through this one harness so none can regress to
      //    count-only evidence on its own.
      const after = ctx.storedFenceRows();
      expect(after).toHaveLength(1);
      expect(after).toEqual(before);
    });
  });
});

// =====================================================================
// THE GUARDS THEMSELVES ARE PART OF THE PROOF
// =====================================================================

describe('a database missing the installed guards is stale, not merely unguarded', () => {
  test('creation refuses when the capture-only guards were never installed', async () => {
    await withWorld({
      installCaptureOnlySchema: false,
      plant: ({ db, sessionId, sessionNumber, meta }) => {
        plantTerminalSession(db, { sessionId, sessionNumber, metaJson: meta() });
      },
    }, async (fence) => {
      const created = await fence.createOrReuseLegacyFence();
      expect(created.ok).toBe(false);
      expect(created.reason).toBe('writer_capture_schema_unverified');
      expect(mockProbe).not.toHaveBeenCalled();
    });
  });

  test.each([
    'trg_ledger_writer_capture_session_insert_guard',
    'trg_ledger_writer_capture_session_number_reserved',
    'trg_ledger_writer_capture_session_close_guard',
    'trg_ledger_writer_capture_session_update_guard',
    'trg_ledger_writer_capture_session_no_delete',
  ])('creation refuses when %s is token-mutated under its own name', async (name) => {
    await withWorld({
      plant: ({ db, sessionId, sessionNumber, meta }) => {
        plantTerminalSession(db, { sessionId, sessionNumber, metaJson: meta() });
        const store = require('../modules/main/telegram-admission-store');
        const mutated = store.CAPTURE_ONLY_SESSION_TRIGGER_SQL[name]
          .replace(/RAISE\(ABORT, '([^']+)'\)/, (_, r) => `RAISE(ABORT, '${r}_mutated')`);
        db.exec(`DROP TRIGGER ${name}`);
        db.exec(mutated);
      },
    }, async (fence) => {
      const created = await fence.createOrReuseLegacyFence();
      expect(created.ok).toBe(false);
      expect(created.reason).toBe('writer_capture_schema_unverified');
      expect(created.detail.missing).toContain(`${name}:mismatch`);
      expect(mockProbe).not.toHaveBeenCalled();
    });
  });

  test('creation refuses when a guard is absent entirely', async () => {
    const name = 'trg_ledger_writer_capture_session_update_guard';
    await withWorld({
      plant: ({ db, sessionId, sessionNumber, meta }) => {
        plantTerminalSession(db, { sessionId, sessionNumber, metaJson: meta() });
        db.exec(`DROP TRIGGER ${name}`);
      },
    }, async (fence) => {
      const created = await fence.createOrReuseLegacyFence();
      expect(created.ok).toBe(false);
      expect(created.reason).toBe('writer_capture_schema_unverified');
      expect(created.detail.missing).toContain(`${name}:absent`);
      expect(mockProbe).not.toHaveBeenCalled();
    });
  });
});

// =====================================================================
// THE PRIVATE PROVERS ARE STILL PRIVATE
// =====================================================================

describe('surface', () => {
  test('neither terminal prover is exported, and both entry points take no arguments', async () => {
    await withWorld({
      plant: ({ db, sessionId, sessionNumber, meta }) => {
        plantTerminalSession(db, { sessionId, sessionNumber, metaJson: meta() });
      },
    }, async (fence) => {
      expect(fence.proveCaptureOnlyTerminalSession).toBeUndefined();
      expect(fence.proveStoredWriterRetired).toBeUndefined();
      expect(fence.createOrReuseLegacyFence.length).toBe(0);
      expect(fence.evaluateFenceHealth.length).toBe(0);
    });
  });
});
