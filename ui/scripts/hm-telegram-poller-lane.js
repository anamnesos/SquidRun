#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const { getProjectRoot, resolveCoordPath } = require('../config');
const { buildProfileTelegramEnv, getProfileProjectRootOverride } = require('../profile');
const {
  acquireProcessLease,
  releaseProcessLease,
} = require('../modules/cross-process-lease');
const telegramPoller = require('../modules/telegram-poller');
const { resolveTelegramInboundRoute } = require('./hm-telegram-routing');
const { resolveRuntimeUiScriptPath } = require('./runtime-ui-paths');

const RUNTIME_DIR = resolveCoordPath('runtime', { forWrite: true });
const PID_PATH = path.join(RUNTIME_DIR, 'telegram-poller-lane.pid');
const LOG_PATH = path.join(RUNTIME_DIR, 'telegram-poller-lane.log');
const LANE_CLAIM_VERSION = 2;
const CLAIM_MUTATION_LOCK_TIMEOUT_MS = 2_000;
const CLAIM_MUTATION_LOCK_STALE_MS = 1_000;
const CLAIM_MUTATION_LOCK_RETRY_MS = 10;
const KEEPALIVE_INTERVAL_MS = 60_000;
const MAIN_OWNER_RECONCILE_INTERVAL_MS = 1_000;
const MAIN_TELEGRAM_WORKER_PATH = path.resolve(__dirname, '..', 'modules', 'main', 'telegram-poller-worker.js');
const POLLER_STATE_REL_PATH = path.join('.squidrun', 'runtime', 'telegram-poller-state.json');

function usage() {
  console.log('Usage: node ui/scripts/hm-telegram-poller-lane.js <start|stop|status|run>');
  console.log('Starts a single-owner Telegram poller lane outside Electron when the app worker is stale.');
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessListText() {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        }
      );
      return result.status === 0 ? String(result.stdout || '') : '';
    }
    const result = spawnSync('ps', ['-eo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    return result.status === 0 ? String(result.stdout || '') : '';
  } catch {
    return '';
  }
}

function normalizeIdentityPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value.trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function tokenizeCommandLine(commandLine) {
  const tokens = [];
  const matcher = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = matcher.exec(String(commandLine || ''))) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function commandInvokesExactScript(commandLine, scriptPath, requiredArg = null) {
  const expectedScript = normalizeIdentityPath(scriptPath);
  if (!expectedScript) return false;
  const tokens = tokenizeCommandLine(commandLine);
  if (tokens.length < 2 || normalizeIdentityPath(tokens[1]) !== expectedScript) return false;
  if (requiredArg !== null && String(tokens[2] || '').trim().toLowerCase() !== requiredArg) return false;
  return true;
}

function pathIsWithinRoot(rootPath, candidatePath) {
  const root = normalizeIdentityPath(rootPath);
  const candidate = normalizeIdentityPath(candidatePath);
  if (!root || !candidate) return false;
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isStandaloneLaneProcess(pid, options = {}) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  const expectedScriptPath = options.scriptPath || __filename;
  const processListText = typeof options.processListText === 'string'
    ? options.processListText
    : readProcessListText();
  return String(processListText || '')
    .split(/\r?\n/)
    .some((line) => {
      const match = String(line || '').match(/^\s*(\d+)\s+(.+)$/);
      if (!match || Number.parseInt(match[1], 10) !== numeric) return false;
      return commandInvokesExactScript(match[2], expectedScriptPath, 'run');
    });
}

function normalizeRootPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(value.trim());
}

function resolveExpectedDataRoot(env = process.env) {
  return normalizeRootPath(env.SQUIDRUN_DATA_ROOT)
    || normalizeRootPath(getProjectRoot())
    || normalizeRootPath(env.SQUIDRUN_PROJECT_ROOT);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolvePollerStatePath(projectRoot = getProjectRoot()) {
  return path.join(path.resolve(String(projectRoot || getProjectRoot() || process.cwd())), POLLER_STATE_REL_PATH);
}

function readMainTelegramWorkerOwner(options = {}) {
  const statePath = options.statePath ? path.resolve(String(options.statePath)) : resolvePollerStatePath();
  const state = readJsonFile(statePath);
  const poller = state?.poller && typeof state.poller === 'object' && !Array.isArray(state.poller)
    ? state.poller
    : null;
  if (!poller) return null;
  const ownerPid = Number.parseInt(String(poller.pid ?? ''), 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || ownerPid === process.pid) return null;

  const expectedDataRoot = resolveExpectedDataRoot(options.env || process.env);
  const pollerDataRoot = normalizeRootPath(poller.dataRoot);
  if (pollerDataRoot && expectedDataRoot && pollerDataRoot.toLowerCase() !== expectedDataRoot.toLowerCase()) {
    return null;
  }
  return {
    pid: ownerPid,
    dataRoot: pollerDataRoot || null,
    statePath,
  };
}

function listMainTelegramWorkerProcesses(options = {}) {
  const processListText = typeof options.processListText === 'string'
    ? options.processListText
    : readProcessListText();
  const expectedScriptPath = options.mainWorkerScriptPath || MAIN_TELEGRAM_WORKER_PATH;
  const expectedDataRoot = resolveExpectedDataRoot(options.env || process.env);
  if (expectedDataRoot && !pathIsWithinRoot(expectedDataRoot, expectedScriptPath)) return [];
  if (!processListText) return [];
  return processListText
    .split(/\r?\n/)
    .map((line) => {
      const text = line.trim();
      const match = text.match(/^\s*(\d+)\s+(.+)$/);
      if (!match || !commandInvokesExactScript(match[2], expectedScriptPath)) return null;
      const pid = match ? Number.parseInt(match[1], 10) : null;
      return { pid, commandLine: match[2], scriptPath: path.resolve(expectedScriptPath) };
    })
    .filter(Boolean)
    .filter((entry) => !Number.isInteger(entry.pid) || entry.pid !== process.pid);
}

function isMainTelegramWorkerAlive(options = {}) {
  const owner = options.owner || readMainTelegramWorkerOwner(options);
  const localMainWorkers = listMainTelegramWorkerProcesses(options);
  if (owner && localMainWorkers.some((entry) => Number(entry?.pid) === owner.pid)) {
    return true;
  }
  // The shared heartbeat can be overwritten by a stale standalone poll that
  // finishes after the main worker's pre-poll claim. The exact script path is
  // rooted in this runtime, so a local main worker is authoritative while the
  // mutable heartbeat catches up. Foreign side-profile runtimes cannot match.
  return localMainWorkers.length > 0;
}

function hasAnyMainTelegramWorkerProcess(options = {}) {
  return listMainTelegramWorkerProcesses(options).length > 0;
}

function allowsStandaloneLaneWithMainWorker(env = process.env) {
  return String(env.SQUIDRUN_ALLOW_STANDALONE_TELEGRAM_LANE || '').trim() === '1';
}

function readLaneClaim(claimPath = PID_PATH) {
  try {
    const raw = fs.readFileSync(claimPath, 'utf8').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      return {
        version: 1,
        state: 'legacy',
        pid: Number.parseInt(raw, 10),
        raw,
      };
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...parsed, raw }
      : null;
  } catch {
    return null;
  }
}

function readPid(claimPath = PID_PATH) {
  const claim = readLaneClaim(claimPath);
  const pid = Number.parseInt(String(claim?.pid ?? ''), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function laneClaimMatchesRuntime(claim, options = {}) {
  if (!claim || Number(claim.version) !== LANE_CLAIM_VERSION) return false;
  const expectedRoot = normalizeIdentityPath(options.projectRoot || getProjectRoot());
  const expectedScript = normalizeIdentityPath(options.scriptPath || __filename);
  return normalizeIdentityPath(claim.projectRoot) === expectedRoot
    && normalizeIdentityPath(claim.scriptPath) === expectedScript
    && typeof claim.launchToken === 'string'
    && claim.launchToken.length > 0;
}

function writeClaimExclusive(claimPath, claim) {
  fs.mkdirSync(path.dirname(claimPath), { recursive: true });
  let fd = null;
  try {
    fd = fs.openSync(claimPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(claim, null, 2)}\n`, 'utf8');
    return { ok: true, claim };
  } catch (err) {
    if (err?.code === 'EEXIST') {
      return { ok: false, reason: 'claim_exists', claim: readLaneClaim(claimPath) };
    }
    return { ok: false, reason: 'claim_create_failed', error: err.message, claim: null };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function createLaneLaunchClaim(options = {}) {
  const claimPath = options.claimPath || PID_PATH;
  const claim = {
    version: LANE_CLAIM_VERSION,
    state: 'launching',
    pid: null,
    launcherPid: Number(options.launcherPid) || process.pid,
    launchToken: options.launchToken || crypto.randomUUID(),
    projectRoot: path.resolve(options.projectRoot || getProjectRoot()),
    scriptPath: path.resolve(options.scriptPath || __filename),
    createdAt: new Date().toISOString(),
  };
  return withClaimMutationLock(
    claimPath,
    options,
    () => writeClaimExclusive(claimPath, claim)
  );
}

function acquireClaimMutationLock(claimPath, options = {}) {
  const lockPath = `${claimPath}.mutation-lock`;
  const timeoutMs = Number.isFinite(Number(options.claimMutationLockTimeoutMs))
    ? Math.max(0, Number(options.claimMutationLockTimeoutMs))
    : CLAIM_MUTATION_LOCK_TIMEOUT_MS;
  const staleMs = Number.isFinite(Number(options.claimMutationLockStaleMs))
    ? Math.max(0, Number(options.claimMutationLockStaleMs))
    : CLAIM_MUTATION_LOCK_STALE_MS;
  const lease = acquireProcessLease(lockPath, {
    timeoutMs,
    retryMs: CLAIM_MUTATION_LOCK_RETRY_MS,
    staleMs,
    isProcessAlive: options.isClaimMutationLockOwnerAlive,
    resource: path.resolve(claimPath),
  });
  if (lease.ok) return lease;
  return {
    ...lease,
    reason: lease.reason === 'lease_busy'
      ? 'claim_mutation_lock_timeout'
      : 'claim_mutation_lock_failed',
  };
}

function releaseClaimMutationLock(lock) {
  return releaseProcessLease(lock);
}

function withClaimMutationLock(claimPath, options, operation) {
  const lock = acquireClaimMutationLock(claimPath, options);
  if (!lock.ok) return lock;
  try {
    return operation();
  } catch (err) {
    return {
      ok: false,
      reason: 'claim_mutation_failed',
      error: err.message,
    };
  } finally {
    releaseClaimMutationLock(lock);
  }
}

function writeLaneClaimAtomically(claimPath, claim) {
  const tempPath = `${claimPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(claim, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, claimPath);
    return true;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function claimLaneForChild(options = {}) {
  const claimPath = options.claimPath || PID_PATH;
  const projectRoot = path.resolve(options.projectRoot || getProjectRoot());
  const scriptPath = path.resolve(options.scriptPath || __filename);
  const childPid = Number(options.pid) || process.pid;
  const launchToken = typeof options.launchToken === 'string' && options.launchToken
    ? options.launchToken
    : crypto.randomUUID();
  const initial = readLaneClaim(claimPath);

  if (!initial) {
    return withClaimMutationLock(claimPath, options, () => {
      if (readLaneClaim(claimPath)) {
        return {
          ok: false,
          reason: 'claim_owned_by_another_lane',
          claim: readLaneClaim(claimPath),
        };
      }
      return writeClaimExclusive(claimPath, {
        version: LANE_CLAIM_VERSION,
        state: 'running',
        pid: childPid,
        launcherPid: null,
        launchToken,
        projectRoot,
        scriptPath,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
      });
    });
  }

  return withClaimMutationLock(claimPath, options, () => {
    const existing = readLaneClaim(claimPath);
    if (
      existing?.state !== 'launching'
      || existing.launchToken !== launchToken
      || !laneClaimMatchesRuntime(existing, { projectRoot, scriptPath })
    ) {
      return { ok: false, reason: 'claim_owned_by_another_lane', claim: existing };
    }
    const validatedRaw = existing.raw;
    if (typeof options.beforeClaimMutationCommit === 'function') {
      options.beforeClaimMutationCommit({
        claimPath,
        operation: 'child_adoption',
        validatedClaim: existing,
      });
    }
    const latest = readLaneClaim(claimPath);
    if (!latest || latest.raw !== validatedRaw) {
      return { ok: false, reason: 'claim_changed_during_adoption', claim: latest };
    }

    const runningClaim = {
      ...existing,
      state: 'running',
      pid: childPid,
      startedAt: new Date().toISOString(),
    };
    delete runningClaim.raw;
    writeLaneClaimAtomically(claimPath, runningClaim);
    const committed = readLaneClaim(claimPath);
    if (
      committed?.launchToken !== launchToken
      || Number(committed?.pid) !== childPid
      || committed?.state !== 'running'
    ) {
      return { ok: false, reason: 'claim_adoption_not_committed', claim: committed };
    }
    return { ok: true, claim: committed };
  });
}

function removeLaneClaimIfOwned(expected = {}, claimPath = PID_PATH, options = {}) {
  const result = withClaimMutationLock(claimPath, options, () => {
    const current = readLaneClaim(claimPath);
    if (!current) return { ok: true, removed: false, reason: 'claim_missing' };
    if (expected.raw && current.raw !== expected.raw) {
      return { ok: false, removed: false, reason: 'claim_changed' };
    }
    if (expected.launchToken && current.launchToken !== expected.launchToken) {
      return { ok: false, removed: false, reason: 'claim_token_mismatch' };
    }
    if (
      Number.isInteger(Number(expected.pid))
      && Number(current.pid) !== Number(expected.pid)
    ) {
      return { ok: false, removed: false, reason: 'claim_pid_mismatch' };
    }
    const validatedRaw = current.raw;
    if (typeof options.beforeClaimMutationCommit === 'function') {
      options.beforeClaimMutationCommit({
        claimPath,
        operation: 'conditional_removal',
        validatedClaim: current,
      });
    }
    const latest = readLaneClaim(claimPath);
    if (!latest || latest.raw !== validatedRaw) {
      return { ok: false, removed: false, reason: 'claim_changed' };
    }

    const tombstonePath = `${claimPath}.${process.pid}.${crypto.randomUUID()}.removed`;
    fs.renameSync(claimPath, tombstonePath);
    fs.rmSync(tombstonePath, { force: true });
    return { ok: true, removed: true, reason: 'claim_removed' };
  });
  return result?.ok === true;
}

function writeLog(message) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

function status(options = {}) {
  const claimPath = options.claimPath || PID_PATH;
  const claim = readLaneClaim(claimPath);
  const pid = readPid(claimPath);
  const processListText = typeof options.processListText === 'string'
    ? options.processListText
    : readProcessListText();
  const probeOptions = { ...options, processListText };
  const pidAlive = typeof options.isPidAlive === 'function'
    ? options.isPidAlive(pid)
    : isPidAlive(pid);
  const processProbeAvailable = String(processListText || '').trim().length > 0;
  const claimMatchesRuntime = laneClaimMatchesRuntime(claim, options);
  const exactScriptProcess = pidAlive
    && processProbeAvailable
    && isStandaloneLaneProcess(pid, probeOptions);
  const exactProcess = exactScriptProcess && claimMatchesRuntime;
  const legacyClaimActive = exactScriptProcess
    && Number(claim?.version) === 1
    && claim?.state === 'legacy';
  const running = (pidAlive && exactProcess && claim?.state === 'running')
    || legacyClaimActive;
  const launcherPid = Number.parseInt(String(claim?.launcherPid ?? ''), 10);
  const launcherAlive = typeof options.isPidAlive === 'function'
    ? options.isPidAlive(launcherPid)
    : isPidAlive(launcherPid);
  const starting = claimMatchesRuntime
    && claim?.state === 'launching'
    && launcherAlive;
  const identityUnverified = pidAlive && !processProbeAvailable;
  const owner = readMainTelegramWorkerOwner(probeOptions);
  return {
    ok: true,
    running,
    starting,
    pid: running ? pid : null,
    stalePid: pidAlive
      && processProbeAvailable
      && !exactProcess
      && !legacyClaimActive
      ? pid
      : null,
    identityUnverified,
    processProbeAvailable,
    legacyClaimActive,
    claimState: claim?.state || null,
    claimMatchesRuntime,
    pidPath: claimPath,
    logPath: LOG_PATH,
    mainWorkerRunning: isMainTelegramWorkerAlive({ ...probeOptions, owner }),
    anyMainWorkerRunning: hasAnyMainTelegramWorkerProcess(probeOptions),
    mainWorkerOwner: owner,
  };
}

function sendToArchitect(message) {
  const projectRoot = getProjectRoot();
  const hmSendPath = resolveRuntimeUiScriptPath(projectRoot, 'hm-send.js');
  const run = spawnSync(process.execPath, [hmSendPath, 'architect', '--stdin', '--role', 'system'], {
    cwd: projectRoot,
    env: { ...process.env, SQUIDRUN_PROJECT_ROOT: projectRoot },
    input: message,
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (run.status !== 0) {
    writeLog(`[warn] hm-send failed: ${String(run.stderr || run.error?.message || 'unknown').trim()}`);
  }
}

function getProfileTelegramTriggerPaths(windowKey = '', env = process.env) {
  const normalizedWindowKey = typeof windowKey === 'string' && windowKey.trim()
    ? windowKey.trim()
    : '';
  if (!normalizedWindowKey || normalizedWindowKey === 'main') return [];

  const profileRoot = getProfileProjectRootOverride(normalizedWindowKey, env);
  const roots = profileRoot
    ? [profileRoot]
    : [getProjectRoot()].filter(Boolean);

  return Array.from(new Set(roots.map((root) => path.resolve(root))))
    .map((root) => path.join(root, '.squidrun', `triggers-${normalizedWindowKey}`, 'architect.txt'));
}

function forwardToProfileTrigger(windowKey, message, env = process.env) {
  const normalizedMessage = typeof message === 'string' && message.trim() ? message : '';
  if (!normalizedMessage) return { ok: false, reason: 'empty_message' };

  const triggerPaths = getProfileTelegramTriggerPaths(windowKey, env);
  if (triggerPaths.length === 0) {
    return { ok: false, reason: 'missing_profile_trigger_path' };
  }

  const written = [];
  const errors = [];
  for (const triggerPath of triggerPaths) {
    try {
      fs.mkdirSync(path.dirname(triggerPath), { recursive: true });
      fs.writeFileSync(triggerPath, normalizedMessage, 'utf8');
      written.push(triggerPath);
    } catch (err) {
      errors.push({ path: triggerPath, error: err.message });
    }
  }

  return {
    ok: written.length > 0,
    written,
    errors,
    reason: written.length > 0 ? null : 'profile_trigger_write_failed',
  };
}

function dispatchInboundTelegramMessage(message, metadata = {}, options = {}) {
  const env = options.env || process.env;
  const resolver = typeof options.resolveInboundRoute === 'function'
    ? options.resolveInboundRoute
    : resolveTelegramInboundRoute;
  const route = resolver({ chatId: metadata?.chatId, env });
  const updateId = metadata?.updateId ?? 'unknown';
  const logEvent = typeof options.writeLog === 'function' ? options.writeLog : writeLog;

  if (!route?.ok) {
    const reason = route?.reason || 'telegram_inbound_route_blocked';
    logEvent(`[privacy-block] inbound update=${updateId} chat=${route?.chatId || 'unknown'} reason=${reason}`);
    return {
      ok: false,
      blocked: true,
      reason,
      route,
    };
  }

  const windowKey = route.windowKey || 'main';
  if (windowKey !== 'main') {
    const forward = typeof options.forwardToProfileTrigger === 'function'
      ? options.forwardToProfileTrigger(windowKey, message, env)
      : forwardToProfileTrigger(windowKey, message, env);
    if (forward?.ok) {
      logEvent(`[routed] inbound update=${updateId} chat=${route.chatId || 'unknown'} window=${windowKey}`);
      return {
        ok: true,
        target: 'profile-trigger',
        windowKey,
        route,
        forward,
      };
    }
    logEvent(`[privacy-block] inbound update=${updateId} chat=${route.chatId || 'unknown'} window=${windowKey} reason=${forward?.reason || 'profile_trigger_failed'}`);
    return {
      ok: false,
      blocked: true,
      reason: forward?.reason || 'profile_trigger_failed',
      route,
      forward,
    };
  }

  const send = typeof options.sendToArchitect === 'function' ? options.sendToArchitect : sendToArchitect;
  send(message);
  return {
    ok: true,
    target: 'architect',
    windowKey: 'main',
    route,
  };
}

function formatInbound(text, from, metadata = {}) {
  const sender = typeof from === 'string' && from.trim() ? from.trim() : 'unknown';
  const media = metadata?.media && typeof metadata.media === 'object' ? metadata.media : null;
  let body = typeof text === 'string' ? text.trim() : '';
  if (!body && media?.kind === 'photo') {
    body = '[Photo received]';
  } else if (!body && media?.kind === 'video') {
    body = '[Video received]';
  } else if (!body && media?.kind === 'document') {
    const fileName = typeof media.fileName === 'string' && media.fileName.trim()
      ? media.fileName.trim()
      : 'unknown';
    body = `[File: ${fileName}]`;
  }
  if (!body) return null;
  const archivePath = typeof media?.localPath === 'string' && media.localPath.trim()
    ? media.localPath.trim()
    : null;
  return `[Telegram from ${sender}]: ${archivePath ? `${body} | saved: ${archivePath}` : body}`;
}

function runLane() {
  require('dotenv').config({ path: path.join(getProjectRoot(), '.env'), quiet: true });
  const launchToken = String(process.env.SQUIDRUN_TELEGRAM_LANE_LAUNCH_TOKEN || '').trim();
  const processListText = readProcessListText();
  if (!String(processListText || '').trim()) {
    writeLog('[blocked] process identity probe unavailable; standalone ownership cannot be proven');
    if (launchToken) removeLaneClaimIfOwned({ launchToken });
    process.exit(4);
    return;
  }
  if (
    isMainTelegramWorkerAlive({ processListText })
    && !allowsStandaloneLaneWithMainWorker()
  ) {
    writeLog('[blocked] main telegram-poller-worker is already running; standalone lane would cause Telegram 409 conflicts');
    if (launchToken) removeLaneClaimIfOwned({ launchToken });
    process.exit(2);
    return;
  }
  const ownership = claimLaneForChild({ launchToken });
  if (!ownership.ok) {
    writeLog(`[blocked] standalone ownership claim rejected reason=${ownership.reason}`);
    process.exit(3);
    return;
  }
  const ownedClaim = ownership.claim;
  writeLog(`[start] pid=${process.pid}`);
  let shuttingDown = false;
  let keepAliveTimer = null;
  let mainOwnerReconcileTimer = null;

  const shutdown = (reason = 'signal', exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (mainOwnerReconcileTimer) clearInterval(mainOwnerReconcileTimer);
    try {
      telegramPoller.stop();
    } catch {
      // Best effort.
    }
    try {
      removeLaneClaimIfOwned({
        launchToken: ownedClaim.launchToken,
        pid: process.pid,
      });
    } catch {
      // Best effort.
    }
    writeLog(`[stop] pid=${process.pid} reason=${reason}`);
    process.exit(exitCode);
  };

  keepAliveTimer = setInterval(() => {}, KEEPALIVE_INTERVAL_MS);

  const ownerEnv = {
    ...buildProfileTelegramEnv(process.env, 'main'),
    SQUIDRUN_TELEGRAM_ACCEPT_SCOPED_CHATS: '1',
    SQUIDRUN_TELEGRAM_STANDALONE_LANE: '1',
  };
  const started = telegramPoller.start({
    env: ownerEnv,
    onMessage: (text, from, metadata = {}) => {
      const formatted = formatInbound(text, from, metadata);
      if (!formatted) {
        writeLog(`[drop] empty inbound update=${metadata?.updateId ?? 'unknown'}`);
        return;
      }
      writeLog(`[inbound] update=${metadata?.updateId ?? 'unknown'} media=${metadata?.media?.kind || 'none'}`);
      dispatchInboundTelegramMessage(formatted, metadata, { env: ownerEnv });
    },
  });

  if (!started) {
    writeLog('[error] Telegram poller did not start; missing config');
    shutdown('poller_not_started', 1);
    return;
  }

  // A standalone lane is only the temporary owner. The main worker claims the
  // shared heartbeat before its first getUpdates tick; yield within one second
  // so both owners can never reach their first poll together.
  mainOwnerReconcileTimer = setInterval(() => {
    if (isMainTelegramWorkerAlive() && !allowsStandaloneLaneWithMainWorker()) {
      writeLog('[handoff] main telegram-poller-worker claimed ownership; stopping standalone lane');
      shutdown('main_worker_takeover', 0);
    }
  }, MAIN_OWNER_RECONCILE_INTERVAL_MS);

  process.on('SIGTERM', () => shutdown('sigterm', 0));
  process.on('SIGINT', () => shutdown('sigint', 0));
}

function buildStandaloneLaneSpawnOptions(projectRoot = getProjectRoot(), env = process.env, outFd = 'ignore') {
  return {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: {
      ...env,
      SQUIDRUN_PROJECT_ROOT: projectRoot,
      ELECTRON_RUN_AS_NODE: '1',
    },
    windowsHide: true,
  };
}

function evaluateLaneStartupProof(childPid, proof = {}) {
  const numericPid = Number(childPid);
  if (proof.mainWorkerRunning === true) {
    return {
      ok: true,
      started: false,
      handedOffToMain: true,
      reason: 'main_telegram_worker_running',
    };
  }
  if (proof.alive !== true) {
    return {
      ok: false,
      started: false,
      handedOffToMain: false,
      reason: 'lane_child_died_immediately',
    };
  }
  if (
    !Number.isInteger(numericPid)
    || Number(proof.claimedPid) !== numericPid
    || !proof.expectedToken
    || proof.claimedToken !== proof.expectedToken
  ) {
    return {
      ok: false,
      started: false,
      handedOffToMain: false,
      reason: 'lane_child_alive_without_startup_claim',
    };
  }
  return {
    ok: true,
    started: true,
    handedOffToMain: false,
    reason: 'lane_child_claimed',
  };
}

function startLane(options = {}) {
  const initialClaim = readLaneClaim();
  const current = status();
  if (current.running) return { ok: true, alreadyRunning: true, ...current };
  if (current.starting) {
    return {
      ok: true,
      started: false,
      alreadyStarting: true,
      reason: 'lane_start_in_progress',
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  }
  if (current.identityUnverified) {
    return {
      ok: false,
      started: false,
      reason: 'process_identity_probe_unavailable',
      note: 'A live claimed PID could not be identified; refusing to remove its claim, spawn, or stop.',
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  }
  if (!current.processProbeAvailable) {
    return {
      ok: false,
      started: false,
      reason: 'process_identity_probe_unavailable',
      note: 'Main/standalone ownership cannot be identified; refusing to spawn another Telegram poller.',
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  }
  if (current.mainWorkerRunning && !allowsStandaloneLaneWithMainWorker()) {
    return {
      ok: false,
      started: false,
      reason: 'main_telegram_worker_running',
      note: 'Refusing to start standalone Telegram lane while the app poller owns getUpdates; this prevents Telegram 409 conflicts.',
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  }
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  if (initialClaim && !removeLaneClaimIfOwned({
    raw: initialClaim.raw,
    launchToken: initialClaim.launchToken,
    pid: initialClaim.pid,
  })) {
    return {
      ok: false,
      started: false,
      reason: 'lane_claim_changed_during_cleanup',
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  }
  const launchClaimResult = createLaneLaunchClaim();
  if (!launchClaimResult.ok) {
    const claimIsActive = laneClaimMatchesRuntime(launchClaimResult.claim)
      && ['launching', 'running'].includes(launchClaimResult.claim?.state);
    return {
      ok: launchClaimResult.reason === 'claim_exists' && claimIsActive,
      started: false,
      alreadyStarting: launchClaimResult.reason === 'claim_exists' && claimIsActive,
      reason: launchClaimResult.reason,
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  }
  const launchClaim = launchClaimResult.claim;
  const out = fs.openSync(LOG_PATH, 'a');
  let child;
  try {
    child = spawn(
      process.execPath,
      [__filename, 'run'],
      buildStandaloneLaneSpawnOptions(getProjectRoot(), {
        ...process.env,
        SQUIDRUN_TELEGRAM_LANE_LAUNCH_TOKEN: launchClaim.launchToken,
      }, out)
    );
  } catch (err) {
    removeLaneClaimIfOwned({ launchToken: launchClaim.launchToken });
    return {
      ok: false,
      started: false,
      reason: 'lane_spawn_failed',
      error: err.message,
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  } finally {
    fs.closeSync(out);
  }
  child.unref();
  const startupVerifyMs = Number.isFinite(options.startupVerifyMs) ? Math.max(0, options.startupVerifyMs) : 4000;
  if (startupVerifyMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, startupVerifyMs);
  }
  const isAlive = typeof options.isPidAlive === 'function' ? options.isPidAlive(child.pid) : isPidAlive(child.pid);
  const mainWorkerRunning = typeof options.isMainWorkerAlive === 'function'
    ? options.isMainWorkerAlive()
    : isMainTelegramWorkerAlive();
  const claimed = readLaneClaim();
  const startupProof = evaluateLaneStartupProof(child.pid, {
    alive: isAlive,
    claimedPid: claimed?.pid,
    claimedToken: claimed?.launchToken,
    expectedToken: launchClaim.launchToken,
    mainWorkerRunning,
  });
  if (startupProof.handedOffToMain && isAlive) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // The just-spawned child may already be yielding to the main owner.
    }
    removeLaneClaimIfOwned({
      launchToken: launchClaim.launchToken,
      pid: child.pid,
    });
  }
  if (!startupProof.ok) {
    if (isAlive && startupProof.reason === 'lane_child_alive_without_startup_claim') {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // The just-spawned child may have exited between proof and cleanup.
      }
    }
    removeLaneClaimIfOwned({ launchToken: launchClaim.launchToken });
    return {
      ...startupProof,
      pid: child.pid,
      note: `Lane child did not produce a verified startup claim within ${startupVerifyMs}ms; see ${LOG_PATH} for its output.`,
      pidPath: PID_PATH,
      logPath: LOG_PATH,
    };
  }
  return {
    ...startupProof,
    pid: startupProof.started ? child.pid : null,
    pidPath: PID_PATH,
    logPath: LOG_PATH,
  };
}

function stopLane(options = {}) {
  const claimPath = options.claimPath || PID_PATH;
  const initialClaim = readLaneClaim(claimPath);
  const current = status(options);
  if (current.identityUnverified) {
    return {
      ok: false,
      stopped: false,
      reason: 'process_identity_probe_unavailable',
      pidPath: PID_PATH,
    };
  }
  if (current.starting) {
    return {
      ok: false,
      stopped: false,
      reason: 'lane_start_in_progress',
      pidPath: PID_PATH,
    };
  }
  if (current.legacyClaimActive) {
    return {
      ok: false,
      stopped: false,
      reason: 'legacy_lane_claim_active',
      pid: current.pid,
      pidPath: claimPath,
    };
  }
  if (current.stalePid) {
    const removed = initialClaim
      ? removeLaneClaimIfOwned({
        raw: initialClaim.raw,
        launchToken: initialClaim.launchToken,
        pid: initialClaim.pid,
      }, claimPath, options)
      : true;
    if (!removed) {
      return {
        ok: false,
        stopped: false,
        reason: 'lane_claim_changed_during_cleanup',
        pid: current.stalePid,
        pidPath: claimPath,
      };
    }
    return {
      ok: false,
      stopped: false,
      reason: 'pid_identity_mismatch',
      pid: current.stalePid,
      pidPath: PID_PATH,
    };
  }
  if (!current.running) {
    const removed = initialClaim
      ? removeLaneClaimIfOwned({
        raw: initialClaim.raw,
        launchToken: initialClaim.launchToken,
        pid: initialClaim.pid,
      }, claimPath, options)
      : true;
    if (!removed) {
      return {
        ok: false,
        stopped: false,
        reason: 'lane_claim_changed_during_cleanup',
        pidPath: claimPath,
      };
    }
    return { ok: true, stopped: false, reason: 'not_running', pidPath: claimPath };
  }
  process.kill(current.pid, 'SIGTERM');
  return { ok: true, stopped: true, pid: current.pid, pidPath: PID_PATH };
}

function main(argv = process.argv.slice(2)) {
  const command = String(argv[0] || 'status').trim().toLowerCase();
  if (command === '--help' || command === '-h') {
    usage();
    return;
  }
  let result;
  if (command === 'run') {
    runLane();
    return;
  } else if (command === 'start') {
    result = startLane();
  } else if (command === 'stop') {
    result = stopLane();
  } else if (command === 'status') {
    result = status();
  } else {
    usage();
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  MAIN_OWNER_RECONCILE_INTERVAL_MS,
  buildStandaloneLaneSpawnOptions,
  claimLaneForChild,
  commandInvokesExactScript,
  createLaneLaunchClaim,
  dispatchInboundTelegramMessage,
  evaluateLaneStartupProof,
  forwardToProfileTrigger,
  formatInbound,
  getProfileTelegramTriggerPaths,
  isMainTelegramWorkerAlive,
  isPidAlive,
  isStandaloneLaneProcess,
  laneClaimMatchesRuntime,
  readLaneClaim,
  resolveRuntimeUiScriptPath,
  status,
  startLane,
  stopLane,
};
