'use strict';

const fs = require('fs');
const path = require('path');

const { resolveCoordPath } = require('../../config');

const DEFAULT_RISK_STATE_PATH = resolveCoordPath(path.join('runtime', 'hard-risk-state.json'), { forWrite: true });
const DEFAULT_WEEKLY_RISK_REPORT_PATH = resolveCoordPath(path.join('runtime', 'hard-risk-weekly.json'), { forWrite: true });
const DEFAULT_RISK_EVENTS_PATH = resolveCoordPath(path.join('runtime', 'hard-risk-events.jsonl'), { forWrite: true });

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function round(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
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
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
}

function defaultRiskState() {
  return {
    mode: 'normal',
    triggerCause: null,
    updatedAt: null,
    accountEquityUsd: 0,
    dailyRealizedPnlUsd: 0,
    dailyLossCapUsd: 0,
    remainingLossBudgetUsd: 0,
    remainingPerTradeMarginCapUsd: 0,
    peakEquityUsd: 0,
    drawdownPct: 0,
    maxObservedDrawdownPct: 0,
    pausedUntil: null,
    dailyCycles: {},
    weekly: {},
  };
}

function loadRiskConfig() {
  return {
    statePath: DEFAULT_RISK_STATE_PATH,
    weeklyReportPath: DEFAULT_WEEKLY_RISK_REPORT_PATH,
    eventsPath: DEFAULT_RISK_EVENTS_PATH,
    dailyLossCapPct: 0.08,
    perTradeMarginCapPct: 0.12,
    weeklyMetrics: {
      lookbackDays: 7,
      largestSingleLossFlagPct: 0.05,
    },
  };
}

function loadRiskState(statePath = DEFAULT_RISK_STATE_PATH) {
  return {
    ...defaultRiskState(),
    ...(readJson(statePath, defaultRiskState()) || {}),
  };
}

function getPacificDateKey(nowMs = Date.now()) {
  const date = new Date(nowMs);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value || '1970';
  const month = parts.find((part) => part.type === 'month')?.value || '01';
  const day = parts.find((part) => part.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

function refreshRiskState(input = {}) {
  const config = input.config || loadRiskConfig();
  const previousState = input.previousState || defaultRiskState();
  const accountEquityUsd = Math.max(0, toNumber(input.accountEquityUsd, previousState.accountEquityUsd));
  const dailyRealizedPnlUsd = toNumber(input.dailyRealizedPnlUsd, previousState.dailyRealizedPnlUsd);
  const peakEquityUsd = Math.max(accountEquityUsd, toNumber(previousState.peakEquityUsd, accountEquityUsd));
  const dailyLossCapUsd = round(Math.max(0, accountEquityUsd * toNumber(config.dailyLossCapPct, 0.08)), 2);
  const realizedLossUsd = Math.max(0, -dailyRealizedPnlUsd);
  const remainingLossBudgetUsd = round(Math.max(0, dailyLossCapUsd - realizedLossUsd), 2);
  const remainingPerTradeMarginCapUsd = round(Math.max(0, accountEquityUsd * toNumber(config.perTradeMarginCapPct, 0.05)), 2);
  const drawdownPct = peakEquityUsd > 0
    ? round(Math.max(0, (peakEquityUsd - accountEquityUsd) / peakEquityUsd), 6)
    : 0;
  const maxObservedDrawdownPct = Math.max(drawdownPct, toNumber(previousState.maxObservedDrawdownPct, 0));
  const mode = remainingLossBudgetUsd <= 0
    ? 'paused'
    : (drawdownPct >= 0.08 ? 'defensive' : 'normal');

  return {
    ...previousState,
    updatedAt: toText(input.updatedAt, new Date().toISOString()),
    marketDate: toText(input.marketDate, getPacificDateKey()),
    accountEquityUsd: round(accountEquityUsd, 2),
    dailyRealizedPnlUsd: round(dailyRealizedPnlUsd, 2),
    dailyLossCapUsd,
    remainingLossBudgetUsd,
    remainingPerTradeMarginCapUsd,
    peakEquityUsd: round(peakEquityUsd, 2),
    drawdownPct,
    maxObservedDrawdownPct: round(maxObservedDrawdownPct, 6),
    currentAgentPositionCount: Math.max(0, Math.floor(toNumber(input.currentAgentPositionCount, 0))),
    mode,
    triggerCause: mode === 'paused'
      ? 'daily_loss_cap'
      : (mode === 'defensive' ? 'drawdown_guard' : null),
  };
}

function computeWeeklyMetrics(input = {}) {
  const fills = Array.isArray(input.fills) ? input.fills : [];
  const accountEquityUsd = Math.max(0.01, toNumber(input.accountEquityUsd, 0));
  const largestSingleLossUsd = fills.reduce((worst, fill) => {
    const pnl = toNumber(fill?.closedPnl, 0);
    return pnl < worst ? pnl : worst;
  }, 0);
  const largestSingleLossPct = largestSingleLossUsd < 0
    ? round(Math.abs(largestSingleLossUsd) / accountEquityUsd, 6)
    : 0;
  const flagPct = toNumber(input.largestSingleLossFlagPct, 0.05);
  return {
    lookbackDays: Math.max(1, Math.floor(toNumber(input.lookbackDays, 7))),
    largestSingleLossUsd: round(Math.abs(largestSingleLossUsd), 2),
    largestSingleLossPct,
    largestSingleLossAutoFlag: largestSingleLossPct >= flagPct,
    maxObservedDrawdownPct: round(toNumber(input.maxObservedDrawdownPct, 0), 6),
    updatedAt: toText(input.updatedAt, new Date().toISOString()),
  };
}

function persistRiskState(state = {}, options = {}) {
  const config = options.config || loadRiskConfig();
  const statePath = options.statePath || config.statePath || DEFAULT_RISK_STATE_PATH;
  const weeklyReportPath = options.weeklyReportPath || config.weeklyReportPath || DEFAULT_WEEKLY_RISK_REPORT_PATH;
  writeJson(statePath, state);
  writeJson(weeklyReportPath, state.weekly || {});
  return {
    statePath,
    weeklyReportPath,
  };
}

function recordRiskEvent(event = {}, options = {}) {
  const config = options.config || event.config || loadRiskConfig();
  const eventsPath = options.eventsPath || config.eventsPath || DEFAULT_RISK_EVENTS_PATH;
  appendJsonLine(eventsPath, {
    ...event,
    recordedAt: new Date().toISOString(),
  });
  return eventsPath;
}

module.exports = {
  DEFAULT_RISK_STATE_PATH,
  DEFAULT_WEEKLY_RISK_REPORT_PATH,
  defaultRiskState,
  loadRiskConfig,
  loadRiskState,
  getPacificDateKey,
  refreshRiskState,
  computeWeeklyMetrics,
  persistRiskState,
  recordRiskEvent,
};
