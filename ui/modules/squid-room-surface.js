'use strict';

const SQUID_ROOM_WINDOW_KEY = 'squid-room';
const TRUSTQUOTE_APP_ROOM_ID = 'trustquote';
const ARM_STATE_PROJECTION_CHANNEL = 'arm-state:projection';

function toText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getMainSessionId(windowContext = {}) {
  const sessionScopeId = toText(windowContext.sessionScopeId, '');
  if (!sessionScopeId) return '';
  return sessionScopeId.split(':')[0] || '';
}

function getAppRoomSessionId(windowContext = {}, appRoomId = TRUSTQUOTE_APP_ROOM_ID) {
  const mainSessionId = getMainSessionId(windowContext);
  if (!mainSessionId) return '';
  return `${mainSessionId}:${appRoomId}`;
}

function buildProjectionRequest(windowContext = {}, appRoomId = TRUSTQUOTE_APP_ROOM_ID) {
  const sessionId = getAppRoomSessionId(windowContext, appRoomId);
  return {
    appRoomId,
    ...(sessionId ? { sessionId } : {}),
    includeRows: true,
  };
}

function normalizeProjection(projection = {}) {
  if (!projection || typeof projection !== 'object') {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'projection_missing',
      registry: { desiredCount: 0, readyCount: 0, missingCount: 0 },
      arms: [],
      watchdogs: { summary: {} },
      applyQueue: { summary: {} },
      sideEffects: {},
    };
  }
  return projection;
}

function buildSquidRoomModel(rawProjection = {}) {
  const projection = normalizeProjection(rawProjection);
  const registry = projection.registry || {};
  const desiredCount = Number(registry.desiredCount || 0);
  const readyCount = Number(registry.readyCount || 0);
  const missingCount = Number(registry.missingCount || 0);
  const status = projection.ok
    ? (missingCount > 0 ? `Missing ${missingCount}` : 'Ready')
    : (projection.reason === 'arm_registry_not_found' ? 'Not seeded' : 'Unavailable');
  const watchdogSummary = projection.watchdogs?.summary || {};
  const applySummary = projection.applyQueue?.summary || {};
  return {
    ok: projection.ok === true,
    status,
    appRoomId: registry.appRoomId || TRUSTQUOTE_APP_ROOM_ID,
    counts: {
      desired: desiredCount,
      ready: readyCount,
      missing: missingCount,
    },
    arms: Array.isArray(projection.arms) ? projection.arms
      .filter((arm) => arm?.required !== false && toText(arm?.status, 'unknown') !== 'disabled')
      .map((arm) => ({
        armKey: toText(arm.armKey, 'unknown'),
        displayName: toText(arm.displayName, toText(arm.armKey, 'Unknown arm')),
        role: toText(arm.role, 'unknown'),
        paneId: toText(arm.paneId, 'unknown'),
        status: toText(arm.status, 'unknown'),
        latestAcceptedCheckin: arm.latestAcceptedCheckin || null,
        watchdogSummary: arm.watchdogSummary || {},
        applyQueueSummary: arm.applyQueueSummary || {},
      })) : [],
    watchdogs: {
      open: Number(watchdogSummary.open || 0),
      overdue: Number(watchdogSummary.overdue || 0),
      escalated: Number(watchdogSummary.escalated || 0),
    },
    applyQueue: {
      pendingApproval: Number(applySummary.pendingApproval || 0),
      approvalRequired: Number(applySummary.approvalRequired || 0),
      executable: Number(applySummary.executable || 0),
    },
    projectionFlags: {
      projectionOnly: projection.projectionOnly === true,
      readOnly: projection.readOnly === true,
      dispatchEnabled: projection.dispatchEnabled === true,
      executorEnabled: projection.executorEnabled === true,
      writesPerformed: Number(projection.sideEffects?.writesPerformed || 0),
      dispatchesPerformed: Number(projection.sideEffects?.dispatchesPerformed || 0),
      watchdogAdvancesPerformed: Number(projection.sideEffects?.watchdogAdvancesPerformed || 0),
    },
  };
}

function getSurfaceElements(doc) {
  if (!doc || typeof doc.getElementById !== 'function') return null;
  return {
    root: doc.getElementById('squidRoomSurface'),
    status: doc.getElementById('squidRoomTrustQuoteStatus'),
    counts: doc.getElementById('squidRoomTrustQuoteCounts'),
    refreshButton: doc.getElementById('squidRoomRefreshBtn'),
  };
}

function renderSquidRoomProjection(projection, elements) {
  const model = buildSquidRoomModel(projection);
  if (elements.status) elements.status.textContent = model.ok ? '' : 'Projection unavailable';
  if (elements.counts) {
    elements.counts.innerHTML = `<span>${model.counts.desired} arms</span>`;
  }
  if (elements.root) {
    elements.root.dataset.projectionStatus = model.ok ? 'loaded' : 'unavailable';
    elements.root.dataset.projectionOnly = String(model.projectionFlags.projectionOnly);
    elements.root.dataset.readOnly = String(model.projectionFlags.readOnly);
    elements.root.dataset.dispatchEnabled = String(model.projectionFlags.dispatchEnabled);
    elements.root.dataset.executorEnabled = String(model.projectionFlags.executorEnabled);
  }
  return model;
}

function setSquidRoomTeamExpandButtonState(teamContainer, expanded) {
  const visibleLabel = expanded ? 'Collapse' : 'Expand';
  const label = expanded ? 'Collapse Builder + Oracle' : 'Expand Builder + Oracle';
  teamContainer?.querySelectorAll?.('.squid-room-team-expand-btn').forEach((button) => {
    if (button.dataset) {
      button.dataset.tooltip = label;
      button.dataset.expanded = String(expanded);
    }
    button.setAttribute?.('aria-label', label);
    button.setAttribute?.('aria-expanded', String(expanded));
    button.classList?.toggle?.('active', expanded);
    if ('title' in button) {
      button.title = label;
    }
    const labelNode = button.querySelector?.('.squid-room-team-toggle-label');
    if (labelNode) labelNode.textContent = visibleLabel;
  });
}

function toggleSquidRoomPaneExpansion({
  body = null,
  pane = null,
  paneLayout = null,
  expandedPaneId = null,
} = {}) {
  if (!(body?.classList?.contains?.('sr2-room') || body?.dataset?.workspaceKey === 'squid-room') || !pane || !paneLayout) {
    return { handled: false, expandedPaneId };
  }

  const teamContainer = pane.closest?.('.squid-room-team-container');
  const livePaneContainer = pane.closest?.('.squid-room-live-panes');

  if (teamContainer) {
    const expanded = !teamContainer.classList.contains('squid-room-team-collapsed');
    const nextExpanded = !expanded;
    teamContainer.classList.remove('squid-room-team-expanded');
    teamContainer.classList.toggle('squid-room-team-collapsed', !nextExpanded);
    paneLayout.classList.remove('has-squid-room-team-expanded');
    paneLayout.classList.toggle('has-squid-room-team-collapsed', !nextExpanded);
    teamContainer.querySelectorAll?.('.pane').forEach((teamPane) => {
      teamPane.classList.remove('pane-expanded');
    });
    setSquidRoomTeamExpandButtonState(teamContainer, nextExpanded);
    return { handled: true, expandedPaneId: null };
  }

  if (livePaneContainer) {
    if (pane.classList.contains('pane-expanded')) {
      pane.classList.remove('pane-expanded');
      livePaneContainer.classList.remove('has-expanded-pane');
      return { handled: true, expandedPaneId: null };
    }
    livePaneContainer.querySelectorAll?.('.pane-expanded').forEach((expandedPane) => {
      expandedPane.classList.remove('pane-expanded');
    });
    pane.classList.add('pane-expanded');
    livePaneContainer.classList.add('has-expanded-pane');
    return { handled: true, expandedPaneId: pane.dataset?.paneId || expandedPaneId };
  }

  return { handled: false, expandedPaneId };
}

async function refreshSquidRoomSurface(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const invoke = typeof options.invoke === 'function' ? options.invoke : null;
  const getWindowContext = typeof options.getWindowContext === 'function'
    ? options.getWindowContext
    : () => ({});
  const elements = getSurfaceElements(doc);
  if (!elements?.root || !invoke) return { ok: false, skipped: true, reason: 'surface_unavailable' };

  const windowContext = getWindowContext() || {};
  if (toText(windowContext.windowKey, 'main') !== SQUID_ROOM_WINDOW_KEY) {
    return { ok: false, skipped: true, reason: 'not_squid_room' };
  }

  const payload = buildProjectionRequest(windowContext, TRUSTQUOTE_APP_ROOM_ID);
  let projection = null;
  try {
    projection = await invoke(ARM_STATE_PROJECTION_CHANNEL, payload);
  } catch (err) {
    projection = {
      ok: false,
      status: 'projection_failed',
      reason: err?.message || String(err),
      projectionOnly: true,
      readOnly: true,
      dispatchEnabled: false,
      executorEnabled: false,
      sideEffects: {
        writesPerformed: 0,
        dispatchesPerformed: 0,
        watchdogAdvancesPerformed: 0,
      },
    };
  }
  const model = renderSquidRoomProjection(projection, elements);
  return {
    ok: model.ok,
    channel: ARM_STATE_PROJECTION_CHANNEL,
    payload,
    model,
  };
}

function initSquidRoomSurface(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const elements = getSurfaceElements(doc);
  if (!elements?.root) return { ok: false, refresh: () => Promise.resolve({ skipped: true }) };
  const refresh = () => refreshSquidRoomSurface(options);
  if (elements.refreshButton && elements.refreshButton.dataset.bound !== 'true') {
    elements.refreshButton.dataset.bound = 'true';
    elements.refreshButton.addEventListener('click', (event) => {
      event?.preventDefault?.();
      void refresh();
    });
  }
  void refresh();
  return {
    ok: true,
    refresh,
    refreshForWindowContext: (windowContext = {}) => {
      if (toText(windowContext.windowKey, 'main') !== SQUID_ROOM_WINDOW_KEY) {
        return Promise.resolve({ ok: false, skipped: true, reason: 'not_squid_room' });
      }
      return refresh();
    },
  };
}

module.exports = {
  ARM_STATE_PROJECTION_CHANNEL,
  SQUID_ROOM_WINDOW_KEY,
  TRUSTQUOTE_APP_ROOM_ID,
  buildProjectionRequest,
  buildSquidRoomModel,
  getAppRoomSessionId,
  initSquidRoomSurface,
  refreshSquidRoomSurface,
  renderSquidRoomProjection,
  setSquidRoomTeamExpandButtonState,
  toggleSquidRoomPaneExpansion,
};
