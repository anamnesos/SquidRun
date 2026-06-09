'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildAlertDeliverySignals,
  buildProbeRequests,
  evaluateAgentPaneAutoRecovery,
  runAgentPaneAutoRecoveryCycle,
} = require('../modules/main/agent-pane-auto-recovery');

function paneSnapshot(paneId, overrides = {}) {
  return {
    schema: 'squidrun.terminal.restart_scrollback.v0',
    panes: {
      [paneId]: {
        paneId,
        createdAt: 1_000,
        lastActivity: 2_000,
        scrollbackSha256: 'hash-a',
        ...overrides,
      },
    },
  };
}

describe('agent pane auto recovery', () => {
  const paneSpecs = [{ paneId: '2', role: 'builder' }];
  const baseConfig = {
    bootGraceMs: 8 * 60 * 1000,
    deadConfirmCount: 2,
    deadSustainMs: 60 * 1000,
    deadProbeAfterMs: 60 * 1000,
    wedgedConfirmCount: 2,
    wedgedMinMs: 60 * 1000,
    restartCircuitMaxAttempts: 3,
    restartCircuitWindowMs: 30 * 60 * 1000,
  };

  test('holds agent_not_running during boot grace', () => {
    const nowMs = 1_000_000;
    const result = evaluateAgentPaneAutoRecovery({
      panes: {
        '2': {
          bootStartedAtMs: nowMs - (2 * 60 * 1000),
        },
      },
    }, {
      nowMs,
      paneSpecs,
      scrollbackSnapshot: paneSnapshot('2', { createdAt: nowMs - (2 * 60 * 1000) }),
      latestCommsByRole: {},
      deliverySignals: [
        {
          paneId: '2',
          role: 'builder',
          reason: 'agent_not_running',
          observedAtMs: nowMs,
        },
      ],
    }, baseConfig);

    expect(result.actions).toEqual([]);
    expect(result.panes['2']).toEqual(expect.objectContaining({
      booting: true,
      status: 'booting_dead_signal_held',
    }));
  });

  test('does not mark idle frozen output as wedged without in-flight directive evidence', () => {
    const nowMs = 2_000_000;
    const result = evaluateAgentPaneAutoRecovery({
      panes: {
        '2': {
          lastObservedAtMs: nowMs - (2 * 60 * 1000),
          lastScrollbackSha256: 'hash-a',
          lastScrollbackActivityMs: 2_000,
          frozenSinceMs: nowMs - (2 * 60 * 1000),
          frozenCount: 3,
        },
      },
    }, {
      nowMs,
      paneSpecs,
      scrollbackSnapshot: paneSnapshot('2'),
      latestCommsByRole: {},
      deliverySignals: [],
    }, baseConfig);

    expect(result.actions).toEqual([]);
    expect(result.panes['2']).toEqual(expect.objectContaining({
      activeInFlight: false,
    }));
  });

  test('confirms dead pane after repeated sustained agent_not_running evidence', () => {
    const nowMs = 3_000_000;
    const result = evaluateAgentPaneAutoRecovery({
      panes: {
        '2': {
          deadFirstAtMs: nowMs - (2 * 60 * 1000),
          deadCount: 1,
        },
      },
    }, {
      nowMs,
      paneSpecs,
      scrollbackSnapshot: paneSnapshot('2', { createdAt: nowMs - (20 * 60 * 1000) }),
      latestCommsByRole: {},
      deliverySignals: [
        {
          paneId: '2',
          role: 'builder',
          reason: 'agent_not_running',
          observedAtMs: nowMs,
        },
      ],
    }, baseConfig);

    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: 'restart',
        paneId: '2',
        reason: 'dead',
      }),
    ]);
  });

  test('confirms wedged only with frozen output and in-flight no-response evidence', () => {
    const nowMs = 4_000_000;
    const result = evaluateAgentPaneAutoRecovery({
      panes: {
        '2': {
          lastObservedAtMs: nowMs - (2 * 60 * 1000),
          lastScrollbackSha256: 'hash-a',
          lastScrollbackActivityMs: 2_000,
          frozenSinceMs: nowMs - (2 * 60 * 1000),
          frozenCount: 1,
        },
      },
    }, {
      nowMs,
      paneSpecs,
      scrollbackSnapshot: paneSnapshot('2', { createdAt: nowMs - (20 * 60 * 1000) }),
      latestCommsByRole: { builder: nowMs - (20 * 60 * 1000) },
      deliverySignals: [
        {
          paneId: '2',
          role: 'builder',
          reason: 'post_enter_output_timeout',
          source: 'pending-pane-deliveries',
          observedAtMs: nowMs - (2 * 60 * 1000),
        },
      ],
    }, baseConfig);

    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: 'restart',
        paneId: '2',
        reason: 'wedged',
      }),
    ]);
  });

  test('returns exhausted action instead of restart when circuit is spent', () => {
    const nowMs = 5_000_000;
    const result = evaluateAgentPaneAutoRecovery({
      panes: {
        '2': {
          deadFirstAtMs: nowMs - (2 * 60 * 1000),
          deadCount: 1,
          restartHistoryMs: [
            nowMs - (20 * 60 * 1000),
            nowMs - (10 * 60 * 1000),
            nowMs - (5 * 60 * 1000),
          ],
        },
      },
    }, {
      nowMs,
      paneSpecs,
      scrollbackSnapshot: paneSnapshot('2', { createdAt: nowMs - (20 * 60 * 1000) }),
      latestCommsByRole: {},
      deliverySignals: [
        {
          paneId: '2',
          role: 'builder',
          reason: 'agent_not_running',
          observedAtMs: nowMs,
        },
      ],
    }, baseConfig);

    expect(result.actions).toEqual([
      expect.objectContaining({
        kind: 'exhausted',
        paneId: '2',
        manualInterventionRequired: true,
      }),
    ]);
  });

  test('only probes panes with active no-response directive evidence', () => {
    const nowMs = 6_000_000;
    const requests = buildProbeRequests({
      panes: {
        '2': {
          lastProbeAtMs: 0,
        },
      },
    }, {
      nowMs,
      paneSpecs,
      scrollbackSnapshot: paneSnapshot('2', { createdAt: nowMs - (20 * 60 * 1000) }),
      latestCommsByRole: { builder: nowMs - (20 * 60 * 1000) },
      deliverySignals: [
        {
          paneId: '2',
          role: 'builder',
          reason: 'post_enter_output_timeout',
          observedAtMs: nowMs - (2 * 60 * 1000),
        },
      ],
    }, baseConfig);

    expect(requests).toEqual([
      expect.objectContaining({
        paneId: '2',
        reason: 'in_flight_no_response',
      }),
    ]);

    const idleRequests = buildProbeRequests({}, {
      nowMs,
      paneSpecs,
      scrollbackSnapshot: paneSnapshot('2', { createdAt: nowMs - (20 * 60 * 1000) }),
      latestCommsByRole: {},
      deliverySignals: [],
    }, baseConfig);
    expect(idleRequests).toEqual([]);
  });

  test('alert stdout creates delivery signals for accepted unverified sends', () => {
    const signals = buildAlertDeliverySignals({
      paneId: '3',
      role: 'oracle',
      alertResult: {
        results: [
          { stdout: 'Accepted by oracle but unverified: ack: accepted.unverified' },
        ],
      },
      nowMs: 7_000_000,
    });

    expect(signals).toEqual([
      expect.objectContaining({
        paneId: '3',
        role: 'oracle',
        reason: 'post_enter_output_timeout',
      }),
    ]);
  });

  test('run cycle sends loud notify on exhausted circuit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pane-auto-recovery-'));
    const statePath = path.join(tempDir, 'state.json');
    const eventsPath = path.join(tempDir, 'events.jsonl');
    const nowMs = 8_000_000;
    try {
      fs.writeFileSync(statePath, JSON.stringify({
        version: 1,
        panes: {
          '2': {
            paneId: '2',
            role: 'builder',
            deadFirstAtMs: nowMs - (2 * 60 * 1000),
            deadCount: 1,
            restartHistoryMs: [
              nowMs - (20 * 60 * 1000),
              nowMs - (10 * 60 * 1000),
              nowMs - (5 * 60 * 1000),
            ],
          },
        },
      }), 'utf8');
      const notifyArchitect = jest.fn(() => ({ ok: true }));
      const restartPane = jest.fn();
      const result = await runAgentPaneAutoRecoveryCycle({
        nowMs,
        statePath,
        eventsPath,
        paneSpecs,
        config: baseConfig,
        scrollbackSnapshot: paneSnapshot('2', { createdAt: nowMs - (20 * 60 * 1000) }),
        appStartedAtMs: nowMs - (20 * 60 * 1000),
        latestCommsByRole: {},
        deliverySignals: [
          {
            paneId: '2',
            role: 'builder',
            reason: 'agent_not_running',
            observedAtMs: nowMs,
          },
        ],
        restartPane,
        notifyArchitect,
        probePanes: false,
      });

      expect(result.actions[0]).toEqual(expect.objectContaining({ kind: 'exhausted' }));
      expect(restartPane).not.toHaveBeenCalled();
      expect(notifyArchitect).toHaveBeenCalledWith(
        expect.stringContaining('LOUD ESCALATION'),
        expect.any(Object)
      );
      expect(fs.readFileSync(eventsPath, 'utf8')).toContain('Manual intervention needed');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
