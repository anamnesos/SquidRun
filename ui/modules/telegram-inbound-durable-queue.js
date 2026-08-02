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
 * Append one inbound update. Idempotent on updateId: re-appending the same id
 * is a no-op, so a replayed poll cannot duplicate a message to the user.
 */
function append(dir, entry = {}) {
  const updateId = normalizeUpdateId(entry.updateId);
  if (updateId === null) return { ok: false, reason: 'missing_update_id' };

  fs.mkdirSync(dir, { recursive: true });
  const existing = new Set(readJsonl(journalPath(dir)).map((e) => normalizeUpdateId(e.updateId)));
  if (existing.has(updateId)) return { ok: true, deduped: true, updateId };

  const record = {
    updateId,
    text: typeof entry.text === 'string' ? entry.text : '',
    chatId: entry.chatId ?? null,
    profile: entry.profile ?? null,
    receivedAtMs: Number.isFinite(Number(entry.receivedAtMs)) ? Number(entry.receivedAtMs) : Date.now(),
  };
  // Single append with a trailing newline: the unit of durability is one line.
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
  const ids = (Array.isArray(updateIds) ? updateIds : [updateIds])
    .map(normalizeUpdateId)
    .filter((id) => id !== null);
  if (ids.length === 0) return { ok: true, acked: 0 };
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const payload = ids.map((updateId) => `${JSON.stringify({ updateId, ackedAtMs: now })}\n`).join('');
  fs.appendFileSync(ackPath(dir), payload, 'utf8');
  return { ok: true, acked: ids.length };
}

module.exports = {
  append,
  ack,
  readPending,
  journalPath,
  ackPath,
};
