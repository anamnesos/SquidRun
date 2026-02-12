/**
 * API Keys Tab Module
 * Manages API key configuration for AI services
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');

async function loadApiKeys() {
  try {
    const keys = await ipcRenderer.invoke('get-api-keys');

    const maskAnth = document.getElementById('apiKeyAnthropicMask');
    const maskOai = document.getElementById('apiKeyOpenaiMask');
    const maskGoogle = document.getElementById('apiKeyGoogleMask');
    const maskRecraft = document.getElementById('apiKeyRecraftMask');

    if (maskAnth) maskAnth.textContent = keys.ANTHROPIC_API_KEY || 'Not set';
    if (maskOai) maskOai.textContent = keys.OPENAI_API_KEY || 'Not set';
    if (maskGoogle) maskGoogle.textContent = keys.GOOGLE_API_KEY || 'Not set';
    if (maskRecraft) maskRecraft.textContent = keys.RECRAFT_API_KEY || 'Not set';
  } catch (err) {
    log.error('ApiKeys', 'Error loading API keys', err);
  }
}

async function saveApiKeys() {
  const updates = {};
  const statusEl = document.getElementById('apiKeyStatus');

  const anthInput = document.getElementById('apiKeyAnthropic');
  const oaiInput = document.getElementById('apiKeyOpenai');
  const googleInput = document.getElementById('apiKeyGoogle');
  const recraftInput = document.getElementById('apiKeyRecraft');

  if (anthInput?.value) updates.ANTHROPIC_API_KEY = anthInput.value;
  if (oaiInput?.value) updates.OPENAI_API_KEY = oaiInput.value;
  if (googleInput?.value) updates.GOOGLE_API_KEY = googleInput.value;
  if (recraftInput?.value) updates.RECRAFT_API_KEY = recraftInput.value;

  if (Object.keys(updates).length === 0) {
    if (statusEl) {
      statusEl.textContent = 'Enter at least one key';
      statusEl.className = 'api-keys-status error';
    }
    return;
  }

  try {
    const result = await ipcRenderer.invoke('set-api-keys', updates);

    if (result.success) {
      if (statusEl) {
        statusEl.textContent = 'Saved! Available immediately.';
        statusEl.className = 'api-keys-status success';
      }
      if (anthInput) anthInput.value = '';
      if (oaiInput) oaiInput.value = '';
      if (googleInput) googleInput.value = '';
      if (recraftInput) recraftInput.value = '';
      loadApiKeys();
      log.info('ApiKeys', 'API keys saved to .env');
    } else {
      if (statusEl) {
        statusEl.textContent = result.error || 'Save failed';
        statusEl.className = 'api-keys-status error';
      }
      log.warn('ApiKeys', 'API key save failed:', result.error);
    }
  } catch (err) {
    log.error('ApiKeys', 'Error saving API keys', err);
    if (statusEl) {
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.className = 'api-keys-status error';
    }
  }
}

let domCleanupFns = [];

function setupApiKeysTab() {
  destroyApiKeysTab();

  const saveBtn = document.getElementById('saveApiKeysBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', saveApiKeys);
    domCleanupFns.push(() => saveBtn.removeEventListener('click', saveApiKeys));
  }

  loadApiKeys();
}

function destroyApiKeysTab() {
  for (const fn of domCleanupFns) {
    try { fn(); } catch (_) {}
  }
  domCleanupFns = [];
}

module.exports = {
  setupApiKeysTab,
  destroyApiKeysTab,
  loadApiKeys,
};
