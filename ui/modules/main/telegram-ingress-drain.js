/**
 * Ordered drain for the Telegram ingress spool.
 *
 * The spool made inbound messages durable. This makes them *arrive* — exactly
 * once visibly, in updateId order, and only retiring a record once something
 * downstream has provably taken ownership of it.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: `queue.ack` is not "we sent it", it is
 * "someone else is now responsible for it". Transport success is not proof.
 * `accepted.unverified` and `accepted.daemon_pty_unverified` are not proof —
 * this lane's own agent-to-agent sends return exactly those strings while
 * explicitly disclaiming visible delivery. Acking on them would retire James's
 * message on the strength of a receipt that says, in its own words, that it
 * cannot confirm he saw it.
 *
 * So: deliver, demand correlated proof, and if the proof is not there, leave the
 * record pending and STOP the queue. A stuck queue is visible and recoverable.
 * A retired-but-undelivered message is neither.
 */

const path = require('path');
const defaultQueue = require('../telegram-inbound-durable-queue');
const spool = require('./telegram-ingress-spool');

const DEFAULT_BACKOFF_MS = 30 * 1000;

/** A receipt proves ownership only if something durable now holds the message. */
function isProvenOwnership(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (receipt.verified === true) return true;
  if (receipt.userVisible === true) return true;
  if (receipt.durableHandoff === true) return true;
  // An explicit persisted row for this message also counts: someone wrote it
  // down somewhere that survives a crash.
  if (typeof receipt.persistedReceiptId === 'string' && receipt.persistedReceiptId.trim()) return true;
  return false;
}

function downstreamMessageId(updateId) {
  return `telegram-in-${updateId}`;
}

function byUpdateId(a, b) {
  return Number(a.updateId) - Number(b.updateId);
}

/**
 * @param {object} deps
 *   queue            durable queue module (readPending/ack)
 *   resolveRoute     (chatId) => {ok, profile, windowKey, ...}
 *   deliver          async (job) => receipt
 *   hasExistingReceipt async (messageId, routeKey) => bool   // crash-replay seam
 *   currentSessionFor (windowKey) => string|null
 *   log
 */
function createDrainCoordinator(deps = {}) {
  const queue = deps.queue || defaultQueue;
  const log = deps.log || { info() {}, warn() {} };
  const resolveRoute = deps.resolveRoute;
  const deliver = deps.deliver;
  const hasExistingReceipt = deps.hasExistingReceipt || (async () => false);
  const currentSessionFor = deps.currentSessionFor || (() => null);
  const backoffMs = Number.isFinite(Number(deps.backoffMs)) ? Number(deps.backoffMs) : DEFAULT_BACKOFF_MS;

  // Per-directory state. `running` is the exclusivity latch; `rerun` coalesces
  // every schedule that arrives while a drain is in flight into ONE extra pass.
  const state = new Map();

  function stateFor(dir) {
    if (!state.has(dir)) state.set(dir, { running: false, rerun: false, blockedUntilMs: 0 });
    return state.get(dir);
  }

  /**
   * Deliver one record. Returns {retire} / {stop, reason}.
   */
  async function processRecord(dir, record, routeKey) {
    const updateId = Number(record.updateId);
    const messageId = downstreamMessageId(updateId);

    // (3) Re-resolve from the STORED chatId every time. A chat that has been
    // re-pointed since the append must not deliver to its old destination, and
    // must not be silently redirected to the new one either — hold it.
    const route = resolveRoute ? resolveRoute(record.chatId) : null;
    if (!route || route.ok !== true) {
      return { stop: true, reason: `route_unresolved:${route?.reason || 'unknown'}` };
    }
    const liveKey = route.profile || route.windowKey || 'main';
    const liveWindow = route.windowKey || 'main';
    if (liveKey !== routeKey
      || (record.targetProfile && route.profile && record.targetProfile !== route.profile)
      || (record.targetWindow && record.targetWindow !== liveWindow)) {
      return { stop: true, reason: 'route_changed' };
    }

    // (4) A terminal record never reaches a pane; it only needs its route
    // validated before being retired, which just happened.
    if (record.terminalDisposition) {
      return { retire: true, terminal: true };
    }

    // (6) Crash after downstream accept but before ack: the record is still
    // pending, but a receipt already exists for this exact messageId. Retire it
    // instead of injecting a second visible copy.
    if (await hasExistingReceipt(messageId, routeKey)) {
      log.info('Telegram', `Drain found an existing receipt for ${messageId}; retiring without re-injection`);
      return { retire: true, replayed: true };
    }

    let receipt;
    try {
      receipt = await deliver({
        messageId,
        updateId,
        text: record.text,
        from: record.from,
        chatId: record.chatId,
        routeKey,
        windowKey: liveWindow,
        profile: route.profile || routeKey,
        // Deliver into the CURRENT session, but keep the session the message
        // originally belonged to to preserve context.
        sessionScopeId: currentSessionFor(liveWindow),
        originalSessionScopeId: record.targetSession || null,
        media: record.media,
        metadata: record.rawMetadata || {},
        record,
      });
    } catch (err) {
      return { stop: true, reason: `deliver_threw:${err.message}` };
    }

    // (5) The acceptance-proof gate.
    if (!isProvenOwnership(receipt)) {
      return { stop: true, reason: `unproven_acceptance:${receipt?.status || 'no_receipt'}` };
    }
    return { retire: true };
  }

  async function drainOnce(dir, routeKey) {
    const pending = queue.readPending(dir).slice().sort(byUpdateId);
    let delivered = 0;
    let stoppedAt = null;

    for (const record of pending) {
      const outcome = await processRecord(dir, record, routeKey);
      if (outcome.stop) {
        // (2) STOP. N+1 must not pass an unretired N, or order and
        // at-most-once both go out the window.
        stoppedAt = { updateId: Number(record.updateId), reason: outcome.reason };
        log.warn('Telegram', `Drain stopped at update ${record.updateId} (${outcome.reason}); ${pending.length - delivered} pending`);
        break;
      }

      const ack = queue.ack(dir, [record.updateId]);
      if (!ack || ack.ok !== true || ack.acked !== 1) {
        // An ack failure after downstream ownership is not loss — the receipt
        // seam will retire it on the next pass — but continuing would let N+1
        // pass an un-retired N.
        stoppedAt = { updateId: Number(record.updateId), reason: 'ack_failed' };
        log.warn('Telegram', `Drain could not retire update ${record.updateId}; stopping`);
        break;
      }
      delivered += 1;
    }

    return { ok: true, delivered, pending: pending.length, stoppedAt };
  }

  /**
   * Coalescing, single-flight schedule. Concurrent callers get ONE drain, plus
   * at most one follow-up pass so work appended during a drain is not stranded.
   */
  async function schedule(dir, routeKey) {
    const st = stateFor(dir);
    if (st.running) {
      st.rerun = true;
      return { ok: true, coalesced: true };
    }
    st.running = true;
    let last = { ok: true, delivered: 0, pending: 0, stoppedAt: null };
    try {
      do {
        st.rerun = false;
        last = await drainOnce(dir, routeKey);
        if (last.stoppedAt) {
          st.blockedUntilMs = backoffMs;
          break;
        }
      } while (st.rerun);
    } finally {
      st.running = false;
    }
    return last;
  }

  /** (3) Only safe route dirs directly below the canonical spool root. */
  function discoverRouteDirs(dataRoot, listDir) {
    const base = spool.resolveSpoolDir(dataRoot, 'probe');
    if (!base.ok) return { ok: false, reason: base.reason };
    const root = path.dirname(base.dir);
    let names;
    try {
      names = listDir(root);
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true, routes: [] };
      return { ok: false, reason: `list_failed:${err.message}` };
    }
    const routes = names
      .filter((name) => spool.isSafeRouteKey(name))
      .map((routeKey) => ({ routeKey, dir: path.join(root, routeKey) }));
    return { ok: true, routes };
  }

  return {
    schedule,
    drainOnce,
    discoverRouteDirs,
    _internals: { isProvenOwnership, downstreamMessageId, processRecord, state },
  };
}

module.exports = {
  createDrainCoordinator,
  isProvenOwnership,
  downstreamMessageId,
  DEFAULT_BACKOFF_MS,
};
