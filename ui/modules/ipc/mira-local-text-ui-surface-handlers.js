'use strict';

const { getProjectRoot } = require('../../config');
const {
  LOCAL_TEXT_UI_CHANNEL,
  buildMiraLocalTextUiSurface,
} = require('../mira-local-text-ui-surface');
const {
  APPROVAL_SEND_CHANNEL,
  executeMiraInternalHandoffApprovalSendV0,
} = require('../mira-core/live-internal-handoff-approval-v0');

async function buildMiraLocalTextUiSurfaceResponse(payload = {}, options = {}) {
  return buildMiraLocalTextUiSurface(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

function normalizeTrustedMetadata(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = String(value.sessionId || value.session_id || '').trim();
  const profileName = String(value.profileName || value.profile_name || '').trim();
  const windowKey = String(value.windowKey || value.window_key || '').trim();
  const sourceScope = String(value.sourceScope || value.source_scope || '').trim();
  if (!sessionId || !profileName || !windowKey || !sourceScope) return null;
  return { sessionId, profileName, windowKey, sourceScope };
}

function trustedMetadataFromMainWindowEvent(event = {}, ctx = {}, deps = {}) {
  if (typeof deps.getTrustedMiraApprovalMetadata === 'function') {
    return normalizeTrustedMetadata(deps.getTrustedMiraApprovalMetadata(event));
  }
  const senderId = event?.sender?.id;
  const mainWindowSenderId = ctx?.mainWindow?.webContents?.id;
  if (senderId && mainWindowSenderId && senderId === mainWindowSenderId) {
    return normalizeTrustedMetadata({
      sessionId: typeof deps.getSessionId === 'function' ? deps.getSessionId() : deps.sessionId,
      profileName: deps.profileName || 'main',
      windowKey: 'main',
      sourceScope: 'main',
    });
  }
  return null;
}

function isAcceptedSendAgentMessageResult(result) {
  if (result === true) return true;
  if (!result || typeof result !== 'object') return false;
  return result.ok === true
    || result.success === true
    || result.accepted === true
    || result.queued === true;
}

function buildInternalHandoffSendAdapter(options = {}) {
  if (typeof options.sendInternalMessage === 'function') return options.sendInternalMessage;
  if (typeof options.sendAgentMessage !== 'function') return null;
  return async (target, body, metadata = {}) => {
    const result = await options.sendAgentMessage(target, body, {
      ...metadata,
      senderRole: 'mira',
      source: 'mira-internal-handoff-approval',
    });
    const ok = isAcceptedSendAgentMessageResult(result);
    return {
      ok,
      status: ok ? 'sent' : (result?.status || 'send_failed'),
      transport: 'sendAgentMessage',
      result,
    };
  };
}

async function buildMiraInternalHandoffApprovalSendResponse(payload = {}, options = {}, event = null) {
  const trustedMetadata = options.trustedMetadata
    ? normalizeTrustedMetadata(options.trustedMetadata)
    : trustedMetadataFromMainWindowEvent(event, options.ctx || {}, options);
  const sendInternalMessage = buildInternalHandoffSendAdapter(options);
  return executeMiraInternalHandoffApprovalSendV0(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
    trustedMetadata,
    requireTrustedMetadata: true,
    sendInternalMessage,
  });
}

function registerMiraLocalTextUiSurfaceHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMiraLocalTextUiSurfaceHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;
  ipcMain.handle(LOCAL_TEXT_UI_CHANNEL, (_event, payload = {}) =>
    buildMiraLocalTextUiSurfaceResponse(payload, deps));
  ipcMain.handle(APPROVAL_SEND_CHANNEL, (event, payload = {}) =>
    buildMiraInternalHandoffApprovalSendResponse(payload, { ...deps, ctx }, event));
}

function unregisterMiraLocalTextUiSurfaceHandlers(ctx) {
  const ipcMain = ctx && ctx.ipcMain;
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler(LOCAL_TEXT_UI_CHANNEL);
  ipcMain.removeHandler(APPROVAL_SEND_CHANNEL);
}

registerMiraLocalTextUiSurfaceHandlers.unregister = unregisterMiraLocalTextUiSurfaceHandlers;

module.exports = {
  APPROVAL_SEND_CHANNEL,
  LOCAL_TEXT_UI_CHANNEL,
  buildInternalHandoffSendAdapter,
  buildMiraInternalHandoffApprovalSendResponse,
  buildMiraLocalTextUiSurfaceResponse,
  isAcceptedSendAgentMessageResult,
  trustedMetadataFromMainWindowEvent,
  registerMiraLocalTextUiSurfaceHandlers,
  unregisterMiraLocalTextUiSurfaceHandlers,
};
