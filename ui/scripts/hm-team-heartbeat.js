#!/usr/bin/env node
'use strict';

/**
 * Durable, bounded team heartbeat for Architect, Builder, and Oracle.
 *
 * Scheduled-task entrypoint:
 *   node ui/scripts/hm-team-heartbeat.js run --scheduled-window am
 *
 * Safe upkeep:
 *   node ui/scripts/hm-team-heartbeat.js config-show --json
 *   node ui/scripts/hm-team-heartbeat.js config-apply --file candidate.json --actor builder --reason "why"
 *   pwsh ui/scripts/hm-team-heartbeat-install.ps1 -Actor builder -Reason "why"
 *
 * This is intentionally a one-shot process. It never schedules or invokes
 * another heartbeat. Windows Task Scheduler owns cadence and bounded retry.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { resolveCliWebSocketPort } = require('./hm-ws-port');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, '.squidrun', 'runtime');
const CONFIG_PATH = path.join(RUNTIME_DIR, 'heartbeat-config.json');
const LOG_PATH = path.join(RUNTIME_DIR, 'heartbeat-log.jsonl');
const LOCK_PATH = path.join(RUNTIME_DIR, 'heartbeat.lock');
const HM_SEND_PATH = path.join(__dirname, 'hm-send.js');
const HM_COMMS_PATH = path.join(__dirname, 'hm-comms.js');

const TARGETS = Object.freeze(['architect', 'builder', 'oracle']);
const MIN_DAILY_BEATS = 2;
const MAX_DAILY_BEATS = 8;
const APP_UNAVAILABLE_EXIT_CODE = 75;
const LOCK_STALE_MS = 10 * 60 * 1000;

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  minimumDailyBeats: MIN_DAILY_BEATS,
  cadenceNotes: 'Windows Task Scheduler owns these local daily windows. Apply changes through config-apply, then run hm-team-heartbeat-install.ps1 to reconcile and audit them.',
  cadence: [
    { id: 'am', time: '08:23' },
    { id: 'pm', time: '18:23' },
  ],
  focusRotation: [
    {
      id: 'james-schedule',
      instruction: 'Read-only check of TrustQuote calendar events for the next 48 hours; surface only a real conflict, gap, or decision.',
    },
    {
      id: 'open-threads-sweep',
      instruction: "Review current main-scope lanes and recent .squidrun/coord artifacts; advance only a lane you own, or report one stale thread. Never close or reassign another role's lane.",
    },
    {
      id: 'site-booking-health',
      instruction: 'Read-only health check of the public site and booking guard; do not submit a booking or create customer contact.',
    },
    {
      id: 'trustquote-drift',
      instruction: 'Read-only check for unsent change orders, stale drafts, or other TrustQuote drift; do not mutate production data.',
    },
    {
      id: 'memory-rule-hygiene',
      instruction: 'Audit one stale, contradictory, or noisy local rule/memory seam and propose a correction; do not edit memory or rules from the heartbeat.',
    },
    {
      id: 'propose-one-improvement',
      instruction: 'Use fresh evidence to make one reversible local improvement or produce one concrete proposal worth acting on.',
    },
    {
      id: 'one-good-question',
      instruction: 'Ask James one question only if the answer would unlock a meaningful decision; otherwise choose silence.',
    },
  ],
});

const PARKED_FOCUS_PATTERN = /\b(trad(?:e|ing|er|es)|markets?|scans?|positions?|portfolio|tickers?|hyperliquid|alpaca|crypto(?:currency)?|stocks?|equities|futures|options?|perpetuals?|leverage|order[- ]?book|pnl|profit[- ]?and[- ]?loss)\b/i;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SAFE_BEAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function appendJsonLine(entry) {
  ensureRuntimeDir();
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
}

function readJsonLines(filePath = LOG_PATH) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('heartbeat config must be a JSON object');
  }
  if (input.enabled === false || input.disabled === true) {
    throw new Error('heartbeat config cannot disable the team heartbeat');
  }

  const cadence = Array.isArray(input.cadence) ? input.cadence : [];
  if (cadence.length < MIN_DAILY_BEATS) {
    throw new Error(`heartbeat cadence must retain at least ${MIN_DAILY_BEATS} daily beats`);
  }
  if (cadence.length > MAX_DAILY_BEATS) {
    throw new Error(`heartbeat cadence is bounded to at most ${MAX_DAILY_BEATS} daily beats`);
  }
  const cadenceIds = new Set();
  const cadenceTimes = new Set();
  const normalizedCadence = cadence.map((entry) => {
    const id = String(entry && entry.id || '').trim().toLowerCase();
    const time = String(entry && entry.time || '').trim();
    if (!SAFE_ID_PATTERN.test(id)) throw new Error(`invalid cadence id: ${id || '<empty>'}`);
    if (!TIME_PATTERN.test(time)) throw new Error(`invalid cadence time for ${id}: ${time || '<empty>'}`);
    if (cadenceIds.has(id)) throw new Error(`duplicate cadence id: ${id}`);
    if (cadenceTimes.has(time)) throw new Error(`duplicate cadence time: ${time}`);
    cadenceIds.add(id);
    cadenceTimes.add(time);
    return { id, time };
  });
  const cadenceMinutes = normalizedCadence
    .map((entry) => parseTimeMinutes(entry.time))
    .sort((left, right) => left - right);
  for (let index = 0; index < cadenceMinutes.length; index += 1) {
    const current = cadenceMinutes[index];
    const next = cadenceMinutes[(index + 1) % cadenceMinutes.length];
    const circularGapMinutes = (next - current + 24 * 60) % (24 * 60);
    if (circularGapMinutes < 60) {
      throw new Error('heartbeat cadence windows require at least 60 minutes of circular spacing');
    }
  }

  const focusRotation = Array.isArray(input.focusRotation) ? input.focusRotation : [];
  if (!focusRotation.length) throw new Error('focusRotation must contain at least one focus');
  if (focusRotation.length > 32) throw new Error('focusRotation is bounded to at most 32 focuses');
  const focusIds = new Set();
  const normalizedFocus = focusRotation.map((entry) => {
    const source = typeof entry === 'string' ? { id: entry, instruction: entry } : entry;
    const id = String(source && source.id || '').trim().toLowerCase();
    const instruction = String(source && source.instruction || '').trim();
    if (!SAFE_ID_PATTERN.test(id)) throw new Error(`invalid focus id: ${id || '<empty>'}`);
    if (!instruction || instruction.length > 500) throw new Error(`invalid instruction for focus ${id}`);
    if (focusIds.has(id)) throw new Error(`duplicate focus id: ${id}`);
    if (PARKED_FOCUS_PATTERN.test(`${id} ${instruction}`)) {
      throw new Error(`focus ${id} references a parked trading/market lane`);
    }
    focusIds.add(id);
    return { id, instruction };
  });

  const minimumDailyBeats = Number(input.minimumDailyBeats ?? MIN_DAILY_BEATS);
  if (!Number.isInteger(minimumDailyBeats) || minimumDailyBeats < MIN_DAILY_BEATS) {
    throw new Error(`minimumDailyBeats cannot be below ${MIN_DAILY_BEATS}`);
  }
  if (minimumDailyBeats > normalizedCadence.length) {
    throw new Error('minimumDailyBeats cannot exceed the configured cadence count');
  }

  return {
    schemaVersion: 1,
    minimumDailyBeats,
    cadenceNotes: String(input.cadenceNotes || DEFAULT_CONFIG.cadenceNotes).trim(),
    cadence: normalizedCadence,
    focusRotation: normalizedFocus,
  };
}

function readConfig(configPath = CONFIG_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return validateConfig(parsed);
  } catch (error) {
    if (error && error.code === 'ENOENT') return validateConfig(cloneJson(DEFAULT_CONFIG));
    throw new Error(`invalid heartbeat config at ${configPath}: ${error.message}`);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

function applyConfig(candidatePath, actor, reason, configPath = CONFIG_PATH) {
  if (!candidatePath) throw new Error('config-apply requires --file <candidate.json>');
  if (!String(actor || '').trim()) throw new Error('config-apply requires --actor');
  if (!String(reason || '').trim()) throw new Error('config-apply requires --reason');
  const before = readConfig(configPath);
  const candidate = validateConfig(JSON.parse(fs.readFileSync(path.resolve(candidatePath), 'utf8')));
  appendJsonLine({
    ts: new Date().toISOString(),
    event: 'config_change_planned',
    actor: String(actor).trim(),
    reason: String(reason).trim(),
    before,
    after: candidate,
  });
  writeJsonAtomic(configPath, candidate);
  appendJsonLine({
    ts: new Date().toISOString(),
    event: 'config_change_applied',
    actor: String(actor).trim(),
    reason: String(reason).trim(),
    before,
    after: candidate,
  });
  return candidate;
}

function parseTimeMinutes(time) {
  const [hour, minute] = String(time).split(':').map(Number);
  return hour * 60 + minute;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function deriveScheduledDate(now, cadenceEntry) {
  const scheduledMinutes = parseTimeMinutes(cadenceEntry.time);
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const date = new Date(now.getTime());
  if (currentMinutes < scheduledMinutes) date.setDate(date.getDate() - 1);
  return formatLocalDate(date);
}

function deriveBeatId(now, scheduledWindow, config, explicitBeatId = null) {
  if (explicitBeatId) {
    if (!SAFE_BEAT_ID_PATTERN.test(explicitBeatId)) throw new Error('invalid --beat-id');
    return explicitBeatId;
  }
  const windowId = String(scheduledWindow || 'manual').trim().toLowerCase();
  if (windowId === 'manual') {
    return `team-heartbeat-${formatLocalDate(now)}-manual-${now.getTime()}`;
  }
  const cadenceEntry = config.cadence.find((entry) => entry.id === windowId);
  if (!cadenceEntry) throw new Error(`scheduled window ${windowId} is not present in heartbeat config`);
  return `team-heartbeat-${deriveScheduledDate(now, cadenceEntry)}-${windowId}`;
}

function selectFocus(config, logRows, beatId) {
  const priorBeat = [...logRows].reverse().find((row) => row.beatId === beatId && row.focus && row.focus.id);
  if (priorBeat) return { focus: priorBeat.focus, focusIndex: Number(priorBeat.focusIndex) || 0 };

  const lastCompleted = [...logRows].reverse().find((row) => (
    row.event === 'heartbeat_attempt'
    && ['delivered', 'deduped'].includes(row.status)
    && TARGETS.every((target) => Array.isArray(row.deliveredTo) && row.deliveredTo.includes(target))
    && Number.isInteger(row.focusIndex)
  ));
  const focusIndex = lastCompleted
    ? (lastCompleted.focusIndex + 1) % config.focusRotation.length
    : 0;
  return { focus: config.focusRotation[focusIndex], focusIndex };
}

function buildPrompt({ beatId, scheduledWindow, focus }) {
  const windowLabel = String(scheduledWindow || 'manual').trim().toUpperCase();
  const instruction = String(focus.instruction || '').trim().replace(/[.\s]+$/, '');
  return `HEARTBEAT ${beatId} window=${windowLabel} focus=${focus.id}: ${instruction}. `
    + 'This beat is authority for ONE bounded useful action in your role. Use fresh main-scope evidence; do the action now, or record a truthful no-op if nothing is worth doing. '
    + "Read-only is the default for James's schedule and all customer, money, appointment, external-send, and production-data surfaces unless fresh James authority explicitly permits the effect. "
    + 'Reversible local improvements are allowed. Never touch trading/PARKED lanes, invoke this runner, create a child beat, or change cadence as a side effect. '
    + 'If heartbeat upkeep itself is your one action, use the validated config/reconcile path, retain at least two daily beats, and log old/new + actor + reason. '
    + 'Coordinate only when useful. Tell James only a decision-worthy result or genuinely valuable question; silence is valid.';
}

function exitCodeForStatus(status) {
  return ['app_unavailable', 'partial', 'lock_busy'].includes(status)
    ? APP_UNAVAILABLE_EXIT_CODE
    : 0;
}

function wasProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireLock(nowMs = Date.now()) {
  ensureRuntimeDir();
  const token = crypto.randomUUID();
  const attempt = () => {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, acquiredAtMs: nowMs }), 'utf8');
    fs.closeSync(fd);
    return { acquired: true, token };
  };
  try {
    return attempt();
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }

  let existing = null;
  let ageMs = 0;
  try {
    existing = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    ageMs = nowMs - Number(existing.acquiredAtMs || 0);
  } catch (_) {
    try { ageMs = nowMs - fs.statSync(LOCK_PATH).mtimeMs; } catch (_) { ageMs = 0; }
  }
  if (ageMs > LOCK_STALE_MS && !wasProcessAlive(Number(existing && existing.pid))) {
    try { fs.unlinkSync(LOCK_PATH); } catch (error) {
      if (!error || error.code !== 'ENOENT') return { acquired: false, reason: 'lock_busy' };
    }
    try { return attempt(); } catch (_) { return { acquired: false, reason: 'lock_busy' }; }
  }
  return { acquired: false, reason: 'lock_busy' };
}

function releaseLock(lock) {
  if (!lock || !lock.acquired) return;
  try {
    const existing = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    if (existing.token === lock.token) fs.unlinkSync(LOCK_PATH);
  } catch (_) {}
}

function checkTcpPort(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function readLedgerRows(limit = 20, target = null) {
  const args = [HM_COMMS_PATH, 'history', '--limit', String(limit), '--scope', 'main', '--json'];
  if (target) args.push('--between', 'heartbeat', target);
  const output = execFileSync(process.execPath, args, {
    encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(output);
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function readHeartbeatLedgerRows() {
  return TARGETS.flatMap((target) => readLedgerRows(20, target));
}

function proofRowsForBeat(rows, beatId, sinceMs = 0) {
  const prefix = `HEARTBEAT ${beatId} `;
  const result = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!TARGETS.includes(row && row.target)) continue;
    if (row.scope !== 'main') continue;
    if (!['routed', 'acked'].includes(row.status)) continue;
    if (row.sender !== 'heartbeat') continue;
    if (Number(row.timestampMs) < sinceMs) continue;
    if (!String(row.rawBody || '').startsWith(prefix)) continue;
    const current = result.get(row.target);
    if (!current || Number(row.timestampMs) > Number(current.timestampMs)) result.set(row.target, row);
  }
  return result;
}

function priorDeliveredTargets(logRows, beatId, ledgerRows = []) {
  const delivered = new Set();
  for (const row of logRows) {
    if (row.beatId !== beatId) continue;
    for (const target of Array.isArray(row.deliveredTo) ? row.deliveredTo : []) {
      if (TARGETS.includes(target)) delivered.add(target);
    }
  }
  for (const target of proofRowsForBeat(ledgerRows, beatId).keys()) delivered.add(target);
  return delivered;
}

function sendHeartbeat(target, prompt) {
  execFileSync(process.execPath, [
    HM_SEND_PATH, target, '--stdin', '--role', 'heartbeat', '--no-fallback',
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    input: prompt,
    timeout: 60000,
    windowsHide: true,
  });
}

async function waitForTargetProof(beatId, target, sinceMs, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const row = proofRowsForBeat(readLedgerRows(20, target), beatId, sinceMs).get(target);
      if (row) return row;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  return null;
}

async function runHeartbeat(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const nowMs = now.getTime();
  const scheduledWindow = String(options.scheduledWindow || 'manual').trim().toLowerCase();
  const config = readConfig(options.configPath || CONFIG_PATH);
  const logRows = readJsonLines(options.logPath || LOG_PATH);
  const beatId = deriveBeatId(now, scheduledWindow, config, options.beatId || null);
  const { focus, focusIndex } = selectFocus(config, logRows, beatId);
  const prompt = buildPrompt({ beatId, scheduledWindow, focus });

  if (options.dryRun) {
    return { exitCode: 0, dryRun: true, beatId, scheduledWindow, focus, focusIndex, prompt };
  }

  const lock = acquireLock(nowMs);
  if (!lock.acquired) {
    appendJsonLine({
      ts: new Date().toISOString(), event: 'heartbeat_attempt', status: 'lock_busy',
      beatId, scheduledWindow, focus, focusIndex, deliveredTo: [],
    });
    return { exitCode: exitCodeForStatus('lock_busy'), status: 'lock_busy', beatId, deliveredTo: [] };
  }

  try {
    let ledgerRows = [];
    try { ledgerRows = readHeartbeatLedgerRows(); } catch (_) {}
    const delivered = priorDeliveredTargets(logRows, beatId, ledgerRows);
    if (delivered.size === TARGETS.length) {
      const deliveredTo = TARGETS.filter((target) => delivered.has(target));
      appendJsonLine({
        ts: new Date().toISOString(), event: 'heartbeat_attempt', status: 'deduped',
        beatId, scheduledWindow, focus, focusIndex, deliveredTo, missingTargets: [],
      });
      return { exitCode: 0, status: 'deduped', beatId, deliveredTo };
    }

    const port = Number(options.port || resolveCliWebSocketPort());
    const appAvailable = await checkTcpPort(port, options.connectTimeoutMs || 1000);
    if (!appAvailable) {
      const deliveredTo = TARGETS.filter((target) => delivered.has(target));
      const missingTargets = TARGETS.filter((target) => !delivered.has(target));
      appendJsonLine({
        ts: new Date().toISOString(), event: 'heartbeat_attempt', status: 'app_unavailable',
        beatId, scheduledWindow, focus, focusIndex, deliveredTo, missingTargets,
        retry: { exitCode: APP_UNAVAILABLE_EXIT_CODE, boundedByTaskScheduler: true },
      });
      return { exitCode: APP_UNAVAILABLE_EXIT_CODE, status: 'app_unavailable', beatId, deliveredTo, missingTargets };
    }

    const attemptStartedAtMs = Date.now();
    for (const target of TARGETS) {
      if (delivered.has(target)) continue;
      let sendError = null;
      try { sendHeartbeat(target, prompt); } catch (error) { sendError = error; }
      const proof = await waitForTargetProof(beatId, target, attemptStartedAtMs);
      if (proof) {
        delivered.add(target);
        appendJsonLine({
          ts: new Date().toISOString(), event: 'heartbeat_target', status: 'routed',
          beatId, scheduledWindow, focus, focusIndex, target, deliveredTo: [target],
          ledgerRowId: proof.rowId, messageId: proof.messageId,
        });
      } else if (sendError) {
        appendJsonLine({
          ts: new Date().toISOString(), event: 'heartbeat_target', status: 'send_failed',
          beatId, scheduledWindow, focus, focusIndex, target, deliveredTo: [],
          error: String(sendError.message || sendError).slice(0, 500),
        });
      }
    }

    const deliveredTo = TARGETS.filter((target) => delivered.has(target));
    const missingTargets = TARGETS.filter((target) => !delivered.has(target));
    const status = missingTargets.length ? 'partial' : 'delivered';
    appendJsonLine({
      ts: new Date().toISOString(), event: 'heartbeat_attempt', status,
      beatId, scheduledWindow, focus, focusIndex, deliveredTo, missingTargets,
      senderRole: 'heartbeat',
    });
    return {
      exitCode: exitCodeForStatus(status),
      status,
      beatId,
      scheduledWindow,
      focus,
      deliveredTo,
      missingTargets,
    };
  } finally {
    releaseLock(lock);
  }
}

function optionValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function auditEvent(args) {
  const event = String(optionValue(args, '--event', '')).trim();
  const actor = String(optionValue(args, '--actor', '')).trim();
  const reason = String(optionValue(args, '--reason', '')).trim();
  const allowed = new Set(['cadence_reconcile_planned', 'cadence_reconcile_applied', 'cadence_reconcile_failed']);
  if (!allowed.has(event)) throw new Error('audit-event requires an allowed --event');
  if (!actor || !reason) throw new Error('audit-event requires --actor and --reason');
  const detailsText = readStdin().trim();
  const details = detailsText ? JSON.parse(detailsText) : {};
  appendJsonLine({ ts: new Date().toISOString(), event, actor, reason, details });
  return { ok: true, event };
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'run';
  const jsonOutput = args.includes('--json');

  if (command === 'config-show' || command === 'validate-config') {
    const config = command === 'validate-config' && optionValue(args, '--file')
      ? validateConfig(JSON.parse(fs.readFileSync(path.resolve(optionValue(args, '--file')), 'utf8')))
      : readConfig();
    process.stdout.write(`${JSON.stringify(config, null, jsonOutput ? 2 : 0)}\n`);
    return;
  }
  if (command === 'config-apply') {
    const config = applyConfig(
      optionValue(args, '--file'),
      optionValue(args, '--actor'),
      optionValue(args, '--reason')
    );
    process.stdout.write(`${JSON.stringify({ ok: true, config }, null, jsonOutput ? 2 : 0)}\n`);
    return;
  }
  if (command === 'audit-event') {
    const result = auditEvent(args);
    if (jsonOutput) process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command !== 'run') throw new Error(`unknown command: ${command}`);

  const result = await runHeartbeat({
    scheduledWindow: optionValue(args, '--scheduled-window', 'manual'),
    beatId: optionValue(args, '--beat-id'),
    dryRun: args.includes('--dry-run'),
  });
  if (jsonOutput) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    const args = process.argv.slice(2);
    const command = args[0] || 'run';
    try {
      appendJsonLine({
        ts: new Date().toISOString(), event: 'heartbeat_runner_error', command,
        error: String(error && error.message || error).slice(0, 1000),
      });
    } catch (_) {}
    if (args.includes('--json') || command !== 'run') {
      process.stderr.write(`${error.message}\n`);
    }
    process.exitCode = 1;
  });
}

module.exports = {
  APP_UNAVAILABLE_EXIT_CODE,
  DEFAULT_CONFIG,
  MAX_DAILY_BEATS,
  MIN_DAILY_BEATS,
  TARGETS,
  acquireLock,
  applyConfig,
  buildPrompt,
  deriveBeatId,
  deriveScheduledDate,
  exitCodeForStatus,
  priorDeliveredTargets,
  proofRowsForBeat,
  readConfig,
  releaseLock,
  runHeartbeat,
  selectFocus,
  validateConfig,
};
