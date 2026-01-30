/**
 * Hivemind - Electron Main Process
 * Refactored to use modular architecture
 */

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { getDaemonClient } = require('./daemon-client');
const { WORKSPACE_PATH } = require('./config');
const log = require('./modules/logger');
const { createPluginManager } = require('./modules/plugins');
const { createBackupManager } = require('./modules/backup-manager');

// Import modules
const triggers = require('./modules/triggers');
const watcher = require('./modules/watcher');
const ipcHandlers = require('./modules/ipc-handlers');
const { getSDKBridge } = require('./modules/sdk-bridge');
const memory = require('./modules/memory');
const memoryIPC = require('./modules/memory/ipc-handlers');
const { createRecoveryManager } = require('./modules/recovery-manager');
const { createExternalNotifier } = require('./modules/external-notifications');

const SETTINGS_FILE_PATH = path.join(__dirname, 'settings.json');
const USAGE_FILE_PATH = path.join(__dirname, 'usage-stats.json');
const APP_STATUS_FILE_PATH = path.join(WORKSPACE_PATH, 'app-status.json');

// Store main window reference
let mainWindow = null;

// Daemon client instance
let daemonClient = null;
let recoveryManager = null;
let pluginManager = null;
let backupManager = null;
let externalNotifier = null;

// Track agent running state per pane: 'idle' | 'starting' | 'running'
const claudeRunning = new Map([
  ['1', 'idle'],
  ['2', 'idle'],
  ['3', 'idle'],
  ['4', 'idle'],
  ['5', 'idle'],
  ['6', 'idle'],
]);

// Track last CLI identity per pane to avoid duplicate UI updates
const paneCliIdentity = new Map();
const lastInterruptAt = new Map();

// Register IPC forwarder once
let cliIdentityForwarderRegistered = false;
let triggerAckForwarderRegistered = false;

// ============================================================
// SETTINGS
// ============================================================

const DEFAULT_SETTINGS = {
  autoSpawn: false,
  autoSync: false,
  notifications: false,
  externalNotificationsEnabled: false,
  notifyOnAlerts: true,
  notifyOnCompletions: true,
  slackWebhookUrl: '',
  discordWebhookUrl: '',
  emailNotificationsEnabled: false,
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: '',
  smtpPass: '',
  smtpFrom: '',
  smtpTo: '',
  devTools: true,
  agentNotify: true,
  watcherEnabled: true,
  allowAllPermissions: true,
  costAlertEnabled: true,
  costAlertThreshold: 5.00,
  dryRun: false,  // Simulate without spawning real agents
  mcpAutoConfig: false,  // MC8: Auto-configure MCP on agent spawn (disabled by default)
  recentProjects: [],  // Recent projects list (max 10)
  stuckThreshold: 120000,  // Auto-interrupt after 120 seconds of no output
  autoNudge: true,  // Enable automatic stuck detection and nudging
  // Per-pane project assignments
  paneProjects: { '1': null, '2': null, '3': null, '4': null, '5': null, '6': null },
  // Per-pane CLI command (PTY mode)
  paneCommands: {
    '1': 'claude',
    '2': 'codex',
    '3': 'claude',
    '4': 'codex',
    '5': 'codex',
    '6': 'claude',
  },
  // Saved templates
  templates: [],
  // Voice control
  voiceInputEnabled: false,
  voiceAutoSend: false,
  voiceLanguage: 'en-US',
  // SDK Mode: Use Claude Agent SDK instead of PTY terminals
  sdkMode: false,
};

let currentSettings = { ...DEFAULT_SETTINGS };

// ============================================================
// CODEX CONFIG BOOTSTRAP
// ============================================================

function ensureCodexConfig() {
  try {
    const codexDir = path.join(os.homedir(), '.codex');
    const configPath = path.join(codexDir, 'config.toml');

    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }

    let content = '';
    if (fs.existsSync(configPath)) {
      content = fs.readFileSync(configPath, 'utf-8');
    }

    // Ensure sandbox_mode = "workspace-write"
    const sandboxRegex = /(^|\r?\n)\s*sandbox_mode\s*=/;
    const sandboxLineRegex = /(^|\r?\n)(\s*sandbox_mode\s*=\s*)(["'][^"']*["'])/;
    if (!sandboxRegex.test(content)) {
      const needsNewline = content.length > 0 && !content.endsWith('\n');
      content += (needsNewline ? '\n' : '') + 'sandbox_mode = "danger-full-access"\n';
      log.info('Codex', 'Added sandbox_mode = "danger-full-access"');
    } else {
      content = content.replace(sandboxLineRegex, '$1$2"danger-full-access"');
      log.info('Codex', 'Updated sandbox_mode to "danger-full-access"');
    }

    // NOTE: approval_policy is NOT a valid config.toml key — use --full-auto CLI flag instead
    // (added via ipc-handlers.js spawn-claude when allowAllPermissions is true)

    fs.writeFileSync(configPath, content, 'utf-8');
  } catch (err) {
    log.error('Codex', 'Failed to ensure config.toml:', err.message);
  }
}

// ============================================================
// ACTIVITY LOG AGGREGATION
// ============================================================

const MAX_ACTIVITY_ENTRIES = 500;
const activityLog = [];

const ACTIVITY_FILE_PATH = path.join(WORKSPACE_PATH, 'activity.json');

/**
 * Log an activity event
 * @param {string} type - Event type: 'terminal', 'file', 'state', 'ipc', 'error', 'system'
 * @param {string} paneId - Pane ID or null for system events
 * @param {string} message - Event description
 * @param {object} details - Additional event data
 */
function logActivity(type, paneId, message, details = {}) {
  const entry = {
    id: `act-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    type,
    paneId,
    message,
    details,
  };

  activityLog.push(entry);

  // Keep only last MAX_ACTIVITY_ENTRIES
  if (activityLog.length > MAX_ACTIVITY_ENTRIES) {
    activityLog.shift();
  }

  // Notify renderer of new activity
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('activity-logged', entry);
  }

  if (pluginManager?.hasHook('activity:log')) {
    pluginManager.dispatch('activity:log', entry).catch(() => {});
  }

  if (externalNotifier && typeof externalNotifier.notify === 'function') {
    if (type === 'error') {
      externalNotifier.notify({
        category: 'alert',
        title: `Error detected${paneId ? ` (pane ${paneId})` : ''}`,
        message: details.snippet || message,
        meta: { paneId },
      }).catch(() => {});
    }

    if (type === 'terminal' && /completion/i.test(message)) {
      externalNotifier.notify({
        category: 'completion',
        title: `Completion detected${paneId ? ` (pane ${paneId})` : ''}`,
        message: details.snippet || message,
        meta: { paneId },
      }).catch(() => {});
    }
  }
}

function getActivityLog(filter = {}) {
  let filtered = [...activityLog];

  if (filter.type) {
    filtered = filtered.filter(e => e.type === filter.type);
  }
  if (filter.paneId) {
    filtered = filtered.filter(e => e.paneId === filter.paneId);
  }
  if (filter.since) {
    const sinceTime = new Date(filter.since).getTime();
    filtered = filtered.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
  }
  if (filter.search) {
    const searchLower = filter.search.toLowerCase();
    filtered = filtered.filter(e =>
      e.message.toLowerCase().includes(searchLower) ||
      JSON.stringify(e.details).toLowerCase().includes(searchLower)
    );
  }

  return filtered;
}

function clearActivityLog() {
  activityLog.length = 0;
}

function saveActivityLog() {
  try {
    const tempPath = ACTIVITY_FILE_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(activityLog, null, 2), 'utf-8');
    fs.renameSync(tempPath, ACTIVITY_FILE_PATH);
    log.info('Activity', `Saved ${activityLog.length} entries`);
  } catch (err) {
    log.error('Activity', 'Error saving', err.message);
  }
}

function loadActivityLog() {
  try {
    if (fs.existsSync(ACTIVITY_FILE_PATH)) {
      const content = fs.readFileSync(ACTIVITY_FILE_PATH, 'utf-8');
      const loaded = JSON.parse(content);
      activityLog.push(...loaded.slice(-MAX_ACTIVITY_ENTRIES));
      log.info('Activity', `Loaded ${activityLog.length} entries`);
    }
  } catch (err) {
    log.error('Activity', 'Error loading', err.message);
  }
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const content = fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8');
      // Use Object.assign to mutate existing object, preserving reference for ipc-handlers
      Object.assign(currentSettings, DEFAULT_SETTINGS, JSON.parse(content));
    }
  } catch (err) {
    log.error('Settings', 'Error loading settings', err);
    Object.assign(currentSettings, DEFAULT_SETTINGS);
  }
  return currentSettings;
}

// ============================================================
// SELF-HEALING RECOVERY MANAGER
// ============================================================

function initRecoveryManager() {
  if (recoveryManager) return recoveryManager;

  recoveryManager = createRecoveryManager({
    getSettings: () => currentSettings,
    getLastActivity: paneId => daemonClient?.getLastActivity?.(paneId),
    getAllActivity: () => daemonClient?.getAllActivity?.() || {},
    getDaemonTerminals: () => daemonClient?.getTerminals?.() || [],
    isPaneRunning: paneId => claudeRunning.get(String(paneId)) === 'running',
    isCodexPane: paneId => {
      const cmd = currentSettings.paneCommands?.[String(paneId)] || '';
      return cmd.includes('codex');
    },
    requestRestart: (paneId, info = {}) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('restart-pane', {
          paneId: String(paneId),
          source: 'recovery',
          ...info,
        });
      }
    },
    beforeRestart: async (paneId, reason) => {
      if (daemonClient?.connected) {
        daemonClient.saveSession();
      }
      logActivity('recovery', String(paneId), `Auto-restart requested (${reason})`, { reason });
    },
    resendTask: (paneId, message, meta = {}) => {
      if (triggers && typeof triggers.sendDirectMessage === 'function') {
        const recoveryMessage = `[RECOVERY] Resuming previous task\\n${message}`;
        const result = triggers.sendDirectMessage([String(paneId)], recoveryMessage, 'Self-Healing');
        return Boolean(result && result.success);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('inject-message', {
          panes: [String(paneId)],
          message: `[RECOVERY] Resuming previous task\\n${message}\\r`,
          meta,
        });
        return true;
      }
      return false;
    },
    notifyEvent: (payload) => {
      const paneId = payload?.paneId ? String(payload.paneId) : 'system';
      logActivity('recovery', paneId, payload?.message || 'Recovery event', payload);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recovery-event', payload);
      }
    },
  });

  return recoveryManager;
}

// ============================================================
// PLUGIN MANAGER
// ============================================================

function initPluginManager() {
  if (pluginManager) return pluginManager;

  pluginManager = createPluginManager({
    workspacePath: WORKSPACE_PATH,
    getSettings: () => currentSettings,
    getState: () => watcher?.readState?.() || null,
    notifyAgents: (targets, message) => triggers.notifyAgents(targets, message),
    sendDirectMessage: (targets, message, fromRole) => triggers.sendDirectMessage(targets, message, fromRole),
    broadcastMessage: (message) => triggers.broadcastToAllAgents(message),
    logActivity,
    getMainWindow: () => mainWindow,
  });

  return pluginManager;
}

// ============================================================
// BACKUP MANAGER
// ============================================================

function initBackupManager() {
  if (backupManager) return backupManager;

  backupManager = createBackupManager({
    workspacePath: WORKSPACE_PATH,
    repoRoot: path.join(WORKSPACE_PATH, '..'),
    logActivity,
  });

  backupManager.init();
  return backupManager;
}

// ============================================================
// APP STATUS FILE - For agents to know runtime state
// ============================================================

/**
 * Write app-status.json so agents can check runtime state without asking
 * Called on startup and when relevant settings change
 */
function writeAppStatus() {
  try {
    const status = {
      started: new Date().toISOString(),
      sdkMode: currentSettings.sdkMode || false,
      dryRun: currentSettings.dryRun || false,
      autoSpawn: currentSettings.autoSpawn || false,
      version: require('./package.json').version || 'unknown',
      platform: process.platform,
      nodeVersion: process.version,
      lastUpdated: new Date().toISOString(),
    };
    const tempPath = APP_STATUS_FILE_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(status, null, 2), 'utf-8');
    fs.renameSync(tempPath, APP_STATUS_FILE_PATH);
    log.info('App Status', `Written: ${status.sdkMode ? 'SDK mode' : 'PTY mode'}`);
  } catch (err) {
    log.error('App Status', 'Error writing', err.message);
  }
}

function saveSettings(settings) {
  try {
    // Track if SDK mode changed
    const sdkModeChanged = settings.sdkMode !== undefined && settings.sdkMode !== currentSettings.sdkMode;

    // Use Object.assign to mutate existing object, preserving reference for ipc-handlers
    Object.assign(currentSettings, settings);
    const tempPath = SETTINGS_FILE_PATH + '.tmp';
    const content = JSON.stringify(currentSettings, null, 2);
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, SETTINGS_FILE_PATH);

    // Update triggers SDK mode when setting changes
    if (sdkModeChanged) {
      triggers.setSDKMode(currentSettings.sdkMode);
      log.info('Settings', `SDK mode ${currentSettings.sdkMode ? 'ENABLED' : 'DISABLED'}`);
      // Update app-status.json so agents know the new mode
      writeAppStatus();
    }
  } catch (err) {
    log.error('Settings', 'Error saving settings', err);
    const tempPath = SETTINGS_FILE_PATH + '.tmp';
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }
  }
  return currentSettings;
}

// ============================================================
// USAGE TRACKING
// ============================================================

const sessionStartTimes = new Map();

let usageStats = {
  totalSpawns: 0,
  spawnsPerPane: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 },
  totalSessionTimeMs: 0,
  sessionTimePerPane: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 },
  sessionsToday: 0,
  lastResetDate: new Date().toISOString().split('T')[0],
  history: [],
};

function loadUsageStats() {
  try {
    if (fs.existsSync(USAGE_FILE_PATH)) {
      const content = fs.readFileSync(USAGE_FILE_PATH, 'utf-8');
      usageStats = { ...usageStats, ...JSON.parse(content) };
      const today = new Date().toISOString().split('T')[0];
      if (usageStats.lastResetDate !== today) {
        usageStats.sessionsToday = 0;
        usageStats.lastResetDate = today;
      }
    }
  } catch (err) {
    log.error('Usage', 'Error loading usage stats', err);
  }
}

function saveUsageStats() {
  try {
    const tempPath = USAGE_FILE_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(usageStats, null, 2), 'utf-8');
    fs.renameSync(tempPath, USAGE_FILE_PATH);
  } catch (err) {
    log.error('Usage', 'Error saving usage stats', err);
  }
}

function recordSessionStart(paneId) {
  sessionStartTimes.set(paneId, Date.now());
  usageStats.totalSpawns++;
  usageStats.spawnsPerPane[paneId] = (usageStats.spawnsPerPane[paneId] || 0) + 1;
  usageStats.sessionsToday++;
  saveUsageStats();
}

function recordSessionEnd(paneId) {
  const startTime = sessionStartTimes.get(paneId);
  if (startTime) {
    const duration = Date.now() - startTime;
    usageStats.totalSessionTimeMs += duration;
    usageStats.sessionTimePerPane[paneId] = (usageStats.sessionTimePerPane[paneId] || 0) + duration;

    usageStats.history.push({
      pane: paneId,
      duration,
      timestamp: new Date().toISOString(),
    });
    if (usageStats.history.length > 50) {
      usageStats.history = usageStats.history.slice(-50);
    }

    sessionStartTimes.delete(paneId);
    saveUsageStats();
  }
}

// Load stats on startup
loadUsageStats();

// ============================================================
// BROADCAST CLAUDE STATE
// ============================================================

function broadcastClaudeState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-state-changed', Object.fromEntries(claudeRunning));
  }
}

// ============================================================
// CLI IDENTITY BADGE
// ============================================================

function extractBaseCommand(command) {
  if (!command || typeof command !== 'string') return '';
  const trimmed = command.trim();
  if (!trimmed) return '';

  let token = trimmed;
  const firstChar = trimmed[0];
  if (firstChar === '"' || firstChar === "'") {
    const end = trimmed.indexOf(firstChar, 1);
    token = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  } else {
    const match = trimmed.match(/^\S+/);
    token = match ? match[0] : trimmed;
  }

  let base = path.basename(token).toLowerCase();
  if (base.endsWith('.exe')) {
    base = base.slice(0, -4);
  }
  return base;
}

function detectCliIdentity(command) {
  const base = extractBaseCommand(command);
  const normalized = (command || '').toLowerCase();
  if (!base && !normalized) return null;

  if (base.includes('claude') || normalized.includes('claude')) {
    return { label: 'Claude Code', provider: 'Anthropic' };
  }
  if (base.includes('codex') || normalized.includes('codex')) {
    return { label: 'Codex', provider: 'OpenAI' };
  }
  if (base.includes('gemini') || normalized.includes('gemini')) {
    return { label: 'Gemini', provider: 'Google' };
  }

  if (!base) return null;
  return { label: base };
}

function getPaneCommandForIdentity(paneId) {
  const paneCommands = (currentSettings && currentSettings.paneCommands) || DEFAULT_SETTINGS.paneCommands || {};
  let cmd = (paneCommands[paneId] || '').trim();
  if (!cmd) cmd = 'claude';
  return cmd;
}

function emitPaneCliIdentity(data) {
  if (!data) return;
  const paneId = data.paneId ? String(data.paneId) : '';
  if (!paneId) return;

  const payload = {
    paneId,
    label: data.label,
    provider: data.provider,
    version: data.version,
  };

  const prev = paneCliIdentity.get(paneId);
  if (prev &&
    prev.label === payload.label &&
    prev.provider === payload.provider &&
    prev.version === payload.version) {
    return;
  }

  paneCliIdentity.set(paneId, payload);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pane-cli-identity', payload);
  }
}

function inferAndEmitCliIdentity(paneId, command) {
  const identity = detectCliIdentity(command);
  if (!identity) return;
  emitPaneCliIdentity({ paneId, ...identity });
}

function ensureCliIdentityForwarder() {
  if (cliIdentityForwarderRegistered) return;
  cliIdentityForwarderRegistered = true;

  ipcMain.on('pane-cli-identity', (event, data) => {
    emitPaneCliIdentity(data);
  });
}

function ensureTriggerDeliveryAckForwarder() {
  if (triggerAckForwarderRegistered) return;
  triggerAckForwarderRegistered = true;

  ipcMain.on('trigger-delivery-ack', (event, data) => {
    if (!data || !data.deliveryId) return;
    triggers.handleDeliveryAck(data.deliveryId, data.paneId);
  });
}

// ============================================================
// DAEMON CLIENT INITIALIZATION
// ============================================================

async function initDaemonClient() {
  daemonClient = getDaemonClient();
  initRecoveryManager();
  initPluginManager();

  // Update IPC handlers with daemon client
  ipcHandlers.setDaemonClient(daemonClient);

  // Set up event handlers for daemon events
  daemonClient.on('data', (paneId, data) => {
    recoveryManager?.recordActivity(paneId);
    if (pluginManager?.hasHook('daemon:data')) {
      pluginManager.dispatch('daemon:data', { paneId: String(paneId), data }).catch(() => {});
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty-data-${paneId}`, data);
    }
    lastInterruptAt.delete(paneId);

    // Log significant terminal output (errors, completions)
    if (data.includes('Error') || data.includes('error:') || data.includes('FAILED')) {
      logActivity('error', paneId, 'Terminal error detected', { snippet: data.substring(0, 200) });
    } else if (data.includes('✅') || data.includes('DONE') || data.includes('Complete')) {
      logActivity('terminal', paneId, 'Completion indicator detected', { snippet: data.substring(0, 100) });
    }

    // Detect agent running state from output (works even if user typed CLI manually)
    const currentState = claudeRunning.get(paneId);
    if (currentState === 'starting' || currentState === 'idle') {
      const lower = data.toLowerCase();
      if (data.includes('>') || lower.includes('claude') || lower.includes('codex') || lower.includes('gemini')) {
        claudeRunning.set(paneId, 'running');
        pluginManager?.dispatch('agent:stateChanged', { paneId: String(paneId), state: 'running' }).catch(() => {});
        broadcastClaudeState();
        logActivity('state', paneId, 'Agent started', { status: 'running' });
        log.info('Agent', `Pane ${paneId} now running`);
      }
    }
  });

  daemonClient.on('exit', (paneId, code) => {
    recoveryManager?.handleExit(paneId, code);
    recordSessionEnd(paneId);
    claudeRunning.set(paneId, 'idle');
    pluginManager?.dispatch('agent:stateChanged', { paneId: String(paneId), state: 'idle', exitCode: code }).catch(() => {});
    broadcastClaudeState();
    logActivity('state', paneId, `Session ended (exit code: ${code})`, { exitCode: code });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty-exit-${paneId}`, code);
    }
  });

  daemonClient.on('spawned', (paneId, pid) => {
    log.info('Daemon', `Terminal spawned for pane ${paneId}, PID: ${pid}`);
    const command = getPaneCommandForIdentity(String(paneId));
    inferAndEmitCliIdentity(paneId, command);
    recoveryManager?.recordActivity(paneId);
  });

  daemonClient.on('connected', (terminals) => {
    log.info('Daemon', `Connected. Existing terminals: ${terminals.length}`);

    if (terminals && terminals.length > 0) {
      for (const term of terminals) {
        if (term.alive) {
          claudeRunning.set(String(term.paneId), 'running');
          log.info('Daemon', `Pane ${term.paneId} assumed running (reconnected)`);
          const command = getPaneCommandForIdentity(String(term.paneId));
          inferAndEmitCliIdentity(term.paneId, command);
        }
      }
      broadcastClaudeState();
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      // Include sdkMode in event so renderer can skip PTY terminals if SDK mode enabled
      mainWindow.webContents.send('daemon-connected', {
        terminals,
        sdkMode: currentSettings.sdkMode || false
      });
    }
  });

  daemonClient.on('disconnected', () => {
    log.warn('Daemon', 'Disconnected from daemon');
  });

  daemonClient.on('reconnected', () => {
    log.info('Daemon', 'Reconnected to daemon');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('daemon-reconnected');
    }
  });

  daemonClient.on('error', (paneId, message) => {
    log.error('Daemon', `Error for pane ${paneId}`, message);
  });

  // Forward heartbeat state changes to renderer
  daemonClient.on('heartbeat-state-changed', (state, interval, timestamp) => {
    log.info('Heartbeat', `State changed: ${state} (${interval}ms)`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('heartbeat-state-changed', { state, interval });
    }
  });

  // Forward watchdog alerts to renderer
  daemonClient.on('watchdog-alert', (message, timestamp) => {
    log.warn('Watchdog', `Alert: ${message}`);
    if (externalNotifier && typeof externalNotifier.notify === 'function') {
      externalNotifier.notify({
        category: 'alert',
        title: 'Watchdog alert',
        message,
        meta: { timestamp },
      }).catch(() => {});
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('watchdog-alert', { message, timestamp });
    }
  });

  // Forward Codex activity state changes to renderer
  daemonClient.on('codex-activity', (paneId, state, detail) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('codex-activity', { paneId, state, detail });
    }
    if (pluginManager?.hasHook('agent:activity')) {
      pluginManager.dispatch('agent:activity', { paneId: String(paneId), state, detail }).catch(() => {});
    }
  });

  const connected = await daemonClient.connect();
  if (connected) {
    log.info('Main', 'Successfully connected to terminal daemon');

    // Auto-unstick timer - check for stuck terminals every 30 seconds
    // Auto-send Ctrl+C after 120s of no output.
    if (currentSettings.autoNudge) {
      setInterval(() => {
        const now = Date.now();
        const threshold = currentSettings.stuckThreshold || 120000;

        for (const [paneId, status] of claudeRunning) {
          if (status === 'running') {
            const lastActivity = daemonClient.getLastActivity(paneId);
            if (lastActivity && (now - lastActivity) > threshold) {
              const idleTime = now - lastActivity;
              const lastInterrupt = lastInterruptAt.get(paneId) || 0;
              if (now - lastInterrupt >= threshold) {
                log.warn('Auto-Unstick', `Pane ${paneId} stuck for ${Math.round(idleTime / 1000)}s - sent Ctrl+C`);
                daemonClient.write(paneId, '\x03');
                lastInterruptAt.set(paneId, now);
                recoveryManager?.handleStuck(paneId, idleTime, 'auto-nudge');
              }
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('agent-stuck-detected', {
                  paneId,
                  idleTime,
                  message: `Agent in pane ${paneId} appears stuck. Ctrl+C sent automatically.`
                });
              }
              if (externalNotifier && typeof externalNotifier.notify === 'function') {
                externalNotifier.notify({
                  category: 'alert',
                  title: `Agent stuck (pane ${paneId})`,
                  message: `Idle for ${Math.round(idleTime / 1000)}s. Auto-interrupt sent.`,
                  meta: { paneId },
                }).catch(() => {});
              }
            }
          }
        }
      }, 30000); // Check every 30 seconds
    }
  } else {
    log.error('Main', 'Failed to connect to terminal daemon');
  }

  return connected;
}

// ============================================================
// WINDOW CREATION
// ============================================================

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    title: 'Hivemind',
  });

  // Allow microphone permission for SpeechRecognition (voice control) and clipboard for copy/paste
  // Need BOTH handlers: checkHandler for permission queries, requestHandler for grants
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const allowedPermissions = ['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write'];
    const mediaTypes = details?.mediaTypes || [];
    // Allow audio and clipboard permission checks
    if (allowedPermissions.includes(permission) || mediaTypes.includes('audio')) {
      log.debug('Main', `Permission check allowed: ${permission} (mediaTypes: ${mediaTypes.join(', ') || 'none'})`);
      return true;
    }
    log.warn('Main', `Permission check denied: ${permission}`);
    return false;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'audioCapture', 'clipboard-read', 'clipboard-sanitized-write'];
    if (allowedPermissions.includes(permission)) {
      log.info('Main', `Granted permission: ${permission}`);
      callback(true);
    } else {
      log.warn('Main', `Denied permission: ${permission}`);
      callback(false);
    }
  });

  mainWindow.loadFile('index.html');

  // Ensure pane-cli-identity forwarding is registered
  ensureCliIdentityForwarder();
  ensureTriggerDeliveryAckForwarder();

  if (currentSettings.devTools) {
    mainWindow.webContents.openDevTools();
  }

  // Initialize modules with shared state
  triggers.init(mainWindow, claudeRunning, logActivity);
  watcher.init(mainWindow, triggers, () => currentSettings); // Pass settings getter for auto-sync control
  triggers.setWatcher(watcher); // Enable workflow gate

  // Attach recovery manager for self-healing context preservation
  triggers.setSelfHealing(initRecoveryManager());

  // Initialize plugins and attach to triggers
  pluginManager = initPluginManager();
  triggers.setPluginManager(pluginManager);
  pluginManager.loadAll();

  // Initialize backup manager
  backupManager = initBackupManager();

  // Connect SDK bridge to triggers for message routing
  const sdkBridge = getSDKBridge();
  sdkBridge.setMainWindow(mainWindow);
  triggers.setSDKBridge(sdkBridge);
  // Set initial SDK mode from settings
  if (currentSettings.sdkMode) {
    triggers.setSDKMode(true);
    log.info('Main', 'SDK mode enabled from settings');
  }

  // Initialize IPC handlers
  ipcHandlers.init({
    mainWindow,
    daemonClient,
    claudeRunning,
    currentSettings,
    watcher,
    triggers,
    usageStats,
    sessionStartTimes,
    recoveryManager: initRecoveryManager(),
    pluginManager,
    backupManager,
  });

  // Setup all IPC handlers
  ipcHandlers.setupIPCHandlers({
    loadSettings,
    saveSettings,
    recordSessionStart,
    recordSessionEnd,
    saveUsageStats,
    broadcastClaudeState,
    // Activity log functions
    logActivity,
    getActivityLog,
    clearActivityLog,
    saveActivityLog,
  });

  // Setup memory system IPC handlers
  memoryIPC.registerHandlers({ mainWindow });

  mainWindow.webContents.on('did-finish-load', async () => {
    const initAfterLoad = async (attempt = 1) => {
      try {
        // Initialize memory system
        memory.initialize();

        watcher.startWatcher();
        watcher.startTriggerWatcher(); // UX-9: Fast trigger watcher (50ms polling)
        watcher.startMessageWatcher(); // Start message queue watcher
        const state = watcher.readState();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('state-changed', state);
        }
        await initDaemonClient();
      } catch (err) {
        log.error('Main', 'Post-load init failed', err);
        logActivity('error', null, 'Post-load init failed', {
          attempt,
          error: err.message,
        });

        if (attempt < 3) {
          const delay = Math.min(2000 * attempt, 10000);
          log.warn('Main', `Retrying post-load init in ${delay}ms (attempt ${attempt + 1})`);
          setTimeout(() => initAfterLoad(attempt + 1), delay);
        }
      }
    };

    initAfterLoad();
  });

  // ESC key interceptor - sends interrupt signal to focused terminal
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Escape' && input.type === 'keyDown') {
      mainWindow.webContents.send('global-escape-pressed');
    }
  });

  // Console log capture
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const logPath = path.join(WORKSPACE_PATH, 'console.log');
    const levelNames = ['verbose', 'info', 'warning', 'error'];
    const entry = `[${new Date().toISOString()}] [${levelNames[level] || level}] ${message}\n`;
    try {
      fs.appendFileSync(logPath, entry);
    } catch (err) {
      // Ignore write errors
    }
  });
}

// ============================================================
// APP LIFECYCLE
// ============================================================

app.whenReady().then(() => {
  // Load settings BEFORE createWindow so ipc-handlers gets the correct reference
  loadSettings();
  externalNotifier = createExternalNotifier({
    getSettings: () => currentSettings,
    log,
    appName: 'Hivemind',
  });
  ipcHandlers.setExternalNotifier(externalNotifier);
  if (watcher && typeof watcher.setExternalNotifier === 'function') {
    watcher.setExternalNotifier((payload) => externalNotifier?.notify(payload));
  }
  // Ensure Codex sandbox mode is preconfigured before any Codex spawn
  // NOTE: This relies on Codex honoring config.toml sandbox_mode values.
  ensureCodexConfig();
  // Write app status so agents can check runtime state without asking
  writeAppStatus();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Shutdown memory system - flush pending writes
  memory.shutdown();

  watcher.stopWatcher();
  watcher.stopTriggerWatcher(); // UX-9: Stop fast trigger watcher
  watcher.stopMessageWatcher(); // Stop message queue watcher

  if (daemonClient) {
    log.info('Cleanup', 'Disconnecting from daemon (terminals will survive)');
    daemonClient.disconnect();
  }

  // Stop SDK sessions and save session IDs for resume
  const sdkBridge = getSDKBridge();
  if (sdkBridge.isActive()) {
    log.info('Cleanup', 'Stopping SDK sessions and saving state');
    sdkBridge.stopSessions().catch(err => {
      log.error('Cleanup', 'SDK stop error', err);
    });
  }

  ipcHandlers.cleanupProcesses();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
