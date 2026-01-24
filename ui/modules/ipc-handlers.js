/**
 * IPC handlers for Electron main process
 * Extracted from main.js for modularization
 */

const { ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { WORKSPACE_PATH, INSTANCE_DIRS } = require('../config');

const SHARED_CONTEXT_PATH = path.join(WORKSPACE_PATH, 'shared_context.md');
const FRICTION_DIR = path.join(WORKSPACE_PATH, 'friction');
const SCREENSHOTS_DIR = path.join(WORKSPACE_PATH, 'screenshots');

// Module state (set by init)
let mainWindow = null;
let daemonClient = null;
let claudeRunning = null;
let currentSettings = null;
let watcher = null;
let triggers = null;

// Usage tracking
let usageStats = null;
let sessionStartTimes = null;
let costAlertSent = false;

// Background processes
const backgroundProcesses = new Map();
let processIdCounter = 1;

/**
 * Initialize the IPC handlers module
 */
function init(deps) {
  mainWindow = deps.mainWindow;
  daemonClient = deps.daemonClient;
  claudeRunning = deps.claudeRunning;
  currentSettings = deps.currentSettings;
  watcher = deps.watcher;
  triggers = deps.triggers;
  usageStats = deps.usageStats;
  sessionStartTimes = deps.sessionStartTimes;
}

/**
 * Update daemon client reference (after connection)
 */
function setDaemonClient(client) {
  daemonClient = client;
}

/**
 * Setup all IPC handlers
 */
function setupIPCHandlers(deps) {
  const {
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
  } = deps;

  // ============================================================
  // PTY IPC HANDLERS (via Daemon)
  // ============================================================

  ipcMain.handle('pty-create', async (event, paneId, workingDir) => {
    if (!daemonClient || !daemonClient.connected) {
      console.error('[pty-create] Daemon not connected');
      return { error: 'Daemon not connected' };
    }

    const instanceDir = INSTANCE_DIRS[paneId];
    const cwd = instanceDir || workingDir || process.cwd();

    daemonClient.spawn(paneId, cwd, currentSettings.dryRun);
    return { paneId, cwd, dryRun: currentSettings.dryRun };
  });

  ipcMain.handle('pty-write', (event, paneId, data) => {
    if (daemonClient && daemonClient.connected) {
      daemonClient.write(paneId, data);
    }
  });

  ipcMain.handle('pty-resize', (event, paneId, cols, rows) => {
    if (daemonClient && daemonClient.connected) {
      daemonClient.resize(paneId, cols, rows);
    }
  });

  ipcMain.handle('pty-kill', (event, paneId) => {
    if (daemonClient && daemonClient.connected) {
      daemonClient.kill(paneId);
    }
  });

  ipcMain.handle('spawn-claude', (event, paneId, workingDir) => {
    // V3: Dry-run mode - simulate without spawning real Claude
    if (currentSettings.dryRun) {
      claudeRunning.set(paneId, 'running');
      broadcastClaudeState();
      return { success: true, command: null, dryRun: true };
    }

    if (!daemonClient || !daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    claudeRunning.set(paneId, 'starting');
    broadcastClaudeState();
    recordSessionStart(paneId);

    let claudeCmd = 'claude';
    if (currentSettings.allowAllPermissions) {
      claudeCmd = 'claude --dangerously-skip-permissions';
    }

    return { success: true, command: claudeCmd };
  });

  ipcMain.handle('get-claude-state', () => {
    return Object.fromEntries(claudeRunning);
  });

  ipcMain.handle('get-daemon-terminals', () => {
    if (daemonClient) {
      return daemonClient.getTerminals();
    }
    return [];
  });

  // ============================================================
  // SHARED CONTEXT HANDLERS
  // ============================================================

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

  ipcMain.handle('write-shared-context', (event, content) => {
    try {
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

  ipcMain.handle('get-shared-context-path', () => {
    return SHARED_CONTEXT_PATH;
  });

  // ============================================================
  // CONFLICT DETECTION HANDLERS
  // ============================================================

  ipcMain.handle('get-file-conflicts', () => watcher.getLastConflicts());
  ipcMain.handle('check-file-conflicts', () => watcher.checkFileConflicts());

  // ============================================================
  // STATE HANDLERS
  // ============================================================

  ipcMain.handle('get-state', () => {
    return watcher.readState();
  });

  ipcMain.handle('set-state', (event, newState) => {
    watcher.transition(newState);
    return watcher.readState();
  });

  ipcMain.handle('trigger-sync', (event, file = 'shared_context.md') => {
    triggers.notifyAllAgentsSync(file);
    return { success: true, file };
  });

  ipcMain.handle('broadcast-message', (event, message) => {
    return triggers.broadcastToAllAgents(message);
  });

  ipcMain.handle('start-planning', (event, project) => {
    const state = watcher.readState();
    state.project = project;
    watcher.writeState(state);
    watcher.transition(watcher.States.PLANNING);
    return watcher.readState();
  });

  // ============================================================
  // SETTINGS HANDLERS
  // ============================================================

  ipcMain.handle('get-settings', () => {
    return loadSettings();
  });

  ipcMain.handle('set-setting', (event, key, value) => {
    const settings = loadSettings();
    settings[key] = value;
    saveSettings(settings);

    if (key === 'watcherEnabled') {
      if (value) {
        watcher.startWatcher();
      } else {
        watcher.stopWatcher();
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

  ipcMain.handle('select-project', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Project Folder',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const projectPath = result.filePaths[0];
    const projectName = path.basename(projectPath);

    const state = watcher.readState();
    state.project = projectPath;
    watcher.writeState(state);

    // J2: Add to recent projects
    const settings = loadSettings();
    const projects = settings.recentProjects || [];
    const filtered = projects.filter(p => p.path !== projectPath);
    filtered.unshift({
      name: projectName,
      path: projectPath,
      lastOpened: new Date().toISOString(),
    });
    settings.recentProjects = filtered.slice(0, 10); // Max 10
    saveSettings(settings);

    watcher.transition(watcher.States.PROJECT_SELECTED);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('project-changed', projectPath);
    }

    return { success: true, path: projectPath, name: projectName };
  });

  ipcMain.handle('get-project', () => {
    const state = watcher.readState();
    return state.project || null;
  });

  // ============================================================
  // FRICTION PANEL
  // ============================================================

  ipcMain.handle('list-friction', () => {
    try {
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

  ipcMain.handle('clear-friction', () => {
    try {
      if (fs.existsSync(FRICTION_DIR)) {
        const files = fs.readdirSync(FRICTION_DIR).filter(f => f.endsWith('.md'));
        for (const f of files) {
          fs.unlinkSync(path.join(FRICTION_DIR, f));
        }
      }
      const state = watcher.readState();
      state.friction_count = 0;
      watcher.writeState(state);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // SCREENSHOTS
  // ============================================================

  ipcMain.handle('save-screenshot', (event, base64Data, originalName) => {
    try {
      if (!fs.existsSync(SCREENSHOTS_DIR)) {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      }

      const timestamp = Date.now();
      const ext = originalName ? path.extname(originalName) || '.png' : '.png';
      const filename = `screenshot-${timestamp}${ext}`;
      const filePath = path.join(SCREENSHOTS_DIR, filename);

      const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Content, 'base64');
      fs.writeFileSync(filePath, buffer);

      const latestPath = path.join(SCREENSHOTS_DIR, 'latest.png');
      fs.writeFileSync(latestPath, buffer);

      const indexPath = path.join(SCREENSHOTS_DIR, 'index.md');
      const entry = `- **${new Date().toISOString()}**: \`${filename}\` → To view: read \`workspace/screenshots/latest.png\`\n`;
      fs.appendFileSync(indexPath, entry);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('screenshot-added', { filename, path: filePath });
      }

      return { success: true, filename, path: filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-screenshots', () => {
    try {
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

  ipcMain.handle('get-screenshot-path', (event, filename) => {
    const filePath = path.join(SCREENSHOTS_DIR, filename);
    return { path: filePath, exists: fs.existsSync(filePath) };
  });

  // ============================================================
  // BACKGROUND PROCESSES
  // ============================================================

  ipcMain.handle('spawn-process', (event, command, args = [], cwd = null) => {
    try {
      const id = `proc-${processIdCounter++}`;
      const workDir = cwd || process.cwd();

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

  ipcMain.handle('kill-process', (event, processId) => {
    try {
      const entry = backgroundProcesses.get(processId);
      if (!entry) {
        return { success: false, error: 'Process not found' };
      }

      const { process: proc, info } = entry;

      if (os.platform() === 'win32') {
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

  ipcMain.handle('get-process-output', (event, processId) => {
    const entry = backgroundProcesses.get(processId);
    if (!entry) {
      return { success: false, error: 'Process not found' };
    }
    return { success: true, output: entry.info.output.join('\n') };
  });

  // ============================================================
  // USAGE STATS
  // ============================================================

  ipcMain.handle('get-usage-stats', () => {
    const formatDuration = (ms) => {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    };

    const COST_PER_MINUTE = 0.05;
    const totalMinutes = usageStats.totalSessionTimeMs / 60000;
    const estimatedCost = totalMinutes * COST_PER_MINUTE;
    const costStr = estimatedCost.toFixed(2);

    // Check cost alert
    if (currentSettings.costAlertEnabled && !costAlertSent) {
      const threshold = currentSettings.costAlertThreshold || 5.00;
      if (parseFloat(costStr) >= threshold) {
        costAlertSent = true;
        console.log(`[Cost Alert] Threshold exceeded: $${costStr} >= $${threshold}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cost-alert', {
            cost: costStr,
            threshold: threshold,
            message: `Cost alert: Session cost ($${costStr}) has exceeded your threshold ($${threshold.toFixed(2)})`
          });
        }
      }
    }

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
      costAlertEnabled: currentSettings.costAlertEnabled,
      costAlertThreshold: currentSettings.costAlertThreshold,
      costAlertSent: costAlertSent,
    };
  });

  ipcMain.handle('reset-usage-stats', () => {
    usageStats.totalSpawns = 0;
    usageStats.spawnsPerPane = { '1': 0, '2': 0, '3': 0, '4': 0 };
    usageStats.totalSessionTimeMs = 0;
    usageStats.sessionTimePerPane = { '1': 0, '2': 0, '3': 0, '4': 0 };
    usageStats.sessionsToday = 0;
    usageStats.lastResetDate = new Date().toISOString().split('T')[0];
    usageStats.history = [];
    costAlertSent = false;
    saveUsageStats();
    return { success: true };
  });

  // ============================================================
  // H2: SESSION HISTORY (Sprint 3.2)
  // ============================================================

  ipcMain.handle('get-session-history', (event, limit = 50) => {
    const formatDuration = (ms) => {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    };

    const PANE_ROLES = { '1': 'Lead', '2': 'Worker A', '3': 'Worker B', '4': 'Reviewer' };

    // Get history entries with enhanced data
    const history = (usageStats.history || [])
      .slice(-limit)
      .reverse() // Most recent first
      .map((entry, index) => ({
        id: `session-${index}`,
        pane: entry.pane,
        role: PANE_ROLES[entry.pane] || `Pane ${entry.pane}`,
        duration: entry.duration,
        durationFormatted: formatDuration(entry.duration),
        timestamp: entry.timestamp,
        date: new Date(entry.timestamp).toLocaleDateString(),
        time: new Date(entry.timestamp).toLocaleTimeString(),
      }));

    return {
      success: true,
      history,
      total: usageStats.history ? usageStats.history.length : 0,
    };
  });

  // ============================================================
  // J2: RECENT PROJECTS (Sprint 3.2)
  // ============================================================

  ipcMain.handle('get-recent-projects', () => {
    const settings = loadSettings();
    const projects = settings.recentProjects || [];

    // Verify projects still exist
    const validProjects = projects.filter(p => {
      try {
        return fs.existsSync(p.path);
      } catch {
        return false;
      }
    });

    // Update settings if some projects were removed
    if (validProjects.length !== projects.length) {
      settings.recentProjects = validProjects;
      saveSettings(settings);
    }

    return {
      success: true,
      projects: validProjects,
    };
  });

  ipcMain.handle('add-recent-project', (event, projectPath) => {
    if (!projectPath || !fs.existsSync(projectPath)) {
      return { success: false, error: 'Invalid project path' };
    }

    const settings = loadSettings();
    const projects = settings.recentProjects || [];
    const MAX_RECENT = 10;

    // Get project name from path
    const projectName = path.basename(projectPath);

    // Remove if already exists (will re-add at top)
    const filtered = projects.filter(p => p.path !== projectPath);

    // Add to front
    filtered.unshift({
      name: projectName,
      path: projectPath,
      lastOpened: new Date().toISOString(),
    });

    // Limit to MAX_RECENT
    settings.recentProjects = filtered.slice(0, MAX_RECENT);
    saveSettings(settings);

    return {
      success: true,
      projects: settings.recentProjects,
    };
  });

  ipcMain.handle('remove-recent-project', (event, projectPath) => {
    const settings = loadSettings();
    const projects = settings.recentProjects || [];

    settings.recentProjects = projects.filter(p => p.path !== projectPath);
    saveSettings(settings);

    return {
      success: true,
      projects: settings.recentProjects,
    };
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

    // Update state with new project
    const state = watcher.readState();
    state.project = projectPath;
    watcher.writeState(state);

    // Add to recent projects
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

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('project-changed', projectPath);
    }

    watcher.transition(watcher.States.PROJECT_SELECTED);

    return { success: true, path: projectPath, name: projectName };
  });

  // ============================================================
  // V4: AUTO-NUDGE (AR2)
  // ============================================================

  ipcMain.handle('nudge-agent', (event, paneId, message) => {
    if (!daemonClient || !daemonClient.connected) {
      return { success: false, error: 'Daemon not connected' };
    }

    const nudgeMessage = message || '[HIVEMIND] Are you still working? Please respond with your current status.';

    // Check if Claude is running in this pane
    if (claudeRunning.get(paneId) !== 'running') {
      return { success: false, error: 'Claude not running in this pane' };
    }

    // Send nudge via terminal
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', {
        panes: [paneId],
        message: nudgeMessage + '\r'
      });
    }

    console.log(`[Auto-Nudge] Sent to pane ${paneId}: ${nudgeMessage.substring(0, 50)}...`);

    return { success: true, pane: paneId };
  });

  ipcMain.handle('nudge-all-stuck', () => {
    const stuckThreshold = currentSettings.stuckThreshold || 60000; // 60 seconds default
    const now = Date.now();
    const nudged = [];

    // Check each pane for stuck status
    for (const [paneId, status] of claudeRunning) {
      if (status === 'running') {
        const lastActivity = daemonClient.getLastActivity(paneId);
        if (lastActivity && (now - lastActivity) > stuckThreshold) {
          // Nudge this agent
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('inject-message', {
              panes: [paneId],
              message: '[HIVEMIND] No activity detected. Please respond with your current status.\r'
            });
          }
          nudged.push(paneId);
        }
      }
    }

    console.log(`[Auto-Nudge] Nudged ${nudged.length} stuck agents: ${nudged.join(', ')}`);
    return { success: true, nudged };
  });

  // ============================================================
  // V4: COMPLETION DETECTION (AT1)
  // ============================================================

  // Patterns that indicate an agent has completed their task
  const COMPLETION_PATTERNS = [
    /task\s+(complete|done|finished)/i,
    /completed?\s+(task|work|assignment)/i,
    /ready\s+for\s+(review|next|handoff)/i,
    /handing\s+off\s+to/i,
    /trigger(ing|ed)?\s+(lead|worker|reviewer)/i,
    /✅\s*(done|complete|finished)/i,
    /DONE:/i,
    /COMPLETE:/i,
  ];

  ipcMain.handle('check-completion', (event, text) => {
    for (const pattern of COMPLETION_PATTERNS) {
      if (pattern.test(text)) {
        return { completed: true, pattern: pattern.toString() };
      }
    }
    return { completed: false };
  });

  ipcMain.handle('get-completion-patterns', () => {
    return COMPLETION_PATTERNS.map(p => p.toString());
  });

  // ============================================================
  // V4 CB2: AGENT CLAIMS
  // ============================================================

  ipcMain.handle('claim-agent', (event, paneId, taskId, description) => {
    return watcher.claimAgent(paneId, taskId, description);
  });

  ipcMain.handle('release-agent', (event, paneId) => {
    return watcher.releaseAgent(paneId);
  });

  ipcMain.handle('get-claims', () => {
    return watcher.getClaims();
  });

  ipcMain.handle('clear-claims', () => {
    return watcher.clearClaims();
  });

  // ============================================================
  // V4 CP1: SESSION SUMMARY PERSISTENCE
  // ============================================================

  const SESSION_SUMMARY_PATH = path.join(WORKSPACE_PATH, 'session-summaries.json');

  ipcMain.handle('save-session-summary', (event, summary) => {
    try {
      let summaries = [];
      if (fs.existsSync(SESSION_SUMMARY_PATH)) {
        const content = fs.readFileSync(SESSION_SUMMARY_PATH, 'utf-8');
        summaries = JSON.parse(content);
      }

      // Add new summary with metadata
      summaries.push({
        ...summary,
        savedAt: new Date().toISOString(),
        id: `session-${Date.now()}`,
      });

      // Keep last 50 summaries
      if (summaries.length > 50) {
        summaries = summaries.slice(-50);
      }

      // Atomic write
      const tempPath = SESSION_SUMMARY_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(summaries, null, 2), 'utf-8');
      fs.renameSync(tempPath, SESSION_SUMMARY_PATH);

      console.log('[Session Summary] Saved summary:', summary.title || 'Untitled');
      return { success: true, id: summaries[summaries.length - 1].id };
    } catch (err) {
      console.error('[Session Summary] Error saving:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-session-summaries', (event, limit = 10) => {
    try {
      if (!fs.existsSync(SESSION_SUMMARY_PATH)) {
        return { success: true, summaries: [] };
      }

      const content = fs.readFileSync(SESSION_SUMMARY_PATH, 'utf-8');
      const summaries = JSON.parse(content);

      // Return most recent first
      return {
        success: true,
        summaries: summaries.slice(-limit).reverse(),
        total: summaries.length,
      };
    } catch (err) {
      return { success: false, error: err.message, summaries: [] };
    }
  });

  ipcMain.handle('get-latest-summary', () => {
    try {
      if (!fs.existsSync(SESSION_SUMMARY_PATH)) {
        return { success: true, summary: null };
      }

      const content = fs.readFileSync(SESSION_SUMMARY_PATH, 'utf-8');
      const summaries = JSON.parse(content);

      if (summaries.length === 0) {
        return { success: true, summary: null };
      }

      return { success: true, summary: summaries[summaries.length - 1] };
    } catch (err) {
      return { success: false, error: err.message, summary: null };
    }
  });

  ipcMain.handle('clear-session-summaries', () => {
    try {
      if (fs.existsSync(SESSION_SUMMARY_PATH)) {
        fs.unlinkSync(SESSION_SUMMARY_PATH);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // V5 MP1: PER-PANE PROJECT ASSIGNMENT
  // ============================================================

  ipcMain.handle('set-pane-project', (event, paneId, projectPath) => {
    if (!['1', '2', '3', '4'].includes(paneId)) {
      return { success: false, error: 'Invalid pane ID' };
    }

    if (projectPath && !fs.existsSync(projectPath)) {
      return { success: false, error: 'Project path does not exist' };
    }

    const settings = loadSettings();
    if (!settings.paneProjects) {
      settings.paneProjects = { '1': null, '2': null, '3': null, '4': null };
    }

    settings.paneProjects[paneId] = projectPath;
    saveSettings(settings);

    console.log(`[Multi-Project] Pane ${paneId} assigned to: ${projectPath || 'default'}`);

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pane-project-changed', { paneId, projectPath });
    }

    return { success: true, paneId, projectPath };
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
      paneProjects: settings.paneProjects || { '1': null, '2': null, '3': null, '4': null },
    };
  });

  ipcMain.handle('clear-pane-projects', () => {
    const settings = loadSettings();
    settings.paneProjects = { '1': null, '2': null, '3': null, '4': null };
    saveSettings(settings);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pane-projects-cleared');
    }

    return { success: true };
  });

  // ============================================================
  // V5 PT1: PERFORMANCE TRACKING
  // ============================================================

  const PERFORMANCE_FILE_PATH = path.join(WORKSPACE_PATH, 'performance.json');

  const DEFAULT_PERFORMANCE = {
    agents: {
      '1': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '2': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '3': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '4': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
    },
    lastUpdated: null,
  };

  function loadPerformance() {
    try {
      if (fs.existsSync(PERFORMANCE_FILE_PATH)) {
        const content = fs.readFileSync(PERFORMANCE_FILE_PATH, 'utf-8');
        return { ...DEFAULT_PERFORMANCE, ...JSON.parse(content) };
      }
    } catch (err) {
      console.error('[Performance] Error loading:', err.message);
    }
    return { ...DEFAULT_PERFORMANCE };
  }

  function savePerformance(data) {
    try {
      data.lastUpdated = new Date().toISOString();
      const tempPath = PERFORMANCE_FILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tempPath, PERFORMANCE_FILE_PATH);
    } catch (err) {
      console.error('[Performance] Error saving:', err.message);
    }
  }

  ipcMain.handle('record-completion', (event, paneId) => {
    const perf = loadPerformance();
    if (!perf.agents[paneId]) {
      perf.agents[paneId] = { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 };
    }
    perf.agents[paneId].completions++;
    savePerformance(perf);

    console.log(`[Performance] Pane ${paneId} completion recorded. Total: ${perf.agents[paneId].completions}`);
    return { success: true, completions: perf.agents[paneId].completions };
  });

  ipcMain.handle('record-error', (event, paneId) => {
    const perf = loadPerformance();
    if (!perf.agents[paneId]) {
      perf.agents[paneId] = { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 };
    }
    perf.agents[paneId].errors++;
    savePerformance(perf);

    return { success: true, errors: perf.agents[paneId].errors };
  });

  ipcMain.handle('record-response-time', (event, paneId, timeMs) => {
    const perf = loadPerformance();
    if (!perf.agents[paneId]) {
      perf.agents[paneId] = { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 };
    }
    perf.agents[paneId].totalResponseTime += timeMs;
    perf.agents[paneId].responseCount++;
    savePerformance(perf);

    const avg = Math.round(perf.agents[paneId].totalResponseTime / perf.agents[paneId].responseCount);
    return { success: true, avgResponseTime: avg };
  });

  ipcMain.handle('get-performance', () => {
    const perf = loadPerformance();
    const PANE_ROLES = { '1': 'Lead', '2': 'Worker A', '3': 'Worker B', '4': 'Reviewer' };

    // Calculate averages and add role names
    const stats = {};
    for (const [paneId, data] of Object.entries(perf.agents)) {
      stats[paneId] = {
        ...data,
        role: PANE_ROLES[paneId] || `Pane ${paneId}`,
        avgResponseTime: data.responseCount > 0
          ? Math.round(data.totalResponseTime / data.responseCount)
          : 0,
      };
    }

    return {
      success: true,
      agents: stats,
      lastUpdated: perf.lastUpdated,
    };
  });

  ipcMain.handle('reset-performance', () => {
    savePerformance({ ...DEFAULT_PERFORMANCE });
    return { success: true };
  });

  // ============================================================
  // V5 TM1: TEMPLATE SAVE/LOAD
  // ============================================================

  const TEMPLATES_FILE_PATH = path.join(WORKSPACE_PATH, 'templates.json');

  function loadTemplates() {
    try {
      if (fs.existsSync(TEMPLATES_FILE_PATH)) {
        const content = fs.readFileSync(TEMPLATES_FILE_PATH, 'utf-8');
        return JSON.parse(content);
      }
    } catch (err) {
      console.error('[Templates] Error loading:', err.message);
    }
    return [];
  }

  function saveTemplates(templates) {
    try {
      const tempPath = TEMPLATES_FILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(templates, null, 2), 'utf-8');
      fs.renameSync(tempPath, TEMPLATES_FILE_PATH);
    } catch (err) {
      console.error('[Templates] Error saving:', err.message);
    }
  }

  ipcMain.handle('save-template', (event, template) => {
    if (!template.name) {
      return { success: false, error: 'Template name is required' };
    }

    const templates = loadTemplates();

    // Check for duplicate name
    const existingIndex = templates.findIndex(t => t.name === template.name);

    const newTemplate = {
      id: existingIndex >= 0 ? templates[existingIndex].id : `tmpl-${Date.now()}`,
      name: template.name,
      description: template.description || '',
      config: template.config || {},
      paneProjects: template.paneProjects || {},
      createdAt: existingIndex >= 0 ? templates[existingIndex].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      templates[existingIndex] = newTemplate;
    } else {
      templates.push(newTemplate);
    }

    // Keep max 20 templates
    if (templates.length > 20) {
      templates.splice(0, templates.length - 20);
    }

    saveTemplates(templates);
    console.log(`[Templates] Saved template: ${template.name}`);

    return { success: true, template: newTemplate };
  });

  ipcMain.handle('load-template', (event, templateId) => {
    const templates = loadTemplates();
    const template = templates.find(t => t.id === templateId || t.name === templateId);

    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    // Apply template settings
    const settings = loadSettings();

    if (template.paneProjects) {
      settings.paneProjects = { ...settings.paneProjects, ...template.paneProjects };
    }

    if (template.config) {
      Object.assign(settings, template.config);
    }

    saveSettings(settings);

    console.log(`[Templates] Loaded template: ${template.name}`);

    // Notify renderer of changes
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('template-loaded', template);
      mainWindow.webContents.send('settings-changed', settings);
    }

    return { success: true, template };
  });

  ipcMain.handle('list-templates', () => {
    const templates = loadTemplates();
    return {
      success: true,
      templates: templates.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    };
  });

  ipcMain.handle('get-template', (event, templateId) => {
    const templates = loadTemplates();
    const template = templates.find(t => t.id === templateId || t.name === templateId);

    if (!template) {
      return { success: false, error: 'Template not found' };
    }

    return { success: true, template };
  });

  ipcMain.handle('delete-template', (event, templateId) => {
    const templates = loadTemplates();
    const index = templates.findIndex(t => t.id === templateId || t.name === templateId);

    if (index < 0) {
      return { success: false, error: 'Template not found' };
    }

    const deleted = templates.splice(index, 1)[0];
    saveTemplates(templates);

    console.log(`[Templates] Deleted template: ${deleted.name}`);
    return { success: true };
  });

  // ============================================================
  // V6 SR2: SMART ROUTING IPC HANDLERS
  // ============================================================

  ipcMain.handle('route-task', (event, taskType, message) => {
    // Get performance data for routing decision
    const perf = loadPerformance();
    return triggers.routeTask(taskType, message, perf);
  });

  ipcMain.handle('get-best-agent', (event, taskType) => {
    const perf = loadPerformance();
    return triggers.getBestAgent(taskType, perf);
  });

  ipcMain.handle('get-agent-roles', () => {
    return triggers.AGENT_ROLES;
  });

  // ============================================================
  // V6 AH1: AUTO-HANDOFF IPC HANDLERS
  // ============================================================

  ipcMain.handle('trigger-handoff', (event, fromPaneId, message) => {
    return triggers.triggerAutoHandoff(fromPaneId, message);
  });

  ipcMain.handle('get-handoff-chain', () => {
    return triggers.HANDOFF_CHAIN;
  });

  // ============================================================
  // V6 CR1: CONFLICT QUEUE IPC HANDLERS
  // ============================================================

  ipcMain.handle('request-file-access', (event, filePath, paneId, operation) => {
    return watcher.requestFileAccess(filePath, paneId, operation);
  });

  ipcMain.handle('release-file-access', (event, filePath, paneId) => {
    return watcher.releaseFileAccess(filePath, paneId);
  });

  ipcMain.handle('get-conflict-queue-status', () => {
    return watcher.getConflictQueueStatus();
  });

  ipcMain.handle('clear-all-locks', () => {
    return watcher.clearAllLocks();
  });

  // ============================================================
  // V6 LM1: LEARNING DATA PERSISTENCE
  // ============================================================

  const LEARNING_FILE_PATH = path.join(WORKSPACE_PATH, 'learning.json');

  const DEFAULT_LEARNING = {
    taskTypes: {}, // taskType -> { agentStats: { paneId: { success, failure, avgTime } } }
    routingWeights: { '1': 1.0, '2': 1.0, '3': 1.0, '4': 1.0 },
    totalDecisions: 0,
    lastUpdated: null,
  };

  function loadLearning() {
    try {
      if (fs.existsSync(LEARNING_FILE_PATH)) {
        const content = fs.readFileSync(LEARNING_FILE_PATH, 'utf-8');
        return { ...DEFAULT_LEARNING, ...JSON.parse(content) };
      }
    } catch (err) {
      console.error('[Learning] Error loading:', err.message);
    }
    return { ...DEFAULT_LEARNING };
  }

  function saveLearning(data) {
    try {
      data.lastUpdated = new Date().toISOString();
      const tempPath = LEARNING_FILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tempPath, LEARNING_FILE_PATH);
    } catch (err) {
      console.error('[Learning] Error saving:', err.message);
    }
  }

  ipcMain.handle('record-task-outcome', (event, taskType, paneId, success, timeMs) => {
    const learning = loadLearning();

    // Initialize task type if needed
    if (!learning.taskTypes[taskType]) {
      learning.taskTypes[taskType] = {
        agentStats: {},
        totalAttempts: 0,
      };
    }

    const taskData = learning.taskTypes[taskType];

    // Initialize agent stats if needed
    if (!taskData.agentStats[paneId]) {
      taskData.agentStats[paneId] = {
        success: 0,
        failure: 0,
        totalTime: 0,
        attempts: 0,
      };
    }

    const agentStats = taskData.agentStats[paneId];

    // Update stats
    if (success) {
      agentStats.success++;
    } else {
      agentStats.failure++;
    }
    agentStats.attempts++;
    agentStats.totalTime += timeMs || 0;
    taskData.totalAttempts++;
    learning.totalDecisions++;

    // Update routing weight based on success rate
    const successRate = agentStats.success / agentStats.attempts;
    learning.routingWeights[paneId] = 0.5 + (successRate * 0.5); // Range: 0.5 - 1.0

    saveLearning(learning);

    console.log(`[Learning] ${taskType} by pane ${paneId}: ${success ? 'SUCCESS' : 'FAILURE'} (rate: ${(successRate * 100).toFixed(1)}%)`);

    return {
      success: true,
      taskType,
      paneId,
      successRate,
      newWeight: learning.routingWeights[paneId],
    };
  });

  ipcMain.handle('get-learning-data', () => {
    const learning = loadLearning();
    const PANE_ROLES = { '1': 'Lead', '2': 'Worker A', '3': 'Worker B', '4': 'Reviewer' };

    // Add computed fields
    const insights = {};
    for (const [taskType, data] of Object.entries(learning.taskTypes)) {
      const agentRankings = Object.entries(data.agentStats)
        .map(([paneId, stats]) => ({
          paneId,
          role: PANE_ROLES[paneId],
          successRate: stats.attempts > 0 ? stats.success / stats.attempts : 0,
          avgTime: stats.attempts > 0 ? Math.round(stats.totalTime / stats.attempts) : 0,
          attempts: stats.attempts,
        }))
        .sort((a, b) => b.successRate - a.successRate);

      insights[taskType] = {
        bestAgent: agentRankings[0] || null,
        rankings: agentRankings,
        totalAttempts: data.totalAttempts,
      };
    }

    return {
      success: true,
      taskTypes: learning.taskTypes,
      routingWeights: learning.routingWeights,
      insights,
      totalDecisions: learning.totalDecisions,
      lastUpdated: learning.lastUpdated,
    };
  });

  ipcMain.handle('get-best-agent-for-task', (event, taskType) => {
    const learning = loadLearning();
    const PANE_ROLES = { '1': 'Lead', '2': 'Worker A', '3': 'Worker B', '4': 'Reviewer' };

    const taskData = learning.taskTypes[taskType];
    if (!taskData || Object.keys(taskData.agentStats).length === 0) {
      return { success: true, bestAgent: null, reason: 'No data for task type' };
    }

    // Find agent with highest success rate (min 2 attempts)
    let bestAgent = null;
    let bestRate = -1;

    for (const [paneId, stats] of Object.entries(taskData.agentStats)) {
      if (stats.attempts >= 2) {
        const rate = stats.success / stats.attempts;
        if (rate > bestRate) {
          bestRate = rate;
          bestAgent = {
            paneId,
            role: PANE_ROLES[paneId],
            successRate: rate,
            avgTime: Math.round(stats.totalTime / stats.attempts),
            attempts: stats.attempts,
          };
        }
      }
    }

    return {
      success: true,
      bestAgent,
      reason: bestAgent ? `${(bestRate * 100).toFixed(0)}% success rate` : 'Insufficient data',
    };
  });

  ipcMain.handle('reset-learning', () => {
    saveLearning({ ...DEFAULT_LEARNING });
    console.log('[Learning] Reset all learning data');
    return { success: true };
  });

  ipcMain.handle('get-routing-weights', () => {
    const learning = loadLearning();
    return {
      success: true,
      weights: learning.routingWeights,
    };
  });

  // ============================================================
  // V7 QV1: OUTPUT VALIDATION HOOKS
  // ============================================================

  const VALIDATION_FILE_PATH = path.join(WORKSPACE_PATH, 'validations.json');

  // Validation patterns for detecting incomplete work
  const INCOMPLETE_PATTERNS = [
    /TODO:/i,
    /FIXME:/i,
    /XXX:/i,
    /HACK:/i,
    /\.\.\.\s*$/,  // Trailing ellipsis
    /not implemented/i,
    /placeholder/i,
    /coming soon/i,
  ];

  // Patterns indicating completion
  const COMPLETION_INDICATORS = [
    /✅/,
    /DONE/i,
    /COMPLETE/i,
    /finished/i,
    /implemented/i,
  ];

  function calculateConfidence(text) {
    let score = 50; // Base score

    // Check for incomplete patterns (reduce confidence)
    for (const pattern of INCOMPLETE_PATTERNS) {
      if (pattern.test(text)) {
        score -= 15;
      }
    }

    // Check for completion indicators (increase confidence)
    for (const pattern of COMPLETION_INDICATORS) {
      if (pattern.test(text)) {
        score += 10;
      }
    }

    // Check text length (very short = suspicious)
    if (text.length < 50) score -= 20;
    if (text.length > 500) score += 10;

    // Clamp to 0-100
    return Math.max(0, Math.min(100, score));
  }

  ipcMain.handle('validate-output', (event, text, options = {}) => {
    const issues = [];
    const warnings = [];

    // Check for incomplete patterns
    for (const pattern of INCOMPLETE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        issues.push({
          type: 'incomplete',
          pattern: pattern.toString(),
          match: match[0],
          message: `Found incomplete marker: ${match[0]}`,
        });
      }
    }

    // Syntax validation for code (if requested)
    if (options.checkSyntax && options.language === 'javascript') {
      try {
        new Function(text);
      } catch (err) {
        issues.push({
          type: 'syntax',
          message: `JavaScript syntax error: ${err.message}`,
        });
      }
    }

    // JSON validation
    if (options.checkJson) {
      try {
        JSON.parse(text);
      } catch (err) {
        issues.push({
          type: 'json',
          message: `JSON parse error: ${err.message}`,
        });
      }
    }

    // Calculate confidence score
    const confidence = calculateConfidence(text);

    // Low confidence warning
    if (confidence < 40) {
      warnings.push({
        type: 'low_confidence',
        message: `Low completion confidence: ${confidence}%`,
      });
    }

    const valid = issues.length === 0;

    console.log(`[Validation] ${valid ? 'PASS' : 'FAIL'} - Confidence: ${confidence}%, Issues: ${issues.length}`);

    return {
      success: true,
      valid,
      confidence,
      issues,
      warnings,
    };
  });

  ipcMain.handle('validate-file', async (event, filePath, options = {}) => {
    try {
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File not found' };
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();

      // Auto-detect options based on extension
      if (ext === '.js' || ext === '.ts') {
        options.checkSyntax = true;
        options.language = 'javascript';
      } else if (ext === '.json') {
        options.checkJson = true;
      }

      // Use validate-output logic
      const result = await ipcMain.handle('validate-output', event, content, options);
      return { ...result, filePath, extension: ext };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-validation-patterns', () => {
    return {
      incomplete: INCOMPLETE_PATTERNS.map(p => p.toString()),
      completion: COMPLETION_INDICATORS.map(p => p.toString()),
    };
  });

  // ============================================================
  // V7 RB1: CHECKPOINT ROLLBACK SUPPORT
  // ============================================================

  const ROLLBACK_DIR = path.join(WORKSPACE_PATH, 'rollbacks');
  const MAX_CHECKPOINTS = 10;

  // Ensure rollback directory exists
  if (!fs.existsSync(ROLLBACK_DIR)) {
    fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
  }

  ipcMain.handle('create-checkpoint', (event, files, label = '') => {
    try {
      const checkpointId = `cp-${Date.now()}`;
      const checkpointDir = path.join(ROLLBACK_DIR, checkpointId);
      fs.mkdirSync(checkpointDir, { recursive: true });

      const manifest = {
        id: checkpointId,
        label: label || `Checkpoint ${new Date().toLocaleTimeString()}`,
        createdAt: new Date().toISOString(),
        files: [],
      };

      // Backup each file
      for (const filePath of files) {
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          const fileName = path.basename(filePath);
          const backupPath = path.join(checkpointDir, fileName);

          fs.writeFileSync(backupPath, content, 'utf-8');
          manifest.files.push({
            original: filePath,
            backup: backupPath,
            size: content.length,
          });
        }
      }

      // Save manifest
      fs.writeFileSync(
        path.join(checkpointDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      // Cleanup old checkpoints
      const checkpoints = fs.readdirSync(ROLLBACK_DIR)
        .filter(d => d.startsWith('cp-'))
        .sort()
        .reverse();

      if (checkpoints.length > MAX_CHECKPOINTS) {
        for (const old of checkpoints.slice(MAX_CHECKPOINTS)) {
          const oldPath = path.join(ROLLBACK_DIR, old);
          fs.rmSync(oldPath, { recursive: true, force: true });
        }
      }

      console.log(`[Rollback] Checkpoint created: ${checkpointId} (${manifest.files.length} files)`);

      return { success: true, checkpointId, files: manifest.files.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-checkpoints', () => {
    try {
      if (!fs.existsSync(ROLLBACK_DIR)) {
        return { success: true, checkpoints: [] };
      }

      const checkpoints = fs.readdirSync(ROLLBACK_DIR)
        .filter(d => d.startsWith('cp-'))
        .map(d => {
          const manifestPath = path.join(ROLLBACK_DIR, d, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            return {
              id: manifest.id,
              label: manifest.label,
              createdAt: manifest.createdAt,
              fileCount: manifest.files.length,
            };
          }
          return null;
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return { success: true, checkpoints };
    } catch (err) {
      return { success: false, error: err.message, checkpoints: [] };
    }
  });

  ipcMain.handle('get-checkpoint-diff', (event, checkpointId) => {
    try {
      const checkpointDir = path.join(ROLLBACK_DIR, checkpointId);
      const manifestPath = path.join(checkpointDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'Checkpoint not found' };
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const diffs = [];

      for (const file of manifest.files) {
        const backupContent = fs.existsSync(file.backup)
          ? fs.readFileSync(file.backup, 'utf-8')
          : null;
        const currentContent = fs.existsSync(file.original)
          ? fs.readFileSync(file.original, 'utf-8')
          : null;

        diffs.push({
          file: file.original,
          hasChanges: backupContent !== currentContent,
          backupSize: backupContent ? backupContent.length : 0,
          currentSize: currentContent ? currentContent.length : 0,
        });
      }

      return { success: true, checkpointId, diffs };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('rollback-checkpoint', (event, checkpointId) => {
    try {
      const checkpointDir = path.join(ROLLBACK_DIR, checkpointId);
      const manifestPath = path.join(checkpointDir, 'manifest.json');

      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: 'Checkpoint not found' };
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const restored = [];

      for (const file of manifest.files) {
        if (fs.existsSync(file.backup)) {
          const content = fs.readFileSync(file.backup, 'utf-8');
          fs.writeFileSync(file.original, content, 'utf-8');
          restored.push(file.original);
        }
      }

      console.log(`[Rollback] Restored ${restored.length} files from ${checkpointId}`);

      // Notify renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('rollback-complete', {
          checkpointId,
          restoredFiles: restored,
        });
      }

      return { success: true, checkpointId, restored };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('delete-checkpoint', (event, checkpointId) => {
    try {
      const checkpointDir = path.join(ROLLBACK_DIR, checkpointId);

      if (!fs.existsSync(checkpointDir)) {
        return { success: false, error: 'Checkpoint not found' };
      }

      fs.rmSync(checkpointDir, { recursive: true, force: true });
      console.log(`[Rollback] Deleted checkpoint: ${checkpointId}`);

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ============================================================
  // V7 OB1: ACTIVITY LOG IPC HANDLERS
  // ============================================================

  ipcMain.handle('get-activity-log', (event, filter = {}) => {
    const log = getActivityLog(filter);
    return {
      success: true,
      entries: log,
      total: log.length,
    };
  });

  ipcMain.handle('clear-activity-log', () => {
    clearActivityLog();
    console.log('[Activity] Log cleared');
    return { success: true };
  });

  ipcMain.handle('save-activity-log', () => {
    saveActivityLog();
    return { success: true };
  });

  ipcMain.handle('log-activity', (event, type, paneId, message, details = {}) => {
    logActivity(type, paneId, message, details);
    return { success: true };
  });

  // ============================================================
  // V7 QV2: COMPLETION QUALITY CHECKS
  // ============================================================

  // State machine integration for quality validation before transitions
  const QUALITY_RULES = {
    // State transitions that require validation
    executing: {
      to: ['checkpoint', 'checkpoint_review'],
      validate: true,
    },
    checkpoint_fix: {
      to: ['checkpoint_review'],
      validate: true,
    },
  };

  ipcMain.handle('check-completion-quality', async (event, paneId, claimedWork) => {
    const PANE_ROLES = { '1': 'Lead', '2': 'Worker A', '3': 'Worker B', '4': 'Reviewer' };
    const role = PANE_ROLES[paneId] || `Pane ${paneId}`;
    const issues = [];
    let qualityScore = 100;

    // 1. Check claimed work for incomplete patterns
    const validationResult = calculateConfidence(claimedWork || '');
    if (validationResult < 50) {
      issues.push({
        type: 'low_confidence',
        severity: 'warning',
        message: `Low completion confidence: ${validationResult}%`,
      });
      qualityScore -= 20;
    }

    // 2. Check for uncommitted git changes in project
    const state = watcher.readState();
    if (state.project) {
      try {
        const { execSync } = require('child_process');
        const gitStatus = execSync('git status --porcelain', {
          cwd: state.project,
          encoding: 'utf-8',
        });
        const uncommittedFiles = gitStatus.trim().split('\n').filter(l => l.trim());
        if (uncommittedFiles.length > 0) {
          issues.push({
            type: 'uncommitted_changes',
            severity: 'info',
            message: `${uncommittedFiles.length} uncommitted file(s)`,
            files: uncommittedFiles.slice(0, 5),
          });
          // Don't deduct points for uncommitted - just info
        }
      } catch (err) {
        // Not a git repo or git not available - skip
      }
    }

    // 3. Log the quality check
    logActivity('system', paneId, `Quality check: ${qualityScore}% (${issues.length} issues)`, {
      role,
      qualityScore,
      issues,
    });

    // 4. Determine if completion should be blocked
    const criticalIssues = issues.filter(i => i.severity === 'error');
    const blocked = criticalIssues.length > 0;

    if (blocked) {
      // Emit event to UI
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('quality-check-failed', {
          paneId,
          role,
          issues: criticalIssues,
        });
      }
    }

    return {
      success: true,
      paneId,
      role,
      qualityScore,
      issues,
      blocked,
      timestamp: new Date().toISOString(),
    };
  });

  ipcMain.handle('validate-state-transition', async (event, fromState, toState) => {
    const rule = QUALITY_RULES[fromState];

    // Check if transition requires validation
    if (!rule || !rule.validate || !rule.to.includes(toState)) {
      return { success: true, allowed: true, reason: 'No validation required' };
    }

    // Get active agents and check their work quality
    const state = watcher.readState();
    const activeAgents = state.active_agents || [];
    const qualityResults = [];

    for (const paneId of activeAgents) {
      if (claudeRunning.get(paneId) === 'running') {
        // In real implementation, would get claimed work from agent
        const result = await ipcMain.handle('check-completion-quality', event, paneId, '');
        qualityResults.push(result);
      }
    }

    const anyBlocked = qualityResults.some(r => r.blocked);

    if (anyBlocked) {
      logActivity('system', null, `State transition blocked: ${fromState} → ${toState}`, {
        qualityResults,
      });
    }

    return {
      success: true,
      allowed: !anyBlocked,
      qualityResults,
      reason: anyBlocked ? 'Quality check failed for one or more agents' : 'All quality checks passed',
    };
  });

  ipcMain.handle('get-quality-rules', () => {
    return QUALITY_RULES;
  });

  // ============================================================
  // V8 TE2: TEST EXECUTION DAEMON
  // ============================================================

  const TEST_RESULTS_PATH = path.join(WORKSPACE_PATH, 'test-results.json');

  // Detect test framework from project
  const TEST_FRAMEWORKS = {
    jest: {
      detect: (projectPath) => {
        const pkgPath = path.join(projectPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          return pkg.devDependencies?.jest || pkg.dependencies?.jest ||
                 pkg.scripts?.test?.includes('jest');
        }
        return false;
      },
      command: 'npx',
      args: ['jest', '--json', '--testLocationInResults'],
      parseOutput: (output) => {
        try {
          const result = JSON.parse(output);
          return {
            passed: result.numPassedTests || 0,
            failed: result.numFailedTests || 0,
            total: result.numTotalTests || 0,
            duration: result.testResults?.[0]?.perfStats?.runtime || 0,
            failures: result.testResults?.flatMap(r =>
              r.assertionResults?.filter(a => a.status === 'failed').map(a => ({
                test: a.fullName,
                message: a.failureMessages?.join('\n') || '',
              }))
            ) || [],
          };
        } catch {
          return null;
        }
      },
    },
    npm: {
      detect: (projectPath) => {
        const pkgPath = path.join(projectPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          return !!pkg.scripts?.test;
        }
        return false;
      },
      command: 'npm',
      args: ['test', '--', '--passWithNoTests'],
      parseOutput: (output) => {
        // Basic parsing for npm test output
        const passed = (output.match(/(\d+)\s+(passing|passed)/i) || [])[1] || 0;
        const failed = (output.match(/(\d+)\s+(failing|failed)/i) || [])[1] || 0;
        return {
          passed: parseInt(passed),
          failed: parseInt(failed),
          total: parseInt(passed) + parseInt(failed),
          duration: 0,
          failures: [],
          raw: output,
        };
      },
    },
  };

  let activeTestRun = null;

  ipcMain.handle('detect-test-framework', (event, projectPath) => {
    const detected = [];
    for (const [name, framework] of Object.entries(TEST_FRAMEWORKS)) {
      try {
        if (framework.detect(projectPath)) {
          detected.push(name);
        }
      } catch {
        // Skip detection errors
      }
    }
    return {
      success: true,
      frameworks: detected,
      recommended: detected[0] || null,
    };
  });

  ipcMain.handle('run-tests', async (event, projectPath, frameworkName = null) => {
    if (activeTestRun) {
      return { success: false, error: 'Tests already running' };
    }

    // Detect framework if not specified
    if (!frameworkName) {
      for (const [name, framework] of Object.entries(TEST_FRAMEWORKS)) {
        if (framework.detect(projectPath)) {
          frameworkName = name;
          break;
        }
      }
    }

    if (!frameworkName || !TEST_FRAMEWORKS[frameworkName]) {
      return { success: false, error: 'No test framework detected' };
    }

    const framework = TEST_FRAMEWORKS[frameworkName];
    const runId = `test-${Date.now()}`;

    activeTestRun = {
      id: runId,
      startTime: Date.now(),
      framework: frameworkName,
      status: 'running',
    };

    // Notify UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('test-run-started', { runId, framework: frameworkName });
    }

    try {
      const { execSync } = require('child_process');
      const output = execSync(`${framework.command} ${framework.args.join(' ')}`, {
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 120000, // 2 minute timeout
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const results = framework.parseOutput(output) || {
        passed: 0,
        failed: 0,
        total: 0,
        raw: output,
      };

      results.runId = runId;
      results.framework = frameworkName;
      results.duration = Date.now() - activeTestRun.startTime;
      results.timestamp = new Date().toISOString();
      results.success = results.failed === 0;

      // Save results
      fs.writeFileSync(TEST_RESULTS_PATH, JSON.stringify(results, null, 2), 'utf-8');

      // Notify UI
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('test-run-complete', results);
      }

      activeTestRun = null;
      return { success: true, results };
    } catch (err) {
      const results = {
        runId,
        framework: frameworkName,
        success: false,
        error: err.message,
        output: err.stdout?.toString() || err.stderr?.toString() || '',
        duration: Date.now() - activeTestRun.startTime,
        timestamp: new Date().toISOString(),
      };

      // Try to parse output even on failure
      const parsed = framework.parseOutput(results.output);
      if (parsed) {
        Object.assign(results, parsed);
      }

      fs.writeFileSync(TEST_RESULTS_PATH, JSON.stringify(results, null, 2), 'utf-8');

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('test-run-complete', results);
      }

      activeTestRun = null;
      return { success: true, results };
    }
  });

  ipcMain.handle('get-test-results', () => {
    try {
      if (fs.existsSync(TEST_RESULTS_PATH)) {
        const content = fs.readFileSync(TEST_RESULTS_PATH, 'utf-8');
        return { success: true, results: JSON.parse(content) };
      }
      return { success: true, results: null };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-test-status', () => {
    return {
      success: true,
      running: !!activeTestRun,
      currentRun: activeTestRun,
    };
  });

  // ============================================================
  // V8 CI1: PRE-COMMIT VALIDATION HOOKS
  // ============================================================

  const CI_STATUS_PATH = path.join(WORKSPACE_PATH, 'ci-status.json');

  let ciEnabled = true;
  let lastCiCheck = null;

  ipcMain.handle('run-pre-commit-checks', async (event, projectPath) => {
    const checkId = `ci-${Date.now()}`;
    const checks = [];
    let allPassed = true;

    // 1. Run tests
    const testResult = await new Promise((resolve) => {
      ipcMain.handle('run-tests', event, projectPath).then(resolve);
    }).catch(() => ({ success: false, error: 'Test execution failed' }));

    if (testResult.results) {
      const testsPassed = testResult.results.failed === 0;
      checks.push({
        name: 'tests',
        passed: testsPassed,
        message: testsPassed
          ? `${testResult.results.passed} tests passed`
          : `${testResult.results.failed} tests failed`,
        details: testResult.results,
      });
      if (!testsPassed) allPassed = false;
    }

    // 2. Validate changed files
    try {
      const { execSync } = require('child_process');
      const stagedFiles = execSync('git diff --cached --name-only', {
        cwd: projectPath,
        encoding: 'utf-8',
      }).trim().split('\n').filter(f => f);

      let validationIssues = 0;
      for (const file of stagedFiles) {
        const filePath = path.join(projectPath, file);
        if (fs.existsSync(filePath) && (file.endsWith('.js') || file.endsWith('.json'))) {
          const content = fs.readFileSync(filePath, 'utf-8');
          const confidence = calculateConfidence(content);
          if (confidence < 40) {
            validationIssues++;
          }
        }
      }

      checks.push({
        name: 'validation',
        passed: validationIssues === 0,
        message: validationIssues === 0
          ? `${stagedFiles.length} files validated`
          : `${validationIssues} file(s) with low confidence`,
      });
      if (validationIssues > 0) allPassed = false;
    } catch {
      checks.push({
        name: 'validation',
        passed: true,
        message: 'Skipped (not a git repo)',
      });
    }

    // 3. Check for incomplete markers in staged files
    try {
      const { execSync } = require('child_process');
      const stagedContent = execSync('git diff --cached', {
        cwd: projectPath,
        encoding: 'utf-8',
      });

      const hasIncomplete = INCOMPLETE_PATTERNS.some(p => p.test(stagedContent));
      checks.push({
        name: 'incomplete_check',
        passed: !hasIncomplete,
        message: hasIncomplete
          ? 'Found TODO/FIXME markers in staged changes'
          : 'No incomplete markers found',
      });
      if (hasIncomplete) allPassed = false;
    } catch {
      // Skip if git not available
    }

    lastCiCheck = {
      id: checkId,
      timestamp: new Date().toISOString(),
      passed: allPassed,
      checks,
    };

    // Save status
    fs.writeFileSync(CI_STATUS_PATH, JSON.stringify(lastCiCheck, null, 2), 'utf-8');

    // Notify UI
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ci-check-complete', lastCiCheck);
    }

    return { success: true, ...lastCiCheck };
  });

  ipcMain.handle('get-ci-status', () => {
    try {
      if (fs.existsSync(CI_STATUS_PATH)) {
        const content = fs.readFileSync(CI_STATUS_PATH, 'utf-8');
        return { success: true, status: JSON.parse(content), enabled: ciEnabled };
      }
      return { success: true, status: null, enabled: ciEnabled };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('set-ci-enabled', (event, enabled) => {
    ciEnabled = enabled;
    console.log(`[CI] Pre-commit checks ${enabled ? 'enabled' : 'disabled'}`);
    return { success: true, enabled: ciEnabled };
  });

  ipcMain.handle('should-block-commit', () => {
    if (!ciEnabled) {
      return { success: true, block: false, reason: 'CI checks disabled' };
    }

    if (!lastCiCheck) {
      return { success: true, block: true, reason: 'No CI check has been run' };
    }

    // Check if CI check is stale (> 5 minutes old)
    const checkAge = Date.now() - new Date(lastCiCheck.timestamp).getTime();
    if (checkAge > 5 * 60 * 1000) {
      return { success: true, block: true, reason: 'CI check is stale (> 5 minutes)' };
    }

    return {
      success: true,
      block: !lastCiCheck.passed,
      reason: lastCiCheck.passed ? 'All checks passed' : 'CI checks failed',
      lastCheck: lastCiCheck,
    };
  });

  // ============================================================
  // V8 TR2: TEST FAILURE NOTIFICATIONS
  // ============================================================

  const TEST_NOTIFICATION_SETTINGS = {
    enabled: true,
    flashTab: true,
    blockTransitions: false,
    soundEnabled: false,
  };

  ipcMain.handle('notify-test-failure', (event, results) => {
    if (!TEST_NOTIFICATION_SETTINGS.enabled) {
      return { success: true, notified: false, reason: 'Notifications disabled' };
    }

    const failedCount = results.failed || 0;
    const failures = results.failures || [];

    // Build notification message
    const title = `${failedCount} Test${failedCount !== 1 ? 's' : ''} Failed`;
    const body = failures.slice(0, 3).map(f => f.test || f.name).join('\n') +
                 (failures.length > 3 ? `\n...and ${failures.length - 3} more` : '');

    // Send to renderer for display
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('test-failure-notification', {
        title,
        body,
        failedCount,
        failures: failures.slice(0, 5),
        timestamp: new Date().toISOString(),
      });

      // Flash the Tests tab
      if (TEST_NOTIFICATION_SETTINGS.flashTab) {
        mainWindow.webContents.send('flash-tab', { tab: 'tests', color: 'red' });
      }
    }

    // Log activity
    if (typeof logActivity === 'function') {
      logActivity('error', null, `Test failure: ${failedCount} tests failed`, {
        failedCount,
        failures: failures.slice(0, 5),
      });
    }

    console.log(`[Test Notification] ${title}`);

    return { success: true, notified: true, title, body };
  });

  ipcMain.handle('get-test-notification-settings', () => {
    return { success: true, settings: TEST_NOTIFICATION_SETTINGS };
  });

  ipcMain.handle('set-test-notification-settings', (event, settings) => {
    Object.assign(TEST_NOTIFICATION_SETTINGS, settings);
    console.log('[Test Notification] Settings updated:', TEST_NOTIFICATION_SETTINGS);
    return { success: true, settings: TEST_NOTIFICATION_SETTINGS };
  });

  ipcMain.handle('should-block-on-test-failure', () => {
    if (!TEST_NOTIFICATION_SETTINGS.blockTransitions) {
      return { success: true, block: false, reason: 'Blocking disabled' };
    }

    // Check last test results
    try {
      if (fs.existsSync(TEST_RESULTS_PATH)) {
        const content = fs.readFileSync(TEST_RESULTS_PATH, 'utf-8');
        const results = JSON.parse(content);

        if (results.failed > 0) {
          return {
            success: true,
            block: true,
            reason: `${results.failed} test(s) failing`,
            results,
          };
        }
      }
    } catch (err) {
      // Ignore errors reading results
    }

    return { success: true, block: false, reason: 'Tests passing or no results' };
  });

  // Hook into test-run-complete to auto-notify on failures
  // This is called internally when tests finish
  ipcMain.on('test-run-complete', (event, results) => {
    if (results && results.failed > 0) {
      ipcMain.emit('notify-test-failure', event, results);
    }
  });

  // ============================================================
  // V10 MQ4: MESSAGE QUEUE IPC HANDLERS
  // ============================================================

  ipcMain.handle('init-message-queue', () => {
    return watcher.initMessageQueue();
  });

  ipcMain.handle('send-message', (event, fromPaneId, toPaneId, content, type = 'direct') => {
    return watcher.sendMessage(fromPaneId, toPaneId, content, type);
  });

  ipcMain.handle('send-broadcast-message', (event, fromPaneId, content) => {
    // Send to all other panes
    const results = [];
    for (const toPaneId of ['1', '2', '3', '4']) {
      if (toPaneId !== fromPaneId) {
        const result = watcher.sendMessage(fromPaneId, toPaneId, content, 'broadcast');
        results.push({ toPaneId, ...result });
      }
    }
    return { success: true, results };
  });

  ipcMain.handle('send-group-message', (event, fromPaneId, toPaneIds, content) => {
    const results = [];
    for (const toPaneId of toPaneIds) {
      if (toPaneId !== fromPaneId) {
        const result = watcher.sendMessage(fromPaneId, toPaneId, content, 'direct');
        results.push({ toPaneId, ...result });
      }
    }
    return { success: true, results };
  });

  ipcMain.handle('get-messages', (event, paneId, undeliveredOnly = false) => {
    const messages = watcher.getMessages(paneId, undeliveredOnly);
    return { success: true, messages, count: messages.length };
  });

  ipcMain.handle('get-all-messages', () => {
    const allMessages = {};
    for (const paneId of ['1', '2', '3', '4']) {
      allMessages[paneId] = watcher.getMessages(paneId);
    }
    return { success: true, messages: allMessages };
  });

  ipcMain.handle('mark-message-delivered', (event, paneId, messageId) => {
    return watcher.markMessageDelivered(paneId, messageId);
  });

  ipcMain.handle('clear-messages', (event, paneId, deliveredOnly = false) => {
    return watcher.clearMessages(paneId, deliveredOnly);
  });

  ipcMain.handle('get-message-queue-status', () => {
    return watcher.getMessageQueueStatus();
  });

  ipcMain.handle('start-message-watcher', () => {
    watcher.startMessageWatcher();
    return { success: true };
  });

  // ============================================================
  // V9 DC3: API DOCUMENTATION GENERATOR
  // ============================================================

  const API_DOCS_PATH = path.join(WORKSPACE_PATH, 'api-docs.md');

  // Handler metadata for documentation
  const IPC_HANDLER_DOCS = {
    // PTY Handlers
    'pty-create': {
      category: 'PTY/Terminal',
      description: 'Create a new pseudo-terminal for a pane',
      params: { paneId: 'string - Pane identifier (1-4)', workingDir: 'string - Working directory path' },
      returns: '{ paneId, cwd, dryRun } | { error }',
    },
    'pty-write': {
      category: 'PTY/Terminal',
      description: 'Write data to a terminal',
      params: { paneId: 'string', data: 'string - Data to write' },
      returns: 'void',
    },
    'pty-resize': {
      category: 'PTY/Terminal',
      description: 'Resize a terminal',
      params: { paneId: 'string', cols: 'number', rows: 'number' },
      returns: 'void',
    },
    'pty-kill': {
      category: 'PTY/Terminal',
      description: 'Kill a terminal process',
      params: { paneId: 'string' },
      returns: 'void',
    },
    'spawn-claude': {
      category: 'PTY/Terminal',
      description: 'Spawn Claude CLI in a terminal pane',
      params: { paneId: 'string', workingDir: 'string' },
      returns: '{ success, command, dryRun? } | { success: false, error }',
    },
    'get-claude-state': {
      category: 'PTY/Terminal',
      description: 'Get Claude running state for all panes',
      params: {},
      returns: '{ paneId: "idle"|"starting"|"running" }',
    },
    'get-daemon-terminals': {
      category: 'PTY/Terminal',
      description: 'Get list of active daemon terminals',
      params: {},
      returns: 'Terminal[]',
    },
    // Shared Context
    'read-shared-context': {
      category: 'Shared Context',
      description: 'Read shared context file content',
      params: {},
      returns: '{ success, content } | { success: false, error }',
    },
    'write-shared-context': {
      category: 'Shared Context',
      description: 'Write content to shared context file',
      params: { content: 'string' },
      returns: '{ success } | { success: false, error }',
    },
    'get-shared-context-path': {
      category: 'Shared Context',
      description: 'Get the path to shared context file',
      params: {},
      returns: 'string - File path',
    },
    // State Management
    'get-state': {
      category: 'State',
      description: 'Get current workflow state',
      params: {},
      returns: 'State object',
    },
    'set-state': {
      category: 'State',
      description: 'Set workflow state',
      params: { newState: 'string' },
      returns: 'State object',
    },
    'trigger-sync': {
      category: 'State',
      description: 'Trigger sync notification to all agents',
      params: { file: 'string - File that changed (default: shared_context.md)' },
      returns: '{ success, file }',
    },
    'broadcast-message': {
      category: 'State',
      description: 'Broadcast a message to all agents',
      params: { message: 'string' },
      returns: 'Result object',
    },
    // Settings
    'get-settings': {
      category: 'Settings',
      description: 'Get current settings',
      params: {},
      returns: 'Settings object',
    },
    'set-setting': {
      category: 'Settings',
      description: 'Set a single setting value',
      params: { key: 'string', value: 'any' },
      returns: 'Settings object',
    },
    'get-all-settings': {
      category: 'Settings',
      description: 'Get all settings',
      params: {},
      returns: 'Settings object',
    },
    // Project Management
    'select-project': {
      category: 'Projects',
      description: 'Open folder picker to select a project',
      params: {},
      returns: '{ success, path, name } | { success: false, canceled }',
    },
    'get-project': {
      category: 'Projects',
      description: 'Get current project path',
      params: {},
      returns: 'string | null',
    },
    'get-recent-projects': {
      category: 'Projects',
      description: 'Get list of recent projects',
      params: {},
      returns: '{ success, projects: Project[] }',
    },
    'switch-project': {
      category: 'Projects',
      description: 'Switch to a different project',
      params: { projectPath: 'string' },
      returns: '{ success, path, name } | { success: false, error }',
    },
    // Per-Pane Projects (V5)
    'set-pane-project': {
      category: 'Multi-Project',
      description: 'Assign a project to a specific pane',
      params: { paneId: 'string', projectPath: 'string | null' },
      returns: '{ success, paneId, projectPath }',
    },
    'get-pane-project': {
      category: 'Multi-Project',
      description: 'Get project assigned to a pane',
      params: { paneId: 'string' },
      returns: '{ success, paneId, projectPath }',
    },
    'get-all-pane-projects': {
      category: 'Multi-Project',
      description: 'Get all pane project assignments',
      params: {},
      returns: '{ success, paneProjects }',
    },
    // Templates (V5)
    'save-template': {
      category: 'Templates',
      description: 'Save a configuration template',
      params: { template: '{ name, description?, config?, paneProjects? }' },
      returns: '{ success, template }',
    },
    'load-template': {
      category: 'Templates',
      description: 'Load and apply a template',
      params: { templateId: 'string' },
      returns: '{ success, template }',
    },
    'list-templates': {
      category: 'Templates',
      description: 'List all saved templates',
      params: {},
      returns: '{ success, templates: TemplateSummary[] }',
    },
    'delete-template': {
      category: 'Templates',
      description: 'Delete a template',
      params: { templateId: 'string' },
      returns: '{ success }',
    },
    // Agent Claims (V4)
    'claim-agent': {
      category: 'Agent Management',
      description: 'Claim an agent for a task',
      params: { paneId: 'string', taskId: 'string', description: 'string' },
      returns: 'Claim result',
    },
    'release-agent': {
      category: 'Agent Management',
      description: 'Release an agent claim',
      params: { paneId: 'string' },
      returns: 'Release result',
    },
    'get-claims': {
      category: 'Agent Management',
      description: 'Get all active agent claims',
      params: {},
      returns: 'Claims object',
    },
    'nudge-agent': {
      category: 'Agent Management',
      description: 'Send a nudge message to a stuck agent',
      params: { paneId: 'string', message: 'string?' },
      returns: '{ success, pane }',
    },
    'nudge-all-stuck': {
      category: 'Agent Management',
      description: 'Nudge all stuck agents',
      params: {},
      returns: '{ success, nudged: string[] }',
    },
    // Smart Routing (V6)
    'route-task': {
      category: 'Smart Routing',
      description: 'Route a task to the best agent',
      params: { taskType: 'string', message: 'string' },
      returns: 'Routing result',
    },
    'get-best-agent': {
      category: 'Smart Routing',
      description: 'Get the best agent for a task type',
      params: { taskType: 'string' },
      returns: 'Agent recommendation',
    },
    'trigger-handoff': {
      category: 'Smart Routing',
      description: 'Trigger automatic handoff to next agent',
      params: { fromPaneId: 'string', message: 'string' },
      returns: 'Handoff result',
    },
    // Conflict Resolution (V6)
    'request-file-access': {
      category: 'Conflict Resolution',
      description: 'Request exclusive access to a file',
      params: { filePath: 'string', paneId: 'string', operation: 'string' },
      returns: '{ granted, queued?, position? }',
    },
    'release-file-access': {
      category: 'Conflict Resolution',
      description: 'Release file access lock',
      params: { filePath: 'string', paneId: 'string' },
      returns: 'Release result',
    },
    'get-conflict-queue-status': {
      category: 'Conflict Resolution',
      description: 'Get current conflict queue status',
      params: {},
      returns: 'Queue status object',
    },
    // Learning (V6)
    'record-task-outcome': {
      category: 'Learning',
      description: 'Record task success/failure for learning',
      params: { taskType: 'string', paneId: 'string', success: 'boolean', timeMs: 'number' },
      returns: '{ success, successRate, newWeight }',
    },
    'get-learning-data': {
      category: 'Learning',
      description: 'Get all learning data and insights',
      params: {},
      returns: '{ taskTypes, routingWeights, insights }',
    },
    'get-best-agent-for-task': {
      category: 'Learning',
      description: 'Get best agent based on historical performance',
      params: { taskType: 'string' },
      returns: '{ bestAgent, reason }',
    },
    // Activity Log (V7)
    'get-activity-log': {
      category: 'Observability',
      description: 'Get activity log entries with optional filters',
      params: { filter: '{ type?, paneId?, since?, search? }' },
      returns: '{ success, entries, total }',
    },
    'log-activity': {
      category: 'Observability',
      description: 'Log a custom activity entry',
      params: { type: 'string', paneId: 'string', message: 'string', details: 'object' },
      returns: '{ success }',
    },
    'clear-activity-log': {
      category: 'Observability',
      description: 'Clear all activity log entries',
      params: {},
      returns: '{ success }',
    },
    // Validation (V7)
    'validate-output': {
      category: 'Quality',
      description: 'Validate text output for completeness',
      params: { text: 'string', options: '{ checkSyntax?, checkJson?, language? }' },
      returns: '{ valid, confidence, issues, warnings }',
    },
    'validate-file': {
      category: 'Quality',
      description: 'Validate a file for completeness',
      params: { filePath: 'string', options: 'object' },
      returns: '{ valid, confidence, issues, filePath }',
    },
    'check-completion-quality': {
      category: 'Quality',
      description: 'Check quality of claimed work',
      params: { paneId: 'string', claimedWork: 'string' },
      returns: '{ qualityScore, issues, blocked }',
    },
    // Rollback (V7)
    'create-checkpoint': {
      category: 'Rollback',
      description: 'Create a file checkpoint for rollback',
      params: { files: 'string[]', label: 'string' },
      returns: '{ success, checkpointId, files }',
    },
    'list-checkpoints': {
      category: 'Rollback',
      description: 'List all available checkpoints',
      params: {},
      returns: '{ success, checkpoints }',
    },
    'rollback-checkpoint': {
      category: 'Rollback',
      description: 'Restore files from a checkpoint',
      params: { checkpointId: 'string' },
      returns: '{ success, restored }',
    },
    'get-checkpoint-diff': {
      category: 'Rollback',
      description: 'Get diff between checkpoint and current files',
      params: { checkpointId: 'string' },
      returns: '{ success, diffs }',
    },
    // Test Execution (V8)
    'detect-test-framework': {
      category: 'Testing',
      description: 'Detect test framework in a project',
      params: { projectPath: 'string' },
      returns: '{ success, frameworks, recommended }',
    },
    'run-tests': {
      category: 'Testing',
      description: 'Run tests in a project',
      params: { projectPath: 'string', frameworkName: 'string?' },
      returns: '{ success, results }',
    },
    'get-test-results': {
      category: 'Testing',
      description: 'Get last test run results',
      params: {},
      returns: '{ success, results }',
    },
    'get-test-status': {
      category: 'Testing',
      description: 'Get current test run status',
      params: {},
      returns: '{ success, running, currentRun }',
    },
    // CI (V8)
    'run-pre-commit-checks': {
      category: 'CI',
      description: 'Run all pre-commit validation checks',
      params: { projectPath: 'string' },
      returns: '{ success, passed, checks }',
    },
    'get-ci-status': {
      category: 'CI',
      description: 'Get CI check status',
      params: {},
      returns: '{ success, status, enabled }',
    },
    'should-block-commit': {
      category: 'CI',
      description: 'Check if commit should be blocked',
      params: {},
      returns: '{ success, block, reason }',
    },
    // Usage Stats
    'get-usage-stats': {
      category: 'Usage',
      description: 'Get session usage statistics',
      params: {},
      returns: '{ totalSpawns, sessionTime, estimatedCost, ... }',
    },
    'reset-usage-stats': {
      category: 'Usage',
      description: 'Reset all usage statistics',
      params: {},
      returns: '{ success }',
    },
    'get-session-history': {
      category: 'Usage',
      description: 'Get session history',
      params: { limit: 'number' },
      returns: '{ success, history, total }',
    },
    // Performance (V5)
    'record-completion': {
      category: 'Performance',
      description: 'Record agent task completion',
      params: { paneId: 'string' },
      returns: '{ success, completions }',
    },
    'record-error': {
      category: 'Performance',
      description: 'Record agent error',
      params: { paneId: 'string' },
      returns: '{ success, errors }',
    },
    'get-performance': {
      category: 'Performance',
      description: 'Get agent performance metrics',
      params: {},
      returns: '{ success, agents, lastUpdated }',
    },
    // Screenshots
    'save-screenshot': {
      category: 'Screenshots',
      description: 'Save a screenshot',
      params: { base64Data: 'string', originalName: 'string' },
      returns: '{ success, filename, path }',
    },
    'list-screenshots': {
      category: 'Screenshots',
      description: 'List all screenshots',
      params: {},
      returns: '{ success, files }',
    },
    // Background Processes
    'spawn-process': {
      category: 'Processes',
      description: 'Spawn a background process',
      params: { command: 'string', args: 'string[]', cwd: 'string' },
      returns: '{ success, id, pid }',
    },
    'list-processes': {
      category: 'Processes',
      description: 'List all background processes',
      params: {},
      returns: '{ success, processes }',
    },
    'kill-process': {
      category: 'Processes',
      description: 'Kill a background process',
      params: { processId: 'string' },
      returns: '{ success }',
    },
  };

  ipcMain.handle('generate-api-docs', () => {
    const categories = {};

    // Group by category
    for (const [handler, doc] of Object.entries(IPC_HANDLER_DOCS)) {
      const cat = doc.category || 'Uncategorized';
      if (!categories[cat]) {
        categories[cat] = [];
      }
      categories[cat].push({ handler, ...doc });
    }

    // Generate markdown
    let markdown = `# Hivemind IPC API Documentation\n\n`;
    markdown += `Generated: ${new Date().toISOString()}\n\n`;
    markdown += `Total Handlers: ${Object.keys(IPC_HANDLER_DOCS).length}\n\n`;
    markdown += `---\n\n`;

    // Table of Contents
    markdown += `## Table of Contents\n\n`;
    for (const cat of Object.keys(categories).sort()) {
      markdown += `- [${cat}](#${cat.toLowerCase().replace(/[^a-z0-9]+/g, '-')})\n`;
    }
    markdown += `\n---\n\n`;

    // Each category
    for (const cat of Object.keys(categories).sort()) {
      markdown += `## ${cat}\n\n`;

      for (const doc of categories[cat]) {
        markdown += `### \`${doc.handler}\`\n\n`;
        markdown += `${doc.description}\n\n`;

        if (Object.keys(doc.params).length > 0) {
          markdown += `**Parameters:**\n`;
          for (const [param, desc] of Object.entries(doc.params)) {
            markdown += `- \`${param}\`: ${desc}\n`;
          }
          markdown += `\n`;
        } else {
          markdown += `**Parameters:** None\n\n`;
        }

        markdown += `**Returns:** \`${doc.returns}\`\n\n`;
        markdown += `---\n\n`;
      }
    }

    // Save to file
    try {
      fs.writeFileSync(API_DOCS_PATH, markdown, 'utf-8');
      console.log(`[API Docs] Generated documentation: ${Object.keys(IPC_HANDLER_DOCS).length} handlers`);
    } catch (err) {
      console.error('[API Docs] Error saving:', err.message);
    }

    return {
      success: true,
      path: API_DOCS_PATH,
      handlerCount: Object.keys(IPC_HANDLER_DOCS).length,
      categoryCount: Object.keys(categories).length,
    };
  });

  ipcMain.handle('get-api-docs', () => {
    try {
      if (fs.existsSync(API_DOCS_PATH)) {
        const content = fs.readFileSync(API_DOCS_PATH, 'utf-8');
        return { success: true, content, path: API_DOCS_PATH };
      }

      // Generate if doesn't exist
      const result = ipcMain._events['generate-api-docs']?.[0]?.();
      if (result?.success) {
        const content = fs.readFileSync(API_DOCS_PATH, 'utf-8');
        return { success: true, content, path: API_DOCS_PATH };
      }

      return { success: false, error: 'Documentation not generated' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-handler-doc', (event, handlerName) => {
    const doc = IPC_HANDLER_DOCS[handlerName];
    if (!doc) {
      return { success: false, error: 'Handler not found' };
    }
    return { success: true, handler: handlerName, ...doc };
  });

  ipcMain.handle('list-api-handlers', () => {
    const handlers = Object.entries(IPC_HANDLER_DOCS).map(([name, doc]) => ({
      name,
      category: doc.category,
      description: doc.description,
    }));

    return {
      success: true,
      handlers,
      total: handlers.length,
    };
  });

  ipcMain.handle('search-api-docs', (event, query) => {
    const queryLower = query.toLowerCase();
    const matches = [];

    for (const [handler, doc] of Object.entries(IPC_HANDLER_DOCS)) {
      const searchText = `${handler} ${doc.description} ${doc.category}`.toLowerCase();
      if (searchText.includes(queryLower)) {
        matches.push({ handler, ...doc });
      }
    }

    return {
      success: true,
      query,
      matches,
      count: matches.length,
    };
  });

  // ============================================================
  // V9 PL3: PERFORMANCE AUDIT
  // ============================================================

  const PERF_PROFILE_PATH = path.join(WORKSPACE_PATH, 'perf-profile.json');

  // Performance profiling data
  const perfProfile = {
    handlers: {}, // handler -> { calls, totalMs, avgMs, maxMs, minMs }
    slowCalls: [], // { handler, duration, timestamp }
    enabled: true,
    slowThreshold: 100, // ms - calls slower than this are logged
  };

  // Load existing profile data
  try {
    if (fs.existsSync(PERF_PROFILE_PATH)) {
      const content = fs.readFileSync(PERF_PROFILE_PATH, 'utf-8');
      Object.assign(perfProfile, JSON.parse(content));
    }
  } catch (err) {
    console.error('[Perf] Error loading profile:', err.message);
  }

  function recordHandlerPerf(handler, durationMs) {
    if (!perfProfile.enabled) return;

    if (!perfProfile.handlers[handler]) {
      perfProfile.handlers[handler] = {
        calls: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
        minMs: Infinity,
      };
    }

    const stats = perfProfile.handlers[handler];
    stats.calls++;
    stats.totalMs += durationMs;
    stats.avgMs = Math.round(stats.totalMs / stats.calls);
    stats.maxMs = Math.max(stats.maxMs, durationMs);
    stats.minMs = Math.min(stats.minMs, durationMs);

    // Track slow calls
    if (durationMs > perfProfile.slowThreshold) {
      perfProfile.slowCalls.push({
        handler,
        duration: durationMs,
        timestamp: new Date().toISOString(),
      });

      // Keep only last 50 slow calls
      if (perfProfile.slowCalls.length > 50) {
        perfProfile.slowCalls.shift();
      }

      console.log(`[Perf] Slow call: ${handler} took ${durationMs}ms`);
    }
  }

  function savePerfProfile() {
    try {
      const tempPath = PERF_PROFILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(perfProfile, null, 2), 'utf-8');
      fs.renameSync(tempPath, PERF_PROFILE_PATH);
    } catch (err) {
      console.error('[Perf] Error saving profile:', err.message);
    }
  }

  ipcMain.handle('get-perf-profile', () => {
    // Calculate additional metrics
    const sortedByAvg = Object.entries(perfProfile.handlers)
      .map(([handler, stats]) => ({ handler, ...stats }))
      .sort((a, b) => b.avgMs - a.avgMs);

    const sortedByCalls = Object.entries(perfProfile.handlers)
      .map(([handler, stats]) => ({ handler, ...stats }))
      .sort((a, b) => b.calls - a.calls);

    const totalCalls = Object.values(perfProfile.handlers)
      .reduce((sum, s) => sum + s.calls, 0);

    const totalTime = Object.values(perfProfile.handlers)
      .reduce((sum, s) => sum + s.totalMs, 0);

    return {
      success: true,
      handlers: perfProfile.handlers,
      slowCalls: perfProfile.slowCalls.slice(-20),
      slowThreshold: perfProfile.slowThreshold,
      enabled: perfProfile.enabled,
      summary: {
        totalHandlers: Object.keys(perfProfile.handlers).length,
        totalCalls,
        totalTimeMs: totalTime,
        avgCallTime: totalCalls > 0 ? Math.round(totalTime / totalCalls) : 0,
        slowestHandlers: sortedByAvg.slice(0, 5),
        mostCalled: sortedByCalls.slice(0, 5),
      },
    };
  });

  ipcMain.handle('set-perf-enabled', (event, enabled) => {
    perfProfile.enabled = enabled;
    console.log(`[Perf] Profiling ${enabled ? 'enabled' : 'disabled'}`);
    return { success: true, enabled };
  });

  ipcMain.handle('set-slow-threshold', (event, thresholdMs) => {
    perfProfile.slowThreshold = thresholdMs;
    console.log(`[Perf] Slow threshold set to ${thresholdMs}ms`);
    return { success: true, threshold: thresholdMs };
  });

  ipcMain.handle('reset-perf-profile', () => {
    perfProfile.handlers = {};
    perfProfile.slowCalls = [];
    savePerfProfile();
    console.log('[Perf] Profile reset');
    return { success: true };
  });

  ipcMain.handle('save-perf-profile', () => {
    savePerfProfile();
    return { success: true, path: PERF_PROFILE_PATH };
  });

  ipcMain.handle('get-slow-handlers', (event, limit = 10) => {
    const sorted = Object.entries(perfProfile.handlers)
      .map(([handler, stats]) => ({ handler, ...stats }))
      .filter(h => h.avgMs > 0)
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, limit);

    return {
      success: true,
      handlers: sorted,
      threshold: perfProfile.slowThreshold,
    };
  });

  ipcMain.handle('get-handler-perf', (event, handlerName) => {
    const stats = perfProfile.handlers[handlerName];
    if (!stats) {
      return { success: false, error: 'No performance data for handler' };
    }

    // Get slow calls for this handler
    const slowCalls = perfProfile.slowCalls
      .filter(c => c.handler === handlerName)
      .slice(-10);

    return {
      success: true,
      handler: handlerName,
      stats,
      slowCalls,
    };
  });

  ipcMain.handle('benchmark-handler', async (event, handlerName, iterations = 10) => {
    // Simple benchmarking - call the handler multiple times and measure
    const times = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      try {
        // Try to invoke the handler with minimal args
        await ipcMain._events[handlerName]?.[0]?.();
      } catch {
        // Ignore errors during benchmark
      }
      times.push(Date.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);

    return {
      success: true,
      handler: handlerName,
      iterations,
      avgMs: Math.round(avg),
      minMs: min,
      maxMs: max,
      times,
    };
  });

  // Auto-save performance profile periodically
  setInterval(() => {
    if (Object.keys(perfProfile.handlers).length > 0) {
      savePerfProfile();
    }
  }, 60000); // Save every minute

  // ============================================================
  // V9 PL1: ERROR MESSAGE IMPROVEMENTS
  // ============================================================

  // User-friendly error messages with recovery suggestions
  const ERROR_MESSAGES = {
    DAEMON_NOT_CONNECTED: {
      title: 'Daemon Disconnected',
      message: 'Terminal daemon is not running.',
      recovery: 'Run "npm run daemon:start" in the ui folder, then restart the app.',
    },
    CLAUDE_NOT_FOUND: {
      title: 'Claude Not Found',
      message: 'Claude Code CLI is not installed or not in PATH.',
      recovery: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
    },
    PROJECT_NOT_FOUND: {
      title: 'Project Not Found',
      message: 'The selected project folder does not exist.',
      recovery: 'Click "Select Project" to choose a valid folder.',
    },
    FILE_WRITE_ERROR: {
      title: 'File Write Failed',
      message: 'Could not write to file. Check permissions.',
      recovery: 'Ensure the file is not locked and you have write permissions.',
    },
    TEST_TIMEOUT: {
      title: 'Test Timeout',
      message: 'Tests took too long to complete.',
      recovery: 'Check for infinite loops or long-running tests. Increase timeout in settings.',
    },
    GIT_NOT_FOUND: {
      title: 'Git Not Found',
      message: 'Git is not installed or not in PATH.',
      recovery: 'Install Git from https://git-scm.com/',
    },
    VALIDATION_FAILED: {
      title: 'Validation Failed',
      message: 'Content validation found issues.',
      recovery: 'Check activity log for details. Fix incomplete markers.',
    },
    STATE_TRANSITION_BLOCKED: {
      title: 'Transition Blocked',
      message: 'Cannot change state due to workflow rules.',
      recovery: 'Ensure Reviewer has approved the plan before starting work.',
    },
  };

  ipcMain.handle('get-error-message', (event, errorCode) => {
    const errorInfo = ERROR_MESSAGES[errorCode];
    if (!errorInfo) {
      return {
        success: false,
        error: 'Unknown error code',
        fallback: {
          title: 'Error',
          message: `An error occurred: ${errorCode}`,
          recovery: 'Check the console for more details.',
        },
      };
    }
    return { success: true, ...errorInfo };
  });

  ipcMain.handle('show-error-toast', (event, errorCode, additionalInfo = {}) => {
    const errorInfo = ERROR_MESSAGES[errorCode] || {
      title: 'Error',
      message: additionalInfo.message || 'An unexpected error occurred.',
      recovery: 'Check the console for details.',
    };

    // Send to renderer for display
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('error-toast', {
        ...errorInfo,
        code: errorCode,
        timestamp: new Date().toISOString(),
        ...additionalInfo,
      });
    }

    // Log activity
    if (typeof logActivity === 'function') {
      logActivity('error', null, `${errorInfo.title}: ${errorInfo.message}`, {
        code: errorCode,
        recovery: errorInfo.recovery,
        ...additionalInfo,
      });
    }

    console.error(`[Error] ${errorInfo.title}: ${errorInfo.message}`);

    return { success: true, shown: true };
  });

  ipcMain.handle('list-error-codes', () => {
    return {
      success: true,
      codes: Object.keys(ERROR_MESSAGES),
      errors: ERROR_MESSAGES,
    };
  });

  // Friendly wrapper for common errors
  ipcMain.handle('handle-error', (event, error, context = {}) => {
    // Try to map error to known code
    const errorStr = error?.message || String(error);
    let code = 'UNKNOWN';

    if (errorStr.includes('daemon') || errorStr.includes('not connected')) {
      code = 'DAEMON_NOT_CONNECTED';
    } else if (errorStr.includes('claude') && errorStr.includes('not found')) {
      code = 'CLAUDE_NOT_FOUND';
    } else if (errorStr.includes('ENOENT') || errorStr.includes('not found')) {
      code = 'PROJECT_NOT_FOUND';
    } else if (errorStr.includes('EACCES') || errorStr.includes('permission')) {
      code = 'FILE_WRITE_ERROR';
    } else if (errorStr.includes('timeout')) {
      code = 'TEST_TIMEOUT';
    } else if (errorStr.includes('git')) {
      code = 'GIT_NOT_FOUND';
    }

    // Show toast
    ipcMain.emit('show-error-toast', event, code, { originalError: errorStr, ...context });

    return { success: true, code, handled: true };
  });
}

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

function getBackgroundProcesses() {
  return backgroundProcesses;
}

function cleanupProcesses() {
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
}

module.exports = {
  init,
  setDaemonClient,
  setupIPCHandlers,
  getBackgroundProcesses,
  cleanupProcesses,
};
