/**
 * Application Context
 * Centralized state and dependency management for the main process
 */

class AppContext {
  constructor() {
    this.mainWindow = null;
    this.daemonClient = null;
    this.recoveryManager = null;
    this.pluginManager = null;
    this.backupManager = null;
    this.externalNotifier = null;
    this.contextInjection = null;
    this.firmwareManager = null;
    
    // Agent running state (renamed from claudeRunning - agents can be Claude, Codex, or Gemini)
    this.agentRunning = new Map([
      ['1', 'idle'],
      ['2', 'idle'],
      ['5', 'idle'],
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

  setContextInjection(manager) {
    this.contextInjection = manager;
  }

  setFirmwareManager(manager) {
    this.firmwareManager = manager;
  }
}

module.exports = new AppContext();
