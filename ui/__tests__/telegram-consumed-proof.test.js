/**
 * The v2 gate's named rejections, each as a test.
 *
 * The truncation case is the one that matters most: it is a live observation,
 * not a hypothetical. 2283 bytes were packetized, reassembled, written and
 * ACKED while the pane held 125 characters starting mid-word.
 */
const {
  SCHEMA,
  sha256,
  byteLength,
  canonicalQueuedPayloadDigest,
  buildConsumedProof,
  validateConsumedProof,
} = require('../modules/main/telegram-consumed-proof');

const NOW = 1_785_780_000_000;
const GENERATION = 'tg-gen-29180-1785780000000';

const RECORD = {
  updateId: 808499317,
  text: 'Kristine muller approved job... change job to invoice',
  chatId: 6543210,
  from: 'james',
  messageId: 22315,
};

const DELIVERED = '[Telegram from james]: Kristine muller approved job... change job to invoice';

function expectedFor(overrides = {}) {
  return {
    updateId: 808499317,
    messageId: 'telegram-in-808499317',
    routeKey: 'main',
    windowKey: 'main',
    profile: 'main',
    chatId: 6543210,
    appGeneration: GENERATION,
    paneId: '1',
    queuedPayloadSha256: canonicalQueuedPayloadDigest(RECORD),
    deliveredPromptSha256: sha256(DELIVERED),
    deliveredPromptBytes: byteLength(DELIVERED),
    ...overrides,
  };
}

function proofFor(overrides = {}, deliveredPrompt = DELIVERED) {
  return {
    ...buildConsumedProof({
      runtime: 'codex',
      updateId: 808499317,
      messageId: 'telegram-in-808499317',
      routeKey: 'main',
      windowKey: 'main',
      profile: 'main',
      chatId: 6543210,
      appGeneration: GENERATION,
      consumerSessionId: 'codex-session-abc',
      consumerTurnId: 'turn-1',
      paneId: '1',
      queuedPayloadSha256: canonicalQueuedPayloadDigest(RECORD),
      deliveredPrompt,
      consumedAtMs: NOW,
    }),
    ...overrides,
  };
}

const ATTEMPT = { atMs: NOW - 1000, generation: GENERATION };

describe('the happy path exists at all', () => {
  test('A COMPLETE, CORRELATED, POST-ATTEMPT PROOF is accepted', () => {
    expect(validateConsumedProof({ proof: proofFor(), expected: expectedFor(), attempt: ATTEMPT }))
      .toEqual({ proven: true, reason: 'consumption_proven' });
  });

  test('CLAUDE AND CODEX PRODUCE AN IDENTICAL PROOF SHAPE', () => {
    // If these ever diverge in shape, the schema is not runtime-neutral and
    // the gate fails by construction.
    const common = {
      updateId: 808499317,
      messageId: 'telegram-in-808499317',
      routeKey: 'main',
      windowKey: 'main',
      profile: 'main',
      chatId: 6543210,
      appGeneration: GENERATION,
      consumerSessionId: 's',
      paneId: '1',
      queuedPayloadSha256: canonicalQueuedPayloadDigest(RECORD),
      deliveredPrompt: DELIVERED,
      consumedAtMs: NOW,
    };
    const codex = buildConsumedProof({ ...common, runtime: 'codex' });
    const claude = buildConsumedProof({ ...common, runtime: 'claude' });

    expect(Object.keys(codex).sort()).toEqual(Object.keys(claude).sort());
    // Identical in every field except the one that names the runtime.
    const { runtime: _c, ...codexRest } = codex;
    const { runtime: _l, ...claudeRest } = claude;
    expect(codexRest).toEqual(claudeRest);
    // And both validate against the same expectation.
    expect(validateConsumedProof({ proof: codex, expected: expectedFor(), attempt: ATTEMPT }).proven).toBe(true);
    expect(validateConsumedProof({ proof: claude, expected: expectedFor(), attempt: ATTEMPT }).proven).toBe(true);
  });
});

describe('THE TRUNCATED-BUT-ACKED DELIVERY (live observation)', () => {
  test('A TRUNCATED PROMPT IS NOT PROOF, however loudly the bus acked it', () => {
    // The sender believes it wrote the whole thing. The consumer received a
    // fragment beginning mid-word. Only the consumer's own digest can tell.
    const truncated = DELIVERED.slice(0, 40);
    const proof = proofFor({}, truncated);

    const result = validateConsumedProof({ proof, expected: expectedFor(), attempt: ATTEMPT });

    expect(result.proven).toBe(false);
    expect(result.reason).toBe('delivered_payload_digest_mismatch');
  });

  test('THE REAL SHAPE: 2283 bytes sent, 125 characters consumed', () => {
    const sent = 'x'.repeat(2283);
    const consumed = sent.slice(1000, 1125); // 125 chars, starting mid-stream
    const expected = expectedFor({
      deliveredPromptSha256: sha256(sent),
      deliveredPromptBytes: byteLength(sent),
    });

    const result = validateConsumedProof({ proof: proofFor({}, consumed), expected, attempt: ATTEMPT });

    expect(result.proven).toBe(false);
    expect(byteLength(consumed)).toBe(125);
  });

  test('A ONE-BYTE LOSS is still a rejection — there is no "close enough"', () => {
    const result = validateConsumedProof({
      proof: proofFor({}, DELIVERED.slice(0, -1)),
      expected: expectedFor(),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
  });

  test('A MATCHING DIGEST WITH A CONTRADICTORY BYTE COUNT is rejected', () => {
    // Defends the length check independently, so loosening the digest
    // comparison later cannot silently take the length guarantee with it.
    const result = validateConsumedProof({
      proof: proofFor({ deliveredPromptBytes: 9999 }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('delivered_payload_length_mismatch');
  });
});

describe('fabricated and weak evidence', () => {
  test('A FABRICATED PLAIN OBJECT with every right id is rejected for having no proof class', () => {
    // This exact object satisfied my previous draft completely.
    const fabricated = {
      updateId: 808499317,
      messageId: 'telegram-in-808499317',
      routeKey: 'main',
      windowKey: 'main',
      profile: 'main',
      chatId: 6543210,
      appGeneration: GENERATION,
      paneId: '1',
      consumerSessionId: 's',
      runtime: 'codex',
      queuedPayloadSha256: canonicalQueuedPayloadDigest(RECORD),
      deliveredPromptSha256: sha256(DELIVERED),
      deliveredPromptBytes: byteLength(DELIVERED),
      consumedAtMs: NOW,
      verified: true,
      userVisible: true,
    };

    const result = validateConsumedProof({ proof: fabricated, expected: expectedFor(), attempt: ATTEMPT });

    expect(result.proven).toBe(false);
    expect(result.reason).toMatch(/^wrong_schema:/);
  });

  test('THE RIGHT SCHEMA WITH A MADE-UP CLASS is rejected', () => {
    const result = validateConsumedProof({
      proof: proofFor({ proofClass: 'looks_delivered_to_me' }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('not_a_positive_proof_class:looks_delivered_to_me');
  });

  test.each([
    ['accepted.daemon_pty_unverified', { status: 'accepted.daemon_pty_unverified', accepted: true }],
    ['accepted.unverified', { status: 'accepted.unverified', accepted: true }],
    ['delivered.websocket', { status: 'delivered.websocket', verified: true }],
    ['a telegram egress row', { direction: 'outbound', channel: 'telegram', status: 'delivered' }],
    ['our own brokered row', { direction: 'inbound', status: 'brokered' }],
  ])('%s IS NOT CONSUMPTION PROOF', (_label, evidence) => {
    const result = validateConsumedProof({ proof: evidence, expected: expectedFor(), attempt: ATTEMPT });
    expect(result.proven).toBe(false);
  });

  test('NULL, ARRAYS AND PRIMITIVES fail closed', () => {
    for (const proof of [null, undefined, [], 'proof', 42, true]) {
      expect(validateConsumedProof({ proof, expected: expectedFor(), attempt: ATTEMPT }).proven).toBe(false);
    }
  });

  test('EVERY REQUIRED FIELD is load-bearing', () => {
    const { REQUIRED_FIELDS } = require('../modules/main/telegram-consumed-proof');
    for (const field of REQUIRED_FIELDS) {
      const proof = proofFor();
      delete proof[field];
      const result = validateConsumedProof({ proof, expected: expectedFor(), attempt: ATTEMPT });
      expect(result.proven).toBe(false);
    }
  });
});

describe('payload identity — same id, different message', () => {
  test('THE SAME updateId CARRYING A DIFFERENT BODY is rejected', () => {
    const tampered = { ...RECORD, text: 'transfer the deposit to a different account' };
    const proof = proofFor({ queuedPayloadSha256: canonicalQueuedPayloadDigest(tampered) });

    const result = validateConsumedProof({ proof, expected: expectedFor(), attempt: ATTEMPT });

    expect(result.proven).toBe(false);
    expect(result.reason).toBe('queued_payload_digest_mismatch');
  });

  test('THE CANONICAL DIGEST CHANGES with any field that identifies the message', () => {
    const base = canonicalQueuedPayloadDigest(RECORD);
    expect(canonicalQueuedPayloadDigest({ ...RECORD, text: 'other' })).not.toBe(base);
    expect(canonicalQueuedPayloadDigest({ ...RECORD, chatId: 1 })).not.toBe(base);
    expect(canonicalQueuedPayloadDigest({ ...RECORD, from: 'someone-else' })).not.toBe(base);
    expect(canonicalQueuedPayloadDigest({ ...RECORD, updateId: 808499318 })).not.toBe(base);
  });

  test('A NON-HEX OR SHORT DIGEST is malformed, not merely unequal', () => {
    expect(validateConsumedProof({
      proof: proofFor({ queuedPayloadSha256: 'abc' }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    }).reason).toBe('queued_digest_malformed');
    expect(validateConsumedProof({
      proof: proofFor({ deliveredPromptSha256: 'NOTHEX'.repeat(11) }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    }).reason).toBe('delivered_digest_malformed');
  });
});

describe('generation, pane and session binding', () => {
  test('A RECEIPT FROM A PREVIOUS APP GENERATION is rejected', () => {
    const result = validateConsumedProof({
      proof: proofFor({ appGeneration: 'tg-gen-29180-1785000000000' }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('generation_mismatch');
  });

  test('A RECEIPT FROM PANE 3 CANNOT RETIRE A PANE 1 DELIVERY', () => {
    // Same-CWD Codex sessions run in panes 1 and 3. Without this the newest
    // session in the shared history would look like proof for either.
    const result = validateConsumedProof({
      proof: proofFor({ paneId: '3' }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('pane_mismatch');
  });

  test('A RECEIPT WITH NO PANE OR SESSION AT ALL is rejected, never assumed to be pane 1', () => {
    expect(validateConsumedProof({
      proof: proofFor({ paneId: null }), expected: expectedFor(), attempt: ATTEMPT,
    }).reason).toBe('proof_field_missing:paneId');
    expect(validateConsumedProof({
      proof: proofFor({ consumerSessionId: null }), expected: expectedFor(), attempt: ATTEMPT,
    }).reason).toBe('proof_field_missing:consumerSessionId');
  });
});

describe('ordering against the attempt', () => {
  test('PROOF THAT PREDATES ITS ATTEMPT is an older delivery', () => {
    const result = validateConsumedProof({
      proof: proofFor({ consumedAtMs: NOW - 5000 }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    });
    expect(result.reason).toBe('proof_predates_attempt');
  });

  test('AN UNDATED ATTEMPT (the 808499316 shape) can never be auto-retired', () => {
    const result = validateConsumedProof({
      proof: proofFor(),
      expected: expectedFor(),
      attempt: { atMs: null, generation: null },
    });
    expect(result.reason).toBe('attempt_time_unknown');
  });

  test('PROOF AT THE EXACT ATTEMPT INSTANT is accepted', () => {
    expect(validateConsumedProof({
      proof: proofFor({ consumedAtMs: NOW }),
      expected: expectedFor(),
      attempt: { atMs: NOW },
    }).proven).toBe(true);
  });
});
