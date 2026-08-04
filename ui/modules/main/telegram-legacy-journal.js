/**
 * THE MANDATORY LEGACY-FILE GATE (v7 §2), and the pure decision that follows it.
 *
 * =====================================================================
 * WHY A SECOND READER EXISTS ALONGSIDE THE QUEUE'S OWN
 * =====================================================================
 * `telegram-inbound-durable-queue` already reads both sidecars, and it is
 * careful. It is not careful ENOUGH to be a protocol gate, and the gaps are the
 * reason this file exists rather than a patch to that one:
 *
 *   * `records.set(id, ...)` on a duplicate updateId is a SILENT OVERWRITE. Two
 *     entries for one update mean the file disagrees with itself, and picking
 *     the last one is choosing which disagreement to believe. v7 forbids it
 *     even when the two lines are byte-identical, because a duplicate is
 *     evidence about the WRITER, not about the update.
 *   * unknown keys pass. A record carrying a field this build does not
 *     understand is a record written by something else, and reading only the
 *     parts we recognise is how a half-understood file gets treated as fully
 *     understood.
 *   * an interior blank line is skipped. Between two records it is not
 *     whitespace, it is a gap where a write went wrong.
 *   * any non-empty string is accepted as a disposition, so a typo retires a
 *     message.
 *
 * Changing the queue's readers in place would alter the behaviour of every
 * existing caller mid-repair. This reader is additive, strict, and used by the
 * gate; the queue keeps its own contract until a later step retires it.
 *
 * =====================================================================
 * ONE READ PER FILE PER PASS
 * =====================================================================
 * v7 §2 requires the sidecars to be read "once per ordered pass". Not once per
 * record: a pass that re-read the files between updates could see the journal
 * change underneath it and make two decisions from two different worlds. The
 * snapshot is taken once, counted, and then answered from.
 */
const fs = require('node:fs');
const path = require('node:path');

const { classifySourceRecord, SOURCE_PROTOCOLS } = require('./telegram-source-protocol');

const ATTEMPTS_NAME = 'delivery-attempts.jsonl';
const DISPOSITIONS_NAME = 'terminal-dispositions.jsonl';

/** The only attempt states this build recognises. */
const ATTEMPT_STATES = Object.freeze(new Set(['attempted', 'retryable']));

/**
 * The only terminal dispositions this build recognises, matching the drain's
 * existing set. An unrecognised value is not a future disposition to be
 * tolerated — it is a record we cannot act on, and acting on it would mean
 * retiring a message on the strength of a string nobody defined.
 */
const TERMINAL_DISPOSITIONS = Object.freeze(new Set(['empty_body', 'consumed_verified_out_of_band']));

/**
 * Exact allowed keys. `atMs` and `generation` are optional on an attempt
 * because records written before those fields existed legitimately lack them —
 * 808499316 is exactly that record, and a gate that rejected it would wedge the
 * queue it exists to unwedge. Nothing else is optional and nothing else is
 * allowed.
 */
const ATTEMPT_REQUIRED_KEYS = Object.freeze(['updateId', 'state']);
const ATTEMPT_OPTIONAL_KEYS = Object.freeze(['atMs', 'generation']);
const DISPOSITION_REQUIRED_KEYS = Object.freeze(['updateId', 'disposition', 'evidence']);
const DISPOSITION_OPTIONAL_KEYS = Object.freeze(['atMs']);

/** Named, total gate actions. The set IS the contract. */
const GATE_ACTIONS = Object.freeze({
  RETIRE_TERMINAL: 'retire_terminal_disposition',
  HOLD_ATTEMPTED: 'hold_legacy_attempted',
  LEGACY_PANE_ONLY: 'legacy_pane_only',
  PROTOCOL_CONFLICT: 'protocol_conflict',
  REQUIRES_FENCE: 'decision_requires_stable_fence',
});

function fail(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parse one sidecar's raw text into a Map, refusing everything v7 §2 refuses.
 *
 * The caller has already read the file; this never touches disk, so the
 * one-read-per-pass promise is structural rather than a habit.
 */
function parseJournalText(raw, spec) {
  // COMPLETE LF TERMINATION. A non-empty file whose last byte is not a newline
  // is a torn write, and its final record is a fragment that may parse.
  if (raw.length > 0 && !raw.endsWith('\n')) {
    return fail(`${spec.name}_torn_tail`);
  }

  const records = new Map();
  const lines = raw.length === 0 ? [] : raw.slice(0, -1).split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    // NO INTERIOR BLANK RECORD. Between two records this is not formatting.
    if (line.trim().length === 0) {
      return fail(`${spec.name}_blank_record`, { line: index + 1 });
    }

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return fail(`${spec.name}_unparseable_record`, { line: index + 1 });
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail(`${spec.name}_record_not_an_object`, { line: index + 1 });
    }

    // EXACT KEY SET. Unknown keys mean another writer; missing keys mean an
    // incomplete record. Neither is something to read the recognised half of.
    const keys = Object.keys(entry);
    const unknown = keys.filter((key) => !spec.required.includes(key) && !spec.optional.includes(key));
    const missing = spec.required.filter((key) => !Object.prototype.hasOwnProperty.call(entry, key));
    if (unknown.length > 0 || missing.length > 0) {
      return fail(`${spec.name}_schema_mismatch`, { line: index + 1, unknown, missing });
    }

    if (!isPositiveSafeInteger(entry.updateId)) {
      return fail(`${spec.name}_invalid_update_id`, { line: index + 1 });
    }

    const validated = spec.validate(entry, index + 1);
    if (!validated.ok) return validated;

    // NO DUPLICATE, EVEN BYTE-IDENTICAL. A repeated id is a fact about the
    // writer, and `set()` would have hidden it.
    if (records.has(entry.updateId)) {
      return fail(`${spec.name}_duplicate_update_id`, { line: index + 1, updateId: entry.updateId });
    }
    records.set(entry.updateId, validated.value);
  }

  return { ok: true, records };
}

function validateAttempt(entry, line) {
  if (!ATTEMPT_STATES.has(entry.state)) {
    return fail('attempt_unknown_state', { line, state: typeof entry.state === 'string' ? entry.state : typeof entry.state });
  }
  // A PRESENT-BUT-MALFORMED provenance field is not "absent". Absent means an
  // older writer; malformed means the record is not what it claims to be.
  if (Object.prototype.hasOwnProperty.call(entry, 'atMs') && !isPositiveSafeInteger(entry.atMs)) {
    return fail('attempt_invalid_at_ms', { line });
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'generation') && !isNonEmptyString(entry.generation)) {
    return fail('attempt_invalid_generation', { line });
  }
  return {
    ok: true,
    value: {
      state: entry.state,
      atMs: Object.prototype.hasOwnProperty.call(entry, 'atMs') ? entry.atMs : null,
      generation: Object.prototype.hasOwnProperty.call(entry, 'generation') ? entry.generation.trim() : null,
    },
  };
}

function validateDisposition(entry, line) {
  if (!isNonEmptyString(entry.disposition) || !TERMINAL_DISPOSITIONS.has(entry.disposition.trim())) {
    return fail('disposition_unrecognized', {
      line,
      disposition: typeof entry.disposition === 'string' ? entry.disposition : typeof entry.disposition,
    });
  }
  // EVIDENCE IS MANDATORY. A retirement without a stated reason is the
  // hand-edited disappearance the sidecar exists to make impossible.
  if (!isNonEmptyString(entry.evidence)) {
    return fail('disposition_missing_evidence', { line });
  }
  if (Object.prototype.hasOwnProperty.call(entry, 'atMs') && !isPositiveSafeInteger(entry.atMs)) {
    return fail('disposition_invalid_at_ms', { line });
  }
  return {
    ok: true,
    value: {
      disposition: entry.disposition.trim(),
      evidence: entry.evidence.trim(),
      atMs: Object.prototype.hasOwnProperty.call(entry, 'atMs') ? entry.atMs : null,
    },
  };
}

/**
 * Read both sidecars EXACTLY ONCE and return an immutable snapshot.
 *
 * A missing file is the defined empty state and is allowed. Anything else that
 * goes wrong — unreadable, unparseable, wrong shape, duplicated — is SNAPSHOT
 * FAILURE, which stops the head and everything behind it. v7 §2: "Unreadable /
 * malformed / conflicting journal stops the head and every later source."
 */
function readLegacyJournalSnapshot(dir, deps = {}) {
  const readFile = typeof deps.readFile === 'function' ? deps.readFile : ((file) => fs.readFileSync(file, 'utf8'));
  const reads = { attempts: 0, dispositions: 0 };

  const load = (name) => {
    const file = path.join(dir, name);
    reads[name === ATTEMPTS_NAME ? 'attempts' : 'dispositions'] += 1;
    try {
      return { ok: true, raw: String(readFile(file)) };
    } catch (err) {
      // ABSENT IS THE DEFINED EMPTY STATE, and only absent.
      if (err && err.code === 'ENOENT') return { ok: true, raw: '' };
      return fail('journal_unreadable', { file: name });
    }
  };

  // BOTH LOADS RUN, UNCONDITIONALLY, BEFORE EITHER IS JUDGED (Architect #116).
  //
  // Returning early on an unreadable attempts file left dispositions read ZERO
  // times, so the pass's evidence was asymmetric exactly on its worst path -
  // the one where we most need to be able to say what we looked at. "Once per
  // ordered pass" has to mean once, not at-most-once, or the read counters
  // stop being evidence about the pass and start being evidence about which
  // error happened first.
  const attemptsRaw = load(ATTEMPTS_NAME);
  const dispositionsRaw = load(DISPOSITIONS_NAME);
  if (!attemptsRaw.ok) return { ...attemptsRaw, reads };
  if (!dispositionsRaw.ok) return { ...dispositionsRaw, reads };

  const attempts = parseJournalText(attemptsRaw.raw, {
    name: 'attempt',
    required: ATTEMPT_REQUIRED_KEYS,
    optional: ATTEMPT_OPTIONAL_KEYS,
    validate: validateAttempt,
  });
  if (!attempts.ok) return { ...attempts, reads };

  const dispositions = parseJournalText(dispositionsRaw.raw, {
    name: 'disposition',
    required: DISPOSITION_REQUIRED_KEYS,
    optional: DISPOSITION_OPTIONAL_KEYS,
    validate: validateDisposition,
  });
  if (!dispositions.ok) return { ...dispositions, reads };

  // CROSS-FILE IS NOT A CONFLICT. An attempt AND a terminal disposition for the
  // same legacy update is the EXPECTED shape of a resolved record - 808499316
  // is precisely that, attempted long ago and since proven answered - and
  // treating it as contradictory would wedge the one record this repair is
  // meant to release.
  return {
    ok: true,
    attempts: attempts.records,
    dispositions: dispositions.records,
    reads,
  };
}

/**
 * THE PURE GATE. No I/O, no side effects, total over its inputs.
 *
 * Every branch returns a NAMED action so the caller never has to infer intent
 * from a boolean, and so a future reader can see the whole contract in one
 * place rather than reconstructing it from call sites.
 */
function evaluateLegacySourceGate(input = {}) {
  const { record, snapshot } = input;
  if (!snapshot || snapshot.ok !== true) {
    return { ok: false, action: null, reason: 'snapshot_unavailable' };
  }
  const updateId = record && typeof record === 'object' ? record.updateId : null;
  if (!isPositiveSafeInteger(updateId)) {
    return { ok: false, action: null, reason: 'record_invalid_update_id' };
  }

  const attempt = snapshot.attempts.get(updateId) || null;
  const disposition = snapshot.dispositions.get(updateId) || null;
  const protocol = classifySourceRecord(record).protocol;

  if (protocol === SOURCE_PROTOCOLS.DECISION_V1) {
    // ANY legacy journal match against a post-cutover source is a protocol
    // conflict: the two regimes disagree about what this update even is, and
    // no amount of reading will reconcile them.
    if (attempt || disposition) {
      return {
        ok: true,
        action: GATE_ACTIONS.PROTOCOL_CONFLICT,
        hold: true,
        deliver: false,
        decision: false,
        detail: { attempt: Boolean(attempt), disposition: Boolean(disposition) },
      };
    }
    // Clean post-cutover source, but the stable fence is Step 3 and does not
    // exist yet, so nothing may be decided or claimed.
    return {
      ok: true, action: GATE_ACTIONS.REQUIRES_FENCE, hold: true, deliver: false, decision: false,
    };
  }

  // ---- legacy ----
  if (disposition) {
    // A VALIDATED TERMINAL DISPOSITION RETIRES IT, even when an `attempted`
    // latch also exists. That pair is the resolved shape, not a contradiction.
    return {
      ok: true,
      action: GATE_ACTIONS.RETIRE_TERMINAL,
      hold: false,
      deliver: false,
      decision: false,
      retire: true,
      disposition: disposition.disposition,
      evidence: disposition.evidence,
    };
  }
  if (attempt && attempt.state === 'attempted') {
    // Attempted with nothing proving how it ended. The live 808499316 shape
    // before its disposition existed: never safely re-sendable, never provably
    // sent, so it holds until a human resolves it.
    return {
      ok: true, action: GATE_ACTIONS.HOLD_ATTEMPTED, hold: true, deliver: false, decision: false,
    };
  }
  // `retryable` or no journal match at all: the ordinary legacy pane path, and
  // Mira/decision policy is never consulted for it.
  return {
    ok: true, action: GATE_ACTIONS.LEGACY_PANE_ONLY, hold: false, deliver: true, decision: false,
  };
}

module.exports = {
  ATTEMPTS_NAME,
  DISPOSITIONS_NAME,
  ATTEMPT_STATES,
  TERMINAL_DISPOSITIONS,
  GATE_ACTIONS,
  readLegacyJournalSnapshot,
  evaluateLegacySourceGate,
};
