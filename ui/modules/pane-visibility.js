'use strict';

const HIDEABLE_PANE_IDS = Object.freeze(['2', '3']);
const PANE_LABELS = Object.freeze({
  2: 'Builder',
  3: 'Oracle',
});
const STORAGE_PREFIX = 'squidrun:pane-visibility';

function normalizePaneId(value) {
  const paneId = String(value || '').trim();
  return HIDEABLE_PANE_IDS.includes(paneId) ? paneId : null;
}

function normalizePaneIds(values) {
  const source = Array.isArray(values) ? values : [];
  return Array.from(new Set(source.map(normalizePaneId).filter(Boolean)));
}

function getProfileName(options = {}) {
  const explicit = String(options.profileName || '').trim();
  if (explicit) return explicit;
  if (typeof document !== 'undefined') {
    const fromBody = String(document.body?.dataset?.profileName || '').trim();
    if (fromBody) return fromBody;
  }
  return 'main';
}

function getStorageKey(options = {}) {
  return `${STORAGE_PREFIX}:${getProfileName(options)}`;
}

function getStorage(options = {}) {
  if (options.storage) return options.storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch (_) {
    return null;
  }
  return null;
}

function readHiddenPaneIds(options = {}) {
  const storage = getStorage(options);
  if (!storage || typeof storage.getItem !== 'function') return [];
  try {
    const raw = storage.getItem(getStorageKey(options));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return normalizePaneIds(parsed?.hiddenPaneIds || parsed);
  } catch (_) {
    return [];
  }
}

function writeHiddenPaneIds(hiddenPaneIds, options = {}) {
  const storage = getStorage(options);
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(getStorageKey(options), JSON.stringify({
      version: 1,
      hiddenPaneIds: normalizePaneIds(hiddenPaneIds),
    }));
    return true;
  } catch (_) {
    return false;
  }
}

function getPaneLabel(paneId) {
  return PANE_LABELS[paneId] || `Pane ${paneId}`;
}

function getPane(documentRef, paneId) {
  if (!documentRef || typeof documentRef.querySelector !== 'function') return null;
  return documentRef.querySelector(`.pane[data-pane-id="${paneId}"]`);
}

function getSidePanesContainer(documentRef) {
  if (!documentRef || typeof documentRef.querySelector !== 'function') return null;
  return documentRef.querySelector('.side-panes-container');
}

function createButton(documentRef, className, paneId, label, title) {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.paneId = paneId;
  button.setAttribute('aria-label', title);
  button.setAttribute('title', title);
  return { button, label };
}

function createHideButton(documentRef, paneId) {
  const title = `Hide ${getPaneLabel(paneId)}`;
  const { button } = createButton(
    documentRef,
    'pane-action-btn pane-hide-btn',
    paneId,
    getPaneLabel(paneId),
    title
  );
  button.dataset.tooltip = title;
  button.innerHTML = '<svg class="pane-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 10.6A2 2 0 0 0 12 14a2 2 0 0 0 1.4-.6"/><path d="M9.9 4.2A10.8 10.8 0 0 1 12 4c5 0 8.5 4.2 10 8a14.3 14.3 0 0 1-3.2 4.7"/><path d="M6.6 6.6A14.5 14.5 0 0 0 2 12c1.5 3.8 5 8 10 8 1.7 0 3.2-.4 4.5-1.1"/></svg>';
  return button;
}

function ensureRestoreShelf(documentRef) {
  const container = getSidePanesContainer(documentRef);
  if (!container) return null;
  let shelf = documentRef.getElementById?.('paneVisibilityRestoreShelf') || null;
  if (shelf) return shelf;
  shelf = documentRef.createElement('div');
  shelf.id = 'paneVisibilityRestoreShelf';
  shelf.className = 'pane-restore-shelf';
  shelf.setAttribute('aria-label', 'Hidden panes');
  const firstPane = HIDEABLE_PANE_IDS.map((paneId) => getPane(documentRef, paneId)).find(Boolean);
  if (typeof container.insertBefore === 'function' && firstPane) {
    container.insertBefore(shelf, firstPane);
  } else {
    container.appendChild(shelf);
  }
  return shelf;
}

function readPaneSignal(documentRef, paneId) {
  const badge = documentRef.getElementById?.(`badge-${paneId}`);
  const task = documentRef.getElementById?.(`task-${paneId}`);
  const health = documentRef.getElementById?.(`health-${paneId}`);
  const badgeClass = String(badge?.className || '');
  return {
    active: /\bactive\b/.test(badgeClass),
    idle: /\bidle\b/.test(badgeClass),
    taskText: String(task?.textContent || '').trim(),
    healthText: String(health?.textContent || '').trim(),
  };
}

function buildRestoreButtonText(signal, paneId) {
  const label = getPaneLabel(paneId);
  if (signal.taskText) return `Show ${label} - ${signal.taskText}`;
  if (signal.healthText && signal.healthText !== '-') return `Show ${label} - ${signal.healthText}`;
  return `Show ${label}`;
}

function renderRestoreShelf(state) {
  const shelf = state.restoreShelf;
  if (!shelf) return;
  shelf.innerHTML = '';
  shelf.hidden = state.hiddenPaneIds.size === 0;
  shelf.classList.toggle('has-hidden-panes', state.hiddenPaneIds.size > 0);
  const container = getSidePanesContainer(state.document);
  if (container) {
    container.classList.toggle('has-hidden-side-pane', state.hiddenPaneIds.size > 0);
  }

  for (const paneId of HIDEABLE_PANE_IDS) {
    if (!state.hiddenPaneIds.has(paneId)) continue;
    const signal = readPaneSignal(state.document, paneId);
    const button = state.document.createElement('button');
    button.type = 'button';
    button.className = 'pane-restore-btn';
    button.dataset.paneId = paneId;
    button.classList.toggle('active', signal.active);
    button.classList.toggle('has-activity', state.activityPaneIds.has(paneId));
    const title = `Restore ${getPaneLabel(paneId)} pane`;
    button.setAttribute('title', title);
    button.setAttribute('aria-label', title);
    button.textContent = buildRestoreButtonText(signal, paneId);
    button.addEventListener('click', () => showPane(state, paneId));
    shelf.appendChild(button);
  }
}

function emitVisibilityChanged(state, paneId, visible) {
  if (state.bus && typeof state.bus.emit === 'function') {
    state.bus.emit('pane.visibility.changed', {
      paneId,
      payload: { paneId, visible, hiddenByUser: !visible },
      source: 'pane-visibility.js',
    });
  }
  if (typeof state.onVisibilityChanged === 'function') {
    state.onVisibilityChanged({ paneId, visible, hiddenByUser: !visible });
  }
}

function requestLayoutResize(state) {
  if (state.windowRef && typeof state.windowRef.dispatchEvent === 'function' && typeof Event === 'function') {
    try {
      state.windowRef.dispatchEvent(new Event('resize'));
    } catch (_) {}
  }
}

function applyPaneVisibility(state, paneId, hidden, options = {}) {
  const normalizedPaneId = normalizePaneId(paneId);
  if (!normalizedPaneId) return false;
  const pane = getPane(state.document, normalizedPaneId);
  if (!pane) return false;

  pane.hidden = Boolean(hidden);
  pane.classList.toggle('pane-hidden-by-user', Boolean(hidden));
  if (hidden) {
    state.hiddenPaneIds.add(normalizedPaneId);
  } else {
    state.hiddenPaneIds.delete(normalizedPaneId);
    state.activityPaneIds.delete(normalizedPaneId);
  }
  writeHiddenPaneIds(Array.from(state.hiddenPaneIds), state);
  renderRestoreShelf(state);
  requestLayoutResize(state);
  if (!options.silent) {
    emitVisibilityChanged(state, normalizedPaneId, !hidden);
  }
  return true;
}

function hidePane(state, paneId) {
  return applyPaneVisibility(state, paneId, true);
}

function showPane(state, paneId) {
  return applyPaneVisibility(state, paneId, false);
}

function markPaneActivity(state, paneId) {
  const normalizedPaneId = normalizePaneId(paneId);
  if (!normalizedPaneId || !state.hiddenPaneIds.has(normalizedPaneId)) return;
  state.activityPaneIds.add(normalizedPaneId);
  renderRestoreShelf(state);
}

function observePaneSignals(state, paneId) {
  const MutationObserverCtor = state.windowRef?.MutationObserver || globalThis.MutationObserver;
  if (typeof MutationObserverCtor !== 'function') return;
  const targets = [
    state.document.getElementById?.(`badge-${paneId}`),
    state.document.getElementById?.(`task-${paneId}`),
    state.document.getElementById?.(`health-${paneId}`),
  ].filter(Boolean);
  for (const target of targets) {
    const observer = new MutationObserverCtor(() => markPaneActivity(state, paneId));
    observer.observe(target, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    state.cleanupFns.push(() => observer.disconnect());
  }
}

function installHideButtons(state) {
  for (const paneId of HIDEABLE_PANE_IDS) {
    const pane = getPane(state.document, paneId);
    const actions = pane?.querySelector?.('.pane-actions');
    if (!actions || actions.querySelector?.(`.pane-hide-btn[data-pane-id="${paneId}"]`)) continue;
    const button = createHideButton(state.document, paneId);
    button.addEventListener('click', () => hidePane(state, paneId));
    actions.appendChild(button);
  }
}

function initPaneVisibilityControls(options = {}) {
  const documentRef = options.documentRef || (typeof document !== 'undefined' ? document : null);
  if (!documentRef) return null;
  const sideContainer = getSidePanesContainer(documentRef);
  if (!sideContainer) return null;
  if (sideContainer.dataset.paneVisibilityInitialized === 'true') return null;
  sideContainer.dataset.paneVisibilityInitialized = 'true';

  const state = {
    document: documentRef,
    windowRef: options.windowRef || (typeof window !== 'undefined' ? window : null),
    storage: getStorage(options),
    profileName: getProfileName(options),
    bus: options.bus || null,
    onVisibilityChanged: options.onVisibilityChanged || null,
    hiddenPaneIds: new Set(readHiddenPaneIds(options)),
    activityPaneIds: new Set(),
    cleanupFns: [],
    restoreShelf: null,
  };
  state.restoreShelf = ensureRestoreShelf(documentRef);
  installHideButtons(state);
  for (const paneId of HIDEABLE_PANE_IDS) {
    observePaneSignals(state, paneId);
    applyPaneVisibility(state, paneId, state.hiddenPaneIds.has(paneId), { silent: true });
  }
  renderRestoreShelf(state);

  return {
    hidePane: (paneId) => hidePane(state, paneId),
    showPane: (paneId) => showPane(state, paneId),
    getHiddenPaneIds: () => Array.from(state.hiddenPaneIds),
    dispose: () => {
      for (const cleanup of state.cleanupFns.splice(0)) {
        try {
          cleanup();
        } catch (_) {}
      }
      sideContainer.dataset.paneVisibilityInitialized = 'false';
    },
  };
}

module.exports = {
  HIDEABLE_PANE_IDS,
  getProfileName,
  getStorageKey,
  normalizePaneIds,
  readHiddenPaneIds,
  writeHiddenPaneIds,
  buildRestoreButtonText,
  initPaneVisibilityControls,
};
