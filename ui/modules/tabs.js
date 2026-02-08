/**
 * Tabs and panels module
 * Refactored to modular architecture (Session 72)
 */

const { ipcRenderer } = require('electron');
const log = require('./logger');

// Sub-modules
const activity = require('./tabs/activity');
const processes = require('./tabs/processes');
const projects = require('./tabs/projects');
const history = require('./tabs/history');
const build = require('./tabs/build');
const friction = require('./tabs/friction');
const screenshots = require('./tabs/screenshots');
const tests = require('./tabs/tests');
const debug = require('./tabs/debug');
const debugReplay = require('./tabs/debug-replay');
const mcp = require('./tabs/mcp');
const docs = require('./tabs/docs');
const oracle = require('./tabs/oracle');
const memory = require('./tabs/memory');
const health = require('./tabs/health');
const git = require('./tabs/git');
const workflow = require('./tabs/workflow');
const review = require('./tabs/review');
const perf = require('./tabs/perf');
const templates = require('./tabs/templates');

// Panel state
let panelOpen = false;
let devtoolsOpen = false;
let onConnectionStatusUpdate = null;

const PRIMARY_TABS = new Set(['activity', 'screenshots', 'oracle', 'git']);
const DEVTOOLS_STORAGE_KEY = 'hivemind-devtools-open';

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
}

function toggleDevtools() {
  const panelTabs = document.querySelector('.panel-tabs');
  if (!panelTabs) return;

  devtoolsOpen = !devtoolsOpen;
  panelTabs.classList.toggle('show-devtools', devtoolsOpen);

  // If closing devtools and current active tab is a devtools tab, switch to first primary tab
  if (!devtoolsOpen) {
    const activeTab = document.querySelector('.panel-tab.active');
    if (activeTab && activeTab.dataset.tabGroup === 'devtools') {
      switchTab('activity');
    }
  }

  // Persist
  try {
    localStorage.setItem(DEVTOOLS_STORAGE_KEY, devtoolsOpen ? '1' : '0');
  } catch (e) {
    // localStorage may be unavailable
  }
}

function isDevtoolsOpen() {
  return devtoolsOpen;
}

function setupRightPanel(handleResizeFn) {
  const panelBtn = document.getElementById('panelBtn');
  if (panelBtn) {
    panelBtn.addEventListener('click', () => togglePanel(handleResizeFn));
  }

  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.id === 'devtoolsToggle') return; // handled separately
      switchTab(tab.dataset.tab);
    });
  });

  // Dev Tools toggle
  const devtoolsBtn = document.getElementById('devtoolsToggle');
  if (devtoolsBtn) {
    devtoolsBtn.addEventListener('click', toggleDevtools);
  }

  // Restore devtools state from localStorage
  try {
    const stored = localStorage.getItem(DEVTOOLS_STORAGE_KEY);
    if (stored === '1') {
      devtoolsOpen = true;
      const panelTabs = document.querySelector('.panel-tabs');
      if (panelTabs) panelTabs.classList.add('show-devtools');
    }
  } catch (e) {
    // localStorage may be unavailable
  }

  // Initialize all modular tabs
  activity.setupActivityTab();
  processes.setupProcessesTab();
  projects.setupProjectsTab(updateConnectionStatus);
  history.setupHistoryTab();
  build.setupBuildProgressTab();
  friction.setupFrictionPanel();
  screenshots.setupScreenshots(updateConnectionStatus);
  tests.setupTestsTab(updateConnectionStatus);
  tests.setupCIStatusIndicator();
  debug.setupInspectorTab();
  debug.setupQueueTab();
  debugReplay.setupDebugTab();
  mcp.setupMCPStatus();
  docs.setupDocsTab(updateConnectionStatus);
  oracle.setupOracleTab(updateConnectionStatus);
  memory.setupMemoryTab();
  health.setupHealthTab();
  git.setupGitTab();
  workflow.setupWorkflowTab();
  workflow.setupGraphTab();
  review.setupReviewTab();
  perf.setupPerformanceTab();
  templates.setupTemplatesTab();
}

module.exports = {
  setConnectionStatusCallback,
  togglePanel,
  isPanelOpen,
  switchTab,
  toggleDevtools,
  isDevtoolsOpen,
  setupRightPanel,
  // Re-export key functions for backward compatibility/other modules
  updateBuildProgress: build.updateBuildProgress,
  refreshBuildProgress: build.refreshBuildProgress,
  addActivityEntry: activity.addActivityEntry,
  addInspectorEvent: debug.addInspectorEvent,
  updateCIStatus: tests.updateCIStatus,
  updateMCPAgentStatus: mcp.updateMCPAgentStatus
};