jest.mock('../modules/renderer-bridge', () => ({
  invokeBridge: jest.fn().mockResolvedValue({ rows: [] }),
}));

jest.mock('../config', () => ({
  PANE_ROLES: {
    '1': 'Architect',
    '2': 'Builder',
    '3': 'Oracle',
  },
  SHORT_AGENT_NAMES: {
    '1': 'Arch',
    '2': 'Builder',
    '3': 'Oracle',
    system: 'Sys',
  },
  ROLE_ID_MAP: {
    architect: '1',
    builder: '2',
    oracle: '3',
  },
  resolveBackgroundBuilderAlias(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (/^builder-bg-\d+$/.test(normalized)) return normalized;
    const match = normalized.match(/^bg-2-(\d+)$/);
    if (match && match[1]) return `builder-bg-${match[1]}`;
    return null;
  },
}));

jest.mock('../modules/tabs/utils', () => ({
  escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
}));

function createElement(tag = 'div') {
  const classSet = new Set();
  const listeners = new Map();
  const element = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '',
    _innerHTML: '',
    _className: '',
    children: [],
    parentElement: null,
    scrollTop: 0,
    scrollHeight: 0,
    dataset: {},
    classList: {
      add(...names) {
        names.filter(Boolean).forEach((name) => classSet.add(name));
        element._className = Array.from(classSet).join(' ');
      },
      remove(...names) {
        names.filter(Boolean).forEach((name) => classSet.delete(name));
        element._className = Array.from(classSet).join(' ');
      },
      contains(name) {
        return classSet.has(name);
      },
    },
    appendChild(child) {
      if (!child) return child;
      child.parentElement = element;
      element.children.push(child);
      element.scrollHeight = element.children.length * 20;
      return child;
    },
    prepend(child) {
      if (!child) return child;
      child.parentElement = element;
      element.children.unshift(child);
      element.scrollHeight = element.children.length * 20;
      return child;
    },
    remove() {
      if (!element.parentElement) return;
      const siblings = element.parentElement.children;
      const idx = siblings.indexOf(element);
      if (idx >= 0) siblings.splice(idx, 1);
      element.parentElement = null;
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
      listeners.set(type, list);
    },
    querySelector(selector) {
      if (typeof selector !== 'string' || !selector.startsWith('.')) return null;
      const className = selector.slice(1);
      const queue = [...element.children];
      while (queue.length > 0) {
        const current = queue.shift();
        if (current.classList?.contains(className)) return current;
        queue.push(...(current.children || []));
      }
      return null;
    },
  };

  Object.defineProperty(element, 'className', {
    get() {
      return element._className;
    },
    set(value) {
      classSet.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classSet.add(name));
      element._className = Array.from(classSet).join(' ');
    },
    enumerable: true,
  });

  Object.defineProperty(element, 'innerHTML', {
    get() {
      return element._innerHTML;
    },
    set(value) {
      element._innerHTML = String(value || '');
      if (element._innerHTML === '') {
        element.children = [];
      }
    },
    enumerable: true,
  });

  Object.defineProperty(element, 'firstElementChild', {
    get() {
      return element.children[0] || null;
    },
    enumerable: true,
  });

  return element;
}

function createMockDocument() {
  const nodesById = new Map();
  const tabButton = createElement('button');
  const tabPane = createElement('div');

  tabButton.dataset = { tab: 'comms' };
  tabPane.className = '';

  return {
    createElement,
    getElementById(id) {
      return nodesById.get(id) || null;
    },
    registerById(id, node) {
      node.id = id;
      nodesById.set(id, node);
    },
    querySelector(selector) {
      if (selector === '.panel-tab[data-tab="comms"]') return tabButton;
      if (selector === '#commsConsoleList .comms-console-history-loading') return null;
      return null;
    },
    tabButton,
    tabPane,
  };
}

function createMockBus() {
  let commsHandler = null;
  return {
    on: jest.fn((type, fn) => {
      if (type === 'comms.*') commsHandler = fn;
    }),
    off: jest.fn((type, fn) => {
      if (type === 'comms.*' && commsHandler === fn) commsHandler = null;
    }),
    emitComms(event) {
      if (commsHandler) commsHandler(event);
    },
  };
}

describe('comms-console background builder rendering', () => {
  let documentMock;
  let commsConsole;
  let bus;

  beforeEach(() => {
    jest.resetModules();
    documentMock = createMockDocument();

    const list = createElement('div');
    const pane = createElement('div');
    documentMock.registerById('commsConsoleList', list);
    documentMock.registerById('tab-comms', pane);

    global.document = documentMock;
    global.requestAnimationFrame = (cb) => {
      cb();
      return 1;
    };

    bus = createMockBus();
    commsConsole = require('../modules/tabs/comms-console');
  });

  afterEach(() => {
    if (commsConsole && typeof commsConsole.destroy === 'function') {
      commsConsole.destroy();
    }
    delete global.document;
    delete global.requestAnimationFrame;
  });

  test('maps background builder pane IDs to dedicated sender classes', () => {
    commsConsole.setupCommsConsoleTab(bus);

    bus.emitComms({
      type: 'comms.delivery',
      payload: {
        senderRole: 'bg-2-2',
        targetRole: 'builder',
        message: '(BUILDER-BG-2 #3): task accepted',
      },
      ts: Date.now(),
    });

    const list = global.document.getElementById('commsConsoleList');
    expect(list.children.length).toBe(1);
    const entry = list.children[0];
    expect(entry.classList.contains('sender-builder-bg')).toBe(true);
    expect(entry.classList.contains('sender-builder-bg-2')).toBe(true);
    expect(entry.innerHTML).toContain('role-builder-bg');
    expect(entry.innerHTML).toContain('Builder BG-2');
  });

  test('infers background builder sender from body when metadata roles are missing', () => {
    commsConsole.setupCommsConsoleTab(bus);

    bus.emitComms({
      type: 'comms.delivery',
      payload: {
        message: '(BUILDER-BG-1 #9): completed scoped fix',
      },
      ts: Date.now(),
    });

    const list = global.document.getElementById('commsConsoleList');
    expect(list.children.length).toBe(1);
    const entry = list.children[0];
    expect(entry.classList.contains('sender-builder-bg')).toBe(true);
    expect(entry.classList.contains('sender-builder-bg-1')).toBe(true);
    expect(entry.innerHTML).toContain('Builder BG-1');
  });
});
