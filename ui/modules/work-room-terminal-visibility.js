'use strict';

const {
  getExampleAppArmPaneIds,
} = require('./exampleapp-arm-specs');

const EXAMPLEAPP_ARM_PANE_IDS = Object.freeze(Array.from(new Set(
  getExampleAppArmPaneIds()
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
)));

function toText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function isExampleAppPaneId(value) {
  return EXAMPLEAPP_ARM_PANE_IDS.includes(toText(value, '').toLowerCase());
}

function filterTerminalsForWorkspace(terminals = [], workspaceKey = 'main') {
  const list = Array.isArray(terminals) ? terminals : [];
  const key = toText(workspaceKey, 'main').toLowerCase();
  if (key === 'squid-room') return list;
  return list.filter((term) => !isExampleAppPaneId(term?.paneId || term?.terminalPaneId || term?.id));
}

module.exports = {
  EXAMPLEAPP_ARM_PANE_IDS,
  filterTerminalsForWorkspace,
  isExampleAppPaneId,
};
