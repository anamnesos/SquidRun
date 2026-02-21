/**
 * File watcher worker process.
 * Emits file events to parent process only (no business logic).
 */

const path = require('path');
const chokidar = require('chokidar');
const { WORKSPACE_PATH, getCoordRoots } = require('../config');

function getCoordWatchRoots() {
  if (typeof getCoordRoots === 'function') {
    const roots = getCoordRoots({ includeLegacy: false, includeMissing: false });
    if (Array.isArray(roots) && roots.length > 0) {
      return roots;
    }
  }
  return [WORKSPACE_PATH];
}

const TRIGGER_PATHS = Array.from(new Set(
  getCoordWatchRoots().map((root) => path.join(root, 'triggers'))
));
const MESSAGE_QUEUE_DIR = path.join(WORKSPACE_PATH, 'messages');
const WORKSPACE_WATCH_POLL_INTERVAL_MS = 5000;

function emit(payload) {
  if (typeof process.send === 'function') {
    process.send(payload);
  }
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
          /state\.json$/,
          /triggers[\\/]/,
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

function registerWatcher(watcherName) {
  const cfg = watcherConfigs[watcherName];
  const watcher = chokidar.watch(cfg.targetPath, cfg.options);

  watcher.on('add', (filePath) => emit({ type: 'add', path: filePath, watcherName }));
  watcher.on('change', (filePath) => emit({ type: 'change', path: filePath, watcherName }));
  watcher.on('unlink', (filePath) => emit({ type: 'unlink', path: filePath, watcherName }));
  watcher.on('error', (err) => emit({
    type: 'error',
    watcherName,
    error: err?.message || String(err),
  }));

  activeWatchers.push(watcher);
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  await Promise.all(activeWatchers.map(async (watcher) => {
    try {
      await watcher.close();
    } catch {
      // Best effort close only.
    }
  }));

  process.exit(exitCode);
}

for (const watcherName of watcherNames) {
  registerWatcher(watcherName);
}

process.on('disconnect', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
