/**
 * Tabs and panels module
 * Refactored to modular architecture (Session 72)
 * Devtools tabs removed (Session 101) — kept: activity, screenshots, oracle, git
 */

// Sub-modules
const activity = require('./tabs/activity');
const screenshots = require('./tabs/screenshots');
const oracle = require('./tabs/oracle');
const git = require('./tabs/git');
const apiKeys = require('./tabs/api-keys');

// Panel state
let panelOpen = false;
let onConnectionStatusUpdate = null;
let storedResizeFn = null;

function setConnectionStatusCallback(cb) {
  onConnectionStatusUpdate = cb;
}

function updateConnectionStatus(status) {
  if (onConnectionStatusUpdate) {
    onConnectionStatusUpdate(status);
  }
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

  if (handleResizeFn) {
    setTimeout(handleResizeFn, 350);
  }
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
  if (storedResizeFn) {
    setTimeout(storedResizeFn, 350);
  }
}

function setupRightPanel(handleResizeFn) {
  storedResizeFn = handleResizeFn;

  const panelBtn = document.getElementById('panelBtn');
  if (panelBtn) {
    panelBtn.addEventListener('click', () => togglePanel(handleResizeFn));
  }

  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
    });
  });

  // Initialize tabs
  activity.setupActivityTab();
  screenshots.setupScreenshots(updateConnectionStatus);
  oracle.setupOracleTab(updateConnectionStatus);
  git.setupGitTab();
  apiKeys.setupApiKeysTab();
}

module.exports = {
  setConnectionStatusCallback,
  togglePanel,
  isPanelOpen,
  switchTab,
  setupRightPanel
};