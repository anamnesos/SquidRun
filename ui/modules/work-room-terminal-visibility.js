'use strict';

const TRUSTQUOTE_WORKSPACE_KEY = 'trustquote';
const TRUSTQUOTE_PANE_IDS = Object.freeze(['trustquote-builder', 'trustquote-oracle']);

function toText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeWorkspaceKey(value) {
  return toText(value, 'main').toLowerCase();
}

function isTrustQuoteWorkspace(value) {
  return normalizeWorkspaceKey(value) === TRUSTQUOTE_WORKSPACE_KEY;
}

function isWorkRoomRouteOwnerTerminal(value) {
  if (!value || typeof value !== 'object') return false;
  return value.workRoomRouteOwner === true
    || Boolean(value.routeOwner && value.roomId);
}

function isTrustQuotePaneId(value) {
  return TRUSTQUOTE_PANE_IDS.includes(toText(value, '').toLowerCase());
}

function isTrustQuoteWorkRoomTerminal(value) {
  if (!value || typeof value !== 'object') return false;
  const paneId = toText(value.paneId || value.terminalPaneId, '').toLowerCase();
  const roomId = toText(value.roomId, '').toLowerCase();
  const profileName = toText(value.profileName, '').toLowerCase();
  const windowKey = toText(value.windowKey, '').toLowerCase();
  return isTrustQuotePaneId(paneId)
    || (isWorkRoomRouteOwnerTerminal(value) && (
      roomId === TRUSTQUOTE_WORKSPACE_KEY
      || profileName === TRUSTQUOTE_WORKSPACE_KEY
      || windowKey === TRUSTQUOTE_WORKSPACE_KEY
    ));
}

function filterTerminalsForWorkspace(terminals = [], workspaceKey = 'main') {
  if (!Array.isArray(terminals)) return [];
  if (isTrustQuoteWorkspace(workspaceKey)) {
    return terminals.filter(isTrustQuoteWorkRoomTerminal);
  }
  return terminals.filter((term) => !isTrustQuoteWorkRoomTerminal(term));
}

module.exports = {
  TRUSTQUOTE_WORKSPACE_KEY,
  TRUSTQUOTE_PANE_IDS,
  normalizeWorkspaceKey,
  isTrustQuoteWorkspace,
  isTrustQuotePaneId,
  isWorkRoomRouteOwnerTerminal,
  isTrustQuoteWorkRoomTerminal,
  filterTerminalsForWorkspace,
};
