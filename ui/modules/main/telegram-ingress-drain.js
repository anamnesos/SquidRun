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
const {
  probeRuntimeProofCapability,
  evaluateConsumptionProof,
  summarizeBacklog,
} = require('./telegram-consumption-proof');
const {
  claimAttemptView,
  decideClaimDisposition,
} = require('./telegram-attempt-authority');
const {
  readLegacyJournalSnapshot,
  evaluateLegacySourceGate,
  GATE_ACTIONS,
  // Only these may retire a record without delivering it.
  //
  // `consumed_verified_out_of_band` (S491) covers the one shape the automatic
  // path provably cannot resolve: a record that WAS consumed and answered,
  // whose attempt predates attempt timestamps, so no receipt can be ordered
  // against it. It is only ever written by explicit operator recovery, never by
  // a timer, and the sidecar refuses to store one without the evidence that
  // justified it.
  //
  // A PREDICATE, NOT A SET, AND NOT A LOCAL COPY. This file used to keep its
  // own identical Set, so the gate's idea of a recognised disposition and the
  // drain's could drift apart by one edit — and the drain is the half that
  // retires a message without delivering it. Importing the Set would have been
  // worse than the copy: a frozen Set is still `.add()`-able, so the fix would
  // have handed every consumer in the process a way to authorise a retirement
  // (Architect #121). One authority, and it is not reachable from here.
  isRecognizedTerminalDisposition,
} = require('./telegram-legacy-journal');
const { resolveActivationMode } = require('./telegram-activation-mode');


const DEFAULT_BACKOFF_MS = 30 * 1000;

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

/**
 * IS THIS ATTEMPT RESOLVABLE BY PROOF AT ALL?
 *
 * =====================================================================
 * THE QUESTION NOBODY WAS ASKING
 * =====================================================================
 * The drain already asks "is proof obtainable from this RUNTIME" and reports
 * `unprovable_pane:runtime_never_produced_proof` when a pane has never produced
 * a receipt. That is a true statement about the runtime and it is the WRONG
 * DIAGNOSIS for update 808499316, which sends whoever reads it to repair hooks
 * and leaves the channel exactly as muted afterwards.
 *
 * The real reason 316 can never retire is in the RECORD, not the runtime. Its
 * durable latch is `{"updateId":808499316,"state":"attempted"}` - no `atMs`, no
 * `generation`. `evaluateConsumptionProof` requires both: a missing timestamp
 * returns `attempt_time_unknown` and a missing generation returns
 * `attempt_generation_unknown`, before any evidence is even considered. So NO
 * RECEIPT, however perfect, can resolve that record. Fixing the Codex receipt
 * path - which genuinely must happen for 317 onward - would not move 316 by one
 * inch, and a repair that reported only the runtime cause would have been
 * measured, shipped, and still wedged.
 *
 * Two different unprovable-nesses, two different repairs. Naming them
 * separately is the whole point.
 */
function classifyAttemptResolvability(attempt, currentGeneration) {
  if (!attempt || attempt.state !== 'attempted') {
    return { resolvable: true, reason: null };
  }
  const atMs = Number(attempt.atMs);
  const hasTime = Number.isFinite(atMs) && atMs > 0;
  const hasGeneration = typeof attempt.generation === 'string' && attempt.generation.trim() !== '';

  // A MISSING TIMESTAMP is structural: proof can never be ordered against it.
  // That is update 808499316.
  if (!hasTime) {
    return {
      resolvable: false,
      reason: 'attempt_time_unknown',
      detail: { hasAttemptTime: false, hasGeneration },
    };
  }

  // A MISSING GENERATION IS STRUCTURAL TOO, and my first reasoning about it was
  // wrong in an instructive way. I argued it was recoverable "because a
  // generation can be recorded". It cannot: this record is ALREADY in the
  // attempted state, so writing a generation onto it now would invent the
  // identity of a delivery that may have already reached the user. The only
  // honest generation for an attempt is the one the attempting process wrote at
  // the time, and a process that did not write one cannot be asked afterwards.
  //
  // The evaluator already fails closed here. The classifier has to agree, or
  // health reports "waiting" for something nothing will ever resolve.
  if (!hasGeneration) {
    return {
      resolvable: false,
      reason: 'attempt_generation_unknown',
      detail: { hasAttemptTime: true, hasGeneration: false },
    };
  }

  // A PRIOR-GENERATION ATTEMPT IS NOT AN ORPHAN. It is resolvable by exactly one
  // thing - its own durable receipt from that same generation - and a receipt
  // from the current generation never substitutes for it.
  return { resolvable: true, reason: null };
}

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
 *   queue            durable queue module. MUST provide readPending, ack,
 *                    attemptsPath and dispositionsPath: legacy attempt storage
 *                    is part of the same ownership boundary, and binding it
 *                    elsewhere leaves an injected queue half-owned.
 *   readJournalFile  (file) => string. The sidecar read seam, so a pass can be
 *                    counted and made to throw without touching a real disk.
 *   resolveRoute     (chatId) => {ok, profile, windowKey, ...}
 *   deliver          async (job) => receipt
 *   hasExistingReceipt async (messageId, routeKey) => bool   // crash-replay seam
 *   lookupTransportClaim async ({updateId, routeKey}) => {claim}|null
 *                    THE POST-CUTOVER ATTEMPT LATCH. Required; see below.
 *   closeUnsentTransportClaim async ({claimId, reason, atMs}) => {ok}
 *   currentSessionFor (windowKey) => string|null
 *   log
 */
function createDrainCoordinator(deps = {}) {
  const queue = deps.queue || defaultQueue;

  // Attempt storage MUST come from the same queue as readPending/ack. Binding
  // it at module load left an injected queue half-owned: pending reads went to
  // the injection while the ambiguity latch quietly hit the real disk, so a
  // test could believe it had isolated storage while production files moved.
  // Fail closed rather than silently falling back to the default module.
  //
  // WHAT MOVED HERE, AND WHAT DID NOT (v7 §2). The drain no longer uses the
  // queue's own PARSERS - `readLegacyJournalSnapshot` is the protocol gate and
  // it is strict where those are lenient - but the queue is still the authority
  // on WHERE the sidecars are. Keeping the path here and taking the parse
  // elsewhere is the whole change: same files, stricter reading.
  const requireAttemptOp = (name) => {
    const fn = queue && typeof queue[name] === 'function' ? queue[name] : null;
    if (!fn) {
      throw new Error(`drain queue is missing the attempt API: ${name}`);
    }
    return fn.bind(queue);
  };
  const attemptsPathFor = requireAttemptOp('attemptsPath');
  const dispositionsPathFor = requireAttemptOp('dispositionsPath');

  // ===================================================================
  // THE POST-CUTOVER LATCH SEAMS. REQUIRED, AND THE DEFAULT IS A HOLD.
  // ===================================================================
  // The drain no longer writes its own attempt row, so without a claim lookup
  // it has no way to learn that a previous process already delivered this
  // message. A default of "no claim" would read as "never attempted" and
  // deliver a second copy after every restart - the exact defect this repair
  // exists to remove, reintroduced as a convenience default. So an absent
  // lookup THROWS from the lookup itself, which `processRecord` turns into a
  // hold, and a caller that forgets to wire it gets a stuck queue rather than a
  // duplicate in front of James.
  const lookupTransportClaim = typeof deps.lookupTransportClaim === 'function'
    ? deps.lookupTransportClaim
    : async () => { throw new Error('drain has no transport claim lookup'); };
  const closeUnsentTransportClaim = typeof deps.closeUnsentTransportClaim === 'function'
    ? deps.closeUnsentTransportClaim
    : async () => ({ ok: false, reason: 'no_claim_close_seam' });
  // S491. The drain must be able to ask THREE questions it previously could
  // not: when was this attempted, which process attempted it, and is proof for
  // this pane obtainable at all. Each has a fail-closed default, because a
  // caller that cannot answer must produce a HOLD and not an assumption.
  const sessionGeneration = typeof deps.sessionGeneration === 'function'
    ? deps.sessionGeneration
    : () => (typeof deps.sessionGeneration === 'string' ? deps.sessionGeneration : null);
  const paneRuntimeFor = typeof deps.paneRuntimeFor === 'function'
    ? deps.paneRuntimeFor
    : () => null;
  const receiptActivity = typeof deps.receiptActivity === 'function'
    ? deps.receiptActivity
    : () => null;
  // The sidecar read seam. Left undefined the journal module uses fs directly,
  // which is what production wants; a test hands one in so "exactly one read
  // per pass" is a counted fact rather than a claim about code shape.
  const readJournalFile = typeof deps.readJournalFile === 'function' ? deps.readJournalFile : null;
  // ===================================================================
  // THE ACTIVATION MODE SEAM. REQUIRED, AND THE DEFAULT IS A HOLD.
  // ===================================================================
  // Same shape and same reason as the claim lookup above: a coordinator built
  // without being told which operating state it is in must WEDGE, not guess. A
  // default of `legacy_settlement` would let any caller that forgot to wire the
  // seam quietly claim Phase L, and a default of "no mode, carry on" would hand
  // `decision_v1` sources back to the pane path before a fence exists. So an
  // absent seam throws, `runPass` turns that into a named hold, and the queue
  // stops somewhere a person can read.
  const activationModeSource = typeof deps.activationMode === 'function'
    ? deps.activationMode
    : () => { throw new Error('drain has no activation mode seam'); };
  const proofCapabilityWindowMs = Number.isFinite(Number(deps.proofCapabilityWindowMs))
    ? Number(deps.proofCapabilityWindowMs)
    : undefined;
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
   * Release the claim THIS refused delivery created — and only that one.
   *
   * =====================================================================
   * WHY THIS NO LONGER RE-READS THE TUPLE (Oracle #13, blocker 2)
   * =====================================================================
   * It used to look the claim up by (updateId, routeKey) and close whatever
   * came back, reasoning that the claim is created inside the delivery sequence
   * so it cannot be "the one we saw earlier". That reasoning is right about
   * WHEN the claim appears and wrong about WHOSE it is. When the sequence loses
   * the race at B, the refusal is `claim_held_by_other` and the very next
   * lookup returns THE OTHER PROCESS'S LIVE CLAIM — which this function then
   * closed, releasing an in-flight delivery and inviting the duplicate the
   * latch exists to prevent. Oracle reproduced exactly that against the real
   * coordinator.
   *
   * So ownership is now stated by the only code that knows it: the sequence
   * returns its own claim id, the delivery glue puts it on the receipt as
   * `claimRelease`, and this function closes that id or nothing at all.
   *
   * A receipt with no `claimRelease` is treated as `none` — no close. That is
   * not a fail-open: closing is the dangerous act and it now requires explicit
   * ownership, while the decision to retry is separately gated by the claim
   * state machine, which holds on a live or unknown claimant and (since blocker
   * 1) on any stored delivery_started event.
   *
   * Returns {held:false} when the record may be retried and {held:true, outcome}
   * when the queue must stop instead.
   */
  async function releaseClaimAfterRejection({ receipt }) {
    const release = receipt && typeof receipt.claimRelease === 'object' && receipt.claimRelease
      ? receipt.claimRelease
      : { kind: 'none' };
    const kind = String(release.kind || 'none');

    if (kind === 'unknown') {
      // The delivery cannot say which side of the authorisation boundary it
      // ended on. Neither closing nor retrying is safe.
      return {
        held: true,
        outcome: {
          stop: true,
          reason: `claim_release_boundary_unknown:${receipt?.status || 'no_receipt'}`,
          failureClass: 'awaiting_proof',
        },
      };
    }
    // Nothing of ours is latched: refused before B, or lost the race at B. The
    // tuple may well hold someone else's claim; it is not ours to close.
    if (kind !== 'owned_unsent') return { held: false };

    const claimId = String(release.claimId || '').trim();
    if (!claimId) {
      // Claims ownership and cannot name it. That is a defect in the producer
      // of this receipt, not a licence to go looking for a claim to close.
      return {
        held: true,
        outcome: {
          stop: true,
          reason: 'claim_release_owned_without_id',
          failureClass: 'awaiting_proof',
        },
      };
    }

    let closed;
    try {
      closed = await closeUnsentTransportClaim({
        claimId,
        reason: `delivery_rejected:${receipt?.status || 'no_receipt'}`,
        atMs: now(),
      });
    } catch (err) {
      return {
        held: true,
        outcome: { stop: true, reason: `claim_close_threw:${err.message}`, failureClass: 'awaiting_proof' },
      };
    }
    if (!closed || closed.ok !== true) {
      // `claim_delivery_started_recorded` or `claim_not_provably_unsent`: the
      // store found durable evidence that bytes were authorised, so this
      // refusal cannot prove they were never written. The database has the
      // final word here, not the caller's belief about its own boundary.
      return {
        held: true,
        outcome: {
          stop: true,
          reason: `claim_close_after_rejection_refused:${closed?.reason || 'unknown'}`,
          failureClass: 'awaiting_proof',
        },
      };
    }
    return { held: false };
  }

  /**
   * Deliver one record. Returns {retire} / {stop, reason}.
   */
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
  // written inside the delivery sequence (telegram-admission-sequence.js:543),
  // which means it is recorded AT the injection and never before it — so a
  // crash can cost one duplicate and can never cost a message. Duplicate is the
  // chosen cheap failure: a confusing pair costs one clarifying text, and
  // silence cost the channel for six days.
  //
  // FAILURE NEVER HOLDS THE LINE. A message we could not deliver is logged
  // loudly and the NEXT one still goes. Head-of-line blocking is what turned
  // one stuck update into a dead channel.
  async function processRecord(dir, record, routeKey, st, journal) {
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
      return { stop: false, delivered: false };
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
      log.info('Telegram', `Update ${updateId} was already injected; retiring without re-delivery`);
      return { stop: false, delivered: false, deduped: true };
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

    return { stop: false, delivered: true };
  }

  /**
   * Read both sidecars once, or say exactly why not.
   *
   * THE QUEUE'S ANSWER IS CHECKED BEFORE IT IS USED (Architect #125).
   * `requireAttemptOp` proves the path methods EXIST; it says nothing about
   * what they return. A queue whose path methods hand back `''`, `null` or the
   * same string twice would reopen the half-owned storage split from the other
   * end — one collapsed file validating as two clean journals, or a fallback
   * derivation quietly reading files this queue does not own. No usable pair of
   * paths, no read at all.
   */
  function takeJournalSnapshot(dir) {
    try {
      const attemptsFile = attemptsPathFor(dir);
      const dispositionsFile = dispositionsPathFor(dir);
      const usable = (value) => typeof value === 'string' && value.trim() !== '';
      if (!usable(attemptsFile) || !usable(dispositionsFile)) {
        return { ok: false, reason: 'journal_path_unresolved', detail: null };
      }
      if (attemptsFile === dispositionsFile) {
        return { ok: false, reason: 'journal_path_collision', detail: null };
      }
      return readLegacyJournalSnapshot(dir, {
        ...(readJournalFile ? { readFile: readJournalFile } : {}),
        attemptsFile,
        dispositionsFile,
      });
    } catch (err) {
      return { ok: false, reason: `journal_snapshot_threw:${err.message}`, detail: null };
    }
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

    // ===================================================================
    // ONE SNAPSHOT PER ORDERED PASS (v7 §2)
    // ===================================================================
    // Both sidecars are read here, exactly once, and every record in this pass
    // is judged from that one snapshot. Not once per record: a pass that
    // re-read between updates could watch the journal change underneath it and
    // decide two records from two different worlds. Reading it twice within one
    // pass invited the same disagreement between the per-record checks and the
    // health summary below.
    //
    // The reader is strict where the queue's own parsers are lenient — see
    // telegram-legacy-journal.js for the four gaps that matter — and a snapshot
    // failure is carried to every record rather than thrown, so the head stops
    // with a named reason instead of the pass dying somewhere less legible.
    //
    // THE QUEUE'S ANSWER IS CHECKED BEFORE IT IS USED (Architect #125).
    // `requireAttemptOp` proves the methods EXIST; it says nothing about what
    // they return. A queue whose path methods hand back `''`, `null` or the
    // same string twice would otherwise reopen the half-owned storage split
    // from the other end — one collapsed file validating as two clean
    // journals, or a fallback derivation quietly reading files this queue does
    // not own. No usable pair of paths, no read at all.
    // ===================================================================
    // ONE ACTIVATION-MODE RESOLUTION PER PASS, BEFORE ANY FILE IS OPENED.
    // ===================================================================
    // Asked once and handed down for the same reason the snapshot is: two
    // records in one pass must not be decided under two different operating
    // states. A throwing seam is a refusal with a name, not a crash — the whole
    // pass then holds and says which seam could not answer.
    let activation;
    try {
      activation = resolveActivationMode(activationModeSource());
    } catch (err) {
      activation = { ok: false, mode: null, reason: `activation_mode_threw:${err.message}`, detail: null };
    }

    // NO SIDECAR READ AT ALL UNDER AN UNHEALTHY MODE. Reading would be harmless
    // in itself, and skipping it lets the counters say something stronger: the
    // pass touched nothing whatsoever, which is exactly the claim Phase L needs
    // to be able to make about its own refusals.
    const snapshot = activation.ok === true
      ? takeJournalSnapshot(dir)
      : { ok: false, reason: 'activation_mode_unhealthy', detail: null };
    const journal = {
      activation,
      snapshot,
      // Filled by processRecord from the DB claims it reads this pass, so the
      // backlog summary below sees post-cutover attempts too.
      claimAttempts: new Map(),
    };

    for (const record of pending) {
      // Dispose can land mid-batch. Continuing would deliver N+1 while the app
      // is tearing down journals underneath us.
      if (disposed) {
        stoppedAt = { updateId: Number(record.updateId), reason: 'coordinator_disposed', failureClass: 'awaiting_proof' };
        break;
      }
      const outcome = await processRecord(dir, record, routeKey, st, journal);
      if (outcome.stop) {
        // (2) STOP. N+1 must not pass an unretired N, or order and
        // at-most-once both go out the window. This is NOT negotiable and was
        // the exact invariant a bypass broke: 808499318 is a correction that
        // means the opposite of itself without 808499317 in front of it.
        stoppedAt = {
          updateId: Number(record.updateId),
          reason: outcome.reason,
          failureClass: outcome.failureClass || 'definite',
          // Carried out so health can tell a channel that is WAITING from a
          // channel that is BROKEN. Both hold; only one of them is news.
          unattainable: Boolean(outcome.unattainable),
          proofRuntime: outcome.proofRuntime || null,
          // AND WHICH KIND OF BROKEN. These were computed by processRecord and
          // then dropped here, so everything downstream - health, the log, the
          // person reading either - saw only "the runtime cannot produce proof"
          // and went to repair hooks for a record no hook repair can reach.
          resolutionRequired: Boolean(outcome.resolutionRequired),
          orphanedAttempt: outcome.orphanedAttempt || null,
          // WHICH DURABLE CLAIM IS HOLDING THIS, for the same reason the orphan
          // detail is carried: a hold whose cause is dropped here reaches health
          // as an unexplained wait.
          claimDisposition: outcome.claimDisposition || null,
          runtimeProofAttainable: outcome.runtimeProofAttainable ?? null,
          runtimeProofReason: outcome.runtimeProofReason || null,
          // WHICH GATE VERDICT HELD THIS, carried for the same reason as the
          // orphan detail: a hold whose cause is dropped here reaches health as
          // an unexplained wait, and a journal that will not parse is the least
          // guessable cause on the list.
          legacyGate: outcome.legacyGate || null,
          // WHICH OPERATING STATE REFUSED, when that is the cause. Carried for
          // the same reason as the gate detail: a hold whose cause is dropped
          // here reaches health as an unexplained wait, and "nobody configured
          // the activation mode" is the least guessable cause on the list.
          activationMode: outcome.activationMode || null,
        };
        if (outcome.activationMode) {
          log.error(
            'Telegram',
            `TELEGRAM INGRESS WEDGED at update ${record.updateId}: ${outcome.reason}. `
            + 'The transport activation mode is not a state this build can operate in '
            + `(${outcome.activationMode.reason}`
            + `${outcome.activationMode.detail ? `: ${JSON.stringify(outcome.activationMode.detail)}` : ''}), `
            + 'so this pass read no journal, looked up no claim, delivered nothing and acked nothing. '
            + `${pending.length - delivered} message(s) are undelivered, this one included. `
            + 'It needs a person to set the mode; no later pass will resolve it on its own.'
          );
        } else if (outcome.legacyGate && outcome.legacyGate.action !== GATE_ACTIONS.HOLD_ATTEMPTED) {
          // THE FILES, THE PROTOCOL, OR TWO AUTHORITIES DISAGREEING. None of
          // these is about a pane, a receipt or an attempt, so the orphan
          // wording below would send the reader to entirely the wrong place.
          log.error(
            'Telegram',
            `TELEGRAM INGRESS WEDGED at update ${record.updateId}: ${outcome.reason}. `
            + `The source gate refused this record (${outcome.legacyGate.action}`
            + `${outcome.legacyGate.detail ? `: ${JSON.stringify(outcome.legacyGate.detail)}` : ''}), so nothing `
            + 'was looked up, delivered or acked on this pass and no later pass will decide differently on its own. '
            + `${pending.length - delivered} message(s) are undelivered, this one included. `
            + 'It needs a person: repair or explain the journal, or resolve the protocol/disposition disagreement.'
          );
        } else if (outcome.resolutionRequired) {
          // THE RECORD ITSELF IS UNRESOLVABLE, whatever the runtime does.
          // Separate from the runtime branch on purpose: sending someone to fix
          // hooks for THIS record wastes the outage, and that is not a
          // hypothetical - it is what the single collapsed message did.
          const orphan = outcome.orphanedAttempt || {};
          log.error(
            'Telegram',
            `TELEGRAM INGRESS WEDGED at update ${record.updateId}: ${outcome.reason}. `
            + `Its durable legacy attempt is outstanding with no reviewed terminal disposition `
            + `(${orphan.reason || 'no validated disposition recorded'}), so no receipt may retire it and waiting `
            + 'will never clear it. '
            + `${pending.length - delivered} message(s) are undelivered, this one included. `
            + 'It needs an EXPLICIT recorded recovery for this one record, pinned to its own evidence. '
            + `Separately, pane runtime ${outcome.proofRuntime || 'unknown'} proof-capable=`
            + `${outcome.runtimeProofAttainable === null ? 'unknown' : outcome.runtimeProofAttainable}`
            + `${outcome.runtimeProofReason ? ` (${outcome.runtimeProofReason})` : ''} - which decides whether the `
            + 'records BEHIND it can drain once this one is resolved.'
          );
        } else if (outcome.unattainable) {
          log.error(
            'Telegram',
            `TELEGRAM INGRESS WEDGED at update ${record.updateId}: ${outcome.reason}. `
            + `Pane runtime ${outcome.proofRuntime || 'unknown'} cannot produce delivery proof, so this queue `
            + `cannot advance and ${pending.length - delivered} message(s) are undelivered. This is a configuration `
            + 'defect, not a transient wait.'
          );
        } else {
          log.warn('Telegram', `Drain stopped at update ${record.updateId} (${outcome.reason}); ${pending.length - delivered} pending`);
        }
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
      st.lastRetirementAtMs = now();
      delivered += 1;
    }

    // Nothing pending and nothing held: this route no longer needs a sweep.
    // Leaving it running would tick forever over an empty queue.
    if (!stoppedAt && delivered === pending.length) {
      stopProofSweep(dir);
    }
    // THE BACKLOG SNAPSHOT is produced on EVERY pass, held or clean, because a
    // health surface that only hears about failures cannot tell "healthy" from
    // "not reporting".
    const backlog = summarizeBacklog({
      pending: pending.slice(delivered),
      // BOTH LATCHES. Legacy rows and the claims read this pass; a summary over
      // only one of them is blind to exactly half the queue. A failed snapshot
      // contributes no legacy rows - it could not read any - and the count is
      // honest about that rather than reporting zero attempts as health.
      attempts: new Map([
        ...(snapshot.ok === true ? snapshot.attempts : new Map()),
        ...journal.claimAttempts,
      ]),
      blocked: stoppedAt,
      lastRetirementAtMs: st.lastRetirementAtMs || null,
      nowMs: now(),
      // PUBLISHED ON EVERY PASS, held or clean, and especially when the queue
      // is EMPTY. An install that has not been told which operating state it is
      // in will refuse every future message, and an empty queue is exactly the
      // moment that would otherwise read as a channel in perfect health.
      activation,
    });
    return { ok: true, delivered, pending: pending.length, stoppedAt, backlog };
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
    isProvenOwnership, isCorrelatedProof, classifyAttemptResolvability, downstreamMessageId, processRecord, state,
  },
  };
}

module.exports = {
  createDrainCoordinator,
  isProvenOwnership,
  isCorrelatedProof,
  classifyAttemptResolvability,
  proofClassOf,
  looksAccepted,
  IDENTITY_FIELDS,
  downstreamMessageId,
  DEFAULT_BACKOFF_MS,
};
// TERMINAL_DISPOSITIONS is deliberately NOT re-exported. It was exported here
// and imported by nobody, and re-exporting the authority now would hand every
// consumer of this module the same mutable-membership hole Architect #121
// caught. `telegram-legacy-journal` owns the question; ask it there.
