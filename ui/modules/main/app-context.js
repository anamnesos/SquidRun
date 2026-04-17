/**
 * Application Context
 * Centralized state and dependency management for the main process
 */

class AppContext {
  constructor() {
    this.mainWindow = null;
    this.windows = new Map();
    this.daemonClient = null;
    this.recoveryManager = null;
    this.pluginManager = null;
    this.backupManager = null;
    this.externalNotifier = null;
    this.firmwareManager = null;
    
    // Agent running state (renamed from claudeRunning - agents can be Claude, Codex, or Gemini)
    this.agentRunning = new Map([
      ['1', 'idle'],
      ['2', 'idle'],
      ['3', 'idle'],
    ]);
    // Backward compatibility alias
    this.claudeRunning = this.agentRunning;

    // CLI Identity
    this.paneCliIdentity = new Map();
    
    // Settings
    this.currentSettings = {};
    
    // Activity Log
    this.activityLog = [];
    
    // Usage Stats
    this.usageStats = {};
    this.sessionStartTimes = new Map();

    // Firmware pre-flight scan cache keyed by absolute target directory.
    this.preflightScanResults = {};
  }

  setMainWindow(window) {
    this.mainWindow = window;
    if (window) {
      this.windows.set('main', window);
    } else {
      this.windows.delete('main');
    }
  }

  setWindow(windowKey, window) {
    const key = String(windowKey || 'main').trim() || 'main';
    if (window) {
      this.windows.set(key, window);
    } else {
      this.windows.delete(key);
    }
    if (key === 'main') {
      this.mainWindow = window || null;
    }
    return window || null;
  }

  getWindow(windowKey = 'main') {
    const key = String(windowKey || 'main').trim() || 'main';
    if (key === 'main') {
      return this.mainWindow || this.windows.get('main') || null;
    }
    return this.windows.get(key) || null;
  }

  deleteWindow(windowKey = 'main') {
    const key = String(windowKey || 'main').trim() || 'main';
    this.windows.delete(key);
    if (key === 'main') {
      this.mainWindow = null;
    }
  }

  getWindows() {
    return new Map(this.windows);
  }

  setDaemonClient(client) {
    this.daemonClient = client;
  }

  setRecoveryManager(manager) {
    this.recoveryManager = manager;
  }

  setPluginManager(manager) {
    this.pluginManager = manager;
  }

  setBackupManager(manager) {
    this.backupManager = manager;
  }

  setExternalNotifier(notifier) {
    this.externalNotifier = notifier;
  }

  setFirmwareManager(manager) {
    this.firmwareManager = manager;
  }
}

module.exports = new AppContext();
