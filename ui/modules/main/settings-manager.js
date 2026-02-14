/**
 * Settings Manager
 * Handles configuration and settings persistence for the main process
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const log = require('../logger');
const { WORKSPACE_PATH } = require('../../config');

const CLI_NAMES = ['claude', 'codex', 'gemini'];
const CLI_PREFERENCES = {
  '1': ['claude', 'codex', 'gemini'],
  '2': ['codex', 'claude', 'gemini'],
  '5': ['gemini', 'codex', 'claude'],
};
const CLI_DISCOVERY_TIMEOUT_MS = 2000;
const CLI_VERSION_TIMEOUT_MS = 2500;

function buildGeminiCommand() {
  return `gemini --yolo --include-directories "${WORKSPACE_PATH}"`;
}

function buildCommandForCli(cli) {
  if (cli === 'codex') return 'codex';
  if (cli === 'gemini') return buildGeminiCommand();
  return 'claude';
}

function extractCliFromCommand(command) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('claude')) return 'claude';
  if (lowered.startsWith('codex')) return 'codex';
  if (lowered.startsWith('gemini')) return 'gemini';

  const tokenMatch = trimmed.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const token = tokenMatch ? (tokenMatch[1] || tokenMatch[2] || tokenMatch[3]) : trimmed.split(/\s+/)[0];
  if (!token) return null;

  const base = path.basename(token).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
  if (base.includes('claude')) return 'claude';
  if (base.includes('codex')) return 'codex';
  if (base.includes('gemini')) return 'gemini';
  return null;
}

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
  dryRun: false,
  mcpAutoConfig: false,
  recentProjects: [],
  stuckThreshold: 120000,
  autoNudge: true,
  ptyStuckDetection: false,
  ptyStuckThreshold: 15000,
  paneProjects: { '1': null, '2': null, '5': null },
  paneCommands: {
    '1': 'claude',
    '2': 'codex',
    '5': buildGeminiCommand(),
  },
  templates: [],
  voiceInputEnabled: false,
  voiceAutoSend: false,
  voiceLanguage: 'en-US',
};

class SettingsManager {
  constructor(appContext) {
    this.ctx = appContext;
    this.settingsPath = path.join(__dirname, '..', '..', 'settings.json');
    this.appStatusPath = path.join(WORKSPACE_PATH, 'app-status.json');
    
    // Deep clone defaults to prevent reference sharing
    this.ctx.currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  loadSettings() {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const content = fs.readFileSync(this.settingsPath, 'utf-8');
        const loaded = JSON.parse(content);
        
        // Deep merge paneCommands and paneProjects to preserve defaults for missing keys
        const paneCommands = { ...DEFAULT_SETTINGS.paneCommands, ...(loaded.paneCommands || {}) };
        const paneProjects = { ...DEFAULT_SETTINGS.paneProjects, ...(loaded.paneProjects || {}) };
        
        Object.assign(this.ctx.currentSettings, DEFAULT_SETTINGS, loaded, { paneCommands, paneProjects });
      }
    } catch (err) {
      log.error('Settings', 'Error loading settings', err);
      Object.assign(this.ctx.currentSettings, DEFAULT_SETTINGS);
    }
    return this.ctx.currentSettings;
  }

  saveSettings(settings) {
    try {
      Object.assign(this.ctx.currentSettings, settings);
      
      const tempPath = this.settingsPath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.ctx.currentSettings, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.settingsPath);

      this.writeAppStatus();
    } catch (err) {
      log.error('Settings', 'Error saving settings', err);
    }
    return this.ctx.currentSettings;
  }

  writeAppStatus() {
    try {
      const explicitMode = this.ctx.currentSettings.sdkMode === true
        ? 'sdk'
        : (this.ctx.currentSettings.dryRun ? 'dry-run' : 'pty');
      const status = {
        started: new Date().toISOString(),
        mode: explicitMode,
        dryRun: this.ctx.currentSettings.dryRun || false,
        autoSpawn: this.ctx.currentSettings.autoSpawn || false,
        version: require('../../package.json').version || 'unknown',
        platform: process.platform,
        nodeVersion: process.version,
        lastUpdated: new Date().toISOString(),
      };
      const tempPath = this.appStatusPath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(status, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.appStatusPath);
      log.info('App Status', 'Written');
    } catch (err) {
      log.error('App Status', 'Error writing', err.message);
    }
  }

  ensureCodexConfig() {
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

      fs.writeFileSync(configPath, content, 'utf-8');
    } catch (err) {
      log.error('Codex', 'Failed to ensure config.toml:', err.message);
    }
  }

  detectInstalledClis() {
    const installed = { claude: false, codex: false, gemini: false };
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';

    for (const cli of CLI_NAMES) {
      let found = false;
      try {
        const locate = spawnSync(locator, [cli], {
          windowsHide: true,
          timeout: CLI_DISCOVERY_TIMEOUT_MS,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        found = Boolean(locate && locate.status === 0 && String(locate.stdout || '').trim());
      } catch (_) {
        found = false;
      }
      if (!found) continue;

      try {
        const version = spawnSync(cli, ['--version'], {
          windowsHide: true,
          timeout: CLI_VERSION_TIMEOUT_MS,
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        installed[cli] = Boolean(version && version.status === 0);
      } catch (_) {
        installed[cli] = false;
      }
    }

    return installed;
  }

  resolvePaneCommandsFromAvailability(installed) {
    const paneCommands = {};
    for (const paneId of Object.keys(CLI_PREFERENCES)) {
      const preferred = CLI_PREFERENCES[paneId];
      const selectedCli = preferred.find(cli => installed[cli]) || preferred[0];
      paneCommands[paneId] = buildCommandForCli(selectedCli);
    }
    return paneCommands;
  }

  commandNeedsRewrite(command, installed) {
    // Only rewrite empty/missing commands — never override user's explicit model choice.
    // If a CLI is uninstalled, the pane will show a spawn error (visible feedback).
    if (typeof command !== 'string' || !command.trim()) return true;
    return false;
  }

  autoDetectPaneCommandsOnStartup() {
    try {
      const installed = this.detectInstalledClis();
      const anyInstalled = Object.values(installed).some(Boolean);
      if (!anyInstalled) {
        log.warn('Settings', 'CLI auto-detection found no installed CLIs; keeping existing paneCommands');
        return { changed: false, installed, updatedPanes: [] };
      }

      const recommended = this.resolvePaneCommandsFromAvailability(installed);
      const current = { ...(this.ctx.currentSettings.paneCommands || {}) };
      const updatedPanes = [];

      for (const paneId of Object.keys(CLI_PREFERENCES)) {
        if (this.commandNeedsRewrite(current[paneId], installed)) {
          current[paneId] = recommended[paneId];
          updatedPanes.push(paneId);
        }
      }

      if (updatedPanes.length > 0) {
        this.saveSettings({ paneCommands: current });
        log.info('Settings', `CLI auto-detection updated paneCommands for panes: ${updatedPanes.join(', ')}`);
        return { changed: true, installed, updatedPanes, paneCommands: current };
      }

      log.debug('Settings', 'CLI auto-detection found no paneCommands changes');
      return { changed: false, installed, updatedPanes: [] };
    } catch (err) {
      log.warn('Settings', `CLI auto-detection failed: ${err.message}`);
      return { changed: false, error: err.message, updatedPanes: [] };
    }
  }
}

module.exports = SettingsManager;
