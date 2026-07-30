#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const { resolveCoordPath } = require('../config');
const { appendTextWithRotation } = require('../modules/runtime-log-rotation');
const { queryCommsJournalEntries } = require('../modules/main/comms-journal');
const {
  buildAlertDeliverySignals,
  runAgentPaneAutoRecoveryCycle,
} = require('../modules/main/agent-pane-auto-recovery');
const { sendAgentAlert } = require('./hm-agent-alert');
const { buildOracleWakeMessage } = require('./hm-oracle-wake-context');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_STATE_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-state.json'), { forWrite: true });
const DEFAULT_PID_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-watchdog.pid'), { forWrite: true });
const DEFAULT_STATUS_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-watchdog-status.json'), { forWrite: true });
const DEFAULT_LOG_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-watchdog.log'), { forWrite: true });
const DEFAULT_START_LOCK_PATH = resolveCoordPath(path.join('runtime', 'bidirectional-wake-watchdog-start.lock'), { forWrite: true });
const DEFAULT_CURRENT_LANE_PATH = resolveCoordPath(path.join('handoffs', 'current-lane.json'));
const DEFAULT_ARCHITECT_SILENCE_MS = 8 * 60 * 1000;
const DEFAULT_ORACLE_SILENCE_MS = 10 * 60 * 1000;
const CHILD_START_GRACE_MS = 10_000;
const MIN_STATUS_STALE_AFTER_MS = 90_000;
const START_LOCK_STALE_AFTER_MS = 15_000;

function toText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
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

// S483: this log reached 245 MB unrotated. It needs COPY-TRUNCATE, not
// rename: the same path is handed to spawn() as child stdio (fs.openSync
// below), so a held handle exists and renaming it silently sends every
// further write into the archived file while the live path disappears -
// proven on Windows before this change. 32 MB cap x 3 files mirrors the
// bus-reliability-trace budget already in the tree.
const LOG_ROTATE_MAX_BYTES = 32 * 1024 * 1024;
const LOG_ROTATE_MAX_FILES = 3;

function appendLog(filePath, message) {
  ensureDir(filePath);
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    appendTextWithRotation(filePath, line, {
      heldHandle: true,
      maxBytes: LOG_ROTATE_MAX_BYTES,
      maxFiles: LOG_ROTATE_MAX_FILES,
      consumer: 'hm-bidirectional-wake-watchdog',
    });
  } catch {
    fs.appendFileSync(filePath, line, 'utf8'); // logging must never break its caller
  }
}

function readPidInfo(pidPath = DEFAULT_PID_PATH) {
  if (!fs.existsSync(pidPath)) {
    return {
      exists: false,
      readable: true,
      pid: null,
      mtimeMs: 0,
      error: null,
    };
  }
  try {
    const stat = fs.statSync(pidPath);
    const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return {
        exists: true,
        readable: false,
        pid: null,
        mtimeMs: Number(stat.mtimeMs || 0),
        error: 'invalid_pid_file',
      };
    }
    return {
      exists: true,
      readable: true,
      pid,
      mtimeMs: Number(stat.mtimeMs || 0),
      error: null,
    };
  } catch (error) {
    return {
      exists: true,
      readable: false,
      pid: null,
      mtimeMs: 0,
      error: error.message,
    };
  }
}

function readStatusInfo(statusPath = DEFAULT_STATUS_PATH) {
  if (!fs.existsSync(statusPath)) {
    return {
      exists: false,
      readable: true,
      value: null,
      mtimeMs: 0,
      error: null,
    };
  }
  try {
    const stat = fs.statSync(statusPath);
    const value = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        exists: true,
        readable: false,
        value: null,
        mtimeMs: Number(stat.mtimeMs || 0),
        error: 'invalid_status_file',
      };
    }
    return {
      exists: true,
      readable: true,
      value,
      mtimeMs: Number(stat.mtimeMs || 0),
      error: null,
    };
  } catch (error) {
    return {
      exists: true,
      readable: false,
      value: null,
      mtimeMs: 0,
      error: error.message,
    };
  }
}

/**
 * Split a supported Node/Electron launch command without evaluating it.
 * SquidRun owns only the exact argv shape it creates:
 *   <node-or-electron> <absolute-this-script> run ...
 * A wrapper merely mentioning the basename and a same-named side-install
 * script therefore cannot become an ownership match.
 */
function splitProcessCommandLine(commandLine) {
  const source = typeof commandLine === 'string' ? commandLine.trim() : '';
  if (!source) return null;
  const tokens = [];
  let token = '';
  let tokenStarted = false;
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    // The supported spawn shape never embeds a literal quote in an argument.
    // Reject Windows escape/doubled-quote forms instead of approximating
    // CommandLineToArgvW at an ownership boundary.
    if (
      (char === '\\' && source[index + 1] === '"')
      || (char === '"' && source[index + 1] === '"')
    ) {
      return null;
    }
    if (char === '"') {
      quoted = !quoted;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char) && !quoted) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    token += char;
    tokenStarted = true;
  }
  if (quoted) return null;
  if (tokenStarted) tokens.push(token);
  return tokens.length > 0 ? tokens : null;
}

function normalizeScriptIdentity(value) {
  const text = toText(value, '');
  if (!text) return '';
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(text)) {
    return path.win32.normalize(text).replace(/\\/g, '/').toLowerCase();
  }
  if (path.posix.isAbsolute(text)) {
    return path.posix.normalize(text);
  }
  return '';
}

function normalizeRunnerProcessRow(row = {}) {
  const pid = Number(row.pid ?? row.ProcessId);
  const commandLineValue = row.commandLine ?? row.CommandLine;
  const executablePathValue = row.executablePath ?? row.ExecutablePath;
  const nameValue = row.name ?? row.Name;
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    name: toText(nameValue, '') || null,
    executablePath: toText(executablePathValue, '') || null,
    commandLine: typeof commandLineValue === 'string' && commandLineValue.trim()
      ? commandLineValue.trim()
      : null,
    creationDate: toText(row.creationDate ?? row.CreationDate, '') || null,
  };
}

function isExactRunnerProcessRow(row = {}, scriptPath = __filename) {
  const normalized = normalizeRunnerProcessRow(row);
  const argv = splitProcessCommandLine(normalized.commandLine);
  if (!normalized.pid || !argv || argv.length < 3) return false;
  const supportedExecutable = (value) => {
    const basename = toText(value, '').replace(/\\/g, '/').split('/').pop();
    return /^(?:node|electron)(?:\.exe)?$/i.test(basename);
  };
  if (!supportedExecutable(argv[0])) return false;
  if (normalized.name && !supportedExecutable(normalized.name)) return false;
  if (normalized.executablePath && !supportedExecutable(normalized.executablePath)) return false;
  return (
    normalizeScriptIdentity(argv[1]) === normalizeScriptIdentity(scriptPath)
    && String(argv[2] || '').toLowerCase() === 'run'
  );
}

/**
 * Enumerate candidate Node/Electron processes without turning probe failure
 * into "none found". Ownership-sensitive callers must fail closed on ok:false.
 */
function getRunnerProcessScan() {
  try {
    if (process.platform === 'win32') {
      const raw = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='electron.exe'\" | Select-Object ProcessId,Name,ExecutablePath,CreationDate,CommandLine | ConvertTo-Json -Compress",
      ], { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const parsed = JSON.parse(raw || '[]');
      const rows = (Array.isArray(parsed) ? parsed : [parsed])
        .map(normalizeRunnerProcessRow)
        .filter((row) => row.pid);
      return { ok: true, source: 'win32_cim', rows, error: null };
    } else {
      const raw = execFileSync('ps', ['-eo', 'pid=,comm=,args='], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      const rows = [];
      for (const line of raw.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
        if (!match) continue;
        rows.push(normalizeRunnerProcessRow({
          pid: Number(match[1]),
          name: match[2],
          executablePath: match[2],
          commandLine: match[3],
        }));
      }
      return { ok: true, source: 'posix_ps', rows, error: null };
    }
  } catch (error) {
    appendLog(DEFAULT_LOG_PATH, `[scan-warning] runner enumeration failed: ${error.message}`);
    return {
      ok: false,
      source: process.platform === 'win32' ? 'win32_cim' : 'posix_ps',
      rows: [],
      error: error.message,
    };
  }
}

function probePidLiveness(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { known: true, alive: false, pid: null, error: null };
  }
  try {
    process.kill(numeric, 0);
    return { known: true, alive: true, pid: numeric, error: null };
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return { known: true, alive: false, pid: numeric, error: null };
    }
    return {
      known: false,
      alive: null,
      pid: numeric,
      error: error.message,
      code: error.code || null,
    };
  }
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildRunnerStatusSnapshot({
  pid = null,
  pidAlive = false,
  pidMtimeMs = 0,
  statusFile = null,
  statusMtimeMs = 0,
  nowMs = Date.now(),
  currentGenerationId = null,
} = {}) {
  const numericPid = Number(pid);
  const validPid = Number.isInteger(numericPid) && numericPid > 0 ? numericPid : null;
  const statusPid = Number(statusFile?.pid);
  const statusMatchesPid = Boolean(
    validPid
    && statusFile
    && Number.isInteger(statusPid)
    && statusPid === validPid
  );
  const pidAgeMs = pidMtimeMs > 0 ? Math.max(0, nowMs - pidMtimeMs) : Infinity;
  const intervalMs = Math.max(30_000, toNumber(statusFile?.intervalMs, DEFAULT_INTERVAL_MS));
  const statusStaleAfterMs = Math.max(MIN_STATUS_STALE_AFTER_MS, intervalMs * 3);
  const statusUpdatedAtMs = timestampMs(statusFile?.heartbeatAt || statusFile?.updatedAt) || Number(statusMtimeMs) || 0;
  const statusAgeMs = statusUpdatedAtMs > 0 ? Math.max(0, nowMs - statusUpdatedAtMs) : Infinity;
  const statusFresh = Boolean(statusMatchesPid && statusAgeMs <= statusStaleAfterMs);
  const starting = Boolean(validPid && pidAlive && !statusMatchesPid && pidAgeMs <= CHILD_START_GRACE_MS);
  const running = Boolean(pidAlive && statusMatchesPid && statusFresh && statusFile?.running !== false);
  const staleHeartbeat = Boolean(pidAlive && statusMatchesPid && statusFile?.running !== false && !statusFresh);
  const stalePid = Boolean(validPid && !pidAlive);
  const unknownLivePid = Boolean(validPid && pidAlive && !statusMatchesPid && !starting);
  // Generation token: the app lifecycle id stamped into the daemon status at
  // spawn. A live daemon whose token != the current app's token (or that carries
  // no token at all, e.g. a pre-fix orphan) belongs to a prior app lifecycle and
  // must be reaped + replaced even though its pid is alive and its heartbeat is
  // fresh — that is the exact hole that let a pre-restart daemon persist. Only
  // evaluated when the caller supplies the current generation (app start path);
  // the CLI/no-context path leaves it false and preserves prior behavior.
  const wantGeneration = toText(currentGenerationId, '');
  const runnerGeneration = toText(statusFile?.appGenerationId, '');
  // A pidfile-only exact child inside CHILD_START_GRACE_MS has not written its
  // generation-bearing status yet. Defer generation comparison until a fresh
  // matching status exists; otherwise a repeated start kills its own child.
  const staleGeneration = Boolean(running && wantGeneration && runnerGeneration !== wantGeneration);
  const reason = running
    ? (staleGeneration ? 'stale_bidirectional_wake_watchdog_generation' : null)
    : (starting ? 'bidirectional_wake_watchdog_starting'
      : (staleHeartbeat ? 'stale_bidirectional_wake_watchdog_status'
        : (unknownLivePid ? 'unknown_live_bidirectional_wake_watchdog_pid'
          : (stalePid ? 'stale_bidirectional_wake_watchdog_pid' : 'not_running'))));

  return {
    ok: true,
    running,
    starting,
    pid: running || starting || staleHeartbeat ? validPid : null,
    stalePid: stalePid ? validPid : null,
    staleHeartbeat,
    staleGeneration,
    generationId: runnerGeneration || null,
    unknownLivePid: unknownLivePid ? validPid : null,
    statusFresh,
    statusAgeMs: Number.isFinite(statusAgeMs) ? statusAgeMs : null,
    statusStaleAfterMs,
    reason,
    pidPath: DEFAULT_PID_PATH,
    statusPath: DEFAULT_STATUS_PATH,
    logPath: DEFAULT_LOG_PATH,
    runner: statusFile || null,
  };
}

function asValidPid(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function runPidOwnershipProbe(pid, ownershipProbe = {}) {
  const probe = typeof ownershipProbe.probePid === 'function'
    ? ownershipProbe.probePid
    : probePidLiveness;
  try {
    const result = probe(pid);
    if (typeof result === 'boolean') {
      return {
        known: true,
        alive: result,
        pid: asValidPid(pid),
        error: null,
      };
    }
    return {
      known: result?.known !== false && typeof result?.alive === 'boolean',
      alive: typeof result?.alive === 'boolean' ? result.alive : null,
      pid: asValidPid(result?.pid ?? pid),
      error: result?.error || null,
      code: result?.code || null,
    };
  } catch (error) {
    return {
      known: false,
      alive: null,
      pid: asValidPid(pid),
      error: error.message,
      code: error.code || null,
    };
  }
}

function runProcessOwnershipScan(ownershipProbe = {}) {
  const scan = typeof ownershipProbe.getProcessScan === 'function'
    ? ownershipProbe.getProcessScan
    : getRunnerProcessScan;
  try {
    const result = scan();
    return {
      ok: result?.ok === true,
      source: result?.source || 'unknown',
      rows: Array.isArray(result?.rows)
        ? result.rows.map(normalizeRunnerProcessRow).filter((row) => row.pid)
        : [],
      error: result?.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      source: 'probe_exception',
      rows: [],
      error: error.message,
    };
  }
}

/**
 * Build a fail-closed ownership claim from all three authorities:
 * pidfile, status file, and an exact process-command observation.
 *
 * No caller may signal a process, delete owner metadata, or spawn a successor
 * unless this snapshot is non-conflicted. A process row is an owner only when
 * argv[1] equals this resolved script and argv[2] is exactly `run`.
 */
function buildRunnerOwnershipSnapshot({
  pidInfo = {},
  statusInfo = {},
  pidProbes = new Map(),
  processScan = {},
  scriptPath = __filename,
  nowMs = Date.now(),
} = {}) {
  const pidFilePid = asValidPid(pidInfo.pid);
  const statusPid = asValidPid(statusInfo.value?.pid);
  const referencedPids = [...new Set([pidFilePid, statusPid].filter(Boolean))];
  const rows = Array.isArray(processScan.rows)
    ? processScan.rows.map(normalizeRunnerProcessRow).filter((row) => row.pid)
    : [];
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
  const exactRows = rows.filter((row) => isExactRunnerProcessRow(row, scriptPath));
  const pidFileProbe = pidProbes.get(pidFilePid);
  const pidAgeMs = Number(pidInfo.mtimeMs) > 0
    ? Number(nowMs) - Number(pidInfo.mtimeMs)
    : Infinity;
  const verifiedStartingOwner = Boolean(
    pidInfo.exists === true
    && pidInfo.readable === true
    && pidFilePid
    && statusInfo.exists === false
    && statusInfo.readable === true
    && pidFileProbe?.known === true
    && pidFileProbe?.alive === true
    && processScan.ok === true
    // NTFS mtime precision can land fractionally ahead of Date.now().
    && pidAgeMs >= -1_000
    && pidAgeMs <= CHILD_START_GRACE_MS
    && exactRows.length === 1
    && exactRows[0].pid === pidFilePid
  );
  const conflicts = [];
  const conflictKeys = new Set();
  const addConflict = (code, details = {}) => {
    const key = `${code}:${details.pid || ''}`;
    if (conflictKeys.has(key)) return;
    conflictKeys.add(key);
    conflicts.push({ code, ...details });
  };

  if (pidInfo.exists === true && pidInfo.readable !== true) {
    addConflict('pid_metadata_unreadable', { error: pidInfo.error || null });
  }
  if (statusInfo.exists === true && statusInfo.readable !== true) {
    addConflict('status_metadata_unreadable', { error: statusInfo.error || null });
  } else if (statusInfo.exists === true && !statusPid) {
    addConflict('status_pid_invalid');
  }
  if (processScan.ok !== true) {
    addConflict('process_enumeration_uncertain', {
      error: processScan.error || null,
      source: processScan.source || null,
    });
  }

  for (const pid of referencedPids) {
    const probe = pidProbes.get(pid) || {
      known: false,
      alive: null,
      pid,
      error: 'pid_probe_missing',
    };
    if (probe.known !== true) {
      addConflict('pid_liveness_uncertain', {
        pid,
        error: probe.error || null,
        source: pid === pidFilePid && pid === statusPid
          ? 'pidfile_and_status'
          : (pid === pidFilePid ? 'pidfile' : 'status'),
      });
      continue;
    }
    if (probe.alive !== true) continue;
    const row = rowsByPid.get(pid);
    if (!row) {
      addConflict('live_process_unobserved', { pid });
    } else if (!row.commandLine) {
      addConflict('live_identity_unreadable', { pid });
    } else if (!isExactRunnerProcessRow(row, scriptPath)) {
      addConflict('live_identity_mismatch', { pid });
    }
  }

  const liveReferencedPids = referencedPids.filter(
    (pid) => pidProbes.get(pid)?.known === true && pidProbes.get(pid)?.alive === true
  );
  if (
    pidFilePid !== statusPid
    && liveReferencedPids.length > 0
    && !verifiedStartingOwner
  ) {
    addConflict('pid_status_mismatch', {
      pidFilePid,
      statusPid,
    });
  }
  if (
    liveReferencedPids.length > 0
    && statusInfo.value?.role !== 'bidirectional-wake-watchdog'
    && !verifiedStartingOwner
  ) {
    addConflict('live_status_role_mismatch', {
      role: statusInfo.value?.role || null,
    });
  }
  if (exactRows.length > 1) {
    addConflict('multiple_exact_runner_owners', {
      pids: exactRows.map((row) => row.pid),
    });
  }
  for (const row of exactRows) {
    const isClaimedOwner = Boolean(
      (pidFilePid && pidFilePid === statusPid && row.pid === pidFilePid)
      || (verifiedStartingOwner && row.pid === pidFilePid)
    );
    if (!isClaimedOwner) {
      addConflict('unclaimed_exact_runner_owner', { pid: row.pid });
    }
    const probe = pidProbes.get(row.pid);
    if (probe && (probe.known !== true || probe.alive !== true)) {
      addConflict('owner_observation_liveness_mismatch', { pid: row.pid });
    }
  }

  const referencedOwners = referencedPids.map((pid) => {
    const row = rowsByPid.get(pid) || null;
    const probe = pidProbes.get(pid) || null;
    return {
      pid,
      sources: [
        ...(pid === pidFilePid ? ['pidfile'] : []),
        ...(pid === statusPid ? ['status'] : []),
      ],
      livenessKnown: probe?.known === true,
      alive: typeof probe?.alive === 'boolean' ? probe.alive : null,
      observed: Boolean(row),
      commandLineReadable: Boolean(row?.commandLine),
      exactRunnerIdentity: Boolean(row && isExactRunnerProcessRow(row, scriptPath)),
      processName: row?.name || null,
      executablePath: row?.executablePath || null,
      creationDate: row?.creationDate || null,
    };
  });
  const status = conflicts.length > 0
    ? 'ownership_conflict'
    : (liveReferencedPids.length > 0
      ? (verifiedStartingOwner ? 'verified_starting_owner' : 'verified_live_owner')
      : (referencedPids.length > 0 || pidInfo.exists === true || statusInfo.exists === true
        ? 'recoverable_stale_metadata'
        : 'clear'));

  return {
    ok: conflicts.length === 0,
    status,
    pidFilePid,
    statusPid,
    pidAgeMs: Number.isFinite(pidAgeMs) ? pidAgeMs : null,
    verifiedStartingOwner,
    referencedOwners,
    observedExactOwners: exactRows.map((row) => ({
      pid: row.pid,
      processName: row.name || null,
      executablePath: row.executablePath || null,
      creationDate: row.creationDate || null,
    })),
    processScan: {
      ok: processScan.ok === true,
      source: processScan.source || null,
      rowCount: rows.length,
      error: processScan.error || null,
    },
    conflicts,
    scriptPath: path.resolve(scriptPath),
  };
}

function readRunnerStatus({
  currentGenerationId = null,
  ownershipProbe = {},
  nowMs = Date.now(),
} = {}) {
  const pidInfo = readPidInfo();
  const statusInfo = readStatusInfo();
  const referencedPids = [...new Set([
    asValidPid(pidInfo.pid),
    asValidPid(statusInfo.value?.pid),
  ].filter(Boolean))];
  const pidProbes = new Map(
    referencedPids.map((pid) => [pid, runPidOwnershipProbe(pid, ownershipProbe)])
  );
  const processScan = runProcessOwnershipScan(ownershipProbe);
  const ownership = buildRunnerOwnershipSnapshot({
    pidInfo,
    statusInfo,
    pidProbes,
    processScan,
    nowMs,
  });
  const status = buildRunnerStatusSnapshot({
    pid: pidInfo.pid,
    pidAlive: pidProbes.get(asValidPid(pidInfo.pid))?.alive === true,
    pidMtimeMs: pidInfo.mtimeMs,
    statusFile: statusInfo.value,
    statusMtimeMs: statusInfo.mtimeMs,
    currentGenerationId,
    nowMs,
  });
  if (!ownership.ok) {
    return {
      ...status,
      ok: false,
      status: 'ownership_conflict',
      reason: 'ownership_conflict',
      blocked: true,
      retryable: false,
      ownership,
    };
  }
  return {
    ...status,
    ownership,
  };
}

function cleanupRunnerMetadata() {
  try {
    fs.rmSync(DEFAULT_PID_PATH, { force: true });
  } catch {
    // Best effort stale metadata cleanup.
  }
  try {
    fs.rmSync(DEFAULT_STATUS_PATH, { force: true });
  } catch {
    // Best effort stale metadata cleanup.
  }
}

function readLockSnapshot(lockPath = DEFAULT_START_LOCK_PATH, nowMs = Date.now()) {
  try {
    const stat = fs.statSync(lockPath);
    const mtimeMs = Number(stat.mtimeMs || 0);
    return {
      lockPath,
      mtimeMs,
      size: Number(stat.size || 0),
      raw: fs.readFileSync(lockPath, 'utf8'),
      ageMs: mtimeMs > 0 ? Math.max(0, nowMs - mtimeMs) : null,
    };
  } catch {
    return null;
  }
}

function sameLockSnapshot(left = null, right = null) {
  return Boolean(
    left
    && right
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.size) === Number(right.size)
    && String(left.raw || '') === String(right.raw || '')
  );
}

function claimStaleStartLock(lockPath = DEFAULT_START_LOCK_PATH, observedSnapshot = null, options = {}) {
  const latest = readLockSnapshot(lockPath, options.nowMs);
  if (!sameLockSnapshot(observedSnapshot, latest)) {
    return {
      claimed: false,
      reason: 'stale_lock_changed',
      lockPath,
      lockAgeMs: latest?.ageMs ?? null,
    };
  }
  const claimPath = `${lockPath}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lockPath, claimPath);
    const claimedSnapshot = readLockSnapshot(claimPath, options.nowMs);
    if (!sameLockSnapshot(observedSnapshot, claimedSnapshot)) {
      try {
        fs.renameSync(claimPath, lockPath);
      } catch {
        // Best effort restore; returning start_in_progress prevents this process from spawning.
      }
      return {
        claimed: false,
        reason: 'stale_lock_claim_mismatch',
        lockPath,
        lockAgeMs: claimedSnapshot?.ageMs ?? null,
      };
    }
    return {
      claimed: true,
      lockPath,
      claimPath,
      lockAgeMs: latest?.ageMs ?? null,
    };
  } catch (error) {
    return {
      claimed: false,
      reason: 'stale_lock_claim_lost',
      error: error.message,
      code: error.code || null,
      lockPath,
      lockAgeMs: latest?.ageMs ?? null,
    };
  }
}

function buildStartLockOwnerToken(nowMs = Date.now()) {
  return `${process.pid}-${nowMs}-${Math.random().toString(36).slice(2)}`;
}

function acquireStartLock(lockPath = DEFAULT_START_LOCK_PATH, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const staleAfterMs = Math.max(1_000, toNumber(options.staleAfterMs, START_LOCK_STALE_AFTER_MS));
  ensureDir(lockPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        createdAt: new Date(nowMs).toISOString(),
        ownerToken: buildStartLockOwnerToken(nowMs),
      }));
      fs.closeSync(fd);
      return { acquired: true, lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { acquired: false, reason: 'start_lock_failed', error: error.message, lockPath };
      }
      const lockSnapshot = readLockSnapshot(lockPath, nowMs);
      if (attempt === 0 && lockSnapshot?.ageMs !== null && lockSnapshot?.ageMs >= staleAfterMs) {
        const claim = claimStaleStartLock(lockPath, lockSnapshot, { nowMs });
        if (claim.claimed) {
          try {
            fs.rmSync(claim.claimPath, { force: true });
          } catch {
            // Best effort quarantine cleanup; the original lock path was already atomically claimed.
          }
          appendLog(DEFAULT_LOG_PATH, `[cleanup] claimed stale start lock ageMs=${claim.lockAgeMs}`);
          continue;
        }
        return {
          acquired: false,
          reason: 'start_in_progress',
          claimReason: claim.reason || 'stale_lock_claim_lost',
          error: claim.error || null,
          code: claim.code || null,
          lockAgeMs: claim.lockAgeMs,
          lockPath,
        };
      }
      return {
        acquired: false,
        reason: 'start_in_progress',
        lockAgeMs: lockSnapshot?.ageMs ?? null,
        lockPath,
      };
    }
  }
  return { acquired: false, reason: 'start_lock_not_acquired', lockPath };
}

function releaseStartLock(lockPath = DEFAULT_START_LOCK_PATH) {
  try {
    fs.rmSync(lockPath, { force: true });
    return { ok: true, lockPath };
  } catch (error) {
    return { ok: false, error: error.message, lockPath };
  }
}

function summarizeHeartbeatResult(result = {}) {
  const recoveryActions = Array.isArray(result?.agentPaneRecovery?.actions)
    ? result.agentPaneRecovery.actions
    : [];
  return {
    ok: result?.ok === true,
    statePath: result?.statePath || null,
    stateUpdatedAt: result?.state?.updatedAt || null,
    alertCount: Array.isArray(result?.alerts) ? result.alerts.length : 0,
    alerts: Array.isArray(result?.alerts)
      ? result.alerts.map((entry) => ({
        target: entry?.target || null,
        ok: entry?.result?.ok === true,
      }))
      : [],
    agentPaneRecovery: result?.agentPaneRecovery ? {
      ok: result.agentPaneRecovery.ok === true,
      status: result.agentPaneRecovery.status || null,
      actionCount: recoveryActions.length,
      actions: recoveryActions.map((action) => ({
        kind: action?.kind || null,
        paneId: action?.paneId || null,
        role: action?.role || null,
        reason: action?.reason || null,
      })),
    } : null,
  };
}

function writeRunnerStatus(payload = {}) {
  const now = new Date().toISOString();
  writeJson(DEFAULT_STATUS_PATH, {
    version: 1,
    role: 'bidirectional-wake-watchdog',
    pid: process.pid,
    appGenerationId: toText(process.env.SQUIDRUN_WAKE_APP_GENERATION) || null,
    updatedAt: now,
    heartbeatAt: now,
    ...payload,
  });
}

function resolveLaunchExecutable(env = process.env) {
  const override = toText(env.SQUIDRUN_BIDIRECTIONAL_WAKE_NODE_PATH || env.SQUIDRUN_NODE_PATH, '');
  if (override) return override;
  const npmNodeExecPath = toText(env.npm_node_execpath, '');
  if (npmNodeExecPath && /(?:^|[\\/])node(?:\.exe)?$/i.test(npmNodeExecPath)) {
    return npmNodeExecPath;
  }
  return process.execPath || (process.platform === 'win32' ? 'node.exe' : 'node');
}

function cleanNodeChildEnv(env = process.env) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  return childEnv;
}

function defaultState() {
  return {
    version: 1,
    architect: {
      lastSeenAt: null,
      lastPokeAt: null,
    },
    oracle: {
      lastSeenAt: null,
      lastPokeAt: null,
    },
    intervalMs: DEFAULT_INTERVAL_MS,
    updatedAt: null,
  };
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  return {
    ...defaultState(),
    ...(readJson(statePath, defaultState()) || {}),
    architect: {
      ...defaultState().architect,
      ...((readJson(statePath, defaultState()) || {}).architect || {}),
    },
    oracle: {
      ...defaultState().oracle,
      ...((readJson(statePath, defaultState()) || {}).oracle || {}),
    },
  };
}

function persistState(statePath, state) {
  writeJson(statePath, {
    ...defaultState(),
    ...(state || {}),
  });
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2).trim();
    const next = argv[index + 1];
    const value = (!next || next.startsWith('--')) ? true : next;
    if (value !== true) index += 1;
    options.set(key, value);
  }
  return { positional, options };
}

function getOption(options, key, fallback = null) {
  if (!options || typeof options.has !== 'function' || !options.has(key)) return fallback;
  return options.get(key);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPacificHour(nowMs = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    hour12: false,
  });
  return Number(formatter.format(new Date(nowMs)));
}

function isActiveWindow(nowMs = Date.now()) {
  const hour = getPacificHour(nowMs);
  return (hour >= 0 && hour < 3)
    || (hour >= 5 && hour < 9)
    || (hour >= 16 && hour < 20);
}

// The active-window "silent >Xm, status check" peer-wake nag can't tell a peer
// that finished and is idle-by-design from one stalled mid-task. When there is
// no open lane, the whole team is legitimately idle and the poke is the same
// false-state signal class as the Blocked badge / heartbeat-stale alerts —
// suppress it. Missing/unreadable lane state defaults to "no pending work"
// (quiet): the nag is internal noise, not a safety signal, and the dead-pane
// auto-recovery path (separate) still catches an actually-dead CLI.
function hasPendingTeamWork(currentLanePath = DEFAULT_CURRENT_LANE_PATH) {
  try {
    const lane = JSON.parse(fs.readFileSync(currentLanePath, 'utf8'));
    if (!lane || typeof lane !== 'object') return false;
    if (toNumber(lane.activeLaneCount, 0) > 0) return true;
    if (lane.activeLane && typeof lane.activeLane === 'object') return true;
    if (lane.continuity && toText(lane.continuity.next_action)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function latestSeenAt(filters = {}, nowMs = Date.now()) {
  const rows = queryCommsJournalEntries({
    ...filters,
    sinceMs: nowMs - (24 * 60 * 60 * 1000),
    order: 'desc',
    limit: 50,
  });
  const latest = Array.isArray(rows) ? rows[0] : null;
  if (!latest) return null;
  return new Date(toNumber(latest.sentAtMs || latest.brokeredAtMs, nowMs)).toISOString();
}

function shouldRepoke(lastPokeAt, nowMs, thresholdMs) {
  const lastPokeMs = new Date(toText(lastPokeAt, '')).getTime();
  if (!Number.isFinite(lastPokeMs) || lastPokeMs <= 0) return true;
  return (nowMs - lastPokeMs) >= thresholdMs;
}

async function runHeartbeatCycle(options = {}) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const intervalMs = Math.max(30_000, toNumber(options.intervalMs, DEFAULT_INTERVAL_MS));
  const architectSilenceMs = Math.max(30_000, toNumber(options.architectSilenceMs, DEFAULT_ARCHITECT_SILENCE_MS));
  const oracleSilenceMs = Math.max(60_000, toNumber(options.oracleSilenceMs, DEFAULT_ORACLE_SILENCE_MS));
  const architectSilenceMinutes = Math.round(architectSilenceMs / 60_000);
  const oracleSilenceMinutes = Math.round(oracleSilenceMs / 60_000);
  const currentLanePath = path.resolve(toText(options.currentLanePath, DEFAULT_CURRENT_LANE_PATH));
  const pendingTeamWork = hasPendingTeamWork(currentLanePath);
  const state = loadState(statePath);

  const architectLastSeenAt = latestSeenAt({
    senderRole: 'architect',
    targetRole: 'oracle',
    direction: 'outbound',
  }, nowMs);
  const oracleLastSeenAt = latestSeenAt({
    senderRole: 'oracle',
    targetRole: 'architect',
    direction: 'outbound',
  }, nowMs);
  const architectLastSeenMs = new Date(toText(architectLastSeenAt, '')).getTime();
  const oracleLastSeenMs = new Date(toText(oracleLastSeenAt, '')).getTime();
  const alerts = [];
  const agentPaneDeliverySignals = [];

  if (isActiveWindow(nowMs)
    && pendingTeamWork
    && Number.isFinite(architectLastSeenMs)
    && (nowMs - architectLastSeenMs) >= architectSilenceMs
    && shouldRepoke(state.architect?.lastPokeAt, nowMs, architectSilenceMs)) {
    const message = `(ORACLE PEER-WAKE): Architect silent >${architectSilenceMinutes}m during active window. Status check now.`;
    const result = sendAgentAlert(message, {
      targets: ['architect'],
      role: 'oracle-peer-wake',
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      env: process.env,
    });
    agentPaneDeliverySignals.push(...buildAlertDeliverySignals({
      paneId: '1',
      role: 'architect',
      alertResult: result,
      message,
      nowMs,
    }));
    state.architect.lastPokeAt = nowIso;
    alerts.push({ target: 'architect', result, message });
  }

  if (isActiveWindow(nowMs)
    && pendingTeamWork
    && Number.isFinite(oracleLastSeenMs)
    && (nowMs - oracleLastSeenMs) >= oracleSilenceMs
    && shouldRepoke(state.oracle?.lastPokeAt, nowMs, oracleSilenceMs)) {
    const message = await buildOracleWakeMessage(
      `(ARCHITECT PEER-WAKE): Oracle silent >${oracleSilenceMinutes}m. Status check now.`,
      {
        watchRulesPath: options.watchRulesPath,
        watchStatePath: options.watchStatePath,
        marketScannerStatePath: options.marketScannerStatePath,
        staleDistancePct: options.staleDistancePct,
        nowMs,
      }
    );
    const result = sendAgentAlert(message, {
      targets: ['oracle'],
      role: 'architect-peer-wake',
      cwd: process.env.SQUIDRUN_PROJECT_ROOT || path.join(__dirname, '..', '..'),
      env: process.env,
    });
    agentPaneDeliverySignals.push(...buildAlertDeliverySignals({
      paneId: '3',
      role: 'oracle',
      alertResult: result,
      message,
      nowMs,
    }));
    state.oracle.lastPokeAt = nowIso;
    alerts.push({ target: 'oracle', result, message });
  }

  let agentPaneRecovery = null;
  const recoveryOptions = options.agentPaneAutoRecovery && typeof options.agentPaneAutoRecovery === 'object'
    ? options.agentPaneAutoRecovery
    : {};
  const recoveryEnabled = options.agentPaneAutoRecovery !== false
    && String(process.env.SQUIDRUN_AGENT_PANE_AUTO_RECOVERY || '').trim().toLowerCase() !== '0'
    && String(process.env.SQUIDRUN_AGENT_PANE_AUTO_RECOVERY || '').trim().toLowerCase() !== 'false';
  if (recoveryEnabled) {
    agentPaneRecovery = await runAgentPaneAutoRecoveryCycle({
      nowMs,
      ...recoveryOptions,
      deliverySignals: [
        ...agentPaneDeliverySignals,
        ...(Array.isArray(recoveryOptions.deliverySignals) ? recoveryOptions.deliverySignals : []),
      ],
    });
  }

  state.intervalMs = intervalMs;
  state.architect.lastSeenAt = architectLastSeenAt;
  state.oracle.lastSeenAt = oracleLastSeenAt;
  state.updatedAt = nowIso;
  persistState(statePath, state);

  return {
    ok: alerts.every((entry) => entry.result?.ok === true),
    statePath,
    state,
    alerts,
    agentPaneRecovery,
  };
}

async function runScheduledLoop(options = {}) {
  const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
  const intervalMs = Math.max(30_000, toNumber(options.intervalMs, DEFAULT_INTERVAL_MS));
  const agentPaneAutoRecovery = options.agentPaneAutoRecovery;
  let runCount = 0;
  let stopping = false;

  ensureDir(DEFAULT_PID_PATH);
  fs.writeFileSync(DEFAULT_PID_PATH, String(process.pid), 'utf8');
  appendLog(DEFAULT_LOG_PATH, `[start] pid=${process.pid} intervalMs=${intervalMs} statePath=${statePath}`);

  const writeStatus = (extra = {}) => {
    writeRunnerStatus({
      running: !stopping,
      intervalMs,
      statePath,
      runCount,
      ...extra,
    });
  };

  const shutdown = (signal = 'shutdown') => {
    if (stopping) return;
    stopping = true;
    appendLog(DEFAULT_LOG_PATH, `[stop] pid=${process.pid} signal=${signal}`);
    writeStatus({
      running: false,
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      stopReason: signal,
    });
    try {
      const currentPid = Number.parseInt(fs.readFileSync(DEFAULT_PID_PATH, 'utf8').trim(), 10);
      if (currentPid === process.pid) {
        fs.rmSync(DEFAULT_PID_PATH, { force: true });
      }
    } catch {
      // Best effort pid cleanup.
    }
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
    process.exit(0);
  });

  while (!stopping) {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    writeStatus({
      status: 'running_cycle',
      currentRunStartedAt: startedAt,
      lastError: null,
    });

    try {
      const result = await runHeartbeatCycle({ statePath, intervalMs, agentPaneAutoRecovery });
      runCount += 1;
      const finishedAtMs = Date.now();
      const nextRunAtMs = finishedAtMs + intervalMs;
      const summary = summarizeHeartbeatResult(result);
      writeStatus({
        status: 'waiting',
        lastRunStartedAt: startedAt,
        lastRunFinishedAt: new Date(finishedAtMs).toISOString(),
        nextRunAt: new Date(nextRunAtMs).toISOString(),
        lastResult: summary,
      });
      appendLog(
        DEFAULT_LOG_PATH,
        `[cycle] runCount=${runCount} ok=${summary.ok} stateUpdatedAt=${summary.stateUpdatedAt || 'null'}`
      );
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      runCount += 1;
      const finishedAtMs = Date.now();
      const nextRunAtMs = finishedAtMs + intervalMs;
      const message = error?.stack || error?.message || String(error);
      writeStatus({
        status: 'waiting_after_error',
        lastRunStartedAt: startedAt,
        lastRunFinishedAt: new Date(finishedAtMs).toISOString(),
        nextRunAt: new Date(nextRunAtMs).toISOString(),
        lastError: message,
      });
      appendLog(DEFAULT_LOG_PATH, `[error] runCount=${runCount} ${message}`);
      console.error(message);
    }

    if (!stopping) {
      await sleep(intervalMs);
    }
  }
}

function ownershipConflictResult(current = {}, operation = 'status', phase = 'initial') {
  return {
    ...current,
    ok: false,
    status: 'ownership_conflict',
    reason: 'ownership_conflict',
    blocked: true,
    retryable: false,
    operation,
    phase,
  };
}

function startRunner(options = {}) {
  const generationId = toText(options.appGenerationId, '');
  const statusOptions = {
    currentGenerationId: generationId,
    ownershipProbe: options.ownershipProbe || {},
  };
  const current = readRunnerStatus(statusOptions);
  if (current.ownership?.ok !== true) {
    return ownershipConflictResult(current, 'start', 'initial');
  }
  // A live daemon from the current app lifecycle is healthy — leave it. A live
  // daemon from a PRIOR lifecycle (stale generation) survived a restart and may
  // run stale code. Owner mutation happens only after the start lock and a
  // second complete ownership classification below.
  if ((current.running || current.starting) && !current.staleGeneration) {
    return current.running
      ? { ok: true, alreadyRunning: true, ...current }
      : { ok: true, alreadyStarting: true, ...current };
  }

  const lock = acquireStartLock(DEFAULT_START_LOCK_PATH, options.startLock);
  if (!lock.acquired) {
    return {
      ok: lock.reason === 'start_in_progress',
      alreadyStarting: lock.reason === 'start_in_progress',
      startInProgress: lock.reason === 'start_in_progress',
      ...lock,
    };
  }

  try {
    const rechecked = readRunnerStatus(statusOptions);
    if (rechecked.ownership?.ok !== true) {
      return ownershipConflictResult(rechecked, 'start', 'under_start_lock');
    }
    if ((rechecked.running || rechecked.starting) && !rechecked.staleGeneration) {
      return rechecked.running
        ? { ok: true, alreadyRunning: true, ...rechecked }
        : { ok: true, alreadyStarting: true, ...rechecked };
    }

    const verifiedOwnerPid = rechecked.ownership.status === 'verified_live_owner'
      ? rechecked.ownership.pidFilePid
      : null;
    if (verifiedOwnerPid) {
      try {
        process.kill(verifiedOwnerPid, 'SIGTERM');
        appendLog(
          DEFAULT_LOG_PATH,
          `[cleanup] stopped exact runner owner pid=${verifiedOwnerPid} after locked ownership recheck`
        );
      } catch (error) {
        return {
          ...rechecked,
          ok: false,
          status: 'owner_stop_failed',
          reason: 'owner_stop_failed',
          blocked: true,
          retryable: false,
          operation: 'start',
          phase: 'under_start_lock',
          error: error.message,
        };
      }
    }
    if (
      verifiedOwnerPid
      || rechecked.ownership.status === 'recoverable_stale_metadata'
    ) {
      cleanupRunnerMetadata();
    }

    const statePath = path.resolve(toText(options.statePath, DEFAULT_STATE_PATH));
    const intervalMs = Math.max(30_000, toNumber(options.intervalMs, DEFAULT_INTERVAL_MS));
    const childArgs = [
      __filename,
      'run',
      '--state',
      statePath,
      '--interval-ms',
      String(intervalMs),
    ];
    if (options.agentPaneAutoRecovery === false) {
      childArgs.push('--no-agent-pane-auto-recovery');
    }

    ensureDir(DEFAULT_LOG_PATH);
    const out = fs.openSync(DEFAULT_LOG_PATH, 'a');
    const executable = resolveLaunchExecutable();
    const projectRoot = path.resolve(
      toText(options.projectRoot, '')
      || process.env.SQUIDRUN_PROJECT_ROOT
      || path.join(__dirname, '..', '..')
    );
    const child = spawn(executable, childArgs, {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', out, out],
      env: {
        ...cleanNodeChildEnv(process.env),
        SQUIDRUN_PROJECT_ROOT: projectRoot,
        ...(generationId ? { SQUIDRUN_WAKE_APP_GENERATION: generationId } : {}),
      },
      windowsHide: true,
    });
    child.unref();
    fs.writeFileSync(DEFAULT_PID_PATH, String(child.pid), 'utf8');
    appendLog(DEFAULT_LOG_PATH, `[spawn] pid=${child.pid} executable=${executable} intervalMs=${intervalMs}`);
    return {
      ok: true,
      started: true,
      pid: child.pid,
      intervalMs,
      statePath,
      pidPath: DEFAULT_PID_PATH,
      statusPath: DEFAULT_STATUS_PATH,
      logPath: DEFAULT_LOG_PATH,
      executable,
    };
  } finally {
    releaseStartLock(DEFAULT_START_LOCK_PATH);
  }
}

function stopRunner(options = {}) {
  const current = readRunnerStatus({
    ownershipProbe: options.ownershipProbe || {},
  });
  if (current.ownership?.ok !== true) {
    return ownershipConflictResult(current, 'stop', 'initial');
  }
  if (current.ownership.status === 'verified_starting_owner') {
    return {
      ...current,
      ok: false,
      status: 'owner_start_in_progress',
      reason: 'owner_start_in_progress',
      blocked: true,
      retryable: false,
      operation: 'stop',
      pid: current.ownership.pidFilePid,
    };
  }
  const pid = current.ownership.status === 'verified_live_owner'
    ? current.ownership.pidFilePid
    : null;
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      return {
        ...current,
        ok: false,
        status: 'stop_failed',
        reason: 'stop_failed',
        blocked: true,
        retryable: false,
        error: error.message,
      };
    }
  }
  cleanupRunnerMetadata();
  return {
    ok: true,
    stopped: Boolean(pid),
    pid: pid || null,
    previousStatus: current,
  };
}

async function runCli(argv = parseCliArgs(), controls = {}) {
  const startControl = typeof controls.startRunner === 'function'
    ? controls.startRunner
    : startRunner;
  const stopControl = typeof controls.stopRunner === 'function'
    ? controls.stopRunner
    : stopRunner;
  const command = toText(argv.positional[0], 'run').toLowerCase();
  const statePath = path.resolve(toText(getOption(argv.options, 'state', DEFAULT_STATE_PATH)));
  const intervalMs = Math.max(30_000, toNumber(getOption(argv.options, 'interval-ms', DEFAULT_INTERVAL_MS), DEFAULT_INTERVAL_MS));
  const agentPaneAutoRecovery = getOption(argv.options, 'no-agent-pane-auto-recovery', false) === true
    ? false
    : undefined;

  if (command === 'once') {
    const result = await runHeartbeatCycle({ statePath, intervalMs, agentPaneAutoRecovery });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'status') {
    const result = readRunnerStatus();
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'start') {
    const result = startControl({ statePath, intervalMs, agentPaneAutoRecovery });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'stop') {
    const result = stopControl();
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (command === 'restart') {
    const stopResult = stopControl();
    if (stopResult?.ok === false) {
      const result = {
        ...stopResult,
        restartAborted: true,
      };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const result = startControl({ statePath, intervalMs, agentPaneAutoRecovery });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  return runScheduledLoop({ statePath, intervalMs, agentPaneAutoRecovery });
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_ARCHITECT_SILENCE_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_ORACLE_SILENCE_MS,
  DEFAULT_LOG_PATH,
  DEFAULT_PID_PATH,
  DEFAULT_STATUS_PATH,
  DEFAULT_STATE_PATH,
  buildRunnerOwnershipSnapshot,
  buildRunnerStatusSnapshot,
  defaultState,
  isActiveWindow,
  isExactRunnerProcessRow,
  hasPendingTeamWork,
  readRunnerStatus,
  loadState,
  persistState,
  runCli,
  runHeartbeatCycle,
  runScheduledLoop,
  startRunner,
  stopRunner,
  summarizeHeartbeatResult,
};
