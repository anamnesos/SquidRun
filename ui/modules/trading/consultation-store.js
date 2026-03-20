'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { getProjectRoot, resolveCoordPath } = require('../../config');
const { queryCommsJournalEntries } = require('../main/comms-journal');

const execFileAsync = promisify(execFile);
const DEFAULT_CONSULTATION_TIMEOUT_MS = 120_000;
const DEFAULT_CONSULTATION_POLL_MS = 1_000;
const DEFAULT_CONSULTATION_REQUESTS_DIR = resolveCoordPath(path.join('runtime', 'consultation-requests'), { forWrite: true });
const DEFAULT_CONSULTATION_RESPONSES_DIR = resolveCoordPath(path.join('runtime', 'consultation-responses'), { forWrite: true });
const AGENT_MESSAGE_PREFIX = '[AGENT MSG - reply via hm-send.js]';

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toIsoTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRequestsDir(options = {}) {
  return options.requestsDir || DEFAULT_CONSULTATION_REQUESTS_DIR;
}

function resolveResponsesDir(options = {}) {
  return options.responsesDir || DEFAULT_CONSULTATION_RESPONSES_DIR;
}

function generateConsultationRequestId(prefix = 'consultation') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function serializeMap(value) {
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value.entries()).map(([key, item]) => [String(key), serializeMap(item)]));
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeMap(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeMap(item)]));
  }
  return value;
}

function normalizeSignal(signal = {}) {
  return {
    ticker: toText(signal.ticker).toUpperCase(),
    direction: toText(signal.direction).toUpperCase(),
    confidence: Math.max(0, Math.min(1, toNumber(signal.confidence, 0))),
    reasoning: toText(signal.reasoning),
  };
}

function normalizeConsultationResponse(response = {}) {
  return {
    requestId: toText(response.requestId),
    agentId: toText(response.agentId).toLowerCase(),
    signals: Array.isArray(response.signals) ? response.signals.map(normalizeSignal).filter((signal) => signal.ticker) : [],
  };
}

function createConsultationRequest(payload = {}) {
  const requestId = toText(payload.requestId, generateConsultationRequestId());
  const deadlineMs = Math.max(1_000, Math.floor(toNumber(payload.timeoutMs, DEFAULT_CONSULTATION_TIMEOUT_MS)));
  const createdAt = toIsoTimestamp(payload.createdAt, new Date().toISOString());
  const deadline = toIsoTimestamp(payload.deadline, new Date(Date.parse(createdAt) + deadlineMs).toISOString());

  return {
    requestId,
    createdAt,
    deadline,
    timeoutMs: deadlineMs,
    symbols: Array.isArray(payload.symbols) ? payload.symbols.map((symbol) => toText(symbol).toUpperCase()).filter(Boolean) : [],
    snapshots: serializeMap(payload.snapshots || {}),
    bars: serializeMap(payload.bars || {}),
    news: serializeMap(payload.news || []),
    accountSnapshot: serializeMap(payload.accountSnapshot || null),
  };
}

function resolveConsultationRequestPath(requestId, options = {}) {
  return path.join(resolveRequestsDir(options), `${requestId}.json`);
}

function resolveConsultationResponsePath(requestId, agentId, options = {}) {
  return path.join(resolveResponsesDir(options), `${requestId}-${agentId}.json`);
}

function writeConsultationRequest(payload = {}, options = {}) {
  const request = createConsultationRequest(payload);
  const requestPath = resolveConsultationRequestPath(request.requestId, options);
  fs.mkdirSync(path.dirname(requestPath), { recursive: true });
  fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
  return {
    ...request,
    path: requestPath,
  };
}

function readConsultationRequest(requestId, options = {}) {
  const requestPath = resolveConsultationRequestPath(requestId, options);
  return JSON.parse(fs.readFileSync(requestPath, 'utf8'));
}

function writeConsultationResponse(response = {}, options = {}) {
  const normalized = normalizeConsultationResponse(response);
  if (!normalized.requestId) {
    throw new Error('requestId is required');
  }
  if (!normalized.agentId) {
    throw new Error('agentId is required');
  }
  const responsePath = resolveConsultationResponsePath(normalized.requestId, normalized.agentId, options);
  fs.mkdirSync(path.dirname(responsePath), { recursive: true });
  fs.writeFileSync(responsePath, JSON.stringify(normalized, null, 2));
  return {
    ...normalized,
    path: responsePath,
  };
}

function stripMessagePrefix(rawBody = '') {
  return String(rawBody || '')
    .replace(/^\s*\[AGENT MSG - reply via hm-send\.js\]\s*/i, '')
    .replace(/^\([^)]*\):\s*/, '')
    .trim();
}

function parseConsultationResponseBody(rawBody = '') {
  const text = stripMessagePrefix(rawBody);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return normalizeConsultationResponse(JSON.parse(text.slice(firstBrace, lastBrace + 1)));
  } catch {
    return null;
  }
}

function buildConsultationPrompt(targetRole, request = {}, options = {}) {
  const requestPath = resolveConsultationRequestPath(request.requestId, options);
  const relativePath = path.relative(getProjectRoot(), requestPath).replace(/\\/g, '/');
  const deadline = request.deadline || new Date(Date.now() + DEFAULT_CONSULTATION_TIMEOUT_MS).toISOString();
  const symbols = Array.isArray(request.symbols) ? request.symbols : [];
  const sampleSignals = symbols.slice(0, 2).map((ticker) => (
    { ticker, direction: 'BUY', confidence: 0.72, reasoning: '...' }
  ));
  if (sampleSignals.length === 0) {
    sampleSignals.push({ ticker: 'BTC/USD', direction: 'BUY', confidence: 0.72, reasoning: '...' });
  }
  const sample = JSON.stringify({
    requestId: request.requestId,
    agentId: targetRole,
    signals: sampleSignals,
  });

  return [
    `Analyze ALL ${symbols.length} symbols in consultation request ${request.requestId}: ${symbols.join(', ')}.`,
    `Market context at ${relativePath} (${requestPath}).`,
    `Reply via hm-send architect with JSON containing a signal for EVERY symbol: ${sample}`,
    `Deadline: ${deadline}.`,
    'Use your normal role prefix if needed, but keep the JSON itself valid and complete. Include all symbols, not just the examples shown.',
  ].join(' ');
}

async function dispatchConsultationRequests(request = {}, agentIds = [], options = {}) {
  const sender = options.sender || defaultConsultationSender;
  const deliveries = [];

  for (const agentId of agentIds) {
    const message = buildConsultationPrompt(agentId, request, options);
    try {
      const result = await sender(agentId, message, { ...options, request });
      deliveries.push({
        agentId,
        ok: result?.ok !== false,
        result: result || null,
      });
    } catch (error) {
      deliveries.push({
        agentId,
        ok: false,
        error: error?.message || String(error),
      });
    }
  }

  return deliveries;
}

async function defaultConsultationSender(target, message, options = {}) {
  const hmSendPath = options.hmSendPath || path.join(getProjectRoot(), 'ui', 'scripts', 'hm-send.js');
  await execFileAsync(process.execPath, [hmSendPath, target, message], {
    cwd: options.cwd || getProjectRoot(),
    windowsHide: true,
    timeout: Math.max(5_000, toNumber(options.sendTimeoutMs, 30_000)),
  });
  return { ok: true };
}

async function collectConsultationResponses(request = {}, agentIds = [], options = {}) {
  const queryEntries = options.queryEntries || queryCommsJournalEntries;
  const requestCreatedAtMs = Date.parse(request.createdAt || new Date().toISOString()) || Date.now();
  const deadlineMs = Date.parse(request.deadline || new Date(Date.now() + DEFAULT_CONSULTATION_TIMEOUT_MS).toISOString())
    || (requestCreatedAtMs + DEFAULT_CONSULTATION_TIMEOUT_MS);
  const pollMs = Math.max(100, Math.floor(toNumber(options.pollMs, DEFAULT_CONSULTATION_POLL_MS)));
  const responses = new Map();
  const errors = [];

  while (Date.now() <= deadlineMs && responses.size < agentIds.length) {
    for (const agentId of agentIds) {
      if (responses.has(agentId)) continue;
      const entries = queryEntries({
        channel: 'ws',
        direction: 'outbound',
        senderRole: agentId,
        sinceMs: requestCreatedAtMs,
        order: 'desc',
        limit: 100,
      }, { dbPath: options.dbPath || null });

      for (const entry of entries) {
        const parsed = parseConsultationResponseBody(entry.rawBody || '');
        if (!parsed || parsed.requestId !== request.requestId) {
          continue;
        }
        if (parsed.agentId !== agentId) {
          continue;
        }
        writeConsultationResponse(parsed, options);
        responses.set(agentId, parsed);
        break;
      }
    }

    if (responses.size >= agentIds.length || Date.now() > deadlineMs) {
      break;
    }

    await sleep(pollMs);
  }

  return {
    requestId: request.requestId,
    responses: Array.from(responses.values()),
    missingAgents: agentIds.filter((agentId) => !responses.has(agentId)),
    errors,
  };
}

module.exports = {
  AGENT_MESSAGE_PREFIX,
  DEFAULT_CONSULTATION_POLL_MS,
  DEFAULT_CONSULTATION_REQUESTS_DIR,
  DEFAULT_CONSULTATION_RESPONSES_DIR,
  DEFAULT_CONSULTATION_TIMEOUT_MS,
  buildConsultationPrompt,
  collectConsultationResponses,
  createConsultationRequest,
  dispatchConsultationRequests,
  generateConsultationRequestId,
  parseConsultationResponseBody,
  readConsultationRequest,
  resolveConsultationRequestPath,
  resolveConsultationResponsePath,
  writeConsultationRequest,
  writeConsultationResponse,
};
