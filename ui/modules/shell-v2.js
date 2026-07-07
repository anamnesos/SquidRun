'use strict';

const SHELL_V2_TABS = Object.freeze([
  { id: 'mira', label: 'MIRA', shortcut: '1' },
  { id: 'squid-room', label: 'SQUID ROOM', shortcut: '2' },
  { id: 'today', label: 'TODAY', shortcut: '3' },
]);

const MAIN_WINDOW_KEYS = new Set(['', 'main']);
const stateByDocument = new WeakMap();

function normalizeWindowKey(windowContext = {}) {
  return String(windowContext?.windowKey || 'main').trim().toLowerCase();
}

function isMainWindowContext(windowContext = {}) {
  return MAIN_WINDOW_KEYS.has(normalizeWindowKey(windowContext));
}

function isShellV2EnvOverrideEnabled(env = {}) {
  return String(env?.SQUIDRUN_SHELL_V2 || '').trim() === '1';
}

function resolveShellV2Enabled(settings = {}, env = {}, windowContext = {}) {
  if (!isMainWindowContext(windowContext)) return false;
  return settings?.shellV2Enabled === true || isShellV2EnvOverrideEnabled(env);
}

function ensureClass(element, className) {
  if (element && className && !element.classList?.contains?.(className)) {
    element.classList?.add?.(className);
  }
  return element;
}

function makeElement(doc, tagName, className, attributes = {}) {
  const element = doc.createElement(tagName);
  if (className) element.className = className;
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'textContent') {
      element.textContent = value;
    } else if (key === 'dataset' && value && typeof value === 'object') {
      Object.assign(element.dataset, value);
    } else {
      element.setAttribute(key, value);
    }
  }
  return element;
}

function appendExisting(parent, child) {
  if (!parent || !child || child.parentNode === parent) return child;
  parent.appendChild(child);
  return child;
}

function showShellActionButton(button) {
  if (!button) return null;
  button.hidden = false;
  if (button.style?.display === 'none') {
    button.style.display = '';
  }
  button.removeAttribute?.('hidden');
  return button;
}

function getRequiredElements(doc) {
  const body = doc.body;
  const header = doc.querySelector('.header');
  const headerActions = doc.querySelector('.header-actions');
  const paneLayout = doc.querySelector('.pane-layout');
  const mainPaneContainer = doc.querySelector('.main-pane-container');
  const sidePanesContainer = doc.querySelector('.side-panes-container');
  const statusBar = doc.querySelector('.status-bar');

  if (!body || !header || !headerActions || !paneLayout || !mainPaneContainer || !sidePanesContainer || !statusBar) {
    return null;
  }

  return {
    body,
    header,
    headerActions,
    paneLayout,
    mainPaneContainer,
    sidePanesContainer,
    statusBar,
  };
}

function buildTabRail(doc, header, onSelectTab) {
  let rail = doc.getElementById('shellV2TabRail');
  if (rail) return rail;

  rail = makeElement(doc, 'nav', 'shell-v2-tab-rail', {
    id: 'shellV2TabRail',
    'aria-label': 'Primary views',
  });

  SHELL_V2_TABS.forEach((tab) => {
    const button = makeElement(doc, 'button', 'shell-v2-tab', {
      type: 'button',
      textContent: tab.label,
      'data-shell-v2-tab': tab.id,
      'data-shortcut': `Ctrl+${tab.shortcut}`,
      'aria-pressed': 'false',
    });
    button.dataset.shellV2Tab = tab.id;
    button.dataset.shortcut = `Ctrl+${tab.shortcut}`;
    button.addEventListener?.('click', () => onSelectTab(tab.id));
    rail.appendChild(button);
  });

  header.insertBefore(rail, header.firstChild || null);
  return rail;
}

function buildHeaderActions(doc, header, existingActions) {
  let shellActions = doc.getElementById('shellV2HeaderActions');
  if (!shellActions) {
    shellActions = makeElement(doc, 'div', 'shell-v2-header-actions', {
      id: 'shellV2HeaderActions',
    });
    header.appendChild(shellActions);
  }

  const settingsBtn = doc.getElementById('settingsBtn');
  const fullRestartBtn = doc.getElementById('fullRestartBtn');
  appendExisting(shellActions, showShellActionButton(settingsBtn));
  appendExisting(shellActions, showShellActionButton(fullRestartBtn));
  if (existingActions) ensureClass(existingActions, 'shell-v2-source-actions');
  return shellActions;
}

function mergeBottomBar(doc, statusBar) {
  const projectIndicator = doc.querySelector('.project-indicator');
  const sessionBadge = doc.getElementById('headerSessionBadge');
  const ownedWorkSummary = doc.getElementById('ownedWorkSummary');
  const sessionTimer = doc.getElementById('sessionTimer');
  const costIndicator = doc.getElementById('costIndicator');
  const connectionStatus = doc.getElementById('connectionStatus');
  const voiceStatus = doc.getElementById('voiceStatus');
  const heartbeatIndicator = doc.getElementById('heartbeatIndicator');

  ensureClass(statusBar, 'shell-v2-bottom-bar');
  [
    projectIndicator,
    sessionBadge,
    ownedWorkSummary,
    sessionTimer,
    costIndicator,
    connectionStatus,
    voiceStatus,
    heartbeatIndicator,
  ].forEach((element) => appendExisting(statusBar, element));
}

function ensureViews(doc, paneLayout) {
  ensureClass(paneLayout, 'shell-v2-pane-layout');

  const views = {};
  SHELL_V2_TABS.forEach((tab) => {
    let view = paneLayout.querySelector(`.shell-v2-view[data-shell-v2-view="${tab.id}"]`);
    if (!view) {
      view = makeElement(doc, 'section', 'shell-v2-view', {
        'data-shell-v2-view': tab.id,
        'aria-label': tab.label,
        'aria-hidden': 'true',
      });
      view.dataset.shellV2View = tab.id;
      paneLayout.appendChild(view);
    }
    views[tab.id] = view;
  });

  return views;
}

function reparentPaneContainers(doc, views, mainPaneContainer, sidePanesContainer) {
  appendExisting(views.mira, mainPaneContainer);
  ensureClass(views.mira, 'shell-v2-mira-view');

  let coreStrip = doc.getElementById('shellV2CoreStrip');
  if (!coreStrip) {
    coreStrip = makeElement(doc, 'div', 'shell-v2-core-strip', {
      id: 'shellV2CoreStrip',
      'aria-label': 'Squid Room core panes',
    });
    views['squid-room'].appendChild(coreStrip);
  }
  appendExisting(coreStrip, sidePanesContainer);
  ensureClass(views['squid-room'], 'shell-v2-squid-room-view');

  ensureClass(views.today, 'shell-v2-today-view');
  if (!views.today.dataset.phase) {
    views.today.dataset.phase = 'empty';
  }

  return coreStrip;
}

function scheduleRefit(terminalApi = {}, windowRef = null) {
  const resize = typeof terminalApi.handleResize === 'function'
    ? terminalApi.handleResize.bind(terminalApi)
    : null;
  if (!resize) return;

  resize();
  const requestFrame = typeof windowRef?.requestAnimationFrame === 'function'
    ? windowRef.requestAnimationFrame.bind(windowRef)
    : (fn) => setTimeout(fn, 0);
  requestFrame(() => resize());
  setTimeout(() => resize(), 120);
}

function dispatchShellEvent(doc, activeTab) {
  if (typeof doc?.dispatchEvent !== 'function') return;
  try {
    const CustomEventCtor = doc.defaultView?.CustomEvent
      || (typeof CustomEvent !== 'undefined' ? CustomEvent : null);
    if (typeof CustomEventCtor === 'function') {
      doc.dispatchEvent(new CustomEventCtor('shell-v2-tab-activated', {
        detail: { activeTab },
      }));
    }
  } catch (_) {}
}

function updateTabState(doc, body, rail, views, activeTab) {
  body.dataset.shellV2ActiveTab = activeTab;
  SHELL_V2_TABS.forEach((tab) => {
    const isActive = tab.id === activeTab;
    const button = rail.querySelector?.(`[data-shell-v2-tab="${tab.id}"]`);
    if (button) {
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      button.setAttribute('tabindex', isActive ? '0' : '-1');
    }

    const view = views[tab.id];
    if (view) {
      view.dataset.shellV2Active = isActive ? 'true' : 'false';
      view.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    }
  });
  dispatchShellEvent(doc, activeTab);
}

function resolveShortcutTab(event) {
  if (!event?.ctrlKey || event.altKey || event.metaKey) return null;
  const key = String(event.key || '');
  const tab = SHELL_V2_TABS.find((candidate) => candidate.shortcut === key);
  return tab?.id || null;
}

function shouldHandleCoreExpand(button) {
  const paneId = String(button?.dataset?.paneId || '');
  return paneId === '2' || paneId === '3';
}

function initShellV2(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const windowRef = options.window || (typeof window !== 'undefined' ? window : null);
  if (!doc) return { enabled: false, reason: 'document_unavailable' };

  const existing = stateByDocument.get(doc);
  if (existing) return existing.controller;

  const enabled = resolveShellV2Enabled(options.settings || {}, options.env || {}, options.windowContext || {});
  if (!enabled) return { enabled: false, reason: 'disabled' };

  const required = getRequiredElements(doc);
  if (!required) return { enabled: false, reason: 'missing_required_elements' };

  const state = {
    activeTab: options.defaultTab || 'mira',
    coreExpanded: false,
  };

  required.body.classList.add('shell-v2-enabled');
  required.body.dataset.shellV2Enabled = 'true';

  const switchTab = (tabId) => {
    if (!SHELL_V2_TABS.some((tab) => tab.id === tabId)) return false;
    state.activeTab = tabId;
    updateTabState(doc, required.body, rail, views, state.activeTab);
    scheduleRefit(options.terminal || {}, windowRef);
    if (typeof options.onTabActivated === 'function') {
      options.onTabActivated(state.activeTab);
    }
    return true;
  };

  const rail = buildTabRail(doc, required.header, switchTab);
  buildHeaderActions(doc, required.header, required.headerActions);
  mergeBottomBar(doc, required.statusBar);
  const views = ensureViews(doc, required.paneLayout);
  const coreStrip = reparentPaneContainers(doc, views, required.mainPaneContainer, required.sidePanesContainer);

  const toggleCoreExpanded = (force) => {
    state.coreExpanded = typeof force === 'boolean' ? force : !state.coreExpanded;
    coreStrip.classList.toggle('shell-v2-core-expanded', state.coreExpanded);
    required.body.dataset.shellV2CoreExpanded = state.coreExpanded ? 'true' : 'false';
    scheduleRefit(options.terminal || {}, windowRef);
    return state.coreExpanded;
  };

  const onKeyDown = (event) => {
    const targetTab = resolveShortcutTab(event);
    if (!targetTab) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    switchTab(targetTab);
  };

  const onClick = (event) => {
    const button = event.target?.closest?.('.expand-btn');
    if (!shouldHandleCoreExpand(button)) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    toggleCoreExpanded();
  };

  doc.addEventListener?.('keydown', onKeyDown, true);
  doc.addEventListener?.('click', onClick, true);
  switchTab(state.activeTab);

  const controller = {
    enabled: true,
    switchTab,
    getActiveTab: () => state.activeTab,
    toggleCoreExpanded,
    isCoreExpanded: () => state.coreExpanded,
    elements: {
      rail,
      views,
      coreStrip,
    },
    destroy: () => {
      doc.removeEventListener?.('keydown', onKeyDown, true);
      doc.removeEventListener?.('click', onClick, true);
      stateByDocument.delete(doc);
    },
  };

  stateByDocument.set(doc, { controller });
  return controller;
}

module.exports = {
  SHELL_V2_TABS,
  initShellV2,
  isShellV2EnvOverrideEnabled,
  resolveShellV2Enabled,
  _internals: {
    isMainWindowContext,
    normalizeWindowKey,
    dispatchShellEvent,
    resolveShortcutTab,
    shouldHandleCoreExpand,
  },
};
