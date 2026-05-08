'use strict';

const {
  normalizeIngressEnvelope,
  normalizeTelegramIngress,
  normalizeVoiceIngress,
  normalizeWakeIngress,
  summarizeIngressEnvelope,
} = require('../modules/ingress-envelope');

describe('ingress-envelope', () => {
  test('normalizes voice into the shared scoped envelope shape', () => {
    const envelope = normalizeIngressEnvelope({
      source: 'voice',
      transcript: 'please go through all six',
      profileName: 'main',
      windowKey: 'main',
      sessionId: '312',
      target: 'architect',
      timestampMs: 1000,
    });

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      source: 'voice',
      speaker: 'user',
      text: 'please go through all six',
      riskClass: 'caution',
      scope: {
        profileName: 'main',
        windowKey: 'main',
        sessionId: '312',
      },
      targetIntent: {
        target: 'architect',
        allowDirectPaneWrite: false,
      },
      routePolicy: {
        failClosed: true,
        requireSameProfile: true,
        requireFreshContext: true,
        allowMainFallback: false,
      },
    });
    expect(envelope.idempotencyKey).toMatch(/^ingress-/);
  });

  test('normalizes telegram customer work as approval required', () => {
    const envelope = normalizeTelegramIngress({
      message: 'send the invoice to Phil',
      profileName: 'main',
      windowKey: 'main',
      chatId: '123',
      timestampMs: 2000,
    });

    expect(envelope.riskClass).toBe('approval_required');
    expect(envelope.targetIntent.allowDirectPaneWrite).toBe(false);
    expect(summarizeIngressEnvelope(envelope)).toContain('telegram -> architect [main/main, approval_required]');
  });

  test('normalizes helper-specific voice and wake envelopes into the same contract', () => {
    const voice = normalizeVoiceIngress({
      text: 'Can we continue the six things?',
      scope: {
        profileName: 'main',
        windowKey: 'main',
        sessionId: '312',
      },
      receivedAtMs: 3000,
    });
    const wake = normalizeWakeIngress({
      agent: 'builder',
      nextStep: 'Run safe docs test',
      receivedAtMs: 3000,
    });

    expect(voice).toEqual(expect.objectContaining({
      source: 'voice',
      text: 'Can we continue the six things?',
      targetIntent: expect.objectContaining({
        target: 'architect',
        allowDirectPaneWrite: false,
      }),
    }));
    expect(wake).toEqual(expect.objectContaining({
      source: 'wake',
      riskClass: 'safe',
      targetIntent: expect.objectContaining({
        target: 'builder',
      }),
    }));
  });
});
