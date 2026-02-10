/**
 * IPC integration harness + smoke tests
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createIpcHarness,
  createDefaultContext,
  createDepsMock,
} = require('./helpers/ipc-harness');

function listIpcModules() {
  const ipcDir = path.join(__dirname, '..', 'modules', 'ipc');
  // Exclude index, state, and helper modules (non-handler modules)
  const ignore = new Set(['index.js', 'ipc-state.js', 'handler-registry.js', 'background-processes.js']);
  return fs
    .readdirSync(ipcDir)
    .filter(file => file.endsWith('.js') && !ignore.has(file))
    .map(file => ({ file, fullPath: path.join(ipcDir, file) }));
}

describe('IPC handler registration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('all IPC modules register at least one handler', () => {
    const { ipcMain } = createIpcHarness();
    const ctx = createDefaultContext({ ipcMain });
    const deps = createDepsMock();

    const results = [];
    for (const { file } of listIpcModules()) {
      const mod = require(`../modules/ipc/${file}`);
      const registerFns = Object.values(mod).filter(
        fn => typeof fn === 'function' && fn.name.startsWith('register')
      );

      expect(registerFns.length).toBeGreaterThan(0);

      const beforeHandles = ipcMain.handle.mock.calls.length;
      const beforeOn = ipcMain.on.mock.calls.length;

      for (const registerFn of registerFns) {
        registerFn(ctx, deps);
      }

      const added =
        (ipcMain.handle.mock.calls.length - beforeHandles)
        + (ipcMain.on.mock.calls.length - beforeOn);
      results.push({ file, added });
    }

    if (ctx.perfAuditInterval) {
      clearInterval(ctx.perfAuditInterval);
      ctx.perfAuditInterval = null;
    }

    const missing = results.filter(entry => entry.added === 0);
    expect(missing).toEqual([]);
  });

  test('all IPC register functions expose unregister cleanup hooks', () => {
    for (const { file } of listIpcModules()) {
      const mod = require(`../modules/ipc/${file}`);
      const registerFns = Object.values(mod).filter(
        fn => typeof fn === 'function' && fn.name.startsWith('register')
      );

      expect(registerFns.length).toBeGreaterThan(0);
      for (const registerFn of registerFns) {
        expect(typeof registerFn.unregister).toBe('function');
      }
    }
  });
});

describe('IPC handler behavior samples', () => {
  test('settings handlers toggle watcher when watcherEnabled changes', async () => {
    const { ipcMain, invoke } = createIpcHarness();
    const ctx = createDefaultContext({ ipcMain });
    const loadSettings = jest.fn(() => ({ watcherEnabled: false }));
    const saveSettings = jest.fn();
    const { registerSettingsHandlers } = require('../modules/ipc/settings-handlers');

    registerSettingsHandlers(ctx, { loadSettings, saveSettings });

    const resultOn = await invoke('set-setting', 'watcherEnabled', true);
    expect(saveSettings).toHaveBeenCalled();
    expect(ctx.watcher.startWatcher).toHaveBeenCalled();
    expect(resultOn.watcherEnabled).toBe(true);

    const resultOff = await invoke('set-setting', 'watcherEnabled', false);
    expect(ctx.watcher.stopWatcher).toHaveBeenCalled();
    expect(resultOff.watcherEnabled).toBe(false);
  });

  test('shared context handlers read/write roundtrip', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-shared-'));
    const sharedPath = path.join(tempDir, 'shared_context.md');

    const { ipcMain, invoke } = createIpcHarness();
    const ctx = createDefaultContext({ ipcMain, SHARED_CONTEXT_PATH: sharedPath });
    const { registerSharedContextHandlers } = require('../modules/ipc/shared-context-handlers');

    registerSharedContextHandlers(ctx);

    const writeResult = await invoke('write-shared-context', 'hello world');
    expect(writeResult.success).toBe(true);

    const readResult = await invoke('read-shared-context');
    expect(readResult.success).toBe(true);
    expect(readResult.content).toBe('hello world');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('agent claims handlers delegate to watcher', async () => {
    const { ipcMain, invoke } = createIpcHarness();
    const ctx = createDefaultContext({ ipcMain });
    const { registerAgentClaimsHandlers } = require('../modules/ipc/agent-claims-handlers');

    registerAgentClaimsHandlers(ctx);

    await invoke('claim-agent', '4', 'TASK-1', 'Testing');
    expect(ctx.watcher.claimAgent).toHaveBeenCalledWith('4', 'TASK-1', 'Testing');

    await invoke('release-agent', '4');
    expect(ctx.watcher.releaseAgent).toHaveBeenCalledWith('4');

    await invoke('get-claims');
    expect(ctx.watcher.getClaims).toHaveBeenCalled();

    await invoke('clear-claims');
    expect(ctx.watcher.clearClaims).toHaveBeenCalled();
  });
});
