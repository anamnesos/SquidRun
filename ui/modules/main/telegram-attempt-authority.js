/**
 * WHICH RECORD IS ALLOWED TO ANSWER "HAS THIS ALREADY BEEN ATTEMPTED?"
 *
 * =====================================================================
 * TWO LATCHES, ONE QUESTION, AND THE RULE THAT SEPARATES THEM
 * =====================================================================
 * `delivery-attempts.jsonl` was the attempt latch before the cutover. The DB
 * claim is the attempt latch after it. Both files exist on disk right now and
 * both will keep existing, because update 700100102 was attempted under the old
 * regime and can never grow a claim retroactively — writing one now would
 * invent the identity of a delivery that may already have reached Operator.
 *
 * So the rule is not "prefer the new one". It is:
 *
 *   A record that ALREADY CARRIES a legacy attempt is judged by the legacy
 *   latch, forever. Everything else is judged by the claim, and by nothing
 *   else.
 *
 * The rule is deliberately about the EVIDENCE PRESENT, not about a date, a
 * session number, or a "post-cutover" flag someone has to remember to set. A
 * timestamp comparison would have to be right about a boundary nobody recorded;
 * this asks a question the files themselves answer.
 *
 * =====================================================================
 * WHY THE DRAIN NO LONGER WRITES A JSONL ATTEMPT
 * =====================================================================
 * It used to write one immediately before `deliver()`. Post-cutover that is a
 * SECOND independent authority for one attempt, created before the first one
 * exists: a crash between the two leaves JSONL saying "attempted" and the
 * database saying nothing was ever claimed, and nothing can ever reconcile
 * them. One attempt, one latch. The claim is created inside the delivery
 * sequence, before any bytes reach a pane, which is exactly where a latch
 * belongs.
 *
 * This module is PURE. It reads no files and opens no database; the drain hands
 * it what it read. That is what makes every branch below testable without a
 * crash harness.
 */

/** Claim states as this decision layer reasons about them. */
const CLAIMED = 'claimed';
const DELIVERY_STARTED = 'delivery_started';
const ADMITTED = 'admitted';
const CLOSED_UNSENT = 'closed_unsent';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * IS THE PROCESS THAT MADE THIS CLAIM STILL RUNNING?
 *
 * Answered from published identity, and it is allowed to say "I don't know".
 *
 * The app generation is minted once per boot and published to the environment
 * (`app-generation.js`); one app process holds the per-profile single-instance
 * lock (`ui/main.js:132`), and the drain only ever runs inside that process. So
 * a claim carrying a DIFFERENT published generation was made by a boot that has
 * ended — not "probably", structurally, because two of them cannot have been
 * writing this ledger at once.
 *
 * When this process does not know its own generation, nothing here is
 * knowable and the answer is `null`. A caller must hold on `null`; treating
 * unknown as dead would let an unnamed process close a live claim and deliver a
 * second copy of the message the other one is mid-flight on.
 */
function classifyClaimantLiveness(claimGeneration, currentGeneration) {
  if (!isNonEmptyString(currentGeneration)) return { live: null, reason: 'current_generation_unpublished' };
  if (!isNonEmptyString(claimGeneration)) return { live: null, reason: 'claim_generation_unknown' };
  if (String(claimGeneration).trim() === String(currentGeneration).trim()) {
    return { live: true, reason: 'claim_generation_is_current' };
  }
  return { live: false, reason: 'claim_generation_superseded' };
}

/**
 * The attempt-shaped view of a claim, for the proof evaluator.
 *
 * PROJECTION, NOT SYNTHESIS: both values are columns of the claim row. The
 * evaluator's contract is "the attempt names the delivery, proof must answer
 * THAT delivery", and post-cutover the claim is what names it. A claim with no
 * outstanding attempt (closed, or absent) projects to `null`, which the
 * evaluator reads as "nothing to order proof against".
 */
function claimAttemptView(claim) {
  if (!claim) return null;
  if (String(claim.state) === CLOSED_UNSENT) return null;
  return {
    state: 'attempted',
    atMs: Number(claim.attemptAtMs),
    generation: claim.appGeneration,
    claimId: claim.claimId,
    attemptNonce: claim.attemptNonce,
    source: 'transport_claim',
  };
}

/**
 * What the drain may do with this record, given the claim it just read.
 *
 * Returns one of:
 *   {action:'attempt'}                     nothing is latched; deliver.
 *   {action:'close_then_attempt', close}   a dead process left a provably
 *                                          unsent claim; release it, then
 *                                          deliver.
 *   {action:'hold', reason, ...}           anything else. The reasons are
 *                                          deliberately distinct: they name
 *                                          which repair is the right one.
 */
function decideClaimDisposition(input = {}) {
  const {
    claim, closedClaims, currentGeneration, proofOutcome,
  } = input;

  // ===================================================================
  // A CLOSED ROW STILL CARRIES ITS DELIVERY, AND IT DECIDES FIRST (Oracle #21).
  //
  // This check sits ABOVE `!claim` because the hole it closes is precisely the
  // absent-claim path. The reader filters `closed_unsent` rows out of `claim`,
  // so a legacy slot holding the incoherent pair (closed_unsent + append-only
  // delivery_started) arrived here as claim: null — and the line below answered
  // `attempt`/`no_claim`, after which acquisition minted a second claim because
  // the exclusive index ignores closed rows. Oracle proved the whole chain on a
  // real ledger.
  //
  // The tuple is the unit: whether or not a live claim also exists, a stored D
  // event on a closed row of this update means bytes may already be on Operator's
  // screen, and that is a contradiction a human resolves, not one the drain
  // routes around.
  // ===================================================================
  const closedAfterDelivery = (Array.isArray(closedClaims) ? closedClaims : [])
    .filter((entry) => entry && (
      Number(entry.deliveryStartedAtMs) > 0
      || (Array.isArray(entry.eventKinds) && entry.eventKinds.includes(DELIVERY_STARTED))
    ));
  if (closedAfterDelivery.length > 0) {
    return {
      action: 'hold',
      reason: 'claim_closed_after_delivery_started',
      failureClass: 'awaiting_proof',
      unattainable: false,
      resolutionRequired: true,
      detail: {
        claimId: closedAfterDelivery[0].claimId ?? null,
        closedClaimIds: closedAfterDelivery.map((entry) => entry.claimId ?? null),
        deliveryStartedAtMs: closedAfterDelivery[0].deliveryStartedAtMs ?? null,
        closedAtMs: closedAfterDelivery[0].closedAtMs ?? null,
        liveClaimId: claim ? claim.claimId : null,
        storedState: claim ? String(claim.state) : null,
      },
    };
  }

  if (!claim) return { action: 'attempt', reason: 'no_claim' };

  const state = String(claim.state);
  const liveness = classifyClaimantLiveness(claim.appGeneration, currentGeneration);

  // ===================================================================
  // THE APPEND-ONLY EVENT DECIDES, NOT THE STATUS COLUMN (Oracle #13).
  //
  // Every branch below used to read `state` alone. `state` is mutable — the
  // claim identity trigger permits it to move — while `delivery_started` is an
  // append-only event, so when the two disagree the event is the record of what
  // actually happened and the column is an opinion about it. Oracle drove the
  // exploit on a real ledger: revert a delivery_started claim to `claimed` and
  // the old code answered close_then_attempt, closed it, and freed a message
  // whose bytes had already been authorised to be delivered a second time.
  //
  // This runs ABOVE the state machine on purpose. A contradiction is not a
  // state to route around; it is a fact about this database that a human has to
  // resolve, so it holds and says which two records disagree.
  // ===================================================================
  const deliveryStartedRecorded = Number(claim.deliveryStartedAtMs) > 0
    || (Array.isArray(claim.eventKinds) && claim.eventKinds.includes(DELIVERY_STARTED));
  if (deliveryStartedRecorded && state !== DELIVERY_STARTED && state !== ADMITTED) {
    return {
      action: 'hold',
      reason: 'claim_state_contradicts_delivery_started',
      failureClass: 'awaiting_proof',
      unattainable: false,
      resolutionRequired: true,
      detail: {
        claimId: claim.claimId,
        claimGeneration: claim.appGeneration,
        storedState: state,
        deliveryStartedAtMs: claim.deliveryStartedAtMs ?? null,
        claimantLive: liveness.live,
      },
    };
  }

  if (state === CLOSED_UNSENT) {
    // The slot was released by an explicit, recorded decision that nothing was
    // sent. That is the one way an attempt becomes retryable without proof.
    return { action: 'attempt', reason: 'claim_closed_unsent' };
  }

  if (state === DELIVERY_STARTED) {
    // AMBIGUOUS BY CONSTRUCTION. The bytes were authorised; whether they landed
    // is a question only a terminal receipt answers. Never re-inject, never
    // auto-close — not even for a dead generation, because the dead process may
    // have written the pane before it died.
    return {
      action: 'hold',
      reason: 'claim_delivery_started_unproven',
      failureClass: 'awaiting_proof',
      unattainable: false,
      resolutionRequired: false,
      detail: {
        claimId: claim.claimId,
        claimGeneration: claim.appGeneration,
        deliveryStartedAtMs: claim.deliveryStartedAtMs ?? null,
        deliveredPromptSha256: claim.deliveredPromptSha256 ?? null,
        proofReason: proofOutcome?.reason ?? null,
        claimantLive: liveness.live,
      },
    };
  }

  if (state === ADMITTED) {
    // Admitted means promotion already ran on terminal proof. Reaching here
    // means the proof lookup did NOT return that proof, so the two stores
    // disagree about a message that has been delivered. Holding is the only
    // reading that cannot put a second copy on screen.
    return {
      action: 'hold',
      reason: 'claim_admitted_without_terminal_proof',
      failureClass: 'awaiting_proof',
      unattainable: false,
      resolutionRequired: true,
      detail: {
        claimId: claim.claimId,
        claimGeneration: claim.appGeneration,
        proofReason: proofOutcome?.reason ?? null,
      },
    };
  }

  if (state === CLAIMED) {
    // PROVABLY UNSENT by the invariant: `delivery_started` is written before any
    // pane write and it is not there. The only question left is whether the
    // process holding it is still alive.
    if (liveness.live === false) {
      return {
        action: 'close_then_attempt',
        reason: 'claim_unsent_dead_generation',
        close: {
          claimId: claim.claimId,
          reason: `dead_generation:${claim.appGeneration}`,
        },
        detail: { claimGeneration: claim.appGeneration, currentGeneration },
      };
    }
    // LIVE OR UNKNOWN CLAIMANT IS NEVER STOLEN. A live one may be mid-sequence
    // right now; an unknown one cannot be ruled out. The in-process case also
    // covers a sequence that refused after B — provably unsent, and released by
    // explicit recovery or by the next boot, never by the next pass.
    return {
      action: 'hold',
      reason: liveness.live === true
        ? 'claim_held_by_live_generation'
        : `claim_liveness_unknown:${liveness.reason}`,
      failureClass: 'awaiting_proof',
      unattainable: false,
      resolutionRequired: false,
      detail: {
        claimId: claim.claimId,
        claimGeneration: claim.appGeneration,
        currentGeneration: currentGeneration ?? null,
        claimantLive: liveness.live,
      },
    };
  }

  // An unrecognised state is a database this code does not understand. Fail
  // closed: an unknown reason to deliver is not a reason to deliver.
  return {
    action: 'hold',
    reason: `claim_state_unknown:${state}`,
    failureClass: 'awaiting_proof',
    unattainable: false,
    resolutionRequired: true,
    detail: { claimId: claim.claimId },
  };
}

module.exports = {
  CLAIM_STATE_NAMES: Object.freeze({ CLAIMED, DELIVERY_STARTED, ADMITTED, CLOSED_UNSENT }),
  classifyClaimantLiveness,
  claimAttemptView,
  decideClaimDisposition,
};
