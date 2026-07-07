#!/usr/bin/env node
'use strict';

/**
 * hm-model-audit: who actually answered? (S468 — born from the router scare)
 *
 * Post-July-1, Anthropic's safety classifier can silently serve Opus 4.8
 * where Fable 5 was expected; the claude.ai webapp shows a notice, Claude
 * Code shows nothing. But every Claude Code session transcript records the
 * SERVING model on each assistant turn — so the blindness is optional.
 * This tool reads the transcripts and answers with numbers instead of vibes.
 * First live run (2026-07-04): July 2 = 2768/2768 Fable, July 3 = 576/576 —
 * zero silent substitutions on this machine; the audition evidence is clean.
 *
 *   node ui/scripts/hm-model-audit.js [--dir <claude-projects-dir>] [--since YYYY-MM-DD] [--per-file]
 *   node ui/scripts/hm-model-audit.js watch [--dir D] [--expect MODEL] [--interval-s 60]
 *
 * watch mode (James, 2026-07-04 04:21: "you don't know when you silently
 * fall back!"): correct — no model can feel its own weights mid-answer.
 * So this shrinks the blind window to one poll interval: tail the
 * transcripts and ALERT (Telegram + stderr) the moment any new turn logs a
 * serving model that drifts from the pane's current settings. Lagging detector,
 * minutes -> seconds.
 * The label-independent backstop remains the verdict ledger: it measures
 * OUTPUT quality, which no routing label can fake.
 *
 * Default dir: every *.jsonl under
 *   %USERPROFILE%/.claude/projects/D--projects-squidrun
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  detectCli,
  normalizeClaudeModelId,
  parseClaudeModelFromCommand,
} = require('../modules/cli-resume-invocation');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SETTINGS_PATH = path.resolve(__dirname, '..', 'settings.json');
const DEFAULT_PANE_SESSION_IDS_PATH = path.join(PROJECT_ROOT, '.squidrun', 'runtime', 'pane-session-ids.json');
const DEFAULT_RUNTIME_DIR = path.join(PROJECT_ROOT, '.squidrun', 'runtime');
const DEFAULT_WATCH_PID_PATH = path.join(DEFAULT_RUNTIME_DIR, 'hm-model-audit-watch.pid');
const DEFAULT_WATCH_STATUS_PATH = path.join(DEFAULT_RUNTIME_DIR, 'hm-model-audit-watch-status.json');
const DEFAULT_WATCH_OUT_LOG_PATH = path.join(DEFAULT_RUNTIME_DIR, 'hm-model-audit-watch.out.log');
const DEFAULT_WATCH_ERR_LOG_PATH = path.join(DEFAULT_RUNTIME_DIR, 'hm-model-audit-watch.err.log');
const WATCH_START_GRACE_MS = 10 * 1000;
const WATCH_MIN_STALE_AFTER_MS = 30 * 1000;
const FALLBACK_REASON_EXCERPT_MAX_CHARS = 140;

function reasonExcerpt(text = '', maxChars = FALLBACK_REASON_EXCERPT_MAX_CHARS) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length > maxChars ? compact.slice(0, maxChars) : compact;
}

function parseFallbackRecordsFromLine(line = '') {
  if (!line || (!line.includes('"fallback"') && !line.includes('model_refusal_fallback'))) {
    return { fallbacks: [], refusalFallbacks: [] };
  }
  let rec;
  try { rec = JSON.parse(line); } catch { return { fallbacks: [], refusalFallbacks: [] }; }

  const timestamp = rec?.timestamp || null;
  const requestId = rec?.requestId || null;
  const fallbacks = [];
  const content = Array.isArray(rec?.message?.content) ? rec.message.content : [];
  for (const part of content) {
    if (part?.type !== 'fallback') continue;
    const fromModel = part?.from?.model || '';
    const toModel = part?.to?.model || '';
    if (!fromModel && !toModel) continue;
    fallbacks.push({ timestamp, fromModel, toModel, requestId });
  }

  const refusalFallbacks = [];
  if (rec?.type === 'system' && rec?.subtype === 'model_refusal_fallback') {
    refusalFallbacks.push({
      timestamp,
      reasonExcerpt: reasonExcerpt(rec?.content || ''),
      requestId,
      fromModel: rec?.originalModel || '',
      toModel: rec?.fallbackModel || '',
    });
  }

  return { fallbacks, refusalFallbacks };
}

function extractModelFallbackRecords(lines) {
  const records = { fallbacks: [], refusalFallbacks: [] };
  for (const line of lines) {
    const parsed = parseFallbackRecordsFromLine(line);
    records.fallbacks.push(...parsed.fallbacks);
    records.refusalFallbacks.push(...parsed.refusalFallbacks);
  }
  return records;
}

function matchRefusalFallback(fallback, refusalFallbacks = []) {
  if (!fallback) return null;
  if (fallback.requestId) {
    const requestMatch = refusalFallbacks.find((item) => item.requestId === fallback.requestId);
    if (requestMatch) return requestMatch;
  }
  const fallbackMs = timestampMs(fallback.timestamp);
  if (!fallbackMs) return refusalFallbacks[0] || null;
  return refusalFallbacks.find((item) => {
    const itemMs = timestampMs(item.timestamp);
    return itemMs && itemMs >= fallbackMs && itemMs - fallbackMs <= 2 * 60 * 1000;
  }) || refusalFallbacks[0] || null;
}

function fallbackEventsByDay(lines, { since = '' } = {}) {
  const counts = {};
  const seen = new Set();
  for (const line of lines) {
    const parsed = parseFallbackRecordsFromLine(line);
    for (const fallback of parsed.fallbacks) {
      const day = String(fallback.timestamp || '').slice(0, 10);
      if (!day || day < since) continue;
      const key = fallback.requestId
        || `${fallback.timestamp || ''}|${fallback.fromModel || ''}|${fallback.toModel || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts[day] = (counts[day] || 0) + 1;
    }
  }
  return counts;
}

/** Pure: fold transcript lines into { day: { model: count } }. */
function tallyModelsByDay(lines, { since = '' } = {}) {
  const counts = {};
  for (const line of lines) {
    if (!line || !line.includes('"model"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const model = rec?.message?.model;
    const day = String(rec?.timestamp || '').slice(0, 10);
    if (!model || !day || day < since) continue;
    counts[day] = counts[day] || {};
    counts[day][model] = (counts[day][model] || 0) + 1;
  }
  const fallbacks = fallbackEventsByDay(lines, { since });
  for (const [day, count] of Object.entries(fallbacks)) {
    counts[day] = counts[day] || {};
    counts[day].fallbacks = (counts[day].fallbacks || 0) + count;
  }
  return counts;
}

/** Merge b into a (mutates a). */
function mergeTallies(a, b) {
  for (const [day, models] of Object.entries(b)) {
    a[day] = a[day] || {};
    for (const [model, n] of Object.entries(models)) {
      a[day][model] = (a[day][model] || 0) + n;
    }
  }
  return a;
}

function auditDir(dir, { since = '', perFile = false } = {}) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const total = {};
  const byFile = {};
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    const tally = tallyModelsByDay(text.split('\n'), { since });
    if (perFile && Object.keys(tally).length) byFile[file] = tally;
    mergeTallies(total, tally);
  }
  return { dir, filesScanned: files.length, byDay: total, ...(perFile ? { byFile } : {}) };
}

/** Pure: new offending turns from freshly-appended lines. '<synthetic>'
 * rows are harness bookkeeping, never a served response — ignored. */
function modelFamily(model = '') {
  const normalized = normalizeClaudeModelId(model).toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('fable')) return 'fable';
  if (normalized.includes('sonnet')) return 'sonnet';
  return normalized;
}

function modelMatchesExpected(servedModel = '', expectedModel = '') {
  const served = normalizeClaudeModelId(servedModel);
  const expected = normalizeClaudeModelId(expectedModel);
  if (!served || !expected) return false;
  if (served.toLowerCase() === expected.toLowerCase()) return true;

  // UI/settings often use compact Claude aliases such as "opus"; transcripts
  // log the concrete serving id such as "claude-opus-4-8".
  if (/^(?:claude-)?(?:opus|fable|sonnet)$/i.test(expected)) {
    return modelFamily(served) === modelFamily(expected);
  }
  return false;
}

function scanModelTurns(lines, expectModel) {
  const turns = [];
  for (const line of lines) {
    if (!line || !line.includes('"model"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const model = rec?.message?.model;
    if (!model || model === '<synthetic>') continue;
    turns.push({
      model,
      timestamp: rec?.timestamp || null,
      offending: !modelMatchesExpected(model, expectModel),
    });
  }
  return turns;
}

function findOffendingTurns(lines, expectModel) {
  return scanModelTurns(lines, expectModel)
    .filter((turn) => turn.offending)
    .map(({ model, timestamp }) => ({ model, timestamp }));
}

function readJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, payload) {
  ensureParent(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function asPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const integer = Math.floor(numeric);
  return integer > 0 ? integer : fallback;
}

function readPidInfo(pidPath = DEFAULT_WATCH_PID_PATH) {
  try {
    const stat = fs.statSync(pidPath);
    return {
      pid: asPositiveInt(fs.readFileSync(pidPath, 'utf8').trim(), null),
      mtimeMs: Number(stat.mtimeMs || 0),
    };
  } catch {
    return { pid: null, mtimeMs: 0 };
  }
}

function isPidAlive(pid) {
  const numeric = asPositiveInt(pid, null);
  if (!numeric) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function readStatusInfo(statusPath = DEFAULT_WATCH_STATUS_PATH) {
  try {
    const stat = fs.statSync(statusPath);
    return {
      value: JSON.parse(fs.readFileSync(statusPath, 'utf8')),
      mtimeMs: Number(stat.mtimeMs || 0),
    };
  } catch {
    return { value: null, mtimeMs: 0 };
  }
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionIdFromTranscriptFile(file = '') {
  return path.basename(String(file || '')).replace(/\.jsonl$/i, '');
}

function findPaneIdForSession(sessionId = '', paneSessionIds = {}) {
  const panes = paneSessionIds?.panes && typeof paneSessionIds.panes === 'object'
    ? paneSessionIds.panes
    : {};
  for (const [paneId, id] of Object.entries(panes)) {
    if (String(id || '') === String(sessionId || '')) return String(paneId);
  }
  return '';
}

function expectedModelFromPaneSettings(settings = {}, paneId = '') {
  const paneCommands = settings?.paneCommands && typeof settings.paneCommands === 'object'
    ? settings.paneCommands
    : {};
  const command = String(paneCommands[String(paneId)] || '').trim();
  if (detectCli(command) !== 'claude') {
    return { expectedModel: '', source: command ? 'non-claude-pane-command' : 'missing-pane-command' };
  }

  const commandModel = parseClaudeModelFromCommand(command);
  if (commandModel) return { expectedModel: commandModel, source: 'pane-command' };

  const settingsModel = normalizeClaudeModelId(settings?.claudeModel || '');
  if (settingsModel) return { expectedModel: settingsModel, source: 'settings-claudeModel' };

  return { expectedModel: '', source: 'missing-claude-model' };
}

function expectedModelsFromSettings(settings = {}) {
  const paneCommands = settings?.paneCommands && typeof settings.paneCommands === 'object'
    ? settings.paneCommands
    : {};
  return Object.keys(paneCommands)
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
    .map((paneId) => {
      const expected = expectedModelFromPaneSettings(settings, paneId);
      return expected.expectedModel
        ? { paneId: String(paneId), expectedModel: expected.expectedModel, source: expected.source }
        : null;
    })
    .filter(Boolean);
}

function resolveExpectedModelForTranscript(file, options = {}) {
  const explicit = normalizeClaudeModelId(options.explicitExpect || options.expect || '');
  if (explicit) return { expectedModel: explicit, paneId: '', source: 'explicit-expect' };

  const settings = options.settings || {};
  const paneSessionIds = options.paneSessionIds || {};
  const sessionId = sessionIdFromTranscriptFile(file);
  const paneId = findPaneIdForSession(sessionId, paneSessionIds);
  if (!paneId) return { expectedModel: '', paneId: '', source: 'unmapped-session' };

  return {
    ...expectedModelFromPaneSettings(settings, paneId),
    paneId,
  };
}

function findOffendingTurnsForTranscript(file, lines, options = {}) {
  const expected = resolveExpectedModelForTranscript(file, options);
  if (!expected.expectedModel) return [];
  return findOffendingTurns(lines, expected.expectedModel).map((turn) => ({
    file,
    ...turn,
    expectedModel: expected.expectedModel,
    paneId: expected.paneId,
    source: expected.source,
  }));
}

function findModelFallbacksForTranscript(file, lines, options = {}) {
  const paneSessionIds = options.paneSessionIds || {};
  const sessionId = sessionIdFromTranscriptFile(file);
  const paneId = findPaneIdForSession(sessionId, paneSessionIds);
  if (!paneId) return [];
  const records = extractModelFallbackRecords(lines);
  return records.fallbacks.map((fallback) => {
    const reason = matchRefusalFallback(fallback, records.refusalFallbacks);
    return {
      file,
      paneId,
      timestamp: fallback.timestamp || null,
      fromModel: fallback.fromModel || reason?.fromModel || '',
      toModel: fallback.toModel || reason?.toModel || '',
      reasonExcerpt: reason?.reasonExcerpt || '',
      requestId: fallback.requestId || reason?.requestId || null,
    };
  });
}

const DEFAULT_REALERT_MS = 60 * 60 * 1000;

/** Alert policy with an injectable clock. Emits `substitution` on a new
 * offending state, `still-offending` every realertMs while it persists, and
 * `recovered` when the file returns to its expected model. Born from
 * 2026-07-06: two 05:28 pings, then ELEVEN silent Opus hours — an ongoing
 * substitution must renag, and a Fable window opening is signal too. */
function createAlertPolicy({ realertMs = DEFAULT_REALERT_MS } = {}) {
  const stateByFile = new Map();
  return (turn = {}, nowMs = Date.now()) => {
    const file = String(turn.file || '');
    const expectedModel = normalizeClaudeModelId(turn.expectedModel || '');
    const model = normalizeClaudeModelId(turn.model || '');
    if (!file || !expectedModel || !model) return null;

    const prior = stateByFile.get(file) || null;
    if (modelMatchesExpected(model, expectedModel)) {
      stateByFile.set(file, null);
      if (!prior) return null;
      return {
        kind: 'recovered',
        file,
        model,
        expectedModel,
        offendingSince: prior.offendingSince,
        offendingTurns: prior.offendingTurns,
      };
    }

    const stateKey = `${expectedModel}=>${model}`;
    if (!prior || prior.stateKey !== stateKey) {
      const next = {
        stateKey,
        offendingSince: turn.timestamp || null,
        offendingTurns: 1,
        lastAlertMs: nowMs,
      };
      stateByFile.set(file, next);
      return {
        kind: 'substitution',
        file,
        model,
        expectedModel,
        offendingSince: next.offendingSince,
        offendingTurns: 1,
      };
    }

    prior.offendingTurns += 1;
    if (nowMs - prior.lastAlertMs >= realertMs) {
      prior.lastAlertMs = nowMs;
      return {
        kind: 'still-offending',
        file,
        model,
        expectedModel,
        offendingSince: prior.offendingSince,
        offendingTurns: prior.offendingTurns,
      };
    }
    return null;
  };
}

/** Back-compat boolean filter: true only on a fresh substitution edge. */
function createStateChangeAlertFilter() {
  const policy = createAlertPolicy({ realertMs: Infinity });
  return (turn = {}) => policy(turn, 0)?.kind === 'substitution';
}

const SERVING_TAIL_BYTES = 512 * 1024;

/** Last real served turn in a transcript, reading only the file tail. */
function lastServedTurn(filePath, { tailBytes = SERVING_TAIL_BYTES } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const lineText = lines[i];
      if (!lineText || !lineText.includes('"model"')) continue;
      let rec;
      try { rec = JSON.parse(lineText); } catch { continue; }
      const model = rec?.message?.model;
      if (!model || model === '<synthetic>') continue;
      return { model, timestamp: rec?.timestamp || null };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/** Who is actually serving each currently-mapped Claude pane right now. */
function servingNow({
  dir,
  settingsPath = DEFAULT_SETTINGS_PATH,
  paneSessionIdsPath = DEFAULT_PANE_SESSION_IDS_PATH,
  settings: settingsOverride,
  paneSessionIds: paneSessionIdsOverride,
} = {}) {
  const settings = settingsOverride || readJsonFile(settingsPath) || {};
  const paneSessionIds = paneSessionIdsOverride || readJsonFile(paneSessionIdsPath) || {};
  const panes = paneSessionIds?.panes && typeof paneSessionIds.panes === 'object'
    ? paneSessionIds.panes
    : {};
  const rows = [];
  for (const [paneId, sessionId] of Object.entries(panes)) {
    const expected = expectedModelFromPaneSettings(settings, paneId);
    if (!expected.expectedModel) continue; // non-Claude panes (codex, ...) have no expectation
    const last = sessionId
      ? lastServedTurn(path.join(dir, `${String(sessionId)}.jsonl`))
      : null;
    rows.push({
      paneId: String(paneId),
      sessionId: sessionId ? String(sessionId) : null,
      expectedModel: expected.expectedModel,
      servedModel: last?.model || null,
      servedAt: last?.timestamp || null,
      ok: last ? modelMatchesExpected(last.model, expected.expectedModel) : null,
    });
  }
  return rows.sort((a, b) => a.paneId.localeCompare(b.paneId, undefined, { numeric: true }));
}

function loadWatchContext(options = {}) {
  const settings = readJsonFile(options.settingsPath || DEFAULT_SETTINGS_PATH) || {};
  const explicitExpect = normalizeClaudeModelId(options.expect || '');
  return {
    explicitExpect: options.expect || '',
    settings,
    paneSessionIds: readJsonFile(options.paneSessionIdsPath || DEFAULT_PANE_SESSION_IDS_PATH) || {},
    expectedModels: explicitExpect
      ? [{ paneId: '', expectedModel: explicitExpect, source: 'explicit-expect' }]
      : expectedModelsFromSettings(settings),
  };
}

function buildWatchStatusSnapshot({
  pid = null,
  pidAlive = false,
  pidMtimeMs = 0,
  statusFile = null,
  nowMs = Date.now(),
} = {}) {
  const validPid = asPositiveInt(pid, null);
  const statusPid = asPositiveInt(statusFile?.pid, null);
  const statusMatchesPid = Boolean(validPid && statusFile && statusPid === validPid);
  const pidAgeMs = pidMtimeMs > 0 ? Math.max(0, nowMs - pidMtimeMs) : Infinity;
  const intervalMs = Math.max(1000, asPositiveInt(statusFile?.intervalMs, asPositiveInt(statusFile?.intervalS, 60) * 1000));
  const statusStaleAfterMs = Math.max(WATCH_MIN_STALE_AFTER_MS, intervalMs * 3);
  const heartbeatAtMs = asPositiveInt(statusFile?.heartbeatAtMs, null)
    || timestampMs(statusFile?.heartbeatAt)
    || timestampMs(statusFile?.updatedAt)
    || 0;
  const statusAgeMs = heartbeatAtMs > 0 ? Math.max(0, nowMs - heartbeatAtMs) : Infinity;
  const statusFresh = Boolean(statusMatchesPid && statusAgeMs <= statusStaleAfterMs);
  const starting = Boolean(validPid && pidAlive && !statusMatchesPid && pidAgeMs <= WATCH_START_GRACE_MS);
  const stopped = statusFile?.running === false || statusFile?.state === 'stopped';
  const running = Boolean(validPid && pidAlive && statusMatchesPid && statusFresh && !stopped);
  const stalePid = Boolean(validPid && !pidAlive);
  const staleStatus = Boolean(statusFile && validPid && !statusMatchesPid);
  const staleHeartbeat = Boolean(validPid && pidAlive && statusMatchesPid && !stopped && !statusFresh);
  const unknownLivePid = Boolean(validPid && pidAlive && !statusMatchesPid && !starting);
  const reason = running
    ? null
    : (starting ? 'model_audit_watch_starting'
      : (staleHeartbeat ? 'stale_model_audit_watch_status'
        : (staleStatus ? 'stale_model_audit_watch_pid_mismatch'
          : (unknownLivePid ? 'unknown_live_model_audit_watch_pid'
            : (stalePid ? 'stale_model_audit_watch_pid' : 'not_running')))));

  return {
    ok: true,
    running,
    starting,
    pid: running || starting || staleHeartbeat || staleStatus || unknownLivePid ? validPid : null,
    stalePid: stalePid ? validPid : null,
    staleStatus,
    staleHeartbeat,
    unknownLivePid: unknownLivePid ? validPid : null,
    statusFresh,
    statusAgeMs: Number.isFinite(statusAgeMs) ? statusAgeMs : null,
    statusStaleAfterMs,
    reason,
    pidPath: DEFAULT_WATCH_PID_PATH,
    statusPath: DEFAULT_WATCH_STATUS_PATH,
    outLogPath: DEFAULT_WATCH_OUT_LOG_PATH,
    errLogPath: DEFAULT_WATCH_ERR_LOG_PATH,
    watcher: statusFile || null,
  };
}

function watchStatus(options = {}) {
  const pidPath = options.pidPath || DEFAULT_WATCH_PID_PATH;
  const statusPath = options.statusPath || DEFAULT_WATCH_STATUS_PATH;
  const pidInfo = readPidInfo(pidPath);
  const statusInfo = readStatusInfo(statusPath);
  return {
    ...buildWatchStatusSnapshot({
      pid: pidInfo.pid,
      pidAlive: isPidAlive(pidInfo.pid),
      pidMtimeMs: pidInfo.mtimeMs,
      statusFile: statusInfo.value,
      statusMtimeMs: statusInfo.mtimeMs,
      nowMs: Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now(),
    }),
    pidPath,
    statusPath,
  };
}

function cleanupWatchMetadata(options = {}) {
  const pidPath = options.pidPath || DEFAULT_WATCH_PID_PATH;
  const statusPath = options.statusPath || DEFAULT_WATCH_STATUS_PATH;
  try { fs.rmSync(pidPath, { force: true }); } catch {}
  try { fs.rmSync(statusPath, { force: true }); } catch {}
}

function formatAlertMessage(event, { paneId = '', source = '' } = {}) {
  const paneNote = paneId ? ` pane ${paneId}` : '';
  if (event.kind === 'fallback') {
    const reason = event.reasonExcerpt ? ` reason="${event.reasonExcerpt}"` : ' reason=unavailable';
    return `MODEL FALLBACK: ${event.file}${paneNote} ${event.fromModel || '?'} -> ${event.toModel || '?'} at ${event.timestamp || '-'}${reason}`;
  }
  if (event.kind === 'still-offending') {
    return `MODEL SUBSTITUTION ONGOING: ${event.file}${paneNote} still serving ${event.model} since ${event.offendingSince} (${event.offendingTurns} offending turns; expected ${event.expectedModel})`;
  }
  if (event.kind === 'recovered') {
    return `MODEL RECOVERED: ${event.file}${paneNote} back on ${event.model} after ${event.offendingTurns} offending turns (since ${event.offendingSince})`;
  }
  return `MODEL SUBSTITUTION: ${event.file}${paneNote} logged ${event.model} at ${event.timestamp} (expected ${event.expectedModel} from ${source})`;
}

function watch(dir, {
  expect = '',
  intervalS,
  realertMin,
  alert,
  settingsPath = DEFAULT_SETTINGS_PATH,
  paneSessionIdsPath = DEFAULT_PANE_SESSION_IDS_PATH,
  pidPath = DEFAULT_WATCH_PID_PATH,
  statusPath = DEFAULT_WATCH_STATUS_PATH,
}) {
  const offsets = new Map(); // file -> bytes already scanned
  const realertMinutes = Math.max(1, Number(realertMin) || 60);
  const policy = createAlertPolicy({ realertMs: realertMinutes * 60 * 1000 });
  const intervalSeconds = Math.max(1, Number(intervalS) || 60);
  const intervalMs = intervalSeconds * 1000;
  let tickCount = 0;
  let stopping = false;

  ensureParent(pidPath);
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');

  const writeStatus = (extra = {}) => {
    const nowMs = Date.now();
    const context = loadWatchContext({ expect, settingsPath, paneSessionIdsPath });
    writeJson(statusPath, {
      schema: 'squidrun.model_audit.watch.status.v1',
      pid: process.pid,
      running: !stopping,
      state: stopping ? 'stopping' : 'running',
      updatedAt: nowIso(nowMs),
      heartbeatAt: nowIso(nowMs),
      heartbeatAtMs: nowMs,
      dir,
      intervalS: intervalSeconds,
      intervalMs,
      settingsPath,
      paneSessionIdsPath,
      explicitExpect: normalizeClaudeModelId(expect) || null,
      expectSource: normalizeClaudeModelId(expect) ? 'explicit-expect' : 'settings',
      expectedModels: context.expectedModels,
      tickCount,
      ...extra,
    });
  };

  const stop = (signal = 'stopped') => {
    if (stopping) return;
    stopping = true;
    const nowMs = Date.now();
    writeStatus({
      running: false,
      state: 'stopped',
      stoppedAt: nowIso(nowMs),
      stopReason: signal,
    });
    try {
      const currentPid = readPidInfo(pidPath).pid;
      if (currentPid === process.pid) fs.rmSync(pidPath, { force: true });
    } catch {}
  };

  process.once('SIGTERM', () => {
    stop('SIGTERM');
    process.exit(0);
  });
  process.once('SIGINT', () => {
    stop('SIGINT');
    process.exit(0);
  });

  const tick = () => {
    const startedAtMs = Date.now();
    let filesScanned = 0;
    let alertsSent = 0;
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
      const watchContext = loadWatchContext({ expect, settingsPath, paneSessionIdsPath });
      for (const file of files) {
        const full = path.join(dir, file);
        let size;
        try { size = fs.statSync(full).size; } catch { continue; }
        filesScanned += 1;
        const from = offsets.get(file) ?? size; // first sight: only future turns
        offsets.set(file, size);
        if (size <= from) continue;
        let chunk;
        try {
          const fd = fs.openSync(full, 'r');
          const buf = Buffer.alloc(size - from);
          fs.readSync(fd, buf, 0, buf.length, from);
          fs.closeSync(fd);
          chunk = buf.toString('utf8');
        } catch { continue; }
        const lines = chunk.split('\n');
        for (const fallback of findModelFallbacksForTranscript(file, lines, watchContext)) {
          alert(formatAlertMessage({ kind: 'fallback', ...fallback }, { paneId: fallback.paneId }));
          alertsSent += 1;
        }
        const expected = resolveExpectedModelForTranscript(file, watchContext);
        if (!expected.expectedModel) continue;
        for (const turn of scanModelTurns(lines, expected.expectedModel)) {
          const event = policy({
            file,
            model: turn.model,
            timestamp: turn.timestamp,
            expectedModel: expected.expectedModel,
          });
          if (!event) continue;
          alert(formatAlertMessage(
            { ...event, timestamp: turn.timestamp },
            { paneId: expected.paneId, source: expected.source }
          ));
          alertsSent += 1;
        }
      }
      tickCount += 1;
      writeStatus({
        state: 'waiting',
        lastTickAt: nowIso(),
        lastTickStartedAt: nowIso(startedAtMs),
        lastTickDurationMs: Math.max(0, Date.now() - startedAtMs),
        lastTick: {
          ok: true,
          filesScanned,
          alertsSent,
        },
        serving: servingNow({ dir, settingsPath, paneSessionIdsPath }),
        lastError: null,
      });
    } catch (error) {
      tickCount += 1;
      writeStatus({
        state: 'waiting_after_error',
        lastTickAt: nowIso(),
        lastTickStartedAt: nowIso(startedAtMs),
        lastTickDurationMs: Math.max(0, Date.now() - startedAtMs),
        lastTick: {
          ok: false,
          filesScanned,
          alertsSent,
        },
        lastError: error.message || String(error),
      });
    }
  };
  writeStatus({ state: 'starting', lastError: null });
  tick();
  setInterval(tick, intervalMs);
  const expectLabel = expect ? `explicit:${expect}` : `settings:${settingsPath}`;
  console.log(`model watch running: expect=${expectLabel}, interval=${intervalSeconds}s, dir=${dir}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidExit(pid, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (isPidAlive(pid) && Date.now() - startedAt < timeoutMs) {
    await delay(100);
  }
  return !isPidAlive(pid);
}

function startWatch(options = {}) {
  const current = watchStatus(options);
  if (current.running === true) {
    return { ok: true, alreadyRunning: true, ...current };
  }
  if ((current.staleHeartbeat || current.staleStatus || current.unknownLivePid) && current.pid) {
    try { process.kill(current.pid, 'SIGTERM'); } catch {}
  }
  if (current.stalePid || current.staleHeartbeat || current.staleStatus || current.unknownLivePid) {
    cleanupWatchMetadata(options);
  }

  const dir = options.dir || path.join(os.homedir(), '.claude', 'projects', 'D--projects-squidrun');
  const intervalS = Math.max(1, Number(options.intervalS) || 60);
  const settingsPath = options.settingsPath || DEFAULT_SETTINGS_PATH;
  const paneSessionIdsPath = options.paneSessionIdsPath || DEFAULT_PANE_SESSION_IDS_PATH;
  const pidPath = options.pidPath || DEFAULT_WATCH_PID_PATH;
  const statusPath = options.statusPath || DEFAULT_WATCH_STATUS_PATH;
  const outLogPath = options.outLogPath || DEFAULT_WATCH_OUT_LOG_PATH;
  const errLogPath = options.errLogPath || DEFAULT_WATCH_ERR_LOG_PATH;

  ensureParent(outLogPath);
  ensureParent(errLogPath);
  const realertMin = Math.max(1, Number(options.realertMin) || 60);
  const args = [
    __filename,
    'watch',
    '--dir', dir,
    '--interval-s', String(intervalS),
    '--realert-min', String(realertMin),
    '--settings', settingsPath,
    '--pane-session-ids', paneSessionIdsPath,
    '--pid', pidPath,
    '--status', statusPath,
  ];
  const expect = normalizeClaudeModelId(options.expect || '');
  if (expect) args.push('--expect', expect);
  const out = fs.openSync(outLogPath, 'a');
  const err = fs.openSync(errLogPath, 'a');
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  child.unref();
  ensureParent(pidPath);
  fs.writeFileSync(pidPath, String(child.pid), 'utf8');
  return {
    ok: true,
    started: true,
    pid: child.pid,
    pidPath,
    statusPath,
    outLogPath,
    errLogPath,
    dir,
    intervalS,
    settingsPath,
    paneSessionIdsPath,
    expect: expect || null,
    expectSource: expect ? 'explicit-expect' : 'settings',
  };
}

function stopWatch(options = {}) {
  const current = watchStatus(options);
  const pid = current.pid || current.stalePid;
  if (!pid || !isPidAlive(pid)) {
    cleanupWatchMetadata(options);
    return { ok: true, stopped: false, reason: 'not_running', pidPath: options.pidPath || DEFAULT_WATCH_PID_PATH };
  }
  process.kill(pid, 'SIGTERM');
  return { ok: true, stopped: true, pid, pidPath: options.pidPath || DEFAULT_WATCH_PID_PATH };
}

async function restartWatch(options = {}) {
  const stop = stopWatch(options);
  if (stop.pid) await waitForPidExit(stop.pid);
  return {
    ok: true,
    action: 'restart-model-audit-watch',
    stop,
    start: startWatch(options),
  };
}

function parseCliArgs(args) {
  return {
    flag: (name) => {
      const i = args.indexOf(`--${name}`);
      return i >= 0 ? args[i + 1] : null;
    },
    has: (name) => args.includes(`--${name}`),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseCliArgs(args);
  const flag = parsed.flag;
  const dir = flag('dir')
    || path.join(os.homedir(), '.claude', 'projects', 'D--projects-squidrun');

  if (args[0] === 'serving') {
    const rows = servingNow({
      dir,
      settingsPath: flag('settings') || DEFAULT_SETTINGS_PATH,
      paneSessionIdsPath: flag('pane-session-ids') || DEFAULT_PANE_SESSION_IDS_PATH,
    });
    console.log(JSON.stringify({ ok: true, serving: rows }, null, 2));
    for (const row of rows) {
      const mark = row.ok === null ? 'NO TURNS' : (row.ok ? 'OK' : 'MISMATCH');
      console.error(`pane ${row.paneId}: served=${row.servedModel || '-'} expected=${row.expectedModel} ${mark} (${row.servedAt || '-'})`);
    }
    return;
  }

  if (args[0] === 'watch') {
    const { execFileSync } = require('child_process');
    watch(dir, {
      expect: flag('expect') || '',
      intervalS: Number(flag('interval-s')) || 60,
      realertMin: Number(flag('realert-min')) || 60,
      settingsPath: flag('settings') || DEFAULT_SETTINGS_PATH,
      paneSessionIdsPath: flag('pane-session-ids') || DEFAULT_PANE_SESSION_IDS_PATH,
      pidPath: flag('pid') || DEFAULT_WATCH_PID_PATH,
      statusPath: flag('status') || DEFAULT_WATCH_STATUS_PATH,
      alert: (message) => {
        console.error(`${new Date().toISOString()} ${message}`);
        try {
          execFileSync(process.execPath, [
            path.join(__dirname, 'hm-send.js'), 'telegram',
            `Model watch: ${message}`, '--role', 'architect',
          ], { timeout: 60000 });
        } catch (err) {
          console.error(`alert send failed: ${err.message}`);
        }
      },
    });
    return;
  }
  if (['start', 'status', 'stop', 'restart'].includes(args[0])) {
    const watchOptions = {
      dir,
      expect: flag('expect') || '',
      intervalS: Number(flag('interval-s')) || 60,
      realertMin: Number(flag('realert-min')) || 60,
      settingsPath: flag('settings') || DEFAULT_SETTINGS_PATH,
      paneSessionIdsPath: flag('pane-session-ids') || DEFAULT_PANE_SESSION_IDS_PATH,
      pidPath: flag('pid') || DEFAULT_WATCH_PID_PATH,
      statusPath: flag('status') || DEFAULT_WATCH_STATUS_PATH,
      outLogPath: flag('out-log') || DEFAULT_WATCH_OUT_LOG_PATH,
      errLogPath: flag('err-log') || DEFAULT_WATCH_ERR_LOG_PATH,
    };
    const result = args[0] === 'start'
      ? startWatch(watchOptions)
      : (args[0] === 'status'
        ? watchStatus(watchOptions)
        : (args[0] === 'stop' ? stopWatch(watchOptions) : await restartWatch(watchOptions)));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = auditDir(dir, {
    since: flag('since') || '',
    perFile: parsed.has('per-file'),
  });
  console.log(JSON.stringify(result, null, 2));
  // Human-readable tail: the question people actually ask.
  for (const day of Object.keys(result.byDay).sort()) {
    const models = result.byDay[day];
    const parts = Object.entries(models).map(([m, n]) => `${m}=${n}`).join(' ');
    console.error(`${day}  ${parts}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_REALERT_MS,
  DEFAULT_WATCH_ERR_LOG_PATH,
  DEFAULT_WATCH_OUT_LOG_PATH,
  DEFAULT_WATCH_PID_PATH,
  DEFAULT_WATCH_STATUS_PATH,
  WATCH_MIN_STALE_AFTER_MS,
  createAlertPolicy,
  formatAlertMessage,
  lastServedTurn,
  servingNow,
  tallyModelsByDay,
  mergeTallies,
  auditDir,
  modelFamily,
  modelMatchesExpected,
  scanModelTurns,
  findOffendingTurns,
  sessionIdFromTranscriptFile,
  findPaneIdForSession,
  expectedModelFromPaneSettings,
  expectedModelsFromSettings,
  resolveExpectedModelForTranscript,
  findOffendingTurnsForTranscript,
  createStateChangeAlertFilter,
  extractModelFallbackRecords,
  fallbackEventsByDay,
  findModelFallbacksForTranscript,
  loadWatchContext,
  buildWatchStatusSnapshot,
  watchStatus,
  startWatch,
  stopWatch,
  restartWatch,
};
