/**
 * Settings Manager
 * Handles configuration and settings persistence for the main process
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
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
const SMTP_PASS_OBFUSCATION_PREFIX = 'obf:v1:';
const SETTINGS_FILE_NAME = 'settings.json';

function asPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function getSmtpObfuscationKey() {
  let username = '';
  try {
    username = os.userInfo().username || '';
  } catch {
    username = process.env.USERNAME || process.env.USER || '';
  }
  const seed = `${os.hostname()}|${username}|${process.platform}|${process.arch}`;
  return crypto.createHash('sha256').update(`squidrun.smtp-password|${seed}`).digest();
}

function xorWithKey(buffer, key) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return Buffer.alloc(0);
  const output = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) {
    output[i] = buffer[i] ^ key[i % key.length];
  }
  return output;
}

function obfuscateSmtpPassword(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.startsWith(SMTP_PASS_OBFUSCATION_PREFIX)) return value;
  const raw = Buffer.from(value, 'utf-8');
  const obfuscated = xorWithKey(raw, getSmtpObfuscationKey());
  return `${SMTP_PASS_OBFUSCATION_PREFIX}${obfuscated.toString('base64')}`;
}

function deobfuscateSmtpPassword(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (!value.startsWith(SMTP_PASS_OBFUSCATION_PREFIX)) return value;
  const payload = value.slice(SMTP_PASS_OBFUSCATION_PREFIX.length);
  if (!payload) return '';
  try {
    const encoded = Buffer.from(payload, 'base64');
    return xorWithKey(encoded, getSmtpObfuscationKey()).toString('utf-8');
  } catch {
    return '';
  }
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

function createDefaultSettings({ isPackaged = false } = {}) {
  return {
    autoSpawn: true,
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
    smtpRejectUnauthorized: true,
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
    operatingMode: isPackaged ? 'project' : 'developer',
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
}

class SettingsManager {
  constructor(appContext) {
    this.ctx = appContext;
    this.electronApp = null;
    this.isPackaged = false;
    this.defaultSettings = createDefaultSettings();
    this.settingsPath = null;
    this.appStatusPath = null;
    this.settingsContextLogged = false;
    this.refreshRuntimeSettingsContext('constructor');

    // Deep clone defaults to prevent reference sharing
    this.ctx.currentSettings = JSON.parse(JSON.stringify(this.defaultSettings));
  }

  resolveElectronApp() {
    if (this.ctx && this.ctx.electronApp && typeof this.ctx.electronApp === 'object') {
      return this.ctx.electronApp;
    }
    try {
      // Keep constructor usable in non-Electron contexts (tests/scripts).
      const { app } = require('electron');
      return app;
    } catch {
      return null;
    }
  }

  resolveSettingsPath() {
    if (this.isPackaged) {
      const { value: userDataPath } = this.tryGetElectronPath('userData');
      if (typeof userDataPath === 'string' && userDataPath.trim()) {
        return path.join(userDataPath, SETTINGS_FILE_NAME);
      }
    }
    return path.join(__dirname, '..', '..', SETTINGS_FILE_NAME);
  }

  tryGetElectronPath(pathName) {
    if (!this.electronApp || typeof this.electronApp.getPath !== 'function') {
      return { value: null, error: 'electron_app_getPath_unavailable' };
    }
    try {
      return { value: this.electronApp.getPath(pathName), error: null };
    } catch (err) {
      return { value: null, error: err?.message || String(err) };
    }
  }

  buildSettingsPersistenceDiagnostics() {
    const userDataPathResult = this.tryGetElectronPath('userData');
    const appDataPathResult = this.tryGetElectronPath('appData');
    const homePathResult = this.tryGetElectronPath('home');
    let appName = null;
    try {
      if (this.electronApp && typeof this.electronApp.getName === 'function') {
        appName = this.electronApp.getName();
      } else if (this.electronApp && typeof this.electronApp.name === 'string') {
        appName = this.electronApp.name;
      }
    } catch {
      appName = null;
    }
    return {
      appName,
      isPackaged: this.isPackaged,
      settingsPath: this.settingsPath || null,
      userDataPath: userDataPathResult.value || null,
      userDataPathError: userDataPathResult.error || null,
      appDataPath: appDataPathResult.value || null,
      appDataPathError: appDataPathResult.error || null,
      homePath: homePathResult.value || null,
      homePathError: homePathResult.error || null,
      cwd: process.cwd(),
      resourcesPath: process.resourcesPath || null,
      appStatusPath: this.appStatusPath || null,
      platform: process.platform,
      nodeVersion: process.version,
    };
  }

  resolveAppStatusPath() {
    if (typeof resolveCoordPath === 'function') {
      return resolveCoordPath('app-status.json', { forWrite: true });
    }
    return path.join(PROJECT_ROOT || path.resolve(path.join(WORKSPACE_PATH, '..')), '.squidrun', 'app-status.json');
  }

  refreshAppStatusPath() {
    this.appStatusPath = this.resolveAppStatusPath();
  }

  refreshRuntimeSettingsContext(reason = 'runtime-refresh') {
    this.electronApp = this.resolveElectronApp();
    this.isPackaged = Boolean(this.electronApp && this.electronApp.isPackaged);
    this.defaultSettings = createDefaultSettings({ isPackaged: this.isPackaged });
    this.refreshAppStatusPath();

    const nextSettingsPath = this.resolveSettingsPath();
    const hadPath = typeof this.settingsPath === 'string' && this.settingsPath.trim().length > 0;
    const pathChanged = !hadPath || path.resolve(this.settingsPath) !== path.resolve(nextSettingsPath);
    this.settingsPath = nextSettingsPath;

    if (!this.settingsContextLogged || pathChanged) {
      this.settingsContextLogged = true;
      log.info('Settings', `Persistence context resolved (${reason})`, this.buildSettingsPersistenceDiagnostics());
    }
  }

  writeSettingsFile(payload) {
    const serialized = JSON.stringify(payload, null, 2);
    const tempPath = this.settingsPath + '.tmp';
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    fs.writeFileSync(tempPath, serialized, 'utf-8');
    fs.renameSync(tempPath, this.settingsPath);
  }

  createDefaultSettingsFileIfMissing() {
    if (!this.isPackaged) return;
    if (fs.existsSync(this.settingsPath)) return;
    const persistedDefaults = JSON.parse(JSON.stringify(this.defaultSettings));
    persistedDefaults.smtpPass = obfuscateSmtpPassword(persistedDefaults.smtpPass);
    this.writeSettingsFile(persistedDefaults);
  }

  loadSettings() {
    try {
      this.refreshRuntimeSettingsContext('load-settings');
      this.createDefaultSettingsFileIfMissing();
      if (fs.existsSync(this.settingsPath)) {
        const content = fs.readFileSync(this.settingsPath, 'utf-8');
        const loaded = JSON.parse(content);
        loaded.smtpPass = deobfuscateSmtpPassword(loaded.smtpPass);

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
        const paneCommands = { ...this.defaultSettings.paneCommands, ...(loaded.paneCommands || {}) };
        const paneProjects = { ...this.defaultSettings.paneProjects, ...(loaded.paneProjects || {}) };
        
        Object.assign(this.ctx.currentSettings, this.defaultSettings, loaded, { paneCommands, paneProjects });
      }
    } catch (err) {
      log.error('Settings', 'Error loading settings', err);
      Object.assign(this.ctx.currentSettings, this.defaultSettings);
    }
    return this.ctx.currentSettings;
  }

  saveSettings(settings) {
    try {
      this.refreshRuntimeSettingsContext('save-settings');
      Object.assign(this.ctx.currentSettings, settings);

      const persistedSettings = JSON.parse(JSON.stringify(this.ctx.currentSettings));
      persistedSettings.smtpPass = obfuscateSmtpPassword(persistedSettings.smtpPass);
      this.writeSettingsFile(persistedSettings);

      const diagnostics = this.buildSettingsPersistenceDiagnostics();
      this.writeAppStatus({
        statusPatch: {
          settingsPersistence: {
            ...diagnostics,
            saveOk: true,
            lastSavedAt: new Date().toISOString(),
            lastError: null,
            lastErrorCode: null,
            lastErrorAt: null,
          },
        },
      });
    } catch (err) {
      const diagnostics = this.buildSettingsPersistenceDiagnostics();
      log.error('Settings', 'Error saving settings', {
        error: err?.message || String(err),
        code: err?.code || null,
        ...diagnostics,
      });
      this.writeAppStatus({
        statusPatch: {
          settingsPersistence: {
            ...diagnostics,
            saveOk: false,
            lastError: err?.message || String(err),
            lastErrorCode: err?.code || null,
            lastErrorAt: new Date().toISOString(),
          },
        },
      });
    }
    return this.ctx.currentSettings;
  }

  readAppStatus() {
    try {
      this.refreshAppStatusPath();
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
      this.refreshAppStatusPath();
      const opts = options && typeof options === 'object' ? options : {};
      const nowIso = new Date().toISOString();
      const existing = this.readAppStatus();

      const explicitMode = this.ctx.currentSettings.sdkMode === true
        ? 'sdk'
        : (this.ctx.currentSettings.dryRun ? 'dry-run' : 'pty');

      let existingSession = asPositiveInt(existing.session ?? existing.session_number ?? existing.sessionNumber, null);
      const sessionFloor = asPositiveInt(opts.sessionFloor ?? opts.sessionSeed, null);

      const overrideSession = asPositiveInt(opts.session, null);
      let session = overrideSession !== null ? overrideSession : existingSession;
      if (opts.incrementSession === true) {
        const baseline = Math.max(existingSession || 0, sessionFloor || 0);
        session = baseline + 1;
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
      delete status.session_number;
      delete status.sessionNumber;
      delete status.currentSession;

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

    // macOS apps launched from Finder get a minimal PATH that excludes
    // Homebrew and user-local bin dirs. Ensure common paths are included.
    const extraPaths = process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.nvm', 'versions', 'node', 'current', 'bin')]
      : [];
    const spawnEnv = { ...process.env };
    if (extraPaths.length) {
      spawnEnv.PATH = [...extraPaths, spawnEnv.PATH || ''].join(':');
    }

    for (const cli of CLI_NAMES) {
      let found = false;
      try {
        const locate = spawnSync(locator, [cli], {
          windowsHide: true,
          timeout: CLI_DISCOVERY_TIMEOUT_MS,
          encoding: 'utf-8',
          stdio: 'pipe',
          env: spawnEnv,
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
          env: spawnEnv,
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
