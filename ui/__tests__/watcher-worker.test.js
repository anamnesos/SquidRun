/**
 * Tests for modules/watcher-worker.js path configuration.
 */

const { EventEmitter } = require('events');
const path = require('path');

function loadWorkerWithConfig(configMock) {
  jest.resetModules();
  jest.doMock('chokidar', () => ({ watch: jest.fn() }));
  jest.doMock('../config', () => configMock);
  return require('../modules/watcher-worker');
}

describe('watcher-worker.js', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('trigger watcher uses profile-namespaced coord path', () => {
    const workspacePath = path.join('D:', 'tmp', 'squidrun-test');
    const triggerPath = path.join(workspacePath, '.squidrun', 'triggers-client-profile');
    const worker = loadWorkerWithConfig({
      WORKSPACE_PATH: workspacePath,
      resolveCoordPath: (relPath, options = {}) => {
        expect(relPath).toBe('triggers');
        expect(options).toEqual(expect.objectContaining({ forWrite: true }));
        return triggerPath;
      },
      getCoordRoots: () => [path.join(workspacePath, '.squidrun')],
    });

    expect(worker.getTriggerWatchPaths()).toEqual([path.resolve(triggerPath)]);
    expect(worker.buildWatcherConfigs().trigger.targetPath).toEqual([path.resolve(triggerPath)]);
    expect(worker.buildWatcherConfigs().trigger.targetPath).not.toContain(path.join(workspacePath, '.squidrun', 'triggers'));
  });

  test('workspace watcher ignores shared and profile trigger folders', () => {
    const workspacePath = path.join('D:', 'tmp', 'squidrun-test');
    const worker = loadWorkerWithConfig({
      WORKSPACE_PATH: workspacePath,
      resolveCoordPath: () => path.join(workspacePath, '.squidrun', 'triggers-client-profile'),
      getCoordRoots: () => [path.join(workspacePath, '.squidrun')],
    });
    const ignored = worker.buildWatcherConfigs().workspace.options.ignored;

    expect(ignored.some((pattern) => pattern.test('D:/repo/.squidrun/triggers/architect.txt'))).toBe(true);
    expect(ignored.some((pattern) => pattern.test('D:/repo/.squidrun/triggers-client-profile/architect.txt'))).toBe(true);
  });

  test('workspace watcher ignores runtime files that only create log churn', () => {
    const workspacePath = path.join('D:', 'tmp', 'squidrun-test');
    const worker = loadWorkerWithConfig({
      WORKSPACE_PATH: workspacePath,
      resolveCoordPath: () => path.join(workspacePath, '.squidrun', 'triggers-client-profile'),
      getCoordRoots: () => [path.join(workspacePath, '.squidrun')],
    });
    const ignored = worker.buildWatcherConfigs().workspace.options.ignored;

    expect(ignored.some((pattern) => pattern.test('D:/repo/.squidrun/logs/app.log'))).toBe(true);
    expect(ignored.some((pattern) => pattern.test('D:/repo/.squidrun/runtime/daemon.log'))).toBe(true);
    expect(ignored.some((pattern) => pattern.test('D:/repo/.squidrun/runtime-eunbyeol/session.md'))).toBe(true);
    expect(ignored.some((pattern) => pattern.test('D:/repo/.squidrun/perf-profile.json'))).toBe(true);
    expect(worker.isRuntimeNoopPath('D:/repo/.squidrun/logs/app.log')).toBe(true);
    expect(worker.isRuntimeNoopPath('D:/repo/.squidrun/perf-profile.json')).toBe(true);
    expect(worker.isRuntimeNoopPath('D:/repo/workspace/plan.md')).toBe(false);
  });

  test('registered chokidar watcher emits ready and heartbeat freshness messages', () => {
    jest.useFakeTimers();
    const workspacePath = path.join('D:', 'tmp', 'squidrun-test');
    const triggerPath = path.join(workspacePath, '.squidrun', 'triggers-client-profile');
    const watcherEmitter = new EventEmitter();
    watcherEmitter.getWatched = jest.fn(() => ({
      [triggerPath]: ['architect.txt'],
    }));
    watcherEmitter.close = jest.fn(() => Promise.resolve());
    const chokidarMock = {
      watch: jest.fn(() => watcherEmitter),
    };
    jest.resetModules();
    jest.doMock('chokidar', () => chokidarMock);
    jest.doMock('../config', () => ({
      WORKSPACE_PATH: workspacePath,
      resolveCoordPath: () => triggerPath,
      getCoordRoots: () => [path.join(workspacePath, '.squidrun')],
    }));

    const originalSend = process.send;
    const hadProcessSend = Object.prototype.hasOwnProperty.call(process, 'send');
    const sent = [];
    process.send = jest.fn((payload) => sent.push(payload));

    try {
      const worker = require('../modules/watcher-worker');
      const activeWatchers = [];
      worker.registerWatcher('trigger', worker.buildWatcherConfigs().trigger, activeWatchers);

      expect(chokidarMock.watch).toHaveBeenCalledWith(
        [path.resolve(triggerPath)],
        expect.objectContaining({
          persistent: true,
          usePolling: true,
        })
      );
      expect(sent).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'heartbeat',
          watcherName: 'trigger',
          ready: false,
          reason: 'registered',
          watchedPathCount: 1,
        }),
      ]));

      watcherEmitter.emit('ready');
      expect(sent).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'ready',
          watcherName: 'trigger',
          watchedPathCount: 1,
        }),
        expect.objectContaining({
          type: 'heartbeat',
          watcherName: 'trigger',
          ready: true,
          reason: 'ready',
          watchedPathCount: 1,
        }),
      ]));

      jest.advanceTimersByTime(worker.WATCHER_HEARTBEAT_INTERVAL_MS);
      expect(sent).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'heartbeat',
          watcherName: 'trigger',
          ready: true,
          reason: 'interval',
          watchedPathCount: 1,
        }),
      ]));

      for (const entry of activeWatchers) {
        clearInterval(entry.heartbeatTimer);
      }
    } finally {
      if (hadProcessSend) process.send = originalSend;
      else delete process.send;
    }
  });
});
