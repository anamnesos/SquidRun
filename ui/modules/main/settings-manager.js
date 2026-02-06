/**
 * Settings Manager
 * Handles configuration and settings persistence for the main process
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('../logger');
const { WORKSPACE_PATH } = require('../../config');

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
  paneProjects: { '1': null, '2': null, '4': null, '5': null },
  paneCommands: {
    '1': 'claude',
    '2': 'codex',
    '4': 'codex',
    '5': 'gemini --yolo --include-directories "D:\\projects\\hivemind"',
  },
  templates: [],
  voiceInputEnabled: false,
  voiceAutoSend: false,
  voiceLanguage: 'en-US',
  sdkMode: false,
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
      const sdkModeChanged = settings.sdkMode !== undefined && settings.sdkMode !== this.ctx.currentSettings.sdkMode;
      Object.assign(this.ctx.currentSettings, settings);
      
      const tempPath = this.settingsPath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.ctx.currentSettings, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.settingsPath);

      if (sdkModeChanged) {
        if (this.ctx.triggers) {
          this.ctx.triggers.setSDKMode(this.ctx.currentSettings.sdkMode);
        }
        log.info('Settings', `SDK mode ${this.ctx.currentSettings.sdkMode ? 'ENABLED' : 'DISABLED'}`);
        this.writeAppStatus();
      }
    } catch (err) {
      log.error('Settings', 'Error saving settings', err);
    }
    return this.ctx.currentSettings;
  }

  writeAppStatus() {
    try {
      const status = {
        started: new Date().toISOString(),
        sdkMode: this.ctx.currentSettings.sdkMode || false,
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
      log.info('App Status', `Written: ${status.sdkMode ? 'SDK mode' : 'PTY mode'}`);
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
}

module.exports = SettingsManager;
