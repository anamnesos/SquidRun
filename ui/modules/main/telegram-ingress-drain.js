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
  async function processRecord(dir, record, routeKey, st, journal) {
    const updateId = Number(record.updateId);
    const messageId = downstreamMessageId(updateId);

    // ===================================================================
    // THE MANDATORY LEGACY-FILE GATE (v7 §2). FIRST, BEFORE EVERYTHING.
    // ===================================================================
    // "Unreadable / malformed / conflicting journal stops the head and every
    // later source." Checked before the route, before the claim lookup, before
    // any decision and any delivery, because a pass that cannot read what was
    // already attempted has nothing to reason with. The snapshot was taken ONCE
    // for the whole pass, so failing here at the head stops N and N+1 alike
    // with no claim lookup, no decision, no deliver, no ack, and no write.
    // ===================================================================
    // THE ACTIVATION MODE IS ASKED FIRST, BEFORE THE FILES (v7 §3 Phase L).
    // ===================================================================
    // Ahead of the journal gate on purpose: "which operating state is this
    // process in" is more fundamental than "what do the sidecars say", and a
    // process that cannot answer it has no business reading a journal in order
    // to decide something it is not authorised to decide. An unhealthy mode
    // therefore costs zero sidecar reads as well as zero claims, deliveries,
    // acks and writes.
    const activation = journal ? journal.activation : null;
    if (!activation || activation.ok !== true) {
      const reason = (activation && activation.reason) || 'activation_mode_unresolved';
      return {
        stop: true,
        reason: `activation_mode_unhealthy:${reason}`,
        failureClass: 'awaiting_proof',
        // Not a wait. No pass will resolve this without someone configuring the
        // mode, so health must say "a person has to set this" rather than
        // reporting patience at a channel that is refusing to operate.
        unattainable: true,
        resolutionRequired: true,
        activationMode: { mode: null, reason, detail: (activation && activation.detail) || null },
      };
    }

    const snapshot = journal ? journal.snapshot : null;
    if (!snapshot || snapshot.ok !== true) {
      const reason = (snapshot && snapshot.reason) || 'journal_snapshot_missing';
      return {
        stop: true,
        reason: `legacy_journal_gate:${reason}`,
        failureClass: 'awaiting_proof',
        // A MALFORMED JOURNAL IS NOT A WAIT. Nothing this process does on any
        // later pass will make those bytes parse, so health has to say "a
        // person must look at this file" rather than report patience at a queue
        // that will never move on its own.
        unattainable: true,
        resolutionRequired: true,
        legacyGate: {
          action: 'snapshot_failed',
          reason,
          detail: (snapshot && snapshot.detail) || null,
        },
      };
    }

    // The per-source verdict: pure, total, and derived only from this record
    // and that one snapshot. Nothing below re-reads a file to second-guess it.
    const gate = evaluateLegacySourceGate({ record, snapshot });
    if (gate.ok !== true) {
      return {
        stop: true,
        reason: `legacy_journal_gate:${gate.reason}`,
        failureClass: 'awaiting_proof',
        unattainable: true,
        resolutionRequired: true,
        legacyGate: { action: 'gate_refused', reason: gate.reason, detail: null },
      };
    }

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
    //
    // ===================================================================
    // TWO AUTHORITIES FOR ONE RETIREMENT, RECONCILED OUT LOUD
    // ===================================================================
    // A disposition may come from the record itself or from the append-only
    // sidecar, and this used to read:
    //
    //     record.terminalDisposition || overlaid.disposition
    //
    // under a comment claiming the record's value "wins" so a recovery could not
    // quietly reclassify history. `||` reconciles nothing. It takes the first
    // truthy value and never looks at the second, so a sidecar disposition that
    // DISAGREED with the record was not refused — it was never compared, and
    // the comment described a check that was not there. Two authorities saying
    // different things about whether James's message is finished is exactly the
    // case that must stop, and it was the one case being read straight past.
    //
    // So: compare both, and act only where they agree or only one exists.
    // ABSENT IS `null`/`undefined`, AND NOTHING ELSE (Architect #122).
    //
    // The obvious spelling of this is
    //
    //     typeof x === 'string' && x.trim() ? x.trim() : null
    //
    // and it is a fail-open read wearing a type guard: `''`, `'   '`, `0`, `{}`
    // and every other malformed present value NORMALISE INTO ABSENCE, so a
    // record whose disposition field is corrupt gets delivered as though it had
    // never carried one. Queue records spell absence as `null`; anything else
    // present is a record we cannot read, and an unreadable field on the one
    // path that retires without delivering is a HOLD, not a shrug.
    //
    // OWN PROPERTY ONLY, for the same reason `telegram-source-protocol` reads
    // own properties: a classification satisfiable through a prototype is a
    // classification that can be borrowed.
    const rawDisposition = record && typeof record === 'object'
      && Object.prototype.hasOwnProperty.call(record, 'terminalDisposition')
      ? record.terminalDisposition
      : undefined;
    let recordDisposition = null;
    if (rawDisposition !== null && rawDisposition !== undefined) {
      if (typeof rawDisposition !== 'string' || rawDisposition.trim() === '') {
        // PRESENT AND UNREADABLE. Named apart from the unrecognised-value case
        // below so the person reading health knows whether to go looking for a
        // disposition nobody defined or for a writer that produced garbage.
        return {
          stop: true,
          reason: 'unknown_record_terminal_disposition',
          failureClass: 'definite',
          legacyGate: {
            action: 'unknown_record_terminal_disposition',
            reason: 'unknown_record_terminal_disposition',
            detail: { type: typeof rawDisposition },
          },
        };
      }
      recordDisposition = rawDisposition.trim();
      // AN UNRECOGNISED VALUE IS NOT A DISPOSITION AT ALL. Checked before the
      // comparison below, because "unknown vs known" is not a disagreement to
      // arbitrate — one of the two sides cannot be read. (The sidecar side needs
      // no such check: the gate refuses to parse an unrecognised disposition, so
      // an unknown value there already failed the whole pass above.)
      if (!isRecognizedTerminalDisposition(recordDisposition)) {
        return {
          stop: true,
          reason: 'unknown_terminal_disposition',
          failureClass: 'definite',
          legacyGate: {
            action: 'unknown_terminal_disposition',
            reason: 'unknown_terminal_disposition',
            detail: { record: recordDisposition },
          },
        };
      }
    }
    const sidecarEntry = snapshot.dispositions.get(updateId) || null;
    const sidecarDisposition = sidecarEntry ? sidecarEntry.disposition : null;

    // A SOURCE THIS BUILD MAY NOT PROCESS IS NOT RETIRED BY IT EITHER (v7 §2).
    // The protocol holds outrank a record-carried disposition: a `decision_v1`
    // record whose journal shows a legacy attempt is two regimes disagreeing
    // about what the update even IS, and acking it on the strength of a field
    // we are not yet authorised to act on would settle that disagreement by
    // discarding it. A clean `decision_v1` source holds for the stable fence,
    // which is Step 3 and does not exist in this build.
    if (gate.action === GATE_ACTIONS.PROTOCOL_CONFLICT || gate.action === GATE_ACTIONS.REQUIRES_FENCE) {
      return {
        stop: true,
        reason: `legacy_journal_gate:${gate.action}`,
        failureClass: 'awaiting_proof',
        unattainable: true,
        resolutionRequired: true,
        legacyGate: { action: gate.action, reason: gate.action, detail: gate.detail || null },
      };
    }

    if (recordDisposition && sidecarDisposition && recordDisposition !== sidecarDisposition) {
      // NEITHER SIDE MAY OVERWRITE THE OTHER. No ack, no delivery, no write —
      // a person decides which of the two is the truth about this message.
      return {
        stop: true,
        reason: 'terminal_disposition_conflict',
        failureClass: 'awaiting_proof',
        unattainable: true,
        resolutionRequired: true,
        legacyGate: {
          action: 'terminal_disposition_conflict',
          reason: 'terminal_disposition_conflict',
          detail: { record: recordDisposition, sidecar: sidecarDisposition },
        },
      };
    }

    const effectiveDisposition = recordDisposition || sidecarDisposition;
    if (effectiveDisposition) {
      // ONE RETIREMENT, whether one authority said it or both said the same
      // thing. Reaching here with a sidecar value means the gate returned
      // RETIRE_TERMINAL, so the `attempted` latch 808499316 also carries is the
      // RESOLVED shape rather than a contradiction — attempted long ago, since
      // proven answered, retired now with nothing injected at a pane.
      if (sidecarEntry && !recordDisposition) {
        log.info(
          'Telegram',
          `Retiring ${messageId} on recorded disposition ${effectiveDisposition} (${sidecarEntry.evidence}); no delivery, no re-injection`
        );
      }
      return { retire: true, terminal: true, visible: false };
    }

    // ===================================================================
    // OUTSTANDING LEGACY ATTEMPT: STOP HERE (v7 §2, Architect #119)
    // ===================================================================
    // "exact matching state='attempted': legacy authority remains; HOLD unless
    // an exact validated terminal disposition already retires it." A validated
    // disposition would have retired it directly above, so reaching this line
    // means there is none, and the only correct next step is to stop.
    //
    // THIS USED TO CONTINUE. The old code looked up a receipt and ran
    // `evaluateConsumptionProof` against the JSONL attempt, and could retire the
    // record automatically when the proof matched. Architect #119 ruled that
    // out and the reasoning holds: the v0 latch is unversioned, carries no
    // producing generation for the shape that matters, and a proof path built on
    // it decides "James already saw this" from a record that cannot say who
    // delivered it. The G->G+1 proof story belongs to the post-cutover DB claim,
    // which is created by the same transaction that authorises the delivery.
    // Exact proof for a legacy record is still usable — through explicit
    // recovery, which WRITES the reviewed disposition, and the disposition then
    // authorises the zero-injection retirement above.
    //
    // So: no claim lookup, no receipt lookup, no proof evaluation, no deliver,
    // no ack, no write. The runtime capability probe below reads only injected
    // in-memory getters and is diagnosis, not a step toward delivery.
    const legacyAttempt = snapshot.attempts.get(updateId) || null;
    if (gate.action === GATE_ACTIONS.HOLD_ATTEMPTED) {
      const capability = probeRuntimeProofCapability({
        runtime: paneRuntimeFor(liveWindow, routeKey),
        receiptActivity: receiptActivity(),
        nowMs: now(),
        windowMs: proofCapabilityWindowMs,
      });
      // WHICH KIND OF UNRESOLVABLE, still named separately. Both hold and both
      // need a written disposition, but only one of them is ALSO the record
      // whose attempt no receipt could ever have ordered — 808499316 — and
      // collapsing them is what once sent an operator to repair hooks for a
      // record no hook repair can reach.
      const resolvability = classifyAttemptResolvability(legacyAttempt, sessionGeneration());
      return {
        stop: true,
        reason: resolvability.resolvable
          ? 'hold_legacy_attempted:awaiting_reviewed_disposition'
          : `orphaned_attempt:${resolvability.reason}`,
        failureClass: 'awaiting_proof',
        // Permanent until somebody writes the disposition. Never a wait.
        unattainable: true,
        resolutionRequired: true,
        orphanedAttempt: resolvability.resolvable
          ? null
          : { ...resolvability.detail, reason: resolvability.reason },
        proofRuntime: capability.runtime,
        runtimeProofAttainable: capability.attainable,
        runtimeProofReason: capability.reason,
        legacyGate: { action: gate.action, reason: 'legacy_attempt_outstanding', detail: null },
      };
    }

    // Everything from here is `legacy_pane_only`: `retryable`, or no journal
    // match at all. The ordinary repaired pane path, judged by the DB claim,
    // which the delivery sequence creates before any bytes reach a pane.

    // (6) Crash after downstream accept but before ack: the record is still
    // pending, but a receipt already exists for this exact messageId. Retire it
    // instead of injecting a second visible copy.
    let claim = null;
    // THE CLOSED SLOTS TRAVEL WITH THE CLAIM. Dropping them here is how a
    // legacy closed_unsent row carrying an append-only delivery_started reached
    // the disposition as a plain "no claim" and authorised a second delivery
    // (Oracle #21). The read already knows; this is the wire that carries it.
    let closedClaims = [];
    try {
      const claimRead = await lookupTransportClaim({
        updateId,
        routeKey,
        messageId,
      });
      claim = claimRead && claimRead.claim ? claimRead.claim : null;
      closedClaims = claimRead && Array.isArray(claimRead.closedClaims)
        ? claimRead.closedClaims
        : [];
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

    // ONE `attempt` for everything below: what delivery is this record waiting
    // on, and does the evidence answer THAT delivery.
    const attempt = claimAttemptView(claim);
    // THE BACKLOG SNAPSHOT COUNTS ATTEMPTS, and post-cutover the attempts live
    // in the claim. Without this the health surface reports zero attempted for
    // a queue whose head has been delivered and is waiting on proof — a channel
    // that looks idle while it is actually blocked.
    if (attempt && journal.claimAttempts) {
      journal.claimAttempts.set(updateId, attempt);
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

    // THE CLAIM'S DECISION IS MADE HERE, ABOVE THE IN-PROCESS LATCH, for the
    // same reason the legacy hold above it stops early: an outstanding attempt
    // has to be DIAGNOSED before anything reports the generic "awaiting_proof". Below
    // the latch, the second pass of a wedged queue answers with a process-local
    // flag and health loses the runtime capability finding entirely - which is
    // the reporting failure that made an 8.6-hour outage read like patience.
    const disposition = decideClaimDisposition({
      claim,
      closedClaims,
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
        // AND THE DATABASE HAS THE FINAL WORD. `closeUnsentClaim` refuses any
        // claim carrying a durable `delivery_started` event and any claim past
        // `claimed`, so a refusal from the far side of the authorisation
        // boundary turns into a hold. That is the state machine ruling, not
        // this branch deciding it is safe. Without the close, every transient
        // refusal would wedge the queue until the next boot.
        //
        // ONLY THE CLAIM THIS DELIVERY OWNS. The receipt names it; nothing here
        // goes looking (Oracle #13, blocker 2).
        const released = await releaseClaimAfterRejection({ receipt });
        if (released.held) return released.outcome;
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
