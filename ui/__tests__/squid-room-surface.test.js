const {
  ARM_STATE_PROJECTION_CHANNEL,
  buildProjectionRequest,
  buildSquidRoomModel,
  initSquidRoomSurface,
  refreshSquidRoomSurface,
  renderSquidRoomHtml,
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
      'squidRoomTrustQuoteStatus',
      'squidRoomTrustQuoteCounts',
      'squidRoomTrustQuoteArms',
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
      appRoomId: 'trustquote',
      desiredCount: 3,
      readyCount: 1,
      missingCount: 2,
    },
    arms: [
      {
        armKey: 'lead',
        displayName: 'TrustQuote Lead',
        role: 'trustquote-lead',
        paneId: 'trustquote-lead',
        status: 'ready',
        latestAcceptedCheckin: { messageId: 'hm-lead-ready' },
        watchdogSummary: { open: 0, overdue: 0 },
        applyQueueSummary: { pendingApproval: 0, executable: 0 },
      },
      {
        armKey: 'invoice',
        displayName: 'Invoice',
        role: 'trustquote-invoice',
        paneId: 'trustquote-invoice',
        status: 'missing',
        latestAcceptedCheckin: null,
        watchdogSummary: { open: 1, overdue: 1 },
        applyQueueSummary: { pendingApproval: 1, executable: 0 },
      },
      {
        armKey: 'retired',
        displayName: 'Retired Arm',
        role: 'trustquote-retired',
        paneId: 'trustquote-retired',
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
  test('builds the TrustQuote projection request from the Squid Room session scope', () => {
    expect(buildProjectionRequest({
      windowKey: 'squid-room',
      sessionScopeId: 'app-session-406:squid-room',
    })).toEqual({
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
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

  test('renders native expandable details without action buttons', () => {
    const html = renderSquidRoomHtml(buildSquidRoomModel(projection()));

    expect(html).toContain('<details class="squid-room-arm-details">');
    expect(html).toContain('Pending approval');
    expect(html).not.toContain('Retired Arm');
    expect(html).not.toMatch(/apply|dispatch|send|approve/i);
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
        appRoomId: 'trustquote',
        sessionId: 'app-session-406:trustquote',
        includeRows: true,
      },
    }));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(ARM_STATE_PROJECTION_CHANNEL, {
      appRoomId: 'trustquote',
      sessionId: 'app-session-406:trustquote',
      includeRows: true,
    });
    expect(doc.getElementById('squidRoomTrustQuoteStatus').textContent).toBe('');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).toContain('Arms count 3');
    expect(doc.getElementById('squidRoomTrustQuoteArms').innerHTML).toContain('Invoice');
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
        appRoomId: 'trustquote',
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
    expect(doc.getElementById('squidRoomTrustQuoteStatus').textContent).toBe('');

    windowContext = { windowKey: 'squid-room', sessionScopeId: 'app-session-408:squid-room' };
    const result = await controller.refreshForWindowContext(windowContext);

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      payload: {
        appRoomId: 'trustquote',
        sessionId: 'app-session-408:trustquote',
        includeRows: true,
      },
    }));
    expect(invoke).toHaveBeenCalledWith(ARM_STATE_PROJECTION_CHANNEL, {
      appRoomId: 'trustquote',
      sessionId: 'app-session-408:trustquote',
      includeRows: true,
    });
    expect(doc.getElementById('squidRoomTrustQuoteStatus').textContent).toBe('');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).toContain('Arms count 3');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).not.toContain('Missing 3');
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
    expect(doc.getElementById('squidRoomTrustQuoteStatus').textContent).toBe('Projection unavailable');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).toContain('Arms count 0');
    expect(doc.getElementById('squidRoomSurface').dataset.projectionStatus).toBe('unavailable');
  });

  test('refresh skips non-Squid-Room windows without invoking IPC', async () => {
    const doc = new FakeDocument();
    const invoke = jest.fn();

    const result = await refreshSquidRoomSurface({
      document: doc,
      invoke,
      getWindowContext: () => ({
        windowKey: 'trustquote',
        sessionScopeId: 'app-session-406:trustquote',
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
      status: doc.getElementById('squidRoomTrustQuoteStatus'),
      counts: doc.getElementById('squidRoomTrustQuoteCounts'),
      arms: doc.getElementById('squidRoomTrustQuoteArms'),
    });

    expect(model.ok).toBe(false);
    expect(doc.getElementById('squidRoomTrustQuoteStatus').textContent).toBe('Projection unavailable');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).toContain('Arms count 0');
    expect(doc.getElementById('squidRoomTrustQuoteArms').innerHTML).toContain('No arms listed');
  });

  test('toggles Builder and Oracle as one Squid Room team container', () => {
    const body = expandableNode({ classes: ['squid-room-workspace'] });
    const paneLayout = expandableNode();
    const builderPane = expandableNode({ paneId: '2' });
    const oraclePane = expandableNode({ paneId: '3' });
    const teamButton = {
      dataset: {},
      title: '',
      attributes: {},
      classList: new FakeClassList(),
      setAttribute(key, value) {
        this.attributes[key] = value;
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

    expect(expanded).toEqual({ handled: true, expandedPaneId: '2' });
    expect(teamContainer.classList.contains('squid-room-team-expanded')).toBe(true);
    expect(paneLayout.classList.contains('has-squid-room-team-expanded')).toBe(true);
    expect(builderPane.classList.contains('pane-expanded')).toBe(true);
    expect(oraclePane.classList.contains('pane-expanded')).toBe(true);
    expect(teamButton.dataset.tooltip).toBe('Collapse Builder + Oracle (ESC to collapse)');
    expect(teamButton.dataset.expanded).toBe('true');
    expect(teamButton.attributes['aria-expanded']).toBe('true');
    expect(teamButton.attributes['aria-label']).toBe('Collapse Builder + Oracle (ESC to collapse)');
    expect(teamButton.classList.contains('active')).toBe(true);

    const collapsed = toggleSquidRoomPaneExpansion({
      body,
      pane: builderPane,
      paneLayout,
      expandedPaneId: '2',
    });

    expect(collapsed).toEqual({ handled: true, expandedPaneId: null });
    expect(teamContainer.classList.contains('squid-room-team-expanded')).toBe(false);
    expect(paneLayout.classList.contains('has-squid-room-team-expanded')).toBe(false);
    expect(builderPane.classList.contains('pane-expanded')).toBe(false);
    expect(oraclePane.classList.contains('pane-expanded')).toBe(false);
    expect(teamButton.dataset.tooltip).toBe('Expand Builder + Oracle (ESC to collapse)');
    expect(teamButton.dataset.expanded).toBe('false');
    expect(teamButton.attributes['aria-expanded']).toBe('false');
    expect(teamButton.attributes['aria-label']).toBe('Expand Builder + Oracle (ESC to collapse)');
    expect(teamButton.classList.contains('active')).toBe(false);
  });

  test('toggles a TrustQuote live pane within its app container', () => {
    const body = expandableNode({ classes: ['squid-room-workspace'] });
    const paneLayout = expandableNode();
    const leadPane = expandableNode({ paneId: 'trustquote-lead' });
    const invoicePane = expandableNode({
      paneId: 'trustquote-invoice',
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
      expandedPaneId: 'trustquote-invoice',
    });

    expect(expanded).toEqual({ handled: true, expandedPaneId: 'trustquote-lead' });
    expect(invoicePane.classList.contains('pane-expanded')).toBe(false);
    expect(leadPane.classList.contains('pane-expanded')).toBe(true);
    expect(livePaneContainer.classList.contains('has-expanded-pane')).toBe(true);

    const collapsed = toggleSquidRoomPaneExpansion({
      body,
      pane: leadPane,
      paneLayout,
      expandedPaneId: 'trustquote-lead',
    });

    expect(collapsed).toEqual({ handled: true, expandedPaneId: null });
    expect(leadPane.classList.contains('pane-expanded')).toBe(false);
    expect(livePaneContainer.classList.contains('has-expanded-pane')).toBe(false);
  });
});
