'use strict';

const {
  getTrustQuoteArmPaneIds,
} = require('./trustquote-arm-specs');

const TRUSTQUOTE_ARM_PANE_IDS = Object.freeze(Array.from(new Set(
  getTrustQuoteArmPaneIds()
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
)));

function toText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function isTrustQuotePaneId(value) {
  return TRUSTQUOTE_ARM_PANE_IDS.includes(toText(value, '').toLowerCase());
}

function filterTerminalsForWorkspace(terminals = [], workspaceKey = 'main') {
  const list = Array.isArray(terminals) ? terminals : [];
  const key = toText(workspaceKey, 'main').toLowerCase();
  if (key === 'squid-room') return list;
  return list.filter((term) => !isTrustQuotePaneId(term?.paneId || term?.terminalPaneId || term?.id));
}

module.exports = {
  TRUSTQUOTE_ARM_PANE_IDS,
  filterTerminalsForWorkspace,
  isTrustQuotePaneId,
};
