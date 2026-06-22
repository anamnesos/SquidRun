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

function appendShadowRows(filePath, rows, startedAtMs) {
  if (!Array.isArray(rows) || rows.length === 0) return { shadowStartedAtMs: startedAtMs, rows: [] };
  const existing = readShadowLedger(filePath);
  const shadowStartedAtMs = existing.shadowStartedAtMs || startedAtMs;
  const ledger = {
    schema: 'squidrun.the_tell.shadow.ledger.v1',
    shadowStartedAtMs,
    updatedAtMs: rows.reduce((max, row) => Math.max(max, asFiniteNumber(row.ts, 0) || 0), 0),
    rows: [...existing.rows, ...rows],
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

function buildTickRow({ runId, tickId, nowMs, trustQuoteRead, supportedCount, rows, emission }) {
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
  const tickRow = buildTickRow({ runId, tickId, nowMs, trustQuoteRead, supportedCount: supportedSignals.length, rows, emission });
  const ledger = appendShadowRows(ledgerPath, rows, nowMs);
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
  const runId = options.runId || `the-tell-shadow:${Date.now()}`;
  const statusPath = options.statusPath || DEFAULT_STATUS_PATH;
  const pidPath = options.pidPath || DEFAULT_PID_PATH;
  ensureParent(pidPath);
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  writeJson(statusPath, {
    ok: true,
    running: true,
    runId,
    startedAt: nowIso(Date.now()),
    ledgerPath: options.ledgerPath || DEFAULT_LEDGER_PATH,
    intervalMs,
    lastTick: null,
    lastError: null,
  });

  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  async function tick() {
    try {
      return await runShadowTick({ ...options, runId, intervalMs, running: true });
    } catch (error) {
      const status = {
        ok: false,
        running: true,
        runId,
        checkedAt: nowIso(Date.now()),
        ledgerPath: options.ledgerPath || DEFAULT_LEDGER_PATH,
        intervalMs,
        lastError: error.message || 'shadow_tick_failed',
      };
      writeJson(statusPath, status);
      return status;
    }
  }

  if (options.immediate !== false) await tick();
  while (!stopped) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (!stopped) await tick();
  }
  try { fs.unlinkSync(pidPath); } catch {}
  writeJson(statusPath, {
    ok: true,
    running: false,
    runId,
    stoppedAt: nowIso(Date.now()),
    ledgerPath: options.ledgerPath || DEFAULT_LEDGER_PATH,
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
  DEFAULT_LEDGER_PATH,
  DEFAULT_PID_PATH,
  DEFAULT_STATUS_PATH,
  MIN_INTERVAL_MS,
  buildSpokeRow,
  buildSwallowedRows,
  isPidAlive,
  normalizeIntervalMs,
  readStatus,
  readShadowLedger,
  runShadowLoop,
  runShadowTick,
  verifyRefsForSignal,
};
