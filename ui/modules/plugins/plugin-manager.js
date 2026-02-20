/**
 * Plugin Manager
 * Loads plugin manifests, manages lifecycle, and dispatches hook events.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const log = require('../logger');

const DEFAULT_TIMEOUT_MS = 2000;
const STATE_VERSION = 1;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    log.warn('Plugins', `Failed to read JSON at ${filePath}: ${err.message}`);
    return null;
  }
}

function safeWriteJson(filePath, data) {
  try {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    log.error('Plugins', `Failed to write JSON at ${filePath}: ${err.message}`);
  }
}

function readManifest(dirPath) {
  const manifestPath = path.join(dirPath, 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = safeReadJson(manifestPath);
    return manifest ? { manifest, manifestPath } : null;
  }

  const pkgPath = path.join(dirPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = safeReadJson(pkgPath);
    if (pkg && pkg.squidrun) {
      const manifest = {
        ...pkg.squidrun,
        id: pkg.squidrun.id || pkg.name,
        name: pkg.squidrun.name || pkg.name,
        version: pkg.squidrun.version || pkg.version || '0.0.0',
        main: pkg.squidrun.main || pkg.main || 'index.js',
      };
      return { manifest, manifestPath: pkgPath };
    }
  }

  return null;
}

function normalizeHooks(hooks) {
  if (!hooks || typeof hooks !== 'object') return {};
  return hooks;
}

function createPluginManager(options = {}) {
  const workspacePath = options.workspacePath || process.cwd();
  const pluginsDir = options.pluginsDir || path.join(workspacePath, 'plugins');
  const pluginDataDir = path.join(pluginsDir, '.data');
  const pluginStatePath = path.join(pluginsDir, 'plugins.json');

  const getSettings = options.getSettings || (() => ({}));
  const getState = options.getState || (() => null);
  const notifyAgents = options.notifyAgents || null;
  const sendDirectMessage = options.sendDirectMessage || null;
  const broadcastMessage = options.broadcastMessage || null;
  const logActivity = options.logActivity || null;
  const getMainWindow = options.getMainWindow || (() => null);

  const registry = new Map(); // pluginId -> record
  let state = { version: STATE_VERSION, plugins: {} };

  function loadState() {
    const loaded = safeReadJson(pluginStatePath);
    if (loaded && loaded.plugins) {
      state = { version: STATE_VERSION, ...loaded };
    } else {
      state = { version: STATE_VERSION, plugins: {} };
    }
  }

  function saveState() {
    state.version = STATE_VERSION;
    state.lastUpdated = new Date().toISOString();
    safeWriteJson(pluginStatePath, state);
  }

  function getPluginState(id) {
    if (!state.plugins[id]) {
      state.plugins[id] = { enabled: true, error: null, lastLoaded: null };
    }
    return state.plugins[id];
  }

  function getPluginDataPath(id) {
    const dataPath = path.join(pluginDataDir, id);
    ensureDir(dataPath);
    return dataPath;
  }

  function buildApi(record) {
    const dataPath = getPluginDataPath(record.id);
    const storageFile = path.join(dataPath, 'state.json');

    const storage = {
      read() {
        return safeReadJson(storageFile) || {};
      },
      write(nextState) {
        safeWriteJson(storageFile, nextState || {});
      },
    };

    return {
      id: record.id,
      name: record.manifest.name || record.id,
      version: record.manifest.version,
      workspacePath,
      pluginPath: record.dir,
      dataPath,
      storage,
      getSettings,
      getState,
      log(level, message, meta) {
        const tag = `Plugin:${record.id}`;
        const payload = meta ? [message, meta] : [message];
        if (level === 'error') log.error(tag, ...payload);
        else if (level === 'warn') log.warn(tag, ...payload);
        else if (level === 'debug') log.debug(tag, ...payload);
        else log.info(tag, ...payload);
      },
      notify(message, type = 'info') {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('plugin-toast', { pluginId: record.id, type, message });
        }
      },
      emit(channel, payload) {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('plugin-event', {
            pluginId: record.id,
            channel,
            payload,
          });
        }
      },
      sendDirectMessage: sendDirectMessage
        ? (targets, message) => sendDirectMessage(targets, message, `plugin:${record.id}`)
        : null,
      notifyAgents: notifyAgents
        ? (targets, message) => notifyAgents(targets, message)
        : null,
      broadcast: broadcastMessage
        ? (message) => broadcastMessage(message)
        : null,
      logActivity: logActivity
        ? (type, paneId, message, details) => logActivity(type, paneId, message, details)
        : null,
    };
  }

  function normalizeRecord(record) {
    const pluginState = getPluginState(record.id);
    record.enabled = pluginState.enabled !== false;
    record.error = pluginState.error || null;
    record.loadedAt = pluginState.lastLoaded || null;
    record.hooks = normalizeHooks(record.hooks);
    record.commands = Array.isArray(record.commands) ? record.commands : [];
    return record;
  }

  function unloadPlugin(record) {
    if (!record) return;
    if (record.module && typeof record.module.onUnload === 'function') {
      try {
        record.module.onUnload(record.api, record.manifest);
      } catch (err) {
        log.warn('Plugins', `onUnload failed for ${record.id}: ${err.message}`);
      }
    }
    record.module = null;
    record.hooks = {};
    record.commands = [];
  }

  function loadPluginModule(record) {
    const entryPath = path.resolve(record.dir, record.manifest.main || 'index.js');
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Entry file not found: ${entryPath}`);
    }

    const pluginRequire = createRequire(entryPath);
    delete pluginRequire.cache[pluginRequire.resolve(entryPath)];
    const moduleExports = pluginRequire(entryPath);
    const pluginModule = moduleExports && moduleExports.default ? moduleExports.default : moduleExports;

    if (!pluginModule || typeof pluginModule !== 'object') {
      throw new Error('Plugin module must export an object');
    }

    record.module = pluginModule;
    record.hooks = normalizeHooks(pluginModule.hooks);
    record.commands = Array.isArray(pluginModule.commands) ? pluginModule.commands : [];

    if (typeof pluginModule.onInit === 'function') {
      pluginModule.onInit(record.api, record.manifest);
    }
  }

  function loadPluginFromDir(dirPath) {
    const manifestInfo = readManifest(dirPath);
    if (!manifestInfo) return null;

    const { manifest } = manifestInfo;
    if (!manifest || !manifest.id) {
      log.warn('Plugins', `Manifest missing id in ${dirPath}`);
      return null;
    }

    const record = {
      id: String(manifest.id),
      dir: dirPath,
      manifest: {
        name: manifest.name || manifest.id,
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        main: manifest.main || 'index.js',
        enabled: manifest.enabled !== false,
        hooks: manifest.hooks || [],
        permissions: manifest.permissions || [],
        timeoutMs: manifest.timeoutMs || DEFAULT_TIMEOUT_MS,
      },
      module: null,
      api: null,
      hooks: {},
      commands: [],
    };

    record.api = buildApi(record);
    normalizeRecord(record);
    registry.set(record.id, record);

    if (record.enabled) {
      try {
        loadPluginModule(record);
        record.loadedAt = new Date().toISOString();
        const pluginState = getPluginState(record.id);
        pluginState.enabled = true;
        pluginState.error = null;
        pluginState.lastLoaded = record.loadedAt;
      } catch (err) {
        record.error = err.message;
        const pluginState = getPluginState(record.id);
        pluginState.error = err.message;
        log.error('Plugins', `Failed to load ${record.id}: ${err.message}`);
      }
    }

    return record;
  }

  function loadAll() {
    ensureDir(pluginsDir);
    ensureDir(pluginDataDir);
    loadState();

    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    const pluginDirs = entries.filter(entry => entry.isDirectory() && entry.name !== '.data');

    pluginDirs.forEach(entry => {
      loadPluginFromDir(path.join(pluginsDir, entry.name));
    });

    saveState();
    return listPlugins();
  }

  function listPlugins() {
    return Array.from(registry.values()).map(record => ({
      id: record.id,
      name: record.manifest.name,
      version: record.manifest.version,
      description: record.manifest.description,
      enabled: record.enabled,
      hooks: Object.keys(record.hooks || {}),
      commands: record.commands.map(cmd => ({
        id: cmd.id,
        title: cmd.title || cmd.id,
        description: cmd.description || '',
      })),
      error: record.error || null,
      loadedAt: record.loadedAt,
      dir: record.dir,
    }));
  }

  function enablePlugin(id) {
    const record = registry.get(id);
    if (!record) return { success: false, error: 'Plugin not found' };

    record.enabled = true;
    const pluginState = getPluginState(id);
    pluginState.enabled = true;

    if (!record.module) {
      try {
        loadPluginModule(record);
        record.loadedAt = new Date().toISOString();
        pluginState.error = null;
        pluginState.lastLoaded = record.loadedAt;
      } catch (err) {
        record.error = err.message;
        pluginState.error = err.message;
        log.error('Plugins', `Enable failed for ${id}: ${err.message}`);
        saveState();
        return { success: false, error: err.message };
      }
    }

    saveState();
    return { success: true };
  }

  function disablePlugin(id) {
    const record = registry.get(id);
    if (!record) return { success: false, error: 'Plugin not found' };

    record.enabled = false;
    unloadPlugin(record);
    const pluginState = getPluginState(id);
    pluginState.enabled = false;
    saveState();
    return { success: true };
  }

  function reloadPlugin(id) {
    const record = registry.get(id);
    if (!record) return { success: false, error: 'Plugin not found' };

    unloadPlugin(record);
    try {
      loadPluginModule(record);
      record.enabled = true;
      record.error = null;
      record.loadedAt = new Date().toISOString();
      const pluginState = getPluginState(id);
      pluginState.enabled = true;
      pluginState.error = null;
      pluginState.lastLoaded = record.loadedAt;
      saveState();
      return { success: true };
    } catch (err) {
      record.error = err.message;
      const pluginState = getPluginState(id);
      pluginState.error = err.message;
      saveState();
      return { success: false, error: err.message };
    }
  }

  function hasHook(eventName) {
    for (const record of registry.values()) {
      if (record.enabled && record.hooks && typeof record.hooks[eventName] === 'function') {
        return true;
      }
    }
    return false;
  }

  function shutdown() {
    for (const record of registry.values()) {
      unloadPlugin(record);
    }
    registry.clear();
    log.info('Plugins', 'Manager shutdown complete');
  }

  function runHookSync(record, hook, payload) {
    try {
      const result = hook(payload, record.api);
      if (result && typeof result.then === 'function') {
        log.warn('Plugins', `Hook ${record.id} ${hook.name || 'anonymous'} returned Promise (ignored in sync hook)`);
        return null;
      }
      return result;
    } catch (err) {
      log.error('Plugins', `Hook ${record.id} failed: ${err.message}`);
      return null;
    }
  }

  function applyHookSync(eventName, payload) {
    let nextPayload = { ...payload };

    for (const record of registry.values()) {
      if (!record.enabled) continue;
      const hook = record.hooks?.[eventName];
      if (typeof hook !== 'function') continue;

      const result = runHookSync(record, hook, nextPayload);
      if (result && typeof result === 'object') {
        nextPayload = { ...nextPayload, ...result };
      }
    }

    return nextPayload;
  }

  async function runHookAsync(record, hook, payload) {
    const timeoutMs = Number(record.manifest.timeoutMs || DEFAULT_TIMEOUT_MS);
    let timeoutId = null;

    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Hook timeout (${timeoutMs}ms)`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([Promise.resolve(hook(payload, record.api)), timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async function dispatch(eventName, payload) {
    const tasks = [];
    for (const record of registry.values()) {
      if (!record.enabled) continue;
      const hook = record.hooks?.[eventName];
      if (typeof hook !== 'function') continue;
      tasks.push(
        runHookAsync(record, hook, payload).catch(err => {
          log.warn('Plugins', `Hook ${record.id} ${eventName} failed: ${err.message}`);
          return null;
        })
      );
    }
    return Promise.all(tasks);
  }

  async function runCommand(pluginId, commandId, args = {}) {
    const record = registry.get(pluginId);
    if (!record || !record.enabled) {
      return { success: false, error: 'Plugin not enabled' };
    }
    const command = record.commands.find(cmd => cmd.id === commandId);
    if (!command || typeof command.run !== 'function') {
      return { success: false, error: 'Command not found' };
    }

    try {
      const result = await runHookAsync(record, command.run, args);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return {
    loadAll,
    listPlugins,
    enablePlugin,
    disablePlugin,
    reloadPlugin,
    runCommand,
    dispatch,
    applyHookSync,
    hasHook,
    shutdown,
    getState: () => ({ ...state }),
  };
}

module.exports = { createPluginManager };
