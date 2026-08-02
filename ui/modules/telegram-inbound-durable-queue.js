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
 * Append one inbound update. Idempotent on updateId: re-appending the same id
 * is a no-op, so a replayed poll cannot duplicate a message to the user.
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
    targetProfile: entry.targetProfile ?? null,
    targetWindow: entry.targetWindow ?? null,
    targetSession: entry.targetSession ?? null,
  };
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

module.exports = {
  append,
  ack,
  readPending,
  journalPath,
  ackPath,
};
