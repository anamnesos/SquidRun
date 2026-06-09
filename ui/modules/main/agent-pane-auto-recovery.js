'use strict';

const fs = require('fs');
const path = require('path');

const { ROLE_ID_MAP, resolveCoordPath } = require('../../config');
const { getTrustQuoteDayToDayArmSpecs } = require('../trustquote-arm-specs');
const { queryCommsJournalEntries } = require('./comms-journal');
const { sendAgentAlert } = require('../../scripts/hm-agent-alert');
const hmPane = require('../../scripts/hm-pane');

const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'agent-pane-auto-recovery-state.json'), { forWrite: true });
const DEFAULT_EVENTS_PATH = resolveCoordPath(path.join('runtime', 'agent-pane-auto-recovery-events.jsonl'), { forWrite: true });
const DEFAULT_SCROLLBACK_PATH = resolveCoordPath(path.join('runtime', 'terminal-restart-scrollback.json'), { forWrite: true });
const DEFAULT_PENDING_DELIVERIES_PATH = resolveCoordPath(path.join('runtime', 'pending-pane-deliveries.json'), { forWrite: true });
const DEFAULT_APP_STATUS_PATH = resolveCoordPath('app-status.json', { forWrite: true });

const DEFAULT_CONFIG = Object.freeze({
  bootGraceMs: 8 * 60 * 1000,
  deadConfirmCount: 2,
  deadSustainMs: 60 * 1000,
  deadProbeAfterMs: 2 * 60 * 1000,
  probeCooldownMs: 60 * 1000,
  wedgedConfirmCount: 2,
  wedgedMinMs: 10 * 60 * 1000,
  restartCircuitMaxAttempts: 3,
  restartCircuitWindowMs: 30 * 60 * 1000,
  exhaustedNotifyCooldownMs: 10 * 60 * 1000,
  staleDeliveryGraceMs: 5 * 60 * 1000,
  commsLookbackMs: 24 * 60 * 60 * 1000,
});

const IN_FLIGHT_REASONS = new Set([
  'accepted.unverified',
  'post_enter_output_timeout',
  'agent_not_running',
  'routed_unverified_timeout',
  'delivery_unverified',
]);

const DEAD_REASONS = new Set(['agent_not_running']);

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseTimeMs(value, fallback = null) {
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeReason(value) {
  return toText(value).toLowerCase();
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
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, payload) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function defaultState() {
  return {
    version: 1,
    panes: {},
    updatedAt: null,
  };
}

function defaultPaneState(paneId, role = null) {
  return {
    paneId: String(paneId),
    role: role || null,
    status: 'unknown',
    firstObservedAtMs: 0,
    lastObservedAtMs: 0,
    lastResponseAtMs: 0,
    lastInFlightAtMs: 0,
    lastInFlightReason: null,
    lastInFlightSource: null,
    lastProbeAtMs: 0,
    lastScrollbackSha256: null,
    lastScrollbackActivityMs: null,
    frozenSinceMs: 0,
    frozenCount: 0,
    deadFirstAtMs: 0,
    deadCount: 0,
    deadLastAtMs: 0,
    deadLastReason: null,
    lastRestartAtMs: 0,
    bootStartedAtMs: 0,
    restartHistoryMs: [],
    lastExhaustedNotifyAtMs: 0,
  };
}

function normalizeState(input = {}) {
  const state = {
    ...defaultState(),
    ...asObject(input),
    panes: {},
  };
  const panes = asObject(input?.panes);
  for (const [paneId, paneState] of Object.entries(panes)) {
    state.panes[String(paneId)] = {
      ...defaultPaneState(paneId, paneState?.role || null),
      ...asObject(paneState),
      paneId: String(paneId),
      restartHistoryMs: Array.isArray(paneState?.restartHistoryMs)
        ? paneState.restartHistoryMs.map((entry) => toNumber(entry, null)).filter(Number.isFinite)
        : [],
    };
  }
  return state;
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  return normalizeState(readJson(statePath, defaultState()) || defaultState());
}

function persistState(statePath, state) {
  writeJson(statePath, normalizeState(state));
}

function getDefaultPaneSpecs() {
  const specs = [];
  for (const [role, paneId] of Object.entries(ROLE_ID_MAP || {})) {
    specs.push({ paneId: String(paneId), role: String(role).toLowerCase(), kind: 'team' });
  }
  for (const spec of getTrustQuoteDayToDayArmSpecs()) {
    specs.push({ paneId: String(spec.paneId), role: String(spec.role).toLowerCase(), kind: 'trustquote-arm' });
  }
  return specs;
}

function normalizePaneSpecs(value = null) {
  const raw = Array.isArray(value) && value.length > 0 ? value : getDefaultPaneSpecs();
  const seen = new Set();
  const specs = [];
  for (const entry of raw) {
    const paneId = toText(entry?.paneId || entry?.pane || '');
    if (!paneId || seen.has(paneId)) continue;
    seen.add(paneId);
    specs.push({
      paneId,
      role: toText(entry?.role || '').toLowerCase() || paneId.toLowerCase(),
      kind: toText(entry?.kind || 'agent'),
    });
  }
  return specs;
}

function readPendingDeliveries(filePath = DEFAULT_PENDING_DELIVERIES_PATH) {
  const payload = readJson(filePath, null);
  return Array.isArray(payload?.items) ? payload.items : [];
}

function getPendingDeliveryTimeMs(item = {}) {
  return parseTimeMs(item.lastAttemptAt, null)
    ?? parseTimeMs(item.createdAt, null)
    ?? parseTimeMs(item.timestamp, null)
    ?? 0;
}

function buildPendingDeliverySignals(items = [], nowMs = Date.now()) {
  const signals = [];
  for (const item of Array.isArray(items) ? items : []) {
    const paneId = toText(item?.paneId || '');
    if (!paneId) continue;
    const reason = normalizeReason(item?.lastFailureReason || item?.status || item?.reason || '');
    if (!IN_FLIGHT_REASONS.has(reason)) continue;
    signals.push({
      paneId,
      role: toText(item?.targetRole || item?.role || '').toLowerCase() || null,
      reason,
      source: 'pending-pane-deliveries',
      messageId: toText(item?.messageId || item?.queueKey || '') || null,
      observedAtMs: getPendingDeliveryTimeMs(item) || nowMs,
    });
  }
  return signals;
}

function buildAlertDeliverySignals({ paneId, role, alertResult, message = '', nowMs = Date.now() } = {}) {
  const normalizedPaneId = toText(paneId);
  if (!normalizedPaneId) return [];
  const results = Array.isArray(alertResult?.results) ? alertResult.results : [];
  const text = [
    alertResult?.stdout,
    alertResult?.stderr,
    alertResult?.error,
    ...results.flatMap((entry) => [entry.stdout, entry.stderr, entry.error]),
  ].map((entry) => String(entry || '')).join('\n').toLowerCase();
  let reason = null;
  if (text.includes('agent_not_running')) {
    reason = 'agent_not_running';
  } else if (
    text.includes('post_enter_output_timeout')
    || text.includes('accepted.unverified')
    || /\bunverified\b/.test(text)
  ) {
    reason = 'post_enter_output_timeout';
  }
  if (!reason) return [];
  return [{
    paneId: normalizedPaneId,
    role: toText(role).toLowerCase() || null,
    reason,
    source: 'hm-send-alert',
    messagePreview: String(message || '').slice(0, 240),
    observedAtMs: nowMs,
  }];
}

function queryLatestCommsByRole(paneSpecs = [], options = {}) {
  const query = typeof options.queryCommsJournalEntries === 'function'
    ? options.queryCommsJournalEntries
    : queryCommsJournalEntries;
  const nowMs = toNumber(options.nowMs, Date.now());
  const lookbackMs = toNumber(options.commsLookbackMs, DEFAULT_CONFIG.commsLookbackMs);
  const latest = {};
  for (const spec of normalizePaneSpecs(paneSpecs)) {
    const role = toText(spec.role).toLowerCase();
    if (!role || latest[role]) continue;
    const rows = query({
      senderRole: role,
      direction: 'outbound',
      sinceMs: nowMs - lookbackMs,
      order: 'desc',
      limit: 1,
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    const rowMs = parseTimeMs(row?.sentAtMs ?? row?.brokeredAtMs ?? row?.timestampMs ?? row?.createdAt, 0);
    if (rowMs) latest[role] = rowMs;
  }
  return latest;
}

function getPaneSnapshot(scrollbackSnapshot = {}, paneId) {
  return asObject(scrollbackSnapshot?.panes)[String(paneId)] || null;
}

function getLatestBootStartMs(paneState = {}, paneSnapshot = {}, appStartedAtMs = null) {
  const candidates = [
    toNumber(paneState.bootStartedAtMs, 0),
    toNumber(paneState.lastRestartAtMs, 0),
    toNumber(paneSnapshot?.createdAt, 0),
    parseTimeMs(appStartedAtMs, 0),
  ].filter((entry) => Number.isFinite(entry) && entry > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

function isWithinBootGrace(paneState = {}, paneSnapshot = {}, config = {}, nowMs = Date.now(), appStartedAtMs = null) {
  const bootStartMs = getLatestBootStartMs(paneState, paneSnapshot, appStartedAtMs);
  if (!bootStartMs) return false;
  return nowMs - bootStartMs < config.bootGraceMs;
}

function filterRestartHistory(paneState = {}, config = {}, nowMs = Date.now()) {
  return (Array.isArray(paneState.restartHistoryMs) ? paneState.restartHistoryMs : [])
    .map((entry) => toNumber(entry, null))
    .filter((entry) => Number.isFinite(entry) && nowMs - entry <= config.restartCircuitWindowMs);
}

function getSignalsForPane(signals = [], paneId) {
  return (Array.isArray(signals) ? signals : [])
    .filter((signal) => toText(signal?.paneId) === String(paneId))
    .map((signal) => ({
      ...signal,
      reason: normalizeReason(signal.reason || signal.status || signal.lastFailureReason || ''),
      observedAtMs: parseTimeMs(signal.observedAtMs ?? signal.sentAtMs ?? signal.lastAttemptAt ?? signal.createdAt, 0),
    }));
}

function getActiveInFlightSignal(signals = [], latestCommsMs = 0, appStartedAtMs = null, config = {}) {
  const staleBeforeMs = Number.isFinite(appStartedAtMs)
    ? appStartedAtMs - config.staleDeliveryGraceMs
    : null;
  const candidates = signals
    .filter((signal) => IN_FLIGHT_REASONS.has(signal.reason))
    .filter((signal) => !signal.observedAtMs || signal.observedAtMs > latestCommsMs)
    .filter((signal) => staleBeforeMs === null || !signal.observedAtMs || signal.observedAtMs >= staleBeforeMs)
    .sort((left, right) => (right.observedAtMs || 0) - (left.observedAtMs || 0));
  return candidates[0] || null;
}

function updateFrozenState(paneState, paneSnapshot, nowMs) {
  const hash = toText(paneSnapshot?.scrollbackSha256 || '');
  const activityMs = toNumber(paneSnapshot?.lastActivity, null);
  const hadPrevious = Boolean(paneState.lastScrollbackSha256);
  const frozen = Boolean(
    hash
    && hadPrevious
    && hash === paneState.lastScrollbackSha256
    && activityMs === paneState.lastScrollbackActivityMs
  );

  if (frozen) {
    paneState.frozenSinceMs = paneState.frozenSinceMs || paneState.lastObservedAtMs || nowMs;
    paneState.frozenCount = (paneState.frozenCount || 0) + 1;
  } else if (hash) {
    paneState.frozenSinceMs = 0;
    paneState.frozenCount = 0;
  }

  if (hash) paneState.lastScrollbackSha256 = hash;
  if (activityMs !== null) paneState.lastScrollbackActivityMs = activityMs;
}

function resetSuspicionOnActivity(paneState) {
  paneState.deadFirstAtMs = 0;
  paneState.deadCount = 0;
  paneState.deadLastAtMs = 0;
  paneState.deadLastReason = null;
  paneState.lastInFlightAtMs = 0;
  paneState.lastInFlightReason = null;
  paneState.lastInFlightSource = null;
}

function buildProbeRequests(previousState = {}, input = {}, configInput = {}) {
  const config = { ...DEFAULT_CONFIG, ...asObject(configInput) };
  const state = normalizeState(previousState);
  const nowMs = toNumber(input.nowMs, Date.now());
  const paneSpecs = normalizePaneSpecs(input.paneSpecs);
  const scrollbackSnapshot = asObject(input.scrollbackSnapshot);
  const latestCommsByRole = asObject(input.latestCommsByRole);
  const deliverySignals = Array.isArray(input.deliverySignals) ? input.deliverySignals : [];
  const appStartedAtMs = parseTimeMs(input.appStartedAtMs, null);
  const requests = [];

  for (const spec of paneSpecs) {
    const paneId = String(spec.paneId);
    const role = toText(spec.role).toLowerCase();
    const paneState = {
      ...defaultPaneState(paneId, role),
      ...asObject(state.panes[paneId]),
    };
    const paneSnapshot = getPaneSnapshot(scrollbackSnapshot, paneId);
    const latestCommsMs = toNumber(latestCommsByRole[role], 0);
    const paneSignals = getSignalsForPane(deliverySignals, paneId);
    const activeInFlight = getActiveInFlightSignal(paneSignals, latestCommsMs, appStartedAtMs, config);
    if (!activeInFlight) continue;
    if (nowMs - (activeInFlight.observedAtMs || nowMs) < config.deadProbeAfterMs) continue;
    if (isWithinBootGrace(paneState, paneSnapshot, config, nowMs, appStartedAtMs)) continue;
    if (paneState.lastProbeAtMs && nowMs - paneState.lastProbeAtMs < config.probeCooldownMs) continue;
    requests.push({
      paneId,
      role,
      reason: 'in_flight_no_response',
      inFlightAtMs: activeInFlight.observedAtMs || null,
    });
  }
  return requests;
}

function evaluateAgentPaneAutoRecovery(previousState = {}, input = {}, configInput = {}) {
  const config = { ...DEFAULT_CONFIG, ...asObject(configInput) };
  const state = normalizeState(previousState);
  const nowMs = toNumber(input.nowMs, Date.now());
  const paneSpecs = normalizePaneSpecs(input.paneSpecs);
  const scrollbackSnapshot = asObject(input.scrollbackSnapshot);
  const latestCommsByRole = asObject(input.latestCommsByRole);
  const deliverySignals = Array.isArray(input.deliverySignals) ? input.deliverySignals : [];
  const appStartedAtMs = parseTimeMs(input.appStartedAtMs, null);
  const actions = [];
  const panes = {};

  for (const spec of paneSpecs) {
    const paneId = String(spec.paneId);
    const role = toText(spec.role).toLowerCase();
    const paneState = {
      ...defaultPaneState(paneId, role),
      ...asObject(state.panes[paneId]),
      paneId,
      role,
    };
    paneState.firstObservedAtMs = paneState.firstObservedAtMs || nowMs;

    const paneSnapshot = getPaneSnapshot(scrollbackSnapshot, paneId);
    const latestCommsMs = toNumber(latestCommsByRole[role], 0);
    if (latestCommsMs > (paneState.lastResponseAtMs || 0)) {
      const suspicionSinceMs = Math.max(
        paneState.lastInFlightAtMs || 0,
        paneState.deadFirstAtMs || 0,
        paneState.deadLastAtMs || 0
      );
      paneState.lastResponseAtMs = latestCommsMs;
      if (suspicionSinceMs > 0 && latestCommsMs > suspicionSinceMs) {
        resetSuspicionOnActivity(paneState);
      }
    }

    updateFrozenState(paneState, paneSnapshot, nowMs);

    const paneSignals = getSignalsForPane(deliverySignals, paneId);
    const activeInFlight = getActiveInFlightSignal(paneSignals, paneState.lastResponseAtMs || 0, appStartedAtMs, config);
    if (activeInFlight) {
      paneState.lastInFlightAtMs = Math.max(paneState.lastInFlightAtMs || 0, activeInFlight.observedAtMs || nowMs);
      paneState.lastInFlightReason = activeInFlight.reason;
      paneState.lastInFlightSource = activeInFlight.source || null;
    }

    const booting = isWithinBootGrace(paneState, paneSnapshot, config, nowMs, appStartedAtMs);
    const deadSignal = paneSignals
      .filter((signal) => DEAD_REASONS.has(signal.reason))
      .sort((left, right) => (right.observedAtMs || 0) - (left.observedAtMs || 0))[0] || null;

    if (deadSignal && booting) {
      paneState.status = 'booting_dead_signal_held';
    } else if (deadSignal) {
      if (!paneState.deadFirstAtMs) paneState.deadFirstAtMs = deadSignal.observedAtMs || nowMs;
      paneState.deadLastAtMs = deadSignal.observedAtMs || nowMs;
      paneState.deadLastReason = deadSignal.reason;
      paneState.deadCount = (paneState.deadCount || 0) + 1;
      paneState.status = 'dead_suspected';
    }

    const deadConfirmed = Boolean(
      !booting
      && paneState.deadCount >= config.deadConfirmCount
      && paneState.deadFirstAtMs
      && nowMs - paneState.deadFirstAtMs >= config.deadSustainMs
    );
    const frozenDurationMs = paneState.frozenSinceMs ? nowMs - paneState.frozenSinceMs : 0;
    const inFlightAgeMs = activeInFlight?.observedAtMs ? nowMs - activeInFlight.observedAtMs : 0;
    const wedgedConfirmed = Boolean(
      !booting
      && activeInFlight
      && paneState.frozenCount >= config.wedgedConfirmCount
      && frozenDurationMs >= config.wedgedMinMs
      && inFlightAgeMs >= config.wedgedMinMs
    );

    paneState.restartHistoryMs = filterRestartHistory(paneState, config, nowMs);
    const confirmedReason = deadConfirmed ? 'dead' : (wedgedConfirmed ? 'wedged' : null);
    if (confirmedReason) {
      if (paneState.restartHistoryMs.length >= config.restartCircuitMaxAttempts) {
        paneState.status = 'circuit_exhausted';
        if (!paneState.lastExhaustedNotifyAtMs || nowMs - paneState.lastExhaustedNotifyAtMs >= config.exhaustedNotifyCooldownMs) {
          paneState.lastExhaustedNotifyAtMs = nowMs;
          actions.push({
            kind: 'exhausted',
            paneId,
            role,
            reason: confirmedReason,
            attempts: paneState.restartHistoryMs.length,
            manualInterventionRequired: true,
            evidence: {
              deadCount: paneState.deadCount,
              deadLastReason: paneState.deadLastReason,
              frozenCount: paneState.frozenCount,
              frozenDurationMs,
              inFlightAgeMs,
              activeInFlight,
            },
          });
        }
      } else {
        paneState.status = `${confirmedReason}_confirmed`;
        paneState.restartHistoryMs.push(nowMs);
        paneState.lastRestartAtMs = nowMs;
        paneState.bootStartedAtMs = nowMs;
        paneState.deadFirstAtMs = 0;
        paneState.deadCount = 0;
        paneState.deadLastAtMs = 0;
        paneState.deadLastReason = null;
        actions.push({
          kind: 'restart',
          paneId,
          role,
          reason: confirmedReason,
          attempt: paneState.restartHistoryMs.length,
          evidence: {
            deadSignal,
            frozenCount: paneState.frozenCount,
            frozenDurationMs,
            inFlightAgeMs,
            activeInFlight,
          },
        });
      }
    } else if (!paneState.status || paneState.status === 'unknown') {
      paneState.status = activeInFlight ? 'in_flight_observed' : 'idle_or_healthy';
    }

    paneState.lastObservedAtMs = nowMs;
    state.panes[paneId] = paneState;
    panes[paneId] = {
      paneId,
      role,
      status: paneState.status,
      booting,
      activeInFlight: Boolean(activeInFlight),
      frozenCount: paneState.frozenCount,
      deadCount: paneState.deadCount,
    };
  }

  state.updatedAt = new Date(nowMs).toISOString();
  return { state, actions, panes, config };
}

function buildRecoveryMessage(action = {}, result = {}) {
  if (action.kind === 'exhausted') {
    return [
      '(AGENT-PANE AUTO-RECOVERY): LOUD ESCALATION.',
      `pane ${action.paneId} auto-recovery exhausted after ${action.attempts} attempts.`,
      `reason=${action.reason}.`,
      'Manual intervention needed.',
    ].join(' ');
  }
  return [
    '(AGENT-PANE AUTO-RECOVERY): Restarting pane.',
    `pane=${action.paneId}`,
    `role=${action.role || 'unknown'}`,
    `reason=${action.reason}`,
    `attempt=${action.attempt || 1}`,
    `result=${result?.ok === false ? 'restart_failed' : 'restart_requested'}`,
  ].join(' ');
}

async function defaultProbePane(paneId, options = {}) {
  const message = options.message || '[SQUIDRUN RECOVERY] Liveness probe. Reply with current status.';
  const response = await hmPane.run('nudge', { paneId: String(paneId), message }, {
    role: 'agent-pane-auto-recovery',
    timeoutMs: Math.max(1000, Number(options.timeoutMs) || 5000),
    port: Number(options.port) || undefined,
  });
  return response?.result || response || {};
}

async function defaultRestartPane(paneId, options = {}) {
  const response = await hmPane.run('restart', { paneId: String(paneId) }, {
    role: 'agent-pane-auto-recovery',
    timeoutMs: Math.max(1000, Number(options.timeoutMs) || 5000),
    port: Number(options.port) || undefined,
  });
  return response?.result || response || {};
}

function defaultNotifyArchitect(message, options = {}) {
  return sendAgentAlert(message, {
    targets: ['architect'],
    role: 'agent-pane-auto-recovery',
    cwd: options.cwd || process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..', '..'),
    env: options.env || process.env,
    timeoutMs: options.timeoutMs,
  });
}

async function runAgentPaneAutoRecoveryCycle(options = {}) {
  const nowMs = toNumber(options.nowMs, Date.now());
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const eventsPath = path.resolve(toText(options.eventsPath, DEFAULT_EVENTS_PATH));
  const paneSpecs = normalizePaneSpecs(options.paneSpecs);
  const config = { ...DEFAULT_CONFIG, ...asObject(options.config) };
  const previousState = options.state ? normalizeState(options.state) : loadState(statePath);
  const scrollbackSnapshot = options.scrollbackSnapshot || readJson(
    toText(options.scrollbackPath, DEFAULT_SCROLLBACK_PATH),
    { panes: {} }
  ) || { panes: {} };
  const appStatus = options.appStatus || readJson(toText(options.appStatusPath, DEFAULT_APP_STATUS_PATH), null) || null;
  const appStartedAtMs = parseTimeMs(options.appStartedAtMs ?? appStatus?.started, null);
  const pendingDeliveries = Array.isArray(options.pendingDeliveries)
    ? options.pendingDeliveries
    : readPendingDeliveries(toText(options.pendingDeliveriesPath, DEFAULT_PENDING_DELIVERIES_PATH));
  const latestCommsByRole = options.latestCommsByRole || queryLatestCommsByRole(paneSpecs, {
    nowMs,
    commsLookbackMs: config.commsLookbackMs,
    queryCommsJournalEntries: options.queryCommsJournalEntries,
  });
  const deliverySignals = [
    ...buildPendingDeliverySignals(pendingDeliveries, nowMs),
    ...(Array.isArray(options.deliverySignals) ? options.deliverySignals : []),
  ];

  const probePane = options.probePane || defaultProbePane;
  const probeRequests = options.probePanes === false
    ? []
    : buildProbeRequests(previousState, {
      nowMs,
      paneSpecs,
      scrollbackSnapshot,
      latestCommsByRole,
      deliverySignals,
      appStartedAtMs,
    }, config);
  const probedState = normalizeState(previousState);
  const probeResults = [];
  for (const request of probeRequests) {
    probedState.panes[request.paneId] = {
      ...defaultPaneState(request.paneId, request.role),
      ...asObject(probedState.panes[request.paneId]),
      lastProbeAtMs: nowMs,
    };
    try {
      const result = await probePane(request.paneId, { request, timeoutMs: options.paneControlTimeoutMs });
      probeResults.push({ ...request, result });
      const reason = normalizeReason(result?.reason || result?.status || '');
      if (DEAD_REASONS.has(reason)) {
        deliverySignals.push({
          paneId: request.paneId,
          role: request.role,
          reason,
          source: 'hm-pane-nudge',
          observedAtMs: nowMs,
        });
      }
    } catch (err) {
      probeResults.push({ ...request, error: err.message });
    }
  }

  const evaluation = evaluateAgentPaneAutoRecovery(probedState, {
    nowMs,
    paneSpecs,
    scrollbackSnapshot,
    latestCommsByRole,
    deliverySignals,
    appStartedAtMs,
  }, config);

  const restartPane = options.restartPane || defaultRestartPane;
  const notifyArchitect = options.notifyArchitect || defaultNotifyArchitect;
  const dispatches = [];
  for (const action of evaluation.actions) {
    let result = { ok: true, skipped: options.dryRun === true };
    if (action.kind === 'restart' && options.dryRun !== true) {
      try {
        result = await restartPane(action.paneId, { action, timeoutMs: options.paneControlTimeoutMs });
      } catch (err) {
        result = { ok: false, error: err.message };
      }
    }
    const message = buildRecoveryMessage(action, result);
    let notify = { ok: true, skipped: options.dryRun === true };
    if (options.dryRun !== true) {
      try {
        notify = notifyArchitect(message, { action, result, timeoutMs: options.notifyTimeoutMs });
      } catch (err) {
        notify = { ok: false, error: err.message };
      }
    }
    const event = {
      timestamp: new Date(nowMs).toISOString(),
      action,
      result,
      notify,
      message,
    };
    appendJsonl(eventsPath, event);
    dispatches.push(event);
  }

  persistState(statePath, evaluation.state);
  return {
    ok: dispatches.every((entry) => entry.result?.ok !== false && entry.notify?.ok !== false),
    statePath,
    eventsPath,
    state: evaluation.state,
    panes: evaluation.panes,
    actions: evaluation.actions,
    dispatches,
    probeRequests,
    probeResults,
    latestCommsByRole,
  };
}

module.exports = {
  DEFAULT_APP_STATUS_PATH,
  DEFAULT_CONFIG,
  DEFAULT_EVENTS_PATH,
  DEFAULT_PENDING_DELIVERIES_PATH,
  DEFAULT_SCROLLBACK_PATH,
  DEFAULT_STATE_PATH,
  buildAlertDeliverySignals,
  buildPendingDeliverySignals,
  buildProbeRequests,
  buildRecoveryMessage,
  defaultState,
  evaluateAgentPaneAutoRecovery,
  getDefaultPaneSpecs,
  loadState,
  normalizePaneSpecs,
  persistState,
  queryLatestCommsByRole,
  readPendingDeliveries,
  runAgentPaneAutoRecoveryCycle,
};
