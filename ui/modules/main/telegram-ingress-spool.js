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
      profile: input.targetProfile ?? null,
      targetProfile: input.targetProfile ?? null,
      targetWindow: input.targetWindow ?? null,
      targetSession: input.targetSession ?? null,
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
