'use strict';

const {
  DEFAULT_ROOM_MEMBERS,
  FORBIDDEN_CLIENT_IDENTITY_FIELDS,
  PARTICIPATION_REASONS,
  TEAM_ROOM_PROMPT_INSTRUCTION,
  buildActivationPrompt,
  classifySameRootCoverage,
  deriveActivationTargets,
  normalizeClientPost,
} = require('../modules/main/team-room-contracts');

const builderIdentity = {
  memberId: 'builder',
  roomId: 'main',
  profileName: 'main',
  memberKind: 'agent',
  role: 'builder',
  paneId: '2',
  source: 'room_cli',
};

describe('team-room contracts', () => {
  test.each(FORBIDDEN_CLIENT_IDENTITY_FIELDS)('rejects client-controlled identity field %s', (field) => {
    const result = normalizeClientPost({
      body: 'spoof attempt',
      clientNonce: `nonce-${field}`,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      [field]: 'architect',
    }, builderIdentity);
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'client_identity_field_forbidden',
      details: { field },
    }));
  });

  test('requires an allowed participation reason from agents', () => {
    expect(normalizeClientPost({ body: 'hello', clientNonce: 'n-1' }, builderIdentity))
      .toEqual(expect.objectContaining({ ok: false, reason: 'agent_participation_reason_required' }));
    expect(normalizeClientPost({
      body: 'hello',
      clientNonce: 'n-2',
      participationReason: 'agreement',
    }, builderIdentity)).toEqual(expect.objectContaining({ ok: false, reason: 'agent_participation_reason_required' }));
  });

  test.each(['hm_send', 'terminal', 'heartbeat', 'telegram'])('rejects non-room ingress source %s', (source) => {
    const result = normalizeClientPost({
      body: 'automatic mirror',
      clientNonce: `mirror-${source}`,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    }, { ...builderIdentity, source });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'trusted_room_source_invalid' }));
  });

  test.each([
    ['-----BEGIN PRIVATE KEY-----\nnot-for-the-room', 'private_key'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', 'bearer_token'],
    ['SSN 123-45-6789', 'government_id'],
    ['card 4242 4242 4242 4242', 'payment_card'],
  ])('rejects high-risk deliberate content before persistence', (body, kind) => {
    const result = normalizeClientPost({
      body,
      clientNonce: `secret-${kind}`,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    }, builderIdentity);
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'room_sensitive_content_forbidden',
      details: { kind },
    }));
  });

  test('accepts only bounded plain JSON metadata and rejects sensitive fields', () => {
    const accepted = normalizeClientPost({
      body: 'Metadata.',
      clientNonce: 'metadata-ok',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      metadata: { decision: { state: 'open', count: 2 } },
    }, builderIdentity);
    expect(accepted.ok).toBe(true);
    const sensitive = normalizeClientPost({
      body: 'Metadata.',
      clientNonce: 'metadata-secret',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      metadata: { apiKey: 'nope' },
    }, builderIdentity);
    expect(sensitive).toEqual(expect.objectContaining({ ok: false, reason: 'room_sensitive_metadata_forbidden' }));
    const cyclic = {};
    cyclic.self = cyclic;
    expect(normalizeClientPost({
      body: 'Metadata.',
      clientNonce: 'metadata-cycle',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      metadata: cyclic,
    }, builderIdentity)).toEqual(expect.objectContaining({ ok: false, reason: 'room_message_metadata_cycle' }));
  });

  test('allows root reentry only for a direct answer, evidence/action, or correction', () => {
    const denied = normalizeClientPost({
      body: 'just texture',
      clientNonce: 'n-3',
      participationReason: PARTICIPATION_REASONS.HUMAN_TEXTURE,
      rootReentry: true,
    }, builderIdentity);
    expect(denied).toEqual(expect.objectContaining({ ok: false, reason: 'room_root_reentry_reason_invalid' }));

    const allowed = normalizeClientPost({
      body: 'new result',
      clientNonce: 'n-4',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      rootReentry: true,
    }, builderIdentity);
    expect(allowed.ok).toBe(true);
  });

  test('suppresses covered social and semantic echoes while preserving additive posts', () => {
    const builderPhoto = {
      messageId: 'trm-builder-photo',
      authorId: 'builder',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      body: 'Yep — full photo came through. Teal-lit PC, ROG screen reading 62°C, white Strimers blazing.',
    };
    const architectPhoto = {
      messageId: 'trm-architect-photo',
      authorId: 'architect',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      body: 'I can read it: Ryuo screen says CPU 62C, the AORUS debug LED shows 62, Astral 5090 lit, and the Lian Li strimer is glowing cyan.',
    };
    const photoEcho = classifySameRootCoverage({
      body: 'The photo path works. I see the teal-lit ROG rig, AIO screen at CPU 62°C, white cables, and GeForce RTX.',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      rootBody: '',
      priorPosts: [architectPhoto, builderPhoto],
    });
    expect(photoEcho).toEqual(expect.objectContaining({
      covered: true,
      reason: 'substance_already_covered',
      coveredByAgentId: expect.stringMatching(/^(?:architect|builder)$/u),
    }));

    expect(classifySameRootCoverage({
      body: 'SquidRun is officially in your pocket now.',
      participationReason: PARTICIPATION_REASONS.HUMAN_TEXTURE,
      rootBody: 'I added Home Screen.',
      priorPosts: [builderPhoto],
    })).toEqual(expect.objectContaining({ covered: true, reason: 'social_beat_already_covered' }));

    expect(classifySameRootCoverage({
      body: 'Production database row 884 persisted with checksum 7f2a.',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      rootBody: 'Did the deploy finish?',
      priorPosts: [{
        messageId: 'trm-build', authorId: 'builder',
        participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
        body: 'The isolated build completed at commit abc123.',
      }],
    })).toEqual(expect.objectContaining({ covered: false, reason: 'new_substance' }));
  });

  test.each([
    [PARTICIPATION_REASONS.MATERIAL_DISSENT_OR_CORRECTION, 'That claim is wrong: session 514 loaded the new handler.'],
    [PARTICIPATION_REASONS.REAL_QUESTION, 'Which phone route did you open?'],
    [PARTICIPATION_REASONS.DIRECT_ANSWER, '@architect this directly answers your question.'],
  ])('never suppresses protected additive participation %s', (participationReason, body) => {
    expect(classifySameRootCoverage({
      body,
      participationReason,
      rootBody: body,
      priorPosts: [{
        messageId: 'trm-prior', authorId: 'builder', participationReason, body,
      }],
    }).covered).toBe(false);
  });

  test('preserves a terse answer when the activated source directly mentions that agent', () => {
    expect(classifySameRootCoverage({
      activatedBody: '@oracle is the listener up?',
      body: 'Yes, it is.',
      memberId: 'oracle',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      rootBody: 'Check the room.',
      priorPosts: [{
        messageId: 'trm-builder-first',
        authorId: 'builder',
        participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
        body: 'The listener accepted the probe.',
      }],
    })).toEqual({ covered: false, reason: 'direct_mention' });
  });

  test('James activates all agents and an agent excludes its author', () => {
    expect(deriveActivationTargets({ memberId: 'james', roomId: 'main', profileName: 'main' }, DEFAULT_ROOM_MEMBERS))
      .toEqual(['architect', 'builder', 'oracle']);
    expect(deriveActivationTargets(builderIdentity, DEFAULT_ROOM_MEMBERS))
      .toEqual(['architect', 'oracle']);
  });

  test('activation prompt carries durable IDs, attachment paths, and the exact choice to reply or stay silent', () => {
    const result = buildActivationPrompt({
      messageId: 'trm-1',
      authorId: 'james',
      rootMessageId: 'trm-1',
      body: 'Look at this photo.',
      attachments: [{
        attachmentId: 'att-1',
        mimeType: 'image/heic',
        bytes: 42,
        sha256: 'ab'.repeat(32),
        localPath: 'D:\\room\\objects\\photo.heic',
      }],
    });
    expect(result.ok).toBe(true);
    expect(result.prompt).toContain('messageId=trm-1');
    expect(result.prompt).toContain(`id=att-1 mime=image/heic bytes=42 sha256=${'ab'.repeat(32)} path=D:\\room\\objects\\photo.heic`);
    expect(result.prompt.endsWith(TEAM_ROOM_PROMPT_INSTRUCTION)).toBe(true);
    expect(result.envelope).toEqual(expect.objectContaining({
      roomMessageId: 'trm-1',
      rootMessageId: 'trm-1',
      instruction: TEAM_ROOM_PROMPT_INSTRUCTION,
    }));
  });
});
