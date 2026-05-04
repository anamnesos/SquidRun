'use strict';

const { invokeBridge } = require('../renderer-bridge');
const { escapeHtml } = require('./utils');

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const VOICE_DATA_CHANNEL_CONTRACT = Object.freeze({
  channelName: 'oai-events',
  clientEvents: Object.freeze({
    conversationItemCreate: 'conversation.item.create',
    responseCreate: 'response.create',
    sessionUpdate: 'session.update',
    responseCancel: 'response.cancel',
    outputAudioClear: 'output_audio_buffer.clear',
  }),
  serverIngressEvents: Object.freeze([
    'response.created',
    'conversation.item.input_audio_transcription.completed',
    'conversation.item.created',
    'response.audio_transcript.done',
    'response.output_text.done',
  ]),
  futureToolIngress: Object.freeze([
    'response.function_call_arguments.done',
    'conversation.item.created',
  ]),
});

const IDS = Object.freeze({
  panel: 'voiceBrokerPanel',
  state: 'voiceBrokerState',
  readiness: 'voiceBrokerReadiness',
  endpoint: 'voiceBrokerEndpoint',
  model: 'voiceBrokerModel',
  journal: 'voiceBrokerJournal',
  error: 'voiceBrokerError',
  refresh: 'voiceBrokerRefreshBtn',
  start: 'voiceBrokerStartBtn',
  stop: 'voiceBrokerStopBtn',
  restart: 'voiceBrokerRestartBtn',
  sessionStatus: 'voiceSessionStatus',
  sessionStart: 'voiceSessionStartBtn',
  sessionPush: 'voicePushToTalkBtn',
  sessionMute: 'voiceMuteBtn',
  sessionInterrupt: 'voiceInterruptBtn',
  sessionStop: 'voiceSessionStopBtn',
  sessionLog: 'voiceSessionLog',
});

let cleanupFns = [];
let lastStatus = null;
let activeSession = null;
let sessionState = 'idle';

function getEl(id) {
  if (typeof document === 'undefined') return null;
  return document.getElementById(id);
}

function getStateLabel(status) {
  const state = status?.state || (status?.running ? 'running' : 'stopped');
  if (state === 'running') return 'Running';
  if (state === 'not_ready') return 'Not ready';
  if (state === 'stopped') return 'Stopped';
  return 'Unavailable';
}

function getReadinessLabel(status) {
  if (!status || status.ok === false) return 'Unavailable';
  const reasons = Array.isArray(status.notReadyReasons) ? status.notReadyReasons : [];
  if (reasons.includes('openai_api_key_missing')) return 'OPENAI_API_KEY missing';
  if (reasons.includes('voice_broker_disabled')) return 'Disabled';
  return status.ready ? 'Ready' : 'Not ready';
}

function getEndpointLabel(status) {
  const shape = status?.config?.endpointShape?.clientSecret;
  const address = status?.lane?.broker?.address || status?.lane?.address || null;
  const host = address?.address || status?.config?.host || '127.0.0.1';
  const port = address?.port || status?.config?.port || 0;
  const base = port ? `http://${host}:${port}` : `${status?.config?.host || '127.0.0.1'}:auto`;
  if (!shape) return base;
  return `${shape.method} ${base}${shape.path}`;
}

function getBrokerBaseUrl(status) {
  const address = status?.lane?.broker?.address || status?.lane?.address || null;
  const host = address?.address || status?.config?.host || '127.0.0.1';
  const port = address?.port || status?.config?.port || 0;
  return port ? `http://${host}:${port}` : null;
}

function getClientSecretUrl(status) {
  const base = getBrokerBaseUrl(status);
  const path = status?.config?.endpointShape?.clientSecret?.path || '/v1/voice/realtime/client-secret';
  return base ? `${base}${path}` : null;
}

function getTranscriptUrl(status) {
  const base = getBrokerBaseUrl(status);
  const path = status?.config?.endpointShape?.transcript?.path || '/v1/voice/transcripts';
  return base ? `${base}${path}` : null;
}

function getAudioTranscriptionUrl(status) {
  const base = getBrokerBaseUrl(status);
  const path = status?.config?.endpointShape?.audioTranscription?.path || '/v1/voice/audio-transcriptions';
  return base ? `${base}${path}` : null;
}

function getEgressUrl(status) {
  const base = getBrokerBaseUrl(status);
  const path = status?.config?.endpointShape?.egress?.path || '/v1/voice/egress';
  return base ? `${base}${path}` : null;
}

function getDiagnosticsUrl(status) {
  const base = getBrokerBaseUrl(status);
  const path = status?.config?.endpointShape?.diagnostics?.path || null;
  return base && path ? `${base}${path}` : null;
}

function getModelLabel(status) {
  const model = status?.config?.model || 'gpt-realtime-1.5';
  const voice = status?.config?.voice || 'marin';
  const transcription = status?.config?.transcriptionModel || 'gpt-4o-transcribe';
  return `${model} / ${voice} / STT ${transcription}`;
}

function getTranscriptionModel(status) {
  return status?.config?.transcriptionModel || 'gpt-4o-transcribe';
}

function renderText(id, text) {
  const el = getEl(id);
  if (el) el.textContent = text;
}

function setError(message) {
  const el = getEl(IDS.error);
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function setSessionStatus(text, state = sessionState) {
  sessionState = state;
  const el = getEl(IDS.sessionStatus);
  if (el) {
    el.textContent = text;
    el.dataset.state = state;
  }
}

function appendSessionLog(text) {
  const el = getEl(IDS.sessionLog);
  if (!el || !text) return;
  const current = String(el.textContent || '').trim();
  const next = current ? `${current}\n${text}` : text;
  el.textContent = next.split('\n').slice(-6).join('\n');
}

function postVoiceDiagnostic(eventType, detail = {}, options = {}) {
  const status = options.status || lastStatus;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const diagnosticsUrl = getDiagnosticsUrl(status);
  if (!diagnosticsUrl || typeof fetchImpl !== 'function') {
    return Promise.resolve({ ok: false, reason: 'voice_diagnostics_endpoint_unavailable' });
  }
  return fetchImpl(diagnosticsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventType,
      ok: options.ok !== false,
      reason: options.reason || null,
      detail,
      tsMs: Date.now(),
    }),
  }).then(async (response) => {
    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      body = null;
    }
    return { ok: response.ok, statusCode: response.status, body };
  }).catch((err) => ({ ok: false, reason: err.message }));
}

function setButtonState(status) {
  const ready = Boolean(status?.ready);
  const running = Boolean(status?.running);
  const start = getEl(IDS.start);
  const stop = getEl(IDS.stop);
  const restart = getEl(IDS.restart);
  if (start) start.disabled = running || !ready;
  if (stop) stop.disabled = !running;
  if (restart) restart.disabled = !ready;
  setSessionButtonState();
}

function setSessionButtonState() {
  const sessionActive = Boolean(activeSession);
  const ready = Boolean(lastStatus?.ready && lastStatus?.running && getClientSecretUrl(lastStatus));
  const start = getEl(IDS.sessionStart);
  const push = getEl(IDS.sessionPush);
  const mute = getEl(IDS.sessionMute);
  const interrupt = getEl(IDS.sessionInterrupt);
  const stop = getEl(IDS.sessionStop);
  if (start) start.disabled = sessionActive || !ready;
  if (push) push.disabled = !sessionActive;
  if (mute) mute.disabled = !sessionActive;
  if (interrupt) interrupt.disabled = !sessionActive;
  if (stop) stop.disabled = !sessionActive;
}

function renderVoiceBrokerStatus(status) {
  lastStatus = status;
  const panel = getEl(IDS.panel);
  if (panel) panel.dataset.state = status?.state || 'unavailable';

  renderText(IDS.state, getStateLabel(status));
  renderText(IDS.readiness, getReadinessLabel(status));
  renderText(IDS.endpoint, getEndpointLabel(status));
  renderText(IDS.model, getModelLabel(status));
  renderText(IDS.journal, status?.config?.transcriptJournalPath || status?.lane?.logPath || 'Not configured');
  setButtonState(status);
  setError(status?.ok === false ? status.reason || 'Voice broker unavailable' : null);
}

function renderVoiceBrokerPanelHtml(status) {
  return [
    `<div class="voice-broker-pill" data-state="${escapeHtml(status?.state || 'unavailable')}">${escapeHtml(getStateLabel(status))}</div>`,
    `<div class="voice-broker-readiness">${escapeHtml(getReadinessLabel(status))}</div>`,
    `<div class="voice-broker-endpoint">${escapeHtml(getEndpointLabel(status))}</div>`,
  ].join('');
}

function getLocalVoiceBrokerStatus() {
  const host = typeof window !== 'undefined' ? window : globalThis;
  const reader = host?.squidrun?.voice?.brokerStatusLocal
    || host?.squidrunAPI?.voice?.brokerStatusLocal
    || null;
  if (typeof reader !== 'function') return null;
  return Promise.resolve(reader());
}

async function refreshVoiceBrokerStatus() {
  try {
    const status = await invokeBridge('voice-broker:status');
    renderVoiceBrokerStatus(status);
    return status;
  } catch (err) {
    const localStatus = await getLocalVoiceBrokerStatus().catch(() => null);
    if (localStatus?.ok) {
      renderVoiceBrokerStatus(localStatus);
      setError(null);
      return localStatus;
    }
    const status = {
      ok: false,
      state: 'unavailable',
      ready: false,
      running: false,
      reason: err.message,
      notReadyReasons: ['ipc_unavailable'],
      config: {},
    };
    renderVoiceBrokerStatus(status);
    setError(err.message);
    return status;
  }
}

async function controlVoiceBroker(action) {
  setError(null);
  try {
    const result = await invokeBridge('voice-broker:control', { action });
    renderVoiceBrokerStatus(result?.status || lastStatus || {});
    if (result?.ok === false) {
      setError(result.reason || 'Voice broker command failed');
    }
    return result;
  } catch (err) {
    setError(err.message);
    throw err;
  }
}

function extractEphemeralKey(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.value
    || payload.client_secret?.value
    || payload.clientSecret?.value
    || payload.body?.value
    || payload.body?.client_secret?.value
    || payload.body?.clientSecret?.value
    || null;
}

function normalizeRealtimeTranscriptEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || '');
  const content = Array.isArray(event.item?.content) ? event.item.content : [];
  const contentText = content
    .map((part) => part?.transcript || part?.text || part?.input_text || '')
    .filter(Boolean)
    .join(' ');
  const text = event.transcript || event.text || event.delta || contentText || null;
  if (!text) return null;
  if (
    type === 'conversation.item.input_audio_transcription.completed'
    || (type === 'conversation.item.created' && event.item?.role === 'user')
    || type === 'response.audio_transcript.done'
    || type === 'response.output_text.done'
    || type.endsWith('.transcript.done')
  ) {
    return {
      eventId: event.event_id || event.eventId || event.item_id || undefined,
      speaker: type.startsWith('response.') ? 'assistant' : 'user',
      text,
      sessionId: event.response_id || event.item_id || undefined,
      metadata: {
        realtimeType: type,
      },
    };
  }
  return null;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function sendDataChannelEvent(channel, event) {
  if (!channel || channel.readyState !== 'open') return false;
  channel.send(JSON.stringify(event));
  return true;
}

function buildSpeakMiraReplyEvents(text) {
  const reply = String(text || '').trim();
  if (!reply) return [];
  return [
    {
      type: VOICE_DATA_CHANNEL_CONTRACT.clientEvents.responseCreate,
      response: {
        input: [],
        output_modalities: ['audio'],
        instructions: `Say exactly this Mira/Architect reply and nothing else:\n${reply}`,
      },
    },
  ];
}

function speakMiraReply(session, text) {
  const events = buildSpeakMiraReplyEvents(text);
  if (!events.length) return false;
  if (session) session.speakingMiraReply = true;
  let sent = false;
  for (const event of events) {
    sent = sendDataChannelEvent(session?.dataChannel, event) || sent;
  }
  if (sent) appendSessionLog('Mira reply spoken');
  return sent;
}

function cancelGenericRealtimeResponse(session, reason = 'generic_response') {
  if (!session || session.speakingMiraReply === true) return false;
  const canceled = sendDataChannelEvent(session.dataChannel, {
    type: VOICE_DATA_CHANNEL_CONTRACT.clientEvents.responseCancel,
  });
  sendDataChannelEvent(session.dataChannel, {
    type: VOICE_DATA_CHANNEL_CONTRACT.clientEvents.outputAudioClear,
  });
  if (canceled) appendSessionLog(`Generic voice response canceled: ${reason}`);
  return canceled;
}

function setTrackEnabled(session, enabled) {
  const tracks = session?.stream?.getAudioTracks?.() || [];
  tracks.forEach((track) => {
    track.enabled = enabled;
  });
}

function stopVoiceSession() {
  if (!activeSession) {
    setSessionStatus('Idle', 'idle');
    setSessionButtonState();
    return;
  }
  const session = activeSession;
  activeSession = null;
  if (session.egressPollTimer) {
    clearInterval(session.egressPollTimer);
    session.egressPollTimer = null;
  }
  try { session.audioRecorder?.stop?.(); } catch (_) {}
  try { session.dataChannel?.close?.(); } catch (_) {}
  try { session.peerConnection?.close?.(); } catch (_) {}
  const tracks = session.stream?.getTracks?.() || [];
  tracks.forEach((track) => {
    try { track.stop?.(); } catch (_) {}
  });
  if (session.remoteAudio) session.remoteAudio.srcObject = null;
  setSessionStatus('Stopped', 'idle');
  setSessionButtonState();
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

async function postAudioChunkToBroker(blob, status = lastStatus, fetchImpl = globalThis.fetch) {
  const audioUrl = getAudioTranscriptionUrl(status);
  if (!audioUrl || typeof fetchImpl !== 'function' || !blob || Number(blob.size || 0) <= 0) {
    void postVoiceDiagnostic('voice.audio_chunk.skipped', {
      hasAudioUrl: Boolean(audioUrl),
      hasFetch: typeof fetchImpl === 'function',
      blobSize: Number(blob?.size || 0),
    }, { status, fetchImpl, ok: false, reason: 'audio_chunk_unavailable' });
    return { ok: false, reason: 'voice_audio_transcription_endpoint_unavailable' };
  }
  void postVoiceDiagnostic('voice.audio_chunk.posting', {
    blobSize: Number(blob.size || 0),
    mimeType: blob.type || 'audio/webm',
  }, { status, fetchImpl });
  const audioBase64 = await blobToBase64(blob);
  const response = await fetchImpl(audioUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audioBase64,
      mimeType: blob.type || 'audio/webm',
      speaker: 'James',
      metadata: {
        source: 'renderer-media-recorder',
      },
    }),
  });
  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  if (body?.text) appendSessionLog(`Mic transcript: ${body.text}`);
  void postVoiceDiagnostic('voice.audio_chunk.result', {
    statusCode: response.status,
    responseOk: response.ok,
    text: body?.text || null,
    reason: body?.reason || null,
  }, { status, fetchImpl, ok: response.ok, reason: body?.reason });
  return {
    ok: response.ok,
    statusCode: response.status,
    body,
  };
}

function startAudioTranscriptionFallback(session, options = {}) {
  const Recorder = options.MediaRecorder
    || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
  if (!session?.stream || typeof Recorder !== 'function') {
    appendSessionLog('Mic fallback unavailable');
    void postVoiceDiagnostic('voice.media_recorder.unavailable', {
      hasStream: Boolean(session?.stream),
      hasMediaRecorder: typeof Recorder === 'function',
    }, { status: options.status || session?.status || lastStatus, fetchImpl: options.fetchImpl, ok: false });
    return null;
  }
  let recorder = null;
  try {
    recorder = new Recorder(session.stream, { mimeType: options.mimeType || 'audio/webm' });
  } catch (_) {
    recorder = new Recorder(session.stream);
  }
  recorder.addEventListener?.('dataavailable', (event) => {
    const blob = event.data;
    const nowMs = Date.now();
    void postVoiceDiagnostic('voice.media_recorder.dataavailable', {
      blobSize: Number(blob?.size || 0),
      mimeType: blob?.type || null,
    }, { status: options.status || session.status || lastStatus, fetchImpl: options.fetchImpl });
    if (!blob || Number(blob.size || 0) <= 0) return;
    const speechRecentlyActive = session.fallbackSpeechActive === true
      || (
        Number.isFinite(Number(session.lastSpeechActivityMs))
        && (nowMs - Number(session.lastSpeechActivityMs)) <= 2500
      );
    if (!speechRecentlyActive) {
      void postVoiceDiagnostic('voice.audio_chunk.silence_skipped', {
        blobSize: Number(blob.size || 0),
        mimeType: blob.type || null,
      }, { status: options.status || session.status || lastStatus, fetchImpl: options.fetchImpl });
      return;
    }
    void postAudioChunkToBroker(blob, options.status || session.status || lastStatus, options.fetchImpl || globalThis.fetch)
      .catch((err) => appendSessionLog(`Mic transcription failed: ${err.message}`));
  });
  recorder.addEventListener?.('error', (event) => {
    appendSessionLog(`Mic recorder error: ${event.error?.message || 'unknown'}`);
    void postVoiceDiagnostic('voice.media_recorder.error', {
      error: event.error?.message || 'unknown',
    }, { status: options.status || session.status || lastStatus, fetchImpl: options.fetchImpl, ok: false });
  });
  recorder.start?.(Math.max(1000, Number(options.timesliceMs) || 4000));
  session.audioRecorder = recorder;
  appendSessionLog('Mic fallback recording');
  void postVoiceDiagnostic('voice.media_recorder.started', {
    timesliceMs: Math.max(1000, Number(options.timesliceMs) || 4000),
  }, { status: options.status || session.status || lastStatus, fetchImpl: options.fetchImpl });
  return recorder;
}

async function pollVoiceEgressOnce(session, status = lastStatus, fetchImpl = globalThis.fetch) {
  const egressUrl = getEgressUrl(status);
  if (!session || !egressUrl || typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'voice_egress_endpoint_unavailable' };
  }
  const sinceMs = Number.isFinite(Number(session.egressSinceMs))
    ? Math.floor(Number(session.egressSinceMs))
    : Date.now();
  const url = `${egressUrl}?sinceMs=${encodeURIComponent(String(sinceMs))}&limit=10`;
  const response = await fetchImpl(url, { method: 'GET' });
  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!session.spokenMessageIds) session.spokenMessageIds = new Set();
  for (const message of messages) {
    const messageId = String(message.messageId || '');
    if (messageId && session.spokenMessageIds.has(messageId)) continue;
    if (messageId) session.spokenMessageIds.add(messageId);
    speakMiraReply(session, message.text);
    const timestampMs = Number(message.timestampMs || 0);
    if (Number.isFinite(timestampMs) && timestampMs >= sinceMs) {
      session.egressSinceMs = timestampMs + 1;
    }
  }
  return {
    ok: response.ok,
    statusCode: response.status,
    messages,
  };
}

function startVoiceEgressPolling(session, options = {}) {
  if (!session || session.egressPollTimer) return session;
  const status = options.status || session.status || lastStatus;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  session.egressSinceMs = Number.isFinite(Number(options.sinceMs))
    ? Math.floor(Number(options.sinceMs))
    : Date.now();
  session.spokenMessageIds = session.spokenMessageIds || new Set();
  const intervalMs = Math.max(500, Number(options.intervalMs) || 1200);
  session.egressPollTimer = setInterval(() => {
    void pollVoiceEgressOnce(session, status, fetchImpl).catch((err) => {
      appendSessionLog(`Voice egress unavailable: ${err.message}`);
    });
  }, intervalMs);
  return session;
}

async function postTranscriptToBroker(transcript, status = lastStatus, fetchImpl = globalThis.fetch) {
  const transcriptUrl = getTranscriptUrl(status);
  if (!transcriptUrl || typeof fetchImpl !== 'function') {
    void postVoiceDiagnostic('voice.transcript.skipped', {
      hasTranscriptUrl: Boolean(transcriptUrl),
      hasFetch: typeof fetchImpl === 'function',
      text: transcript?.text || null,
    }, { status, fetchImpl, ok: false });
    return { ok: false, reason: 'voice_transcript_endpoint_unavailable' };
  }
  void postVoiceDiagnostic('voice.transcript.posting', {
    speaker: transcript?.speaker || null,
    text: transcript?.text || null,
  }, { status, fetchImpl });
  const response = await fetchImpl(transcriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transcript),
  });
  let body = null;
  try {
    body = await response.json();
  } catch (_) {
    body = null;
  }
  return {
    ok: response.ok,
    statusCode: response.status,
    body,
  };
}

async function createVoiceRealtimeSession(options = {}) {
  const status = options.status || lastStatus;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const mediaDevices = options.mediaDevices
    || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);
  const PeerConnection = options.RTCPeerConnection
    || (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
  const clientSecretUrl = getClientSecretUrl(status);

  if (!status?.ready || !status?.running) {
    throw new Error('Voice broker is not running and ready.');
  }
  if (!clientSecretUrl) {
    throw new Error('Voice broker client-secret endpoint is unavailable.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable for voice session.');
  }
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    throw new Error('Microphone capture is unavailable.');
  }
  if (typeof PeerConnection !== 'function') {
    throw new Error('RTCPeerConnection is unavailable.');
  }

  let tokenResponse;
  try {
    void postVoiceDiagnostic('voice.session.client_secret.request', {
      clientSecretUrl,
    }, { status, fetchImpl });
    tokenResponse = await fetchImpl(clientSecretUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    throw new Error(`Voice broker fetch failed at ${clientSecretUrl}: ${err.message}`);
  }
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok || tokenPayload?.ok === false) {
    throw new Error(tokenPayload?.reason || 'Realtime client secret request failed.');
  }
  const ephemeralKey = extractEphemeralKey(tokenPayload);
  if (!ephemeralKey) {
    throw new Error('Realtime client secret response did not include an ephemeral key.');
  }

  const stream = await mediaDevices.getUserMedia({ audio: true });
  const initialTracks = stream.getAudioTracks?.() || stream.getTracks?.() || [];
  void postVoiceDiagnostic('voice.mic.granted', {
    audioTrackCount: initialTracks.length,
    tracks: initialTracks.map((track) => ({
      enabled: Boolean(track.enabled),
      muted: Boolean(track.muted),
      readyState: track.readyState || null,
      label: track.label || null,
    })),
  }, { status, fetchImpl });
  const peerConnection = new PeerConnection();
  const remoteAudio = options.audioElement || (typeof document !== 'undefined' ? document.createElement('audio') : null);
  if (remoteAudio) {
    remoteAudio.autoplay = true;
    peerConnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams?.[0] || null;
    };
  }

  const tracks = stream.getAudioTracks?.() || stream.getTracks?.() || [];
  tracks.forEach((track) => {
    track.enabled = true;
    peerConnection.addTrack(track, stream);
  });
  void postVoiceDiagnostic('voice.mic.tracks_enabled', {
    audioTrackCount: tracks.length,
    enabledCount: tracks.filter((track) => track.enabled !== false).length,
  }, { status, fetchImpl });

  const dataChannel = peerConnection.createDataChannel(VOICE_DATA_CHANNEL_CONTRACT.channelName);
  const session = {
    dataChannel,
    egressSinceMs: Date.now(),
    fallbackSpeechActive: false,
    lastSpeechActivityMs: 0,
    peerConnection,
    remoteAudio,
    speakingMiraReply: false,
    spokenMessageIds: new Set(),
    stream,
    status,
  };
  startAudioTranscriptionFallback(session, {
    status,
    fetchImpl,
    MediaRecorder: options.MediaRecorder,
    timesliceMs: options.audioChunkMs,
  });
  dataChannel.addEventListener?.('open', () => {
    appendSessionLog('Data channel open');
    void postVoiceDiagnostic('voice.data_channel.open', {}, { status, fetchImpl });
    sendDataChannelEvent(dataChannel, {
      type: VOICE_DATA_CHANNEL_CONTRACT.clientEvents.sessionUpdate,
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: {
          input: {
            transcription: { model: getTranscriptionModel(status) },
            turn_detection: {
              type: 'server_vad',
              create_response: false,
            },
          },
        },
      },
    });
  });
  dataChannel.addEventListener?.('message', (event) => {
    const payload = safeJsonParse(event.data);
    if (!payload) return;
    appendSessionLog(payload.type || 'voice event');
    const eventType = String(payload.type || '');
    void postVoiceDiagnostic('voice.data_channel.event', {
      eventType,
      hasTranscript: Boolean(payload.transcript || payload.text || payload.delta),
      itemRole: payload.item?.role || null,
      errorCode: payload.error?.code || null,
      errorMessage: payload.error?.message || null,
      errorType: payload.error?.type || null,
    }, { status, fetchImpl });
    if (eventType === 'input_audio_buffer.speech_started') {
      session.fallbackSpeechActive = true;
      session.lastSpeechActivityMs = Date.now();
    }
    if (eventType === 'input_audio_buffer.speech_stopped') {
      session.fallbackSpeechActive = false;
      session.lastSpeechActivityMs = Date.now();
    }
    if (
      eventType === 'response.created'
      || eventType === 'response.output_item.added'
      || eventType === 'response.audio.delta'
      || eventType === 'response.output_audio.delta'
      || eventType === 'response.audio_transcript.delta'
      || eventType === 'response.output_audio_transcript.delta'
    ) {
      cancelGenericRealtimeResponse(session, eventType);
    }
    if (
      eventType === 'response.done'
      || eventType === 'response.audio.done'
      || eventType === 'response.output_audio.done'
      || eventType === 'response.audio_transcript.done'
      || eventType === 'response.output_audio_transcript.done'
    ) {
      session.speakingMiraReply = false;
    }
    const transcript = normalizeRealtimeTranscriptEvent(payload);
    if (transcript) {
      if (transcript.speaker === 'user') {
        const nowMs = Date.now();
        cancelGenericRealtimeResponse(session, 'user_transcript_routed');
        session.egressSinceMs = Math.min(
          Number(session.egressSinceMs || nowMs),
          Math.max(0, nowMs - 2000)
        );
      }
      void postTranscriptToBroker(transcript, status, fetchImpl);
    }
  });

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  const callsUrl = options.callsUrl || OPENAI_REALTIME_CALLS_URL;
  let sdpResponse;
  try {
    sdpResponse = await fetchImpl(callsUrl, {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        'Content-Type': 'application/sdp',
      },
    });
  } catch (err) {
    throw new Error(`Realtime SDP fetch failed at ${callsUrl}: ${err.message}`);
  }
  if (!sdpResponse.ok) {
    throw new Error('Realtime SDP exchange failed.');
  }
  const answerSdp = await sdpResponse.text();
  await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  return session;
}

async function startVoiceSession(options = {}) {
  setError(null);
  setSessionStatus('Connecting', 'connecting');
  setSessionButtonState();
  try {
    const sessionOptions = { ...options };
    if (!sessionOptions.status) {
      sessionOptions.status = await refreshVoiceBrokerStatus();
    }
    activeSession = await createVoiceRealtimeSession(sessionOptions);
    startVoiceEgressPolling(activeSession, {
      status: sessionOptions.status,
      fetchImpl: sessionOptions.fetchImpl,
      intervalMs: sessionOptions.egressPollIntervalMs,
    });
    setSessionStatus('Listening', 'talking');
    appendSessionLog('Realtime session connected');
    appendSessionLog('Mic listening');
    setSessionButtonState();
    return activeSession;
  } catch (err) {
    stopVoiceSession();
    setError(err.message);
    setSessionStatus('Error', 'error');
    throw err;
  }
}

function setPushToTalk(active) {
  if (!activeSession) return false;
  setTrackEnabled(activeSession, Boolean(active));
  setSessionStatus(active ? 'Talking' : 'Connected', active ? 'talking' : 'connected');
  const button = getEl(IDS.sessionPush);
  if (button) button.dataset.active = active ? 'true' : 'false';
  return true;
}

function muteVoiceSession() {
  if (!activeSession) return false;
  setTrackEnabled(activeSession, false);
  setSessionStatus('Muted', 'muted');
  return true;
}

function interruptVoiceSession() {
  if (!activeSession) return false;
  const sent = sendDataChannelEvent(activeSession.dataChannel, {
    type: VOICE_DATA_CHANNEL_CONTRACT.clientEvents.responseCancel,
  });
  sendDataChannelEvent(activeSession.dataChannel, {
    type: VOICE_DATA_CHANNEL_CONTRACT.clientEvents.outputAudioClear,
  });
  appendSessionLog(sent ? 'Interrupt sent' : 'Interrupt unavailable');
  return sent;
}

function bindButton(id, handler) {
  const button = getEl(id);
  if (!button) return;
  button.addEventListener('click', handler);
  cleanupFns.push(() => button.removeEventListener('click', handler));
}

function setupVoiceBrokerTab() {
  destroyVoiceBrokerTab();
  bindButton(IDS.refresh, () => { void refreshVoiceBrokerStatus(); });
  bindButton(IDS.start, () => { void controlVoiceBroker('start'); });
  bindButton(IDS.stop, () => { void controlVoiceBroker('stop'); });
  bindButton(IDS.restart, () => { void controlVoiceBroker('restart'); });
  bindButton(IDS.sessionStart, () => { void startVoiceSession(); });
  bindButton(IDS.sessionPush, () => {
    const isActive = getEl(IDS.sessionPush)?.dataset.active === 'true';
    setPushToTalk(!isActive);
  });
  bindButton(IDS.sessionMute, () => { muteVoiceSession(); });
  bindButton(IDS.sessionInterrupt, () => { interruptVoiceSession(); });
  bindButton(IDS.sessionStop, () => { stopVoiceSession(); });
  setSessionStatus('Idle', 'idle');
  void refreshVoiceBrokerStatus();
}

function destroyVoiceBrokerTab() {
  stopVoiceSession();
  for (const fn of cleanupFns) {
    try { fn(); } catch (_) {}
  }
  cleanupFns = [];
}

module.exports = {
  controlVoiceBroker,
  buildSpeakMiraReplyEvents,
  blobToBase64,
  createVoiceRealtimeSession,
  destroyVoiceBrokerTab,
  extractEphemeralKey,
  getEgressUrl,
  getDiagnosticsUrl,
  getAudioTranscriptionUrl,
  getReadinessLabel,
  getStateLabel,
  getClientSecretUrl,
  getTranscriptUrl,
  interruptVoiceSession,
  muteVoiceSession,
  cancelGenericRealtimeResponse,
  normalizeRealtimeTranscriptEvent,
  pollVoiceEgressOnce,
  postTranscriptToBroker,
  postAudioChunkToBroker,
  postVoiceDiagnostic,
  refreshVoiceBrokerStatus,
  renderVoiceBrokerPanelHtml,
  renderVoiceBrokerStatus,
  setPushToTalk,
  speakMiraReply,
  startVoiceSession,
  startAudioTranscriptionFallback,
  startVoiceEgressPolling,
  stopVoiceSession,
  setupVoiceBrokerTab,
  VOICE_DATA_CHANNEL_CONTRACT,
};
