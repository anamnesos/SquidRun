'use strict';

const { invokeBridge } = require('../renderer-bridge');
const { LOCAL_TEXT_UI_CHANNEL } = require('../mira-local-text-ui-surface');
const {
  MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
} = require('../mira-coordinator-snapshot-channel');

const IDS = Object.freeze({
  panel: 'miraLocalTextPanel',
  status: 'miraLocalTextStatus',
  scope: 'miraLocalTextScope',
  coordinatorStrip: 'miraCoordinatorStrip',
  coordinatorStatus: 'miraCoordinatorStatus',
  coordinatorRefresh: 'miraCoordinatorRefreshBtn',
  coordinatorFocus: 'miraCoordinatorFocus',
  coordinatorLanes: 'miraCoordinatorLanes',
  coordinatorModelAttachment: 'miraCoordinatorModelAttachment',
  coordinatorNext: 'miraCoordinatorNext',
  coordinatorBlockers: 'miraCoordinatorBlockers',
  coordinatorRationale: 'miraCoordinatorRationale',
  input: 'miraLocalTextInput',
  submit: 'miraLocalTextSubmitBtn',
  reply: 'miraLocalTextReply',
  meta: 'miraLocalTextMeta',
  counters: 'miraLocalTextCounters',
});
const SESSION_WINDOW_MS = 15 * 60 * 1000;

let cleanupFns = [];
let activeController = null;
let rememberedDraft = '';

function getEl(id, doc = document) {
  if (!doc || typeof doc.getElementById !== 'function') return null;
  return doc.getElementById(id);
}

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  const match = text.match(/session\s+(\d+)/i);
  if (match) return `app-session-${match[1]}`;
  return text || 'app-session-ui-local-text';
}

function getHeaderSessionId(doc = document) {
  return normalizeSessionId(getEl('headerSessionBadge', doc)?.textContent);
}

function setText(el, text) {
  if (el) el.textContent = text;
}

function setHidden(el, hidden) {
  if (el) el.hidden = Boolean(hidden);
}

function summarizeCounters(counters = {}) {
  return [
    `module ${Number(counters.module_call_count || 0)}`,
    `reply ${Number(counters.reply_count || 0)}`,
    `writes ${Number(counters.write_count || 0)}`,
    `tools ${Number(counters.tool_call_count || 0)}`,
    `sends ${Number(counters.external_send_count || 0)}`,
  ].join(' / ');
}

function defaultElements(doc = document) {
  return Object.keys(IDS).reduce((result, key) => {
    result[key] = getEl(IDS[key], doc);
    return result;
  }, {});
}

function createNowGetter(options = {}) {
  if (typeof options.now === 'function') return options.now;
  if (Number.isFinite(Number(options.nowMs))) return () => Number(options.nowMs);
  return () => Date.now();
}

function requestSessionWindow(nowGetter) {
  const startedMs = Number(nowGetter());
  const safeStartedMs = Number.isFinite(startedMs) ? startedMs : Date.now();
  return {
    startedAt: new Date(safeStartedMs).toISOString(),
    expiresAt: new Date(safeStartedMs + SESSION_WINDOW_MS).toISOString(),
  };
}

function createMiraLocalTextController(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const elements = options.elements || defaultElements(doc);
  const invoke = options.invoke || ((channel, payload) => invokeBridge(channel, payload));
  const getSessionId = options.getSessionId || (() => getHeaderSessionId(doc));
  const nowGetter = createNowGetter(options);
  const counters = {
    submit_count: 0,
    module_call_count: 0,
    reply_count: 0,
    blocked_count: 0,
    duplicate_submit_block_count: 0,
    write_count: 0,
    tool_call_count: 0,
    external_send_count: 0,
  };
  const state = {
    submitting: false,
    coordinatorLoading: false,
    status: 'ready',
    coordinatorStatus: 'idle',
    lastResult: null,
    lastCoordinatorSnapshot: null,
    lastError: null,
  };

  if (elements.input && !String(elements.input.value || '').trim() && rememberedDraft) {
    elements.input.value = rememberedDraft;
  }

  function applyDataset() {
    const panel = elements.panel;
    if (!panel) return;
    panel.dataset.status = state.status;
    panel.dataset.profile = 'main';
    panel.dataset.windowKey = 'main';
    panel.dataset.sourceScope = 'main';
    panel.dataset.deviceId = 'VIGIL';
    panel.dataset.moduleCallCount = String(counters.module_call_count);
    panel.dataset.replyCount = String(counters.reply_count);
    panel.dataset.blockedCount = String(counters.blocked_count);
    panel.dataset.duplicateSubmitBlockCount = String(counters.duplicate_submit_block_count);
    panel.dataset.writeCount = String(counters.write_count);
    panel.dataset.toolCallCount = String(counters.tool_call_count);
    panel.dataset.externalSendCount = String(counters.external_send_count);
    panel.dataset.coordinatorStatus = state.coordinatorStatus;
  }

  function renderStatus(status, message) {
    state.status = status;
    setText(elements.status, message);
    setText(elements.scope, `${DEFAULT_SCOPE_LABEL} / ${getSessionId()}`);
    setText(elements.counters, summarizeCounters(counters));
    if (elements.submit) elements.submit.disabled = state.submitting;
    applyDataset();
  }

  function clearReply() {
    if (!elements.reply) return;
    elements.reply.textContent = '';
    elements.reply.dataset.count = '0';
    setHidden(elements.reply, true);
  }

  function renderReply(reply) {
    if (!elements.reply) return;
    elements.reply.textContent = reply?.text || '';
    elements.reply.dataset.count = reply?.text ? '1' : '0';
    setHidden(elements.reply, !reply?.text);
  }

  function clearDraftAfterAcceptedReply() {
    if (elements.input) elements.input.value = '';
    rememberedDraft = '';
  }

  function buildPayload(text) {
    const sessionWindow = requestSessionWindow(nowGetter);
    return {
      text,
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      deviceId: 'VIGIL',
      sessionId: getSessionId(),
      activeState: 'open',
      visibleIndicatorPresent: true,
      startedAt: sessionWindow.startedAt,
      expiresAt: sessionWindow.expiresAt,
      source: 'right-panel-local-text-ui-v0',
    };
  }

  function buildCoordinatorPayload() {
    return {
      profileName: 'main',
      windowKey: 'main',
      sourceScope: 'main',
      deviceId: 'VIGIL',
      sessionId: getSessionId(),
      activeState: 'open',
      visibleIndicatorPresent: true,
      source: 'right-panel-mira-coordinator-snapshot-v0',
    };
  }

  function hasCoordinatorSurface() {
    return Boolean(elements.coordinatorStrip);
  }

  function setCoordinatorText(key, text) {
    setText(elements[key], text);
  }

  function summarizeLane(lane = {}) {
    return `${lane.label || lane.id}: ${lane.state || 'unknown'}`;
  }

  function summarizeBlocker(blocker = {}) {
    return `${blocker.label || blocker.id}: ${blocker.state || 'unknown'}`;
  }

  function summarizeModelAttachment(modelAttachment = {}) {
    return modelAttachment.visible_status || `${modelAttachment.label || 'Model Attachment'}: ${modelAttachment.state || 'unknown'}`;
  }

  function renderCoordinatorSnapshot(result) {
    if (!hasCoordinatorSurface()) return;
    const snapshot = result?.coordinator_snapshot_v0 || {};
    const accepted = snapshot.decision === 'accepted';
    state.lastCoordinatorSnapshot = result;
    state.coordinatorStatus = accepted ? 'ready' : 'blocked';
    elements.coordinatorStrip.dataset.status = state.coordinatorStatus;
    setCoordinatorText('coordinatorStatus', accepted ? 'Ready' : 'Blocked');
    setCoordinatorText('coordinatorFocus', snapshot.current_focus?.summary || 'Local coordinator state unavailable.');
    setCoordinatorText('coordinatorLanes', Array.isArray(snapshot.lanes)
      ? snapshot.lanes.map(summarizeLane).join(' | ')
      : '');
    setCoordinatorText('coordinatorModelAttachment', summarizeModelAttachment(snapshot.model_attachment));
    setCoordinatorText('coordinatorNext', snapshot.next_recommended_action?.summary || '');
    setCoordinatorText('coordinatorBlockers', Array.isArray(snapshot.blockers)
      ? snapshot.blockers.map(summarizeBlocker).join(' | ')
      : '');
    setCoordinatorText('coordinatorRationale', Array.isArray(snapshot.rationale)
      ? snapshot.rationale.join(' ')
      : '');
    applyDataset();
  }

  function renderCoordinatorError(err) {
    if (!hasCoordinatorSurface()) return;
    state.coordinatorStatus = 'error';
    elements.coordinatorStrip.dataset.status = 'error';
    setCoordinatorText('coordinatorStatus', 'Unavailable');
    setCoordinatorText('coordinatorFocus', err?.message || 'coordinator_snapshot_error');
    setCoordinatorText('coordinatorLanes', '');
    setCoordinatorText('coordinatorModelAttachment', '');
    setCoordinatorText('coordinatorNext', '');
    setCoordinatorText('coordinatorBlockers', '');
    setCoordinatorText('coordinatorRationale', '');
    applyDataset();
  }

  async function refreshCoordinatorSnapshot() {
    if (!hasCoordinatorSurface()) {
      return { ok: false, reason: 'coordinator_snapshot_unmounted' };
    }
    if (state.coordinatorLoading) {
      return { ok: false, reason: 'coordinator_snapshot_already_loading' };
    }
    state.coordinatorLoading = true;
    state.coordinatorStatus = 'loading';
    elements.coordinatorStrip.dataset.status = 'loading';
    setCoordinatorText('coordinatorStatus', 'Reading');
    if (elements.coordinatorRefresh) elements.coordinatorRefresh.disabled = true;
    applyDataset();
    try {
      const result = await invoke(MIRA_COORDINATOR_SNAPSHOT_CHANNEL, buildCoordinatorPayload());
      renderCoordinatorSnapshot(result);
      return result;
    } catch (err) {
      state.lastError = err;
      renderCoordinatorError(err);
      return {
        ok: false,
        reason: 'coordinator_snapshot_error',
        error: err?.message || String(err),
      };
    } finally {
      state.coordinatorLoading = false;
      if (elements.coordinatorRefresh) elements.coordinatorRefresh.disabled = false;
      applyDataset();
    }
  }

  function updateFromResult(result) {
    const surface = result?.ui_surface_v0 || {};
    const surfaceCounters = surface.checked_output_counters || {};
    counters.module_call_count += Number(surfaceCounters.module_call_count || 0);
    counters.write_count += Number(surfaceCounters.write_count || 0);
    counters.tool_call_count += Number(surfaceCounters.tool_call_count || 0);
    counters.external_send_count += Number(surfaceCounters.external_send_count || 0);
    state.lastResult = result;
    state.lastError = null;

    if (surface.decision === 'accepted' && surface.reply?.count === 1 && surface.reply?.text) {
      counters.reply_count += 1;
      renderReply(surface.reply);
      clearDraftAfterAcceptedReply();
      setText(elements.meta, surface.local_text_session_gate?.session_id || 'local_text_session_v0');
      renderStatus('reply_ready', 'Ready');
      return;
    }

    counters.blocked_count += 1;
    clearReply();
    setText(elements.meta, Array.isArray(surface.reasons) ? surface.reasons.join(', ') : 'blocked');
    renderStatus('blocked', 'Blocked');
  }

  async function submit() {
    if (state.submitting) {
      counters.duplicate_submit_block_count += 1;
      renderStatus('duplicate_blocked', 'Already working');
      return { ok: false, reason: 'duplicate_submit_blocked' };
    }

    const text = String(elements.input?.value || '');
    rememberedDraft = text;
    if (!text.trim()) {
      counters.blocked_count += 1;
      clearReply();
      setText(elements.meta, 'blocked_empty_input');
      renderStatus('blocked_empty_input', 'Blocked');
      return { ok: false, reason: 'blocked_empty_input' };
    }

    counters.submit_count += 1;
    state.submitting = true;
    renderStatus('submitting', 'Reading local state');

    try {
      const result = await invoke(LOCAL_TEXT_UI_CHANNEL, buildPayload(text));
      updateFromResult(result);
      return result;
    } catch (err) {
      state.lastError = err;
      counters.blocked_count += 1;
      clearReply();
      setText(elements.meta, err?.message || 'local_text_ui_error');
      renderStatus('error', 'Unavailable');
      return { ok: false, reason: 'local_text_ui_error', error: err?.message || String(err) };
    } finally {
      state.submitting = false;
      if (elements.submit) elements.submit.disabled = false;
      applyDataset();
    }
  }

  function onInput() {
    rememberedDraft = String(elements.input?.value || '');
  }

  function destroy() {
    if (elements.input && inputHandler) {
      elements.input.removeEventListener('input', inputHandler);
    }
    if (elements.submit && submitHandler) {
      elements.submit.removeEventListener('click', submitHandler);
    }
    if (elements.coordinatorRefresh && coordinatorRefreshHandler) {
      elements.coordinatorRefresh.removeEventListener('click', coordinatorRefreshHandler);
    }
  }

  const inputHandler = onInput;
  const submitHandler = () => { submit(); };
  const coordinatorRefreshHandler = () => { refreshCoordinatorSnapshot(); };
  if (elements.input && typeof elements.input.addEventListener === 'function') {
    elements.input.addEventListener('input', inputHandler);
  }
  if (elements.submit && typeof elements.submit.addEventListener === 'function') {
    elements.submit.addEventListener('click', submitHandler);
  }
  if (elements.coordinatorRefresh && typeof elements.coordinatorRefresh.addEventListener === 'function') {
    elements.coordinatorRefresh.addEventListener('click', coordinatorRefreshHandler);
  }

  renderStatus('ready', 'Active');
  if (String(elements.input?.value || '')) rememberedDraft = String(elements.input.value || '');
  if (hasCoordinatorSurface() && options.autoLoadCoordinator !== false) {
    refreshCoordinatorSnapshot();
  }

  return {
    counters,
    state,
    submit,
    refreshCoordinatorSnapshot,
    destroy,
    buildPayload,
    buildCoordinatorPayload,
    getDraftText: () => rememberedDraft,
  };
}

const DEFAULT_SCOPE_LABEL = 'VIGIL / main';

function setupMiraLocalTextTab() {
  destroyMiraLocalTextTab();
  activeController = createMiraLocalTextController();
  cleanupFns.push(() => activeController?.destroy());
}

function destroyMiraLocalTextTab() {
  for (const fn of cleanupFns) {
    try { fn(); } catch (_) {}
  }
  cleanupFns = [];
  activeController = null;
}

module.exports = {
  IDS,
  LOCAL_TEXT_UI_CHANNEL,
  MIRA_COORDINATOR_SNAPSHOT_CHANNEL,
  createMiraLocalTextController,
  destroyMiraLocalTextTab,
  getHeaderSessionId,
  setupMiraLocalTextTab,
};
