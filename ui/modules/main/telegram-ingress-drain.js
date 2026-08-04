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
  isUnattainableReason,
  evaluateConsumptionProof,
  summarizeBacklog,
} = require('./telegram-consumption-proof');
const {
  claimAttemptView,
  decideClaimDisposition,
} = require('./telegram-attempt-authority');


const DEFAULT_BACKOFF_MS = 30 * 1000;

// Only these may retire a record without delivering it.
//
// `consumed_verified_out_of_band` (S491) covers the one shape the automatic
// path provably cannot resolve: a record that WAS consumed and answered, whose
// attempt predates attempt timestamps, so no receipt can be ordered against it.
// It is only ever written by explicit operator recovery, never by a timer, and
// the sidecar refuses to store one without the evidence that justified it.
const TERMINAL_DISPOSITIONS = new Set(['empty_body', 'consumed_verified_out_of_band']);

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
 *                    readAttemptRecords and readDispositions: legacy attempt
 *                    storage is part of the same ownership boundary, and
 *                    binding it elsewhere leaves an injected queue half-owned.
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
  const requireAttemptOp = (name) => {
    const fn = queue && typeof queue[name] === 'function' ? queue[name] : null;
    if (!fn) {
      throw new Error(`drain queue is missing the attempt API: ${name}`);
    }
    return fn.bind(queue);
  };
  const readAttemptRecords = requireAttemptOp('readAttemptRecords');
  const readDispositions = requireAttemptOp('readDispositions');

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
   * Release the claim a just-refused delivery created, on the transport's own
   * first-hand refusal. Returns {held:false} when the record may be retried and
   * {held:true, outcome} when the release could not be made and the queue must
   * stop instead.
   *
   * THE CLAIM IS RE-READ, not remembered. The one we read before delivering was
   * null by definition on a first attempt — the claim is created INSIDE the
   * delivery sequence — so closing "the claim we saw earlier" would close
   * nothing at all and report success.
   */
  async function releaseClaimAfterRejection({ updateId, routeKey, messageId, receipt }) {
    let current = null;
    try {
      const read = await lookupTransportClaim({ updateId, routeKey, messageId });
      current = read && read.claim ? read.claim : null;
    } catch (err) {
      return {
        held: true,
        outcome: { stop: true, reason: `claim_lookup_failed:${err.message}`, failureClass: 'awaiting_proof' },
      };
    }
    // Refused before a claim existed: nothing is latched, so nothing to release.
    if (!current) return { held: false };

    let closed;
    try {
      closed = await closeUnsentTransportClaim({
        claimId: current.claimId,
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
      // Most often `claim_not_provably_unsent`: the claim is at
      // delivery_started, so the bytes were authorised and this refusal cannot
      // prove they were never written. Hold.
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
  async function processRecord(dir, record, routeKey, st, attemptsRead) {
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
    // FAIL CLOSED BEFORE READING EITHER SIDECAR. An unreadable attempt or
    // disposition journal must hold, and it has to be checked HERE rather than
    // further down: treating an unreadable disposition file as "no disposition"
    // would be a fail-open read in the one place that retires without delivery.
    if (!attemptsRead || attemptsRead.error) {
      const message = attemptsRead?.error?.message || 'attempt journal not read';
      return { stop: true, reason: `attempt_journal_unreadable:${message}`, failureClass: 'awaiting_proof' };
    }

    // A disposition may come from the record itself or from the append-only
    // sidecar. The sidecar cannot INVENT one for a record that already carries
    // a different disposition — that would let a recovery quietly reclassify
    // history — so the record's own value wins where both exist.
    const overlaid = attemptsRead.dispositions.get(updateId) || null;
    const effectiveDisposition = record.terminalDisposition || (overlaid ? overlaid.disposition : null);
    if (effectiveDisposition) {
      if (!TERMINAL_DISPOSITIONS.has(effectiveDisposition)) {
        return { stop: true, reason: 'unknown_terminal_disposition', failureClass: 'definite' };
      }
      if (overlaid && !record.terminalDisposition) {
        log.info(
          'Telegram',
          `Retiring ${messageId} on recorded disposition ${effectiveDisposition} (${overlaid.evidence}); no delivery, no re-injection`
        );
      }
      return { retire: true, terminal: true, visible: false };
    }

    // (6) Crash after downstream accept but before ack: the record is still
    // pending, but a receipt already exists for this exact messageId. Retire it
    // instead of injecting a second visible copy.
    // READ THE DURABLE ATTEMPT FIRST. Everything below - the expected identity,
    // the receipt lookup, the proof gate - has to be able to ask what the record
    // was actually waiting for, and it cannot do that after the fact.
    //
    // WHICH LATCH IS AUTHORITATIVE IS DECIDED BY THE EVIDENCE PRESENT (B5).
    // A record already carrying an OUTSTANDING legacy attempt is judged by that
    // attempt forever - update 808499316 above all - because a claim written for
    // it now would invent the identity of a delivery that may already have
    // reached James. Everything else is judged by the DB claim, which the
    // delivery sequence creates before any bytes reach a pane.
    const legacyAttempt = attemptsRead.attempts.get(updateId) || null;
    const legacyOutstanding = !!(legacyAttempt && legacyAttempt.state === 'attempted');

    let claim = null;
    if (!legacyOutstanding) {
      try {
        const claimRead = await lookupTransportClaim({
          updateId,
          routeKey,
          messageId,
        });
        claim = claimRead && claimRead.claim ? claimRead.claim : null;
      } catch (err) {
        // WE CANNOT TELL WHETHER THIS WAS ALREADY CLAIMED. Post-cutover the
        // claim is the only latch, so an unreadable claim store is exactly the
        // "I do not know if he has seen this" case, and delivering into it is
        // how the fix would have shipped the duplicate it exists to prevent.
        return {
          stop: true,
          reason: `claim_lookup_failed:${err.message}`,
          failureClass: 'awaiting_proof',
        };
      }
    }

    // ONE `attempt` for everything below. Legacy record or claim projection,
    // the proof gate asks the same question of both: what delivery is this
    // record waiting on, and does the evidence answer THAT delivery.
    const attempt = legacyOutstanding ? legacyAttempt : claimAttemptView(claim);
    // THE BACKLOG SNAPSHOT COUNTS ATTEMPTS, and post-cutover the attempts live
    // in the claim. Without this the health surface reports zero attempted for
    // a queue whose head has been delivered and is waiting on proof — a channel
    // that looks idle while it is actually blocked.
    if (!legacyOutstanding && attempt && attemptsRead.claimAttempts) {
      attemptsRead.claimAttempts.set(updateId, attempt);
    }

    const expectedIdentity = {
      messageId,
      routeKey,
      windowKey: liveWindow,
      profile: route.profile || routeKey,
      // The STORED chat id, threaded through so a proof lookup can correlate
      // against the row it needs. Without it the replay check matches nothing.
      chatId: record.chatId ?? null,
      // WHICH GENERATION THE DURABLE ATTEMPT IS WAITING ON - not which process
      // happens to be asking.
      //
      // This used to be `sessionGeneration()`, built BEFORE the attempt was even
      // read, so after a restart the exact-field comparison rejected generation
      // G's own receipt against the current G+1 before any attempt-aware check
      // could run. The one case that must survive a restart could not.
      //
      // Deriving it from the attempt keeps both halves honest: a G receipt
      // answers a G attempt, and a G+1 receipt still cannot, because the
      // comparison below is against the attempt's generation either way.
      generation: (attempt && typeof attempt.generation === 'string' && attempt.generation.trim())
        ? attempt.generation
        : sessionGeneration(),
    };
    // DURABLE AMBIGUITY CHECK (Architect #80). An attempt recorded but never
    // resolved means we may already have shown this to the user.
    //
    // READ ONCE PER PASS, by the loop, and handed down. We cannot tell what was
    // already tried when it is unreadable — fail closed and hold rather than
    // deliver something the user may already have seen.
    //
    // THIS IS READ BEFORE THE REPLAY LOOKUP, and that order is load-bearing.
    // The attempt is what dates the delivery that any proof must postdate, so a
    // replay check performed without it can only ask the weaker question "does
    // some correlated receipt exist" — which a stale receipt, or one from a
    // previous process generation, answers YES to. Readability was already
    // enforced above, before the disposition overlay.

    let existing = null;
    try {
      existing = await findExistingReceipt(expectedIdentity);
    } catch (err) {
      // We cannot tell whether this already landed. Delivering would risk a
      // second visible copy, so HOLD.
      return { stop: true, reason: 'receipt_lookup_failed', failureClass: 'indefinite' };
    }

    // ONE proof gate for both the crash-replay path and the outstanding-attempt
    // path. They used to be judged by different standards — replay by a
    // four-field correlation, attempts by nothing at all — which meant a receipt
    // that was too old, or from another process generation, could retire a
    // record through the replay door that the attempt door would have held.
    const proofOutcome = evaluateConsumptionProof({
      evidence: existing,
      expected: expectedIdentity,
      attempt,
      nowMs: now(),
    });
    if (proofOutcome.proven) {
      log.info('Telegram', `Drain found exact consumption proof for ${messageId}; retiring without re-injection`);
      // Downstream owns it, but it is not retired until the ack lands. On a
      // fresh process an ack failure plus a transiently empty lookup would
      // otherwise re-deliver.
      if (st) st.awaitingProof = updateId;
      return { retire: true, replayed: true };
    }

    if (legacyOutstanding) {
      // S491. An outstanding attempt used to end the story right here: hold,
      // forever, with no way to distinguish "proof is still coming" from "proof
      // can never come". That single unanswerable question muted the channel
      // for 8.6 hours.
      //
      // Proof has already been evaluated above and did not land. So the only
      // question left is the one nothing used to ask: is proof for
      // this pane obtainable AT ALL? A runtime that has never once produced a
      // receipt is not slow, it is unwired — a configuration defect wearing the
      // costume of patience. Either way we HOLD, because 318 ("Not the tankless
      // job the other one") must never reach James without 317. But the hold
      // now carries its own diagnosis to the health surface.
      const capability = probeRuntimeProofCapability({
        runtime: paneRuntimeFor(liveWindow, routeKey),
        receiptActivity: receiptActivity(),
        nowMs: now(),
        windowMs: proofCapabilityWindowMs,
      });

      // THE RECORD'S OWN RESOLVABILITY IS REPORTED FIRST, because it is the
      // cause that decides which repair is the right one. Runtime capability is
      // still reported alongside - both facts are true and both matter - but
      // they are no longer collapsed into one reason string that names only the
      // runtime.
      const resolvability = classifyAttemptResolvability(attempt, sessionGeneration());
      if (!resolvability.resolvable) {
        return {
          stop: true,
          reason: `orphaned_attempt:${resolvability.reason}`,
          failureClass: 'awaiting_proof',
          // Permanent, and not because of the runtime. No receipt can retire
          // this record; only an explicit recorded resolution can.
          unattainable: true,
          resolutionRequired: true,
          orphanedAttempt: { ...resolvability.detail, reason: resolvability.reason },
          proofRuntime: capability.runtime,
          runtimeProofAttainable: capability.attainable,
          runtimeProofReason: capability.reason,
        };
      }

      return {
        stop: true,
        reason: capability.attainable
          ? `unresolved_delivery_attempt:${proofOutcome.reason}`
          : `unprovable_pane:${capability.reason}`,
        failureClass: 'awaiting_proof',
        unattainable: !capability.attainable,
        resolutionRequired: false,
        proofRuntime: capability.runtime,
        runtimeProofAttainable: capability.attainable,
        runtimeProofReason: capability.reason,
      };
    }

    // THE CLAIM'S DECISION IS MADE HERE, ABOVE THE IN-PROCESS LATCH, for the
    // same reason the legacy branch above it is: an outstanding attempt has to
    // be DIAGNOSED before anything reports the generic "awaiting_proof". Below
    // the latch, the second pass of a wedged queue answers with a process-local
    // flag and health loses the runtime capability finding entirely - which is
    // the reporting failure that made an 8.6-hour outage read like patience.
    const disposition = decideClaimDisposition({
      claim,
      currentGeneration: sessionGeneration(),
      proofOutcome,
    });
    if (disposition.action === 'hold') {
      // THE DIAGNOSIS DOES NOT GET LOST AT THE CUTOVER.
      //
      // The legacy branch answers "is proof obtainable from this runtime at
      // all", and that question is exactly as live for a claim: an authorised
      // delivery whose pane can never produce a receipt holds FOREVER, and
      // health has to be able to say so instead of reporting patience. So an
      // ambiguous claim reuses the SAME reason vocabulary the rest of the
      // system already reads, and the claim-specific fact travels alongside it
      // rather than replacing it.
      if (disposition.reason === 'claim_delivery_started_unproven') {
        const capability = probeRuntimeProofCapability({
          runtime: paneRuntimeFor(liveWindow, routeKey),
          receiptActivity: receiptActivity(),
          nowMs: now(),
          windowMs: proofCapabilityWindowMs,
        });
        return {
          stop: true,
          reason: capability.attainable
            ? `unresolved_delivery_attempt:${proofOutcome.reason}`
            : `unprovable_pane:${capability.reason}`,
          failureClass: 'awaiting_proof',
          unattainable: !capability.attainable,
          resolutionRequired: false,
          proofRuntime: capability.runtime,
          runtimeProofAttainable: capability.attainable,
          runtimeProofReason: capability.reason,
          claimDisposition: { ...(disposition.detail || {}), state: 'delivery_started' },
        };
      }
      return {
        stop: true,
        reason: disposition.reason,
        failureClass: disposition.failureClass,
        unattainable: disposition.unattainable === true,
        resolutionRequired: disposition.resolutionRequired === true,
        claimDisposition: disposition.detail || null,
      };
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

    // ===================================================================
    // THE ATTEMPT LATCH IS THE CLAIM NOW, AND THE CLAIM IS NOT WRITTEN HERE.
    // ===================================================================
    // This used to append `attempted` to delivery-attempts.jsonl immediately
    // before `deliver()`. Post-cutover that is a SECOND independent authority
    // for one attempt, written before the first one exists: crash in between
    // and JSONL says "attempted" while the database says nothing was ever
    // claimed, forever irreconcilable. The delivery sequence creates the claim
    // at step B, before any bytes reach a pane, so the latch is created by the
    // same transaction that authorises the delivery it describes.
    //
    // A failure BEFORE the claim therefore leaves nothing latched and nothing
    // delivered - an honest retry - which is the property the JSONL write was
    // trying and failing to buy.
    if (disposition.action === 'close_then_attempt') {
      // A PROVABLY UNSENT CLAIM HELD BY A BOOT THAT HAS ENDED. Releasing the
      // slot is a recorded, append-only decision - never a timeout, never an
      // age heuristic - and it must SUCCEED before anything is delivered. A
      // failed close means the slot is still held, and delivering anyway would
      // be the theft the claim exists to forbid.
      let closed;
      try {
        closed = await closeUnsentTransportClaim({
          claimId: disposition.close.claimId,
          reason: disposition.close.reason,
          atMs: now(),
        });
      } catch (err) {
        return {
          stop: true,
          reason: `claim_close_threw:${err.message}`,
          failureClass: 'awaiting_proof',
        };
      }
      if (!closed || closed.ok !== true) {
        return {
          stop: true,
          reason: `claim_close_refused:${closed?.reason || 'unknown'}`,
          failureClass: 'awaiting_proof',
        };
      }
      log.info(
        'Telegram',
        `Closed provably-unsent claim ${disposition.close.claimId} for ${messageId} (${disposition.close.reason}); re-attempting`
      );
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
        // THE JSONL `retryable` ROW IS GONE; the claim is what gets resolved.
        //
        // A HARD REJECTION IS FIRST-HAND EVIDENCE THAT NOTHING WAS WRITTEN, and
        // it is the one release that does not need a dead process or an
        // operator: the transport we just called told us it refused. So the
        // claim is CLOSED as provably unsent, right here, by the call site that
        // owns the failure - not silently re-claimed by a later pass, which is
        // the thing Oracle forbade.
        //
        // AND THE DATABASE HAS THE FINAL WORD. `closeUnsentClaim` permits the
        // move only from `claimed`; a claim already at `delivery_started` is
        // past the authorisation boundary and its close is REFUSED, which turns
        // this into a hold. That is the state machine ruling, not this branch
        // deciding it is safe. Without the close, every transient refusal would
        // wedge the queue until the next boot.
        if (!legacyOutstanding) {
          const released = await releaseClaimAfterRejection({ updateId, routeKey, messageId, receipt });
          if (released.held) return released.outcome;
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

    // ONE read of the ambiguity latch per pass, shared by the per-record checks
    // and the health summary below. Reading it twice invited the two halves of
    // the same pass to disagree about what had been attempted.
    let attemptsRead;
    try {
      attemptsRead = {
        attempts: readAttemptRecords(dir),
        dispositions: readDispositions(dir),
        // Filled by processRecord from the DB claims it reads this pass, so the
        // backlog summary below sees post-cutover attempts too.
        claimAttempts: new Map(),
        error: null,
      };
    } catch (err) {
      attemptsRead = {
        attempts: new Map(), dispositions: new Map(), claimAttempts: new Map(), error: err,
      };
    }

    for (const record of pending) {
      // Dispose can land mid-batch. Continuing would deliver N+1 while the app
      // is tearing down journals underneath us.
      if (disposed) {
        stoppedAt = { updateId: Number(record.updateId), reason: 'coordinator_disposed', failureClass: 'awaiting_proof' };
        break;
      }
      const outcome = await processRecord(dir, record, routeKey, st, attemptsRead);
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
        };
        if (outcome.resolutionRequired) {
          // THE RECORD ITSELF IS UNRESOLVABLE, whatever the runtime does.
          // Separate from the runtime branch on purpose: sending someone to fix
          // hooks for THIS record wastes the outage, and that is not a
          // hypothetical - it is what the single collapsed message did.
          const orphan = outcome.orphanedAttempt || {};
          log.error(
            'Telegram',
            `TELEGRAM INGRESS WEDGED at update ${record.updateId}: ${outcome.reason}. `
            + `Its durable attempt cannot be resolved by ANY receipt (${orphan.reason || 'unknown'}), so this is `
            + 'not something the pane runtime can fix and waiting will never clear it. '
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
      // only one of them is blind to exactly half the queue.
      attempts: new Map([...attemptsRead.attempts, ...(attemptsRead.claimAttempts || new Map())]),
      blocked: stoppedAt,
      lastRetirementAtMs: st.lastRetirementAtMs || null,
      nowMs: now(),
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
  TERMINAL_DISPOSITIONS,
  downstreamMessageId,
  DEFAULT_BACKOFF_MS,
};
