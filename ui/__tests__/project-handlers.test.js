/**
 * Project IPC Handler Tests
 * Target: Full coverage of project-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');
const path = require('path');
const { getProjectRoot, getSquidrunRoot, setProjectRoot, resetProjectRoot } = require('../config');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock('../modules/ipc/evidence-ledger-runtime', () => ({
  initializeEvidenceLedgerRuntime: jest.fn(() => ({ ok: true, status: { driver: 'in-process' } })),
}));
jest.mock('../modules/team-memory/runtime', () => ({
  initializeTeamMemoryRuntime: jest.fn(() => ({ ok: true, status: { driver: 'in-process' } })),
}));

const fs = require('fs');
const { initializeEvidenceLedgerRuntime } = require('../modules/ipc/evidence-ledger-runtime');
const { initializeTeamMemoryRuntime } = require('../modules/team-memory/runtime');
const { registerProjectHandlers } = require('../modules/ipc/project-handlers');

describe('Project Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    jest.clearAllMocks();
    resetProjectRoot();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.PANE_IDS = ['1', '2', '3'];
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    // Mock dialog
    ctx.dialog = {
      showOpenDialog: jest.fn().mockResolvedValue({
        canceled: false,
        filePaths: ['/selected/project'],
      }),
    };

    // Set up watcher
    ctx.watcher.readState = jest.fn(() => ({ project: null }));
    ctx.watcher.writeState = jest.fn();
    ctx.watcher.transition = jest.fn();
    ctx.watcher.States = { PROJECT_SELECTED: 'project_selected' };

    deps = {
      loadSettings: jest.fn(() => ({ recentProjects: [], paneProjects: {} })),
      saveSettings: jest.fn(),
      readAppStatus: jest.fn(() => ({ session: 321 })),
      getSessionId: jest.fn(() => 'app-session-321'),
      startRuntimeLifecycle: jest.fn(async () => ({ ok: true })),
      stopRuntimeLifecycle: jest.fn(async () => ({ ok: true })),
    };

    fs.existsSync.mockReturnValue(true);

    registerProjectHandlers(ctx, deps);
    initializeEvidenceLedgerRuntime.mockClear();
    initializeTeamMemoryRuntime.mockClear();
  });

  afterEach(() => {
    resetProjectRoot();
    jest.clearAllMocks();
  });

  describe('startup operating mode sync', () => {
    test('resets stale project root when startup mode is developer', () => {
      setProjectRoot('/stale/project-root');
      expect(path.resolve(getProjectRoot())).toBe(path.resolve('/stale/project-root'));

      const startupHarness = createIpcHarness();
      const startupCtx = createDefaultContext({ ipcMain: startupHarness.ipcMain });
      startupCtx.PANE_IDS = ['1', '2', '3'];
      startupCtx.currentSettings = {
        operatingMode: 'developer',
      };
      startupCtx.watcher.readState = jest.fn(() => ({ project: '/external/project' }));

      const startupDeps = {
        loadSettings: jest.fn(() => ({ recentProjects: [], paneProjects: {} })),
        saveSettings: jest.fn(),
        readAppStatus: jest.fn(() => ({ session: 159 })),
        getSessionId: jest.fn(() => 'app-session-159'),
      };

      registerProjectHandlers(startupCtx, startupDeps);

      expect(path.resolve(getProjectRoot())).toBe(path.resolve(getSquidrunRoot()));
      const normalizePath = (value) => String(value || '').replace(/\\/g, '/');
      const expectedProjectRoot = path.resolve(getSquidrunRoot()).replace(/\\/g, '/');
      const linkWrite = fs.writeFileSync.mock.calls.find(([filePath]) =>
        normalizePath(filePath).endsWith(`${expectedProjectRoot}/.squidrun/link.json.tmp`)
      );
      expect(linkWrite).toBeDefined();
      expect(JSON.parse(linkWrite[1])).toEqual(expect.objectContaining({
        workspace: expectedProjectRoot,
        session_id: 'app-session-159',
      }));
      expect(startupCtx.mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'project-warning',
        expect.anything()
      );
    });

    test('writes bootstrap files when startup project path is present', () => {
      const startupHarness = createIpcHarness();
      const startupCtx = createDefaultContext({ ipcMain: startupHarness.ipcMain });
      startupCtx.PANE_IDS = ['1', '2', '3'];
      startupCtx.currentSettings = {
        operatingMode: 'project',
      };
      startupCtx.watcher.readState = jest.fn(() => ({ project: '/startup/project' }));

      const startupDeps = {
        loadSettings: jest.fn(() => ({ recentProjects: [], paneProjects: {} })),
        saveSettings: jest.fn(),
        readAppStatus: jest.fn(() => ({ session: 186 })),
        getSessionId: jest.fn(() => 'app-session-186'),
      };

      registerProjectHandlers(startupCtx, startupDeps);

      const normalizePath = (value) => String(value || '').replace(/\\/g, '/');
      const linkWrite = fs.writeFileSync.mock.calls.find(([filePath]) =>
        normalizePath(filePath).endsWith('/startup/project/.squidrun/link.json.tmp')
      );
      const readmeWrite = fs.writeFileSync.mock.calls.find(([filePath]) =>
        normalizePath(filePath).endsWith('/startup/project/.squidrun/README-FIRST.md.tmp')
      );

      expect(linkWrite).toBeDefined();
      expect(readmeWrite).toBeDefined();
      expect(JSON.parse(linkWrite[1])).toEqual(expect.objectContaining({
        workspace: path.resolve('/startup/project').replace(/\\/g, '/'),
        session_id: 'app-session-186',
      }));
    });
  });

  describe('select-project', () => {
    test('opens dialog and selects project', async () => {
      const result = await harness.invoke('select-project');

      expect(result.success).toBe(true);
      expect(result.path).toBe('/selected/project');
      expect(result.name).toBe('project');
      expect(ctx.watcher.writeState).toHaveBeenCalled();
      expect(ctx.watcher.transition).toHaveBeenCalledWith('project_selected');
      expect(result.bootstrap).toBeDefined();
      expect(result.bootstrap.session_id).toBe('app-session-321');
    });

    test('writes bootstrap link.json and README-FIRST.md', async () => {
      await harness.invoke('select-project');

      const normalizePath = (value) => String(value || '').replace(/\\/g, '/');
      const linkWrite = fs.writeFileSync.mock.calls.find(([filePath]) =>
        normalizePath(filePath).endsWith('/selected/project/.squidrun/link.json.tmp')
      );
      const readmeWrite = fs.writeFileSync.mock.calls.find(([filePath]) =>
        normalizePath(filePath).endsWith('/selected/project/.squidrun/README-FIRST.md.tmp')
      );

      expect(linkWrite).toBeDefined();
      expect(readmeWrite).toBeDefined();

      const linkPayload = JSON.parse(linkWrite[1]);
      expect(linkPayload).toEqual(expect.objectContaining({
        squidrun_root: expect.any(String),
        workspace: path.resolve('/selected/project').replace(/\\/g, '/'),
        session_id: 'app-session-321',
        version: 1,
      }));
      expect(linkPayload.comms.hm_send).toContain('ui/scripts/hm-send.js');
      expect(linkPayload.role_targets).toEqual({
        architect: 'architect',
        builder: 'builder',
        oracle: 'oracle',
      });
      expect(readmeWrite[1]).toContain('Connectivity Test');
      expect(readmeWrite[1]).toContain('node ');
      expect(readmeWrite[1]).toContain('hm-send.js architect');
    });

    test('returns error when bootstrap write fails', async () => {
      fs.writeFileSync.mockImplementationOnce(() => {
        throw new Error('Disk full');
      });

      const result = await harness.invoke('select-project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to initialize .squidrun bootstrap');
      expect(ctx.watcher.writeState).not.toHaveBeenCalled();
      expect(ctx.watcher.transition).not.toHaveBeenCalled();
    });

    test('handles dialog cancel', async () => {
      ctx.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

      const result = await harness.invoke('select-project');

      expect(result.success).toBe(false);
      expect(result.canceled).toBe(true);
    });

    test('adds to recent projects', async () => {
      deps.loadSettings.mockReturnValue({ recentProjects: [] });

      await harness.invoke('select-project');

      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.recentProjects.length).toBe(1);
      expect(savedSettings.recentProjects[0].path).toBe('/selected/project');
    });

    test('rebinds evidence/team memory runtimes after selecting project', async () => {
      await harness.invoke('select-project');

      expect(initializeEvidenceLedgerRuntime).toHaveBeenCalledWith({ forceRuntimeRecreate: true });
      expect(initializeTeamMemoryRuntime).toHaveBeenCalledWith({ forceRuntimeRecreate: true });
    });

    test('moves existing project to front', async () => {
      deps.loadSettings.mockReturnValue({
        recentProjects: [
          { path: '/other/project', lastOpened: '2026-01-01' },
          { path: '/selected/project', lastOpened: '2025-01-01' },
        ],
      });

      await harness.invoke('select-project');

      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.recentProjects[0].path).toBe('/selected/project');
    });

    test('sends project-changed event', async () => {
      await harness.invoke('select-project');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('project-changed', '/selected/project');
    });
  });

  describe('get-project', () => {
    test('returns current project', async () => {
      ctx.watcher.readState.mockReturnValue({ project: '/current/project' });

      const result = await harness.invoke('get-project');

      expect(result).toBe('/current/project');
    });

    test('returns null when no project', async () => {
      ctx.watcher.readState.mockReturnValue({});

      const result = await harness.invoke('get-project');

      expect(result).toBeNull();
    });
  });

  describe('get-recent-projects', () => {
    test('returns recent projects', async () => {
      deps.loadSettings.mockReturnValue({
        recentProjects: [
          { path: '/proj1', name: 'proj1' },
          { path: '/proj2', name: 'proj2' },
        ],
      });

      const result = await harness.invoke('get-recent-projects');

      expect(result.success).toBe(true);
      expect(result.projects.length).toBe(2);
    });

    test('filters out non-existent projects', async () => {
      fs.existsSync.mockImplementation(path => path !== '/missing');
      deps.loadSettings.mockReturnValue({
        recentProjects: [
          { path: '/exists', name: 'exists' },
          { path: '/missing', name: 'missing' },
        ],
      });

      const result = await harness.invoke('get-recent-projects');

      expect(result.projects.length).toBe(1);
      expect(deps.saveSettings).toHaveBeenCalled();
    });

    test('returns empty array when no settings', async () => {
      deps.loadSettings.mockReturnValue({});

      const result = await harness.invoke('get-recent-projects');

      expect(result.projects).toEqual([]);
    });

    test('handles fs.existsSync throwing', async () => {
      fs.existsSync.mockImplementation(path => {
        if (path === '/throws') throw new Error('Access denied');
        return true;
      });
      deps.loadSettings.mockReturnValue({
        recentProjects: [
          { path: '/throws', name: 'throws' },
          { path: '/valid', name: 'valid' },
        ],
      });

      const result = await harness.invoke('get-recent-projects');

      expect(result.projects.length).toBe(1);
      expect(result.projects[0].path).toBe('/valid');
    });
  });

  describe('add-recent-project', () => {
    test('adds project to recent list', async () => {
      const result = await harness.invoke('add-recent-project', '/new/project');

      expect(result.success).toBe(true);
      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.recentProjects[0].path).toBe('/new/project');
    });

    test('returns error for invalid path', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('add-recent-project', '/invalid');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    test('limits to 10 recent projects', async () => {
      deps.loadSettings.mockReturnValue({
        recentProjects: Array.from({ length: 12 }, (_, i) => ({ path: `/proj${i}` })),
      });

      await harness.invoke('add-recent-project', '/new');

      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.recentProjects.length).toBe(10);
    });
  });

  describe('remove-recent-project', () => {
    test('removes project from list', async () => {
      deps.loadSettings.mockReturnValue({
        recentProjects: [
          { path: '/keep' },
          { path: '/remove' },
        ],
      });

      const result = await harness.invoke('remove-recent-project', '/remove');

      expect(result.success).toBe(true);
      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.recentProjects.length).toBe(1);
    });
  });

  describe('clear-recent-projects', () => {
    test('clears all recent projects', async () => {
      deps.loadSettings.mockReturnValue({
        recentProjects: [{ path: '/proj' }],
      });

      const result = await harness.invoke('clear-recent-projects');

      expect(result.success).toBe(true);
      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.recentProjects).toEqual([]);
    });
  });

  describe('switch-project', () => {
    test('switches to specified project', async () => {
      const result = await harness.invoke('switch-project', '/new/project');

      expect(result.success).toBe(true);
      expect(result.path).toBe('/new/project');
      expect(ctx.watcher.writeState).toHaveBeenCalled();
      expect(ctx.watcher.transition).toHaveBeenCalled();
      expect(result.bootstrap).toBeDefined();
      expect(result.bootstrap.session_id).toBe('app-session-321');
    });

    test('returns error for non-existent path', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('switch-project', '/missing');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    test('sends project-changed event', async () => {
      await harness.invoke('switch-project', '/project');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('project-changed', '/project');
    });

    test('rebinds evidence/team memory runtimes after switching project', async () => {
      await harness.invoke('switch-project', '/project');

      expect(initializeEvidenceLedgerRuntime).toHaveBeenCalledWith({ forceRuntimeRecreate: true });
      expect(initializeTeamMemoryRuntime).toHaveBeenCalledWith({ forceRuntimeRecreate: true });
    });

    test('runs stop -> start runtime lifecycle around project rebind', async () => {
      const result = await harness.invoke('switch-project', '/project');

      expect(result.success).toBe(true);
      expect(deps.stopRuntimeLifecycle).toHaveBeenCalledTimes(1);
      expect(deps.startRuntimeLifecycle).toHaveBeenCalledTimes(1);
      expect(deps.stopRuntimeLifecycle.mock.calls[0][0]).toContain(':stop');
      expect(deps.startRuntimeLifecycle.mock.calls[0][0]).toContain(':start');
    });

    test('returns lifecycle failure when stop lifecycle fails', async () => {
      deps.stopRuntimeLifecycle.mockImplementationOnce(async () => ({ ok: false, reason: 'busy' }));

      const result = await harness.invoke('switch-project', '/project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('runtime_lifecycle_failed');
      expect(result.error).toContain('busy');
    });

    test('queues concurrent project switches without overlapping lifecycle calls', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const settleAfterTick = async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return { ok: true };
      };

      deps.stopRuntimeLifecycle.mockImplementation(settleAfterTick);
      deps.startRuntimeLifecycle.mockImplementation(settleAfterTick);

      const first = harness.invoke('switch-project', '/project-a');
      const second = harness.invoke('switch-project', '/project-b');
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(maxInFlight).toBe(1);
      expect(deps.stopRuntimeLifecycle).toHaveBeenCalledTimes(2);
      expect(deps.startRuntimeLifecycle).toHaveBeenCalledTimes(2);
    });
  });

  describe('set-pane-project', () => {
    test('assigns project to pane', async () => {
      const result = await harness.invoke('set-pane-project', '1', '/pane/project');

      expect(result.success).toBe(true);
      expect(result.paneId).toBe('1');
      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.paneProjects['1']).toBe('/pane/project');
    });

    test('returns error for invalid pane ID', async () => {
      const result = await harness.invoke('set-pane-project', '99', '/project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid pane');
    });

    test('returns error for non-existent project', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('set-pane-project', '1', '/missing');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    test('allows null to clear assignment', async () => {
      const result = await harness.invoke('set-pane-project', '1', null);

      expect(result.success).toBe(true);
    });

    test('sends pane-project-changed event', async () => {
      await harness.invoke('set-pane-project', '2', '/project');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('pane-project-changed', {
        paneId: '2',
        projectPath: '/project',
      });
    });

    test('initializes paneProjects when missing from settings', async () => {
      deps.loadSettings.mockReturnValue({ recentProjects: [] }); // No paneProjects

      const result = await harness.invoke('set-pane-project', '1', '/project');

      expect(result.success).toBe(true);
      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.paneProjects).toBeDefined();
      expect(savedSettings.paneProjects['1']).toBe('/project');
    });
  });

  describe('select-pane-project', () => {
    test('opens dialog and assigns to pane', async () => {
      const result = await harness.invoke('select-pane-project', '2');

      expect(result.success).toBe(true);
      expect(result.paneId).toBe('2');
      expect(result.path).toBe('/selected/project');
    });

    test('returns error for invalid pane ID', async () => {
      const result = await harness.invoke('select-pane-project', '99');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid pane');
    });

    test('handles dialog cancel', async () => {
      ctx.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

      const result = await harness.invoke('select-pane-project', '1');

      expect(result.success).toBe(false);
      expect(result.canceled).toBe(true);
    });

    test('returns error when selected path does not exist', async () => {
      ctx.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/selected/nonexistent'],
      });
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('select-pane-project', '1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });
  });

  describe('get-pane-project', () => {
    test('returns pane project', async () => {
      deps.loadSettings.mockReturnValue({
        paneProjects: { '1': '/pane1/project' },
      });

      const result = await harness.invoke('get-pane-project', '1');

      expect(result.success).toBe(true);
      expect(result.projectPath).toBe('/pane1/project');
    });

    test('returns null when no assignment', async () => {
      deps.loadSettings.mockReturnValue({ paneProjects: {} });

      const result = await harness.invoke('get-pane-project', '1');

      expect(result.projectPath).toBeNull();
    });
  });

  describe('get-all-pane-projects', () => {
    test('returns all pane projects', async () => {
      deps.loadSettings.mockReturnValue({
        paneProjects: { '1': '/proj1', '2': '/proj2' },
      });

      const result = await harness.invoke('get-all-pane-projects');

      expect(result.success).toBe(true);
      expect(result.paneProjects['1']).toBe('/proj1');
    });

    test('returns defaults when no paneProjects', async () => {
      deps.loadSettings.mockReturnValue({});

      const result = await harness.invoke('get-all-pane-projects');

      expect(result.paneProjects).toEqual({
        '1': null, '2': null, '3': null,
      });
    });
  });

  describe('clear-pane-projects', () => {
    test('clears all pane projects', async () => {
      deps.loadSettings.mockReturnValue({
        paneProjects: { '1': '/proj1' },
      });

      const result = await harness.invoke('clear-pane-projects');

      expect(result.success).toBe(true);
      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(Object.values(savedSettings.paneProjects).every(v => v === null)).toBe(true);
    });

    test('sends pane-projects-cleared event', async () => {
      await harness.invoke('clear-pane-projects');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('pane-projects-cleared');
    });
  });
});
