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
  recentProjects: [],  // V3 J2: Recent projects list (max 10)
  stuckThreshold: 60000,  // V4: Auto-nudge after 60 seconds of no activity
  autoNudge: true,  // V4: Enable automatic stuck detection and nudging
};

let currentSettings = { ...DEFAULT_SETTINGS };

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

    // Detect Claude running state from output
    if (claudeRunning.get(paneId) === 'starting') {
      if (data.includes('Claude') || data.includes('>') || data.includes('claude')) {
        claudeRunning.set(paneId, 'running');
        broadcastClaudeState();
        console.log(`[Claude] Pane ${paneId} now running`);
      }
    }
  });

  daemonClient.on('exit', (paneId, code) => {
    recordSessionEnd(paneId);
    claudeRunning.set(paneId, 'idle');
    broadcastClaudeState();
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

  const connected = await daemonClient.connect();
  if (connected) {
    console.log('[Main] Successfully connected to terminal daemon');

    // V4: Auto-unstick timer - check for stuck terminals every 30 seconds
    if (currentSettings.autoNudge) {
      setInterval(() => {
        const now = Date.now();
        const threshold = currentSettings.stuckThreshold || 60000;

        for (const [paneId, status] of claudeRunning) {
          if (status === 'running') {
            const lastActivity = daemonClient.getLastActivity(paneId);
            if (lastActivity && (now - lastActivity) > threshold) {
              console.log(`[Auto-Unstick] Pane ${paneId} stuck for ${Math.round((now - lastActivity) / 1000)}s, sending ESC+Enter`);
              // Send ESC to cancel any pending input, then Enter to unstick
              daemonClient.write(paneId, '\x1b'); // ESC
              setTimeout(() => {
                daemonClient.write(paneId, '\r'); // Enter
              }, 100);
              // Notify UI
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('agent-unstuck', { paneId, after: now - lastActivity });
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
  watcher.init(mainWindow, triggers);
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
  });

  mainWindow.webContents.on('did-finish-load', async () => {
    watcher.startWatcher();
    const state = watcher.readState();
    mainWindow.webContents.send('state-changed', state);
    await initDaemonClient();
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

  if (daemonClient) {
    console.log('[Cleanup] Disconnecting from daemon (terminals will survive)');
    daemonClient.disconnect();
  }

  ipcHandlers.cleanupProcesses();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
