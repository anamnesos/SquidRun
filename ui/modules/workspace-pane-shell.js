'use strict';

const {
  TRUSTQUOTE_PANE_IDS,
  isTrustQuoteWorkspace,
} = require('./work-room-terminal-visibility');

const SQUID_ROOM_WORKSPACE_KEY = 'squid-room';
const SQUID_ROOM_PANE_IDS = Object.freeze(['2', '3']);
const TRUSTQUOTE_PANES = Object.freeze([
  { sourcePaneId: '2', paneId: TRUSTQUOTE_PANE_IDS[0], label: 'TrustQuote Builder' },
  { sourcePaneId: '3', paneId: TRUSTQUOTE_PANE_IDS[1], label: 'TrustQuote Oracle' },
]);
const TRUSTQUOTE_PROJECT_PATH = 'D:\\projects\\TrustQuote';

function getDocument(doc) {
  if (doc && typeof doc.querySelector === 'function') return doc;
  if (typeof document !== 'undefined') return document;
  return null;
}

function setPaneTitleLabel(pane, label) {
  const title = pane?.querySelector?.('.pane-title');
  if (!title) return;

  let labelNode = title.querySelector('.workspace-pane-label');
  if (!labelNode) {
    labelNode = title.ownerDocument.createElement('span');
    labelNode.className = 'workspace-pane-label';
    const infoButton = title.querySelector('.pane-role-info-btn');
    if (infoButton) {
      title.insertBefore(labelNode, infoButton);
    } else {
      title.appendChild(labelNode);
    }
  }
  labelNode.textContent = label;

  for (const node of Array.from(title.childNodes)) {
    if (node.nodeType === 3 && node.textContent.trim()) {
      node.textContent = '';
    }
  }
}

function retargetPaneIds(pane, sourcePaneId, paneId) {
  pane.dataset.workspaceSourcePaneId = sourcePaneId;
  pane.dataset.paneId = paneId;

  pane.querySelectorAll('[id]').forEach((element) => {
    const id = String(element.id || '');
    const suffix = `-${sourcePaneId}`;
    if (id.endsWith(suffix)) {
      element.id = `${id.slice(0, -suffix.length)}-${paneId}`;
    }
  });

  pane.querySelectorAll('[data-pane-id]').forEach((element) => {
    element.dataset.paneId = paneId;
  });
}

function setElementHidden(element, hidden) {
  if (!element) return;
  element.hidden = Boolean(hidden);
  if (hidden) {
    element.setAttribute?.('aria-hidden', 'true');
    element.classList?.add?.('workspace-hidden-pane');
  } else {
    element.removeAttribute?.('aria-hidden');
    element.classList?.remove?.('workspace-hidden-pane');
  }
}

function isSquidRoomWorkspace(value) {
  return String(value || '').trim().toLowerCase() === SQUID_ROOM_WORKSPACE_KEY;
}

function configureTrustQuotePaneShell(doc) {
  const body = doc.body;
  if (body) {
    body.dataset.workspaceKey = 'trustquote';
    body.classList.remove('squid-room-workspace');
    body.classList.add('trustquote-workspace');
  }

  const projectPath = doc.getElementById?.('projectPath') || doc.querySelector?.('#projectPath');
  if (projectPath) {
    projectPath.textContent = TRUSTQUOTE_PROJECT_PATH;
    projectPath.classList?.remove?.('no-project');
  }
  const projectIndicator = doc.querySelector?.('.project-indicator');
  if (projectIndicator) {
    projectIndicator.title = `Current workspace folder: ${TRUSTQUOTE_PROJECT_PATH}`;
  }

  const mainPane = doc.querySelector('.pane[data-pane-id="1"], .pane[data-workspace-source-pane-id="1"]');
  if (mainPane) {
    setElementHidden(mainPane, true);
  }

  for (const spec of TRUSTQUOTE_PANES) {
    const pane = doc.querySelector(`.pane[data-workspace-source-pane-id="${spec.sourcePaneId}"], .pane[data-pane-id="${spec.sourcePaneId}"], .pane[data-pane-id="${spec.paneId}"]`);
    if (!pane) continue;
    setElementHidden(pane, false);
    retargetPaneIds(pane, spec.sourcePaneId, spec.paneId);
    setPaneTitleLabel(pane, spec.label);
  }

  return {
    workspaceKey: 'trustquote',
    paneIds: TRUSTQUOTE_PANE_IDS.slice(),
  };
}

function configureSquidRoomPaneShell(doc) {
  const body = doc.body;
  if (body) {
    body.dataset.workspaceKey = SQUID_ROOM_WORKSPACE_KEY;
    body.classList.remove('trustquote-workspace');
    body.classList.add('squid-room-workspace');
  }

  const mainPane = doc.querySelector('.pane[data-pane-id="1"], .pane[data-workspace-source-pane-id="1"]');
  setElementHidden(mainPane, true);

  const commandBar = doc.querySelector('.command-bar');
  setElementHidden(commandBar, true);

  const miraLiveReply = doc.querySelector('#miraLiveReply');
  setElementHidden(miraLiveReply, true);

  for (const paneId of SQUID_ROOM_PANE_IDS) {
    const pane = doc.querySelector(`.pane[data-pane-id="${paneId}"]`);
    setElementHidden(pane, false);
    const terminal = doc.querySelector(`#terminal-${paneId}`);
    if (terminal) {
      terminal.hidden = true;
      terminal.setAttribute?.('aria-hidden', 'true');
      terminal.classList?.add?.('squid-room-terminal-hidden');
    }
  }

  const surface = doc.querySelector('#squidRoomSurface');
  if (surface) {
    surface.hidden = false;
    surface.removeAttribute?.('aria-hidden');
  }

  return {
    workspaceKey: SQUID_ROOM_WORKSPACE_KEY,
    paneIds: SQUID_ROOM_PANE_IDS.slice(),
    displayOnly: true,
  };
}

function configureWorkspacePaneShell(windowContext = {}, terminal = null, doc = null) {
  const resolvedDocument = getDocument(doc);
  if (!resolvedDocument) {
    return { workspaceKey: 'main', paneIds: [] };
  }

  const workspaceKey = windowContext?.windowKey || windowContext?.profileName || 'main';
  let result = { workspaceKey: 'main', paneIds: null };
  if (isTrustQuoteWorkspace(workspaceKey)) {
    result = configureTrustQuotePaneShell(resolvedDocument);
  } else if (isSquidRoomWorkspace(workspaceKey)) {
    result = configureSquidRoomPaneShell(resolvedDocument);
  } else if (resolvedDocument.body) {
    resolvedDocument.body.classList.remove('trustquote-workspace');
    resolvedDocument.body.classList.remove('squid-room-workspace');
  }

  if (terminal && typeof terminal.setActivePaneIds === 'function') {
    terminal.setActivePaneIds(result.paneIds || null);
  }

  return result;
}

module.exports = {
  SQUID_ROOM_WORKSPACE_KEY,
  SQUID_ROOM_PANE_IDS,
  TRUSTQUOTE_PROJECT_PATH,
  TRUSTQUOTE_PANES,
  configureWorkspacePaneShell,
};
