/**
 * Settings module
 * Handles application settings panel and configuration
 */

const { ipcRenderer } = require('electron');
const log = require('./logger');

// Current settings state
let currentSettings = {};

// Callback for connection status
let onConnectionStatusUpdate = null;

// Callback when settings finish loading
let onSettingsLoaded = null;

function setConnectionStatusCallback(cb) {
  onConnectionStatusUpdate = cb;
}

function setSettingsLoadedCallback(cb) {
  onSettingsLoaded = cb;
}

function updateConnectionStatus(status) {
  if (onConnectionStatusUpdate) {
    onConnectionStatusUpdate(status);
  }
}

// Load and apply settings
async function loadSettings() {
  try {
    currentSettings = await ipcRenderer.invoke('get-settings');
    applySettingsToUI();
    // Notify that settings are loaded (for init sequencing)
    if (onSettingsLoaded) {
      onSettingsLoaded();
    }
  } catch (err) {
    log.error('Settings', 'Error loading settings', err);
    // Still call callback so init doesn't hang
    if (onSettingsLoaded) {
      onSettingsLoaded();
    }
  }
}

// Apply settings to toggle UI
function applySettingsToUI() {
  for (const [key, value] of Object.entries(currentSettings)) {
    const toggle = document.getElementById(`toggle${key.charAt(0).toUpperCase() + key.slice(1)}`);
    if (toggle) {
      toggle.classList.toggle('active', value);
    }
  }

  // Show/hide permissions warning
  const warning = document.getElementById('permissionsWarning');
  if (warning) {
    warning.style.display = currentSettings.allowAllPermissions ? 'block' : 'none';
  }

  // Show/hide dry-run indicator
  const dryRunIndicator = document.getElementById('dryRunIndicator');
  if (dryRunIndicator) {
    dryRunIndicator.style.display = currentSettings.dryRun ? 'inline-block' : 'none';
  }

  // Show/hide SDK mode notice
  const sdkModeNotice = document.getElementById('sdkModeNotice');
  if (sdkModeNotice) {
    sdkModeNotice.style.display = currentSettings.sdkMode ? 'block' : 'none';
  }

  // Hide Spawn All button in SDK mode (SDK manages agents, not CLIs)
  const spawnAllBtn = document.getElementById('spawnAllBtn');
  if (spawnAllBtn) {
    spawnAllBtn.style.display = currentSettings.sdkMode ? 'none' : 'inline-block';
  }

  // Populate cost alert threshold
  const thresholdInput = document.getElementById('costAlertThreshold');
  if (thresholdInput && currentSettings.costAlertThreshold !== undefined) {
    thresholdInput.value = currentSettings.costAlertThreshold.toFixed(2);
  }

  // Populate text/number inputs bound to settings
  document.querySelectorAll('input[data-setting]').forEach(input => {
    const key = input.dataset.setting;
    if (key && currentSettings[key] !== undefined) {
      if (input.type === 'number') {
        input.value = currentSettings[key];
      } else {
        input.value = currentSettings[key] || '';
      }
    }
  });

  window.dispatchEvent(new CustomEvent('hivemind-settings-updated', {
    detail: { ...currentSettings }
  }));
}

// Handle setting toggle
async function toggleSetting(key) {
  try {
    const newValue = !currentSettings[key];
    currentSettings = await ipcRenderer.invoke('set-setting', key, newValue);
    applySettingsToUI();
    log.info('Settings', `${key} = ${newValue}`);
  } catch (err) {
    log.error('Settings', 'Error toggling setting', err);
  }
}

// Get current settings
function getSettings() {
  return currentSettings;
}

// Load and display masked API keys
async function loadApiKeys() {
  try {
    const keys = await ipcRenderer.invoke('get-api-keys');

    const maskAnth = document.getElementById('apiKeyAnthropicMask');
    const maskOai = document.getElementById('apiKeyOpenaiMask');
    const maskGoogle = document.getElementById('apiKeyGoogleMask');

    if (maskAnth) maskAnth.textContent = keys.ANTHROPIC_API_KEY || 'Not set';
    if (maskOai) maskOai.textContent = keys.OPENAI_API_KEY || 'Not set';
    if (maskGoogle) maskGoogle.textContent = keys.GOOGLE_API_KEY || 'Not set';
  } catch (err) {
    log.error('Settings', 'Error loading API keys', err);
  }
}

// Save API keys to .env
async function saveApiKeys() {
  const updates = {};
  const statusEl = document.getElementById('apiKeyStatus');

  const anthInput = document.getElementById('apiKeyAnthropic');
  const oaiInput = document.getElementById('apiKeyOpenai');
  const googleInput = document.getElementById('apiKeyGoogle');

  if (anthInput?.value) updates.ANTHROPIC_API_KEY = anthInput.value;
  if (oaiInput?.value) updates.OPENAI_API_KEY = oaiInput.value;
  if (googleInput?.value) updates.GOOGLE_API_KEY = googleInput.value;

  if (Object.keys(updates).length === 0) {
    if (statusEl) {
      statusEl.textContent = 'Enter at least one key';
      statusEl.classList.add('error');
    }
    return;
  }

  try {
    const result = await ipcRenderer.invoke('set-api-keys', updates);

    if (result.success) {
      if (statusEl) {
        statusEl.textContent = 'Saved! Restart to apply.';
        statusEl.classList.remove('error');
      }
      // Clear inputs after save (security)
      if (anthInput) anthInput.value = '';
      if (oaiInput) oaiInput.value = '';
      if (googleInput) googleInput.value = '';
      // Reload masked display
      loadApiKeys();
      log.info('Settings', 'API keys saved to .env');
    } else {
      if (statusEl) {
        statusEl.textContent = result.error || 'Save failed';
        statusEl.classList.add('error');
      }
      log.warn('Settings', 'API key save failed:', result.error);
    }
  } catch (err) {
    log.error('Settings', 'Error saving API keys', err);
    if (statusEl) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.classList.add('error');
    }
  }
}

// Setup settings panel
function setupSettings() {
  // Settings button toggle
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');

  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('click', () => {
      settingsPanel.classList.toggle('open');
      settingsBtn.classList.toggle('active');
    });
  }

  // Toggle switches
  document.querySelectorAll('.toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const setting = toggle.dataset.setting;
      if (setting) {
        toggleSetting(setting);
      }
    });
  });

  // Cost alert threshold input
  const thresholdInput = document.getElementById('costAlertThreshold');
  if (thresholdInput) {
    thresholdInput.addEventListener('change', async () => {
      const value = parseFloat(thresholdInput.value);
      if (!isNaN(value) && value > 0) {
        await ipcRenderer.invoke('set-setting', 'costAlertThreshold', value);
        log.info('Settings', 'Cost alert threshold set to $' + value.toFixed(2));
      }
    });
  }

  // Generic settings inputs (text/number)
  document.querySelectorAll('input[data-setting]').forEach(input => {
    input.addEventListener('change', async () => {
      const key = input.dataset.setting;
      if (!key) return;
      let value = input.value;
      if (input.type === 'number') {
        const parsed = parseFloat(input.value);
        if (!isNaN(parsed)) {
          value = parsed;
        } else {
          return;
        }
      }

      try {
        currentSettings = await ipcRenderer.invoke('set-setting', key, value);
        const safeValue = key.toLowerCase().includes('pass') ? '[hidden]' : value;
        log.info('Settings', `${key} updated: ${safeValue}`);
      } catch (err) {
        log.error('Settings', `Error updating ${key}`, err);
      }
    });
  });

  const testExternalBtn = document.getElementById('sendExternalTestBtn');
  if (testExternalBtn) {
    testExternalBtn.addEventListener('click', async () => {
      try {
        const result = await ipcRenderer.invoke('notify-external-test', {});
        if (result && result.success) {
          log.info('Settings', 'External notification test sent');
        } else {
          log.warn('Settings', 'External notification test failed', result?.error || 'unknown');
        }
      } catch (err) {
        log.error('Settings', 'External notification test error', err);
      }
    });
  }

  // API Keys save button
  const saveApiKeysBtn = document.getElementById('saveApiKeysBtn');
  if (saveApiKeysBtn) {
    saveApiKeysBtn.addEventListener('click', saveApiKeys);
  }

  // Load settings and API keys
  loadSettings();
  loadApiKeys();
}

// Check if should auto-spawn agents
async function checkAutoSpawn(spawnAllAgentsFn, reconnectedToExisting) {
  // Skip auto-spawn if reconnecting to existing terminals (they already have agents)
  if (reconnectedToExisting) {
    log.info('AutoSpawn', 'Reconnected to existing terminals, skipping auto-spawn');
    return;
  }

  // SDK Mode: Don't auto-spawn CLI agents when SDK mode is enabled
  // SDK manages its own Claude instances via the Python SDK
  if (currentSettings.sdkMode) {
    log.info('AutoSpawn', 'SDK mode enabled, skipping CLI auto-spawn');
    return;
  }

  if (currentSettings.autoSpawn) {
    updateConnectionStatus('Auto-spawning agents in all panes...');
    await spawnAllAgentsFn();
  }
}

module.exports = {
  setConnectionStatusCallback,
  setSettingsLoadedCallback,
  loadSettings,
  applySettingsToUI,
  toggleSetting,
  getSettings,
  setupSettings,
  checkAutoSpawn,
};
