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
