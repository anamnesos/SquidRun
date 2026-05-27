const fs = require('fs');
const path = require('path');

function createFakeElement(id, dataset = {}) {
  const listeners = new Map();
  const classNames = new Set();
  const attributes = {};

  return {
    id,
    dataset: { ...dataset },
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

describe('project room registry and switcher', () => {
  let projectRooms;

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

  test('defaults to Main and renders it as the current command room', () => {
    const dom = installRoomDom();

    const controller = projectRooms.initProjectRooms({ documentRef: dom.documentRef });

    expect(controller.ok).toBe(true);
    expect(controller.getSelectedRoomId()).toBe('main');
    expect(dom.root.dataset.selectedRoom).toBe('main');
    expect(dom.overview.dataset.roomId).toBe('main');
    expect(dom.overview.innerHTML).toContain('Current command room');
    expect(dom.overview.innerHTML).toContain('JAMES ACTION: NONE');
    expect(dom.overview.innerHTML.match(/JAMES ACTION:/g)).toHaveLength(1);
    expect(dom.tabs[0].classList.contains('active')).toBe(true);
    expect(dom.tabs[0].getAttribute('aria-selected')).toBe('true');
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
    expect(dom.overview.innerHTML).toContain('Project-context mutation: disabled');
    expect(invoke).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    dom.tabs[2].click();

    expect(controller.getSelectedRoomId()).toBe('mira-build');
    expect(dom.overview.innerHTML).toContain('SquidRun and Mira internals');
    expect(invoke).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
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

  test('room shell lives above the main work area while right panel tabs remain tools', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const roomIndex = html.indexOf('id="projectRooms"');
    const mainContentIndex = html.indexOf('class="main-content"');
    const rightPanelIndex = html.indexOf('id="rightPanel"');
    const panelTabsStart = html.indexOf('class="panel-tabs"');
    const panelTabsEnd = html.indexOf('class="panel-content"');
    const panelTabsHtml = html.slice(panelTabsStart, panelTabsEnd);

    expect(roomIndex).toBeGreaterThan(-1);
    expect(roomIndex).toBeLessThan(mainContentIndex);
    expect(roomIndex).toBeLessThan(rightPanelIndex);
    expect(panelTabsHtml).toContain('data-tab="bridge"');
    expect(panelTabsHtml).toContain('data-tab="comms"');
    expect(panelTabsHtml).toContain('data-tab="screenshots"');
    expect(panelTabsHtml).not.toContain('data-project-room-tab');
    expect(html.toLowerCase()).not.toContain('plumbhalo');
  });
});
