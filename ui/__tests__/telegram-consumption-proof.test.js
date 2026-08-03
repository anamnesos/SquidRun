const {
  PROOF_CAPABILITY_WINDOW_MS,
  probeRuntimeProofCapability,
  isUnattainableReason,
  evaluateConsumptionProof,
  summarizeBacklog,
} = require('../modules/main/telegram-consumption-proof');

const NOW = 1_785_780_000_000;

function identity(overrides = {}) {
  return {
    messageId: 'telegram-in-808499317',
    routeKey: 'main',
    windowKey: 'main',
    profile: 'main',
    chatId: 6543210,
    generation: 'gen-a',
    ...overrides,
  };
}

function proof(overrides = {}) {
  return {
    ...identity(),
    provedAtMs: NOW,
    ...overrides,
  };
}

describe('runtime proof capability (measured, never assumed)', () => {
  test('A RUNTIME THAT HAS ACTUALLY PRODUCED PROOF is attainable', () => {
    const result = probeRuntimeProofCapability({
      runtime: 'claude',
      receiptActivity: { claude: NOW - 60_000 },
      nowMs: NOW,
    });
    expect(result.attainable).toBe(true);
    expect(result.reason).toBe('runtime_proof_observed');
    expect(result.lastProofAtMs).toBe(NOW - 60_000);
  });

  test('THE CODEX CASE: configured but never once produced a receipt is NOT attainable', () => {
    // The live store held 2194 receipts, every one runtime=claude, while
    // .codex/hooks.json carried a UserPromptSubmit receipt hook. Config said
    // yes; reality said no. Reality wins.
    const result = probeRuntimeProofCapability({
      runtime: 'codex',
      receiptActivity: { claude: NOW - 60_000 },
      nowMs: NOW,
    });
    expect(result.attainable).toBe(false);
    expect(result.reason).toBe('runtime_never_produced_proof');
    expect(isUnattainableReason(result.reason)).toBe(true);
  });

  test('A CHANNEL THAT WORKED ONCE AND DIED goes stale rather than staying trusted', () => {
    const result = probeRuntimeProofCapability({
      runtime: 'codex',
      receiptActivity: { codex: NOW - PROOF_CAPABILITY_WINDOW_MS - 1 },
      nowMs: NOW,
    });
    expect(result.attainable).toBe(false);
    expect(result.reason).toBe('runtime_proof_stale');
    expect(isUnattainableReason(result.reason)).toBe(true);
  });

  test('AN IDLE BUT WIRED RUNTIME stays attainable inside the window', () => {
    const result = probeRuntimeProofCapability({
      runtime: 'codex',
      receiptActivity: { codex: NOW - PROOF_CAPABILITY_WINDOW_MS + 1 },
      nowMs: NOW,
    });
    expect(result.attainable).toBe(true);
  });

  test('AN UNNAMED RUNTIME fails closed', () => {
    for (const runtime of [null, undefined, '', '   ']) {
      const result = probeRuntimeProofCapability({ runtime, receiptActivity: {}, nowMs: NOW });
      expect(result.attainable).toBe(false);
      expect(result.reason).toBe('runtime_unknown');
    }
  });

  test('NO CLOCK, NO JUDGEMENT — a missing now fails closed', () => {
    const result = probeRuntimeProofCapability({
      runtime: 'claude',
      receiptActivity: { claude: NOW },
      nowMs: undefined,
    });
    expect(result.attainable).toBe(false);
  });

  test('RUNTIME NAME IS CASE-INSENSITIVE, so a capitalised pane label is not a phantom outage', () => {
    const result = probeRuntimeProofCapability({
      runtime: 'Claude',
      receiptActivity: { claude: NOW },
      nowMs: NOW,
    });
    expect(result.attainable).toBe(true);
  });

  test('A Map is accepted as readily as a plain object', () => {
    const result = probeRuntimeProofCapability({
      runtime: 'claude',
      receiptActivity: new Map([['claude', NOW]]),
      nowMs: NOW,
    });
    expect(result.attainable).toBe(true);
  });

  test('A NON-NUMERIC last-proof value is absence, not capability', () => {
    for (const value of ['yesterday', true, {}, 0, -1, NaN]) {
      const result = probeRuntimeProofCapability({
        runtime: 'codex',
        receiptActivity: { codex: value },
        nowMs: NOW,
      });
      expect(result.attainable).toBe(false);
    }
  });
});

describe('exact consumption proof', () => {
  test('FULLY CORRELATED, POST-ATTEMPT PROOF is accepted', () => {
    const result = evaluateConsumptionProof({
      evidence: proof({ provedAtMs: NOW }),
      expected: identity(),
      attempt: { atMs: NOW - 1000, generation: 'gen-a' },
      nowMs: NOW,
    });
    expect(result).toEqual({ proven: true, reason: 'exact_consumption_proof' });
  });

  test('EVERY identity field is load-bearing — dropping any one rejects the proof', () => {
    // Guards against a future edit quietly shrinking the correlation set.
    for (const field of ['messageId', 'routeKey', 'windowKey', 'profile', 'chatId', 'generation']) {
      const evidence = proof();
      delete evidence[field];
      const result = evaluateConsumptionProof({
        evidence,
        expected: identity(),
        attempt: { atMs: NOW - 1000 },
      });
      expect(result.proven).toBe(false);
      expect(result.reason).toBe(`identity_mismatch:${field}`);
    }
  });

  test('PROOF FOR A DIFFERENT MESSAGE proves nothing about this one', () => {
    const result = evaluateConsumptionProof({
      evidence: proof({ messageId: 'telegram-in-808499318' }),
      expected: identity(),
      attempt: { atMs: NOW - 1000 },
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('identity_mismatch:messageId');
  });

  test('PROOF FROM ANOTHER WINDOW OR PROFILE is rejected', () => {
    expect(evaluateConsumptionProof({
      evidence: proof({ windowKey: 'sideprofile' }),
      expected: identity(),
      attempt: { atMs: NOW - 1000 },
    }).reason).toBe('identity_mismatch:windowKey');
    expect(evaluateConsumptionProof({
      evidence: proof({ profile: 'sideprofile' }),
      expected: identity(),
      attempt: { atMs: NOW - 1000 },
    }).reason).toBe('identity_mismatch:profile');
  });

  test('A RE-POINTED CHAT is caught by chatId correlation', () => {
    const result = evaluateConsumptionProof({
      evidence: proof({ chatId: 999 }),
      expected: identity(),
      attempt: { atMs: NOW - 1000 },
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('identity_mismatch:chatId');
  });

  test('A RECEIPT FROM AN OLDER PROCESS GENERATION is not proof of this delivery', () => {
    const result = evaluateConsumptionProof({
      evidence: proof({ generation: 'gen-previous' }),
      expected: identity({ generation: 'gen-a' }),
      attempt: { atMs: NOW - 1000, generation: 'gen-a' },
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('identity_mismatch:generation');
  });

  test('PROOF THAT PREDATES ITS ATTEMPT is an older delivery, not this one', () => {
    const result = evaluateConsumptionProof({
      evidence: proof({ provedAtMs: NOW - 5000 }),
      expected: identity(),
      attempt: { atMs: NOW - 1000 },
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('proof_predates_attempt');
  });

  test('PROOF EXACTLY AT THE ATTEMPT INSTANT is accepted — same millisecond is not "before"', () => {
    const result = evaluateConsumptionProof({
      evidence: proof({ provedAtMs: NOW }),
      expected: identity(),
      attempt: { atMs: NOW },
    });
    expect(result.proven).toBe(true);
  });

  test('THE 808499316 CASE: a v0 attempt with no timestamp can never be auto-retired', () => {
    // Proof genuinely exists for this update — James was answered. But nothing
    // can order it against an attempt that never recorded when it happened, so
    // the automatic path must refuse and leave it to explicit recovery.
    const result = evaluateConsumptionProof({
      evidence: proof({ messageId: 'telegram-in-808499316' }),
      expected: identity({ messageId: 'telegram-in-808499316' }),
      attempt: { atMs: null, generation: null },
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('attempt_time_unknown');
  });

  test('UNDATED PROOF is rejected even with a perfectly dated attempt', () => {
    const result = evaluateConsumptionProof({
      evidence: proof({ provedAtMs: undefined }),
      expected: identity(),
      attempt: { atMs: NOW - 1000 },
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('proof_time_unknown');
  });

  test('NO EVIDENCE and NO EXPECTED IDENTITY both fail closed', () => {
    expect(evaluateConsumptionProof({ evidence: null, expected: identity() }).reason).toBe('no_evidence');
    expect(evaluateConsumptionProof({ evidence: proof(), expected: null }).reason).toBe('no_expected_identity');
  });

  test('AN EMPTY EXPECTED FIELD is a missing question, not a wildcard', () => {
    const result = evaluateConsumptionProof({
      evidence: proof(),
      expected: identity({ profile: '   ' }),
      attempt: { atMs: NOW - 1000 },
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('expected_identity_missing:profile');
  });

  test('NUMERIC AND STRING chatId agree — transport typing must not fake a mismatch', () => {
    const result = evaluateConsumptionProof({
      evidence: proof({ chatId: '6543210' }),
      expected: identity({ chatId: 6543210 }),
      attempt: { atMs: NOW - 1000 },
    });
    expect(result.proven).toBe(true);
  });

  test('AN OBJECT identity value never matches, however it stringifies', () => {
    const result = evaluateConsumptionProof({
      evidence: proof({ chatId: {} }),
      expected: identity({ chatId: {} }),
      attempt: { atMs: NOW - 1000 },
    });
    expect(result.proven).toBe(false);
  });

  test('WITH NO ATTEMPT ON RECORD, correlation alone decides (the crash-replay path)', () => {
    const result = evaluateConsumptionProof({
      evidence: proof(),
      expected: identity(),
      attempt: null,
    });
    expect(result.proven).toBe(true);
  });
});

describe('backlog summary (the false-green killer)', () => {
  const pending = [
    { updateId: 808499318, receivedAtMs: NOW - 60_000 },
    { updateId: 808499317, receivedAtMs: NOW - 3_600_000 },
    { updateId: 808499319, receivedAtMs: NOW - 30_000 },
  ];

  test('IT REPORTS THE HEAD, not merely the oldest timestamp', () => {
    const summary = summarizeBacklog({ pending, nowMs: NOW });
    expect(summary.pendingCount).toBe(3);
    expect(summary.oldestPendingUpdateId).toBe(808499317);
    expect(summary.oldestPendingAgeMs).toBe(3_600_000);
  });

  test('AN EMPTY QUEUE reports no head and no age', () => {
    const summary = summarizeBacklog({ pending: [], nowMs: NOW });
    expect(summary.pendingCount).toBe(0);
    expect(summary.oldestPendingUpdateId).toBeNull();
    expect(summary.oldestPendingAgeMs).toBeNull();
  });

  test('AN UNDATED HEAD reports UNKNOWN age, never a fabricated zero', () => {
    const summary = summarizeBacklog({
      pending: [{ updateId: 808499317 }],
      nowMs: NOW,
    });
    expect(summary.oldestPendingAgeMs).toBeNull();
    expect(summary.oldestPendingAgeUnknown).toBe(true);
  });

  test('THE BLOCKED REASON AND ITS ATTAINABILITY reach the surface', () => {
    const summary = summarizeBacklog({
      pending,
      nowMs: NOW,
      blocked: {
        updateId: 808499317,
        reason: 'unresolved_delivery_attempt',
        failureClass: 'awaiting_proof',
        unattainable: true,
      },
      lastRetirementAtMs: NOW - 9_000_000,
    });
    expect(summary.blockedUpdateId).toBe(808499317);
    expect(summary.blockedReason).toBe('unresolved_delivery_attempt');
    expect(summary.proofUnattainable).toBe(true);
    expect(summary.lastRetirementAtMs).toBe(NOW - 9_000_000);
  });

  test('OUTSTANDING ATTEMPTS are counted, retryable ones are not', () => {
    const summary = summarizeBacklog({
      pending,
      nowMs: NOW,
      attempts: new Map([
        [808499317, { state: 'attempted', atMs: NOW - 1000 }],
        [808499318, { state: 'retryable', atMs: NOW - 1000 }],
      ]),
    });
    expect(summary.attemptedCount).toBe(1);
  });

  test('A RECORD WITH A CORRUPT updateId is not allowed to become the head', () => {
    const summary = summarizeBacklog({
      pending: [{ updateId: 'nonsense' }, { updateId: 808499317, receivedAtMs: NOW - 1000 }],
      nowMs: NOW,
    });
    expect(summary.oldestPendingUpdateId).toBe(808499317);
  });
});
