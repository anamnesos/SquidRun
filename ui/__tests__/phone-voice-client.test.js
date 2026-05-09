'use strict';

const {
  buildPhoneClientConfig,
  createPhonePairingToken,
  extractPhoneAuthToken,
  renderPhoneVoiceClientPage,
  validatePhonePairingToken,
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
          model: 'gpt-realtime-2',
          voice: 'marin',
          liveTranscriptionModel: 'gpt-realtime-whisper',
          transcriptionModel: 'gpt-4o-transcribe',
          openaiApiKeyPresent: true,
        },
      },
    });

    expect(config.status.openaiApiKeyPresent).toBe(true);
    expect(config).not.toHaveProperty('openaiApiKey');
    expect(JSON.stringify(config)).not.toContain('sk-');
    expect(config.status.model).toBe('gpt-realtime-2');
    expect(config.status.liveTranscriptionModel).toBe('gpt-realtime-whisper');
    expect(config.safety).toMatchObject({
      routesTo: 'architect',
      directPaneWrites: false,
    });
    expect(config.endpoints.clientSecret).toBe('/v1/voice/phone/realtime/client-secret');
  });

  test('renders a phone client shell with broker endpoints embedded', () => {
    const html = renderPhoneVoiceClientPage({
      status: {
        running: true,
        config: {
          model: 'gpt-realtime-2',
          voice: 'marin',
        },
      },
    });

    expect(html).toContain('Mira Voice');
    expect(html).toContain('/v1/voice/phone/realtime/client-secret');
    expect(html).toContain('Hold to Talk');
    expect(html).toContain('AI-generated voice audio');
    expect(html).toContain('SQUIDRUN_PHONE_VOICE');
    expect(html).toContain('RTCPeerConnection');
    expect(html).toContain('navigator.mediaDevices.getUserMedia');
    expect(html).toContain('gpt-realtime-whisper');
    expect(html).toContain('phone-web-client');
    expect(html).toContain('Missing phone pairing token');
  });

  test('renders a phone client shell wired to the voice lease lifecycle (register, acquire, heartbeat, spoken, release)', () => {
    const html = renderPhoneVoiceClientPage({
      status: { running: true, config: { model: 'gpt-realtime-2', voice: 'marin' } },
    });

    expect(html).toContain('/v1/voice/egress/lease/register');
    expect(html).toContain('/v1/voice/egress/lease/acquire');
    expect(html).toContain('/v1/voice/egress/lease/release');
    expect(html).toContain('/v1/voice/egress/spoken');

    expect(html).toContain("consumerKind: 'phone-client'");
    expect(html).toContain("'x-voice-registration-token'");
    expect(html).toContain('squidrun.voice.phoneConsumerId');

    expect(html).toContain('voiceHeartbeatTimer = setInterval');
    expect(html).toContain('acquireOrRenewPhoneVoiceLease');

    expect(html).toContain('postPhoneVoiceSpokenAck');
    expect(html).toContain("payloadType === 'response.audio.done'");
    expect(html).toContain("payloadType === 'response.output_audio.done'");

    expect(html).toContain('releasePhoneVoiceLease');
    expect(html).toContain('clearInterval(session.voiceHeartbeatTimer)');

    // FIFO queue for in-flight spoken acks (not a single slot that overwrites).
    expect(html).toContain('pendingSpokenMessageIds: []');
    expect(html).toContain('pendingSpokenMessageIds.push(message.messageId)');
    expect(html).toContain('pendingSpokenMessageIds.shift()');

    // Phone client must not impersonate desktop or use multiOutput.
    expect(html).not.toContain("consumerKind: 'desktop-tab'");
    expect(html).not.toContain('multiOutput=1');
    expect(html).not.toContain('multiOutputEnabled');
    expect(html).not.toContain('SQUIDRUN_VOICE_MULTI_OUTPUT_ENABLED');

    // Phone-client register MUST send the Bearer pairing token.
    expect(html).toContain("Authorization: 'Bearer ' + phoneToken");

    // Real user activity (Talk pointerdown) updates lastUserActivityAtMs; heartbeat alone must not.
    expect(html).toContain('session.lastUserActivityAtMs = Date.now()');
    expect(html).toMatch(/talkBtn\.addEventListener\('pointerdown'[\s\S]*?session\.lastUserActivityAtMs\s*=\s*Date\.now\(\)/);
    // The activity-update line must appear only inside the user-interaction handler — exactly once.
    const activityAssignmentMatches = html.match(/session\.lastUserActivityAtMs\s*=\s*Date\.now\(\)/g) || [];
    expect(activityAssignmentMatches).toHaveLength(1);
  });

  test('phone client config exposes lease/spoken endpoints alongside legacy ones', () => {
    const config = buildPhoneClientConfig({
      status: { running: true, config: { model: 'gpt-realtime-2', voice: 'marin' } },
    });
    expect(config.endpoints.leaseRegister).toBe('/v1/voice/egress/lease/register');
    expect(config.endpoints.leaseAcquire).toBe('/v1/voice/egress/lease/acquire');
    expect(config.endpoints.leaseRelease).toBe('/v1/voice/egress/lease/release');
    expect(config.endpoints.spoken).toBe('/v1/voice/egress/spoken');
    expect(config.endpoints.egress).toBe('/v1/voice/phone/egress');
  });

  test('falls back to the current Realtime 2 model in public status', () => {
    const config = buildPhoneClientConfig({
      status: {
        running: true,
        config: {},
      },
    });

    expect(config.status.model).toBe('gpt-realtime-2');
    expect(config.status.voice).toBe('marin');
    expect(config.status.liveTranscriptionModel).toBe('gpt-realtime-whisper');
    expect(config.status.transcriptionModel).toBe('gpt-4o-transcribe');
  });

  test('extracts and validates bearer pairing tokens', () => {
    expect(extractPhoneAuthToken({
      headers: { authorization: 'Bearer phone_abc' },
    })).toBe('phone_abc');

    expect(validatePhonePairingToken({
      ok: true,
      token: 'phone_abc',
      expiresAtMs: 2000,
    }, {
      headers: { authorization: 'Bearer phone_abc' },
    }, {
      nowMs: 1000,
    })).toEqual(expect.objectContaining({
      ok: true,
      token: 'phone_abc',
    }));

    expect(validatePhonePairingToken({
      ok: true,
      token: 'phone_abc',
      expiresAtMs: 2000,
    }, {
      headers: { authorization: 'Bearer phone_abc' },
    }, {
      nowMs: 3000,
    })).toEqual(expect.objectContaining({
      ok: false,
      reason: 'phone_pairing_token_expired',
    }));
  });
});
