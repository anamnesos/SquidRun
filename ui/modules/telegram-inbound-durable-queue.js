/**
 * Durable append-only inbound queue, keyed by Telegram updateId.
 *
 * WHY THIS EXISTS. The standalone lane forwarded each inbound message with
 * `fs.writeFileSync(triggerPath, message)` to a FIXED filename, and the poller
 * invokes that callback once per update inside its dispatch loop. Two updates in
 * a single getUpdates batch therefore wrote the first and then OVERWROTE it with
 * the second — while the cursor advanced past both as delivered. Silent loss:
 * the cursor claimed delivery, the file disagreed, and nothing raised an error.
 * The 2026-08-01 outage carried exactly two updates in one drain, so app-down
 * continuity built on that path would have upgraded a delay bug into a loss bug.
 *
 * DESIGN, deliberately boring:
 *  - APPEND-only JSONL. A write never destroys a previous write.
 *  - Keyed by updateId, which Telegram already guarantees unique and ordered,
 *    so replay is idempotent without inventing our own identity.
 *  - Delivery is ACK-based: an entry stays pending until acked, so a consumer
 *    that crashes between reading and handling REPLAYS rather than drops. Late
 *    is recoverable; lost is not.
 *  - A torn trailing line (crash mid-append) is skipped, never fatal — losing
 *    every earlier message because the last byte was half-written would
 *    recreate the very bug this replaces.
 *  - Per-directory, so profile scoping is structural: the caller passes its own
 *    profile root and two profiles cannot share a journal by construction.
 */
const fs = require('node:fs');
const path = require('node:path');

const JOURNAL_NAME = 'telegram-inbound-queue.jsonl';
const ACK_NAME = 'telegram-inbound-queue.acked.jsonl';

function journalPath(dir) {
  return path.join(dir, JOURNAL_NAME);
}

function ackPath(dir) {
  return path.join(dir, ACK_NAME);
}

function normalizeUpdateId(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Complete JSON lines only. A partial trailing line is skipped, not fatal. */
function readJsonl(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Torn write from a crash mid-append. Skip this line only.
    }
  }
  return out;
}

/**
 * If the journal does not end in a newline, a previous append was cut short.
 * Terminate it so the fragment cannot swallow the next record.
 */
function sealTornTail(file) {
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return;
    fd = fs.openSync(file, 'r');
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    fs.closeSync(fd);
    fd = null;
    if (last.toString('utf8') !== '\n') {
      fs.appendFileSync(file, '\n', 'utf8');
    }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    // ENOENT is the only benign case: no journal yet, nothing to seal.
    //
    // EVERY OTHER ERROR MUST PROPAGATE. Swallowing EACCES/EIO here would let
    // append() return ok while the tail was never sealed — and the caller would
    // advance the Telegram cursor on a write that may have concatenated onto a
    // fragment. A repair that silently fails is indistinguishable from one that
    // worked, which is precisely how the original loss went unnoticed.
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * The v7 §1 source-protocol stamp. Named here rather than imported so this
 * low-level queue keeps no dependency on the admission modules that read it;
 * the list is asserted equal to the canonical one in the protocol tests.
 */
const SOURCE_PROTOCOL_FIELDS = Object.freeze([
  'transportProtocol',
  'decisionCutoverId',
  'producerAppGeneration',
  'producerSessionId',
]);

/**
 * Append one inbound update. Idempotent on updateId: re-appending the same id
 * is a no-op, so a replayed poll cannot duplicate a message to the user.
 *
 * THE DEDUPE IS ALSO THE STAMP'S IMMUTABILITY GUARANTEE. A replay after a
 * restart returns early on the existing id and never rewrites the stored line,
 * so the record keeps the generation that first wrote it (v7 §1, Architect
 * #106).
 */
function append(dir, entry = {}) {
  const updateId = normalizeUpdateId(entry.updateId);
  if (updateId === null) return { ok: false, reason: 'missing_update_id' };

  fs.mkdirSync(dir, { recursive: true });
  const existing = new Set(readJsonl(journalPath(dir)).map((e) => normalizeUpdateId(e.updateId)));
  if (existing.has(updateId)) return { ok: true, deduped: true, updateId };

  // ADDITIVE ONLY. The original four fields keep their names and meaning so
  // journals written before this change still read back; everything below is
  // what a later drain needs to actually re-deliver the message rather than
  // just prove it once existed. A spool that cannot reconstruct the delivery is
  // a record of the loss, not a recovery from it.
  const record = {
    updateId,
    text: typeof entry.text === 'string' ? entry.text : '',
    chatId: entry.chatId ?? null,
    profile: entry.profile ?? null,
    receivedAtMs: Number.isFinite(Number(entry.receivedAtMs)) ? Number(entry.receivedAtMs) : Date.now(),
    from: typeof entry.from === 'string' ? entry.from : null,
    messageId: entry.messageId ?? null,
    updateKind: entry.updateKind ?? null,
    timestampMs: Number.isFinite(Number(entry.timestampMs)) ? Number(entry.timestampMs) : null,
    media: entry.media && typeof entry.media === 'object' ? entry.media : null,
    photo: entry.photo && typeof entry.photo === 'object' ? entry.photo : null,
    video: entry.video && typeof entry.video === 'object' ? entry.video : null,
    document: entry.document && typeof entry.document === 'object' ? entry.document : null,
    routeKey: typeof entry.routeKey === 'string' ? entry.routeKey : null,
    rawMetadata: entry.rawMetadata && typeof entry.rawMetadata === 'object' ? entry.rawMetadata : null,
    terminalDisposition: typeof entry.terminalDisposition === 'string' ? entry.terminalDisposition : null,
    targetProfile: entry.targetProfile ?? null,
    targetWindow: entry.targetWindow ?? null,
    targetSession: entry.targetSession ?? null,
  };

  // ===================================================================
  // THE PROTOCOL STAMP IS PERSISTED, OR THE RECORD ON DISK IS LEGACY (v7 §1).
  //
  // This record is built by PICKING named fields, so a stamp the spool computed
  // and handed over was simply dropped on the way to disk. The caller saw
  // ok:true, the in-memory object had the fields, and the durable record - the
  // only thing that survives a restart, and the only thing the classifier ever
  // reads - was unstamped and therefore legacy. Silent success: the exact
  // failure class this lane keeps finding, arriving in the first new commit.
  //
  // Added CONDITIONALLY, so a record written without a stamp keeps its exact
  // historical key set and its exact digest. Absent is not null here: writing
  // four explicit nulls would change the JSON of every legacy journal line.
  // ===================================================================
  for (const field of SOURCE_PROTOCOL_FIELDS) {
    if (typeof entry[field] === 'string' && entry[field].trim()) {
      record[field] = entry[field];
    }
  }
  // TORN-TAIL REPAIR, and this one bites hard: a crash mid-append leaves a
  // partial line with NO trailing newline. The next append would concatenate
  // its own complete JSON onto that fragment, producing one unparseable line —
  // so the NEW message is skipped too, while append() still returns ok and the
  // caller advances the Telegram cursor. That is silent loss of a message that
  // never had anything wrong with it. Terminate the fragment first so the torn
  // record is quarantined to its own line and the new record stands alone.
  sealTornTail(journalPath(dir));
  fs.appendFileSync(journalPath(dir), `${JSON.stringify(record)}\n`, 'utf8');
  return { ok: true, deduped: false, updateId };
}

function ackedIds(dir) {
  return new Set(readJsonl(ackPath(dir)).map((e) => normalizeUpdateId(e.updateId)));
}

/**
 * Everything appended and not yet acked, in updateId order.
 *
 * Sorted by updateId rather than by file order so ordering survives an
 * out-of-order append (retry, replay, or two writers).
 */
function readPending(dir, options = {}) {
  const acked = ackedIds(dir);
  const wantChatId = options.chatId ?? null;
  const seen = new Set();
  const pending = [];
  for (const entry of readJsonl(journalPath(dir))) {
    const updateId = normalizeUpdateId(entry.updateId);
    if (updateId === null || acked.has(updateId) || seen.has(updateId)) continue;
    if (wantChatId !== null && String(entry.chatId) !== String(wantChatId)) continue;
    seen.add(updateId);
    pending.push({ ...entry, updateId });
  }
  return pending.sort((a, b) => a.updateId - b.updateId);
}

/**
 * Mark ids handled. Recorded as its own append-only log so an ack is as durable
 * as the entry it retires, and so acking is never a destructive rewrite of the
 * journal (a rewrite is exactly how the original bug lost data).
 */
function ack(dir, updateIds = []) {
  const requested = (Array.isArray(updateIds) ? updateIds : [updateIds])
    .map(normalizeUpdateId)
    .filter((id) => id !== null);
  if (requested.length === 0) return { ok: true, acked: 0, ignored: 0 };

  // AN ACK MAY ONLY RETIRE SOMETHING THAT EXISTS. Writing a tombstone for an
  // unknown id looked harmless — "acking an unknown id is a no-op" — but the
  // ack log is consulted at read time, so that tombstone would silently
  // suppress the SAME id when it genuinely arrives later. A pre-emptive ack
  // would delete a future message before it was ever seen. Ignore unknown ids
  // instead of recording them.
  const known = new Set(readJsonl(journalPath(dir)).map((e) => normalizeUpdateId(e.updateId)));
  const ids = requested.filter((id) => known.has(id));
  const ignored = requested.length - ids.length;
  if (ids.length === 0) return { ok: true, acked: 0, ignored };
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const payload = ids.map((updateId) => `${JSON.stringify({ updateId, ackedAtMs: now })}\n`).join('');
  sealTornTail(ackPath(dir));
  fs.appendFileSync(ackPath(dir), payload, 'utf8');
  return { ok: true, acked: ids.length, ignored };
}


// ---------------------------------------------------------------------------
// STRICT DELIVERY-ATTEMPT SIDECAR
//
// Deliberately NOT sharing the inbound journal's parser. readJsonl above is
// permissive: it skips malformed lines so one bad record cannot strand a whole
// queue. That is right for pending messages and WRONG here — this sidecar is
// the ambiguity latch that decides whether something may be shown to the user
// again. Under storage or parse failure the safe bias is HOLD, so every read
// fails closed instead of quietly returning less than the truth.
// ---------------------------------------------------------------------------

const ATTEMPTS_NAME = 'delivery-attempts.jsonl';
const ATTEMPT_STATES = new Set(['attempted', 'retryable']);

function attemptsPath(dir) {
  return path.join(dir, ATTEMPTS_NAME);
}

/**
 * ATTEMPT PROVENANCE (S491). The v0 entry was `{updateId, state}` and nothing
 * else, which made one question unanswerable: *when* was this attempted, and by
 * which process?
 *
 * That gap is why update 700100102 could not be resolved. Proof for it existed
 * — Operator was answered — but "is this receipt NEWER than the attempt it claims
 * to prove?" had no attempt timestamp to compare against, so the only honest
 * answer was the one that wedged the channel for eight hours.
 *
 * Both fields are OPTIONAL, because the live latch on disk predates them and
 * MUST stay readable. Absent means UNKNOWN, never zero and never "now": an
 * entry with no `atMs` can never satisfy a freshness comparison, so it holds.
 * Fail-closed on absence is the whole point — an attempt we cannot place in
 * time is exactly the one we must not reason about.
 */
function normalizeAttemptAtMs(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number') {
    throw new Error('attempt entry atMs must be a number when present');
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('attempt entry atMs must be a positive safe integer');
  }
  return value;
}

function normalizeAttemptGeneration(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('attempt entry generation must be a non-empty string when present');
  }
  return value.trim();
}

// Attempt entries are an INTERNAL schema, so no coercion is owed to anyone.
// Number('1') is 1 and Number(true) is 1; accepting either would let a foreign
// or corrupted record claim an updateId it does not actually carry.
function normalizeAttemptUpdateId(value) {
  if (typeof value !== 'number') return null;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * appendAttempt writes JSON + newline as ONE record, so a nonempty file that
 * does not end in a newline is a torn write — even when the final line happens
 * to parse. Repairing it by inserting a newline and appending behind it would
 * bless an unknown state and hide that a previous append died mid-write. Read
 * and append both refuse.
 */
function assertNoTornTail(raw) {
  if (raw.length > 0 && !raw.endsWith('\n')) {
    throw new Error('attempt journal has a torn (non-newline-terminated) tail');
  }
}

/**
 * @returns {Map<number, {state: string, atMs: number|null, generation: string|null}>}
 * @throws on anything it cannot fully trust
 */
function readAttemptRecords(dir) {
  const file = attemptsPath(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map();
    throw new Error(`attempt journal unreadable: ${err.message}`);
  }

  assertNoTornTail(raw);

  const records = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      throw new Error('attempt journal contains an unreadable entry');
    }
    const id = normalizeAttemptUpdateId(entry && entry.updateId);
    if (id === null) {
      throw new Error('attempt journal entry has an invalid updateId');
    }
    if (!ATTEMPT_STATES.has(entry.state)) {
      throw new Error(`attempt journal entry has an unknown state: ${entry.state}`);
    }
    // A malformed provenance field is NOT downgraded to "absent". Absent means
    // an older writer; malformed means the record is not what it claims to be,
    // and guessing which is a decision about showing Operator a message twice.
    records.set(id, {
      state: entry.state,
      atMs: normalizeAttemptAtMs(entry.atMs),
      generation: normalizeAttemptGeneration(entry.generation),
    });
  }
  return records;
}

/**
 * @returns {Map<number, string>} updateId -> state
 * @throws on anything it cannot fully trust
 */
function readAttemptState(dir) {
  const state = new Map();
  for (const [id, record] of readAttemptRecords(dir)) {
    state.set(id, record.state);
  }
  return state;
}

/** Validates BEFORE touching disk: a rejected write must leave no trace. */
function appendAttempt(dir, updateId, entryState, provenance = {}) {
  const id = normalizeAttemptUpdateId(updateId);
  if (id === null) {
    throw new Error('attempt updateId must be a positive integer');
  }
  if (!ATTEMPT_STATES.has(entryState)) {
    throw new Error(`attempt state must be one of ${Array.from(ATTEMPT_STATES).join('|')}`);
  }
  // Validated up here with everything else, so a bad provenance field is
  // rejected before any byte is written rather than landing half-formed.
  const atMs = normalizeAttemptAtMs(provenance ? provenance.atMs : null);
  const generation = normalizeAttemptGeneration(provenance ? provenance.generation : null);

  const file = attemptsPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  // REFUSE rather than repair. Appending behind a torn tail would bless whatever
  // that half-written record was about.
  try {
    assertNoTornTail(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  // Provenance keys are OMITTED when unknown rather than written as null, so a
  // v0 reader keeps parsing these and the file does not grow fields that carry
  // no information.
  const entry = { updateId: id, state: entryState };
  if (atMs !== null) entry.atMs = atMs;
  if (generation !== null) entry.generation = generation;
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return { ok: true, updateId: id, state: entryState, atMs, generation };
}

// ---------------------------------------------------------------------------
// TERMINAL DISPOSITION SIDECAR (S491)
//
// `append` dedupes by updateId and `readPending` keeps the FIRST record for an
// id, both deliberately — that is what makes replay idempotent. The consequence
// is that a queued record can never be superseded by appending a corrected copy.
//
// Update 700100102 needs exactly that: it WAS consumed and answered (Telegram
// 22314 / ledger 78453), so re-delivering it would duplicate real business work,
// but nothing in the automatic path can prove it after the fact because its
// attempt predates attempt timestamps. It must be retired without delivery.
//
// Editing the journal by hand would be the worst possible answer: an
// unexplained disappearance in the one file whose entire job is to make loss
// impossible. So dispositions live in their own append-only sidecar, carry the
// evidence that justified them, and are overlaid at read time. The journal
// stays exactly as written, and why a record was retired is auditable forever.
// ---------------------------------------------------------------------------

const DISPOSITIONS_NAME = 'terminal-dispositions.jsonl';

function dispositionsPath(dir) {
  return path.join(dir, DISPOSITIONS_NAME);
}

/**
 * @returns {Map<number, {disposition: string, evidence: string, atMs: number|null}>}
 * @throws on anything it cannot fully trust — same bias as the attempt latch.
 */
function readDispositions(dir) {
  const file = dispositionsPath(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map();
    throw new Error(`disposition journal unreadable: ${err.message}`);
  }

  assertNoTornTail(raw);

  const records = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      throw new Error('disposition journal contains an unreadable entry');
    }
    const id = normalizeAttemptUpdateId(entry && entry.updateId);
    if (id === null) {
      throw new Error('disposition journal entry has an invalid updateId');
    }
    if (typeof entry.disposition !== 'string' || !entry.disposition.trim()) {
      throw new Error('disposition journal entry has no disposition');
    }
    // EVIDENCE IS MANDATORY. A disposition without a stated reason is exactly
    // the hand-edited disappearance this sidecar exists to make impossible.
    if (typeof entry.evidence !== 'string' || !entry.evidence.trim()) {
      throw new Error(`disposition for ${id} carries no evidence`);
    }
    records.set(id, {
      disposition: entry.disposition.trim(),
      evidence: entry.evidence.trim(),
      atMs: normalizeAttemptAtMs(entry.atMs),
    });
  }
  return records;
}

/** Validates BEFORE touching disk: a rejected write must leave no trace. */
function appendDisposition(dir, updateId, disposition, evidence, atMs = null) {
  const id = normalizeAttemptUpdateId(updateId);
  if (id === null) {
    throw new Error('disposition updateId must be a positive integer');
  }
  if (typeof disposition !== 'string' || !disposition.trim()) {
    throw new Error('disposition must be a non-empty string');
  }
  if (typeof evidence !== 'string' || !evidence.trim()) {
    throw new Error('a disposition must carry the evidence that justifies it');
  }
  const at = normalizeAttemptAtMs(atMs);

  const file = dispositionsPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  try {
    assertNoTornTail(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  const entry = { updateId: id, disposition: disposition.trim(), evidence: evidence.trim() };
  if (at !== null) entry.atMs = at;
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return { ok: true, updateId: id, disposition: entry.disposition };
}

module.exports = {
  append,
  SOURCE_PROTOCOL_FIELDS,
  attemptsPath,
  dispositionsPath,
  readDispositions,
  appendDisposition,
  DISPOSITIONS_NAME,
  readAttemptState,
  readAttemptRecords,
  appendAttempt,
  ATTEMPTS_NAME,
  ATTEMPT_STATES,
  ack,
  readPending,
  journalPath,
  ackPath,
};
