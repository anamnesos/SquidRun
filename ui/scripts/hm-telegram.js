#!/usr/bin/env node
/**
 * hm-telegram: CLI tool to send a Telegram message or photo via Bot API.
 * Usage: node hm-telegram.js "Hey, build passed!"
 *        node hm-telegram.js --photo path/to/image.png "Optional caption"
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const {
  appendCommsJournalEntry,
  closeCommsJournalStores,
} = require('../modules/main/comms-journal');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asRole(value, fallback = 'system') {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized || fallback;
}

function buildJournalMessageId(prefix = 'tg') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function upsertTelegramJournal(entry = {}) {
  const result = appendCommsJournalEntry({
    channel: 'telegram',
    direction: 'outbound',
    ...entry,
  });
  if (result?.ok !== true) {
    console.warn(`[hm-telegram] journal write unavailable: ${result?.reason || 'unknown'}`);
  }
  return result;
}

function usage() {
  console.log('Usage: node hm-telegram.js <message>');
  console.log('       node hm-telegram.js --photo <image-path> [caption]');
  console.log('Env required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID');
}

function parseMessage(args = []) {
  return args.join(' ').trim();
}

function getTelegramConfig(env = process.env) {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatIdRaw = (env.TELEGRAM_CHAT_ID || '').trim();
  const chatId = Number.parseInt(chatIdRaw, 10);
  return {
    botToken,
    chatId,
  };
}

function getMissingConfigKeys(config) {
  const missing = [];
  if (!config.botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!Number.isFinite(config.chatId)) missing.push('TELEGRAM_CHAT_ID');
  return missing;
}

function requestTelegram(path, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
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
    request.write(body);
    request.end();
  });
}

function requestTelegramMultipart(apiPath, fields, fileField) {
  return new Promise((resolve, reject) => {
    const boundary = '----HivemindBoundary' + Date.now();
    const parts = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      );
    }

    const fileData = fs.readFileSync(fileField.path);
    const fileName = path.basename(fileField.path);
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`
    );
    const epilogue = `\r\n--${boundary}--\r\n`;

    const preFile = Buffer.from(parts.join(''), 'utf8');
    const postFile = Buffer.from(epilogue, 'utf8');
    const bodyLength = preFile.length + fileData.length + postFile.length;

    const request = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: apiPath,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': bodyLength,
        },
      },
      (response) => {
        let responseBody = '';
        response.on('data', (chunk) => { responseBody += chunk; });
        response.on('end', () => {
          resolve({ statusCode: response.statusCode || 0, body: responseBody });
        });
      }
    );

    request.on('error', reject);
    request.write(preFile);
    request.write(fileData);
    request.write(postFile);
    request.end();
  });
}

async function sendTelegramPhoto(photoPath, caption, env = process.env, options = {}) {
  const opts = asObject(options);
  const messageId = typeof opts.messageId === 'string' && opts.messageId.trim()
    ? opts.messageId.trim()
    : buildJournalMessageId('tg-photo');
  const nowMs = Date.now();
  const senderRole = asRole(opts.senderRole || opts.fromRole || 'system', 'system');
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
  const targetRole = 'telegram';

  upsertTelegramJournal({
    messageId,
    sessionId: sessionId || null,
    senderRole,
    targetRole,
    sentAtMs: nowMs,
    rawBody: caption ? `[photo] ${caption}` : '[photo]',
    status: 'recorded',
    attempt: 1,
    metadata: {
      source: 'hm-telegram',
      mode: 'photo',
      photoPath: path.resolve(photoPath),
    },
  });

  const config = getTelegramConfig(env);
  const missing = getMissingConfigKeys(config);
  if (missing.length > 0) {
    upsertTelegramJournal({
      messageId,
      sessionId: sessionId || null,
      senderRole,
      targetRole,
      status: 'failed',
      errorCode: 'missing_config',
      metadata: {
        missing,
      },
    });
    return { ok: false, error: `Missing required env vars: ${missing.join(', ')}` };
  }

  const resolvedPath = path.resolve(photoPath);
  if (!fs.existsSync(resolvedPath)) {
    upsertTelegramJournal({
      messageId,
      sessionId: sessionId || null,
      senderRole,
      targetRole,
      status: 'failed',
      errorCode: 'photo_not_found',
      metadata: {
        photoPath: resolvedPath,
      },
    });
    return { ok: false, error: `Photo not found: ${resolvedPath}` };
  }

  const fields = { chat_id: String(config.chatId) };
  if (caption) fields.caption = caption;

  const apiPath = `/bot${config.botToken}/sendPhoto`;
  const response = await requestTelegramMultipart(apiPath, fields, { name: 'photo', path: resolvedPath });

  let payload = null;
  try { payload = JSON.parse(response.body || '{}'); } catch { payload = null; }

  if (response.statusCode >= 200 && response.statusCode < 300 && payload?.ok !== false) {
    upsertTelegramJournal({
      messageId,
      sessionId: sessionId || null,
      senderRole,
      targetRole,
      status: 'acked',
      ackStatus: 'telegram_delivered',
      metadata: {
        telegramMessageId: payload?.result?.message_id || null,
        chatId: payload?.result?.chat?.id || config.chatId,
      },
    });
    return {
      ok: true,
      statusCode: response.statusCode,
      messageId: payload?.result?.message_id || null,
      chatId: payload?.result?.chat?.id || config.chatId,
    };
  }

  upsertTelegramJournal({
    messageId,
    sessionId: sessionId || null,
    senderRole,
    targetRole,
    status: 'failed',
    errorCode: String(response.statusCode || 'telegram_request_failed'),
    metadata: {
      statusCode: response.statusCode || 0,
      error: payload?.description || null,
    },
  });
  return {
    ok: false,
    statusCode: response.statusCode,
    error: payload?.description || `Telegram photo request failed (${response.statusCode})`,
  };
}

async function sendTelegram(message, env = process.env, options = {}) {
  const opts = asObject(options);
  const messageId = typeof opts.messageId === 'string' && opts.messageId.trim()
    ? opts.messageId.trim()
    : buildJournalMessageId('tg');
  const nowMs = Date.now();
  const senderRole = asRole(opts.senderRole || opts.fromRole || 'system', 'system');
  const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
  const targetRole = 'telegram';

  upsertTelegramJournal({
    messageId,
    sessionId: sessionId || null,
    senderRole,
    targetRole,
    sentAtMs: nowMs,
    rawBody: message,
    status: 'recorded',
    attempt: 1,
    metadata: {
      source: 'hm-telegram',
      mode: 'message',
    },
  });

  const config = getTelegramConfig(env);
  const missing = getMissingConfigKeys(config);
  if (missing.length > 0) {
    upsertTelegramJournal({
      messageId,
      sessionId: sessionId || null,
      senderRole,
      targetRole,
      status: 'failed',
      errorCode: 'missing_config',
      metadata: {
        missing,
      },
    });
    return {
      ok: false,
      error: `Missing required env vars: ${missing.join(', ')}`,
    };
  }

  const body = JSON.stringify({
    chat_id: config.chatId,
    text: message,
  });
  const path = `/bot${config.botToken}/sendMessage`;

  const response = await requestTelegram(path, body);
  let payload = null;
  try {
    payload = JSON.parse(response.body || '{}');
  } catch {
    payload = null;
  }

  if (response.statusCode >= 200 && response.statusCode < 300 && payload?.ok !== false) {
    upsertTelegramJournal({
      messageId,
      sessionId: sessionId || null,
      senderRole,
      targetRole,
      status: 'acked',
      ackStatus: 'telegram_delivered',
      metadata: {
        telegramMessageId: payload?.result?.message_id || null,
        chatId: payload?.result?.chat?.id || config.chatId,
      },
    });
    return {
      ok: true,
      statusCode: response.statusCode,
      messageId: payload?.result?.message_id || null,
      chatId: payload?.result?.chat?.id || config.chatId,
    };
  }

  upsertTelegramJournal({
    messageId,
    sessionId: sessionId || null,
    senderRole,
    targetRole,
    status: 'failed',
    errorCode: String(response.statusCode || 'telegram_request_failed'),
    metadata: {
      statusCode: response.statusCode || 0,
      error: payload?.description || payload?.message || payload?.detail || null,
    },
  });
  return {
    ok: false,
    statusCode: response.statusCode,
    error: payload?.description || payload?.message || payload?.detail || `Telegram request failed (${response.statusCode})`,
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length < 1 || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    process.exit(argv.length < 1 ? 1 : 0);
  }

  // Handle --photo flag
  if (argv[0] === '--photo') {
    if (argv.length < 2) {
      console.error('[hm-telegram] --photo requires an image path');
      process.exit(1);
    }
    const photoPath = argv[1];
    const caption = argv.slice(2).join(' ').trim() || '';
    const result = await sendTelegramPhoto(photoPath, caption, env);
    if (!result.ok) {
      closeCommsJournalStores();
      console.error(`[hm-telegram] Photo failed: ${result.error}`);
      process.exit(1);
    }
    closeCommsJournalStores();
    console.log(
      `[hm-telegram] Sent Telegram photo successfully to ${result.chatId}${result.messageId ? ` (message_id: ${result.messageId})` : ''}`
    );
    process.exit(0);
  }

  const message = parseMessage(argv);
  if (!message) {
    console.error('[hm-telegram] Message cannot be empty');
    process.exit(1);
  }

  const result = await sendTelegram(message, env);
  if (!result.ok) {
    closeCommsJournalStores();
    console.error(`[hm-telegram] Failed: ${result.error}`);
    process.exit(1);
  }

  closeCommsJournalStores();
  console.log(
    `[hm-telegram] Sent Telegram message successfully to ${result.chatId}${result.messageId ? ` (message_id: ${result.messageId})` : ''}`
  );
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    closeCommsJournalStores();
    console.error(`[hm-telegram] Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseMessage,
  getTelegramConfig,
  getMissingConfigKeys,
  requestTelegram,
  requestTelegramMultipart,
  sendTelegram,
  sendTelegramPhoto,
  main,
};
