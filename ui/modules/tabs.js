/**
 * Tabs and panels module
 * Refactored to modular architecture (Session 72)
 * Devtools tabs removed (Session 101). Git + Feed tabs removed (Session 121) — kept: bridge, screenshots, comms, oracle, api-keys
 */

// Sub-modules

const screenshots = require('./tabs/screenshots');
const oracle = require('./tabs/oracle');
const commsConsole = require('./tabs/comms-console');

const apiKeys = require('./tabs/api-keys');
const bridge = require('./tabs/bridge');

// Panel state
let panelOpen = false;
let onConnectionStatusUpdate = null;
let storedResizeFn = null;
let pendingResizeTimer = null;
const PANEL_RESIZE_DELAY_MS = 350;

// Track panel-level DOM listener cleanup
let panelCleanupFns = [];

function setConnectionStatusCallback(cb) {
  onConnectionStatusUpdate = cb;
}

function updateConnectionStatus(status) {
  if (onConnectionStatusUpdate) {
    onConnectionStatusUpdate(status);
  }
}

function schedulePanelResize(handleResizeFn) {
  if (typeof handleResizeFn !== 'function') return;
  if (pendingResizeTimer) {
    clearTimeout(pendingResizeTimer);
  }
  pendingResizeTimer = setTimeout(() => {
    pendingResizeTimer = null;
    handleResizeFn();
  }, PANEL_RESIZE_DELAY_MS);
}

// Toggle right panel
function togglePanel(handleResizeFn) {
  const panel = document.getElementById('rightPanel');
  const terminalsSection = document.getElementById('terminalsSection');
  const panelBtn = document.getElementById('panelBtn');

  panelOpen = !panelOpen;

  if (panel) panel.classList.toggle('open', panelOpen);
  if (terminalsSection) terminalsSection.classList.toggle('panel-open', panelOpen);
  if (panelBtn) panelBtn.classList.toggle('active', panelOpen);

  schedulePanelResize(handleResizeFn);
}

function isPanelOpen() {
  return panelOpen;
}

function switchTab(tabId) {
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabId);
  });

  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `tab-${tabId}`);
  });

  // Trigger resize when switching tabs (panel size may differ by content)
  schedulePanelResize(storedResizeFn);
}

/**
 * Destroy all tab modules — call before re-initialization to prevent listener leaks.
 */
function destroyAllTabs() {
  if (pendingResizeTimer) {
    clearTimeout(pendingResizeTimer);
    pendingResizeTimer = null;
  }

  // Destroy panel-level DOM listeners
  for (const fn of panelCleanupFns) {
    try { fn(); } catch (_) {}
  }
  panelCleanupFns = [];

  // Destroy each tab module

  if (typeof screenshots.destroyScreenshots === 'function') screenshots.destroyScreenshots();
  if (typeof oracle.destroyOracleTab === 'function') oracle.destroyOracleTab();
  if (typeof commsConsole.destroy === 'function') commsConsole.destroy();

  if (typeof apiKeys.destroyApiKeysTab === 'function') apiKeys.destroyApiKeysTab();
  if (typeof bridge.destroy === 'function') bridge.destroy();
}

function setupRightPanel(handleResizeFn, busInstance) {
  // Destroy previous tab state before re-init (prevents listener accumulation)
  destroyAllTabs();

  storedResizeFn = handleResizeFn;

  const panelBtn = document.getElementById('panelBtn');
  if (panelBtn) {
    const handler = () => togglePanel(handleResizeFn);
    panelBtn.addEventListener('click', handler);
    panelCleanupFns.push(() => panelBtn.removeEventListener('click', handler));
  }

  document.querySelectorAll('.panel-tab').forEach(tab => {
    const handler = () => { switchTab(tab.dataset.tab); };
    tab.addEventListener('click', handler);
    panelCleanupFns.push(() => tab.removeEventListener('click', handler));
  });

  // Initialize tabs

  screenshots.setupScreenshots(updateConnectionStatus);
  oracle.setupOracleTab(updateConnectionStatus);
  if (busInstance) commsConsole.setupCommsConsoleTab(busInstance);

  apiKeys.setupApiKeysTab();
  if (busInstance) bridge.setupBridgeTab(busInstance);
}

module.exports = {
  setConnectionStatusCallback,
  togglePanel,
  isPanelOpen,
  switchTab,
  setupRightPanel,
  destroyAllTabs
};
