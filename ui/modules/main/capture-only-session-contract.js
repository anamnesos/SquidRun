/**
 * THE CAPTURE-ONLY LEDGER SESSION CONTRACT, IN ONE PLACE.
 *
 * =====================================================================
 * WHY THIS IS A LEAF MODULE AND NOT THREE COPIES OF A STRING
 * =====================================================================
 * Four separate places have to agree on exactly what a capture-only ledger
 * session IS: the admission store installs the triggers that guard it, the
 * generic `recordSessionStart`/`recordSessionEnd` must refuse it, the
 * evidence-ledger IPC dispatcher must refuse it at its own boundary, and the
 * legacy cutover fence must read one and prove it terminal before it will
 * believe a stored capture.
 *
 * Those four live in three subsystems that do not otherwise know about each
 * other, and the ledger has no business depending on the 136 KB Telegram
 * admission store to learn one mode name. So the contract is a leaf: it
 * requires nothing but the canonical JSON rule, and everything else requires
 * it. The alternative — the same literal typed in four files — is the failure
 * this lane keeps finding. Four spellings agree until one is edited, and the
 * day they disagree the gate that was supposed to reserve the mode is guarding
 * a name nobody writes.
 *
 * =====================================================================
 * WHAT THIS MODULE DOES NOT DO
 * =====================================================================
 * It does not write anything, it does not open a database, and it does not
 * build a terminal document. `P` — the process that issues a capture and closes
 * its session — is not implemented and is not implemented here (capture-only
 * activation bridge ruling v3, Architect #208/#210). This module validates, and
 * validation is the successor's half of the contract.
 *
 * Deliberately there is no `buildTerminalMeta`. A builder here would be the
 * seam by which the thing that WRITES the document and the thing that JUDGES it
 * share one implementation, and a document that is judged by its own author is
 * judged by nobody. Tests state the expected shape independently, which is the
 * point of them.
 */
const { canonicalJson } = require('./canonical-json');

/**
 * THE RESERVED MODE. One definition; the generic session APIs, the IPC
 * dispatcher and the installed triggers all consume this exact value.
 */
const CAPTURE_ONLY_SESSION_MODE = 'writer_capture_only';

/** The terminal metadata schema, fixed by capture-only terminal ruling v1. */
const TERMINAL_META_SCHEMA = 'squidrun.telegram_writer_capture.session_terminal.v1';

/** The one accepted terminal status. Anything else is a HOLD, never a retry. */
const TERMINAL_STATUS = 'capture_committed_validated';

/**
 * `ses_` PLUS A REAL v4 UUID, and the version/variant nibbles are the load-
 * bearing part rather than decoration.
 *
 * The ruling requires the id to come from mandatory `crypto.randomUUID()` and
 * forbids the store's ordinary time-plus-random fallback. A shape check that
 * accepted any 36 hex-and-dash characters would accept that fallback the moment
 * it happened to look close enough, so the check is for what `randomUUID`
 * actually emits: version `4` and variant `10xx`. Nothing else in this
 * repository generates that.
 */
const CAPTURE_ONLY_SESSION_ID_RE =
  /^ses_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SHA256_RE = /^[0-9a-f]{64}$/;
const CAPTURE_ID_RE = /^owc1_[0-9a-f]{64}$/;
const APP_GENERATION_PREFIX = 'app-session-';

const TERMINAL_REASONS = Object.freeze({
  // Lookup.
  SESSION_ABSENT: 'capture_only_session_absent',
  SESSION_AMBIGUOUS: 'capture_only_session_ambiguous',
  SESSION_NUMBER_DUPLICATED: 'capture_only_session_number_duplicated',
  SESSION_QUERY_FAILED: 'capture_only_session_query_failed',
  // Row state.
  SESSION_ID_SHAPE: 'capture_only_session_id_shape_invalid',
  SESSION_MODE_WRONG: 'capture_only_session_mode_not_reserved',
  SESSION_NUMBER_INVALID: 'capture_only_session_number_invalid',
  SESSION_OPEN: 'capture_only_session_not_ended',
  SESSION_TIMES_INVALID: 'capture_only_session_times_invalid',
  SESSION_TIMES_UNORDERED: 'capture_only_session_times_unordered',
  SESSION_NOT_PRISTINE: 'capture_only_session_not_pristine',
  // Terminal document.
  META_UNPARSEABLE: 'capture_only_terminal_meta_unparseable',
  META_NONCANONICAL: 'capture_only_terminal_meta_noncanonical',
  META_SHAPE: 'capture_only_terminal_meta_shape_invalid',
  META_SCHEMA_WRONG: 'capture_only_terminal_meta_schema_unrecognized',
  TERMINAL_STATUS_WRONG: 'capture_only_terminal_status_unrecognized',
  TERMINAL_FLAGS_SET: 'capture_only_terminal_flags_set',
  // Cross-check against the independently validated capture.
  CAPTURE_SESSION_MISMATCH: 'capture_only_terminal_session_id_mismatch',
  CAPTURE_ID_MISMATCH: 'capture_only_terminal_capture_id_mismatch',
  CAPTURE_FINGERPRINT_MISMATCH: 'capture_only_terminal_fingerprint_mismatch',
  CAPTURE_GENERATION_MISMATCH: 'capture_only_terminal_generation_mismatch',
  CAPTURE_TIME_OUTSIDE_SESSION: 'capture_only_terminal_capture_time_outside_session',
  // The independent count query, which the document's own claim cannot replace.
  CONTEXT_SNAPSHOTS_PRESENT: 'capture_only_session_context_snapshots_present',
  CONTEXT_QUERY_FAILED: 'capture_only_session_context_query_failed',
});

/**
 * THE EXACT KEY SETS. Not a minimum — an exact set, at every depth.
 *
 * "No extra key" is what makes the absence of conflict/retry/replacement
 * provable. A validator that checked only the keys it knew about would accept a
 * document carrying a `detail` object describing a conflicting history, and the
 * six false booleans below would still read as a clean terminal.
 */
const META_KEYS = Object.freeze([
  'capture', 'postcommitReread', 'schema', 'secondDiskRevalidation', 'session', 'terminal',
]);
const CAPTURE_KEYS = Object.freeze(['capabilityFingerprint', 'id']);
const POSTCOMMIT_KEYS = Object.freeze(['captureId', 'sessionId']);
const SECOND_DISK_KEYS = Object.freeze(['capabilityFingerprint']);
const SESSION_KEYS = Object.freeze(['appGeneration', 'id', 'number']);
const TERMINAL_KEYS = Object.freeze([
  'conflict', 'contextSnapshotCount', 'degraded', 'fallback', 'replacement', 'retry', 'status',
]);
/** Every one of these must be exactly `false`. Absence is not falsity. */
const TERMINAL_FALSE_KEYS = Object.freeze([
  'conflict', 'degraded', 'fallback', 'replacement', 'retry',
]);

function fail(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Exact key equality, order-independent. */
function keysExactly(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length) return false;
  return expected.every((key, index) => actual[index] === key);
}

/**
 * VALIDATE THE STORED TERMINAL DOCUMENT, BYTES FIRST.
 *
 * The byte comparison is not a formality. `meta_json` must equal
 * `canonicalJson(parsed)` exactly, which means the writer used the canonical
 * encoder and not `JSON.stringify` over an object whose keys happened to be in
 * insertion order. Two documents with identical content and different byte
 * order are different rows to every digest in this lane, and accepting either
 * would make "the terminal proof" a thing with more than one spelling.
 */
function validateTerminalMetaBytes(metaJson) {
  if (typeof metaJson !== 'string' || metaJson.length === 0) {
    return fail(TERMINAL_REASONS.META_UNPARSEABLE, { type: typeof metaJson });
  }
  let parsed;
  try {
    parsed = JSON.parse(metaJson);
  } catch (error) {
    return fail(TERMINAL_REASONS.META_UNPARSEABLE, { message: error?.message || String(error) });
  }
  if (!isPlainObject(parsed)) return fail(TERMINAL_REASONS.META_SHAPE, { top: 'not_object' });
  if (canonicalJson(parsed) !== metaJson) return fail(TERMINAL_REASONS.META_NONCANONICAL);

  if (!keysExactly(parsed, META_KEYS)) {
    return fail(TERMINAL_REASONS.META_SHAPE, { keys: Object.keys(parsed).sort() });
  }
  if (parsed.schema !== TERMINAL_META_SCHEMA) {
    return fail(TERMINAL_REASONS.META_SCHEMA_WRONG, { schema: parsed.schema });
  }
  if (!keysExactly(parsed.capture, CAPTURE_KEYS)
    || !keysExactly(parsed.postcommitReread, POSTCOMMIT_KEYS)
    || !keysExactly(parsed.secondDiskRevalidation, SECOND_DISK_KEYS)
    || !keysExactly(parsed.session, SESSION_KEYS)
    || !keysExactly(parsed.terminal, TERMINAL_KEYS)) {
    return fail(TERMINAL_REASONS.META_SHAPE, { nested: 'key_set_mismatch' });
  }

  // Value shapes, before any cross-check. A malformed fingerprint compared
  // against an equally malformed capture column would agree.
  if (!CAPTURE_ID_RE.test(String(parsed.capture.id))
    || !CAPTURE_ID_RE.test(String(parsed.postcommitReread.captureId))
    || !SHA256_RE.test(String(parsed.capture.capabilityFingerprint))
    || !SHA256_RE.test(String(parsed.secondDiskRevalidation.capabilityFingerprint))
    || !CAPTURE_ONLY_SESSION_ID_RE.test(String(parsed.session.id))
    || !CAPTURE_ONLY_SESSION_ID_RE.test(String(parsed.postcommitReread.sessionId))
    || !isPositiveSafeInteger(parsed.session.number)
    || typeof parsed.session.appGeneration !== 'string') {
    return fail(TERMINAL_REASONS.META_SHAPE, { values: 'field_shape_invalid' });
  }

  if (parsed.terminal.status !== TERMINAL_STATUS) {
    return fail(TERMINAL_REASONS.TERMINAL_STATUS_WRONG, { status: parsed.terminal.status });
  }
  // STRICT `=== false`, never falsy. `0`, `''` and `null` are all falsy and none
  // of them is a recorded negative observation.
  const set = TERMINAL_FALSE_KEYS.filter((key) => parsed.terminal[key] !== false);
  if (set.length > 0) return fail(TERMINAL_REASONS.TERMINAL_FLAGS_SET, { set });
  if (parsed.terminal.contextSnapshotCount !== 0) {
    return fail(TERMINAL_REASONS.TERMINAL_FLAGS_SET, { contextSnapshotCount: parsed.terminal.contextSnapshotCount });
  }

  // The document's INTERNAL agreement. The capture cross-check is a separate
  // step against a separately validated row; this only proves the document does
  // not contradict itself.
  if (parsed.session.id !== parsed.postcommitReread.sessionId) {
    return fail(TERMINAL_REASONS.META_SHAPE, { internal: 'session_id_disagrees' });
  }
  if (parsed.capture.id !== parsed.postcommitReread.captureId) {
    return fail(TERMINAL_REASONS.META_SHAPE, { internal: 'capture_id_disagrees' });
  }
  if (parsed.capture.capabilityFingerprint !== parsed.secondDiskRevalidation.capabilityFingerprint) {
    return fail(TERMINAL_REASONS.META_SHAPE, { internal: 'fingerprint_disagrees' });
  }
  if (parsed.session.appGeneration !== `${APP_GENERATION_PREFIX}${parsed.session.number}`) {
    return fail(TERMINAL_REASONS.META_SHAPE, { internal: 'generation_disagrees' });
  }

  return { ok: true, meta: parsed };
}

module.exports = Object.freeze({
  CAPTURE_ONLY_SESSION_MODE,
  TERMINAL_META_SCHEMA,
  TERMINAL_STATUS,
  TERMINAL_REASONS,
  CAPTURE_ONLY_SESSION_ID_RE,
  APP_GENERATION_PREFIX,
  META_KEYS,
  CAPTURE_KEYS,
  POSTCOMMIT_KEYS,
  SECOND_DISK_KEYS,
  SESSION_KEYS,
  TERMINAL_KEYS,
  TERMINAL_FALSE_KEYS,
  isPositiveSafeInteger,
  keysExactly,
  validateTerminalMetaBytes,
});
