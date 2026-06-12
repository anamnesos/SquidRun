'use strict';

const {
  TRUSTQUOTE_PANE_IDS,
  isTrustQuoteWorkspace,
} = require('./work-room-terminal-visibility');
const {
  TRUSTQUOTE_PROJECT_PATH,
  getTrustQuoteDayToDayArmSpecs,
} = require('./trustquote-arm-specs');
const {
  applyWindowChrome,
  resolveWindowChromeClass,
} = require('./window-chrome');
const rendererSettings = require('./settings');
const {
  CLAUDE_MODEL_SELECTOR_OPTIONS,
  selectorValueForCommand,
} = require('./claude-model-options');

const SQUID_ROOM_WORKSPACE_KEY = 'squid-room';
const SQUID_ROOM_TEAM_PANE_IDS = Object.freeze(['2', '3']);
const SQUID_ROOM_PET_PANE_SPECS = Object.freeze([
  {
    paneId: '2',
    petId: 'builder',
    assetRef: 'builder-squid',
    title: 'Builder',
    role: 'Builder',
    state: 'running',
    stateLabel: 'Working',
    bubble: 'Working the active fix.',
  },
  {
    paneId: '3',
    petId: 'oracle',
    assetRef: 'oracle-squid',
    title: 'Oracle',
    role: 'Oracle',
    state: 'review',
    stateLabel: 'Reviewing',
    bubble: 'Checking the proof.',
  },
]);
const TRUSTQUOTE_PANES = Object.freeze([
  { sourcePaneId: '2', paneId: TRUSTQUOTE_PANE_IDS[0], label: 'TrustQuote Builder' },
  { sourcePaneId: '3', paneId: TRUSTQUOTE_PANE_IDS[1], label: 'TrustQuote Oracle' },
]);
const PANE_ICON_SVGS = Object.freeze({
  avatar: '<svg class="avatar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
  info: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  interrupt: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>',
  enter: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>',
  restart: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  expand: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
  lock: '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
});
const SQUID_ROOM_TRUSTQUOTE_ARM_PANES = Object.freeze(getTrustQuoteDayToDayArmSpecs().map((spec) => Object.freeze({
  paneId: spec.paneId,
  label: spec.label,
  role: spec.roleLabel,
  roleId: spec.role,
  routeTarget: spec.routeTarget,
  commandSourcePaneId: spec.commandSourcePaneId,
  workingDir: spec.workingDir,
  command: spec.command,
  startupMessage: spec.startupMessage,
})));
const SQUID_ROOM_PANE_IDS = Object.freeze([
  ...SQUID_ROOM_TRUSTQUOTE_ARM_PANES.map((pane) => pane.paneId),
]);

function detectModelFamily(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (normalized.includes('codex')) return 'codex';
  if (normalized.includes('gemini')) return 'gemini';
  return 'claude';
}

function resolveArmCommandFromSettings(paneId, fallback = 'codex') {
  try {
    const paneCommands = rendererSettings.getSettings?.()?.paneCommands || {};
    const command = String(paneCommands[String(paneId)] || '').trim();
    return command || fallback;
  } catch (_) {
    return fallback;
  }
}

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

function appendTextNode(parent, text) {
  if (!parent?.ownerDocument || !text) return null;
  if (typeof parent.ownerDocument.createTextNode === 'function') {
    const node = parent.ownerDocument.createTextNode(text);
    parent.appendChild(node);
    return node;
  }
  const node = parent.ownerDocument.createElement('span');
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function createElement(doc, tagName, attrs = {}, text = '') {
  const element = doc.createElement(tagName);
  if (attrs.className) element.className = attrs.className;
  if (attrs.id) element.id = attrs.id;
  if (attrs.type) element.type = attrs.type;
  if (attrs.title) element.title = attrs.title;
  if (attrs.value !== undefined) element.value = attrs.value;
  if (attrs.selected !== undefined) element.selected = Boolean(attrs.selected);
  if (attrs.dataset) {
    for (const [key, value] of Object.entries(attrs.dataset)) {
      if (value !== undefined && value !== null) {
        element.dataset[key] = String(value);
      }
    }
  }
  if (attrs.attributes) {
    for (const [key, value] of Object.entries(attrs.attributes)) {
      element.setAttribute?.(key, String(value));
    }
  }
  if (attrs.innerHTML) element.innerHTML = attrs.innerHTML;
  if (text) element.textContent = text;
  return element;
}

function createPaneActionButton(doc, className, paneId, tooltip, iconMarkup) {
  return createElement(doc, 'button', {
    className: `pane-action-btn ${className}`,
    type: 'button',
    dataset: {
      paneId,
      tooltip,
    },
    attributes: {
      'aria-label': tooltip,
    },
    innerHTML: iconMarkup,
  });
}

function createRoleInfoButton(doc, paneId) {
  return createElement(doc, 'button', {
    className: 'pane-role-info-btn',
    type: 'button',
    title: 'Show role bundle',
    dataset: { paneId },
    innerHTML: PANE_ICON_SVGS.info,
  });
}

function createArmModelSelector(doc, paneId, currentModel = 'codex', currentCommand = '') {
  const model = ['claude', 'codex', 'gemini'].includes(currentModel) ? currentModel : 'codex';
  const selectorValue = selectorValueForCommand(currentCommand, model);
  const selector = createElement(doc, 'select', {
    className: 'model-selector squid-room-arm-model-selector',
    id: `model-selector-${paneId}`,
    title: 'Switch model for this arm',
    dataset: {
      paneId,
      previousValue: selectorValue,
      squidRoomArmModelSelector: 'true',
    },
  });
  for (const option of [
    ...CLAUDE_MODEL_SELECTOR_OPTIONS,
    { value: 'codex', label: 'Codex' },
    { value: 'gemini', label: 'Gemini' },
  ]) {
    selector.appendChild(createElement(doc, 'option', {
      value: option.value,
      selected: option.value === selectorValue,
      dataset: option.model ? { claudeModel: option.model } : undefined,
    }, option.label));
  }
  selector.value = selectorValue;
  return selector;
}

function removeElement(element) {
  if (!element) return;
  if (typeof element.remove === 'function') {
    element.remove();
    return;
  }
  const siblings = element.parentNode?.childNodes;
  if (Array.isArray(siblings)) {
    const index = siblings.indexOf(element);
    if (index >= 0) siblings.splice(index, 1);
  }
}

function ensureArmModelSelector(doc, pane, paneId, currentModel = 'codex', currentCommand = '') {
  if (!doc || !pane || !paneId) return null;
  const model = ['claude', 'codex', 'gemini'].includes(currentModel) ? currentModel : 'codex';
  const selectorValue = selectorValueForCommand(currentCommand, model);
  let selector = pane.querySelector?.(`.model-selector[data-pane-id="${paneId}"]`);
  if (!selector) {
    selector = createArmModelSelector(doc, paneId, model, currentCommand);
    const badge = pane.querySelector?.(`.model-badge[data-pane-id="${paneId}"]`);
    if (badge?.parentNode) {
      badge.parentNode.insertBefore?.(selector, badge);
      removeElement(badge);
      return selector;
    }
    const headerRight = pane.querySelector?.('.pane-header-right') || pane.querySelector?.('.pane-header');
    const health = pane.querySelector?.(`#health-${paneId}`);
    if (headerRight && health?.parentNode === headerRight) {
      headerRight.insertBefore?.(selector, health);
    } else {
      headerRight?.appendChild?.(selector);
    }
  }
  selector.value = selectorValue;
  selector.dataset.previousValue = selectorValue;
  selector.dataset.squidRoomArmModelSelector = 'true';
  return selector;
}

function createSquidRoomLivePane(doc, spec) {
  const command = resolveArmCommandFromSettings(spec.paneId, spec.command);
  const model = detectModelFamily(command);
  const pane = createElement(doc, 'div', {
    className: 'pane squid-room-live-pane',
    dataset: {
      paneId: spec.paneId,
      squidRoomLivePane: 'true',
      squidRoomLabel: spec.label,
      squidRoomRole: spec.role,
      squidRoomRoleId: spec.roleId || spec.routeTarget || spec.paneId,
      squidRoomRouteTarget: spec.routeTarget || spec.paneId,
      squidRoomWorkingDir: spec.workingDir,
      squidRoomCommand: command,
      squidRoomCommandSourcePaneId: spec.commandSourcePaneId,
      squidRoomStartupMessage: spec.startupMessage,
      cli: model,
    },
  });

  const header = createElement(doc, 'div', { className: 'pane-header' });
  const title = createElement(doc, 'span', { className: 'pane-title' });
  title.appendChild(createElement(doc, 'span', {
    className: 'agent-avatar',
    innerHTML: PANE_ICON_SVGS.avatar,
  }));
  title.appendChild(createElement(doc, 'span', {
    className: 'agent-badge idle',
    id: `badge-${spec.paneId}`,
  }));
  appendTextNode(title, spec.label);
  title.appendChild(createRoleInfoButton(doc, spec.paneId));
  title.appendChild(createElement(doc, 'span', {
    className: 'cli-badge',
    id: `cli-badge-${spec.paneId}`,
  }));
  title.appendChild(createElement(doc, 'span', {
    className: 'pane-project',
    id: `project-${spec.paneId}`,
  }));
  title.appendChild(createElement(doc, 'span', {
    className: 'agent-task',
    id: `task-${spec.paneId}`,
    text: '',
  }));

  const headerRight = createElement(doc, 'div', { className: 'pane-header-right' });
  headerRight.appendChild(createArmModelSelector(doc, spec.paneId, model, command));
  headerRight.appendChild(createElement(doc, 'span', {
    className: 'agent-health',
    id: `health-${spec.paneId}`,
    title: 'Last output time',
  }, '-'));

  const actions = createElement(doc, 'div', { className: 'pane-actions' });
  actions.appendChild(createPaneActionButton(doc, 'interrupt-btn', spec.paneId, 'Interrupt', PANE_ICON_SVGS.interrupt));
  actions.appendChild(createPaneActionButton(doc, 'unstick-btn', spec.paneId, 'Enter', PANE_ICON_SVGS.enter));
  actions.appendChild(createPaneActionButton(doc, 'kickoff-btn', spec.paneId, 'Restart agent', PANE_ICON_SVGS.restart));
  actions.appendChild(createPaneActionButton(doc, 'expand-btn', spec.paneId, 'Expand (ESC to collapse)', PANE_ICON_SVGS.expand));
  headerRight.appendChild(actions);
  headerRight.appendChild(createElement(doc, 'span', {
    className: 'lock-icon',
    id: `lock-icon-${spec.paneId}`,
    dataset: {
      paneId: spec.paneId,
      tooltip: 'Locked (click to toggle)',
    },
    innerHTML: PANE_ICON_SVGS.lock,
  }));

  header.appendChild(title);
  header.appendChild(headerRight);
  pane.appendChild(header);
  pane.appendChild(createElement(doc, 'div', {
    className: 'pane-terminal',
    id: `terminal-${spec.paneId}`,
  }));
  pane.appendChild(createElement(doc, 'span', { id: `status-${spec.paneId}` }));
  return pane;
}

function createSquidRoomPetArtwork(doc, spec) {
  return createElement(doc, 'div', {
    className: `squid-room-codex-pet squid-room-codex-pet-${spec.assetRef}`,
    dataset: {
      avatarAssetRef: spec.assetRef,
      avatarState: spec.state,
      squidRoomPetSprite: 'true',
    },
    attributes: { 'aria-hidden': 'true' },
  });
}

function renderSquidRoomPetPane(doc, pane, spec) {
  if (!doc || !pane || !spec) return null;
  if (Array.isArray(pane.childNodes)) pane.childNodes.length = 0;
  pane.innerHTML = '';
  pane.className = 'pane squid-room-pet-pane';
  pane.dataset.paneId = spec.paneId;
  pane.dataset.squidRoomPet = spec.petId;
  pane.dataset.squidRoomSourcePaneId = spec.paneId;
  pane.dataset.squidRoomState = spec.state;
  pane.dataset.squidRoomRole = spec.role;
  pane.dataset.squidRoomLabel = spec.title;
  pane.dataset.squidRoomPetAsset = spec.assetRef;

  const shell = createElement(doc, 'div', { className: 'squid-room-pet-shell' });
  const header = createElement(doc, 'div', { className: 'squid-room-pet-header' });
  const title = createElement(doc, 'div', { className: 'squid-room-pet-title' });
  title.appendChild(createElement(doc, 'span', { className: 'squid-room-pet-eyebrow' }, spec.role));
  title.appendChild(createElement(doc, 'strong', {}, spec.title));
  header.appendChild(title);
  header.appendChild(createElement(doc, 'span', { className: 'squid-room-pet-state' }, spec.stateLabel));

  const stage = createElement(doc, 'div', { className: 'squid-room-pet-stage' });
  stage.appendChild(createSquidRoomPetArtwork(doc, spec));

  shell.appendChild(header);
  shell.appendChild(stage);
  shell.appendChild(createElement(doc, 'div', {
    className: 'squid-room-pet-bubble',
    id: `squidRoomPetBubble-${spec.paneId}`,
    attributes: { 'aria-live': 'polite' },
  }, spec.bubble));
  pane.appendChild(shell);
  return pane;
}

function ensureSquidRoomPetPanes(doc) {
  const panes = [];
  for (const spec of SQUID_ROOM_PET_PANE_SPECS) {
    const pane = doc.querySelector?.(`.pane[data-pane-id="${spec.paneId}"], .pane[data-workspace-source-pane-id="${spec.paneId}"]`);
    if (!pane) continue;
    setElementHidden(pane, false);
    renderSquidRoomPetPane(doc, pane, spec);
    panes.push(spec);
  }
  return panes;
}

function ensureSquidRoomTeamHeader(doc, teamContainer) {
  if (!doc || !teamContainer) return null;
  let header = teamContainer.querySelector?.('.squid-room-team-header');
  if (!header) {
    header = createElement(doc, 'div', { className: 'squid-room-team-header' });
    teamContainer.insertBefore?.(header, teamContainer.firstChild || null);
  }

  header.innerHTML = '';
  const title = createElement(doc, 'div', { className: 'squid-room-team-title' });
  title.appendChild(createElement(doc, 'span', { className: 'squid-room-team-eyebrow' }, 'Pets'));
  title.appendChild(createElement(doc, 'strong', {}, 'Builder + Oracle'));
  header.appendChild(title);

  const actions = createElement(doc, 'div', { className: 'pane-actions squid-room-team-actions' });
  const expandButton = createElement(doc, 'button', {
    className: 'squid-room-app-toggle-btn expand-btn squid-room-team-expand-btn',
    type: 'button',
    dataset: {
      paneId: SQUID_ROOM_TEAM_PANE_IDS[0],
      tooltip: 'Collapse Builder + Oracle',
      expanded: 'true',
      squidRoomTeamToggle: 'true',
    },
    attributes: {
      'aria-label': 'Collapse Builder + Oracle',
      'aria-expanded': 'true',
    },
  });
  expandButton.appendChild(createElement(doc, 'span', {
    className: 'squid-room-team-toggle-label',
  }, 'Collapse'));
  actions.appendChild(expandButton);
  header.appendChild(actions);
  return header;
}

function ensureSquidRoomLivePaneContainer(doc) {
  let container = doc.querySelector?.('#squidRoomTrustQuoteLivePanes');
  if (container) return container;

  const app = doc.querySelector?.('.squid-room-app[data-app-room-id="trustquote"]')
    || doc.querySelector?.('[data-app-room-id="trustquote"]')
    || doc.querySelector?.('#squidRoomSurface');
  if (!app) return null;

  container = createElement(doc, 'div', {
    className: 'squid-room-live-panes',
    id: 'squidRoomTrustQuoteLivePanes',
  });
  app.appendChild(container);
  return container;
}

function ensureSquidRoomLivePanes(doc) {
  const container = ensureSquidRoomLivePaneContainer(doc);
  if (!container) return [];

  const panes = [];
  for (const spec of SQUID_ROOM_TRUSTQUOTE_ARM_PANES) {
    const command = resolveArmCommandFromSettings(spec.paneId, spec.command);
    const model = detectModelFamily(command);
    let pane = doc.querySelector?.(`.pane[data-pane-id="${spec.paneId}"]`);
    if (!pane) {
      pane = createSquidRoomLivePane(doc, spec);
      container.appendChild(pane);
    }
    setElementHidden(pane, false);
    pane.dataset.squidRoomLivePane = 'true';
    pane.dataset.squidRoomLabel = spec.label;
    pane.dataset.squidRoomRole = spec.role;
    pane.dataset.squidRoomRoleId = spec.roleId || spec.routeTarget || spec.paneId;
    pane.dataset.squidRoomRouteTarget = spec.routeTarget || spec.paneId;
    pane.dataset.squidRoomWorkingDir = spec.workingDir;
    pane.dataset.squidRoomCommand = command;
    pane.dataset.squidRoomCommandSourcePaneId = spec.commandSourcePaneId;
    pane.dataset.squidRoomStartupMessage = spec.startupMessage;
    pane.dataset.cli = model;
    ensureArmModelSelector(doc, pane, spec.paneId, model, command);
    panes.push(spec);
  }
  return panes;
}

function configureSquidRoomRuntimeOverrides(terminal, livePanes = SQUID_ROOM_TRUSTQUOTE_ARM_PANES) {
  if (!terminal || typeof terminal.setPaneRuntimeOverride !== 'function') return;
  for (const spec of livePanes) {
    const command = resolveArmCommandFromSettings(spec.paneId, spec.command);
    const provider = detectModelFamily(command);
    terminal.setPaneRuntimeOverride(spec.paneId, {
      label: spec.label,
      roleLabel: spec.label,
      roleId: spec.roleId || spec.routeTarget || spec.paneId,
      routeTarget: spec.routeTarget || spec.paneId,
      provider,
      command,
      commandSourcePaneId: spec.commandSourcePaneId,
      workingDir: spec.workingDir,
      startupMessage: spec.startupMessage,
      spawnCommandOnCreate: true,
      recreateOnWorkingDirMismatch: true,
    });
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

  const teamContainer = doc.querySelector?.('.side-panes-container');
  if (teamContainer) {
    teamContainer.classList?.add?.('squid-room-team-container');
    teamContainer.dataset.squidRoomSection = 'builder-oracle';
    teamContainer.setAttribute?.('aria-label', 'Builder and Oracle');
    ensureSquidRoomTeamHeader(doc, teamContainer);
  }

  const petPanes = ensureSquidRoomPetPanes(doc);

  const surface = doc.querySelector('#squidRoomSurface');
  if (surface) {
    surface.hidden = false;
    surface.removeAttribute?.('aria-hidden');
  }

  const livePanes = ensureSquidRoomLivePanes(doc);

  return {
    workspaceKey: SQUID_ROOM_WORKSPACE_KEY,
    paneIds: SQUID_ROOM_PANE_IDS.slice(),
    teamPaneIds: SQUID_ROOM_TEAM_PANE_IDS.slice(),
    petPanes,
    livePanes,
  };
}

function configureWorkspacePaneShell(windowContext = {}, terminal = null, doc = null) {
  const resolvedDocument = getDocument(doc);
  if (!resolvedDocument) {
    return { workspaceKey: 'main', paneIds: [] };
  }

  // Chrome renders by window class from a deliberate allow-list - every
  // window decides its chrome here, never by inheriting main's header.
  const windowChromeClass = resolveWindowChromeClass(windowContext);
  applyWindowChrome(resolvedDocument, windowChromeClass);

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
  if (isSquidRoomWorkspace(result.workspaceKey)) {
    configureSquidRoomRuntimeOverrides(terminal, result.livePanes);
  }

  return result;
}

module.exports = {
  SQUID_ROOM_WORKSPACE_KEY,
  SQUID_ROOM_PANE_IDS,
  SQUID_ROOM_PET_PANE_SPECS,
  SQUID_ROOM_TEAM_PANE_IDS,
  SQUID_ROOM_TRUSTQUOTE_ARM_PANES,
  TRUSTQUOTE_PROJECT_PATH,
  TRUSTQUOTE_PANES,
  configureWorkspacePaneShell,
};
