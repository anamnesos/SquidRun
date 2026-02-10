/**
 * Tests for modules/health-strip.js
 * Tests DOM creation, state change updates, per-pane isolation, and cleanup.
 */

jest.mock('../config', () => ({
  PANE_IDS: ['1', '2', '5'],
  PANE_ROLES: {
    '1': 'Architect',
    '2': 'DevOps',
    '5': 'Analyst',
  },
}));

// Lightweight DOM mock that supports health-strip's usage patterns
function createMockDOM() {
  const elements = [];
  const styleElements = [];

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
      classList: {
        _classes: classSet,
        contains(cls) { return classSet.has(cls); },
        add(cls) { classSet.add(cls); },
        remove(cls) { classSet.delete(cls); },
        toggle(cls, force) {
          if (force === undefined) {
            if (classSet.has(cls)) { classSet.delete(cls); } else { classSet.add(cls); }
          } else if (force) {
            classSet.add(cls);
          } else {
            classSet.delete(cls);
          }
        },
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
    // Sync className setter with classList
    Object.defineProperty(el, 'className', {
      get() { return el._className; },
      set(val) {
        el._className = val;
        classSet.clear();
        val.split(/\s+/).filter(Boolean).forEach(c => classSet.add(c));
      },
      enumerable: true,
    });
    // innerHTML setter clears children
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._innerHTML || ''; },
      set(val) {
        el._innerHTML = val;
        if (val === '') el.children = [];
      },
      enumerable: true,
    });

    // Track style elements
    if (tag === 'style') {
      styleElements.push(el);
    }

    return el;
  }

  function matchesSelector(el, selector) {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      // Handle compound selectors like '.health-strip-pane[data-pane-id="1"]'
      if (cls.includes('[')) {
        const [clsPart, attrPart] = cls.split('[');
        const attrMatch = attrPart.replace(']', '').match(/data-(\w+(?:-\w+)*)="([^"]+)"/);
        if (attrMatch) {
          const key = attrMatch[1].replace(/-(\w)/g, (_, c) => c.toUpperCase()); // kebab to camel
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

  const head = createElement('head');
  const body = createElement('body');

  return {
    createElement,
    head,
    body,
    styleElements,
    querySelectorAll(selector) {
      if (selector === 'style') {
        return styleElements.filter(s => s.parentNode);
      }
      return findAllInTree(body, selector);
    },
  };
}

describe('health-strip', () => {
  let healthStrip;
  let bus;
  let container;
  let mockDOM;

  beforeEach(() => {
    jest.resetModules();
    mockDOM = createMockDOM();
    global.document = mockDOM;
    bus = require('../modules/event-bus');
    bus.reset();
    healthStrip = require('../modules/health-strip');
    container = mockDOM.createElement('div');
    mockDOM.body.appendChild(container);
  });

  afterEach(() => {
    healthStrip.destroy();
    bus.reset();
    delete global.document;
  });

  describe('init', () => {
    test('creates health strip DOM structure with pane indicators', () => {
      healthStrip.init(bus, container);

      const strip = container.querySelector('.health-strip');
      expect(strip).toBeTruthy();

      const panes = strip.querySelectorAll('.health-strip-pane');
      expect(panes.length).toBe(3);
    });

    test('creates labels for each pane', () => {
      healthStrip.init(bus, container);

      const labels = container.querySelectorAll('.health-strip-label');
      expect(labels.length).toBe(3);
      expect(labels[0].textContent).toBe('Arch');
      expect(labels[1].textContent).toBe('DevO');
      expect(labels[2].textContent).toBe('Anal');
    });

    test('creates activity dots for each pane', () => {
      healthStrip.init(bus, container);

      const dots = container.querySelectorAll('.health-strip-dot');
      expect(dots.length).toBe(3);
    });

    test('creates connectivity indicators for each pane', () => {
      healthStrip.init(bus, container);

      const connDots = container.querySelectorAll('.health-strip-conn-dot');
      // 2 per pane (bridge + PTY)
      expect(connDots.length).toBe(6);
    });

    test('initializes with current bus state', () => {
      bus.updateState('1', { activity: 'error' });
      healthStrip.init(bus, container);

      const pane1 = container.querySelector('.health-strip-pane');
      const dot = pane1.querySelector('.health-strip-dot');
      // error color is #f44336
      expect(dot.style.background).toBe('#f44336');
    });

    test('does nothing with null bus', () => {
      expect(() => healthStrip.init(null, container)).not.toThrow();
      expect(container.querySelector('.health-strip')).toBeNull();
    });

    test('does nothing with null container', () => {
      expect(() => healthStrip.init(bus, null)).not.toThrow();
    });

    test('injects CSS styles', () => {
      healthStrip.init(bus, container);
      const styles = mockDOM.querySelectorAll('style');
      const hasHealthStyle = styles.some(s => s.textContent.includes('.health-strip'));
      expect(hasHealthStyle).toBe(true);
    });
  });

  describe('state change updates', () => {
    test('activity state change updates dot color', () => {
      healthStrip.init(bus, container);

      bus.updateState('1', { activity: 'injecting' });

      // Find pane 1's dot
      const panes = container.querySelectorAll('.health-strip-pane');
      const dot = panes[0].querySelector('.health-strip-dot');
      expect(dot.style.background).toBe('#ffeb3b'); // yellow
    });

    test('error activity shows red dot', () => {
      healthStrip.init(bus, container);

      bus.updateState('2', { activity: 'error' });

      const panes = container.querySelectorAll('.health-strip-pane');
      const dot = panes[1].querySelector('.health-strip-dot');
      expect(dot.style.background).toBe('#f44336'); // red
    });

    test('focus locked gate shows L badge', () => {
      healthStrip.init(bus, container);

      bus.updateState('1', { gates: { focusLocked: true } });

      const panes = container.querySelectorAll('.health-strip-pane');
      const badges = panes[0].querySelectorAll('.health-strip-gate');
      expect(badges.length).toBe(1);
      expect(badges[0].textContent).toBe('L');
    });

    test('compacting gate shows C badge with pulse', () => {
      healthStrip.init(bus, container);

      bus.updateState('1', { gates: { compacting: 'confirmed' } });

      const panes = container.querySelectorAll('.health-strip-pane');
      const badges = panes[0].querySelectorAll('.health-strip-gate');
      expect(badges.length).toBe(1);
      expect(badges[0].textContent).toBe('C');
      expect(badges[0].classList.contains('pulse')).toBe(true);
    });

    test('safe mode gate shows S badge', () => {
      healthStrip.init(bus, container);

      bus.updateState('1', { gates: { safeMode: true } });

      const panes = container.querySelectorAll('.health-strip-pane');
      const badges = panes[0].querySelectorAll('.health-strip-gate');
      expect(badges.length).toBe(1);
      expect(badges[0].textContent).toBe('S');
    });

    test('multiple gates show multiple badges', () => {
      healthStrip.init(bus, container);

      bus.updateState('1', { gates: { focusLocked: true, compacting: 'suspected', safeMode: true } });

      const panes = container.querySelectorAll('.health-strip-pane');
      const badges = panes[0].querySelectorAll('.health-strip-gate');
      expect(badges.length).toBe(3);
    });

    test('clearing gates removes badges', () => {
      healthStrip.init(bus, container);

      bus.updateState('1', { gates: { focusLocked: true } });
      let panes = container.querySelectorAll('.health-strip-pane');
      let badges = panes[0].querySelectorAll('.health-strip-gate');
      expect(badges.length).toBe(1);

      bus.updateState('1', { gates: { focusLocked: false } });
      panes = container.querySelectorAll('.health-strip-pane');
      badges = panes[0].querySelectorAll('.health-strip-gate');
      expect(badges.length).toBe(0);
    });

    test('bridge down shows correct connectivity color', () => {
      healthStrip.init(bus, container);

      bus.updateState('1', { connectivity: { bridge: 'down' } });

      const panes = container.querySelectorAll('.health-strip-pane');
      const connDots = panes[0].querySelectorAll('.health-strip-conn-dot');
      expect(connDots[0].style.background).toBe('#f44336'); // red - bridge down
      expect(connDots[1].style.background).toBe('#4caf50'); // green - pty still up
    });
  });

  describe('per-pane isolation', () => {
    test('updating pane 1 state does not affect pane 2', () => {
      healthStrip.init(bus, container);

      bus.updateState('1', { activity: 'error' });

      const panes = container.querySelectorAll('.health-strip-pane');
      const dot1 = panes[0].querySelector('.health-strip-dot');
      const dot2 = panes[1].querySelector('.health-strip-dot');

      expect(dot1.style.background).toBe('#f44336'); // red - error
      expect(dot2.style.background).toBe('#4caf50'); // green - idle (unchanged)
    });
  });

  describe('destroy', () => {
    test('removes strip DOM from container', () => {
      healthStrip.init(bus, container);
      expect(container.querySelector('.health-strip')).toBeTruthy();

      healthStrip.destroy();
      expect(container.querySelector('.health-strip')).toBeNull();
    });

    test('removes style element', () => {
      healthStrip.init(bus, container);
      let styles = mockDOM.querySelectorAll('style');
      const healthStyleBefore = styles.some(s => s.textContent.includes('.health-strip'));
      expect(healthStyleBefore).toBe(true);

      healthStrip.destroy();
      styles = mockDOM.querySelectorAll('style');
      const healthStyleAfter = styles.some(s => s.textContent.includes('.health-strip'));
      expect(healthStyleAfter).toBe(false);
    });

    test('unsubscribes from bus events', () => {
      healthStrip.init(bus, container);
      healthStrip.destroy();

      // Further state changes should not cause errors
      expect(() => {
        bus.updateState('1', { activity: 'error' });
      }).not.toThrow();
    });

    test('destroy is safe to call multiple times', () => {
      healthStrip.init(bus, container);
      expect(() => {
        healthStrip.destroy();
        healthStrip.destroy();
      }).not.toThrow();
    });

    test('destroy without init is safe', () => {
      expect(() => healthStrip.destroy()).not.toThrow();
    });
  });
});
