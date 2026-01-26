/**
 * Settings module
 * Handles application settings panel and configuration
 */

const { ipcRenderer } = require('electron');

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
    console.error('Error loading settings:', err);
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

  // Hide Spawn All button in SDK mode (SDK manages Claude, not CLI)
  const spawnAllBtn = document.getElementById('spawnAllBtn');
  if (spawnAllBtn) {
    spawnAllBtn.style.display = currentSettings.sdkMode ? 'none' : 'inline-block';
  }

  // Populate cost alert threshold
  const thresholdInput = document.getElementById('costAlertThreshold');
  if (thresholdInput && currentSettings.costAlertThreshold !== undefined) {
    thresholdInput.value = currentSettings.costAlertThreshold.toFixed(2);
  }
}

// Handle setting toggle
async function toggleSetting(key) {
  try {
    const newValue = !currentSettings[key];
    currentSettings = await ipcRenderer.invoke('set-setting', key, newValue);
    applySettingsToUI();
    console.log(`[Settings] ${key} = ${newValue}`);
  } catch (err) {
    console.error('Error setting:', err);
  }
}

// Get current settings
function getSettings() {
  return currentSettings;
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
        console.log('[Settings] Cost alert threshold set to $' + value.toFixed(2));
      }
    });
  }

  // Load settings
  loadSettings();
}

// Check if should auto-spawn Claude
async function checkAutoSpawn(spawnAllClaudeFn, reconnectedToExisting) {
  // V16: Skip auto-spawn if reconnecting to existing terminals (they already have Claude)
  if (reconnectedToExisting) {
    console.log('[AutoSpawn] Reconnected to existing terminals, skipping auto-spawn');
    return;
  }

  // SDK Mode: Don't auto-spawn CLI Claude when SDK mode is enabled
  // SDK manages its own Claude instances via the Python SDK
  if (currentSettings.sdkMode) {
    console.log('[AutoSpawn] SDK mode enabled, skipping CLI auto-spawn');
    return;
  }

  if (currentSettings.autoSpawn) {
    updateConnectionStatus('Auto-spawning Claude in all panes...');
    await spawnAllClaudeFn();
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
