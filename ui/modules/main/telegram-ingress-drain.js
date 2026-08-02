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

const fs = require('fs');
const path = require('path');
const defaultQueue = require('../telegram-inbound-durable-queue');
const spool = require('./telegram-ingress-spool');


const ATTEMPTS_NAME = 'delivery-attempts.jsonl';

function attemptsPath(dir) {
  return path.join(dir, ATTEMPTS_NAME);
}

/**
 * Durable record of "we are about to put this in front of the user".
 *
 * WHY A FILE AND NOT A FLAG: the in-memory awaiting-proof latch dies with the
 * process, so this exact sequence re-delivered:
 *   pending N -> pane returns accepted.unverified -> latch set in memory ->
 *   app dies before the receipt persists -> restart -> empty map -> N injected
 *   a second time.
 * The attempt marker lives in the same route dir as the record it describes, so
 * it survives whatever kills the app between accepting and acking.
 *
 * An unresolved attempt is AMBIGUOUS, not proof of either outcome. Ambiguity
 * holds: a stuck queue is visible and recoverable, a duplicate in James's chat
 * is neither.
 */
function readAttemptState(dir) {
  const file = attemptsPath(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return new Map();
    // Unreadable attempt journal: we cannot know what was already tried.
    throw new Error(`attempt journal unreadable: ${err.message}`);
  }
  const state = new Map();
  const ALLOWED_STATES = new Set(['attempted', 'retryable']);
  // NO TORN-TAIL TOLERANCE (Architect #88, correcting my #83 allowance).
  // Skipping a torn fragment is not harmless here: appendAttempt seals the file
  // with a newline and appends after it, which promotes that fragment to
  // corrupt INTERIOR and poisons every later read. And this sidecar IS the
  // ambiguity latch — under storage or process failure the safe bias is HOLD,
  // never an inferred retry. Anything unreadable fails closed pending
  // controlled recovery.
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      throw new Error('attempt journal contains an unreadable entry');
    }
    // Parseable is not the same as valid. A record missing its state used to
    // read as "not attempted" and authorize delivery.
    const id = Number(entry && entry.updateId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error('attempt journal entry has an invalid updateId');
    }
    if (!ALLOWED_STATES.has(entry.state)) {
      throw new Error(`attempt journal entry has an unknown state: ${entry.state}`);
    }
    state.set(id, entry.state);
  }
  return state;
}

function appendAttempt(dir, updateId, entryState) {
  const file = attemptsPath(dir);
  fs.mkdirSync(dir, { recursive: true });
  // Terminate any torn tail first so a crashed partial line cannot swallow this
  // record by concatenation.
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      fs.closeSync(fd);
      if (last.toString('utf8') !== '\n') fs.appendFileSync(file, '\n', 'utf8');
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  fs.appendFileSync(file, `${JSON.stringify({ updateId, state: entryState })}\n`, 'utf8');
}

function normalizeUpdateId(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

const DEFAULT_BACKOFF_MS = 30 * 1000;

// Only these may retire a record without delivering it.
const TERMINAL_DISPOSITIONS = new Set(['empty_body']);

// Results that mean the delivery never happened. These are safe to retry, and
// must NOT enter the proof-only hold: latching a hard rejection would strand
// the message forever waiting for proof of something that never occurred.
const HARD_FAILURE_STATUSES = new Set([
  'daemon_not_connected',
  'pane_missing',
  'transport_failed',
  'rejected',
]);

/**
 * Did this result actually claim the message was taken? Only then may it enter
 * the proof-only hold. Anything that says otherwise is a definite failure.
 */
function looksAccepted(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  // POSITIVE ACCEPTANCE WINS, and it is checked FIRST. Real pane results such as
  // daemon_enter_failed / daemon_paste_end_failed come back {ok:false,
  // accepted:true} AFTER the text bytes were already written to the pane.
  // Reading ok:false first and retrying would duplicate or concatenate what is
  // already on screen. A brittle list of hard-failure statuses can never be
  // complete; an explicit acceptance signal can be trusted.
  if (receipt.accepted === true
    || receipt.queued === true
    || receipt.pendingQueued === true
    || receipt.receiptPending === true
    || receipt.verified === true
    || receipt.userVisible === true
    || receipt.durableHandoff === true) {
    return true;
  }
  if (typeof receipt.status === 'string' && receipt.status.startsWith('accepted')) return true;
  // Only now, with no acceptance signal at all, classify as rejected.
  if (receipt.ok === false) return false;
  if (typeof receipt.status === 'string' && HARD_FAILURE_STATUSES.has(receipt.status)) return false;
  return false;
}

// Statuses that mean a downstream consumer has taken responsibility. A
// persistedReceiptId on its own is NOT on this list: a row existing says only
// that somebody wrote something down, not that the message arrived.
const DOWNSTREAM_PROOF_STATUSES = new Set([
  'delivered.verified',
  'delivered.user_visible',
  'durable.pending_handoff',
]);

/**
 * THE TRAP THIS EXISTS FOR: squidrun-app upserts a comms-journal row with
 * direction:'inbound' and status:'brokered' under the SAME
 * `telegram-in-<updateId>` id BEFORE the message is delivered
 * (squidrun-app.js:14626). A boolean "is there a receipt for this id?" check
 * would find that row on the very first drain pass and retire the record
 * without ever delivering it, turning the crash-replay safeguard into a loss
 * machine. Our own bookkeeping is not evidence of our own delivery.
 */
function proofClassOf(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (evidence.direction === 'inbound') return null;
  if (evidence.status === 'brokered') return null;
  if (evidence.verified === true) return 'verified';
  if (evidence.userVisible === true) return 'user_visible';
  if (evidence.durableHandoff === true) return 'durable_handoff';
  if (typeof evidence.status === 'string' && DOWNSTREAM_PROOF_STATUSES.has(evidence.status)) {
    return 'allowlisted_status';
  }
  return null;
}

/**
 * Proof must be STRUCTURALLY CORRELATED to this exact message and route, not
 * merely truthy. A verified receipt for a different message, or for the same
 * message on a different route, proves nothing about this record.
 */
const IDENTITY_FIELDS = ['messageId', 'routeKey', 'windowKey', 'profile'];

function isCorrelatedProof(evidence, expected = {}) {
  if (!evidence || typeof evidence !== 'object') return false;
  // The EVIDENCE must carry every identity field itself and match exactly. An
  // earlier version merged the expected identity into the receipt before
  // validating, which meant the check was reading values it had just written:
  // a bare {verified:true} with no identity at all sailed through. Never
  // synthesize identity inside the validator. A delivery adapter may attach it
  // at the boundary, where it actually knows what it delivered.
  for (const field of IDENTITY_FIELDS) {
    const want = expected[field];
    if (typeof want !== 'string' || !want) return false;
    if (evidence[field] !== want) return false;
  }
  return proofClassOf(evidence) !== null;
}

/** Class check only; correlation is enforced by isCorrelatedProof. */
function isProvenOwnership(receipt) {
  return proofClassOf(receipt) !== null;
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
  const findExistingReceipt = deps.findExistingReceipt || (async () => null);
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const currentSessionFor = deps.currentSessionFor || (() => null);
  const backoffMs = Number.isFinite(Number(deps.backoffMs)) ? Number(deps.backoffMs) : DEFAULT_BACKOFF_MS;
  const sweepIntervalMs = Number.isFinite(Number(deps.sweepIntervalMs))
    ? Number(deps.sweepIntervalMs)
    : 60 * 1000;

  // Per-directory state. `running` is the exclusivity latch; `rerun` coalesces
  // every schedule that arrives while a drain is in flight into ONE extra pass.
  const state = new Map();
  let disposed = false;
  const inFlight = new Set();

  function stateFor(dir) {
    if (!state.has(dir)) {
      state.set(dir, { running: false, rerun: false, blockedUntilMs: 0, awaitingProof: null });
    }
    return state.get(dir);
  }

  /**
   * Deliver one record. Returns {retire} / {stop, reason}.
   */
  async function processRecord(dir, record, routeKey, st) {
    const updateId = Number(record.updateId);
    const messageId = downstreamMessageId(updateId);

    // (3) Re-resolve from the STORED chatId every time. A chat that has been
    // re-pointed since the append must not deliver to its old destination, and
    // must not be silently redirected to the new one either — hold it.
    const route = resolveRoute ? resolveRoute(record.chatId) : null;
    if (!route || route.ok !== true) {
      return { stop: true, reason: `route_unresolved:${route?.reason || 'unknown'}`, failureClass: 'definite' };
    }
    const liveKey = route.profile || route.windowKey || 'main';
    const liveWindow = route.windowKey || 'main';
    if (liveKey !== routeKey
      || (record.targetProfile && route.profile && record.targetProfile !== route.profile)
      || (record.targetWindow && record.targetWindow !== liveWindow)) {
      return { stop: true, reason: 'route_changed', failureClass: 'definite' };
    }

    // (4) A terminal record never reaches a pane; it only needs its route
    // validated before being retired, which just happened.
    // (4) Only an explicitly allowlisted disposition may retire without
    // delivery. A corrupted or unrecognised value must HOLD: an unknown reason
    // to skip delivery is not a reason to skip delivery.
    if (record.terminalDisposition) {
      if (!TERMINAL_DISPOSITIONS.has(record.terminalDisposition)) {
        return { stop: true, reason: 'unknown_terminal_disposition', failureClass: 'definite' };
      }
      return { retire: true, terminal: true, visible: false };
    }

    // (6) Crash after downstream accept but before ack: the record is still
    // pending, but a receipt already exists for this exact messageId. Retire it
    // instead of injecting a second visible copy.
    const expectedIdentity = {
      messageId,
      routeKey,
      windowKey: liveWindow,
      profile: route.profile || routeKey,
      // The STORED chat id, threaded through so a proof lookup can correlate
      // against the row it needs. Without it the replay check matches nothing.
      chatId: record.chatId ?? null,
    };
    let existing = null;
    try {
      existing = await findExistingReceipt(expectedIdentity);
    } catch (err) {
      // We cannot tell whether this already landed. Delivering would risk a
      // second visible copy, so HOLD.
      return { stop: true, reason: 'receipt_lookup_failed', failureClass: 'indefinite' };
    }
    if (isCorrelatedProof(existing, expectedIdentity)) {
      log.info('Telegram', `Drain found correlated downstream proof for ${messageId}; retiring without re-injection`);
      // Downstream owns it, but it is not retired until the ack lands. On a
      // fresh process an ack failure plus a transiently empty lookup would
      // otherwise re-deliver.
      if (st) st.awaitingProof = updateId;
      return { retire: true, replayed: true };
    }

    // DURABLE AMBIGUITY CHECK (Architect #80). An attempt recorded but never
    // resolved means we may already have shown this to the user. No proof was
    // found above, so we cannot tell — hold.
    let attempts;
    try {
      attempts = readAttemptState(dir);
    } catch (err) {
      // We cannot tell what was already tried. Fail closed: hold this record
      // rather than deliver something the user may already have seen.
      return { stop: true, reason: `attempt_journal_unreadable:${err.message}`, failureClass: 'awaiting_proof' };
    }
    if (attempts.get(updateId) === 'attempted') {
      return { stop: true, reason: 'unresolved_delivery_attempt', failureClass: 'awaiting_proof' };
    }

    // THE DUPLICATE TRAP (Architect #63). Once a delivery has been ACCEPTED but
    // not proved, this record may never be injected again on a timer. The submit
    // verifier deliberately waits 4+15+45+120+300s because a busy pane can take
    // that long to report prompt_submit; a 30s backoff followed by re-delivery
    // would put the same message in front of James twice. From here the only
    // way out is correlated proof arriving, or an explicit controlled recovery.
    if (st && st.awaitingProof === updateId) {
      return { stop: true, reason: 'awaiting_proof', failureClass: 'awaiting_proof' };
    }

    // Record the attempt BEFORE delivering. If this cannot be written durably we
    // must not deliver at all: an undelivered message is recoverable, an
    // unrecorded delivery is how a duplicate becomes invisible to us.
    try {
      appendAttempt(dir, updateId, 'attempted');
    } catch (err) {
      return { stop: true, reason: `attempt_marker_failed:${err.message}`, failureClass: 'definite' };
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
      // AMBIGUOUS, not definite: the pane may have received this before the
      // error surfaced. The durable attempt is deliberately left UNRESOLVED so
      // no timer may re-inject it; only proof or explicit recovery releases it.
      return { stop: true, reason: `deliver_threw:${err.message}`, failureClass: 'awaiting_proof' };
    }

    // (5) The acceptance-proof gate.
    // The delivery receipt is held to the same standard: it must carry the
    // identity of what it claims to have delivered.
    if (!isCorrelatedProof(receipt, expectedIdentity)) {
      // A hard rejection means nothing was delivered: retry it. Only a result
      // that actually claims acceptance enters the proof-only hold, or a
      // disconnected daemon would strand the message forever.
      if (!looksAccepted(receipt)) {
        // Nothing was delivered, so the attempt is resolved as "did not happen"
        // and may be retried. Leaving it unresolved would wedge the queue.
        try {
          appendAttempt(dir, updateId, 'retryable');
        } catch (err) {
          // Swallowing this and reporting a clean definite retry would let a
          // sweep re-deliver while the durable state still reads "attempted".
          // The label must agree with what a future timer is allowed to do.
          return {
            stop: true,
            reason: `attempt_state_write_failed:${err.message}`,
            failureClass: 'awaiting_proof',
          };
        }
        return {
          stop: true,
          reason: `delivery_rejected:${receipt?.status || 'no_receipt'}`,
          failureClass: 'definite',
        };
      }
      if (st) st.awaitingProof = updateId;
      return {
        stop: true,
        reason: `unproven_acceptance:${receipt?.status || 'no_receipt'}`,
        failureClass: 'awaiting_proof',
      };
    }

    // (2) Delivery succeeded and is proven — but it is not RETIRED until the ack
    // lands. Latch proof-only state here and let drainOnce clear it after a
    // successful ack. Clearing before the ack meant an ack failure plus a
    // momentarily empty receipt lookup would re-deliver visibly on the next
    // schedule.
    if (st) st.awaitingProof = updateId;
    return { retire: true, visible: true };
  }

  async function runPass(dir, routeKey) {
    // drainOnce is callable DIRECTLY (startup path), so it needs its own
    // disposed check: guarding only schedule() left a delivery path wide open
    // during teardown.
    if (disposed) return { ok: false, reason: 'coordinator_disposed', delivered: 0, pending: 0, stoppedAt: null };
    const st = stateFor(dir);
    const pending = queue.readPending(dir).slice().sort(byUpdateId);
    let delivered = 0;
    let stoppedAt = null;

    for (const record of pending) {
      // Dispose can land mid-batch. Continuing would deliver N+1 while the app
      // is tearing down journals underneath us.
      if (disposed) {
        stoppedAt = { updateId: Number(record.updateId), reason: 'coordinator_disposed', failureClass: 'awaiting_proof' };
        break;
      }
      const outcome = await processRecord(dir, record, routeKey, st);
      if (outcome.stop) {
        // (2) STOP. N+1 must not pass an unretired N, or order and
        // at-most-once both go out the window.
        stoppedAt = {
          updateId: Number(record.updateId),
          reason: outcome.reason,
          failureClass: outcome.failureClass || 'definite',
        };
        log.warn('Telegram', `Drain stopped at update ${record.updateId} (${outcome.reason}); ${pending.length - delivered} pending`);
        break;
      }

      let ack;
      try {
        ack = queue.ack(dir, [record.updateId]);
      } catch (err) {
        // (3) A throwing ack leaves the record exactly as unretired as a false
        // one does, so it must stop the queue in exactly the same way.
        ack = { ok: false, reason: 'ack_threw' };
      }
      if (!ack || ack.ok !== true || ack.acked !== 1) {
        // An ack failure after downstream ownership is not loss — the receipt
        // seam will retire it on the next pass — but continuing would let N+1
        // pass an un-retired N.
        stoppedAt = { updateId: Number(record.updateId), reason: 'ack_failed', failureClass: 'indefinite' };
        log.warn('Telegram', `Drain could not retire update ${record.updateId}; stopping`);
        break;
      }
      // Retired for real: only now is it safe to stop treating this record as
      // proof-only.
      if (st.awaitingProof === Number(record.updateId)) st.awaitingProof = null;
      delivered += 1;
    }

    // Nothing pending and nothing held: this route no longer needs a sweep.
    // Leaving it running would tick forever over an empty queue.
    if (!stoppedAt && delivered === pending.length) {
      stopProofSweep(dir);
    }
    return { ok: true, delivered, pending: pending.length, stoppedAt };
  }

  /**
   * Public direct pass. It MUST go through the same tracking as schedule():
   * an untracked drainOnce awaiting deliver() when dispose starts would let
   * dispose resolve immediately, and shutdown would then close journals out
   * from under a live delivery. It also has to respect the single-flight latch
   * so a direct pass cannot double-deliver alongside a scheduled one.
   */
  async function drainOnce(dir, routeKey) {
    if (disposed) return { ok: false, reason: 'coordinator_disposed', delivered: 0, pending: 0, stoppedAt: null };
    const st = stateFor(dir);
    if (st.running) return { ok: true, coalesced: true, delivered: 0, pending: 0, stoppedAt: null };
    st.running = true;
    let settle;
    const tracked = new Promise((resolve) => { settle = resolve; });
    inFlight.add(tracked);
    try {
      return await runPass(dir, routeKey);
    } finally {
      st.running = false;
      inFlight.delete(tracked);
      settle();
    }
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
    // (2) Bounded backoff on a real injected clock. Before expiry we do NOT
    // re-deliver N; after expiry the next pass re-checks correlated proof
    // first, so a message that landed during the wait gets retired rather than
    // injected a second time.
    if (st.blockedUntilMs > now()) {
      return { ok: true, blocked: true, blockedUntilMs: st.blockedUntilMs };
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
        if (last.stoppedAt) {
          // AUTO-ARM. Production has no caller standing by at the moment proof
          // lands, so a hold that waits for an external poke waits forever. The
          // first unresolved hold arms the sweep itself, exactly once per dir.
          if (last.stoppedAt.failureClass === 'awaiting_proof') {
            armProofSweep(dir, routeKey);
          }
          // Only a DEFINITE failure earns a retry deadline. An awaiting-proof
          // hold has no deadline at all: it is released by proof, not by time.
          if (last.stoppedAt.failureClass === 'definite') {
            st.blockedUntilMs = now() + backoffMs;
          }
          break;
        }
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

  /**
   * SELF-DRIVEN PROOF SWEEP. Without this a lone message that was accepted but
   * unproved waits forever: nothing else schedules a drain until the NEXT
   * inbound message arrives, so proof that lands in between is never noticed.
   * The timer only re-checks proof — it never re-delivers, because the
   * awaiting-proof latch and the durable attempt marker both still apply.
   */
  function armProofSweep(dir, routeKey) {
    if (disposed) return null;
    const st = stateFor(dir);
    // Exactly one per dir: re-arming on every hold would multiply timers for a
    // queue that is already stuck.
    if (st.sweepTimer) return st.sweepTimer;
    const timer = setInterval(() => {
      schedule(dir, routeKey).catch((err) => {
        log.warn('Telegram', `Proof sweep failed for ${routeKey}: ${err.message}`);
      });
    }, sweepIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    st.sweepTimer = timer;
    return timer;
  }

  function startProofSweep(dir, routeKey) {
    return armProofSweep(dir, routeKey);
  }

  function stopProofSweep(dir) {
    const st = state.get(dir);
    if (st && st.sweepTimer) {
      clearInterval(st.sweepTimer);
      st.sweepTimer = null;
    }
  }

  /** Cancel every sweep. Called on shutdown so no timer outlives the app. */
  async function dispose() {
    disposed = true;
    for (const dir of Array.from(state.keys())) stopProofSweep(dir);
    // Let anything already delivering finish before the app tears down the
    // journals and poller underneath it.
    await Promise.all(Array.from(inFlight));
  }

  return {
    schedule,
    drainOnce,
    discoverRouteDirs,
    startProofSweep,
    armProofSweep,
    stopProofSweep,
    dispose,
    isDisposed: () => disposed,
    _internals: {
    isProvenOwnership, isCorrelatedProof, downstreamMessageId, processRecord, state,
    readAttemptState, appendAttempt, attemptsPath,
  },
  };
}

module.exports = {
  createDrainCoordinator,
  attemptsPath,
  readAttemptState,
  appendAttempt,
  isProvenOwnership,
  isCorrelatedProof,
  proofClassOf,
  looksAccepted,
  IDENTITY_FIELDS,
  TERMINAL_DISPOSITIONS,
  downstreamMessageId,
  DEFAULT_BACKOFF_MS,
};
