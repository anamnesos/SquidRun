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
  buildAdmissionRecord,
  validateAdmissionRecord,
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
    runtime: 'codex',
    consumerSessionId: 'codex-session-abc',
    queuedPayloadSha256: canonicalQueuedPayloadDigest(RECORD),
    deliveredPromptSha256: sha256(DELIVERED),
    deliveredPromptBytes: byteLength(DELIVERED),
    // A3b-2: the record ASSERTS the attempt, launch, role, hook process and
    // typed submission, and the validator now COMPARES them rather than only
    // requiring them present.
    claimId: 'claim-1',
    attemptNonce: 'nonce-1',
    paneLaunchId: 'pl_00000000000000000000000000000001',
    role: 'architect',
    hookProcessId: '9001',
    hookParentProcessId: '9000',
    runtimeSubmissionId: 'turn-1',
    runtimeSubmissionKind: 'codex_turn',
    ...overrides,
  };
}

/** The tuple every valid fixture record carries. */
const RECORD_TUPLE = Object.freeze({
  claimId: 'claim-1',
  attemptNonce: 'nonce-1',
  paneLaunchId: 'pl_00000000000000000000000000000001',
  role: 'architect',
  hookProcessId: '9001',
  hookParentProcessId: '9000',
  runtimeSubmissionId: 'turn-1',
  runtimeSubmissionKind: 'codex_turn',
});

function proofFor(overrides = {}, deliveredPrompt = DELIVERED) {
  return {
    ...buildAdmissionRecord({
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
      ...RECORD_TUPLE,
    }),
    ...overrides,
  };
}

const ATTEMPT = { atMs: NOW - 1000, generation: GENERATION };

describe('the happy path exists at all', () => {
  test('A COMPLETE, CORRELATED, POST-ATTEMPT PROOF is accepted', () => {
    expect(validateAdmissionRecord({ proof: proofFor(), expected: expectedFor(), attempt: ATTEMPT }))
      .toEqual({ proven: true, reason: 'admission_proven' });
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
      ...RECORD_TUPLE,
    };
    const codex = buildAdmissionRecord({ ...common, runtime: 'codex' });
    const claude = buildAdmissionRecord({ ...common, runtime: 'claude' });

    expect(Object.keys(codex).sort()).toEqual(Object.keys(claude).sort());
    // Identical in every field except the one that names the runtime.
    const { runtime: _c, ...codexRest } = codex;
    const { runtime: _l, ...claudeRest } = claude;
    expect(codexRest).toEqual(claudeRest);
    // And each validates against an expectation naming its own runtime — the
    // runtime is compared now, so it is the one field that must agree per side.
    expect(validateAdmissionRecord({
      proof: codex,
      expected: expectedFor({ runtime: 'codex', consumerSessionId: 's' }),
      attempt: ATTEMPT,
    }).proven).toBe(true);
    expect(validateAdmissionRecord({
      proof: claude,
      expected: expectedFor({ runtime: 'claude', consumerSessionId: 's' }),
      attempt: ATTEMPT,
    }).proven).toBe(true);
  });
});

describe('THE TRUNCATED-BUT-ACKED DELIVERY (live observation)', () => {
  test('A TRUNCATED PROMPT IS NOT PROOF, however loudly the bus acked it', () => {
    // The sender believes it wrote the whole thing. The consumer received a
    // fragment beginning mid-word. Only the consumer's own digest can tell.
    const truncated = DELIVERED.slice(0, 40);
    const proof = proofFor({}, truncated);

    const result = validateAdmissionRecord({ proof, expected: expectedFor(), attempt: ATTEMPT });

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

    const result = validateAdmissionRecord({ proof: proofFor({}, consumed), expected, attempt: ATTEMPT });

    expect(result.proven).toBe(false);
    expect(byteLength(consumed)).toBe(125);
  });

  test('A ONE-BYTE LOSS is still a rejection — there is no "close enough"', () => {
    const result = validateAdmissionRecord({
      proof: proofFor({}, DELIVERED.slice(0, -1)),
      expected: expectedFor(),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
  });

  test('A MATCHING DIGEST WITH A CONTRADICTORY BYTE COUNT is rejected', () => {
    // Defends the length check independently, so loosening the digest
    // comparison later cannot silently take the length guarantee with it.
    const result = validateAdmissionRecord({
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

    const result = validateAdmissionRecord({ proof: fabricated, expected: expectedFor(), attempt: ATTEMPT });

    expect(result.proven).toBe(false);
    expect(result.reason).toMatch(/^wrong_schema:/);
  });

  test('THE RIGHT SCHEMA WITH A MADE-UP CLASS is rejected', () => {
    const result = validateAdmissionRecord({
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
    const result = validateAdmissionRecord({ proof: evidence, expected: expectedFor(), attempt: ATTEMPT });
    expect(result.proven).toBe(false);
  });

  test('NULL, ARRAYS AND PRIMITIVES fail closed', () => {
    for (const proof of [null, undefined, [], 'proof', 42, true]) {
      expect(validateAdmissionRecord({ proof, expected: expectedFor(), attempt: ATTEMPT }).proven).toBe(false);
    }
  });

  test('EVERY REQUIRED FIELD is load-bearing', () => {
    const { REQUIRED_FIELDS } = require('../modules/main/telegram-consumed-proof');
    for (const field of REQUIRED_FIELDS) {
      const proof = proofFor();
      delete proof[field];
      const result = validateAdmissionRecord({ proof, expected: expectedFor(), attempt: ATTEMPT });
      expect(result.proven).toBe(false);
    }
  });
});

describe('payload identity — same id, different message', () => {
  test('THE SAME updateId CARRYING A DIFFERENT BODY is rejected', () => {
    const tampered = { ...RECORD, text: 'transfer the deposit to a different account' };
    const proof = proofFor({ queuedPayloadSha256: canonicalQueuedPayloadDigest(tampered) });

    const result = validateAdmissionRecord({ proof, expected: expectedFor(), attempt: ATTEMPT });

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
    expect(validateAdmissionRecord({
      proof: proofFor({ queuedPayloadSha256: 'abc' }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    }).reason).toBe('queued_digest_malformed');
    expect(validateAdmissionRecord({
      proof: proofFor({ deliveredPromptSha256: 'NOTHEX'.repeat(11) }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    }).reason).toBe('delivered_digest_malformed');
  });
});

describe('generation, pane and session binding', () => {
  test('A RECEIPT FROM A PREVIOUS APP GENERATION is rejected', () => {
    const result = validateAdmissionRecord({
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
    const result = validateAdmissionRecord({
      proof: proofFor({ paneId: '3' }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('pane_mismatch');
  });

  test('A RECEIPT WITH NO PANE OR SESSION AT ALL is rejected, never assumed to be pane 1', () => {
    expect(validateAdmissionRecord({
      proof: proofFor({ paneId: null }), expected: expectedFor(), attempt: ATTEMPT,
    }).reason).toBe('proof_field_missing:paneId');
    expect(validateAdmissionRecord({
      proof: proofFor({ consumerSessionId: null }), expected: expectedFor(), attempt: ATTEMPT,
    }).reason).toBe('proof_field_missing:consumerSessionId');
  });
});

describe('ordering against the attempt', () => {
  test('PROOF THAT PREDATES ITS ATTEMPT is an older delivery', () => {
    const result = validateAdmissionRecord({
      proof: proofFor({ consumedAtMs: NOW - 5000 }),
      expected: expectedFor(),
      attempt: ATTEMPT,
    });
    expect(result.reason).toBe('proof_predates_attempt');
  });

  test('AN UNDATED ATTEMPT (the 808499316 shape) can never be auto-retired', () => {
    const result = validateAdmissionRecord({
      proof: proofFor(),
      expected: expectedFor(),
      attempt: { atMs: null, generation: null },
    });
    expect(result.reason).toBe('attempt_time_unknown');
  });

  test('PROOF AT THE EXACT ATTEMPT INSTANT is accepted', () => {
    expect(validateAdmissionRecord({
      proof: proofFor({ consumedAtMs: NOW }),
      expected: expectedFor(),
      attempt: { atMs: NOW, generation: GENERATION },
    }).proven).toBe(true);
  });

  test('AN ATTEMPT FROM A DIFFERENT GENERATION is rejected', () => {
    // Matching the CURRENT generation is not enough - the attempt being
    // resolved was made by some generation too, and if it is not this one the
    // record answers a delivery nobody is waiting on.
    const result = validateAdmissionRecord({
      proof: proofFor(),
      expected: expectedFor(),
      attempt: { atMs: NOW - 1000, generation: 'tg-gen-99999-1780000000000' },
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('attempt_generation_mismatch');
  });

  test('AN ATTEMPT WITH NO RECORDED GENERATION fails closed', () => {
    const result = validateAdmissionRecord({
      proof: proofFor(),
      expected: expectedFor(),
      attempt: { atMs: NOW - 1000 },
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('attempt_generation_unknown');
  });
});

describe('required means CORRECT, not merely present', () => {
  // Architect #54 finding 1: both fields were required and neither compared.
  test('A PROOF FROM THE WRONG RUNTIME is rejected', () => {
    const result = validateAdmissionRecord({
      proof: proofFor({ runtime: 'claude' }),
      expected: expectedFor({ runtime: 'codex' }),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('runtime_mismatch');
  });

  test('A PROOF FROM A STALE CONSUMER SESSION is rejected', () => {
    const result = validateAdmissionRecord({
      proof: proofFor({ consumerSessionId: 'codex-session-OLD' }),
      expected: expectedFor({ consumerSessionId: 'codex-session-abc' }),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('consumer_session_mismatch');
  });

  test('EVERY COMPARED FIELD is compared — an expectation that omits one cannot pass by default', () => {
    for (const field of ['runtime', 'consumerSessionId', 'appGeneration', 'paneId']) {
      const expected = expectedFor();
      delete expected[field];
      expect(validateAdmissionRecord({ proof: proofFor(), expected, attempt: ATTEMPT }).proven).toBe(false);
    }
  });
});

describe('canonical digest covers ALL consumer-visible payload identity', () => {
  // Gate probe 3. The five-field text-only digest meant a record whose TEXT was
  // unchanged but whose attachment had been swapped hashed identically. For a
  // plumbing business "here is the one I meant" is defined by its photo.
  const BASE = {
    updateId: 808499317,
    text: 'here is the one I meant',
    chatId: 6543210,
    from: 'james',
    messageId: 22315,
    updateKind: 'message',
    routeKey: 'main',
    targetProfile: 'main',
    targetWindow: 'main',
    media: { kind: 'photo', fileId: 'AgACgg', fileUniqueId: 'u1', mimeType: 'image/jpeg', caption: 'the tankless one' },
  };

  test.each([
    ['a swapped photo fileId', { media: { ...BASE.media, fileId: 'DIFFERENT' } }],
    ['a swapped fileUniqueId', { media: { ...BASE.media, fileUniqueId: 'u2' } }],
    ['a changed caption', { media: { ...BASE.media, caption: 'the OTHER one' } }],
    ['a different mime type', { media: { ...BASE.media, mimeType: 'image/png' } }],
    ['a different file name', { media: { ...BASE.media, fileName: 'other.jpg' } }],
    ['a different file size', { media: { ...BASE.media, fileSize: 999 } }],
    ['media removed entirely', { media: null }],
    ['a document added', { document: { kind: 'document', fileId: 'DOC1' } }],
    ['a video added', { video: { kind: 'video', fileId: 'VID1' } }],
    ['a different update kind', { updateKind: 'edited_message' }],
    ['a different route', { routeKey: 'sideprofile' }],
    ['a different target window', { targetWindow: 'sideprofile' }],
    ['a different target profile', { targetProfile: 'sideprofile' }],
  ])('%s changes the canonical digest', (_label, patch) => {
    expect(canonicalQueuedPayloadDigest({ ...BASE, ...patch }))
      .not.toBe(canonicalQueuedPayloadDigest(BASE));
  });

  test('A MUTABLE LOCAL PATH does NOT change the digest — the same message on two machines is one message', () => {
    expect(canonicalQueuedPayloadDigest({ ...BASE, media: { ...BASE.media, localPath: 'D:/a.jpg' } }))
      .toBe(canonicalQueuedPayloadDigest({ ...BASE, media: { ...BASE.media, localPath: 'C:/b.jpg' } }));
  });

  test('SAME TEXT, SWAPPED ATTACHMENT is rejected by the validator, not just by the hasher', () => {
    const swapped = { ...BASE, media: { ...BASE.media, fileId: 'SWAPPED' } };
    const result = validateAdmissionRecord({
      proof: proofFor({ queuedPayloadSha256: canonicalQueuedPayloadDigest(swapped) }),
      expected: expectedFor({ queuedPayloadSha256: canonicalQueuedPayloadDigest(BASE) }),
      attempt: ATTEMPT,
    });
    expect(result.proven).toBe(false);
    expect(result.reason).toBe('queued_payload_digest_mismatch');
  });
});
