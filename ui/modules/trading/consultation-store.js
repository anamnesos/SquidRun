'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const { getProjectRoot, resolveCoordPath } = require('../../config');
const { queryCommsJournalEntries } = require('../main/comms-journal');
const { getCrisisUniverse } = require('./crisis-mode');

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

function isCryptoSymbol(symbol) {
  return /\/USD$/i.test(toText(symbol));
}

function derivePrimaryDataSource(payload = {}) {
  const explicit = toText(payload.primaryDataSource || payload.executionVenue || null).toLowerCase();
  if (explicit) return explicit;
  const symbols = Array.isArray(payload.symbols) ? payload.symbols : [];
  if (symbols.some((symbol) => isCryptoSymbol(symbol))) {
    return 'hyperliquid';
  }
  return 'alpaca_paper';
}

function buildHyperliquidAccount(serializedAccountSnapshot = null, serializedDefiStatus = null) {
  const explicitAccount = serializeMap(serializedAccountSnapshot?.markets?.hyperliquid || null);
  if (explicitAccount) {
    return explicitAccount;
  }

  const accountValue = toNumber(serializedDefiStatus?.accountValue, NaN);
  const withdrawable = toNumber(serializedDefiStatus?.withdrawable, NaN);
  const totalMarginUsed = toNumber(serializedDefiStatus?.totalMarginUsed, NaN);
  if (!Number.isFinite(accountValue) && !Number.isFinite(withdrawable) && !Number.isFinite(totalMarginUsed)) {
    return null;
  }

  return {
    equity: Number.isFinite(accountValue) ? accountValue : 0,
    cash: Number.isFinite(withdrawable) ? withdrawable : 0,
    liquidCapital: Number.isFinite(withdrawable) ? withdrawable : 0,
    marketValue: Number.isFinite(totalMarginUsed) ? totalMarginUsed : 0,
    walletAddress: toText(serializedDefiStatus?.walletAddress, null),
  };
}

function buildLiveTradingContext(payload = {}, serializedAccountSnapshot = null, serializedDefiStatus = null, serializedWarnings = []) {
  const hyperliquidAccount = buildHyperliquidAccount(serializedAccountSnapshot, serializedDefiStatus);
  const positions = Array.isArray(serializedDefiStatus?.positions) ? serializedDefiStatus.positions : [];
  return {
    venue: 'hyperliquid',
    isPrimary: derivePrimaryDataSource(payload) === 'hyperliquid',
    checkedAt: toIsoTimestamp(serializedDefiStatus?.checkedAt, null),
    positions,
    warnings: Array.isArray(serializedWarnings) ? serializedWarnings : [],
    account: hyperliquidAccount || null,
  };
}

function buildPaperTradingContext(payload = {}, serializedAccountSnapshot = null) {
  if (derivePrimaryDataSource(payload) === 'hyperliquid') {
    return null;
  }
  const snapshots = serializeMap(payload.snapshots || {});
  const bars = serializeMap(payload.bars || {});
  const news = serializeMap(payload.news || []);
  const paperAccount = serializeMap(
    serializedAccountSnapshot?.markets?.alpaca_stocks
    || serializedAccountSnapshot?.markets?.alpaca_crypto
    || serializedAccountSnapshot
    || null
  );
  return {
    venue: 'alpaca_paper',
    isSecondary: derivePrimaryDataSource(payload) === 'hyperliquid',
    snapshots,
    bars,
    news,
    account: paperAccount || null,
  };
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
  const serializedSnapshots = serializeMap(payload.snapshots || {});
  const serializedBars = serializeMap(payload.bars || {});
  const serializedNews = serializeMap(payload.news || []);
  const serializedAccountSnapshot = serializeMap(payload.accountSnapshot || null);
  const serializedDefiStatus = serializeMap(payload.defiStatus || null);
  const serializedWarnings = serializeMap(payload.consultationWarnings || []);
  const serializedWhaleData = serializeMap(payload.whaleData || null);
  const serializedCryptoMechBoard = serializeMap(payload.cryptoMechBoard || null);
  const serializedEventVeto = serializeMap(payload.eventVeto || null);
  const serializedPositionManagementContext = serializeMap(payload.positionManagementContext || null);
  const primaryDataSource = derivePrimaryDataSource(payload);

  return {
    requestId,
    createdAt,
    deadline,
    timeoutMs: deadlineMs,
    symbols: Array.isArray(payload.symbols) ? payload.symbols.map((symbol) => toText(symbol).toUpperCase()).filter(Boolean) : [],
    primaryDataSource,
    executionVenue: primaryDataSource,
    liveTradingContext: buildLiveTradingContext(payload, serializedAccountSnapshot, serializedDefiStatus, serializedWarnings),
    paperTradingContext: buildPaperTradingContext(payload, serializedAccountSnapshot),
    snapshots: serializedSnapshots,
    bars: serializedBars,
    news: serializedNews,
    accountSnapshot: serializedAccountSnapshot,
    macroRisk: serializeMap(payload.macroRisk || null),
    strategyMode: toText(payload.strategyMode || payload.macroRisk?.strategyMode || null).toLowerCase() || null,
    brokerCapabilities: serializeMap(payload.brokerCapabilities || null),
    whaleData: serializedWhaleData,
    cryptoMechBoard: serializedCryptoMechBoard,
    eventVeto: serializedEventVeto,
    positionManagementContext: serializedPositionManagementContext,
    defiStatus: serializedDefiStatus,
    consultationWarnings: serializedWarnings,
    taskType: toText(payload.taskType || (Array.isArray(payload?.defiStatus?.positions) && payload.defiStatus.positions.length > 0 ? 'position_management' : 'new_signal')).toLowerCase() || 'new_signal',
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

function isConsultationPromptBody(rawBody = '') {
  const text = stripMessagePrefix(rawBody);
  if (!text) return false;
  return /reply via hm-send architect with json containing a signal for every symbol:/i.test(text)
    || /analyze all \d+ symbols in consultation request /i.test(text)
    || /crisis consultation for .*: what should we short or hedge\?/i.test(text);
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
  const strategyMode = toText(request.strategyMode || request?.macroRisk?.strategyMode || null).toLowerCase();
  const taskType = toText(request.taskType || 'new_signal').toLowerCase();
  const crisisUniverse = getCrisisUniverse(request?.macroRisk || request);
  const executableCrisisBuys = Array.isArray(request?.brokerCapabilities?.supportedUniverse)
    ? request.brokerCapabilities.supportedUniverse
    : [];
  const sampleSignals = symbols.slice(0, 2).map((ticker) => (
    {
      ticker,
      direction: strategyMode === 'crisis'
        ? 'BUY'
        : (request?.macroRisk?.constraints?.allowLongs === false ? 'HOLD' : 'BUY'),
      confidence: strategyMode === 'crisis'
        ? 0.76
        : (request?.macroRisk?.constraints?.allowLongs === false ? 0.83 : 0.72),
      reasoning: '...'
    }
  ));
  if (sampleSignals.length === 0) {
    sampleSignals.push({ ticker: 'BTC/USD', direction: 'BUY', confidence: 0.72, reasoning: '...' });
  }
  const sample = JSON.stringify({
    requestId: request.requestId,
    agentId: targetRole,
    signals: sampleSignals,
  });

  const macroRisk = request?.macroRisk || null;
  const consultationWarnings = Array.isArray(request?.consultationWarnings) ? request.consultationWarnings : [];
  const defiStatus = request?.defiStatus || null;
  const primaryDataSource = derivePrimaryDataSource(request);
  const liveTradingContext = request?.liveTradingContext || null;
  const paperTradingContext = request?.paperTradingContext || null;
  const cryptoMechBoard = request?.cryptoMechBoard || null;
  const eventVeto = request?.eventVeto || null;
  const positionManagementContext = request?.positionManagementContext || null;
  const primaryVenueInstruction = primaryDataSource === 'hyperliquid'
    ? 'Primary live-trading venue is Hyperliquid. Base the consultation on liveTradingContext plus the attached crypto market snapshots/bars.'
    : 'Primary venue is paper trading. Use the paperTradingContext as your main market snapshot.';
  const defiInstruction = defiStatus?.positions?.length
    ? `Live Hyperliquid positions are included in the request JSON (${defiStatus.positions.length} open). Factor them into your signal reasoning before considering any new idea.`
    : '';
  const liveAccountInstruction = liveTradingContext?.account
    ? 'Live Hyperliquid account state is included in liveTradingContext.account.'
    : '';
  const mechanicalInstruction = primaryDataSource === 'hyperliquid'
    && cryptoMechBoard?.symbols
    && Object.keys(cryptoMechBoard.symbols).length > 0
    ? 'A per-symbol mechanical crypto scorecard is included in the request JSON under cryptoMechBoard (funding, open interest, whale flow, squeeze risk, overcrowding, cascade risk, and trade/watch/no-trade flag).'
    : '';
  const eventVetoInstruction = eventVeto?.decision
    ? `A compact event veto is included in eventVeto with ${toText(eventVeto.decision).toUpperCase()} / source tier / staleness / affected assets. Treat it as a brake, not a narrative engine.`
    : '';
  const positionManagementInstruction = taskType === 'position_management' && positionManagementContext
    ? 'The request JSON includes positionManagementContext built from position_management(portfolio_state, market_context, risk_state). Use it to decide hold/add/reduce/close/tighten-stop thesis management for existing positions.'
    : '';
  const paperContextInstruction = primaryDataSource !== 'hyperliquid'
    && paperTradingContext?.snapshots
    && Object.keys(paperTradingContext.snapshots).length > 0
    ? 'Paper Alpaca snapshots/bars/news are still included for secondary confirmation and backtesting context.'
    : '';
  const warningInstruction = consultationWarnings.length > 0
    ? `WARNING: ${consultationWarnings.map((warning) => toText(warning?.message)).filter(Boolean).join(' ')}`
    : '';
  const macroInstruction = strategyMode === 'crisis'
    ? `Live macro regime: ${toText(macroRisk?.regime).toUpperCase()} with strategy mode CRISIS (score ${toNumber(macroRisk?.score, 0)}). ${toText(macroRisk?.reason)}`
    : (macroRisk
      ? `Live macro regime: ${toText(macroRisk.regime).toUpperCase()} (score ${toNumber(macroRisk.score, 0)}). ${toText(macroRisk.reason)} ${macroRisk?.constraints?.allowLongs === false ? 'Do not emit BUY signals under this regime. Use HOLD or defensive SELL only.' : 'Scale any BUY confidence by the current macro regime before replying.'}`
      : '');

  if (strategyMode === 'crisis') {
    return [
      `Crisis consultation for ${request.requestId}: what should we short or hedge?`,
      `Use the crisis universe only: ${crisisUniverse.join(', ')}.`,
      `Phase 1 executable path is BUY-side only, so prefer BUY ideas on tradable inverse ETFs / crisis longs first. Executable BUY universe from broker capabilities: ${executableCrisisBuys.join(', ') || 'none provided'}.`,
      'SHORT, COVER, and BUY_PUT are valid signal directions for analysis, but they are not executable in Phase 1.',
      `Market context and broker capabilities are in ${relativePath} (${requestPath}).`,
      primaryVenueInstruction,
      defiInstruction,
      liveAccountInstruction,
      mechanicalInstruction,
      eventVetoInstruction,
      paperContextInstruction,
      warningInstruction,
      macroInstruction,
      `Reply via hm-send architect with JSON containing a signal for EVERY symbol: ${sample}`,
      `Deadline: ${deadline}.`,
      'Use your normal role prefix if needed, but keep the JSON itself valid and complete. Include all symbols, not just the examples shown.',
    ].filter(Boolean).join(' ');
  }

  return [
    `Analyze ALL ${symbols.length} symbols in consultation request ${request.requestId}: ${symbols.join(', ')}.`,
    taskType === 'position_management'
      ? 'Task type: position_management. Prioritize protecting and managing existing live positions over new entries.'
      : 'Task type: new_signal.',
    `Market context at ${relativePath} (${requestPath}).`,
    primaryVenueInstruction,
    defiInstruction,
    liveAccountInstruction,
    mechanicalInstruction,
    eventVetoInstruction,
    positionManagementInstruction,
    paperContextInstruction,
    warningInstruction,
    macroInstruction,
    `Reply via hm-send architect with JSON containing a signal for EVERY symbol: ${sample}`,
    `Deadline: ${deadline}.`,
    'Use your normal role prefix if needed, but keep the JSON itself valid and complete. Include all symbols, not just the examples shown.',
  ].filter(Boolean).join(' ');
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
  const minResponses = Math.min(
    agentIds.length,
    Math.max(
      1,
      Math.floor(toNumber(options.minResponses, agentIds.length))
    )
  );
  const responses = new Map();
  const errors = [];

  while (Date.now() <= deadlineMs && responses.size < minResponses) {
    for (const agentId of agentIds) {
      if (responses.has(agentId)) continue;
      const entries = queryEntries({
        channel: 'ws',
        direction: 'outbound',
        senderRole: agentId,
        targetRole: 'architect',
        sinceMs: requestCreatedAtMs,
        order: 'desc',
        limit: 100,
      }, { dbPath: options.dbPath || null });

      for (const entry of entries) {
        const rawBody = entry.rawBody || entry.body || '';
        if (isConsultationPromptBody(rawBody)) {
          continue;
        }
        const parsed = parseConsultationResponseBody(rawBody);
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

    if (responses.size >= minResponses || Date.now() > deadlineMs) {
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
