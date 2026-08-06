/**
 * Best-effort ordered drain for the Telegram ingress spool.
 *
 * The delivery contract is intentionally small: process records in updateId
 * order, use the transport claim as an at-most-once key, log failures loudly,
 * retire the record, and keep moving. A failed record must never hold N+1.
 */

const path = require('path');
const defaultQueue = require('../telegram-inbound-durable-queue');
const spool = require('./telegram-ingress-spool');
const { summarizeBacklog } = require('./telegram-consumption-proof');
const { resolveActivationMode } = require('./telegram-activation-mode');

function downstreamMessageId(updateId) {
  return `telegram-in-${updateId}`;
}

function byUpdateId(a, b) {
  return Number(a.updateId) - Number(b.updateId);
}

/**
 * @param {object} deps
 *   queue            durable queue module. MUST provide readPending and ack.
 *   resolveRoute     (chatId) => {ok, profile, windowKey, ...}
 *   deliver          async (job) => receipt
 *   lookupTransportClaim async ({updateId, routeKey}) => {claim}|null
 *   currentSessionFor (windowKey) => string|null
 *   log
 */
function createDrainCoordinator(deps = {}) {
  const queue = deps.queue || defaultQueue;

  // The transport claim is the at-most-once key. A missing or throwing lookup
  // is surfaced at warn and delivery proceeds: possible duplication is the
  // accepted failure mode; a muted channel is not.
  const lookupTransportClaim = typeof deps.lookupTransportClaim === 'function'
    ? deps.lookupTransportClaim
    : async () => { throw new Error('drain has no transport claim lookup'); };
  // Activation mode remains published as health metadata. It is not delivery
  // authority: missing or invalid metadata must not hold the queue.
  const activationModeSource = typeof deps.activationMode === 'function'
    ? deps.activationMode
    : () => { throw new Error('drain has no activation mode seam'); };
  // `error` belongs in the floor, not just the default. The wedge path is the
  // one that fires when everything else has already gone wrong, and a logger
  // without .error would turn the alarm itself into the crash.
  const injectedLog = deps.log || {};
  const log = {
    info: typeof injectedLog.info === 'function' ? injectedLog.info.bind(injectedLog) : () => {},
    warn: typeof injectedLog.warn === 'function' ? injectedLog.warn.bind(injectedLog) : () => {},
    error: typeof injectedLog.error === 'function'
      ? injectedLog.error.bind(injectedLog)
      : (typeof injectedLog.warn === 'function' ? injectedLog.warn.bind(injectedLog) : () => {}),
  };
  const resolveRoute = deps.resolveRoute;
  const deliver = deps.deliver;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const currentSessionFor = deps.currentSessionFor || (() => null);

  // Per-directory state. `running` is the exclusivity latch; `rerun` coalesces
  // every schedule that arrives while a drain is in flight into ONE extra pass.
  const state = new Map();
  let disposed = false;
  const inFlight = new Set();

  function stateFor(dir) {
    if (!state.has(dir)) {
      state.set(dir, { running: false, rerun: false, lastRetirementAtMs: null });
    }
    return state.get(dir);
  }

  /** Deliver one record and report what happened for diagnostics only. */
  // ===================================================================
  // DELIVER THE MESSAGE. THAT IS THE WHOLE JOB.
  // ===================================================================
  // This replaced 583 lines whose job was deciding NOT to deliver.
  //
  // The previous design demanded consumption proof before retiring a record,
  // and that proof could not be produced, so `lastRetirementAtMs` was 0: the
  // drain never once completed its job in the field. Six days of James's
  // messages sat in the spool behind five independent locks — consumption
  // proof, the awaiting_proof latch, the durable attempt sidecar as a gate,
  // the legacy journal gate, and the runtime capability probe. Each was
  // defensible alone. Together they could not pass a single text message.
  //
  // The control group was in the same app the whole time: James types into the
  // terminal, it appears in the pane, and that path has never failed. It has no
  // proof system. This function is now that path plus a dedupe key.
  //
  // AT MOST ONCE, NOT EXACTLY ONCE. The transport claim is the key. It is
  // written by the delivery sequence. A crash around that boundary can cost a
  // duplicate or one message; those are accepted rare failures. The claim may
  // not become a second proof system that holds the entire channel.
  //
  // FAILURE NEVER HOLDS THE LINE. A message we could not deliver is logged
  // loudly and the NEXT one still goes. Head-of-line blocking is what turned
  // one stuck update into a dead channel.
  async function processRecord(record, routeKey) {
    const updateId = Number(record.updateId);
    const messageId = downstreamMessageId(updateId);

    // Re-resolve from the STORED chatId. A chat re-pointed since the append must
    // not deliver to its old destination, and must not be silently redirected to
    // a new one either — that is a wrong recipient, not a late message.
    const route = resolveRoute ? resolveRoute(record.chatId) : null;
    if (!route || route.ok !== true) {
      log.error(
        'Telegram',
        `Dropping update ${updateId}: route unresolved (${route?.reason || 'unknown'}). `
        + 'It is retired rather than held, because a message with no destination will '
        + 'never acquire one by waiting, and holding it would stop every message behind it.'
      );
      return { delivered: false, dropped: true };
    }
    const liveWindow = route.windowKey || 'main';

    // THE DEDUPE KEY. A recorded claim means this update was already injected
    // once, by this process or a previous one. Retire it; do not show it twice.
    //
    // A lookup that THROWS means we cannot tell. We deliver anyway and accept a
    // possible duplicate, because the alternative is the six-day silence this
    // replaced. That direction is deliberate and is the whole doctrine.
    let alreadyInjected = false;
    try {
      const claim = await lookupTransportClaim({
        updateId,
        routeKey,
        windowKey: liveWindow,
        profile: route.profile || routeKey,
      });
      alreadyInjected = Boolean(claim && claim.claim);
    } catch (err) {
      log.warn(
        'Telegram',
        `Claim lookup failed for update ${updateId} (${err.message}); delivering anyway. `
        + 'A possible duplicate is the accepted cost; a message withheld because we could '
        + 'not check a key is not.'
      );
    }
    if (alreadyInjected) {
      log.info('Telegram', `Update ${updateId} was already claimed; retiring without re-delivery`);
      return { delivered: false, deduped: true };
    }

    try {
      const receipt = await deliver({
        messageId,
        updateId,
        text: record.text,
        from: record.from,
        chatId: record.chatId,
        routeKey,
        windowKey: liveWindow,
        profile: route.profile || routeKey,
        // Deliver into the CURRENT session, but keep the session the message
        // originally belonged to so context survives a restart.
        sessionScopeId: currentSessionFor(liveWindow),
        originalSessionScopeId: record.targetSession || null,
        media: record.media,
        metadata: record.rawMetadata || {},
        record,
      });
      // THE RECEIPT IS A LOG LINE, NOT A GATE. We record what the transport said
      // and retire the record either way. Reading this value and deciding to
      // hold on it is how the previous design stopped delivering entirely.
      if (!receipt || receipt.ok === false) {
        log.error(
          'Telegram',
          `Update ${updateId} was NOT confirmed delivered (${receipt?.status || 'no status'}). `
          + 'It is retired and the queue continues. If James is waiting on this one he will '
          + 'text again, and that retry is the recovery path — by design.'
        );
      }
    } catch (err) {
      log.error(
        'Telegram',
        `Delivery threw for update ${updateId}: ${err.message}. Retiring and continuing; `
        + 'the next message still goes.'
      );
    }

    return { delivered: true };
  }

  async function runPass(dir, routeKey) {
    if (disposed) return { ok: false, reason: 'coordinator_disposed', delivered: 0, pending: 0, stoppedAt: null };
    const st = stateFor(dir);
    const pending = queue.readPending(dir).slice().sort(byUpdateId);
    const unretired = [];
    let retired = 0;
    let stoppedAt = null;

    // Activation mode remains health metadata only. It is deliberately not a
    // delivery gate, and a bad value does not stop this pass.
    let activation;
    try {
      activation = resolveActivationMode(activationModeSource());
    } catch (err) {
      activation = { ok: false, mode: null, reason: `activation_mode_threw:${err.message}`, detail: null };
    }

    for (let index = 0; index < pending.length; index += 1) {
      const record = pending[index];
      // Dispose can land mid-batch. Continuing would deliver N+1 while the app
      // is tearing down the poller and delivery transport underneath us.
      if (disposed) {
        stoppedAt = { updateId: Number(record.updateId), reason: 'coordinator_disposed', failureClass: 'shutdown' };
        unretired.push(...pending.slice(index));
        break;
      }
      await processRecord(record, routeKey);

      let ack;
      try {
        ack = queue.ack(dir, [record.updateId]);
      } catch {
        ack = { ok: false, reason: 'ack_threw' };
      }
      if (!ack || ack.ok !== true || ack.acked !== 1) {
        unretired.push(record);
        log.error(
          'Telegram',
          `Drain could not retire update ${record.updateId}; leaving it pending and continuing. `
          + 'The next message still goes.'
        );
        continue;
      }
      st.lastRetirementAtMs = now();
      retired += 1;
    }

    // The backlog snapshot is produced on every pass because a
    // health surface that only hears about failures cannot tell "healthy" from
    // "not reporting".
    const backlog = summarizeBacklog({
      pending: unretired,
      attempts: new Map(),
      blocked: stoppedAt,
      lastRetirementAtMs: st.lastRetirementAtMs || null,
      nowMs: now(),
      activation,
    });
    return { ok: true, delivered: retired, pending: pending.length, stoppedAt, backlog };
  }

  /**
   * Public direct pass. It is literally schedule(): keeping a separate wrapper
   * created a two-way coalescing loss — a direct pass starting while a
   * scheduled one ran did not set `rerun`, and a schedule arriving during a
   * direct pass set a `rerun` the wrapper never consumed, so queued work was
   * silently dropped in both directions. One primitive, one latch, one loop.
   */
  async function drainOnce(dir, routeKey) {
    return schedule(dir, routeKey);
  }

  /**
   * Coalescing, single-flight schedule. Concurrent callers get ONE drain, plus
   * at most one follow-up pass so work appended during a drain is not stranded.
   */
  async function schedule(dir, routeKey) {
    // After dispose nothing may deliver. Refusing loudly beats a timer firing
    // into a half-torn-down app.
    if (disposed) return { ok: false, reason: 'coordinator_disposed' };
    const st = stateFor(dir);
    if (st.running) {
      st.rerun = true;
      return { ok: true, coalesced: true };
    }
    st.running = true;
    let settle;
    const tracked = new Promise((resolve) => { settle = resolve; });
    inFlight.add(tracked);
    let last = { ok: true, delivered: 0, pending: 0, stoppedAt: null };
    try {
      do {
        st.rerun = false;
        last = await runPass(dir, routeKey);
      } while (st.rerun && !disposed);
    } finally {
      st.running = false;
      inFlight.delete(tracked);
      settle();
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

  /** Stop new work and wait for anything already delivering to settle. */
  async function dispose() {
    disposed = true;
    // Let anything already delivering finish before the app tears down the
    // journals and poller underneath it.
    await Promise.all(Array.from(inFlight));
  }

  return {
    schedule,
    drainOnce,
    discoverRouteDirs,
    dispose,
    isDisposed: () => disposed,
  };
}

module.exports = {
  createDrainCoordinator,
};
