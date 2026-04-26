'use strict';

const fs = require('fs');
const path = require('path');
const { queryCommsJournalEntries } = require('../main/comms-journal');

const AGENT_IDS = Object.freeze(['architect', 'builder', 'oracle']);
const CORE_TICKERS = Object.freeze(['BTC/USD', 'ETH/USD', 'SOL/USD']);
const DEFAULT_TIMER_INTERVAL_MINUTES = Object.freeze({
  architect: 10,
  builder: 15,
  oracle: 5,
});
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_DRAIN_POLL_MS = 100;
const DEFAULT_SHUTDOWN_FENCE_TTL_MS = 60_000;
const SHUTDOWN_ABORT_MARKER = 'aborted:shutdown';

function toText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function appendJsonLine(filePath, payload) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function bestEffortAppendJsonLine(filePath, payload) {
  try {
    appendJsonLine(filePath, payload);
    return true;
  } catch {
    return false;
  }
}

function normalizeTicker(value) {
  const raw = toText(value).toUpperCase().replace('-', '/');
  if (!raw) return '';
  if (raw.includes('/')) return raw;
  return `${raw}/USD`;
}

function normalizeSide(value) {
  const text = toText(value).toUpperCase();
  if (text === 'LONG' || text === 'BUY') return 'LONG';
  if (text === 'SHORT' || text === 'SELL') return 'SHORT';
  return '';
}

function stripMessagePrefix(rawBody = '') {
  return String(rawBody || '')
    .replace(/^\s*\[AGENT MSG - reply via hm-send\.js\]\s*/i, '')
    .replace(/^\([^)]*\):\s*/, '')
    .trim();
}

function normalizeMark(mark = {}) {
  return {
    markedAt: toText(mark.markedAt || mark.time || new Date().toISOString()),
    equity: round(toNumber(mark.equity, 0), 2),
    cashBalance: round(toNumber(mark.cashBalance, 0), 2),
    realizedPnl: round(toNumber(mark.realizedPnl, 0), 2),
    unrealizedPnl: round(toNumber(mark.unrealizedPnl, 0), 2),
    totalPnl: round(toNumber(mark.totalPnl, 0), 2),
    openPositionCount: Math.max(0, Math.floor(toNumber(mark.openPositionCount, 0))),
    notes: Array.isArray(mark.notes) ? mark.notes.map((entry) => toText(entry)).filter(Boolean) : [],
  };
}

function normalizePosition(position = {}) {
  const ticker = normalizeTicker(position.ticker || position.symbol);
  const side = normalizeSide(position.side || position.direction);
  const entryPrice = toNumber(position.entryPrice ?? position.entry, 0);
  const currentPrice = toNumber(position.currentPrice ?? position.markPrice ?? entryPrice, entryPrice);
  const size = toNumber(position.size, 0);
  const marginUsedUsd = toNumber(position.marginUsedUsd ?? position.marginUsed, 0);
  const leverage = Math.max(0, toNumber(position.leverage, 0));
  const notionalUsd = toNumber(position.notionalUsd ?? position.notional, marginUsedUsd * leverage);
  return {
    id: toText(position.id || `${ticker}-${side}-${Date.now()}`),
    ticker,
    symbol: ticker.split('/')[0],
    side,
    direction: side,
    entryPrice,
    entry: entryPrice,
    currentPrice,
    size,
    notionalUsd: round(notionalUsd, 2),
    notional: round(notionalUsd, 2),
    marginUsedUsd: round(marginUsedUsd, 2),
    marginUsed: round(marginUsedUsd, 2),
    leverage,
    openedAt: toText(position.openedAt || new Date().toISOString()),
    stopLoss: toNumber(position.stopLoss ?? position.stop, 0) || null,
    stop: toNumber(position.stopLoss ?? position.stop, 0) || null,
    takeProfit: toNumber(position.takeProfit ?? position.tp1, 0) || null,
    tp1: toNumber(position.takeProfit ?? position.tp1, 0) || null,
    tp2: toNumber(position.tp2, 0) || null,
    unrealizedPnl: round(toNumber(position.unrealizedPnl, 0), 2),
    status: toText(position.status || 'OPEN'),
    thesis: toText(position.thesis || position.reason || ''),
    reason: toText(position.reason || position.thesis || ''),
    notes: Array.isArray(position.notes) ? position.notes.map((entry) => toText(entry)).filter(Boolean) : [],
    timeStop: position.timeStop || null,
    stopDeclaration: position.stopDeclaration || null,
    noStopDeclaration: position.noStopDeclaration || null,
  };
}

function normalizeClosedTrade(trade = {}) {
  const ticker = normalizeTicker(trade.ticker || trade.symbol);
  const side = normalizeSide(trade.side || trade.direction);
  const entryPrice = toNumber(trade.entryPrice ?? trade.entry, 0);
  const exitPrice = toNumber(trade.exitPrice ?? trade.exit, 0);
  const marginUsedUsd = toNumber(trade.marginUsedUsd ?? trade.marginUsed, 0);
  const leverage = Math.max(0, toNumber(trade.leverage, 0));
  const notionalUsd = toNumber(trade.notionalUsd ?? trade.notional, marginUsedUsd * leverage);
  return {
    id: toText(trade.id || `${ticker}-${side}-${Date.now()}`),
    ticker,
    symbol: ticker.split('/')[0],
    side,
    direction: side,
    entryPrice,
    entry: entryPrice,
    exitPrice,
    exit: exitPrice,
    size: toNumber(trade.size, 0),
    notionalUsd: round(notionalUsd, 2),
    notional: round(notionalUsd, 2),
    marginUsedUsd: round(marginUsedUsd, 2),
    marginUsed: round(marginUsedUsd, 2),
    leverage,
    openedAt: toText(trade.openedAt || new Date().toISOString()),
    closedAt: toText(trade.closedAt || new Date().toISOString()),
    stopLoss: toNumber(trade.stopLoss ?? trade.stop, 0) || null,
    stop: toNumber(trade.stopLoss ?? trade.stop, 0) || null,
    takeProfit: toNumber(trade.takeProfit ?? trade.tp1, 0) || null,
    tp1: toNumber(trade.takeProfit ?? trade.tp1, 0) || null,
    realizedPnl: round(toNumber(trade.realizedPnl, 0), 2),
    status: 'CLOSED',
    exitReason: toText(trade.exitReason || trade.reason || ''),
    thesis: toText(trade.thesis || trade.reason || ''),
    reason: toText(trade.reason || trade.thesis || ''),
    rootCauseReview: trade.rootCauseReview || null,
    notes: Array.isArray(trade.notes) ? trade.notes.map((entry) => toText(entry)).filter(Boolean) : [],
    timeStop: trade.timeStop || null,
    stopDeclaration: trade.stopDeclaration || null,
    noStopDeclaration: trade.noStopDeclaration || null,
  };
}

function normalizePortfolio(raw = {}, fallbackAgentId = 'unknown') {
  const agentId = toText(raw.agentId || raw.agent, fallbackAgentId).toLowerCase();
  const startingBalance = round(toNumber(raw.startingBalance, 500), 2);
  const openPositions = (Array.isArray(raw.openPositions) ? raw.openPositions : []).map(normalizePosition);
  const closedTrades = (Array.isArray(raw.closedTrades) ? raw.closedTrades : []).map(normalizeClosedTrade);
  const hourlyMarks = (Array.isArray(raw.hourlyMarks) ? raw.hourlyMarks : []).map(normalizeMark);
  const realizedPnl = round(
    toNumber(
      raw.realizedPnl,
      closedTrades.reduce((sum, trade) => sum + toNumber(trade.realizedPnl, 0), 0)
    ),
    2
  );
  const cashBalance = round(toNumber(raw.cashBalance, raw.currentEquity ?? raw.equity ?? startingBalance), 2);
  const unrealizedPnl = round(toNumber(raw.unrealizedPnl, 0), 2);
  const equity = round(toNumber(raw.equity ?? raw.currentEquity, cashBalance + unrealizedPnl), 2);
  return {
    schemaVersion: 1,
    competition: toText(raw.competition, 'agent-trading-competition'),
    agentId,
    agent: agentId,
    venue: toText(raw.venue, 'hyperliquid-paper'),
    baseCurrency: toText(raw.baseCurrency, 'USD'),
    startedAt: toText(raw.startedAt, raw.lastUpdatedAt || new Date().toISOString()),
    startingBalance,
    cashBalance,
    equity,
    currentEquity: equity,
    realizedPnl,
    unrealizedPnl,
    totalPnl: round(realizedPnl + unrealizedPnl, 2),
    lastUpdatedAt: toText(raw.lastUpdatedAt, new Date().toISOString()),
    strategy: raw.strategy || null,
    riskRules: raw.riskRules || null,
    openPositions,
    closedTrades,
    hourlyMarks,
    notes: Array.isArray(raw.notes) ? raw.notes.map((entry) => toText(entry)).filter(Boolean) : [],
  };
}

function serializePortfolio(portfolio = {}, previousRaw = {}) {
  return {
    ...previousRaw,
    schemaVersion: 1,
    competition: portfolio.competition,
    agentId: portfolio.agentId,
    agent: portfolio.agentId,
    venue: portfolio.venue,
    baseCurrency: portfolio.baseCurrency,
    startedAt: portfolio.startedAt,
    startingBalance: round(portfolio.startingBalance, 2),
    cashBalance: round(portfolio.cashBalance, 2),
    equity: round(portfolio.equity, 2),
    currentEquity: round(portfolio.equity, 2),
    realizedPnl: round(portfolio.realizedPnl, 2),
    unrealizedPnl: round(portfolio.unrealizedPnl, 2),
    totalPnl: round(portfolio.totalPnl, 2),
    lastUpdatedAt: portfolio.lastUpdatedAt,
    strategy: portfolio.strategy || previousRaw.strategy || null,
    riskRules: portfolio.riskRules || previousRaw.riskRules || null,
    openPositions: portfolio.openPositions,
    closedTrades: portfolio.closedTrades,
    hourlyMarks: portfolio.hourlyMarks,
    notes: Array.isArray(portfolio.notes) ? portfolio.notes : (Array.isArray(previousRaw.notes) ? previousRaw.notes : []),
  };
}

function getPortfolioPaths(projectRoot, agentId) {
  const dir = path.join(projectRoot, 'workspace', 'agent-trading');
  return {
    dir,
    portfolioPath: path.join(dir, `${agentId}-portfolio.json`),
    triggerConfigPath: path.join(dir, `${agentId}-triggers.json`),
    auditLogPath: path.join(dir, 'paper-trading-actions.jsonl'),
    requestDir: path.join(projectRoot, '.squidrun', 'runtime', 'paper-trading-requests'),
    responseDir: path.join(projectRoot, '.squidrun', 'runtime', 'paper-trading-responses'),
  };
}

function getRuntimeDir(projectRoot) {
  return path.join(projectRoot, '.squidrun', 'runtime');
}

function getPaperTradingAutomationStatePath(projectRoot) {
  return path.join(getRuntimeDir(projectRoot), 'paper-trading-automation-state.json');
}

function getShutdownFencePath(projectRoot) {
  return path.join(getRuntimeDir(projectRoot), 'paper-trading-shutdown-fence.json');
}

function normalizeAutomationAgentState(agentId, raw = {}) {
  return {
    agentId,
    lastDispatchAt: toText(raw.lastDispatchAt, null),
    lastDispatchAtMs: Math.max(0, Math.floor(toNumber(raw.lastDispatchAtMs, 0))),
    nextTimerWakeAt: toText(raw.nextTimerWakeAt, null),
    nextTimerWakeAtMs: Math.max(0, Math.floor(toNumber(raw.nextTimerWakeAtMs, 0))),
    pendingRequestId: toText(raw.pendingRequestId, null),
    pendingRequestCreatedAt: toText(raw.pendingRequestCreatedAt, null),
    pendingRequestCreatedAtMs: Math.max(0, Math.floor(toNumber(raw.pendingRequestCreatedAtMs, 0))),
    lastResponseAt: toText(raw.lastResponseAt, null),
    lastResponseAtMs: Math.max(0, Math.floor(toNumber(raw.lastResponseAtMs, 0))),
    lastWakeReason: toText(raw.lastWakeReason, null),
    lastActionType: toText(raw.lastActionType, null),
    lastError: toText(raw.lastError, null),
  };
}

function normalizeAutomationState(raw = {}) {
  const agents = {};
  for (const agentId of AGENT_IDS) {
    agents[agentId] = normalizeAutomationAgentState(agentId, raw?.agents?.[agentId] || {});
  }
  return {
    updatedAt: toText(raw.updatedAt, null),
    lastProcessedAt: toText(raw.lastProcessedAt, null),
    lastSummary: raw?.lastSummary && typeof raw.lastSummary === 'object' ? raw.lastSummary : null,
    agents,
  };
}

function readAutomationState(projectRoot, options = {}) {
  const statePath = toText(options.statePath, getPaperTradingAutomationStatePath(projectRoot));
  const raw = readJson(statePath, {});
  return {
    path: statePath,
    raw,
    normalized: normalizeAutomationState(raw || {}),
  };
}

function writeAutomationState(statePath, state = {}) {
  writeJson(statePath, normalizeAutomationState(state));
}

function writeShutdownFence(projectRoot, options = {}) {
  const timeoutMs = Math.max(0, Math.floor(toNumber(options.timeoutMs, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS)));
  const ttlMs = Math.max(timeoutMs, Math.floor(toNumber(options.ttlMs, DEFAULT_SHUTDOWN_FENCE_TTL_MS)));
  const createdAt = toText(options.createdAt, new Date().toISOString());
  const payload = {
    active: true,
    reason: toText(options.reason, 'shutdown'),
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
    timeoutMs,
    ttlMs,
  };
  const fencePath = getShutdownFencePath(projectRoot);
  writeJson(fencePath, payload);
  return {
    path: fencePath,
    payload,
  };
}

function readShutdownFence(projectRoot) {
  const fencePath = getShutdownFencePath(projectRoot);
  return {
    path: fencePath,
    payload: readJson(fencePath, null),
  };
}

function isShutdownFenceActive(projectRoot, options = {}) {
  const nowMs = Number(options.nowMs || Date.now()) || Date.now();
  const ttlMs = Math.max(0, Math.floor(toNumber(options.ttlMs, DEFAULT_SHUTDOWN_FENCE_TTL_MS)));
  const { payload } = readShutdownFence(projectRoot);
  if (!payload || payload.active !== true) return false;
  const createdAtMs = Date.parse(payload.createdAt || '') || 0;
  const expiresAtMs = Date.parse(payload.expiresAt || '') || (createdAtMs > 0 ? createdAtMs + ttlMs : 0);
  if (!(expiresAtMs > 0)) return false;
  return nowMs <= expiresAtMs;
}

function clearShutdownFence(projectRoot) {
  const fencePath = getShutdownFencePath(projectRoot);
  try {
    fs.unlinkSync(fencePath);
    return { ok: true, path: fencePath, cleared: true };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, path: fencePath, cleared: false, skipped: true };
    }
    return { ok: false, path: fencePath, error: error?.message || String(error) };
  }
}

function defaultTriggerConfig(agentId = 'builder', overrides = {}) {
  const normalizedAgentId = toText(agentId, 'builder').toLowerCase();
  const intervalMinutes = Math.max(
    1,
    Math.floor(
      Number(overrides?.timer?.intervalMinutes)
      || Number(overrides?.timerIntervalMinutes)
      || Number(DEFAULT_TIMER_INTERVAL_MINUTES[normalizedAgentId] || 15)
    )
  );
  return {
    version: 1,
    agentId: normalizedAgentId,
    enabled: overrides?.enabled !== false,
    timer: {
      enabled: overrides?.timer?.enabled !== false,
      intervalMinutes,
    },
    eventTriggers: Array.isArray(overrides?.eventTriggers) ? overrides.eventTriggers : [],
    wakeConditions: {
      anyOf: Array.isArray(overrides?.wakeConditions?.anyOf) && overrides.wakeConditions.anyOf.length > 0
        ? overrides.wakeConditions.anyOf.map((entry) => toText(entry).toLowerCase()).filter(Boolean)
        : ['timer'],
    },
    notes: Array.isArray(overrides?.notes) ? overrides.notes.map((entry) => toText(entry)).filter(Boolean) : [],
  };
}

function normalizeTriggerConfig(config = {}, agentId = 'builder') {
  const normalizedAgentId = toText(config.agentId || agentId, agentId).toLowerCase();
  const defaults = defaultTriggerConfig(normalizedAgentId, config);
  const eventTriggers = Array.isArray(config.eventTriggers) ? config.eventTriggers : defaults.eventTriggers;
  return {
    version: 1,
    agentId: normalizedAgentId,
    enabled: config.enabled !== false,
    timer: {
      enabled: config?.timer?.enabled !== false,
      intervalMinutes: Math.max(
        1,
        Math.floor(
          Number(config?.timer?.intervalMinutes)
          || Number(config?.timerIntervalMinutes)
          || Number(defaults.timer.intervalMinutes)
        )
      ),
    },
    eventTriggers: eventTriggers.map((trigger, index) => ({
      id: toText(trigger?.id, `${normalizedAgentId}-event-${index + 1}`),
      type: toText(trigger?.type || trigger?.trigger, 'custom').toLowerCase(),
      enabled: trigger?.enabled !== false,
      description: toText(trigger?.description || trigger?.label || trigger?.name),
      payload: trigger?.payload && typeof trigger.payload === 'object' ? trigger.payload : {},
    })),
    wakeConditions: {
      anyOf: Array.isArray(config?.wakeConditions?.anyOf) && config.wakeConditions.anyOf.length > 0
        ? config.wakeConditions.anyOf.map((entry) => toText(entry).toLowerCase()).filter(Boolean)
        : defaults.wakeConditions.anyOf,
    },
    notes: Array.isArray(config?.notes) ? config.notes.map((entry) => toText(entry)).filter(Boolean) : defaults.notes,
  };
}

function loadTriggerConfig(projectRoot, agentId, options = {}) {
  const paths = getPortfolioPaths(projectRoot, agentId);
  const raw = readJson(paths.triggerConfigPath, null);
  const normalized = normalizeTriggerConfig(raw || {}, agentId);
  if ((!raw || options.writeDefaults === true) && normalized.enabled !== false) {
    writeJson(paths.triggerConfigPath, normalized);
  }
  return {
    paths,
    raw: raw || normalized,
    normalized,
  };
}

function computeNextTimerWakeMs(referenceMs, intervalMinutes) {
  const intervalMs = Math.max(60_000, Math.floor(Number(intervalMinutes) || 1) * 60_000);
  return Number(referenceMs || Date.now()) + intervalMs;
}

function evaluateWakeCondition(triggerConfig = {}, agentState = {}, nowMs = Date.now()) {
  const config = normalizeTriggerConfig(triggerConfig, triggerConfig?.agentId || agentState?.agentId || 'builder');
  const lastDispatchAtMs = Number(agentState?.lastDispatchAtMs || 0) || 0;
  const nextTimerWakeAtMs = Number(agentState?.nextTimerWakeAtMs || 0) || 0;
  if (config.enabled !== true) {
    return {
      shouldWake: false,
      wakeReason: 'disabled',
      nextTimerWakeAtMs,
      triggerConfig: config,
    };
  }
  const timerEnabled = config?.timer?.enabled !== false && config.wakeConditions.anyOf.includes('timer');
  if (timerEnabled) {
    const effectiveNextWakeAtMs = nextTimerWakeAtMs > 0
      ? nextTimerWakeAtMs
      : computeNextTimerWakeMs(lastDispatchAtMs || (nowMs - (config.timer.intervalMinutes * 60_000)), config.timer.intervalMinutes);
    return {
      shouldWake: nowMs >= effectiveNextWakeAtMs,
      wakeReason: 'timer_cycle',
      nextTimerWakeAtMs: effectiveNextWakeAtMs,
      triggerConfig: config,
    };
  }
  return {
    shouldWake: false,
    wakeReason: 'no_supported_trigger',
    nextTimerWakeAtMs,
    triggerConfig: config,
  };
}

function readPortfolio(projectRoot, agentId) {
  const paths = getPortfolioPaths(projectRoot, agentId);
  const raw = readJson(paths.portfolioPath, {});
  return {
    paths,
    raw,
    normalized: normalizePortfolio(raw, agentId),
  };
}

function writePortfolio(projectRoot, agentId, portfolio, previousRaw = {}) {
  const paths = getPortfolioPaths(projectRoot, agentId);
  const payload = serializePortfolio(portfolio, previousRaw);
  writeJson(paths.portfolioPath, payload);
  return {
    path: paths.portfolioPath,
    payload,
  };
}

function commitPortfolioMutation(projectRoot, options = {}) {
  const agentId = toText(options.agentId).toLowerCase();
  if (!agentId) throw new Error('agentId is required for commitPortfolioMutation.');
  const paths = getPortfolioPaths(projectRoot, agentId);
  const previousRaw = options.previousRaw || {};
  const payload = serializePortfolio(options.portfolio || {}, previousRaw);
  const transactionId = toText(
    options.transactionId,
    `${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  const nowIso = toText(options.now, new Date().toISOString());
  const auditLogPath = paths.auditLogPath;
  const tempPortfolioPath = `${paths.portfolioPath}.${transactionId}.tmp`;
  const pendingEntry = {
    kind: 'paper_trading_mutation_pending',
    status: 'pending',
    transactionId,
    createdAt: nowIso,
    ...(options.pendingAudit || {}),
  };

  appendJsonLine(auditLogPath, pendingEntry);

  try {
    if (typeof options.beforePortfolioWrite === 'function') {
      options.beforePortfolioWrite();
    }
    writeJson(tempPortfolioPath, payload);
    fs.renameSync(tempPortfolioPath, paths.portfolioPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPortfolioPath)) {
        fs.unlinkSync(tempPortfolioPath);
      }
    } catch {
      // Ignore temp cleanup failures; the pending/aborted audit trail is the important recovery signal.
    }
    bestEffortAppendJsonLine(auditLogPath, {
      kind: 'paper_trading_mutation_aborted',
      status: 'aborted',
      transactionId,
      failedAt: new Date().toISOString(),
      error: error?.message || String(error),
      ...Object.fromEntries(
        Object.entries(options.pendingAudit || {}).filter(([key]) => !['kind', 'status', 'createdAt'].includes(key))
      ),
      ...(options.abortAudit || {}),
    });
    throw error;
  }

  const committedEntry = {
    status: 'committed',
    transactionId,
    committedAt: new Date().toISOString(),
    ...(options.committedAudit || {}),
  };
  let committedAuditOk = true;
  let committedAuditError = null;
  try {
    appendJsonLine(auditLogPath, committedEntry);
  } catch (error) {
    committedAuditOk = false;
    committedAuditError = error;
  }

  return {
    ok: true,
    path: paths.portfolioPath,
    payload,
    transactionId,
    pendingEntry,
    committedEntry: committedAuditOk ? committedEntry : null,
    committedAuditOk,
    committedAuditError,
    auditLogPath,
  };
}

function summarizeStructure(entry = {}) {
  const bars5m = Array.isArray(entry?.bars5m) ? entry.bars5m : [];
  const latest = bars5m.length > 0 ? bars5m[bars5m.length - 1] : null;
  const previous = bars5m.length > 1 ? bars5m[bars5m.length - 2] : null;
  const latestClose = toNumber(latest?.close, toNumber(entry?.price, 0));
  const previousClose = toNumber(previous?.close, latestClose);
  const changePct = previousClose > 0 ? ((latestClose - previousClose) / previousClose) * 100 : 0;
  return {
    ticker: normalizeTicker(entry?.ticker),
    price: round(toNumber(entry?.price, latestClose), 6),
    latest5m: latest ? {
      open: round(toNumber(latest.open, 0), 6),
      high: round(toNumber(latest.high, 0), 6),
      low: round(toNumber(latest.low, 0), 6),
      close: round(toNumber(latest.close, 0), 6),
    } : null,
    recent5mCloses: bars5m.slice(-3).map((bar) => round(toNumber(bar?.close, 0), 6)),
    trend: changePct > 0.1 ? 'up' : (changePct < -0.1 ? 'down' : 'flat'),
    changePct5m: round(changePct, 3),
  };
}

function buildPaperCompetitionSnapshot(portfolios = []) {
  return portfolios.map((portfolio) => ({
    agentId: portfolio.agentId,
    totalPnl: round(portfolio.totalPnl, 2),
    realizedPnl: round(portfolio.realizedPnl, 2),
    unrealizedPnl: round(portfolio.unrealizedPnl, 2),
    openPositionCount: Array.isArray(portfolio.openPositions) ? portfolio.openPositions.length : 0,
  }));
}

function buildRequestPayload(agentId, options = {}) {
  const requestId = toText(options.requestId, `paper-cycle-${Date.now()}-${agentId}`);
  const portfolio = normalizePortfolio(options.portfolio || {}, agentId);
  const livePrices = Array.isArray(options.livePrices) ? options.livePrices : [];
  const structureSummary = Array.isArray(options.structureSummary) ? options.structureSummary : [];
  const snapshot = Array.isArray(options.competitionSnapshot) ? options.competitionSnapshot : [];
  return {
    requestId,
    agentId,
    wakeReason: toText(options.wakeReason, 'timer_cycle'),
    createdAt: toText(options.createdAt, new Date().toISOString()),
    deadline: toText(options.deadline, new Date(Date.now() + 90_000).toISOString()),
    livePrices,
    structureSummary,
    openPositions: portfolio.openPositions,
    pnl: {
      realized: round(portfolio.realizedPnl, 2),
      unrealized: round(portfolio.unrealizedPnl, 2),
      total: round(portfolio.totalPnl, 2),
      cashBalance: round(portfolio.cashBalance, 2),
      equity: round(portfolio.equity, 2),
    },
    competitionSnapshot: snapshot,
  };
}

function buildPrompt(request = {}, requestPath) {
  const sample = JSON.stringify({
    requestId: request.requestId,
    agentId: request.agentId,
    action: {
      type: 'hold',
      ticker: 'BTC/USD',
    },
    rationale: 'I am staying with the current plan because nothing in the tape has changed enough to justify a mutation.',
    stopDeclaration: {
      type: 'stop_loss',
      price: 74280,
      note: 'Hard stop under the invalidation level.',
    },
    timeStop: {
      minutes: 30,
      note: 'Exit if the move stays dead for 30 minutes.',
    },
  });
  const relativePath = requestPath.replace(/\\/g, '/');
  return [
    `Paper trading cycle ${request.requestId} for ${request.agentId}.`,
    `Context JSON is at ${relativePath}.`,
    'This prompt is style-agnostic. Use your own method. The infrastructure only enforces honesty and explicit risk.',
    'Reply via hm-send builder with JSON only.',
    'Required fields:',
    '- requestId',
    '- agentId',
    '- action.type: hold | open | close | scale | hourly_mark',
    '- rationale: plain English, required',
    '- exactly one of stopDeclaration or noStopDeclaration',
    'Action field guidance:',
    '- hold/hourly_mark need no mutation fields',
    '- open needs ticker, side, marginUsd, leverage',
    '- close needs ticker and optional closePct',
    '- scale needs ticker plus direction add|reduce and size fields',
    `JSON sample: ${sample}`,
    `Deadline: ${request.deadline}.`,
    'Malformed replies missing rationale or stop/no-stop will be rejected and must wait until the next cycle.',
  ].join(' ');
}

function writeRequest(projectRoot, request = {}) {
  const paths = getPortfolioPaths(projectRoot, request.agentId);
  const requestPath = path.join(paths.requestDir, `${request.requestId}-${request.agentId}.json`);
  writeJson(requestPath, request);
  return requestPath;
}

function writeResponse(projectRoot, response = {}) {
  const paths = getPortfolioPaths(projectRoot, response.agentId);
  const responsePath = path.join(paths.responseDir, `${response.requestId}-${response.agentId}.json`);
  writeJson(responsePath, response);
  return responsePath;
}

function readResponse(projectRoot, requestId, agentId) {
  if (!requestId || !agentId) return null;
  const paths = getPortfolioPaths(projectRoot, agentId);
  const responsePath = path.join(paths.responseDir, `${requestId}-${agentId}.json`);
  const payload = readJson(responsePath, null);
  if (!payload) return null;
  return {
    path: responsePath,
    payload,
  };
}

function parsePaperTradingResponseBody(rawBody = '') {
  const text = stripMessagePrefix(rawBody);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }

  const risk = parsed?.risk && typeof parsed.risk === 'object' ? parsed.risk : {};
  const stopDeclaration = parsed.stopDeclaration || risk.stopDeclaration || null;
  const noStopDeclaration = parsed.noStopDeclaration || risk.noStopDeclaration || null;
  const response = {
    requestId: toText(parsed.requestId),
    agentId: toText(parsed.agentId).toLowerCase(),
    action: {
      type: toText(parsed?.action?.type).toLowerCase(),
      ticker: normalizeTicker(parsed?.action?.ticker),
      side: normalizeSide(parsed?.action?.side),
      direction: toText(parsed?.action?.direction).toLowerCase(),
      marginUsd: toNumber(parsed?.action?.marginUsd ?? parsed?.action?.sizeUsd, 0),
      leverage: toNumber(parsed?.action?.leverage, 0),
      closePct: clamp(toNumber(parsed?.action?.closePct ?? parsed?.action?.sizePct, 1), 0, 1),
      units: toNumber(parsed?.action?.units, 0),
      takeProfit: toNumber(parsed?.action?.takeProfit, 0) || null,
    },
    rationale: toText(parsed.rationale),
    stopDeclaration,
    noStopDeclaration,
    timeStop: parsed.timeStop || risk.timeStop || null,
    raw: parsed,
  };
  return response;
}

function collectPaperTradingAgentResponse(agentId, requestId, sinceMs = 0) {
  const entries = queryCommsJournalEntries({
    channel: 'ws',
    direction: 'outbound',
    senderRole: agentId,
    targetRole: 'builder',
    sinceMs,
    order: 'desc',
    limit: 100,
  });
  for (const entry of entries) {
    const rawBody = entry?.rawBody || entry?.body || '';
    const parsed = parsePaperTradingResponseBody(rawBody);
    if (!parsed) continue;
    if (parsed.requestId !== requestId) continue;
    if (parsed.agentId !== agentId) continue;
    return {
      entry,
      parsed,
    };
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.floor(ms))));
}

async function drainShutdownPendingCycles(projectRoot, options = {}) {
  const timeoutMs = Math.max(0, Math.floor(toNumber(options.timeoutMs, DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS)));
  const pollMs = Math.max(10, Math.floor(toNumber(options.pollMs, DEFAULT_SHUTDOWN_DRAIN_POLL_MS)));
  const hardDeadlineMs = Date.now() + timeoutMs;
  const statePath = toText(options.statePath, getPaperTradingAutomationStatePath(projectRoot));
  const result = {
    ok: true,
    statePath,
    timeoutMs,
    drained: true,
    pendingAtStart: 0,
    finalized: [],
    preserved: [],
    remaining: [],
  };

  while (true) {
    const stateResult = readAutomationState(projectRoot, { statePath });
    const nextState = normalizeAutomationState(stateResult.normalized);
    const pending = AGENT_IDS
      .map((agentId) => {
        const agentState = nextState.agents[agentId];
        const requestId = toText(agentState?.pendingRequestId, null);
        if (!requestId) return null;
        const requestPath = path.join(getPortfolioPaths(projectRoot, agentId).requestDir, `${requestId}-${agentId}.json`);
        const request = readJson(requestPath, null);
        const responseRecord = readResponse(projectRoot, requestId, agentId);
        const deadlineMs = Date.parse(request?.deadline || '')
          || (Math.max(0, Number(agentState?.pendingRequestCreatedAtMs || 0)) + 90_000);
        const capturedResponse = collectPaperTradingAgentResponse(
          agentId,
          requestId,
          Number(agentState?.pendingRequestCreatedAtMs || 0) || 0
        );
        return {
          agentId,
          requestId,
          requestPath,
          request,
          deadlineMs,
          responseRecord,
          capturedResponse,
        };
      })
      .filter(Boolean);

    if (result.pendingAtStart === 0) {
      result.pendingAtStart = pending.length;
    }
    if (pending.length === 0) {
      break;
    }

    const nowMs = Date.now();
    let changed = false;

    for (const entry of pending) {
      const agentState = nextState.agents[entry.agentId];
      if (entry.responseRecord?.payload) {
        nextState.agents[entry.agentId] = {
          ...agentState,
          pendingRequestId: null,
          pendingRequestCreatedAt: null,
          pendingRequestCreatedAtMs: 0,
          lastResponseAt: toText(entry.responseRecord.payload.receivedAt || new Date(nowMs).toISOString(), new Date(nowMs).toISOString()),
          lastResponseAtMs: nowMs,
          lastError: null,
        };
        result.preserved.push({
          agentId: entry.agentId,
          requestId: entry.requestId,
          disposition: 'response_recorded',
        });
        changed = true;
        continue;
      }

      const forceFinalize = nowMs >= hardDeadlineMs || (entry.deadlineMs > 0 && nowMs >= entry.deadlineMs);
      if (!forceFinalize) {
        continue;
      }

      const finalizedAt = new Date(nowMs).toISOString();
      writeResponse(projectRoot, {
        requestId: entry.requestId,
        agentId: entry.agentId,
        ok: false,
        status: SHUTDOWN_ABORT_MARKER,
        error: SHUTDOWN_ABORT_MARKER,
        aborted: true,
        finalizedAt,
        deadline: entry.request?.deadline || null,
        capturedResponse: entry.capturedResponse ? {
          receivedAt: entry.capturedResponse?.entry?.createdAt || null,
          action: entry.capturedResponse?.parsed?.action || null,
          rationale: entry.capturedResponse?.parsed?.rationale || null,
        } : null,
      });
      appendJsonLine(
        getPortfolioPaths(projectRoot, entry.agentId).auditLogPath,
        {
          kind: 'paper_trading_response_aborted',
          requestId: entry.requestId,
          agentId: entry.agentId,
          finalizedAt,
          error: SHUTDOWN_ABORT_MARKER,
          deadline: entry.request?.deadline || null,
          capturedResponse: Boolean(entry.capturedResponse),
        }
      );
      nextState.agents[entry.agentId] = {
        ...agentState,
        pendingRequestId: null,
        pendingRequestCreatedAt: null,
        pendingRequestCreatedAtMs: 0,
        lastResponseAt: finalizedAt,
        lastResponseAtMs: nowMs,
        lastActionType: null,
        lastError: SHUTDOWN_ABORT_MARKER,
      };
      result.finalized.push({
        agentId: entry.agentId,
        requestId: entry.requestId,
        disposition: SHUTDOWN_ABORT_MARKER,
        capturedResponse: Boolean(entry.capturedResponse),
      });
      changed = true;
    }

    if (changed) {
      writeAutomationState(statePath, nextState);
      continue;
    }

    if (nowMs >= hardDeadlineMs) {
      result.drained = false;
      result.remaining = pending.map((entry) => ({
        agentId: entry.agentId,
        requestId: entry.requestId,
      }));
      break;
    }

    await sleep(pollMs);
  }

  return result;
}

function validatePaperTradingResponse(response = {}) {
  if (!response.requestId) return { ok: false, error: 'requestId is required.' };
  if (!AGENT_IDS.includes(response.agentId)) return { ok: false, error: 'agentId must be architect, builder, or oracle.' };
  if (!response.action?.type) return { ok: false, error: 'action.type is required.' };
  if (!response.rationale) return { ok: false, error: 'rationale is required.' };
  const hasStop = Boolean(response.stopDeclaration);
  const hasNoStop = Boolean(response.noStopDeclaration);
  if ((hasStop && hasNoStop) || (!hasStop && !hasNoStop)) {
    return { ok: false, error: 'Provide exactly one of stopDeclaration or noStopDeclaration.' };
  }
  if (hasStop) {
    const stopPrice = toNumber(response.stopDeclaration?.price, 0);
    if (!(stopPrice > 0)) {
      return { ok: false, error: 'stopDeclaration.price must be a positive number.' };
    }
  } else if (!toText(response.noStopDeclaration?.reason || response.noStopDeclaration?.note)) {
    return { ok: false, error: 'noStopDeclaration.reason is required when declaring no stop.' };
  }

  const actionType = response.action.type;
  if (['open', 'close', 'scale'].includes(actionType) && !response.action.ticker) {
    return { ok: false, error: 'action.ticker is required for open, close, and scale.' };
  }
  if (actionType === 'open') {
    if (!response.action.side) return { ok: false, error: 'action.side is required for open.' };
    if (!(response.action.marginUsd > 0)) return { ok: false, error: 'action.marginUsd must be positive for open.' };
    if (!(response.action.leverage > 0)) return { ok: false, error: 'action.leverage must be positive for open.' };
  }
  if (actionType === 'scale') {
    if (!['add', 'reduce'].includes(response.action.direction)) {
      return { ok: false, error: 'action.direction must be add or reduce for scale.' };
    }
    if (response.action.direction === 'add') {
      if (!(response.action.marginUsd > 0)) return { ok: false, error: 'action.marginUsd must be positive for add scale.' };
      if (!(response.action.leverage > 0)) return { ok: false, error: 'action.leverage must be positive for add scale.' };
    }
    if (response.action.direction === 'reduce' && !(response.action.closePct > 0 || response.action.units > 0)) {
      return { ok: false, error: 'reduce scale requires closePct or units.' };
    }
  }
  if (actionType === 'close' && !(response.action.closePct > 0 || response.action.units > 0)) {
    response.action.closePct = 1;
  }
  if (!['hold', 'open', 'close', 'scale', 'hourly_mark'].includes(actionType)) {
    return { ok: false, error: 'action.type must be hold, open, close, scale, or hourly_mark.' };
  }
  return { ok: true };
}

function calculatePnl(side, entryPrice, exitPrice, size) {
  if (normalizeSide(side) === 'SHORT') {
    return round((entryPrice - exitPrice) * size, 2);
  }
  return round((exitPrice - entryPrice) * size, 2);
}

function refreshPortfolioMarks(portfolio = {}, livePriceMap = {}) {
  let unrealizedPnl = 0;
  const nextOpenPositions = portfolio.openPositions.map((position) => {
    const livePrice = toNumber(livePriceMap[position.ticker], position.currentPrice || position.entryPrice);
    const refreshed = {
      ...position,
      currentPrice: livePrice,
      unrealizedPnl: calculatePnl(position.side, position.entryPrice, livePrice, position.size),
    };
    unrealizedPnl += refreshed.unrealizedPnl;
    return refreshed;
  });
  const realizedPnl = round(portfolio.closedTrades.reduce((sum, trade) => sum + toNumber(trade.realizedPnl, 0), 0), 2);
  const equity = round(portfolio.cashBalance + nextOpenPositions.reduce((sum, position) => sum + toNumber(position.marginUsedUsd, 0), 0) + unrealizedPnl, 2);
  return {
    ...portfolio,
    openPositions: nextOpenPositions,
    realizedPnl,
    unrealizedPnl: round(unrealizedPnl, 2),
    totalPnl: round(realizedPnl + unrealizedPnl, 2),
    equity,
    currentEquity: equity,
  };
}

function buildMark(portfolio, note, markedAt) {
  return normalizeMark({
    markedAt,
    equity: portfolio.equity,
    cashBalance: portfolio.cashBalance,
    realizedPnl: portfolio.realizedPnl,
    unrealizedPnl: portfolio.unrealizedPnl,
    totalPnl: portfolio.totalPnl,
    openPositionCount: portfolio.openPositions.length,
    notes: note ? [note] : [],
  });
}

function applyPaperTradingResponse(input = {}) {
  const portfolio = normalizePortfolio(input.portfolio || {}, input.agentId || 'unknown');
  const response = input.response || {};
  const livePriceMap = input.livePriceMap || {};
  const now = toText(input.now, new Date().toISOString());
  let nextPortfolio = refreshPortfolioMarks(portfolio, livePriceMap);
  const actionType = response.action?.type;
  const ticker = response.action?.ticker;
  const livePrice = ticker ? toNumber(livePriceMap[ticker], 0) : 0;
  const mutation = {
    type: actionType,
    ticker,
    notes: [],
  };

  if (actionType === 'open') {
    if (nextPortfolio.openPositions.some((position) => position.ticker === ticker)) {
      throw new Error(`Open rejected: ${ticker} already exists in ${nextPortfolio.agentId} paper portfolio.`);
    }
    const marginUsd = round(response.action.marginUsd, 2);
    const leverage = response.action.leverage;
    const entryPrice = livePrice;
    if (!(entryPrice > 0)) throw new Error(`Open rejected: missing live price for ${ticker}.`);
    if (nextPortfolio.cashBalance < marginUsd) throw new Error(`Open rejected: cash balance ${nextPortfolio.cashBalance} is below required margin ${marginUsd}.`);
    const notionalUsd = round(marginUsd * leverage, 2);
    const size = round(notionalUsd / entryPrice, 8);
    nextPortfolio.cashBalance = round(nextPortfolio.cashBalance - marginUsd, 2);
    nextPortfolio.openPositions.push(normalizePosition({
      id: `${nextPortfolio.agentId}-paper-${ticker.replace('/', '-').toLowerCase()}-${Date.now()}`,
      ticker,
      side: response.action.side,
      entryPrice,
      currentPrice: entryPrice,
      size,
      notionalUsd,
      marginUsedUsd: marginUsd,
      leverage,
      openedAt: now,
      stopLoss: response.stopDeclaration?.price || null,
      takeProfit: response.action.takeProfit || null,
      thesis: response.rationale,
      notes: [`Paper trading automation open via ${input.wakeReason || 'timer_cycle'}.`],
      timeStop: response.timeStop || null,
      stopDeclaration: response.stopDeclaration || null,
      noStopDeclaration: response.noStopDeclaration || null,
    }));
    mutation.notes.push(`Opened ${response.action.side} ${ticker} at ${entryPrice}.`);
  } else if (actionType === 'close') {
    const existingIndex = nextPortfolio.openPositions.findIndex((position) => position.ticker === ticker);
    if (existingIndex < 0) throw new Error(`Close rejected: no open position for ${ticker}.`);
    const existing = nextPortfolio.openPositions[existingIndex];
    const exitPrice = livePrice || existing.currentPrice || existing.entryPrice;
    const closeQty = response.action.units > 0
      ? Math.min(existing.size, response.action.units)
      : round(existing.size * clamp(response.action.closePct || 1, 0, 1), 8);
    const closeRatio = existing.size > 0 ? clamp(closeQty / existing.size, 0, 1) : 1;
    const realizedPnl = calculatePnl(existing.side, existing.entryPrice, exitPrice, closeQty);
    const releasedMargin = round(existing.marginUsedUsd * closeRatio, 2);
    nextPortfolio.cashBalance = round(nextPortfolio.cashBalance + releasedMargin + realizedPnl, 2);
    if (closeRatio >= 0.999999) {
      nextPortfolio.openPositions.splice(existingIndex, 1);
    } else {
      nextPortfolio.openPositions[existingIndex] = normalizePosition({
        ...existing,
        size: round(existing.size - closeQty, 8),
        notionalUsd: round(existing.notionalUsd * (1 - closeRatio), 2),
        marginUsedUsd: round(existing.marginUsedUsd * (1 - closeRatio), 2),
      });
    }
    nextPortfolio.closedTrades.push(normalizeClosedTrade({
      ...existing,
      id: `${existing.id}-close-${Date.now()}`,
      exitPrice,
      size: closeQty,
      notionalUsd: round(existing.notionalUsd * closeRatio, 2),
      marginUsedUsd: releasedMargin,
      closedAt: now,
      realizedPnl,
      exitReason: response.rationale,
      thesis: existing.thesis,
      notes: [`Paper trading automation close via ${input.wakeReason || 'timer_cycle'}.`],
      timeStop: response.timeStop || null,
      stopDeclaration: response.stopDeclaration || null,
      noStopDeclaration: response.noStopDeclaration || null,
    }));
    mutation.notes.push(`Closed ${round(closeRatio * 100, 2)}% of ${ticker} at ${exitPrice}.`);
  } else if (actionType === 'scale') {
    const existingIndex = nextPortfolio.openPositions.findIndex((position) => position.ticker === ticker);
    if (existingIndex < 0) throw new Error(`Scale rejected: no open position for ${ticker}.`);
    const existing = nextPortfolio.openPositions[existingIndex];
    if (response.action.direction === 'add') {
      const marginUsd = round(response.action.marginUsd, 2);
      const leverage = response.action.leverage || existing.leverage;
      const entryPrice = livePrice || existing.currentPrice || existing.entryPrice;
      if (!(entryPrice > 0)) throw new Error(`Scale-add rejected: missing live price for ${ticker}.`);
      if (nextPortfolio.cashBalance < marginUsd) throw new Error(`Scale-add rejected: cash balance ${nextPortfolio.cashBalance} is below required margin ${marginUsd}.`);
      const addNotionalUsd = round(marginUsd * leverage, 2);
      const addSize = round(addNotionalUsd / entryPrice, 8);
      const combinedSize = round(existing.size + addSize, 8);
      const weightedEntry = combinedSize > 0
        ? round(((existing.entryPrice * existing.size) + (entryPrice * addSize)) / combinedSize, 6)
        : entryPrice;
      nextPortfolio.cashBalance = round(nextPortfolio.cashBalance - marginUsd, 2);
      nextPortfolio.openPositions[existingIndex] = normalizePosition({
        ...existing,
        entryPrice: weightedEntry,
        currentPrice: entryPrice,
        size: combinedSize,
        notionalUsd: round(existing.notionalUsd + addNotionalUsd, 2),
        marginUsedUsd: round(existing.marginUsedUsd + marginUsd, 2),
        leverage,
        stopLoss: response.stopDeclaration?.price || existing.stopLoss,
        takeProfit: response.action.takeProfit || existing.takeProfit,
        thesis: response.rationale,
        notes: [...existing.notes, `Added paper size via ${input.wakeReason || 'timer_cycle'}.`],
        timeStop: response.timeStop || existing.timeStop || null,
        stopDeclaration: response.stopDeclaration || existing.stopDeclaration || null,
        noStopDeclaration: response.noStopDeclaration || existing.noStopDeclaration || null,
      });
      mutation.notes.push(`Added to ${ticker} at ${entryPrice}.`);
    } else {
      const closeLike = applyPaperTradingResponse({
        portfolio: nextPortfolio,
        response: {
          ...response,
          action: {
            ...response.action,
            type: 'close',
          },
        },
        livePriceMap,
        now,
        wakeReason: input.wakeReason,
      });
      nextPortfolio = closeLike.portfolio;
      mutation.notes.push(...closeLike.mutation.notes);
    }
  } else if (actionType === 'hold' || actionType === 'hourly_mark') {
    mutation.notes.push(actionType === 'hold' ? 'Portfolio held with no mutation.' : 'Hourly mark recorded.');
  } else {
    throw new Error(`Unsupported paper trading action: ${actionType}`);
  }

  nextPortfolio = refreshPortfolioMarks(nextPortfolio, livePriceMap);
  nextPortfolio.lastUpdatedAt = now;
  nextPortfolio.hourlyMarks = [...nextPortfolio.hourlyMarks, buildMark(nextPortfolio, response.rationale, now)];

  return {
    portfolio: nextPortfolio,
    mutation,
  };
}

function buildAgentErrorMessage(request = {}, errorMessage = '') {
  return [
    `Paper trading response rejected for ${request.requestId || 'unknown_request'}.`,
    errorMessage,
    'Retry next cycle with valid JSON including rationale and exactly one of stopDeclaration or noStopDeclaration.',
  ].join(' ');
}

module.exports = {
  AGENT_IDS,
  CORE_TICKERS,
  DEFAULT_TIMER_INTERVAL_MINUTES,
  DEFAULT_SHUTDOWN_DRAIN_POLL_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_FENCE_TTL_MS,
  SHUTDOWN_ABORT_MARKER,
  appendJsonLine,
  applyPaperTradingResponse,
  buildAgentErrorMessage,
  buildPaperCompetitionSnapshot,
  buildPaperTradingPrompt: buildPrompt,
  buildRequestPayload,
  computeNextTimerWakeMs,
  defaultTriggerConfig,
  evaluateWakeCondition,
  getPortfolioPaths,
  loadTriggerConfig,
  normalizeTriggerConfig,
  normalizePortfolio,
  parsePaperTradingResponseBody,
  readPortfolio,
  refreshPortfolioMarks,
  serializePortfolio,
  summarizeStructure,
  validatePaperTradingResponse,
  commitPortfolioMutation,
  clearShutdownFence,
  collectPaperTradingAgentResponse,
  drainShutdownPendingCycles,
  writePortfolio,
  getPaperTradingAutomationStatePath,
  getShutdownFencePath,
  isShutdownFenceActive,
  normalizeAutomationState,
  readAutomationState,
  readResponse,
  writeRequest,
  writeResponse,
  writeAutomationState,
  writeShutdownFence,
};
