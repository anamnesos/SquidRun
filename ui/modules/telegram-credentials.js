'use strict';

const fs = require('fs');
const path = require('path');

// Install-owner Telegram credentials live in a settings file INSIDE the data
// root — never in the exe-adjacent install manifest, which is pointer-only and
// may sit on a read-only path. The overlay only fills env keys that process
// env / .env loads left unset, so explicit env always wins and dev trees are
// unaffected.
const TELEGRAM_SETTINGS_RELATIVE_PATH = path.join('.squidrun', 'settings', 'telegram.json');
const BRIDGE_RELAY_MODE_ENV_KEY = 'SQUIDRUN_BRIDGE_RELAY_MODE';

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeChatId(value) {
  const text = typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : toNonEmptyString(typeof value === 'string' ? value : null);
  if (!text || !/^-?\d+$/.test(text)) return null;
  return text;
}

function resolveTelegramSettingsPath(dataRoot) {
  const root = toNonEmptyString(dataRoot);
  if (!root) return null;
  return path.join(path.resolve(root), TELEGRAM_SETTINGS_RELATIVE_PATH);
}

function readTelegramSettings(settingsPath) {
  const resolved = toNonEmptyString(settingsPath);
  if (!resolved) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (_) {
    // Missing or malformed settings must never block boot.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const botToken = toNonEmptyString(parsed.botToken);
  const ownerChatId = normalizeChatId(parsed.ownerChatId ?? parsed.chatId);
  const chatAllowlist = Array.isArray(parsed.chatAllowlist)
    ? Array.from(new Set(parsed.chatAllowlist.map(normalizeChatId).filter(Boolean)))
    : [];
  const relayMode = toNonEmptyString(parsed.relayMode)?.toLowerCase() || null;

  if (!botToken && !ownerChatId && chatAllowlist.length < 1) return null;
  return { botToken, ownerChatId, chatAllowlist, relayMode };
}

function buildTelegramEnvOverlay(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
  const overlay = {};
  if (toNonEmptyString(settings.botToken)) {
    overlay.TELEGRAM_BOT_TOKEN = settings.botToken;
  }
  if (normalizeChatId(settings.ownerChatId)) {
    overlay.TELEGRAM_CHAT_ID = normalizeChatId(settings.ownerChatId);
  }
  if (Array.isArray(settings.chatAllowlist) && settings.chatAllowlist.length > 0) {
    const allowlist = Array.from(new Set(settings.chatAllowlist.map(normalizeChatId).filter(Boolean)));
    if (allowlist.length > 0) {
      overlay.TELEGRAM_CHAT_ALLOWLIST = allowlist.join(',');
      // A data-root allowlist means this install is sandboxed to those chats;
      // outbound enforcement must fail closed if the allowlist env is lost.
      overlay.TELEGRAM_CHAT_ALLOWLIST_STRICT = '1';
    }
  }
  if (toNonEmptyString(settings.relayMode)?.toLowerCase() === 'off') {
    overlay[BRIDGE_RELAY_MODE_ENV_KEY] = 'off';
  }
  return overlay;
}

function applyTelegramEnvOverlay(options = {}) {
  const env = options.env || process.env;
  const settingsPath = toNonEmptyString(options.settingsPath)
    || resolveTelegramSettingsPath(options.dataRoot);
  const settings = readTelegramSettings(settingsPath);
  if (!settings) {
    return { ok: true, applied: [], skipped: [], source: null };
  }

  const overlay = buildTelegramEnvOverlay(settings);
  const applied = [];
  const skipped = [];
  for (const [key, value] of Object.entries(overlay)) {
    if (toNonEmptyString(env[key])) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }
  return { ok: true, applied, skipped, source: settingsPath, relayMode: settings.relayMode };
}

module.exports = {
  BRIDGE_RELAY_MODE_ENV_KEY,
  TELEGRAM_SETTINGS_RELATIVE_PATH,
  applyTelegramEnvOverlay,
  buildTelegramEnvOverlay,
  readTelegramSettings,
  resolveTelegramSettingsPath,
};
