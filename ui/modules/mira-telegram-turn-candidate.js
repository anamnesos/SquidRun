'use strict';

const { createHash } = require('crypto');

const { normalizeChatId } = require('../scripts/hm-telegram');
const {
  resolveTelegramInboundRoute,
} = require('../scripts/hm-telegram-routing');

const AGENT_MESSAGE_PREFIX = '[AGENT MSG - reply via hm-send.js] ';
const CANDIDATE_PROTOCOL = 'squidrun.mira.telegram_turn_candidate.v0';

function toNonEmptyString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function isTelegramAgentOpsOrCommandText(value) {
  const text = toNonEmptyString(value);
  if (!text) return false;
  if (text.startsWith(AGENT_MESSAGE_PREFIX)) return true;
  if (/^\/\S+/.test(text)) return true;
  if (/^\((?:ARCHITECT|ARCH|BUILDER|BUILD|ORACLE)\s+#\d+\)\s*:/i.test(text)) return true;
  if (/^(?:architect|builder|oracle)\s*:/i.test(text)) return true;
  return false;
}

function hasTelegramMedia({ archivePath = null, media = null, photo = null, document = null, metadata = {} } = {}) {
  if (toNonEmptyString(archivePath)) return true;
  if (media && typeof media === 'object') return true;
  if (photo && typeof photo === 'object') return true;
  if (document && typeof document === 'object') return true;
  if (metadata?.media && typeof metadata.media === 'object') return true;
  if (metadata?.photo && typeof metadata.photo === 'object') return true;
  if (metadata?.document && typeof metadata.document === 'object') return true;
  return false;
}

function stableFallbackMessageId({ chatId, text, sender }) {
  const digest = createHash('sha1')
    .update(`${chatId || 'missing'}\n${sender || 'unknown'}\n${text || ''}`)
    .digest('hex')
    .slice(0, 12);
  return `telegram-in-dry-run-${digest}`;
}

function deriveInboundMessageId({ inboundMessageId = null, metadata = {}, chatId = null, text = '', sender = 'unknown' } = {}) {
  const explicit = toNonEmptyString(inboundMessageId);
  if (explicit) return explicit;
  const updateId = Number.isFinite(Number(metadata?.updateId)) ? Math.floor(Number(metadata.updateId)) : null;
  if (updateId !== null) return `telegram-in-${updateId}`;
  const telegramMessageId = Number.isFinite(Number(metadata?.messageId)) ? Math.floor(Number(metadata.messageId)) : null;
  if (telegramMessageId !== null) return `telegram-in-msg-${telegramMessageId}`;
  return stableFallbackMessageId({ chatId, text, sender });
}

function blocked(reason, details = {}) {
  return {
    ok: false,
    protocol: CANDIDATE_PROTOCOL,
    status: 'new_mira_telegram_candidate_blocked',
    reason,
    dryRun: true,
    ...details,
  };
}

function buildNewMiraTelegramTurnCandidate({
  body = '',
  sender = 'unknown',
  metadata = {},
  inboundRoute = null,
  inboundMessageId = null,
  inboundSessionScopeId = null,
  archivePath = null,
  media = null,
  photo = null,
  document = null,
  env = process.env,
  sessionId = null,
} = {}) {
  const text = toNonEmptyString(body);
  if (!text) return blocked('telegram_text_required');

  const route = inboundRoute || resolveTelegramInboundRoute({
    chatId: metadata?.chatId,
    env,
  });
  if (!route?.ok) {
    return blocked('telegram_inbound_route_blocked', {
      routeReason: route?.reason || 'unknown',
      chatId: normalizeChatId(route?.chatId || metadata?.chatId),
    });
  }

  const windowKey = toNonEmptyString(route.windowKey) || 'main';
  const profile = toNonEmptyString(route.profile) || windowKey;
  const chatId = normalizeChatId(route.chatId || metadata?.chatId);
  if (windowKey !== 'main' || profile !== 'main') {
    return blocked('telegram_inbound_route_not_main_owner', {
      routeReason: route.reason || null,
      chatId,
      windowKey,
      profile,
    });
  }
  if (!chatId || route.reason !== 'owner_chat') {
    return blocked('telegram_owner_chat_required', {
      routeReason: route.reason || null,
      chatId,
      windowKey,
      profile,
    });
  }

  if (hasTelegramMedia({ archivePath, media, photo, document, metadata })) {
    return blocked('telegram_media_excluded', {
      chatId,
      windowKey,
      profile,
    });
  }

  if (isTelegramAgentOpsOrCommandText(text)) {
    return blocked('telegram_agent_ops_or_command_excluded', {
      chatId,
      windowKey,
      profile,
    });
  }

  const resolvedSessionId = toNonEmptyString(inboundSessionScopeId)
    || toNonEmptyString(sessionId)
    || 'app-session-main';
  const messageId = deriveInboundMessageId({
    inboundMessageId,
    metadata,
    chatId,
    text,
    sender,
  });

  return {
    ok: true,
    protocol: CANDIDATE_PROTOCOL,
    status: 'new_mira_telegram_turn_candidate_ready',
    dryRun: true,
    source: 'squidrun-telegram-main-owner-text',
    route: {
      currentOwner: 'squidrun-telegram-guard-stack',
      reason: route.reason || null,
      chatId,
      windowKey,
      profile,
      routeOwnerChange: false,
      liveRouteChanged: false,
    },
    candidate: {
      endpoint: '/turn',
      method: 'POST',
      body: {
        text,
        sessionId: resolvedSessionId,
        messageId,
        requestId: `${messageId}-new-mira-dry-run`,
        useModel: false,
      },
    },
    sideEffects: {
      telegramSendFunctionCall: false,
      liveTelegramSend: false,
      routeOwnerChange: false,
      runtimeExecutes: false,
      runtimeActions: false,
      toolsEnabled: false,
      sendsEnabled: false,
      store: false,
      modelInvoked: false,
      modelProviderCall: false,
      telegramRouteControl: false,
      uiSurfaceControl: false,
    },
  };
}

module.exports = {
  CANDIDATE_PROTOCOL,
  buildNewMiraTelegramTurnCandidate,
  hasTelegramMedia,
  isTelegramAgentOpsOrCommandText,
};
