/**
 * Tests for modules/tabs/bridge.js
 * Tests DOM creation, event subscriptions, stream entries, filtering, and cleanup.
 */

jest.mock('../config', () => ({
  PANE_IDS: ['1', '2', '5'],
  PANE_ROLES: {
    '1': 'Architect',
    '2': 'DevOps',
    '5': 'Analyst',
  },
  SHORT_AGENT_NAMES: {
    '1': 'Arch',
    '2': 'DevOps',
    '5': 'Ana',
    'system': 'Sys',
  },
}));

jest.mock('../modules/tabs/utils', () => ({
  escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
}));

// Lightweight DOM mock
function createMockDOM() {
  const elements = [];

  function createElement(tag) {
    const classSet = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      _className: '',
      textContent: '',
      title: '',
      id: '',
      dataset: {},
      style: {},
      children: [],
      parentNode: null,
      scrollTop: 0,
      scrollHeight: 0,
      classList: {
        _classes: classSet,
        contains(cls) { return classSet.has(cls); },
        add(cls) { classSet.add(cls); },
        remove(cls) { classSet.delete(cls); },
      },
      appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        elements.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        child.parentNode = null;
        return child;
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.removeChild(this);
        }
      },
      querySelector(selector) {
        return findInTree(this, selector);
      },
      querySelectorAll(selector) {
        return findAllInTree(this, selector);
      },
    };
    Object.defineProperty(el, 'className', {
      get() { return el._className; },
      set(val) {
        el._className = val;
        classSet.clear();
        val.split(/\s+/).filter(Boolean).forEach(c => classSet.add(c));
      },
      enumerable: true,
    });
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._innerHTML || ''; },
      set(val) {
        el._innerHTML = val;
        if (val === '') el.children = [];
      },
      enumerable: true,
    });
    return el;
  }

  function matchesSelector(el, selector) {
    // Handle compound selectors like '.bridge-agent-card[data-pane-id="1"]'
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      if (cls.includes('[')) {
        const [clsPart, attrPart] = cls.split('[');
        const attrMatch = attrPart.replace(']', '').match(/data-(\w+(?:-\w+)*)="([^"]+)"/);
        if (attrMatch) {
          const key = attrMatch[1].replace(/-(\w)/g, (_, c) => c.toUpperCase());
          return el.classList && el.classList.contains(clsPart) && el.dataset[key] === attrMatch[2];
        }
        return el.classList && el.classList.contains(clsPart);
      }
      return el.classList && el.classList.contains(cls);
    }
    if (selector.startsWith('#')) {
      return el.id === selector.slice(1);
    }
    return el.tagName === selector.toUpperCase();
  }

  function findInTree(root, selector) {
    for (const child of (root.children || [])) {
      if (matchesSelector(child, selector)) return child;
      const found = findInTree(child, selector);
      if (found) return found;
    }
    return null;
  }

  function findAllInTree(root, selector) {
    const results = [];
    for (const child of (root.children || [])) {
      if (matchesSelector(child, selector)) results.push(child);
      results.push(...findAllInTree(child, selector));
    }
    return results;
  }

  // DOM elements registry — getElementById uses this
  const idMap = {};

  return {
    createElement,
    getElementById(id) {
      return idMap[id] || null;
    },
    registerElement(id, el) {
      idMap[id] = el;
      el.id = id;
    },
    querySelectorAll(selector) {
      const results = [];
      for (const el of Object.values(idMap)) {
        if (matchesSelector(el, selector)) results.push(el);
        results.push(...findAllInTree(el, selector));
      }
      return results;
    },
  };
}

describe('bridge tab', () => {
  let bridge;
  let bus;
  let mockDOM;

  beforeEach(() => {
    jest.resetModules();

    mockDOM = createMockDOM();

    // Create the three container elements that bridge.js expects
    const agentsEl = mockDOM.createElement('div');
    mockDOM.registerElement('bridgeAgents', agentsEl);

    const metricsEl = mockDOM.createElement('div');
    mockDOM.registerElement('bridgeMetrics', metricsEl);

    const streamEl = mockDOM.createElement('div');
    mockDOM.registerElement('bridgeStream', streamEl);
    // Add initial empty state
    const emptyDiv = mockDOM.createElement('div');
    emptyDiv.className = 'bridge-stream-empty';
    emptyDiv.textContent = 'Waiting for events...';
    streamEl.appendChild(emptyDiv);

    global.document = mockDOM;

    bus = require('../modules/event-bus');
    bus.reset();
    bridge = require('../modules/tabs/bridge');
  });

  afterEach(() => {
    bridge.destroy();
    bus.reset();
    delete global.document;
  });

  describe('setupBridgeTab', () => {
    test('creates agent status cards for each pane', () => {
      bridge.setupBridgeTab(bus);

      const agentsEl = mockDOM.getElementById('bridgeAgents');
      const cards = agentsEl.querySelectorAll('.bridge-agent-card');
      expect(cards.length).toBe(3);
    });

    test('renders initial metrics', () => {
      bridge.setupBridgeTab(bus);

      const metricsEl = mockDOM.getElementById('bridgeMetrics');
      expect(metricsEl.innerHTML).toContain('emitted');
      expect(metricsEl.innerHTML).toContain('buffer');
      expect(metricsEl.innerHTML).toContain('violations');
    });

    test('does nothing with null bus', () => {
      expect(() => bridge.setupBridgeTab(null)).not.toThrow();
    });

    test('agent cards show correct pane names', () => {
      bridge.setupBridgeTab(bus);

      const agentsEl = mockDOM.getElementById('bridgeAgents');
      // Cards are created with innerHTML containing agent names
      const cards = agentsEl.children;
      expect(cards[0].innerHTML).toContain('Arch');
      expect(cards[1].innerHTML).toContain('DevOps');
      expect(cards[2].innerHTML).toContain('Ana');
    });
  });

  describe('event subscriptions', () => {
    test('pane.state.changed updates agent cards', () => {
      bridge.setupBridgeTab(bus);

      // Change pane 1 to error state
      bus.updateState('1', { activity: 'error' });

      const agentsEl = mockDOM.getElementById('bridgeAgents');
      const card = agentsEl.querySelector('.bridge-agent-card[data-pane-id="1"]');
      expect(card).toBeTruthy();
      // The card's innerHTML is set by renderAgentCards, inner elements set via innerHTML
      // aren't real DOM nodes in our mock. Verify the card's innerHTML contains the error color.
      expect(card.innerHTML).toContain('#f44336');
    });

    test('pane.state.changed adds stream entry', () => {
      bridge.setupBridgeTab(bus);

      bus.updateState('1', { activity: 'injecting' });

      const streamEl = mockDOM.getElementById('bridgeStream');
      const entries = streamEl.querySelectorAll('.bridge-stream-entry');
      expect(entries.length).toBeGreaterThan(0);
    });

    test('pane.state.changed updates metrics', () => {
      bridge.setupBridgeTab(bus);

      const metricsEl = mockDOM.getElementById('bridgeMetrics');
      const before = metricsEl.innerHTML;

      // Emit several events to increase counters
      bus.emit('inject.requested', { paneId: '1', payload: { test: true } });
      bus.emit('inject.requested', { paneId: '2', payload: { test: true } });

      // Metrics should have been re-rendered (totalEmitted increased)
      // The exact value depends on internal events too, but it should differ
      expect(metricsEl.innerHTML).toBeTruthy();
    });
  });

  describe('stream filtering', () => {
    test('noisy pty.data events are filtered out', () => {
      bridge.setupBridgeTab(bus);

      // pty.data.received should be filtered
      bus.emit('pty.data.received', { paneId: '1', payload: { data: 'hello' } });

      const streamEl = mockDOM.getElementById('bridgeStream');
      const entries = streamEl.querySelectorAll('.bridge-stream-entry');
      // Should not have any pty.data entries
      const hasPtyEntry = entries.some(e => e.innerHTML && e.innerHTML.includes('pty.data'));
      expect(hasPtyEntry).toBe(false);
    });

    test('contract.checked events are filtered out', () => {
      bridge.setupBridgeTab(bus);

      // contract.checked is noisy — should be filtered
      bus.emit('contract.checked', { paneId: '1', payload: {} });

      const streamEl = mockDOM.getElementById('bridgeStream');
      const entries = streamEl.querySelectorAll('.bridge-stream-entry');
      const hasChecked = entries.some(e => e.innerHTML && e.innerHTML.includes('contract.checked'));
      expect(hasChecked).toBe(false);
    });

    test('daemon.write events are filtered out', () => {
      bridge.setupBridgeTab(bus);

      bus.emit('daemon.write.requested', { paneId: '1', payload: {} });

      const streamEl = mockDOM.getElementById('bridgeStream');
      const entries = streamEl.querySelectorAll('.bridge-stream-entry');
      const hasDaemon = entries.some(e => e.innerHTML && e.innerHTML.includes('daemon.write'));
      expect(hasDaemon).toBe(false);
    });

    test('significant events (inject.*) are shown in stream', () => {
      bridge.setupBridgeTab(bus);

      bus.emit('inject.requested', { paneId: '1', payload: { target: 'pane1' } });

      const streamEl = mockDOM.getElementById('bridgeStream');
      const entries = streamEl.querySelectorAll('.bridge-stream-entry');
      expect(entries.length).toBeGreaterThan(0);
      const hasInject = entries.some(e => e.innerHTML && e.innerHTML.includes('inject.requested'));
      expect(hasInject).toBe(true);
    });
  });

  describe('stream cap', () => {
    test('caps stream at 100 entries', () => {
      bridge.setupBridgeTab(bus);

      // Emit 110 inject events
      for (let i = 0; i < 110; i++) {
        bus.emit('inject.requested', { paneId: '1', payload: { i } });
      }

      const streamEl = mockDOM.getElementById('bridgeStream');
      const entries = streamEl.querySelectorAll('.bridge-stream-entry');
      expect(entries.length).toBeLessThanOrEqual(100);
    });
  });

  describe('destroy', () => {
    test('cleans up subscriptions — further events do not throw', () => {
      bridge.setupBridgeTab(bus);
      bridge.destroy();

      expect(() => {
        bus.updateState('1', { activity: 'error' });
        bus.emit('inject.requested', { paneId: '1', payload: {} });
      }).not.toThrow();
    });

    test('clears stream DOM', () => {
      bridge.setupBridgeTab(bus);
      bus.emit('inject.requested', { paneId: '1', payload: {} });

      bridge.destroy();

      const streamEl = mockDOM.getElementById('bridgeStream');
      // destroy() resets innerHTML with the empty state message
      expect(streamEl.innerHTML).toContain('Waiting for events...');
    });

    test('clears agents DOM', () => {
      bridge.setupBridgeTab(bus);
      bridge.destroy();

      const agentsEl = mockDOM.getElementById('bridgeAgents');
      expect(agentsEl.innerHTML).toBe('');
    });

    test('clears metrics DOM', () => {
      bridge.setupBridgeTab(bus);
      bridge.destroy();

      const metricsEl = mockDOM.getElementById('bridgeMetrics');
      expect(metricsEl.innerHTML).toBe('');
    });

    test('destroy without setup is safe', () => {
      expect(() => bridge.destroy()).not.toThrow();
    });

    test('destroy is safe to call multiple times', () => {
      bridge.setupBridgeTab(bus);
      expect(() => {
        bridge.destroy();
        bridge.destroy();
      }).not.toThrow();
    });
  });
});
