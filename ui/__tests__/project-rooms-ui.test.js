const fs = require('fs');
const path = require('path');

function createFakeElement(id, dataset = {}) {
  const listeners = new Map();
  const classNames = new Set();
  const attributes = {};

  return {
    id,
    dataset: { ...dataset },
    hidden: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    listeners,
    classList: {
      add(name) {
        classNames.add(name);
      },
      remove(name) {
        classNames.delete(name);
      },
      contains(name) {
        return classNames.has(name);
      },
      toggle(name, force) {
        const shouldAdd = force === undefined ? !classNames.has(name) : Boolean(force);
        if (shouldAdd) {
          classNames.add(name);
        } else {
          classNames.delete(name);
        }
        return shouldAdd;
      },
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    addEventListener(event, handler) {
      listeners.set(event, handler);
    },
    removeEventListener(event, handler) {
      if (listeners.get(event) === handler) listeners.delete(event);
    },
    click() {
      const handler = listeners.get('click');
      if (handler) handler({ currentTarget: this });
    },
  };
}

function installRoomDom() {
  const root = createFakeElement('projectRooms', { selectedRoom: 'main' });
  const overview = createFakeElement('projectRoomOverview', { roomId: 'main' });
  const tabs = [
    createFakeElement('room-main', { projectRoomTab: 'main' }),
    createFakeElement('room-trustquote', { projectRoomTab: 'trustquote' }),
    createFakeElement('room-mira-build', { projectRoomTab: 'mira-build' }),
  ];
  const byId = new Map([
    ['projectRooms', root],
    ['projectRoomOverview', overview],
    ...tabs.map((tab) => [tab.id, tab]),
  ]);

  return {
    root,
    overview,
    tabs,
    documentRef: {
      getElementById: jest.fn((id) => byId.get(id) || null),
      querySelectorAll: jest.fn((selector) => (
        selector === '[data-project-room-tab]' ? tabs : []
      )),
    },
  };
}

function installEmptyRoomMountDom() {
  const root = createFakeElement('projectRooms', { selectedRoom: 'main' });
  const byId = new Map([['projectRooms', root]]);
  let tabs = [];
  let shellHtml = '';

  Object.defineProperty(root, 'innerHTML', {
    get() {
      return shellHtml;
    },
    set(value) {
      shellHtml = String(value || '');
      if (!shellHtml.includes('data-project-room-tab')) {
        tabs = [];
        byId.delete('projectRoomOverview');
        return;
      }
      const overview = createFakeElement('projectRoomOverview', { roomId: 'main' });
      tabs = ['main', 'trustquote', 'mira-build'].map((roomId) => createFakeElement(`room-${roomId}`, {
        projectRoomTab: roomId,
      }));
      byId.set('projectRoomOverview', overview);
      for (const tab of tabs) {
        byId.set(tab.id, tab);
      }
    },
  });

  return {
    root,
    get overview() {
      return byId.get('projectRoomOverview') || null;
    },
    get tabs() {
      return tabs;
    },
    documentRef: {
      getElementById: jest.fn((id) => byId.get(id) || null),
      querySelectorAll: jest.fn((selector) => (
        selector === '[data-project-room-tab]' ? tabs : []
      )),
    },
  };
}

function installNoRoomMountDom() {
  return {
    documentRef: {
      getElementById: jest.fn(() => null),
      querySelectorAll: jest.fn(() => []),
    },
  };
}

describe('project room registry and switcher', () => {
  let projectRooms;
  const oldInternalVisibleCopy = [
    /\bPayload\b/i,
    /\bTransport\b/i,
    /Main lane authority/i,
    /Cross-room publish/i,
    /Source authority/i,
    /Prototype\/archive/i,
  ];

  beforeEach(() => {
    jest.resetModules();
    projectRooms = require('../modules/project-rooms');
  });

  afterEach(() => {
    delete global.window;
  });

  test('exposes exactly the reviewed room ids and excludes unreviewed rooms', () => {
    expect(projectRooms.getProjectRoomIds()).toEqual(['main', 'trustquote', 'mira-build']);
    expect(projectRooms.getProjectRoomIds()).not.toContain('plumbhalo');
    expect(projectRooms.getProjectRooms().map((room) => room.label)).toEqual([
      'Main',
      'TrustQuote',
      'Mira Build',
    ]);
  });

  test('explicit debug mount exposes Main, TrustQuote, and Mira Build with Main selected by default', () => {
    const dom = installRoomDom();

    const controller = projectRooms.initProjectRooms({
      documentRef: dom.documentRef,
      windowContext: { windowKey: 'main', profileName: 'main' },
    });

    expect(controller.ok).toBe(true);
    expect(controller.disabled).toBeUndefined();
    expect(controller.getSelectedRoomId()).toBe('main');
    expect(dom.root.hidden).toBe(false);
    expect(dom.root.classList.contains('project-rooms-hidden')).toBe(false);
    expect(dom.root.getAttribute('aria-hidden')).toBe('false');
    expect(dom.root.dataset.selectedRoom).toBe('main');
    expect(dom.overview.dataset.roomId).toBe('main');
    expect(dom.overview.innerHTML).toContain('Current work');
    expect(dom.overview.innerHTML).toContain('data-room-card="main"');
    expect(dom.overview.innerHTML).toContain('data-room-card="trustquote"');
    expect(dom.overview.innerHTML).toContain('data-room-card="mira-build"');
    expect(dom.overview.innerHTML).toContain('Main');
    expect(dom.overview.innerHTML).toContain('TrustQuote');
    expect(dom.overview.innerHTML).toContain('Mira Build');
    expect(dom.overview.innerHTML).toContain('JAMES ACTION: NONE');
    expect(dom.overview.innerHTML.match(/JAMES ACTION:/g)).toHaveLength(1);
    expect(dom.tabs[0].classList.contains('active')).toBe(true);
    expect(dom.tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  test('Project Rooms shell can be generated for a non-default debug/status surface', () => {
    const shellHtml = projectRooms._internals.buildProjectRoomsShellHtml('main');

    expect(shellHtml).toContain('data-project-room-tab="main"');
    expect(shellHtml).toContain('data-project-room-tab="trustquote"');
    expect(shellHtml).toContain('data-project-room-tab="mira-build"');
    expect(shellHtml).toMatch(/>Main<[\s\S]*>TrustQuote<[\s\S]*>Mira Build</);
  });

  test('explicit debug/status mount initializes tabs from an empty mount point', () => {
    const dom = installEmptyRoomMountDom();

    const controller = projectRooms.initProjectRooms({
      documentRef: dom.documentRef,
      windowContext: { windowKey: 'main', profileName: 'main' },
    });

    expect(controller.ok).toBe(true);
    expect(controller.getSelectedRoomId()).toBe('main');
    expect(dom.root.hidden).toBe(false);
    expect(dom.root.classList.contains('project-rooms-hidden')).toBe(false);
    expect(dom.root.innerHTML).toContain('data-project-room-tab="main"');
    expect(dom.root.innerHTML).toContain('data-project-room-tab="trustquote"');
    expect(dom.root.innerHTML).toContain('data-project-room-tab="mira-build"');
    expect(dom.tabs).toHaveLength(3);
    expect(dom.overview.innerHTML).toContain('Current work');
  });

  test('default shell absence leaves Project Rooms module inert', () => {
    const dom = installNoRoomMountDom();

    const controller = projectRooms.initProjectRooms({
      documentRef: dom.documentRef,
      windowContext: { windowKey: 'main', profileName: 'main' },
    });

    expect(controller.ok).toBe(false);
    expect(controller.reason).toBe('missing_project_rooms_root');
    expect(dom.documentRef.getElementById).toHaveBeenCalledWith('projectRooms');
    expect(dom.documentRef.querySelectorAll).not.toHaveBeenCalled();
  });

  test('switching rooms only changes DOM state and calls no side-effect APIs', () => {
    const dom = installRoomDom();
    const invoke = jest.fn();
    const send = jest.fn();
    const fetch = jest.fn();
    global.window = { squidrun: { invoke, send }, fetch };

    const controller = projectRooms.initProjectRooms({ documentRef: dom.documentRef });
    dom.tabs[1].click();

    expect(controller.getSelectedRoomId()).toBe('trustquote');
    expect(dom.root.dataset.selectedRoom).toBe('trustquote');
    expect(dom.overview.innerHTML).toContain('TrustQuote readiness');
    expect(dom.overview.innerHTML).toContain('Project: D:/projects/TrustQuote');
    expect(dom.overview.innerHTML).toContain('Status: preview only');
    expect(dom.overview.innerHTML).toContain('Review required before launch');
    expect(invoke).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    dom.tabs[2].click();

    expect(controller.getSelectedRoomId()).toBe('mira-build');
    expect(dom.root.dataset.selectedRoom).toBe('mira-build');
    expect(dom.overview.innerHTML).toContain('Mira implementation evidence and blockers');
    expect(dom.overview.innerHTML).toContain('Voice and A3/A4 remain blocked');
    expect(invoke).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('Eunbyeol and side-profile contexts hide Project Rooms before preview rooms render', () => {
    const sideContexts = [
      { windowContext: { windowKey: 'eunbyeol', profileName: 'eunbyeol', sessionScopeId: 'case-scope' } },
      { windowContext: { windowKey: 'main', profileName: 'eunbyeol', sessionScopeId: 'case-scope' } },
      { locationSearch: '?windowKey=eunbyeol&profileName=eunbyeol&sessionScopeId=case-scope' },
    ];

    for (const sideContext of sideContexts) {
      const dom = installRoomDom();

      const controller = projectRooms.initProjectRooms({
        documentRef: dom.documentRef,
        ...sideContext,
      });

      expect(controller.ok).toBe(true);
      expect(controller.disabled).toBe(true);
      expect(controller.reason).toBe(projectRooms.SIDE_PROFILE_DISABLED_REASON);
      expect(controller.getSelectedRoomId()).toBeNull();
      expect(controller.selectRoom('trustquote')).toBeNull();
      expect(dom.root.hidden).toBe(true);
      expect(dom.root.classList.contains('project-rooms-hidden')).toBe(true);
      expect(dom.root.dataset.disabledReason).toBe(projectRooms.SIDE_PROFILE_DISABLED_REASON);
      expect(dom.root.getAttribute('aria-hidden')).toBe('true');
      expect(dom.root.innerHTML).toBe('');
      expect(dom.overview.dataset.roomId).toBe('');
      expect(dom.overview.innerHTML).toBe('');
      expect(dom.overview.innerHTML).not.toMatch(/TrustQuote|Mira Build/);

      for (const tab of dom.tabs) {
        expect(tab.disabled).toBe(true);
        expect(tab.getAttribute('aria-disabled')).toBe('true');
        expect(tab.getAttribute('aria-selected')).toBe('false');
        expect(tab.getAttribute('tabindex')).toBe('-1');
      }

      dom.tabs[1].click();

      expect(controller.getSelectedRoomId()).toBeNull();
      expect(dom.overview.innerHTML).toBe('');
      expect(dom.overview.innerHTML).not.toMatch(/TrustQuote|Mira Build/);
    }
  });

  test('visible room copy stays product-facing and avoids old internal wording', () => {
    const visibleMarkup = projectRooms.getProjectRoomIds()
      .map((roomId) => projectRooms.buildRoomOverviewHtml(roomId))
      .join('\n');

    for (const pattern of oldInternalVisibleCopy) {
      expect(visibleMarkup).not.toMatch(pattern);
    }
  });

  test('room registry module does not include send, routing, restart, or project mutation calls', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'project-rooms.js'), 'utf8');

    expect(source).not.toMatch(/hm-send|sendAgentMessage|sendDirectMessage/);
    expect(source).not.toMatch(/fetch\s*\(|squidrun\.(invoke|send)/);
    expect(source).not.toMatch(/setContext|project:set-context|projectContext/);
    expect(source).not.toMatch(/restart|relaunch|routeOwner|telegram/i);
  });

  test('Main does not accept other room refs as lane authority', () => {
    expect(projectRooms.resolveMainLaneAuthority({
      sourceRoomId: 'trustquote',
      sourceRef: 'trustquote#12',
    })).toEqual({
      canUseAsAuthority: false,
      sourceRoomId: 'trustquote',
      sourceRef: 'trustquote#12',
      reason: 'cross_room_preview_only',
    });

    expect(projectRooms.resolveMainLaneAuthority({
      sourceRoomId: 'mira-build',
      sourceRef: 'mira-build#8',
    }).canUseAsAuthority).toBe(false);

    expect(projectRooms.resolveMainLaneAuthority({
      sourceRoomId: 'main',
      sourceRef: 'architect#173',
    })).toEqual({
      canUseAsAuthority: true,
      sourceRoomId: 'main',
      sourceRef: 'architect#173',
      reason: 'main_room_source',
    });
  });

  test('default live shell has no Project Rooms mount, tabs, cards, or reserved header slot', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const mainContentIndex = html.indexOf('class="main-content"');
    const stateBarIndex = html.indexOf('class="state-bar"');
    const rightPanelIndex = html.indexOf('id="rightPanel"');
    const panelTabsStart = html.indexOf('class="panel-tabs"');
    const panelTabsEnd = html.indexOf('class="panel-content"');
    const panelTabsHtml = html.slice(panelTabsStart, panelTabsEnd);
    const preMainHtml = html.slice(0, mainContentIndex);
    const postStatePreMainHtml = html.slice(stateBarIndex, mainContentIndex);

    expect(mainContentIndex).toBeGreaterThan(-1);
    expect(stateBarIndex).toBeGreaterThan(-1);
    expect(stateBarIndex).toBeLessThan(mainContentIndex);
    expect(rightPanelIndex).toBeGreaterThan(mainContentIndex);
    expect(html).not.toContain('id="projectRooms"');
    expect(preMainHtml).not.toContain('class="project-rooms');
    expect(preMainHtml).not.toContain('data-project-room-tab');
    expect(preMainHtml).not.toContain('project-room-switcher');
    expect(preMainHtml).not.toContain('project-room-overview');
    expect(preMainHtml).not.toContain('data-room-card=');
    expect(preMainHtml).not.toMatch(/>Main<|>TrustQuote<|>Mira Build/);
    expect(postStatePreMainHtml).not.toContain('<section');
    expect(panelTabsHtml).toContain('data-tab="bridge"');
    expect(panelTabsHtml).toContain('data-tab="comms"');
    expect(panelTabsHtml).toContain('data-tab="screenshots"');
    expect(panelTabsHtml).not.toContain('data-project-room-tab');
    expect(html.toLowerCase()).not.toContain('plumbhalo');
  });

  test('hidden Project Rooms CSS collapses the mount to zero footprint', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'project-rooms.css'), 'utf8');
    const hiddenRuleMatch = css.match(/\.project-rooms\[hidden\],[\s\S]*?\.project-rooms\.project-rooms-hidden\s*\{([\s\S]*?)\}/);

    expect(hiddenRuleMatch).not.toBeNull();
    const hiddenRule = hiddenRuleMatch ? hiddenRuleMatch[1] : '';

    expect(hiddenRule).toMatch(/display:\s*none\s*!important/);
    expect(hiddenRule).toMatch(/flex:\s*0\s+0\s+0\s*!important/);
    expect(hiddenRule).toMatch(/min-height:\s*0\s*!important/);
    expect(hiddenRule).toMatch(/height:\s*0\s*!important/);
    expect(hiddenRule).toMatch(/padding:\s*0\s*!important/);
    expect(hiddenRule).toMatch(/margin:\s*0\s*!important/);
    expect(hiddenRule).toMatch(/border:\s*0\s*!important/);
    expect(hiddenRule).toMatch(/gap:\s*0\s*!important/);
    expect(hiddenRule).toMatch(/overflow:\s*hidden\s*!important/);
  });
});
