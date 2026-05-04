const {
  getStorageKey,
  normalizePaneIds,
  readHiddenPaneIds,
  writeHiddenPaneIds,
  initPaneVisibilityControls,
} = require('../modules/pane-visibility');

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.items = new Set();
  }

  add(...classes) {
    for (const className of classes) this.items.add(className);
    this.sync();
  }

  remove(...classes) {
    for (const className of classes) this.items.delete(className);
    this.sync();
  }

  contains(className) {
    return this.items.has(className);
  }

  toggle(className, force) {
    const shouldAdd = force === undefined ? !this.items.has(className) : Boolean(force);
    if (shouldAdd) this.items.add(className);
    else this.items.delete(className);
    this.sync();
    return shouldAdd;
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
    this.dataset = {};
    this.attributes = {};
    this.eventListeners = {};
    this.hidden = false;
    this.id = '';
    this._textContent = '';
    this._innerHTML = '';
    this._className = '';
    this.classList = new FakeClassList(this);
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

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, before) {
    child.parentNode = this;
    const index = this.children.indexOf(before);
    if (index < 0) return this.appendChild(child);
    this.children.splice(index, 0, child);
    return child;
  }

  addEventListener(type, listener) {
    this.eventListeners[type] = this.eventListeners[type] || [];
    this.eventListeners[type].push(listener);
  }

  click() {
    for (const listener of this.eventListeners.click || []) {
      listener({ currentTarget: this });
    }
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      if (matchesSelector(node, selector)) matches.push(node);
      for (const child of node.children || []) visit(child);
    };
    for (const child of this.children) visit(child);
    return matches;
  }
}

function matchesSelector(node, selector) {
  if (selector === '.side-panes-container') return node.classList.contains('side-panes-container');
  if (selector === '.pane-layout') return node.classList.contains('pane-layout');
  if (selector === '.main-pane-container') return node.classList.contains('main-pane-container');
  if (selector === '.command-bar') return node.classList.contains('command-bar');
  if (selector === '.pane-actions') return node.classList.contains('pane-actions');
  if (selector === '.pane-hide-btn') return node.classList.contains('pane-hide-btn');
  if (selector === '.team-focus-btn') return node.classList.contains('team-focus-btn');
  if (selector === '.pane-restore-shelf') return node.classList.contains('pane-restore-shelf');
  const paneMatch = selector.match(/^\.pane\[data-pane-id="(\d+)"\]$/);
  if (paneMatch) {
    return node.classList.contains('pane') && node.dataset.paneId === paneMatch[1];
  }
  const hideMatch = selector.match(/^\.pane-hide-btn\[data-pane-id="(\d+)"\]$/);
  if (hideMatch) {
    return node.classList.contains('pane-hide-btn') && node.dataset.paneId === hideMatch[1];
  }
  const focusMatch = selector.match(/^\.team-focus-btn\[data-pane-id="([^"]+)"\]$/);
  if (focusMatch) {
    return node.classList.contains('team-focus-btn') && node.dataset.paneId === focusMatch[1];
  }
  return false;
}

function createFakeDocument() {
  const elementsById = new Map();
  const body = new FakeElement('body');
  body.dataset.profileName = 'main';
  const layout = new FakeElement('div');
  layout.className = 'pane-layout';
  body.appendChild(layout);
  const mainContainer = new FakeElement('div');
  mainContainer.className = 'main-pane-container';
  layout.appendChild(mainContainer);
  const miraPane = new FakeElement('div');
  miraPane.className = 'pane';
  miraPane.dataset.paneId = '1';
  const miraHeader = new FakeElement('div');
  miraHeader.className = 'pane-header';
  const miraActions = new FakeElement('div');
  miraActions.className = 'pane-actions';
  miraHeader.appendChild(miraActions);
  miraPane.appendChild(miraHeader);
  mainContainer.appendChild(miraPane);

  const sideContainer = new FakeElement('div');
  sideContainer.className = 'side-panes-container';
  layout.appendChild(sideContainer);

  for (const paneId of ['2', '3']) {
    const pane = new FakeElement('div');
    pane.className = 'pane';
    pane.dataset.paneId = paneId;
    const header = new FakeElement('div');
    header.className = 'pane-header';
    const actions = new FakeElement('div');
    actions.className = 'pane-actions';
    header.appendChild(actions);
    pane.appendChild(header);
    sideContainer.appendChild(pane);

    const badge = new FakeElement('span');
    badge.id = `badge-${paneId}`;
    badge.className = 'agent-badge idle';
    elementsById.set(badge.id, badge);

    const task = new FakeElement('span');
    task.id = `task-${paneId}`;
    elementsById.set(task.id, task);

    const health = new FakeElement('span');
    health.id = `health-${paneId}`;
    health.textContent = '-';
    elementsById.set(health.id, health);
  }

  return {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => {
      if (id === 'paneVisibilityRestoreShelf') {
        return body.querySelectorAll('.pane-restore-shelf')[0] || null;
      }
      return elementsById.get(id) || null;
    },
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };
}

function createStorage(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: jest.fn((key) => store.get(key) || null),
    setItem: jest.fn((key, value) => store.set(key, value)),
    dump: () => Object.fromEntries(store.entries()),
  };
}

describe('pane-visibility', () => {
  test('persists only hideable panes per profile', () => {
    const storage = createStorage();

    expect(normalizePaneIds(['1', '2', '3', '2', 'x'])).toEqual(['2', '3']);
    expect(writeHiddenPaneIds(['1', '2'], { storage, profileName: 'eunbyeol' })).toBe(true);
    expect(getStorageKey({ profileName: 'eunbyeol' })).toBe('squidrun:pane-visibility:eunbyeol');
    expect(readHiddenPaneIds({ storage, profileName: 'eunbyeol' })).toEqual(['2', '3']);
    expect(readHiddenPaneIds({ storage, profileName: 'main' })).toEqual([]);
  });

  test('focuses Mira and restores team visually without removing pane state', () => {
    const documentRef = createFakeDocument();
    const storage = createStorage();
    const emitted = [];
    const bus = { emit: jest.fn((type, payload) => emitted.push({ type, payload })) };
    const api = initPaneVisibilityControls({ documentRef, storage, bus, profileName: 'main' });
    const layout = documentRef.querySelector('.pane-layout');
    const sideContainer = documentRef.querySelector('.side-panes-container');
    const miraPane = documentRef.querySelector('.pane[data-pane-id="1"]');
    const miraActions = miraPane.querySelector('.pane-actions');
    const builderPane = documentRef.querySelector('.pane[data-pane-id="2"]');
    const oraclePane = documentRef.querySelector('.pane[data-pane-id="3"]');
    const focusButton = miraActions.querySelector('.team-focus-btn[data-pane-id="team"]');

    expect(focusButton).toBeTruthy();
    focusButton.click();

    expect(builderPane.hidden).toBe(true);
    expect(oraclePane.hidden).toBe(true);
    expect(builderPane.classList.contains('pane-hidden-by-user')).toBe(true);
    expect(oraclePane.classList.contains('pane-hidden-by-user')).toBe(true);
    expect(layout.classList.contains('team-focus-mode')).toBe(true);
    expect(sideContainer.hidden).toBe(true);
    expect(api.getHiddenPaneIds()).toEqual(['2', '3']);
    expect(readHiddenPaneIds({ storage, profileName: 'main' })).toEqual(['2', '3']);
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'pane.visibility.changed',
        payload: expect.objectContaining({
          paneId: '2',
          payload: expect.objectContaining({ visible: false, hiddenByUser: true }),
        }),
      }),
    ]));

    const shelf = documentRef.getElementById('paneVisibilityRestoreShelf');
    expect(shelf.hidden).toBe(true);
    expect(shelf.children).toHaveLength(0);
    focusButton.click();

    expect(builderPane.hidden).toBe(false);
    expect(oraclePane.hidden).toBe(false);
    expect(builderPane.classList.contains('pane-hidden-by-user')).toBe(false);
    expect(oraclePane.classList.contains('pane-hidden-by-user')).toBe(false);
    expect(layout.classList.contains('team-focus-mode')).toBe(false);
    expect(sideContainer.hidden).toBe(false);
    expect(readHiddenPaneIds({ storage, profileName: 'main' })).toEqual([]);
  });

  test('applies stored hidden panes and mirrors activity signals onto restore controls', () => {
    const storage = createStorage({
      'squidrun:pane-visibility:main': JSON.stringify({ version: 1, hiddenPaneIds: ['3'] }),
    });
    const documentRef = createFakeDocument();
    documentRef.getElementById('badge-3').className = 'agent-badge active';
    documentRef.getElementById('task-3').textContent = 'Reading evidence';

    initPaneVisibilityControls({ documentRef, storage, profileName: 'main' });

    const oraclePane = documentRef.querySelector('.pane[data-pane-id="3"]');
    const sideContainer = documentRef.querySelector('.side-panes-container');
    const shelf = documentRef.getElementById('paneVisibilityRestoreShelf');

    expect(oraclePane.hidden).toBe(true);
    expect(documentRef.querySelector('.pane[data-pane-id="2"]').hidden).toBe(true);
    expect(sideContainer.hidden).toBe(true);
    expect(shelf.hidden).toBe(true);
    expect(shelf.children).toHaveLength(0);
  });

  test('marks hidden restore control when existing pane signals change', () => {
    const observers = [];
    class FakeMutationObserver {
      constructor(callback) {
        this.callback = callback;
        observers.push(this);
      }

      observe() {}
      disconnect() {}
    }
    const documentRef = createFakeDocument();
    const storage = createStorage();
    const windowRef = { MutationObserver: FakeMutationObserver };
    const api = initPaneVisibilityControls({ documentRef, storage, windowRef, profileName: 'main' });

    api.hidePane('2');
    observers[0].callback();

    const focusButton = documentRef
      .querySelector('.pane[data-pane-id="1"]')
      .querySelector('.team-focus-btn[data-pane-id="team"]');
    expect(focusButton.classList.contains('has-activity')).toBe(true);

    focusButton.click();
    expect(api.getHiddenPaneIds()).toEqual([]);
  });

  test('force rebind replaces stale controls after renderer reload', () => {
    const documentRef = createFakeDocument();
    const storage = createStorage();

    initPaneVisibilityControls({ documentRef, storage, profileName: 'main' });
    const firstButton = documentRef
      .querySelector('.pane[data-pane-id="1"]')
      .querySelector('.team-focus-btn[data-pane-id="team"]');
    expect(firstButton).toBeTruthy();

    const api = initPaneVisibilityControls({
      documentRef,
      storage,
      profileName: 'main',
      forceRebind: true,
    });
    const buttons = documentRef.querySelectorAll('.team-focus-btn[data-pane-id="team"]');
    const secondButton = buttons[0];

    expect(api).toBeTruthy();
    expect(buttons).toHaveLength(1);
    expect(secondButton).not.toBe(firstButton);
    secondButton.click();
    expect(api.getHiddenPaneIds()).toEqual(['2', '3']);
  });

  test('keyboard shortcut toggles Focus Mira and Show Team', () => {
    const listeners = new Map();
    const windowRef = {
      addEventListener: jest.fn((type, listener) => listeners.set(type, listener)),
      removeEventListener: jest.fn((type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      }),
    };
    const documentRef = createFakeDocument();
    const api = initPaneVisibilityControls({ documentRef, windowRef, profileName: 'main' });
    const preventDefault = jest.fn();

    listeners.get('keydown')({ key: 'm', ctrlKey: true, shiftKey: true, preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(api.getHiddenPaneIds()).toEqual(['2', '3']);

    listeners.get('keydown')({ key: 'M', ctrlKey: true, shiftKey: true, preventDefault });
    expect(api.getHiddenPaneIds()).toEqual([]);
  });
});
