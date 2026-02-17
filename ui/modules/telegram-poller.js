/**
 * Telegram inbound poller.
 * Uses raw HTTPS polling and relays inbound messages to a callback.
 */

const https = require('https');
const log = require('./logger');

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;

let running = false;
let pollTimer = null;
let pollInFlight = false;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let onMessage = null;
let config = null;
let nextOffset = 0;

function getTelegramConfig(env = process.env) {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatIdRaw = (env.TELEGRAM_CHAT_ID || '').trim();
  const chatId = Number.parseInt(chatIdRaw, 10);

  if (!botToken || !chatIdRaw || !Number.isFinite(chatId)) {
    return null;
  }

  return {
    botToken,
    chatId,
  };
}

function buildUpdatesPath(currentConfig, offset) {
  const query = new URLSearchParams();
  query.append('offset', String(offset));
  query.append('timeout', '0');
  return `/bot${currentConfig.botToken}/getUpdates?${query.toString()}`;
}

function requestTelegram(method, path) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path,
        method,
      },
      (response) => {
        let responseBody = '';
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: responseBody,
          });
        });
      }
    );

    request.on('error', reject);
    request.end();
  });
}

function parseUpdateId(update) {
  const value = Number.parseInt(String(update?.update_id ?? ''), 10);
  return Number.isFinite(value) ? value : null;
}

function getAuthorizedChatId(message) {
  const value = Number.parseInt(String(message?.chat?.id ?? ''), 10);
  return Number.isFinite(value) ? value : null;
}

function isAuthorizedChat(message, currentConfig) {
  const chatId = getAuthorizedChatId(message);
  if (chatId === null) return false;
  return chatId === currentConfig.chatId;
}

function normalizeFrom(rawFrom) {
  if (!rawFrom || typeof rawFrom !== 'object') return 'unknown';

  const username = typeof rawFrom.username === 'string' ? rawFrom.username.trim() : '';
  if (username) return `@${username}`;

  const firstName = typeof rawFrom.first_name === 'string' ? rawFrom.first_name.trim() : '';
  const lastName = typeof rawFrom.last_name === 'string' ? rawFrom.last_name.trim() : '';
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) return fullName;

  const id = Number.parseInt(String(rawFrom.id ?? ''), 10);
  if (Number.isFinite(id)) return String(id);

  return 'unknown';
}

function normalizeBody(rawBody) {
  if (typeof rawBody !== 'string') return '';
  return rawBody.trim();
}

function parseMessageTimestampMs(message) {
  const dateSeconds = Number(message?.date);
  if (!Number.isFinite(dateSeconds) || dateSeconds <= 0) return null;
  return Math.floor(dateSeconds * 1000);
}

async function pollNow() {
  if (!running || !config || pollInFlight) return;
  pollInFlight = true;

  try {
    const path = buildUpdatesPath(config, nextOffset);
    const response = await requestTelegram('GET', path);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      log.warn('Telegram', `Telegram polling failed (${response.statusCode})`);
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(response.body || '{}');
    } catch (err) {
      log.warn('Telegram', `Telegram polling returned invalid JSON: ${err.message}`);
      return;
    }

    const updates = Array.isArray(payload.result) ? payload.result : [];
    updates
      .slice()
      .sort((left, right) => {
        const leftId = parseUpdateId(left) ?? 0;
        const rightId = parseUpdateId(right) ?? 0;
        return leftId - rightId;
      })
      .forEach((update) => {
        const updateId = parseUpdateId(update);
        if (updateId === null || updateId < nextOffset) return;
        nextOffset = Math.max(nextOffset, updateId + 1);

        const message = update?.message && typeof update.message === 'object' ? update.message : null;
        if (!message) return;
        if (!isAuthorizedChat(message, config)) {
          log.warn(
            'Telegram',
            `Rejected inbound Telegram message from unauthorized chat (${message?.chat?.id ?? 'unknown'})`
          );
          return;
        }

        const text = normalizeBody(message.text);
        if (!text) return;

        if (typeof onMessage === 'function') {
          try {
            onMessage(text, normalizeFrom(message.from), {
              updateId,
              messageId: Number.isFinite(Number(message?.message_id))
                ? Number(message.message_id)
                : null,
              chatId: getAuthorizedChatId(message),
              timestampMs: parseMessageTimestampMs(message),
            });
          } catch (err) {
            log.warn('Telegram', `Telegram callback failed: ${err.message}`);
          }
        }
      });
  } catch (err) {
    log.warn('Telegram', `Telegram polling error: ${err.message}`);
  } finally {
    pollInFlight = false;
  }
}

function start(options = {}) {
  if (running) return true;

  config = getTelegramConfig(options.env || process.env);
  if (!config) {
    return false;
  }

  pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs >= MIN_POLL_INTERVAL_MS
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;

  onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
  nextOffset = 0;
  pollInFlight = false;
  running = true;

  pollTimer = setInterval(() => {
    pollNow().catch((err) => {
      log.warn('Telegram', `Telegram polling tick failed: ${err.message}`);
    });
  }, pollIntervalMs);
  if (typeof pollTimer.unref === 'function') {
    pollTimer.unref();
  }

  log.info('Telegram', `Telegram inbound poller started (interval=${pollIntervalMs}ms)`);
  return true;
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  running = false;
  pollInFlight = false;
  onMessage = null;
  config = null;
  nextOffset = 0;
}

function isRunning() {
  return running;
}

const _internals = {
  getTelegramConfig,
  buildUpdatesPath,
  requestTelegram,
  pollNow,
  parseUpdateId,
  isAuthorizedChat,
};

module.exports = {
  start,
  stop,
  isRunning,
  _internals,
};
