'use strict';

const {
  buildPhoneClientConfig,
  createPhonePairingToken,
  renderPhoneVoiceClientPage,
} = require('../modules/phone-voice-client');

describe('phone-voice-client', () => {
  test('creates short-lived pairing tokens for phone voice sessions', () => {
    const token = createPhonePairingToken({
      nowMs: 1000,
      ttlMs: 5000,
      code: 123456,
      randomBytes: () => Buffer.from('abcdefghijklmnopqrstuvwx'),
    });

    expect(token).toEqual(expect.objectContaining({
      ok: true,
      token: expect.stringMatching(/^phone_/),
      code: '123456',
      createdAtMs: 1000,
      expiresAtMs: 6000,
      scope: {
        channel: 'phone-voice',
        target: 'architect',
      },
    }));
  });

  test('builds public phone config without exposing server API keys', () => {
    const config = buildPhoneClientConfig({
      status: {
        running: true,
        config: {
          model: 'gpt-realtime-1.5',
          voice: 'marin',
          transcriptionModel: 'gpt-4o-transcribe',
          openaiApiKeyPresent: true,
        },
      },
    });

    expect(config.status.openaiApiKeyPresent).toBe(true);
    expect(config).not.toHaveProperty('openaiApiKey');
    expect(JSON.stringify(config)).not.toContain('sk-');
    expect(config.safety).toMatchObject({
      routesTo: 'architect',
      directPaneWrites: false,
    });
  });

  test('renders a phone client shell with broker endpoints embedded', () => {
    const html = renderPhoneVoiceClientPage({
      status: {
        running: true,
        config: {
          model: 'gpt-realtime-1.5',
          voice: 'marin',
        },
      },
    });

    expect(html).toContain('Mira Voice');
    expect(html).toContain('/v1/voice/realtime/client-secret');
    expect(html).toContain('Hold to Talk');
    expect(html).toContain('SQUIDRUN_PHONE_VOICE');
    expect(html).toContain('RTCPeerConnection');
    expect(html).toContain('navigator.mediaDevices.getUserMedia');
    expect(html).toContain('phone-web-client');
  });
});
