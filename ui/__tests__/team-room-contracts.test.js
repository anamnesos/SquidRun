'use strict';

const {
  DEFAULT_ROOM_MEMBERS,
  FORBIDDEN_CLIENT_IDENTITY_FIELDS,
  NOTIFICATION_CLASSES,
  PARTICIPATION_REASONS,
  TEAM_ROOM_NOTIFICATION_INSTRUCTION,
  TEAM_ROOM_PROMPT_INSTRUCTION,
  buildActivationPrompt,
  classifyRoomMessageAttention,
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

  test('accepts an explicit agent root post without weakening causal replies', () => {
    const root = normalizeClientPost({
      agentInitiatedRoot: true,
      body: 'The immutable gate is green at commit abc123.',
      clientNonce: 'agent-root-1',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    }, builderIdentity);
    expect(root).toEqual(expect.objectContaining({
      ok: true,
      post: expect.objectContaining({
        agentInitiatedRoot: true,
        causalActivationId: null,
        replyToMessageId: null,
      }),
    }));

    expect(normalizeClientPost({
      agentInitiatedRoot: true,
      body: 'Invalid mixed causality.',
      causalActivationId: 'tra_existing',
      clientNonce: 'agent-root-mixed',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      replyToMessageId: 'trm_existing',
    }, builderIdentity)).toEqual(expect.objectContaining({
      ok: false,
      reason: 'room_agent_initiated_root_causality_invalid',
    }));
  });

  test('keeps room names presentational while role identities stay immutable', () => {
    expect(DEFAULT_ROOM_MEMBERS.map(({ memberId, displayName, role }) => ({ memberId, displayName, role })))
      .toEqual([
        { memberId: 'operator', displayName: 'You', role: 'operator' },
        { memberId: 'architect', displayName: 'Mira', role: 'architect' },
        { memberId: 'builder', displayName: 'Rook', role: 'builder' },
        { memberId: 'oracle', displayName: 'Vera', role: 'oracle' },
      ]);
  });

  test('keeps numeric ranges unambiguous in pane activation prompts', () => {
    const result = buildActivationPrompt({
      messageId: 'trm-smart-punctuation',
      authorId: 'builder',
      rootMessageId: 'trm-smart-punctuation',
      body: 'Wait 2–3 minutes—then say “check it.” It’s ready…',
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(result.prompt).toContain('Wait 2-3 minutes -- then say "check it." It\'s ready...');
    expect(result.prompt).not.toContain('23 minutes');
  });

  test.each([
    [PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION, NOTIFICATION_CLASSES.NEEDS_OPERATOR],
    [PARTICIPATION_REASONS.MATERIAL_DISSENT_OR_CORRECTION, NOTIFICATION_CLASSES.FAILURE],
    [PARTICIPATION_REASONS.REAL_QUESTION, NOTIFICATION_CLASSES.QUESTION],
  ])('requires explicit attention class %s/%s for badge and push', (participationReason, notificationClass) => {
    expect(classifyRoomMessageAttention({
      authorId: 'builder',
      author: { memberId: 'builder', memberKind: 'agent' },
      participationReason,
      metadata: { notificationClass },
    }, { memberId: 'operator' })).toEqual({
      level: 'ping',
      shouldBadge: true,
      shouldNotify: true,
      notificationClass,
      reason: `reason_${participationReason}`,
    });
  });

  test.each([
    [PARTICIPATION_REASONS.DIRECT_ANSWER, 'notification_not_requested'],
    [PARTICIPATION_REASONS.HUMAN_TEXTURE, 'notification_not_requested'],
    ['not_a_reason', 'participation_reason_invalid'],
    [null, 'participation_reason_invalid'],
  ])('keeps ordinary or invalid agent reason %s quiet', (participationReason, reason) => {
    expect(classifyRoomMessageAttention({
      authorId: 'oracle',
      author: { memberId: 'oracle', memberKind: 'agent' },
      participationReason,
    }, { memberId: 'operator' })).toEqual({
      level: 'quiet',
      shouldBadge: false,
      shouldNotify: false,
      reason,
    });
  });

  test('fails quiet unless an agent deliberately marks the message for notification', () => {
    expect(classifyRoomMessageAttention({
      authorId: 'builder',
      author: { memberId: 'builder', memberKind: 'agent' },
      participationReason: PARTICIPATION_REASONS.REAL_QUESTION,
    }, { memberId: 'operator' })).toEqual({
      level: 'quiet',
      shouldBadge: false,
      shouldNotify: false,
      reason: 'notification_not_requested',
    });
  });

  test('validates notification class against reason and forbids human-triggered buzzes', () => {
    expect(normalizeClientPost({
      body: 'Operator needs to choose.',
      clientNonce: 'notify-ok',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      notificationClass: NOTIFICATION_CLASSES.NEEDS_OPERATOR,
    }, builderIdentity)).toEqual(expect.objectContaining({
      ok: true,
      post: expect.objectContaining({ metadata: { notificationClass: NOTIFICATION_CLASSES.NEEDS_OPERATOR } }),
    }));
    expect(normalizeClientPost({
      body: 'Mismatched class.',
      clientNonce: 'notify-bad-reason',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      notificationClass: NOTIFICATION_CLASSES.QUESTION,
    }, builderIdentity)).toEqual(expect.objectContaining({
      ok: false,
      reason: 'room_notification_class_reason_mismatch',
    }));
    expect(normalizeClientPost({
      body: 'Human messages never self-page.',
      clientNonce: 'notify-human',
      notificationClass: NOTIFICATION_CLASSES.NEEDS_OPERATOR,
    }, {
      memberId: 'operator', roomId: 'main', profileName: 'main', memberKind: 'human',
      role: 'operator', source: 'room_web',
    })).toEqual(expect.objectContaining({ ok: false, reason: 'human_notification_class_forbidden' }));
  });

  test('fails quiet for own, human-authored, and incomplete messages', () => {
    expect(classifyRoomMessageAttention({
      authorId: 'operator',
      author: { memberId: 'operator', memberKind: 'human' },
      participationReason: PARTICIPATION_REASONS.REAL_QUESTION,
    }, { memberId: 'operator' })).toEqual(expect.objectContaining({
      shouldNotify: false,
      reason: 'own_message',
    }));

    expect(classifyRoomMessageAttention({
      authorId: 'operator',
      author: { memberId: 'operator', memberKind: 'human' },
      participationReason: PARTICIPATION_REASONS.REAL_QUESTION,
    }, { memberId: 'builder' })).toEqual(expect.objectContaining({
      shouldNotify: false,
      reason: 'non_agent_message',
    }));

    expect(classifyRoomMessageAttention({
      authorId: 'builder',
      participationReason: PARTICIPATION_REASONS.REAL_QUESTION,
    }, { memberId: 'operator' })).toEqual(expect.objectContaining({
      shouldNotify: false,
      reason: 'non_agent_message',
    }));

    expect(classifyRoomMessageAttention({}, {})).toEqual(expect.objectContaining({
      shouldNotify: false,
      reason: 'viewer_member_required',
    }));
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
      body: 'The photo came through: teal ROG rig, CPU 62C, white Strimers.',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
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
    })).toEqual(expect.objectContaining({ covered: false, reason: 'distinct_human_texture' }));

    expect(classifySameRootCoverage({
      body: 'SquidRun is officially in your pocket now!',
      participationReason: PARTICIPATION_REASONS.HUMAN_TEXTURE,
      rootBody: 'I added Home Screen.',
      priorPosts: [{
        messageId: 'trm-builder-texture',
        authorId: 'builder',
        participationReason: PARTICIPATION_REASONS.HUMAN_TEXTURE,
        body: 'squidrun is officially in your pocket now.',
      }],
    })).toEqual(expect.objectContaining({
      covered: true,
      reason: 'social_beat_duplicate',
      coveredByAgentId: 'builder',
    }));

    expect(classifySameRootCoverage({
      body: 'Production database row 884 persisted with checksum 7f2a.',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      rootBody: 'Did the deploy finish?',
      priorPosts: [{
        messageId: 'trm-build', authorId: 'builder',
        participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
        body: 'The isolated build completed at commit abc123.',
      }],
    })).toEqual(expect.objectContaining({ covered: false, reason: 'reason_class_is_additive' }));

    expect(classifySameRootCoverage({
      body: 'The phone photo retained 4032 by 3024 resolution.',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      rootBody: 'Is the listener up and did the phone photo retain full resolution?',
      priorPosts: [{
        messageId: 'trm-builder-listener', authorId: 'builder',
        participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
        body: 'The TCP listener returned HTTP 200.',
      }],
    })).toEqual(expect.objectContaining({ covered: false, reason: 'new_substance' }));

    expect(classifySameRootCoverage({
      body: 'The HTTP listener returned 200; the phone photo retained 4032 by 3024 resolution.',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      rootBody: 'Is the listener up and did the phone photo retain full resolution?',
      priorPosts: [{
        messageId: 'trm-builder-listener', authorId: 'builder',
        participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
        body: 'The TCP listener returned HTTP 200.',
      }],
    })).toEqual(expect.objectContaining({ covered: false, reason: 'new_substance' }));
  });

  test.each([
    [PARTICIPATION_REASONS.MATERIAL_DISSENT_OR_CORRECTION, 'That claim is wrong: session 514 loaded the new handler.'],
    [PARTICIPATION_REASONS.REAL_QUESTION, 'Which phone route did you open?'],
    [PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION, 'The same checksum is independently confirmed.'],
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

  test('never suppresses an attachment-bearing answer', () => {
    expect(classifySameRootCoverage({
      attachments: [{ attachmentId: 'att-new-proof' }],
      body: 'The photo came through.',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      priorPosts: [{
        messageId: 'trm-prior', authorId: 'builder',
        participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
        body: 'The photo came through.',
      }],
    })).toEqual({ covered: false, reason: 'attachments_are_additive' });
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

  test.each([
    ['architect', '@Mira can you verify this?'],
    ['builder', '@Rook can you verify this?'],
    ['oracle', '@Vera can you verify this?'],
  ])('treats the display name as a mention alias for %s', (memberId, activatedBody) => {
    expect(classifySameRootCoverage({
      activatedBody,
      body: 'Yes.',
      memberId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      priorPosts: [{
        messageId: 'trm-prior',
        authorId: 'operator',
        participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
        body: 'Someone else already said yes.',
      }],
    })).toEqual({ covered: false, reason: 'direct_mention' });
  });

  test('Operator activates all agents and an agent excludes its author', () => {
    expect(deriveActivationTargets({ memberId: 'operator', roomId: 'main', profileName: 'main' }, DEFAULT_ROOM_MEMBERS))
      .toEqual(['architect', 'builder', 'oracle']);
    expect(deriveActivationTargets(builderIdentity, DEFAULT_ROOM_MEMBERS))
      .toEqual(['architect', 'oracle']);
  });

  test('activation prompt carries durable IDs, attachment paths, and the exact choice to reply or stay silent', () => {
    const result = buildActivationPrompt({
      messageId: 'trm-1',
      authorId: 'operator',
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
    expect(result.prompt).toContain(TEAM_ROOM_NOTIFICATION_INSTRUCTION);
    expect(result.prompt.endsWith(TEAM_ROOM_PROMPT_INSTRUCTION)).toBe(true);
    expect(result.envelope).toEqual(expect.objectContaining({
      roomMessageId: 'trm-1',
      rootMessageId: 'trm-1',
      instruction: TEAM_ROOM_PROMPT_INSTRUCTION,
    }));
  });
});
