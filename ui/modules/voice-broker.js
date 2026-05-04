'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const { resolveCoordPath } = require('../config');
const taskQueue = require('../scripts/hm-task-queue');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_MODEL = 'gpt-realtime';
const DEFAULT_VOICE = 'marin';
const DEFAULT_TRANSCRIPT_RELATIVE_PATH = path.join('runtime', 'voice-transcripts.jsonl');
const OPENAI_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const OPENAI_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

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
  const apiKey = trimText(overrides.openaiApiKey)
    || trimText(env.OPENAI_API_KEY)
    || null;
  const transcriptJournalPath = trimText(overrides.transcriptJournalPath)
    || trimText(env.SQUIDRUN_VOICE_TRANSCRIPT_JOURNAL)
    || resolveWritableCoordPath(DEFAULT_TRANSCRIPT_RELATIVE_PATH);

  return {
    enabled: toBoolean(overrides.enabled ?? env.SQUIDRUN_VOICE_BROKER_ENABLED, true),
    host,
    port,
    model,
    voice,
    openaiApiKey: apiKey,
    openaiApiKeyPresent: Boolean(apiKey),
    transcriptJournalPath,
    endpointShape: {
      status: { method: 'GET', path: '/status' },
      clientSecret: {
        method: 'POST',
        path: '/v1/voice/realtime/client-secret',
        upstream: OPENAI_CLIENT_SECRETS_URL,
      },
      transcript: {
        method: 'POST',
        path: '/v1/voice/transcripts',
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
    || 'You are SquidRun voice ingress. Capture user intent and route it through owned work; do not write directly to terminal panes.';
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

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  setCorsHeaders(res);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload, null, 2));
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
        openaiApiKeyPresent: this.config.openaiApiKeyPresent,
        transcriptJournalPath: this.config.transcriptJournalPath,
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
  DEFAULT_MODEL,
  DEFAULT_TRANSCRIPT_RELATIVE_PATH,
  DEFAULT_VOICE,
  OPENAI_CALLS_URL,
  OPENAI_CLIENT_SECRETS_URL,
  VoiceBrokerService,
  buildRealtimeSessionPayload,
  getVoiceBrokerConfig,
  ingestVoiceTranscript,
  mintRealtimeClientSecret,
  normalizeTranscriptPayload,
  routeVoiceTranscriptToArchitect,
};
