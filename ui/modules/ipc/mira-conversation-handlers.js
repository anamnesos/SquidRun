'use strict';

const { getProjectRoot } = require('../../config');
const {
  MIRA_CONVERSATION_REPLY_CHANNEL,
  MIRA_SELF_DIRECTION_CHANNEL,
  MIRA_SELF_DIRECTION_LIST_CHANNEL,
  MIRA_SELF_DIRECTION_REVIEW_CHANNEL,
  buildMiraConversationReply,
  buildMiraSelfDirectionProposal,
  listMiraSelfDirectionProposals,
  reviewMiraSelfDirectionProposal,
} = require('../mira-conversation-engine');

async function buildMiraConversationReplyResponse(payload = {}, options = {}) {
  return buildMiraConversationReply(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

async function buildMiraSelfDirectionProposalResponse(payload = {}, options = {}) {
  return buildMiraSelfDirectionProposal(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

function listMiraSelfDirectionProposalsResponse(payload = {}, options = {}) {
  return listMiraSelfDirectionProposals(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

async function reviewMiraSelfDirectionProposalResponse(payload = {}, options = {}) {
  return reviewMiraSelfDirectionProposal(payload, {
    ...options,
    projectRoot: options.projectRoot || getProjectRoot(),
  });
}

function registerMiraConversationHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerMiraConversationHandlers requires ctx.ipcMain');
  }
  const ipcMain = ctx.ipcMain;
  ipcMain.handle(MIRA_CONVERSATION_REPLY_CHANNEL, (_event, payload = {}) =>
    buildMiraConversationReplyResponse(payload, deps));
  ipcMain.handle(MIRA_SELF_DIRECTION_CHANNEL, (_event, payload = {}) =>
    buildMiraSelfDirectionProposalResponse(payload, deps));
  ipcMain.handle(MIRA_SELF_DIRECTION_LIST_CHANNEL, (_event, payload = {}) =>
    listMiraSelfDirectionProposalsResponse(payload, deps));
  ipcMain.handle(MIRA_SELF_DIRECTION_REVIEW_CHANNEL, (_event, payload = {}) =>
    reviewMiraSelfDirectionProposalResponse(payload, deps));
}

function unregisterMiraConversationHandlers(ctx) {
  const ipcMain = ctx && ctx.ipcMain;
  if (!ipcMain || typeof ipcMain.removeHandler !== 'function') return;
  ipcMain.removeHandler(MIRA_CONVERSATION_REPLY_CHANNEL);
  ipcMain.removeHandler(MIRA_SELF_DIRECTION_CHANNEL);
  ipcMain.removeHandler(MIRA_SELF_DIRECTION_LIST_CHANNEL);
  ipcMain.removeHandler(MIRA_SELF_DIRECTION_REVIEW_CHANNEL);
}

registerMiraConversationHandlers.unregister = unregisterMiraConversationHandlers;

module.exports = {
  MIRA_CONVERSATION_REPLY_CHANNEL,
  MIRA_SELF_DIRECTION_CHANNEL,
  MIRA_SELF_DIRECTION_LIST_CHANNEL,
  MIRA_SELF_DIRECTION_REVIEW_CHANNEL,
  buildMiraConversationReplyResponse,
  buildMiraSelfDirectionProposalResponse,
  listMiraSelfDirectionProposalsResponse,
  registerMiraConversationHandlers,
  reviewMiraSelfDirectionProposalResponse,
  unregisterMiraConversationHandlers,
};
