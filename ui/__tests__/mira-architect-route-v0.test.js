'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const route = require('../modules/mira-core/mira-architect-route-v0');

const {
  buildMiraIntentEnvelope,
  validateMiraEnvelopeShape,
  evaluateMiraVisibleReply,
  appendJsonlRow,
  readJsonlRows,
  getIntentResolutionState,
  findMiraReplyEvent,
  isIntentAlreadyResolved,
  newMiraIntentId,
} = route;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixedIntentIds() {
  let n = 0;
  return () => `mira-intent-fixed-${++n}`;
}

describe('mira-architect-route-v0 / envelope build + shape validation', () => {
  test('builds an envelope with mira_intent_id, sender=mira, target=architect, presence metadata', () => {
    const result = buildMiraIntentEnvelope({
      intentText: 'wake up; want to know what is happening with the lease patch',
      sessionId: 'app-session-342',
      profile: 'main',
      windowKey: 'main',
      deviceId: 'VIGIL',
      nowMs: 1000,
      intentIdFactory: fixedIntentIds(),
    });
    expect(result.ok).toBe(true);
    expect(result.envelope).toEqual(expect.objectContaining({
      mira_intent_id: 'mira-intent-fixed-1',
      created_at_ms: 1000,
      sender: { role: 'mira' },
      target: { role: 'architect' },
      content: 'wake up; want to know what is happening with the lease patch',
      metadata: expect.objectContaining({
        profile: 'main',
        windowKey: 'main',
        sessionId: 'app-session-342',
        deviceId: 'VIGIL',
        provenance: 'mira-architect-route-v0',
      }),
    }));
  });

  test('rejects empty or whitespace-only intent text', () => {
    expect(buildMiraIntentEnvelope({ intentText: '' }).reason).toBe('intent_text_required');
    expect(buildMiraIntentEnvelope({ intentText: '   \n\t' }).reason).toBe('intent_text_required');
    expect(buildMiraIntentEnvelope({ intentText: null }).reason).toBe('intent_text_required');
  });

  test('shape validation accepts a freshly-built envelope', () => {
    const built = buildMiraIntentEnvelope({
      intentText: 'check broker',
      intentIdFactory: fixedIntentIds(),
    });
    expect(validateMiraEnvelopeShape(built.envelope).ok).toBe(true);
  });

  test('shape validation rejects sender role mismatch (anti-spoof shape check, NOT cryptographic)', () => {
    const built = buildMiraIntentEnvelope({ intentText: 'x', intentIdFactory: fixedIntentIds() });
    const tampered = { ...built.envelope, sender: { role: 'builder' } };
    expect(validateMiraEnvelopeShape(tampered).reason).toBe('sender_role_must_be_mira');
  });

  test('shape validation rejects missing or wrong-shape mira_intent_id', () => {
    const built = buildMiraIntentEnvelope({ intentText: 'x', intentIdFactory: fixedIntentIds() });
    expect(validateMiraEnvelopeShape({ ...built.envelope, mira_intent_id: undefined }).reason).toBe('mira_intent_id_required');
    expect(validateMiraEnvelopeShape({ ...built.envelope, mira_intent_id: 'not-prefixed-correctly' }).reason).toBe('mira_intent_id_required');
  });

  test('shape validation rejects missing content or presence metadata', () => {
    const built = buildMiraIntentEnvelope({ intentText: 'x', intentIdFactory: fixedIntentIds() });
    expect(validateMiraEnvelopeShape({ ...built.envelope, content: '' }).reason).toBe('content_required');
    const stripped = JSON.parse(JSON.stringify(built.envelope));
    delete stripped.metadata.profile;
    expect(validateMiraEnvelopeShape(stripped).reason).toBe('metadata_profile_required');
  });

  test('shape validation rejects unknown provenance label', () => {
    const built = buildMiraIntentEnvelope({ intentText: 'x', intentIdFactory: fixedIntentIds() });
    const tampered = { ...built.envelope, metadata: { ...built.envelope.metadata, provenance: 'random-thing' } };
    expect(validateMiraEnvelopeShape(tampered).reason).toBe('metadata_provenance_unknown');
  });
});

describe('mira-architect-route-v0 / visible-reply language lint', () => {
  test('passes terse, direct replies', () => {
    const passing = [
      'Lease landed. Phone fail-closed until phone-client lifecycle ships.',
      'Broker still needs Electron restart for production effect.',
      "I don't know yet. Will check the journal and come back.",
      'No.',
      'Tighten the heartbeat to 5s and cut the noise.',
    ];
    for (const text of passing) {
      const r = evaluateMiraVisibleReply(text);
      expect(r.ok).toBe(true);
      expect(r.violations).toEqual([]);
    }
  });

  test('rejects "I understand" and other preamble openers', () => {
    expect(evaluateMiraVisibleReply('I understand. The lease is fine.').violations).toContain('preamble');
    expect(evaluateMiraVisibleReply('Sure, let me look.').violations).toContain('preamble');
    expect(evaluateMiraVisibleReply('Of course — checking now.').violations).toContain('preamble');
    expect(evaluateMiraVisibleReply('Got it, I will dig in.').violations).toContain('preamble');
    expect(evaluateMiraVisibleReply('Happy to help with that.').violations).toContain('preamble');
    expect(evaluateMiraVisibleReply('Here is the answer: lease is fine.').violations).toContain('preamble');
    expect(evaluateMiraVisibleReply("Here's the summary: lease is fine.").violations).toContain('preamble');
    expect(evaluateMiraVisibleReply('Here are the steps: 1. restart.').violations).toContain('preamble');
  });

  test('rejects "Hope that helps" and other postamble offers', () => {
    expect(evaluateMiraVisibleReply('Lease is fine. Hope that helps!').violations).toContain('postamble');
    expect(evaluateMiraVisibleReply('Done. Let me know if you need more.').violations).toContain('postamble');
    expect(evaluateMiraVisibleReply('Patch landed. Anything else?').violations).toContain('postamble');
  });

  test('rejects tone-explanation phrases', () => {
    expect(evaluateMiraVisibleReply('Speaking plainly, the lease is fine.').violations).toContain('tone_explanation');
    expect(evaluateMiraVisibleReply("I'll be direct: the lease is fine.").violations).toContain('tone_explanation');
    expect(evaluateMiraVisibleReply('To be honest, that is the answer.').violations).toContain('tone_explanation');
  });

  test('rejects assistant-shaped phrasing James cited', () => {
    expect(evaluateMiraVisibleReply("I'm trying not to sound like an assistant here.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("I'm not your typical AI.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("I hear you. The lease is fine.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("I get it, you want it tighter.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("Good point. Will adjust.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("That's a great point. Will adjust.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("To clarify, the lease is fine.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("Just to be clear, no restart.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("I just want to make sure we are aligned.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("I want to push back on the K=3 approach.").violations).toContain('assistant_shape');
  });

  test('rejects empty replies', () => {
    expect(evaluateMiraVisibleReply('').violations).toEqual(['empty_reply']);
    expect(evaluateMiraVisibleReply('   \n\t').violations).toEqual(['empty_reply']);
  });

  test('rejects product-helper templates James cited (#106)', () => {
    expect(evaluateMiraVisibleReply("That's valid. Will check.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("That's fair, the lease is fine.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("To be clear, the lease is fine.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("If you want, I can rerun the tests.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("If you'd like, I can dig deeper.").violations).toContain('assistant_shape');
    expect(evaluateMiraVisibleReply("Would you like me to retry?").violations).toContain('assistant_shape');
  });

  test('rejects replies over the max-length cap (force shorter grounded replies)', () => {
    const long = 'word '.repeat(200);
    const r = evaluateMiraVisibleReply(long);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('reply_too_long');
  });

  test('passes terse replies under the max-length cap', () => {
    const short = 'Lease landed. Phone fail-closed until phone-client lifecycle ships.';
    const r = evaluateMiraVisibleReply(short);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });
});

describe('mira-architect-route-v0 / pending-intent JSONL durability', () => {
  test('appendJsonlRow + readJsonlRows roundtrip', () => {
    const dir = tempDir('mira-pending-');
    const file = path.join(dir, 'pending.jsonl');
    appendJsonlRow({ filePath: file, row: { mira_intent_id: 'a', kind: 'emitted', t: 1 } });
    appendJsonlRow({ filePath: file, row: { mira_intent_id: 'a', kind: 'resolved', t: 2 } });
    const rows = readJsonlRows({ filePath: file });
    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe('emitted');
    expect(rows[1].kind).toBe('resolved');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('readJsonlRows returns [] when file missing', () => {
    const dir = tempDir('mira-pending-');
    const file = path.join(dir, 'does-not-exist.jsonl');
    expect(readJsonlRows({ filePath: file })).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('readJsonlRows skips malformed lines', () => {
    const dir = tempDir('mira-pending-');
    const file = path.join(dir, 'malformed.jsonl');
    fs.writeFileSync(file, '{"ok":true}\nnot-json\n{"x":1}\n', 'utf8');
    const rows = readJsonlRows({ filePath: file });
    expect(rows).toEqual([{ ok: true }, { x: 1 }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('getIntentResolutionState detects pending vs resolved vs failed vs timeout', () => {
    const rowsEmittedOnly = [{ mira_intent_id: 'a', kind: 'emitted' }];
    expect(getIntentResolutionState(rowsEmittedOnly, 'a').state).toBe('pending');
    const rowsResolved = [...rowsEmittedOnly, { mira_intent_id: 'a', kind: 'resolved' }];
    expect(getIntentResolutionState(rowsResolved, 'a').state).toBe('resolved');
    const rowsFailed = [...rowsEmittedOnly, { mira_intent_id: 'a', kind: 'failed' }];
    expect(getIntentResolutionState(rowsFailed, 'a').state).toBe('failed');
    const rowsTimeout = [...rowsEmittedOnly, { mira_intent_id: 'a', kind: 'timeout' }];
    expect(getIntentResolutionState(rowsTimeout, 'a').state).toBe('timeout');
    expect(getIntentResolutionState(rowsEmittedOnly, 'b').state).toBe('unknown');
  });

  test('isIntentAlreadyResolved returns true for resolved/failed/timeout, false otherwise', () => {
    expect(isIntentAlreadyResolved([{ mira_intent_id: 'a', kind: 'resolved' }], 'a')).toBe(true);
    expect(isIntentAlreadyResolved([{ mira_intent_id: 'a', kind: 'failed' }], 'a')).toBe(true);
    expect(isIntentAlreadyResolved([{ mira_intent_id: 'a', kind: 'timeout' }], 'a')).toBe(true);
    expect(isIntentAlreadyResolved([{ mira_intent_id: 'a', kind: 'emitted' }], 'a')).toBe(false);
    expect(isIntentAlreadyResolved([], 'a')).toBe(false);
  });

  test('JSONL append is single-call atomic (no torn writes)', () => {
    const dir = tempDir('mira-pending-');
    const file = path.join(dir, 'atomic.jsonl');
    for (let i = 0; i < 50; i++) {
      appendJsonlRow({ filePath: file, row: { mira_intent_id: `m${i}`, kind: 'emitted', i } });
    }
    const rows = readJsonlRows({ filePath: file });
    expect(rows).toHaveLength(50);
    expect(rows.every((r) => typeof r.mira_intent_id === 'string')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('mira-architect-route-v0 / event queue reply correlation', () => {
  test('findMiraReplyEvent matches by mira_intent_id, kind=architect_reply, target=mira AND sender=architect', () => {
    const rows = [
      { mira_intent_id: 'other', kind: 'architect_reply', target_role: 'mira', sender_role: 'architect', reply_text: 'no' },
      { mira_intent_id: 'a', kind: 'emitted' },
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'mira', sender_role: 'architect', reply_text: 'yes' },
    ];
    const found = findMiraReplyEvent({ rows, miraIntentId: 'a' });
    expect(found).toEqual(expect.objectContaining({
      mira_intent_id: 'a',
      kind: 'architect_reply',
      target_role: 'mira',
      sender_role: 'architect',
      reply_text: 'yes',
    }));
  });

  test('findMiraReplyEvent accepts the nested target.role: "mira" shape too', () => {
    const rows = [
      { mira_intent_id: 'a', kind: 'architect_reply', target: { role: 'mira' }, sender_role: 'architect', reply_text: 'nested-ok' },
    ];
    const found = findMiraReplyEvent({ rows, miraIntentId: 'a' });
    expect(found?.reply_text).toBe('nested-ok');
  });

  test('findMiraReplyEvent IGNORES rows missing the Mira target', () => {
    const rows = [
      { mira_intent_id: 'a', kind: 'architect_reply', sender_role: 'architect', reply_text: 'no-target' },
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: '', sender_role: 'architect', reply_text: 'empty-target' },
    ];
    expect(findMiraReplyEvent({ rows, miraIntentId: 'a' })).toBe(null);
  });

  test('findMiraReplyEvent IGNORES rows with the wrong target', () => {
    const rows = [
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'user', sender_role: 'architect', reply_text: 'wrong-flat' },
      { mira_intent_id: 'a', kind: 'architect_reply', target: { role: 'architect' }, sender_role: 'architect', reply_text: 'wrong-nested' },
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'builder', sender_role: 'architect', reply_text: 'wrong-builder' },
    ];
    expect(findMiraReplyEvent({ rows, miraIntentId: 'a' })).toBe(null);
  });

  test('findMiraReplyEvent IGNORES rows with the wrong sender (must be architect)', () => {
    const rows = [
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'mira', sender_role: 'user', reply_text: 'spoof-user' },
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'mira', sender_role: 'oracle', reply_text: 'spoof-oracle' },
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'mira', sender_role: 'builder', reply_text: 'spoof-builder' },
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'mira', sender_role: 'mira', reply_text: 'spoof-self' },
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'mira', sender: { role: 'oracle' }, reply_text: 'spoof-nested' },
    ];
    expect(findMiraReplyEvent({ rows, miraIntentId: 'a' })).toBe(null);
  });

  test('findMiraReplyEvent IGNORES rows with no sender field at all', () => {
    const rows = [
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'mira', reply_text: 'no-sender' },
    ];
    expect(findMiraReplyEvent({ rows, miraIntentId: 'a' })).toBe(null);
  });

  test('findMiraReplyEvent accepts the nested sender.role: "architect" shape', () => {
    const rows = [
      { mira_intent_id: 'a', kind: 'architect_reply', target_role: 'mira', sender: { role: 'architect' }, reply_text: 'nested-sender-ok' },
    ];
    expect(findMiraReplyEvent({ rows, miraIntentId: 'a' })?.reply_text).toBe('nested-sender-ok');
  });

  test('findMiraReplyEvent ignores rows of other kinds for the same intent', () => {
    const rows = [
      { mira_intent_id: 'a', kind: 'emitted', target_role: 'mira' },
      { mira_intent_id: 'a', kind: 'note', target_role: 'mira', text: 'something else' },
    ];
    expect(findMiraReplyEvent({ rows, miraIntentId: 'a' })).toBe(null);
  });

  test('findMiraReplyEvent returns null on empty/non-array', () => {
    expect(findMiraReplyEvent({ rows: [], miraIntentId: 'a' })).toBe(null);
    expect(findMiraReplyEvent({ rows: null, miraIntentId: 'a' })).toBe(null);
  });
});

describe('mira-architect-route-v0 / buildArchitectReplyRow', () => {
  const { buildArchitectReplyRow } = route;

  test('builds a row with target_role:"mira", kind:"architect_reply", and matching mira_intent_id', () => {
    const built = buildArchitectReplyRow({
      miraIntentId: 'mira-intent-fixed-1',
      replyText: 'Lease landed. Phone fail-closed.',
      nowMs: 5000,
    });
    expect(built.ok).toBe(true);
    expect(built.row).toEqual({
      mira_intent_id: 'mira-intent-fixed-1',
      kind: 'architect_reply',
      target_role: 'mira',
      sender_role: 'architect',
      reply_text: 'Lease landed. Phone fail-closed.',
      occurred_at_ms: 5000,
    });
  });

  test('sender_role is always "architect" (hardcoded — helper is Architect-only by contract)', () => {
    const built = buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: 'ok', nowMs: 1 });
    expect(built.row.sender_role).toBe('architect');
  });

  test('senderRole override to non-architect is REJECTED', () => {
    expect(buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: 'ok', senderRole: 'oracle' }).reason).toBe('sender_role_must_be_architect');
    expect(buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: 'ok', senderRole: 'builder' }).reason).toBe('sender_role_must_be_architect');
    expect(buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: 'ok', senderRole: 'user' }).reason).toBe('sender_role_must_be_architect');
    expect(buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: 'ok', senderRole: 'mira' }).reason).toBe('sender_role_must_be_architect');
  });

  test('senderRole=architect explicit is accepted (idempotent with default)', () => {
    const built = buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: 'ok', senderRole: 'architect', nowMs: 1 });
    expect(built.ok).toBe(true);
    expect(built.row.sender_role).toBe('architect');
  });

  test('rejects empty / whitespace-only reply text', () => {
    expect(buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: '' }).reason).toBe('reply_text_required');
    expect(buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: '   ' }).reason).toBe('reply_text_required');
    expect(buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: null }).reason).toBe('reply_text_required');
    expect(buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: undefined }).reason).toBe('reply_text_required');
  });

  test('rejects malformed mira_intent_id', () => {
    expect(buildArchitectReplyRow({ miraIntentId: '', replyText: 'ok' }).reason).toBe('mira_intent_id_required');
    expect(buildArchitectReplyRow({ miraIntentId: 'not-prefixed', replyText: 'ok' }).reason).toBe('mira_intent_id_required');
    expect(buildArchitectReplyRow({ miraIntentId: null, replyText: 'ok' }).reason).toBe('mira_intent_id_required');
  });

  test('always sets target_role to "mira" even if caller would try to spoof another target', () => {
    const built = buildArchitectReplyRow({
      miraIntentId: 'mira-intent-x',
      replyText: 'ok',
      nowMs: 1,
    });
    expect(built.row.target_role).toBe('mira');
  });

  test('row built by buildArchitectReplyRow is matchable by findMiraReplyEvent', () => {
    const built = buildArchitectReplyRow({
      miraIntentId: 'mira-intent-x',
      replyText: 'ok',
      nowMs: 1,
    });
    const found = route.findMiraReplyEvent({ rows: [built.row], miraIntentId: 'mira-intent-x' });
    expect(found).toBe(built.row);
  });

  test('trims reply text', () => {
    const built = buildArchitectReplyRow({ miraIntentId: 'mira-intent-x', replyText: '   short and grounded   ', nowMs: 1 });
    expect(built.row.reply_text).toBe('short and grounded');
  });
});

describe('hm-mira-reply.js CLI smoke', () => {
  const { spawnSync } = require('child_process');

  function runCli(args, options = {}) {
    const cliPath = path.join(__dirname, '..', 'scripts', 'hm-mira-reply.js');
    return spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      input: options.stdin || undefined,
    });
  }

  test('writes a target_role:"mira" architect_reply row to the queue path', () => {
    const dir = tempDir('hm-mira-reply-');
    const queue = path.join(dir, 'mira-event-queue.jsonl');
    const result = runCli([
      'mira-intent-cli-1',
      '--text',
      'short, grounded reply',
      '--queue-path',
      queue,
    ]);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.ok).toBe(true);
    expect(out.target_role).toBe('mira');
    expect(out.mira_intent_id).toBe('mira-intent-cli-1');
    const rows = readJsonlRows({ filePath: queue });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      mira_intent_id: 'mira-intent-cli-1',
      kind: 'architect_reply',
      target_role: 'mira',
      sender_role: 'architect',
      reply_text: 'short, grounded reply',
    }));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('CLI rejects malformed intent id with non-zero exit', () => {
    const dir = tempDir('hm-mira-reply-');
    const queue = path.join(dir, 'mira-event-queue.jsonl');
    const result = runCli([
      'not-a-real-intent-id',
      '--text',
      'reply',
      '--queue-path',
      queue,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mira_intent_id_required');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('CLI rejects empty reply with non-zero exit', () => {
    const dir = tempDir('hm-mira-reply-');
    const queue = path.join(dir, 'mira-event-queue.jsonl');
    const result = runCli([
      'mira-intent-cli-2',
      '--text',
      '   ',
      '--queue-path',
      queue,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reply_text_required');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('CLI --stdin path reads reply from stdin and writes a row', () => {
    const dir = tempDir('hm-mira-reply-');
    const queue = path.join(dir, 'mira-event-queue.jsonl');
    const result = runCli(['mira-intent-cli-3', '--stdin', '--queue-path', queue], {
      stdin: 'reply via stdin\n',
    });
    expect(result.status).toBe(0);
    const rows = readJsonlRows({ filePath: queue });
    expect(rows[0].reply_text).toBe('reply via stdin');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('CLI --lint flag prints violations to stderr but still writes the row', () => {
    const dir = tempDir('hm-mira-reply-');
    const queue = path.join(dir, 'mira-event-queue.jsonl');
    const result = runCli([
      'mira-intent-cli-4',
      '--text',
      'I understand. The lease is fine.',
      '--lint',
      '--queue-path',
      queue,
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Lint violations');
    expect(result.stderr).toContain('preamble');
    const rows = readJsonlRows({ filePath: queue });
    expect(rows[0].reply_text).toBe('I understand. The lease is fine.');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('CLI without --lint does NOT run language gate (emit-side gate is the source of truth)', () => {
    const dir = tempDir('hm-mira-reply-');
    const queue = path.join(dir, 'mira-event-queue.jsonl');
    const result = runCli([
      'mira-intent-cli-5',
      '--text',
      'I understand. Hope that helps.',
      '--queue-path',
      queue,
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Lint violations');
  });
});

describe('mira-architect-route-v0 / newMiraIntentId', () => {
  test('produces a prefixed unique-ish id', () => {
    const a = newMiraIntentId();
    const b = newMiraIntentId();
    expect(a).toMatch(/^mira-intent-/);
    expect(b).toMatch(/^mira-intent-/);
    expect(a).not.toBe(b);
  });
});
