'use strict';

const { buildConfidenceSurface } = require('../modules/confidence-surface');
const { buildServiceLifecycleRegistry } = require('../modules/service-lifecycle-registry');

describe('confidence-surface', () => {
  test('projects a ready owned-work action into one calm status line', () => {
    const surface = buildConfidenceSurface({
      presenceState: {
        mode: 'working',
        currentTopic: 'six-track architecture pass',
        activeChannel: 'voice',
      },
      continuePlan: {
        nextAction: {
          owner: 'builder',
          riskClass: 'safe',
          nextStep: 'add service lifecycle registry',
        },
        counts: { ready: 1 },
      },
      serviceRegistry: buildServiceLifecycleRegistry({
        statuses: {
          'voice-broker': { state: 'healthy' },
        },
      }),
    });

    expect(surface.priority).toBe('owned_work');
    expect(surface.ownedWork.label).toBe('Next: add service lifecycle registry');
    expect(surface.line).toContain('Working: six-track architecture pass');
    expect(surface.line).toContain('Services quiet');
  });

  test('surfaces degraded service state without implying terminal restart', () => {
    const surface = buildConfidenceSurface({
      presenceState: { mode: 'idle' },
      continuePlan: { counts: { held: 1 } },
      serviceRegistry: buildServiceLifecycleRegistry({
        statuses: {
          'telegram-poller': { state: 'degraded', detail: '409 conflict' },
        },
      }),
    });

    expect(surface.ok).toBe(false);
    expect(surface.priority).toBe('service');
    expect(surface.ownedWork.label).toBe('1 approval-held item');
    expect(surface.services.degradedServiceIds).toContain('telegram-poller');
  });
});
