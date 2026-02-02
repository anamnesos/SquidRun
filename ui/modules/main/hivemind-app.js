/**
 * Hivemind Application
 * Main process application controller
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('../logger');
const { getDaemonClient } = require('../../daemon-client');
const { WORKSPACE_PATH } = require('../../config');
const { createPluginManager } = require('../plugins');
const { createBackupManager } = require('../backup-manager');
const { createRecoveryManager } = require('../recovery-manager');
const { createExternalNotifier } = require('../external-notifications');
const { getSDKBridge } = require('../sdk-bridge');

// Import sub-modules
const triggers = require('../triggers');
const watcher = require('../watcher');
const ipcHandlers = require('../ipc-handlers');
const memory = require('../memory');
const memoryIPC = require('../memory/ipc-handlers');

class HivemindApp {
  constructor(appContext, managers) {
    this.ctx = appContext;
    this.settings = managers.settings;
    this.activity = managers.activity;
    this.usage = managers.usage;
    this.cliIdentity = managers.cliIdentity;
    this.contextInjection = managers.contextInjection;

    this.cliIdentityForwarderRegistered = false;
    this.triggerAckForwarderRegistered = false;
  }

  async init() {
    log.info('App', 'Initializing Hivemind Application');

    // 1. Load settings
    this.settings.loadSettings();

    // 2. Pre-configure Codex
    this.settings.ensureCodexConfig();

    // 3. Setup external notifications
    this.ctx.setExternalNotifier(createExternalNotifier({
      getSettings: () => this.ctx.currentSettings,
      log,
      appName: 'Hivemind',
    }));

    ipcHandlers.setExternalNotifier(this.ctx.externalNotifier);
    if (watcher && typeof watcher.setExternalNotifier === 'function') {
      watcher.setExternalNotifier((payload) => this.ctx.externalNotifier?.notify(payload));
    }

    // 4. Initial app status
    this.settings.writeAppStatus();

    // 5. Load activity log
    this.activity.loadActivityLog();

    // 6. Load usage stats
    this.usage.loadUsageStats();

    // 7. Initialize PTY daemon connection
    await this.initDaemonClient();

    // 8. Create main window
    await this.createWindow();

    // 9. Setup global IPC forwarders
    this.ensureCliIdentityForwarder();
    this.ensureTriggerDeliveryAckForwarder();

    log.info('App', 'Initialization complete');
  }

  async createWindow() {
    this.ctx.mainWindow = new BrowserWindow({
      width: 1400,
      height: 800,
      icon: path.join(__dirname, '..', '..', 'assets', 'hivemind-icon.svg'),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
      title: 'Hivemind',
    });

    this.setupPermissions();
    this.ctx.mainWindow.loadFile('index.html');

    if (this.ctx.currentSettings.devTools) {
      this.ctx.mainWindow.webContents.openDevTools();
    }

    this.initModules();
    this.setupWindowListeners();
  }

  setupPermissions() {
    session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {   
      const allowedPermissions = ['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write'];       
      const mediaTypes = details?.mediaTypes || [];
      if (allowedPermissions.includes(permission) || mediaTypes.includes('audio')) {
        return true;
      }
      return false;
    });

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowedPermissions = ['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write'];       
      if (allowedPermissions.includes(permission)) {
        callback(true);
      } else {
        callback(false);
      }
    });
  }

  initModules() {
    const window = this.ctx.mainWindow;

    // Triggers
    triggers.init(window, this.ctx.claudeRunning, (type, paneId, msg, details) =>
      this.activity.logActivity(type, paneId, msg, details));
    triggers.setWatcher(watcher);

    // Recovery
    this.ctx.setRecoveryManager(this.initRecoveryManager());
    triggers.setSelfHealing(this.ctx.recoveryManager);

    // Plugins
    this.ctx.setPluginManager(this.initPluginManager());
    triggers.setPluginManager(this.ctx.pluginManager);
    this.ctx.pluginManager.loadAll();

    // Backup
    this.ctx.setBackupManager(this.initBackupManager());

    // SDK Bridge
    const sdkBridge = getSDKBridge();
    sdkBridge.setMainWindow(window);
    triggers.setSDKBridge(sdkBridge);
    if (this.ctx.currentSettings.sdkMode) {
      triggers.setSDKMode(true);
    }

    // Watcher
    watcher.init(window, triggers, () => this.ctx.currentSettings);

    // IPC Handlers
    ipcHandlers.init({
      mainWindow: window,
      daemonClient: this.ctx.daemonClient,
      claudeRunning: this.ctx.claudeRunning,
      currentSettings: this.ctx.currentSettings,
      watcher,
      triggers,
      usageStats: this.ctx.usageStats,
      sessionStartTimes: this.ctx.sessionStartTimes,
      recoveryManager: this.ctx.recoveryManager,
      pluginManager: this.ctx.pluginManager,
      backupManager: this.ctx.backupManager,
      contextInjection: this.ctx.contextInjection,
    });

    ipcHandlers.setupIPCHandlers({
      loadSettings: () => this.settings.loadSettings(),
      saveSettings: (s) => this.settings.saveSettings(s),
      recordSessionStart: (id) => this.usage.recordSessionStart(id),
      recordSessionEnd: (id) => this.usage.recordSessionEnd(id),
      saveUsageStats: () => this.usage.saveUsageStats(),
      broadcastClaudeState: () => this.broadcastClaudeState(),
      logActivity: (t, p, m, d) => this.activity.logActivity(t, p, m, d),
      getActivityLog: (f) => this.activity.getActivityLog(f),
      clearActivityLog: () => this.activity.clearActivityLog(),
      saveActivityLog: () => this.activity.saveActivityLog(),
    });

    memoryIPC.registerHandlers({ mainWindow: window });
  }

  setupWindowListeners() {
    const window = this.ctx.mainWindow;

    window.webContents.on('did-finish-load', async () => {
      await this.initPostLoad();
    });

    window.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'Escape' && input.type === 'keyDown') {
        window.webContents.send('global-escape-pressed');
      }
    });

    window.webContents.on('console-message', (event, level, message) => {
      const logPath = path.join(WORKSPACE_PATH, 'console.log');
      const levelNames = ['verbose', 'info', 'warning', 'error'];
      const entry = `[${new Date().toISOString()}] [${levelNames[level] || level}] ${message}\n`;
      try {
        fs.appendFileSync(logPath, entry);
      } catch (err) {}
    });
  }

  async initPostLoad() {
    const window = this.ctx.mainWindow;

    const initAfterLoad = async (attempt = 1) => {
      try {
        memory.initialize();
        watcher.startWatcher();
        watcher.startTriggerWatcher();
        watcher.startMessageWatcher();

        const state = watcher.readState();
        if (window && !window.isDestroyed()) {
          window.webContents.send('state-changed', state);
        }

        // Connect if not already connected, or resend state if already connected
        if (this.ctx.daemonClient) {
          if (!this.ctx.daemonClient.connected) {
            await this.ctx.daemonClient.connect();
          } else {
            // Daemon already connected before renderer loaded - resend the event
            log.info('App', 'Resending daemon-connected to renderer (was connected before load)');
            const terminals = this.ctx.daemonClient.getTerminals?.() || [];
            window.webContents.send('daemon-connected', {
              terminals,
              sdkMode: this.ctx.currentSettings.sdkMode || false
            });
          }
        }
      } catch (err) {
        log.error('App', 'Post-load init failed', err);
        this.activity.logActivity('error', null, 'Post-load init failed', {
          attempt,
          error: err.message,
        });

        if (attempt < 3) {
          const delay = Math.min(2000 * attempt, 10000);
          setTimeout(() => initAfterLoad(attempt + 1), delay);
        }
      }
    };

    initAfterLoad();
  }

  initRecoveryManager() {
    return createRecoveryManager({
      getSettings: () => this.ctx.currentSettings,
      getLastActivity: paneId => this.ctx.daemonClient?.getLastActivity?.(paneId),
      getAllActivity: () => this.ctx.daemonClient?.getAllActivity?.() || {},
      getDaemonTerminals: () => this.ctx.daemonClient?.getTerminals?.() || [],
      isPaneRunning: paneId => this.ctx.claudeRunning.get(String(paneId)) === 'running',
      isCodexPane: paneId => {
        const cmd = this.ctx.currentSettings.paneCommands?.[String(paneId)] || '';
        return cmd.includes('codex');
      },
      requestRestart: (paneId, info = {}) => {
        if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          this.ctx.mainWindow.webContents.send('restart-pane', {
            paneId: String(paneId),
            source: 'recovery',
            ...info,
          });
        }
      },
      requestUnstick: (paneId, info = {}) => {
        if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          this.ctx.mainWindow.webContents.send('unstick-pane', {
            paneId: String(paneId),
            source: 'recovery',
            ...info,
          });
        }
      },
      beforeRestart: async (paneId, reason) => {
        if (this.ctx.daemonClient?.connected) {
          this.ctx.daemonClient.saveSession();
        }
        this.activity.logActivity('recovery', String(paneId), `Auto-restart requested (${reason})`, { reason }); 
      },
      resendTask: (paneId, message, meta = {}) => {
        if (triggers && typeof triggers.sendDirectMessage === 'function') {
          const recoveryMessage = `[RECOVERY] Resuming previous task\n${message}`;
          const result = triggers.sendDirectMessage([String(paneId)], recoveryMessage, 'Self-Healing');
          return Boolean(result && result.success);
        }
        if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          this.ctx.mainWindow.webContents.send('inject-message', {
            panes: [String(paneId)],
            message: `[RECOVERY] Resuming previous task\n${message}\r`,
            meta,
          });
          return true;
        }
        return false;
      },
      notifyEvent: (payload) => {
        const paneId = payload?.paneId ? String(payload.paneId) : 'system';
        this.activity.logActivity('recovery', paneId, payload?.message || 'Recovery event', payload);
        if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
          this.ctx.mainWindow.webContents.send('recovery-event', payload);
        }
      },
    });
  }

  initPluginManager() {
    return createPluginManager({
      workspacePath: WORKSPACE_PATH,
      getSettings: () => this.ctx.currentSettings,
      getState: () => watcher?.readState?.() || null,
      notifyAgents: (targets, message) => triggers.notifyAgents(targets, message),
      sendDirectMessage: (targets, message, fromRole) => triggers.sendDirectMessage(targets, message, fromRole), 

      broadcastMessage: (message) => triggers.broadcastToAllAgents(message),
      logActivity: (t, p, m, d) => this.activity.logActivity(t, p, m, d),
      getMainWindow: () => this.ctx.mainWindow,
    });
  }

  initBackupManager() {
    const manager = createBackupManager({
      workspacePath: WORKSPACE_PATH,
      repoRoot: path.join(WORKSPACE_PATH, '..'),
      logActivity: (t, p, m, d) => this.activity.logActivity(t, p, m, d),
    });
    manager.init();
    return manager;
  }

  async initDaemonClient() {
    this.ctx.daemonClient = getDaemonClient();

    // Update IPC handlers with daemon client
    ipcHandlers.setDaemonClient(this.ctx.daemonClient);

    this.ctx.daemonClient.on('data', (paneId, data) => {
      this.ctx.recoveryManager?.recordActivity(paneId);
      this.ctx.recoveryManager?.recordPtyOutput?.(paneId, data);

      if (this.ctx.pluginManager?.hasHook('daemon:data')) {
        this.ctx.pluginManager.dispatch('daemon:data', { paneId: String(paneId), data }).catch(() => {});        
      }

      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send(`pty-data-${paneId}`, data);
      }

      if (data.includes('Error') || data.includes('error:') || data.includes('FAILED')) {
        this.activity.logActivity('error', paneId, 'Terminal error detected', { snippet: data.substring(0, 200) }
);
      } else if (data.includes('✅') || data.includes('DONE') || data.includes('Complete')) {
        this.activity.logActivity('terminal', paneId, 'Completion indicator detected', { snippet: data.substring(
0, 100) });
      }

      const currentState = this.ctx.claudeRunning.get(paneId);
      if (currentState === 'starting' || currentState === 'idle') {
        const lower = data.toLowerCase();
        if (data.includes('>') || lower.includes('claude') || lower.includes('codex') || lower.includes('gemini')
) {
          this.ctx.claudeRunning.set(paneId, 'running');
          this.ctx.pluginManager?.dispatch('agent:stateChanged', { paneId: String(paneId), state: 'running' }).catch(() => {});
          this.broadcastClaudeState();
          this.activity.logActivity('state', paneId, 'Agent started', { status: 'running' });
          log.info('Agent', `Pane ${paneId} now running`);
        }
      }
    });

    this.ctx.daemonClient.on('exit', (paneId, code) => {
      this.ctx.recoveryManager?.handleExit(paneId, code);
      this.usage.recordSessionEnd(paneId);
      this.ctx.claudeRunning.set(paneId, 'idle');
      this.ctx.pluginManager?.dispatch('agent:stateChanged', { paneId: String(paneId), state: 'idle', exitCode: code }).catch(() => {});
      this.broadcastClaudeState();
      this.activity.logActivity('state', paneId, `Session ended (exit code: ${code})`, { exitCode: code });      
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send(`pty-exit-${paneId}`, code);
      }
    });

    this.ctx.daemonClient.on('spawned', (paneId, pid) => {
      log.info('Daemon', `Terminal spawned for pane ${paneId}, PID: ${pid}`);
      const command = this.cliIdentity.getPaneCommandForIdentity(String(paneId));
      this.cliIdentity.inferAndEmitCliIdentity(paneId, command);
      this.ctx.recoveryManager?.recordActivity(paneId);
    });

    this.ctx.daemonClient.on('connected', (terminals) => {
      log.info('Daemon', `Connected. Existing terminals: ${terminals.length}`);

      if (terminals && terminals.length > 0) {
        for (const term of terminals) {
          if (term.alive) {
            this.ctx.claudeRunning.set(String(term.paneId), 'running');
            const command = this.cliIdentity.getPaneCommandForIdentity(String(term.paneId));
            this.cliIdentity.inferAndEmitCliIdentity(term.paneId, command);
          }
        }
        this.broadcastClaudeState();
      }

      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('daemon-connected', {
          terminals,
          sdkMode: this.ctx.currentSettings.sdkMode || false
        });
      }
    });

    this.ctx.daemonClient.on('disconnected', () => log.warn('Daemon', 'Disconnected'));
    this.ctx.daemonClient.on('reconnected', () => {
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('daemon-reconnected');
      }
    });

    this.ctx.daemonClient.on('heartbeat-state-changed', (state, interval) => {
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('heartbeat-state-changed', { state, interval });
      }
    });

    this.ctx.daemonClient.on('watchdog-alert', (message, timestamp) => {
      log.warn('Watchdog', `Alert: ${message}`);
      if (this.ctx.externalNotifier && typeof this.ctx.externalNotifier.notify === 'function') {
        this.ctx.externalNotifier.notify({
          category: 'alert',
          title: 'Watchdog alert',
          message,
          meta: { timestamp },
        }).catch(() => {});
      }
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('watchdog-alert', { message, timestamp });
      }
    });

    this.ctx.daemonClient.on('codex-activity', (paneId, state, detail) => {
      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('codex-activity', { paneId, state, detail });
      }
      if (this.ctx.pluginManager?.hasHook('agent:activity')) {
        this.ctx.pluginManager.dispatch('agent:activity', { paneId: String(paneId), state, detail }).catch(() => 
{});
      }
    });

    this.ctx.daemonClient.on('agent-stuck-detected', (payload) => {
      const paneId = payload?.paneId;
      if (!paneId) return;
      const idleTime = payload?.idleMs || 0;
      this.ctx.recoveryManager?.handleStuck(paneId, idleTime, 'daemon-auto-nudge');

      if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
        this.ctx.mainWindow.webContents.send('agent-stuck-detected', {
          paneId,
          idleTime,
          message: payload?.message || `Agent in pane ${paneId} appears stuck.`,
        });
      }
    });

    return this.ctx.daemonClient.connect();
  }

  broadcastClaudeState() {
    if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
      this.ctx.mainWindow.webContents.send('claude-state-changed', Object.fromEntries(this.ctx.claudeRunning));  
    }
  }

  ensureCliIdentityForwarder() {
    if (this.cliIdentityForwarderRegistered) return;
    this.cliIdentityForwarderRegistered = true;
    ipcMain.on('pane-cli-identity', (event, data) => this.cliIdentity.emitPaneCliIdentity(data));
  }

  ensureTriggerDeliveryAckForwarder() {
    if (this.triggerAckForwarderRegistered) return;
    this.triggerAckForwarderRegistered = true;
    ipcMain.on('trigger-delivery-ack', (event, data) => {
      if (data?.deliveryId) triggers.handleDeliveryAck(data.deliveryId, data.paneId);
    });
  }

  shutdown() {
    log.info('App', 'Shutting down Hivemind Application');
    memory.shutdown();
    watcher.stopWatcher();
    watcher.stopTriggerWatcher();
    watcher.stopMessageWatcher();

    if (this.ctx.daemonClient) {
      this.ctx.daemonClient.disconnect();
    }

    const sdkBridge = getSDKBridge();
    if (sdkBridge.isActive()) {
      sdkBridge.stopSessions().catch(() => {});
    }

    ipcHandlers.cleanupProcesses();
  }
}

module.exports = HivemindApp;
