'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { DaemonClient } = require('../daemon-client');
const {
  TRUSTQUOTE_ROOM_ID,
  buildTrustQuoteWorkRoomContract,
} = require('./project-room-envelope');
const {
  ROUTE_OWNER_ID,
  ROUTE_OWNER_VERSION,
  buildTrustQuoteRouteOwnerPlan,
} = require('./trustquote-work-room-route-owner');

const SUPERVISOR_VERSION = 'squidrun.trustquote-work-room-route-owner-supervisor.v0';
const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_PROBE_STALE_AFTER_MS = 60000;

function toText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizePathForMetadata(value) {
  return toText(value, '').replace(/\\/g, '/');
}

function resolveSquidrunRoot(options = {}) {
  return path.resolve(options.squidrunRoot || path.join(__dirname, '..', '..'));
}

function resolveLifecycleDir(options = {}) {
  return path.resolve(
    options.lifecycleDir
    || path.join(resolveSquidrunRoot(options), '.squidrun', 'runtime', 'trustquote-work-room-route-owner')
  );
}

function resolveStatusPath(options = {}) {
  return path.resolve(options.statusPath || path.join(resolveLifecycleDir(options), 'status.json'));
}

function resolveLogPath(options = {}) {
  return path.resolve(options.logPath || path.join(resolveLifecycleDir(options), 'route-owner.log'));
}

function resolveScriptPath(options = {}) {
  return path.resolve(options.scriptPath || path.join(resolveSquidrunRoot(options), 'ui', 'scripts', 'hm-trustquote-room-route-owner.js'));
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
  return filePath;
}

function isPidAlive(pid, killImpl = process.kill) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    killImpl(numericPid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function readRouteOwnerStatus(options = {}) {
  const statusPath = resolveStatusPath(options);
  const status = readJsonFile(statusPath);
  const plan = buildTrustQuoteRouteOwnerPlan(options);
  const pidAlive = status?.pid ? isPidAlive(status.pid, options.killImpl || process.kill) : false;
  if (!status) {
    return {
      version: SUPERVISOR_VERSION,
      routeOwner: ROUTE_OWNER_ID,
      state: 'stopped',
      running: false,
      pid: null,
      pidAlive: false,
      statusPath: normalizePathForMetadata(statusPath),
      plan,
    };
  }
  return {
    ...status,
    version: status.version || SUPERVISOR_VERSION,
    routeOwner: status.routeOwner || ROUTE_OWNER_ID,
    state: pidAlive ? (status.state || 'running') : 'stopped',
    running: pidAlive,
    pidAlive,
    statusPath: normalizePathForMetadata(statusPath),
    plan: status.plan || plan,
  };
}

function buildRunArgs(options = {}) {
  const plan = buildTrustQuoteRouteOwnerPlan(options);
  const args = [
    resolveScriptPath(options),
    'run',
    '--session',
    options.mainSessionScopeId || options.sessionScopeId || plan.mainSessionScopeId,
    '--status-file',
    resolveStatusPath(options),
  ];
  if (options.projectPath) args.push('--project-path', options.projectPath);
  if (options.squidrunRoot) args.push('--squidrun-root', options.squidrunRoot);
  if (options.dryRun === true) args.push('--dry-run');
  if (options.launchAgents !== true) args.push('--no-launch-agents');
  return args;
}

function writeSupervisorStatus(options = {}, patch = {}) {
  const statusPath = resolveStatusPath(options);
  const previous = readJsonFile(statusPath) || {};
  const payload = {
    version: SUPERVISOR_VERSION,
    routeOwner: ROUTE_OWNER_ID,
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
    statusPath: normalizePathForMetadata(statusPath),
  };
  writeJsonAtomic(statusPath, payload);
  return payload;
}

function startTrustQuoteRouteOwner(options = {}) {
  const statusPath = resolveStatusPath(options);
  const logPath = resolveLogPath(options);
  const existing = readRouteOwnerStatus(options);
  if (existing.running) {
    return {
      ok: true,
      alreadyRunning: true,
      status: existing,
    };
  }
  if (options.launchAgents === true && options.allowLiveAgents !== true) {
    return {
      ok: false,
      reason: 'live_agent_launch_requires_explicit_allow',
      launchAgents: true,
      status: existing,
    };
  }

  const plan = buildTrustQuoteRouteOwnerPlan(options);
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  const spawnImpl = options.spawnImpl || spawn;
  const child = spawnImpl(process.execPath, buildRunArgs(options), {
    cwd: resolveSquidrunRoot(options),
    detached: true,
    windowsHide: true,
    env: {
      ...process.env,
      SQUIDRUN_PROFILE: TRUSTQUOTE_ROOM_ID,
      ...(options.env && typeof options.env === 'object' ? options.env : {}),
    },
    stdio: ['ignore', logFd, logFd],
  });
  if (typeof child.unref === 'function') child.unref();
  const status = writeSupervisorStatus(options, {
    state: 'starting',
    running: true,
    pid: child.pid || null,
    pidAlive: Boolean(child.pid),
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    stopReason: null,
    terminalCleanup: null,
    error: null,
    launchAgents: options.launchAgents === true,
    dryRun: options.dryRun === true,
    command: [process.execPath, ...buildRunArgs(options)].join(' '),
    logPath: normalizePathForMetadata(logPath),
    plan,
  });
  if (typeof fs.closeSync === 'function') {
    try {
      fs.closeSync(logFd);
    } catch (_) {}
  }
  return {
    ok: true,
    started: true,
    status,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopTrustQuoteRouteOwner(options = {}) {
  const status = readRouteOwnerStatus(options);
  const terminalCleanup = await cleanupRouteOwnerTerminals(options, status.plan);
  if (!status.pid || !status.pidAlive) {
    const stopped = writeSupervisorStatus(options, {
      state: 'stopped',
      running: false,
      pidAlive: false,
      stoppedAt: new Date().toISOString(),
      stopReason: options.reason || 'not_running',
      terminalCleanup,
    });
    return {
      ok: true,
      stopped: false,
      reason: 'not_running',
      status: stopped,
      terminalCleanup,
    };
  }

  const killImpl = options.killImpl || process.kill;
  killImpl(Number(status.pid), options.signal || 'SIGTERM');
  const timeoutMs = Number.parseInt(String(options.timeoutMs || DEFAULT_STOP_TIMEOUT_MS), 10) || DEFAULT_STOP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(status.pid, killImpl)) break;
    await wait(100);
  }
  const aliveAfterStop = isPidAlive(status.pid, killImpl);
  const next = writeSupervisorStatus(options, {
    state: aliveAfterStop ? 'stop_pending' : 'stopped',
    running: aliveAfterStop,
    pidAlive: aliveAfterStop,
    stoppedAt: aliveAfterStop ? null : new Date().toISOString(),
    stopReason: options.reason || 'stop_requested',
    terminalCleanup,
  });
  return {
    ok: !aliveAfterStop,
    stopped: !aliveAfterStop,
    reason: aliveAfterStop ? 'stop_timeout' : 'stopped',
    status: next,
    terminalCleanup,
  };
}

async function cleanupRouteOwnerTerminals(options = {}, plan = null) {
  if (options.killTerminalsOnStop === false) {
    return { skipped: true, reason: 'disabled' };
  }
  const routePlan = plan || buildTrustQuoteRouteOwnerPlan(options);
  const injectedDaemonClient = Boolean(options.daemonClient);
  const daemonClient = options.daemonClient || new DaemonClient({ profileName: TRUSTQUOTE_ROOM_ID });
  try {
    if (typeof daemonClient.connect === 'function') {
      const connected = await daemonClient.connect();
      if (connected === false) {
        return { ok: false, reason: 'daemon_unavailable', killed: [] };
      }
    }
    const killed = [];
    for (const spec of routePlan.roles || []) {
      if (!spec?.paneId || typeof daemonClient.kill !== 'function') continue;
      daemonClient.kill(spec.paneId);
      killed.push(spec.paneId);
    }
    return { ok: true, killed };
  } catch (err) {
    return { ok: false, reason: 'cleanup_failed', error: err.message, killed: [] };
  } finally {
    if (!injectedDaemonClient && typeof daemonClient.disconnect === 'function') {
      try {
        daemonClient.disconnect();
      } catch (_) {}
    }
  }
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch (_) {
    return null;
  }
}

function waitForSocketMessage(ws, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off?.('message', onMessage);
      ws.off?.('error', onError);
      ws.off?.('close', onClose);
    };
    const onMessage = (raw) => {
      const msg = parseJson(raw?.toString ? raw.toString() : raw);
      if (!msg || !predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${label} socket closed`));
    };
    ws.on?.('message', onMessage);
    ws.on?.('error', onError);
    ws.on?.('close', onClose);
  });
}

async function probeTrustQuoteRouteOwner(options = {}) {
  const plan = buildTrustQuoteRouteOwnerPlan(options);
  const status = readRouteOwnerStatus(options);
  const timeoutMs = Number.parseInt(String(options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS), 10) || DEFAULT_PROBE_TIMEOUT_MS;
  const WebSocketImpl = options.WebSocketImpl || require('ws');
  const ws = new WebSocketImpl(`ws://127.0.0.1:${plan.port}`);
  try {
    await waitForSocketMessage(ws, (msg) => msg.type === 'welcome', timeoutMs, 'welcome');
    ws.send(JSON.stringify({
      type: 'register',
      role: 'architect',
      paneId: 'trustquote-probe',
      profileName: 'trustquote',
      windowKey: 'trustquote',
      sessionScopeId: plan.sessionScopeId,
    }));
    await waitForSocketMessage(ws, (msg) => msg.type === 'registered', timeoutMs, 'registered');
    const routeHealth = {};
    for (const role of ['builder', 'oracle']) {
      const requestId = `trustquote-route-probe-${role}-${Date.now()}`;
      const resultPromise = waitForSocketMessage(
        ws,
        (msg) => msg.type === 'health-check-result' && msg.requestId === requestId,
        timeoutMs,
        `${role} health-check`
      );
      ws.send(JSON.stringify({
        type: 'health-check',
        target: role,
        requestId,
        staleAfterMs: options.staleAfterMs || DEFAULT_PROBE_STALE_AFTER_MS,
      }));
      routeHealth[role] = await resultPromise;
    }
    const contract = buildTrustQuoteWorkRoomContract({
      ...options,
      mainSessionScopeId: plan.mainSessionScopeId,
      routeHealth,
    });
    return {
      ok: true,
      reachable: true,
      status,
      plan,
      routeHealth,
      contract: {
        status: contract.status,
        canRenderTopTab: contract.canRenderTopTab,
        canRouteTask: contract.canRouteTask,
        allowedTargets: contract.routeContract.allowedTargets,
        blockers: contract.blockers,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      error: err.message,
      status,
      plan,
      routeHealth: {},
      contract: null,
    };
  } finally {
    try {
      if (ws && ws.readyState !== 3) ws.close();
    } catch (_) {}
  }
}

module.exports = {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_STALE_AFTER_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  SUPERVISOR_VERSION,
  buildRunArgs,
  cleanupRouteOwnerTerminals,
  isPidAlive,
  probeTrustQuoteRouteOwner,
  readRouteOwnerStatus,
  resolveLifecycleDir,
  resolveLogPath,
  resolveStatusPath,
  startTrustQuoteRouteOwner,
  stopTrustQuoteRouteOwner,
  writeSupervisorStatus,
};
