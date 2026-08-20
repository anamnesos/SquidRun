'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TeamRoomAuth,
  hashToken,
  isPrivateLanHostname,
  parsePrivateNetworkOrigin,
  safeNetworkPolicy,
} = require('../modules/main/team-room-auth');
const {
  PARTICIPATION_REASONS,
  SAME_ROOT_COVERAGE_WINDOW_MS,
} = require('../modules/main/team-room-contracts');
const { TeamRoomDeliveryAdapter } = require('../modules/main/team-room-delivery-adapter');
const { TeamRoomService } = require('../modules/main/team-room-service');
const {
  SCHEMA_V1_SQL,
  TeamRoomStore,
  loadSqliteDriver,
} = require('../modules/main/team-room-store');

function memberIdentity(memberId) {
  const identities = {
    james: { memberKind: 'human', role: 'james', paneId: null, source: 'room_web' },
    architect: { memberKind: 'agent', role: 'architect', paneId: '1', source: 'room_cli' },
    builder: { memberKind: 'agent', role: 'builder', paneId: '2', source: 'room_cli' },
    oracle: { memberKind: 'agent', role: 'oracle', paneId: '3', source: 'room_cli' },
  };
  return { memberId, roomId: 'main', profileName: 'main', ...identities[memberId] };
}

describe('team-room production service path', () => {
  let tempDir;
  let store;
  let auth;
  let service;
  let idCounter;
  let nowMs;
  let credentials;
  let registrations;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-room-store-'));
    idCounter = 0;
    nowMs = 1000;
    store = new TeamRoomStore({
      dbPath: path.join(tempDir, 'room.db'),
      attachmentRoot: path.join(tempDir, 'media'),
      now: () => ++nowMs,
      randomUUID: () => `id-${++idCounter}`,
    });
    expect(store.init().ok).toBe(true);
    registrations = new Map();
    for (const memberId of ['james', 'architect', 'builder', 'oracle']) {
      registrations.set(`registration-${memberId}`, {
        ok: true,
        registrationAuthority: memberId === 'james' ? 'paired_device' : 'runtime_registry',
        identity: memberIdentity(memberId),
      });
    }
    auth = new TeamRoomAuth({
      store,
      now: () => nowMs,
      randomBytes: () => Buffer.alloc(32, idCounter + 1),
      randomUUID: () => `cred-${++idCounter}`,
      resolveTrustedRegistration: (request) => registrations.get(request.registrationToken) || null,
    });
    service = new TeamRoomService({ store, auth });
    credentials = {};
    for (const memberId of ['james', 'architect', 'builder', 'oracle']) {
      const issued = auth.issueCredential({
        registrationToken: `registration-${memberId}`,
      });
      expect(issued.ok).toBe(true);
      credentials[memberId] = issued;
    }
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function postAs(memberId, payload) {
    return service.post({
      authorization: `Bearer ${credentials[memberId].token}`,
      source: memberId === 'james' ? 'room_web' : 'room_cli',
      roomId: 'main',
      profileName: 'main',
      payload,
    });
  }

  function deliverActivation(targetMemberId) {
    const claimed = store.claimActivationBatch(targetMemberId, { limit: 1 });
    expect(claimed.ok).toBe(true);
    expect(claimed.activations).toHaveLength(1);
    const payload = claimed.activations[0];
    expect(store.markActivationDelivered(payload.activation.activationId).ok).toBe(true);
    return payload;
  }

  test('binds identity from a stored credential and never stores the raw token', () => {
    const credential = credentials.builder;
    const row = store.db.prepare('SELECT token_hash FROM room_auth_credentials WHERE credential_id = ?')
      .get(credential.credential.credentialId);
    expect(row.token_hash).toBe(hashToken(credential.token));
    expect(row.token_hash).not.toBe(credential.token);

    const spoofed = postAs('builder', {
      body: 'I am Architect now',
      clientNonce: 'spoof-1',
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      authorId: 'architect',
    });
    expect(spoofed).toEqual(expect.objectContaining({ ok: false, reason: 'client_identity_field_forbidden' }));
    expect(store.listMessages()).toHaveLength(0);

    const serverResolved = auth.issueCredential({
      registrationToken: 'registration-builder',
      identity: memberIdentity('james'),
    });
    expect(serverResolved).toEqual(expect.objectContaining({
      ok: true,
      credential: expect.objectContaining({ memberId: 'builder', profileName: 'main' }),
    }));
  });

  test('rejects paired-device and runtime credential source relabeling and persists only the bound source', () => {
    const jamesMismatch = service.post({
      authorization: `Bearer ${credentials.james.token}`,
      source: 'room_cli',
      roomId: 'main',
      profileName: 'main',
      payload: { body: 'wrong endpoint', clientNonce: 'source-james-wrong' },
    });
    expect(jamesMismatch).toEqual(expect.objectContaining({ ok: false, reason: 'room_source_mismatch' }));
    const builderMismatch = service.post({
      authorization: `Bearer ${credentials.builder.token}`,
      source: 'room_web',
      roomId: 'main',
      profileName: 'main',
      payload: {
        body: 'wrong endpoint',
        clientNonce: 'source-builder-wrong',
        participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
      },
    });
    expect(builderMismatch).toEqual(expect.objectContaining({ ok: false, reason: 'room_source_mismatch' }));
    expect(store.listMessages()).toHaveLength(0);

    const accepted = postAs('james', { body: 'bound endpoint', clientNonce: 'source-james-right' });
    expect(accepted.ok).toBe(true);
    expect(accepted.message.source).toBe('room_web');
    const credentialRow = store.db.prepare(`
      SELECT source FROM room_auth_credentials WHERE credential_id = ?
    `).get(credentials.james.credential.credentialId);
    expect(credentialRow.source).toBe('room_web');
    expect(store.db.prepare('SELECT source FROM room_messages WHERE message_id = ?').get(accepted.message.messageId).source)
      .toBe('room_web');
  });

  test('migrates v1 credentials to a bound source and makes the source immutable', () => {
    const legacyPath = path.join(tempDir, 'legacy-v1.db');
    const driver = loadSqliteDriver();
    const legacy = driver.create(legacyPath);
    legacy.exec('PRAGMA foreign_keys=ON;');
    legacy.exec(SCHEMA_V1_SQL);
    legacy.prepare(`
      INSERT INTO room_members (
        room_id, profile_name, member_id, display_name, member_kind, role, pane_id, avatar_key, active, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('main', 'main', 'james', 'James', 'human', 'james', null, 'james', 1, 1);
    legacy.prepare(`
      INSERT INTO room_auth_credentials (
        credential_id, token_hash, room_id, profile_name, member_id, session_kind,
        capabilities_json, created_at_ms, expires_at_ms, revoked_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run('legacy-credential', 'a'.repeat(64), 'main', 'main', 'james', 'paired_device', '["post"]', 1, 999999);
    legacy.exec('PRAGMA user_version=1;');
    legacy.close();

    const migrated = new TeamRoomStore({
      dbPath: legacyPath,
      attachmentRoot: path.join(tempDir, 'legacy-media'),
    });
    expect(migrated.init().ok).toBe(true);
    expect(Object.values(migrated.db.prepare('PRAGMA user_version').get())[0]).toBe(3);
    expect(migrated.getAuthCredentialByHash('a'.repeat(64))).toEqual(expect.objectContaining({ source: 'room_web' }));
    expect(() => migrated.db.prepare('UPDATE room_auth_credentials SET source = ? WHERE credential_id = ?')
      .run('room_cli', 'legacy-credential')).toThrow(/room_auth_source_immutable/u);
    migrated.close();
  });

  test('migrates duplicate legacy links into distinct consumed claims and preserves an unlinked handle', () => {
    const linkedPath = path.join(tempDir, 'media', 'legacy-linked.png');
    const unlinkedPath = path.join(tempDir, 'media', 'legacy-unlinked.png');
    fs.writeFileSync(linkedPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]));
    fs.writeFileSync(unlinkedPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8]));
    const linked = store.registerReadyAttachment({ filePath: linkedPath, claimedMime: 'image/png' });
    const unlinked = store.registerReadyAttachment({ filePath: unlinkedPath, claimedMime: 'image/png' });
    const first = postAs('james', { body: 'Legacy first.', clientNonce: 'legacy-link-first' });
    const second = postAs('james', { body: 'Legacy second.', clientNonce: 'legacy-link-second' });
    expect(linked.ok && unlinked.ok && first.ok && second.ok).toBe(true);

    store.db.exec(`
      DROP TRIGGER room_message_attachments_append_only_update;
      DROP TRIGGER room_message_attachments_append_only_delete;
      DROP TRIGGER room_attachment_claim_identity_immutable;
      DROP TRIGGER room_attachment_claim_transition_guard;
      DROP TRIGGER room_attachment_claims_append_only_delete;
      DROP TABLE room_message_attachments;
      DROP TABLE room_attachment_claims;
      CREATE TABLE room_message_attachments (
        message_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (message_id, attachment_id),
        UNIQUE (message_id, ordinal),
        FOREIGN KEY (message_id) REFERENCES room_messages (message_id),
        FOREIGN KEY (attachment_id) REFERENCES room_attachments (attachment_id)
      );
      CREATE TRIGGER room_message_attachments_append_only_update
      BEFORE UPDATE ON room_message_attachments
      BEGIN SELECT RAISE(ABORT, 'room_message_attachments_append_only'); END;
      CREATE TRIGGER room_message_attachments_append_only_delete
      BEFORE DELETE ON room_message_attachments
      BEGIN SELECT RAISE(ABORT, 'room_message_attachments_append_only'); END;
      PRAGMA user_version=2;
    `);
    store.db.prepare('INSERT INTO room_message_attachments (message_id, attachment_id, ordinal) VALUES (?, ?, 0)')
      .run(first.message.messageId, linked.attachment.attachmentId);
    store.db.prepare('INSERT INTO room_message_attachments (message_id, attachment_id, ordinal) VALUES (?, ?, 0)')
      .run(second.message.messageId, linked.attachment.attachmentId);
    store.close();

    store = new TeamRoomStore({
      dbPath: path.join(tempDir, 'room.db'),
      attachmentRoot: path.join(tempDir, 'media'),
      now: () => ++nowMs,
      randomUUID: () => `id-${++idCounter}`,
    });
    expect(store.init()).toEqual(expect.objectContaining({ ok: true }));
    expect(Object.values(store.db.prepare('PRAGMA user_version').get())[0]).toBe(3);
    const firstAttachments = store.getMessageAttachments(first.message.messageId);
    const secondAttachments = store.getMessageAttachments(second.message.messageId);
    expect(firstAttachments).toHaveLength(1);
    expect(secondAttachments).toHaveLength(1);
    expect(firstAttachments[0].attachmentId).not.toBe(secondAttachments[0].attachmentId);
    expect(firstAttachments[0].contentAttachmentId).toBe(linked.attachment.attachmentId);
    expect(secondAttachments[0].contentAttachmentId).toBe(linked.attachment.attachmentId);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM room_attachment_claims').get().count).toBe(3);
    expect(store.db.prepare('SELECT COUNT(DISTINCT claim_id) AS count FROM room_message_attachments').get().count).toBe(2);

    const replayed = store.postMessage({
      identity: memberIdentity('james'),
      payload: {
        body: 'Legacy claimed handle replay.',
        clientNonce: 'legacy-claimed-replay',
        attachmentIds: [firstAttachments[0].attachmentId],
      },
    });
    expect(replayed).toEqual({ ok: false, reason: 'room_attachment_already_claimed' });
    const postedUnlinked = store.postMessage({
      identity: memberIdentity('james'),
      payload: {
        body: 'Legacy unlinked handle remains usable.',
        clientNonce: 'legacy-unlinked-use',
        attachmentIds: [unlinked.attachment.attachmentId],
      },
    });
    expect(postedUnlinked).toEqual(expect.objectContaining({ ok: true, status: 'inserted' }));
  });

  test('traverses auth to persistence to durable target activations to the canonical delivery adapter', async () => {
    const jamesPost = postAs('james', { body: 'Room check.', clientNonce: 'james-1' });
    expect(jamesPost.ok).toBe(true);
    expect(jamesPost.activations.map((item) => item.targetMemberId)).toEqual(['architect', 'builder', 'oracle']);

    const deliveries = [];
    const adapter = new TeamRoomDeliveryAdapter({
      store,
      deliverToPane: async (delivery) => {
        deliveries.push(delivery);
        return { ok: true };
      },
    });
    const result = await adapter.dispatchSafeBoundary('builder');
    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: expect.any(Array) }));
    expect(result.delivered).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].member).toEqual(expect.objectContaining({ memberId: 'builder', paneId: '2' }));
    expect(deliveries[0].prompt).toContain(`messageId=${jamesPost.message.messageId}`);
    expect(deliveries[0].prompt).toContain('reply via hm-room or stay silent.');
    expect(store.getActivation(result.delivered[0]).status).toBe('delivered');
  });

  test('preserves canonical punctuation while making the derived pane prompt transport-safe', async () => {
    const canonicalBody = 'Wait 2–3 minutes—then say “check it.”';
    const jamesPost = postAs('james', {
      body: canonicalBody,
      clientNonce: 'james-smart-punctuation',
    });
    expect(jamesPost.ok).toBe(true);

    const stored = store.db.prepare('SELECT body FROM room_messages WHERE message_id = ?')
      .get(jamesPost.message.messageId);
    expect(stored.body).toBe(canonicalBody);
    expect(stored.body.codePointAt(stored.body.indexOf('–'))).toBe(0x2013);

    const deliveries = [];
    const adapter = new TeamRoomDeliveryAdapter({
      store,
      deliverToPane: async (delivery) => {
        deliveries.push(delivery);
        return { ok: true };
      },
    });
    const result = await adapter.dispatchSafeBoundary('builder');
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].prompt).toContain('Wait 2-3 minutes -- then say "check it."');
    expect(deliveries[0].prompt).not.toContain('23 minutes');
  });

  test('is idempotent by author nonce and rejects a changed replay', () => {
    const payload = { body: 'Exactly once.', clientNonce: 'nonce-1' };
    const first = postAs('james', payload);
    const replay = postAs('james', payload);
    const conflict = postAs('james', { ...payload, body: 'Changed body.' });
    expect(first.status).toBe('inserted');
    expect(replay).toEqual(expect.objectContaining({ ok: true, status: 'idempotent' }));
    expect(replay.message.messageId).toBe(first.message.messageId);
    expect(conflict).toEqual(expect.objectContaining({ ok: false, reason: 'room_client_nonce_conflict' }));
    expect(store.listMessages()).toHaveLength(1);
    expect(store.listActivations(first.message.messageId)).toHaveLength(3);
  });

  test('lets an agent initiate one bounded root, activates only peers, and rejects an echo loop', () => {
    const root = postAs('builder', {
      agentInitiatedRoot: true,
      body: 'The isolated room gate is green at commit abc123.',
      clientNonce: 'agent-root-builder-1',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    });
    expect(root.ok).toBe(true);
    expect(root.message).toEqual(expect.objectContaining({
      authorId: 'builder',
      causalActivationId: null,
      replyToMessageId: null,
      rootMessageId: root.message.messageId,
    }));
    expect(root.activations.map((item) => item.targetMemberId)).toEqual(['architect', 'oracle']);

    const duplicate = postAs('builder', {
      agentInitiatedRoot: true,
      body: 'The isolated room gate is green at commit abc123.',
      clientNonce: 'agent-root-builder-duplicate',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    });
    expect(duplicate).toEqual(expect.objectContaining({
      ok: false,
      reason: 'room_agent_root_duplicate',
      details: { duplicateOfMessageId: root.message.messageId, duplicateCreatedAtMs: expect.any(Number) },
    }));

    const architectDelivery = deliverActivation('architect');
    const architectReply = postAs('architect', {
      body: 'Independent boot and shutdown proof is also green.',
      clientNonce: 'agent-root-architect-reply',
      replyToMessageId: architectDelivery.message.messageId,
      causalActivationId: architectDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    });
    expect(architectReply.ok).toBe(true);

    const authorEchoActivation = deliverActivation('builder');
    expect(postAs('builder', {
      body: 'This echo must not extend the chain.',
      clientNonce: 'agent-root-builder-echo',
      replyToMessageId: authorEchoActivation.message.messageId,
      causalActivationId: authorEchoActivation.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    })).toEqual(expect.objectContaining({ ok: false, reason: 'agent_root_post_limit_reached' }));
    expect(store.listMessages()).toHaveLength(2);
    expect(store.getRoomState()).toEqual(expect.objectContaining({
      consecutiveAgentPosts: 2,
      activationFused: false,
    }));
  });

  test('applies the six-post fuse across agent-initiated roots and requires James to reset it', () => {
    const order = ['builder', 'architect', 'oracle', 'builder', 'architect', 'oracle'];
    let sixth;
    for (let index = 0; index < order.length; index += 1) {
      sixth = postAs(order[index], {
        agentInitiatedRoot: true,
        body: `Independent initiated root ${index + 1}.`,
        clientNonce: `initiated-fuse-${index + 1}`,
        participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      });
      expect(sixth.ok).toBe(true);
    }
    expect(store.getRoomState()).toEqual(expect.objectContaining({
      consecutiveAgentPosts: 6,
      activationFused: true,
    }));
    expect(sixth.message.activationSuppressed).toBe(true);
    expect(sixth.activations.every((activation) => activation.status === 'suppressed_fuse')).toBe(true);
    expect(postAs('builder', {
      agentInitiatedRoot: true,
      body: 'The seventh initiated root must not land.',
      clientNonce: 'initiated-fuse-7',
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    })).toEqual(expect.objectContaining({ ok: false, reason: 'room_activation_fused' }));

    expect(postAs('james', { body: 'Fresh human turn.', clientNonce: 'initiated-fuse-reset' }).ok).toBe(true);
    expect(store.getRoomState()).toEqual(expect.objectContaining({
      consecutiveAgentPosts: 0,
      activationFused: false,
    }));
  });

  test('converges persisted display names without changing room identity keys', () => {
    store.db.prepare("UPDATE room_members SET display_name = member_id WHERE member_kind = 'agent'").run();
    const dbPath = store.dbPath;
    const attachmentRoot = store.attachmentRoot;
    store.close();
    store = new TeamRoomStore({
      dbPath,
      attachmentRoot,
      now: () => ++nowMs,
      randomUUID: () => `id-${++idCounter}`,
    });
    expect(store.init().ok).toBe(true);
    expect(store.listMembers().map(({ memberId, displayName, role }) => ({ memberId, displayName, role })))
      .toEqual([
        { memberId: 'architect', displayName: 'Mira', role: 'architect' },
        { memberId: 'builder', displayName: 'Rook', role: 'builder' },
        { memberId: 'james', displayName: 'James', role: 'james' },
        { memberId: 'oracle', displayName: 'Vera', role: 'oracle' },
      ]);
  });

  test('missing-target repair adds only the new member activation and preserves existing activation IDs', () => {
    const posted = postAs('james', { body: 'Expansion-safe.', clientNonce: 'missing-target-1' });
    const before = new Map(posted.activations.map((item) => [item.targetMemberId, item.activationId]));
    store.db.prepare(`
      INSERT INTO room_members (
        room_id, profile_name, member_id, display_name, member_kind, role, pane_id, avatar_key, active, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('main', 'main', 'reviewer', 'Reviewer', 'agent', 'reviewer', '4', 'reviewer', 1, ++nowMs);
    const repaired = store.ensureMissingActivations(posted.message.messageId);
    expect(repaired.ok).toBe(true);
    expect(repaired.inserted).toBe(1);
    expect(repaired.activations).toHaveLength(4);
    expect(repaired.activations.find((item) => item.targetMemberId === 'reviewer')).toBeTruthy();
    for (const [target, activationId] of before) {
      expect(repaired.activations.find((item) => item.targetMemberId === target).activationId).toBe(activationId);
    }
  });

  test('requires a delivered target activation, excludes the author, and caps one post per causal root', () => {
    const root = postAs('james', { body: 'Discuss.', clientNonce: 'root-1' });
    const builderDelivery = deliverActivation('builder');
    const builderReply = postAs('builder', {
      body: 'Builder answer.',
      clientNonce: 'builder-1',
      replyToMessageId: builderDelivery.message.messageId,
      causalActivationId: builderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    });
    expect(builderReply.ok).toBe(true);
    expect(builderReply.message.rootMessageId).toBe(root.message.messageId);
    expect(builderReply.activations.map((item) => item.targetMemberId)).toEqual(['architect', 'oracle']);

    const oracleDelivery = deliverActivation('oracle');
    const oracleReply = postAs('oracle', {
      body: 'Database row 42 persisted with checksum cafe.',
      clientNonce: 'oracle-1',
      replyToMessageId: oracleDelivery.message.messageId,
      causalActivationId: oracleDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    });
    expect(oracleReply.ok).toBe(true);

    const secondBuilderDelivery = deliverActivation('builder');
    const capped = postAs('builder', {
      body: 'Unnecessary second post.',
      clientNonce: 'builder-2',
      replyToMessageId: secondBuilderDelivery.message.messageId,
      causalActivationId: secondBuilderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.HUMAN_TEXTURE,
    });
    expect(capped).toEqual(expect.objectContaining({ ok: false, reason: 'agent_root_post_limit_reached' }));

    const reentry = postAs('builder', {
      body: 'New evidence worth re-entering.',
      clientNonce: 'builder-3',
      replyToMessageId: secondBuilderDelivery.message.messageId,
      causalActivationId: secondBuilderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      rootReentry: true,
    });
    expect(reentry.ok).toBe(true);
  });

  test('atomically rejects covered cross-agent echoes but preserves distinct additive posts', () => {
    const root = postAs('james', { body: 'Did the phone photo arrive?', clientNonce: 'coverage-root' });
    const builderDelivery = deliverActivation('builder');
    const builderReply = postAs('builder', {
      body: 'Yep — the full photo came through. Teal ROG rig, CPU at 62C, white Strimers.',
      clientNonce: 'coverage-builder',
      replyToMessageId: builderDelivery.message.messageId,
      causalActivationId: builderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    });
    expect(builderReply.ok).toBe(true);

    const architectDelivery = deliverActivation('architect');
    const covered = postAs('architect', {
      body: 'The photo came through: teal ROG rig, CPU 62C, white Strimers.',
      clientNonce: 'coverage-architect-echo',
      replyToMessageId: architectDelivery.message.messageId,
      causalActivationId: architectDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    });
    expect(covered).toEqual({
      ok: false,
      reason: 'room_root_already_covered',
      details: expect.objectContaining({
        rootMessageId: root.message.messageId,
        coveredByAgent: 'builder',
        coveredByMessageId: builderReply.message.messageId,
        coverageReason: 'substance_already_covered',
      }),
    });
    expect(store.listMessages().map((message) => message.clientNonce))
      .not.toContain('coverage-architect-echo');

    const distinctRetry = postAs('architect', {
      body: 'The HEIC decoder also preserved the original 4032x3024 dimensions.',
      clientNonce: 'coverage-architect-additive',
      replyToMessageId: architectDelivery.message.messageId,
      causalActivationId: architectDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    });
    expect(distinctRetry.ok).toBe(true);
  });

  test('does not count a multipart root question as proof that another agent covered the second answer', () => {
    postAs('james', {
      body: 'Is the listener up and did the phone photo retain full resolution?',
      clientNonce: 'multipart-coverage-root',
    });
    const builderDelivery = deliverActivation('builder');
    expect(postAs('builder', {
      body: 'The TCP listener returned HTTP 200.',
      clientNonce: 'multipart-coverage-listener',
      replyToMessageId: builderDelivery.message.messageId,
      causalActivationId: builderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    }).ok).toBe(true);

    const oracleDelivery = deliverActivation('oracle');
    const photoAnswer = postAs('oracle', {
      body: 'The phone photo retained 4032 by 3024 resolution.',
      clientNonce: 'multipart-coverage-photo',
      replyToMessageId: oracleDelivery.message.messageId,
      causalActivationId: oracleDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    });
    expect(photoAnswer.ok).toBe(true);
    expect(store.listMessages().map((message) => message.clientNonce))
      .toContain('multipart-coverage-photo');
  });

  test('lands a combined answer when any substantive token is absent from prior agent posts', () => {
    postAs('james', {
      body: 'Is the listener up and did the phone photo retain full resolution?',
      clientNonce: 'combined-coverage-root',
    });
    const builderDelivery = deliverActivation('builder');
    expect(postAs('builder', {
      body: 'The TCP listener returned HTTP 200.',
      clientNonce: 'combined-coverage-listener',
      replyToMessageId: builderDelivery.message.messageId,
      causalActivationId: builderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    }).ok).toBe(true);

    const oracleDelivery = deliverActivation('oracle');
    const combinedAnswer = postAs('oracle', {
      body: 'The HTTP listener returned 200; the phone photo retained 4032 by 3024 resolution.',
      clientNonce: 'multipart-coverage-combined',
      replyToMessageId: oracleDelivery.message.messageId,
      causalActivationId: oracleDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    });
    expect(combinedAnswer.ok).toBe(true);
  });

  test('lands an attachment-bearing answer even when its text is already covered', () => {
    postAs('james', { body: 'Did the phone photo arrive?', clientNonce: 'attachment-coverage-root' });
    const builderDelivery = deliverActivation('builder');
    expect(postAs('builder', {
      body: 'The photo came through.',
      clientNonce: 'attachment-coverage-builder',
      replyToMessageId: builderDelivery.message.messageId,
      causalActivationId: builderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    }).ok).toBe(true);

    const attachmentPath = path.join(tempDir, 'media', 'attachment-coverage.png');
    fs.writeFileSync(attachmentPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]));
    const registered = store.registerReadyAttachment({ filePath: attachmentPath, claimedMime: 'image/png' });
    expect(registered.ok).toBe(true);
    const claim = store.createAttachmentClaim(registered.attachment.attachmentId, {
      roomId: 'main', profileName: 'main',
    });
    expect(claim.ok).toBe(true);
    const oracleDelivery = deliverActivation('oracle');
    const attachedAnswer = postAs('oracle', {
      body: 'The photo came through.',
      attachmentIds: [claim.attachment.attachmentId],
      clientNonce: 'attachment-coverage-oracle',
      replyToMessageId: oracleDelivery.message.messageId,
      causalActivationId: oracleDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    });
    expect(attachedAnswer.ok).toBe(true);
    expect(store.getMessageAttachments(attachedAnswer.message.messageId)).toHaveLength(1);
  });

  test('allows two independently additive posts seconds apart and direct mentions unconditionally', () => {
    postAs('james', { body: 'Give me the two verification results.', clientNonce: 'additive-root' });
    const builderDelivery = deliverActivation('builder');
    expect(postAs('builder', {
      body: 'The HTTP probe returned status 200 with origin 192.168.0.200.',
      clientNonce: 'additive-builder',
      replyToMessageId: builderDelivery.message.messageId,
      causalActivationId: builderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    }).ok).toBe(true);

    const oracleDelivery = deliverActivation('oracle');
    expect(postAs('oracle', {
      body: 'The SQLite row preserved attachment digest aa9978 and byte count 3797838.',
      clientNonce: 'additive-oracle',
      replyToMessageId: oracleDelivery.message.messageId,
      causalActivationId: oracleDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
    }).ok).toBe(true);

    const architectDelivery = deliverActivation('architect');
    expect(postAs('architect', {
      body: '@builder your requested second check is here.',
      clientNonce: 'additive-direct-mention',
      replyToMessageId: architectDelivery.message.messageId,
      causalActivationId: architectDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    }).ok).toBe(true);
  });

  test('binds the direct-mention bypass to the activated source and posting identity', () => {
    postAs('james', { body: 'Coordinate the listener check.', clientNonce: 'mention-root' });
    const builderDelivery = deliverActivation('builder');
    expect(postAs('builder', {
      body: 'The listener accepted my TCP probe.',
      clientNonce: 'mention-builder',
      replyToMessageId: builderDelivery.message.messageId,
      causalActivationId: builderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    }).ok).toBe(true);

    const architectDelivery = deliverActivation('architect');
    const architectQuestion = postAs('architect', {
      body: '@oracle is the listener up?',
      clientNonce: 'mention-architect',
      replyToMessageId: architectDelivery.message.messageId,
      causalActivationId: architectDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.REAL_QUESTION,
    });
    expect(architectQuestion.ok).toBe(true);

    const oracleClaims = store.claimActivationBatch('oracle', { limit: 10 });
    const oracleQuestionActivation = oracleClaims.activations
      .find((item) => item.message.messageId === architectQuestion.message.messageId);
    expect(oracleQuestionActivation).toBeTruthy();
    for (const item of oracleClaims.activations) {
      expect(store.markActivationDelivered(item.activation.activationId).ok).toBe(true);
    }
    expect(postAs('oracle', {
      body: 'Yes, it is.',
      clientNonce: 'mention-oracle-terse',
      replyToMessageId: oracleQuestionActivation.message.messageId,
      causalActivationId: oracleQuestionActivation.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    }).ok).toBe(true);
  });

  test('limits duplicate coverage suppression to the short post-time window', () => {
    postAs('james', { body: 'Window check.', clientNonce: 'coverage-window-root' });
    const builderDelivery = deliverActivation('builder');
    expect(postAs('builder', {
      body: 'The QR route is working.',
      clientNonce: 'coverage-window-builder',
      replyToMessageId: builderDelivery.message.messageId,
      causalActivationId: builderDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    }).ok).toBe(true);

    nowMs += SAME_ROOT_COVERAGE_WINDOW_MS + 1;
    const architectDelivery = deliverActivation('architect');
    expect(postAs('architect', {
      body: 'The QR route is working.',
      clientNonce: 'coverage-window-architect',
      replyToMessageId: architectDelivery.message.messageId,
      causalActivationId: architectDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.DIRECT_ANSWER,
    }).ok).toBe(true);
  });

  test('persists the sixth agent post but suppresses all further activation until James posts', () => {
    postAs('james', { body: 'Start chain.', clientNonce: 'fuse-root' });
    const order = ['builder', 'architect', 'oracle', 'builder', 'architect', 'oracle'];
    let sixth;
    for (let index = 0; index < order.length; index += 1) {
      const memberId = order[index];
      const delivery = deliverActivation(memberId);
      sixth = postAs(memberId, {
        body: `Agent post ${index + 1}`,
        clientNonce: `fuse-${index + 1}`,
        replyToMessageId: delivery.message.messageId,
        causalActivationId: delivery.activation.activationId,
        participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
        rootReentry: index >= 3,
      });
      expect(sixth.ok).toBe(true);
    }
    expect(store.getRoomState()).toEqual(expect.objectContaining({
      consecutiveAgentPosts: 6,
      activationFused: true,
    }));
    expect(sixth.message.activationSuppressed).toBe(true);
    expect(sixth.activations.every((item) => item.status === 'suppressed_fuse')).toBe(true);
    expect(store.claimActivationBatch('builder')).toEqual(expect.objectContaining({
      ok: true,
      fused: true,
      activations: [],
    }));

    const reset = postAs('james', { body: 'Continue.', clientNonce: 'fuse-reset' });
    expect(reset.ok).toBe(true);
    expect(store.getRoomState()).toEqual(expect.objectContaining({
      consecutiveAgentPosts: 0,
      activationFused: false,
    }));
    expect(reset.activations.every((item) => item.status === 'queued')).toBe(true);
  });

  test('cancels a preclaimed activation at post six and rejects late delivery and post seven', async () => {
    postAs('james', { body: 'Race root.', clientNonce: 'race-root' });
    const firstFive = ['architect', 'oracle', 'architect', 'oracle', 'architect'];
    const distinctBodies = [
      'Voltage rail sampled at 12.08V.',
      'Attachment digest begins aa9978.',
      'Listener accepted the IPv4 probe.',
      'Viewport retained the upload control.',
      'Database sequence advanced to 905.',
    ];
    for (let index = 0; index < firstFive.length; index += 1) {
      const memberId = firstFive[index];
      const delivery = deliverActivation(memberId);
      const posted = postAs(memberId, {
        body: distinctBodies[index],
        clientNonce: `race-${index + 1}`,
        replyToMessageId: delivery.message.messageId,
        causalActivationId: delivery.activation.activationId,
        participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
        rootReentry: index >= 2,
      });
      expect(posted.ok).toBe(true);
    }
    expect(store.getRoomState().consecutiveAgentPosts).toBe(5);

    const preclaimed = store.claimActivationBatch('builder', { limit: 1 }).activations[0];
    expect(preclaimed.activation.status).toBe('claimed');
    const sixthDelivery = deliverActivation('oracle');
    const sixth = postAs('oracle', {
      body: 'The sixth independent check decoded the QR payload.',
      clientNonce: 'race-6',
      replyToMessageId: sixthDelivery.message.messageId,
      causalActivationId: sixthDelivery.activation.activationId,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      rootReentry: true,
    });
    expect(sixth.ok).toBe(true);
    expect(store.getRoomState()).toEqual(expect.objectContaining({
      consecutiveAgentPosts: 6,
      activationFused: true,
    }));
    expect(store.getActivation(preclaimed.activation.activationId).status).toBe('suppressed_fuse');
    expect(store.isActivationDeliverable(preclaimed.activation.activationId))
      .toEqual(expect.objectContaining({ ok: false, reason: 'room_activation_fused' }));
    expect(store.markActivationDelivered(preclaimed.activation.activationId))
      .toEqual(expect.objectContaining({ ok: false, reason: 'room_activation_fused' }));

    let lateDeliveries = 0;
    const adapter = new TeamRoomDeliveryAdapter({
      store,
      deliverToPane: async () => {
        lateDeliveries += 1;
        return { ok: true };
      },
    });
    expect(await adapter.dispatchSafeBoundary('builder')).toEqual(expect.objectContaining({
      ok: true,
      fused: true,
      delivered: [],
    }));
    expect(lateDeliveries).toBe(0);

    const seventh = postAs('builder', {
      body: 'This must not become post seven.',
      clientNonce: 'race-7',
      replyToMessageId: preclaimed.message.messageId,
      causalActivationId: preclaimed.activation.activationId,
      participationReason: PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION,
      rootReentry: true,
    });
    expect(seventh).toEqual(expect.objectContaining({ ok: false, reason: 'room_activation_fused' }));
    expect(store.listMessages()).toHaveLength(7);
    expect(store.listMessages().some((message) => message.clientNonce === 'race-7')).toBe(false);

    const reset = postAs('james', { body: 'Fresh work only.', clientNonce: 'race-reset' });
    expect(reset.ok).toBe(true);
    expect(store.getRoomState()).toEqual(expect.objectContaining({
      consecutiveAgentPosts: 0,
      activationFused: false,
    }));
    expect(store.getActivation(preclaimed.activation.activationId).status).toBe('suppressed_fuse');
    expect(reset.activations.every((activation) => activation.status === 'queued')).toBe(true);
  });

  test('retries only failed activations and never duplicates message-target pairs', async () => {
    const posted = postAs('james', { body: 'Retry seam.', clientNonce: 'retry-1' });
    expect(store.ensureMissingActivations(posted.message.messageId)).toEqual(expect.objectContaining({ inserted: 0 }));
    let calls = 0;
    const adapter = new TeamRoomDeliveryAdapter({
      store,
      deliverToPane: async () => {
        calls += 1;
        return calls === 1 ? { ok: false, reason: 'pane_busy' } : { ok: true };
      },
    });
    const failed = await adapter.dispatchSafeBoundary('builder');
    expect(failed.ok).toBe(false);
    const activationId = failed.failed[0].activationId;
    expect(store.getActivation(activationId).status).toBe('failed');
    expect(store.requeueFailedActivation(activationId).ok).toBe(true);
    const delivered = await adapter.dispatchSafeBoundary('builder');
    expect(delivered.ok).toBe(true);
    expect(delivered.delivered).toEqual([activationId]);
    expect(store.listActivations(posted.message.messageId).filter((item) => item.targetMemberId === 'builder')).toHaveLength(1);
  });

  test('delivers a busy pane batch in persisted message order', async () => {
    const first = postAs('james', { body: 'First.', clientNonce: 'ordered-1' });
    const second = postAs('james', { body: 'Second.', clientNonce: 'ordered-2' });
    const seen = [];
    const adapter = new TeamRoomDeliveryAdapter({
      store,
      deliverToPane: async ({ message }) => {
        seen.push(message.messageId);
        return { ok: true };
      },
    });
    const result = await adapter.dispatchSafeBoundary('builder', { limit: 2 });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([first.message.messageId, second.message.messageId]);
  });

  test('recovers a stale claimed activation without creating a second activation row', () => {
    const posted = postAs('james', { body: 'Crash lease.', clientNonce: 'stale-1' });
    const claimed = store.claimActivationBatch('builder', { limit: 1 });
    const activationId = claimed.activations[0].activation.activationId;
    nowMs += 10_000;
    expect(store.recoverStaleClaims({ olderThanMs: 1_000 })).toEqual(expect.objectContaining({
      ok: true,
      found: 1,
      requeued: 1,
      fused: false,
    }));
    const reclaimed = store.claimActivationBatch('builder', { limit: 1 });
    expect(reclaimed.activations[0].activation.activationId).toBe(activationId);
    expect(store.listActivations(posted.message.messageId).filter((item) => item.targetMemberId === 'builder')).toHaveLength(1);
  });

  test('fails closed on DB-file split and quarantines a changed attachment', () => {
    const filePath = path.join(tempDir, 'media', 'photo.png');
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    const registered = store.registerReadyAttachment({ filePath, claimedMime: 'image/png' });
    expect(registered.ok).toBe(true);
    const claim = store.createAttachmentClaim(registered.attachment.attachmentId, {
      roomId: 'main', profileName: 'main',
    });
    expect(claim.ok).toBe(true);
    fs.appendFileSync(filePath, Buffer.from('tampered'));
    const posted = postAs('james', {
      body: 'Look.',
      clientNonce: 'attachment-split',
      attachmentIds: [claim.attachment.attachmentId],
    });
    expect(posted).toEqual(expect.objectContaining({
      ok: false,
      reason: 'room_attachment_integrity_failed',
      details: 'attachment_byte_count_mismatch',
    }));
    expect(store.getAttachment(registered.attachment.attachmentId).status).toBe('quarantined');
    expect(store.listMessages()).toHaveLength(0);
  });

  test('revalidates file integrity on authenticated media reads', () => {
    const filePath = path.join(tempDir, 'media', 'served.png');
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    const registered = store.registerReadyAttachment({ filePath, claimedMime: 'image/png' });
    const claim = store.createAttachmentClaim(registered.attachment.attachmentId, {
      roomId: 'main', profileName: 'main',
    });
    expect(claim.ok).toBe(true);
    const request = {
      authorization: `Bearer ${credentials.james.token}`,
      source: 'room_web',
      roomId: 'main',
      profileName: 'main',
      attachmentId: claim.attachment.attachmentId,
    };
    expect(service.authorizeMedia(request)).toEqual(expect.objectContaining({ ok: true }));
    fs.appendFileSync(filePath, Buffer.from('tampered'));
    expect(service.authorizeMedia(request)).toEqual(expect.objectContaining({
      ok: false,
      reason: 'room_attachment_integrity_failed',
    }));
  });

  test('rejects sensitive, cyclic, oversized, and non-plain attachment metadata before persistence', () => {
    const filePath = path.join(tempDir, 'media', 'metadata.png');
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    const cyclic = {};
    cyclic.self = cyclic;
    const cases = [
      [{ apiKey: 'should-not-persist', nested: { password: 'also-no' } }, 'room_sensitive_metadata_forbidden'],
      [cyclic, 'room_message_metadata_cycle'],
      [{ caption: 'x'.repeat(70 * 1024) }, 'room_message_metadata_too_large'],
      [new Date('2026-08-19T00:00:00Z'), 'room_message_metadata_object_invalid'],
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const [metadata, reason] = cases[index];
      expect(store.registerReadyAttachment({
        attachmentId: `metadata-invalid-${index}`,
        filePath,
        claimedMime: 'image/png',
        metadata,
      })).toEqual(expect.objectContaining({ ok: false, reason }));
    }
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM room_attachments').get().count).toBe(0);

    const valid = store.registerReadyAttachment({
      attachmentId: 'metadata-valid',
      filePath,
      claimedMime: 'image/png',
      metadata: { caption: 'deliberate room photo', dimensionsVerified: true },
    });
    expect(valid.ok).toBe(true);
    expect(valid.attachment.metadata).toEqual({ caption: 'deliberate room photo', dimensionsVerified: true });
  });

  test('enforces append-only message rows and activation identity in SQLite itself', () => {
    const posted = postAs('james', { body: 'Immutable.', clientNonce: 'immutable-1' });
    expect(() => store.db.prepare('UPDATE room_messages SET body = ? WHERE message_id = ?')
      .run('rewritten', posted.message.messageId)).toThrow(/room_messages_append_only/u);
    const activation = posted.activations[0];
    expect(() => store.db.prepare('UPDATE room_activations SET target_member_id = ? WHERE activation_id = ?')
      .run('james', activation.activationId)).toThrow(/room_activation_identity_immutable/u);
    expect(() => store.db.prepare('UPDATE room_activations SET status = ? WHERE activation_id = ?')
      .run('delivered', activation.activationId)).toThrow(/room_activation_transition_invalid/u);
  });

  test('requires auth on reads and media, honors revocation, and defaults to loopback-only networking', () => {
    expect(service.readMessages({ source: 'room_web' })).toEqual(expect.objectContaining({ ok: false, reason: 'room_bearer_required' }));
    expect(service.authorizeMedia({ source: 'room_web', attachmentId: 'missing' }))
      .toEqual(expect.objectContaining({ ok: false, reason: 'room_bearer_required' }));
    expect(safeNetworkPolicy()).toEqual(expect.objectContaining({ ok: true, policy: expect.objectContaining({ bindHost: '127.0.0.1' }) }));
    expect(safeNetworkPolicy({ bindHost: '0.0.0.0' })).toEqual(expect.objectContaining({ ok: false, reason: 'room_loopback_policy_required' }));
    expect(safeNetworkPolicy({ lanEnabled: true, bindHost: '192.168.1.20', allowedOrigins: ['*'] }))
      .toEqual(expect.objectContaining({ ok: false, reason: 'room_wildcard_origin_forbidden' }));
    expect(safeNetworkPolicy({ lanEnabled: true, bindHost: '8.8.8.8', allowedOrigins: ['http://8.8.8.8:9910'] }))
      .toEqual(expect.objectContaining({ ok: false, reason: 'room_lan_private_bind_required' }));
    expect(isPrivateLanHostname('10.attacker.example')).toBe(false);
    expect(isPrivateLanHostname('192.168.attacker.example')).toBe(false);
    expect(parsePrivateNetworkOrigin('http://10.attacker.example:9910'))
      .toEqual({ ok: false, reason: 'room_origin_not_lan_private' });
    expect(safeNetworkPolicy({
      lanEnabled: true,
      bindHost: '10.attacker.example',
      allowedOrigins: ['http://10.attacker.example:9910'],
    })).toEqual(expect.objectContaining({ ok: false, reason: 'room_lan_private_bind_required' }));
    expect(safeNetworkPolicy({
      lanEnabled: true,
      bindHost: '192.168.1.20',
      allowedOrigins: ['http://192.168.attacker.example:9910'],
    })).toEqual(expect.objectContaining({ ok: false, reason: 'room_origin_not_lan_private' }));
    expect(safeNetworkPolicy({
      lanEnabled: true,
      bindHost: '192.168.1.20',
      allowedOrigins: ['http://192.168.1.20:9910'],
    })).toEqual(expect.objectContaining({ ok: true }));
    expect(auth.issueCredential({
      registrationToken: 'client-claim',
      registrationAuthority: 'runtime_registry',
      identity: memberIdentity('builder'),
    })).toEqual(expect.objectContaining({ ok: false, reason: 'trusted_registration_invalid' }));

    expect(store.revokeAuthCredential(credentials.james.credential.credentialId).ok).toBe(true);
    expect(postAs('james', { body: 'revoked', clientNonce: 'revoked-1' }))
      .toEqual(expect.objectContaining({ ok: false, reason: 'room_credential_revoked' }));
  });

  test('uses exact IP parsing for all private-network positive and adversarial origin shapes', () => {
    for (const host of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.20',
      '169.254.10.20', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    ]) {
      expect(isPrivateLanHostname(host)).toBe(true);
    }
    for (const host of [
      '0.0.0.0', '8.8.8.8', '172.15.255.255', '172.32.0.1', '169.253.1.1',
      '192.168.1.999', '10.0.0.1.2', '10.attacker.example', '192.168.attacker.example',
      '::', '2001:4860:4860::8888', 'fd00:::1',
    ]) {
      expect(isPrivateLanHostname(host)).toBe(false);
    }
    for (const origin of [
      'http://user:pass@192.168.1.20:9910',
      'http://192.168.1.20:9910/room',
      'http://192.168.1.20:9910/?next=room',
      'http://192.168.1.20:9910/#room',
      'http://192.168.1.20.evil:9910',
      'http://8.8.8.8:9910',
      'http://[2001:4860:4860::8888]:9910',
      'http://[fd00:::1]:9910',
      'http://127.1:9910',
      'http://0177.0.0.1:9910',
      'http://0x7f000001:9910',
      'http://2130706433:9910',
    ]) {
      expect(parsePrivateNetworkOrigin(origin)).toEqual(expect.objectContaining({ ok: false }));
    }
    for (const origin of [
      'http://127.0.0.1:9910',
      'http://192.168.1.20:9910',
      'http://[::1]:9910',
      'http://[fd12:3456::1]:9910',
      'http://[fe80::1]:9910',
    ]) {
      expect(parsePrivateNetworkOrigin(origin)).toEqual(expect.objectContaining({ ok: true }));
    }
  });
});
