'use strict';

const crypto = require('crypto');

const DEFAULT_PHONE_PAIRING_TTL_MS = 10 * 60 * 1000;

function toNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function toPositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function createPhonePairingToken(options = {}) {
  const nowMs = toPositiveInt(options.nowMs, Date.now());
  const ttlMs = toPositiveInt(options.ttlMs, DEFAULT_PHONE_PAIRING_TTL_MS);
  const randomBytes = typeof options.randomBytes === 'function'
    ? options.randomBytes
    : crypto.randomBytes;
  const raw = randomBytes(24).toString('base64url');
  const code = String(toPositiveInt(options.code, crypto.randomInt(100000, 999999)));
  return {
    ok: true,
    token: `phone_${raw}`,
    code,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    ttlMs,
    scope: {
      channel: 'phone-voice',
      target: 'architect',
    },
  };
}

function sanitizePublicStatus(status = {}) {
  const config = status.config || {};
  return {
    running: Boolean(status.running),
    model: toNonEmptyString(config.model) || 'gpt-realtime-2',
    voice: toNonEmptyString(config.voice) || 'marin',
    liveTranscriptionModel: toNonEmptyString(config.liveTranscriptionModel) || 'gpt-realtime-whisper',
    transcriptionModel: toNonEmptyString(config.transcriptionModel) || 'gpt-4o-transcribe',
    vadPrefixPaddingMs: toPositiveInt(config.vadPrefixPaddingMs, 700),
    vadSilenceDurationMs: toPositiveInt(config.vadSilenceDurationMs, 2200),
    openaiApiKeyPresent: Boolean(config.openaiApiKeyPresent),
  };
}

function buildPhoneClientConfig(input = {}) {
  const basePath = toNonEmptyString(input.basePath) || '';
  return {
    ok: true,
    client: 'squidrun-phone-voice',
    title: 'Mira Phone Voice',
    status: sanitizePublicStatus(input.status || {}),
    endpoints: {
      status: `${basePath}/status`,
      clientSecret: `${basePath}/v1/voice/phone/realtime/client-secret`,
      transcripts: `${basePath}/v1/voice/phone/transcripts`,
      egress: `${basePath}/v1/voice/phone/egress`,
      diagnostics: `${basePath}/v1/voice/phone/diagnostics`,
      leaseRegister: `${basePath}/v1/voice/egress/lease/register`,
      leaseAcquire: `${basePath}/v1/voice/egress/lease/acquire`,
      leaseRelease: `${basePath}/v1/voice/egress/lease/release`,
      spoken: `${basePath}/v1/voice/egress/spoken`,
    },
    controls: {
      pushToTalk: true,
      mute: true,
      interrupt: true,
      pairingRequired: true,
    },
    safety: {
      routesTo: 'architect',
      directPaneWrites: false,
      approvalRequiredFor: ['customer', 'trading', 'money', 'auth', 'irreversible'],
    },
  };
}

function extractPhoneAuthToken(input = {}) {
  const headers = input.headers || {};
  const authorization = toNonEmptyString(headers.authorization || headers.Authorization);
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return toNonEmptyString(headers['x-squidrun-phone-token'])
    || toNonEmptyString(headers['X-SquidRun-Phone-Token'])
    || toNonEmptyString(input.token);
}

function validatePhonePairingToken(pairing = {}, input = {}, options = {}) {
  const token = extractPhoneAuthToken(input);
  if (!token) {
    return { ok: false, reason: 'phone_pairing_token_required' };
  }
  if (!pairing || pairing.ok !== true || !toNonEmptyString(pairing.token)) {
    return { ok: false, reason: 'phone_pairing_not_available' };
  }
  if (token !== pairing.token) {
    return { ok: false, reason: 'phone_pairing_token_invalid' };
  }
  const nowMs = toPositiveInt(options.nowMs, Date.now());
  const expiresAtMs = toPositiveInt(pairing.expiresAtMs, 0);
  if (expiresAtMs && nowMs > expiresAtMs) {
    return { ok: false, reason: 'phone_pairing_token_expired' };
  }
  return {
    ok: true,
    token,
    pairing,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPhoneVoiceClientPage(input = {}) {
  const config = buildPhoneClientConfig(input);
  const serialized = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.title)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #101418; color: #f5f7fa; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: min(480px, 100%); display: grid; gap: 18px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
    p { margin: 0; color: #b9c3cf; line-height: 1.45; }
    .status { border: 1px solid #2d3844; border-radius: 8px; padding: 14px; background: #151b21; }
    .talk { min-height: 72px; border: 0; border-radius: 8px; background: #2f7df6; color: white; font-size: 22px; font-weight: 700; }
    .talk:disabled { background: #3a4652; color: #aab4c0; }
    .row { display: flex; gap: 10px; }
    .row button { flex: 1; min-height: 48px; border: 1px solid #334252; border-radius: 8px; background: #18212a; color: #f5f7fa; }
    .disclosure { color: #9ea9b5; font-size: 13px; }
    code { color: #d8e7ff; }
  </style>
</head>
<body>
  <main>
    <h1>Mira Voice</h1>
    <p>Phone client shell. Pair this device, then use push-to-talk to route speech through SquidRun's Architect lane.</p>
    <section class="status" id="status">Loading...</section>
    <button class="talk" id="talk" type="button" disabled>Hold to Talk</button>
    <div class="row">
      <button id="connect" type="button">Connect</button>
      <button id="mute" type="button" disabled>Mute</button>
      <button id="interrupt" type="button" disabled>Interrupt</button>
    </div>
    <p class="disclosure">Spoken Mira replies use AI-generated voice audio. Audio may be sent to OpenAI while this paired session is active.</p>
    <p id="log">Ready to connect when this broker is reachable from your phone.</p>
  </main>
  <script>
    window.SQUIDRUN_PHONE_VOICE = ${serialized};
    const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
    const urlParams = new URLSearchParams(window.location.search);
    const phoneToken = urlParams.get('token') || '';
    const status = document.getElementById('status');
    const log = document.getElementById('log');
    const connectBtn = document.getElementById('connect');
    const talkBtn = document.getElementById('talk');
    const muteBtn = document.getElementById('mute');
    const interruptBtn = document.getElementById('interrupt');
    let session = null;

    function setLog(text) { log.textContent = text; }
    function extractEphemeralKey(payload) {
      return payload && (
        payload.value
        || (payload.body && payload.body.value)
        || (payload.client_secret && payload.client_secret.value)
        || (payload.body && payload.body.client_secret && payload.body.client_secret.value)
      );
    }
    function sendEvent(event) {
      if (!session || !session.channel || session.channel.readyState !== 'open') return false;
      session.channel.send(JSON.stringify(event));
      return true;
    }
    function setTracksEnabled(enabled) {
      const tracks = session && session.stream && session.stream.getAudioTracks ? session.stream.getAudioTracks() : [];
      tracks.forEach((track) => { track.enabled = Boolean(enabled); });
    }
    async function postTranscript(payload) {
      await fetch(window.SQUIDRUN_PHONE_VOICE.endpoints.transcripts, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + phoneToken,
        },
        body: JSON.stringify(Object.assign({}, payload, {
          metadata: Object.assign({}, payload.metadata || {}, { source: 'phone-web-client' }),
        })),
      });
    }
    function normalizeTranscriptEvent(event) {
      if (!event || typeof event !== 'object') return null;
      const type = String(event.type || '');
      const content = Array.isArray(event.item && event.item.content) ? event.item.content : [];
      const contentText = content.map((part) => part.transcript || part.text || part.input_text || '').filter(Boolean).join(' ');
      const text = event.transcript || event.text || event.delta || contentText || '';
      if (!text) return null;
      if (
        type === 'conversation.item.input_audio_transcription.completed'
        || (type === 'conversation.item.created' && event.item && event.item.role === 'user')
        || type === 'response.audio_transcript.done'
        || type === 'response.output_text.done'
        || type.endsWith('.transcript.done')
      ) {
        return {
          eventId: event.event_id || event.eventId || event.item_id || undefined,
          speaker: type.startsWith('response.') ? 'assistant' : 'user',
          text,
          sessionId: event.response_id || event.item_id || undefined,
        };
      }
      return null;
    }
    function getOrCreatePhoneConsumerId() {
      try {
        if (typeof localStorage !== 'undefined') {
          const stored = localStorage.getItem('squidrun.voice.phoneConsumerId');
          if (typeof stored === 'string' && stored.trim()) return stored.trim();
        }
      } catch (_) {}
      let id;
      try {
        id = 'phone-' + (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)));
      } catch (_) {
        id = 'phone-' + Date.now().toString(36);
      }
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('squidrun.voice.phoneConsumerId', id);
        }
      } catch (_) {}
      return id;
    }
    async function registerPhoneVoiceConsumer() {
      if (!session) return false;
      const consumerId = session.voiceConsumerId || (session.voiceConsumerId = getOrCreatePhoneConsumerId());
      const response = await fetch(window.SQUIDRUN_PHONE_VOICE.endpoints.leaseRegister, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + phoneToken,
        },
        body: JSON.stringify({ consumerId, consumerKind: 'phone-client' }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok !== true) return false;
      session.voiceRegistrationToken = body.registrationToken;
      session.voiceRegistrationExpiresAtMs = Number(body.expiresAtMs || 0);
      return true;
    }
    async function acquireOrRenewPhoneVoiceLease() {
      if (!session) return false;
      if (!session.voiceRegistrationToken) {
        const ok = await registerPhoneVoiceConsumer();
        if (!ok) return false;
      }
      const consumerId = session.voiceConsumerId;
      const response = await fetch(window.SQUIDRUN_PHONE_VOICE.endpoints.leaseAcquire, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-voice-registration-token': session.voiceRegistrationToken,
        },
        body: JSON.stringify({
          consumerId,
          consumerKind: 'phone-client',
          lastUserActivityAtMs: Number(session.lastUserActivityAtMs || 0),
        }),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 401 && body && body.reason === 'registration_expired') {
        session.voiceRegistrationToken = null;
        return acquireOrRenewPhoneVoiceLease();
      }
      if (!response.ok || !body || body.ok !== true) return false;
      session.voiceLeaseId = (body.leaseState && body.leaseState.leaseId) || null;
      session.voiceLeaseExpiresAtMs = Number(body.leaseState && body.leaseState.expiresAtMs || 0);
      return true;
    }
    async function postPhoneVoiceSpokenAck(messageId) {
      if (!session || !session.voiceRegistrationToken || !session.voiceLeaseId || !messageId) return;
      try {
        await fetch(window.SQUIDRUN_PHONE_VOICE.endpoints.spoken, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-voice-registration-token': session.voiceRegistrationToken,
          },
          body: JSON.stringify({
            consumerId: session.voiceConsumerId,
            leaseId: session.voiceLeaseId,
            messageId,
          }),
        });
      } catch (_) {}
    }
    async function releasePhoneVoiceLease() {
      if (!session || !session.voiceRegistrationToken) return;
      try {
        await fetch(window.SQUIDRUN_PHONE_VOICE.endpoints.leaseRelease, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-voice-registration-token': session.voiceRegistrationToken,
          },
          body: JSON.stringify({
            consumerId: session.voiceConsumerId,
            leaseId: session.voiceLeaseId || null,
          }),
        });
      } catch (_) {}
      session.voiceLeaseId = null;
      session.voiceLeaseExpiresAtMs = 0;
    }
    async function pollEgressOnce() {
      if (!session) return;
      const acquired = await acquireOrRenewPhoneVoiceLease();
      if (!acquired) return;
      const sinceMs = session.egressSinceMs || Date.now();
      const consumerId = session.voiceConsumerId;
      const response = await fetch(
        window.SQUIDRUN_PHONE_VOICE.endpoints.egress + '?sinceMs=' + encodeURIComponent(String(sinceMs)) + '&limit=10&consumerId=' + encodeURIComponent(consumerId),
        { headers: {
            Authorization: 'Bearer ' + phoneToken,
            'x-voice-registration-token': session.voiceRegistrationToken,
        } }
      );
      const body = await response.json().catch(() => null);
      const messages = Array.isArray(body && body.messages) ? body.messages : [];
      for (const message of messages) {
        if (session.spokenIds.has(message.messageId)) continue;
        session.spokenIds.add(message.messageId);
        if (message.messageId) session.pendingSpokenMessageIds.push(message.messageId);
        sendEvent({
          type: 'response.create',
          response: {
            input: [],
            output_modalities: ['audio'],
            instructions: 'Say exactly this Mira/Architect reply and nothing else:\\n' + message.text,
          },
        });
        if (Number(message.timestampMs) >= sinceMs) session.egressSinceMs = Number(message.timestampMs) + 1;
      }
    }
    function stopSession() {
      if (!session) return;
      clearInterval(session.egressTimer);
      clearInterval(session.voiceHeartbeatTimer);
      void releasePhoneVoiceLease();
      try { session.channel.close(); } catch (_) {}
      try { session.peer.close(); } catch (_) {}
      const tracks = session.stream && session.stream.getTracks ? session.stream.getTracks() : [];
      tracks.forEach((track) => { try { track.stop(); } catch (_) {} });
      session = null;
      talkBtn.disabled = true;
      muteBtn.disabled = true;
      interruptBtn.disabled = true;
      connectBtn.textContent = 'Connect';
      setLog('Disconnected.');
    }
    async function connect() {
      if (session) {
        stopSession();
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof RTCPeerConnection !== 'function') {
        setLog('This browser cannot open a WebRTC microphone session.');
        return;
      }
      setLog('Asking for microphone...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const tokenResponse = await fetch(window.SQUIDRUN_PHONE_VOICE.endpoints.clientSecret, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + phoneToken,
        },
        body: JSON.stringify({}),
      });
      const tokenPayload = await tokenResponse.json();
      const ephemeralKey = extractEphemeralKey(tokenPayload);
      if (!tokenResponse.ok || !ephemeralKey) throw new Error('Could not get Realtime client secret.');

      const peer = new RTCPeerConnection();
      const audio = document.createElement('audio');
      audio.autoplay = true;
      peer.ontrack = (event) => { audio.srcObject = event.streams[0]; };
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
        peer.addTrack(track, stream);
      });
      const channel = peer.createDataChannel('oai-events');
      session = {
        stream,
        peer,
        channel,
        audio,
        egressSinceMs: Date.now(),
        spokenIds: new Set(),
        egressTimer: null,
        voiceConsumerId: null,
        voiceRegistrationToken: null,
        voiceLeaseId: null,
        voiceHeartbeatTimer: null,
        pendingSpokenMessageIds: [],
        lastUserActivityAtMs: 0,
      };
      channel.addEventListener('open', () => {
        sendEvent({
          type: 'session.update',
          session: {
            type: 'realtime',
            output_modalities: ['audio'],
            audio: {
              input: {
                transcription: { model: window.SQUIDRUN_PHONE_VOICE.status.liveTranscriptionModel || 'gpt-realtime-whisper' },
                turn_detection: {
                  type: 'server_vad',
                  prefix_padding_ms: window.SQUIDRUN_PHONE_VOICE.status.vadPrefixPaddingMs || 700,
                  silence_duration_ms: window.SQUIDRUN_PHONE_VOICE.status.vadSilenceDurationMs || 2200,
                  create_response: false,
                },
              },
            },
          },
        });
        session.egressTimer = setInterval(() => { pollEgressOnce().catch((err) => setLog('Egress check failed: ' + err.message)); }, 1200);
        session.voiceHeartbeatTimer = setInterval(() => {
          acquireOrRenewPhoneVoiceLease().catch((err) => setLog('Voice lease heartbeat failed: ' + err.message));
        }, 5000);
        setLog('Connected. Hold Talk when you want to speak.');
      });
      channel.addEventListener('message', (event) => {
        const payload = JSON.parse(event.data || '{}');
        const transcript = normalizeTranscriptEvent(payload);
        if (transcript) postTranscript(transcript).catch((err) => setLog('Transcript route failed: ' + err.message));
        const payloadType = payload && typeof payload.type === 'string' ? payload.type : '';
        if (
          session
          && Array.isArray(session.pendingSpokenMessageIds)
          && session.pendingSpokenMessageIds.length > 0
          && (
            payloadType === 'response.audio.done'
            || payloadType === 'response.output_audio.done'
            || payloadType === 'response.done'
          )
        ) {
          const ackMessageId = session.pendingSpokenMessageIds.shift();
          if (ackMessageId) void postPhoneVoiceSpokenAck(ackMessageId);
        }
      });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const sdpResponse = await fetch(OPENAI_REALTIME_CALLS_URL, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: 'Bearer ' + ephemeralKey,
          'Content-Type': 'application/sdp',
        },
      });
      if (!sdpResponse.ok) throw new Error('Realtime SDP exchange failed.');
      await peer.setRemoteDescription({ type: 'answer', sdp: await sdpResponse.text() });
      talkBtn.disabled = false;
      muteBtn.disabled = false;
      interruptBtn.disabled = false;
      connectBtn.textContent = 'Disconnect';
    }
    status.textContent = 'Broker model: ' + window.SQUIDRUN_PHONE_VOICE.status.model
      + ' / voice: ' + window.SQUIDRUN_PHONE_VOICE.status.voice;
    if (!phoneToken) {
      setLog('Missing phone pairing token. Open the paired link from Telegram.');
      connectBtn.disabled = true;
    }
    connectBtn.addEventListener('click', () => { connect().catch((err) => { stopSession(); setLog(err.message); }); });
    talkBtn.addEventListener('pointerdown', () => {
      if (session) session.lastUserActivityAtMs = Date.now();
      setTracksEnabled(true);
      talkBtn.dataset.active = 'true';
      setLog('Talking...');
    });
    talkBtn.addEventListener('pointerup', () => { setTracksEnabled(false); talkBtn.dataset.active = 'false'; setLog('Connected.'); });
    talkBtn.addEventListener('pointercancel', () => { setTracksEnabled(false); talkBtn.dataset.active = 'false'; setLog('Connected.'); });
    muteBtn.addEventListener('click', () => { setTracksEnabled(false); setLog('Muted.'); });
    interruptBtn.addEventListener('click', () => {
      sendEvent({ type: 'response.cancel' });
      sendEvent({ type: 'output_audio_buffer.clear' });
      setLog('Interrupt sent.');
    });
  </script>
</body>
</html>`;
}

module.exports = {
  DEFAULT_PHONE_PAIRING_TTL_MS,
  buildPhoneClientConfig,
  createPhonePairingToken,
  extractPhoneAuthToken,
  renderPhoneVoiceClientPage,
  sanitizePublicStatus,
  validatePhonePairingToken,
};
