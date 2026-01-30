/**
 * Multi-Project Dashboard IPC Handler Tests
 * Target: Full coverage of multi-project-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Mock the dashboard module
const mockDashboard = {
  getAllProjects: jest.fn(),
  getProject: jest.fn(),
  getActiveProject: jest.fn(),
  registerProject: jest.fn(),
  unregisterProject: jest.fn(),
  switchProject: jest.fn(),
  getAggregatedMetrics: jest.fn(),
  getProjectHealth: jest.fn(),
  compareProjects: jest.fn(),
  recordActivity: jest.fn(),
  getActivityTimeline: jest.fn(),
};

jest.mock('../modules/analysis/multi-project-dashboard', () => ({
  getMultiProjectDashboard: jest.fn(() => mockDashboard),
}));

const fs = require('fs');
const log = require('../modules/logger');
const { registerMultiProjectHandlers } = require('../modules/ipc/multi-project-handlers');

describe('Multi-Project Handlers', () => {
  let harness;
  let ctx;
  let deps;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    // Mock dialog
    ctx.dialog = {
      showSaveDialog: jest.fn(),
      showOpenDialog: jest.fn(),
    };

    // Mock watcher
    ctx.watcher = {
      readState: jest.fn(() => ({})),
      writeState: jest.fn(),
      transition: jest.fn(),
      States: { PROJECT_SELECTED: 'project_selected' },
    };

    deps = {
      loadSettings: jest.fn(() => ({ recentProjects: [] })),
      saveSettings: jest.fn(),
    };

    fs.existsSync.mockReturnValue(true);

    // Reset mock dashboard
    mockDashboard.getAllProjects.mockReturnValue([]);
    mockDashboard.getProject.mockReturnValue(null);
    mockDashboard.getActiveProject.mockReturnValue(null);
    mockDashboard.registerProject.mockReturnValue({ id: 'proj-1', name: 'Test' });
    mockDashboard.unregisterProject.mockReturnValue(true);
    mockDashboard.switchProject.mockReturnValue({ success: true, previousId: null });
    mockDashboard.getAggregatedMetrics.mockReturnValue({});
    mockDashboard.getProjectHealth.mockReturnValue({ score: 80 });
    mockDashboard.compareProjects.mockReturnValue({});
    mockDashboard.getActivityTimeline.mockReturnValue([]);

    registerMultiProjectHandlers(ctx, deps);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('multi-project-get-all', () => {
    test('returns all projects', async () => {
      mockDashboard.getAllProjects.mockReturnValue([
        { id: 'proj-1', name: 'Project 1' },
        { id: 'proj-2', name: 'Project 2' },
      ]);
      mockDashboard.getActiveProject.mockReturnValue('proj-1');

      const result = await harness.invoke('multi-project-get-all');

      expect(result.success).toBe(true);
      expect(result.projects.length).toBe(2);
      expect(result.activeId).toBe('proj-1');
      expect(result.count).toBe(2);
    });

    test('handles dashboard not initialized', async () => {
      const dashboardMod = require('../modules/analysis/multi-project-dashboard');
      dashboardMod.getMultiProjectDashboard.mockReturnValueOnce(null);

      const result = await harness.invoke('multi-project-get-all');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
    });

    test('handles error gracefully', async () => {
      mockDashboard.getAllProjects.mockImplementation(() => {
        throw new Error('Database error');
      });

      const result = await harness.invoke('multi-project-get-all');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('multi-project-register', () => {
    test('registers new project', async () => {
      mockDashboard.registerProject.mockReturnValue({
        id: 'proj-new',
        name: 'New Project',
        path: '/path/to/project',
      });

      const result = await harness.invoke('multi-project-register', {
        id: 'proj-new',
        name: 'New Project',
        projectPath: '/path/to/project',
        description: 'Test description',
        tags: ['test'],
      });

      expect(result.success).toBe(true);
      expect(result.project.id).toBe('proj-new');
      expect(mockDashboard.registerProject).toHaveBeenCalled();
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'multi-project-registered',
        expect.any(Object)
      );
    });

    test('returns error for missing required fields', async () => {
      const result = await harness.invoke('multi-project-register', {
        id: 'proj-1',
        // missing name and projectPath
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required fields');
    });

    test('returns error for non-existent path', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('multi-project-register', {
        id: 'proj-1',
        name: 'Test',
        projectPath: '/invalid/path',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    test('adds to recent projects in settings', async () => {
      deps.loadSettings.mockReturnValue({ recentProjects: [] });
      mockDashboard.registerProject.mockReturnValue({ id: 'proj-1', name: 'Test' });

      await harness.invoke('multi-project-register', {
        id: 'proj-1',
        name: 'Test',
        projectPath: '/path/to/project',
      });

      expect(deps.saveSettings).toHaveBeenCalled();
      const savedSettings = deps.saveSettings.mock.calls[0][0];
      expect(savedSettings.recentProjects[0].path).toBe('/path/to/project');
    });

    test('does not duplicate existing recent project', async () => {
      deps.loadSettings.mockReturnValue({
        recentProjects: [{ path: '/path/to/project', name: 'Existing' }],
      });

      await harness.invoke('multi-project-register', {
        id: 'proj-1',
        name: 'Test',
        projectPath: '/path/to/project',
      });

      expect(deps.saveSettings).not.toHaveBeenCalled();
    });
  });

  describe('multi-project-unregister', () => {
    test('unregisters project', async () => {
      mockDashboard.unregisterProject.mockReturnValue(true);

      const result = await harness.invoke('multi-project-unregister', 'proj-1');

      expect(result.success).toBe(true);
      expect(result.projectId).toBe('proj-1');
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'multi-project-unregistered',
        { projectId: 'proj-1' }
      );
    });

    test('returns error when project not found', async () => {
      mockDashboard.unregisterProject.mockReturnValue(false);

      const result = await harness.invoke('multi-project-unregister', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('multi-project-update', () => {
    test('updates project fields', async () => {
      const mockProject = {
        id: 'proj-1',
        name: 'Old Name',
        description: 'Old description',
        tags: [],
        metadata: {},
      };
      mockDashboard.getProject.mockReturnValue(mockProject);

      const result = await harness.invoke('multi-project-update', 'proj-1', {
        name: 'New Name',
        description: 'New description',
        tags: ['updated'],
      });

      expect(result.success).toBe(true);
      expect(mockProject.name).toBe('New Name');
      expect(mockProject.description).toBe('New description');
      expect(mockProject.tags).toEqual(['updated']);
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'multi-project-updated',
        mockProject
      );
    });

    test('merges metadata updates', async () => {
      const mockProject = {
        id: 'proj-1',
        metadata: { existing: 'value' },
      };
      mockDashboard.getProject.mockReturnValue(mockProject);

      await harness.invoke('multi-project-update', 'proj-1', {
        metadata: { newField: 'new value' },
      });

      expect(mockProject.metadata.existing).toBe('value');
      expect(mockProject.metadata.newField).toBe('new value');
    });

    test('returns error when project not found', async () => {
      mockDashboard.getProject.mockReturnValue(null);

      const result = await harness.invoke('multi-project-update', 'unknown', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('multi-project-get-active', () => {
    test('returns active project', async () => {
      mockDashboard.getActiveProject.mockReturnValue('proj-1');
      mockDashboard.getProject.mockReturnValue({ id: 'proj-1', name: 'Active' });

      const result = await harness.invoke('multi-project-get-active');

      expect(result.success).toBe(true);
      expect(result.activeId).toBe('proj-1');
      expect(result.project.name).toBe('Active');
    });

    test('returns null when no active project', async () => {
      mockDashboard.getActiveProject.mockReturnValue(null);

      const result = await harness.invoke('multi-project-get-active');

      expect(result.success).toBe(true);
      expect(result.activeId).toBeNull();
      expect(result.project).toBeNull();
    });
  });

  describe('multi-project-switch', () => {
    test('switches to specified project', async () => {
      mockDashboard.switchProject.mockReturnValue({
        success: true,
        previousId: 'proj-old',
        savedContext: {},
        restoredContext: {},
      });
      mockDashboard.getProject.mockReturnValue({
        id: 'proj-new',
        name: 'New Project',
        path: '/new/path',
      });

      const result = await harness.invoke('multi-project-switch', 'proj-new');

      expect(result.success).toBe(true);
      expect(result.projectId).toBe('proj-new');
      expect(ctx.watcher.writeState).toHaveBeenCalled();
      expect(ctx.watcher.transition).toHaveBeenCalledWith('project_selected');
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'multi-project-switched',
        expect.any(Object)
      );
    });

    test('returns error from dashboard', async () => {
      mockDashboard.switchProject.mockReturnValue({
        success: false,
        error: 'Cannot switch while busy',
      });

      const result = await harness.invoke('multi-project-switch', 'proj-new');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot switch while busy');
    });
  });

  describe('multi-project-get-metrics', () => {
    test('returns aggregated metrics', async () => {
      mockDashboard.getAggregatedMetrics.mockReturnValue({
        totalProjects: 5,
        totalTasks: 100,
      });

      const result = await harness.invoke('multi-project-get-metrics');

      expect(result.success).toBe(true);
      expect(result.metrics.totalProjects).toBe(5);
    });

    test('passes options to dashboard', async () => {
      await harness.invoke('multi-project-get-metrics', { period: '7d' });

      expect(mockDashboard.getAggregatedMetrics).toHaveBeenCalledWith({ period: '7d' });
    });
  });

  describe('multi-project-get-health', () => {
    test('returns health for project', async () => {
      mockDashboard.getProjectHealth.mockReturnValue({
        score: 85,
        factors: { activity: 90, issues: 80 },
      });

      const result = await harness.invoke('multi-project-get-health', 'proj-1');

      expect(result.success).toBe(true);
      expect(result.health.score).toBe(85);
      expect(result.projectId).toBe('proj-1');
    });

    test('returns error when project not found', async () => {
      mockDashboard.getProjectHealth.mockReturnValue(null);

      const result = await harness.invoke('multi-project-get-health', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('multi-project-get-all-health', () => {
    test('returns health scores for all projects', async () => {
      mockDashboard.getAllProjects.mockReturnValue([
        { id: 'proj-1' },
        { id: 'proj-2' },
      ]);
      mockDashboard.getProjectHealth
        .mockReturnValueOnce({ score: 80 })
        .mockReturnValueOnce({ score: 60 });

      const result = await harness.invoke('multi-project-get-all-health');

      expect(result.success).toBe(true);
      expect(result.healthScores['proj-1'].score).toBe(80);
      expect(result.healthScores['proj-2'].score).toBe(60);
    });
  });

  describe('multi-project-compare', () => {
    test('compares multiple projects', async () => {
      mockDashboard.compareProjects.mockReturnValue({
        projects: ['proj-1', 'proj-2'],
        differences: {},
      });

      const result = await harness.invoke('multi-project-compare', ['proj-1', 'proj-2']);

      expect(result.success).toBe(true);
      expect(result.comparison.projects).toEqual(['proj-1', 'proj-2']);
    });

    test('returns error for insufficient projects', async () => {
      const result = await harness.invoke('multi-project-compare', ['proj-1']);

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least 2');
    });

    test('returns error for invalid input', async () => {
      const result = await harness.invoke('multi-project-compare', 'not-array');

      expect(result.success).toBe(false);
      expect(result.error).toContain('at least 2');
    });
  });

  describe('multi-project-record-activity', () => {
    test('records activity for project', async () => {
      const result = await harness.invoke('multi-project-record-activity', 'proj-1', {
        type: 'task_completed',
        data: { taskId: 'task-1' },
      });

      expect(result.success).toBe(true);
      expect(mockDashboard.recordActivity).toHaveBeenCalledWith(
        'proj-1',
        'task_completed',
        { taskId: 'task-1' },
        undefined
      );
    });

    test('returns error for missing activity type', async () => {
      const result = await harness.invoke('multi-project-record-activity', 'proj-1', {
        data: { some: 'data' },
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('type required');
    });
  });

  describe('multi-project-get-activity', () => {
    test('returns activity timeline', async () => {
      mockDashboard.getActivityTimeline.mockReturnValue([
        { type: 'task', timestamp: Date.now() },
      ]);

      const result = await harness.invoke('multi-project-get-activity', { limit: 10 });

      expect(result.success).toBe(true);
      expect(result.activities.length).toBe(1);
      expect(mockDashboard.getActivityTimeline).toHaveBeenCalledWith({ limit: 10 });
    });
  });

  describe('multi-project-get-summary', () => {
    test('returns dashboard summary', async () => {
      mockDashboard.getAllProjects.mockReturnValue([
        { id: 'proj-1', status: 'active' },
        { id: 'proj-2', status: 'paused' },
        { id: 'proj-3', status: 'active' },
      ]);
      mockDashboard.getActiveProject.mockReturnValue('proj-1');
      mockDashboard.getAggregatedMetrics.mockReturnValue({ total: 100 });
      mockDashboard.getActivityTimeline.mockReturnValue([]);
      mockDashboard.getProjectHealth
        .mockReturnValueOnce({ score: 80 })
        .mockReturnValueOnce({ score: 40 })
        .mockReturnValueOnce({ score: 90 });

      const result = await harness.invoke('multi-project-get-summary');

      expect(result.success).toBe(true);
      expect(result.summary.totalProjects).toBe(3);
      expect(result.summary.statusCounts.active).toBe(2);
      expect(result.summary.statusCounts.paused).toBe(1);
      expect(result.summary.needsAttention.length).toBe(1);
      expect(result.summary.needsAttention[0].id).toBe('proj-2');
    });
  });

  describe('multi-project-export', () => {
    test('exports project to file', async () => {
      mockDashboard.getProject.mockReturnValue({
        id: 'proj-1',
        name: 'Export Test',
        path: '/path',
      });
      mockDashboard.getProjectHealth.mockReturnValue({ score: 80 });
      mockDashboard.getActivityTimeline.mockReturnValue([]);
      ctx.dialog.showSaveDialog.mockResolvedValue({
        canceled: false,
        filePath: '/export/project.json',
      });

      const result = await harness.invoke('multi-project-export', 'proj-1');

      expect(result.success).toBe(true);
      expect(result.filePath).toBe('/export/project.json');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles canceled dialog', async () => {
      mockDashboard.getProject.mockReturnValue({ id: 'proj-1', name: 'Test' });
      ctx.dialog.showSaveDialog.mockResolvedValue({ canceled: true });

      const result = await harness.invoke('multi-project-export', 'proj-1');

      expect(result.success).toBe(false);
      expect(result.canceled).toBe(true);
    });

    test('returns error when project not found', async () => {
      mockDashboard.getProject.mockReturnValue(null);

      const result = await harness.invoke('multi-project-export', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('multi-project-import', () => {
    test('imports project from file', async () => {
      ctx.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/import/project.json'],
      });
      fs.readFileSync.mockReturnValue(JSON.stringify({
        version: '1.0',
        project: {
          id: 'proj-import',
          name: 'Imported Project',
          path: '/path',
          description: 'Test',
          tags: [],
        },
        activities: [{ type: 'task', data: {} }],
      }));
      mockDashboard.getProject.mockReturnValue(null); // No existing project
      mockDashboard.registerProject.mockReturnValue({
        id: 'proj-import',
        name: 'Imported Project',
      });

      const result = await harness.invoke('multi-project-import');

      expect(result.success).toBe(true);
      expect(result.project.id).toBe('proj-import');
      expect(mockDashboard.registerProject).toHaveBeenCalled();
      expect(mockDashboard.recordActivity).toHaveBeenCalled();
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'multi-project-imported',
        expect.any(Object)
      );
    });

    test('handles canceled dialog', async () => {
      ctx.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

      const result = await harness.invoke('multi-project-import');

      expect(result.success).toBe(false);
      expect(result.canceled).toBe(true);
    });

    test('returns error for invalid file format', async () => {
      ctx.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/import/invalid.json'],
      });
      fs.readFileSync.mockReturnValue('{}'); // Missing project

      const result = await harness.invoke('multi-project-import');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid import file');
    });

    test('returns error when project already exists', async () => {
      ctx.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/import/project.json'],
      });
      fs.readFileSync.mockReturnValue(JSON.stringify({
        project: { id: 'existing', name: 'Test' },
      }));
      mockDashboard.getProject.mockReturnValue({ id: 'existing', name: 'Existing' });

      const result = await harness.invoke('multi-project-import');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
      expect(result.existingProject).toBeDefined();
    });
  });

  describe('multi-project-archive', () => {
    test('archives project', async () => {
      const mockProject = { id: 'proj-1', name: 'Test', status: 'active' };
      mockDashboard.getProject.mockReturnValue(mockProject);

      const result = await harness.invoke('multi-project-archive', 'proj-1');

      expect(result.success).toBe(true);
      expect(mockProject.status).toBe('archived');
      expect(mockProject.archivedAt).toBeDefined();
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'multi-project-archived',
        { projectId: 'proj-1' }
      );
    });

    test('returns error when project not found', async () => {
      mockDashboard.getProject.mockReturnValue(null);

      const result = await harness.invoke('multi-project-archive', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('multi-project-restore', () => {
    test('restores archived project', async () => {
      const mockProject = { id: 'proj-1', name: 'Test', status: 'archived', archivedAt: Date.now() };
      mockDashboard.getProject.mockReturnValue(mockProject);

      const result = await harness.invoke('multi-project-restore', 'proj-1');

      expect(result.success).toBe(true);
      expect(mockProject.status).toBe('active');
      expect(mockProject.archivedAt).toBeUndefined();
      expect(mockProject.restoredAt).toBeDefined();
      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith(
        'multi-project-restored',
        { projectId: 'proj-1' }
      );
    });

    test('returns error when project not archived', async () => {
      const mockProject = { id: 'proj-1', status: 'active' };
      mockDashboard.getProject.mockReturnValue(mockProject);

      const result = await harness.invoke('multi-project-restore', 'proj-1');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not archived');
    });

    test('returns error when project not found', async () => {
      mockDashboard.getProject.mockReturnValue(null);

      const result = await harness.invoke('multi-project-restore', 'unknown');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('dashboard initialization error', () => {
    beforeEach(() => {
      // Clear the cached module to test initialization error
      jest.resetModules();
    });

    test('handles failed dashboard module load', async () => {
      jest.doMock('../modules/analysis/multi-project-dashboard', () => {
        throw new Error('Module not found');
      });

      // Need to re-import to get fresh instance
      const { registerMultiProjectHandlers: register } = require('../modules/ipc/multi-project-handlers');
      const newHarness = createIpcHarness();
      register(createDefaultContext({ ipcMain: newHarness.ipcMain }), deps);

      const result = await newHarness.invoke('multi-project-get-all');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
    });
  });
});
