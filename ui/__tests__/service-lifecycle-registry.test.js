'use strict';

const {
  buildServiceLifecycleRegistry,
  chooseMinimalRestartAction,
  summarizeServiceLifecycle,
} = require('../modules/service-lifecycle-registry');

describe('service-lifecycle-registry', () => {
  test('defines independent restart boundaries without terminal impact by default', () => {
    const registry = buildServiceLifecycleRegistry({
      statuses: {
        'voice-broker': { state: 'healthy', detail: 'port 57208', lastCheckedAtMs: 1000 },
        'telegram-poller': { state: 'degraded', detail: '409 conflict', lastCheckedAtMs: 900 },
      },
    });

    const voice = registry.find((service) => service.id === 'voice-broker');
    const telegram = registry.find((service) => service.id === 'telegram-poller');

    expect(voice).toMatchObject({
      restartAction: 'hm-voice-broker restart',
      requiresMainRestart: false,
      affectsTerminals: false,
      state: 'healthy',
    });
    expect(telegram.state).toBe('degraded');
  });

  test('summarizes terminal-sensitive and main-restart services', () => {
    const registry = buildServiceLifecycleRegistry({
      statuses: {
        'terminal-daemon': { state: 'healthy' },
        'main-ipc': { state: 'healthy' },
      },
    });
    const summary = summarizeServiceLifecycle(registry);

    expect(summary.terminalSensitive).toContain('terminal-daemon');
    expect(summary.mainRestartRequired).toContain('main-ipc');
    expect(summary.total).toBeGreaterThanOrEqual(8);
  });

  test('chooses the smallest named restart action for a service', () => {
    expect(chooseMinimalRestartAction('voice-broker')).toMatchObject({
      ok: true,
      restartAction: 'hm-voice-broker restart',
      requiresMainRestart: false,
      affectsTerminals: false,
    });
    expect(chooseMinimalRestartAction('missing')).toMatchObject({
      ok: false,
      reason: 'unknown_service',
    });
  });
});
