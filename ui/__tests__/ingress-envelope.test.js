'use strict';

const {
  normalizeIngressEnvelope,
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
    const envelope = normalizeIngressEnvelope({
      source: 'telegram',
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
});
