const {
  ARM_STATE_PROJECTION_CHANNEL,
  buildProjectionRequest,
  buildSquidRoomModel,
  initSquidRoomSurface,
  refreshSquidRoomSurface,
  renderSquidRoomHtml,
  renderSquidRoomProjection,
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
        armKey: 'money-documents',
        displayName: 'Money + Documents',
        role: 'trustquote-billing',
        paneId: 'trustquote-billing',
        status: 'missing',
        latestAcceptedCheckin: null,
        watchdogSummary: { open: 1, overdue: 1 },
        applyQueueSummary: { pendingApproval: 1, executable: 0 },
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
      displayName: 'Money + Documents',
      status: 'missing',
      latestAcceptedCheckin: null,
    }));
  });

  test('renders native expandable details without action buttons', () => {
    const html = renderSquidRoomHtml(buildSquidRoomModel(projection()));

    expect(html).toContain('<details class="squid-room-arm-details">');
    expect(html).toContain('Pending approval');
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
    expect(doc.getElementById('squidRoomTrustQuoteStatus').textContent).toBe('Missing 2');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).toContain('Desired 3');
    expect(doc.getElementById('squidRoomTrustQuoteArms').innerHTML).toContain('Money + Documents');
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
    expect(doc.getElementById('squidRoomTrustQuoteStatus').textContent).toBe('Missing 3');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).toContain('Desired 3');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).toContain('Missing 3');
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
    expect(doc.getElementById('squidRoomTrustQuoteStatus').textContent).toBe('Unavailable');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).toContain('Desired 0');
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
    expect(doc.getElementById('squidRoomTrustQuoteStatus').textContent).toBe('Not seeded');
    expect(doc.getElementById('squidRoomTrustQuoteCounts').innerHTML).toContain('Ready 0');
    expect(doc.getElementById('squidRoomTrustQuoteArms').innerHTML).toContain('No desired arms');
  });
});
