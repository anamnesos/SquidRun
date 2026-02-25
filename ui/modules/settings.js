/**
 * Settings module
 * Handles application settings panel and configuration
 */

const { invokeBridge, onBridge } = require('./renderer-bridge');
const log = require('./logger');

// Current settings state
let currentSettings = {};

// Callback for connection status
let onConnectionStatusUpdate = null;

// Callback when settings finish loading
let onSettingsLoaded = null;
let pairingStateUnsubscribe = null;
let pairingCountdownTimer = null;
let pairingStateCache = null;

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

function stopPairingCountdownTimer() {
  if (pairingCountdownTimer) {
    clearInterval(pairingCountdownTimer);
    pairingCountdownTimer = null;
  }
}

function formatIsoDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function updatePairingCountdown(expiresAt) {
  const el = document.getElementById('pairingCountdown');
  if (!el) return;
  if (!Number.isFinite(expiresAt)) {
    el.textContent = 'Expires in --s';
    return;
  }
  const remainingMs = Math.max(0, Math.floor(expiresAt - Date.now()));
  const remainingSec = Math.floor(remainingMs / 1000);
  el.textContent = `Expires in ${remainingSec}s`;
}

function renderPairingState(state = {}) {
  const statusEl = document.getElementById('pairingStatus');
  const codeEl = document.getElementById('pairingCodeDisplay');
  const joinInput = document.getElementById('pairingJoinCodeInput');

  pairingStateCache = state && typeof state === 'object' ? state : {};
  const statusText = String(pairingStateCache.status || 'idle');
  const error = pairingStateCache.error || null;
  const code = String(pairingStateCache.code || '').trim();
  const expiresAt = Number.isFinite(pairingStateCache.expiresAt) ? pairingStateCache.expiresAt : null;

  if (statusEl) {
    statusEl.classList.remove('error', 'success');
    if (error) {
      statusEl.classList.add('error');
      statusEl.textContent = `Pairing error: ${error}`;
    } else if (statusText === 'pairing_complete') {
      statusEl.classList.add('success');
      const pairedDevice = pairingStateCache?.paired?.paired_device_id || pairingStateCache?.paired?.device_id || 'device';
      statusEl.textContent = `Pairing complete with ${pairedDevice}.`;
    } else if (statusText === 'pairing_init_ok') {
      statusEl.textContent = 'Code generated. Share it with the other device.';
    } else if (statusText === 'pairing_join_pending' || statusText === 'pairing_init_pending') {
      statusEl.textContent = 'Pairing in progress...';
    } else {
      statusEl.textContent = 'Pairing idle.';
    }
  }

  if (codeEl) {
    codeEl.textContent = code || '------';
  }

  if (joinInput && statusText === 'pairing_complete') {
    joinInput.value = '';
  }

  stopPairingCountdownTimer();
  updatePairingCountdown(expiresAt);
  if (expiresAt && expiresAt > Date.now()) {
    pairingCountdownTimer = setInterval(() => {
      updatePairingCountdown(expiresAt);
      if (Date.now() >= expiresAt) {
        stopPairingCountdownTimer();
      }
    }, 250);
  }
}

function renderConnectedDevices(devices = []) {
  const tbody = document.getElementById('pairedDevicesTableBody');
  if (!tbody) return;
  const rows = Array.isArray(devices) ? devices : [];
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="device-list-empty">No devices yet.</td></tr>';
    return;
  }
  const html = rows.map((device) => {
    const id = String(device?.device_id || device?.name || 'UNKNOWN');
    const online = device?.online === true;
    const pairedAt = formatIsoDate(device?.paired_at);
    return `
      <tr>
        <td>${id}</td>
        <td><span class="device-status ${online ? 'online' : 'offline'}">${online ? 'Online' : 'Offline'}</span></td>
        <td>${pairedAt}</td>
      </tr>
    `;
  }).join('');
  tbody.innerHTML = html;
}

async function refreshBridgeDevices({ refresh = true } = {}) {
  try {
    const result = await invokeBridge('bridge:get-devices', { refresh });
    renderConnectedDevices(Array.isArray(result?.devices) ? result.devices : []);
  } catch (err) {
    log.warn('Settings', 'Failed to load bridge devices', err?.message || err);
    renderConnectedDevices([]);
  }
}

async function refreshPairingState() {
  try {
    const result = await invokeBridge('bridge:get-pairing-state');
    if (result?.ok && result?.state) {
      renderPairingState(result.state);
      return;
    }
  } catch (err) {
    log.warn('Settings', 'Failed to load pairing state', err?.message || err);
  }
  renderPairingState({});
}

// Load and apply settings
async function loadSettings() {
  try {
    currentSettings = await invokeBridge('get-settings');
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

  window.dispatchEvent(new CustomEvent('squidrun-settings-updated', {
    detail: { ...currentSettings }
  }));
}

// Handle setting toggle
async function toggleSetting(key) {
  try {
    const newValue = !currentSettings[key];
    currentSettings = await invokeBridge('set-setting', key, newValue);
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
    currentSettings = await invokeBridge('set-setting', 'allowAllPermissions', Boolean(enabled));
    applySettingsToUI();
    return { success: true, settings: currentSettings };
  } catch (err) {
    log.error('Settings', 'Error saving autonomy consent choice', err);
    return { success: false, error: err.message };
  }
}

async function refreshSettingsFromMain({ applyUi = false } = {}) {
  try {
    currentSettings = await invokeBridge('get-settings');
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
      if (settingsPanel.classList.contains('open')) {
        refreshPairingState();
        refreshBridgeDevices({ refresh: true });
      }
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
        await invokeBridge('set-setting', 'costAlertThreshold', value);
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
        currentSettings = await invokeBridge('set-setting', key, value);
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
        currentSettings = await invokeBridge('set-setting', key, select.value);
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
        const result = await invokeBridge('notify-external-test', {});
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

  const pairingInitBtn = document.getElementById('pairingInitBtn');
  if (pairingInitBtn) {
    pairingInitBtn.addEventListener('click', async () => {
      pairingInitBtn.disabled = true;
      try {
        const result = await invokeBridge('bridge:pairing-init', { timeoutMs: 12000 });
        if (result?.ok) {
          renderPairingState({
            status: result.status,
            code: result.code,
            expiresAt: result.expiresAt,
            error: null,
          });
        } else {
          renderPairingState({
            status: result?.status || 'pairing_init_failed',
            error: result?.error || 'Failed to generate pairing code',
            reason: result?.reason || null,
          });
        }
      } catch (err) {
        renderPairingState({
          status: 'pairing_init_failed',
          error: err?.message || 'Failed to generate pairing code',
        });
      } finally {
        pairingInitBtn.disabled = false;
      }
    });
  }

  const pairingJoinBtn = document.getElementById('pairingJoinBtn');
  const pairingJoinCodeInput = document.getElementById('pairingJoinCodeInput');
  if (pairingJoinBtn && pairingJoinCodeInput) {
    const runJoin = async () => {
      const code = String(pairingJoinCodeInput.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      pairingJoinCodeInput.value = code;
      pairingJoinBtn.disabled = true;
      try {
        const result = await invokeBridge('bridge:pairing-join', { code, timeoutMs: 12000 });
        if (result?.ok) {
          renderPairingState({
            status: result.status || 'pairing_complete',
            error: null,
            paired: result.paired || null,
          });
          refreshBridgeDevices({ refresh: true });
        } else {
          renderPairingState({
            status: result?.status || 'pairing_join_failed',
            error: result?.error || 'Pairing join failed',
            reason: result?.reason || null,
          });
        }
      } catch (err) {
        renderPairingState({
          status: 'pairing_join_failed',
          error: err?.message || 'Pairing join failed',
        });
      } finally {
        pairingJoinBtn.disabled = false;
      }
    };

    pairingJoinBtn.addEventListener('click', runJoin);
    pairingJoinCodeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runJoin();
      }
    });
    pairingJoinCodeInput.addEventListener('input', () => {
      pairingJoinCodeInput.value = String(pairingJoinCodeInput.value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 6);
    });
  }

  const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
  if (refreshDevicesBtn) {
    refreshDevicesBtn.addEventListener('click', async () => {
      refreshDevicesBtn.disabled = true;
      try {
        await refreshBridgeDevices({ refresh: true });
      } finally {
        refreshDevicesBtn.disabled = false;
      }
    });
  }

  if (!pairingStateUnsubscribe) {
    pairingStateUnsubscribe = onBridge('bridge:pairing-state', (_event, state) => {
      renderPairingState(state || {});
      if (state?.status === 'pairing_complete') {
        refreshBridgeDevices({ refresh: true });
      }
    });
  }

  // Load settings
  loadSettings();
  refreshPairingState();
  refreshBridgeDevices({ refresh: false });
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
