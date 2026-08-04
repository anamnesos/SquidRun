/**
 * Ingress spool for inbound Telegram — the durable landing point that has to
 * succeed BEFORE the worker is told its message was accepted.
 *
 * OWNERSHIP (Architect #45/#49, and the reason this is its own module):
 * the spool belongs to the single main getUpdates owner, so its base comes ONLY
 * from the canonical `SQUIDRUN_DATA_ROOT` captured when the poller was started.
 * Not the target profile root, not getProjectRoot(), not cwd, and explicitly not
 * the two scoped-fallback sites in squidrun-app — those resolve a DELIVERY
 * target, which is a different question from who owns the ingress journal.
 * Using them here would let a routing answer decide where the record lands, and
 * that is how main and sideprofile end up sharing a journal.
 *
 * Missing base or an unsafe route key writes NOWHERE and reports a reason. The
 * caller turns that into a rejected ack, and the Telegram cursor holds.
 */

const path = require('path');
const queue = require('../telegram-inbound-durable-queue');
const { buildSourceProtocolStamp } = require('./telegram-source-protocol');

const SPOOL_SEGMENTS = ['.squidrun', 'runtime', 'telegram-inbound'];

// One path segment: letters, digits, dash, underscore. This rejects separators,
// '..', absolute paths, drive letters and empty strings by construction rather
// than by blocklist, because a blocklist of traversal spellings is a thing you
// get wrong once and never notice.
const SAFE_ROUTE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isSafeRouteKey(routeKey) {
  return typeof routeKey === 'string' && routeKey.length <= 64 && SAFE_ROUTE_KEY.test(routeKey);
}

/**
 * @returns {{ok: true, dir: string} | {ok: false, reason: string}}
 */
function resolveSpoolDir(dataRoot, routeKey) {
  if (typeof dataRoot !== 'string' || !dataRoot.trim()) {
    return { ok: false, reason: 'missing_ingress_base' };
  }
  // A relative base would be resolved against cwd, which silently invents an
  // owner root that nobody captured. The canonical SQUIDRUN_DATA_ROOT is always
  // absolute; anything else is a configuration bug and must write nowhere.
  if (!path.isAbsolute(dataRoot.trim())) {
    return { ok: false, reason: 'relative_ingress_base' };
  }
  if (!isSafeRouteKey(routeKey)) {
    return { ok: false, reason: 'unsafe_route_key' };
  }
  const base = path.resolve(dataRoot.trim());
  const dir = path.join(base, ...SPOOL_SEGMENTS, routeKey);
  // Belt and braces: even with a safe-looking key, the result must stay under
  // the owner base. If it ever does not, that is a bug in this function and the
  // right answer is to write nothing.
  const spoolRoot = path.join(base, ...SPOOL_SEGMENTS);
  if (dir !== path.join(spoolRoot, routeKey) || !dir.startsWith(spoolRoot + path.sep)) {
    return { ok: false, reason: 'unsafe_route_key' };
  }
  return { ok: true, dir };
}

/**
 * Durably record one inbound update. Returns an EXPLICIT acceptance result;
 * the caller must not infer acceptance from the absence of a throw.
 *
 * @returns {{ok: true, durable: true, updateId: number, deduped: boolean, dir: string}
 *          | {ok: false, reason: string}}
 */
function acceptInbound(input = {}, deps = {}) {
  const append = typeof deps.append === 'function' ? deps.append : queue.append;
  const { dataRoot, routeKey, text, from, metadata } = input;

  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const updateId = Number(meta.updateId);
  if (!Number.isFinite(updateId)) {
    return { ok: false, reason: 'missing_update_id' };
  }

  const resolved = resolveSpoolDir(dataRoot, routeKey);
  if (!resolved.ok) return resolved;

  // ===================================================================
  // NO ANONYMOUS LEGACY APPEND, EVER AGAIN (Architect #104).
  //
  // My first draft wrote the record unstamped when the producer could not name
  // itself, reasoning that losing James's message is worse than routing it down
  // the legacy path. That reasoning is wrong under v7 and the correction is
  // worth writing down, because it is not obvious:
  //
  // v7 §4 derives the stable legacy fence from the FINAL attempt/disposition
  // journal fingerprints, taken once after legacy settlement. Those fingerprints
  // then become a protocol invariant that G+1 must re-derive exactly. A NEW
  // legacy record appended after that point changes the very files the fence is
  // hashed from - so a single anonymous append invalidates the fence, disables
  // both claim paths, and needs a human. "Preserve existing queued bytes by
  // non-rewrite, not by allowing future anonymous legacy appends."
  //
  // So this fails CLOSED, before the append. The existing twelve records keep
  // their bytes because nothing rewrites them, not because this door stayed
  // open. A producer that cannot name its generation and session has a
  // configuration defect, and the honest response is to refuse loudly at the
  // door rather than to quietly manufacture a record no fence can survive.
  // ===================================================================
  const protocolStamp = buildSourceProtocolStamp({
    appGeneration: input.producerAppGeneration,
    sessionId: input.producerSessionId,
  });
  if (!protocolStamp) {
    return { ok: false, reason: 'missing_producer_protocol_identity' };
  }

  let result;
  try {
    result = append(resolved.dir, {
      updateId,
      text: typeof text === 'string' ? text : '',
      from: typeof from === 'string' ? from : null,
      chatId: meta.chatId ?? null,
      messageId: meta.messageId ?? null,
      updateKind: meta.updateKind ?? null,
      timestampMs: meta.timestampMs ?? null,
      media: meta.media ?? null,
      photo: meta.photo ?? null,
      video: meta.video ?? null,
      document: meta.document ?? null,
      routeKey,
      // The full untouched metadata as well as the selected fields: a drain
      // that can only see what today's code thought to copy cannot replay a
      // message shape added tomorrow.
      rawMetadata: meta,
      terminalDisposition: typeof input.terminalDisposition === 'string' ? input.terminalDisposition : null,
      profile: input.targetProfile ?? null,
      targetProfile: input.targetProfile ?? null,
      targetWindow: input.targetWindow ?? null,
      targetSession: input.targetSession ?? null,
      // ===================================================================
      // THE PRODUCER DECLARES THE PROTOCOL, HERE, ONCE (v7 §1).
      //
      // This is the only place an inbound record is created, which is why the
      // stamp belongs here and nowhere else: a second stamping site is a second
      // opinion about which protocol a message belongs to, and the whole point
      // of §1 is that the answer is written down by the producer rather than
      // inferred later by whoever happens to be reading.
      //
      // The stamp is guaranteed complete by the fail-closed gate above, so this
      // record is always explicitly post-cutover. Nothing this build appends is
      // ever legacy; legacy is only what was already on disk.
      // ===================================================================
      ...protocolStamp,
    });
  } catch (err) {
    return { ok: false, reason: `append_threw:${err.message}` };
  }

  // append() reports failure by return value, not by throwing — the same shape
  // that hid the original cursor loss. Check it.
  if (!result || result.ok !== true) {
    return { ok: false, reason: (result && result.reason) || 'append_failed' };
  }

  return {
    ok: true,
    durable: true,
    updateId,
    deduped: result.deduped === true,
    dir: resolved.dir,
  };
}

module.exports = {
  resolveSpoolDir,
  acceptInbound,
  isSafeRouteKey,
  SPOOL_SEGMENTS,
};
