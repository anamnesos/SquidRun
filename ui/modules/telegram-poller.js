/**
 * Telegram inbound poller.
 * Uses raw HTTPS polling and relays inbound messages to a callback.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { resolveCoordPath } = require('../config');
const log = require('./logger');

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const DEFAULT_INBOUND_MEDIA_DIR = path.join('runtime', 'telegram-inbound-media');
const DEFAULT_LATEST_SCREENSHOT_PATH = path.join('screenshots', 'latest.png');
const DEFAULT_POLLER_STATE_PATH = path.join('runtime', 'telegram-poller-state.json');
const DEFAULT_STARTUP_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_BACKLOG_BACKSTOP_DROP_MS = 24 * 60 * 60 * 1000;

let running = false;
let pollTimer = null;
let pollInFlight = false;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let onMessage = null;
let config = null;
let nextOffset = 0;
let mediaDownloadEnabled = true;
let mediaDownloadRoot = null;
let latestScreenshotPath = null;
let statePath = null;
let cursorKey = null;
let delayedMarkerMs = DEFAULT_STARTUP_GRACE_MS;
let backlogBackstopDropMs = DEFAULT_BACKLOG_BACKSTOP_DROP_MS;
let pollerDataRoot = null;

function normalizeRootPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return path.resolve(value.trim());
}

function fingerprintTelegramToken(token) {
  if (typeof token !== 'string' || !token.trim()) return null;
  return crypto.createHash('sha256').update(token.trim()).digest('hex').slice(0, 16);
}

function resolvePollerDataRoot(env = process.env) {
  return normalizeRootPath(env.SQUIDRUN_DATA_ROOT)
    || normalizeRootPath(env.SQUIDRUN_PROJECT_ROOT)
    || null;
}

function getTelegramConfig(env = process.env) {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatIdRaw = (env.TELEGRAM_CHAT_ID || '').trim();
  const chatId = Number.parseInt(chatIdRaw, 10);

  if (!botToken || !chatIdRaw || !Number.isFinite(chatId)) {
    return null;
  }

  // Parse additional authorized chat IDs from both legacy and current env names.
  const extraIds = [
    env.TELEGRAM_AUTHORIZED_CHAT_IDS,
    env.TELEGRAM_CHAT_ALLOWLIST,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(',');
  const authorizedChatIds = Array.from(new Set(
    extraIds
      ? extraIds.split(',').map(s => Number.parseInt(s.trim(), 10)).filter(Number.isFinite)
      : []
  ));

  // Profile-scoped routing is resolved by one getUpdates owner. The main
  // profile can opt into accepting scoped chat IDs centrally, then route them
  // by chatId/windowKey; secondary profiles must not run competing pollers.
  // Fail-safe: without the central-owner flag, main rejects scoped chat IDs.
  const profile = String(env.SQUIDRUN_PROFILE || '').trim().toLowerCase();
  const scopedRaw = typeof env.TELEGRAM_SCOPED_CHAT_IDS === 'string'
    ? env.TELEGRAM_SCOPED_CHAT_IDS.trim()
    : '';
  const scopedChatIds = Array.from(new Set(
    scopedRaw
      ? scopedRaw.split(',').map(s => Number.parseInt(s.trim(), 10)).filter(Number.isFinite)
      : []
  ));

  return {
    botToken,
    chatId,
    authorizedChatIds,
    profile,
    scopedChatIds,
    acceptScopedChatIds: env.SQUIDRUN_TELEGRAM_ACCEPT_SCOPED_CHATS === '1',
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
        response.setEncoding('utf8');
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

function requestTelegramBuffer(method, requestPath) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: requestPath,
        method,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: Buffer.concat(chunks),
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

function normalizeOffset(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getConfigCursorKey(currentConfig) {
  if (!currentConfig) return 'telegram:unknown';
  const tokenHash = crypto
    .createHash('sha256')
    .update(String(currentConfig.botToken || ''))
    .digest('hex')
    .slice(0, 16);
  const profile = String(currentConfig.profile || 'main').trim().toLowerCase() || 'main';
  const scopedIds = Array.isArray(currentConfig.scopedChatIds)
    ? currentConfig.scopedChatIds.slice().sort((left, right) => left - right).join(',')
    : '';
  const scopeMode = currentConfig.acceptScopedChatIds ? 'accept-scoped' : 'own-chat';
  return [
    'telegram',
    tokenHash,
    profile,
    String(currentConfig.chatId || ''),
    scopedIds,
    scopeMode,
  ].join(':');
}

function getAuthorizedChatId(message) {
  const value = Number.parseInt(String(message?.chat?.id ?? ''), 10);
  return Number.isFinite(value) ? value : null;
}

function isAuthorizedChat(message, currentConfig) {
  const chatId = getAuthorizedChatId(message);
  if (chatId === null) return false;

  const scopedIds = Array.isArray(currentConfig.scopedChatIds) ? currentConfig.scopedChatIds : [];
  const profile = typeof currentConfig.profile === 'string' ? currentConfig.profile : '';

  if (profile === 'scoped') {
    // Scoped window: accept ONLY chats declared as scoped-scoped.
    return scopedIds.includes(chatId);
  }

  // Main window (profile unset or anything else): accept the normal allowlist
  // but REJECT any chat declared as scoped-scoped so case-work does not leak in.
  if (scopedIds.includes(chatId)) {
    return currentConfig.acceptScopedChatIds === true;
  }
  if (chatId === currentConfig.chatId) return true;
  if (Array.isArray(currentConfig.authorizedChatIds) && currentConfig.authorizedChatIds.includes(chatId)) return true;
  return false;
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

function resolveWritableCoordPath(relPath) {
  try {
    return resolveCoordPath(relPath, { forWrite: true });
  } catch (_) {
    return path.resolve(process.cwd(), '.squidrun', relPath);
  }
}

function resolveDefaultStatePath(env = process.env) {
  if (env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test') return null;
  return resolveWritableCoordPath(DEFAULT_POLLER_STATE_PATH);
}

function resolveStatePath(options = {}) {
  const explicit = typeof options.statePath === 'string' && options.statePath.trim()
    ? options.statePath.trim()
    : (typeof options.env?.TELEGRAM_POLLER_STATE_PATH === 'string' && options.env.TELEGRAM_POLLER_STATE_PATH.trim()
      ? options.env.TELEGRAM_POLLER_STATE_PATH.trim()
      : null);
  if (explicit) return path.resolve(explicit);
  return resolveDefaultStatePath(options.env || process.env);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readPollerState(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    log.warn('Telegram', `Telegram poller state read failed (${filePath}): ${err.message}`);
    return null;
  }
}

function writePollerState(filePath, state) {
  if (!filePath) return false;
  try {
    ensureDir(path.dirname(filePath));
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    log.warn('Telegram', `Telegram poller state write failed (${filePath}): ${err.message}`);
    return false;
  }
}

function readPersistedOffset(filePath, key) {
  if (!filePath || !key) return null;
  const state = readPollerState(filePath);
  const cursor = state?.cursors?.[key];
  const offset = normalizeOffset(cursor?.nextOffset);
  return offset;
}

function persistNextOffset(filePath, key, offset, details = {}) {
  const normalized = normalizeOffset(offset);
  if (!filePath || !key || normalized === null) return false;

  const existing = readPollerState(filePath);
  const state = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing
    : {};
  const cursors = state.cursors && typeof state.cursors === 'object' && !Array.isArray(state.cursors)
    ? state.cursors
    : {};
  const prior = cursors[key] && typeof cursors[key] === 'object' && !Array.isArray(cursors[key])
    ? cursors[key]
    : {};
  const hasMediaFileId = Object.prototype.hasOwnProperty.call(details, 'mediaFileId');

  state.version = 1;
  state.updatedAt = new Date().toISOString();
  state.cursors = {
    ...cursors,
    [key]: {
      ...prior,
      nextOffset: normalized,
      updatedAt: state.updatedAt,
      profile: details.profile || prior.profile || null,
      chatId: details.chatId ?? prior.chatId ?? null,
      lastUpdateId: details.updateId ?? prior.lastUpdateId ?? null,
      lastMessageId: details.messageId ?? prior.lastMessageId ?? null,
      lastMediaFileId: hasMediaFileId ? (details.mediaFileId || null) : (prior.lastMediaFileId || null),
      lastAction: details.action || prior.lastAction || 'seen',
    },
  };

  return writePollerState(filePath, state);
}

function persistPollerHeartbeat(filePath, key, details = {}) {
  if (!filePath) return false;

  const existing = readPollerState(filePath);
  const state = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing
    : {};
  const nowIso = new Date().toISOString();
  const priorPoller = state.poller && typeof state.poller === 'object' && !Array.isArray(state.poller)
    ? state.poller
    : {};

  state.version = 1;
  state.updatedAt = nowIso;
  state.poller = {
    ...priorPoller,
    cursorKey: key || priorPoller.cursorKey || null,
    pid: process.pid,
    profile: details.profile || priorPoller.profile || null,
    dataRoot: details.dataRoot || priorPoller.dataRoot || null,
    tokenFingerprint: details.tokenFingerprint || priorPoller.tokenFingerprint || null,
    chatId: details.chatId ?? priorPoller.chatId ?? null,
    nextOffset: normalizeOffset(details.nextOffset) ?? normalizeOffset(priorPoller.nextOffset),
    lastPollAt: nowIso,
    lastPollStatus: details.status || priorPoller.lastPollStatus || 'unknown',
    lastError: details.error || null,
  };

  return writePollerState(filePath, state);
}

function resolveStartupGraceMs(options = {}) {
  const candidates = [
    options.startupGraceMs,
    options.env?.TELEGRAM_INBOUND_STARTUP_GRACE_MS,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_STARTUP_GRACE_MS;
}

function resolveBacklogBackstopDropMs(options = {}) {
  const candidates = [
    options.backlogBackstopDropMs,
    options.env?.TELEGRAM_INBOUND_BACKSTOP_DROP_MS,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_BACKLOG_BACKSTOP_DROP_MS;
}

function resolveDefaultMediaDownloadRoot(env = process.env) {
  return env.TELEGRAM_INBOUND_MEDIA_DIR
    ? path.resolve(env.TELEGRAM_INBOUND_MEDIA_DIR)
    : resolveWritableCoordPath(DEFAULT_INBOUND_MEDIA_DIR);
}

function resolveDefaultLatestScreenshotPath() {
  return resolveWritableCoordPath(DEFAULT_LATEST_SCREENSHOT_PATH);
}

function sanitizeFilenamePart(value, fallback = 'telegram') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}

function getFileExtension(fileName = '', mimeType = '', telegramFilePath = '', fallback = '.jpg') {
  const fromName = path.extname(String(fileName || '')).trim();
  if (fromName) return fromName.toLowerCase();

  const fromTelegramPath = path.extname(String(telegramFilePath || '')).trim();
  if (fromTelegramPath) return fromTelegramPath.toLowerCase();

  const normalizedMimeType = String(mimeType || '').trim().toLowerCase();
  if (normalizedMimeType === 'image/png') return '.png';
  if (normalizedMimeType === 'image/webp') return '.webp';
  if (normalizedMimeType === 'image/gif') return '.gif';
  if (normalizedMimeType === 'image/heic' || normalizedMimeType === 'image/heif') return '.heic';
  if (normalizedMimeType.startsWith('image/')) return '.jpg';
  if (normalizedMimeType === 'video/mp4') return '.mp4';
  if (normalizedMimeType === 'video/quicktime') return '.mov';
  if (normalizedMimeType === 'video/x-m4v') return '.m4v';
  if (normalizedMimeType === 'video/webm') return '.webm';
  if (normalizedMimeType === 'video/x-matroska') return '.mkv';
  if (normalizedMimeType.startsWith('video/')) return '.mp4';

  return fallback;
}

function isImageDocument(document) {
  if (!document || typeof document !== 'object') return false;
  const mimeType = String(document.mime_type || '').trim().toLowerCase();
  if (mimeType.startsWith('image/')) return true;

  const extension = path.extname(String(document.file_name || '')).trim().toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'].includes(extension);
}

function isVideoDocument(document) {
  if (!document || typeof document !== 'object') return false;
  const mimeType = String(document.mime_type || '').trim().toLowerCase();
  if (mimeType.startsWith('video/')) return true;

  const extension = path.extname(String(document.file_name || '')).trim().toLowerCase();
  return ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'].includes(extension);
}

function extractInboundMessage(update) {
  if (!update || typeof update !== 'object') return { kind: null, message: null };
  const candidates = ['message', 'edited_message', 'channel_post', 'edited_channel_post'];
  for (const kind of candidates) {
    if (update[kind] && typeof update[kind] === 'object') {
      return {
        kind,
        message: update[kind],
      };
    }
  }
  return { kind: null, message: null };
}

function selectInboundMedia(message) {
  const photoArray = Array.isArray(message?.photo) ? message.photo : [];
  if (photoArray.length > 0) {
    const photo = photoArray[photoArray.length - 1];
    const fileId = typeof photo?.file_id === 'string' ? photo.file_id.trim() : '';
    if (fileId) {
      return {
        kind: 'photo',
        fileId,
        telegram: photo,
        fileName: '',
        mimeType: 'image/jpeg',
        fileUniqueId: typeof photo?.file_unique_id === 'string' ? photo.file_unique_id.trim() : '',
      };
    }
  }

  const video = message?.video && typeof message.video === 'object' ? message.video : null;
  if (video) {
    const fileId = typeof video?.file_id === 'string' ? video.file_id.trim() : '';
    if (fileId) {
      return {
        kind: 'video',
        telegramKind: 'video',
        fileId,
        telegram: video,
        fileName: typeof video.file_name === 'string' ? video.file_name.trim() : '',
        mimeType: typeof video.mime_type === 'string' ? video.mime_type.trim() : 'video/mp4',
        fileUniqueId: typeof video.file_unique_id === 'string' ? video.file_unique_id.trim() : '',
        duration: Number.isFinite(Number(video.duration)) ? Number(video.duration) : null,
        width: Number.isFinite(Number(video.width)) ? Number(video.width) : null,
        height: Number.isFinite(Number(video.height)) ? Number(video.height) : null,
      };
    }
  }

  const document = message?.document && typeof message.document === 'object' ? message.document : null;
  if (document) {
    const fileId = typeof document?.file_id === 'string' ? document.file_id.trim() : '';
    if (fileId) {
      const isVideo = isVideoDocument(document);
      return {
        kind: isVideo ? 'video' : 'document',
        telegramKind: 'document',
        fileId,
        telegram: document,
        fileName: typeof document.file_name === 'string' ? document.file_name.trim() : '',
        mimeType: typeof document.mime_type === 'string' ? document.mime_type.trim() : '',
        fileUniqueId: typeof document.file_unique_id === 'string' ? document.file_unique_id.trim() : '',
      };
    }
  }

  return null;
}

function getMediaFileId(message) {
  const media = selectInboundMedia(message);
  return typeof media?.fileId === 'string' && media.fileId.trim()
    ? media.fileId.trim()
    : null;
}

function buildInboundDisplayText(message, selectedMedia = null) {
  const text = normalizeBody(message?.text);
  if (text) return text;

  const caption = normalizeBody(message?.caption);
  const media = selectedMedia || selectInboundMedia(message);
  if (media?.kind === 'photo') {
    return caption ? `[Photo] ${caption}` : '[Photo received]';
  }
  if (media?.kind === 'video') {
    return caption ? `[Video] ${caption}` : '[Video received]';
  }

  const document = message?.document && typeof message.document === 'object' ? message.document : null;
  if (document || media?.kind === 'document') {
    const fileName = document?.file_name || media?.fileName || 'unknown';
    return caption ? `[File: ${fileName}] ${caption}` : `[File: ${fileName}]`;
  }

  return '';
}

async function requestTelegramJson(method, requestPath) {
  const response = await requestTelegram(method, requestPath);
  let payload = null;
  try {
    payload = JSON.parse(response.body || '{}');
  } catch (err) {
    return {
      ok: false,
      statusCode: response.statusCode,
      error: `invalid_json:${err.message}`,
      payload: null,
    };
  }

  if (response.statusCode < 200 || response.statusCode >= 300 || payload?.ok === false) {
    return {
      ok: false,
      statusCode: response.statusCode,
      error: payload?.description || `telegram_request_failed:${response.statusCode}`,
      payload,
    };
  }

  return {
    ok: true,
    statusCode: response.statusCode,
    payload,
  };
}

function buildGetFilePath(currentConfig, fileId) {
  const query = new URLSearchParams();
  query.append('file_id', fileId);
  return `/bot${currentConfig.botToken}/getFile?${query.toString()}`;
}

function buildDownloadPath(currentConfig, telegramFilePath) {
  return `/file/bot${currentConfig.botToken}/${telegramFilePath.replace(/^\/+/, '')}`;
}

function buildInboundMediaFilePath(media, context = {}) {
  const baseDir = mediaDownloadRoot || resolveDefaultMediaDownloadRoot();
  ensureDir(baseDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const updateLabel = Number.isFinite(Number(context.updateId))
    ? `u${Math.floor(Number(context.updateId))}`
    : `m${Math.floor(Number(context.messageId || Date.now()))}`;
  const idLabel = sanitizeFilenamePart(
    media.fileUniqueId || media.fileName || media.fileId || media.kind,
    media.kind
  );
  const extension = getFileExtension(
    media.fileName,
    media.mimeType,
    media.telegramFilePath,
    media.kind === 'photo' ? '.jpg' : '.bin'
  );
  return path.join(baseDir, `${timestamp}-${updateLabel}-${idLabel}${extension}`);
}

function persistInboundMedia(buffer, media, context = {}) {
  const archivePath = buildInboundMediaFilePath(media, context);
  ensureDir(path.dirname(archivePath));
  fs.writeFileSync(archivePath, buffer);

  const result = {
    kind: media.kind,
    fileId: media.fileId,
    telegramFilePath: media.telegramFilePath || null,
    fileName: media.fileName || null,
    mimeType: media.mimeType || null,
    telegramKind: media.telegramKind || media.kind,
    duration: media.duration ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
    localPath: archivePath,
    bytes: buffer.length,
    latestScreenshotPath: null,
  };

  const latestPath = latestScreenshotPath || resolveDefaultLatestScreenshotPath();
  if (latestPath && String(result.mimeType || '').toLowerCase().startsWith('image/')) {
    ensureDir(path.dirname(latestPath));
    fs.copyFileSync(archivePath, latestPath);
    result.latestScreenshotPath = latestPath;
  }

  return result;
}

async function maybeDownloadInboundMedia(message, currentConfig, context = {}) {
  if (!mediaDownloadEnabled || !currentConfig) return null;

  const media = selectInboundMedia(message);
  if (!media) return null;

  const fileResult = await requestTelegramJson('GET', buildGetFilePath(currentConfig, media.fileId));
  if (!fileResult.ok) {
    throw new Error(`getFile failed (${fileResult.error})`);
  }

  const telegramFilePath = typeof fileResult.payload?.result?.file_path === 'string'
    ? fileResult.payload.result.file_path.trim()
    : '';
  if (!telegramFilePath) {
    throw new Error('getFile returned no file_path');
  }

  media.telegramFilePath = telegramFilePath;
  const downloadResponse = await requestTelegramBuffer('GET', buildDownloadPath(currentConfig, telegramFilePath));
  if (downloadResponse.statusCode < 200 || downloadResponse.statusCode >= 300) {
    throw new Error(`file download failed (${downloadResponse.statusCode})`);
  }

  return persistInboundMedia(downloadResponse.body, media, context);
}

async function pollNow() {
  if (!running || !config || pollInFlight) return;
  pollInFlight = true;
  let heartbeatStatus = 'started';
  let heartbeatError = null;

  try {
    const path = buildUpdatesPath(config, nextOffset);
    const response = await requestTelegram('GET', path);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      log.warn('Telegram', `Telegram polling failed (${response.statusCode})`);
      heartbeatStatus = 'http_error';
      heartbeatError = `status:${response.statusCode}`;
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(response.body || '{}');
    } catch (err) {
      log.warn('Telegram', `Telegram polling returned invalid JSON: ${err.message}`);
      heartbeatStatus = 'invalid_json';
      heartbeatError = err.message;
      return;
    }

    const updates = Array.isArray(payload.result) ? payload.result : [];
    heartbeatStatus = updates.length > 0 ? 'updates_received' : 'ok_empty';
    const sortedUpdates = updates
      .slice()
      .sort((left, right) => {
        const leftId = parseUpdateId(left) ?? 0;
        const rightId = parseUpdateId(right) ?? 0;
        return leftId - rightId;
      });

    for (const update of sortedUpdates) {
      const updateId = parseUpdateId(update);
      if (updateId === null || updateId < nextOffset) continue;
      nextOffset = Math.max(nextOffset, updateId + 1);

      const inbound = extractInboundMessage(update);
      const message = inbound.message;
      const messageId = Number.isFinite(Number(message?.message_id))
        ? Number(message.message_id)
        : null;
      const parsedChatId = message ? getAuthorizedChatId(message) : null;
      const mediaFileId = message ? getMediaFileId(message) : null;

      persistNextOffset(statePath, cursorKey, nextOffset, {
        action: 'seen',
        chatId: parsedChatId,
        mediaFileId,
        messageId,
        profile: config.profile || 'main',
        updateId,
      });

      if (!message) continue;
      if (!isAuthorizedChat(message, config)) {
        log.warn(
          'Telegram',
          `Rejected inbound Telegram message from unauthorized chat (${message?.chat?.id ?? 'unknown'}) — profile=${config.profile || 'main'} config.chatId=${config.chatId} authorizedChatIds=${JSON.stringify(config.authorizedChatIds)} scopedChatIds=${JSON.stringify(config.scopedChatIds)} msgChatId=${message?.chat?.id} typeof=${typeof message?.chat?.id}`
        );
        continue;
      }

      const messageTimestampMs = parseMessageTimestampMs(message);
      const messageAgeMs = messageTimestampMs === null ? 0 : Math.max(0, Date.now() - messageTimestampMs);
      if (backlogBackstopDropMs > 0 && messageAgeMs > backlogBackstopDropMs) {
        persistNextOffset(statePath, cursorKey, nextOffset, {
          action: 'dropped_backlog_backstop',
          chatId: parsedChatId,
          mediaFileId,
          messageId,
          profile: config.profile || 'main',
          updateId,
        });
        const bodyPreview = String(message.text || message.caption || '').slice(0, 80);
        log.warn(
          'Telegram',
          `DROPPED backlog update ${updateId} past the ${Math.round(backlogBackstopDropMs / 3600000)}h backstop (message=${messageId ?? 'unknown'} chat=${parsedChatId ?? 'unknown'} ageMs=${messageAgeMs} bodyPreview=${JSON.stringify(bodyPreview)}) - no-drop policy backstop, loss logged deliberately`
        );
        continue;
      }

      const photoArray = Array.isArray(message.photo) ? message.photo : null;
      const document = message.document && typeof message.document === 'object' ? message.document : null;
      const selectedMedia = selectInboundMedia(message);
      if (selectedMedia) {
        log.info(
          'Telegram',
          `Inbound Telegram ${selectedMedia.kind} detected (update=${updateId} message=${messageId ?? 'unknown'} chat=${message?.chat?.id ?? 'unknown'} downloadMedia=${mediaDownloadEnabled ? 'enabled' : 'disabled'})`
        );
      }

      let downloadedMedia = null;
      try {
        downloadedMedia = await maybeDownloadInboundMedia(message, config, {
          updateId,
          messageId,
        });
        if (downloadedMedia) {
          log.info(
            'Telegram',
            `Inbound Telegram ${downloadedMedia.kind} saved to ${downloadedMedia.localPath} (update=${updateId} message=${messageId ?? 'unknown'})`
          );
        }
      } catch (err) {
        log.warn(
          'Telegram',
          `Telegram media download failed for update=${updateId} message=${messageId ?? 'unknown'} fileId=${selectedMedia?.fileId || 'unknown'}: ${err.message}`
        );
      }

      let displayText = buildInboundDisplayText(message, selectedMedia);
      if (!displayText) {
        log.warn(
          'Telegram',
          `Skipping inbound Telegram update ${updateId} because no display text could be derived (hasPhoto=${photoArray ? 'yes' : 'no'} hasDocument=${document ? 'yes' : 'no'})`
        );
        continue;
      }
      if (delayedMarkerMs > 0 && messageAgeMs > delayedMarkerMs) {
        displayText = `[delayed: ${Math.max(1, Math.round(messageAgeMs / 60000))}m old] ${displayText}`;
      }

      if (typeof onMessage === 'function') {
        try {
          log.info(
            'Telegram',
            `Dispatching inbound Telegram update ${updateId} to callback (message=${messageId ?? 'unknown'} body=${JSON.stringify(displayText)})`
          );
          await Promise.resolve(onMessage(displayText, normalizeFrom(message.from), {
            updateId,
            updateKind: inbound.kind,
            messageId,
            chatId: getAuthorizedChatId(message),
            timestampMs: parseMessageTimestampMs(message),
            photo: photoArray ? photoArray[photoArray.length - 1] : null,
            video: message.video && typeof message.video === 'object' ? message.video : null,
            document: document || null,
            media: downloadedMedia,
          }));
          persistNextOffset(statePath, cursorKey, nextOffset, {
            action: 'delivered',
            chatId: parsedChatId,
            mediaFileId,
            messageId,
            profile: config.profile || 'main',
            updateId,
          });
        } catch (err) {
          persistNextOffset(statePath, cursorKey, nextOffset, {
            action: 'callback_failed',
            chatId: parsedChatId,
            mediaFileId,
            messageId,
            profile: config.profile || 'main',
            updateId,
          });
          log.warn('Telegram', `Telegram callback failed: ${err.message}`);
        }
      }
    }
  } catch (err) {
    log.warn('Telegram', `Telegram polling error: ${err.message}`);
    heartbeatStatus = 'request_error';
    heartbeatError = err.message;
  } finally {
    persistPollerHeartbeat(statePath, cursorKey, {
      chatId: config?.chatId ?? null,
      dataRoot: pollerDataRoot,
      error: heartbeatError,
      nextOffset,
      profile: config?.profile || 'main',
      status: heartbeatStatus,
      tokenFingerprint: fingerprintTelegramToken(config?.botToken),
    });
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
  mediaDownloadEnabled = options.downloadMedia !== false;
  mediaDownloadRoot = typeof options.mediaDownloadRoot === 'string' && options.mediaDownloadRoot.trim()
    ? path.resolve(options.mediaDownloadRoot)
    : (typeof options.env?.TELEGRAM_INBOUND_MEDIA_DIR === 'string' && options.env.TELEGRAM_INBOUND_MEDIA_DIR.trim()
      ? path.resolve(options.env.TELEGRAM_INBOUND_MEDIA_DIR)
      : resolveDefaultMediaDownloadRoot(options.env || process.env));
  latestScreenshotPath = typeof options.latestScreenshotPath === 'string' && options.latestScreenshotPath.trim()
    ? path.resolve(options.latestScreenshotPath)
    : resolveDefaultLatestScreenshotPath();
  statePath = resolveStatePath(options);
  pollerDataRoot = resolvePollerDataRoot(options.env || process.env);
  cursorKey = getConfigCursorKey(config);
  nextOffset = readPersistedOffset(statePath, cursorKey) ?? normalizeOffset(options.initialOffset) ?? 0;
  delayedMarkerMs = resolveStartupGraceMs(options);
  backlogBackstopDropMs = resolveBacklogBackstopDropMs(options);
  pollInFlight = false;
  running = true;

  log.info(
    'Telegram',
    `Telegram poller cursor loaded (offset=${nextOffset}, state=${statePath || 'disabled'})`
  );
  log.info(
    'Telegram',
    `Telegram backlog policy: no-drop; delayed-marker after ${delayedMarkerMs}ms; backstop drop ${backlogBackstopDropMs > 0 ? `${backlogBackstopDropMs}ms (always logged)` : 'disabled'}`
  );
  log.info(
    'Telegram',
    `Telegram inbound media downloads ${mediaDownloadEnabled ? 'enabled' : 'disabled'} (root=${mediaDownloadRoot || 'n/a'})`
  );
  pollTimer = setInterval(() => {
    pollNow().catch((err) => {
      log.warn('Telegram', `Telegram polling tick failed: ${err.message}`);
    });
  }, pollIntervalMs);
  if (options.keepAlive !== true && typeof pollTimer.unref === 'function') {
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
  mediaDownloadEnabled = true;
  mediaDownloadRoot = null;
  latestScreenshotPath = null;
  statePath = null;
  pollerDataRoot = null;
  cursorKey = null;
  delayedMarkerMs = DEFAULT_STARTUP_GRACE_MS;
  backlogBackstopDropMs = DEFAULT_BACKLOG_BACKSTOP_DROP_MS;
}

function isRunning() {
  return running;
}

const _internals = {
  getTelegramConfig,
  buildUpdatesPath,
  requestTelegram,
  requestTelegramBuffer,
  requestTelegramJson,
  maybeDownloadInboundMedia,
  selectInboundMedia,
  buildInboundDisplayText,
  extractInboundMessage,
  pollNow,
  parseUpdateId,
  normalizeOffset,
  getConfigCursorKey,
  isAuthorizedChat,
  isImageDocument,
  isVideoDocument,
  resolveDefaultMediaDownloadRoot,
  resolveDefaultStatePath,
  resolveStatePath,
  readPersistedOffset,
  persistNextOffset,
  persistPollerHeartbeat,
  resolveBacklogBackstopDropMs,
};

module.exports = {
  start,
  stop,
  isRunning,
  _internals,
};
