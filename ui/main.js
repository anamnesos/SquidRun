/**
 * Hivemind - Electron Main Process
 * Refactored to use modular architecture
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { getDaemonClient } = require('./daemon-client');
const { WORKSPACE_PATH } = require('./config');

// Import modules
const triggers = require('./modules/triggers');
const watcher = require('./modules/watcher');
const ipcHandlers = require('./modules/ipc-handlers');

const SETTINGS_FILE_PATH = path.join(__dirname, 'settings.json');
const USAGE_FILE_PATH = path.join(__dirname, 'usage-stats.json');

// Store main window reference
let mainWindow = null;

// Daemon client instance
let daemonClient = null;

// Track Claude running state per pane: 'idle' | 'starting' | 'running'
const claudeRunning = new Map([
  ['1', 'idle'],
  ['2', 'idle'],
  ['3', 'idle'],
  ['4', 'idle'],
]);

// ============================================================
// SETTINGS
// ============================================================

const DEFAULT_SETTINGS = {
  autoSpawn: false,
  autoSync: false,
  notifications: false,
  devTools: true,
  agentNotify: true,
  watcherEnabled: true,
  allowAllPermissions: false,
  costAlertEnabled: true,
  costAlertThreshold: 5.00,
  dryRun: false,  // V3: Simulate without spawning real Claude
  mcpAutoConfig: false,  // MC8: Auto-configure MCP on agent spawn (disabled by default)
  recentProjects: [],  // V3 J2: Recent projects list (max 10)
  stuckThreshold: 60000,  // V4: Auto-nudge after 60 seconds of no activity
  autoNudge: true,  // V4: Enable automatic stuck detection and nudging
  // V5 MP1: Per-pane project assignments
  paneProjects: { '1': null, '2': null, '3': null, '4': null },
  // V5 TM1: Saved templates
  templates: [],
};

let currentSettings = { ...DEFAULT_SETTINGS };

// ============================================================
// V7 OB1: ACTIVITY LOG AGGREGATION
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
    id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
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
    console.log(`[Activity] Saved ${activityLog.length} entries`);
  } catch (err) {
    console.error('[Activity] Error saving:', err.message);
  }
}

function loadActivityLog() {
  try {
    if (fs.existsSync(ACTIVITY_FILE_PATH)) {
      const content = fs.readFileSync(ACTIVITY_FILE_PATH, 'utf-8');
      const loaded = JSON.parse(content);
      activityLog.push(...loaded.slice(-MAX_ACTIVITY_ENTRIES));
      console.log(`[Activity] Loaded ${activityLog.length} entries`);
    }
  } catch (err) {
    console.error('[Activity] Error loading:', err.message);
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
    console.error('Error loading settings:', err);
    Object.assign(currentSettings, DEFAULT_SETTINGS);
  }
  return currentSettings;
}

function saveSettings(settings) {
  try {
    currentSettings = { ...currentSettings, ...settings };
    const tempPath = SETTINGS_FILE_PATH + '.tmp';
    const content = JSON.stringify(currentSettings, null, 2);
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, SETTINGS_FILE_PATH);
  } catch (err) {
    console.error('Error saving settings:', err);
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
  spawnsPerPane: { '1': 0, '2': 0, '3': 0, '4': 0 },
  totalSessionTimeMs: 0,
  sessionTimePerPane: { '1': 0, '2': 0, '3': 0, '4': 0 },
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
    console.error('Error loading usage stats:', err);
  }
}

function saveUsageStats() {
  try {
    const tempPath = USAGE_FILE_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(usageStats, null, 2), 'utf-8');
    fs.renameSync(tempPath, USAGE_FILE_PATH);
  } catch (err) {
    console.error('Error saving usage stats:', err);
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
// DAEMON CLIENT INITIALIZATION
// ============================================================

async function initDaemonClient() {
  daemonClient = getDaemonClient();

  // Update IPC handlers with daemon client
  ipcHandlers.setDaemonClient(daemonClient);

  // Set up event handlers for daemon events
  daemonClient.on('data', (paneId, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty-data-${paneId}`, data);
    }

    // V7 OB1: Log significant terminal output (errors, completions)
    if (data.includes('Error') || data.includes('error:') || data.includes('FAILED')) {
      logActivity('error', paneId, 'Terminal error detected', { snippet: data.substring(0, 200) });
    } else if (data.includes('✅') || data.includes('DONE') || data.includes('Complete')) {
      logActivity('terminal', paneId, 'Completion indicator detected', { snippet: data.substring(0, 100) });
    }

    // Detect Claude running state from output (works even if user typed claude manually)
    const currentState = claudeRunning.get(paneId);
    if (currentState === 'starting' || currentState === 'idle') {
      if (data.includes('Claude') || data.includes('>') || data.includes('claude')) {
        claudeRunning.set(paneId, 'running');
        broadcastClaudeState();
        logActivity('state', paneId, 'Claude started', { status: 'running' });
        console.log(`[Claude] Pane ${paneId} now running`);
      }
    }
  });

  daemonClient.on('exit', (paneId, code) => {
    recordSessionEnd(paneId);
    claudeRunning.set(paneId, 'idle');
    broadcastClaudeState();
    logActivity('state', paneId, `Session ended (exit code: ${code})`, { exitCode: code });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty-exit-${paneId}`, code);
    }
  });

  daemonClient.on('spawned', (paneId, pid) => {
    console.log(`[Daemon] Terminal spawned for pane ${paneId}, PID: ${pid}`);
  });

  daemonClient.on('connected', (terminals) => {
    console.log(`[Daemon] Connected. Existing terminals:`, terminals.length);

    if (terminals && terminals.length > 0) {
      for (const term of terminals) {
        if (term.alive) {
          claudeRunning.set(String(term.paneId), 'running');
          console.log(`[Daemon] Pane ${term.paneId} assumed running (reconnected)`);
        }
      }
      broadcastClaudeState();
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('daemon-connected', { terminals });
    }
  });

  daemonClient.on('disconnected', () => {
    console.log('[Daemon] Disconnected from daemon');
  });

  daemonClient.on('reconnected', () => {
    console.log('[Daemon] Reconnected to daemon');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('daemon-reconnected');
    }
  });

  daemonClient.on('error', (paneId, message) => {
    console.error(`[Daemon] Error for pane ${paneId}:`, message);
  });

  // V17: Forward heartbeat state changes to renderer
  daemonClient.on('heartbeat-state-changed', (state, interval, timestamp) => {
    console.log(`[Heartbeat] State changed: ${state} (${interval}ms)`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('heartbeat-state-changed', { state, interval });
    }
  });

  // V13: Forward watchdog alerts to renderer
  daemonClient.on('watchdog-alert', (message, timestamp) => {
    console.log(`[Watchdog] Alert: ${message}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('watchdog-alert', { message, timestamp });
    }
  });

  const connected = await daemonClient.connect();
  if (connected) {
    console.log('[Main] Successfully connected to terminal daemon');

    // V4: Auto-unstick timer - check for stuck terminals every 30 seconds
    // V16 FIX: REMOVED ESC sending - PTY ESC kills/interrupts agents!
    // We can only NOTIFY the user about stuck agents, not auto-fix them.
    // User keyboard ESC works to unstick, but programmatic PTY ESC breaks things.
    if (currentSettings.autoNudge) {
      setInterval(() => {
        const now = Date.now();
        const threshold = currentSettings.stuckThreshold || 60000;

        for (const [paneId, status] of claudeRunning) {
          if (status === 'running') {
            const lastActivity = daemonClient.getLastActivity(paneId);
            if (lastActivity && (now - lastActivity) > threshold) {
              console.log(`[Auto-Unstick] Pane ${paneId} stuck for ${Math.round((now - lastActivity) / 1000)}s - user intervention needed`);
              // V16 FIX: DO NOT send ESC via PTY - it kills agents!
              // Just notify UI so user can manually press ESC
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('agent-stuck-detected', {
                  paneId,
                  idleTime: now - lastActivity,
                  message: `Agent in pane ${paneId} appears stuck. Press ESC to unstick.`
                });
              }
            }
          }
        }
      }, 30000); // Check every 30 seconds
    }
  } else {
    console.error('[Main] Failed to connect to terminal daemon');
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

  mainWindow.loadFile('index.html');

  if (currentSettings.devTools) {
    mainWindow.webContents.openDevTools();
  }

  // Initialize modules with shared state
  triggers.init(mainWindow, claudeRunning);
  watcher.init(mainWindow, triggers, () => currentSettings); // V14: Pass settings getter for auto-sync control
  triggers.setWatcher(watcher); // Enable workflow gate

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
  });

  // Setup all IPC handlers
  ipcHandlers.setupIPCHandlers({
    loadSettings,
    saveSettings,
    recordSessionStart,
    recordSessionEnd,
    saveUsageStats,
    broadcastClaudeState,
    // V7 OB1: Activity log functions
    logActivity,
    getActivityLog,
    clearActivityLog,
    saveActivityLog,
  });

  mainWindow.webContents.on('did-finish-load', async () => {
    watcher.startWatcher();
    watcher.startMessageWatcher(); // V10 MQ4: Start message queue watcher
    const state = watcher.readState();
    mainWindow.webContents.send('state-changed', state);
    await initDaemonClient();
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
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  watcher.stopWatcher();
  watcher.stopMessageWatcher(); // V10 MQ4: Stop message queue watcher

  if (daemonClient) {
    console.log('[Cleanup] Disconnecting from daemon (terminals will survive)');
    daemonClient.disconnect();
  }

  ipcHandlers.cleanupProcesses();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
