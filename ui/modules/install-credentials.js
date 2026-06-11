'use strict';

const fs = require('fs');
const path = require('path');

const {
  applyTelegramEnvOverlay,
} = require('./telegram-credentials');

// Per-install credential overlay for packaged SquidRun instances.
//
// COMPOSITION WITH THE SCRUB-LAUNCH WRAPPER (they are NOT redundant):
//   1. The scrub wrapper guarantees a CLEAN environment at boot — deny-by-default
//      removal of every inherited variable so no main-instance secret can ride in.
//   2. This overlay then supplies the install's OWN values from files inside its
//      data root. Wrapper removes foreign secrets; overlay injects owned ones.
//
// One precedence rule for every overlay class, identical to telegram-credentials:
//   explicit env wins → data-root settings file fills the gaps → dev .env loads
//   (which run before this) are simply "env" by the time we get here.
//
// CREDENTIAL TAXONOMY — every class is enumerated with an explicit policy so a
// future config slot cannot be added quietly:
//   telegram → overlay  (settings/telegram.json, handled by telegram-credentials)
//   relay    → overlay  (settings/relay.json — ALL-OR-NOTHING: an install either
//              has a complete relay identity of its own or none; partial identity
//              must never produce a connection under an inherited/implicit device)
//   twilio   → overlay  (settings/twilio.json — sid+token are pair-or-nothing;
//              phoneNumber/smsRecipient apply independently)
//   smtp     → settings-redaction (the app consumes SMTP from the settings store,
//              not env, so the per-install treatment is redacting staged
//              settings.json — see SMTP_SENSITIVE_SETTINGS_KEYS / redactSensitiveSettings)
//   wallet   → DENY (an install NEVER carries wallet credentials. The wrapper
//              strips them at boot; this module is the second wall: wallet env
//              keys are actively removed, and a wallet settings file is never
//              read — its presence is only reported)
const CREDENTIAL_CLASS_POLICIES = Object.freeze({
  telegram: 'overlay',
  relay: 'overlay',
  twilio: 'overlay',
  smtp: 'settings-redaction',
  wallet: 'deny',
});

const RELAY_SETTINGS_RELATIVE_PATH = path.join('.squidrun', 'settings', 'relay.json');
const TWILIO_SETTINGS_RELATIVE_PATH = path.join('.squidrun', 'settings', 'twilio.json');
const WALLET_SETTINGS_RELATIVE_PATH = path.join('.squidrun', 'settings', 'wallet.json');

const WALLET_DENY_ENV_KEYS = Object.freeze([
  'HYPERLIQUID_PRIVATE_KEY',
  'HYPERLIQUID_WALLET_ADDRESS',
]);

const RELAY_ENV_KEYS = Object.freeze([
  'SQUIDRUN_RELAY_URL',
  'SQUIDRUN_RELAY_SECRET',
  'SQUIDRUN_DEVICE_ID',
]);

const SMTP_SENSITIVE_SETTINGS_KEYS = Object.freeze([
  'smtpHost',
  'smtpPort',
  'smtpSecure',
  'smtpRejectUnauthorized',
  'smtpUser',
  'smtpPass',
  'smtpFrom',
  'smtpTo',
  'slackWebhookUrl',
  'discordWebhookUrl',
]);

function toNonEmptyString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readSettingsJson(dataRoot, relativePath) {
  const root = toNonEmptyString(dataRoot);
  if (!root) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(path.resolve(root), relativePath), 'utf8'));
  } catch (_) {
    // Missing or malformed settings must never block boot.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

function applyOverlayEntries(env, entries) {
  const applied = [];
  const skipped = [];
  for (const [key, value] of Object.entries(entries)) {
    if (toNonEmptyString(env[key])) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { applied, skipped };
}

function applyRelayEnvOverlay(env, dataRoot) {
  const settings = readSettingsJson(dataRoot, RELAY_SETTINGS_RELATIVE_PATH);
  if (!settings) return { applied: [], skipped: [], reason: null };

  // Fail closed on BOTH sides of the all-or-nothing rule: if ANY relay identity
  // key is already present in env, never splice a file-supplied value onto an
  // inherited one — that would forge a mixed device identity. Apply nothing.
  const presentEnvKeys = RELAY_ENV_KEYS.filter((key) => toNonEmptyString(env[key]));
  if (presentEnvKeys.length > 0) {
    return { applied: [], skipped: presentEnvKeys, reason: 'partial_env_relay_identity' };
  }

  const relayUrl = toNonEmptyString(settings.relayUrl);
  const relaySecret = toNonEmptyString(settings.relaySecret);
  const deviceId = toNonEmptyString(settings.deviceId);
  if (!relayUrl || !relaySecret || !deviceId) {
    return { applied: [], skipped: [], reason: 'incomplete_relay_identity' };
  }

  const { applied, skipped } = applyOverlayEntries(env, {
    SQUIDRUN_RELAY_URL: relayUrl,
    SQUIDRUN_RELAY_SECRET: relaySecret,
    SQUIDRUN_DEVICE_ID: deviceId,
  });
  return { applied, skipped, reason: null };
}

function applyTwilioEnvOverlay(env, dataRoot) {
  const settings = readSettingsJson(dataRoot, TWILIO_SETTINGS_RELATIVE_PATH);
  if (!settings) return { applied: [], skipped: [], reason: null };

  const accountSid = toNonEmptyString(settings.accountSid);
  const authToken = toNonEmptyString(settings.authToken);
  const entries = {};
  let reason = null;
  if (accountSid && authToken) {
    entries.TWILIO_ACCOUNT_SID = accountSid;
    entries.TWILIO_AUTH_TOKEN = authToken;
  } else if (accountSid || authToken) {
    reason = 'incomplete_twilio_credential_pair';
  }
  const phoneNumber = toNonEmptyString(settings.phoneNumber);
  if (phoneNumber) entries.TWILIO_PHONE_NUMBER = phoneNumber;
  const smsRecipient = toNonEmptyString(settings.smsRecipient);
  if (smsRecipient) entries.SMS_RECIPIENT = smsRecipient;

  const { applied, skipped } = applyOverlayEntries(env, entries);
  return { applied, skipped, reason };
}

function applyWalletDeny(env, dataRoot) {
  const denied = [];
  for (const key of WALLET_DENY_ENV_KEYS) {
    if (env[key] !== undefined) {
      delete env[key];
      denied.push(key);
    }
  }

  let settingsFilePresent = false;
  const root = toNonEmptyString(dataRoot);
  if (root) {
    try {
      settingsFilePresent = fs.existsSync(path.join(path.resolve(root), WALLET_SETTINGS_RELATIVE_PATH));
    } catch (_) {
      settingsFilePresent = false;
    }
  }

  return {
    applied: [],
    skipped: [],
    denied,
    settingsFilePresent,
    reason: settingsFilePresent ? 'wallet_class_denied' : (denied.length > 0 ? 'wallet_class_denied' : null),
  };
}

function redactSensitiveSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { settings: {}, removed: [] };
  }
  const clean = { ...settings };
  const removed = [];
  for (const key of SMTP_SENSITIVE_SETTINGS_KEYS) {
    if (key in clean) {
      delete clean[key];
      removed.push(key);
    }
  }
  return { settings: clean, removed };
}

function applyInstallCredentialEnvOverlay(options = {}) {
  const env = options.env || process.env;
  const dataRoot = options.dataRoot;

  const telegram = applyTelegramEnvOverlay({ env, dataRoot });
  const relay = applyRelayEnvOverlay(env, dataRoot);
  const twilio = applyTwilioEnvOverlay(env, dataRoot);
  const wallet = applyWalletDeny(env, dataRoot);

  return {
    ok: true,
    classes: { telegram, relay, twilio, wallet },
    applied: [...telegram.applied, ...relay.applied, ...twilio.applied],
    skipped: [...telegram.skipped, ...relay.skipped, ...twilio.skipped],
    denied: wallet.denied,
  };
}

module.exports = {
  CREDENTIAL_CLASS_POLICIES,
  RELAY_SETTINGS_RELATIVE_PATH,
  RELAY_ENV_KEYS,
  TWILIO_SETTINGS_RELATIVE_PATH,
  WALLET_SETTINGS_RELATIVE_PATH,
  WALLET_DENY_ENV_KEYS,
  SMTP_SENSITIVE_SETTINGS_KEYS,
  applyInstallCredentialEnvOverlay,
  redactSensitiveSettings,
};
