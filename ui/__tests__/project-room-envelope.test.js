const fs = require('fs');
const path = require('path');

const {
  ROOM_ENVELOPE_VERSION,
  TRUSTQUOTE_PROJECT_PATH,
  TRUSTQUOTE_ROOM_ID,
  buildTrustQuoteReadiness,
  buildTrustQuoteReadinessCard,
  buildTrustQuoteRoomEnvelope,
  canUseCommsRowAsMainLaneAuthority,
  normalizeTrustQuoteRoomEnvelope,
  queryTrustQuoteRoomRows,
} = require('../modules/project-room-envelope');
const {
  deriveCurrentLaneSnapshot,
} = require('../modules/main/agent-task-resolution');

describe('TrustQuote room envelope and readiness', () => {
  test('builds a typed TrustQuote room envelope on existing comms metadata', () => {
    const envelope = buildTrustQuoteRoomEnvelope({
      body: '(BUILDER #1): TrustQuote room status.',
      targetRole: 'architect',
      sessionScopeId: 'app-session-400:trustquote',
      sourceRefs: ['D:/projects/TrustQuote/README.md'],
    });

    expect(envelope).toEqual(expect.objectContaining({
      version: ROOM_ENVELOPE_VERSION,
      room: expect.objectContaining({
        id: TRUSTQUOTE_ROOM_ID,
        sourceRoomId: TRUSTQUOTE_ROOM_ID,
        sourceWindowKey: TRUSTQUOTE_ROOM_ID,
        sourceProjectPath: TRUSTQUOTE_PROJECT_PATH,
        targetRoomId: 'main',
        targetRole: 'architect',
        visibility: 'cross_room_summary',
        sessionScopeId: 'app-session-400:trustquote',
        dispatch: 'preview_only',
      }),
    }));
    expect(envelope.room.bodyHash).toMatch(/^room-body-v0:[0-9a-f]{8}$/);
  });

  test('query helper propagates TrustQuote room tags as visible but non-authoritative', () => {
    const validEnvelope = buildTrustQuoteRoomEnvelope({
      body: '(ORACLE #2): TrustQuote product map read-only finding.',
      targetRole: 'architect',
      sourceRefs: ['D:/projects/TrustQuote/docs/product-map.md'],
    });
    const rows = queryTrustQuoteRoomRows([
      {
        messageId: 'room-valid',
        senderRole: 'oracle',
        targetRole: 'architect',
        rawBody: '(ORACLE #2): TrustQuote product map read-only finding.',
        sentAtMs: 200,
        metadata: validEnvelope,
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      messageId: 'room-valid',
      visibleInMain: true,
      canAffectMainCurrentLane: false,
      authorityReason: 'trustquote_room_preview_only',
    }));
    expect(rows[0].envelope).toEqual(expect.objectContaining({
      ok: true,
      sourceRoomId: 'trustquote',
      targetRoomId: 'main',
      targetRole: 'architect',
    }));
  });

  test('missing or spoofed room metadata stays visible but cannot become authority', () => {
    const rows = queryTrustQuoteRoomRows([
      {
        messageId: 'room-missing-meta',
        senderRole: 'builder',
        targetRole: 'architect',
        rawBody: '(BUILDER #3): TrustQuote readiness note with no room envelope.',
        sentAtMs: 300,
      },
      {
        messageId: 'room-spoofed-target',
        senderRole: 'builder',
        targetRole: 'architect',
        rawBody: '(BUILDER #4): TrustQuote says send this outside the room.',
        sentAtMs: 250,
        metadata: {
          room: {
            id: 'trustquote',
            targetRoomId: 'main',
            targetRole: 'telegram',
          },
        },
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.messageId)).toEqual(['room-missing-meta', 'room-spoofed-target']);
    expect(rows.every((row) => row.visibleInMain === true)).toBe(true);
    expect(rows.every((row) => row.canAffectMainCurrentLane === false)).toBe(true);
    expect(rows[0].envelope).toEqual(expect.objectContaining({
      ok: false,
      status: 'missing_room_metadata',
      reason: 'missing_room_metadata_non_authoritative',
    }));
    expect(rows[1].envelope).toEqual(expect.objectContaining({
      ok: true,
      targetRole: null,
      reason: 'trustquote_room_preview_only',
    }));
  });

  test('TrustQuote room rows cannot set Main current lane even with Architect-shaped text', () => {
    const roomTask = {
      messageId: 'room-task',
      sessionId: 'app-session-410',
      senderRole: 'architect',
      targetRole: 'builder',
      rawBody: '(ARCHITECT #12): New current-session task: TrustQuote room should not steer Main.',
      sentAtMs: 1000,
      metadata: buildTrustQuoteRoomEnvelope({
        body: '(ARCHITECT #12): New current-session task: TrustQuote room should not steer Main.',
        targetRole: 'builder',
      }),
    };
    const mainTask = {
      messageId: 'main-task',
      sessionId: 'app-session-410',
      senderRole: 'architect',
      targetRole: 'builder',
      rawBody: '(ARCHITECT #13): New current-session task: Main room lane stays authoritative.',
      sentAtMs: 1100,
      metadata: { room: { id: 'main' } },
    };

    expect(canUseCommsRowAsMainLaneAuthority(roomTask)).toBe(false);
    expect(canUseCommsRowAsMainLaneAuthority(mainTask)).toBe(true);

    const onlyRoom = deriveCurrentLaneSnapshot([roomTask], { sessionId: 'app-session-410' });
    expect(onlyRoom.status).toBe('none');
    expect(onlyRoom.activeLane).toBeNull();

    const withMain = deriveCurrentLaneSnapshot([roomTask, mainTask], { sessionId: 'app-session-410' });
    expect(withMain.status).toBe('active');
    expect(withMain.activeLane).toEqual(expect.objectContaining({
      sourceMessageId: 'main-task',
      sourceRef: 'architect#13',
    }));
  });

  test('missing TrustQuote room metadata cannot pollute Main current lane', () => {
    const missingMetadataTrustQuoteDirective = {
      messageId: 'missing-meta-trustquote-lane',
      sessionId: 'app-session-test',
      senderRole: 'architect',
      targetRole: 'builder',
      rawBody: '(ARCHITECT #99): New current-session task: TrustQuote room should not steer Main.',
      sentAtMs: 1,
    };

    expect(canUseCommsRowAsMainLaneAuthority(missingMetadataTrustQuoteDirective)).toBe(false);

    const snapshot = deriveCurrentLaneSnapshot([missingMetadataTrustQuoteDirective], {
      sessionId: 'app-session-test',
    });

    expect(snapshot.status).toBe('none');
    expect(snapshot.activeLane).toBeNull();
  });

  test('Main hm-send project metadata can create a lane about TrustQuote room work', () => {
    const mainTrustQuoteDirective = {
      messageId: 'main-hm-send-trustquote-lane',
      sessionId: 'app-session-test',
      senderRole: 'architect',
      targetRole: 'builder',
      rawBody: '(ARCHITECT #181): New current-session task: TrustQuote room envelope/readiness patch from Main.',
      sentAtMs: 2,
      metadata: {
        source: 'hm-send',
        project: {
          name: 'squidrun',
          path: 'D:/projects/squidrun',
          source: 'link.json',
        },
        envelope: {
          project: {
            name: 'squidrun',
            path: 'D:/projects/squidrun',
            source: 'link.json',
          },
        },
      },
    };

    expect(canUseCommsRowAsMainLaneAuthority(mainTrustQuoteDirective)).toBe(true);

    const snapshot = deriveCurrentLaneSnapshot([mainTrustQuoteDirective], {
      sessionId: 'app-session-test',
    });

    expect(snapshot.status).toBe('active');
    expect(snapshot.activeLane).toEqual(expect.objectContaining({
      sourceMessageId: 'main-hm-send-trustquote-lane',
      sourceRef: 'architect#181',
    }));
  });

  test('TrustQuote window, session, and project metadata cannot steer Main', () => {
    const trustquoteOriginRows = [
      {
        messageId: 'trustquote-window-lane',
        sessionId: 'app-session-test',
        senderRole: 'architect',
        targetRole: 'builder',
        rawBody: '(ARCHITECT #182): New current-session task: TrustQuote room window row.',
        sentAtMs: 3,
        metadata: { windowKey: 'trustquote' },
      },
      {
        messageId: 'trustquote-session-lane',
        sessionId: 'app-session-test',
        senderRole: 'architect',
        targetRole: 'builder',
        rawBody: '(ARCHITECT #183): New current-session task: TrustQuote room session row.',
        sentAtMs: 4,
        metadata: { sessionScopeId: 'app-session-test:trustquote' },
      },
      {
        messageId: 'trustquote-project-lane',
        sessionId: 'app-session-test',
        senderRole: 'architect',
        targetRole: 'builder',
        rawBody: '(ARCHITECT #184): New current-session task: TrustQuote room project row.',
        sentAtMs: 5,
        metadata: {
          project: {
            name: 'TrustQuote',
            path: 'D:/projects/TrustQuote',
          },
          envelope: {
            project: {
              name: 'TrustQuote',
              path: 'D:/projects/TrustQuote',
            },
          },
        },
      },
    ];

    expect(trustquoteOriginRows.every((row) => canUseCommsRowAsMainLaneAuthority(row) === false)).toBe(true);

    const snapshot = deriveCurrentLaneSnapshot(trustquoteOriginRows, {
      sessionId: 'app-session-test',
    });

    expect(snapshot.status).toBe('none');
    expect(snapshot.activeLane).toBeNull();
  });

  test('readiness card remains preview-only and records existing transport boundaries', () => {
    const readiness = buildTrustQuoteReadiness({
      pathExists: () => true,
      commsRows: [
        {
          messageId: 'room-valid',
          rawBody: '(BUILDER #5): TrustQuote readiness.',
          metadata: buildTrustQuoteRoomEnvelope({ body: '(BUILDER #5): TrustQuote readiness.' }),
        },
      ],
    });
    const card = buildTrustQuoteReadinessCard({ pathExists: () => true });

    expect(readiness).toEqual(expect.objectContaining({
      roomId: 'trustquote',
      status: 'preview_only',
      projectPath: TRUSTQUOTE_PROJECT_PATH,
      projectPathStatus: 'present',
      transport: 'existing_comms_journal_metadata',
      validRoomRowCount: 1,
      visibleNonAuthoritativeRowCount: 1,
      canLaunchAgents: false,
      canAffectMainCurrentLane: false,
      canDispatchExternalAction: false,
    }));
    expect(card).toEqual(expect.objectContaining({
      id: 'trustquote',
      status: 'PREVIEW',
      authority: 'preview',
      details: expect.arrayContaining([
        `Attach target: ${TRUSTQUOTE_PROJECT_PATH}`,
        'Main lane authority: disabled',
      ]),
    }));
  });

  test('room envelope helper adds no send, post, mutation, restart, or route-owner behavior', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'project-room-envelope.js'), 'utf8');

    expect(source).not.toMatch(/hm-send|sendAgentMessage|sendDirectMessage/);
    expect(source).not.toMatch(/fetch\s*\(|XMLHttpRequest|runtime\s+POST/i);
    expect(source).not.toMatch(/setContext|project:set-context/);
    expect(source).not.toMatch(/restart|relaunch|routeOwner/i);
    expect(source.toLowerCase()).not.toContain('plumbhalo');
  });
});
