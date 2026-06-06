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
const RUNTIME_NOOP_FILE_RE = /[\\/](?:logs(?:-[^\\/]+)?|runtime(?:-[^\\/]+)?)[\\/](?:app\.log|daemon\.log|supervisor\.log|supervisor-status\.json|session\.md|last-session\.md|user-input-shadow\.jsonl|bus-reliability-trace\.jsonl|team-memory-pattern-spool\.jsonl|evidence-ledger\.db-(?:wal|shm))$/;
const ROOT_RUNTIME_NOOP_FILE_RE = /[\\/]\.squidrun[\\/](?:app-status\.json|perf-profile\.json|supervisor-status\.json|session\.md|last-session\.md)$/;

function isRuntimeNoopPath(filePath = '') {
  const normalized = String(filePath || '');
  return RUNTIME_NOOP_FILE_RE.test(normalized) || ROOT_RUNTIME_NOOP_FILE_RE.test(normalized);
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
  return {
    workspace: {
      targetPath: WORKSPACE_PATH,
      options: {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: WORKSPACE_WATCH_POLL_INTERVAL_MS,
        ignored: [
          /node_modules[\\/]/,
          /\.git[\\/]/,
          /instances[\\/]/,
          /backups[\\/]/,
          /context-snapshots[\\/]/,
          /logs[\\/]/,
          RUNTIME_NOOP_FILE_RE,
          ROOT_RUNTIME_NOOP_FILE_RE,
          /state\.json$/,
          /triggers(?:-[^\\/]+)?[\\/]/,
        ],
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

  function emitFileEvent(type, filePath) {
    if (watcherName === 'workspace' && isRuntimeNoopPath(filePath)) return;
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
  getTriggerWatchPaths,
  isRuntimeNoopPath,
  main,
  registerWatcher,
  watcherFreshnessPayload,
};
