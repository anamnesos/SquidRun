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
      const enabled = value === true;
      toggle.classList.toggle('active', enabled);
      toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
      if (!toggle.hasAttribute('tabindex')) {
        toggle.setAttribute('tabindex', '0');
      }
      if (!toggle.hasAttribute('role')) {
        toggle.setAttribute('role', 'switch');
      }
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

  // Populate select dropdowns bound to settings
  document.querySelectorAll('select[data-setting]').forEach(select => {
    const key = select.dataset.setting;
    if (key && currentSettings[key] !== undefined) {
      select.value = currentSettings[key];
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

function requiresAutonomyConsent() {
  return currentSettings?.autonomyConsentGiven !== true;
}

async function setAutonomyConsentChoice(enabled) {
  try {
    currentSettings = await ipcRenderer.invoke('set-setting', 'allowAllPermissions', Boolean(enabled));
    applySettingsToUI();
    return { success: true, settings: currentSettings };
  } catch (err) {
    log.error('Settings', 'Error saving autonomy consent choice', err);
    return { success: false, error: err.message };
  }
}

async function refreshSettingsFromMain({ applyUi = false } = {}) {
  try {
    currentSettings = await ipcRenderer.invoke('get-settings');
    if (applyUi) {
      applySettingsToUI();
    }
    return currentSettings;
  } catch (err) {
    log.error('Settings', 'Error refreshing settings cache', err);
    return currentSettings;
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
    const setting = toggle.dataset.setting;
    if (!setting) return;

    if (!toggle.hasAttribute('tabindex')) {
      toggle.setAttribute('tabindex', '0');
    }
    if (!toggle.hasAttribute('role')) {
      toggle.setAttribute('role', 'switch');
    }

    const triggerToggle = () => {
      toggleSetting(setting);
    };

    toggle.addEventListener('click', triggerToggle);
    toggle.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        triggerToggle();
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

  // Select dropdowns bound to settings
  document.querySelectorAll('select[data-setting]').forEach(select => {
    select.addEventListener('change', async () => {
      const key = select.dataset.setting;
      if (!key) return;
      try {
        currentSettings = await ipcRenderer.invoke('set-setting', key, select.value);
        log.info('Settings', `${key} updated: ${select.value}`);
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

  // Load settings
  loadSettings();
}

// Check if should auto-spawn agents
async function checkAutoSpawn(spawnAllAgentsFn, reconnectedToExisting) {
  // Skip auto-spawn if reconnecting to existing terminals (they already have agents)
  if (reconnectedToExisting) {
    log.info('AutoSpawn', 'Reconnected to existing terminals, skipping auto-spawn');
    return;
  }

  if (requiresAutonomyConsent()) {
    log.info('AutoSpawn', 'Pending autonomy consent, skipping auto-spawn until user chooses');
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
  requiresAutonomyConsent,
  setAutonomyConsentChoice,
  refreshSettingsFromMain,
  setupSettings,
  checkAutoSpawn,
};
