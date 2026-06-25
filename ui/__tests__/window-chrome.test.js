'use strict';

const {
  CHROME_ALLOWLIST,
  CHROME_CONTROL_IDS,
  CHROME_REGION_SELECTORS,
  WINDOW_CHROME_CLASSES,
  applyWindowChrome,
  resolveWindowChromeClass,
} = require('../modules/window-chrome');

class FakeElement {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.style = {
      display: '',
      removeProperty(prop) { if (prop === 'display') this.display = ''; },
    };
    this.attributes = {};
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  removeAttribute(name) { delete this.attributes[name]; }
}

// Minimal document covering the chrome registry: header action ids plus the
// region selectors (right panel, status bar, project indicator) and the
// always-rendered session badge.
function buildHeaderDoc() {
  const byId = new Map();
  const bySelector = new Map();
  for (const id of [...CHROME_CONTROL_IDS, 'headerSessionBadge']) {
    byId.set(id, new FakeElement(id));
  }
  for (const selector of Object.values(CHROME_REGION_SELECTORS)) {
    bySelector.set(selector, new FakeElement(selector));
  }
  return {
    elements: { byId, bySelector },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(selector) {
      if (bySelector.has(selector)) return bySelector.get(selector);
      if (selector.startsWith('#')) return byId.get(selector.slice(1)) || null;
      return null;
    },
  };
}

function visible(doc, key) {
  const el = doc.getElementById(key) || doc.querySelector(key);
  return el ? el.hidden === false : null;
}

describe('window chrome matrix', () => {
  describe('class resolution', () => {
    test('main operator window', () => {
      expect(resolveWindowChromeClass({ windowKey: 'main', profileName: 'main' }))
        .toBe(WINDOW_CHROME_CLASSES.MAIN);
      expect(resolveWindowChromeClass({})).toBe(WINDOW_CHROME_CLASSES.MAIN);
    });

    test('pinned installed main window uses installed operator chrome', () => {
      expect(resolveWindowChromeClass({
        windowKey: 'main',
        profileName: 'main',
        installedDeploymentWindow: true,
      })).toBe(WINDOW_CHROME_CLASSES.INSTALLED_OPERATOR);
      expect(resolveWindowChromeClass({
        windowKey: 'main',
        profileName: 'main',
        standaloneWindow: true,
      })).toBe(WINDOW_CHROME_CLASSES.INSTALLED_OPERATOR);
    });

    test('squid room window', () => {
      expect(resolveWindowChromeClass({ windowKey: 'squid-room', profileName: 'main' }))
        .toBe(WINDOW_CHROME_CLASSES.SQUID_ROOM);
    });

    test('client profile window (the live Eunbyeol launch shape)', () => {
      // Eunbyeol launches: --profile=eunbyeol --window=eunbyeol --standalone-window
      expect(resolveWindowChromeClass({
        windowKey: 'eunbyeol',
        profileName: 'eunbyeol',
        standaloneWindow: true,
      })).toBe(WINDOW_CHROME_CLASSES.CLIENT_PROFILE);
      expect(resolveWindowChromeClass({ windowKey: 'eunbyeol', profileName: 'eunbyeol' }))
        .toBe(WINDOW_CHROME_CLASSES.CLIENT_PROFILE);
    });

  });

  describe('allow-list application (default-deny)', () => {
    test('main renders full chrome', () => {
      const doc = buildHeaderDoc();
      const result = applyWindowChrome(doc, WINDOW_CHROME_CLASSES.MAIN);
      expect(result.ok).toBe(true);
      for (const id of CHROME_CONTROL_IDS) expect(visible(doc, id)).toBe(true);
      expect(visible(doc, '#rightPanel')).toBe(true);
      expect(visible(doc, '.status-bar')).toBe(true);
      expect(visible(doc, '.project-indicator')).toBe(true);
    });

    test('squid room renders only the Close affordance - no operator chrome, no status strip', () => {
      const doc = buildHeaderDoc();
      applyWindowChrome(doc, WINDOW_CHROME_CLASSES.SQUID_ROOM);
      expect(visible(doc, 'fullRestartBtn')).toBe(true);
      for (const id of CHROME_CONTROL_IDS.filter((x) => x !== 'fullRestartBtn')) {
        expect(visible(doc, id)).toBe(false);
      }
      expect(visible(doc, '#rightPanel')).toBe(false);
      // The status strip advertises main-window semantics that are lies in
      // the room (Ctrl+1-4 / Enter-to-Mira) - it must not render.
      expect(visible(doc, '.status-bar')).toBe(false);
      expect(visible(doc, '.project-indicator')).toBe(false);
      // Session badge is unregistered chrome - untouched, always renders.
      expect(visible(doc, 'headerSessionBadge')).toBe(true);
    });

    test('client window shows Quit + Profile only - no operator surface leaks to Eunbyeol', () => {
      const doc = buildHeaderDoc();
      applyWindowChrome(doc, WINDOW_CHROME_CLASSES.CLIENT_PROFILE);
      expect(visible(doc, 'fullRestartBtn')).toBe(true);
      expect(visible(doc, 'profileBtn')).toBe(true);
      // Product-boundary controls a client must never see:
      for (const id of ['selectProjectBtn', 'settingsBtn', 'openSquidRoomBtn', 'openMiraLabBtn', 'panelBtn', 'dryRunIndicator', 'ciStatusIndicator']) {
        expect(visible(doc, id)).toBe(false);
      }
      expect(visible(doc, '#rightPanel')).toBe(false);
      expect(visible(doc, '.status-bar')).toBe(false);
    });

    test('installed operator drops cross-product launchers and keeps maintenance chrome', () => {
      const doc = buildHeaderDoc();
      applyWindowChrome(doc, WINDOW_CHROME_CLASSES.INSTALLED_OPERATOR);

      for (const id of ['openSquidRoomBtn', 'openMiraLabBtn']) {
        expect(visible(doc, id)).toBe(false);
      }
      for (const id of CHROME_CONTROL_IDS.filter((x) => !['openSquidRoomBtn', 'openMiraLabBtn'].includes(x))) {
        expect(visible(doc, id)).toBe(true);
      }
      for (const selector of Object.values(CHROME_REGION_SELECTORS)) {
        expect(visible(doc, selector)).toBe(true);
      }
    });

    test('work room shows Close only', () => {
      const doc = buildHeaderDoc();
      applyWindowChrome(doc, WINDOW_CHROME_CLASSES.WORK_ROOM);
      expect(visible(doc, 'fullRestartBtn')).toBe(true);
      for (const id of CHROME_CONTROL_IDS.filter((x) => x !== 'fullRestartBtn')) {
        expect(visible(doc, id)).toBe(false);
      }
      expect(visible(doc, '#rightPanel')).toBe(false);
    });

    test('Mira Lab renders in MAIN only (ruling of record, S426)', () => {
      for (const [cls, expected] of [
        [WINDOW_CHROME_CLASSES.MAIN, true],
        [WINDOW_CHROME_CLASSES.SQUID_ROOM, false],
        [WINDOW_CHROME_CLASSES.CLIENT_PROFILE, false],
        [WINDOW_CHROME_CLASSES.INSTALLED_OPERATOR, false],
        [WINDOW_CHROME_CLASSES.WORK_ROOM, false],
      ]) {
        const doc = buildHeaderDoc();
        applyWindowChrome(doc, cls);
        expect(visible(doc, 'openMiraLabBtn')).toBe(expected);
      }
    });

    test('unknown class falls back to main chrome rather than blanking a window', () => {
      const doc = buildHeaderDoc();
      const result = applyWindowChrome(doc, 'mystery-window');
      expect(result.ok).toBe(true);
      for (const id of CHROME_CONTROL_IDS) expect(visible(doc, id)).toBe(true);
    });

    test('missing elements are skipped, never thrown on', () => {
      const emptyDoc = { getElementById: () => null, querySelector: () => null };
      const result = applyWindowChrome(emptyDoc, WINDOW_CHROME_CLASSES.SQUID_ROOM);
      expect(result.ok).toBe(true);
    });
  });

  test('the matrix itself stays explicit: every class names its lists', () => {
    for (const cls of Object.values(WINDOW_CHROME_CLASSES)) {
      expect(CHROME_ALLOWLIST[cls]).toBeDefined();
      expect(Array.isArray(CHROME_ALLOWLIST[cls].controls)).toBe(true);
      expect(Array.isArray(CHROME_ALLOWLIST[cls].regions)).toBe(true);
    }
    expect(Object.keys(CHROME_REGION_SELECTORS)).toEqual(
      expect.arrayContaining(['right_panel', 'status_bar', 'project_indicator'])
    );
  });
});
