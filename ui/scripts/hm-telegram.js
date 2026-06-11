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
const {
  reconcileTelegramReplyObligationFromJournal,
} = require('../modules/main/telegram-reply-obligations');
require('dotenv').config({ path: path.join(process.env.SQUIDRUN_PROJECT_ROOT || path.resolve(__dirname, '..', '..'), '.env') });
try {
  const dataRoot = process.env.SQUIDRUN_PROJECT_ROOT;
  if (dataRoot) {
    require('../modules/install-credentials').applyInstallCredentialEnvOverlay({ dataRoot });
  }
} catch (_) {
  // CLI credential overlay is best effort; normal missing-config handling below reports send failures.
}

const TELEGRAM_RATE_LIMIT_MAX_MESSAGES = 10;
const TELEGRAM_RATE_LIMIT_WINDOW_MS = 60_000;
const TELEGRAM_MESSAGE_MAX_CHARS = 4_000;
const TELEGRAM_CAPTION_MAX_CHARS = 1_000;
const TELEGRAM_TRUNCATED_SUFFIX = '[message truncated]';
const TELEGRAM_REPLY_CONTEXT_PATH = path.join('runtime', 'telegram-reply-context.json');
const RESERVED_SINGLE_MESSAGE_TOKENS = new Set([
  'help',
  'poll',
  'poller',
  'recover',
  'receive',
  'restart',
  'run',
  'start',
  'status',
  'stop',
  'updates',
  'version',
]);
const INTERNAL_EGRESS_LINE_PATTERNS = [
  /^\s*\[CURRENT PROJECT\].*$/i,
  /^\s*\[PROJECT CONTEXT SWITCHED\].*$/i,
  /^\s*Mira held that reply\. Open Mira Lab for diagnostics\.?\s*$/i,
];
const INTERNAL_EGRESS_PREFIX_PATTERN = /^\s*(?:\[AGENT MSG - reply via hm-send\.js\]\s*)?(?:(?:\((?:(?:MIRA\s*\/\s*)?(?:ARCHITECT|ARCH|BUILDER|BUILD|ORACLE)|MIRA)(?:\s*#\d+)?\)\s*:?)|(?:(?:ARCHITECT|ARCH|BUILDER|BUILD|ORACLE|MIRA)(?:\s*#\d+)?\s*:))\s*/i;

let telegramRateLimiterQueue = Promise.resolve();
let telegramRateLimiterTimestamps = [];

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
  const explicitProjectRoot = String(process.env.SQUIDRUN_PROJECT_ROOT || '').trim();
  if (explicitProjectRoot) {
    return projectContext;
  }
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

function getReplyObligationInboundMessageId(metadata = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = metadata.replyToMessageId
    || metadata.reply_to_message_id
    || metadata.inboundMessageId
    || metadata.inbound_message_id
    || null;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function reconcileTelegramReplyObligationAfterAck(metadata = {}, options = {}) {
  const inboundMessageId = getReplyObligationInboundMessageId(metadata);
  if (!inboundMessageId) return null;
  try {
    return reconcileTelegramReplyObligationFromJournal({
      inboundMessageId,
    }, {
      dbPath: options.dbPath || null,
    });
  } catch (err) {
    console.warn(`[hm-telegram] durable reply obligation reconcile skipped: ${err.message}`);
    return {
      ok: false,
      status: 'exception',
      reason: err.message,
      inboundMessageId,
    };
  }
}

function usage() {
  console.log('Usage: node hm-telegram.js <message>');
  console.log('       node hm-telegram.js --message <message>');
  console.log('       node hm-telegram.js --text <message>');
  console.log('       node hm-telegram.js --stdin');
  console.log('       node hm-telegram.js --file <text-file>');
  console.log('       node hm-telegram.js --photo <image-path> [caption]');
  console.log('       node hm-telegram.js [--chat-id <chat-id>] <message>');
  console.log('       node hm-telegram.js --photo <image-path> [caption] [--chat-id <chat-id>]');
  console.log('Poller status: node hm-telegram-poller-lane.js status');
  console.log('Env required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID');
  console.log('Optional: TELEGRAM_CHAT_ALLOWLIST (comma-separated chat ids)');
}

function parseMessage(args = []) {
  return args.join(' ').trim();
}

function isReservedSingleMessageToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!token) return false;
  if (token.startsWith('--')) return true;
  return RESERVED_SINGLE_MESSAGE_TOKENS.has(token);
}

function parseCliArgs(argv = []) {
  let photoPath = null;
  let chatId = null;
  let messageFile = null;
  let readStdin = false;
  let explicitMessage = false;
  const messageParts = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--photo') {
      if (!argv[i + 1]) {
        return { ok: false, error: '--photo requires an image path' };
      }
      photoPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--chat-id') {
      if (!argv[i + 1]) {
        return { ok: false, error: '--chat-id requires a chat ID' };
      }
      chatId = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--message' || token === '--text') {
      if (!argv[i + 1]) {
        return { ok: false, error: `${token} requires message text` };
      }
      explicitMessage = true;
      messageParts.push(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--stdin') {
      explicitMessage = true;
      readStdin = true;
      continue;
    }
    if (token === '--file') {
      if (!argv[i + 1]) {
        return { ok: false, error: '--file requires a text file path' };
      }
      explicitMessage = true;
      messageFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (String(token || '').startsWith('--')) {
      return { ok: false, error: `Unknown option ${token}` };
    }
    messageParts.push(token);
  }

  if (!photoPath && !explicitMessage && messageParts.length === 1 && isReservedSingleMessageToken(messageParts[0])) {
    return {
      ok: false,
      error: `hm-telegram.js sends messages; refusing reserved command-like token "${messageParts[0]}". For poller status use hm-telegram-poller-lane.js status, or use --message/--text/--stdin/--file for explicit message text.`,
    };
  }

  return {
    ok: true,
    photoPath,
    chatId,
    messageFile,
    readStdin,
    explicitMessage,
    message: parseMessage(messageParts),
  };
}

function readParsedMessageInput(parsed = {}) {
  const parts = [];
  if (parsed.message) parts.push(parsed.message);
  if (parsed.messageFile) {
    parts.push(fs.readFileSync(parsed.messageFile, 'utf8'));
  }
  if (parsed.readStdin) {
    parts.push(fs.readFileSync(0, 'utf8'));
  }
  return parts.join('\n').trim();
}

function normalizeChatId(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (!/^-?\d+$/.test(text)) return null;
  return text;
}

function parseChatAllowlist(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  const parsed = value
    .split(',')
    .map((entry) => normalizeChatId(entry))
    .filter(Boolean);
  return Array.from(new Set(parsed));
}

function resolveTelegramReplyContextPath() {
  if (typeof resolveCoordPath !== 'function') return null;
  try {
    return resolveCoordPath(TELEGRAM_REPLY_CONTEXT_PATH);
  } catch (_) {
    return null;
  }
}

function readTelegramReplyContext() {
  const contextPath = resolveTelegramReplyContextPath();
  if (!contextPath) return null;

  const payload = parseJsonFileSafe(contextPath);
  if (!payload || typeof payload !== 'object') return null;

  const chatId = normalizeChatId(payload.chatId);
  if (!chatId) return null;

  return {
    chatId,
    sender: typeof payload.sender === 'string' ? payload.sender.trim() || null : null,
    messageId: typeof payload.messageId === 'string' ? payload.messageId.trim() || null : null,
    inboundMessageId: typeof payload.inboundMessageId === 'string' ? payload.inboundMessageId.trim() || null : null,
    replyToMessageId: typeof payload.replyToMessageId === 'string' ? payload.replyToMessageId.trim() || null : null,
    updateId: Number.isFinite(Number(payload.updateId)) ? Math.floor(Number(payload.updateId)) : null,
    telegramMessageId: Number.isFinite(Number(payload.telegramMessageId))
      ? Math.floor(Number(payload.telegramMessageId))
      : null,
    sessionScopeId: typeof payload.sessionScopeId === 'string' ? payload.sessionScopeId.trim() || null : null,
    windowKey: typeof payload.windowKey === 'string' ? payload.windowKey.trim() || null : null,
    profile: typeof payload.profile === 'string' ? payload.profile.trim() || null : null,
    defaultChatId: normalizeChatId(payload.defaultChatId),
    lastInboundAtMs: Number.isFinite(Number(payload.lastInboundAtMs))
      ? Math.floor(Number(payload.lastInboundAtMs))
      : null,
  };
}

function buildReplyContextJournalMetadata({ outboundChatId = null, replyContext = null } = {}) {
  const context = (replyContext && typeof replyContext === 'object' && !Array.isArray(replyContext))
    ? replyContext
    : readTelegramReplyContext();
  const contextChatId = normalizeChatId(context?.chatId);
  const normalizedOutboundChatId = normalizeChatId(outboundChatId);
  if (!contextChatId || !normalizedOutboundChatId || contextChatId !== normalizedOutboundChatId) {
    return {};
  }

  const inboundMessageId = typeof context.replyToMessageId === 'string' && context.replyToMessageId.trim()
    ? context.replyToMessageId.trim()
    : (typeof context.inboundMessageId === 'string' && context.inboundMessageId.trim()
      ? context.inboundMessageId.trim()
      : (typeof context.messageId === 'string' && context.messageId.trim() ? context.messageId.trim() : null));
  const metadata = {
    replyContext: 'telegram',
    replyContextChatId: contextChatId,
    replyContextLastInboundAtMs: Number.isFinite(Number(context.lastInboundAtMs))
      ? Math.floor(Number(context.lastInboundAtMs))
      : null,
  };
  if (inboundMessageId) {
    metadata.replyToMessageId = inboundMessageId;
    metadata.inboundMessageId = inboundMessageId;
  }
  if (Number.isFinite(Number(context.updateId))) {
    metadata.telegramUpdateId = Math.floor(Number(context.updateId));
  }
  if (Number.isFinite(Number(context.telegramMessageId))) {
    metadata.inboundTelegramMessageId = Math.floor(Number(context.telegramMessageId));
  }
  if (typeof context.sender === 'string' && context.sender.trim()) {
    metadata.replyContextSender = context.sender.trim();
  }
  if (typeof context.sessionScopeId === 'string' && context.sessionScopeId.trim()) {
    metadata.replyContextSessionScopeId = context.sessionScopeId.trim();
  }
  if (typeof context.windowKey === 'string' && context.windowKey.trim()) {
    metadata.replyContextWindowKey = context.windowKey.trim();
  }
  if (typeof context.profile === 'string' && context.profile.trim()) {
    metadata.replyContextProfile = context.profile.trim();
  }
  return metadata;
}

function resolveReplyContextChatId(config, options = {}) {
  const opts = asObject(options);
  const replyContext = (opts.replyContext && typeof opts.replyContext === 'object' && !Array.isArray(opts.replyContext))
    ? opts.replyContext
    : readTelegramReplyContext();
  const replyChatId = normalizeChatId(replyContext?.chatId);
  if (!replyChatId) return null;

  const defaultChatId = normalizeChatId(replyContext?.defaultChatId) || normalizeChatId(config?.chatId);
  if (defaultChatId && replyChatId === defaultChatId) {
    return null;
  }
  return replyChatId;
}

function resolveOutboundChatId(config, options = {}) {
  const opts = asObject(options);
  // Explicit chat ID from caller always wins.
  const explicit = normalizeChatId(opts.chatId) || normalizeChatId(opts.telegramChatId);
  if (explicit) return explicit;
  // Reply context inheritance is OPT-IN only. Without opts.useReplyContext=true,
  // unsolicited outbound notifications go to the default chat,
  // NOT to whoever last messaged the bot. Prevents cross-user leaks.
  if (opts.useReplyContext === true) {
    const fromContext = resolveReplyContextChatId(config, opts);
    if (fromContext) return fromContext;
  }
  return normalizeChatId(config?.chatId) || null;
}

function isChatAllowed(chatId, allowlist = [], options = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  if (!normalizedChatId) return false;
  if (!Array.isArray(allowlist) || allowlist.length < 1) {
    // Strict installs are sandboxed to their allowlist: losing the list must
    // block every send, not open the door to every chat.
    return options?.strict !== true;
  }
  return allowlist.includes(normalizedChatId);
}

function parseAllowlistStrictFlag(value) {
  if (typeof value !== 'string') return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function getTelegramConfig(env = process.env) {
  const botToken = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = normalizeChatId(env.TELEGRAM_CHAT_ID || '');
  const chatAllowlist = parseChatAllowlist(env.TELEGRAM_CHAT_ALLOWLIST || '');
  const chatAllowlistStrict = parseAllowlistStrictFlag(env.TELEGRAM_CHAT_ALLOWLIST_STRICT);
  return {
    botToken,
    chatId,
    chatAllowlist,
    chatAllowlistStrict,
  };
}

function getMissingConfigKeys(config, options = {}) {
  const missing = [];
  if (!config.botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!resolveOutboundChatId(config, options)) missing.push('TELEGRAM_CHAT_ID');
  return missing;
}

function maybeTruncateTelegramContent(content, maxChars = TELEGRAM_MESSAGE_MAX_CHARS) {
  const text = typeof content === 'string' ? content : String(content ?? '');
  const resolvedMaxChars = Number.isFinite(maxChars) ? Math.max(1, Number(maxChars)) : TELEGRAM_MESSAGE_MAX_CHARS;
  if (text.length <= resolvedMaxChars) {
    return {
      text,
      truncated: false,
      originalLength: text.length,
    };
  }

  const preservedChars = Math.max(0, resolvedMaxChars - TELEGRAM_TRUNCATED_SUFFIX.length);
  return {
    text: `${text.slice(0, preservedChars)}${TELEGRAM_TRUNCATED_SUFFIX}`,
    truncated: true,
    originalLength: text.length,
  };
}

function sanitizeTelegramUserFacingText(content) {
  let text = typeof content === 'string' ? content : String(content ?? '');
  if (!text) return '';

  text = text
    .split(/\r?\n/)
    .filter((line) => !INTERNAL_EGRESS_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .join('\n')
    .trim();

  for (let index = 0; index < 4; index += 1) {
    const next = text.replace(INTERNAL_EGRESS_PREFIX_PATTERN, '').trimStart();
    if (next === text) break;
    text = next;
  }

  return text.trim();
}

function maybeTruncateTelegramMessage(message) {
  return maybeTruncateTelegramContent(sanitizeTelegramUserFacingText(message), TELEGRAM_MESSAGE_MAX_CHARS);
}

function maybeTruncateTelegramCaption(caption) {
  return maybeTruncateTelegramContent(sanitizeTelegramUserFacingText(caption), TELEGRAM_CAPTION_MAX_CHARS);
}

function mergeJournalMetadata(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    Object.assign(merged, source);
  }
  return merged;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneRateLimitTimestamps(nowMs = Date.now()) {
  telegramRateLimiterTimestamps = telegramRateLimiterTimestamps.filter(
    (timestamp) => (nowMs - timestamp) < TELEGRAM_RATE_LIMIT_WINDOW_MS
  );
}

async function reserveRateLimitSlot() {
  while (true) {
    const nowMs = Date.now();
    pruneRateLimitTimestamps(nowMs);
    if (telegramRateLimiterTimestamps.length < TELEGRAM_RATE_LIMIT_MAX_MESSAGES) {
      telegramRateLimiterTimestamps.push(nowMs);
      return 0;
    }
    const oldest = telegramRateLimiterTimestamps[0];
    const waitMs = Math.max(1, TELEGRAM_RATE_LIMIT_WINDOW_MS - (nowMs - oldest));
    await sleep(waitMs);
  }
}

function enqueueRateLimitedSend(sendFn) {
  const run = async () => {
    await reserveRateLimitSlot();
    return sendFn();
  };
  const queued = telegramRateLimiterQueue.then(run, run);
  telegramRateLimiterQueue = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

function resetRateLimiterStateForTests() {
  telegramRateLimiterQueue = Promise.resolve();
  telegramRateLimiterTimestamps = [];
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
  const preparedCaption = maybeTruncateTelegramCaption(caption);
  const config = getTelegramConfig(env);
  const outboundChatId = resolveOutboundChatId(config, opts);
  const replyContextMetadata = buildReplyContextJournalMetadata({
    outboundChatId,
    replyContext: opts.replyContext,
  });

  upsertTelegramJournal({
    messageId,
    sessionId,
    senderRole,
    targetRole,
    sentAtMs: nowMs,
    rawBody: preparedCaption.text ? `[photo] ${preparedCaption.text}` : '[photo]',
    status: 'recorded',
    attempt: 1,
    metadata: mergeJournalMetadata(replyContextMetadata, opts.metadata, {
      source: 'hm-telegram',
      mode: 'photo',
      photoPath: path.resolve(photoPath),
      captionTruncated: preparedCaption.truncated,
      captionOriginalLength: preparedCaption.originalLength,
    }),
  });

  const missing = getMissingConfigKeys(config, { chatId: outboundChatId });
  if (missing.length > 0) {
    upsertTelegramJournal({
      messageId,
      sessionId,
      senderRole,
      targetRole,
      status: 'failed',
      errorCode: 'missing_config',
      metadata: mergeJournalMetadata(opts.metadata, { missing }),
    });
    return { ok: false, error: `Missing required env vars: ${missing.join(', ')}` };
  }
  if (!isChatAllowed(outboundChatId, config.chatAllowlist, { strict: config.chatAllowlistStrict })) {
    upsertTelegramJournal({
      messageId,
      sessionId,
      senderRole,
      targetRole,
      status: 'failed',
      errorCode: 'telegram_chat_not_allowlisted',
      metadata: mergeJournalMetadata(opts.metadata, {
        chatId: outboundChatId,
        allowlistSize: config.chatAllowlist.length,
      }),
    });
    return {
      ok: false,
      error: `Chat ID ${outboundChatId} is not allowlisted`,
    };
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
      metadata: mergeJournalMetadata(opts.metadata, {
        photoPath: resolvedPath,
      }),
    });
    return { ok: false, error: `Photo not found: ${resolvedPath}` };
  }

  const fields = { chat_id: String(outboundChatId) };
  if (preparedCaption.text) fields.caption = preparedCaption.text;

  const apiPath = `/bot${config.botToken}/sendPhoto`;
  const response = await enqueueRateLimitedSend(
    () => requestTelegramMultipart(apiPath, fields, { name: 'photo', path: resolvedPath })
  );

  let payload = null;
  try { payload = JSON.parse(response.body || '{}'); } catch { payload = null; }

  if (response.statusCode >= 200 && response.statusCode < 300 && payload?.ok !== false) {
    const ackMetadata = mergeJournalMetadata(replyContextMetadata, opts.metadata, {
      telegramMessageId: payload?.result?.message_id || null,
      chatId: payload?.result?.chat?.id || outboundChatId,
    });
    upsertTelegramJournal({
      messageId,
      sessionId,
      senderRole,
      targetRole,
      status: 'acked',
      ackStatus: 'telegram_delivered',
      metadata: ackMetadata,
    });
    const durableSatisfaction = reconcileTelegramReplyObligationAfterAck(ackMetadata, {
      dbPath: opts.dbPath || null,
    });
    return {
      ok: true,
      statusCode: response.statusCode,
      messageId: payload?.result?.message_id || null,
      journalMessageId: messageId,
      chatId: payload?.result?.chat?.id || outboundChatId,
      durableSatisfaction,
    };
  }

  upsertTelegramJournal({
    messageId,
    sessionId,
    senderRole,
    targetRole,
    status: 'failed',
    errorCode: String(response.statusCode || 'telegram_request_failed'),
    metadata: mergeJournalMetadata(opts.metadata, {
      statusCode: response.statusCode || 0,
      error: payload?.description || null,
    }),
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
  const preparedMessage = maybeTruncateTelegramMessage(message);
  const config = getTelegramConfig(env);
  const outboundChatId = resolveOutboundChatId(config, opts);
  const replyContextMetadata = buildReplyContextJournalMetadata({
    outboundChatId,
    replyContext: opts.replyContext,
  });

  upsertTelegramJournal({
    messageId,
    sessionId,
    senderRole,
    targetRole,
    sentAtMs: nowMs,
    rawBody: preparedMessage.text,
    status: 'recorded',
    attempt: 1,
    metadata: mergeJournalMetadata(replyContextMetadata, opts.metadata, {
      source: 'hm-telegram',
      mode: 'message',
      messageTruncated: preparedMessage.truncated,
      originalLength: preparedMessage.originalLength,
    }),
  });

  if (!preparedMessage.text) {
    upsertTelegramJournal({
      messageId,
      sessionId,
      senderRole,
      targetRole,
      status: 'failed',
      errorCode: 'telegram_empty_after_sanitization',
      metadata: mergeJournalMetadata(opts.metadata, {
        source: 'hm-telegram',
        mode: 'message',
      }),
    });
    return {
      ok: false,
      error: 'Telegram message empty after user-facing cleanup',
      code: 'telegram_empty_after_sanitization',
    };
  }

  const missing = getMissingConfigKeys(config, { chatId: outboundChatId });
  if (missing.length > 0) {
    upsertTelegramJournal({
      messageId,
      sessionId,
      senderRole,
      targetRole,
      status: 'failed',
      errorCode: 'missing_config',
      metadata: mergeJournalMetadata(opts.metadata, { missing }),
    });
    return {
      ok: false,
      error: `Missing required env vars: ${missing.join(', ')}`,
    };
  }
  if (!isChatAllowed(outboundChatId, config.chatAllowlist, { strict: config.chatAllowlistStrict })) {
    upsertTelegramJournal({
      messageId,
      sessionId,
      senderRole,
      targetRole,
      status: 'failed',
      errorCode: 'telegram_chat_not_allowlisted',
      metadata: mergeJournalMetadata(opts.metadata, {
        chatId: outboundChatId,
        allowlistSize: config.chatAllowlist.length,
      }),
    });
    return {
      ok: false,
      error: `Chat ID ${outboundChatId} is not allowlisted`,
    };
  }

  const body = JSON.stringify({
    chat_id: outboundChatId,
    text: preparedMessage.text,
  });
  const apiPath = `/bot${config.botToken}/sendMessage`;

  const response = await enqueueRateLimitedSend(() => requestTelegram(apiPath, body));
  let payload = null;
  try {
    payload = JSON.parse(response.body || '{}');
  } catch {
    payload = null;
  }

  if (response.statusCode >= 200 && response.statusCode < 300 && payload?.ok !== false) {
    const ackMetadata = mergeJournalMetadata(replyContextMetadata, opts.metadata, {
      telegramMessageId: payload?.result?.message_id || null,
      chatId: payload?.result?.chat?.id || outboundChatId,
    });
    upsertTelegramJournal({
      messageId,
      sessionId,
      senderRole,
      targetRole,
      status: 'acked',
      ackStatus: 'telegram_delivered',
      metadata: ackMetadata,
    });
    const durableSatisfaction = reconcileTelegramReplyObligationAfterAck(ackMetadata, {
      dbPath: opts.dbPath || null,
    });
    return {
      ok: true,
      statusCode: response.statusCode,
      messageId: payload?.result?.message_id || null,
      journalMessageId: messageId,
      chatId: payload?.result?.chat?.id || outboundChatId,
      durableSatisfaction,
    };
  }

  upsertTelegramJournal({
    messageId,
    sessionId,
    senderRole,
    targetRole,
    status: 'failed',
    errorCode: String(response.statusCode || 'telegram_request_failed'),
    metadata: mergeJournalMetadata(opts.metadata, {
      statusCode: response.statusCode || 0,
      error: payload?.description || payload?.message || payload?.detail || null,
    }),
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

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(`[hm-telegram] ${parsed.error}`);
    process.exit(1);
  }

  let message = '';
  try {
    message = readParsedMessageInput(parsed);
  } catch (err) {
    closeCommsJournalStores();
    console.error(`[hm-telegram] Message input failed: ${err.message}`);
    process.exit(1);
  }

  if (parsed.photoPath) {
    const result = await sendTelegramPhoto(parsed.photoPath, message, env, { chatId: parsed.chatId });
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

  if (!message) {
    console.error('[hm-telegram] Message cannot be empty');
    process.exit(1);
  }

  const result = await sendTelegram(message, env, { chatId: parsed.chatId });
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
  parseCliArgs,
  parseMessage,
  getTelegramConfig,
  getMissingConfigKeys,
  requestTelegram,
  requestTelegramMultipart,
  sendTelegram,
  sendTelegramPhoto,
  normalizeChatId,
  parseChatAllowlist,
  readTelegramReplyContext,
  buildReplyContextJournalMetadata,
  getReplyObligationInboundMessageId,
  reconcileTelegramReplyObligationAfterAck,
  resolveReplyContextChatId,
  resolveOutboundChatId,
  isChatAllowed,
  sanitizeTelegramUserFacingText,
  maybeTruncateTelegramMessage,
  maybeTruncateTelegramCaption,
  resetRateLimiterStateForTests,
  main,
};
