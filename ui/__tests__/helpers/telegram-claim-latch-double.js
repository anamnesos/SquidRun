/**
 * AN IN-MEMORY STAND-IN FOR THE POST-CUTOVER ATTEMPT LATCH.
 *
 * =====================================================================
 * WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT
 * =====================================================================
 * The drain suites that use this test DRAIN BEHAVIOUR - ordering, at-most-once,
 * proof correlation, backoff, dispose - against fake panes and fake queues.
 * They are not testing the admission kernel, and giving each of them a real
 * SQLite ledger would make them slower without making them stricter.
 *
 * So this double provides the two seams the drain now requires, with the same
 * OBSERVABLE contract the real store has:
 *
 *   claimed          an attempt exists and provably has not been delivered
 *   delivery_started the bytes were authorised; ambiguous from here
 *   closed_unsent    released, by first-hand refusal or a dead generation
 *
 * IT IS A DOUBLE AND IT IS NAMED ONE. The real store's rules - the exclusive
 * partial index, `closeUnsentClaim` permitting the move ONLY from `claimed`,
 * the append-only events - are proved against the real database in
 * `telegram-drain-claim-authority.test.js` and the admission-store suites. If
 * this file and the real store ever disagree, the real store is right and this
 * file is the bug.
 *
 * The one rule it does reproduce exactly, because every test here depends on
 * it: a close is REFUSED once `delivery_started` has been recorded.
 */

/**
 * @param {object} options
 *   generation  () => string   the app generation attempts are made under
 *   now         () => number
 */
function createClaimLatchDouble(options = {}) {
  const generation = typeof options.generation === 'function'
    ? options.generation
    : () => options.generation || 'app-session-test';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** key `${routeKey}:${updateId}` -> claim */
  const claims = new Map();
  const closed = [];
  let lookups = 0;
  let failLookup = null;

  const keyFor = (routeKey, updateId) => `${routeKey}:${Number(updateId)}`;

  async function lookupTransportClaim(query = {}) {
    lookups += 1;
    if (failLookup) throw new Error(failLookup);
    const claim = claims.get(keyFor(query.routeKey, query.updateId)) || null;
    const closedClaims = closed.filter((entry) => entry.key === keyFor(query.routeKey, query.updateId));
    if (!claim) return closedClaims.length ? { claim: null, closedClaims } : null;
    return { claim, closedClaims };
  }

  async function closeUnsentTransportClaim(input = {}) {
    for (const [key, claim] of claims) {
      if (claim.claimId !== input.claimId) continue;
      // THE REAL STORE'S HARD RULES, in the real store's order. The stored
      // delivery_started EVENT is asked first and outranks the state column,
      // because the column is mutable and the event is not (Oracle #13).
      if (claim.deliveryStartedAtMs !== null && claim.deliveryStartedAtMs !== undefined) {
        return {
          ok: false,
          reason: 'claim_delivery_started_recorded',
          state: claim.state,
          deliveryStartedAtMs: claim.deliveryStartedAtMs,
        };
      }
      if (claim.state !== 'claimed') {
        return { ok: false, reason: 'claim_not_provably_unsent', state: claim.state };
      }
      claims.delete(key);
      closed.push({ key, claimId: claim.claimId, reason: input.reason, closedAtMs: input.atMs });
      return { ok: true, claimId: claim.claimId, state: 'closed_unsent' };
    }
    return { ok: false, reason: 'claim_not_found' };
  }

  /**
   * Wrap a suite's existing `deliver` fake so it latches like production does:
   * a claim before any bytes, promoted to `delivery_started` only when the
   * delivery reports that it reached the pane.
   */
  function wrapDeliver(deliver, options = {}) {
    // WHICH GENERATION MADE THE ATTEMPT is the coordinator's answer, not this
    // double's: a restart test builds a second coordinator with a different
    // generation over the SAME latch, and stamping both from one shared getter
    // would erase the exact distinction those tests exist to make.
    const stamp = typeof options.generation === 'function' ? options.generation : generation;
    // THE COORDINATOR'S CLOCK, not this double's. Proof must postdate the
    // attempt, and a claim stamped from a different clock than the drain's makes
    // every ordering assertion accidental.
    const clock = typeof options.now === 'function' ? options.now : now;
    const isAccepted = options.isAccepted;
    const accepted = typeof isAccepted === 'function'
      ? isAccepted
      : (receipt) => Boolean(receipt && (receipt.ok === true
        || receipt.accepted === true
        || receipt.verified === true
        || receipt.userVisible === true
        || (typeof receipt.status === 'string' && receipt.status.startsWith('accepted'))
        || (typeof receipt.status === 'string' && receipt.status.startsWith('delivered'))));

    return async (job) => {
      const key = keyFor(job.routeKey, job.updateId);
      const claim = {
        claimId: `tgc_double_${key}_${claims.size}_${closed.length}`,
        cutoverId: 'tg-cutover-v1',
        routeKey: job.routeKey,
        updateId: Number(job.updateId),
        state: 'claimed',
        appGeneration: stamp(),
        attemptAtMs: clock(),
        attemptNonce: `n_${key}`,
        deliveryStartedAtMs: null,
      };
      claims.set(key, claim);
      let receipt;
      try {
        receipt = await deliver(job);
      } catch (err) {
        // A throw leaves the claim at `claimed`: nothing proved it reached a
        // pane, and nothing proved it did not.
        throw err;
      }
      if (accepted(receipt)) {
        claim.state = 'delivery_started';
        claim.deliveryStartedAtMs = clock();
        return receipt;
      }
      // ===================================================================
      // A RETURNED REFUSAL NAMES THE CLAIM IT OWNS (Oracle #13, blocker 2).
      //
      // Production's cleanup no longer re-reads the tuple and closes whatever
      // it finds — it closes the exact claim the delivery reports owning, and
      // nothing at all when the receipt names none. A double that omitted this
      // would leave its own claim latched under a LIVE generation, and every
      // "definite failures retry" test would go red for a reason production
      // does not have. A receipt that already carries its own answer keeps it.
      // ===================================================================
      if (receipt && typeof receipt === 'object' && receipt.claimRelease === undefined) {
        return { ...receipt, claimRelease: { kind: 'owned_unsent', claimId: claim.claimId } };
      }
      return receipt;
    };
  }

  return {
    lookupTransportClaim,
    closeUnsentTransportClaim,
    wrapDeliver,
    claims,
    closed,
    stats: () => ({ lookups, live: claims.size, closed: closed.length }),
    setLookupFailure: (message) => { failLookup = message; },
    seedClaim: (routeKey, updateId, over = {}) => {
      const key = keyFor(routeKey, updateId);
      const claim = {
        claimId: `tgc_seed_${key}`,
        cutoverId: 'tg-cutover-v1',
        routeKey,
        updateId: Number(updateId),
        state: 'claimed',
        appGeneration: generation(),
        attemptAtMs: now(),
        attemptNonce: `n_seed_${key}`,
        deliveryStartedAtMs: null,
        ...over,
      };
      claims.set(key, claim);
      return claim;
    },
  };
}

module.exports = { createClaimLatchDouble };
