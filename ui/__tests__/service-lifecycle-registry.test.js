const {
  buildServiceLifecycleSummary,
  findServiceLifecycle,
} = require('../modules/service-lifecycle-registry');

describe('service-lifecycle-registry', () => {
  test('describes restart boundaries without implying terminal impact for service-only restarts', () => {
    const summary = buildServiceLifecycleSummary({
      nowMs: 1777890000000,
      statusById: {
        'voice-broker': { state: 'running' },
        renderer: { state: 'ready' },
      },
    });

    expect(summary).toEqual(expect.objectContaining({
      ok: true,
      generatedAtMs: 1777890000000,
    }));
    expect(summary.services).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'renderer',
        restartAction: 'reload-renderers',
        requiresMainRestart: false,
        affectsTerminals: false,
        status: { state: 'ready' },
      }),
      expect.objectContaining({
        id: 'voice-broker',
        restartAction: 'voice-broker:restart',
        requiresMainRestart: false,
        affectsTerminals: false,
        status: { state: 'running' },
      }),
      expect.objectContaining({
        id: 'terminal-daemon',
        affectsTerminals: true,
        safeRestart: false,
      }),
    ]));
    expect(summary.totals.terminalImpactCount).toBe(1);
    expect(summary.totals.mainRestartCount).toBe(1);
  });

  test('finds a single lifecycle definition by id', () => {
    expect(findServiceLifecycle('telegram-poller')).toEqual(expect.objectContaining({
      label: 'Telegram poller',
      restartAction: 'restart-telegram-poller',
      affectsTerminals: false,
    }));
    expect(findServiceLifecycle('missing')).toBeNull();
  });

  test('defines Telegram poller restart as service-only and pane-safe', () => {
    expect(findServiceLifecycle('telegram-poller')).toEqual(expect.objectContaining({
      label: 'Telegram poller',
      restartAction: 'restart-telegram-poller',
      requiresMainRestart: false,
      affectsTerminals: false,
      safeRestart: true,
      userImpact: 'Restarts remote message intake without touching panes.',
    }));
  });
});
