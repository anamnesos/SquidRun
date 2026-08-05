/**
 * AN ATTEMPT THAT NO RECEIPT CAN EVER RESOLVE.
 *
 * =====================================================================
 * WHY THIS EXISTS
 * =====================================================================
 * Ten of James's Telegram messages sat undelivered behind update 808499316.
 * The health surface said `unprovable_pane:runtime_never_produced_proof`, which
 * is a true statement about the Codex pane and the WRONG diagnosis for that
 * record: it sends whoever reads it to repair hooks, and the channel stays
 * muted afterwards.
 *
 * 316's durable latch is `{"updateId":808499316,"state":"attempted"}` - no
 * `atMs`, no `generation`. `evaluateConsumptionProof` rejects on exactly that
 * before it looks at any evidence, so no receipt can retire the record no
 * matter how correct the runtime becomes. Two different unprovable-nesses, two
 * different repairs; these tests hold them apart.
 *
 * Everything here is synthetic and in-memory. No live queue, sidecar, ledger or
 * process is read or written.
 */
const { classifyAttemptResolvability } = require('../modules/main/telegram-ingress-drain');
const { evaluateConsumptionProof } = require('../modules/main/telegram-consumption-proof');

const GEN = 'app-session-492';

describe('classifying whether an attempt can be resolved at all', () => {
  test('no attempt, or a resolved one, is not orphaned', () => {
    expect(classifyAttemptResolvability(null, GEN).resolvable).toBe(true);
    expect(classifyAttemptResolvability({ state: 'not_delivered' }, GEN).resolvable).toBe(true);
  });

  test('THE LIVE 808499316 SHAPE is orphaned for want of provenance', () => {
    // Byte-for-byte the shape read from delivery-attempts.jsonl.
    const verdict = classifyAttemptResolvability({ updateId: 808499316, state: 'attempted' }, GEN);
    expect(verdict.resolvable).toBe(false);
    expect(verdict.reason).toBe('attempt_time_unknown');
    expect(verdict.detail.hasAttemptTime).toBe(false);
  });

  test('a MISSING GENERATION is ALSO structural - it cannot be recorded afterwards', () => {
    // Writing a generation onto an already-attempted record would invent the
    // identity of a delivery that may already have reached the user.
    const verdict = classifyAttemptResolvability({ state: 'attempted', atMs: 1 }, GEN);
    expect(verdict.resolvable).toBe(false);
    expect(verdict.reason).toBe('attempt_generation_unknown');
    // A missing timestamp outranks it: that is 316, and it is reported as such.
    expect(classifyAttemptResolvability({ state: 'attempted', generation: GEN }, GEN).reason)
      .toBe('attempt_time_unknown');
  });

  test('an attempt from a PRIOR generation is NOT an orphan - the proof gate judges it', () => {
    // Its generation mismatch is a proof question, answered in the gate, not a
    // permanent property of the record.
    const verdict = classifyAttemptResolvability(
      { state: 'attempted', atMs: 1_700_000_000_000, generation: 'app-session-491' },
      GEN
    );
    expect(verdict.resolvable).toBe(true);
  });

  test('an attempt from THIS generation with full provenance is resolvable - it is merely waiting', () => {
    const verdict = classifyAttemptResolvability(
      { state: 'attempted', atMs: 1_700_000_000_000, generation: GEN },
      GEN
    );
    expect(verdict.resolvable).toBe(true);
    expect(verdict.reason).toBe(null);
  });

  test('an unknown current generation does not manufacture an orphan', () => {
    // If this process cannot say which generation it is, the honest answer is
    // "cannot tell", and a record must not be declared permanently unresolvable
    // on the strength of a question we failed to ask.
    const attempt = { state: 'attempted', atMs: 1_700_000_000_000, generation: 'app-session-491' };
    expect(classifyAttemptResolvability(attempt, '').resolvable).toBe(true);
    expect(classifyAttemptResolvability(attempt, null).resolvable).toBe(true);
  });
});

describe('the classification matches what the proof gate actually does', () => {
  /**
   * The classifier would be worthless if it disagreed with the code that
   * decides retirement. These assert the SAME inputs against the real proof
   * evaluator, so the two cannot drift apart silently.
   */
  // EVERY field EXACT_PROOF_FIELDS requires. An earlier draft of this fixture
  // omitted chatId, so the cross-check "a resolvable attempt IS retirable"
  // failed for a reason that had nothing to do with the attempt - a fixture
  // testing the fixture.
  const expected = {
    updateId: 808499316,
    messageId: 'telegram-in-808499316',
    routeKey: 'main',
    windowKey: 'main',
    profile: 'main',
    chatId: 6543210,
    generation: GEN,
  };

  function perfectProof(atMs) {
    return {
      class: 'verified',
      updateId: expected.updateId,
      messageId: expected.messageId,
      routeKey: expected.routeKey,
      windowKey: expected.windowKey,
      profile: expected.profile,
      chatId: expected.chatId,
      generation: GEN,
      appGeneration: GEN,
      provedAtMs: atMs,
      consumedAtMs: atMs,
    };
  }

  test('a PERFECT receipt still cannot retire the 316 shape', () => {
    const outcome = evaluateConsumptionProof({
      evidence: perfectProof(1_700_000_100_000),
      expected,
      attempt: { updateId: 808499316, state: 'attempted' },
      nowMs: 1_700_000_200_000,
    });
    expect(outcome.proven).toBe(false);
    // This is the fact the whole repair turns on: the refusal is about the
    // ATTEMPT, not the evidence and not the runtime.
    expect(['attempt_time_unknown', 'attempt_generation_unknown']).toContain(outcome.reason);
  });

  test('the classifier calls orphaned exactly the cases the proof gate refuses on attempt grounds', () => {
    const shapes = [
      { state: 'attempted' },
      { state: 'attempted', generation: GEN },
      { state: 'attempted', atMs: 1_700_000_000_000 },
    ];
    for (const attempt of shapes) {
      const classified = classifyAttemptResolvability(attempt, GEN);
      const outcome = evaluateConsumptionProof({
        evidence: perfectProof(1_700_000_100_000),
        expected,
        attempt,
        nowMs: 1_700_000_200_000,
      });
      expect(classified.resolvable).toBe(false);
      expect(outcome.proven).toBe(false);
    }
  });

  test('and the resolvable shape is one the proof gate CAN retire', () => {
    const attempt = { state: 'attempted', atMs: 1_700_000_000_000, generation: GEN };
    expect(classifyAttemptResolvability(attempt, GEN).resolvable).toBe(true);
    const outcome = evaluateConsumptionProof({
      evidence: perfectProof(1_700_000_100_000),
      expected,
      attempt,
      nowMs: 1_700_000_200_000,
    });
    // If this ever fails, the classifier is promising resolvability the proof
    // gate will not honour, and the drain would hold while reporting "waiting".
    expect(outcome.proven).toBe(true);
  });
});

describe('a receipt must answer the attempt it claims to resolve, not the process asking', () => {
  const base = {
    updateId: 808499316,
    messageId: 'telegram-in-808499316',
    routeKey: 'main',
    windowKey: 'main',
    profile: 'main',
    chatId: 6543210,
  };
  const proofFor = (generation, atMs) => ({ class: 'verified', ...base, generation, appGeneration: generation, provedAtMs: atMs, consumedAtMs: atMs });
  const attemptIn = (generation) => ({ state: 'attempted', atMs: 1_700_000_000_000, generation });

  test('a LIVE receipt may NOT retire a DEAD generation attempt', () => {
    // Measured before the fix: this was proven. That let a live generation
    // retire a delivery attempted by a process that no longer exists.
    const outcome = evaluateConsumptionProof({
      evidence: proofFor(GEN, 1_700_000_100_000),
      expected: { ...base, generation: GEN },
      attempt: attemptIn('app-session-491'),
      nowMs: 1_700_000_200_000,
    });
    expect(outcome.proven).toBe(false);
    expect(outcome.reason).toBe('proof_generation_does_not_match_attempt');
  });

  test("a generation's OWN receipt still retires its OWN attempt ACROSS A RESTART", () => {
    // The case that must survive: G's durable receipt resolving G's attempt
    // while the process asking is G+1. Comparing against the current process
    // would have broken exactly this.
    const outcome = evaluateConsumptionProof({
      evidence: proofFor('app-session-491', 1_700_000_100_000),
      expected: { ...base, generation: 'app-session-491' },
      attempt: attemptIn('app-session-491'),
      nowMs: 1_700_000_200_000,
    });
    expect(outcome.proven).toBe(true);
  });

  test('a receipt with no generation cannot answer an attempt that has one', () => {
    const outcome = evaluateConsumptionProof({
      evidence: { ...proofFor(GEN, 1_700_000_100_000), generation: '' },
      expected: { ...base, generation: GEN },
      attempt: attemptIn(GEN),
      nowMs: 1_700_000_200_000,
    });
    expect(outcome.proven).toBe(false);
  });
});
