const {
  ARM_STATE_PROJECTION_CHANNEL,
  buildProjectionRequest,
  buildSquidRoomModel,
  initSquidRoomSurface,
  refreshSquidRoomSurface,
  renderSquidRoomProjection,
  toggleSquidRoomPaneExpansion,
} = require('../modules/squid-room-surface');

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.dataset = {};
    this.textContent = '';
    this.innerHTML = '';
    this.listeners = new Map();
  }

  addEventListener(eventName, listener) {
    this.listeners.set(eventName, listener);
  }

  removeAttribute() {}
  setAttribute() {}
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    for (const id of [
      'squidRoomSurface',
      'squidRoomExampleAppStatus',
      'squidRoomExampleAppCounts',
      'squidRoomRefreshBtn',
    ]) {
      this.elements.set(id, new FakeElement(id));
    }
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }
}

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(value) {
    this.values.add(value);
  }

  remove(value) {
    this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) {
      this.values.add(value);
    } else {
      this.values.delete(value);
    }
    return enabled;
  }
}

function expandableNode({ paneId = '', classes = [], closestMap = {}, queryAllMap = {} } = {}) {
  return {
    dataset: paneId ? { paneId } : {},
    classList: new FakeClassList(classes),
    closest: (selector) => closestMap[selector] || null,
    querySelectorAll: (selector) => queryAllMap[selector] || [],
  };
}

function projection(overrides = {}) {
  return {
    ok: true,
    projectionOnly: true,
    readOnly: true,
    dispatchEnabled: false,
    executorEnabled: false,
    sideEffects: {
      writesPerformed: 0,
      dispatchesPerformed: 0,
      watchdogAdvancesPerformed: 0,
    },
    registry: {
      appRoomId: 'exampleapp',
      desiredCount: 3,
      readyCount: 1,
      missingCount: 2,
    },
    arms: [
      {
        armKey: 'lead',
        displayName: 'ExampleApp Lead',
        role: 'exampleapp-lead',
        paneId: 'exampleapp-lead',
        status: 'ready',
        latestAcceptedCheckin: { messageId: 'hm-lead-ready' },
        watchdogSummary: { open: 0, overdue: 0 },
        applyQueueSummary: { pendingApproval: 0, executable: 0 },
      },
      {
        armKey: 'invoice',
        displayName: 'Invoice',
        role: 'exampleapp-invoice',
        paneId: 'exampleapp-invoice',
        status: 'missing',
        latestAcceptedCheckin: null,
        watchdogSummary: { open: 1, overdue: 1 },
        applyQueueSummary: { pendingApproval: 1, executable: 0 },
      },
      {
        armKey: 'retired',
        displayName: 'Retired Arm',
        role: 'exampleapp-retired',
        paneId: 'exampleapp-retired',
        status: 'disabled',
        required: false,
        latestAcceptedCheckin: null,
        watchdogSummary: {},
        applyQueueSummary: {},
      },
    ],
    watchdogs: {
      summary: { open: 2, overdue: 1, escalated: 0 },
    },
    applyQueue: {
      summary: { pendingApproval: 1, approvalRequired: 1, executable: 0 },
    },
    ...overrides,
  };
}

describe('squid-room-surface', () => {
  test('builds the ExampleApp projection request from the Squid Room session scope', () => {
    expect(buildProjectionRequest({
      windowKey: 'squid-room',
      sessionScopeId: 'app-session-406:squid-room',
    })).toEqual({
      appRoomId: 'exampleapp',
      sessionId: 'app-session-406:exampleapp',
      includeRows: true,
    });
  });

  test('builds a read-only display model from projection counts and summaries', () => {
    const model = buildSquidRoomModel(projection());

    expect(model).toEqual(expect.objectContaining({
      ok: true,
      status: 'Missing 2',
      counts: { desired: 3, ready: 1, missing: 2 },
      watchdogs: expect.objectContaining({ open: 2, overdue: 1 }),
      applyQueue: expect.objectContaining({ pendingApproval: 1 }),
      projectionFlags: {
        projectionOnly: true,
        readOnly: true,
        dispatchEnabled: false,
        executorEnabled: false,
        writesPerformed: 0,
        dispatchesPerformed: 0,
        watchdogAdvancesPerformed: 0,
      },
    }));
    expect(model.arms).toHaveLength(2);
    expect(model.arms[1]).toEqual(expect.objectContaining({
      displayName: 'Invoice',
      status: 'missing',
      latestAcceptedCheckin: null,
    }));
  });

  test('refresh invokes only arm-state projection and updates DOM state', async () => {
    const doc = new FakeDocument();
    const invoke = jest.fn().mockResolvedValue(projection());

    const result = await refreshSquidRoomSurface({
      document: doc,
      invoke,
      getWindowContext: () => ({
        windowKey: 'squid-room',
        sessionScopeId: 'app-session-406:squid-room',
      }),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      channel: ARM_STATE_PROJECTION_CHANNEL,
      payload: {
        appRoomId: 'exampleapp',
        sessionId: 'app-session-406:exampleapp',
        includeRows: true,
      },
    }));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(ARM_STATE_PROJECTION_CHANNEL, {
      appRoomId: 'exampleapp',
      sessionId: 'app-session-406:exampleapp',
      includeRows: true,
    });
    expect(doc.getElementById('squidRoomExampleAppStatus').textContent).toBe('');
    expect(doc.getElementById('squidRoomExampleAppCounts').innerHTML).toContain('3 arms');
    expect(doc.getElementById('squidRoomSurface').dataset).toEqual(expect.objectContaining({
      projectionStatus: 'loaded',
      projectionOnly: 'true',
      readOnly: 'true',
      dispatchEnabled: 'false',
      executorEnabled: 'false',
    }));
  });

  test('context-arrival refresh consumes and applies the projection payload', async () => {
    const doc = new FakeDocument();
    const invoke = jest.fn().mockResolvedValue(projection({
      registry: {
        appRoomId: 'exampleapp',
        desiredCount: 3,
        readyCount: 0,
        missingCount: 3,
      },
    }));
    let windowContext = { windowKey: 'main', sessionScopeId: 'app-session-408' };

    const controller = initSquidRoomSurface({
      document: doc,
      invoke,
      getWindowContext: () => windowContext,
    });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    expect(doc.getElementById('squidRoomExampleAppStatus').textContent).toBe('');

    windowContext = { windowKey: 'squid-room', sessionScopeId: 'app-session-408:squid-room' };
    const result = await controller.refreshForWindowContext(windowContext);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      payload: {
        appRoomId: 'exampleapp',
        sessionId: 'app-session-408:exampleapp',
        includeRows: true,
      },
    }));
    expect(invoke).toHaveBeenCalledWith(ARM_STATE_PROJECTION_CHANNEL, {
      appRoomId: 'exampleapp',
      sessionId: 'app-session-408:exampleapp',
      includeRows: true,
    });
    expect(doc.getElementById('squidRoomExampleAppStatus').textContent).toBe('');
    expect(doc.getElementById('squidRoomExampleAppCounts').innerHTML).toContain('3 arms');
    expect(doc.getElementById('squidRoomExampleAppCounts').innerHTML).not.toContain('Missing 3');
  });

  test('projection invoke failures render unavailable instead of leaving placeholders', async () => {
    const doc = new FakeDocument();
    const invoke = jest.fn().mockRejectedValue(new Error('ipc handler missing'));

    const result = await refreshSquidRoomSurface({
      document: doc,
      invoke,
      getWindowContext: () => ({
        windowKey: 'squid-room',
        sessionScopeId: 'app-session-408:squid-room',
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.model.status).toBe('Unavailable');
    expect(doc.getElementById('squidRoomExampleAppStatus').textContent).toBe('Projection unavailable');
    expect(doc.getElementById('squidRoomExampleAppCounts').innerHTML).toContain('0 arms');
    expect(doc.getElementById('squidRoomSurface').dataset.projectionStatus).toBe('unavailable');
  });

  test('refresh skips non-Squid-Room windows without invoking IPC', async () => {
    const doc = new FakeDocument();
    const invoke = jest.fn();

    const result = await refreshSquidRoomSurface({
      document: doc,
      invoke,
      getWindowContext: () => ({
        windowKey: 'main',
        sessionScopeId: 'app-session-406:exampleapp',
      }),
    });

    expect(result).toEqual({ ok: false, skipped: true, reason: 'not_squid_room' });
    expect(invoke).not.toHaveBeenCalled();
  });

  test('rendering an unavailable projection does not manufacture readiness', () => {
    const doc = new FakeDocument();
    const model = renderSquidRoomProjection({
      ok: false,
      reason: 'arm_registry_not_found',
      projectionOnly: true,
      readOnly: true,
      dispatchEnabled: false,
      executorEnabled: false,
      sideEffects: {},
    }, {
      root: doc.getElementById('squidRoomSurface'),
      status: doc.getElementById('squidRoomExampleAppStatus'),
      counts: doc.getElementById('squidRoomExampleAppCounts'),
    });

    expect(model.ok).toBe(false);
    expect(doc.getElementById('squidRoomExampleAppStatus').textContent).toBe('Projection unavailable');
    expect(doc.getElementById('squidRoomExampleAppCounts').innerHTML).toContain('0 arms');
  });

  test('collapses and expands Builder and Oracle as a local Squid Room team container', () => {
    const body = expandableNode({ classes: ['sr2-room'] });
    const paneLayout = expandableNode();
    const builderPane = expandableNode({ paneId: '2' });
    const oraclePane = expandableNode({ paneId: '3' });
    const labelNode = { textContent: 'Collapse' };
    const teamButton = {
      dataset: {},
      title: '',
      attributes: {},
      classList: new FakeClassList(),
      setAttribute(key, value) {
        this.attributes[key] = value;
      },
      querySelector(selector) {
        return selector === '.squid-room-team-toggle-label' ? labelNode : null;
      },
    };
    const teamContainer = expandableNode({
      queryAllMap: {
        '.pane': [builderPane, oraclePane],
        '.squid-room-team-expand-btn': [teamButton],
      },
    });
    builderPane.closest = (selector) => (selector === '.squid-room-team-container' ? teamContainer : null);

    const expanded = toggleSquidRoomPaneExpansion({
      body,
      pane: builderPane,
      paneLayout,
      expandedPaneId: null,
    });

    expect(expanded).toEqual({ handled: true, expandedPaneId: null });
    expect(teamContainer.classList.contains('squid-room-team-collapsed')).toBe(true);
    expect(teamContainer.classList.contains('squid-room-team-expanded')).toBe(false);
    expect(paneLayout.classList.contains('has-squid-room-team-expanded')).toBe(false);
    expect(paneLayout.classList.contains('has-squid-room-team-collapsed')).toBe(true);
    expect(builderPane.classList.contains('pane-expanded')).toBe(false);
    expect(oraclePane.classList.contains('pane-expanded')).toBe(false);
    expect(teamButton.dataset.tooltip).toBe('Expand Builder + Oracle');
    expect(teamButton.dataset.expanded).toBe('false');
    expect(teamButton.attributes['aria-expanded']).toBe('false');
    expect(teamButton.attributes['aria-label']).toBe('Expand Builder + Oracle');
    expect(teamButton.classList.contains('active')).toBe(false);
    expect(labelNode.textContent).toBe('Expand');

    const collapsed = toggleSquidRoomPaneExpansion({
      body,
      pane: builderPane,
      paneLayout,
      expandedPaneId: null,
    });

    expect(collapsed).toEqual({ handled: true, expandedPaneId: null });
    expect(teamContainer.classList.contains('squid-room-team-collapsed')).toBe(false);
    expect(paneLayout.classList.contains('has-squid-room-team-expanded')).toBe(false);
    expect(paneLayout.classList.contains('has-squid-room-team-collapsed')).toBe(false);
    expect(builderPane.classList.contains('pane-expanded')).toBe(false);
    expect(oraclePane.classList.contains('pane-expanded')).toBe(false);
    expect(teamButton.dataset.tooltip).toBe('Collapse Builder + Oracle');
    expect(teamButton.dataset.expanded).toBe('true');
    expect(teamButton.attributes['aria-expanded']).toBe('true');
    expect(teamButton.attributes['aria-label']).toBe('Collapse Builder + Oracle');
    expect(teamButton.classList.contains('active')).toBe(true);
    expect(labelNode.textContent).toBe('Collapse');
  });

  test('toggles a ExampleApp live pane within its app container', () => {
    const body = expandableNode({ classes: ['sr2-room'] });
    const paneLayout = expandableNode();
    const leadPane = expandableNode({ paneId: 'exampleapp-lead' });
    const invoicePane = expandableNode({
      paneId: 'exampleapp-invoice',
      classes: ['pane-expanded'],
    });
    const livePaneContainer = expandableNode({
      queryAllMap: { '.pane-expanded': [invoicePane] },
    });
    leadPane.closest = (selector) => (selector === '.squid-room-live-panes' ? livePaneContainer : null);

    const expanded = toggleSquidRoomPaneExpansion({
      body,
      pane: leadPane,
      paneLayout,
      expandedPaneId: 'exampleapp-invoice',
    });

    expect(expanded).toEqual({ handled: true, expandedPaneId: 'exampleapp-lead' });
    expect(invoicePane.classList.contains('pane-expanded')).toBe(false);
    expect(leadPane.classList.contains('pane-expanded')).toBe(true);
    expect(livePaneContainer.classList.contains('has-expanded-pane')).toBe(true);

    const collapsed = toggleSquidRoomPaneExpansion({
      body,
      pane: leadPane,
      paneLayout,
      expandedPaneId: 'exampleapp-lead',
    });

    expect(collapsed).toEqual({ handled: true, expandedPaneId: null });
    expect(leadPane.classList.contains('pane-expanded')).toBe(false);
    expect(livePaneContainer.classList.contains('has-expanded-pane')).toBe(false);
  });
});
