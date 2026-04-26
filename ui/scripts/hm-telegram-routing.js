const fs = require('fs');
const path = require('path');
const { resolveCoordPath } = require('../config');
const { EUNBYEOL_CHAT_ID, getActiveProfileName } = require('../profile');
const { sendTelegram, normalizeChatId } = require('./hm-telegram');

const TELEGRAM_ROUTING_RELATIVE_PATH = path.join('runtime', 'telegram-routing.json');
const TELEGRAM_LONG_MESSAGE_MAX_CHARS = 4000;

const DEFAULT_TELEGRAM_ROUTING = Object.freeze({
  '8754356993': {
    method: 'send-long-telegram',
    name: 'Eunbyeol',
    language: 'ko',
  },
  default: {
    method: 'hm-send-telegram',
    name: 'James',
    language: 'en',
  },
});

function cloneRoute(route = {}) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return null;
  const method = typeof route.method === 'string' ? route.method.trim().toLowerCase() : '';
  if (!method) return null;
  return {
    method,
    name: typeof route.name === 'string' && route.name.trim() ? route.name.trim() : null,
    language: typeof route.language === 'string' && route.language.trim() ? route.language.trim().toLowerCase() : null,
  };
}

function getTelegramRoutingPath() {
  try {
    return resolveCoordPath(TELEGRAM_ROUTING_RELATIVE_PATH, { forWrite: true });
  } catch (_) {
    return null;
  }
}

function buildDefaultTelegramRouting() {
  return JSON.parse(JSON.stringify(DEFAULT_TELEGRAM_ROUTING));
}

function readTelegramRoutingConfig() {
  const routingPath = getTelegramRoutingPath();
  const fallback = buildDefaultTelegramRouting();
  if (!routingPath || !fs.existsSync(routingPath)) {
    return {
      routingPath,
      routes: fallback,
      source: 'default',
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(routingPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        routingPath,
        routes: fallback,
        source: 'default_invalid',
      };
    }

    const routes = {};
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
      const normalizedRoute = cloneRoute(rawValue);
      if (!normalizedRoute) continue;
      const normalizedKey = rawKey === 'default' ? 'default' : normalizeChatId(rawKey);
      if (!normalizedKey) continue;
      routes[normalizedKey] = normalizedRoute;
    }

    const defaultRoute = cloneRoute(routes.default) || cloneRoute(fallback.default);
    if (defaultRoute) routes.default = defaultRoute;

    for (const [chatId, route] of Object.entries(fallback)) {
      if (chatId === 'default') continue;
      if (!routes[chatId]) {
        const normalized = cloneRoute(route);
        if (normalized) routes[chatId] = normalized;
      }
    }

    return {
      routingPath,
      routes,
      source: 'file',
    };
  } catch (_) {
    return {
      routingPath,
      routes: fallback,
      source: 'default_parse_error',
    };
  }
}

function getProfileDefaultRouteKey(env = process.env) {
  return getActiveProfileName(env) === 'eunbyeol' ? EUNBYEOL_CHAT_ID : 'default';
}

function resolveTelegramRoute({ chatId = null, env = process.env } = {}) {
  const normalizedChatId = normalizeChatId(chatId);
  const { routes, routingPath, source } = readTelegramRoutingConfig();
  const defaultRouteKey = getProfileDefaultRouteKey(env);
  const route = cloneRoute(
    (normalizedChatId && routes[normalizedChatId])
      ? routes[normalizedChatId]
      : (routes[defaultRouteKey] || routes.default)
  ) || cloneRoute(DEFAULT_TELEGRAM_ROUTING.default);

  return {
    chatId: normalizedChatId,
    route,
    routingPath,
    source,
  };
}

function splitLongTelegramMessage(message, maxChars = TELEGRAM_LONG_MESSAGE_MAX_CHARS) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return [];

  const limit = Number.isFinite(Number(maxChars))
    ? Math.max(1, Math.floor(Number(maxChars)))
    : TELEGRAM_LONG_MESSAGE_MAX_CHARS;

  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitIndex = remaining.lastIndexOf('\n\n', limit);
    if (splitIndex < Math.floor(limit * 0.5)) splitIndex = remaining.lastIndexOf('\n', limit);
    if (splitIndex < Math.floor(limit * 0.5)) splitIndex = limit;
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendLongTelegramMessage(message, env = process.env, options = {}) {
  const chunks = splitLongTelegramMessage(message);
  if (chunks.length === 0) {
    return {
      ok: false,
      error: 'empty_message',
      method: 'send-long-telegram',
      chunkCount: 0,
    };
  }

  let lastResult = null;
  for (let index = 0; index < chunks.length; index += 1) {
    const baseMessageId = typeof options.messageId === 'string' && options.messageId.trim()
      ? options.messageId.trim()
      : null;
    lastResult = await sendTelegram(chunks[index], env, {
      ...options,
      messageId: baseMessageId
        ? `${baseMessageId}-part${index + 1}`
        : null,
      metadata: {
        ...(options.metadata || {}),
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        routeMethod: 'send-long-telegram',
      },
    });
    if (!lastResult?.ok) {
      return {
        ...lastResult,
        ok: false,
        method: 'send-long-telegram',
        chunkCount: chunks.length,
        failedChunkIndex: index + 1,
      };
    }
  }

  return {
    ...lastResult,
    ok: true,
    method: 'send-long-telegram',
    chunkCount: chunks.length,
  };
}

async function sendRoutedTelegramMessage(message, env = process.env, options = {}) {
  const normalizedChatId = normalizeChatId(options.chatId);
  const resolved = resolveTelegramRoute({ chatId: normalizedChatId, env });
  const route = resolved.route || cloneRoute(DEFAULT_TELEGRAM_ROUTING.default);
  const dispatchOptions = {
    ...options,
    chatId: normalizedChatId,
    metadata: {
      ...(options.metadata || {}),
      routingSource: resolved.source,
      routingPath: resolved.routingPath,
      routeMethod: route?.method || 'hm-send-telegram',
      routeName: route?.name || null,
      routeLanguage: route?.language || null,
    },
  };

  if (route?.method === 'send-long-telegram') {
    const result = await sendLongTelegramMessage(message, env, dispatchOptions);
    return {
      ...result,
      route,
      routedChatId: normalizedChatId,
    };
  }

  const result = await sendTelegram(message, env, dispatchOptions);
  return {
    ...result,
    method: route?.method || 'hm-send-telegram',
    route,
    routedChatId: normalizedChatId,
  };
}

module.exports = {
  DEFAULT_TELEGRAM_ROUTING,
  TELEGRAM_ROUTING_RELATIVE_PATH,
  TELEGRAM_LONG_MESSAGE_MAX_CHARS,
  buildDefaultTelegramRouting,
  getTelegramRoutingPath,
  readTelegramRoutingConfig,
  resolveTelegramRoute,
  splitLongTelegramMessage,
  sendLongTelegramMessage,
  sendRoutedTelegramMessage,
};
