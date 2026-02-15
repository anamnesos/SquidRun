/**
 * Settings IPC Handlers
 * Channels: get-settings, set-setting, get-all-settings, get-api-keys,
 *           set-api-keys, get-feature-capabilities
 */

const fs = require('fs');
const path = require('path');
const { getFeatureCapabilities } = require('../feature-capabilities');

// Path to .env file (project root)
const ENV_PATH = path.join(__dirname, '..', '..', '..', '.env');

function registerSettingsHandlers(ctx, deps) {
  const { ipcMain } = ctx;
  const { loadSettings, saveSettings } = deps;

  ipcMain.handle('get-settings', () => {
    return loadSettings();
  });

  ipcMain.handle('set-setting', (event, key, value) => {
    const settings = loadSettings();
    settings[key] = value;
    saveSettings(settings);

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

  // Get masked API keys for display (never returns full keys)
  ipcMain.handle('get-api-keys', () => {
    const keys = {
      ANTHROPIC_API_KEY: null,
      OPENAI_API_KEY: null,
      GOOGLE_API_KEY: null,
      RECRAFT_API_KEY: null,
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
          const match = line.match(/^(ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY|RECRAFT_API_KEY|TWILIO_ACCOUNT_SID|TWILIO_AUTH_TOKEN|TWILIO_PHONE_NUMBER|SMS_RECIPIENT|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)=(.+)$/);
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
      TWILIO_ACCOUNT_SID: v => !v || v.startsWith('AC'),
      TWILIO_AUTH_TOKEN: v => !v || v.length > 0,
      TWILIO_PHONE_NUMBER: v => !v || v.startsWith('+'),
      SMS_RECIPIENT: v => !v || v.startsWith('+'),
      TELEGRAM_BOT_TOKEN: v => !v || v.length > 0,
      TELEGRAM_CHAT_ID: v => !v || /^-?\d+$/.test(v)
    };

    for (const [key, value] of Object.entries(updates)) {
      if (value && validators[key] && !validators[key](value)) {
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
      console.log('[Settings] API keys updated in .env');

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
    ipcMain.removeHandler('set-setting');
    ipcMain.removeHandler('get-all-settings');
    ipcMain.removeHandler('get-api-keys');
    ipcMain.removeHandler('set-api-keys');
    ipcMain.removeHandler('get-feature-capabilities');
  }
}

registerSettingsHandlers.unregister = unregisterSettingsHandlers;

module.exports = { registerSettingsHandlers };
