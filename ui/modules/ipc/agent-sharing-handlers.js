/**
 * Agent Sharing IPC Handlers (Task #22)
 * Channels:
 *  - agent-config-list
 *  - agent-config-get
 *  - agent-config-save
 *  - agent-config-apply
 *  - agent-config-export
 *  - agent-config-import
 *  - agent-config-share
 *  - agent-config-delete
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

const STORE_VERSION = '1.0';
const MAX_CONFIGS = 200;
const AGENT_CONFIG_KEYS = [
  'paneCommands',
  'autoSpawn',
  'autoSync',
  'agentNotify',
  'dryRun',
  'sdkMode',
  'mcpAutoConfig',
  'allowAllPermissions',
  'stuckThreshold',
  'autoNudge',
];

function registerAgentSharingHandlers(ctx, deps) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  const { loadSettings, saveSettings } = deps;
  const configsDir = path.join(WORKSPACE_PATH, 'memory');
  const configsPath = path.join(configsDir, '_agent-configs.json');

  const ensureDir = () => {
    if (!fs.existsSync(configsDir)) {
      fs.mkdirSync(configsDir, { recursive: true });
    }
  };

  const deepClone = (value) => {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  };

  const normalizeProjectPath = (projectPath) => {
    if (!projectPath) return null;
    return path.resolve(projectPath);
  };

  const getActiveProjectPath = () => {
    try {
      const state = ctx.watcher?.readState?.();
      return state?.project ? normalizeProjectPath(state.project) : null;
    } catch (err) {
      return null;
    }
  };

  const resolveProjectInfo = (payload = {}) => {
    const project = payload.project || {};
    const projectId = payload.projectId || project.id || null;
    const projectPath = normalizeProjectPath(
      payload.projectPath || project.path || (payload.useActiveProject === false ? null : getActiveProjectPath())
    );
    const name = payload.name || project.name || (projectPath ? path.basename(projectPath) : projectId || 'Global');
    const key = projectId ? `id:${projectId}` : projectPath ? `path:${projectPath}` : 'global';
    return { projectId, projectPath, name, key };
  };

  const loadStore = () => {
    ensureDir();
    if (!fs.existsSync(configsPath)) {
      return { version: STORE_VERSION, configs: [], savedAt: new Date().toISOString() };
    }
    try {
      const data = JSON.parse(fs.readFileSync(configsPath, 'utf8'));
      if (Array.isArray(data)) {
        return { version: STORE_VERSION, configs: data, savedAt: new Date().toISOString() };
      }
      if (!Array.isArray(data.configs)) {
        data.configs = [];
      }
      return { version: data.version || STORE_VERSION, configs: data.configs, savedAt: data.savedAt || new Date().toISOString() };
    } catch (err) {
      log.error('AgentSharing', 'Failed to load agent configs:', err.message);
      return { version: STORE_VERSION, configs: [], savedAt: new Date().toISOString() };
    }
  };

  const saveStore = (store) => {
    try {
      ensureDir();
      const payload = {
        version: store.version || STORE_VERSION,
        configs: store.configs || [],
        savedAt: new Date().toISOString(),
      };
      const tempPath = configsPath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tempPath, configsPath);
    } catch (err) {
      log.error('AgentSharing', 'Failed to save agent configs:', err.message);
    }
  };

  const extractAgentConfig = (settings, options = {}) => {
    const config = {};
    AGENT_CONFIG_KEYS.forEach((key) => {
      if (settings && settings[key] !== undefined) {
        config[key] = deepClone(settings[key]);
      }
    });
    if (options.includePaneProjects && settings?.paneProjects) {
      config.paneProjects = deepClone(settings.paneProjects);
    }
    return config;
  };

  const sanitizeAgentConfig = (input, options = {}) => {
    if (!input || typeof input !== 'object') return {};
    const config = {};
    AGENT_CONFIG_KEYS.forEach((key) => {
      if (input[key] !== undefined) {
        config[key] = deepClone(input[key]);
      }
    });
    if (options.includePaneProjects && input.paneProjects) {
      config.paneProjects = deepClone(input.paneProjects);
    }
    return config;
  };

  const listConfigs = () => {
    const store = loadStore();
    return store.configs.map(entry => ({
      key: entry.key,
      name: entry.name,
      projectId: entry.projectId || null,
      projectPath: entry.projectPath || null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      source: entry.source || 'local',
    }));
  };

  const findConfig = (key) => {
    if (!key) return null;
    const store = loadStore();
    return store.configs.find(entry => entry.key === key) || null;
  };

  const upsertConfig = (store, entry) => {
    const existingIndex = store.configs.findIndex(item => item.key === entry.key);
    if (existingIndex >= 0) {
      const existing = store.configs[existingIndex];
      store.configs[existingIndex] = {
        ...existing,
        ...entry,
        createdAt: existing.createdAt || entry.createdAt,
      };
      return store.configs[existingIndex];
    }
    store.configs.push(entry);
    if (store.configs.length > MAX_CONFIGS) {
      store.configs.splice(0, store.configs.length - MAX_CONFIGS);
    }
    return entry;
  };

  const applyAgentConfig = (settings, config, options = {}) => {
    const merge = options.merge !== false;
    const applyPaneProjects = options.applyPaneProjects === true;
    const nextSettings = { ...settings };

    if (config.paneCommands) {
      nextSettings.paneCommands = merge
        ? { ...(settings.paneCommands || {}), ...config.paneCommands }
        : deepClone(config.paneCommands);
    }

    if (applyPaneProjects && config.paneProjects) {
      nextSettings.paneProjects = merge
        ? { ...(settings.paneProjects || {}), ...config.paneProjects }
        : deepClone(config.paneProjects);
    }

    AGENT_CONFIG_KEYS.forEach((key) => {
      if (key === 'paneCommands') return;
      if (config[key] !== undefined) {
        nextSettings[key] = deepClone(config[key]);
      }
    });

    return nextSettings;
  };

  ipcMain.handle('agent-config-list', () => {
    const configs = listConfigs();
    return { success: true, configs, count: configs.length };
  });

  ipcMain.handle('agent-config-get', (event, payload = {}) => {
    const projectInfo = resolveProjectInfo(payload);
    const entry = findConfig(projectInfo.key);
    if (!entry) {
      return { success: false, error: 'Agent config not found', project: projectInfo };
    }
    return { success: true, config: entry.config, entry };
  });

  ipcMain.handle('agent-config-save', (event, payload = {}) => {
    const projectInfo = resolveProjectInfo(payload);
    const settings = loadSettings();
    const includePaneProjects = payload.includePaneProjects === true;
    const config = payload.config
      ? sanitizeAgentConfig(payload.config, { includePaneProjects })
      : extractAgentConfig(settings, { includePaneProjects });

    const store = loadStore();
    const now = new Date().toISOString();
    const entry = upsertConfig(store, {
      key: projectInfo.key,
      name: projectInfo.name,
      projectId: projectInfo.projectId,
      projectPath: projectInfo.projectPath,
      config,
      source: payload.source || 'local',
      createdAt: now,
      updatedAt: now,
    });
    saveStore(store);

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('agent-config-saved', entry);
    }

    log.info('AgentSharing', `Saved agent config for ${projectInfo.name}`);
    return { success: true, entry };
  });

  ipcMain.handle('agent-config-apply', (event, payload = {}) => {
    const projectInfo = resolveProjectInfo(payload);
    const includePaneProjects = payload.applyPaneProjects === true;
    const merge = payload.merge !== false;

    let config = null;
    if (payload.config) {
      config = sanitizeAgentConfig(payload.config, { includePaneProjects });
    } else {
      const entry = findConfig(projectInfo.key);
      config = entry ? sanitizeAgentConfig(entry.config || {}, { includePaneProjects }) : null;
    }

    if (!config) {
      return { success: false, error: 'Agent config not found', project: projectInfo };
    }

    const settings = loadSettings();
    const nextSettings = applyAgentConfig(settings, config, {
      merge,
      applyPaneProjects: includePaneProjects,
    });

    saveSettings(nextSettings);

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('settings-changed', nextSettings);
      ctx.mainWindow.webContents.send('agent-config-applied', {
        project: projectInfo,
        config,
      });
    }

    log.info('AgentSharing', `Applied agent config for ${projectInfo.name}`);
    return { success: true, settings: nextSettings, config };
  });

  ipcMain.handle('agent-config-export', async (event, payload = {}) => {
    const projectInfo = resolveProjectInfo(payload);
    const includePaneProjects = payload.includePaneProjects === true;
    const settings = loadSettings();
    const entry = findConfig(projectInfo.key);

    const config = payload.config
      ? sanitizeAgentConfig(payload.config, { includePaneProjects })
      : entry?.config
        ? sanitizeAgentConfig(entry.config, { includePaneProjects })
        : extractAgentConfig(settings, { includePaneProjects });

    const exportData = {
      version: STORE_VERSION,
      exportedAt: new Date().toISOString(),
      project: {
        id: projectInfo.projectId,
        path: projectInfo.projectPath,
        name: projectInfo.name,
      },
      config,
    };

    let filePath = payload.filePath;
    if (!filePath && payload.useDialog !== false && ctx.dialog && ctx.mainWindow) {
      const result = await ctx.dialog.showSaveDialog(ctx.mainWindow, {
        title: 'Export Agent Config',
        defaultPath: `${projectInfo.name}-agent-config.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled) {
        return { success: false, canceled: true };
      }
      filePath = result.filePath;
    }

    if (filePath) {
      fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
    }

    return {
      success: true,
      filePath: filePath || null,
      json: JSON.stringify(exportData, null, 2),
      config,
    };
  });

  ipcMain.handle('agent-config-import', async (event, payload = {}) => {
    let raw = payload;
    if (payload.useDialog !== false && !payload.filePath && !payload.json && !payload.config && ctx.dialog && ctx.mainWindow) {
      const result = await ctx.dialog.showOpenDialog(ctx.mainWindow, {
        title: 'Import Agent Config',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      raw = { filePath: result.filePaths[0] };
    }

    if (raw.filePath) {
      const content = fs.readFileSync(raw.filePath, 'utf8');
      raw = { json: content };
    }

    let parsed = raw;
    if (typeof raw === 'string') {
      parsed = JSON.parse(raw);
    } else if (raw.json) {
      parsed = typeof raw.json === 'string' ? JSON.parse(raw.json) : raw.json;
    }

    const importConfig = parsed?.config || parsed?.agentConfig || parsed;
    const projectPayload = parsed?.project || {};
    const projectInfo = resolveProjectInfo({
      ...payload,
      project: projectPayload,
      projectId: payload.projectId || projectPayload.id,
      projectPath: payload.projectPath || projectPayload.path,
      name: payload.name || projectPayload.name,
    });

    const includePaneProjects = payload.includePaneProjects === true;
    const config = sanitizeAgentConfig(importConfig, { includePaneProjects });
    if (!Object.keys(config).length) {
      return { success: false, error: 'No valid agent config found in import payload' };
    }

    const store = loadStore();
    const now = new Date().toISOString();
    const entry = upsertConfig(store, {
      key: projectInfo.key,
      name: projectInfo.name,
      projectId: projectInfo.projectId,
      projectPath: projectInfo.projectPath,
      config,
      source: payload.source || 'imported',
      createdAt: now,
      updatedAt: now,
    });
    saveStore(store);

    let appliedSettings = null;
    if (payload.apply === true) {
      const settings = loadSettings();
      appliedSettings = applyAgentConfig(settings, config, {
        merge: payload.merge !== false,
        applyPaneProjects: payload.applyPaneProjects === true,
      });
      saveSettings(appliedSettings);
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('settings-changed', appliedSettings);
        ctx.mainWindow.webContents.send('agent-config-applied', {
          project: projectInfo,
          config,
        });
      }
    }

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('agent-config-imported', entry);
    }

    log.info('AgentSharing', `Imported agent config for ${projectInfo.name}`);
    return { success: true, entry, applied: Boolean(payload.apply), settings: appliedSettings };
  });

  ipcMain.handle('agent-config-share', (event, payload = {}) => {
    const store = loadStore();
    const sourceInfo = resolveProjectInfo({
      projectId: payload.sourceProjectId,
      projectPath: payload.sourceProjectPath,
      name: payload.sourceName,
      useActiveProject: payload.sourceUseActive !== false,
    });
    const targetInfo = resolveProjectInfo({
      projectId: payload.targetProjectId,
      projectPath: payload.targetProjectPath,
      name: payload.targetName,
      useActiveProject: payload.targetUseActive !== false,
    });

    if (!targetInfo.projectId && !targetInfo.projectPath) {
      return { success: false, error: 'Target project not specified' };
    }

    const sourceEntry = store.configs.find(entry => entry.key === sourceInfo.key);
    const includePaneProjects = payload.includePaneProjects === true;
    const config = sourceEntry
      ? sanitizeAgentConfig(sourceEntry.config, { includePaneProjects })
      : extractAgentConfig(loadSettings(), { includePaneProjects });

    const now = new Date().toISOString();
    const entry = upsertConfig(store, {
      key: targetInfo.key,
      name: targetInfo.name,
      projectId: targetInfo.projectId,
      projectPath: targetInfo.projectPath,
      config,
      source: payload.source || 'shared',
      createdAt: now,
      updatedAt: now,
    });
    saveStore(store);

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('agent-config-shared', {
        source: sourceInfo,
        target: entry,
      });
    }

    log.info('AgentSharing', `Shared agent config from ${sourceInfo.name} to ${targetInfo.name}`);
    return { success: true, entry };
  });

  ipcMain.handle('agent-config-delete', (event, payload = {}) => {
    const projectInfo = resolveProjectInfo(payload);
    const store = loadStore();
    const index = store.configs.findIndex(entry => entry.key === projectInfo.key);
    if (index < 0) {
      return { success: false, error: 'Agent config not found', project: projectInfo };
    }
    const deleted = store.configs.splice(index, 1)[0];
    saveStore(store);
    log.info('AgentSharing', `Deleted agent config for ${projectInfo.name}`);
    return { success: true, deleted };
  });
}

module.exports = { registerAgentSharingHandlers };
