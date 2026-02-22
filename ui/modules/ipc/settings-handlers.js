/**
 * Settings IPC Handlers
 * Channels: get-settings, set-setting, get-all-settings, get-api-keys,
 *           set-api-keys, get-feature-capabilities, get-app-status
 */

const fs = require('fs');
const path = require('path');
const { getFeatureCapabilities } = require('../feature-capabilities');

// Path to .env file (project root)
const ENV_PATH = path.join(__dirname, '..', '..', '..', '.env');

function normalizeDirectoryPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function asPaneProjects(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function getChangedPaneProjectTargets(previousPaneProjects, nextPaneProjects) {
  const previous = asPaneProjects(previousPaneProjects);
  const next = asPaneProjects(nextPaneProjects);
  const paneIds = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const changedTargets = [];

  paneIds.forEach((paneId) => {
    const before = normalizeDirectoryPath(previous[paneId]);
    const after = normalizeDirectoryPath(next[paneId]);
    if (before === after) return;
    if (after) changedTargets.push(after);
  });

  return [...new Set(changedTargets)];
}

function flattenScanResults(resultsByTarget) {
  return Object.values(resultsByTarget || {}).reduce((acc, value) => {
    if (Array.isArray(value)) {
      acc.push(...value);
    }
    return acc;
  }, []);
}

function hasPreflightConflicts(preflightResults) {
  if (!Array.isArray(preflightResults)) return false;
  return preflightResults.some((entry) => (
    entry
    && entry.hasAgentProtocols === true
    && Array.isArray(entry.conflicts)
    && entry.conflicts.length > 0
  ));
}

function isProjectMode(settings) {
  return settings?.operatingMode === 'project' || settings?.firmwareInjectionEnabled === true;
}

function getFirmwareManager(ctx, deps) {
  return deps?.firmwareManager || ctx?.firmwareManager || null;
}

function getCachedResultsFromManager(firmwareManager) {
  if (!firmwareManager || typeof firmwareManager.getAllCachedPreflightResults !== 'function') {
    return [];
  }
  return firmwareManager.getAllCachedPreflightResults();
}

function maybeRegenerateFirmwareFromConflicts(firmwareManager, settings, scannedResultsByTarget) {
  if (!firmwareManager || typeof firmwareManager.ensureFirmwareFiles !== 'function') return;
  if (!isProjectMode(settings)) return;

  const hasConflict = Object.values(scannedResultsByTarget || {}).some((results) => hasPreflightConflicts(results));
  if (!hasConflict) return;

  const cached = getCachedResultsFromManager(firmwareManager);
  const mergedResults = cached.length > 0 ? cached : flattenScanResults(scannedResultsByTarget);
  firmwareManager.ensureFirmwareFiles(mergedResults);
}

function runPreflightForPaneProjectChanges(ctx, deps, settings, previousPaneProjects, nextPaneProjects) {
  const firmwareManager = getFirmwareManager(ctx, deps);
  if (!firmwareManager || typeof firmwareManager.runPreflight !== 'function') {
    return { scanned: false, targets: [], resultsByTarget: {}, combinedResults: [] };
  }

  const changedTargets = getChangedPaneProjectTargets(previousPaneProjects, nextPaneProjects);
  if (changedTargets.length === 0) {
    return { scanned: false, targets: [], resultsByTarget: {}, combinedResults: [] };
  }

  const resultsByTarget = {};
  changedTargets.forEach((targetDir) => {
    resultsByTarget[targetDir] = firmwareManager.runPreflight(targetDir, { cache: true });
  });

  const combinedResults = (() => {
    const cached = getCachedResultsFromManager(firmwareManager);
    return cached.length > 0 ? cached : flattenScanResults(resultsByTarget);
  })();

  ctx.preflightScanResults = combinedResults;
  ctx.lastPreflightScan = {
    source: 'set-setting:paneProjects',
    scannedAt: new Date().toISOString(),
    targets: changedTargets,
    resultsByTarget,
  };

  maybeRegenerateFirmwareFromConflicts(firmwareManager, settings, resultsByTarget);

  return {
    scanned: true,
    targets: changedTargets,
    resultsByTarget,
    combinedResults,
  };
}

function runManualPreflightScan(ctx, deps, settings, targetDir) {
  const firmwareManager = getFirmwareManager(ctx, deps);
  if (!firmwareManager || typeof firmwareManager.runPreflight !== 'function') {
    return {
      success: false,
      error: 'Firmware manager unavailable',
      targetDir: null,
      results: [],
      hasConflicts: false,
    };
  }

  const normalizedTarget = normalizeDirectoryPath(targetDir);
  if (!normalizedTarget) {
    return {
      success: false,
      error: 'Directory path is required',
      targetDir: null,
      results: [],
      hasConflicts: false,
    };
  }

  if (!fs.existsSync(normalizedTarget)) {
    return {
      success: false,
      error: 'Directory does not exist',
      targetDir: normalizedTarget,
      results: [],
      hasConflicts: false,
    };
  }

  let stat = null;
  try {
    stat = fs.statSync(normalizedTarget);
  } catch {
    stat = null;
  }

  if (!stat || !stat.isDirectory()) {
    return {
      success: false,
      error: 'Path is not a directory',
      targetDir: normalizedTarget,
      results: [],
      hasConflicts: false,
    };
  }

  const results = firmwareManager.runPreflight(normalizedTarget, { cache: true });
  const hasConflicts = hasPreflightConflicts(results);
  const combinedResults = (() => {
    const cached = getCachedResultsFromManager(firmwareManager);
    return cached.length > 0 ? cached : (Array.isArray(results) ? results : []);
  })();

  ctx.preflightScanResults = combinedResults;
  ctx.lastPreflightScan = {
    source: 'manual:preflight-scan',
    scannedAt: new Date().toISOString(),
    targets: [normalizedTarget],
    resultsByTarget: {
      [normalizedTarget]: results,
    },
  };

  if (isProjectMode(settings) && hasConflicts && typeof firmwareManager.ensureFirmwareFiles === 'function') {
    firmwareManager.ensureFirmwareFiles(combinedResults);
  }

  return {
    success: true,
    targetDir: normalizedTarget,
    results,
    hasConflicts,
  };
}

function registerSettingsHandlers(ctx, deps) {
  const { ipcMain } = ctx;
  const { loadSettings, saveSettings } = deps;

  ipcMain.handle('get-settings', () => {
    return loadSettings();
  });

  ipcMain.handle('get-app-status', () => {
    if (!ctx?.settings || typeof ctx.settings.readAppStatus !== 'function') {
      return null;
    }
    return ctx.settings.readAppStatus() || null;
  });

  ipcMain.handle('set-setting', (event, key, value) => {
    const settings = loadSettings();
    const previousPaneProjects = key === 'paneProjects'
      ? { ...asPaneProjects(settings.paneProjects) }
      : null;

    settings[key] = value;

    if (key === 'allowAllPermissions') {
      settings.autonomyConsentGiven = true;
      settings.autonomyConsentChoice = value ? 'enabled' : 'declined';
      settings.autonomyConsentUpdatedAt = new Date().toISOString();
    }
    if (key === 'autonomyConsentGiven' && value !== true) {
      settings.autonomyConsentChoice = 'pending';
      settings.autonomyConsentUpdatedAt = null;
    }

    // Operating mode drives firmware injection
    if (key === 'operatingMode') {
      settings.firmwareInjectionEnabled = value === 'project';
    }

    saveSettings(settings);

    if (key === 'paneProjects') {
      runPreflightForPaneProjectChanges(
        ctx,
        deps,
        settings,
        previousPaneProjects,
        settings.paneProjects
      );
    }

    if (key === 'watcherEnabled') {
      if (value) {
        ctx.watcher.startWatcher();
      } else {
        ctx.watcher.stopWatcher();
      }
    }

    return settings;
  });

  ipcMain.handle('get-all-settings', () => {
    return loadSettings();
  });

  ipcMain.handle('get-feature-capabilities', () => {
    return getFeatureCapabilities(process.env);
  });

  ipcMain.handle('preflight-scan', (event, targetDir) => {
    const settings = loadSettings();
    return runManualPreflightScan(ctx, deps, settings, targetDir);
  });

  // Get masked API keys for display (never returns full keys)
  ipcMain.handle('get-api-keys', () => {
    const keys = {
      ANTHROPIC_API_KEY: null,
      OPENAI_API_KEY: null,
      GOOGLE_API_KEY: null,
      RECRAFT_API_KEY: null,
      GODADDY_API_KEY: null,
      GODADDY_API_SECRET: null,
      GITHUB_TOKEN: null,
      VERCEL_TOKEN: null,
      TWILIO_ACCOUNT_SID: null,
      TWILIO_AUTH_TOKEN: null,
      TWILIO_PHONE_NUMBER: null,
      SMS_RECIPIENT: null,
      TELEGRAM_BOT_TOKEN: null,
      TELEGRAM_CHAT_ID: null
    };

    if (fs.existsSync(ENV_PATH)) {
      try {
        const content = fs.readFileSync(ENV_PATH, 'utf-8').replace(/\r/g, '');
        const lines = content.split('\n');

        for (const line of lines) {
          const match = line.match(/^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|RECRAFT_API_KEY|GODADDY_API_KEY|GODADDY_API_SECRET|GITHUB_TOKEN|VERCEL_TOKEN|TWILIO_ACCOUNT_SID|TWILIO_AUTH_TOKEN|TWILIO_PHONE_NUMBER|SMS_RECIPIENT|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)=(.+)$/);
          if (match) {
            const [, keyName, value] = match;
            // Return masked version: show only last 4 chars
            keys[keyName] = value.length > 4
              ? `***${value.slice(-4)}`
              : '****';
          }
        }
      } catch (err) {
        console.error('[Settings] Error reading .env for API keys:', err.message);
      }
    }

    return keys;
  });

  // Save API keys to .env file
  ipcMain.handle('set-api-keys', (event, updates) => {
    // Validate key formats
    const validators = {
      ANTHROPIC_API_KEY: v => !v || v.startsWith('sk-ant-'),
      OPENAI_API_KEY: v => !v || v.startsWith('sk-'),
      GOOGLE_API_KEY: v => !v || v.startsWith('AIza'),
      RECRAFT_API_KEY: v => !v || v.length > 0,
      GODADDY_API_KEY: v => !v || v.length > 0,
      GODADDY_API_SECRET: v => !v || v.length > 0,
      GITHUB_TOKEN: v => !v || v.length > 0,
      VERCEL_TOKEN: v => !v || v.length > 0,
      TWILIO_ACCOUNT_SID: v => !v || v.startsWith('AC'),
      TWILIO_AUTH_TOKEN: v => !v || v.length > 0,
      TWILIO_PHONE_NUMBER: v => !v || v.startsWith('+'),
      SMS_RECIPIENT: v => !v || v.startsWith('+'),
      TELEGRAM_BOT_TOKEN: v => !v || v.length > 0,
      TELEGRAM_CHAT_ID: v => !v || /^-?\d+$/.test(v)
    };

    for (const [key, value] of Object.entries(updates)) {
      if (!validators[key]) {
        return { success: false, error: `Unknown key: ${key}` };
      }
      if (value && !validators[key](value)) {
        return { success: false, error: `Invalid format for ${key.replace('_API_KEY', '')}` };
      }
    }

    try {
      // Read existing .env or start fresh
      let content = '';
      if (fs.existsSync(ENV_PATH)) {
        content = fs.readFileSync(ENV_PATH, 'utf-8');
      }

      // Update or add each key
      for (const [key, value] of Object.entries(updates)) {
        if (!value) continue; // Skip empty values

        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `${key}=${value}`);
        } else {
          content = content.trim() + `\n${key}=${value}`;
        }

        // Update process.env for immediate use
        process.env[key] = value;
      }

      // Write .env
      fs.writeFileSync(ENV_PATH, content.trim() + '\n', 'utf-8');

      const capabilities = getFeatureCapabilities(process.env);
      const mainWindow = ctx.mainWindow;
      if (mainWindow && !mainWindow.isDestroyed?.() && mainWindow.webContents?.send) {
        mainWindow.webContents.send('feature-capabilities-updated', capabilities);
      }

      return { success: true, capabilities };
    } catch (err) {
      console.error('[Settings] Error saving API keys:', err.message);
      return { success: false, error: err.message };
    }
  });
}

function unregisterSettingsHandlers(ctx) {
  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('get-settings');
    ipcMain.removeHandler('get-app-status');
    ipcMain.removeHandler('set-setting');
    ipcMain.removeHandler('get-all-settings');
    ipcMain.removeHandler('get-api-keys');
    ipcMain.removeHandler('set-api-keys');
    ipcMain.removeHandler('get-feature-capabilities');
    ipcMain.removeHandler('preflight-scan');
  }
}

registerSettingsHandlers.unregister = unregisterSettingsHandlers;

module.exports = { registerSettingsHandlers };
