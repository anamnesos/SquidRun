/**
 * File watcher worker process.
 * Emits file events to parent process only (no business logic).
 */

const path = require('path');
const chokidar = require('chokidar');
const { WORKSPACE_PATH, getCoordRoots, resolveCoordPath } = require('../config');

function getCoordWatchRoots() {
  if (typeof getCoordRoots === 'function') {
    const roots = getCoordRoots({ includeLegacy: false, includeMissing: false });
    if (Array.isArray(roots) && roots.length > 0) {
      return roots;
    }
  }
  return [WORKSPACE_PATH];
}

function getTriggerWatchPaths() {
  const paths = [];
  if (typeof resolveCoordPath === 'function') {
    paths.push(resolveCoordPath('triggers', { forWrite: true }));
  }
  if (paths.length === 0) {
    paths.push(...getCoordWatchRoots().map((root) => path.join(root, 'triggers')));
  }
  return Array.from(new Set(paths.filter(Boolean).map((targetPath) => path.resolve(targetPath))));
}

const TRIGGER_PATHS = getTriggerWatchPaths();
const MESSAGE_QUEUE_DIR = path.join(WORKSPACE_PATH, 'messages');
const WORKSPACE_WATCH_POLL_INTERVAL_MS = 5000;
const WATCHER_HEARTBEAT_INTERVAL_MS = 5000;
const WORKSPACE_WATCH_TARGETS_ENV = 'SQUIDRUN_WORKSPACE_WATCH_TARGETS_JSON';
const WORKSPACE_WATCH_RELATIVE_PATHS = Object.freeze([
  'plan.md',
  'plan-approved.md',
  'plan-feedback.md',
  'checkpoint.md',
  'checkpoint-approved.md',
  'checkpoint-issues.md',
  'friction-resolution.md',
  'improvements.md',
  'shared_context.md',
  'blockers.md',
  'errors.md',
  'app-status.json',
  path.join('handoffs', 'session.md'),
  path.join('runtime', 'active-cases.json'),
  'pipeline.json',
  'review.json',
  'task-pool.json',
]);
const WORKSPACE_WATCH_RELATIVE_DIRS = Object.freeze([
  'friction',
]);
const RUNTIME_NOOP_DIR_RE = /[\\/]\.squidrun[\\/](?:logs(?:-[^\\/]+)?|runtime(?:-[^\\/]+)?)(?:[\\/]|$)/;
const RUNTIME_NOOP_FILE_RE = /[\\/](?:logs(?:-[^\\/]+)?|runtime(?:-[^\\/]+)?)[\\/](?:app\.log|daemon\.log|supervisor\.log|supervisor-status\.json|session\.md|last-session\.md|user-input-shadow\.jsonl|bus-reliability-trace\.jsonl|team-memory-pattern-spool\.jsonl|evidence-ledger\.db-(?:wal|shm))$/;
const ROOT_RUNTIME_NOOP_FILE_RE = /[\\/]\.squidrun[\\/](?:app-status\.json|perf-profile\.json|supervisor-status\.json|session\.md|last-session\.md)$/;

function isRuntimeNoopPath(filePath = '') {
  const normalized = String(filePath || '');
  return RUNTIME_NOOP_DIR_RE.test(normalized)
    || RUNTIME_NOOP_FILE_RE.test(normalized)
    || ROOT_RUNTIME_NOOP_FILE_RE.test(normalized);
}

function uniqueResolvedPaths(paths = []) {
  return Array.from(new Set(paths
    .filter((targetPath) => typeof targetPath === 'string' && targetPath.trim())
    .map((targetPath) => path.resolve(targetPath))));
}

function getCoordWatchPaths(relPath) {
  const paths = [];
  if (typeof resolveCoordPath === 'function') {
    paths.push(resolveCoordPath(relPath, { forWrite: true }));
  }
  if (paths.length === 0) {
    paths.push(...getCoordWatchRoots().map((root) => path.join(root, relPath)));
  }
  return uniqueResolvedPaths(paths);
}

function getDefaultWorkspaceWatchTargets() {
  return uniqueResolvedPaths([
    ...WORKSPACE_WATCH_RELATIVE_PATHS.flatMap((relPath) => getCoordWatchPaths(relPath)),
    ...WORKSPACE_WATCH_RELATIVE_DIRS.flatMap((relPath) => getCoordWatchPaths(relPath)),
  ]);
}

function parseWorkspaceWatchTargetsEnv() {
  const raw = process.env[WORKSPACE_WATCH_TARGETS_ENV];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const targets = uniqueResolvedPaths(parsed);
    return targets.length > 0 ? targets : null;
  } catch {
    return null;
  }
}

function getWorkspaceWatchTargets() {
  return parseWorkspaceWatchTargetsEnv() || getDefaultWorkspaceWatchTargets();
}

function normalizeForPathMatch(filePath = '') {
  return path.resolve(String(filePath || '')).toLowerCase();
}

function isSameOrNestedPath(candidate, target) {
  const normalizedCandidate = normalizeForPathMatch(candidate);
  const normalizedTarget = normalizeForPathMatch(target);
  return normalizedCandidate === normalizedTarget
    || normalizedCandidate.startsWith(`${normalizedTarget}${path.sep}`)
    || normalizedTarget.startsWith(`${normalizedCandidate}${path.sep}`);
}

function createAllowedWorkspacePathMatcher(targetPaths = []) {
  const targets = uniqueResolvedPaths(targetPaths);
  return (filePath = '') => targets.some((targetPath) => isSameOrNestedPath(filePath, targetPath));
}

function createWorkspaceIgnoredMatcher(targetPaths = []) {
  const isAllowedWorkspacePath = createAllowedWorkspacePathMatcher(targetPaths);
  const ignoredPatterns = [
    /node_modules[\\/]/,
    /\.git[\\/]/,
    /instances[\\/]/,
    /backups[\\/]/,
    /context-snapshots[\\/]/,
    /logs[\\/]/,
    RUNTIME_NOOP_DIR_RE,
    RUNTIME_NOOP_FILE_RE,
    ROOT_RUNTIME_NOOP_FILE_RE,
    /state\.json$/,
    /triggers(?:-[^\\/]+)?[\\/]/,
  ];
  return (filePath) => {
    if (isAllowedWorkspacePath(filePath)) return false;
    const normalized = String(filePath || '');
    return ignoredPatterns.some((pattern) => pattern.test(normalized));
  };
}

function emit(payload) {
  if (typeof process.send === 'function') {
    process.send(payload);
  }
}

function watchedPathCount(watcher) {
  try {
    const watched = typeof watcher.getWatched === 'function' ? watcher.getWatched() : {};
    return Object.values(watched || {}).reduce((total, entries) => (
      total + (Array.isArray(entries) ? entries.length : 0)
    ), 0);
  } catch (_) {
    return null;
  }
}

function watcherFreshnessPayload(watcherName, watcher, ready, reason) {
  return {
    type: 'heartbeat',
    watcherName,
    pid: process.pid,
    ready: ready === true,
    reason,
    watchedPathCount: watchedPathCount(watcher),
    timestamp: new Date().toISOString(),
  };
}

function buildWatcherConfigs() {
  const workspaceTargetPath = getWorkspaceWatchTargets();
  return {
    workspace: {
      targetPath: workspaceTargetPath,
      options: {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: WORKSPACE_WATCH_POLL_INTERVAL_MS,
        ignored: createWorkspaceIgnoredMatcher(workspaceTargetPath),
      },
    },
    trigger: {
      targetPath: TRIGGER_PATHS,
      options: {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 1000,
        binaryInterval: 1000,
        awaitWriteFinish: false,
        atomic: false,
        ignored: [
          /\.tmp$/,
          /~$/,
        ],
      },
    },
    message: {
      targetPath: MESSAGE_QUEUE_DIR,
      options: {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 1000,
      },
    },
  };
}

function registerWatcher(watcherName, cfg, activeWatchers = []) {
  const watcher = chokidar.watch(cfg.targetPath, cfg.options);
  let ready = false;
  const isAllowedWorkspacePath = watcherName === 'workspace'
    ? createAllowedWorkspacePathMatcher(Array.isArray(cfg.targetPath) ? cfg.targetPath : [cfg.targetPath])
    : null;

  function emitFileEvent(type, filePath) {
    if (watcherName === 'workspace' && isRuntimeNoopPath(filePath) && !isAllowedWorkspacePath(filePath)) return;
    emit({ type, path: filePath, watcherName });
  }

  function emitHeartbeat(reason) {
    emit(watcherFreshnessPayload(watcherName, watcher, ready, reason));
  }

  watcher.on('add', (filePath) => emitFileEvent('add', filePath));
  watcher.on('change', (filePath) => emitFileEvent('change', filePath));
  watcher.on('unlink', (filePath) => emitFileEvent('unlink', filePath));
  watcher.on('ready', () => {
    ready = true;
    emit({
      type: 'ready',
      watcherName,
      pid: process.pid,
      watchedPathCount: watchedPathCount(watcher),
      timestamp: new Date().toISOString(),
    });
    emitHeartbeat('ready');
  });
  watcher.on('error', (err) => emit({
    type: 'error',
    watcherName,
    error: err?.message || String(err),
  }));

  emitHeartbeat('registered');
  const heartbeatTimer = setInterval(() => emitHeartbeat('interval'), WATCHER_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer?.unref?.();
  activeWatchers.push({ watcher, heartbeatTimer });
  return watcher;
}

function main() {
  const watcherConfigs = buildWatcherConfigs();
  const requestedWatcherName = String(process.env.SQUIDRUN_WATCHER_NAME || 'all').toLowerCase();
  const watcherNames = requestedWatcherName === 'all'
    ? Object.keys(watcherConfigs)
    : [requestedWatcherName].filter((name) => watcherConfigs[name]);

  if (watcherNames.length === 0) {
    emit({
      type: 'error',
      watcherName: requestedWatcherName,
      error: `Unknown watcher name: ${requestedWatcherName}`,
    });
    process.exit(1);
  }

  const activeWatchers = [];
  let shuttingDown = false;

  async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    await Promise.all(activeWatchers.map(async (entry) => {
      if (entry.heartbeatTimer) {
        clearInterval(entry.heartbeatTimer);
      }
      try {
        await entry.watcher.close();
      } catch {
        // Best effort close only.
      }
    }));

    process.exit(exitCode);
  }

  for (const watcherName of watcherNames) {
    registerWatcher(watcherName, watcherConfigs[watcherName], activeWatchers);
  }

  process.on('disconnect', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
}

if (require.main === module) {
  main();
}

module.exports = {
  WATCHER_HEARTBEAT_INTERVAL_MS,
  buildWatcherConfigs,
  createAllowedWorkspacePathMatcher,
  createWorkspaceIgnoredMatcher,
  getDefaultWorkspaceWatchTargets,
  getWorkspaceWatchTargets,
  getTriggerWatchPaths,
  isRuntimeNoopPath,
  main,
  registerWatcher,
  watcherFreshnessPayload,
};
