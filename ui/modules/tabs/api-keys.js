/**
 * API Keys Tab Module
 * Manages API key configuration for AI services
 */

const { invokeBridge } = require('../renderer-bridge');
const log = require('../logger');
const API_KEY_FIELDS = Object.freeze([
  { inputId: 'apiKeyAnthropic', settingKey: 'ANTHROPIC_API_KEY' },
  { inputId: 'apiKeyOpenai', settingKey: 'OPENAI_API_KEY' },
  { inputId: 'apiKeyGoogle', settingKey: 'GOOGLE_API_KEY' },
  { inputId: 'apiKeyRecraft', settingKey: 'RECRAFT_API_KEY' },
  { inputId: 'apiKeyGodaddyApiKey', settingKey: 'GODADDY_API_KEY' },
  { inputId: 'apiKeyGodaddyApiSecret', settingKey: 'GODADDY_API_SECRET' },
  { inputId: 'apiKeyGithubToken', settingKey: 'GITHUB_TOKEN' },
  { inputId: 'apiKeyVercelToken', settingKey: 'VERCEL_TOKEN' },
  { inputId: 'apiKeyTwilioSid', settingKey: 'TWILIO_ACCOUNT_SID' },
  { inputId: 'apiKeyTwilioAuth', settingKey: 'TWILIO_AUTH_TOKEN' },
  { inputId: 'apiKeyTwilioPhone', settingKey: 'TWILIO_PHONE_NUMBER' },
  { inputId: 'apiKeySmsRecipient', settingKey: 'SMS_RECIPIENT' },
  { inputId: 'apiKeyTelegramToken', settingKey: 'TELEGRAM_BOT_TOKEN' },
  { inputId: 'apiKeyTelegramChatId', settingKey: 'TELEGRAM_CHAT_ID' },
]);

function resetApiKeyFieldDirtyState() {
  API_KEY_FIELDS.forEach(({ inputId }) => {
    const input = document.getElementById(inputId);
    if (input) {
      input.dataset.dirty = 'false';
    }
  });
}

async function loadApiKeys() {
  try {
    const keys = await invokeBridge('get-api-keys');

    const maskAnth = document.getElementById('apiKeyAnthropicMask');
    const maskOai = document.getElementById('apiKeyOpenaiMask');
    const maskGoogle = document.getElementById('apiKeyGoogleMask');
    const maskRecraft = document.getElementById('apiKeyRecraftMask');
    const maskGodaddyApiKey = document.getElementById('apiKeyGodaddyApiKeyMask');
    const maskGodaddyApiSecret = document.getElementById('apiKeyGodaddyApiSecretMask');
    const maskGithubToken = document.getElementById('apiKeyGithubTokenMask');
    const maskVercelToken = document.getElementById('apiKeyVercelTokenMask');
    const maskTwilioSid = document.getElementById('apiKeyTwilioSidMask');
    const maskTwilioAuth = document.getElementById('apiKeyTwilioAuthMask');
    const maskTwilioPhone = document.getElementById('apiKeyTwilioPhoneMask');
    const maskSmsRecipient = document.getElementById('apiKeySmsRecipientMask');
    const maskTelegramToken = document.getElementById('apiKeyTelegramTokenMask');
    const maskTelegramChatId = document.getElementById('apiKeyTelegramChatIdMask');

    if (maskAnth) maskAnth.textContent = keys.ANTHROPIC_API_KEY || 'Not set';
    if (maskOai) maskOai.textContent = keys.OPENAI_API_KEY || 'Not set';
    if (maskGoogle) maskGoogle.textContent = keys.GOOGLE_API_KEY || 'Not set';
    if (maskRecraft) maskRecraft.textContent = keys.RECRAFT_API_KEY || 'Not set';
    if (maskGodaddyApiKey) maskGodaddyApiKey.textContent = keys.GODADDY_API_KEY || 'Not set';
    if (maskGodaddyApiSecret) maskGodaddyApiSecret.textContent = keys.GODADDY_API_SECRET || 'Not set';
    if (maskGithubToken) maskGithubToken.textContent = keys.GITHUB_TOKEN || 'Not set';
    if (maskVercelToken) maskVercelToken.textContent = keys.VERCEL_TOKEN || 'Not set';
    if (maskTwilioSid) maskTwilioSid.textContent = keys.TWILIO_ACCOUNT_SID || 'Not set';
    if (maskTwilioAuth) maskTwilioAuth.textContent = keys.TWILIO_AUTH_TOKEN || 'Not set';
    if (maskTwilioPhone) maskTwilioPhone.textContent = keys.TWILIO_PHONE_NUMBER || 'Not set';
    if (maskSmsRecipient) maskSmsRecipient.textContent = keys.SMS_RECIPIENT || 'Not set';
    if (maskTelegramToken) maskTelegramToken.textContent = keys.TELEGRAM_BOT_TOKEN || 'Not set';
    if (maskTelegramChatId) maskTelegramChatId.textContent = keys.TELEGRAM_CHAT_ID || 'Not set';
  } catch (err) {
    log.error('ApiKeys', 'Error loading API keys', err);
  }
}

async function saveApiKeys() {
  const updates = {};
  const statusEl = document.getElementById('apiKeyStatus');

  API_KEY_FIELDS.forEach(({ inputId, settingKey }) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    const value = String(input.value || '');
    const dirty = input.dataset.dirty === 'true';
    if (!dirty && !value) return;
    updates[settingKey] = value;
  });

  if (Object.keys(updates).length === 0) {
    if (statusEl) {
      statusEl.textContent = 'Enter a key or clear a field you edited';
      statusEl.className = 'api-keys-status error';
    }
    return;
  }

  try {
    const result = await invokeBridge('set-api-keys', updates);

    if (result.success) {
      if (statusEl) {
        statusEl.textContent = 'Saved! Available immediately.';
        statusEl.className = 'api-keys-status success';
      }
      API_KEY_FIELDS.forEach(({ inputId }) => {
        const input = document.getElementById(inputId);
        if (input) input.value = '';
      });
      resetApiKeyFieldDirtyState();
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

  const twilioToggle = document.getElementById('twilioSectionToggle');
  if (twilioToggle) {
    const toggleHandler = () => {
      const content = document.getElementById('twilioSectionContent');
      const arrow = twilioToggle.querySelector('.api-keys-section-arrow');
      if (content) {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        if (arrow) arrow.innerHTML = isHidden ? '&#9660;' : '&#9654;';
      }
    };
    twilioToggle.addEventListener('click', toggleHandler);
    domCleanupFns.push(() => twilioToggle.removeEventListener('click', toggleHandler));
  }

  const telegramToggle = document.getElementById('telegramSectionToggle');
  if (telegramToggle) {
    const toggleHandler = () => {
      const content = document.getElementById('telegramSectionContent');
      const arrow = telegramToggle.querySelector('.api-keys-section-arrow');
      if (content) {
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        if (arrow) arrow.innerHTML = isHidden ? '&#9660;' : '&#9654;';
      }
    };
    telegramToggle.addEventListener('click', toggleHandler);
    domCleanupFns.push(() => telegramToggle.removeEventListener('click', toggleHandler));
  }

  API_KEY_FIELDS.forEach(({ inputId }) => {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.dataset.dirty = 'false';
    const onInput = () => {
      input.dataset.dirty = 'true';
    };
    input.addEventListener('input', onInput);
    domCleanupFns.push(() => input.removeEventListener('input', onInput));
  });

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
