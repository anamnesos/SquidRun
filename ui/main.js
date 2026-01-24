const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const chokidar = require('chokidar');
const { getDaemonClient } = require('./daemon-client');

// Paths
const WORKSPACE_PATH = path.join(__dirname, '..', 'workspace');
const SHARED_CONTEXT_PATH = path.join(WORKSPACE_PATH, 'shared_context.md');
const STATE_FILE_PATH = path.join(WORKSPACE_PATH, 'state.json');
const SETTINGS_FILE_PATH = path.join(__dirname, 'settings.json');

// Store main window reference for IPC
let mainWindow = null;

// File watcher instance
let workspaceWatcher = null;

// Default settings
const DEFAULT_SETTINGS = {
  autoSpawn: false,
  autoSync: false,
  notifications: false,
  devTools: true,
  agentNotify: true,
  watcherEnabled: true,
  // Permissions
  allowAllPermissions: false,
  allowRead: false,
  allowWrite: false,
  allowBash: false,
  // Cost Alerts
  costAlertEnabled: true,
  costAlertThreshold: 5.00, // dollars
};

// Current settings
let currentSettings = { ...DEFAULT_SETTINGS };

// Load settings from file
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE_PATH)) {
      const content = fs.readFileSync(SETTINGS_FILE_PATH, 'utf-8');
      currentSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(content) };
    }
  } catch (err) {
    console.error('Error loading settings:', err);
    currentSettings = { ...DEFAULT_SETTINGS };
  }
  return currentSettings;
}

// Save settings to file (atomic write: temp file + rename)
function saveSettings(settings) {
  try {
    currentSettings = { ...currentSettings, ...settings };
    // Atomic write: write to temp file, then rename
    const tempPath = SETTINGS_FILE_PATH + '.tmp';
    const content = JSON.stringify(currentSettings, null, 2);
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, SETTINGS_FILE_PATH);
  } catch (err) {
    console.error('Error saving settings:', err);
    // Clean up temp file if rename failed
    const tempPath = SETTINGS_FILE_PATH + '.tmp';
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }
  }
  return currentSettings;
}

// Instance working directories (role injection)
const INSTANCE_DIRS = {
  '1': path.join(__dirname, '..', 'workspace', 'instances', 'lead'),
  '2': path.join(__dirname, '..', 'workspace', 'instances', 'worker-a'),
  '3': path.join(__dirname, '..', 'workspace', 'instances', 'worker-b'),
  '4': path.join(__dirname, '..', 'workspace', 'instances', 'reviewer'),
};

// Daemon client instance (connects to terminal daemon)
let daemonClient = null;

// Track Claude running state per pane: 'idle' | 'starting' | 'running'
const claudeRunning = new Map([
  ['1', 'idle'],
  ['2', 'idle'],
  ['3', 'idle'],
  ['4', 'idle'],
]);

// ============================================================
// USAGE TRACKING (Cost visibility)
// ============================================================

const USAGE_FILE_PATH = path.join(__dirname, 'usage-stats.json');

// Track session start times per pane
const sessionStartTimes = new Map();

// Usage statistics
let usageStats = {
  totalSpawns: 0,
  spawnsPerPane: { '1': 0, '2': 0, '3': 0, '4': 0 },
  totalSessionTimeMs: 0,
  sessionTimePerPane: { '1': 0, '2': 0, '3': 0, '4': 0 },
  sessionsToday: 0,
  lastResetDate: new Date().toISOString().split('T')[0],
  history: [], // Last 50 sessions
};

// Cost alert state (reset when app restarts or usage is reset)
let costAlertSent = false;

// Load usage stats from file
function loadUsageStats() {
  try {
    if (fs.existsSync(USAGE_FILE_PATH)) {
      const content = fs.readFileSync(USAGE_FILE_PATH, 'utf-8');
      usageStats = { ...usageStats, ...JSON.parse(content) };
      // Reset daily counter if new day
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

// Save usage stats to file (atomic write)
function saveUsageStats() {
  try {
    const tempPath = USAGE_FILE_PATH + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(usageStats, null, 2), 'utf-8');
    fs.renameSync(tempPath, USAGE_FILE_PATH);
  } catch (err) {
    console.error('Error saving usage stats:', err);
  }
}

// Record Claude session start
function recordSessionStart(paneId) {
  sessionStartTimes.set(paneId, Date.now());
  usageStats.totalSpawns++;
  usageStats.spawnsPerPane[paneId] = (usageStats.spawnsPerPane[paneId] || 0) + 1;
  usageStats.sessionsToday++;
  saveUsageStats();
}

// Record Claude session end
function recordSessionEnd(paneId) {
  const startTime = sessionStartTimes.get(paneId);
  if (startTime) {
    const duration = Date.now() - startTime;
    usageStats.totalSessionTimeMs += duration;
    usageStats.sessionTimePerPane[paneId] = (usageStats.sessionTimePerPane[paneId] || 0) + duration;

    // Add to history (keep last 50)
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

  // Always open DevTools for debugging
  mainWindow.webContents.openDevTools();

  // Start file watcher when window is ready
  mainWindow.webContents.on('did-finish-load', async () => {
    startWatcher();
    // Send initial state to renderer
    const state = readState();
    mainWindow.webContents.send('state-changed', state);

    // Connect to terminal daemon
    await initDaemonClient();
  });

  // QW-1: Console log capture - save renderer console to file for agents to read
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
// DAEMON CLIENT INITIALIZATION
// ============================================================

async function initDaemonClient() {
  daemonClient = getDaemonClient();

  // Set up event handlers for daemon events
  daemonClient.on('data', (paneId, data) => {
    // Forward terminal data to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`pty-data-${paneId}`, data);
    }

    // QW-2: Detect Claude running state from output
    if (claudeRunning.get(paneId) === 'starting') {
      if (data.includes('Claude') || data.includes('>') || data.includes('claude')) {
        claudeRunning.set(paneId, 'running');
        broadcastClaudeState();
        console.log(`[Claude] Pane ${paneId} now running`);
      }
    }
  });

  daemonClient.on('exit', (paneId, code) => {
    // Record session end for usage tracking
    recordSessionEnd(paneId);
    // Reset Claude state when terminal exits
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

    // For reconnected terminals, assume Claude is running
    // (if they were alive in daemon, Claude was likely running before restart)
    if (terminals && terminals.length > 0) {
      for (const term of terminals) {
        if (term.alive) {
          claudeRunning.set(String(term.paneId), 'running');
          console.log(`[Daemon] Pane ${term.paneId} assumed running (reconnected)`);
        }
      }
      broadcastClaudeState();
    }

    // Notify renderer about existing terminals
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

  // Connect to daemon (will spawn if not running)
  const connected = await daemonClient.connect();
  if (connected) {
    console.log('[Main] Successfully connected to terminal daemon');
  } else {
    console.error('[Main] Failed to connect to terminal daemon');
  }

  return connected;
}

// ============================================================
// PTY IPC HANDLERS (via Daemon)
// ============================================================

// Create a new pty process for a pane (via daemon)
ipcMain.handle('pty-create', async (event, paneId, workingDir) => {
  if (!daemonClient || !daemonClient.connected) {
    console.error('[pty-create] Daemon not connected');
    return { error: 'Daemon not connected' };
  }

  // Use role-specific instance directory if available
  const instanceDir = INSTANCE_DIRS[paneId];
  const cwd = instanceDir || workingDir || process.cwd();

  daemonClient.spawn(paneId, cwd);

  // Return immediately - spawned event will confirm
  return { paneId, cwd };
});

// Write data to pty (via daemon)
ipcMain.handle('pty-write', (event, paneId, data) => {
  if (daemonClient && daemonClient.connected) {
    daemonClient.write(paneId, data);
  }
});

// Resize pty (via daemon)
ipcMain.handle('pty-resize', (event, paneId, cols, rows) => {
  if (daemonClient && daemonClient.connected) {
    daemonClient.resize(paneId, cols, rows);
  }
});

// Kill pty process (via daemon)
ipcMain.handle('pty-kill', (event, paneId) => {
  if (daemonClient && daemonClient.connected) {
    daemonClient.kill(paneId);
  }
});

// Spawn claude in a pane - returns command for renderer to send via terminal.paste()
ipcMain.handle('spawn-claude', (event, paneId, workingDir) => {
  if (!daemonClient || !daemonClient.connected) {
    return { success: false, error: 'Daemon not connected' };
  }

  // Track state as starting
  claudeRunning.set(paneId, 'starting');
  broadcastClaudeState();

  // Record usage for cost tracking
  recordSessionStart(paneId);

  // Build claude command with permission flags
  let claudeCmd = 'claude';
  if (currentSettings.allowAllPermissions) {
    claudeCmd = 'claude --dangerously-skip-permissions';
  }

  // Return command - renderer will send it via terminal.paste() which works properly
  return { success: true, command: claudeCmd };
});

// Get Claude running state for all panes
ipcMain.handle('get-claude-state', () => {
  return Object.fromEntries(claudeRunning);
});

// Get list of existing terminals from daemon
ipcMain.handle('get-daemon-terminals', () => {
  if (daemonClient) {
    return daemonClient.getTerminals();
  }
  return [];
});

// Broadcast Claude state to renderer
function broadcastClaudeState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('claude-state-changed', Object.fromEntries(claudeRunning));
  }
}

// Read shared context file
ipcMain.handle('read-shared-context', () => {
  try {
    if (fs.existsSync(SHARED_CONTEXT_PATH)) {
      const content = fs.readFileSync(SHARED_CONTEXT_PATH, 'utf-8');
      return { success: true, content };
    }
    return { success: false, error: 'File not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Write to shared context file
ipcMain.handle('write-shared-context', (event, content) => {
  try {
    // Ensure directory exists
    const dir = path.dirname(SHARED_CONTEXT_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SHARED_CONTEXT_PATH, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get shared context path
ipcMain.handle('get-shared-context-path', () => {
  return SHARED_CONTEXT_PATH;
});

// ============================================================
// STATE MACHINE
// ============================================================

// State enum
const States = {
  IDLE: 'idle',
  PROJECT_SELECTED: 'project_selected',
  PLANNING: 'planning',
  PLAN_REVIEW: 'plan_review',
  PLAN_REVISION: 'plan_revision',
  EXECUTING: 'executing',
  CHECKPOINT: 'checkpoint',
  CHECKPOINT_REVIEW: 'checkpoint_review',
  CHECKPOINT_FIX: 'checkpoint_fix',
  FRICTION_LOGGED: 'friction_logged',
  FRICTION_SYNC: 'friction_sync',
  FRICTION_RESOLUTION: 'friction_resolution',
  COMPLETE: 'complete',
  ERROR: 'error',
  PAUSED: 'paused',
};

// Active agents per state (pane IDs: 1=Lead, 2=WorkerA, 3=WorkerB, 4=Reviewer)
const ACTIVE_AGENTS = {
  [States.IDLE]: [],
  [States.PROJECT_SELECTED]: ['1'],
  [States.PLANNING]: ['1'],
  [States.PLAN_REVIEW]: ['4'],
  [States.PLAN_REVISION]: ['1'],
  [States.EXECUTING]: ['2', '3'],
  [States.CHECKPOINT]: [],
  [States.CHECKPOINT_REVIEW]: ['4'],
  [States.CHECKPOINT_FIX]: ['1', '2', '3'],
  [States.FRICTION_LOGGED]: [],
  [States.FRICTION_SYNC]: [],
  [States.FRICTION_RESOLUTION]: ['1'],
  [States.COMPLETE]: [],
  [States.ERROR]: [],
  [States.PAUSED]: [],
};

// Context messages for agents when state changes
const CONTEXT_MESSAGES = {
  [States.PLAN_REVIEW]: '[HIVEMIND] Plan submitted. Please review workspace/plan.md and write either plan-approved.md or plan-feedback.md',
  [States.PLAN_REVISION]: '[HIVEMIND] Revision requested. Please read workspace/plan-feedback.md and update plan.md accordingly.',
  [States.EXECUTING]: '[HIVEMIND] Plan approved. Begin implementation. Write to checkpoint.md when you reach a checkpoint.',
  [States.CHECKPOINT_REVIEW]: '[HIVEMIND] Checkpoint reached. Please review the work and write checkpoint-approved.md or checkpoint-issues.md',
  [States.CHECKPOINT_FIX]: '[HIVEMIND] Issues found at checkpoint. Please read checkpoint-issues.md and address the problems.',
  [States.FRICTION_RESOLUTION]: '[HIVEMIND] Friction logged. Please read workspace/friction/ and propose fixes in friction-resolution.md',
  [States.COMPLETE]: '[HIVEMIND] Task complete! All work has been reviewed and approved.',
};

// ============================================================
// CONFLICT DETECTION
// ============================================================
let lastConflicts = [];

function extractFilePaths(text) {
  const files = new Set();
  const patterns = [/`([^`]+\.(js|ts|html|css|json|md))`/gi, /(ui\/\S+\.(js|html|css))/gi];
  for (const p of patterns) { let m; while ((m = p.exec(text))) files.add(m[1].toLowerCase()); }
  return [...files];
}

function parseWorkerAssignments() {
  try {
    if (!fs.existsSync(SHARED_CONTEXT_PATH)) return {};
    const c = fs.readFileSync(SHARED_CONTEXT_PATH, 'utf-8');
    const a = {};
    const wA = c.match(/### Worker A[\s\S]*?(?=###|$)/i);
    const wB = c.match(/### Worker B[\s\S]*?(?=###|$)/i);
    if (wA) a['Worker A'] = extractFilePaths(wA[0]);
    if (wB) a['Worker B'] = extractFilePaths(wB[0]);
    return a;
  } catch (e) { return {}; }
}

function checkFileConflicts() {
  const a = parseWorkerAssignments();
  const conflicts = [];
  const fA = a['Worker A'] || [], fB = a['Worker B'] || [];
  for (const f of fA) if (fB.includes(f)) conflicts.push({ file: f, workers: ['A', 'B'] });
  lastConflicts = conflicts;
  if (conflicts.length && mainWindow && !mainWindow.isDestroyed()) {
    console.warn('[Conflict]', conflicts.map(c => c.file));
    mainWindow.webContents.send('file-conflicts-detected', conflicts);
  }
  return conflicts;
}

ipcMain.handle('get-file-conflicts', () => lastConflicts);
ipcMain.handle('check-file-conflicts', () => checkFileConflicts());

// Read state from state.json
function readState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const content = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.error('Error reading state:', err);
  }
  // Return default state
  return {
    state: States.IDLE,
    previous_state: null,
    active_agents: [],
    timestamp: new Date().toISOString(),
    project: null,
    current_checkpoint: 0,
    total_checkpoints: 0,
    friction_count: 0,
    error: null,
  };
}

// Write state to state.json (atomic write: temp file + rename)
function writeState(state) {
  try {
    const dir = path.dirname(STATE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Atomic write: write to temp file, then rename
    // This prevents corruption if process crashes mid-write
    const tempPath = STATE_FILE_PATH + '.tmp';
    const content = JSON.stringify(state, null, 2);
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, STATE_FILE_PATH);
  } catch (err) {
    console.error('Error writing state:', err);
    // Clean up temp file if rename failed
    const tempPath = STATE_FILE_PATH + '.tmp';
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }
  }
}

// Transition to a new state
function transition(newState) {
  const state = readState();
  const oldState = state.state;

  // Don't transition to same state
  if (oldState === newState) return;

  state.previous_state = oldState;
  state.state = newState;
  state.active_agents = ACTIVE_AGENTS[newState] || [];
  state.timestamp = new Date().toISOString();

  writeState(state);
  console.log(`[State Machine] ${oldState} → ${newState}`);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state-changed', state);
  }

  // Notify active agents
  notifyAgents(state.active_agents, newState);
}

// Send context message to active agents
// NOTE: Only works when Claude is running in terminal, not raw shell
function notifyAgents(agents, newState) {
  const message = CONTEXT_MESSAGES[newState];
  if (!message) return;

  // QW-3: Only send to panes where Claude is confirmed running
  const notified = [];
  for (const paneId of agents) {
    if (claudeRunning.get(paneId) === 'running') {
      notified.push(paneId);
    }
  }

  if (notified.length > 0) {
    console.log(`[notifyAgents] Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: notified, message: message + '\r' });
    }
  } else {
    console.log(`[notifyAgents] Skipped (no Claude running): ${agents.join(', ')}`);
  }
}

// AUTO-SYNC: Notify ALL agents when trigger files change
// This enables the autonomous improvement loop
function notifyAllAgentsSync(triggerFile) {
  const message = `[HIVEMIND SYNC] ${triggerFile} was updated. Read workspace/${triggerFile} and respond.`;

  // Get list of running Claude panes
  const runningPanes = [];
  for (const [paneId, status] of claudeRunning) {
    if (status === 'running') {
      runningPanes.push(paneId);
    }
  }

  if (runningPanes.length > 0) {
    console.log(`[AUTO-SYNC] Notifying panes ${runningPanes.join(', ')}: ${triggerFile} changed`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: runningPanes, message: message + '\r' });
    }
  } else {
    console.log(`[AUTO-SYNC] No Claude instances running to notify about ${triggerFile}`);
  }

  // Also notify renderer for UI update
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-triggered', { file: triggerFile, notified: runningPanes });
  }
}

// TARGETED TRIGGERS: Map trigger filenames to pane IDs
const TRIGGER_TARGETS = {
  'lead.txt': ['1'],
  'worker-a.txt': ['2'],
  'worker-b.txt': ['3'],
  'reviewer.txt': ['4'],
  'workers.txt': ['2', '3'],
  'all.txt': ['1', '2', '3', '4'],
};

// Handle trigger file changes - sends content to target pane(s)
function handleTriggerFile(filePath, filename) {
  const targets = TRIGGER_TARGETS[filename];
  if (!targets) {
    console.log(`[Trigger] Unknown trigger file: ${filename}`);
    return;
  }

  // Read trigger file content
  let message;
  try {
    message = fs.readFileSync(filePath, 'utf-8').trim();
  } catch (err) {
    console.log(`[Trigger] Could not read ${filename}: ${err.message}`);
    return;
  }

  if (!message) {
    console.log(`[Trigger] Empty trigger file: ${filename}`);
    return;
  }

  // Filter to only running Claude instances
  const runningTargets = targets.filter(paneId => claudeRunning.get(paneId) === 'running');

  if (runningTargets.length > 0) {
    console.log(`[Trigger] ${filename} → panes ${runningTargets.join(', ')}: ${message.substring(0, 50)}...`);
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: runningTargets, message: message + '\r' });
    }

    // Clear the trigger file after sending
    try {
      fs.writeFileSync(filePath, '', 'utf-8');
    } catch (err) {
      console.log(`[Trigger] Could not clear ${filename}: ${err.message}`);
    }
  } else {
    console.log(`[Trigger] No running Claude in target panes for ${filename}`);
  }
}

// BROADCAST: Send message to ALL panes with clear broadcast indicator
// Use this for user broadcasts so agents know it's going to everyone
function broadcastToAllAgents(message) {
  const broadcastMessage = `[BROADCAST TO ALL AGENTS] ${message}`;

  // Get list of running Claude panes
  const notified = [];
  for (const [paneId, status] of claudeRunning) {
    if (status === 'running') {
      notified.push(paneId);
    }
  }

  if (notified.length > 0) {
    // Send to renderer which uses terminal.paste() for proper execution
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', { panes: notified, message: broadcastMessage + '\r' });
    }
  }

  console.log(`[BROADCAST] Sent to panes ${notified.join(', ')}: ${message.substring(0, 50)}...`);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('broadcast-sent', { message, notified });
  }

  return { success: true, notified };
}

// Handle file changes in workspace
function handleFileChange(filePath) {
  const filename = path.basename(filePath);
  const state = readState();
  const currentState = state.state;

  console.log(`[Watcher] File changed: ${filename} (current state: ${currentState})`);

  // Transition logic based on file + current state
  if (filename === 'plan.md' && currentState === States.PLANNING) {
    transition(States.PLAN_REVIEW);
  }
  else if (filename === 'plan-approved.md' && currentState === States.PLAN_REVIEW) {
    // Check for file conflicts before executing
    const conflicts = checkFileConflicts();
    if (conflicts.length > 0) {
      console.warn('[Transition] Proceeding to EXECUTING with file conflicts');
    }
    transition(States.EXECUTING);
  }
  else if (filename === 'plan-feedback.md' && currentState === States.PLAN_REVIEW) {
    transition(States.PLAN_REVISION);
  }
  else if (filename === 'plan.md' && currentState === States.PLAN_REVISION) {
    transition(States.PLAN_REVIEW);
  }
  else if (filename === 'checkpoint.md' && currentState === States.EXECUTING) {
    transition(States.CHECKPOINT);
    // Auto-advance to review
    setTimeout(() => transition(States.CHECKPOINT_REVIEW), 500);
  }
  else if (filename === 'checkpoint-approved.md' && currentState === States.CHECKPOINT_REVIEW) {
    // Check if there's more work or complete
    const checkpointContent = fs.readFileSync(filePath, 'utf-8').toLowerCase();
    if (checkpointContent.includes('complete') || checkpointContent.includes('done')) {
      transition(States.COMPLETE);
    } else {
      transition(States.EXECUTING);
    }
  }
  else if (filename === 'checkpoint-issues.md' && currentState === States.CHECKPOINT_REVIEW) {
    transition(States.CHECKPOINT_FIX);
  }
  else if (filename === 'checkpoint.md' && currentState === States.CHECKPOINT_FIX) {
    transition(States.CHECKPOINT_REVIEW);
  }
  else if (filename.endsWith('.md') && filePath.includes('friction')) {
    // Any file in friction/ directory
    if (currentState !== States.FRICTION_LOGGED &&
        currentState !== States.FRICTION_SYNC &&
        currentState !== States.FRICTION_RESOLUTION) {
      const updatedState = readState();
      updatedState.friction_count = (updatedState.friction_count || 0) + 1;
      writeState(updatedState);
      transition(States.FRICTION_LOGGED);
      setTimeout(() => transition(States.FRICTION_SYNC), 500);
    }
  }
  else if (filename === 'friction-resolution.md' && currentState === States.FRICTION_RESOLUTION) {
    transition(States.PLAN_REVIEW);
  }

  // AUTO-SYNC TRIGGERS: These files notify ALL agents when changed
  // This enables the autonomous improvement loop
  else if (filename === 'improvements.md') {
    console.log('[Watcher] Improvements file changed - triggering auto-sync to all agents');
    notifyAllAgentsSync('improvements.md');
  }
  else if (filename === 'shared_context.md') {
    console.log('[Watcher] Shared context changed - triggering auto-sync to all agents');
    notifyAllAgentsSync('shared_context.md');
  }

  // TARGETED TRIGGERS: workspace/triggers/{target}.txt
  else if (filePath.includes('triggers') && filename.endsWith('.txt')) {
    handleTriggerFile(filePath, filename);
  }
}

// Start watching workspace
function startWatcher() {
  if (workspaceWatcher) {
    workspaceWatcher.close();
  }

  workspaceWatcher = chokidar.watch(WORKSPACE_PATH, {
    ignoreInitial: true,
    persistent: true,
    ignored: [
      /node_modules/,
      /\.git/,
      /instances\//,  // Ignore instance directories
      /state\.json$/,  // Don't watch state.json (we write to it)
    ],
  });

  workspaceWatcher.on('add', handleFileChange);
  workspaceWatcher.on('change', handleFileChange);

  console.log(`[Watcher] Watching ${WORKSPACE_PATH}`);
}

// Stop watching
function stopWatcher() {
  if (workspaceWatcher) {
    workspaceWatcher.close();
    workspaceWatcher = null;
  }
}

// IPC handlers for state
ipcMain.handle('get-state', () => {
  return readState();
});

ipcMain.handle('set-state', (event, newState) => {
  transition(newState);
  return readState();
});

// Manual sync trigger - broadcasts to all agents
ipcMain.handle('trigger-sync', (event, file = 'shared_context.md') => {
  notifyAllAgentsSync(file);
  return { success: true, file };
});

// Broadcast custom message to all agents with [BROADCAST] prefix
ipcMain.handle('broadcast-message', (event, message) => {
  // Use the dedicated broadcast function with clear indicator
  return broadcastToAllAgents(message);
});

// Legacy broadcast (kept for compatibility) - will be removed
ipcMain.handle('broadcast-message-raw', (event, message) => {
  const notified = [];
  for (const [paneId, status] of claudeRunning) {
    if (status === 'running') {
      if (daemonClient && daemonClient.connected) {
        daemonClient.write(paneId, message + '\n');
        notified.push(paneId);
      }
    }
  }
  return { success: true, notified };
});

ipcMain.handle('start-planning', (event, project) => {
  const state = readState();
  state.project = project;
  writeState(state);
  transition(States.PLANNING);
  return readState();
});

// Settings IPC handlers
ipcMain.handle('get-settings', () => {
  return loadSettings();
});

ipcMain.handle('set-setting', (event, key, value) => {
  const settings = loadSettings();
  settings[key] = value;
  saveSettings(settings);

  // Handle side effects
  if (key === 'watcherEnabled') {
    if (value) {
      startWatcher();
    } else {
      stopWatcher();
    }
  }

  return settings;
});

ipcMain.handle('get-all-settings', () => {
  return loadSettings();
});

// ============================================================
// PROJECT/FOLDER PICKER
// ============================================================

// Current project path
let currentProjectPath = null;

// Select project folder
ipcMain.handle('select-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  const projectPath = result.filePaths[0];
  currentProjectPath = projectPath;

  // Update state with project
  const state = readState();
  state.project = projectPath;
  writeState(state);

  // Transition to project_selected state
  transition(States.PROJECT_SELECTED);

  // Notify renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('project-changed', projectPath);
  }

  return { success: true, path: projectPath };
});

// Get current project path
ipcMain.handle('get-project', () => {
  const state = readState();
  return state.project || null;
});

// ============================================================
// FRICTION PANEL
// ============================================================

const FRICTION_DIR = path.join(WORKSPACE_PATH, 'friction');
const SCREENSHOTS_DIR = path.join(WORKSPACE_PATH, 'screenshots');

// List friction files
ipcMain.handle('list-friction', () => {
  try {
    // Ensure friction directory exists
    if (!fs.existsSync(FRICTION_DIR)) {
      fs.mkdirSync(FRICTION_DIR, { recursive: true });
      return { success: true, files: [] };
    }

    const files = fs.readdirSync(FRICTION_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = path.join(FRICTION_DIR, f);
        const stats = fs.statSync(filePath);
        return {
          name: f,
          path: filePath,
          modified: stats.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));

    return { success: true, files };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Read friction file
ipcMain.handle('read-friction', (event, filename) => {
  try {
    const filePath = path.join(FRICTION_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Delete friction file
ipcMain.handle('delete-friction', (event, filename) => {
  try {
    const filePath = path.join(FRICTION_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Clear all friction files
ipcMain.handle('clear-friction', () => {
  try {
    if (fs.existsSync(FRICTION_DIR)) {
      const files = fs.readdirSync(FRICTION_DIR).filter(f => f.endsWith('.md'));
      for (const f of files) {
        fs.unlinkSync(path.join(FRICTION_DIR, f));
      }
    }
    // Reset friction count in state
    const state = readState();
    state.friction_count = 0;
    writeState(state);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// SCREENSHOTS
// ============================================================

// Save screenshot from base64 data
ipcMain.handle('save-screenshot', (event, base64Data, originalName) => {
  try {
    // Ensure screenshots directory exists
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    // Generate timestamp-based filename
    const timestamp = Date.now();
    const ext = originalName ? path.extname(originalName) || '.png' : '.png';
    const filename = `screenshot-${timestamp}${ext}`;
    const filePath = path.join(SCREENSHOTS_DIR, filename);

    // Remove data URL prefix if present (e.g., "data:image/png;base64,")
    const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');

    // Write file
    const buffer = Buffer.from(base64Content, 'base64');
    fs.writeFileSync(filePath, buffer);

    // Also save as latest.png so agents have a known path
    const latestPath = path.join(SCREENSHOTS_DIR, 'latest.png');
    fs.writeFileSync(latestPath, buffer);

    // Update index.md for agents to read
    const indexPath = path.join(SCREENSHOTS_DIR, 'index.md');
    const entry = `- **${new Date().toISOString()}**: \`${filename}\` → To view: read \`workspace/screenshots/latest.png\`\n`;
    fs.appendFileSync(indexPath, entry);

    // Notify agents via state change that new screenshot is available
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('screenshot-added', { filename, path: filePath });
    }

    return { success: true, filename, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// List all screenshots
ipcMain.handle('list-screenshots', () => {
  try {
    // Ensure screenshots directory exists
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      return { success: true, files: [] };
    }

    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    const files = fs.readdirSync(SCREENSHOTS_DIR)
      .filter(f => imageExts.includes(path.extname(f).toLowerCase()))
      .map(f => {
        const filePath = path.join(SCREENSHOTS_DIR, f);
        const stats = fs.statSync(filePath);
        return {
          name: f,
          path: filePath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));

    return { success: true, files };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Delete a screenshot
ipcMain.handle('delete-screenshot', (event, filename) => {
  try {
    const filePath = path.join(SCREENSHOTS_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get full path for a screenshot (for agent reference)
ipcMain.handle('get-screenshot-path', (event, filename) => {
  const filePath = path.join(SCREENSHOTS_DIR, filename);
  return { path: filePath, exists: fs.existsSync(filePath) };
});

// ============================================================
// BACKGROUND PROCESSES
// ============================================================

const { spawn } = require('child_process');

// Track spawned background processes
// Map<id, { process, command, args, cwd, startTime, status }>
const backgroundProcesses = new Map();
let processIdCounter = 1;

// Spawn a background process
ipcMain.handle('spawn-process', (event, command, args = [], cwd = null) => {
  try {
    const id = `proc-${processIdCounter++}`;
    const workDir = cwd || process.cwd();

    // On Windows, use shell for commands like npm, npx, etc.
    const isWindows = os.platform() === 'win32';
    const spawnOptions = {
      cwd: workDir,
      shell: isWindows,
      env: process.env,
    };

    const proc = spawn(command, args, spawnOptions);

    const processInfo = {
      id,
      command,
      args,
      cwd: workDir,
      pid: proc.pid,
      startTime: new Date().toISOString(),
      status: 'running',
      output: [],
    };

    // Capture output (last 100 lines)
    const captureOutput = (data) => {
      const lines = data.toString().split('\n');
      processInfo.output.push(...lines);
      if (processInfo.output.length > 100) {
        processInfo.output = processInfo.output.slice(-100);
      }
    };

    proc.stdout.on('data', captureOutput);
    proc.stderr.on('data', captureOutput);

    proc.on('error', (err) => {
      processInfo.status = 'error';
      processInfo.error = err.message;
      broadcastProcessList();
    });

    proc.on('exit', (code) => {
      processInfo.status = code === 0 ? 'stopped' : 'error';
      processInfo.exitCode = code;
      broadcastProcessList();
    });

    backgroundProcesses.set(id, { process: proc, info: processInfo });
    broadcastProcessList();

    return { success: true, id, pid: proc.pid };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// List all background processes
ipcMain.handle('list-processes', () => {
  const processes = [];
  for (const [id, { info }] of backgroundProcesses) {
    processes.push({
      id: info.id,
      command: info.command,
      args: info.args,
      cwd: info.cwd,
      pid: info.pid,
      startTime: info.startTime,
      status: info.status,
      exitCode: info.exitCode,
      error: info.error,
    });
  }
  return { success: true, processes };
});

// Kill a background process by ID
ipcMain.handle('kill-process', (event, processId) => {
  try {
    const entry = backgroundProcesses.get(processId);
    if (!entry) {
      return { success: false, error: 'Process not found' };
    }

    const { process: proc, info } = entry;

    // Kill the process
    if (os.platform() === 'win32') {
      // On Windows, use taskkill to kill process tree
      spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t']);
    } else {
      proc.kill('SIGTERM');
    }

    info.status = 'stopped';
    broadcastProcessList();

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get process output by ID
ipcMain.handle('get-process-output', (event, processId) => {
  const entry = backgroundProcesses.get(processId);
  if (!entry) {
    return { success: false, error: 'Process not found' };
  }
  return { success: true, output: entry.info.output.join('\n') };
});

// Broadcast process list to renderer
function broadcastProcessList() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const processes = [];
    for (const [id, { info }] of backgroundProcesses) {
      processes.push({
        id: info.id,
        command: info.command,
        args: info.args,
        pid: info.pid,
        status: info.status,
      });
    }
    mainWindow.webContents.send('processes-changed', processes);
  }
}

// ============================================================
// USAGE STATS IPC HANDLERS
// ============================================================

// Check and fire cost alert if threshold exceeded
function checkCostAlert(estimatedCost) {
  if (!currentSettings.costAlertEnabled) return false;
  if (costAlertSent) return false; // Already sent this session

  const threshold = currentSettings.costAlertThreshold || 5.00;
  if (parseFloat(estimatedCost) >= threshold) {
    costAlertSent = true;
    console.log(`[Cost Alert] Threshold exceeded: $${estimatedCost} >= $${threshold}`);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cost-alert', {
        cost: estimatedCost,
        threshold: threshold,
        message: `Cost alert: Session cost ($${estimatedCost}) has exceeded your threshold ($${threshold.toFixed(2)})`
      });
    }
    return true;
  }
  return false;
}

// Get usage statistics
ipcMain.handle('get-usage-stats', () => {
  // Calculate human-readable durations
  const formatDuration = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  // Estimate cost: ~$0.05/min per active Claude session (rough estimate)
  // This is a placeholder - actual cost depends on API usage
  const COST_PER_MINUTE = 0.05;
  const totalMinutes = usageStats.totalSessionTimeMs / 60000;
  const estimatedCost = totalMinutes * COST_PER_MINUTE;
  const costStr = estimatedCost.toFixed(2);

  // Check and fire cost alert if threshold exceeded
  checkCostAlert(costStr);

  return {
    totalSpawns: usageStats.totalSpawns,
    spawnsPerPane: usageStats.spawnsPerPane,
    totalSessionTime: formatDuration(usageStats.totalSessionTimeMs),
    totalSessionTimeMs: usageStats.totalSessionTimeMs,
    sessionTimePerPane: Object.fromEntries(
      Object.entries(usageStats.sessionTimePerPane).map(([k, v]) => [k, formatDuration(v)])
    ),
    sessionsToday: usageStats.sessionsToday,
    lastResetDate: usageStats.lastResetDate,
    estimatedCost: costStr,
    estimatedCostPerPane: Object.fromEntries(
      Object.entries(usageStats.sessionTimePerPane).map(([k, v]) => [k, ((v / 60000) * COST_PER_MINUTE).toFixed(2)])
    ),
    recentSessions: usageStats.history.slice(-10).map(s => ({
      ...s,
      durationFormatted: formatDuration(s.duration),
    })),
    // Cost alert settings
    costAlertEnabled: currentSettings.costAlertEnabled,
    costAlertThreshold: currentSettings.costAlertThreshold,
    costAlertSent: costAlertSent,
  };
});

// Reset usage statistics
ipcMain.handle('reset-usage-stats', () => {
  usageStats = {
    totalSpawns: 0,
    spawnsPerPane: { '1': 0, '2': 0, '3': 0, '4': 0 },
    totalSessionTimeMs: 0,
    sessionTimePerPane: { '1': 0, '2': 0, '3': 0, '4': 0 },
    sessionsToday: 0,
    lastResetDate: new Date().toISOString().split('T')[0],
    history: [],
  };
  costAlertSent = false; // Reset alert flag
  saveUsageStats();
  return { success: true };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Stop file watcher
  stopWatcher();

  // Disconnect from daemon (but DON'T kill terminals - that's the whole point!)
  // Terminals survive app restart because they're managed by the daemon
  if (daemonClient) {
    console.log('[Cleanup] Disconnecting from daemon (terminals will survive)');
    daemonClient.disconnect();
  }

  // Clean up background processes
  for (const [id, { process: proc, info }] of backgroundProcesses) {
    try {
      if (proc && info && info.status === 'running' && proc.pid) {
        if (os.platform() === 'win32') {
          spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { shell: true });
        } else {
          proc.kill('SIGTERM');
        }
      }
    } catch (err) {
      console.log(`[Cleanup] Error killing process ${id}:`, err.message);
    }
  }
  backgroundProcesses.clear();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});
