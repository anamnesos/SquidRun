/**
 * Settings Manager
 * Handles configuration and settings persistence for the main process
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const log = require('../logger');
const { WORKSPACE_PATH, PROJECT_ROOT, resolvePaneCwd, resolveCoordPath } = require('../../config');

const CLI_NAMES = ['claude', 'codex', 'gemini'];
const CLI_PREFERENCES = {
  '1': ['claude', 'codex', 'gemini'],
  '2': ['codex', 'claude', 'gemini'],
  '3': ['gemini', 'codex', 'claude'],
};
const CLI_DISCOVERY_TIMEOUT_MS = 2000;
const CLI_VERSION_TIMEOUT_MS = 2500;

function asPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function buildGeminiCommand() {
  const includeDir = resolvePaneCwd('1') || PROJECT_ROOT || path.resolve(path.join(WORKSPACE_PATH, '..'));
  return `gemini --yolo --include-directories "${includeDir}"`;
}

function buildCommandForCli(cli) {
  if (cli === 'codex') return 'codex';
  if (cli === 'gemini') return buildGeminiCommand();
  return 'claude --permission-mode acceptEdits';
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
  devTools: false,
  agentNotify: true,
  watcherEnabled: true,
  allowAllPermissions: false,
  autonomyConsentGiven: false,
  autonomyConsentChoice: 'pending',
  autonomyConsentUpdatedAt: null,
  costAlertEnabled: true,
  costAlertThreshold: 5.00,
  dryRun: false,
  mcpAutoConfig: false,
  recentProjects: [],
  stuckThreshold: 120000,
  autoNudge: true,
  ptyStuckDetection: false,
  ptyStuckThreshold: 15000,
  hiddenPaneHostsEnabled: process.platform === 'win32',
  operatingMode: 'developer',
  firmwareInjectionEnabled: false,
  paneProjects: { '1': null, '2': null, '3': null },
  paneCommands: {
    '1': 'claude',
    '2': 'codex',
    '3': buildGeminiCommand(),
  },
  templates: [],
  voiceInputEnabled: false,
  voiceAutoSend: false,
  voiceLanguage: 'en-US',
  userName: '',
  userExperienceLevel: 'intermediate',
  userPreferredStyle: 'balanced',
};

class SettingsManager {
  constructor(appContext) {
    this.ctx = appContext;
    this.settingsPath = path.join(__dirname, '..', '..', 'settings.json');
    this.appStatusPath = typeof resolveCoordPath === 'function'
      ? resolveCoordPath('app-status.json', { forWrite: true })
      : path.join(PROJECT_ROOT || path.resolve(path.join(WORKSPACE_PATH, '..')), '.squidrun', 'app-status.json');

    // Deep clone defaults to prevent reference sharing
    this.ctx.currentSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  loadSettings() {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const content = fs.readFileSync(this.settingsPath, 'utf-8');
        const loaded = JSON.parse(content);

        // Migration: pre-consent builds had no autonomy consent fields.
        // Preserve prior behavior for existing users by marking consent as resolved.
        if (!Object.prototype.hasOwnProperty.call(loaded, 'autonomyConsentGiven')) {
          loaded.autonomyConsentGiven = true;
          if (typeof loaded.allowAllPermissions !== 'boolean') {
            loaded.allowAllPermissions = false;
          }
          loaded.autonomyConsentChoice = loaded.allowAllPermissions ? 'enabled' : 'declined';
          loaded.autonomyConsentUpdatedAt = null;
        }
        
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

  readAppStatus() {
    try {
      if (!fs.existsSync(this.appStatusPath)) return {};
      const raw = fs.readFileSync(this.appStatusPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  writeAppStatus(options = {}) {
    try {
      const opts = options && typeof options === 'object' ? options : {};
      const nowIso = new Date().toISOString();
      const existing = this.readAppStatus();

      const explicitMode = this.ctx.currentSettings.sdkMode === true
        ? 'sdk'
        : (this.ctx.currentSettings.dryRun ? 'dry-run' : 'pty');

      let existingSession = asPositiveInt(existing.session ?? existing.sessionNumber, null);

      const overrideSession = asPositiveInt(opts.session, null);
      let session = overrideSession !== null ? overrideSession : existingSession;
      if (opts.incrementSession === true) {
        session = (existingSession || 0) + 1;
      }

      const status = {
        ...existing,
        started: opts.incrementSession === true
          ? nowIso
          : (typeof existing.started === 'string' && existing.started.trim() ? existing.started : nowIso),
        mode: explicitMode,
        dryRun: this.ctx.currentSettings.dryRun || false,
        autoSpawn: this.ctx.currentSettings.autoSpawn || false,
        version: require('../../package.json').version || 'unknown',
        platform: process.platform,
        nodeVersion: process.version,
        lastUpdated: nowIso,
      };

      if (session !== null) {
        status.session = session;
      } else {
        delete status.session;
      }

      const statusPatch = (opts.statusPatch && typeof opts.statusPatch === 'object' && !Array.isArray(opts.statusPatch))
        ? opts.statusPatch
        : null;
      if (statusPatch) {
        for (const [key, value] of Object.entries(statusPatch)) {
          const currentValue = status[key];
          if (
            value
            && typeof value === 'object'
            && !Array.isArray(value)
            && currentValue
            && typeof currentValue === 'object'
            && !Array.isArray(currentValue)
          ) {
            status[key] = {
              ...currentValue,
              ...value,
            };
            continue;
          }
          status[key] = value;
        }
      }

      const serialized = JSON.stringify(status, null, 2);

      // Primary write: coordination root (.squidrun)
      fs.mkdirSync(path.dirname(this.appStatusPath), { recursive: true });
      const tempPath = this.appStatusPath + '.tmp';
      fs.writeFileSync(tempPath, serialized, 'utf-8');
      fs.renameSync(tempPath, this.appStatusPath);

      log.info('App Status', `Written${session !== null ? ` (session ${session})` : ''}`);
    } catch (err) {
      log.error('App Status', 'Error writing', err.message);
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

  commandNeedsRewrite(command) {
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
        if (this.commandNeedsRewrite(current[paneId])) {
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
