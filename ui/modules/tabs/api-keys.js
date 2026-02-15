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

  const anthInput = document.getElementById('apiKeyAnthropic');
  const oaiInput = document.getElementById('apiKeyOpenai');
  const googleInput = document.getElementById('apiKeyGoogle');
  const recraftInput = document.getElementById('apiKeyRecraft');
  const twilioSidInput = document.getElementById('apiKeyTwilioSid');
  const twilioAuthInput = document.getElementById('apiKeyTwilioAuth');
  const twilioPhoneInput = document.getElementById('apiKeyTwilioPhone');
  const smsRecipientInput = document.getElementById('apiKeySmsRecipient');
  const telegramTokenInput = document.getElementById('apiKeyTelegramToken');
  const telegramChatIdInput = document.getElementById('apiKeyTelegramChatId');

  if (anthInput?.value) updates.ANTHROPIC_API_KEY = anthInput.value;
  if (oaiInput?.value) updates.OPENAI_API_KEY = oaiInput.value;
  if (googleInput?.value) updates.GOOGLE_API_KEY = googleInput.value;
  if (recraftInput?.value) updates.RECRAFT_API_KEY = recraftInput.value;
  if (twilioSidInput?.value) updates.TWILIO_ACCOUNT_SID = twilioSidInput.value;
  if (twilioAuthInput?.value) updates.TWILIO_AUTH_TOKEN = twilioAuthInput.value;
  if (twilioPhoneInput?.value) updates.TWILIO_PHONE_NUMBER = twilioPhoneInput.value;
  if (smsRecipientInput?.value) updates.SMS_RECIPIENT = smsRecipientInput.value;
  if (telegramTokenInput?.value) updates.TELEGRAM_BOT_TOKEN = telegramTokenInput.value;
  if (telegramChatIdInput?.value) updates.TELEGRAM_CHAT_ID = telegramChatIdInput.value;

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
      if (twilioSidInput) twilioSidInput.value = '';
      if (twilioAuthInput) twilioAuthInput.value = '';
      if (twilioPhoneInput) twilioPhoneInput.value = '';
      if (smsRecipientInput) smsRecipientInput.value = '';
      if (telegramTokenInput) telegramTokenInput.value = '';
      if (telegramChatIdInput) telegramChatIdInput.value = '';
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
