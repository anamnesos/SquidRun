'use strict';

const {
  analyzeColdSpawnOutput,
  createColdSpawnBlankRecoveryController,
  outputLooksLikeClearScreenStorm,
} = require('../modules/terminal/cold-spawn-blank-recovery');

function clearStorm(repetitions = 12) {
  return Array.from(
    { length: repetitions },
    (_, index) => `\u001b[H\u001b[${(index % 20) + 1};1H\u001b[K`
  ).join('');
}

describe('Codex cold-spawn blank recovery', () => {
  let clock;
  let surface;
  let inputBlockReason;
  let sendRecovery;
  let events;
  let controller;

  const config = {
    startupGraceMs: 1_000,
    maxColdSpawnAgeMs: 10_000,
    sampleIntervalMs: 100,
    blankSustainMs: 500,
    confirmSamples: 2,
    recentOutputMs: 1_000,
    outcomeTimeoutMs: 1_000,
    minRawBytes: 32,
    minEraseOps: 2,
    minCursorOps: 2,
    minClearOpsPerKb: 0,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    clock = 0;
    surface = {
      ready: true,
      reason: 'ready',
      visibleText: '',
      visibleChars: 0,
      cols: 100,
      rows: 24,
      width: 800,
      height: 500,
    };
    inputBlockReason = null;
    sendRecovery = jest.fn(async () => true);
    events = [];
    controller = createColdSpawnBlankRecoveryController({
      config,
      now: () => clock,
      sampleSurface: () => surface,
      isCodexPane: () => true,
      getInputBlockReason: () => inputBlockReason,
      sendRecovery,
      onEvent: (event) => events.push(event),
    });
  });

  afterEach(() => {
    for (const paneId of Array.from(controller.states.keys())) {
      controller.dispose(paneId);
    }
    jest.useRealTimers();
  });

  test('classifies the deterministic missed-full-frame clear-screen tail', () => {
    const analysis = analyzeColdSpawnOutput(clearStorm());

    expect(analysis).toEqual(expect.objectContaining({
      eraseLineOps: 12,
      cursorOps: 24,
    }));
    expect(outputLooksLikeClearScreenStorm(analysis, {
      ...config,
      minRawBytes: 1,
    })).toBe(true);
  });

  test('sends one existing Enter nudge after sustained live clear churn on a renderer-confirmed blank frame', async () => {
    controller.arm('2', { source: 'fresh-create', startedAtMs: 0 });

    clock = 1_000;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');

    clock = 1_600;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');

    expect(sendRecovery).toHaveBeenCalledTimes(1);
    expect(sendRecovery).toHaveBeenCalledWith('2', expect.objectContaining({
      reason: 'alive_blank_cold_spawn',
    }));
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining(['detected', 'action'])
    );
    expect(events.find((event) => event.phase === 'action')).toEqual(
      expect.objectContaining({
        method: 'nudgePane_enter',
        maxAttempts: 1,
      })
    );

    surface = {
      ...surface,
      visibleText: '› Implement {feature}',
      visibleChars: 20,
    };
    clock = 1_800;
    controller.observeOutput('2', '\r\n› Implement {feature}');
    await controller.evaluate('2');

    expect(events.find((event) => event.phase === 'outcome')).toEqual(
      expect.objectContaining({ status: 'recovered' })
    );
  });

  test('does not trigger for a dead PTY even when its last tail was clear-screen churn', async () => {
    controller.arm('2', { source: 'fresh-create', startedAtMs: 0 });
    clock = 1_000;
    controller.observeOutput('2', clearStorm());
    controller.markPtyExited('2');
    clock = 2_000;

    await controller.evaluate('2');

    expect(sendRecovery).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      phase: 'held',
      reason: 'dead_pty',
    }));
  });

  test('does not trigger while a normal busy Codex frame remains visible', async () => {
    controller.arm('2', { source: 'fresh-create', startedAtMs: 0 });
    surface = {
      ...surface,
      visibleText: '• Working (27s · esc to interrupt)',
      visibleChars: 30,
    };

    clock = 1_000;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');
    clock = 2_000;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');

    expect(sendRecovery).not.toHaveBeenCalled();
    expect(events.some((event) => event.phase === 'action')).toBe(false);
  });

  test('does not trigger when the renderer or terminal container cannot be measured', async () => {
    controller.arm('2', { source: 'fresh-create', startedAtMs: 0 });
    surface = {
      ready: false,
      reason: 'container_not_renderable',
      visibleText: '',
      visibleChars: 0,
    };

    clock = 1_000;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');
    clock = 2_000;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');

    expect(sendRecovery).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      phase: 'held',
      reason: 'container_not_renderable',
    }));
  });

  test('holds while a programmatic injection is active, then allows one action when it completes', async () => {
    controller.arm('2', { source: 'fresh-create', startedAtMs: 0 });
    inputBlockReason = 'injection_in_flight';

    clock = 1_000;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');
    clock = 1_600;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');

    expect(sendRecovery).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      phase: 'held',
      reason: 'injection_in_flight',
    }));

    inputBlockReason = null;
    clock = 1_700;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');
    clock = 1_800;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');

    expect(sendRecovery).toHaveBeenCalledTimes(1);
  });

  test('permanently disarms the current recovery generation after user terminal input', async () => {
    controller.arm('2', { source: 'fresh-create', startedAtMs: 0 });

    clock = 1_000;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');

    expect(controller.disarm('2', 'user_terminal_input', {
      inputKind: 'terminal_on_data',
      inputChars: 13,
    })).toBe(true);

    clock = 9_000;
    expect(controller.observeOutput('2', clearStorm())).toBe(false);
    await controller.evaluate('2');

    expect(sendRecovery).not.toHaveBeenCalled();
    expect(controller.getState('2')).toEqual(expect.objectContaining({
      finished: true,
      outcome: 'disarmed_user_input',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      phase: 'disarmed',
      reason: 'user_terminal_input',
      inputKind: 'terminal_on_data',
    }));
  });

  test('caps recovery at one Enter and logs an unverified timeout if the frame stays blank', async () => {
    controller.arm('2', { source: 'fresh-create', startedAtMs: 0 });

    clock = 1_000;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');
    clock = 1_600;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');

    clock = 2_700;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');
    clock = 4_000;
    controller.observeOutput('2', clearStorm());
    await controller.evaluate('2');

    expect(sendRecovery).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.phase === 'action')).toHaveLength(1);
    expect(events.find((event) => event.phase === 'outcome')).toEqual(
      expect.objectContaining({ status: 'unverified_timeout' })
    );
  });
});
