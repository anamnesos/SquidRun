'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { getProjectRoot, resolveCoordPath } = require('../config');
const taskQueue = require('../scripts/hm-task-queue');
const {
  buildPhoneClientConfig,
  createPhonePairingToken,
  renderPhoneVoiceClientPage,
} = require('./phone-voice-client');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_MODEL = 'gpt-realtime-1.5';
const DEFAULT_VOICE = 'marin';
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
const DEFAULT_TRANSCRIPT_RELATIVE_PATH = path.join('runtime', 'voice-transcripts.jsonl');
const DEFAULT_DIAGNOSTICS_RELATIVE_PATH = path.join('runtime', 'voice-diagnostics.jsonl');
const DEFAULT_PHONE_PAIRING_RELATIVE_PATH = path.join('runtime', 'voice-phone-pairing.json');
const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const OPENAI_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const DEFAULT_MIRA_VOICE_INSTRUCTIONS = [
  'You are Mira, the SquidRun Architect voice companion for James.',
  'You are not a generic AI assistant and you should not introduce yourself that way.',
  'Speak warmly, briefly, and plainly, like the Mira Architect lane in SquidRun.',
  'Treat this as a live voice front-end to Mira: acknowledge what James says, keep him oriented, and avoid sounding like a demo bot.',
  'For concrete work, say what you are carrying or what will be routed through SquidRun; do not claim you personally completed app changes unless the SquidRun lane reports it.',
  'Never execute customer-facing, trading, money, auth, or irreversible actions from voice alone.',
  'When James says to push, send, route, or put something in Mira/my pane, that is allowed and expected: the app routes the transcript to the Architect lane through SquidRun.',
  'Do not refuse pane-routing commands just because they mention a pane; only refuse direct OS/terminal control or irreversible actions.',
  'Do not write directly to terminal panes yourself.',
  'Do not answer user speech as a separate assistant. Wait for SquidRun to provide Mira/Architect replies, then speak those replies as Mira\'s mouth.',
].join(' ');

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function resolveReadableCoordPath(relativePath, options = {}) {
  if (options.paths && options.paths[relativePath]) {
    return options.paths[relativePath];
  }
  try {
    return resolveCoordPath(relativePath);
  } catch (_) {
    return path.join(options.projectRoot || getProjectRoot() || process.cwd(), '.squidrun', relativePath);
  }
}

function countQueueItems(agentState = {}) {
  const pending = Array.isArray(agentState.pending) ? agentState.pending.length : 0;
  const active = agentState.active ? 1 : 0;
  const blocked = Array.isArray(agentState.blocked) ? agentState.blocked.length : 0;
  const waiting = Array.isArray(agentState.waiting) ? agentState.waiting.length : 0;
  return { pending, active, blocked, waiting };
}

function summarizeAgentWork(role, agentState = {}) {
  const counts = countQueueItems(agentState);
  const activeTitle = trimText(agentState.active?.title || agentState.active?.message);
  const parts = [`${role}: active=${counts.active}`];
  if (activeTitle) parts.push(`active work="${activeTitle.slice(0, 80)}"`);
  parts.push(`pending=${counts.pending}`);
  if (counts.blocked) parts.push(`blocked=${counts.blocked}`);
  if (counts.waiting) parts.push(`waiting=${counts.waiting}`);
  return parts.join(', ');
}

function buildVoiceContextSnapshot(options = {}) {
  const appStatus = safeReadJson(resolveReadableCoordPath('app-status.json', options));
  const taskQueueState = safeReadJson(resolveReadableCoordPath(path.join('runtime', 'agent-task-queue.json'), options));
  const lines = [];

  if (appStatus) {
    const session = appStatus.session ? `session ${appStatus.session}` : 'current session';
    const mode = trimText(appStatus.mode) || 'unknown mode';
    const readyPanes = Array.isArray(appStatus.paneHost?.readyPanes)
      ? appStatus.paneHost.readyPanes.join('/')
      : null;
    const paneHealth = readyPanes
      ? `pane host ready panes ${readyPanes}`
      : 'pane host state unknown';
    const degraded = appStatus.paneHost?.degraded === true ? 'degraded' : 'not degraded';
    lines.push(`Main SquidRun app is ${session}, ${mode}, ${paneHealth}, ${degraded}.`);
  } else {
    lines.push('Main SquidRun app status is unavailable right now.');
  }

  const agents = taskQueueState?.agents && typeof taskQueueState.agents === 'object'
    ? taskQueueState.agents
    : null;
  if (agents) {
    lines.push([
      summarizeAgentWork('Mira/Architect', agents.architect),
      summarizeAgentWork('Builder', agents.builder),
      summarizeAgentWork('Oracle', agents.oracle),
    ].join('; '));
  } else {
    lines.push('Owned-work queue status is unavailable right now.');
  }

  lines.push('Builder and Oracle may be visually hidden in Focus Mira mode, but routing and terminal processes can still be alive.');
  const commsRows = Array.isArray(options.commsRows)
    ? options.commsRows
    : queryRecentCommsRows(options);
  const recentSession = summarizeRecentComms(commsRows, {
    limit: options.recentCommsLimit,
  });
  if (recentSession) {
    lines.push(`Recent session context: ${recentSession}`);
  } else {
    lines.push('Recent session message history is unavailable right now.');
  }
  lines.push('Use this context when James asks what is happening; when exact action status is uncertain, say you are routing/checking through Mira.');
  return lines.join(' ');
}

function queryRecentCommsRows(options = {}) {
  if (options.includeRecentComms === false) return [];
  if (typeof options.queryCommsJournalEntries === 'function') {
    return options.queryCommsJournalEntries({
      limit: options.recentCommsQueryLimit || 18,
      order: 'desc',
    }) || [];
  }
  try {
    const { queryCommsJournalEntries } = require('./main/comms-journal');
    return queryCommsJournalEntries({
      limit: options.recentCommsQueryLimit || 18,
      order: 'desc',
    }) || [];
  } catch (_) {
    return [];
  }
}

function normalizeCommsBody(body) {
  return String(body || '')
    .replace(/\s+/g, ' ')
    .replace(/\[[^\]]*CURRENT PROJECT[^\]]*\]/gi, '')
    .trim();
}

function summarizeRecentComms(rows = [], options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const limit = Math.max(1, Math.min(24, Number(options.limit) || 12));
  return rows
    .slice(0, limit)
    .reverse()
    .map((row) => {
      const sender = trimText(row.senderRole || row.sender || row.source) || 'unknown';
      const target = trimText(row.targetRole || row.target) || 'unknown';
      const body = normalizeCommsBody(row.rawBody || row.body || row.message || row.excerpt);
      if (!body) return null;
      return `${sender}->${target}: ${body.slice(0, 240)}`;
    })
    .filter(Boolean)
    .join(' | ');
}

function buildMiraVoiceInstructions(options = {}) {
  const context = trimText(options.contextText)
    || buildVoiceContextSnapshot(options.contextOptions || options);
  return `${DEFAULT_MIRA_VOICE_INSTRUCTIONS} Current SquidRun context: ${context}`;
}

function trimText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toPositiveInt(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function resolveWritableCoordPath(relativePath) {
  try {
    return resolveCoordPath(relativePath, { forWrite: true });
  } catch (_) {
    return path.resolve(process.cwd(), '.squidrun', relativePath);
  }
}

function getVoiceBrokerConfig(env = process.env, overrides = {}) {
  const host = trimText(overrides.host)
    || trimText(env.SQUIDRUN_VOICE_BROKER_HOST)
    || DEFAULT_HOST;
  const port = toPositiveInt(
    overrides.port ?? env.SQUIDRUN_VOICE_BROKER_PORT,
    DEFAULT_PORT
  );
  const model = trimText(overrides.model)
    || trimText(env.SQUIDRUN_REALTIME_MODEL)
    || trimText(env.OPENAI_REALTIME_MODEL)
    || DEFAULT_MODEL;
  const voice = trimText(overrides.voice)
    || trimText(env.SQUIDRUN_REALTIME_VOICE)
    || trimText(env.OPENAI_REALTIME_VOICE)
    || DEFAULT_VOICE;
  const transcriptionModel = trimText(overrides.transcriptionModel)
    || trimText(env.SQUIDRUN_VOICE_TRANSCRIPTION_MODEL)
    || trimText(env.OPENAI_TRANSCRIPTION_MODEL)
    || DEFAULT_TRANSCRIPTION_MODEL;
  const apiKey = trimText(overrides.openaiApiKey)
    || trimText(env.OPENAI_API_KEY)
    || null;
  const transcriptJournalPath = trimText(overrides.transcriptJournalPath)
    || trimText(env.SQUIDRUN_VOICE_TRANSCRIPT_JOURNAL)
    || resolveWritableCoordPath(DEFAULT_TRANSCRIPT_RELATIVE_PATH);
  const diagnosticsJournalPath = trimText(overrides.diagnosticsJournalPath)
    || trimText(env.SQUIDRUN_VOICE_DIAGNOSTICS_JOURNAL)
    || resolveWritableCoordPath(DEFAULT_DIAGNOSTICS_RELATIVE_PATH);
  const phonePairingPath = trimText(overrides.phonePairingPath)
    || trimText(env.SQUIDRUN_VOICE_PHONE_PAIRING_PATH)
    || resolveWritableCoordPath(DEFAULT_PHONE_PAIRING_RELATIVE_PATH);

  return {
    enabled: toBoolean(overrides.enabled ?? env.SQUIDRUN_VOICE_BROKER_ENABLED, true),
    host,
    port,
    model,
    voice,
    transcriptionModel,
    openaiApiKey: apiKey,
    openaiApiKeyPresent: Boolean(apiKey),
    transcriptJournalPath,
    diagnosticsJournalPath,
    phonePairingPath,
    endpointShape: {
      status: { method: 'GET', path: '/status' },
      phoneClient: {
        method: 'GET',
        path: '/phone',
      },
      phoneConfig: {
        method: 'GET',
        path: '/v1/voice/phone/config',
      },
      phonePairing: {
        method: 'POST',
        path: '/v1/voice/phone/pairing',
      },
      clientSecret: {
        method: 'POST',
        path: '/v1/voice/realtime/client-secret',
        upstream: OPENAI_CLIENT_SECRETS_URL,
      },
      transcript: {
        method: 'POST',
        path: '/v1/voice/transcripts',
      },
      audioTranscription: {
        method: 'POST',
        path: '/v1/voice/audio-transcriptions',
        upstream: OPENAI_TRANSCRIPTIONS_URL,
      },
      egress: {
        method: 'GET',
        path: '/v1/voice/egress',
      },
      egressSay: {
        method: 'POST',
        path: '/v1/voice/egress',
      },
      diagnostics: {
        method: 'POST',
        path: '/v1/voice/diagnostics',
      },
      futureSdpSession: {
        method: 'POST',
        path: '/v1/voice/realtime/session',
        upstream: OPENAI_CALLS_URL,
        status: 'contract_only',
      },
    },
  };
}

function buildRealtimeSessionPayload(config = {}, overrides = {}) {
  const model = trimText(overrides.model) || config.model || DEFAULT_MODEL;
  const voice = trimText(overrides.voice) || config.voice || DEFAULT_VOICE;
  const instructions = trimText(overrides.instructions)
    || buildMiraVoiceInstructions(overrides);
  return {
    session: {
      type: 'realtime',
      model,
      instructions,
      audio: {
        output: {
          voice,
        },
      },
    },
  };
}

function sanitizeTokenResponse(data) {
  if (!data || typeof data !== 'object') return data;
  return data;
}

async function mintRealtimeClientSecret(options = {}) {
  const config = options.config || getVoiceBrokerConfig(options.env || process.env, options);
  if (!config.openaiApiKey) {
    return {
      ok: false,
      reason: 'openai_api_key_missing',
      endpointShape: config.endpointShape.clientSecret,
    };
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      reason: 'fetch_unavailable',
      endpointShape: config.endpointShape.clientSecret,
    };
  }

  const payload = buildRealtimeSessionPayload(config, options.session || {});
  const response = await fetchImpl(OPENAI_CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const responseText = await response.text();
  let body = responseText;
  try {
    body = JSON.parse(responseText);
  } catch (_) {
    // Keep text body.
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: 'openai_client_secret_failed',
      statusCode: response.status,
      body,
      endpointShape: config.endpointShape.clientSecret,
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    body: sanitizeTokenResponse(body),
    endpointShape: config.endpointShape.clientSecret,
  };
}

function normalizeAudioTranscriptionPayload(payload = {}) {
  const audioBase64 = trimText(payload.audioBase64 || payload.audio_base64);
  if (!audioBase64) {
    return { ok: false, reason: 'audio_base64_required' };
  }
  const mimeType = trimText(payload.mimeType || payload.mime_type) || 'audio/webm';
  const speaker = trimText(payload.speaker) || 'James';
  return {
    ok: true,
    audioBase64,
    mimeType,
    speaker,
    eventId: trimText(payload.eventId || payload.event_id),
    sessionId: trimText(payload.sessionId || payload.session_id),
    metadata: payload.metadata && typeof payload.metadata === 'object'
      ? { ...payload.metadata }
      : {},
  };
}

async function transcribeVoiceAudio(payload = {}, options = {}) {
  const config = options.config || getVoiceBrokerConfig(options.env || process.env, options);
  if (!config.openaiApiKey) {
    return {
      ok: false,
      reason: 'openai_api_key_missing',
      endpointShape: config.endpointShape.audioTranscription,
    };
  }
  const normalized = normalizeAudioTranscriptionPayload(payload);
  if (!normalized.ok) return normalized;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      reason: 'fetch_unavailable',
      endpointShape: config.endpointShape.audioTranscription,
    };
  }
  if (typeof FormData !== 'function' || typeof Blob !== 'function') {
    return {
      ok: false,
      reason: 'formdata_unavailable',
      endpointShape: config.endpointShape.audioTranscription,
    };
  }

  const buffer = Buffer.from(normalized.audioBase64, 'base64');
  const form = new FormData();
  form.append(
    'model',
    trimText(options.transcriptionModel) || config.transcriptionModel || DEFAULT_TRANSCRIPTION_MODEL
  );
  form.append('file', new Blob([buffer], { type: normalized.mimeType }), 'voice.webm');

  const response = await fetchImpl(OPENAI_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
    },
    body: form,
  });
  const responseText = await response.text();
  let body = responseText;
  try {
    body = JSON.parse(responseText);
  } catch (_) {
    // Keep text body.
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: 'openai_audio_transcription_failed',
      statusCode: response.status,
      body,
      endpointShape: config.endpointShape.audioTranscription,
    };
  }
  const text = trimText(body?.text || body?.transcript || body);
  if (!text) {
    return {
      ok: true,
      skipped: true,
      reason: 'empty_transcript',
      statusCode: response.status,
      body,
    };
  }
  const ingest = ingestVoiceTranscript({
    eventId: normalized.eventId || `voice-audio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    speaker: normalized.speaker,
    text,
    sessionId: normalized.sessionId,
    metadata: {
      ...normalized.metadata,
      source: 'audio-transcription-fallback',
      mimeType: normalized.mimeType,
    },
  }, {
    ...options,
    config,
  });
  return {
    ok: true,
    statusCode: response.status,
    text,
    body,
    ingest,
    endpointShape: config.endpointShape.audioTranscription,
  };
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeTranscriptPayload(payload = {}) {
  const text = trimText(payload.text || payload.transcript);
  if (!text) {
    return { ok: false, reason: 'transcript_text_required' };
  }
  const nowMs = Number.isFinite(Number(payload.receivedAtMs))
    ? Math.floor(Number(payload.receivedAtMs))
    : Date.now();
  const eventId = trimText(payload.eventId)
    || `voice-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ok: true,
    event: {
      eventId,
      source: 'voice',
      channel: 'voice',
      direction: 'inbound',
      speaker: trimText(payload.speaker) || 'user',
      text,
      receivedAtMs: nowMs,
      sessionId: trimText(payload.sessionId),
      metadata: payload.metadata && typeof payload.metadata === 'object'
        ? { ...payload.metadata }
        : {},
    },
  };
}

function appendTranscriptJournal(event, journalPath) {
  ensureDirForFile(journalPath);
  fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`, 'utf8');
  return journalPath;
}

function normalizeVoiceDiagnosticPayload(payload = {}) {
  const eventType = trimText(payload.eventType || payload.type) || 'voice.diagnostic';
  const nowMs = Number.isFinite(Number(payload.tsMs || payload.timestampMs))
    ? Math.floor(Number(payload.tsMs || payload.timestampMs))
    : Date.now();
  return {
    ok: true,
    event: {
      eventId: trimText(payload.eventId) || `voice-diag-${nowMs}-${Math.random().toString(36).slice(2, 8)}`,
      eventType,
      tsMs: nowMs,
      sessionId: trimText(payload.sessionId),
      ok: payload.ok !== false,
      reason: trimText(payload.reason),
      detail: payload.detail && typeof payload.detail === 'object'
        ? { ...payload.detail }
        : {},
    },
  };
}

function appendVoiceDiagnostic(payload = {}, journalPath) {
  const normalized = normalizeVoiceDiagnosticPayload(payload);
  const targetPath = journalPath || resolveWritableCoordPath(DEFAULT_DIAGNOSTICS_RELATIVE_PATH);
  ensureDirForFile(targetPath);
  fs.appendFileSync(targetPath, `${JSON.stringify(normalized.event)}\n`, 'utf8');
  return {
    ok: true,
    event: normalized.event,
    journalPath: targetPath,
  };
}

function emitVoiceIngress(bus, event) {
  if (bus && typeof bus.emit === 'function') {
    bus.emit('voice.ingress', {
      paneId: 'system',
      payload: event,
      source: 'voice-broker',
    });
  }
}

function enqueueVoiceOwnedWork(event, options = {}) {
  if (options.enqueueOwnedWork === false) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  const enqueue = typeof options.enqueueTask === 'function'
    ? options.enqueueTask
    : taskQueue.enqueueTask;
  return enqueue({
    agent: 'architect',
    title: 'Voice ingress',
    message: `[Voice from ${event.speaker}]: ${event.text}`,
    source: 'voice-broker',
    riskClass: options.riskClass || undefined,
    nextStep: 'Classify and route this voice request through SquidRun owned work.',
    wakeTrigger: 'voice-ingress',
    restartPersistence: true,
    metadata: {
      voiceEventId: event.eventId,
      channel: 'voice',
      sessionId: event.sessionId || null,
    },
  }, options.queuePath ? { queuePath: options.queuePath } : {});
}

function routeVoiceTranscriptToArchitect(event, options = {}) {
  if (options.routeToArchitect === false) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  if (event.speaker === 'assistant') {
    return { ok: true, skipped: true, reason: 'non_user_speaker' };
  }
  if (typeof options.routeVoiceMessage === 'function') {
    return options.routeVoiceMessage(event);
  }

  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'hm-send.js');
  const child = spawn(process.execPath, [scriptPath, 'architect', '--stdin', '--role', 'voice'], {
    cwd: path.resolve(__dirname, '..', '..'),
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: {
      ...process.env,
      SQUIDRUN_PROJECT_ROOT: path.resolve(__dirname, '..', '..'),
    },
  });
  child.stdin.end(`[Voice from James]: ${event.text}`);
  child.unref?.();
  return {
    ok: true,
    routed: true,
    target: 'architect',
    method: 'hm-send',
  };
}

function ingestVoiceTranscript(payload = {}, options = {}) {
  const config = options.config || getVoiceBrokerConfig(options.env || process.env, options);
  const normalized = normalizeTranscriptPayload(payload);
  if (!normalized.ok) return normalized;
  const event = normalized.event;
  const journalPath = appendTranscriptJournal(event, options.transcriptJournalPath || config.transcriptJournalPath);
  emitVoiceIngress(options.bus, event);
  let ownedWork = null;
  try {
    const shouldEnqueueOwnedWork = options.enqueueOwnedWork !== undefined
      ? options.enqueueOwnedWork
      : options.routeToArchitect === false;
    ownedWork = enqueueVoiceOwnedWork(event, {
      ...options,
      enqueueOwnedWork: shouldEnqueueOwnedWork,
    });
  } catch (err) {
    ownedWork = { ok: false, reason: 'owned_work_enqueue_failed', error: err.message };
  }
  let route = null;
  try {
    route = routeVoiceTranscriptToArchitect(event, options);
  } catch (err) {
    route = { ok: false, reason: 'voice_route_failed', error: err.message };
  }
  return {
    ok: true,
    event,
    journalPath,
    ownedWork,
    route,
  };
}

function normalizeVoiceEgressMessage(row = {}) {
  const sender = trimText(row.senderRole || row.sender_role || row.sender);
  const target = trimText(row.targetRole || row.target_role || row.target);
  if (sender !== 'architect' || target !== 'user') return null;
  const text = trimText(row.rawBody || row.raw_body || row.body || row.message || row.excerpt);
  if (!text) return null;
  const timestampMs = Number(
    row.brokeredAtMs
    || row.brokered_at_ms
    || row.sentAtMs
    || row.sent_at_ms
    || row.updatedAtMs
    || row.updated_at_ms
    || row.timestampMs
    || 0
  );
  return {
    messageId: trimText(row.messageId || row.message_id) || `voice-egress-${timestampMs}-${text.slice(0, 16)}`,
    speaker: 'Mira',
    text,
    timestampMs: Number.isFinite(timestampMs) && timestampMs > 0 ? timestampMs : Date.now(),
    source: 'architect',
    target: 'user',
  };
}

function queryVoiceEgressMessages(options = {}) {
  const sinceMs = Number.isFinite(Number(options.sinceMs))
    ? Math.floor(Number(options.sinceMs))
    : Date.now();
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const filters = {
    senderRole: 'architect',
    targetRole: 'user',
    sinceMs,
    order: 'asc',
    limit,
  };
  let rows = [];
  if (typeof options.queryCommsJournalEntries === 'function') {
    rows = options.queryCommsJournalEntries(filters) || [];
  } else {
    try {
      const { queryCommsJournalEntries } = require('./main/comms-journal');
      rows = queryCommsJournalEntries(filters) || [];
    } catch (_) {
      rows = [];
    }
  }
  return rows
    .map((row) => normalizeVoiceEgressMessage(row))
    .filter(Boolean)
    .filter((message) => message.timestampMs >= sinceMs)
    .slice(0, limit);
}

function appendVoiceEgressMessage(input = {}, options = {}) {
  const text = trimText(input.text || input.rawBody || input.message || input.body);
  if (!text) {
    return { ok: false, reason: 'voice_egress_text_required' };
  }
  const nowMs = Number.isFinite(Number(options.nowMs || input.nowMs))
    ? Math.floor(Number(options.nowMs || input.nowMs))
    : Date.now();
  const messageId = trimText(input.messageId)
    || `voice-egress-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    messageId,
    sessionId: trimText(input.sessionId) || null,
    senderRole: 'architect',
    targetRole: 'user',
    channel: 'voice',
    direction: 'outbound',
    sentAtMs: nowMs,
    brokeredAtMs: nowMs,
    rawBody: text,
    status: 'recorded',
    attempt: 1,
    metadata: {
      source: trimText(input.source) || 'voice-egress-api',
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    },
  };
  let result = null;
  if (typeof options.appendCommsJournalEntry === 'function') {
    result = options.appendCommsJournalEntry(entry) || {};
  } else {
    try {
      const { appendCommsJournalEntry } = require('./main/comms-journal');
      result = appendCommsJournalEntry(entry) || {};
    } catch (err) {
      return { ok: false, reason: 'voice_egress_journal_unavailable', error: err.message };
    }
  }
  if (result.ok === false) {
    return {
      ok: false,
      reason: result.reason || 'voice_egress_journal_failed',
      journal: result,
    };
  }
  return {
    ok: true,
    message: normalizeVoiceEgressMessage(entry),
    journal: result,
  };
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  setCorsHeaders(res);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, statusCode, html) {
  res.statusCode = statusCode;
  setCorsHeaders(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readRequestBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > limitBytes) {
        reject(new Error('request_body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function parseJsonBody(text) {
  if (!trimText(text)) return {};
  return JSON.parse(text);
}

class VoiceBrokerService {
  constructor(options = {}) {
    this.config = options.config || getVoiceBrokerConfig(options.env || process.env, options);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.bus = options.bus || null;
    this.enqueueTask = options.enqueueTask || null;
    this.routeVoiceMessage = options.routeVoiceMessage || null;
    this.queryCommsJournalEntries = options.queryCommsJournalEntries || null;
    this.appendCommsJournalEntry = options.appendCommsJournalEntry || null;
    this.routeToArchitect = options.routeToArchitect;
    this.server = null;
    this.startedAtMs = null;
    this.lastError = null;
    this.boundAddress = null;
  }

  getStatus() {
    return {
      ok: true,
      running: Boolean(this.server),
      startedAtMs: this.startedAtMs,
      address: this.boundAddress,
      config: {
        enabled: this.config.enabled,
        host: this.config.host,
        port: this.config.port,
        model: this.config.model,
        voice: this.config.voice,
        transcriptionModel: this.config.transcriptionModel,
        openaiApiKeyPresent: this.config.openaiApiKeyPresent,
        transcriptJournalPath: this.config.transcriptJournalPath,
        diagnosticsJournalPath: this.config.diagnosticsJournalPath,
        phonePairingPath: this.config.phonePairingPath,
        endpointShape: this.config.endpointShape,
      },
      lastError: this.lastError,
    };
  }

  async handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'OPTIONS') {
        setCorsHeaders(res);
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/health')) {
        sendJson(res, 200, this.getStatus());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/phone') {
        sendHtml(res, 200, renderPhoneVoiceClientPage({
          status: this.getStatus(),
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/voice/phone/config') {
        sendJson(res, 200, buildPhoneClientConfig({
          status: this.getStatus(),
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/voice/phone/pairing') {
        const body = parseJsonBody(await readRequestBody(req));
        const pairing = createPhonePairingToken({
          ttlMs: body.ttlMs,
        });
        ensureDirForFile(this.config.phonePairingPath);
        fs.writeFileSync(this.config.phonePairingPath, `${JSON.stringify(pairing, null, 2)}\n`, 'utf8');
        sendJson(res, 201, {
          ...pairing,
          pairingPath: this.config.phonePairingPath,
          phonePath: this.config.endpointShape.phoneClient.path,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/voice/realtime/client-secret') {
        const body = parseJsonBody(await readRequestBody(req));
        const result = await mintRealtimeClientSecret({
          config: this.config,
          fetchImpl: this.fetchImpl,
          session: body.session || body,
        });
        sendJson(res, result.ok ? 200 : 503, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/voice/transcripts') {
        const body = parseJsonBody(await readRequestBody(req));
        const result = ingestVoiceTranscript(body, {
          config: this.config,
          bus: this.bus,
          enqueueTask: this.enqueueTask || undefined,
          routeVoiceMessage: this.routeVoiceMessage || undefined,
          routeToArchitect: this.routeToArchitect,
        });
        sendJson(res, result.ok ? 202 : 400, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/voice/audio-transcriptions') {
        const body = parseJsonBody(await readRequestBody(req, 12 * 1024 * 1024));
        const result = await transcribeVoiceAudio(body, {
          config: this.config,
          fetchImpl: this.fetchImpl,
          bus: this.bus,
          enqueueTask: this.enqueueTask || undefined,
          routeVoiceMessage: this.routeVoiceMessage || undefined,
          routeToArchitect: this.routeToArchitect,
        });
        sendJson(res, result.ok ? 202 : 400, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/voice/diagnostics') {
        const body = parseJsonBody(await readRequestBody(req));
        const result = appendVoiceDiagnostic(body, this.config.diagnosticsJournalPath);
        sendJson(res, 202, result);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/voice/egress') {
        const messages = queryVoiceEgressMessages({
          sinceMs: Number(url.searchParams.get('sinceMs') || 0),
          limit: Number(url.searchParams.get('limit') || 10),
          queryCommsJournalEntries: this.queryCommsJournalEntries || undefined,
        });
        sendJson(res, 200, {
          ok: true,
          messages,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/voice/egress') {
        const body = parseJsonBody(await readRequestBody(req));
        const result = appendVoiceEgressMessage(body, {
          appendCommsJournalEntry: this.appendCommsJournalEntry || undefined,
        });
        sendJson(res, result.ok ? 202 : 400, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/voice/realtime/session') {
        sendJson(res, 501, {
          ok: false,
          reason: 'sdp_session_proxy_not_implemented',
          endpointShape: this.config.endpointShape.futureSdpSession,
        });
        return;
      }

      sendJson(res, 404, { ok: false, reason: 'not_found' });
    } catch (err) {
      this.lastError = err.message;
      sendJson(res, err.message === 'request_body_too_large' ? 413 : 500, {
        ok: false,
        reason: err.message,
      });
    }
  }

  start() {
    if (this.server) return Promise.resolve(this.getStatus());
    if (!this.config.enabled) {
      return Promise.resolve({
        ...this.getStatus(),
        ok: false,
        reason: 'voice_broker_disabled',
      });
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server.once('error', (err) => {
        this.lastError = err.message;
        this.server = null;
        reject(err);
      });
      this.server.listen(this.config.port, this.config.host, () => {
        this.startedAtMs = Date.now();
        this.boundAddress = this.server.address();
        resolve(this.getStatus());
      });
    });
  }

  stop() {
    if (!this.server) return Promise.resolve({ ok: true, stopped: false, reason: 'not_running' });
    const server = this.server;
    this.server = null;
    return new Promise((resolve) => {
      server.close(() => {
        this.boundAddress = null;
        resolve({ ok: true, stopped: true });
      });
    });
  }
}

module.exports = {
  DEFAULT_DIAGNOSTICS_RELATIVE_PATH,
  DEFAULT_MODEL,
  DEFAULT_MIRA_VOICE_INSTRUCTIONS,
  DEFAULT_PHONE_PAIRING_RELATIVE_PATH,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TRANSCRIPT_RELATIVE_PATH,
  DEFAULT_VOICE,
  OPENAI_CALLS_URL,
  OPENAI_CLIENT_SECRETS_URL,
  OPENAI_TRANSCRIPTIONS_URL,
  VoiceBrokerService,
  appendVoiceEgressMessage,
  appendVoiceDiagnostic,
  buildMiraVoiceInstructions,
  buildRealtimeSessionPayload,
  buildVoiceContextSnapshot,
  getVoiceBrokerConfig,
  ingestVoiceTranscript,
  mintRealtimeClientSecret,
  normalizeAudioTranscriptionPayload,
  normalizeTranscriptPayload,
  normalizeVoiceDiagnosticPayload,
  queryVoiceEgressMessages,
  routeVoiceTranscriptToArchitect,
  summarizeRecentComms,
  transcribeVoiceAudio,
};
