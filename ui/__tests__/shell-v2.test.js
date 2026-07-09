const {
  DOORBELL_CHOKEPOINT_CALLERS,
  initShellV2,
  resolveShellV2Enabled,
} = require('../modules/shell-v2');

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.items = new Set();
  }

  add(...classes) {
    classes.forEach((className) => this.items.add(className));
    this.sync();
  }

  remove(...classes) {
    classes.forEach((className) => this.items.delete(className));
    this.sync();
  }

  contains(className) {
    return this.items.has(className);
  }

  toggle(className, force) {
    const next = force === undefined ? !this.items.has(className) : Boolean(force);
    if (next) this.items.add(className);
    else this.items.delete(className);
    this.sync();
    return next;
  }

  sync() {
    this.owner._className = Array.from(this.items).join(' ');
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.parentElement = null;
    this.dataset = {};
    this.attributes = {};
    this.eventListeners = {};
    this.style = {
      removeProperty: (name) => {
        delete this.style[name];
        if (name === 'display') this.style.display = '';
      },
    };
    this.id = '';
    this.hidden = false;
    this.scrollTop = 0;
    this.value = '';
    this._className = '';
    this._textContent = '';
    this.classList = new FakeClassList(this);
  }

  get firstChild() {
    return this.children[0] || null;
  }

  set className(value) {
    this._className = String(value || '');
    this.classList.items = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  get className() {
    return this._className;
  }

  set textContent(value) {
    this._textContent = String(value || '');
  }

  get textContent() {
    return this._textContent;
  }

  setAttribute(name, value) {
    const normalized = String(value);
    this.attributes[name] = normalized;
    if (name === 'id') this.id = normalized;
    if (name.startsWith('data-')) {
      this.dataset[toDatasetKey(name.slice(5))] = normalized;
    }
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((entry) => entry !== child);
    }
    child.parentNode = this;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, before) {
    if (!child) return child;
    if (child.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((entry) => entry !== child);
    }
    child.parentNode = this;
    child.parentElement = this;
    const index = this.children.indexOf(before);
    if (index < 0) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentNode = null;
      child.parentElement = null;
    }
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => {
      child.parentNode = null;
      child.parentElement = null;
    });
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  remove() {
    this.parentNode?.removeChild?.(this);
  }

  addEventListener(type, listener) {
    this.eventListeners[type] = this.eventListeners[type] || [];
    this.eventListeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    this.eventListeners[type] = (this.eventListeners[type] || []).filter((entry) => entry !== listener);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      if (matchesSelector(node, selector)) matches.push(node);
      (node.children || []).forEach(visit);
    };
    (this.children || []).forEach(visit);
    return matches;
  }

  closest(selector) {
    let cursor = this;
    while (cursor) {
      if (matchesSelector(cursor, selector)) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  }

  contains(target) {
    if (target === this) return true;
    return (this.children || []).some((child) => child.contains?.(target) === true);
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument?.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }
}

function toDatasetKey(value) {
  return String(value || '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function matchesSelector(node, selector) {
  if (!node) return false;
  if (selector === '*') return true;
  if (selector.startsWith('#')) return node.id === selector.slice(1);

  const dataMatch = selector.match(/^(?:\.([a-zA-Z0-9_-]+))?\[data-([a-zA-Z0-9_-]+)="([^"]+)"\]$/);
  if (dataMatch) {
    const [, className, dataName, value] = dataMatch;
    const classOk = !className || node.classList.contains(className);
    return classOk && node.dataset[toDatasetKey(dataName)] === value;
  }

  const multiClassMatch = selector.match(/^\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/);
  if (multiClassMatch) {
    return node.classList.contains(multiClassMatch[1]) && node.classList.contains(multiClassMatch[2]);
  }

  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function createFakeDocument() {
  const listeners = new Map();
  const body = new FakeElement('body');
  const doc = {
    body,
    activeElement: body,
    defaultView: { CustomEvent: class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail || {};
      }
    } },
    createElement: (tagName) => new FakeElement(tagName),
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    getElementById: (id) => body.querySelector(`#${id}`),
    addEventListener: (type, listener) => {
      const entries = listeners.get(type) || [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    removeEventListener: (type, listener) => {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== listener));
    },
    dispatchEvent: (event) => {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    fire: (type, event) => {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };

  body.ownerDocument = doc;
  const make = (tagName, { id = '', className = '', text = '', dataset = {} } = {}) => {
    const element = new FakeElement(tagName);
    element.ownerDocument = doc;
    if (id) element.setAttribute('id', id);
    if (className) element.className = className;
    if (text) element.textContent = text;
    Object.assign(element.dataset, dataset);
    return element;
  };

  const header = make('div', { className: 'header' });
  const heading = make('h1', { text: 'SquidRun ' });
  heading.appendChild(make('span', { id: 'headerSessionBadge', className: 'header-session-badge pending', text: 'Session --' }));
  header.appendChild(heading);
  header.appendChild(make('span', { id: 'dryRunIndicator', className: 'dry-run-indicator' }));
  const headerActions = make('div', { className: 'header-actions' });
  [
    'selectProjectBtn',
    'fullRestartBtn',
    'profileBtn',
    'settingsBtn',
    'openHumanTimelineBtn',
    'openSquidRoomBtn',
    'openMiraLabBtn',
    'panelBtn',
  ].forEach((id) => {
    const button = make('button', { id, className: 'btn' });
    if (id === 'settingsBtn') {
      button.hidden = true;
      button.style.display = 'none';
    }
    headerActions.appendChild(button);
  });
  header.appendChild(headerActions);
  body.appendChild(header);

  const profileOverlay = make('div', { id: 'profileModalOverlay', className: 'pane-role-modal-overlay profile-modal-overlay' });
  profileOverlay.appendChild(make('div', { id: 'profileModalSubtitle', className: 'pane-role-modal-subtitle', text: 'Profile copy' }));
  const profileForm = make('form', { id: 'profileModalForm', className: 'profile-modal-form' });
  profileForm.appendChild(make('input', { id: 'profileNameInput', className: 'settings-input' }));
  profileForm.appendChild(make('button', { id: 'profileModalSave', className: 'btn profile-modal-save' }));
  profileOverlay.appendChild(profileForm);
  body.appendChild(profileOverlay);

  const settingsPanel = make('div', { id: 'settingsPanel', className: 'settings-panel' });
  const settingsShell = make('div', { className: 'settings-shell' });
  const settingsLayout = make('div', { className: 'settings-layout' });
  const makeSettingsSection = (title, children = []) => {
    const section = make('div', { className: 'settings-section' });
    section.appendChild(make('div', { className: 'settings-section-title', text: title }));
    const items = make('div', { className: 'settings-items' });
    children.forEach((child) => items.appendChild(child));
    section.appendChild(items);
    return section;
  };
  const makeSettingItem = (id, setting) => {
    const item = make('div', { className: 'setting-item' });
    item.appendChild(make('span', { className: 'setting-label', text: setting }));
    item.appendChild(make('div', { id, className: 'toggle', dataset: { setting } }));
    return item;
  };
  settingsLayout.appendChild(makeSettingsSection('General', [
    makeSettingItem('toggleAutoSpawn', 'autoSpawn'),
    makeSettingItem('toggleDevTools', 'devTools'),
  ]));
  settingsLayout.appendChild(makeSettingsSection('Permissions', [
    makeSettingItem('toggleAllowAllPermissions', 'allowAllPermissions'),
  ]));
  settingsLayout.appendChild(makeSettingsSection('Voice Control', [
    makeSettingItem('toggleVoiceInputEnabled', 'voiceInputEnabled'),
    makeSettingItem('toggleVoiceAutoSend', 'voiceAutoSend'),
  ]));
  const costSection = makeSettingsSection('Cost Alerts', [
    makeSettingItem('toggleCostAlertEnabled', 'costAlertEnabled'),
  ]);
  costSection.appendChild(make('input', { id: 'costAlertThreshold', className: 'threshold-input' }));
  settingsLayout.appendChild(costSection);
  settingsLayout.appendChild(makeSettingsSection('Devices', [
    make('button', { id: 'pairingInitBtn', className: 'btn' }),
    make('button', { id: 'pairingJoinBtn', className: 'btn' }),
  ]));
  settingsShell.appendChild(settingsLayout);
  settingsPanel.appendChild(settingsShell);
  body.appendChild(settingsPanel);

  const stateBar = make('div', { className: 'state-bar' });
  const stateLeft = make('div', { className: 'state-bar-left' });
  const projectIndicator = make('div', { className: 'project-indicator' });
  projectIndicator.appendChild(make('span', { className: 'state-label', text: 'Project:' }));
  projectIndicator.appendChild(make('span', { id: 'projectPath', className: 'project-path no-project', text: 'SquidRun home' }));
  stateLeft.appendChild(projectIndicator);
  stateBar.appendChild(stateLeft);
  const stateRight = make('div', { className: 'state-bar-right' });
  stateRight.appendChild(make('span', { id: 'ownedWorkSummary', className: 'owned-work-summary idle', text: 'Carrying: idle' }));
  stateRight.appendChild(make('span', { id: 'sessionTimer', className: 'session-timer', text: 'Session: 0:00' }));
  stateRight.appendChild(make('span', { id: 'costIndicator', className: 'cost-indicator', text: '$0.00' }));
  stateBar.appendChild(stateRight);
  body.appendChild(stateBar);

  const mainContent = make('div', { className: 'main-content' });
  const terminalsSection = make('div', { id: 'terminalsSection', className: 'terminals-section' });
  const paneLayout = make('div', { className: 'pane-layout' });
  const mainPaneContainer = make('div', { className: 'main-pane-container' });
  const pane1 = makePane(make, '1');
  mainPaneContainer.appendChild(pane1);
  mainPaneContainer.appendChild(make('form', { className: 'command-bar' }));
  mainPaneContainer.appendChild(make('div', { id: 'miraLiveReply', className: 'mira-live-reply' }));
  paneLayout.appendChild(mainPaneContainer);

  const sidePanesContainer = make('div', { className: 'side-panes-container' });
  sidePanesContainer.appendChild(makePane(make, '2'));
  sidePanesContainer.appendChild(makePane(make, '3'));
  paneLayout.appendChild(sidePanesContainer);
  terminalsSection.appendChild(paneLayout);
  mainContent.appendChild(terminalsSection);
  const rightPanel = make('div', { id: 'rightPanel', className: 'right-panel' });
  const panelTabs = make('div', { className: 'panel-tabs' });
  ['bridge', 'comms', 'screenshots', 'oracle', 'voice', 'api-keys'].forEach((tab) => {
    panelTabs.appendChild(make('button', { className: 'panel-tab', text: tab, dataset: { tab } }));
  });
  rightPanel.appendChild(panelTabs);
  const voiceTab = make('div', { id: 'tab-voice', className: 'tab-pane' });
  voiceTab.appendChild(make('div', { id: 'voiceBrokerPanel', className: 'voice-broker-panel' }));
  rightPanel.appendChild(voiceTab);
  const apiKeysTab = make('div', { id: 'tab-api-keys', className: 'tab-pane' });
  apiKeysTab.appendChild(make('button', { id: 'saveApiKeysBtn', className: 'btn' }));
  rightPanel.appendChild(apiKeysTab);
  const oracleTab = make('div', { id: 'tab-oracle', className: 'tab-pane' });
  oracleTab.appendChild(make('button', { id: 'oracleGenerateBtn', className: 'btn' }));
  rightPanel.appendChild(oracleTab);
  mainContent.appendChild(rightPanel);
  body.appendChild(mainContent);

  const statusBar = make('div', { className: 'status-bar' });
  statusBar.appendChild(make('span', { id: 'connectionStatus', text: 'Initializing...' }));
  statusBar.appendChild(make('span', { id: 'voiceStatus', className: 'voice-status' }));
  statusBar.appendChild(make('span', { id: 'heartbeatIndicator', className: 'heartbeat-indicator idle' }));
  statusBar.appendChild(make('span', { className: 'status-shortcuts', text: 'Press Ctrl+1-4' }));
  body.appendChild(statusBar);

  return {
    doc,
    body,
    paneLayout,
    mainPaneContainer,
    sidePanesContainer,
    panes: {
      '1': pane1,
      '2': sidePanesContainer.querySelector('.pane[data-pane-id="2"]'),
      '3': sidePanesContainer.querySelector('.pane[data-pane-id="3"]'),
    },
  };
}

function makePane(make, paneId) {
  const pane = make('div', { className: 'pane', dataset: { paneId } });
  const header = make('div', { className: 'pane-header' });
  const title = make('span', { className: 'pane-title', text: paneId === '2' ? 'Builder' : paneId === '3' ? 'Oracle' : 'Mira' });
  title.appendChild(make('span', { id: `badge-${paneId}`, className: 'agent-badge idle' }));
  title.appendChild(make('button', { className: 'pane-role-info-btn', dataset: { paneId } }));
  title.appendChild(make('span', { id: `cli-badge-${paneId}`, className: 'cli-badge' }));
  title.appendChild(make('span', { id: `project-${paneId}`, className: 'pane-project' }));
  title.appendChild(make('span', { id: `task-${paneId}`, className: 'agent-task' }));
  const headerRight = make('div', { className: 'pane-header-right' });
  const selector = make('select', { id: `model-selector-${paneId}`, className: 'model-selector', dataset: { paneId } });
  selector.value = paneId === '3' ? 'gemini' : paneId === '2' ? 'codex' : 'claude';
  headerRight.appendChild(selector);
  headerRight.appendChild(make('button', { className: 'pane-action-btn fresh-session-btn', dataset: { paneId } }));
  headerRight.appendChild(make('span', { id: `health-${paneId}`, className: 'agent-health', text: '-' }));
  const actions = make('div', { className: 'pane-actions' });
  actions.appendChild(make('button', { className: 'pane-action-btn interrupt-btn', dataset: { paneId } }));
  actions.appendChild(make('button', { className: 'pane-action-btn unstick-btn', dataset: { paneId } }));
  actions.appendChild(make('button', { className: 'pane-action-btn kickoff-btn', dataset: { paneId } }));
  if (paneId !== '1') actions.appendChild(make('button', { className: 'pane-action-btn expand-btn', dataset: { paneId } }));
  headerRight.appendChild(actions);
  headerRight.appendChild(make('span', { id: `lock-icon-${paneId}`, className: 'lock-icon', dataset: { paneId } }));
  header.appendChild(title);
  header.appendChild(headerRight);
  pane.appendChild(header);
  const terminal = make('div', { id: `terminal-${paneId}`, className: 'pane-terminal', text: `pane ${paneId} scrollback` });
  terminal.scrollTop = Number(paneId) * 10;
  pane.appendChild(terminal);
  return pane;
}

function initHarness({
  settings = { shellV2Enabled: true },
  env = {},
  windowContext = { windowKey: 'main' },
  todayJournalApi,
  todayFullMessageApi,
  doorbellJournalApi,
} = {}) {
  const dom = createFakeDocument();
  let activePaneIds = ['1', '2', '3'];
  const clipboardWriteText = jest.fn(async () => undefined);
  const terminalApi = {
    handleResize: jest.fn(),
    spawn: jest.fn(),
    write: jest.fn(),
    kill: jest.fn(),
    focusPane: jest.fn(),
    blurAllTerminals: jest.fn(),
    getActivePaneIds: jest.fn(() => activePaneIds.slice()),
    setActivePaneIds: jest.fn((paneIds) => {
      activePaneIds = paneIds.slice();
      return activePaneIds.slice();
    }),
    setPaneRuntimeOverride: jest.fn(),
    refreshPane: jest.fn(() => true),
  };
  const win = {
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
    navigator: {
      clipboard: {
        writeText: clipboardWriteText,
      },
    },
  };
  const controller = initShellV2({
    document: dom.doc,
    window: win,
    settings,
    env,
    windowContext,
    terminal: terminalApi,
    todayJournalApi,
    todayFullMessageApi,
    doorbellJournalApi,
  });
  return { ...dom, terminalApi, controller, clipboardWriteText };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('shell-v2', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('resolves disabled by default and enabled only by setting or env on the main window', () => {
    expect(resolveShellV2Enabled({}, {}, { windowKey: 'main' })).toBe(false);
    expect(resolveShellV2Enabled({ shellV2Enabled: true }, {}, { windowKey: 'main' })).toBe(true);
    expect(resolveShellV2Enabled({}, { SQUIDRUN_SHELL_V2: '1' }, { windowKey: 'main' })).toBe(true);
    expect(resolveShellV2Enabled({ shellV2Enabled: true }, { SQUIDRUN_SHELL_V2: '1' }, { windowKey: 'squid-room' })).toBe(false);
  });

  test('flag off leaves the existing pane layout untouched', () => {
    const dom = createFakeDocument();
    const beforeParent = dom.mainPaneContainer.parentNode;
    const beforeSideParent = dom.sidePanesContainer.parentNode;

    const controller = initShellV2({
      document: dom.doc,
      settings: { shellV2Enabled: false },
      env: {},
      windowContext: { windowKey: 'main' },
      terminal: { handleResize: jest.fn() },
    });

    expect(controller.enabled).toBe(false);
    expect(dom.doc.getElementById('shellV2TabRail')).toBeNull();
    expect(dom.body.classList.contains('shell-v2-enabled')).toBe(false);
    expect(dom.mainPaneContainer.parentNode).toBe(beforeParent);
    expect(dom.sidePanesContainer.parentNode).toBe(beforeSideParent);
  });

  test('initializes tab rail and reparents panes without cloning them', () => {
    const { doc, body, controller, mainPaneContainer, sidePanesContainer } = initHarness();

    expect(controller.enabled).toBe(true);
    expect(body.classList.contains('shell-v2-enabled')).toBe(true);
    expect(doc.getElementById('shellV2TabRail').children).toHaveLength(3);
    expect(mainPaneContainer.parentNode.dataset.shellV2View).toBe('mira');
    expect(sidePanesContainer.parentNode.id).toBe('shellV2CoreStrip');
    expect(doc.getElementById('settingsBtn').parentNode.id).toBe('shellV2HeaderActions');
    expect(doc.getElementById('fullRestartBtn').parentNode.id).toBe('shellV2HeaderActions');
    expect(doc.getElementById('settingsBtn').hidden).toBe(false);
    expect(doc.getElementById('settingsBtn').style.display).toBe('');
    expect(doc.getElementById('headerSessionBadge').parentNode.classList.contains('status-bar')).toBe(true);
    expect(doc.querySelector('.status-shortcuts')).toBeNull();
  });

  test('removes Shell V2 killed controls and migrates settings into an overlay', () => {
    const { doc } = initHarness();

    expect(doc.getElementById('selectProjectBtn')).toBeNull();
    expect(doc.getElementById('panelBtn')).toBeNull();
    expect(doc.getElementById('openHumanTimelineBtn')).toBeNull();
    expect(doc.getElementById('openSquidRoomBtn')).toBeNull();
    expect(doc.getElementById('openMiraLabBtn')).toBeNull();
    expect(doc.getElementById('rightPanel')).toBeNull();
    expect(doc.querySelector('.panel-tabs')).toBeNull();
    expect(doc.getElementById('settingsPanel')).toBeNull();

    const overlay = doc.getElementById('shellV2SettingsOverlay');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('[data-shell-v2-settings-nav="general"]')).toBeTruthy();
    expect(overlay.querySelector('[data-shell-v2-settings-nav="voice"]')).toBeTruthy();
    expect(overlay.querySelector('[data-shell-v2-settings-nav="secrets"]')).toBeTruthy();
    expect(overlay.querySelector('[data-shell-v2-settings-nav="profile"]')).toBeTruthy();
    expect(overlay.querySelector('#toggleDevTools')).toBeTruthy();
    expect(overlay.querySelector('#togglePaneFailureAlertsEnabled')).toBeTruthy();
    expect(overlay.querySelector('#togglePaneFailureAlertsEnabled').classList.contains('active')).toBe(true);
    expect(overlay.querySelector('#toggleDevMode')).toBeTruthy();
    expect(overlay.querySelector('#voiceBrokerPanel')).toBeTruthy();
    expect(overlay.querySelector('#saveApiKeysBtn')).toBeTruthy();
    expect(overlay.querySelector('#profileModalForm')).toBeTruthy();

    const keyEvent = {
      key: ',',
      ctrlKey: true,
      metaKey: false,
      preventDefault: jest.fn(),
    };
    doc.fire('keydown', keyEvent);
    expect(overlay.classList.contains('open')).toBe(true);
    expect(keyEvent.preventDefault).toHaveBeenCalled();

    const escape = { key: 'Escape', preventDefault: jest.fn() };
    doc.fire('keydown', escape);
    expect(overlay.classList.contains('open')).toBe(false);
  });

  test('keeps killed legacy controls present when the Shell V2 flag is off', () => {
    const dom = createFakeDocument();
    initShellV2({
      document: dom.doc,
      settings: { shellV2Enabled: false },
      windowContext: { windowKey: 'main' },
    });

    expect(dom.doc.getElementById('selectProjectBtn')).toBeTruthy();
    expect(dom.doc.getElementById('panelBtn')).toBeTruthy();
    expect(dom.doc.getElementById('openHumanTimelineBtn')).toBeTruthy();
    expect(dom.doc.getElementById('openSquidRoomBtn')).toBeTruthy();
    expect(dom.doc.getElementById('openMiraLabBtn')).toBeTruthy();
    expect(dom.doc.getElementById('rightPanel')).toBeTruthy();
    expect(dom.doc.querySelector('.panel-tabs')).toBeTruthy();
    expect(dom.doc.getElementById('settingsPanel')).toBeTruthy();
  });

  test('shows the LAB tab only when devMode is enabled', () => {
    const disabled = initHarness({ settings: { shellV2Enabled: true, devMode: false } });
    expect(disabled.doc.getElementById('shellV2TabRail').children).toHaveLength(3);
    expect(disabled.doc.querySelector('[data-shell-v2-tab="lab"]')).toBeNull();

    const enabled = initHarness({ settings: { shellV2Enabled: true, devMode: true } });
    expect(enabled.doc.getElementById('shellV2TabRail').children).toHaveLength(4);
    expect(enabled.doc.querySelector('[data-shell-v2-tab="lab"]')).toBeTruthy();
  });

  test('refreshChrome keeps the bottom bar visible and purges stale shortcut text', () => {
    const { doc, controller } = initHarness();
    const statusBar = doc.querySelector('.status-bar');
    const staleHint = doc.createElement('span');
    staleHint.className = 'status-shortcuts';
    staleHint.textContent = 'Press Ctrl+1-4 to focus pane';
    statusBar.hidden = true;
    statusBar.style.display = 'none';
    statusBar.setAttribute('aria-hidden', 'true');
    statusBar.appendChild(staleHint);

    controller.refreshChrome();

    expect(statusBar.hidden).toBe(false);
    expect(statusBar.style.display).toBe('');
    expect(statusBar.getAttribute('aria-hidden')).toBeNull();
    expect(statusBar.querySelector('.status-shortcuts')).toBeNull();
  });

  test('keeps pane DOM identity and scrollback across 50 programmatic switches', () => {
    const { controller, panes, doc, terminalApi } = initHarness();
    const terminal2 = doc.getElementById('terminal-2');
    const terminal3 = doc.getElementById('terminal-3');
    terminal2.textContent = 'builder scrollback marker';
    terminal3.textContent = 'oracle scrollback marker';
    terminal2.scrollTop = 220;
    terminal3.scrollTop = 330;
    const paneRefs = { ...panes };

    for (let i = 0; i < 50; i += 1) {
      controller.switchTab(i % 3 === 0 ? 'squid-room' : (i % 3 === 1 ? 'mira' : 'today'));
    }

    expect(panes['1']).toBe(paneRefs['1']);
    expect(panes['2']).toBe(paneRefs['2']);
    expect(panes['3']).toBe(paneRefs['3']);
    expect(doc.getElementById('terminal-2')).toBe(terminal2);
    expect(doc.getElementById('terminal-3')).toBe(terminal3);
    expect(terminal2.textContent).toBe('builder scrollback marker');
    expect(terminal3.textContent).toBe('oracle scrollback marker');
    expect(terminal2.scrollTop).toBe(220);
    expect(terminal3.scrollTop).toBe(330);
    expect(terminalApi.handleResize).toHaveBeenCalled();
    expect(terminalApi.spawn).not.toHaveBeenCalled();
    expect(terminalApi.write).not.toHaveBeenCalled();
    expect(terminalApi.kill).not.toHaveBeenCalled();
  });

  test('Ctrl+1/2/3 switches shell tabs before pane-focus shortcuts can run', () => {
    const { doc, controller, terminalApi } = initHarness();
    const makeEvent = (key) => ({
      key,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      stopImmediatePropagation: jest.fn(),
    });

    const toSquidRoom = makeEvent('2');
    const helperTextarea = doc.createElement('textarea');
    helperTextarea.ownerDocument = doc;
    helperTextarea.className = 'xterm-helper-textarea';
    doc.getElementById('terminal-1').appendChild(helperTextarea);
    helperTextarea.focus();

    doc.fire('keydown', toSquidRoom);
    expect(controller.getActiveTab()).toBe('squid-room');
    expect(toSquidRoom.preventDefault).toHaveBeenCalled();
    expect(toSquidRoom.stopImmediatePropagation).toHaveBeenCalled();
    expect(terminalApi.blurAllTerminals).toHaveBeenCalled();
    expect(doc.activeElement).toBe(doc.body);

    const toToday = makeEvent('3');
    doc.fire('keydown', toToday);
    expect(controller.getActiveTab()).toBe('today');

    const toMira = makeEvent('1');
    doc.fire('keydown', toMira);
    expect(controller.getActiveTab()).toBe('mira');
    expect(terminalApi.focusPane).not.toHaveBeenCalled();
  });

  test('Alt+1/2/3 focuses panes through Shell V2 without stealing Ctrl tab ownership', () => {
    const { doc, controller, terminalApi } = initHarness();
    const makeEvent = (key) => ({
      key,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      stopImmediatePropagation: jest.fn(),
    });

    controller.switchTab('today');

    const toBuilder = makeEvent('2');
    doc.fire('keydown', toBuilder);
    expect(controller.getActiveTab()).toBe('squid-room');
    expect(terminalApi.focusPane).toHaveBeenLastCalledWith('2');
    expect(toBuilder.preventDefault).toHaveBeenCalled();
    expect(toBuilder.stopImmediatePropagation).toHaveBeenCalled();

    const toOracle = makeEvent('3');
    doc.fire('keydown', toOracle);
    expect(controller.getActiveTab()).toBe('squid-room');
    expect(terminalApi.focusPane).toHaveBeenLastCalledWith('3');

    const toMira = makeEvent('1');
    doc.fire('keydown', toMira);
    expect(controller.getActiveTab()).toBe('mira');
    expect(terminalApi.focusPane).toHaveBeenLastCalledWith('1');
  });

  test('removes legacy Builder and Oracle expand buttons and reduces station headers', () => {
    const { panes, controller } = initHarness();

    for (const paneId of ['2', '3']) {
      const pane = panes[paneId];
      const header = pane.querySelector('.pane-header');
      expect(pane.querySelector('.expand-btn')).toBeNull();
      expect(pane.querySelector('.agent-badge')).toBeNull();
      expect(header.dataset.shellV2Reduced).toBe('true');
      expect(header.children).toHaveLength(3);
      expect(header.querySelector('.shell-v2-station-chip')).toBeTruthy();
      expect(header.querySelector('.shell-v2-station-chip .cli-badge')).toBeNull();
      expect(header.querySelector('.shell-v2-station-chip .shell-v2-station-separator')).toBeNull();
      expect(header.querySelector('.shell-v2-station-role').textContent).toBe(paneId === '2' ? 'Builder' : 'Oracle');
      expect(header.querySelector('.shell-v2-needs-input-slot').textContent).toBe('');
      expect(header.querySelector('.shell-v2-station-menu')).toBeTruthy();
      expect(header.querySelector(`.interrupt-btn[data-pane-id="${paneId}"]`)).toBeTruthy();
      expect(header.querySelector(`.fresh-session-btn[data-pane-id="${paneId}"]`)).toBeTruthy();
      expect(header.querySelector(`#health-${paneId}`)).toBeTruthy();
    }

    controller.refreshChrome();
    expect(panes['2'].querySelector('.expand-btn')).toBeNull();
    expect(panes['3'].querySelector('.expand-btn')).toBeNull();
  });

  test('reduces the Mira header to chip, needs-input slot, and overflow controls', () => {
    const { panes, controller } = initHarness();
    const pane = panes['1'];
    const header = pane.querySelector('.pane-header');
    const menu = header.querySelector('.shell-v2-mira-menu');
    const panel = menu.querySelector('.shell-v2-station-menu-panel');

    expect(header.dataset.shellV2Reduced).toBe('true');
    expect(header.children).toHaveLength(3);
    expect(header.querySelector('.agent-badge')).toBeNull();
    expect(header.querySelector('.shell-v2-station-chip')).toBeTruthy();
    expect(header.querySelector('.shell-v2-station-chip .cli-badge')).toBeNull();
    expect(header.querySelector('.shell-v2-station-chip .shell-v2-station-separator')).toBeNull();
    expect(header.querySelector('.shell-v2-station-role').textContent).toBe('Mira');
    expect(header.querySelector('.shell-v2-needs-input-slot')).toBeTruthy();
    expect(menu).toBeTruthy();

    const outsideButtons = header.querySelectorAll('button')
      .filter((button) => !button.closest('.shell-v2-station-menu-panel'));
    expect(outsideButtons).toHaveLength(0);
    [
      '.pane-role-info-btn[data-pane-id="1"]',
      '.fresh-session-btn[data-pane-id="1"]',
      '.interrupt-btn[data-pane-id="1"]',
      '.unstick-btn[data-pane-id="1"]',
      '.kickoff-btn[data-pane-id="1"]',
    ].forEach((selector) => {
      expect(panel.querySelector(selector)).toBeTruthy();
    });
    expect(panel.querySelector('#model-selector-1')).toBeNull();
    expect(panel.querySelector('#health-1')).toBeNull();
    expect(panel.querySelector('#lock-icon-1')).toBeNull();

    controller.refreshChrome();
    expect(pane.querySelector('.pane-header').children).toHaveLength(3);
  });

  test('creates the TrustQuote arm section on existing terminal/runtime paths', () => {
    const { doc, terminalApi } = initHarness();
    const section = doc.getElementById('shellV2TrustQuoteSection');
    const panes = section.querySelectorAll('.shell-v2-arm-pane');

    expect(section).toBeTruthy();
    expect(section.querySelector('.shell-v2-arm-section-app').textContent).toBe('TrustQuote');
    expect(section.querySelector('.shell-v2-arm-section-lead').textContent).toBe('Lead');
    expect(section.querySelector('.shell-v2-arm-section-count').textContent).toBe('4 arms');
    expect(section.querySelector('.shell-v2-arm-section-report').textContent).toBe('');
    expect(section.querySelector('[data-shell-v2-lead-report="trustquote-lead"]')).toBeTruthy();
    expect(section.querySelector('.shell-v2-arm-section-lead-report').id).toBe('shellV2TrustQuoteLeadReport');
    expect(panes.map((pane) => pane.dataset.paneId)).toEqual([
      'trustquote-lead',
      'trustquote-schedule-dispatch',
      'trustquote-app',
      'trustquote-invoice',
    ]);
    expect(doc.getElementById('terminal-trustquote-lead')).toBeTruthy();
    expect(terminalApi.setActivePaneIds).toHaveBeenCalledWith(expect.arrayContaining([
      '1',
      '2',
      '3',
      'trustquote-lead',
      'trustquote-app',
    ]));
    expect(terminalApi.setPaneRuntimeOverride).toHaveBeenCalledWith(
      'trustquote-lead',
      expect.objectContaining({
        roleId: 'trustquote-lead',
        routeTarget: 'trustquote-lead',
        spawnCommandOnCreate: true,
        recreateOnWorkingDirMismatch: true,
      })
    );
  });

  test('arm pane click, double-click zoom, collapse, and Escape restore stay in-room', () => {
    const { doc, terminalApi } = initHarness();
    const section = doc.getElementById('shellV2TrustQuoteSection');
    const appPane = section.querySelector('.shell-v2-arm-pane[data-pane-id="trustquote-app"]');
    const toggle = section.querySelector('.shell-v2-arm-section-toggle');

    section.eventListeners.click[0]({ target: appPane });
    expect(appPane.classList.contains('is-main-slot')).toBe(true);
    expect(terminalApi.focusPane).toHaveBeenCalledWith('trustquote-app');

    section.eventListeners.dblclick[0]({ target: appPane });
    expect(section.classList.contains('has-temp-zoom')).toBe(true);
    expect(appPane.classList.contains('is-temp-zoom')).toBe(true);

    const escape = {
      key: 'Escape',
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      stopImmediatePropagation: jest.fn(),
    };
    doc.fire('keydown', escape);
    expect(section.classList.contains('has-temp-zoom')).toBe(false);
    expect(appPane.classList.contains('is-temp-zoom')).toBe(false);
    expect(escape.stopImmediatePropagation).toHaveBeenCalled();

    toggle.eventListeners.click[0]();
    expect(section.classList.contains('is-collapsed')).toBe(true);
    expect(section.querySelector('.shell-v2-arm-panes').hidden).toBe(true);

    terminalApi.refreshPane.mockClear();
    toggle.eventListeners.click[0]();
    expect(section.classList.contains('is-collapsed')).toBe(false);
    expect(terminalApi.refreshPane).toHaveBeenCalledWith(
      'trustquote-lead',
      expect.objectContaining({
        operation: 'shell_v2_arm_reveal',
        forceFit: true,
        forceApply: true,
        resumeRender: true,
        replayDaemonScrollback: true,
      })
    );
  });

  test('renders Today journal rows with counts, compact grammar, and failed-only status accent', async () => {
    const now = new Date('2026-07-07T10:00:00').getTime();
    const todayJournalApi = jest.fn(async () => ({
      ok: true,
      rows: [
        {
          rowId: 102,
          messageId: 'hm-team',
          sessionId: 'app-session-476',
          senderRole: 'architect',
          targetRole: 'builder',
          channel: 'ws',
          direction: 'outbound',
          timestampMs: now,
          rawBody: '[TASK] (Architect): Build the Today tab.',
          status: 'routed',
        },
        {
          rowId: 101,
          messageId: 'hm-james',
          sessionId: 'app-session-476',
          senderRole: 'user',
          targetRole: 'architect',
          channel: 'telegram',
          direction: 'inbound',
          timestampMs: now - 60000,
          rawBody: '[FYI] James sent a field update.',
          status: 'acked',
        },
        {
          rowId: 100,
          messageId: 'hm-system',
          sessionId: 'app-session-475',
          senderRole: 'system',
          targetRole: 'builder',
          channel: 'ws',
          direction: 'outbound',
          timestampMs: now - 120000,
          rawBody: '[SYS] liveness warning',
          status: 'failed',
        },
      ],
    }));
    const { doc, controller } = initHarness({ todayJournalApi });

    await controller.refreshToday({ preserveScroll: false });

    expect(todayJournalApi).toHaveBeenCalledWith(expect.objectContaining({
      dayStartMs: expect.any(Number),
      dayEndMs: expect.any(Number),
      limit: 5000,
    }));
    expect(doc.querySelectorAll('.shell-v2-today-row')).toHaveLength(3);
    expect(doc.querySelector('.shell-v2-today-chip[data-today-filter="all"]').textContent).toBe('All 3');
    expect(doc.querySelector('.shell-v2-today-chip[data-today-filter="team"]').textContent).toBe('Team 1');
    expect(doc.querySelector('.shell-v2-today-chip[data-today-filter="james"]').textContent).toBe('James 1');
    expect(doc.querySelector('.shell-v2-today-chip[data-today-filter="system"]').textContent).toBe('System 1');
    expect(doc.querySelectorAll('.shell-v2-today-party').map((node) => node.textContent)).toEqual([
      'Mira→Builder',
      'James→Mira',
      'System→Builder',
    ]);
    expect(doc.querySelectorAll('.shell-v2-today-origin').map((node) => node.textContent)).toEqual(['⇄', '⇠', 'sys']);
    expect(doc.querySelectorAll('.shell-v2-today-tag').map((node) => node.textContent)).toEqual(['[TASK]', '[FYI]', '[SYS]']);
    expect(doc.querySelectorAll('.shell-v2-today-status.is-failed')).toHaveLength(1);
  });

  test('Today filter, row expansion, and lazy full-file read stay in place', async () => {
    const todayFullMessageApi = jest.fn(async () => ({
      ok: true,
      bytes: 42,
      shaShort: 'abcdef123456',
      content: 'full materialized body',
    }));
    const { doc, controller, clipboardWriteText } = initHarness({
      todayJournalApi: jest.fn(async () => ({
        ok: true,
        rows: [
          {
            rowId: 201,
            messageId: 'hm-team',
            sessionId: 'app-session-476',
            senderRole: 'builder',
            targetRole: 'oracle',
            channel: 'ws',
            direction: 'outbound',
            timestampMs: Date.now(),
            rawBody: '[ACK] Team-only row.',
            status: 'routed',
          },
          {
            rowId: 200,
            messageId: 'hm-james',
            sessionId: 'app-session-476',
            senderRole: 'architect',
            targetRole: 'user',
            channel: 'telegram',
            direction: 'outbound',
            timestampMs: Date.now() - 1000,
            rawBody: '[TASK] FULL MSG AT .squidrun/coord/full-agent-messages/hm-james.txt',
            status: 'routed',
            hasFullFile: true,
          },
        ],
      })),
      todayFullMessageApi,
    });

    await controller.refreshToday({ preserveScroll: false });
    doc.querySelector('.shell-v2-today-chip[data-today-filter="james"]').eventListeners.click[0]();
    expect(doc.querySelectorAll('.shell-v2-today-row')).toHaveLength(1);

    const summary = doc.querySelector('.shell-v2-today-summary');
    summary.eventListeners.click[0]();
    expect(doc.querySelector('.shell-v2-today-raw').textContent).toContain('FULL MSG AT');
    expect(doc.querySelector('.shell-v2-today-footer').textContent).toContain('msgId=hm-james');

    await doc.querySelector('.shell-v2-today-copy-btn[data-today-copy="copy-body"]').eventListeners.click[0]({
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
    await doc.querySelector('.shell-v2-today-copy-btn[data-today-copy="copy-id"]').eventListeners.click[0]({
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
    expect(clipboardWriteText).toHaveBeenNthCalledWith(1, '[TASK] FULL MSG AT .squidrun/coord/full-agent-messages/hm-james.txt');
    expect(clipboardWriteText).toHaveBeenNthCalledWith(2, 'hm-james');

    const fullButton = doc.querySelector('.shell-v2-today-full-btn');
    await fullButton.eventListeners.click[0]({
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    });
    expect(todayFullMessageApi).toHaveBeenCalledWith({ messageId: 'hm-james' });
    expect(doc.querySelector('.shell-v2-today-full-meta').textContent).toBe('42 bytes · sha abcdef123456');
    expect(doc.querySelector('.shell-v2-today-full-raw').textContent).toBe('full materialized body');
  });

  test('Today refresh does not yank scroll and exposes the new-row pill', async () => {
    let rows = [
      {
        rowId: 301,
        messageId: 'hm-old',
        sessionId: 'app-session-476',
        senderRole: 'builder',
        targetRole: 'oracle',
        channel: 'ws',
        direction: 'outbound',
        timestampMs: Date.now(),
        rawBody: '[ACK] Existing row.',
        status: 'routed',
      },
    ];
    const { doc, controller } = initHarness({
      todayJournalApi: jest.fn(async () => ({ ok: true, rows })),
    });

    await controller.refreshToday({ preserveScroll: false });
    const list = doc.querySelector('[data-today-list="true"]');
    list.scrollTop = 120;
    rows = [
      {
        rowId: 302,
        messageId: 'hm-new',
        sessionId: 'app-session-476',
        senderRole: 'oracle',
        targetRole: 'builder',
        channel: 'ws',
        direction: 'inbound',
        timestampMs: Date.now() + 1000,
        rawBody: '[FYI] New row.',
        status: 'routed',
      },
      ...rows,
    ];

    await controller.refreshToday({ preserveScroll: true });
    expect(doc.querySelectorAll('.shell-v2-today-row')).toHaveLength(1);
    const pill = doc.querySelector('[data-today-new-pill="true"]');
    expect(pill.hidden).toBe(false);
    expect(pill.textContent).toBe('1 new ↑');

    pill.eventListeners.click[0]();
    expect(doc.querySelectorAll('.shell-v2-today-row')).toHaveLength(2);
    expect(list.scrollTop).toBe(0);
  });

  test('Today can refresh through the renderer-owned DOM event', async () => {
    let rows = [
      {
        rowId: 401,
        messageId: 'hm-old-event-refresh',
        sessionId: 'app-session-476',
        senderRole: 'builder',
        targetRole: 'oracle',
        channel: 'ws',
        direction: 'outbound',
        timestampMs: Date.now(),
        rawBody: '[ACK] Existing event-refresh row.',
        status: 'routed',
      },
    ];
    const todayJournalApi = jest.fn(async () => ({ ok: true, rows }));
    const { doc } = initHarness({ todayJournalApi });

    doc.dispatchEvent(new doc.defaultView.CustomEvent('shell-v2-refresh-today', {
      detail: { preserveScroll: false },
    }));
    await flushAsyncWork();

    expect(doc.querySelectorAll('.shell-v2-today-row')).toHaveLength(1);
    expect(doc.querySelector('.shell-v2-today-excerpt').textContent).toContain('Existing event-refresh row');

    rows = [
      {
        rowId: 402,
        messageId: 'hm-doorbell-ack',
        sessionId: 'app-session-476',
        senderRole: 'system',
        targetRole: 'architect',
        channel: 'system',
        direction: 'internal',
        timestampMs: Date.now() + 1000,
        rawBody: '[DOORBELL] doorbell_ack pane=squid-room label=squid-room action=ack',
        status: 'recorded',
      },
      ...rows,
    ];

    doc.dispatchEvent(new doc.defaultView.CustomEvent('shell-v2-refresh-today', {
      detail: { preserveScroll: false },
    }));
    await flushAsyncWork();

    expect(todayJournalApi).toHaveBeenLastCalledWith(expect.objectContaining({
      limit: 5000,
    }));
    expect(doc.querySelectorAll('.shell-v2-today-row')).toHaveLength(2);
    expect(doc.querySelector('.shell-v2-today-chip[data-today-filter="system"]').textContent).toBe('System 1');
    expect(doc.querySelector('.shell-v2-today-excerpt').textContent).toContain('doorbell_ack');
  });

  test('doorbell events write system receipts, mark stations, and clear on Squid Room visit', async () => {
    const doorbellJournalApi = jest.fn(async () => ({ ok: true, rowId: 9001 }));
    const { doc, controller, panes } = initHarness({ doorbellJournalApi });

    expect(typeof controller.handleDoorbellPermissionPrompt).toBe('function');
    expect(typeof controller.handleDoorbellLeadEscalationMessage).toBe('function');
    expect(typeof controller.handleDoorbellProcessExit).toBe('function');

    await controller.handleDoorbellPermissionPrompt('2', 'Codex permission prompt detected: approve this command');

    const badge = doc.querySelector('[data-shell-v2-doorbell-badge="squid-room"]');
    const builderHeader = panes['2'].querySelector('.pane-header');
    const builderSlot = builderHeader.querySelector('.shell-v2-needs-input-slot');
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1');
    expect(builderHeader.classList.contains('shell-v2-doorbell-on')).toBe(true);
    expect(builderSlot.textContent).toBe('permission');
    expect(doorbellJournalApi).toHaveBeenCalledWith(expect.objectContaining({
      senderRole: 'system',
      targetRole: 'architect',
      channel: 'system',
      status: 'recorded',
      rawBody: expect.stringContaining('permission_prompt'),
      metadata: expect.objectContaining({
        scope: 'main',
        windowKey: 'main',
        doorbellEvent: 'permission_prompt',
        paneId: '2',
      }),
    }));

    await controller.ackDoorbell({ detail: 'test clear' });

    expect(badge.hidden).toBe(true);
    expect(badge.textContent).toBe('');
    expect(builderHeader.classList.contains('shell-v2-doorbell-on')).toBe(false);
    expect(doorbellJournalApi).toHaveBeenLastCalledWith(expect.objectContaining({
      rawBody: expect.stringContaining('doorbell_ack'),
      metadata: expect.objectContaining({
        doorbellEvent: 'doorbell_ack',
        nextCount: 0,
      }),
    }));
  });

  test('doorbell source probe is available only in the Shell V2 QA profile', async () => {
    const normalJournalApi = jest.fn(async () => ({ ok: true, rowId: 9100 }));
    const normal = initHarness({ doorbellJournalApi: normalJournalApi });
    expect(normal.doc.body.dataset.shellV2DoorbellSourceProbe).toBeUndefined();
    normal.doc.dispatchEvent(new normal.doc.defaultView.CustomEvent('shell-v2-doorbell-source-probe', {
      detail: { eventName: 'permission_prompt', paneId: '2', data: 'Permission prompt: approve this command' },
    }));
    await Promise.resolve();
    expect(normalJournalApi).not.toHaveBeenCalled();

    const qaJournalApi = jest.fn(async () => ({ ok: true, rowId: 9101 }));
    const qa = initHarness({
      windowContext: { windowKey: 'main', profileName: 'shellv2qa' },
      doorbellJournalApi: qaJournalApi,
    });
    expect(qa.doc.body.dataset.shellV2DoorbellSourceProbe).toBe('enabled');
    qa.doc.dispatchEvent(new qa.doc.defaultView.CustomEvent('shell-v2-doorbell-source-probe', {
      detail: { eventName: 'permission_prompt', paneId: '2', data: 'Permission prompt: approve this command' },
    }));
    await Promise.resolve();

    expect(qaJournalApi).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'system',
      rawBody: expect.stringContaining('permission_prompt'),
      metadata: expect.objectContaining({
        doorbellEvent: 'permission_prompt',
        paneId: '2',
      }),
    }));
  });

  test('doorbell source map stays limited to the real event callers', () => {
    expect(DOORBELL_CHOKEPOINT_CALLERS).toEqual([
      { source: 'pty_permission_prompt_detector', eventName: 'permission_prompt' },
      { source: 'lead_escalation_message_parser', eventName: 'lead_escalation' },
      { source: 'pty_process_exit_handler', eventName: 'process_exit' },
      { source: 'squid_room_tab_ack', eventName: 'doorbell_ack' },
    ]);
  });
});
