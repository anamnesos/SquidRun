/**
 * Multi-Project Dashboard IPC Handlers
 * Task #30: Multi-project management with context switching, metrics aggregation,
 * health scoring, and cross-project comparison
 *
 * Channels:
 *   - multi-project-get-all: Get all registered projects
 *   - multi-project-register: Register a new project
 *   - multi-project-unregister: Remove a project from registry
 *   - multi-project-update: Update project metadata
 *   - multi-project-get-active: Get currently active project
 *   - multi-project-switch: Switch active project with context preservation
 *   - multi-project-get-metrics: Get aggregated metrics across projects
 *   - multi-project-get-health: Get health score for a project
 *   - multi-project-get-all-health: Get health scores for all projects
 *   - multi-project-compare: Compare multiple projects
 *   - multi-project-record-activity: Record activity for a project
 *   - multi-project-get-activity: Get activity timeline
 *   - multi-project-get-summary: Get dashboard summary
 *   - multi-project-export: Export project data
 *   - multi-project-import: Import project data
 *   - multi-project-archive: Archive a project
 *   - multi-project-restore: Restore an archived project
 */

const path = require('path');
const fs = require('fs');
const log = require('../logger');

// Import the dashboard module
let dashboardModule = null;

function getDashboard() {
  if (!dashboardModule) {
    try {
      dashboardModule = require('../analysis/multi-project-dashboard');
    } catch (err) {
      log.error('MultiProjectHandlers', 'Failed to load dashboard module:', err.message);
      return null;
    }
  }
  return dashboardModule.getMultiProjectDashboard();
}

function registerMultiProjectHandlers(ctx, deps) {
  const { ipcMain } = ctx;
  const { loadSettings, saveSettings } = deps;

  // === PROJECT REGISTRY ===

  ipcMain.handle('multi-project-get-all', () => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const projects = dashboard.getAllProjects();
      return {
        success: true,
        projects,
        count: projects.length,
        activeId: dashboard.getActiveProject(),
      };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Get all projects failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-register', (event, projectData) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const { id, name, projectPath, description, tags, metadata } = projectData || {};

      if (!id || !name || !projectPath) {
        return { success: false, error: 'Missing required fields: id, name, path' };
      }

      // Verify path exists
      if (!fs.existsSync(projectPath)) {
        return { success: false, error: 'Project path does not exist' };
      }

      const project = dashboard.registerProject(id, {
        name,
        path: projectPath,
        description: description || '',
        tags: tags || [],
        ...metadata,
      });

      // Also add to recent projects in settings
      const settings = loadSettings();
      const recentProjects = settings.recentProjects || [];
      const existingIndex = recentProjects.findIndex(p => p.path === projectPath);
      if (existingIndex === -1) {
        recentProjects.unshift({
          name,
          path: projectPath,
          lastOpened: new Date().toISOString(),
        });
        settings.recentProjects = recentProjects.slice(0, 20);
        saveSettings(settings);
      }

      // Notify renderer
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('multi-project-registered', project);
      }

      log.info('MultiProjectHandlers', `Registered project: ${name} (${id})`);
      return { success: true, project };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Register project failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-unregister', (event, projectId) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const removed = dashboard.unregisterProject(projectId);
      if (!removed) {
        return { success: false, error: 'Project not found' };
      }

      // Notify renderer
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('multi-project-unregistered', { projectId });
      }

      log.info('MultiProjectHandlers', `Unregistered project: ${projectId}`);
      return { success: true, projectId };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Unregister project failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-update', (event, projectId, updates) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const project = dashboard.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      // Update allowed fields
      const allowedFields = ['name', 'description', 'tags', 'status', 'priority', 'metadata'];
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          if (field === 'metadata') {
            project.metadata = { ...project.metadata, ...updates.metadata };
          } else {
            project[field] = updates[field];
          }
        }
      }
      project.updatedAt = Date.now();

      // Notify renderer
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('multi-project-updated', project);
      }

      log.info('MultiProjectHandlers', `Updated project: ${projectId}`);
      return { success: true, project };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Update project failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === ACTIVE PROJECT & CONTEXT SWITCHING ===

  ipcMain.handle('multi-project-get-active', () => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const activeId = dashboard.getActiveProject();
      const activeProject = activeId ? dashboard.getProject(activeId) : null;

      return {
        success: true,
        activeId,
        project: activeProject,
      };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Get active project failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-switch', async (event, projectId, options = {}) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const result = dashboard.switchProject(projectId, options);
      if (!result.success) {
        return result;
      }

      // Update app state
      const project = dashboard.getProject(projectId);
      if (project && project.path) {
        const state = ctx.watcher.readState();
        state.project = project.path;
        state.multiProjectId = projectId;
        ctx.watcher.writeState(state);

        // Transition state machine if needed
        ctx.watcher.transition(ctx.watcher.States.PROJECT_SELECTED);
      }

      // Notify renderer
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('multi-project-switched', {
          projectId,
          project,
          previousId: result.previousId,
          savedContext: result.savedContext,
        });
      }

      log.info('MultiProjectHandlers', `Switched to project: ${projectId}`);
      return {
        success: true,
        projectId,
        project,
        previousId: result.previousId,
        restoredContext: result.restoredContext,
      };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Switch project failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === METRICS & HEALTH ===

  ipcMain.handle('multi-project-get-metrics', (event, options = {}) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const metrics = dashboard.getAggregatedMetrics(options);
      return { success: true, metrics };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Get metrics failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-get-health', (event, projectId) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const health = dashboard.getProjectHealth(projectId);
      if (!health) {
        return { success: false, error: 'Project not found' };
      }

      return { success: true, projectId, health };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Get health failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-get-all-health', () => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const projects = dashboard.getAllProjects();
      const healthScores = {};

      for (const project of projects) {
        healthScores[project.id] = dashboard.getProjectHealth(project.id);
      }

      return { success: true, healthScores };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Get all health failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-compare', (event, projectIds) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      if (!Array.isArray(projectIds) || projectIds.length < 2) {
        return { success: false, error: 'Need at least 2 project IDs to compare' };
      }

      const comparison = dashboard.compareProjects(projectIds);
      return { success: true, comparison };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Compare projects failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === ACTIVITY TRACKING ===

  ipcMain.handle('multi-project-record-activity', (event, projectId, activity) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const { type, data, timestamp } = activity || {};
      if (!type) {
        return { success: false, error: 'Activity type required' };
      }

      dashboard.recordActivity(projectId, type, data, timestamp);

      log.debug('MultiProjectHandlers', `Recorded activity for ${projectId}: ${type}`);
      return { success: true };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Record activity failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-get-activity', (event, options = {}) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const timeline = dashboard.getActivityTimeline(options);
      return { success: true, activities: timeline };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Get activity failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === DASHBOARD SUMMARY ===

  ipcMain.handle('multi-project-get-summary', () => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const projects = dashboard.getAllProjects();
      const activeId = dashboard.getActiveProject();
      const metrics = dashboard.getAggregatedMetrics();
      const recentActivity = dashboard.getActivityTimeline({ limit: 10 });

      // Calculate status distribution
      const statusCounts = { active: 0, paused: 0, completed: 0, archived: 0 };
      for (const project of projects) {
        const status = project.status || 'active';
        statusCounts[status] = (statusCounts[status] || 0) + 1;
      }

      // Get health scores
      const healthScores = {};
      for (const project of projects) {
        healthScores[project.id] = dashboard.getProjectHealth(project.id);
      }

      // Find projects needing attention (low health score)
      const needsAttention = projects
        .filter(p => {
          const health = healthScores[p.id];
          return health && health.score < 50;
        })
        .map(p => ({
          id: p.id,
          name: p.name,
          health: healthScores[p.id],
        }));

      return {
        success: true,
        summary: {
          totalProjects: projects.length,
          activeProjectId: activeId,
          statusCounts,
          aggregatedMetrics: metrics,
          recentActivity,
          healthScores,
          needsAttention,
          lastUpdated: Date.now(),
        },
      };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Get summary failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === EXPORT/IMPORT ===

  ipcMain.handle('multi-project-export', async (event, projectId) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const project = dashboard.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      const exportData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        project: {
          ...project,
          health: dashboard.getProjectHealth(projectId),
        },
        activities: dashboard.getActivityTimeline({
          projectIds: [projectId],
          limit: 1000,
        }),
      };

      // Show save dialog
      const result = await ctx.dialog.showSaveDialog(ctx.mainWindow, {
        title: 'Export Project Data',
        defaultPath: `${project.name}-export.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });

      if (result.canceled) {
        return { success: false, canceled: true };
      }

      fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2));

      log.info('MultiProjectHandlers', `Exported project ${projectId} to ${result.filePath}`);
      return { success: true, filePath: result.filePath };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Export project failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-import', async () => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      // Show open dialog
      const result = await ctx.dialog.showOpenDialog(ctx.mainWindow, {
        title: 'Import Project Data',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const content = fs.readFileSync(result.filePaths[0], 'utf8');
      const importData = JSON.parse(content);

      if (!importData.project || !importData.project.id) {
        return { success: false, error: 'Invalid import file format' };
      }

      // Check for existing project with same ID
      const existing = dashboard.getProject(importData.project.id);
      if (existing) {
        return {
          success: false,
          error: 'Project with this ID already exists',
          existingProject: existing,
        };
      }

      // Register the project
      const { id, name, path: projectPath, description, tags, metadata } = importData.project;
      const project = dashboard.registerProject(id, {
        name,
        path: projectPath,
        description,
        tags,
        ...metadata,
        importedAt: Date.now(),
        importedFrom: result.filePaths[0],
      });

      // Import activities
      if (importData.activities && Array.isArray(importData.activities)) {
        for (const activity of importData.activities) {
          dashboard.recordActivity(id, activity.type, activity.data, activity.timestamp);
        }
      }

      // Notify renderer
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('multi-project-imported', project);
      }

      log.info('MultiProjectHandlers', `Imported project ${id} from ${result.filePaths[0]}`);
      return { success: true, project };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Import project failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  // === ARCHIVE/RESTORE ===

  ipcMain.handle('multi-project-archive', (event, projectId) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const project = dashboard.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      project.status = 'archived';
      project.archivedAt = Date.now();
      project.updatedAt = Date.now();

      // Notify renderer
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('multi-project-archived', { projectId });
      }

      log.info('MultiProjectHandlers', `Archived project: ${projectId}`);
      return { success: true, projectId };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Archive project failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('multi-project-restore', (event, projectId) => {
    try {
      const dashboard = getDashboard();
      if (!dashboard) {
        return { success: false, error: 'Dashboard not initialized' };
      }

      const project = dashboard.getProject(projectId);
      if (!project) {
        return { success: false, error: 'Project not found' };
      }

      if (project.status !== 'archived') {
        return { success: false, error: 'Project is not archived' };
      }

      project.status = 'active';
      project.restoredAt = Date.now();
      project.updatedAt = Date.now();
      delete project.archivedAt;

      // Notify renderer
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('multi-project-restored', { projectId });
      }

      log.info('MultiProjectHandlers', `Restored project: ${projectId}`);
      return { success: true, projectId, project };
    } catch (err) {
      log.error('MultiProjectHandlers', 'Restore project failed:', err.message);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerMultiProjectHandlers };
