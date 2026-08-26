'use strict';

/**
 * THE STABLE LEGACY CUTOVER FENCE (v7 §4).
 *
 * =====================================================================
 * WHAT THIS IS FOR
 * =====================================================================
 * Twelve legacy Telegram records are sitting in the live queue, written by a
 * build that knew nothing about decisions. The repaired transport may not touch
 * them, and the new symmetric decision path may not start, until there is one
 * durable, content-derived statement that says: THE LEGACY WORLD IS CLOSED, and
 * here is exactly what it looked like when it closed.
 *
 * "Exactly" is the entire difficulty. A fence that says "the journals looked
 * fine" is worth nothing; a fence that binds their bytes, the identity of the
 * writer that can no longer append to them, and the release that is running,
 * is a thing a later generation can re-derive and either match or refuse.
 *
 * =====================================================================
 * THE ID IS THE MATERIAL
 * =====================================================================
 * `legacyFenceId = "lf1_" + SHA256(canonicalFenceMaterial)`. Not an assigned
 * name, not a row number, not a uuid: two different worlds cannot produce one
 * id, and one world cannot produce two. Every attack in v13 §"required
 * adversarial proof" reduces to the same question — can something that is not
 * this world derive this id — and the answer has to be no for key order, JSON
 * spelling, path spelling, line endings, cutover substitution, caller-supplied
 * digests, and a stored row with one field edited.
 *
 * =====================================================================
 * NOTHING HERE ACCEPTS AN ASSERTION — AND NOTHING ACCEPTS AN INPUT EITHER
 * =====================================================================
 * The earlier draft said callers supply raw inputs and never conclusions, and
 * treated that as the safe half of the line. It was not. A `db` handle chooses
 * which database the permanent statement lands in; a `dir` chooses which
 * journals it is about; an `owner` chooses which generation is current; a
 * release capture chooses what code is running; a probe chooses whether the
 * predecessor is alive. Those are not raw inputs — each one answers, from
 * outside, the exact question the check downstream of it claims to establish.
 *
 * So the public surface takes NOTHING. `createOrReuseLegacyFence()` and
 * `evaluateFenceHealth()` acquire every value themselves: generation and session
 * from the published env authority, the spool from the pinned install root and
 * exactly one enumerated route, the journal paths from the queue that writes
 * them, the release from this module's own frozen startup capture, the database
 * from a writer whose `open()` verifies its own identity, and liveness from the
 * real OS probe.
 *
 * The three producer results (journals, retirement, material) are tracked in
 * private WeakSets, so an object that merely LOOKS like one is refused by
 * construction rather than by inspection: `{ok: true, ...}` is the cheapest
 * forgery there is, and every `if (result.ok)` in this file would otherwise
 * honour it. The producers that mint those brands are module-private, because an
 * exported minter defeats a WeakSet by simply being asked (Architect #192) — and
 * no brand is returned across the boundary either, so a caller can neither
 * supply one nor keep one.
 *
 * =====================================================================
 * WHY THE RETIREMENT PROVER LIVES IN THIS FILE
 * =====================================================================
 * It reads the immutable predecessor capture, which another module owns. It
 * could have stayed there and been exported. It could not have stayed there and
 * been PRIVATE, because the material that consumes its brand is minted here, and
 * two brands in two closures can only be joined by an exported minter in the
 * middle. The whole brand-consuming sequence therefore shares one closure. What
 * this module imports from the capture authority is a row reader, a schema list
 * and a vocabulary — read-only by construction, with no issuance or backfill
 * path anywhere in it (capture-only activation bridge ruling v1).
 *
 * =====================================================================
 * THIS CHILD STILL SCHEDULES NOTHING
 * =====================================================================
 * A healthy fence is a precondition for the decision path, not permission to
 * run it. Step 2B's HOLD stands: `schedulingEnabled` is false on every path in
 * this module, healthy or not, and enabling it belongs to a later reviewed
 * child.
 */

const fs = require('node:fs');
const path = require('node:path');

const { canonicalJson, sha256 } = require('./canonical-json');
const {
  DECISION_CUTOVER_ID,
  TRANSPORT_PROTOCOL_V1,
  readStampedProtocol,
} = require('./telegram-source-protocol');
const { readLegacyJournalSnapshot } = require('./telegram-legacy-journal');
// THE COORDINATOR'S OWN MODE AUTHORITY AND ITS RESOLVER (Architect #202).
const {
  LEGACY_SETTLEMENT,
  resolveActivationMode,
  currentFrozenActivationMode,
} = require('./telegram-activation-mode');
const {
  PROCESS_IDENTITY_SCHEMA,
  probeProcessStartIdentity,
  processIdentitiesEqual,
} = require('./windows-process-identity');
const {
  captureLoadedRelease,
  isGenuineCapture,
  verifyLoadedReleaseUnchanged,
} = require('./telegram-loaded-release');
const { currentAppGeneration, currentAppSchedulingSession } = require('./app-generation');
const {
  verifyInstalledSchema,
  CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS,
} = require('./telegram-admission-store');
// THE TERMINAL SESSION CONTRACT, from the one module that owns it. The reserved
// mode name, the document shape and the refusal vocabulary are shared with the
// generic-API gates and the installed triggers, so there is no second spelling
// of what a capture-only session is.
const {
  CAPTURE_ONLY_SESSION_MODE,
  CAPTURE_ONLY_SESSION_ID_RE,
  TERMINAL_REASONS,
  isPositiveSafeInteger,
  validateTerminalMetaBytes,
} = require('./capture-only-session-contract');
// THE REAL QUEUE OWNER, not a copy of its naming rule. `ATTEMPTS_NAME` /
// `DISPOSITIONS_NAME` were imported from the journal parser and joined onto a
// directory here, which is a SECOND derivation of where those files live. Two
// derivations agree until one moves, and the day they disagree the fence binds
// bytes the queue never wrote. `attemptsPath`/`dispositionsPath` are the exact
// functions the drain uses at telegram-ingress-drain.js:1041.
const queue = require('../telegram-inbound-durable-queue');
const spool = require('./telegram-ingress-spool');
const { resolveInstalledDataRoot, isPinnedInstalledDataRoot } = require('../installed-data-root');
const { TelegramAdmissionWriter } = require('./telegram-admission-writer');
// READ-ONLY OVER THE CAPTURE (capture-only activation bridge ruling v1). The
// successor imports a row reader, a schema list and a vocabulary. There is
// nothing on this import that can issue, backfill or mint.
const {
  CAPTURE_REASONS,
  CAPTURE_SCHEMA_OBJECTS,
  RETIREMENT_OBSERVATION_SCHEMA,
  readStoredWriterCapture,
} = require('./telegram-legacy-writer-capture');

const FENCE_VERSION = 'legacy_fence_v1';
const FENCE_ID_PREFIX = 'lf1_';
const JOURNALS_SCHEMA = 'squidrun.telegram_legacy_fence.journals.v1';
const MATERIAL_SCHEMA = 'squidrun.telegram_legacy_fence.material.v1';
const FENCE_ID_RE = /^lf1_[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** The schema objects a fence write or read depends on. */
const FENCE_SCHEMA_OBJECTS = Object.freeze([
  'telegram_legacy_cutover_fences',
  'trg_tg_fence_immutable',
  'trg_tg_fence_no_delete',
]);

const FENCE_REASONS = Object.freeze({
  JOURNAL_PATH_UNRESOLVED: 'fence_journal_path_unresolved',
  JOURNAL_PATH_COLLISION: 'fence_journal_path_collision',
  JOURNAL_UNREADABLE: 'fence_journal_unreadable',
  JOURNAL_INVALID: 'fence_journal_invalid',
  JOURNAL_MUTATED: 'fence_journal_mutated_during_read',
  // THE QUEUE'S OWN PATHS, RESOLVED TO ONE REAL FILE EACH. Two spellings of the
  // same file — case, junction, symlink, `..` — would let one journal validate
  // as both, so an alias collision is refused rather than deduplicated.
  JOURNAL_PATH_ALIASED: 'fence_journal_path_aliased',
  RETIREMENT_IDENTITY_MISMATCH: 'fence_retirement_identity_mismatch',
  RETIREMENT_UNVERIFIABLE: 'fence_retirement_unverifiable',
  MATERIAL_INPUT_FORGED: 'fence_material_input_forged',
  MATERIAL_CUTOVER_OVERRIDE: 'fence_material_cutover_override_refused',
  MATERIAL_ID_ASSERTED: 'fence_material_id_asserted',
  MATERIAL_SHAPE: 'fence_material_shape_invalid',
  MATERIAL_VERSION: 'fence_material_version_unrecognized',
  MATERIAL_CUTOVER_WRONG: 'fence_material_cutover_unrecognized',
  MATERIAL_IDENTITY_SCHEMA: 'fence_material_identity_schema_unrecognized',
  MATERIAL_UNBRANDED: 'fence_material_not_production_issued',
  SCHEMA_UNVERIFIED: 'fence_schema_unverified',
  STORE_UNAVAILABLE: 'fence_store_unavailable',
  ROW_COUNT_INVALID: 'fence_row_count_invalid',
  ROW_CONFLICT: 'fence_row_conflict',
  ROW_MISMATCH: 'fence_row_mismatch',
  ROW_MISSING: 'fence_row_missing',
  ROW_INCOHERENT: 'fence_row_incoherent',
  INSERT_FAILED: 'fence_insert_failed',
  OWNER_UNPUBLISHED: 'fence_scheduling_owner_unpublished',
  OWNER_SESSION_MISSING: 'fence_scheduling_owner_session_missing',
  // The successor orchestrator's own acquisition refusals. Every one of these
  // exists because the value it names USED to be a parameter.
  RELEASE_NOT_FROZEN: 'fence_release_not_frozen',
  RELEASE_CAPTURE_FAILED: 'fence_release_capture_failed',
  DATA_ROOT_UNPINNED: 'fence_data_root_unpinned',
  SPOOL_ROOT_UNRESOLVED: 'fence_spool_root_unresolved',
  SPOOL_ROUTE_ABSENT: 'fence_spool_route_absent',
  SPOOL_ROUTE_AMBIGUOUS: 'fence_spool_route_ambiguous',
  SPOOL_ROUTE_UNSAFE: 'fence_spool_route_unsafe',
  WRITER_UNAVAILABLE: 'fence_admission_writer_unavailable',
  POSTCOMMIT_MISSING: 'fence_postcommit_row_missing',
  POSTCOMMIT_DIVERGED: 'fence_postcommit_row_diverged',
  // Phase-L readiness (#178 §3). The legacy world has to be SETTLED, not merely
  // old, before a permanent statement says it is closed.
  PHASE_L_QUEUE_UNREADABLE: 'fence_phase_l_queue_unreadable',
  PHASE_L_LEGACY_PENDING: 'fence_phase_l_legacy_source_pending',
  PHASE_L_SOURCE_UNRECOGNIZED: 'fence_phase_l_queued_source_unrecognized',
  PHASE_L_DISPOSITION_OUTSTANDING: 'fence_phase_l_disposition_outstanding',
  PHASE_L_OWNER_UNPROVEN: 'fence_phase_l_legacy_owner_unproven',
  PHASE_L_SCHEDULING_NOT_HELD: 'fence_phase_l_scheduling_not_held',
  PHASE_L_MODE_NOT_FROZEN: 'fence_phase_l_activation_mode_not_frozen',
  PHASE_L_MODE_UNRECOGNIZED: 'fence_phase_l_activation_mode_unrecognized',
  PHASE_L_MODE_NOT_SETTLEMENT: 'fence_phase_l_activation_mode_not_legacy_settlement',
});

/**
 * SCHEDULING IS HELD, AND THE HOLD IS A CONSTANT RATHER THAN SIX LITERALS.
 *
 * Phase-L readiness proof (4) has to assert that queued decision sources are
 * still scheduling-held, and it must assert it against THE SAME value the
 * results carry. Six copies of a string literal agree until someone edits five
 * of them, and the one that gets missed is the one that lies.
 */
const SCHEDULING_ENABLED = false;
const SCHEDULING_HOLD = 'step_2b_scheduling_hold';

/**
 * THE EXPLICIT ABSENT SENTINEL.
 *
 * Absence is a FACT about the journal, and it has to hash differently from every
 * possible present state — including a zero-byte file, which has a perfectly
 * real SHA-256. Nulls rather than omitted keys, because `JSON.stringify` drops
 * `undefined` and two materials that differ only by a dropped key would produce
 * identical bytes.
 */
const ABSENT_JOURNAL = Object.freeze({ present: false, length: null, sha256: null });

function fail(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Producer results this module actually computed. See the header. */
const genuineJournals = new WeakSet();
const genuineRetirement = new WeakSet();
const genuineMaterial = new WeakSet();

function isGenuine(set, value) {
  return typeof value === 'object' && value !== null && set.has(value);
}

// =====================================================================
// JOURNAL DESCRIPTORS
// =====================================================================

/**
 * Resolve the two journal paths FROM THE QUEUE THAT WRITES THEM.
 *
 * There is no override and no fallback derivation. The previous shape let a
 * caller name either file, and joined `ATTEMPTS_NAME` onto the directory when it
 * did not — a SECOND derivation of where the queue keeps its sidecars, living in
 * a module that does not own them. Two derivations agree right up until one
 * moves, and on that day the fence permanently binds bytes the queue never
 * wrote, with every internal check still passing.
 *
 * `attemptsPath`/`dispositionsPath` are the exact functions the drain uses
 * (telegram-ingress-drain.js:1041), so there is one owner of that answer.
 */
function resolveJournalPaths(dir) {
  let attemptsFile;
  let dispositionsFile;
  try {
    attemptsFile = queue.attemptsPath(dir);
    dispositionsFile = queue.dispositionsPath(dir);
  } catch (error) {
    return fail(FENCE_REASONS.JOURNAL_PATH_UNRESOLVED, { message: error?.message || String(error) });
  }
  // THE QUEUE'S ANSWER IS CHECKED BEFORE IT IS USED (Architect #125). That the
  // path methods exist says nothing about what they return.
  const usable = (value) => typeof value === 'string' && value.trim() !== '';
  if (!usable(attemptsFile) || !usable(dispositionsFile)) {
    return fail(FENCE_REASONS.JOURNAL_PATH_UNRESOLVED, {
      attempts: usable(attemptsFile),
      dispositions: usable(dispositionsFile),
    });
  }
  // Two journals, two files. Collapsed to one, the same bytes would validate as
  // a clean attempts journal AND a clean dispositions journal.
  if (attemptsFile === dispositionsFile) {
    return fail(FENCE_REASONS.JOURNAL_PATH_COLLISION, { file: attemptsFile });
  }

  // IDENTICAL SPELLING IS THE EASY COLLISION; THE SAME FILE UNDER TWO SPELLINGS
  // IS THE REAL ONE. This machine reaches its workspace through a junction and
  // its filesystem is case-insensitive, so `Delivery-Attempts.jsonl` and a
  // symlinked sibling are the same bytes wearing two names — and the string
  // compare above waves both through.
  //
  // THE PARENT IS CANONICALIZED FIRST, AND AN ABSENT FILE INHERITS IT (Architect
  // #197). Resolving an absent sidecar lexically was the fail-open seam: two
  // journals under two ALIASED parent directories — a junction, a case variant —
  // are the same file the moment either is created, but `path.resolve` preserves
  // both spellings and the comparison below would call them distinct. The route
  // directory exists, so it can always be canonicalized; each sidecar must then
  // be a direct child OF THAT canonical directory, which refuses parent aliasing,
  // route escape and any path that is not where the queue puts it, in one rule.
  const comparable = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  let canonicalRouteDir;
  try {
    canonicalRouteDir = fs.realpathSync.native(path.resolve(dir));
  } catch (error) {
    return fail(FENCE_REASONS.JOURNAL_PATH_UNRESOLVED, {
      reason: 'route_dir_unresolvable',
      message: error?.message || String(error),
    });
  }

  const identity = (file) => {
    const resolved = path.resolve(file);
    let canonicalParent;
    try {
      canonicalParent = fs.realpathSync.native(path.dirname(resolved));
    } catch {
      return null;
    }
    // A DIRECT CHILD OF THE ONE ROUTE DIRECTORY, or nothing. This is what makes
    // an aliased parent a collision rather than a second location.
    if (comparable(canonicalParent) !== comparable(canonicalRouteDir)) return null;
    try {
      // If the file exists, take ITS real identity — that catches a symlinked
      // sidecar pointing at its sibling, which the parent check cannot see.
      return fs.realpathSync.native(resolved);
    } catch (error) {
      // ENOENT IS NOT AN ALIAS FAILURE. An absent journal is a legitimate,
      // separately-hashed state; it inherits the canonical parent so two absent
      // spellings of ONE path still compare equal below.
      if (error && error.code === 'ENOENT') return path.join(canonicalParent, path.basename(resolved));
      return null;
    }
  };
  const attemptsIdentity = identity(attemptsFile);
  const dispositionsIdentity = identity(dispositionsFile);
  if (attemptsIdentity === null || dispositionsIdentity === null) {
    return fail(FENCE_REASONS.JOURNAL_PATH_UNRESOLVED, {
      reason: 'journal_path_not_confined_to_route',
      attempts: attemptsIdentity !== null,
      dispositions: dispositionsIdentity !== null,
    });
  }
  if (comparable(attemptsIdentity) === comparable(dispositionsIdentity)) {
    return fail(FENCE_REASONS.JOURNAL_PATH_ALIASED, {
      attempts: attemptsIdentity,
      dispositions: dispositionsIdentity,
    });
  }
  return { ok: true, attemptsFile, dispositionsFile };
}

/**
 * THE ONE LEGACY SPOOL DIRECTORY, OR A HOLD.
 *
 * `dir` used to be a parameter, which made the single most important question
 * the fence answers — WHICH journals is this permanent statement about — a
 * caller's choice. The spool root comes from the pinned install authority, and
 * the route comes from enumerating what is actually there.
 *
 * EXACTLY ONE ROUTE, OR NOTHING. Zero routes is not "an empty legacy world": it
 * is a root we resolved wrongly or a queue that has not run, and both are holds.
 * Two or more is worse — the fence material carries ONE attempt/disposition
 * pair, so binding one route out of several would silently attest that the
 * others do not exist. Multi-route is a different fence protocol with a
 * different permanent id, and it belongs to a reviewed change, not to a `[0]`.
 */
function resolveLegacySpoolRoute() {
  const installed = resolveInstalledDataRoot();
  // A DEFAULTED ROOT IS NOT AN AUTHORITY. `resolveInstalledDataRoot` falls back
  // to `~/SquidRun` so ordinary callers always get a path; a fence built on that
  // guess would bind an invented directory on any machine whose real root is
  // configured elsewhere. Only env: or manifest: pinning counts here.
  if (!isPinnedInstalledDataRoot(installed)) {
    return fail(FENCE_REASONS.DATA_ROOT_UNPINNED, { source: installed?.source || null });
  }
  const probe = spool.resolveSpoolDir(installed.path, 'probe');
  if (!probe.ok) return fail(FENCE_REASONS.SPOOL_ROOT_UNRESOLVED, { reason: probe.reason });
  const spoolRoot = path.dirname(probe.dir);

  let names;
  try {
    names = fs.readdirSync(spoolRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return fail(FENCE_REASONS.SPOOL_ROUTE_ABSENT, { spoolRoot });
    return fail(FENCE_REASONS.SPOOL_ROOT_UNRESOLVED, { message: error?.message || String(error) });
  }
  // A LINKED ROUTE IS REFUSED, NOT SKIPPED (Architect #197, and the same rule the
  // release scanner uses). On Windows a junction reports as neither a directory
  // nor a file, so `isDirectory()` alone drops it in silence — and a dropped
  // route is one whose journals the fence would permanently claim do not exist.
  const linked = names.filter(
    (entry) => spool.isSafeRouteKey(entry.name)
      && typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()
  );
  if (linked.length > 0) {
    return fail(FENCE_REASONS.SPOOL_ROUTE_UNSAFE, { routes: linked.map((entry) => entry.name).sort() });
  }
  const routes = names
    .filter((entry) => entry.isDirectory() && spool.isSafeRouteKey(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (routes.length === 0) return fail(FENCE_REASONS.SPOOL_ROUTE_ABSENT, { spoolRoot });
  if (routes.length > 1) return fail(FENCE_REASONS.SPOOL_ROUTE_AMBIGUOUS, { routes });

  const resolved = spool.resolveSpoolDir(installed.path, routes[0]);
  if (!resolved.ok) return fail(FENCE_REASONS.SPOOL_ROOT_UNRESOLVED, { reason: resolved.reason });
  // THE ROUTE MUST STILL LIVE UNDER THE SPOOL ROOT AFTER CANONICALIZATION.
  // `resolveSpoolDir` proves the SPELLING stays under the root; it cannot see a
  // junction placed at the route itself, which resolves somewhere else entirely.
  const comparable = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  let canonicalRoute;
  let canonicalSpoolRoot;
  try {
    canonicalRoute = fs.realpathSync.native(resolved.dir);
    canonicalSpoolRoot = fs.realpathSync.native(spoolRoot);
  } catch (error) {
    return fail(FENCE_REASONS.SPOOL_ROOT_UNRESOLVED, { message: error?.message || String(error) });
  }
  const rootPrefix = comparable(canonicalSpoolRoot).endsWith(path.sep)
    ? comparable(canonicalSpoolRoot)
    : `${comparable(canonicalSpoolRoot)}${path.sep}`;
  if (!comparable(canonicalRoute).startsWith(rootPrefix)) {
    return fail(FENCE_REASONS.SPOOL_ROUTE_UNSAFE, {
      route: routes[0],
      canonical: canonicalRoute,
      spoolRoot: canonicalSpoolRoot,
    });
  }
  return { ok: true, dir: resolved.dir, routeKey: routes[0] };
}

/** Raw bytes, or the defined absent state. Only ENOENT is absence. */
function readJournalBytes(file, readFile) {
  try {
    const raw = readFile(file);
    return { ok: true, present: true, buffer: Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8') };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, present: false, buffer: null };
    return fail(FENCE_REASONS.JOURNAL_UNREADABLE, { message: error?.message || String(error) });
  }
}

function describeJournal(read) {
  if (!read.present) return { ...ABSENT_JOURNAL };
  return { present: true, length: read.buffer.length, sha256: sha256(read.buffer) };
}

function descriptorsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * READ, VALIDATE, READ AGAIN — and fingerprint only what the parser accepted.
 *
 * The order is the whole point. Fingerprinting first and validating second
 * would let malformed or self-contradicting state into the fence material, and
 * the fence would then be a stable, permanent, immutable statement about a file
 * nobody could read. The strict Step-1 parser runs against THE EXACT BYTES OF
 * THE FIRST READ — it is handed those bytes rather than the path, so there is
 * no third read and no window in which it could validate something else.
 *
 * The second read closes the gap between "we validated it" and "we hashed it".
 * Any difference at all — appeared, vanished, same length different bytes — is
 * a mutation mid-read, and a fence is not something to derive from a file that
 * is moving.
 */
function readJournalDescriptors(dir) {
  // NO INJECTED READER, ON ANY PATH (Architect #177). This function's entire job
  // is to say what is in those two files; a caller that could supply `readFile`
  // would be answering the question it asked. The call goes through the `fs`
  // namespace object deliberately, so a suite can still drive the mutated- and
  // unreadable-mid-read branches with a spy at the module boundary without
  // production carrying a seam for it.
  const readFile = (file) => fs.readFileSync(file);
  const resolved = resolveJournalPaths(dir);
  if (!resolved.ok) return resolved;
  const { attemptsFile, dispositionsFile } = resolved;

  const reads = { attempts: 0, dispositions: 0 };
  const readBoth = () => {
    reads.attempts += 1;
    const attempts = readJournalBytes(attemptsFile, readFile);
    reads.dispositions += 1;
    const dispositions = readJournalBytes(dispositionsFile, readFile);
    return { attempts, dispositions };
  };

  const first = readBoth();
  if (!first.attempts.ok) return { ...first.attempts, journal: 'attempts', reads };
  if (!first.dispositions.ok) return { ...first.dispositions, journal: 'dispositions', reads };

  // The strict parser, over the FIRST READ'S BYTES, not the path.
  const served = new Map([
    [attemptsFile, first.attempts],
    [dispositionsFile, first.dispositions],
  ]);
  const snapshot = readLegacyJournalSnapshot(dir, {
    attemptsFile,
    dispositionsFile,
    readFile: (file) => {
      const read = served.get(file);
      if (!read || !read.present) {
        const error = new Error(`ENOENT: ${file}`);
        error.code = 'ENOENT';
        throw error;
      }
      return read.buffer.toString('utf8');
    },
  });
  if (!snapshot.ok) {
    return fail(FENCE_REASONS.JOURNAL_INVALID, { reason: snapshot.reason, detail: snapshot.detail || null });
  }

  const second = readBoth();
  if (!second.attempts.ok) return { ...second.attempts, journal: 'attempts', reads };
  if (!second.dispositions.ok) return { ...second.dispositions, journal: 'dispositions', reads };

  const attempt = describeJournal(first.attempts);
  const disposition = describeJournal(first.dispositions);
  if (!descriptorsEqual(attempt, describeJournal(second.attempts))
    || !descriptorsEqual(disposition, describeJournal(second.dispositions))) {
    return fail(FENCE_REASONS.JOURNAL_MUTATED, { reads });
  }

  const result = Object.freeze({
    ok: true,
    schema: JOURNALS_SCHEMA,
    attempt: Object.freeze(attempt),
    disposition: Object.freeze(disposition),
    attemptsFile,
    dispositionsFile,
    reads: Object.freeze({ ...reads }),
  });
  genuineJournals.add(result);
  return result;
}

// =====================================================================
// ORIGINAL-WRITER RETIREMENT — PRIVATE, AND READ FROM THE IMMUTABLE ROW
// =====================================================================

/**
 * Prove the stored capture's author is definitively gone.
 *
 * =====================================================================
 * WHAT REPLACED WHAT, AND WHY IT MOVED HERE
 * =====================================================================
 * The exported `proveOriginalWriterRetired` is GONE, not deprecated (Architect
 * #184). It proved retirement from a caller-supplied generation, session, PID,
 * creation date, executable path and command-line digest: an invented PID that
 * happens to be dead — which is most numbers — plus five invented strings, and
 * the module computed a digest over the assertion until it looked like evidence.
 *
 * Nothing about the predecessor is passed in now. It is read from the immutable
 * singleton capture that the predecessor wrote about ITSELF while it was alive.
 *
 * And it lives HERE, module-private, rather than exported from the capture
 * module (Architect #192). The retirement result is a brand; the fence material
 * that consumes it is minted by a different WeakSet. Two brands in two module
 * closures can only be joined by an exported minter in the middle, which is the
 * exact injection seam this pass exists to close. So the whole brand-consuming
 * sequence — retirement, journals, material, establishment — shares one private
 * closure, and `createOrReuseLegacyFence` is the only thing inside it.
 *
 * FOUR WAYS THE CURRENT GENERATION IS REFUSED AS ITS OWN PREDECESSOR — pid,
 * generation, session and release fingerprint. Four rather than one because each
 * is separately forgeable in a different scenario: a recycled pid, a restarted
 * app reusing a generation string, a replayed session, and a successor whose
 * release somehow matched the capture's. Any single one of them matching means
 * the row is describing US.
 *
 * No probe injection either. A private function with an inert `deps` seam is
 * flexibility nobody can reach; the branches below are driven by mocking
 * `./windows-process-identity` at the module boundary, which costs production
 * nothing.
 */
/**
 * THE TERMINAL SESSION PROOF (capture-only terminal ruling v1, Architect #205).
 *
 * =====================================================================
 * WHY A COMMITTED CAPTURE IS NOT YET A USABLE ONE
 * =====================================================================
 * The capture row commits BEFORE its issuer finishes: before the postcommit
 * reread, before the second disk revalidation of the release it measured, and
 * before the ledger session that names it is closed. So a capture can exist and
 * be perfectly well-formed while the process that wrote it died halfway through
 * proving its own work. Believing that row is believing an unfinished sentence.
 *
 * The terminal session is where the issuer says, durably and once, that it
 * finished — and it names what it observed at each boundary rather than
 * asserting a pair of booleans. A `postcommitOk: true` flag is a claim about an
 * observation; `postcommitReread: { captureId, sessionId }` IS the observation,
 * and it can be compared against the capture that is sitting right there.
 *
 * =====================================================================
 * THREE QUERIES, NOT ONE READ
 * =====================================================================
 * The row alone cannot answer the question. Two of the requirements are facts
 * ABOUT the database that no single row can carry:
 *
 * - the session number is unique. Live history contains duplicate ordinary
 *   session numbers, so `getSessionByNumber(... LIMIT 1)` would happily return
 *   one of two rows and every downstream comparison would pass against the
 *   arbitrary winner. The lookup is therefore by id, and uniqueness of the
 *   number is a separate COUNT.
 * - the session wrote no context. `contextSnapshotCount: 0` inside the document
 *   is the issuer grading its own homework; the count query is the grader. The
 *   document's claim is still checked, because a document that lies about a fact
 *   we can verify independently is itself a finding.
 *
 * A HOLD HERE IS PERMANENT AND HAS NO REPAIR PATH, which is the whole design.
 * Absent, open, duplicated, noncanonical, extra-keyed, context-bearing or
 * mismatched all end here, and none of them may be treated as "not written yet".
 */
function proveCaptureOnlyTerminalSession(db, capture) {
  // THE GUARDS THEMSELVES ARE PART OF THE PROOF. Without them installed, every
  // check below reads a row that any raw statement could have written a second
  // ago, so a database missing the triggers is a database whose terminal
  // documents mean nothing — stale, not merely unguarded.
  const schema = verifyInstalledSchema(db, [...CAPTURE_ONLY_SESSION_SCHEMA_OBJECTS]);
  if (!schema.ok) {
    return fail(CAPTURE_REASONS.SCHEMA_UNVERIFIED, schema.detail || { reason: schema.reason });
  }

  const sessionId = capture.row.writer_session_id;
  let rows;
  try {
    // NO `LIMIT 1`. The primary key makes a second row impossible in a healthy
    // database, and that is exactly why asking for all of them is cheap: if the
    // impossible is true, this is where we find out instead of picking one.
    rows = db.prepare('SELECT * FROM ledger_sessions WHERE session_id = ?').all(sessionId);
  } catch (error) {
    return fail(TERMINAL_REASONS.SESSION_QUERY_FAILED, { message: error?.message || String(error) });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return fail(TERMINAL_REASONS.SESSION_ABSENT, { sessionId });
  }
  if (rows.length > 1) {
    return fail(TERMINAL_REASONS.SESSION_AMBIGUOUS, { sessionId, count: rows.length });
  }
  const row = rows[0];

  if (!CAPTURE_ONLY_SESSION_ID_RE.test(String(row.session_id))) {
    return fail(TERMINAL_REASONS.SESSION_ID_SHAPE, { sessionId: row.session_id });
  }
  if (String(row.mode) !== CAPTURE_ONLY_SESSION_MODE) {
    return fail(TERMINAL_REASONS.SESSION_MODE_WRONG, { mode: row.mode });
  }
  const number = Number(row.session_number);
  if (!isPositiveSafeInteger(number)) {
    return fail(TERMINAL_REASONS.SESSION_NUMBER_INVALID, { number: row.session_number });
  }
  // OPEN IS A HOLD, NOT A WAIT. There is no later moment at which this becomes
  // true: the only writer entitled to close it is a process that has already
  // exited, and the close guard refuses every other one.
  if (row.ended_at_ms === null || row.ended_at_ms === undefined) {
    return fail(TERMINAL_REASONS.SESSION_OPEN, { sessionId });
  }
  const startedAtMs = Number(row.started_at_ms);
  const endedAtMs = Number(row.ended_at_ms);
  const capturedAtMs = Number(capture.row.created_at_ms);
  if (!isPositiveSafeInteger(startedAtMs) || !isPositiveSafeInteger(endedAtMs)
    || !isPositiveSafeInteger(capturedAtMs)) {
    return fail(TERMINAL_REASONS.SESSION_TIMES_INVALID, {
      startedAtMs: row.started_at_ms,
      endedAtMs: row.ended_at_ms,
      capturedAtMs: capture.row.created_at_ms,
    });
  }
  if (startedAtMs > endedAtMs) {
    return fail(TERMINAL_REASONS.SESSION_TIMES_UNORDERED, { startedAtMs, endedAtMs });
  }
  // THE CAPTURE HAS TO HAVE BEEN WRITTEN INSIDE ITS OWN SESSION. A capture
  // stamped outside the window is a row this session did not produce, however
  // well its identifiers line up.
  if (capturedAtMs < startedAtMs || capturedAtMs > endedAtMs) {
    return fail(TERMINAL_REASONS.CAPTURE_TIME_OUTSIDE_SESSION, {
      startedAtMs, capturedAtMs, endedAtMs,
    });
  }
  // PRISTINE EXCEPT FOR THE CLOSE. Normal summary/stats/team are how an ordinary
  // app session describes itself, and a capture-only session that carries them
  // was either written by the generic API or rewritten after the fact.
  if (row.summary !== null && row.summary !== undefined) {
    return fail(TERMINAL_REASONS.SESSION_NOT_PRISTINE, { field: 'summary' });
  }
  if (String(row.stats_json) !== '{}' || String(row.team_json) !== '{}') {
    return fail(TERMINAL_REASONS.SESSION_NOT_PRISTINE, {
      stats: String(row.stats_json), team: String(row.team_json),
    });
  }

  // THE NUMBER IS UNIQUE ACROSS EVERY MODE, asked independently.
  let numberCount;
  try {
    numberCount = db
      .prepare('SELECT COUNT(*) AS n FROM ledger_sessions WHERE session_number = ?')
      .get(number);
  } catch (error) {
    return fail(TERMINAL_REASONS.SESSION_QUERY_FAILED, {
      query: 'duplicate_number', message: error?.message || String(error),
    });
  }
  if (Number(numberCount?.n) !== 1) {
    return fail(TERMINAL_REASONS.SESSION_NUMBER_DUPLICATED, { number, count: Number(numberCount?.n) });
  }

  // AND IT WROTE NO CONTEXT. `ledger_context_snapshots.session_id` is a bare
  // text column with no foreign key, so this is a real question with a real
  // answer rather than a constraint we could have assumed.
  let contextCount;
  try {
    contextCount = db
      .prepare('SELECT COUNT(*) AS n FROM ledger_context_snapshots WHERE session_id = ?')
      .get(row.session_id);
  } catch (error) {
    return fail(TERMINAL_REASONS.CONTEXT_QUERY_FAILED, { message: error?.message || String(error) });
  }
  if (Number(contextCount?.n) !== 0) {
    return fail(TERMINAL_REASONS.CONTEXT_SNAPSHOTS_PRESENT, { count: Number(contextCount?.n) });
  }

  const meta = validateTerminalMetaBytes(row.meta_json);
  if (!meta.ok) return meta;

  // REDERIVE, DO NOT ADOPT. Every equality below is against the independently
  // validated capture row, not against another field of the same document.
  if (meta.meta.session.id !== String(row.session_id)
    || meta.meta.session.id !== String(capture.row.writer_session_id)) {
    return fail(TERMINAL_REASONS.CAPTURE_SESSION_MISMATCH, {
      meta: meta.meta.session.id, row: row.session_id, capture: capture.row.writer_session_id,
    });
  }
  if (meta.meta.session.number !== number) {
    return fail(TERMINAL_REASONS.CAPTURE_SESSION_MISMATCH, { metaNumber: meta.meta.session.number, number });
  }
  if (meta.meta.session.appGeneration !== String(capture.row.writer_app_generation)) {
    return fail(TERMINAL_REASONS.CAPTURE_GENERATION_MISMATCH, {
      meta: meta.meta.session.appGeneration, capture: capture.row.writer_app_generation,
    });
  }
  if (meta.meta.capture.id !== String(capture.row.capture_id)) {
    return fail(TERMINAL_REASONS.CAPTURE_ID_MISMATCH, {
      meta: meta.meta.capture.id, capture: capture.row.capture_id,
    });
  }
  if (meta.meta.capture.capabilityFingerprint !== String(capture.row.capability_fingerprint)) {
    return fail(TERMINAL_REASONS.CAPTURE_FINGERPRINT_MISMATCH);
  }

  return {
    ok: true,
    sessionId: String(row.session_id),
    sessionNumber: number,
    endedAtMs,
  };
}

async function proveStoredWriterRetired(db, successorCapture) {
  const schema = verifyInstalledSchema(db, [...CAPTURE_SCHEMA_OBJECTS]);
  if (!schema.ok) {
    return fail(CAPTURE_REASONS.SCHEMA_UNVERIFIED, schema.detail || { reason: schema.reason });
  }

  const stored = readStoredWriterCapture(db);
  if (!stored.ok) return stored;
  // MISSING IS A HOLD, NEVER A BACKFILL (Oracle #105, ruling v1). This is the
  // branch a machine with no history lands in, and the only correct behaviour is
  // to have no fence. The successor has no issuance path to reach for here —
  // that is the point of it not importing one.
  if (!stored.row) return fail(CAPTURE_REASONS.CAPTURE_ABSENT);

  const writer = stored.material.writer;
  if (writer.pid === process.pid) {
    return fail(CAPTURE_REASONS.NAMES_CURRENT_PROCESS, { pid: writer.pid });
  }

  // UNPUBLISHED AUTHORITY IS A HOLD, NOT A SKIPPED COMPARISON (Architect #187
  // §3). An earlier draft only compared when a value happened to be published,
  // so the way to defeat the self-capture check was to publish nothing — the
  // guard failing open in exactly the state it exists for.
  const generation = currentAppGeneration();
  if (!isNonEmptyString(generation)) return fail(CAPTURE_REASONS.GENERATION_UNPUBLISHED);
  if (writer.appGeneration === generation.trim()) {
    return fail(CAPTURE_REASONS.NAMES_CURRENT_GENERATION, { generation: writer.appGeneration });
  }
  const session = currentAppSchedulingSession();
  if (!isNonEmptyString(session)) return fail(CAPTURE_REASONS.SESSION_UNPUBLISHED);
  if (writer.sessionId === session.trim()) {
    return fail(CAPTURE_REASONS.NAMES_CURRENT_SESSION, { sessionId: writer.sessionId });
  }

  // THE RELEASE THAT ISSUED IT CANNOT BE THE RELEASE READING IT, and the
  // successor's fingerprint comes from ITS OWN BRANDED FROZEN CAPTURE — never a
  // caller string, which was the previous shape and made the whole check
  // optional. A stored capability fingerprint equal to ours would mean one
  // release measured as both worlds, which is not a close call.
  if (!isGenuineCapture(successorCapture) || successorCapture.ok !== true
    || !SHA256_RE.test(String(successorCapture.fingerprint))) {
    return fail(CAPTURE_REASONS.SUCCESSOR_CAPTURE_MISSING);
  }
  if (stored.material.capability.fingerprint === successorCapture.fingerprint) {
    return fail(CAPTURE_REASONS.NAMES_CURRENT_RELEASE, { fingerprint: successorCapture.fingerprint });
  }

  // THE ISSUER HAS TO HAVE FINISHED, and that is asked BEFORE the OS probe on
  // purpose. Whether the predecessor process is alive is a question about the
  // world; whether its capture was ever completed is a question about this
  // database, and there is no reason to interrogate the operating system on
  // behalf of a capture that was never closed out.
  //
  // The result is a GATE, not new material. Nothing here enters the canonical
  // fence material or the derived id — the terminal session is the condition
  // under which the stored capture may be believed at all, and folding it into
  // the material would change a reviewed schema and remint every fence id for a
  // fact that is about admissibility rather than identity.
  const terminal = proveCaptureOnlyTerminalSession(db, stored);
  if (!terminal.ok) return terminal;

  const probed = await probeProcessStartIdentity(writer.pid);
  if (probed && probed.ok === true) {
    // LIVE OR REUSED, BOTH HOLD — but the EVIDENCE CLASS has to stay true
    // (Architect #187 §4). Comparing the command-line digest alone called a
    // reused PID running the same command line "the exact owner is still alive",
    // which is a different fact with different consequences. Full identity
    // equality — creation date, executable and command line, both sides carrying
    // the schema — is what distinguishes them. Calling PID reuse proof of death
    // remains the temptation Architect #174 refused.
    const exactOwnerLive = processIdentitiesEqual(probed.identity, {
      schema: PROCESS_IDENTITY_SCHEMA,
      pid: writer.pid,
      creationDate: writer.processCreatedAt,
      executablePath: writer.executablePath,
      commandLineSha256: writer.commandLineSha256,
    });
    return fail(
      exactOwnerLive ? CAPTURE_REASONS.OWNER_LIVE : CAPTURE_REASONS.OWNER_IDENTITY_MISMATCH,
      { pid: writer.pid }
    );
  }
  if (!probed || probed.absent !== true) {
    return fail(CAPTURE_REASONS.OWNER_UNVERIFIABLE, { reason: probed?.reason || 'no_probe_result' });
  }

  // THE OBSERVATION DIGEST CARRIES NO CLOCK AND NO PROBE REASON. Both vary
  // between G and G+1 for the same fact, and the fence id derives from this
  // value — a digest that moved would remint the fence on every boot, which is
  // the one thing a STABLE legacy fence may not do.
  const observation = {
    schema: RETIREMENT_OBSERVATION_SCHEMA,
    captureId: stored.row.capture_id,
    pid: writer.pid,
    observation: 'definitively_absent',
  };
  const result = Object.freeze({
    ok: true,
    schema: RETIREMENT_OBSERVATION_SCHEMA,
    captureId: stored.row.capture_id,
    retired: Object.freeze({
      identitySchema: writer.identitySchema,
      appGeneration: writer.appGeneration,
      sessionId: writer.sessionId,
      pid: writer.pid,
      processCreatedAt: writer.processCreatedAt,
      executablePath: writer.executablePath,
      commandLineSha256: writer.commandLineSha256,
      retirementEvidenceSha256: sha256(canonicalJson(observation)),
    }),
  });
  genuineRetirement.add(result);
  return result;
}

// =====================================================================
// CANONICAL MATERIAL AND THE ID
// =====================================================================

/**
 * Assemble the one versioned canonical object.
 *
 * `decisionCutoverId` IS NOT AN INPUT (cutover-authority ruling v1). The key is
 * refused if a caller supplies it at all — not merely if it disagrees — which
 * kills the caller override, the duplicated local literal, and the substitution
 * of `TELEGRAM_CUTOVER_ID` with one rule instead of three. The value comes from
 * the release-owned export, imported.
 */
function buildFenceMaterial(input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, 'decisionCutoverId')) {
    return fail(FENCE_REASONS.MATERIAL_CUTOVER_OVERRIDE);
  }
  for (const key of ['fenceId', 'legacyFenceId', 'canonicalMaterialSha256']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      return fail(FENCE_REASONS.MATERIAL_ID_ASSERTED, { key });
    }
  }
  if (!isGenuine(genuineJournals, input.journals)) {
    return fail(FENCE_REASONS.MATERIAL_INPUT_FORGED, { input: 'journals' });
  }
  if (!isGenuine(genuineRetirement, input.retirement)) {
    return fail(FENCE_REASONS.MATERIAL_INPUT_FORGED, { input: 'retirement' });
  }

  // THE RELEASE IS REVALIDATED HERE, NOT TRUSTED FROM STARTUP. The capture is
  // the generation's frozen claim; this call is what makes the material a
  // statement about the code on disk right now as well.
  const release = verifyLoadedReleaseUnchanged(input.releaseCapture);
  if (!release.ok) return release;

  const capture = input.releaseCapture;
  // ONE FINGERPRINT, NOT A NESTED MANIFEST SCHEMA (Architect #178 §6). v7 §4
  // names exactly one release/call-graph field, and that value already binds
  // the scanner version, every file digest, the anchors and the reachability
  // inputs. Expanding the canonical object here would quietly define a second,
  // unreviewed fence protocol with a different permanent id — the manifest
  // digest, file count and byte total remain STORED and revalidated, as
  // diagnostics, which is a different job from being material.
  const material = {
    fenceVersion: FENCE_VERSION,
    decisionCutoverId: DECISION_CUTOVER_ID,
    attemptJournal: { ...input.journals.attempt },
    dispositionJournal: { ...input.journals.disposition },
    retiredWriter: { ...input.retirement.retired },
    loadedReleaseFingerprint: capture.fingerprint,
  };
  const result = Object.freeze({
    ok: true,
    schema: MATERIAL_SCHEMA,
    material,
    canonical: canonicalJson(material),
    fenceId: deriveFenceId(material),
    // Non-canonical, carried alongside so the row can store them.
    diagnostics: Object.freeze({
      releaseManifestSha256: capture.manifestSha256,
      releaseFileCount: capture.fileCount,
      releaseTotalBytes: capture.totalBytes,
      releaseScanner: capture.material.scanner,
    }),
  });
  genuineMaterial.add(result);
  return result;
}

/** The exact key set of a canonical fence object. Nothing more, nothing less. */
const MATERIAL_KEYS = Object.freeze([
  'attemptJournal', 'decisionCutoverId', 'dispositionJournal',
  'fenceVersion', 'loadedReleaseFingerprint', 'retiredWriter',
]);

const RETIRED_WRITER_KEYS = Object.freeze([
  'appGeneration', 'commandLineSha256', 'executablePath', 'identitySchema',
  'pid', 'processCreatedAt', 'retirementEvidenceSha256', 'sessionId',
]);

const DESCRIPTOR_KEYS = Object.freeze(['length', 'present', 'sha256']);

function keysExactly(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function descriptorValid(descriptor) {
  if (!keysExactly(descriptor, DESCRIPTOR_KEYS)) return false;
  if (descriptor.present === false) return descriptor.length === null && descriptor.sha256 === null;
  if (descriptor.present !== true) return false;
  return typeof descriptor.length === 'number'
    && Number.isSafeInteger(descriptor.length)
    && descriptor.length >= 0
    && SHA256_RE.test(descriptor.sha256);
}

/**
 * SEMANTIC validation of material, not merely self-consistency (Architect #178 §4).
 *
 * A stored row can be internally perfect and still describe a fence this build
 * must not honour: a `fenceVersion` from a protocol nobody reviewed, a cutover
 * id that is not the release-owned one, an identity schema from a different
 * process-identity rule. Self-consistency proves the row was not corrupted;
 * this proves it is OURS. And the constants come from the imports at the top of
 * this file — never from the blob being validated, which would be the blob
 * vouching for itself.
 */
function validateMaterialSemantics(material) {
  if (!keysExactly(material, MATERIAL_KEYS)) {
    return fail(FENCE_REASONS.MATERIAL_SHAPE, { keys: material && typeof material === 'object' ? Object.keys(material).sort() : null });
  }
  if (material.fenceVersion !== FENCE_VERSION) {
    return fail(FENCE_REASONS.MATERIAL_VERSION, { fenceVersion: material.fenceVersion });
  }
  if (material.decisionCutoverId !== DECISION_CUTOVER_ID) {
    return fail(FENCE_REASONS.MATERIAL_CUTOVER_WRONG, { decisionCutoverId: material.decisionCutoverId });
  }
  if (!SHA256_RE.test(material.loadedReleaseFingerprint)) {
    return fail(FENCE_REASONS.MATERIAL_SHAPE, { field: 'loadedReleaseFingerprint' });
  }
  if (!descriptorValid(material.attemptJournal) || !descriptorValid(material.dispositionJournal)) {
    return fail(FENCE_REASONS.MATERIAL_SHAPE, { field: 'journalDescriptor' });
  }
  const writer = material.retiredWriter;
  if (!keysExactly(writer, RETIRED_WRITER_KEYS)) {
    return fail(FENCE_REASONS.MATERIAL_SHAPE, { field: 'retiredWriter' });
  }
  if (writer.identitySchema !== PROCESS_IDENTITY_SCHEMA) {
    return fail(FENCE_REASONS.MATERIAL_IDENTITY_SCHEMA, { identitySchema: writer.identitySchema });
  }
  if (!isPositiveInteger(writer.pid)) return fail(FENCE_REASONS.MATERIAL_SHAPE, { field: 'retiredWriter.pid' });
  if (!SHA256_RE.test(writer.commandLineSha256) || !SHA256_RE.test(writer.retirementEvidenceSha256)) {
    return fail(FENCE_REASONS.MATERIAL_SHAPE, { field: 'retiredWriter.digests' });
  }
  for (const field of ['appGeneration', 'sessionId', 'processCreatedAt', 'executablePath']) {
    if (!isNonEmptyString(writer[field])) return fail(FENCE_REASONS.MATERIAL_SHAPE, { field: `retiredWriter.${field}` });
  }
  return { ok: true };
}

/** `lf1_` + the SHA-256 of the canonical bytes. Lowercase hex, exactly. */
function deriveFenceId(material) {
  return `${FENCE_ID_PREFIX}${sha256(canonicalJson(material))}`;
}

// =====================================================================
// THE DURABLE ROW
// =====================================================================

const FENCE_COLUMNS = Object.freeze([
  'fence_id', 'fence_slot', 'fence_version', 'decision_cutover_id',
  'attempt_present', 'attempt_length', 'attempt_sha256',
  'disposition_present', 'disposition_length', 'disposition_sha256',
  'retired_identity_schema', 'retired_app_generation', 'retired_session_id',
  'retired_pid', 'retired_process_created_at', 'retired_executable_path',
  'retired_command_line_sha256', 'retirement_evidence_sha256',
  'release_fingerprint', 'release_manifest_sha256', 'release_file_count',
  'release_total_bytes', 'canonical_material_json', 'created_at_ms',
]);

/** Columns that ARE the material. `created_at_ms` is deliberately not one. */
const FENCE_MATERIAL_COLUMNS = Object.freeze(
  FENCE_COLUMNS.filter((column) => column !== 'created_at_ms')
);

function rowFromMaterial(material, fenceId, diagnostics, nowMs) {
  const { attemptJournal: attempt, dispositionJournal: disposition, retiredWriter: writer } = material;
  return {
    fence_id: fenceId,
    fence_slot: 1,
    fence_version: material.fenceVersion,
    decision_cutover_id: material.decisionCutoverId,
    attempt_present: attempt.present ? 1 : 0,
    attempt_length: attempt.present ? attempt.length : null,
    attempt_sha256: attempt.present ? attempt.sha256 : null,
    disposition_present: disposition.present ? 1 : 0,
    disposition_length: disposition.present ? disposition.length : null,
    disposition_sha256: disposition.present ? disposition.sha256 : null,
    retired_identity_schema: writer.identitySchema,
    retired_app_generation: writer.appGeneration,
    retired_session_id: writer.sessionId,
    retired_pid: writer.pid,
    retired_process_created_at: writer.processCreatedAt,
    retired_executable_path: writer.executablePath,
    retired_command_line_sha256: writer.commandLineSha256,
    retirement_evidence_sha256: writer.retirementEvidenceSha256,
    release_fingerprint: material.loadedReleaseFingerprint,
    // Stored evidence, revalidated on reread, and NOT canonical material.
    release_manifest_sha256: diagnostics.releaseManifestSha256,
    release_file_count: diagnostics.releaseFileCount,
    release_total_bytes: diagnostics.releaseTotalBytes,
    canonical_material_json: canonicalJson(material),
    created_at_ms: nowMs,
  };
}

/**
 * Rebuild the canonical material FROM THE STORED COLUMNS.
 *
 * This is what makes the three-way agreement real: the columns are re-serialised
 * independently, and the result has to equal both the stored blob and the id.
 * A row with one edited field breaks at least two of those three.
 */
function materialFromRow(row) {
  const descriptor = (present, length, digest) => (present === 1
    ? { present: true, length, sha256: digest }
    : { ...ABSENT_JOURNAL });
  return {
    fenceVersion: row.fence_version,
    decisionCutoverId: row.decision_cutover_id,
    attemptJournal: descriptor(row.attempt_present, row.attempt_length, row.attempt_sha256),
    dispositionJournal: descriptor(row.disposition_present, row.disposition_length, row.disposition_sha256),
    retiredWriter: {
      identitySchema: row.retired_identity_schema,
      appGeneration: row.retired_app_generation,
      sessionId: row.retired_session_id,
      pid: row.retired_pid,
      processCreatedAt: row.retired_process_created_at,
      executablePath: row.retired_executable_path,
      commandLineSha256: row.retired_command_line_sha256,
      retirementEvidenceSha256: row.retirement_evidence_sha256,
    },
    // FROM THE COLUMN, NEVER FROM THE BLOB (Architect #178 §4). An earlier draft
    // read the scanner version out of `canonical_material_json` in order to
    // rebuild the object it was about to compare against that same blob — a
    // check that can only ever agree with itself.
    loadedReleaseFingerprint: row.release_fingerprint,
  };
}

/**
 * The stored fence, with its internal agreement checked.
 *
 * A row that does not re-derive its own id is not a fence with a problem; it is
 * not a fence, and reporting it as one would be the confident nonsense this
 * lane keeps finding.
 */
function readStoredFence(db) {
  let rows;
  try {
    rows = db.prepare(`SELECT ${FENCE_COLUMNS.join(', ')} FROM telegram_legacy_cutover_fences`).all();
  } catch (error) {
    return fail(FENCE_REASONS.STORE_UNAVAILABLE, { message: error?.message || String(error) });
  }
  if (rows.length === 0) return { ok: true, row: null, material: null };
  if (rows.length > 1) return fail(FENCE_REASONS.ROW_COUNT_INVALID, { rows: rows.length });

  const [row] = rows;
  if (!FENCE_ID_RE.test(String(row.fence_id))) {
    return fail(FENCE_REASONS.ROW_INCOHERENT, { reason: 'stored_id_is_not_an_lf1_id' });
  }
  if (row.fence_slot !== 1) {
    return fail(FENCE_REASONS.ROW_INCOHERENT, { reason: 'stored_row_is_not_the_singleton_slot' });
  }
  let material;
  try {
    material = materialFromRow(row);
  } catch (error) {
    return fail(FENCE_REASONS.ROW_INCOHERENT, { message: error?.message || String(error) });
  }
  // WHAT THIS BUILD RECOGNISES, checked against this build's constants.
  const semantics = validateMaterialSemantics(material);
  if (!semantics.ok) return { ...semantics, storedFenceId: row.fence_id };
  for (const [column, valid] of [
    ['release_manifest_sha256', SHA256_RE.test(String(row.release_manifest_sha256))],
    ['release_file_count', isPositiveInteger(row.release_file_count)],
    ['release_total_bytes', isPositiveInteger(row.release_total_bytes)],
    ['created_at_ms', isPositiveInteger(row.created_at_ms)],
  ]) {
    if (!valid) return fail(FENCE_REASONS.ROW_INCOHERENT, { reason: `invalid_${column}` });
  }
  const canonical = canonicalJson(material);
  if (canonical !== row.canonical_material_json) {
    return fail(FENCE_REASONS.ROW_INCOHERENT, { reason: 'columns_disagree_with_stored_material' });
  }
  if (deriveFenceId(material) !== row.fence_id) {
    return fail(FENCE_REASONS.ROW_INCOHERENT, { reason: 'stored_material_does_not_derive_stored_id' });
  }
  return { ok: true, row, material, canonical };
}

/**
 * Insert the fence, or reread the one that is already there — in ONE
 * `BEGIN IMMEDIATE`.
 *
 * The transaction boundary is the writer's, so this cannot half-commit, and
 * IMMEDIATE means two concurrent generations collide at BEGIN rather than
 * half-way through. An existing row with a DIFFERENT id is a conflict and never
 * a second insert: a release or a journal that moved is a cutover violation
 * requiring review, not a reason to mint a successor fence.
 */
function establishFence(writer, input = {}) {
  // ONLY A MATERIAL RESULT THIS MODULE ISSUED (Architect #178 §2). Accepting a
  // caller's `{material, fenceId}` meant an alternate world could be assembled
  // by hand, self-consistently derived, and inserted — every WeakSet above it
  // bypassed, because none of them were on this path.
  const built = input.built;
  if (!isGenuine(genuineMaterial, built)) {
    return fail(FENCE_REASONS.MATERIAL_UNBRANDED);
  }
  const { material, fenceId, diagnostics } = built;
  const semantics = validateMaterialSemantics(material);
  if (!semantics.ok) return semantics;
  if (deriveFenceId(material) !== fenceId) {
    return fail(FENCE_REASONS.MATERIAL_ID_ASSERTED, { reason: 'id_does_not_derive_from_material' });
  }
  const nowMs = isPositiveInteger(input.nowMs) ? input.nowMs : Date.now();

  return writer.transaction((db) => {
    const schema = verifyInstalledSchema(db, [...FENCE_SCHEMA_OBJECTS]);
    if (!schema.ok) return fail(FENCE_REASONS.SCHEMA_UNVERIFIED, schema.detail || { reason: schema.reason });

    const existing = readStoredFence(db);
    if (!existing.ok) return existing;

    const row = rowFromMaterial(material, fenceId, diagnostics, nowMs);
    if (existing.row) {
      if (existing.row.fence_id !== fenceId) {
        return fail(FENCE_REASONS.ROW_CONFLICT, { stored: existing.row.fence_id, derived: fenceId });
      }
      const mismatched = FENCE_MATERIAL_COLUMNS.filter((column) => existing.row[column] !== row[column]);
      if (mismatched.length > 0) {
        return fail(FENCE_REASONS.ROW_MISMATCH, { columns: mismatched });
      }
      return { ok: true, created: false, fenceId, row: existing.row };
    }

    try {
      db.prepare(
        `INSERT INTO telegram_legacy_cutover_fences (${FENCE_COLUMNS.join(', ')})
         VALUES (${FENCE_COLUMNS.map(() => '?').join(', ')})`
      ).run(...FENCE_COLUMNS.map((column) => row[column]));
    } catch (error) {
      return fail(FENCE_REASONS.INSERT_FAILED, { message: error?.message || String(error) });
    }

    // READ IT BACK INSIDE THE SAME TRANSACTION. An insert that "succeeded" and
    // a row that reads back correctly are different facts, and this lane's
    // worst defect class is accepting the first as the second.
    const stored = readStoredFence(db);
    if (!stored.ok) return stored;
    if (!stored.row || stored.row.fence_id !== fenceId) {
      return fail(FENCE_REASONS.ROW_MISSING, { reason: 'insert_did_not_land' });
    }
    return { ok: true, created: true, fenceId, row: stored.row };
  });
}

// =====================================================================
// PHASE-L READINESS — THE LEGACY WORLD MUST BE SETTLED, NOT MERELY OLD
// =====================================================================

/**
 * The four readiness proofs (#178 §3), from the authoritative queue state.
 *
 * =====================================================================
 * WHY THIS EXISTS AT ALL
 * =====================================================================
 * Everything else in this module proves the fence DESCRIBES the world
 * accurately. None of it asks whether the world is in a state worth describing.
 * A queue with one legacy record still pending, or one attempt whose disposition
 * was never written, is a legacy world that is not finished — and a permanent,
 * immutable, content-derived statement that it is CLOSED would then be exactly
 * wrong, forever, with every digest in it perfectly correct.
 *
 * `readJournalDescriptors` cannot catch this: an empty directory yields two
 * valid ABSENT sentinels and hashes beautifully. Absence of bytes is not
 * settlement.
 *
 * =====================================================================
 * THE FOUR
 * =====================================================================
 *   1. No legacy source remains pending.
 *   2. No reviewed recovery disposition remains to be written.
 *   3. No exact legacy-capable writer/owner is active or unknown.
 *   4. Any queued source is explicit coherent `decision_v1`, still
 *      scheduling-held.
 *
 * Proof 3 is not re-probed here. It is BOUND to the retirement result, which
 * only exists when the stored capture's exact owner came back DEFINITIVELY
 * ABSENT from a real OS probe — re-asking would be a second, weaker answer to a
 * question already answered by the stronger authority, and two answers is how a
 * disagreement gets resolved in favour of whichever ran last.
 */
function proveLegacyPhaseReadiness(dir, retirement) {
  // 3. THE OWNER. Bound to the branded retirement, never re-derived.
  if (!isGenuine(genuineRetirement, retirement) || retirement.ok !== true) {
    return fail(FENCE_REASONS.PHASE_L_OWNER_UNPROVEN);
  }

  // 4a. THE PROCESS IS ACTUALLY IN PHASE L, ON THE COORDINATOR'S AUTHORITY.
  //
  // This check used to compare this module's own `SCHEDULING_ENABLED` and
  // `SCHEDULING_HOLD` against themselves, which is a module asserting that a
  // module said so (Architect #202). Those constants are output formatting; a
  // local `false` can sit here unchanged while the live app schedules from a
  // frozen mode this file never saw.
  //
  // The authoritative value is the ONE-TIME startup freeze that
  // `telegram-ingress-drain` resolves through `activationMode()`. It is read
  // here from the same publication, never re-derived from settings and never
  // accepted from a caller — a second settings read would be a second answer,
  // and this lane's defect history is two readers disagreeing quietly.
  const frozen = currentFrozenActivationMode();
  if (!frozen.frozen) {
    return fail(FENCE_REASONS.PHASE_L_MODE_NOT_FROZEN);
  }
  // NEVER FROZEN, FROZEN-AS-UNSET and FROZEN-AS-UNKNOWN are three different
  // facts with three different fixes. `resolveActivationMode` is the same total
  // resolver the coordinator uses, so an unrecognised value cannot be read as
  // Phase L here while the drain refuses it (or the reverse).
  const resolved = resolveActivationMode(frozen.mode);
  if (!resolved.ok) {
    return fail(FENCE_REASONS.PHASE_L_MODE_UNRECOGNIZED, {
      reason: resolved.reason,
      detail: resolved.detail || null,
    });
  }
  if (resolved.mode !== LEGACY_SETTLEMENT) {
    return fail(FENCE_REASONS.PHASE_L_MODE_NOT_SETTLEMENT, { mode: resolved.mode });
  }
  // Only AFTER the production authority passes do this module's own hold
  // constants get to describe the result. If they ever disagree with the mode
  // above, the disagreement is the finding.
  if (SCHEDULING_ENABLED !== false || !isNonEmptyString(SCHEDULING_HOLD)) {
    return fail(FENCE_REASONS.PHASE_L_SCHEDULING_NOT_HELD, { schedulingHold: SCHEDULING_HOLD });
  }

  let pending;
  let attempts;
  let dispositions;
  try {
    pending = queue.readPending(dir);
    attempts = queue.readAttemptRecords(dir);
    dispositions = queue.readDispositions(dir);
  } catch (error) {
    // A TORN OR UNPARSEABLE JOURNAL IS A HOLD, NOT AN EMPTY ONE. The queue's
    // readers throw on a torn tail precisely so nobody reads "no records" out of
    // "I could not tell".
    return fail(FENCE_REASONS.PHASE_L_QUEUE_UNREADABLE, { message: error?.message || String(error) });
  }

  // 1 and 4b. EVERY PENDING SOURCE IS EXPLICIT, COHERENT `decision_v1`.
  //
  // One loop, because "no legacy pending" and "anything queued is decision_v1"
  // are the same sweep asked twice, and splitting them into two passes over the
  // same list is how the two drift apart. An unstamped record is legacy by
  // definition (`classifySourceRecord`), so it fails as legacy-pending; a
  // stamped one must carry THIS release's protocol and THIS cutover id, because
  // a record stamped by a protocol nobody reviewed is not a record this build
  // may declare settled.
  const legacyPending = [];
  const unrecognized = [];
  for (const record of pending) {
    const stamped = readStampedProtocol(record);
    if (!stamped) {
      legacyPending.push(record.updateId);
      continue;
    }
    if (stamped.transportProtocol !== TRANSPORT_PROTOCOL_V1
      || stamped.decisionCutoverId !== DECISION_CUTOVER_ID) {
      unrecognized.push({
        updateId: record.updateId,
        transportProtocol: stamped.transportProtocol,
        decisionCutoverId: stamped.decisionCutoverId,
      });
    }
  }
  if (legacyPending.length > 0) {
    return fail(FENCE_REASONS.PHASE_L_LEGACY_PENDING, { updateIds: legacyPending.sort((a, b) => a - b) });
  }
  if (unrecognized.length > 0) {
    return fail(FENCE_REASONS.PHASE_L_SOURCE_UNRECOGNIZED, { sources: unrecognized });
  }

  // 2. EVERY ATTEMPT HAS ITS DISPOSITION.
  //
  // An attempt without one is a delivery whose outcome was never recorded — the
  // exact shape of the wedge this whole lane exists to repair. Deliberately not
  // filtered by attempt state: "which states still owe a disposition" is a
  // policy that can change, and a fence that silently stopped covering a state
  // would be attesting to settlement it never checked.
  const outstanding = [];
  for (const updateId of attempts.keys()) {
    if (!dispositions.has(updateId)) outstanding.push(updateId);
  }
  if (outstanding.length > 0) {
    return fail(FENCE_REASONS.PHASE_L_DISPOSITION_OUTSTANDING, {
      updateIds: outstanding.sort((a, b) => a - b),
    });
  }

  return {
    ok: true,
    pendingSources: pending.length,
    attemptRecords: attempts.size,
    dispositionRecords: dispositions.size,
  };
}

// =====================================================================
// THE SUCCESSOR AUTHORITY — ONE SEQUENCE, NOTHING INJECTED, NO BRAND OUT
// =====================================================================

/**
 * THIS GENERATION'S FROZEN RELEASE CAPTURE, HELD PRIVATELY.
 *
 * The app used to hold it (`SquidRunApp.telegramLoadedRelease`) and hand it to
 * the fence. That is a caller-supplied release by any other name: the object
 * carries the brand every downstream check trusts, so whoever holds it decides
 * what "the release that is running" means. It lives here now, and there is no
 * setter — `captureStartupRelease` computes it from the real module cache and
 * the real filesystem, once, and stores it where only this closure can read it.
 *
 * The capture is deliberately NOT returned. Callers get a summary of strings and
 * numbers; the branded object never leaves this module.
 */
let frozenReleaseCapture = null;
let frozenReleaseFailure = null;
let releaseCaptureTaken = false;

/** Strings and numbers only. The brand stays inside. */
function releaseCaptureStatus() {
  if (!releaseCaptureTaken) return fail(FENCE_REASONS.RELEASE_NOT_FROZEN);
  if (frozenReleaseCapture === null) {
    return fail(FENCE_REASONS.RELEASE_CAPTURE_FAILED, { reason: frozenReleaseFailure });
  }
  return {
    ok: true,
    fingerprint: frozenReleaseCapture.fingerprint,
    manifestSha256: frozenReleaseCapture.manifestSha256,
    fileCount: frozenReleaseCapture.fileCount,
    totalBytes: frozenReleaseCapture.totalBytes,
  };
}

/**
 * Freeze the loaded release for this generation. Call once, at startup, before
 * any drain or scheduling authority exists (loaded-release ruling v1).
 *
 * TAKES NOTHING AND RETURNS NO BRAND. A FAILED CAPTURE IS STORED AS THE FAILURE
 * and never retried: an ambiguous root or a reachable legacy writer is a reason
 * to hold the fence, and re-asking after startup would just be asking a
 * different question of a different world.
 */
function captureStartupRelease() {
  if (releaseCaptureTaken) return releaseCaptureStatus();
  releaseCaptureTaken = true;
  let captured;
  try {
    captured = captureLoadedRelease();
  } catch (error) {
    captured = { ok: false, reason: 'release_capture_threw', detail: { message: error?.message || String(error) } };
  }
  if (captured && captured.ok === true && isGenuineCapture(captured)) {
    frozenReleaseCapture = captured;
    frozenReleaseFailure = null;
  } else {
    frozenReleaseCapture = null;
    frozenReleaseFailure = (captured && captured.reason) || 'release_capture_unbranded';
  }
  return releaseCaptureStatus();
}

/**
 * Does the process asking own scheduling right now?
 *
 * NOTHING IS CLAIMED AND NOTHING IS COMPARED TO A CLAIM. The previous shape took
 * an `appGeneration` from the caller and checked it against the published one,
 * which reads like a guard and is actually a formality: the only party that ever
 * called it also chose what to claim. Ownership is now simply READ from the two
 * published authorities, and an unpublished one is a HOLD rather than a blank —
 * an empty authority is the correct answer to "who owns scheduling" before
 * anyone does.
 */
function proveSchedulingOwnership() {
  const appGeneration = currentAppGeneration();
  if (!isNonEmptyString(appGeneration)) return fail(FENCE_REASONS.OWNER_UNPUBLISHED);
  const sessionId = currentAppSchedulingSession();
  if (!isNonEmptyString(sessionId)) return fail(FENCE_REASONS.OWNER_SESSION_MISSING);
  return { ok: true, appGeneration: appGeneration.trim(), sessionId: sessionId.trim() };
}

/**
 * The production admission writer, opened and identity-verified by its own
 * `open()` — WAL, `synchronous=FULL`, foreign keys, and `PRAGMA database_list`
 * proving the handle is attached to the file we intended. A durable handle onto
 * the wrong database is worse than no handle: it writes a perfect, fully
 * attested fence into a file nobody reads.
 */
function acquireAdmissionWriter(sessionId) {
  const writer = new TelegramAdmissionWriter({ sessionId });
  let opened;
  try {
    opened = writer.open();
  } catch (error) {
    try { writer.close(); } catch { /* nothing was opened */ }
    return fail(FENCE_REASONS.WRITER_UNAVAILABLE, { message: error?.message || String(error) });
  }
  if (!opened || opened.ok !== true) {
    try { writer.close(); } catch { /* nothing was opened */ }
    return fail(FENCE_REASONS.WRITER_UNAVAILABLE, { reason: opened?.reason || 'writer_open_no_result' });
  }
  return { ok: true, writer, dbPath: opened.dbPath };
}

/**
 * THE ONE PRODUCTION SUCCESSOR SEQUENCE. Create the fence, or reread the exact
 * one already there.
 *
 * =====================================================================
 * WHY THIS FUNCTION TAKES NOTHING
 * =====================================================================
 * Every argument it could take is an argument somebody could invent, and each
 * one was a real hole an hour ago: a `db` handle chose which database the
 * permanent statement landed in; a `dir` chose which journals it was about; an
 * `owner` chose which generation was current; a `releaseCapture` chose what code
 * was running; a `probe` chose whether the predecessor was alive. Guarding each
 * of them with a stronger check is the move that does not work, because the
 * checks were being handed their own answers.
 *
 * So: no arguments, and the acquisition IS the authority. Generation and session
 * from the published env authority; the spool from the pinned install root and
 * exactly one enumerated route; the journal paths from the queue that writes
 * them; the release from this module's own frozen startup capture; the database
 * from a writer this function opens and whose identity `open()` verifies; the
 * liveness answer from the real top-level OS probe.
 *
 * =====================================================================
 * NO BRAND CROSSES THE BOUNDARY, IN EITHER DIRECTION
 * =====================================================================
 * The journals, retirement and material results are minted by three private
 * WeakSets in this closure and are consumed inside this one call. The result
 * handed back is strings and booleans. A caller cannot supply one and cannot
 * keep one, which is what makes `establishFence`'s brand check meaningful rather
 * than decorative (Architect #192).
 *
 * It is READ-ONLY OVER THE CAPTURE. There is no issuance path here and no
 * backfill: a machine with no predecessor capture gets `writer_capture_absent`
 * and no fence, permanently, until a real `P` issues one (ruling v1, Oracle
 * #105). That blocked rollout is the honest outcome — the alternative is a
 * successor writing the record of its own predecessor.
 */
async function createOrReuseLegacyFence() {
  // 1. THE RELEASE THIS GENERATION LOADED. Frozen at startup, never a parameter.
  const releaseStatus = releaseCaptureStatus();
  if (!releaseStatus.ok) return releaseStatus;
  const releaseCapture = frozenReleaseCapture;

  // 2. WHO OWNS SCHEDULING. Published authority, HOLD when either is missing.
  const owner = proveSchedulingOwnership();
  if (!owner.ok) return owner;

  // 3. WHICH JOURNALS. Pinned root, exactly one route, queue-owned paths.
  const route = resolveLegacySpoolRoute();
  if (!route.ok) return route;
  const journals = readJournalDescriptors(route.dir);
  if (!journals.ok) return journals;

  // 4. THE DATABASE. Opened here, identity verified by the writer itself.
  const acquired = acquireAdmissionWriter(owner.sessionId);
  if (!acquired.ok) return acquired;
  const { writer } = acquired;

  try {
    // 5. THE PREDECESSOR IS DEFINITIVELY GONE, read from its own immutable row.
    const retirement = await proveStoredWriterRetired(writer.db, releaseCapture);
    if (!retirement.ok) return retirement;

    // 5b. THE LEGACY WORLD IS SETTLED, not merely old. Absence of bytes in a
    //     journal is not settlement, and an empty directory hashes perfectly.
    const readiness = proveLegacyPhaseReadiness(route.dir, retirement);
    if (!readiness.ok) return readiness;

    // 6. THE MATERIAL, from three branded producer results and nothing else.
    const built = buildFenceMaterial({ journals, retirement, releaseCapture });
    if (!built.ok) return built;

    // 7. ONE `BEGIN IMMEDIATE`: insert, or reread the identical row.
    const established = establishFence(writer, { built });
    if (!established.ok) return established;

    // 8. POST-COMMIT REREAD, OUTSIDE THE TRANSACTION.
    //
    // The in-transaction reread proves the insert landed in the transaction's
    // own view. This one proves it survived the commit and re-derives its id
    // from the columns as an independent reader would — the difference between
    // "the write returned success" and "the row is there", which is this lane's
    // worst defect class stated in one sentence.
    const settled = readStoredFence(writer.db);
    if (!settled.ok) return settled;
    if (!settled.row) return fail(FENCE_REASONS.POSTCOMMIT_MISSING, { fenceId: established.fenceId });
    if (settled.row.fence_id !== established.fenceId) {
      return fail(FENCE_REASONS.POSTCOMMIT_DIVERGED, {
        expected: established.fenceId,
        stored: settled.row.fence_id,
      });
    }

    // STRINGS AND BOOLEANS. No capture, no material, no retirement, no handle.
    return Object.freeze({
      ok: true,
      created: established.created === true,
      fenceId: settled.row.fence_id,
      fenceVersion: settled.material.fenceVersion,
      decisionCutoverId: settled.material.decisionCutoverId,
      releaseFingerprint: releaseStatus.fingerprint,
      appGeneration: owner.appGeneration,
      sessionId: owner.sessionId,
      routeKey: route.routeKey,
      // STILL FALSE, ALWAYS. A fence existing is not the decision path being on.
      schedulingEnabled: SCHEDULING_ENABLED,
      schedulingHold: SCHEDULING_HOLD,
    });
  } finally {
    // The handle is this sequence's, and it does not outlive it.
    writer.close();
  }
}

/**
 * Revalidate everything, from live sources, and publish the health document.
 *
 * TAKES NOTHING, for the same reasons `createOrReuseLegacyFence` does not.
 * Health's whole job is to compare the world against the stored fence, and every
 * input it used to accept — the database, the directory, the release capture,
 * the probe, the claimed owner — was a way of answering the question on its
 * behalf.
 *
 * `schedulingEnabled` is false unconditionally: a healthy fence is a
 * precondition for the decision path, not permission to run it, and Step 2B's
 * HOLD is not lifted by this child.
 */
async function evaluateFenceHealth() {
  const unhealthy = (reason, detail = null) => ({
    ok: true,
    healthy: false,
    schedulingEnabled: SCHEDULING_ENABLED,
    schedulingHold: SCHEDULING_HOLD,
    fenceId: null,
    reason,
    detail,
  });

  const releaseStatus = releaseCaptureStatus();
  if (!releaseStatus.ok) return unhealthy(releaseStatus.reason, releaseStatus.detail || null);

  // Whoever is asking owns scheduling. Checked first: a straggler generation
  // must not learn the fence is healthy, and v13 disables both claim paths for
  // exactly that reason.
  const owner = proveSchedulingOwnership();
  if (!owner.ok) return unhealthy(owner.reason, owner.detail || null);

  const route = resolveLegacySpoolRoute();
  if (!route.ok) return unhealthy(route.reason, route.detail || null);

  const acquired = acquireAdmissionWriter(owner.sessionId);
  if (!acquired.ok) return unhealthy(acquired.reason, acquired.detail || null);
  const { writer } = acquired;

  try {
    const schema = verifyInstalledSchema(writer.db, [...FENCE_SCHEMA_OBJECTS]);
    if (!schema.ok) return unhealthy(FENCE_REASONS.SCHEMA_UNVERIFIED, schema.detail || { reason: schema.reason });

    const stored = readStoredFence(writer.db);
    if (!stored.ok) return unhealthy(stored.reason, stored.detail || null);
    if (!stored.row) return unhealthy(FENCE_REASONS.ROW_MISSING);
    const storedMaterial = stored.material;

    // 1. The release this generation loaded, still matching disk.
    const release = verifyLoadedReleaseUnchanged(frozenReleaseCapture);
    if (!release.ok) return unhealthy(release.reason, release.detail || null);
    if (release.fingerprint !== stored.row.release_fingerprint) {
      return unhealthy('fence_release_fingerprint_changed', {
        stored: stored.row.release_fingerprint,
        current: release.fingerprint,
      });
    }

    // 2. Both journals, exact-reread and strict-parsed again.
    const journals = readJournalDescriptors(route.dir);
    if (!journals.ok) return unhealthy(journals.reason, journals.detail || null);
    if (!descriptorsEqual(journals.attempt, storedMaterial.attemptJournal)
      || !descriptorsEqual(journals.disposition, storedMaterial.dispositionJournal)) {
      return unhealthy('fence_journal_diverged_from_stored_fence', {
        attempt: journals.attempt,
        disposition: journals.disposition,
      });
    }

    // 3. The original writer is still gone. A resurrected exact owner is the one
    //    fact that can un-close a closed legacy world.
    //
    //    THE SAME AUTHORITY CREATION USES, not a second weaker probe. Health
    //    used to re-probe the stored PID by hand, which answered a narrower
    //    question than creation had asked: it never re-read the capture row, so
    //    a capture that had since become incoherent — or one that now names THIS
    //    generation — still read as healthy. One authority, both paths.
    const retirement = await proveStoredWriterRetired(writer.db, frozenReleaseCapture);
    if (!retirement.ok) return unhealthy(retirement.reason, retirement.detail || null);
    // The capture the successor just re-proved must be the one this fence was
    // built from. A different predecessor with an equally valid proof is a
    // second history, not a healthier fence.
    if (retirement.retired.pid !== storedMaterial.retiredWriter.pid
      || retirement.retired.retirementEvidenceSha256 !== storedMaterial.retiredWriter.retirementEvidenceSha256) {
      return unhealthy(FENCE_REASONS.RETIREMENT_IDENTITY_MISMATCH, {
        stored: storedMaterial.retiredWriter.pid,
        proven: retirement.retired.pid,
      });
    }

    // 3b. And the legacy world is still settled (#178 §3: a queue with one
    //     pending legacy record cannot CREATE OR REREAD a healthy fence).
    const readiness = proveLegacyPhaseReadiness(route.dir, retirement);
    if (!readiness.ok) return unhealthy(readiness.reason, readiness.detail || null);

    return {
      ok: true,
      healthy: true,
      // STILL FALSE. See the module header: the fence being healthy is not the
      // decision path being on.
      schedulingEnabled: SCHEDULING_ENABLED,
      schedulingHold: SCHEDULING_HOLD,
      fenceId: stored.row.fence_id,
      fenceVersion: storedMaterial.fenceVersion,
      decisionCutoverId: storedMaterial.decisionCutoverId,
      releaseFingerprint: release.fingerprint,
      owner: { appGeneration: owner.appGeneration, sessionId: owner.sessionId },
      routeKey: route.routeKey,
      reason: null,
    };
  } finally {
    writer.close();
  }
}

/**
 * THE PUBLIC SURFACE IS FOUR ENTRIES AND A VOCABULARY.
 *
 * `readJournalDescriptors`, `proveStoredWriterRetired`, `buildFenceMaterial`,
 * `establishFence` and `proveSchedulingOwnership` are all module-private now.
 * Each of them either mints a brand or writes the authoritative row, and an
 * export is an injection seam regardless of how carefully the function itself
 * checks its inputs — the whole point of the WeakSets is defeated by an exported
 * function that adds objects to them on request.
 *
 * What remains public: freeze the release at startup, create-or-reuse the fence,
 * read its health, and the pure parsers/validators/constants a test or a reader
 * legitimately needs. None of them can write, mint, or supply a brand.
 */
module.exports = Object.freeze({
  FENCE_VERSION,
  FENCE_ID_PREFIX,
  FENCE_REASONS,
  FENCE_SCHEMA_OBJECTS,
  FENCE_COLUMNS,
  FENCE_MATERIAL_COLUMNS,
  JOURNALS_SCHEMA,
  MATERIAL_SCHEMA,
  MATERIAL_KEYS,
  ABSENT_JOURNAL,
  // Pure calculation and validation. No state, no brand, no write.
  validateMaterialSemantics,
  deriveFenceId,
  materialFromRow,
  rowFromMaterial,
  readStoredFence,
  // The production surface.
  captureStartupRelease,
  releaseCaptureStatus,
  createOrReuseLegacyFence,
  evaluateFenceHealth,
});
