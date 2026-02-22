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
  setProjectRoot,
  resolveCoordPath,
} = require('../config');
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

function parseJsonFileSafe(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function findNearestProjectLinkFile(startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(currentDir, '.squidrun', 'link.json');
    if (fs.existsSync(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function resolveProjectContextFromLink(startDir = process.cwd()) {
  const linkPath = findNearestProjectLinkFile(startDir);
  if (!linkPath) return null;
  const payload = parseJsonFileSafe(linkPath);
  if (!payload || typeof payload !== 'object') return null;

  const fallbackProjectPath = path.resolve(path.join(path.dirname(linkPath), '..'));
  const workspaceValue = typeof payload.workspace === 'string'
    ? payload.workspace.trim()
    : '';
  const declaredProjectPath = workspaceValue
    ? path.resolve(workspaceValue)
    : fallbackProjectPath;
  const projectPath = (workspaceValue && !fs.existsSync(declaredProjectPath))
    ? fallbackProjectPath
    : declaredProjectPath;
  const sessionId = typeof payload.session_id === 'string'
    ? payload.session_id.trim()
    : (typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '');

  return {
    source: 'link.json',
    projectPath,
    sessionId: sessionId || null,
  };
}

function resolveProjectContextFromState() {
  if (typeof resolveCoordPath !== 'function') return null;
  const state = parseJsonFileSafe(resolveCoordPath('state.json'));
  const projectValue = typeof state?.project === 'string'
    ? state.project.trim()
    : '';
  if (!projectValue) return null;
  return {
    source: 'state.json',
    projectPath: path.resolve(projectValue),
    sessionId: null,
  };
}

function resolveLocalProjectContext(startDir = process.cwd()) {
  const fromLink = resolveProjectContextFromLink(startDir);
  if (fromLink?.projectPath) return fromLink;

  const fromState = resolveProjectContextFromState();
  if (fromState?.projectPath) return fromState;

  return {
    source: 'cwd',
    projectPath: path.resolve(startDir),
    sessionId: null,
  };
}

function applyProjectContext(projectContext = null) {
  if (!projectContext?.projectPath || typeof setProjectRoot !== 'function') return projectContext;
  try {
    setProjectRoot(projectContext.projectPath);
  } catch (_) {
    // Best-effort only.
  }
  return projectContext;
}

function normalizeSessionId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^app-session-/i.test(text)) return text;
  if (/^\d+$/.test(text)) return `app-session-${text}`;
  return text;
}

function looksLikeLegacyBootstrapSessionId(value) {
  return /^app-\d+-\d+/i.test(String(value || '').trim());
}

function resolveSessionIdFromAppStatus() {
  if (typeof resolveCoordPath !== 'function') return null;
  const appStatus = parseJsonFileSafe(resolveCoordPath('app-status.json'));
  if (!appStatus || typeof appStatus !== 'object') return null;
  const rawSession = appStatus.session_id ?? appStatus.sessionId ?? appStatus.session ?? appStatus.sessionNumber;
  return normalizeSessionId(rawSession);
}

function resolvePreferredSessionId(explicitSessionId = null, fallbackSessionId = null) {
  const explicit = normalizeSessionId(explicitSessionId);
  if (explicit) return explicit;

  const appStatusSession = resolveSessionIdFromAppStatus();
  if (appStatusSession) return appStatusSession;

  const fallback = normalizeSessionId(fallbackSessionId);
  if (fallback && !looksLikeLegacyBootstrapSessionId(fallback)) return fallback;
  return null;
}

const localProjectContext = applyProjectContext(resolveLocalProjectContext(process.cwd()));

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
    const boundary = '----SquidRunBoundary' + Date.now();
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
  const senderRole = asRole(opts.senderRole || opts.fromRole || 'architect', 'architect');
  const targetRole = asRole(opts.targetRole || opts.toRole || 'user', 'user');
  const sessionId = resolvePreferredSessionId(opts.sessionId, localProjectContext?.sessionId || null);

  upsertTelegramJournal({
    messageId,
    sessionId,
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
      sessionId,
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
      sessionId,
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
      sessionId,
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
    sessionId,
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
  const senderRole = asRole(opts.senderRole || opts.fromRole || 'architect', 'architect');
  const targetRole = asRole(opts.targetRole || opts.toRole || 'user', 'user');
  const sessionId = resolvePreferredSessionId(opts.sessionId, localProjectContext?.sessionId || null);

  upsertTelegramJournal({
    messageId,
    sessionId,
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
      sessionId,
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
      sessionId,
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
    sessionId,
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
