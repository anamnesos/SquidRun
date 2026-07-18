'use strict';

const {
  ARM_LIVENESS_PING_SCHEMA,
  ARM_LIVENESS_PONG_MARKER,
  ARM_LIVENESS_PONG_SCHEMA,
  buildArmLivenessPrompt,
  probeArmLiveness,
  terminalMatchesSpawnSession,
} = require('../modules/main/arm-liveness-probe');

function activeSession(overrides = {}) {
  return {
    spawnSessionId: 'arm-spawn-session-1',
    durableAddress: 'arm://build-1a-qa/0123456789abcdef/trustquote-qa/dev-qa',
    spawnLeaseId: 'lease-1',
    appRoomId: 'trustquote-qa',
    armKey: 'dev-qa',
    paneId: 'trustquote-dev-qa',
    role: 'trustquote-dev-qa',
    sourceMessageId: 'ping-1',
    expectedResponseClass: 'arm.liveness.pong',
    status: 'active',
    ...overrides,
  };
}

function liveTerminal(session = activeSession()) {
  return {
    paneId: session.paneId,
    pid: 4321,
    alive: true,
    durableAddress: session.durableAddress,
    spawnLeaseId: session.spawnLeaseId,
  };
}

describe('arm journal round-trip liveness probe', () => {
  test('builds a blame-free exact receipt obligation for the spawned generation', () => {
    const prompt = buildArmLivenessPrompt(activeSession());

    expect(prompt).toEqual({
      ping: expect.objectContaining({
        schema: ARM_LIVENESS_PING_SCHEMA,
        sourceMessageId: 'ping-1',
        expectedResponseClass: 'arm.liveness.pong',
        durableAddress: activeSession().durableAddress,
        spawnLeaseId: 'lease-1',
        paneId: 'trustquote-dev-qa',
        replyMarker: ARM_LIVENESS_PONG_MARKER,
        replyReceipt: {
          schema: ARM_LIVENESS_PONG_SCHEMA,
          sourceMessageId: 'ping-1',
          responseClass: 'arm.liveness.pong',
          durableAddress: activeSession().durableAddress,
          spawnLeaseId: 'lease-1',
          paneId: 'trustquote-dev-qa',
        },
      }),
      replyBody: expect.stringContaining(ARM_LIVENESS_PONG_MARKER),
      text: expect.stringContaining('From this exact pane'),
    });
    expect(prompt.text).not.toMatch(/who.?failed/i);
  });

  test('requires the cached terminal to match address, lease, and pane', () => {
    const session = activeSession();
    expect(terminalMatchesSpawnSession(liveTerminal(session), session)).toBe(true);
    expect(terminalMatchesSpawnSession({
      ...liveTerminal(session),
      spawnLeaseId: 'lease-stale',
    }, session)).toBe(false);
    expect(terminalMatchesSpawnSession({
      ...liveTerminal(session),
      paneId: 'wrong-pane',
    }, session)).toBe(false);
  });

  test('does not write a ping when the current daemon generation is stale', async () => {
    const session = activeSession();
    const daemonClient = {
      getTerminal: jest.fn().mockReturnValue({
        ...liveTerminal(session),
        spawnLeaseId: 'lease-newer',
      }),
      writeAndWaitAck: jest.fn(),
    };

    const result = await probeArmLiveness({ session }, { daemonClient });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'rejected',
      reason: 'spawn_generation_not_live',
    }));
    expect(daemonClient.writeAndWaitAck).not.toHaveBeenCalled();
  });

  test('proves liveness only after its own-pane reply is accepted from comms journal', async () => {
    const session = activeSession();
    let nowMs = 1_000;
    let poll = 0;
    const daemonClient = {
      getTerminal: jest.fn().mockReturnValue(liveTerminal(session)),
      writeAndWaitAck: jest.fn().mockResolvedValue({
        success: true,
        status: 'accepted',
        requestEventId: 'write-1',
      }),
    };
    const noise = {
      rowId: 10,
      messageId: 'hm-noise',
      senderRole: 'trustquote-dev-qa',
      direction: 'outbound',
    };
    const pong = {
      rowId: 11,
      messageId: 'hm-pong',
      senderRole: 'trustquote-dev-qa',
      direction: 'outbound',
    };
    const queryJournal = jest.fn().mockImplementation(() => {
      poll += 1;
      return poll === 1 ? [noise] : [noise, pong];
    });
    const recordProof = jest.fn().mockImplementation((proof) => {
      if (proof.messageId === 'hm-noise') {
        return { ok: false, status: 'rejected', reason: 'liveness_source_message_mismatch' };
      }
      return {
        ok: true,
        status: 'proved',
        session: { ...session, livenessMessageId: 'hm-pong', livenessRowId: 11 },
      };
    });

    const result = await probeArmLiveness({
      session,
      proofTimeoutMs: 500,
      pollIntervalMs: 50,
    }, {
      daemonClient,
      queryJournal,
      recordProof,
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'proved',
      session: expect.objectContaining({ livenessMessageId: 'hm-pong' }),
      proof: expect.objectContaining({ ok: true, status: 'proved' }),
    }));
    expect(daemonClient.writeAndWaitAck).toHaveBeenCalledWith(
      'trustquote-dev-qa',
      expect.stringContaining(ARM_LIVENESS_PONG_MARKER),
      expect.objectContaining({
        correlationId: 'ping-1',
        source: 'arm-liveness-probe',
      }),
      { timeoutMs: 2000 }
    );
    expect(queryJournal).toHaveBeenCalledWith(expect.objectContaining({
      senderRole: 'trustquote-dev-qa',
      direction: 'outbound',
      sinceMs: 1_000,
    }));
    expect(recordProof).toHaveBeenCalledWith({
      durableAddress: session.durableAddress,
      spawnLeaseId: 'lease-1',
      messageId: 'hm-pong',
      commsRowId: 11,
    });
  });

  test('times out instead of treating a successful terminal write as aliveness', async () => {
    const session = activeSession();
    let nowMs = 1_000;
    const daemonClient = {
      getTerminal: jest.fn().mockReturnValue(liveTerminal(session)),
      writeAndWaitAck: jest.fn().mockResolvedValue({ success: true, status: 'accepted' }),
    };

    const result = await probeArmLiveness({
      session,
      proofTimeoutMs: 100,
      pollIntervalMs: 50,
    }, {
      daemonClient,
      queryJournal: () => [],
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'proof_timeout',
      reason: 'no_correlated_comms_reply_within_100ms',
    }));
  });
});
