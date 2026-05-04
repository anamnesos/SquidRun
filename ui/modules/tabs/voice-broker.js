'use strict';

const { invokeBridge } = require('../renderer-bridge');
const { escapeHtml } = require('./utils');

const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const VOICE_DATA_CHANNEL_CONTRACT = Object.freeze({
  channelName: 'oai-events',
  clientEvents: Object.freeze({
    sessionUpdate: 'session.update',
    responseCancel: 'response.cancel',
    outputAudioClear: 'output_audio_buffer.clear',
  }),
  serverIngressEvents: Object.freeze([
    'conversation.item.input_audio_transcription.completed',
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

function getModelLabel(status) {
  const model = status?.config?.model || 'gpt-realtime';
  const voice = status?.config?.voice || 'marin';
  return `${model} / ${voice}`;
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
  const text = event.transcript || event.text || event.delta || event.item?.content?.[0]?.text || null;
  if (!text) return null;
  if (
    type === 'conversation.item.input_audio_transcription.completed'
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

async function postTranscriptToBroker(transcript, status = lastStatus, fetchImpl = globalThis.fetch) {
  const transcriptUrl = getTranscriptUrl(status);
  if (!transcriptUrl || typeof fetchImpl !== 'function') {
    return { ok: false, reason: 'voice_transcript_endpoint_unavailable' };
  }
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
    track.enabled = false;
    peerConnection.addTrack(track, stream);
  });

  const dataChannel = peerConnection.createDataChannel(VOICE_DATA_CHANNEL_CONTRACT.channelName);
  dataChannel.addEventListener?.('open', () => {
    appendSessionLog('Data channel open');
    sendDataChannelEvent(dataChannel, {
      type: VOICE_DATA_CHANNEL_CONTRACT.clientEvents.sessionUpdate,
      session: {
        input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
      },
    });
  });
  dataChannel.addEventListener?.('message', (event) => {
    const payload = safeJsonParse(event.data);
    if (!payload) return;
    appendSessionLog(payload.type || 'voice event');
    const transcript = normalizeRealtimeTranscriptEvent(payload);
    if (transcript) {
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

  return {
    dataChannel,
    peerConnection,
    remoteAudio,
    stream,
    status,
  };
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
    setSessionStatus('Connected', 'connected');
    appendSessionLog('Realtime session connected');
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
  createVoiceRealtimeSession,
  destroyVoiceBrokerTab,
  extractEphemeralKey,
  getReadinessLabel,
  getStateLabel,
  getClientSecretUrl,
  getTranscriptUrl,
  interruptVoiceSession,
  muteVoiceSession,
  normalizeRealtimeTranscriptEvent,
  postTranscriptToBroker,
  refreshVoiceBrokerStatus,
  renderVoiceBrokerPanelHtml,
  renderVoiceBrokerStatus,
  setPushToTalk,
  startVoiceSession,
  stopVoiceSession,
  setupVoiceBrokerTab,
  VOICE_DATA_CHANNEL_CONTRACT,
};
