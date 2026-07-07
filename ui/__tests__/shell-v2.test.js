const {
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
    this.style = {};
    this.id = '';
    this.hidden = false;
    this.scrollTop = 0;
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

  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function createFakeDocument() {
  const listeners = new Map();
  const body = new FakeElement('body');
  const doc = {
    body,
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
  mainContent.appendChild(make('div', { id: 'rightPanel', className: 'right-panel' }));
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
  const actions = make('div', { className: 'pane-actions' });
  if (paneId !== '1') {
    actions.appendChild(make('button', { className: 'pane-action-btn expand-btn', dataset: { paneId } }));
  }
  header.appendChild(actions);
  pane.appendChild(header);
  const terminal = make('div', { id: `terminal-${paneId}`, className: 'pane-terminal', text: `pane ${paneId} scrollback` });
  terminal.scrollTop = Number(paneId) * 10;
  pane.appendChild(terminal);
  return pane;
}

function initHarness({ settings = { shellV2Enabled: true }, env = {}, windowContext = { windowKey: 'main' } } = {}) {
  const dom = createFakeDocument();
  const terminalApi = {
    handleResize: jest.fn(),
    spawn: jest.fn(),
    write: jest.fn(),
    kill: jest.fn(),
  };
  const win = {
    requestAnimationFrame: (fn) => {
      fn();
      return 1;
    },
  };
  const controller = initShellV2({
    document: dom.doc,
    window: win,
    settings,
    env,
    windowContext,
    terminal: terminalApi,
  });
  return { ...dom, terminalApi, controller };
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
    const { doc, controller } = initHarness();
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
    doc.fire('keydown', toSquidRoom);
    expect(controller.getActiveTab()).toBe('squid-room');
    expect(toSquidRoom.preventDefault).toHaveBeenCalled();
    expect(toSquidRoom.stopImmediatePropagation).toHaveBeenCalled();

    const toToday = makeEvent('3');
    doc.fire('keydown', toToday);
    expect(controller.getActiveTab()).toBe('today');

    const toMira = makeEvent('1');
    doc.fire('keydown', toMira);
    expect(controller.getActiveTab()).toBe('mira');
  });

  test('Builder and Oracle expand buttons toggle the core strip, not individual pane expansion', () => {
    const { doc, panes, controller } = initHarness();
    const expandButton = panes['2'].querySelector('.expand-btn');
    const event = {
      target: expandButton,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
      stopImmediatePropagation: jest.fn(),
    };

    doc.fire('click', event);

    expect(controller.isCoreExpanded()).toBe(true);
    expect(doc.getElementById('shellV2CoreStrip').classList.contains('shell-v2-core-expanded')).toBe(true);
    expect(panes['2'].classList.contains('pane-expanded')).toBe(false);
    expect(panes['3'].classList.contains('pane-expanded')).toBe(false);
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
  });
});
