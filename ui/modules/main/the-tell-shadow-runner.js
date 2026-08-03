'use strict';

const fs = require('fs');
const path = require('path');
const { evaluate } = require('../the-tell/scorer');
const { fetchTrustQuoteReadOnlySignals } = require('./trustquote-tell-feed');
const { supportedScorerSignals } = require('./spine-overlay-snapshot');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNTIME_ROOT = path.join(PROJECT_ROOT, '.squidrun', 'runtime');
const DEFAULT_LEDGER_PATH = path.join(RUNTIME_ROOT, 'the-tell-shadow-ledger.json');
const DEFAULT_STATUS_PATH = path.join(RUNTIME_ROOT, 'the-tell-shadow-status.json');
const DEFAULT_PID_PATH = path.join(RUNTIME_ROOT, 'the-tell-shadow-runner.pid');
const DEFAULT_INTERVAL_MS = 20 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_LEDGER_ROWS = 5000;
const DEFAULT_LIVENESS_STALE_THRESHOLD_MS = 25 * 60 * 60 * 1000;
const LIVENESS_STALE_MS = 3 * 60 * 60 * 1000;
const LIVENESS_AGING_MS = 40 * 60 * 1000;
const DEFAULT_TICK_DEADLINE_MULTIPLIER = 2;

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, data) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readShadowLedger(filePath = DEFAULT_LEDGER_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      shadowStartedAtMs: asFiniteNumber(parsed.shadowStartedAtMs, null),
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { shadowStartedAtMs: null, rows: [] };
    throw error;
  }
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function asPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const integer = Math.floor(numeric);
  return integer > 0 ? integer : fallback;
}

function asNonNegativeInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const integer = Math.floor(numeric);
  return integer >= 0 ? integer : fallback;
}

function latestSuccessfulTickFromLedger(ledgerPath) {
  if (!ledgerPath) return null;
  try {
    const ledger = readShadowLedger(ledgerPath);
    let latest = null;
    for (const row of ledger.rows) {
      if (!row || row.type !== 'tick' || !Number.isFinite(Number(row.ts))) continue;
      const ts = Math.floor(Number(row.ts));
      if (latest === null || ts > latest.ts) {
        latest = {
          ts,
          checkedAt: asNonEmptyString(row.checkedAt || row.observedAt) || null,
          tickId: asNonEmptyString(row.tickId) || null,
        };
      }
    }
    return latest;
  } catch {
    return null;
  }
}

function classifyShadowRunnerLiveness({
  lastTickAgeMs,
  lastActivityType,
  staleThresholdMs = DEFAULT_LIVENESS_STALE_THRESHOLD_MS,
  statusFilePresent,
}) {
  if (statusFilePresent !== true) {
    return { status: 'missing', stale: false, staleReasons: [] };
  }
  if (lastActivityType && lastActivityType !== 'tick') {
    return { status: 'blind', stale: true, staleReasons: [`last_tick_${lastActivityType}`] };
  }
  if (!Number.isFinite(Number(lastTickAgeMs))) {
    return { status: 'dead', stale: true, staleReasons: ['no_successful_tick'] };
  }
  const ageMs = Number(lastTickAgeMs);
  if (ageMs >= staleThresholdMs) {
    return { status: 'dead', stale: true, staleReasons: ['last_tick_dead'] };
  }
  if (ageMs >= LIVENESS_STALE_MS) {
    return { status: 'stale', stale: true, staleReasons: ['last_tick_stale'] };
  }
  if (ageMs >= LIVENESS_AGING_MS) {
    return { status: 'aging', stale: false, staleReasons: [] };
  }
  return { status: 'fresh', stale: false, staleReasons: [] };
}

function readPid(pidPath = DEFAULT_PID_PATH) {
  if (!pidPath) return null;
  try {
    return asPositiveInt(fs.readFileSync(pidPath, 'utf8').trim(), null);
  } catch {
    return null;
  }
}

function inspectShadowRunnerStatus(options = {}) {
  const statusPath = options.statusPath || DEFAULT_STATUS_PATH;
  const fallbackLedgerPath = options.ledgerPath || DEFAULT_LEDGER_PATH;
  const pidPath = Object.prototype.hasOwnProperty.call(options, 'pidPath')
    ? options.pidPath
    : DEFAULT_PID_PATH;
  const nowMs = asFiniteNumber(options.nowMs, Date.now());
  const staleThresholdMs = Math.max(
    60 * 1000,
    asFiniteNumber(options.staleThresholdMs, DEFAULT_LIVENESS_STALE_THRESHOLD_MS)
  );
  const requirePid = options.requirePid === true;
  const pid = Object.prototype.hasOwnProperty.call(options, 'pid')
    ? asPositiveInt(options.pid, null)
    : readPid(pidPath);
  const pidAlive = Object.prototype.hasOwnProperty.call(options, 'pidAlive')
    ? options.pidAlive === true
    : isPidAlive(pid);

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch (error) {
    const missing = error.code === 'ENOENT';
    return {
      ok: missing,
      status: missing ? 'missing' : 'read_error',
      path: statusPath,
      statusFilePresent: !missing,
      running: false,
      reportedRunning: false,
      tickFresh: false,
      runId: null,
      tickId: null,
      lastTickAt: null,
      lastTickAtMs: null,
      lastTickAgeMs: null,
      lastActivityAt: null,
      lastActivityAtMs: null,
      lastActivityAgeMs: null,
      lastActivityType: null,
      staleThresholdMs,
      intervalMs: null,
      ledgerRows: null,
      ledgerPath: fallbackLedgerPath,
      counts: null,
      stale: !missing,
      staleReasons: missing ? [] : ['status_read_error'],
      error: missing ? null : error.message,
      pid,
      pidAlive,
      pidPath: pidPath || null,
    };
  }

  const statusObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const lastTick = statusObject.lastTick && typeof statusObject.lastTick === 'object' && !Array.isArray(statusObject.lastTick)
    ? statusObject.lastTick
    : {};
  const ledgerPath = asNonEmptyString(statusObject.ledgerPath) || fallbackLedgerPath;
  const latestSuccessfulTick = latestSuccessfulTickFromLedger(ledgerPath);
  const lastActivityAt = asNonEmptyString(lastTick.checkedAt || statusObject.checkedAt || lastTick.observedAt) || null;
  const rawLastActivityMs = Number.isFinite(Number(lastTick.ts))
    ? Number(lastTick.ts)
    : (lastActivityAt ? Date.parse(lastActivityAt) : NaN);
  const lastActivityAtMs = Number.isFinite(rawLastActivityMs) ? Math.floor(rawLastActivityMs) : null;
  const lastActivityAgeMs = lastActivityAtMs !== null ? Math.max(0, nowMs - lastActivityAtMs) : null;
  const lastActivityType = asNonEmptyString(lastTick.type || lastTick.rowType) || null;
  const statusSuccessfulTick = lastActivityType === 'tick' && Number.isFinite(Number(lastTick.ts))
    ? {
      ts: Math.floor(Number(lastTick.ts)),
      checkedAt: lastActivityAt,
      tickId: asNonEmptyString(lastTick.tickId) || null,
    }
    : null;
  const successfulTick = latestSuccessfulTick || statusSuccessfulTick;
  const lastTickAtMs = successfulTick ? successfulTick.ts : null;
  const lastTickAt = successfulTick?.checkedAt || (lastTickAtMs !== null ? new Date(lastTickAtMs).toISOString() : null);
  const lastTickAgeMs = lastTickAtMs !== null ? Math.max(0, nowMs - lastTickAtMs) : null;
  const classification = classifyShadowRunnerLiveness({
    lastTickAgeMs,
    lastActivityType,
    staleThresholdMs,
    statusFilePresent: true,
  });
  const tickFresh = classification.status === 'fresh' || classification.status === 'aging';
  const reportedRunning = statusObject.running === true;
  const effectiveRunning = Boolean(reportedRunning && tickFresh && (!requirePid || pidAlive === true));

  return {
    ok: statusObject.ok === true && classification.stale !== true,
    status: classification.status,
    path: statusPath,
    statusFilePresent: true,
    running: effectiveRunning,
    reportedRunning,
    tickFresh,
    runId: asNonEmptyString(statusObject.runId) || null,
    tickId: successfulTick?.tickId || asNonEmptyString(statusObject.tickId || lastTick.tickId) || null,
    lastTickAt,
    lastTickAtMs,
    lastTickAgeMs,
    lastActivityAt,
    lastActivityAtMs,
    lastActivityAgeMs,
    lastActivityType,
    staleThresholdMs,
    intervalMs: asPositiveInt(statusObject.intervalMs || lastTick.intervalMs, null),
    ledgerRows: asNonNegativeInt(statusObject.ledgerRows, null),
    ledgerPath,
    counts: lastTick.counts && typeof lastTick.counts === 'object' && !Array.isArray(lastTick.counts)
      ? lastTick.counts
      : null,
    stale: classification.stale,
    staleReasons: classification.staleReasons,
    error: statusObject.lastError || null,
    pid,
    pidAlive,
    pidPath: pidPath || null,
  };
}

function appendShadowRows(filePath, rows, startedAtMs, maxRows = process.env.SQUIDRUN_THE_TELL_SHADOW_LEDGER_MAX_ROWS) {
  if (!Array.isArray(rows) || rows.length === 0) return { shadowStartedAtMs: startedAtMs, rows: [] };
  const existing = readShadowLedger(filePath);
  const shadowStartedAtMs = existing.shadowStartedAtMs || startedAtMs;
  const retainedRows = [...existing.rows, ...rows].slice(-normalizeMaxLedgerRows(maxRows));
  const ledger = {
    schema: 'squidrun.the_tell.shadow.ledger.v1',
    shadowStartedAtMs,
    updatedAtMs: rows.reduce((max, row) => Math.max(max, asFiniteNumber(row.ts, 0) || 0), 0),
    rows: retainedRows,
  };
  writeJson(filePath, ledger);
  return ledger;
}

function asFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeIntervalMs(value) {
  const numeric = asFiniteNumber(value, DEFAULT_INTERVAL_MS);
  return Math.max(MIN_INTERVAL_MS, numeric || DEFAULT_INTERVAL_MS);
}

function normalizeMaxLedgerRows(value) {
  const numeric = asFiniteNumber(value, null);
  if (!Number.isInteger(numeric) || numeric <= 0) return DEFAULT_MAX_LEDGER_ROWS;
  return Math.max(100, numeric);
}

function normalizeTickDeadlineMs(value, intervalMs = DEFAULT_INTERVAL_MS) {
  const explicit = asFiniteNumber(value, null);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(10, Math.floor(explicit));
  const interval = normalizeIntervalMs(intervalMs);
  return Math.max(1000, Math.floor(interval * DEFAULT_TICK_DEADLINE_MULTIPLIER));
}

function timeoutError(message, details = {}) {
  const error = new Error(message);
  error.code = details.code || 'shadow_tick_timeout';
  error.timeoutMs = details.timeoutMs || null;
  error.tickId = details.tickId || null;
  return error;
}

function withDeadline(promise, deadlineMs, details = {}) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(timeoutError(details.message || 'shadow_tick_timeout', {
        code: details.code,
        timeoutMs: deadlineMs,
        tickId: details.tickId,
      }));
    }, deadlineMs);
    if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function firestoreRefs(rawRefs = {}) {
  if (!rawRefs || typeof rawRefs !== 'object') return [];
  const refs = [];
  if (rawRefs.collection && rawRefs.docId) {
    refs.push({
      system: rawRefs.system || 'trustquote',
      collection: rawRefs.collection,
      docId: rawRefs.docId,
      path: `${rawRefs.collection}/${rawRefs.docId}`,
      businessId: rawRefs.businessId || null,
      customerId: rawRefs.customerId || null,
      customerIdentityKey: rawRefs.customerIdentityKey || null,
    });
  }
  if (Array.isArray(rawRefs.eventIds)) {
    for (const eventId of rawRefs.eventIds) {
      refs.push({
        system: rawRefs.system || 'trustquote',
        collection: rawRefs.collection || 'calendar-events',
        docId: eventId,
        path: `${rawRefs.collection || 'calendar-events'}/${eventId}`,
        businessId: rawRefs.businessId || null,
      });
    }
  }
  return refs;
}

function numericFacts(facts = {}) {
  const picked = {};
  for (const key of [
    'invoiceAmount',
    'balanceDue',
    'dueMs',
    'paymentReceivedMs',
    'lastChasedMs',
    'bidAmount',
    'bidPrice',
    'bidCost',
    'bidMarginPct',
    'jobValue',
    'tasksTotal',
    'tasksIncomplete',
  ]) {
    if (facts[key] !== undefined && facts[key] !== null) picked[key] = facts[key];
  }
  const historical = facts.historicalMargin || {};
  if (historical && typeof historical === 'object') {
    picked.historicalMargin = {
      floorPct: historical.floorPct ?? null,
      sampleCount: historical.sampleCount ?? null,
      jobIds: Array.isArray(historical.jobIds) ? historical.jobIds : [],
    };
  }
  if (Array.isArray(facts.commitments)) {
    picked.commitments = facts.commitments.map((commitment) => ({
      id: commitment.id,
      rawRef: commitment.rawRef,
      startMs: commitment.startMs,
      endMs: commitment.endMs,
      durationMin: commitment.durationMin,
      confirmed: commitment.confirmed,
      customerId: commitment.customerId,
      madeInContextRef: commitment.madeInContextRef,
    }));
  }
  if (facts.taskSummary && typeof facts.taskSummary === 'object') {
    picked.taskSummary = facts.taskSummary;
  }
  return picked;
}

function verifyRefsForSignal(signal = {}, speech = {}) {
  const facts = signal.facts || {};
  return {
    system: signal.rawRefs?.system || 'trustquote',
    firestore: firestoreRefs(signal.rawRefs),
    numbers: numericFacts(facts),
    scorerVerify: speech.verify || null,
    receipts: Array.isArray(speech.receipts) ? speech.receipts : [],
  };
}

function indexSignals(signals = []) {
  const byId = new Map();
  for (const signal of signals) {
    if (signal?.id) byId.set(signal.id, signal);
  }
  return byId;
}

function buildSpokeRow({ runId, tickId, nowMs, emission }) {
  const winner = emission?._winner;
  const signal = winner?._sig || {};
  return {
    ts: nowMs,
    type: 'spoke',
    signalClass: signal.type || winner?.type || null,
    key: signal.id || winner?.key || null,
    claim: emission.claim || null,
    regretScore: emission.regretScore || 0,
    verify: verifyRefsForSignal(signal, emission),
    review: { verdict: 'pending', by: null, at: null },
    runId,
    tickId,
    source: emission.source || signal.source || 'unverified',
    context: emission.context || signal.context || signal.type || null,
    rawRefs: signal.rawRefs || {},
    whyNow: emission.whyNow || null,
    proposedAction: {
      ...(emission.proposedAction || {}),
      reversible: true,
      executionMode: 'dry-run',
    },
    pushback: emission.pushback || null,
    dryRun: true,
    readOnly: true,
  };
}

function buildSwallowedRows({ runId, tickId, nowMs, emission, signalById }) {
  const swallowed = Array.isArray(emission?.swallowed) ? emission.swallowed : [];
  return swallowed.map((entry) => {
    const signal = signalById.get(entry.key) || null;
    return {
      ts: nowMs,
      type: 'swallowed',
      signalClass: entry.signal || signal?.type || null,
      key: entry.key || signal?.id || null,
      reason: entry.reason || null,
      runId,
      tickId,
      source: emission.source || signal?.source || 'unverified',
      context: entry.context || signal?.context || signal?.type || entry.signal || null,
      rawRefs: signal?.rawRefs || {},
      verify: signal ? verifyRefsForSignal(signal, {}) : {
        system: 'trustquote',
        firestore: [],
        numbers: entry.snapshot || {},
        scorerVerify: null,
        receipts: [],
      },
      regretScore: entry.regretScore || 0,
      wouldHaveSaid: entry.wouldHaveSaid || null,
      snapshot: entry.snapshot || {},
      dryRun: true,
      readOnly: true,
    };
  });
}

function buildTickRow({ runId, tickId, nowMs, trustQuoteRead, supportedCount, rows, emission, intervalMs = null }) {
  return {
    schema: 'squidrun.the_tell.shadow.status.v1',
    type: 'tick',
    runId,
    tickId,
    ts: nowMs,
    checkedAt: nowIso(nowMs),
    source: trustQuoteRead?.source || emission?.source || 'unverified',
    ok: trustQuoteRead?.ok === true,
    readOnly: true,
    dryRun: true,
    intervalMs,
    counts: {
      jobs: trustQuoteRead?.data?.counts?.jobs || 0,
      quotes: trustQuoteRead?.data?.counts?.quotes || 0,
      events: trustQuoteRead?.data?.eventCount || 0,
      parked: trustQuoteRead?.data?.parkedCount || 0,
      supportedSignals: supportedCount,
      spokeRows: rows.filter((row) => row.type === 'spoke').length,
      swallowedRows: rows.filter((row) => row.type === 'swallowed').length,
    },
    reason: trustQuoteRead?.reason || null,
  };
}

function buildLedgerTickRow(tickRow = {}) {
  const ok = tickRow.ok === true;
  return {
    schema: 'squidrun.the_tell.shadow.ledger.v1',
    type: ok ? 'tick' : 'tick_failed',
    runId: tickRow.runId || null,
    tickId: tickRow.tickId || null,
    ts: tickRow.ts || null,
    checkedAt: tickRow.checkedAt || null,
    source: tickRow.source || 'unverified',
    ok,
    readOnly: true,
    dryRun: true,
    intervalMs: tickRow.intervalMs || null,
    counts: tickRow.counts || {},
    reason: tickRow.reason || null,
  };
}

function buildFailedTickRow({ runId, tickId, nowMs, intervalMs = null, reason = 'shadow_tick_failed', errorCode = null }) {
  return {
    schema: 'squidrun.the_tell.shadow.status.v1',
    type: 'tick_failed',
    runId,
    tickId,
    ts: nowMs,
    checkedAt: nowIso(nowMs),
    source: 'unverified',
    ok: false,
    readOnly: true,
    dryRun: true,
    intervalMs,
    counts: {
      jobs: 0,
      quotes: 0,
      events: 0,
      parked: 0,
      supportedSignals: 0,
      spokeRows: 0,
      swallowedRows: 0,
    },
    reason,
    errorCode,
  };
}

function writeFailedTickStatus({
  ledgerPath = DEFAULT_LEDGER_PATH,
  statusPath = DEFAULT_STATUS_PATH,
  runId,
  tickId,
  intervalMs,
  error,
  running = true,
  maxLedgerRows = process.env.SQUIDRUN_THE_TELL_SHADOW_LEDGER_MAX_ROWS,
  nowMs = Date.now(),
}) {
  const reason = error?.code || error?.message || 'shadow_tick_failed';
  const tickRow = buildFailedTickRow({
    runId,
    tickId,
    nowMs,
    intervalMs,
    reason,
    errorCode: error?.code || null,
  });
  const livenessRow = buildLedgerTickRow(tickRow);
  const ledger = appendShadowRows(ledgerPath, [livenessRow], nowMs, maxLedgerRows);
  const status = {
    ok: false,
    running: Boolean(running),
    runId,
    tickId,
    checkedAt: nowIso(nowMs),
    ledgerPath,
    intervalMs,
    lastTick: tickRow,
    ledgerRows: ledger.rows.length,
    lastError: error?.message || reason,
    lastErrorCode: error?.code || null,
    timeoutMs: error?.timeoutMs || null,
  };
  writeJson(statusPath, status);
  return status;
}

async function runShadowTick(options = {}) {
  const nowMs = asFiniteNumber(options.nowMs, Date.now());
  const runId = options.runId || `the-tell-shadow:${nowMs}`;
  const tickId = options.tickId || `${runId}:tick:${nowMs}`;
  const ledgerPath = options.ledgerPath || DEFAULT_LEDGER_PATH;
  const statusPath = options.statusPath || DEFAULT_STATUS_PATH;
  const fetchSignals = options.fetchTrustQuoteReadOnlySignals || fetchTrustQuoteReadOnlySignals;
  const evaluateImpl = options.evaluate || evaluate;

  const trustQuoteRead = await fetchSignals({ ...options, nowMs, source: 'live' });
  const signals = Array.isArray(trustQuoteRead?.data?.signals) ? trustQuoteRead.data.signals : [];
  const supportedSignals = supportedScorerSignals(signals);
  const emission = supportedSignals.length > 0
    ? evaluateImpl({
      positions: [],
      signals: supportedSignals,
      accountValue: null,
      nowMs,
      glanceAtMs: nowMs,
      state: options.scorerState || {},
      source: trustQuoteRead?.ok === true ? 'live' : 'unverified',
      parkTrading: true,
    })
    : {
      source: trustQuoteRead?.ok === true ? 'live' : 'unverified',
      regretScore: 0,
      context: 'work-life:none',
      speak: false,
      swallowed: [],
    };

  const signalById = indexSignals(supportedSignals);
  const rows = [];
  if (emission.speak === true && emission._winner) {
    rows.push(buildSpokeRow({ runId, tickId, nowMs, emission }));
  }
  rows.push(...buildSwallowedRows({ runId, tickId, nowMs, emission, signalById }));
  const tickRow = buildTickRow({
    runId,
    tickId,
    nowMs,
    trustQuoteRead,
    supportedCount: supportedSignals.length,
    rows,
    emission,
    intervalMs: options.intervalMs || null,
  });
  const livenessRow = buildLedgerTickRow(tickRow);
  const ledgerRows = [livenessRow, ...rows];
  const ledger = appendShadowRows(ledgerPath, ledgerRows, nowMs, options.maxLedgerRows);
  const status = {
    ok: true,
    running: Boolean(options.running),
    runId,
    tickId,
    checkedAt: nowIso(nowMs),
    ledgerPath,
    intervalMs: options.intervalMs || null,
    lastTick: tickRow,
    ledgerRows: ledger.rows.length,
    lastError: null,
  };
  writeJson(statusPath, status);
  return { ok: true, runId, tickId, ledgerPath, statusPath, rows: [tickRow, ...rows], ledger, emission, trustQuoteRead };
}

async function runShadowLoop(options = {}) {
  const intervalMs = normalizeIntervalMs(options.intervalMs);
  const tickDeadlineMs = normalizeTickDeadlineMs(options.tickDeadlineMs, intervalMs);
  const runId = options.runId || `the-tell-shadow:${Date.now()}`;
  const statusPath = options.statusPath || DEFAULT_STATUS_PATH;
  const pidPath = options.pidPath || DEFAULT_PID_PATH;
  const ledgerPath = options.ledgerPath || DEFAULT_LEDGER_PATH;
  const exitProcess = typeof options.exitProcess === 'function'
    ? options.exitProcess
    : ((code) => process.exit(code));
  ensureParent(pidPath);
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  writeJson(statusPath, {
    ok: true,
    running: true,
    runId,
    startedAt: nowIso(Date.now()),
    ledgerPath,
    intervalMs,
    tickDeadlineMs,
    lastTick: null,
    lastError: null,
  });

  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  async function tick() {
    const tickNowMs = Date.now();
    const tickId = `${runId}:tick:${tickNowMs}`;
    try {
      return await withDeadline(
        runShadowTick({ ...options, runId, tickId, intervalMs, running: true }),
        tickDeadlineMs,
        {
          tickId,
          code: 'shadow_tick_timeout',
          message: `shadow_tick_timeout after ${tickDeadlineMs}ms`,
        }
      );
    } catch (error) {
      const status = writeFailedTickStatus({
        ledgerPath,
        statusPath,
        runId,
        tickId,
        intervalMs,
        error,
        running: true,
        maxLedgerRows: options.maxLedgerRows,
      });
      if (error?.code === 'shadow_tick_timeout') {
        stopped = true;
        exitProcess(1);
      }
      return status;
    }
  }

  if (options.immediate !== false) {
    const firstTick = await tick();
    if (stopped) return firstTick;
  }
  while (!stopped) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (!stopped) {
      const nextTick = await tick();
      if (stopped) return nextTick;
    }
  }
  try { fs.unlinkSync(pidPath); } catch {}
  writeJson(statusPath, {
    ok: true,
    running: false,
    runId,
    stoppedAt: nowIso(Date.now()),
    ledgerPath,
    intervalMs,
  });
}

function readStatus(statusPath = DEFAULT_STATUS_PATH) {
  try {
    return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch (error) {
    return { ok: false, running: false, reason: error.code === 'ENOENT' ? 'missing_status' : error.message, statusPath };
  }
}

function isPidAlive(pid) {
  const numeric = Number.parseInt(String(pid || ''), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_LIVENESS_STALE_THRESHOLD_MS,
  DEFAULT_LEDGER_PATH,
  DEFAULT_MAX_LEDGER_ROWS,
  DEFAULT_PID_PATH,
  DEFAULT_STATUS_PATH,
  DEFAULT_TICK_DEADLINE_MULTIPLIER,
  MIN_INTERVAL_MS,
  buildFailedTickRow,
  buildLedgerTickRow,
  buildSpokeRow,
  buildSwallowedRows,
  classifyShadowRunnerLiveness,
  inspectShadowRunnerStatus,
  isPidAlive,
  latestSuccessfulTickFromLedger,
  normalizeIntervalMs,
  normalizeMaxLedgerRows,
  normalizeTickDeadlineMs,
  readStatus,
  readShadowLedger,
  runShadowLoop,
  runShadowTick,
  writeFailedTickStatus,
  verifyRefsForSignal,
};
