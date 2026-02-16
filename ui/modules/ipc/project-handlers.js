/**
 * Project IPC Handlers
 * Channels: select-project, get-project, get-recent-projects, add-recent-project,
 *           remove-recent-project, clear-recent-projects, switch-project,
 *           set-pane-project, select-pane-project, get-pane-project, get-all-pane-projects, clear-pane-projects
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { setProjectRoot } = require('../../config');

function registerProjectHandlers(ctx, deps) {
  const { ipcMain, PANE_IDS } = ctx;
  const { loadSettings, saveSettings } = deps;
  const syncProjectRoot = (projectPath) => {
    if (typeof setProjectRoot === 'function') {
      setProjectRoot(projectPath || null);
    }
  };

  try {
    const initialProject = ctx?.watcher?.readState?.()?.project || null;
    syncProjectRoot(initialProject);
  } catch (_) {
    // Keep startup resilient if watcher state is not available yet.
  }

  // === PROJECT/FOLDER PICKER ===

  ipcMain.handle('select-project', async () => {
    const result = await ctx.dialog.showOpenDialog(ctx.mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Project Folder',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const projectPath = result.filePaths[0];
    const projectName = path.basename(projectPath);

    const state = ctx.watcher.readState();
    state.project = projectPath;
    ctx.watcher.writeState(state);
    syncProjectRoot(projectPath);

    const settings = loadSettings();
    const projects = settings.recentProjects || [];
    const filtered = projects.filter(p => p.path !== projectPath);
    filtered.unshift({
      name: projectName,
      path: projectPath,
      lastOpened: new Date().toISOString(),
    });
    settings.recentProjects = filtered.slice(0, 10);
    saveSettings(settings);

    ctx.watcher.transition(ctx.watcher.States.PROJECT_SELECTED);

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('project-changed', projectPath);
    }

    return { success: true, path: projectPath, name: projectName };
  });

  ipcMain.handle('get-project', () => {
    const state = ctx.watcher.readState();
    return state.project || null;
  });

  // === RECENT PROJECTS ===

  ipcMain.handle('get-recent-projects', () => {
    const settings = loadSettings();
    const projects = settings.recentProjects || [];

    const validProjects = projects.filter(p => {
      try {
        return fs.existsSync(p.path);
      } catch {
        return false;
      }
    });

    if (validProjects.length !== projects.length) {
      settings.recentProjects = validProjects;
      saveSettings(settings);
    }

    return { success: true, projects: validProjects };
  });

  ipcMain.handle('add-recent-project', (event, projectPath) => {
    if (!projectPath || !fs.existsSync(projectPath)) {
      return { success: false, error: 'Invalid project path' };
    }

    const settings = loadSettings();
    const projects = settings.recentProjects || [];
    const MAX_RECENT = 10;
    const projectName = path.basename(projectPath);

    const filtered = projects.filter(p => p.path !== projectPath);
    filtered.unshift({
      name: projectName,
      path: projectPath,
      lastOpened: new Date().toISOString(),
    });
    settings.recentProjects = filtered.slice(0, MAX_RECENT);
    saveSettings(settings);

    return { success: true, projects: settings.recentProjects };
  });

  ipcMain.handle('remove-recent-project', (event, projectPath) => {
    const settings = loadSettings();
    const projects = settings.recentProjects || [];

    settings.recentProjects = projects.filter(p => p.path !== projectPath);
    saveSettings(settings);

    return { success: true, projects: settings.recentProjects };
  });

  ipcMain.handle('clear-recent-projects', () => {
    const settings = loadSettings();
    settings.recentProjects = [];
    saveSettings(settings);

    return { success: true };
  });

  ipcMain.handle('switch-project', async (event, projectPath) => {
    if (!projectPath || !fs.existsSync(projectPath)) {
      return { success: false, error: 'Project path does not exist' };
    }

    const state = ctx.watcher.readState();
    state.project = projectPath;
    ctx.watcher.writeState(state);
    syncProjectRoot(projectPath);

    const settings = loadSettings();
    const projects = settings.recentProjects || [];
    const projectName = path.basename(projectPath);

    const filtered = projects.filter(p => p.path !== projectPath);
    filtered.unshift({
      name: projectName,
      path: projectPath,
      lastOpened: new Date().toISOString(),
    });
    settings.recentProjects = filtered.slice(0, 10);
    saveSettings(settings);

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('project-changed', projectPath);
    }

    ctx.watcher.transition(ctx.watcher.States.PROJECT_SELECTED);

    return { success: true, path: projectPath, name: projectName };
  });

  // === PER-PANE PROJECT ASSIGNMENT ===

  function assignPaneProject(paneId, projectPath) {
    if (!PANE_IDS.includes(paneId)) {
      return { success: false, error: 'Invalid pane ID' };
    }

    if (projectPath && !fs.existsSync(projectPath)) {
      return { success: false, error: 'Project path does not exist' };
    }

    const settings = loadSettings();
    if (!settings.paneProjects) {
      settings.paneProjects = { '1': null, '2': null, '5': null };
    }

    settings.paneProjects[paneId] = projectPath;
    saveSettings(settings);

    log.info('Multi-Project', `Pane ${paneId} assigned to: ${projectPath || 'default'}`);

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('pane-project-changed', { paneId, projectPath });
    }

    return { success: true, paneId, projectPath };
  }

  ipcMain.handle('set-pane-project', (event, paneId, projectPath) => assignPaneProject(paneId, projectPath));

  ipcMain.handle('select-pane-project', async (event, paneId) => {
    if (!PANE_IDS.includes(paneId)) {
      return { success: false, error: 'Invalid pane ID' };
    }

    const result = await ctx.dialog.showOpenDialog(ctx.mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Project Folder',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const projectPath = result.filePaths[0];
    const assigned = assignPaneProject(paneId, projectPath);
    if (!assigned.success) {
      return assigned;
    }

    return { success: true, paneId, path: projectPath, name: path.basename(projectPath) };
  });

  ipcMain.handle('get-pane-project', (event, paneId) => {
    const settings = loadSettings();
    const projectPath = settings.paneProjects?.[paneId] || null;
    return { success: true, paneId, projectPath };
  });

  ipcMain.handle('get-all-pane-projects', () => {
    const settings = loadSettings();
    return {
      success: true,
      paneProjects: settings.paneProjects || { '1': null, '2': null, '5': null },
    };
  });

  ipcMain.handle('clear-pane-projects', () => {
    const settings = loadSettings();
    settings.paneProjects = { '1': null, '2': null, '5': null };
    saveSettings(settings);

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('pane-projects-cleared');
    }

    return { success: true };
  });
}

function unregisterProjectHandlers(ctx) {
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('select-project');
    ipcMain.removeHandler('get-project');
    ipcMain.removeHandler('get-recent-projects');
    ipcMain.removeHandler('add-recent-project');
    ipcMain.removeHandler('remove-recent-project');
    ipcMain.removeHandler('clear-recent-projects');
    ipcMain.removeHandler('switch-project');
    ipcMain.removeHandler('set-pane-project');
    ipcMain.removeHandler('select-pane-project');
    ipcMain.removeHandler('get-pane-project');
    ipcMain.removeHandler('get-all-pane-projects');
    ipcMain.removeHandler('clear-pane-projects');
  }
}

registerProjectHandlers.unregister = unregisterProjectHandlers;

module.exports = { registerProjectHandlers };
