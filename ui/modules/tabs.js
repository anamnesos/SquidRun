/**
 * Tabs and panels module
 * Handles right panel, tab switching, screenshots, processes, and build progress
 */

const { ipcRenderer } = require('electron');
const log = require('./logger');

// Panel state
let panelOpen = false;

// Process list
let processList = [];

// Friction files
let frictionFiles = [];

// Current conflicts
let currentConflicts = [];

// Agent names for display
const AGENT_NAMES = {
  '1': 'Architect',
  '2': 'Infra',
  '3': 'Frontend',
  '4': 'Backend',
  '5': 'Analyst',
  '6': 'Reviewer',
};

const PANE_IDS = Object.keys(AGENT_NAMES);

// Status callback
let onConnectionStatusUpdate = null;

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

  // Trigger resize for terminals
  if (handleResizeFn) {
    setTimeout(handleResizeFn, 350);
  }
}

function isPanelOpen() {
  return panelOpen;
}

// Switch panel tab
function switchTab(tabId) {
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabId);
  });

  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `tab-${tabId}`);
  });
}

// ============================================================
// PROCESSES TAB
// ============================================================

function renderProcessList() {
  const listEl = document.getElementById('processList');
  if (!listEl) return;

  if (processList.length === 0) {
    listEl.innerHTML = '<div class="process-empty">No processes running</div>';
    return;
  }

  listEl.innerHTML = processList.map(proc => `
    <div class="process-item" data-process-id="${proc.id}">
      <div class="process-status-dot ${proc.status}"></div>
      <div class="process-info">
        <div class="process-command">${proc.command} ${(proc.args || []).join(' ')}</div>
        <div class="process-details">PID: ${proc.pid || 'N/A'} | Status: ${proc.status}</div>
      </div>
      <button class="process-kill-btn" data-process-id="${proc.id}" ${proc.status !== 'running' ? 'disabled' : ''}>
        Kill
      </button>
    </div>
  `).join('');

  listEl.querySelectorAll('.process-kill-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const processId = btn.dataset.processId;
      btn.disabled = true;
      btn.textContent = 'Killing...';
      const result = await window.hivemind.process.kill(processId);
      if (!result.success) {
        updateConnectionStatus(`Failed to kill process: ${result.error}`);
        btn.disabled = false;
        btn.textContent = 'Kill';
      }
    });
  });
}

async function loadProcesses() {
  try {
    const result = await window.hivemind.process.list();
    if (result.success) {
      processList = result.processes;
      renderProcessList();
    }
  } catch (err) {
    log.error('Tabs', 'Error loading processes', err);
  }
}

async function spawnProcess(commandStr) {
  if (!commandStr.trim()) return;

  const parts = commandStr.trim().split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  updateConnectionStatus(`Starting: ${commandStr}...`);

  try {
    const result = await window.hivemind.process.spawn(command, args);
    if (result.success) {
      updateConnectionStatus(`Started: ${commandStr} (PID: ${result.pid})`);
    } else {
      updateConnectionStatus(`Failed to start: ${result.error}`);
    }
  } catch (err) {
    updateConnectionStatus(`Error: ${err.message}`);
  }
}

function setupProcessesTab() {
  const commandInput = document.getElementById('processCommandInput');
  const spawnBtn = document.getElementById('processSpawnBtn');

  if (commandInput && spawnBtn) {
    spawnBtn.addEventListener('click', () => {
      spawnProcess(commandInput.value);
      commandInput.value = '';
    });

    commandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        spawnProcess(commandInput.value);
        commandInput.value = '';
      }
    });
  }

  ipcRenderer.on('processes-changed', (event, processes) => {
    processList = processes;
    renderProcessList();
  });

  loadProcesses();
}

// ============================================================
// OB2: ACTIVITY LOG
// ============================================================

let activityLog = [];
let activityFilter = 'all';
let activitySearchText = '';
const MAX_ACTIVITY_ENTRIES = 500;

const ACTIVITY_AGENT_NAMES = {
  '1': 'Architect',
  '2': 'Infra',
  '3': 'Frontend',
  '4': 'Backend',
  '5': 'Analyst',
  '6': 'Reviewer',
  'system': 'System'
};

function formatActivityTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function addActivityEntry(entry) {
  activityLog.push({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    ...entry
  });

  // Trim to max entries
  if (activityLog.length > MAX_ACTIVITY_ENTRIES) {
    activityLog = activityLog.slice(-MAX_ACTIVITY_ENTRIES);
  }

  renderActivityLog();
}

function renderActivityLog() {
  const logEl = document.getElementById('activityLog');
  if (!logEl) return;

  // Apply filters
  let filtered = activityLog;

  if (activityFilter !== 'all') {
    filtered = filtered.filter(e => e.type === activityFilter);
  }

  if (activitySearchText) {
    const search = activitySearchText.toLowerCase();
    filtered = filtered.filter(e =>
      (e.message && e.message.toLowerCase().includes(search)) ||
      (e.agent && ACTIVITY_AGENT_NAMES[e.agent]?.toLowerCase().includes(search))
    );
  }

  if (filtered.length === 0) {
    logEl.innerHTML = '<div class="activity-empty">No matching activity</div>';
    return;
  }

  // Show most recent last (scrolls to bottom)
  logEl.innerHTML = filtered.map(entry => `
    <div class="activity-entry" data-type="${entry.type}">
      <span class="activity-time">${formatActivityTime(entry.timestamp)}</span>
      <span class="activity-agent" data-agent="${entry.agent}">${ACTIVITY_AGENT_NAMES[entry.agent] || entry.agent}</span>
      <span class="activity-type ${entry.type}">${entry.type}</span>
      <span class="activity-message">${entry.message}</span>
    </div>
  `).join('');

  // Auto-scroll to bottom
  logEl.scrollTop = logEl.scrollHeight;
}

async function loadActivityLog() {
  try {
    const result = await ipcRenderer.invoke('get-activity-log');
    if (result && result.success) {
      activityLog = result.entries || [];
      renderActivityLog();
    }
  } catch (err) {
    log.error('OB2', 'Error loading activity log', err);
  }
}

function clearActivityLog() {
  if (!confirm('Clear all activity entries?')) return;
  activityLog = [];
  renderActivityLog();
  ipcRenderer.invoke('clear-activity-log').catch(() => {});
  updateConnectionStatus('Activity log cleared');
}

function exportActivityLog() {
  const content = activityLog.map(e =>
    `[${e.timestamp}] [${ACTIVITY_AGENT_NAMES[e.agent] || e.agent}] [${e.type}] ${e.message}`
  ).join('\n');

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `activity-log-${new Date().toISOString().split('T')[0]}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  updateConnectionStatus('Activity log exported');
}

function setupActivityTab() {
  // Filter buttons
  document.querySelectorAll('.activity-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.activity-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activityFilter = btn.dataset.filter;
      renderActivityLog();
    });
  });

  // Search box
  const searchInput = document.getElementById('activitySearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      activitySearchText = searchInput.value;
      renderActivityLog();
    });
  }

  // Action buttons
  const clearBtn = document.getElementById('clearActivityBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearActivityLog);

  const exportBtn = document.getElementById('exportActivityBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportActivityLog);

  // Listen for activity events
  ipcRenderer.on('activity-entry', (event, entry) => {
    addActivityEntry(entry);
  });

  loadActivityLog();
}

// ============================================================
// TR1: TEST RESULTS PANEL
// ============================================================

let testResults = [];
let testSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
let testStatus = 'idle'; // idle, running, passed, failed

function formatTestDuration(ms) {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function renderTestSummary() {
  const passedEl = document.getElementById('testPassedCount');
  const failedEl = document.getElementById('testFailedCount');
  const skippedEl = document.getElementById('testSkippedCount');

  if (passedEl) passedEl.textContent = testSummary.passed || 0;
  if (failedEl) failedEl.textContent = testSummary.failed || 0;
  if (skippedEl) skippedEl.textContent = testSummary.skipped || 0;

  // Update progress bar
  const total = testSummary.total || 0;
  if (total > 0) {
    const passedPct = (testSummary.passed / total) * 100;
    const failedPct = (testSummary.failed / total) * 100;
    const skippedPct = (testSummary.skipped / total) * 100;

    const passedBar = document.getElementById('testProgressPassed');
    const failedBar = document.getElementById('testProgressFailed');
    const skippedBar = document.getElementById('testProgressSkipped');

    if (passedBar) passedBar.style.width = `${passedPct}%`;
    if (failedBar) failedBar.style.width = `${failedPct}%`;
    if (skippedBar) skippedBar.style.width = `${skippedPct}%`;
  }

  // Update status badge
  const statusBadge = document.getElementById('testStatusBadge');
  if (statusBadge) {
    statusBadge.className = `test-status-badge ${testStatus}`;
    switch (testStatus) {
      case 'running':
        statusBadge.textContent = 'Running tests...';
        break;
      case 'passed':
        statusBadge.textContent = `All ${testSummary.passed} tests passed`;
        break;
      case 'failed':
        statusBadge.textContent = `${testSummary.failed} test(s) failed`;
        break;
      default:
        statusBadge.textContent = 'No tests run';
    }
  }
}

function renderTestResults() {
  const listEl = document.getElementById('testResultsList');
  if (!listEl) return;

  if (testResults.length === 0) {
    listEl.innerHTML = '<div class="test-empty">No test results yet. Run tests to see results here.</div>';
    return;
  }

  // Sort: failed first, then passed, then skipped
  const sorted = [...testResults].sort((a, b) => {
    const order = { failed: 0, passed: 1, skipped: 2 };
    return (order[a.status] || 3) - (order[b.status] || 3);
  });

  listEl.innerHTML = sorted.map((test, idx) => `
    <div class="test-result-item ${test.status}" data-idx="${idx}">
      <div class="test-result-header">
        <span class="test-result-name" title="${test.name}">${test.name}</span>
        <span class="test-result-status ${test.status}">${test.status.toUpperCase()}</span>
      </div>
      ${test.duration ? `<div class="test-result-duration">${formatTestDuration(test.duration)}</div>` : ''}
      ${test.error ? `<div class="test-result-error">${escapeHtml(test.error)}</div>` : ''}
    </div>
  `).join('');

  // Click to expand/collapse error details
  listEl.querySelectorAll('.test-result-item').forEach(item => {
    item.addEventListener('click', () => {
      if (item.querySelector('.test-result-error')) {
        item.classList.toggle('expanded');
      }
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateTestStatus(status) {
  testStatus = status;
  renderTestSummary();
}

function addTestResult(result) {
  testResults.push(result);

  // Update summary
  if (result.status === 'passed') testSummary.passed++;
  else if (result.status === 'failed') testSummary.failed++;
  else if (result.status === 'skipped') testSummary.skipped++;
  testSummary.total++;

  renderTestSummary();
  renderTestResults();
}

function setTestResults(results, summary) {
  testResults = results || [];
  // Use testResults.length (already defaulted) to avoid null reference on results
  testSummary = summary || { passed: 0, failed: 0, skipped: 0, total: testResults.length };
  testStatus = testSummary.failed > 0 ? 'failed' : (testSummary.passed > 0 ? 'passed' : 'idle');

  renderTestSummary();
  renderTestResults();
}

function clearTestResults() {
  testResults = [];
  testSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
  testStatus = 'idle';
  renderTestSummary();
  renderTestResults();
  updateConnectionStatus('Test results cleared');
}

async function runTests() {
  updateConnectionStatus('Running tests...');
  updateCIStatus('running'); // Task #10: Show CI indicator during test run
  testStatus = 'running';
  testResults = [];
  testSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
  renderTestSummary();
  renderTestResults();

  try {
    const result = await ipcRenderer.invoke('run-tests');
    if (result && result.success) {
      // Defensive: ensure results is an array and summary has required fields
      const results = Array.isArray(result.results) ? result.results : [];
      const summary = result.summary || { passed: 0, failed: 0, skipped: 0, total: results.length };
      setTestResults(results, summary);
      const allPassed = summary.failed === 0;
      updateCIStatus(allPassed ? 'passing' : 'failing',
        allPassed ? null : `${summary.failed} tests failed`);
      updateConnectionStatus(`Tests complete: ${summary.passed} passed, ${summary.failed} failed`);
    } else {
      testStatus = 'idle';
      updateCIStatus('failing', result?.error || 'Test run failed');
      renderTestSummary();
      updateConnectionStatus(`Test run failed: ${result?.error || 'Unknown error'}`);
    }
  } catch (err) {
    testStatus = 'idle';
    updateCIStatus('failing', err.message);
    renderTestSummary();
    updateConnectionStatus(`Test error: ${err.message}`);
  }
}

async function loadTestResults() {
  try {
    const result = await ipcRenderer.invoke('get-test-results');
    if (result && result.success) {
      // Defensive: ensure results is an array and summary has required fields
      const results = Array.isArray(result.results) ? result.results : [];
      const summary = result.summary || { passed: 0, failed: 0, skipped: 0, total: results.length };
      setTestResults(results, summary);
    }
  } catch (err) {
    log.error('TR1', 'Error loading test results', err);
  }
}

function setupTestsTab() {
  const runBtn = document.getElementById('runTestsBtn');
  if (runBtn) runBtn.addEventListener('click', runTests);

  const refreshBtn = document.getElementById('refreshTestsBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadTestResults);

  const clearBtn = document.getElementById('clearTestsBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearTestResults);

  // Listen for test events from backend
  ipcRenderer.on('test-started', () => {
    testStatus = 'running';
    testResults = [];
    testSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
    renderTestSummary();
    renderTestResults();
  });

  ipcRenderer.on('test-result', (event, result) => {
    addTestResult(result);
  });

  ipcRenderer.on('test-complete', (event, data) => {
    // Defensive: ensure data and its fields are valid
    if (!data) return;
    const results = Array.isArray(data.results) ? data.results : [];
    const summary = data.summary || { passed: 0, failed: 0, skipped: 0, total: results.length };
    setTestResults(results, summary);
    updateConnectionStatus(`Tests complete: ${summary.passed} passed, ${summary.failed} failed`);
  });

  loadTestResults();
}

// ============================================================
// CI2: CI STATUS INDICATOR
// ============================================================

let ciStatus = 'idle'; // idle, running, passing, failing

function updateCIStatus(status, details = null) {
  ciStatus = status;

  const indicator = document.getElementById('ciStatusIndicator');
  const icon = document.getElementById('ciStatusIcon');
  const text = document.getElementById('ciStatusText');

  if (!indicator) return;

  // Remove all status classes
  indicator.className = 'ci-status-indicator';

  switch (status) {
    case 'passing':
      indicator.classList.add('passing');
      indicator.style.display = 'flex';
      if (icon) {
        icon.textContent = '✓';
        icon.classList.remove('spinning');
      }
      if (text) text.textContent = 'CI Passing';
      break;

    case 'failing':
      indicator.classList.add('failing');
      indicator.style.display = 'flex';
      if (icon) {
        icon.textContent = '✗';
        icon.classList.remove('spinning');
      }
      if (text) text.textContent = details || 'CI Failing';
      break;

    case 'running':
      indicator.classList.add('running');
      indicator.style.display = 'flex';
      if (icon) {
        icon.textContent = '↻';
        icon.classList.add('spinning');
      }
      if (text) text.textContent = 'CI Running...';
      break;

    case 'idle':
    default:
      indicator.classList.add('idle');
      indicator.style.display = 'none'; // Hide when idle
      if (icon) {
        icon.textContent = '-';
        icon.classList.remove('spinning');
      }
      if (text) text.textContent = 'CI Idle';
      break;
  }
}

function setupCIStatusIndicator() {
  // Listen for CI status events from backend
  ipcRenderer.on('ci-status-changed', (event, data) => {
    updateCIStatus(data.status, data.details);
  });

  ipcRenderer.on('ci-validation-started', () => {
    updateCIStatus('running');
  });

  ipcRenderer.on('ci-validation-passed', () => {
    updateCIStatus('passing');
    // Auto-hide after 10 seconds when passing
    setTimeout(() => {
      if (ciStatus === 'passing') {
        updateCIStatus('idle');
      }
    }, 10000);
  });

  ipcRenderer.on('ci-validation-failed', (event, data) => {
    updateCIStatus('failing', data?.message || 'Validation failed');
  });

  // Task #10: Listen for ci-check-complete from precommit-handlers.js
  ipcRenderer.on('ci-check-complete', (event, data) => {
    if (data && data.passed !== undefined) {
      if (data.passed) {
        updateCIStatus('passing');
        setTimeout(() => {
          if (ciStatus === 'passing') {
            updateCIStatus('idle');
          }
        }, 10000);
      } else {
        const failedChecks = data.checks?.filter(c => !c.passed).map(c => c.name).join(', ');
        updateCIStatus('failing', failedChecks ? `Failed: ${failedChecks}` : 'CI checks failed');
      }
    }
  });

  // Load initial CI status
  ipcRenderer.invoke('get-ci-status').then(result => {
    if (result && result.status) {
      updateCIStatus(result.status, result.details);
    }
  }).catch(() => {
    // CI status not available yet, that's okay
  });
}

// ============================================================
// MC7: MCP STATUS INDICATOR
// ============================================================

const mcpStatus = {
  '1': 'disconnected',
  '2': 'disconnected',
  '3': 'disconnected',
  '4': 'disconnected',
  '5': 'disconnected',
  '6': 'disconnected'
};

const MCP_AGENT_NAMES = {
  '1': 'Architect',
  '2': 'Orchestrator',
  '3': 'Implementer A',
  '4': 'Implementer B',
  '5': 'Investigator',
  '6': 'Reviewer'
};

function updateMCPAgentStatus(paneId, status) {
  // status: 'connected', 'disconnected', 'connecting', 'error'
  mcpStatus[paneId] = status;

  const dot = document.getElementById(`mcpDot${paneId}`);
  if (dot) {
    dot.className = `mcp-agent-dot ${status}`;
    const agentName = MCP_AGENT_NAMES[paneId] || `Pane ${paneId}`;
    const statusText = status.charAt(0).toUpperCase() + status.slice(1);
    dot.title = `${agentName} - ${statusText}`;
  }

  updateMCPSummary();
}

function updateMCPSummary() {
  const summary = document.getElementById('mcpStatusSummary');
  if (!summary) return;

  const connected = Object.values(mcpStatus).filter(s => s === 'connected').length;
  const total = PANE_IDS.length;

  summary.textContent = `${connected}/${total}`;

  // Update summary color
  summary.className = 'mcp-status-summary';
  if (connected === total) {
    summary.classList.add('all-connected');
  } else if (connected > 0) {
    summary.classList.add('partial');
  } else {
    summary.classList.add('none');
  }
}

function setAllMCPStatus(status) {
  for (const paneId of PANE_IDS) {
    updateMCPAgentStatus(paneId, status);
  }
}

async function loadMCPStatus() {
  try {
    const result = await ipcRenderer.invoke('get-mcp-status');
    if (result && result.success) {
      for (const paneId in result.status) {
        updateMCPAgentStatus(paneId, result.status[paneId]);
      }
    }
  } catch (err) {
    // MCP not available yet, that's okay
    log.info('MC7', 'MCP status not available yet');
  }
}

function setupMCPStatusIndicator() {
  // Listen for MCP status events from backend
  ipcRenderer.on('mcp-agent-connected', (event, data) => {
    updateMCPAgentStatus(data.paneId, 'connected');
    updateConnectionStatus(`MCP: ${MCP_AGENT_NAMES[data.paneId]} connected`);
  });

  ipcRenderer.on('mcp-agent-disconnected', (event, data) => {
    updateMCPAgentStatus(data.paneId, 'disconnected');
  });

  ipcRenderer.on('mcp-agent-connecting', (event, data) => {
    updateMCPAgentStatus(data.paneId, 'connecting');
  });

  ipcRenderer.on('mcp-agent-error', (event, data) => {
    updateMCPAgentStatus(data.paneId, 'error');
    updateConnectionStatus(`MCP: ${MCP_AGENT_NAMES[data.paneId]} error - ${data.error}`);
  });

  ipcRenderer.on('mcp-status-changed', (event, data) => {
    if (data.status) {
      for (const paneId in data.status) {
        updateMCPAgentStatus(paneId, data.status[paneId]);
      }
    }
  });

  // Click on dot to attempt reconnection
  document.querySelectorAll('.mcp-agent-dot').forEach(dot => {
    dot.addEventListener('click', async () => {
      const paneId = dot.dataset.pane;
      if (mcpStatus[paneId] === 'disconnected' || mcpStatus[paneId] === 'error') {
        updateMCPAgentStatus(paneId, 'connecting');
        try {
          await ipcRenderer.invoke('mcp-reconnect-agent', paneId);
        } catch (err) {
          updateMCPAgentStatus(paneId, 'error');
        }
      }
    });
  });

  // Load initial MCP status
  loadMCPStatus();

  // MC9: Start health monitoring
  startMCPHealthMonitoring();
}

// ============================================================
// MC8: MCP AUTO-CONFIGURATION
// ============================================================

let mcpConfigured = {
  '1': false,
  '2': false,
  '3': false,
  '4': false,
  '5': false,
  '6': false
};

async function configureMCPForAgent(paneId) {
  updateConnectionStatus(`Configuring MCP for ${MCP_AGENT_NAMES[paneId]}...`);
  updateMCPAgentStatus(paneId, 'connecting');

  try {
    const result = await ipcRenderer.invoke('mcp-configure-agent', paneId);
    if (result && result.success) {
      mcpConfigured[paneId] = true;
      updateConnectionStatus(`MCP configured for ${MCP_AGENT_NAMES[paneId]}`);
      return true;
    } else {
      updateConnectionStatus(`MCP config failed for ${MCP_AGENT_NAMES[paneId]}: ${result?.error || 'Unknown error'}`);
      updateMCPAgentStatus(paneId, 'error');
      return false;
    }
  } catch (err) {
    updateConnectionStatus(`MCP config error for ${MCP_AGENT_NAMES[paneId]}: ${err.message}`);
    updateMCPAgentStatus(paneId, 'error');
    return false;
  }
}

async function configureAllMCP() {
  updateConnectionStatus('Configuring MCP for all agents...');

  for (const paneId of PANE_IDS) {
    await configureMCPForAgent(paneId);
  }

  const configured = Object.values(mcpConfigured).filter(Boolean).length;
  updateConnectionStatus(`MCP configured for ${configured}/${PANE_IDS.length} agents`);
}

async function autoConfigureMCPOnSpawn(paneId) {
  // Check if auto-configure is enabled
  try {
    const settings = await ipcRenderer.invoke('get-settings');
    if (settings && settings.mcpAutoConfig !== false) {
      // Only configure if not already configured
      if (!mcpConfigured[paneId]) {
        await configureMCPForAgent(paneId);
      }
    }
  } catch (err) {
    log.error('MC8', 'Error checking MCP auto-config setting', err);
  }
}

function isMCPConfigured(paneId) {
  return mcpConfigured[paneId] === true;
}

function resetMCPConfiguration() {
  mcpConfigured = Object.fromEntries(PANE_IDS.map(paneId => [paneId, false]));
  setAllMCPStatus('disconnected');
}

// ============================================================
// MC9: MCP CONNECTION HEALTH MONITORING
// ============================================================

let mcpHealthCheckInterval = null;
const MCP_HEALTH_CHECK_INTERVAL = 30000; // Check every 30 seconds
const MCP_STALE_THRESHOLD = 60000; // Consider stale after 60 seconds

let lastMCPHealthCheck = Object.fromEntries(PANE_IDS.map(paneId => [paneId, null]));

async function checkMCPHealth() {
  try {
    const result = await ipcRenderer.invoke('get-mcp-status');
    if (!result || !result.success) return;

    const now = Date.now();

    for (const paneId of PANE_IDS) {
      const agentStatus = result.status[paneId];

      if (agentStatus && agentStatus.connected) {
        const lastSeen = agentStatus.lastSeen ? new Date(agentStatus.lastSeen).getTime() : null;

        if (lastSeen && (now - lastSeen) > MCP_STALE_THRESHOLD) {
          // Connection is stale - might be disconnected
          if (mcpStatus[paneId] === 'connected') {
            updateMCPAgentStatus(paneId, 'error');
            updateConnectionStatus(`MCP: ${MCP_AGENT_NAMES[paneId]} connection stale`);
          }
        } else {
          // Connection is healthy
          if (mcpStatus[paneId] !== 'connected') {
            updateMCPAgentStatus(paneId, 'connected');
          }
        }

        lastMCPHealthCheck[paneId] = now;
      } else {
        // Not connected
        if (mcpStatus[paneId] === 'connected') {
          updateMCPAgentStatus(paneId, 'disconnected');
          updateConnectionStatus(`MCP: ${MCP_AGENT_NAMES[paneId]} disconnected`);
        }
      }
    }
  } catch (err) {
    log.error('MC9', 'Health check error', err);
  }
}

function startMCPHealthMonitoring() {
  // Stop any existing interval
  stopMCPHealthMonitoring();

  // Initial check
  checkMCPHealth();

  // Start periodic checks
  mcpHealthCheckInterval = setInterval(checkMCPHealth, MCP_HEALTH_CHECK_INTERVAL);
  log.info('MC9', 'MCP health monitoring started');
}

function stopMCPHealthMonitoring() {
  if (mcpHealthCheckInterval) {
    clearInterval(mcpHealthCheckInterval);
    mcpHealthCheckInterval = null;
    log.info('MC9', 'MCP health monitoring stopped');
  }
}

async function attemptMCPReconnect(paneId) {
  updateMCPAgentStatus(paneId, 'connecting');
  updateConnectionStatus(`MCP: Reconnecting ${MCP_AGENT_NAMES[paneId]}...`);

  try {
    const result = await ipcRenderer.invoke('mcp-reconnect-agent', paneId);
    if (result && result.success) {
      // Wait a moment then check connection
      setTimeout(() => checkMCPHealth(), 2000);
    } else {
      updateMCPAgentStatus(paneId, 'error');
      updateConnectionStatus(`MCP: Reconnect failed for ${MCP_AGENT_NAMES[paneId]}`);
    }
  } catch (err) {
    updateMCPAgentStatus(paneId, 'error');
    updateConnectionStatus(`MCP: Reconnect error - ${err.message}`);
  }
}

async function reconnectAllMCP() {
  updateConnectionStatus('MCP: Reconnecting all agents...');

  for (const paneId of PANE_IDS) {
    if (mcpStatus[paneId] !== 'connected') {
      await attemptMCPReconnect(paneId);
    }
  }
}

function getMCPHealthSummary() {
  const connected = Object.values(mcpStatus).filter(s => s === 'connected').length;
  const errors = Object.values(mcpStatus).filter(s => s === 'error').length;
  const connecting = Object.values(mcpStatus).filter(s => s === 'connecting').length;
  const total = PANE_IDS.length;

  return {
    connected,
    disconnected: total - connected - errors - connecting,
    errors,
    connecting,
    healthy: connected === total
  };
}

// ============================================================
// PT2: PERFORMANCE DASHBOARD
// ============================================================

let performanceData = {};
let perfProfileData = null;

function formatAvgTime(ms) {
  if (!ms || ms <= 0) return '--';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatSuccessRate(success, total) {
  if (!total || total === 0) return '--';
  const rate = (success / total) * 100;
  return `${rate.toFixed(0)}%`;
}

function renderPerformanceData() {
  for (const paneId of PANE_IDS) {
    const data = performanceData[paneId] || {};

    const completionsEl = document.getElementById(`perf-completions-${paneId}`);
    const avgtimeEl = document.getElementById(`perf-avgtime-${paneId}`);
    const successEl = document.getElementById(`perf-success-${paneId}`);

    if (completionsEl) completionsEl.textContent = data.completions || 0;
    if (avgtimeEl) avgtimeEl.textContent = formatAvgTime(data.avgResponseTime);
    if (successEl) successEl.textContent = formatSuccessRate(data.successes, data.completions);
  }
}

async function loadPerformanceData() {
  try {
    const result = await ipcRenderer.invoke('get-performance-stats');
    if (result && result.success) {
      performanceData = result.stats || {};
      renderPerformanceData();
    }
  } catch (err) {
    log.error('PT2', 'Error loading performance data', err);
  }
}

function renderPerfProfile() {
  const flameEl = document.getElementById('perfFlameGraph');
  const slowCallsEl = document.getElementById('perfSlowCalls');
  const suggestionsEl = document.getElementById('perfSuggestions');

  if (!perfProfileData || !perfProfileData.summary) {
    if (flameEl) flameEl.innerHTML = '<div class="perf-empty">No profiling data yet</div>';
    if (slowCallsEl) slowCallsEl.innerHTML = '<div class="perf-empty">No slow calls recorded</div>';
    if (suggestionsEl) suggestionsEl.innerHTML = '<div class="perf-empty">Run profiling to get suggestions</div>';
    return;
  }

  const slowest = perfProfileData.summary.slowestHandlers || [];
  const maxAvg = Math.max(...slowest.map(h => h.avgMs || 0), 1);
  if (flameEl) {
    if (slowest.length === 0) {
      flameEl.innerHTML = '<div class="perf-empty">No profiling data yet</div>';
    } else {
      flameEl.innerHTML = slowest.map(handler => {
        const width = Math.max(5, Math.round((handler.avgMs / maxAvg) * 100));
        return `
          <div class="perf-bar">
            <div class="perf-bar-label" title="${handler.handler}">${handler.handler}</div>
            <div class="perf-bar-track"><div class="perf-bar-fill" style="width:${width}%"></div></div>
            <div class="perf-bar-meta">${handler.avgMs}ms</div>
          </div>
        `;
      }).join('');
    }
  }

  const slowCalls = perfProfileData.slowCalls || [];
  if (slowCallsEl) {
    if (slowCalls.length === 0) {
      slowCallsEl.innerHTML = '<div class="perf-empty">No slow calls recorded</div>';
    } else {
      slowCallsEl.innerHTML = slowCalls.map(call => `
        <div class="perf-list-item">
          <span>${call.handler}</span>
          <span>${call.duration}ms</span>
        </div>
      `).join('');
    }
  }

  if (suggestionsEl) {
    const suggestions = buildPerfSuggestions(slowest);
    suggestionsEl.innerHTML = suggestions.length
      ? suggestions.map(text => `<div>• ${text}</div>`).join('')
      : '<div class="perf-empty">No optimization suggestions</div>';
  }
}

function buildPerfSuggestions(slowest) {
  const suggestions = [];
  slowest.slice(0, 5).forEach(handler => {
    const name = handler.handler || '';
    if (name.includes('list') || name.includes('get')) {
      suggestions.push(`Consider caching results for ${name} to reduce repeated fetches.`);
    } else if (name.includes('search') || name.includes('query')) {
      suggestions.push(`Optimize search in ${name} (indexing or narrower queries).`);
    } else if (name.includes('save') || name.includes('write')) {
      suggestions.push(`Batch or debounce writes in ${name} to avoid frequent I/O.`);
    } else {
      suggestions.push(`Review ${name} for heavy work; consider async batching or memoization.`);
    }
  });
  return suggestions;
}

async function loadPerfProfile() {
  try {
    const result = await ipcRenderer.invoke('get-perf-profile');
    if (result?.success) {
      perfProfileData = result;
      const enabledEl = document.getElementById('perfProfileEnabled');
      const thresholdEl = document.getElementById('perfSlowThreshold');
      if (enabledEl) enabledEl.checked = !!result.enabled;
      if (thresholdEl) thresholdEl.value = result.slowThreshold || 100;
      renderPerfProfile();
    }
  } catch (err) {
    log.error('PT3', 'Error loading perf profile', err);
  }
}

async function togglePerfProfile(enabled) {
  try {
    await ipcRenderer.invoke('set-perf-enabled', enabled);
    loadPerfProfile();
  } catch (err) {
    log.error('PT3', 'Error setting perf enabled', err);
  }
}

async function updatePerfThreshold(value) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold <= 0) return;
  try {
    await ipcRenderer.invoke('set-slow-threshold', threshold);
    loadPerfProfile();
  } catch (err) {
    log.error('PT3', 'Error setting perf threshold', err);
  }
}

async function resetPerfProfile() {
  if (!confirm('Reset performance profiling data?')) return;
  try {
    await ipcRenderer.invoke('reset-perf-profile');
    perfProfileData = null;
    renderPerfProfile();
  } catch (err) {
    log.error('PT3', 'Error resetting perf profile', err);
  }
}

async function resetPerformanceData() {
  if (!confirm('Reset all performance statistics?')) return;
  try {
    await ipcRenderer.invoke('reset-performance-stats');
    performanceData = {};
    renderPerformanceData();
    updateConnectionStatus('Performance stats reset');
  } catch (err) {
    log.error('PT2', 'Error resetting performance data', err);
  }
}

function setupPerformanceTab() {
  const refreshBtn = document.getElementById('refreshPerfBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadPerformanceData);

  const resetBtn = document.getElementById('resetPerfBtn');
  if (resetBtn) resetBtn.addEventListener('click', resetPerformanceData);

  const profileRefresh = document.getElementById('perfProfileRefreshBtn');
  if (profileRefresh) profileRefresh.addEventListener('click', loadPerfProfile);

  const profileReset = document.getElementById('perfProfileResetBtn');
  if (profileReset) profileReset.addEventListener('click', resetPerfProfile);

  const enabledEl = document.getElementById('perfProfileEnabled');
  if (enabledEl) enabledEl.addEventListener('change', (e) => togglePerfProfile(e.target.checked));

  const thresholdEl = document.getElementById('perfSlowThreshold');
  if (thresholdEl) thresholdEl.addEventListener('change', (e) => updatePerfThreshold(e.target.value));

  loadPerformanceData();
  loadPerfProfile();
}

// ============================================================
// TM2: TEMPLATE MANAGEMENT
// ============================================================

let templates = [];

function formatTemplateDate(isoString) {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderTemplateList() {
  const listEl = document.getElementById('templateList');
  if (!listEl) return;

  if (templates.length === 0) {
    listEl.innerHTML = '<div class="template-empty">No saved templates</div>';
    return;
  }

  listEl.innerHTML = templates.map(tmpl => `
    <div class="template-item" data-id="${tmpl.id}">
      <div class="template-item-info">
        <div class="template-item-name">${tmpl.name}</div>
        <div class="template-item-date">${formatTemplateDate(tmpl.createdAt)}</div>
      </div>
      <div class="template-item-actions">
        <button class="template-item-btn load-btn" data-id="${tmpl.id}">Load</button>
        <button class="template-item-btn delete" data-id="${tmpl.id}">X</button>
      </div>
    </div>
  `).join('');

  // Load button handlers
  listEl.querySelectorAll('.load-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        const result = await ipcRenderer.invoke('load-template', id);
        if (result && result.success) {
          updateConnectionStatus(`Loaded template: ${result.name}`);
        }
      } catch (err) {
        updateConnectionStatus(`Failed to load template: ${err.message}`);
      }
    });
  });

  // Delete button handlers
  listEl.querySelectorAll('.template-item-btn.delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        await ipcRenderer.invoke('delete-template', id);
        templates = templates.filter(t => t.id !== id);
        renderTemplateList();
        updateConnectionStatus('Template deleted');
      } catch (err) {
        updateConnectionStatus(`Failed to delete template: ${err.message}`);
      }
    });
  });
}

async function loadTemplates() {
  try {
    const result = await ipcRenderer.invoke('get-templates');
    if (result && result.success) {
      templates = result.templates || [];
      renderTemplateList();
    }
  } catch (err) {
    log.error('TM2', 'Error loading templates', err);
  }
}

async function saveTemplate() {
  const input = document.getElementById('templateNameInput');
  const name = input?.value?.trim();
  if (!name) {
    updateConnectionStatus('Enter a template name');
    return;
  }

  try {
    const result = await ipcRenderer.invoke('save-template', name);
    if (result && result.success) {
      input.value = '';
      await loadTemplates();
      updateConnectionStatus(`Saved template: ${name}`);
    }
  } catch (err) {
    updateConnectionStatus(`Failed to save template: ${err.message}`);
  }
}

function setupTemplatesTab() {
  const refreshBtn = document.getElementById('refreshTemplatesBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadTemplates);

  const saveBtn = document.getElementById('saveTemplateBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveTemplate);

  const input = document.getElementById('templateNameInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveTemplate();
    });
  }

  loadTemplates();
}

// ============================================================
// PROJECTS TAB
// ============================================================

// Recent projects data
let recentProjects = [];
let currentProjectPath = null;

function getProjectName(projectPath) {
  // Extract folder name from path
  const parts = projectPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || projectPath;
}

function renderProjectsList() {
  const listEl = document.getElementById('projectsList');
  if (!listEl) return;

  if (recentProjects.length === 0) {
    listEl.innerHTML = '<div class="projects-empty">No recent projects</div>';
    return;
  }

  listEl.innerHTML = recentProjects.map(project => {
    const isActive = project.path === currentProjectPath;
    return `
      <div class="project-item ${isActive ? 'active' : ''}" data-path="${project.path}">
        <div class="project-item-info">
          <div class="project-item-name">${getProjectName(project.path)}</div>
          <div class="project-item-path" title="${project.path}">${project.path}</div>
        </div>
        <button class="project-item-remove" data-path="${project.path}" title="Remove from list">X</button>
      </div>
    `;
  }).join('');

  // Click to switch project
  listEl.querySelectorAll('.project-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.classList.contains('project-item-remove')) return;

      const projectPath = item.dataset.path;
      if (projectPath === currentProjectPath) return;

      updateConnectionStatus(`Switching to ${getProjectName(projectPath)}...`);

      try {
        // Switch project via IPC
        await ipcRenderer.invoke('switch-project', projectPath);
        currentProjectPath = projectPath;
        renderProjectsList();
        updateConnectionStatus(`Switched to ${getProjectName(projectPath)}`);
      } catch (err) {
        updateConnectionStatus(`Failed to switch: ${err.message}`);
      }
    });
  });

  // Remove button
  listEl.querySelectorAll('.project-item-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const projectPath = btn.dataset.path;

      try {
        await ipcRenderer.invoke('remove-recent-project', projectPath);
        recentProjects = recentProjects.filter(p => p.path !== projectPath);
        renderProjectsList();
        updateConnectionStatus(`Removed ${getProjectName(projectPath)} from recent`);
      } catch (err) {
        updateConnectionStatus(`Failed to remove: ${err.message}`);
      }
    });
  });
}

async function loadRecentProjects() {
  try {
    const result = await ipcRenderer.invoke('get-recent-projects');
    if (result && result.success) {
      recentProjects = result.projects || [];
    } else if (Array.isArray(result)) {
      recentProjects = result;
    }

    // Get current project
    const currentProject = await ipcRenderer.invoke('get-project');
    currentProjectPath = currentProject;

    renderProjectsList();
  } catch (err) {
    log.error('Tabs', 'Error loading recent projects', err);
  }
}

async function addCurrentProject() {
  try {
    // Use existing project selector
    const result = await ipcRenderer.invoke('select-project');
    if (result.success) {
      currentProjectPath = result.path;
      await loadRecentProjects();
      updateConnectionStatus(`Added project: ${getProjectName(result.path)}`);
    }
  } catch (err) {
    updateConnectionStatus(`Failed to add project: ${err.message}`);
  }
}

function setupProjectsTab() {
  const refreshBtn = document.getElementById('refreshProjectsBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadRecentProjects);
  }

  const addBtn = document.getElementById('addProjectBtn');
  if (addBtn) {
    addBtn.addEventListener('click', addCurrentProject);
  }

  // Listen for project changes
  ipcRenderer.on('project-changed', (event, projectPath) => {
    currentProjectPath = projectPath;
    loadRecentProjects();
  });

  loadRecentProjects();
}

// ============================================================
// SESSION HISTORY TAB
// ============================================================

// Session history data
let sessionHistory = [];

function formatHistoryTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function renderHistoryList() {
  const listEl = document.getElementById('historyList');
  if (!listEl) return;

  if (sessionHistory.length === 0) {
    listEl.innerHTML = '<div class="history-empty">No sessions recorded yet</div>';
    return;
  }

  // Show most recent first
  const sorted = [...sessionHistory].reverse();

  listEl.innerHTML = sorted.map(session => `
    <div class="history-item" data-timestamp="${session.timestamp}">
      <div class="history-item-header">
        <span class="history-item-agent">${AGENT_NAMES[session.pane] || `Pane ${session.pane}`}</span>
        <span class="history-item-duration">${session.durationFormatted || formatDuration(session.duration)}</span>
      </div>
      <div class="history-item-time">${formatHistoryTime(session.timestamp)}</div>
    </div>
  `).join('');

  // Click to show details
  listEl.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const timestamp = item.dataset.timestamp;
      const session = sessionHistory.find(s => s.timestamp === timestamp);
      if (session) {
        const details = [
          `Agent: ${AGENT_NAMES[session.pane] || `Pane ${session.pane}`}`,
          `Duration: ${session.durationFormatted || formatDuration(session.duration)}`,
          `Started: ${formatHistoryTime(session.timestamp)}`,
        ];
        if (session.filesModified) {
          details.push(`Files Modified: ${session.filesModified.join(', ')}`);
        }
        if (session.commandsRun) {
          details.push(`Commands: ${session.commandsRun}`);
        }
        alert(`Session Details\n\n${details.join('\n')}`);
      }
    });
  });
}

async function loadSessionHistory() {
  try {
    const stats = await ipcRenderer.invoke('get-usage-stats');
    if (stats && stats.recentSessions) {
      sessionHistory = stats.recentSessions;
      renderHistoryList();
    }
  } catch (err) {
    log.error('Tabs', 'Error loading session history', err);
  }
}

function setupHistoryTab() {
  const refreshBtn = document.getElementById('refreshHistoryBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadSessionHistory);
  }
  loadSessionHistory();
}

// ============================================================
// BUILD PROGRESS TAB
// ============================================================

function updateBuildProgress(state) {
  const stateEl = document.getElementById('progressState');
  if (stateEl) {
    const stateName = state.state || 'idle';
    stateEl.textContent = stateName.toUpperCase().replace(/_/g, ' ');
    stateEl.className = 'progress-state-badge ' + stateName.replace(/_/g, '_');
  }

  const checkpointFill = document.getElementById('checkpointFill');
  const checkpointText = document.getElementById('checkpointText');
  if (checkpointFill && checkpointText) {
    const current = state.current_checkpoint || 0;
    const total = state.total_checkpoints || 0;
    const percent = total > 0 ? (current / total) * 100 : 0;
    checkpointFill.style.width = `${percent}%`;
    checkpointText.textContent = `${current} / ${total}`;
  }

  const agentsEl = document.getElementById('activeAgentsList');
  if (agentsEl) {
    const agents = state.active_agents || [];
    if (agents.length === 0) {
      agentsEl.innerHTML = '<span class="no-agents">No agents active</span>';
    } else {
      agentsEl.innerHTML = agents.map(id =>
        `<span class="active-agent-badge">${AGENT_NAMES[id] || `Agent ${id}`}</span>`
      ).join('');
    }
  }

  const frictionEl = document.getElementById('frictionCountDisplay');
  if (frictionEl) {
    frictionEl.textContent = state.friction_count || 0;
  }

  const errorSection = document.getElementById('errorSection');
  const errorDisplay = document.getElementById('errorDisplay');
  if (errorSection && errorDisplay) {
    if (state.error) {
      errorSection.style.display = 'block';
      errorDisplay.textContent = state.error;
    } else if (state.errors && state.errors.length > 0) {
      const lastError = state.errors[state.errors.length - 1];
      errorSection.style.display = 'block';
      errorDisplay.textContent = `${lastError.agent}: ${lastError.message}`;
    } else {
      errorSection.style.display = 'none';
    }
  }
}

async function updateUsageStats() {
  try {
    const stats = await ipcRenderer.invoke('get-usage-stats');
    if (stats) {
      const totalSpawnsEl = document.getElementById('usageTotalSpawns');
      const sessionsTodayEl = document.getElementById('usageSessionsToday');
      const totalTimeEl = document.getElementById('usageTotalTime');
      const estCostEl = document.getElementById('usageEstCost');

      if (totalSpawnsEl) totalSpawnsEl.textContent = stats.totalSpawns || 0;
      if (sessionsTodayEl) sessionsTodayEl.textContent = stats.sessionsToday || 0;
      if (totalTimeEl) totalTimeEl.textContent = stats.totalSessionTime || '0s';
      if (estCostEl) estCostEl.textContent = `$${stats.estimatedCost || '0.00'}`;
    }
  } catch (err) {
    log.error('Tabs', 'Error loading usage stats', err);
  }
}

async function refreshBuildProgress() {
  try {
    const state = await ipcRenderer.invoke('get-state');
    if (state) {
      updateBuildProgress(state);
    }
    await updateUsageStats();
  } catch (err) {
    log.error('Tabs', 'Error loading state', err);
  }
}

function displayConflicts(conflicts) {
  currentConflicts = conflicts;
  const errorSection = document.getElementById('errorSection');
  const errorDisplay = document.getElementById('errorDisplay');
  if (conflicts.length > 0 && errorSection && errorDisplay) {
    errorSection.style.display = 'block';
    errorDisplay.textContent = `Warning: File Conflict: ${conflicts.map(c => c.file).join(', ')}`;
    errorDisplay.style.color = '#ffc857';
  }
}

function setupConflictListener() {
  ipcRenderer.on('file-conflicts-detected', (event, conflicts) => {
    log.info('Conflict', conflicts);
    displayConflicts(conflicts);
  });
}

function setupBuildProgressTab() {
  const refreshBtn = document.getElementById('refreshProgressBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshBuildProgress);
  setupConflictListener();
  refreshBuildProgress();
}

// ============================================================
// FRICTION PANEL
// ============================================================

function updateFrictionBadge(count) {
  // Update old toolbar badge (if still exists)
  const badge = document.getElementById('frictionBadge');
  if (badge) {
    badge.textContent = count;
  }
  // Update new tab badge
  const tabBadge = document.getElementById('frictionTabBadge');
  if (tabBadge) {
    tabBadge.textContent = count;
    tabBadge.classList.toggle('hidden', count === 0);
  }
}

function formatFrictionTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderFrictionList() {
  // Render to both old panel and new tab
  const listEls = [
    document.getElementById('frictionList'),
    document.getElementById('frictionListTab')
  ].filter(Boolean);

  if (listEls.length === 0) return;

  if (frictionFiles.length === 0) {
    listEls.forEach(el => {
      el.innerHTML = '<div class="friction-empty">No friction logs found</div>';
    });
    updateFrictionBadge(0);
    return;
  }

  updateFrictionBadge(frictionFiles.length);

  const html = frictionFiles.map(f => `
    <div class="friction-item" data-filename="${f.name}">
      <span class="friction-item-name">${f.name}</span>
      <span class="friction-item-time">${formatFrictionTime(f.modified)}</span>
    </div>
  `).join('');

  listEls.forEach(el => {
    el.innerHTML = html;
    el.querySelectorAll('.friction-item').forEach(item => {
      item.addEventListener('click', () => viewFrictionFile(item.dataset.filename));
    });
  });
}

async function loadFrictionFiles() {
  try {
    const result = await window.hivemind.friction.list();
    if (result.success) {
      frictionFiles = result.files;
      renderFrictionList();
    }
  } catch (err) {
    log.error('Tabs', 'Error loading friction files', err);
  }
}

async function viewFrictionFile(filename) {
  try {
    const result = await window.hivemind.friction.read(filename);
    if (result.success) {
      alert(`=== ${filename} ===\n\n${result.content}`);
    }
  } catch (err) {
    log.error('Tabs', 'Error reading friction file', err);
  }
}

async function clearFriction() {
  if (!confirm('Clear all friction logs?')) return;

  try {
    const result = await window.hivemind.friction.clear();
    if (result.success) {
      frictionFiles = [];
      renderFrictionList();
      updateConnectionStatus('Friction logs cleared');
    }
  } catch (err) {
    log.error('Tabs', 'Error clearing friction', err);
  }
}

function setupFrictionPanel() {
  // Old panel toggle (if still exists)
  const frictionBtn = document.getElementById('frictionBtn');
  const frictionPanel = document.getElementById('frictionPanel');

  if (frictionBtn && frictionPanel) {
    frictionBtn.addEventListener('click', () => {
      frictionPanel.classList.toggle('open');
      frictionBtn.classList.toggle('active');
      if (frictionPanel.classList.contains('open')) {
        loadFrictionFiles();
      }
    });
  }

  // Old panel buttons
  const refreshBtn = document.getElementById('refreshFrictionBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadFrictionFiles);
  }

  const clearBtn = document.getElementById('clearFrictionBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearFriction);
  }

  // New tab buttons
  const refreshTabBtn = document.getElementById('refreshFrictionTabBtn');
  if (refreshTabBtn) {
    refreshTabBtn.addEventListener('click', loadFrictionFiles);
  }

  const clearTabBtn = document.getElementById('clearFrictionTabBtn');
  if (clearTabBtn) {
    clearTabBtn.addEventListener('click', clearFriction);
  }

  // Load friction on friction tab activation
  document.querySelector('.panel-tab[data-tab="friction"]')?.addEventListener('click', () => {
    loadFrictionFiles();
  });

  loadFrictionFiles();
}

// ============================================================
// SCREENSHOTS
// ============================================================

async function handleScreenshotDrop(files) {
  const listEl = document.getElementById('screenshotList');
  if (!listEl) return;

  const emptyMsg = listEl.querySelector('.screenshot-empty');
  if (emptyMsg) emptyMsg.remove();

  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;

    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Data = e.target.result;

      const result = await window.hivemind.screenshot.save(base64Data, file.name);
      if (!result.success) {
        updateConnectionStatus(`Failed to save ${file.name}: ${result.error}`);
        return;
      }

      const savedFilename = result.filename;
      const savedPath = result.path;

      const item = document.createElement('div');
      item.className = 'screenshot-item';
      item.dataset.filename = savedFilename;
      item.innerHTML = `
        <img class="screenshot-thumb" src="${base64Data}" alt="${savedFilename}">
        <div class="screenshot-info">
          <div class="screenshot-name" title="${savedPath}">${savedFilename}</div>
          <div class="screenshot-size">${(file.size / 1024).toFixed(1)} KB</div>
        </div>
        <div class="screenshot-actions">
          <button class="screenshot-btn copy-btn" title="Copy path">Copy</button>
          <button class="screenshot-btn delete-btn" title="Delete">X</button>
        </div>
      `;

      item.querySelector('.delete-btn').addEventListener('click', async () => {
        const delResult = await window.hivemind.screenshot.delete(savedFilename);
        if (delResult.success) {
          item.remove();
          if (listEl.children.length === 0) {
            listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
          }
          updateConnectionStatus(`Deleted ${savedFilename}`);
        } else {
          updateConnectionStatus(`Failed to delete: ${delResult.error}`);
        }
      });

      item.querySelector('.copy-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(savedPath);
          updateConnectionStatus(`Copied path: ${savedPath}`);
        } catch (err) {
          updateConnectionStatus(`Copy failed: ${err.message}`);
        }
      });

      listEl.appendChild(item);
    };
    reader.readAsDataURL(file);
  }

  updateConnectionStatus(`Saving ${files.length} screenshot(s)...`);
}

async function loadScreenshots() {
  const listEl = document.getElementById('screenshotList');
  if (!listEl) return;

  try {
    const result = await window.hivemind.screenshot.list();
    if (!result.success) {
      log.error('Tabs', 'Failed to load screenshots', result.error);
      return;
    }

    if (result.files.length === 0) {
      listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
      return;
    }

    listEl.innerHTML = '';

    for (const file of result.files) {
      const item = document.createElement('div');
      item.className = 'screenshot-item';
      item.dataset.filename = file.name;
      item.innerHTML = `
        <img class="screenshot-thumb" src="file://${file.path.replace(/\\/g, '/')}" alt="${file.name}">
        <div class="screenshot-info">
          <div class="screenshot-name" title="${file.path}">${file.name}</div>
          <div class="screenshot-size">${(file.size / 1024).toFixed(1)} KB</div>
        </div>
        <div class="screenshot-actions">
          <button class="screenshot-btn copy-btn" title="Copy path">Copy</button>
          <button class="screenshot-btn delete-btn" title="Delete">X</button>
        </div>
      `;

      const savedFilename = file.name;
      const savedPath = file.path;
      item.querySelector('.delete-btn').addEventListener('click', async () => {
        const delResult = await window.hivemind.screenshot.delete(savedFilename);
        if (delResult.success) {
          item.remove();
          if (listEl.children.length === 0) {
            listEl.innerHTML = '<div class="screenshot-empty">No screenshots yet</div>';
          }
          updateConnectionStatus(`Deleted ${savedFilename}`);
        } else {
          updateConnectionStatus(`Failed to delete: ${delResult.error}`);
        }
      });

      item.querySelector('.copy-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(savedPath);
          updateConnectionStatus(`Copied path: ${savedPath}`);
        } catch (err) {
          updateConnectionStatus(`Copy failed: ${err.message}`);
        }
      });

      listEl.appendChild(item);
    }

    updateConnectionStatus(`Loaded ${result.files.length} screenshot(s)`);
  } catch (err) {
    log.error('Tabs', 'Error loading screenshots', err);
  }
}

function setupRightPanel(handleResizeFn) {
  const panelBtn = document.getElementById('panelBtn');
  if (panelBtn) {
    panelBtn.addEventListener('click', () => togglePanel(handleResizeFn));
  }

  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchTab(tab.dataset.tab);
    });
  });

  const dropzone = document.getElementById('screenshotDropzone');
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      handleScreenshotDrop(e.dataTransfer.files);
    });

    dropzone.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.onchange = () => handleScreenshotDrop(input.files);
      input.click();
    });
  }

  document.addEventListener('paste', (e) => {
    if (panelOpen) {
      const items = e.clipboardData.items;
      const files = [];
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          files.push(item.getAsFile());
        }
      }
      if (files.length > 0) {
        handleScreenshotDrop(files);
      }
    }
  });

  loadScreenshots();
}

// ============================================================
// P2-5: MESSAGE INSPECTOR TAB
// ============================================================

let inspectorEvents = [];
let inspectorFilter = 'all';
let inspectorAutoScroll = true;
let inspectorPaused = false;
const MAX_INSPECTOR_EVENTS = 500;

const INSPECTOR_STATS = {
  total: 0,
  delivered: 0,
  pending: 0,
  skipped: 0
};

const INSPECTOR_AGENT_NAMES = {
  '1': 'Arch',
  '2': 'Orch',
  '3': 'ImpA',
  '4': 'ImpB',
  '5': 'Inv',
  '6': 'Rev',
  'lead': 'Arch',
  'architect': 'Arch',
  'orchestrator': 'Orch',
  'worker-a': 'ImpA',
  'implementer-a': 'ImpA',
  'worker-b': 'ImpB',
  'implementer-b': 'ImpB',
  'investigator': 'Inv',
  'reviewer': 'Rev',
  'system': 'Sys',
  'all': 'All',
  'workers': 'Workers'
};

function formatInspectorTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getAgentShortName(id) {
  if (!id) return '?';
  const strId = String(id);
  return INSPECTOR_AGENT_NAMES[strId] || INSPECTOR_AGENT_NAMES[strId.toLowerCase()] || strId;
}

function addInspectorEvent(event) {
  if (inspectorPaused) return;

  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    ...event
  };

  inspectorEvents.push(entry);

  // Trim to max
  if (inspectorEvents.length > MAX_INSPECTOR_EVENTS) {
    inspectorEvents = inspectorEvents.slice(-MAX_INSPECTOR_EVENTS);
  }

  // Update stats
  INSPECTOR_STATS.total++;
  if (event.status === 'delivered' || event.status === 'success') {
    INSPECTOR_STATS.delivered++;
  } else if (event.status === 'pending') {
    INSPECTOR_STATS.pending++;
  } else if (event.status === 'skipped' || event.status === 'blocked') {
    INSPECTOR_STATS.skipped++;
  }

  renderInspectorStats();
  renderInspectorLog();
}

function renderInspectorStats() {
  const totalEl = document.getElementById('inspectorTotalEvents');
  const deliveredEl = document.getElementById('inspectorDelivered');
  const pendingEl = document.getElementById('inspectorPending');
  const skippedEl = document.getElementById('inspectorSkipped');

  if (totalEl) totalEl.textContent = INSPECTOR_STATS.total;
  if (deliveredEl) deliveredEl.textContent = INSPECTOR_STATS.delivered;
  if (pendingEl) pendingEl.textContent = INSPECTOR_STATS.pending;
  if (skippedEl) skippedEl.textContent = INSPECTOR_STATS.skipped;
}

function renderInspectorLog() {
  const logEl = document.getElementById('inspectorLog');
  if (!logEl) return;

  // Apply filter
  let filtered = inspectorEvents;
  if (inspectorFilter !== 'all') {
    filtered = inspectorEvents.filter(e => e.type === inspectorFilter);
  }

  if (filtered.length === 0) {
    logEl.innerHTML = '<div class="inspector-empty">No events captured yet. Trigger files or send messages to see activity.</div>';
    return;
  }

  logEl.innerHTML = filtered.map(event => {
    const time = formatInspectorTime(event.timestamp);
    const from = getAgentShortName(event.from);
    const to = getAgentShortName(event.to);
    const seq = event.seq ? `#${event.seq}` : '';
    const statusIcon = event.status === 'delivered' || event.status === 'success' ? '✓' :
                       event.status === 'pending' ? '⏳' :
                       event.status === 'skipped' || event.status === 'blocked' ? '✗' : '';
    const statusClass = event.status === 'delivered' || event.status === 'success' ? 'success' :
                        event.status === 'pending' ? 'pending' : 'failed';
    const msgPreview = event.message ? event.message.substring(0, 60) + (event.message.length > 60 ? '...' : '') : '';

    return `
      <div class="inspector-event" data-id="${event.id}" title="${escapeHtml(event.message || '')}">
        <span class="inspector-event-time">${time}</span>
        <span class="inspector-event-type ${event.type}">${event.type}</span>
        <span class="inspector-event-route">
          ${from}<span class="arrow">→</span>${to}
        </span>
        <span class="inspector-event-seq">${seq}</span>
        <span class="inspector-event-status ${statusClass}">${statusIcon}</span>
        <span class="inspector-event-message">${escapeHtml(msgPreview)}</span>
      </div>
    `;
  }).join('');

  // Auto-scroll
  if (inspectorAutoScroll) {
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function clearInspectorLog() {
  inspectorEvents = [];
  INSPECTOR_STATS.total = 0;
  INSPECTOR_STATS.delivered = 0;
  INSPECTOR_STATS.pending = 0;
  INSPECTOR_STATS.skipped = 0;
  renderInspectorStats();
  renderInspectorLog();
  updateConnectionStatus('Inspector log cleared');
}

function exportInspectorLog() {
  const content = inspectorEvents.map(e => {
    const time = new Date(e.timestamp).toISOString();
    return `[${time}] [${e.type}] ${e.from || '?'} -> ${e.to || '?'} #${e.seq || 'N/A'} (${e.status || 'unknown'}) ${e.message || ''}`;
  }).join('\n');

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `inspector-log-${new Date().toISOString().split('T')[0]}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  updateConnectionStatus('Inspector log exported');
}

async function loadSequenceState() {
  try {
    const result = await ipcRenderer.invoke('get-message-state');
    if (result && result.success && result.state) {
      const sequences = result.state.sequences || {};

      for (const agent of ['lead', 'orchestrator', 'worker-a', 'worker-b', 'investigator', 'reviewer']) {
        const el = document.getElementById(`seq-${agent}`);
        if (el) {
          const agentState = sequences[agent];
          if (agentState && agentState.lastSeen) {
            const lastSeenEntries = Object.entries(agentState.lastSeen);
            if (lastSeenEntries.length > 0) {
              el.textContent = lastSeenEntries.map(([sender, seq]) => `${getAgentShortName(sender)}:#${seq}`).join(', ');
            } else {
              el.textContent = 'clean';
            }
          } else {
            el.textContent = 'clean';
          }
        }
      }
    }
  } catch (err) {
    log.error('P2-5', 'Error loading sequence state', err);
  }
}

// Task #8: Load and display reliability analytics
async function loadReliabilityStats() {
  try {
    const result = await ipcRenderer.invoke('get-reliability-stats');
    if (result && result.success && result.stats) {
      const stats = result.stats;

      // Main overview stats
      const successRateEl = document.getElementById('reliabilitySuccessRate');
      if (successRateEl) successRateEl.textContent = `${stats.aggregate.successRate}%`;

      const uptimeEl = document.getElementById('reliabilityUptime');
      if (uptimeEl) uptimeEl.textContent = stats.uptimeFormatted || '--';

      const latencyEl = document.getElementById('reliabilityLatency');
      if (latencyEl) latencyEl.textContent = stats.latency.avg > 0 ? `${stats.latency.avg}ms` : '--';

      // Detail rows
      const sentEl = document.getElementById('reliabilitySent');
      if (sentEl) sentEl.textContent = stats.aggregate.sent;

      const deliveredEl = document.getElementById('reliabilityDelivered');
      if (deliveredEl) deliveredEl.textContent = stats.aggregate.delivered;

      const failedEl = document.getElementById('reliabilityFailed');
      if (failedEl) failedEl.textContent = stats.aggregate.failed;

      const timedOutEl = document.getElementById('reliabilityTimedOut');
      if (timedOutEl) timedOutEl.textContent = stats.aggregate.timedOut;

      const skippedEl = document.getElementById('reliabilitySkipped');
      if (skippedEl) skippedEl.textContent = stats.aggregate.skipped;

      // Mode stats
      const ptySentEl = document.getElementById('reliabilityPtySent');
      if (ptySentEl) ptySentEl.textContent = stats.byMode.pty.sent;

      const ptyDeliveredEl = document.getElementById('reliabilityPtyDelivered');
      if (ptyDeliveredEl) ptyDeliveredEl.textContent = stats.byMode.pty.delivered;

      const sdkSentEl = document.getElementById('reliabilitySdkSent');
      if (sdkSentEl) sdkSentEl.textContent = stats.byMode.sdk.sent;

      const sdkDeliveredEl = document.getElementById('reliabilitySdkDelivered');
      if (sdkDeliveredEl) sdkDeliveredEl.textContent = stats.byMode.sdk.delivered;

      // Rolling windows
      const window15m = stats.windows.last15m;
      const el15m = document.getElementById('reliability15m');
      if (el15m) {
        el15m.textContent = `${window15m.sent} sent, ${window15m.delivered} delivered`;
      }

      const window1h = stats.windows.last1h;
      const el1h = document.getElementById('reliability1h');
      if (el1h) {
        el1h.textContent = `${window1h.sent} sent, ${window1h.delivered} delivered`;
      }
    }
  } catch (err) {
    log.error('Task8', 'Error loading reliability stats', err);
  }
}

function setupInspectorTab() {
  // Filter buttons
  document.querySelectorAll('.inspector-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.inspector-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      inspectorFilter = btn.dataset.filter;
      renderInspectorLog();
    });
  });

  // Auto-scroll checkbox
  const autoScrollCheck = document.getElementById('inspectorAutoScroll');
  if (autoScrollCheck) {
    autoScrollCheck.addEventListener('change', () => {
      inspectorAutoScroll = autoScrollCheck.checked;
    });
  }

  // Pause checkbox
  const pauseCheck = document.getElementById('inspectorPaused');
  if (pauseCheck) {
    pauseCheck.addEventListener('change', () => {
      inspectorPaused = pauseCheck.checked;
    });
  }

  // Action buttons
  const refreshBtn = document.getElementById('refreshInspectorBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadSequenceState);

  const clearBtn = document.getElementById('clearInspectorBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearInspectorLog);

  const exportBtn = document.getElementById('exportInspectorBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportInspectorLog);

  // Task #8: Reliability stats refresh button
  const reliabilityRefreshBtn = document.getElementById('refreshReliabilityBtn');
  if (reliabilityRefreshBtn) reliabilityRefreshBtn.addEventListener('click', loadReliabilityStats);

  // Load initial reliability stats
  loadReliabilityStats();

  // Listen for message flow events from main process
  ipcRenderer.on('inject-message', (event, data) => {
    // PTY injection event
    const panes = data.panes || [];
    panes.forEach(paneId => {
      addInspectorEvent({
        type: 'pty',
        from: 'system',
        to: paneId,
        message: data.message ? data.message.replace(/\r/g, '') : '',
        status: 'delivered'
      });
    });
  });

  ipcRenderer.on('sdk-message', (event, data) => {
    // SDK message event
    addInspectorEvent({
      type: 'sdk',
      from: data.from || 'system',
      to: data.paneId || data.to,
      message: data.message || data.content,
      seq: data.seq,
      status: 'delivered'
    });
  });

  ipcRenderer.on('sync-triggered', (event, data) => {
    // Sync context trigger
    addInspectorEvent({
      type: 'trigger',
      from: 'system',
      to: data.notified ? data.notified.join(',') : 'all',
      message: `Sync: ${data.file || 'shared_context.md'}`,
      status: 'delivered'
    });
  });

  ipcRenderer.on('trigger-blocked', (event, data) => {
    // Blocked/skipped trigger
    addInspectorEvent({
      type: 'blocked',
      from: data.sender || 'unknown',
      to: data.recipient || data.target,
      message: data.reason || 'Duplicate or blocked',
      seq: data.seq,
      status: 'skipped'
    });
    // Decrement delivered, increment skipped for accuracy
    if (INSPECTOR_STATS.delivered > 0) INSPECTOR_STATS.delivered--;
  });

  ipcRenderer.on('trigger-sent-sdk', (event, data) => {
    addInspectorEvent({
      type: 'sdk',
      from: data.from || 'trigger',
      to: data.paneId,
      message: data.message,
      seq: data.seq,
      status: 'delivered'
    });
  });

  ipcRenderer.on('broadcast-sent', (event, data) => {
    addInspectorEvent({
      type: 'broadcast',
      from: 'user',
      to: data.notified ? data.notified.join(',') : 'all',
      message: data.message,
      status: 'delivered'
    });
  });

  ipcRenderer.on('direct-message-sent', (event, data) => {
    addInspectorEvent({
      type: 'trigger',
      from: data.from,
      to: data.to,
      message: data.message,
      seq: data.seq,
      status: 'delivered'
    });
  });

  ipcRenderer.on('task-routed', (event, data) => {
    addInspectorEvent({
      type: 'trigger',
      from: 'router',
      to: data.targetPaneId,
      message: `Task routed: ${data.message ? data.message.substring(0, 50) : 'N/A'}`,
      status: 'delivered'
    });
  });

  ipcRenderer.on('auto-handoff', (event, data) => {
    addInspectorEvent({
      type: 'trigger',
      from: data.from,
      to: data.to,
      message: `Auto-handoff: ${data.message || 'N/A'}`,
      status: 'delivered'
    });
  });

  // Load initial state
  loadSequenceState();
  renderInspectorStats();
}

// ============================================================
// Task #3: Task Queue Dashboard
// ============================================================

let queueStatus = null;
let conflictStatus = null;
let queueClaims = {};
let queueEvents = [];
let queueRefreshTimer = null;
let queueRefreshInFlight = false;
let queuePoller = null;
const MAX_QUEUE_EVENTS = 120;

function formatQueueTime(timestamp) {
  if (!timestamp) return '--';
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function truncateQueueText(text, limit = 60) {
  if (!text) return '';
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}

function addQueueEvent(event) {
  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    type: event.type || 'info',
    message: event.message || '',
    severity: event.severity || 'info',
  };
  queueEvents.push(entry);
  if (queueEvents.length > MAX_QUEUE_EVENTS) {
    queueEvents = queueEvents.slice(-MAX_QUEUE_EVENTS);
  }
  renderQueueEvents();
}

function renderQueueSummary() {
  const totalEl = document.getElementById('queueTotalCount');
  const undeliveredEl = document.getElementById('queueUndeliveredCount');
  const lockEl = document.getElementById('queueLockCount');
  const queuedFilesEl = document.getElementById('queueFileCount');

  const totalMessages = queueStatus?.totalMessages || 0;
  const undelivered = queueStatus?.undelivered || 0;
  const lockCount = conflictStatus?.lockCount || 0;
  const queuedFiles = conflictStatus?.queuedCount || 0;

  if (totalEl) totalEl.textContent = totalMessages;
  if (undeliveredEl) undeliveredEl.textContent = undelivered;
  if (lockEl) lockEl.textContent = lockCount;
  if (queuedFilesEl) queuedFilesEl.textContent = queuedFiles;
}

function renderQueuePaneList() {
  const listEl = document.getElementById('queuePaneList');
  if (!listEl) return;

  const queues = queueStatus?.queues || {};
  const items = PANE_IDS.map(paneId => {
    const data = queues[paneId] || { total: 0, undelivered: 0, latest: null };
    const total = data.total || 0;
    const undelivered = data.undelivered || 0;
    const latest = data.latest ? truncateQueueText(data.latest.content || data.latest.message || '') : '';
    const fillPct = total > 0 ? Math.min(100, Math.round((undelivered / total) * 100)) : 0;

    return `
      <div class="queue-pane-item">
        <div class="queue-pane-header">
          <div class="queue-pane-name">${AGENT_NAMES[paneId] || `Pane ${paneId}`}</div>
          <div class="queue-pane-counts">${undelivered} / ${total}</div>
        </div>
        <div class="queue-pane-bar">
          <div class="queue-pane-bar-fill" style="width: ${fillPct}%"></div>
        </div>
        <div class="queue-pane-meta">${latest || 'No recent messages'}</div>
      </div>
    `;
  });

  listEl.innerHTML = items.join('') || '<div class="queue-empty">No queued messages</div>';
}

function renderQueueConflictList() {
  const listEl = document.getElementById('queueConflictList');
  if (!listEl) return;

  if (conflictStatus?.success === false) {
    listEl.innerHTML = `<div class="queue-empty">${conflictStatus.error || 'Conflict queue unavailable'}</div>`;
    return;
  }

  const locks = conflictStatus?.locks || {};
  const queues = conflictStatus?.queues || {};
  const entries = [];

  for (const [file, holder] of Object.entries(locks)) {
    const queued = queues[file] || [];
    const queuedText = queued.length
      ? queued.map(item => `${AGENT_NAMES[item.paneId] || item.paneId} (${item.operation})`).join(', ')
      : 'None';
    entries.push(`
      <div class="queue-conflict-item">
        <div><strong>${file}</strong></div>
        <div class="queue-conflict-sub">Lock holder: ${AGENT_NAMES[holder] || holder}</div>
        <div class="queue-conflict-sub">Queued: ${queuedText}</div>
      </div>
    `);
  }

  if (entries.length === 0) {
    listEl.innerHTML = '<div class="queue-empty">No active file locks</div>';
    return;
  }

  listEl.innerHTML = entries.join('');
}

function renderQueueClaims() {
  const listEl = document.getElementById('queueClaimsList');
  if (!listEl) return;

  const entries = Object.entries(queueClaims || {});
  if (entries.length === 0) {
    listEl.innerHTML = '<div class="queue-empty">No active claims</div>';
    return;
  }

  listEl.innerHTML = entries.map(([paneId, claim]) => `
    <div class="queue-claim-item">
      <div><strong>${AGENT_NAMES[paneId] || `Pane ${paneId}`}</strong></div>
      <div class="queue-claim-sub">${claim.taskId || 'Unspecified task'}</div>
      <div class="queue-claim-sub">${claim.description || 'No description'}</div>
    </div>
  `).join('');
}

function renderQueueEvents() {
  const listEl = document.getElementById('queueEventsList');
  if (!listEl) return;

  if (!queueEvents.length) {
    listEl.innerHTML = '<div class="queue-empty">No queue events</div>';
    return;
  }

  listEl.innerHTML = queueEvents.map(event => `
    <div class="queue-event-item ${event.severity}">
      <div><strong>${formatQueueTime(event.timestamp)}</strong></div>
      <div class="queue-event-sub">${event.message}</div>
    </div>
  `).join('');
}

function renderQueueDashboard() {
  renderQueueSummary();
  renderQueuePaneList();
  renderQueueConflictList();
  renderQueueClaims();
  renderQueueEvents();
}

async function loadQueueStatus() {
  if (queueRefreshInFlight) return;
  queueRefreshInFlight = true;
  try {
    const [messageStatus, conflict, claims] = await Promise.all([
      ipcRenderer.invoke('get-message-queue-status'),
      ipcRenderer.invoke('get-conflict-queue-status'),
      ipcRenderer.invoke('get-claims'),
    ]);

    queueStatus = messageStatus || { queues: {}, totalMessages: 0, undelivered: 0 };
    conflictStatus = conflict || { locks: {}, queues: {}, lockCount: 0, queuedCount: 0 };
    queueClaims = claims || {};
  } catch (err) {
    log.error('Queue', 'Failed to load queue status', err);
  } finally {
    queueRefreshInFlight = false;
    renderQueueDashboard();
  }
}

function scheduleQueueRefresh(delay = 200) {
  if (queueRefreshTimer) return;
  queueRefreshTimer = setTimeout(() => {
    queueRefreshTimer = null;
    loadQueueStatus();
  }, delay);
}

function setupQueueTab() {
  const refreshBtn = document.getElementById('refreshQueueBtn');
  const clearDeliveredBtn = document.getElementById('clearDeliveredQueueBtn');
  const clearLocksBtn = document.getElementById('clearConflictLocksBtn');

  if (refreshBtn) refreshBtn.addEventListener('click', loadQueueStatus);
  if (clearDeliveredBtn) {
    clearDeliveredBtn.addEventListener('click', async () => {
      try {
        await ipcRenderer.invoke('clear-messages', 'all', true);
        addQueueEvent({ type: 'queue', message: 'Cleared delivered messages', severity: 'info' });
        loadQueueStatus();
      } catch (err) {
        addQueueEvent({ type: 'queue', message: `Clear delivered failed: ${err.message}`, severity: 'error' });
      }
    });
  }
  if (clearLocksBtn) {
    clearLocksBtn.addEventListener('click', async () => {
      try {
        await ipcRenderer.invoke('clear-all-locks');
        addQueueEvent({ type: 'queue', message: 'Cleared all conflict locks', severity: 'warning' });
        loadQueueStatus();
      } catch (err) {
        addQueueEvent({ type: 'queue', message: `Clear locks failed: ${err.message}`, severity: 'error' });
      }
    });
  }

  ipcRenderer.on('message-queued', (event, data) => {
    addQueueEvent({
      type: 'queue',
      message: `Queued for ${data?.toRole || AGENT_NAMES[data?.to] || 'agent'}`,
      severity: 'info',
    });
    scheduleQueueRefresh();
  });

  ipcRenderer.on('message-delivered', (event, data) => {
    addQueueEvent({
      type: 'queue',
      message: `Delivered to pane ${data?.paneId || ''}`.trim(),
      severity: 'info',
    });
    scheduleQueueRefresh();
  });

  ipcRenderer.on('messages-cleared', () => {
    addQueueEvent({ type: 'queue', message: 'Message queue cleared', severity: 'warning' });
    scheduleQueueRefresh();
  });

  ipcRenderer.on('conflict-queued', (event, data) => {
    addQueueEvent({
      type: 'conflict',
      message: `Conflict queued: ${data?.filePath || 'file'} (${AGENT_NAMES[data?.paneId] || data?.paneId || 'agent'})`,
      severity: 'warning',
    });
    scheduleQueueRefresh();
  });

  ipcRenderer.on('conflict-resolved', (event, data) => {
    addQueueEvent({
      type: 'conflict',
      message: `Conflict resolved: ${data?.filePath || 'file'} (${AGENT_NAMES[data?.paneId] || data?.paneId || 'agent'})`,
      severity: 'info',
    });
    scheduleQueueRefresh();
  });

  ipcRenderer.on('conflicts-cleared', () => {
    addQueueEvent({ type: 'conflict', message: 'All conflicts cleared', severity: 'warning' });
    scheduleQueueRefresh();
  });

  ipcRenderer.on('claims-changed', (event, claims) => {
    queueClaims = claims || {};
    renderQueueClaims();
  });

  loadQueueStatus();

  if (queuePoller) {
    clearInterval(queuePoller);
  }
  queuePoller = setInterval(() => {
    const tab = document.getElementById('tab-queue');
    if (tab && tab.classList.contains('active')) {
      loadQueueStatus();
    }
  }, 4000);
}

// ============================================================
// Task #28: Scheduler
// ============================================================

let scheduleData = [];
let schedulePoller = null;

function formatScheduleTime(iso) {
  if (!iso) return '--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString();
}

function renderScheduleCalendar() {
  const calendarEl = document.getElementById('scheduleCalendar');
  if (!calendarEl) return;

  const days = Array.from({ length: 7 }).map((_, idx) => {
    const date = new Date();
    date.setDate(date.getDate() + idx);
    return date;
  });

  const itemsByDay = {};
  scheduleData.forEach(schedule => {
    if (!schedule.nextRun) return;
    const nextDate = new Date(schedule.nextRun);
    const key = nextDate.toDateString();
    if (!itemsByDay[key]) itemsByDay[key] = [];
    itemsByDay[key].push(schedule);
  });

  calendarEl.innerHTML = days.map(day => {
    const key = day.toDateString();
    const items = (itemsByDay[key] || []).slice(0, 3);
    return `
      <div class="schedule-day">
        <div class="schedule-day-title">${day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
        ${items.length === 0 ? '<div class="schedule-day-item">No tasks</div>' : items.map(item => `
          <div class="schedule-day-item">${item.name || item.input || 'Task'}</div>
        `).join('')}
      </div>
    `;
  }).join('');
}

function renderScheduleList() {
  const listEl = document.getElementById('scheduleList');
  if (!listEl) return;

  if (!scheduleData || scheduleData.length === 0) {
    listEl.innerHTML = '<div class="schedule-empty">No scheduled tasks</div>';
    return;
  }

  listEl.innerHTML = scheduleData.map(schedule => `
    <div class="schedule-item">
      <div class="schedule-item-header">
        <div>
          <div class="schedule-item-title">${schedule.name || schedule.input || 'Scheduled task'}</div>
          <div class="schedule-meta">${schedule.type.toUpperCase()} · Next: ${formatScheduleTime(schedule.nextRun)} · ${schedule.active ? 'Active' : 'Paused'}</div>
        </div>
        <div class="schedule-actions">
          <button class="btn btn-secondary schedule-run" data-id="${schedule.id}">Run</button>
          <button class="btn schedule-toggle" data-id="${schedule.id}" data-active="${schedule.active}">${schedule.active ? 'Pause' : 'Resume'}</button>
          <button class="btn schedule-delete" data-id="${schedule.id}">Delete</button>
        </div>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.schedule-run').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await ipcRenderer.invoke('run-schedule-now', id);
      loadSchedules();
    });
  });
  listEl.querySelectorAll('.schedule-toggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const active = btn.dataset.active === 'true';
      await ipcRenderer.invoke('update-schedule', id, { active: !active });
      loadSchedules();
    });
  });
  listEl.querySelectorAll('.schedule-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      await ipcRenderer.invoke('delete-schedule', id);
      loadSchedules();
    });
  });
}

async function loadSchedules() {
  try {
    const result = await ipcRenderer.invoke('get-schedules');
    scheduleData = result?.schedules || [];
  } catch (err) {
    log.error('Schedule', 'Failed to load schedules', err);
    scheduleData = [];
  }
  renderScheduleCalendar();
  renderScheduleList();
}

function setupScheduleTab() {
  const typeSelect = document.getElementById('scheduleType');
  const timeInput = document.getElementById('scheduleTime');
  const intervalInput = document.getElementById('scheduleInterval');
  const cronInput = document.getElementById('scheduleCron');
  const eventInput = document.getElementById('scheduleEvent');
  const timezoneInput = document.getElementById('scheduleTimezone');
  const addBtn = document.getElementById('scheduleAddBtn');
  const taskInput = document.getElementById('scheduleInput');

  function updateFields() {
    if (!typeSelect) return;
    const type = typeSelect.value;
    if (timeInput) timeInput.style.display = type === 'once' ? '' : 'none';
    if (intervalInput) intervalInput.style.display = type === 'interval' ? '' : 'none';
    if (cronInput) cronInput.style.display = type === 'cron' ? '' : 'none';
    if (eventInput) eventInput.style.display = type === 'event' ? '' : 'none';
  }

  if (typeSelect) typeSelect.addEventListener('change', updateFields);
  updateFields();

  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      const input = taskInput?.value?.trim() || '';
      if (!input) return;
      const payload = {
        input,
        type: typeSelect?.value || 'once',
        timeZone: timezoneInput?.value?.trim() || null,
      };
      if (payload.type === 'once') {
        payload.runAt = timeInput?.value ? new Date(timeInput.value).toISOString() : null;
      } else if (payload.type === 'interval') {
        const minutes = parseInt(intervalInput?.value || '0', 10);
        payload.intervalMs = minutes > 0 ? minutes * 60 * 1000 : null;
      } else if (payload.type === 'cron') {
        payload.cron = cronInput?.value?.trim() || null;
      } else if (payload.type === 'event') {
        payload.eventName = eventInput?.value?.trim() || null;
      }

      await ipcRenderer.invoke('add-schedule', payload);
      if (taskInput) taskInput.value = '';
      loadSchedules();
    });
  }

  loadSchedules();

  if (schedulePoller) clearInterval(schedulePoller);
  schedulePoller = setInterval(() => {
    const tab = document.getElementById('tab-schedule');
    if (tab && tab.classList.contains('active')) {
      loadSchedules();
    }
  }, 60000);
}

// ============================================================
// Task #6: Git Integration
// ============================================================

let gitStatus = null;
let gitStatusError = '';
let gitDiffMode = 'unstaged';

function renderGitFileList(listEl, files, className, emptyLabel) {
  if (!listEl) return;
  if (!files || files.length === 0) {
    listEl.innerHTML = `<div class="git-empty">${emptyLabel || 'No files'}</div>`;
    return;
  }
  listEl.innerHTML = files.map(file => `
    <div class="git-file-item ${className || ''}" title="${file}">${file}</div>
  `).join('');
}

function renderGitStatus() {
  const messageEl = document.getElementById('gitStatusMessage');
  const summaryEl = document.getElementById('gitSummary');
  const sectionsEl = document.querySelector('.git-sections');
  const diffEl = document.querySelector('.git-diff');
  const commitEl = document.querySelector('.git-commit');
  const actionsEl = document.querySelector('.git-actions');

  if (!gitStatus || gitStatusError) {
    if (messageEl) messageEl.textContent = gitStatusError || 'Git status unavailable';
    if (summaryEl) summaryEl.style.display = 'none';
    if (sectionsEl) sectionsEl.style.display = 'none';
    if (diffEl) diffEl.style.display = 'none';
    if (commitEl) commitEl.style.display = 'none';
    if (actionsEl) actionsEl.style.display = 'none';
    return;
  }

  if (messageEl) messageEl.textContent = '';
  if (summaryEl) summaryEl.style.display = '';
  if (sectionsEl) sectionsEl.style.display = '';
  if (diffEl) diffEl.style.display = '';
  if (commitEl) commitEl.style.display = '';
  if (actionsEl) actionsEl.style.display = '';

  const branchEl = document.getElementById('gitBranchValue');
  const upstreamEl = document.getElementById('gitUpstreamValue');
  const aheadBehindEl = document.getElementById('gitAheadBehindValue');
  const repoRootEl = document.getElementById('gitRepoRootValue');
  const lastCommitEl = document.getElementById('gitLastCommitValue');
  const lastCommitMetaEl = document.getElementById('gitLastCommitMeta');
  const cleanEl = document.getElementById('gitCleanValue');
  const changeCountEl = document.getElementById('gitChangeCount');

  if (branchEl) branchEl.textContent = gitStatus.branch || 'Detached';
  if (upstreamEl) upstreamEl.textContent = gitStatus.upstream || 'No upstream';
  if (aheadBehindEl) aheadBehindEl.textContent = `${gitStatus.ahead || 0} / ${gitStatus.behind || 0}`;
  if (repoRootEl) repoRootEl.textContent = gitStatus.repoRoot || '--';

  const lastCommit = gitStatus.lastCommit;
  if (lastCommitEl) {
    lastCommitEl.textContent = lastCommit?.hash ? `${lastCommit.hash} ${lastCommit.subject}` : 'No commits';
  }
  if (lastCommitMetaEl) {
    lastCommitMetaEl.textContent = lastCommit?.hash ? `${lastCommit.author} · ${lastCommit.date}` : '--';
  }

  const totalChanges = (gitStatus.staged?.length || 0) +
    (gitStatus.unstaged?.length || 0) +
    (gitStatus.untracked?.length || 0) +
    (gitStatus.conflicted?.length || 0);

  if (cleanEl) cleanEl.textContent = gitStatus.isClean ? 'Clean' : 'Dirty';
  if (changeCountEl) changeCountEl.textContent = `${totalChanges} changes`;

  renderGitFileList(document.getElementById('gitStagedList'), gitStatus.staged, '', 'No staged files');
  renderGitFileList(document.getElementById('gitUnstagedList'), gitStatus.unstaged, 'unstaged', 'No unstaged files');
  renderGitFileList(document.getElementById('gitUntrackedList'), gitStatus.untracked, 'untracked', 'No untracked files');
  renderGitFileList(document.getElementById('gitConflictedList'), gitStatus.conflicted, 'conflicted', 'No conflicts');
}

async function loadGitStatus() {
  try {
    const projectPath = await ipcRenderer.invoke('get-project');
    const result = await ipcRenderer.invoke('git-status', projectPath);

    if (!result?.success) {
      gitStatus = null;
      gitStatusError = result?.notRepo
        ? 'No git repository detected for current project'
        : (result?.error || 'Git status failed');
      renderGitStatus();
      return;
    }

    gitStatus = result.status;
    gitStatusError = '';
    renderGitStatus();
  } catch (err) {
    gitStatus = null;
    gitStatusError = err.message || 'Git status failed';
    renderGitStatus();
  }
}

async function loadGitDiff(mode) {
  const diffOutputEl = document.getElementById('gitDiffOutput');
  if (diffOutputEl) diffOutputEl.textContent = 'Loading diff...';

  try {
    const projectPath = await ipcRenderer.invoke('get-project');
    const result = await ipcRenderer.invoke('git-diff', { projectPath, scope: mode });
    if (!result?.success) {
      const error = result?.notRepo
        ? 'No git repository detected'
        : (result?.error || 'Diff failed');
      if (diffOutputEl) diffOutputEl.textContent = error;
      return;
    }
    if (diffOutputEl) diffOutputEl.textContent = result.diff || 'No diff';
  } catch (err) {
    if (diffOutputEl) diffOutputEl.textContent = err.message || 'Diff failed';
  }
}

function formatGitSummary(status) {
  if (!status) return 'Git status unavailable';
  const lines = [
    `Branch: ${status.branch || 'Detached'}`,
    `Upstream: ${status.upstream || 'None'}`,
    `Ahead/Behind: ${status.ahead || 0}/${status.behind || 0}`,
    `Staged: ${status.staged?.length || 0}`,
    `Unstaged: ${status.unstaged?.length || 0}`,
    `Untracked: ${status.untracked?.length || 0}`,
    `Conflicted: ${status.conflicted?.length || 0}`,
  ];
  if (status.repoRoot) lines.push(`Repo: ${status.repoRoot}`);
  return lines.join('\n');
}

function setupGitTab() {
  const refreshBtn = document.getElementById('gitRefreshBtn');
  const stageAllBtn = document.getElementById('gitStageAllBtn');
  const unstageAllBtn = document.getElementById('gitUnstageAllBtn');
  const diffSelect = document.getElementById('gitDiffMode');
  const diffBtn = document.getElementById('gitDiffRefreshBtn');
  const commitBtn = document.getElementById('gitCommitBtn');
  const commitInput = document.getElementById('gitCommitMessage');
  const copyBtn = document.getElementById('gitCopySummaryBtn');

  if (refreshBtn) refreshBtn.addEventListener('click', loadGitStatus);

  if (stageAllBtn) {
    stageAllBtn.addEventListener('click', async () => {
      try {
        const projectPath = await ipcRenderer.invoke('get-project');
        const result = await ipcRenderer.invoke('git-stage', { projectPath });
        if (!result?.success) {
          updateConnectionStatus(result?.error || 'Stage failed');
        } else {
          updateConnectionStatus('Staged all changes');
        }
        loadGitStatus();
      } catch (err) {
        updateConnectionStatus(err.message || 'Stage failed');
      }
    });
  }

  if (unstageAllBtn) {
    unstageAllBtn.addEventListener('click', async () => {
      try {
        const projectPath = await ipcRenderer.invoke('get-project');
        const result = await ipcRenderer.invoke('git-unstage', { projectPath });
        if (!result?.success) {
          updateConnectionStatus(result?.error || 'Unstage failed');
        } else {
          updateConnectionStatus('Unstaged all changes');
        }
        loadGitStatus();
      } catch (err) {
        updateConnectionStatus(err.message || 'Unstage failed');
      }
    });
  }

  if (diffSelect) {
    diffSelect.addEventListener('change', () => {
      gitDiffMode = diffSelect.value;
      loadGitDiff(gitDiffMode);
    });
  }

  if (diffBtn) diffBtn.addEventListener('click', () => loadGitDiff(gitDiffMode));

  if (commitBtn && commitInput) {
    commitBtn.addEventListener('click', async () => {
      const message = commitInput.value.trim();
      if (!message) {
        updateConnectionStatus('Commit message required');
        return;
      }
      try {
        const projectPath = await ipcRenderer.invoke('get-project');
        const result = await ipcRenderer.invoke('git-commit', { projectPath, message });
        if (!result?.success) {
          updateConnectionStatus(result?.error || 'Commit failed');
        } else {
          updateConnectionStatus('Commit created');
          commitInput.value = '';
        }
        loadGitStatus();
        loadGitDiff(gitDiffMode);
      } catch (err) {
        updateConnectionStatus(err.message || 'Commit failed');
      }
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        const text = formatGitSummary(gitStatus);
        await navigator.clipboard.writeText(text);
        updateConnectionStatus('Git summary copied');
      } catch (err) {
        updateConnectionStatus(err.message || 'Copy failed');
      }
    });
  }

  loadGitStatus();
  loadGitDiff(gitDiffMode);
}

// ============================================================
// MEMORY TAB (Task #8: Conversation History Viewer)
// ============================================================

let memoryCurrentAgent = 'all';
let memoryCurrentView = 'transcript';

function formatMemoryTime(timestamp) {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    return '';
  }
}

function formatMemoryDate(timestamp) {
  if (!timestamp) return '';
  try {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  } catch (e) {
    return '';
  }
}

function truncateContent(content, maxLength = 200) {
  if (!content || content.length <= maxLength) return content;
  return content.substring(0, maxLength) + '...';
}

function getEntryTypeClass(type) {
  const typeMap = {
    'input': 'input',
    'output': 'output',
    'tool_use': 'tool-use',
    'tool_result': 'tool-result',
    'decision': 'decision',
    'error': 'error',
    'trigger': 'trigger',
    'system': 'system',
    'state': 'state'
  };
  return typeMap[type] || '';
}

function renderTranscriptEntry(entry, showAgent = false) {
  const typeClass = getEntryTypeClass(entry.type);
  const time = formatMemoryTime(entry.timestamp);
  const isLong = entry.content && entry.content.length > 200;
  const agentLabel = showAgent && entry.paneId ? AGENT_NAMES[entry.paneId] || `Pane ${entry.paneId}` : '';

  return `
    <div class="transcript-entry ${typeClass}" data-entry-id="${entry.id || ''}">
      <div class="transcript-header">
        <span class="transcript-type">${entry.type}${agentLabel ? ` (${agentLabel})` : ''}</span>
        <span class="transcript-time">${time}</span>
      </div>
      <div class="transcript-content ${isLong ? 'collapsed' : ''}">${escapeHtml(entry.content || '')}</div>
      ${isLong ? '<button class="transcript-expand">Show more</button>' : ''}
    </div>
  `;
}

function renderTimelineEntry(entry, showAgent = false) {
  const typeClass = getEntryTypeClass(entry.type);
  const time = formatMemoryTime(entry.timestamp);
  const agentLabel = showAgent && entry.paneId ? AGENT_NAMES[entry.paneId] || `Pane ${entry.paneId}` : '';
  const content = escapeHtml(entry.content || '');

  return `
    <div class="memory-timeline-item ${typeClass}">
      <div class="memory-timeline-header">
        <span class="memory-timeline-type ${typeClass}">${entry.type || 'event'}</span>
        ${agentLabel ? `<span class="memory-timeline-agent">${agentLabel}</span>` : ''}
        <span class="memory-timeline-time">${time}</span>
      </div>
      <div class="memory-timeline-content">${content}</div>
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadMemoryTranscript(paneId = 'all', limit = 50) {
  const listEl = document.getElementById('transcriptList');
  if (!listEl) return;

  try {
    if (paneId === 'all') {
      // Load from all agents
      const results = [];
      for (const id of PANE_IDS) {
        const result = await ipcRenderer.invoke('memory:get-transcript', id, Math.floor(limit / 6));
        if (result?.success && result.data) {
          results.push(...result.data.map(e => ({ ...e, paneId: id })));
        }
      }
      // Sort by timestamp
      results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const entries = results.slice(0, limit);

      if (entries.length === 0) {
        listEl.innerHTML = '<div class="memory-empty">No conversation history yet</div>';
        return;
      }

      listEl.innerHTML = entries.map(e => renderTranscriptEntry(e, true)).join('');
    } else {
      const result = await ipcRenderer.invoke('memory:get-transcript', paneId, limit);
      if (!result?.success || !result.data || result.data.length === 0) {
        listEl.innerHTML = '<div class="memory-empty">No conversation history for this agent</div>';
        return;
      }

      listEl.innerHTML = result.data.map(e => renderTranscriptEntry(e, false)).join('');
    }

    // Add expand/collapse handlers
    listEl.querySelectorAll('.transcript-expand').forEach(btn => {
      btn.addEventListener('click', () => {
        const content = btn.previousElementSibling;
        if (content.classList.contains('collapsed')) {
          content.classList.remove('collapsed');
          btn.textContent = 'Show less';
        } else {
          content.classList.add('collapsed');
          btn.textContent = 'Show more';
        }
      });
    });

    updateMemoryStats();
  } catch (err) {
    listEl.innerHTML = `<div class="memory-empty">Error loading transcript: ${err.message}</div>`;
  }
}

async function loadMemoryTimeline(paneId = 'all', limit = 120) {
  const listEl = document.getElementById('memoryTimeline');
  if (!listEl) return;

  try {
    let entries = [];

    if (paneId === 'all') {
      const results = [];
      for (const id of PANE_IDS) {
        const result = await ipcRenderer.invoke('memory:get-transcript', id, Math.floor(limit / 6));
        if (result?.success && result.data) {
          results.push(...result.data.map(e => ({ ...e, paneId: id })));
        }
      }
      entries = results;
    } else {
      const result = await ipcRenderer.invoke('memory:get-transcript', paneId, limit);
      if (result?.success && result.data) {
        entries = result.data;
      }
    }

    if (!entries || entries.length === 0) {
      listEl.innerHTML = '<div class="memory-empty">No timeline events yet</div>';
      return;
    }

    entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const showAgent = paneId === 'all';
    let lastDate = '';
    let html = '';

    entries.forEach((entry) => {
      const dateLabel = formatMemoryDate(entry.timestamp);
      if (dateLabel && dateLabel !== lastDate) {
        html += `<div class="memory-timeline-date">${dateLabel}</div>`;
        lastDate = dateLabel;
      }
      html += renderTimelineEntry(entry, showAgent);
    });

    listEl.innerHTML = html;
    updateMemoryStats(entries.length);
  } catch (err) {
    listEl.innerHTML = `<div class="memory-empty">Error loading timeline: ${err.message}</div>`;
  }
}

async function loadMemoryContext(paneId) {
  const summaryEl = document.getElementById('contextSummary');
  if (!summaryEl) return;

  if (paneId === 'all') {
    summaryEl.innerHTML = '<div class="memory-empty">Select a specific agent to view context</div>';
    return;
  }

  try {
    const result = await ipcRenderer.invoke('memory:get-context-summary', paneId);
    if (!result?.success || !result.data) {
      summaryEl.innerHTML = '<div class="memory-empty">No context available</div>';
      return;
    }

    const ctx = result.data;
    const agentName = AGENT_NAMES[paneId] || `Pane ${paneId}`;

    summaryEl.innerHTML = `
      <div class="context-section">
        <div class="context-section-title">${agentName} Context</div>
        <div class="context-stat">
          <span class="context-stat-label">Session ID</span>
          <span class="context-stat-value">${ctx.sessionId || 'None'}</span>
        </div>
        <div class="context-stat">
          <span class="context-stat-label">Session Start</span>
          <span class="context-stat-value">${ctx.sessionStart ? new Date(ctx.sessionStart).toLocaleTimeString() : 'N/A'}</span>
        </div>
        <div class="context-stat">
          <span class="context-stat-label">Current Task</span>
          <span class="context-stat-value">${ctx.currentTask?.description || 'None'}</span>
        </div>
        <div class="context-stat">
          <span class="context-stat-label">Files Touched</span>
          <span class="context-stat-value">${ctx.recentFiles?.length || 0}</span>
        </div>
        <div class="context-stat">
          <span class="context-stat-label">Learnings</span>
          <span class="context-stat-value">${ctx.learnings?.length || 0}</span>
        </div>
        <div class="context-stat">
          <span class="context-stat-label">Decisions</span>
          <span class="context-stat-value">${ctx.decisions?.length || 0}</span>
        </div>
        <div class="context-stat">
          <span class="context-stat-label">Errors</span>
          <span class="context-stat-value">${ctx.recentErrors?.length || 0}</span>
        </div>
      </div>
      ${ctx.recentFiles?.length > 0 ? `
        <div class="context-section">
          <div class="context-section-title">Recent Files</div>
          ${ctx.recentFiles.slice(0, 5).map(f => `
            <div class="context-stat">
              <span class="context-stat-label">${f.path?.split(/[\\/]/).pop() || f.path}</span>
              <span class="context-stat-value">${f.count || 1}x</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  } catch (err) {
    summaryEl.innerHTML = `<div class="memory-empty">Error loading context: ${err.message}</div>`;
  }
}

async function loadMemoryLearnings(paneId) {
  const listEl = document.getElementById('learningsList');
  if (!listEl) return;

  try {
    let learnings = [];

    if (paneId === 'all') {
      // Get shared learnings
      const result = await ipcRenderer.invoke('memory:get-shared-learnings', 20);
      if (result?.success && result.data) {
        learnings = result.data;
      }
    } else {
      // Get agent-specific learnings from context
      const result = await ipcRenderer.invoke('memory:get-context-summary', paneId);
      if (result?.success && result.data?.learnings) {
        learnings = result.data.learnings;
      }
    }

    if (learnings.length === 0) {
      listEl.innerHTML = '<div class="memory-empty">No learnings recorded</div>';
      return;
    }

    listEl.innerHTML = learnings.map(l => `
      <div class="learning-item">
        <div class="learning-header">
          <span class="learning-topic">${escapeHtml(l.topic || 'General')}</span>
          <span class="learning-confidence">${Math.round((l.confidence || 0.8) * 100)}%</span>
        </div>
        <div class="learning-content">${escapeHtml(l.content || '')}</div>
        <div class="learning-meta">${l.source || ''} ${l.timestamp ? formatMemoryTime(l.timestamp) : ''}</div>
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="memory-empty">Error loading learnings: ${err.message}</div>`;
  }
}

async function loadMemoryTeam() {
  const summaryEl = document.getElementById('teamSummary');
  if (!summaryEl) return;

  try {
    const result = await ipcRenderer.invoke('memory:get-team-summary');
    if (!result?.success || !result.data) {
      summaryEl.innerHTML = '<div class="memory-empty">Unable to load team summary</div>';
      return;
    }

    const team = result.data;
    const agents = team.agents || {};

    // Render agent cards
    const agentCards = Object.entries(agents).map(([role, data]) => `
      <div class="team-agent">
        <div class="team-agent-header">
          <span class="team-agent-name">${role}</span>
          <span class="team-agent-status ${data.active ? 'active' : ''}">${data.active ? 'Active' : 'Idle'}</span>
        </div>
        <div class="team-agent-stats">
          <div class="team-stat">
            <span class="team-stat-label">Messages</span>
            <span class="team-stat-value">${data.messageCount || 0}</span>
          </div>
          <div class="team-stat">
            <span class="team-stat-label">Files</span>
            <span class="team-stat-value">${data.fileCount || 0}</span>
          </div>
          <div class="team-stat">
            <span class="team-stat-label">Tasks</span>
            <span class="team-stat-value">${data.taskCount || 0}</span>
          </div>
          <div class="team-stat">
            <span class="team-stat-label">Learnings</span>
            <span class="team-stat-value">${data.learningCount || 0}</span>
          </div>
        </div>
      </div>
    `).join('');

    // Render shared sections
    const sharedLearnings = team.sharedLearnings || [];
    const sharedDecisions = team.sharedDecisions || [];

    summaryEl.innerHTML = `
      ${agentCards}
      ${sharedLearnings.length > 0 ? `
        <div class="team-shared-section">
          <div class="team-shared-title">Shared Learnings (${sharedLearnings.length})</div>
          <div class="team-shared-list">
            ${sharedLearnings.slice(0, 5).map(l => `
              <div class="team-shared-item">${escapeHtml(l.content || l.topic || '')}</div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      ${sharedDecisions.length > 0 ? `
        <div class="team-shared-section">
          <div class="team-shared-title">Shared Decisions (${sharedDecisions.length})</div>
          <div class="team-shared-list">
            ${sharedDecisions.slice(0, 5).map(d => `
              <div class="team-shared-item">${escapeHtml(d.action || '')}</div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    `;
  } catch (err) {
    summaryEl.innerHTML = `<div class="memory-empty">Error loading team summary: ${err.message}</div>`;
  }
}

async function searchMemory(query) {
  const listEl = document.getElementById('transcriptList');
  if (!listEl || !query) return;

  try {
    const result = await ipcRenderer.invoke('memory:search', query, { limit: 30 });
    if (!result?.success || !result.data?.results || result.data.results.length === 0) {
      listEl.innerHTML = '<div class="memory-empty">No results found</div>';
      return;
    }

    const entries = result.data.results;
    listEl.innerHTML = entries.map(e => renderTranscriptEntry(e, true)).join('');
    updateMemoryStats(entries.length);
  } catch (err) {
    listEl.innerHTML = `<div class="memory-empty">Search error: ${err.message}</div>`;
  }
}

function updateMemoryStats(count = null) {
  const statsEl = document.getElementById('memoryStats');
  if (!statsEl) return;

  if (count !== null) {
    statsEl.textContent = `${count} results`;
  } else {
    const listEl = document.getElementById('transcriptList');
    const entryCount = listEl?.querySelectorAll('.transcript-entry').length || 0;
    statsEl.textContent = entryCount > 0 ? `${entryCount} entries` : '';
  }
}

function switchMemoryView(view) {
  memoryCurrentView = view;

  // Update tab buttons
  document.querySelectorAll('.memory-view-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });

  // Update view panes
  document.querySelectorAll('.memory-view').forEach(pane => {
    pane.classList.toggle('active', pane.id === `memory-${view}`);
  });

  // Load data for the view
  loadMemoryViewData(view, memoryCurrentAgent);
}

function loadMemoryViewData(view, agent) {
  switch (view) {
    case 'transcript':
      loadMemoryTranscript(agent);
      break;
    case 'timeline':
      loadMemoryTimeline(agent);
      break;
    case 'context':
      loadMemoryContext(agent);
      break;
    case 'learnings':
      loadMemoryLearnings(agent);
      break;
    case 'team':
      loadMemoryTeam();
      break;
  }
}

function setupMemoryTab() {
  const agentSelect = document.getElementById('memoryAgentSelect');
  const searchInput = document.getElementById('memorySearchInput');
  const searchBtn = document.getElementById('memorySearchBtn');
  const refreshBtn = document.getElementById('memoryRefreshBtn');
  const clearBtn = document.getElementById('memoryClearBtn');

  // Agent selection
  if (agentSelect) {
    agentSelect.addEventListener('change', (e) => {
      memoryCurrentAgent = e.target.value;
      loadMemoryViewData(memoryCurrentView, memoryCurrentAgent);
    });
  }

  // Search
  if (searchBtn) {
    searchBtn.addEventListener('click', () => {
      const query = searchInput?.value.trim();
      if (query) {
        searchMemory(query);
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const query = searchInput.value.trim();
        if (query) {
          searchMemory(query);
        }
      }
    });
  }

  // Refresh
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadMemoryViewData(memoryCurrentView, memoryCurrentAgent);
    });
  }

  // Clear
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      loadMemoryViewData(memoryCurrentView, memoryCurrentAgent);
    });
  }

  // View tab switching
  document.querySelectorAll('.memory-view-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      switchMemoryView(tab.dataset.view);
    });
  });

  // Initial load
  loadMemoryTranscript('all');
}

/* =============================================================================
   HEALTH TAB - Task #29: Self-Healing Error Recovery UI
   ============================================================================= */

const PANE_NAMES = {
  '1': 'Architect',
  '2': 'Orchestrator',
  '3': 'Implementer A',
  '4': 'Implementer B',
  '5': 'Investigator',
  '6': 'Reviewer'
};

// Health state tracking
const healthState = {
  agents: new Map(),    // paneId -> { status, lastOutput, stuckCount, recoveryStep }
  playbookLog: [],      // Recovery action history
  lastUpdate: null,
  refreshInterval: null
};

const resourceThresholds = {
  cpuPercent: 80,
  memMB: 1500,
  diskPercent: 90
};

/**
 * Initialize health state for all agents
 */
function initHealthState() {
  for (let i = 1; i <= 6; i++) {
    healthState.agents.set(String(i), {
      status: 'unknown',     // unknown, healthy, warning, error, recovering
      lastOutput: null,
      stuckCount: 0,
      recoveryStep: 'none'   // none, nudge, interrupt, restart
    });
  }
}

/**
 * Update health status for a single agent
 */
function updateAgentHealth(paneId, data) {
  const id = String(paneId);
  const existing = healthState.agents.get(id) || {};
  healthState.agents.set(id, { ...existing, ...data });
  renderAgentHealthItem(id);
  updateHealthSummary();
}

/**
 * Render a single agent's health item in the list
 */
function renderAgentHealthItem(paneId) {
  const id = String(paneId);
  const agentData = healthState.agents.get(id);
  if (!agentData) return;

  const item = document.querySelector(`.health-agent-item[data-pane="${id}"]`);
  if (!item) return;

  // Update classes
  item.className = `health-agent-item ${agentData.status}`;

  // Update badge
  const badge = document.getElementById(`health-badge-${id}`);
  if (badge) {
    badge.textContent = agentData.status === 'recovering' ? '◐' : '●';
  }

  // Update status text
  const statusEl = document.getElementById(`health-status-${id}`);
  if (statusEl) {
    const statusLabels = {
      unknown: 'Unknown',
      healthy: 'Healthy',
      warning: 'Inactive',
      error: 'Error',
      recovering: 'Recovering...'
    };
    statusEl.textContent = statusLabels[agentData.status] || agentData.status;
  }

  // Update last output
  const lastOutputEl = document.getElementById(`health-last-output-${id}`);
  if (lastOutputEl) {
    lastOutputEl.textContent = agentData.lastOutput
      ? formatRelativeTime(agentData.lastOutput)
      : '-';
  }

  // Update stuck count
  const stuckCountEl = document.getElementById(`health-stuck-count-${id}`);
  if (stuckCountEl) {
    stuckCountEl.textContent = String(agentData.stuckCount || 0);
  }

  // Update recovery step
  const recoveryStepEl = document.getElementById(`health-recovery-step-${id}`);
  if (recoveryStepEl) {
    const stepLabels = {
      none: 'None',
      nudge: 'Step 1: Nudge',
      interrupt: 'Step 2: Interrupt',
      restart: 'Step 3: Restart'
    };
    recoveryStepEl.textContent = stepLabels[agentData.recoveryStep] || 'None';
  }
}

/**
 * Update health summary counts
 */
function updateHealthSummary() {
  let healthy = 0, warning = 0, error = 0, recovering = 0;

  for (const [, data] of healthState.agents) {
    switch (data.status) {
      case 'healthy': healthy++; break;
      case 'warning': warning++; break;
      case 'error': error++; break;
      case 'recovering': recovering++; break;
    }
  }

  const healthyEl = document.getElementById('healthyAgentCount');
  const warningEl = document.getElementById('warningAgentCount');
  const errorEl = document.getElementById('errorAgentCount');
  const recoveringEl = document.getElementById('recoveringAgentCount');

  if (healthyEl) healthyEl.textContent = String(healthy);
  if (warningEl) warningEl.textContent = String(warning);
  if (errorEl) errorEl.textContent = String(error);
  if (recoveringEl) recoveringEl.textContent = String(recovering);
}

/**
 * Format relative time (e.g., "2m ago", "just now")
 */
function formatRelativeTime(timestamp) {
  if (!timestamp) return '-';

  const now = Date.now();
  const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
  const diff = now - ts;

  if (diff < 10000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/**
 * Fetch health data from daemon and update UI
 */
async function refreshHealthData() {
  try {
    // Get last activity times from daemon
    const result = await ipcRenderer.invoke('get-agent-health');
    if (result?.success && result.agents) {
      const now = Date.now();
      const WARNING_THRESHOLD = 30000;  // 30s
      const ERROR_THRESHOLD = 120000;   // 2min

      for (const [paneId, data] of Object.entries(result.agents)) {
        const lastOutput = data.lastActivity || data.lastOutput;
        const idleTime = lastOutput ? now - lastOutput : Infinity;

        let status = 'unknown';
        if (data.recovering) {
          status = 'recovering';
        } else if (data.alive === false) {
          status = 'error';
        } else if (idleTime < WARNING_THRESHOLD) {
          status = 'healthy';
        } else if (idleTime < ERROR_THRESHOLD) {
          status = 'warning';
        } else {
          status = 'error';
        }

        updateAgentHealth(paneId, {
          status,
          lastOutput,
          stuckCount: data.stuckCount || 0,
          recoveryStep: data.recoveryStep || 'none'
        });
      }
    }

    healthState.lastUpdate = Date.now();
    const lastUpdateEl = document.getElementById('healthLastUpdate');
    if (lastUpdateEl) {
      lastUpdateEl.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
    }

    await refreshResourceUsage();
  } catch (err) {
    console.error('Health refresh failed:', err);
  }
}

async function refreshResourceUsage() {
  try {
    const result = await ipcRenderer.invoke('resource:get-usage');
    if (!result?.success) return;

    updateResourceOverview(result.system);
    updateAgentResourceUsage(result.agents || {});
    updateResourceBottlenecks(result.agents || {});
  } catch (err) {
    console.warn('Resource usage refresh failed:', err);
  }
}

function updateResourceOverview(system = {}) {
  const cpuEl = document.getElementById('resourceCpu');
  const memEl = document.getElementById('resourceMem');
  const diskEl = document.getElementById('resourceDisk');

  if (cpuEl) {
    cpuEl.textContent = system.cpuPercent != null ? `${system.cpuPercent}%` : '--';
    cpuEl.classList.toggle('alert', system.cpuPercent != null && system.cpuPercent >= resourceThresholds.cpuPercent);
  }

  if (memEl) {
    const used = system.memUsedMB != null ? `${system.memUsedMB} MB` : '--';
    const total = system.memTotalMB != null ? `${system.memTotalMB} MB` : '--';
    memEl.textContent = `${used} / ${total}`;
    memEl.classList.toggle('alert', system.memPercent != null && system.memPercent >= 85);
  }

  if (diskEl) {
    if (system.disk) {
      const usedPct = system.disk.usedPercent != null ? `${system.disk.usedPercent}%` : '--';
      diskEl.textContent = usedPct;
      diskEl.classList.toggle('alert', system.disk.usedPercent != null && system.disk.usedPercent >= resourceThresholds.diskPercent);
    } else {
      diskEl.textContent = '--';
    }
  }
}

function updateAgentResourceUsage(agentStats) {
  for (let i = 1; i <= 6; i++) {
    const id = String(i);
    const cpuEl = document.getElementById(`health-cpu-${id}`);
    const memEl = document.getElementById(`health-mem-${id}`);
    const stats = agentStats[id] || {};

    if (cpuEl) {
      cpuEl.textContent = stats.cpuPercent != null ? `${stats.cpuPercent}%` : '-';
      cpuEl.classList.toggle('alert', stats.cpuPercent != null && stats.cpuPercent >= resourceThresholds.cpuPercent);
    }

    if (memEl) {
      memEl.textContent = stats.memMB != null ? `${stats.memMB} MB` : '-';
      memEl.classList.toggle('alert', stats.memMB != null && stats.memMB >= resourceThresholds.memMB);
    }
  }
}

function updateResourceBottlenecks(agentStats) {
  const bottleneckEl = document.getElementById('resourceBottlenecks');
  if (!bottleneckEl) return;

  let maxCpu = { pane: null, value: 0 };
  let maxMem = { pane: null, value: 0 };

  for (const [paneId, stats] of Object.entries(agentStats)) {
    if (stats.cpuPercent != null && stats.cpuPercent > maxCpu.value) {
      maxCpu = { pane: paneId, value: stats.cpuPercent };
    }
    if (stats.memMB != null && stats.memMB > maxMem.value) {
      maxMem = { pane: paneId, value: stats.memMB };
    }
  }

  const parts = [];
  if (maxCpu.pane && maxCpu.value >= resourceThresholds.cpuPercent) {
    parts.push(`High CPU: ${PANE_NAMES[maxCpu.pane] || `Pane ${maxCpu.pane}`} (${maxCpu.value}%)`);
  }
  if (maxMem.pane && maxMem.value >= resourceThresholds.memMB) {
    parts.push(`High Mem: ${PANE_NAMES[maxMem.pane] || `Pane ${maxMem.pane}`} (${maxMem.value} MB)`);
  }

  bottleneckEl.textContent = parts.join(' · ');
}

/**
 * Handle recovery action button click
 */
async function handleRecoveryAction(action, paneId) {
  const id = String(paneId);

  // Update playbook step indicator
  updatePlaybookStep(action);

  // Mark agent as recovering
  updateAgentHealth(id, { status: 'recovering', recoveryStep: action });

  try {
    let result;
    switch (action) {
      case 'nudge':
        result = await ipcRenderer.invoke('nudge-pane', id);
        break;
      case 'interrupt':
        result = await ipcRenderer.invoke('interrupt-pane', id);
        break;
      case 'restart':
        result = await ipcRenderer.invoke('restart-pane', id);
        break;
    }

    const success = result?.success !== false;
    addPlaybookLogEntry(action, id, success);

    if (success) {
      showRecoveryToast('success', `${action} sent to ${PANE_NAMES[id]}`, 'Recovery action completed successfully.');
    } else {
      showRecoveryToast('error', `${action} failed for ${PANE_NAMES[id]}`, result?.error || 'Unknown error');
    }

    // Refresh health after a short delay
    setTimeout(refreshHealthData, 1500);
  } catch (err) {
    addPlaybookLogEntry(action, id, false, err.message);
    showRecoveryToast('error', `${action} failed`, err.message);
    updateAgentHealth(id, { status: 'error', recoveryStep: 'none' });
  }
}

/**
 * Update playbook step visualization
 */
function updatePlaybookStep(activeStep) {
  const steps = document.querySelectorAll('.playbook-step');
  const stepOrder = ['nudge', 'interrupt', 'restart'];
  const activeIndex = stepOrder.indexOf(activeStep);

  steps.forEach((step, index) => {
    step.classList.remove('active', 'completed');
    if (index < activeIndex) {
      step.classList.add('completed');
    } else if (index === activeIndex) {
      step.classList.add('active');
    }
  });

  const statusEl = document.getElementById('playbookStatus');
  if (statusEl) {
    statusEl.textContent = activeStep ? `Running: ${activeStep}` : 'Idle';
    statusEl.classList.toggle('active', !!activeStep);
  }
}

/**
 * Add entry to playbook log
 */
function addPlaybookLogEntry(action, paneId, success, errorMsg = null) {
  const log = document.getElementById('playbookLog');
  if (!log) return;

  // Clear empty message
  const emptyMsg = log.querySelector('.playbook-log-empty');
  if (emptyMsg) emptyMsg.remove();

  const entry = document.createElement('div');
  entry.className = `playbook-log-entry ${success ? 'success' : 'failure'}`;

  const time = new Date().toLocaleTimeString();
  const agent = PANE_NAMES[String(paneId)] || `Pane ${paneId}`;
  const status = success ? '✓' : '✗';
  const message = errorMsg ? ` - ${errorMsg}` : '';

  entry.innerHTML = `<span class="playbook-log-time">${time}</span> ${status} ${action} → ${agent}${message}`;

  // Prepend to show newest first
  log.insertBefore(entry, log.firstChild);

  // Keep only last 20 entries
  const entries = log.querySelectorAll('.playbook-log-entry');
  if (entries.length > 20) {
    entries[entries.length - 1].remove();
  }

  // Store in state
  healthState.playbookLog.unshift({
    time,
    action,
    paneId,
    success,
    error: errorMsg
  });
}

/**
 * Show recovery toast notification
 */
function showRecoveryToast(type, title, message) {
  // Remove existing toasts
  const existingToasts = document.querySelectorAll('.recovery-toast');
  existingToasts.forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className = `recovery-toast ${type}`;
  toast.innerHTML = `
    <div class="recovery-toast-header">
      <span class="recovery-toast-title">${title}</span>
      <button class="recovery-toast-close" onclick="this.parentElement.parentElement.remove()">×</button>
    </div>
    <div class="recovery-toast-message">${message}</div>
  `;

  document.body.appendChild(toast);

  // Auto-remove after 5 seconds
  setTimeout(() => {
    if (toast.parentElement) {
      toast.remove();
    }
  }, 5000);
}

/**
 * Nudge all stuck agents
 */
async function nudgeAllStuck() {
  try {
    const result = await ipcRenderer.invoke('nudge-all-stuck');
    if (result?.nudged?.length > 0) {
      showRecoveryToast('success', 'Nudged Stuck Agents', `Sent nudge to ${result.nudged.length} agent(s).`);
      result.nudged.forEach(id => {
        addPlaybookLogEntry('nudge', id, true);
      });
    } else {
      showRecoveryToast('warning', 'No Stuck Agents', 'No agents detected as stuck.');
    }
    setTimeout(refreshHealthData, 1500);
  } catch (err) {
    showRecoveryToast('error', 'Nudge All Failed', err.message);
  }
}

/**
 * Restart all agents
 */
async function restartAllAgents() {
  if (!confirm('Restart all agents? This will kill and respawn all panes.')) {
    return;
  }

  try {
    const result = await ipcRenderer.invoke('restart-all-panes');
    showRecoveryToast('success', 'Restarting All Agents', 'All panes are being restarted.');
    for (let i = 1; i <= 6; i++) {
      addPlaybookLogEntry('restart', String(i), true);
    }
    setTimeout(refreshHealthData, 3000);
  } catch (err) {
    showRecoveryToast('error', 'Restart All Failed', err.message);
  }
}

/**
 * Setup Health tab event handlers
 */
function setupHealthTab() {
  // Initialize state
  initHealthState();

  // Refresh button
  const refreshBtn = document.getElementById('healthRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshHealthData);
  }

  // Nudge all button
  const nudgeAllBtn = document.getElementById('healthNudgeAllBtn');
  if (nudgeAllBtn) {
    nudgeAllBtn.addEventListener('click', nudgeAllStuck);
  }

  // Restart all button
  const restartAllBtn = document.getElementById('healthRestartAllBtn');
  if (restartAllBtn) {
    restartAllBtn.addEventListener('click', restartAllAgents);
  }

  // Individual agent action buttons
  document.querySelectorAll('.health-agent-actions .btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const paneId = btn.dataset.pane;
      if (action && paneId) {
        handleRecoveryAction(action, paneId);
      }
    });
  });

  // Auto-refresh every 5 seconds when tab is visible
  healthState.refreshInterval = setInterval(() => {
    const healthTab = document.getElementById('tab-health');
    if (healthTab && healthTab.classList.contains('active')) {
      refreshHealthData();
    }
  }, 5000);

  // Initial load
  refreshHealthData();
}

/**
 * Stop health monitoring (cleanup)
 */
function stopHealthMonitoring() {
  if (healthState.refreshInterval) {
    clearInterval(healthState.refreshInterval);
    healthState.refreshInterval = null;
  }
}

/**
 * Get current health state (for external access)
 */
function getHealthState() {
  return {
    agents: Object.fromEntries(healthState.agents),
    playbookLog: healthState.playbookLog.slice(0, 10),
    lastUpdate: healthState.lastUpdate
  };
}

// ============================================================
// KNOWLEDGE GRAPH TAB - Task #36
// ============================================================

// Graph state
const graphState = {
  nodes: [],
  edges: [],
  selectedNode: null,
  filter: 'all',
  searchQuery: '',
  lastUpdate: null,
  canvas: null,
  ctx: null,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  isDragging: false,
  dragStart: { x: 0, y: 0 },
  nodePositions: new Map()
};

// Workflow builder state
const workflowState = {
  nodes: [],
  edges: [],
  selectedNodeId: null,
  connectMode: false,
  connectingFrom: null,
  drag: null,
  canvas: null,
  nodesEl: null,
  edgesEl: null,
  emptyEl: null,
  inspectorEl: null,
  statusEl: null,
  statsEl: null,
  connectBtn: null,
  lastSaved: null,
  // Enhanced state for Task #19
  nodeTypes: null,
  templates: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  panStart: { x: 0, y: 0 },
  workflowName: 'Untitled Workflow',
  workflowDescription: '',
  undoStack: [],
  redoStack: [],
  clipboard: null,
  validationResult: null,
  executionPlan: null
};

const WORKFLOW_STORAGE_KEY = 'hivemind-workflow-v2';
const WORKFLOW_NODE_TYPES = {
  trigger: 'Trigger',
  agent: 'Agent',
  tool: 'Tool',
  decision: 'Decision',
  input: 'Input',
  output: 'Output',
  loop: 'Loop',
  parallel: 'Parallel',
  merge: 'Merge',
  transform: 'Transform',
  subworkflow: 'Subworkflow',
  delay: 'Delay'
};

// Node categories for toolbar grouping
const WORKFLOW_NODE_CATEGORIES = {
  control: ['trigger', 'decision', 'loop', 'parallel', 'merge', 'delay'],
  processing: ['agent', 'tool', 'transform'],
  io: ['input', 'output'],
  advanced: ['subworkflow']
};

// Node colors by type
const NODE_COLORS = {
  file: '#8be9fd',
  agent: '#50fa7b',
  decision: '#bd93f9',
  error: '#ff5555',
  task: '#ffb86c',
  concept: '#f1fa8c',
  session: '#ff79c6',
  message: '#6272a4'
};

/**
 * Setup the Knowledge Graph tab
 */
function setupGraphTab() {
  const searchInput = document.getElementById('graphSearchInput');
  const searchBtn = document.getElementById('graphSearchBtn');
  const refreshBtn = document.getElementById('graphRefreshBtn');
  const saveBtn = document.getElementById('graphSaveBtn');
  const resetViewBtn = document.getElementById('graphResetViewBtn');
  const canvas = document.getElementById('graphCanvas');
  const filterBtns = document.querySelectorAll('.graph-filter-btn');
  const legendItems = document.querySelectorAll('.graph-legend-item');

  if (!canvas) return;

  graphState.canvas = canvas;
  graphState.ctx = canvas.getContext('2d');

  // Search functionality
  if (searchBtn) {
    searchBtn.addEventListener('click', () => searchGraph());
  }
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') searchGraph();
    });
  }

  // Filter buttons
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      graphState.filter = btn.dataset.type;
      renderGraph();
    });
  });

  // Legend toggle
  legendItems.forEach(item => {
    item.addEventListener('click', () => {
      item.classList.toggle('dimmed');
      renderGraph();
    });
  });

  // Refresh button
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshGraphData());
  }

  // Save button
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveGraph());
  }

  // Reset view button
  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => {
      graphState.scale = 1;
      graphState.offsetX = 0;
      graphState.offsetY = 0;
      renderGraph();
    });
  }

  // Canvas interactions
  setupCanvasInteractions(canvas);

  // Initial data load
  refreshGraphData();
}

/**
 * Setup canvas mouse interactions for pan/zoom/select
 */
function setupCanvasInteractions(canvas) {
  if (!canvas) return;

  // Mouse down - start drag or select node
  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - graphState.offsetX) / graphState.scale;
    const y = (e.clientY - rect.top - graphState.offsetY) / graphState.scale;

    // Check if clicked on a node
    const clickedNode = findNodeAtPosition(x, y);
    if (clickedNode) {
      selectNode(clickedNode);
    } else {
      // Start panning
      graphState.isDragging = true;
      graphState.dragStart = { x: e.clientX, y: e.clientY };
    }
  });

  // Mouse move - pan
  canvas.addEventListener('mousemove', (e) => {
    if (graphState.isDragging) {
      const dx = e.clientX - graphState.dragStart.x;
      const dy = e.clientY - graphState.dragStart.y;
      graphState.offsetX += dx;
      graphState.offsetY += dy;
      graphState.dragStart = { x: e.clientX, y: e.clientY };
      renderGraph();
    }
  });

  // Mouse up - stop drag
  canvas.addEventListener('mouseup', () => {
    graphState.isDragging = false;
  });

  canvas.addEventListener('mouseleave', () => {
    graphState.isDragging = false;
  });

  // Mouse wheel - zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(graphState.scale * zoomFactor, 0.1), 5);

    // Adjust offset to zoom toward mouse position
    graphState.offsetX = mouseX - (mouseX - graphState.offsetX) * (newScale / graphState.scale);
    graphState.offsetY = mouseY - (mouseY - graphState.offsetY) * (newScale / graphState.scale);
    graphState.scale = newScale;

    renderGraph();
  });
}

/**
 * Find node at canvas position
 */
function findNodeAtPosition(x, y) {
  for (const node of graphState.nodes) {
    const pos = graphState.nodePositions.get(node.id);
    if (pos) {
      const dx = x - pos.x;
      const dy = y - pos.y;
      const radius = getNodeRadius(node);
      if (dx * dx + dy * dy < radius * radius) {
        return node;
      }
    }
  }
  return null;
}

/**
 * Get node radius based on type
 */
function getNodeRadius(node) {
  if (node.type === 'agent') return 20;
  if (node.type === 'file') return 12;
  return 15;
}

/**
 * Search the knowledge graph
 */
async function searchGraph() {
  const input = document.getElementById('graphSearchInput');
  if (!input || !input.value.trim()) {
    refreshGraphData();
    return;
  }

  graphState.searchQuery = input.value.trim();

  try {
    const result = await window.ipcRenderer.invoke('graph-query', {
      query: graphState.searchQuery,
      maxDepth: 3,
      maxResults: 100
    });

    if (result.success) {
      graphState.nodes = result.results.nodes || [];
      graphState.edges = result.results.edges || [];
      calculateNodePositions();
      renderGraph();
      updateGraphStats();
      hideEmptyState();
    } else {
      console.error('[GraphTab] Search failed:', result.error);
    }
  } catch (err) {
    console.error('[GraphTab] Search error:', err);
  }
}

/**
 * Refresh graph data from backend
 */
async function refreshGraphData() {
  try {
    const result = await window.ipcRenderer.invoke('graph-visualize', {});

    if (result.success) {
      graphState.nodes = result.data.nodes || [];
      graphState.edges = result.data.edges || [];
      graphState.lastUpdate = new Date();

      calculateNodePositions();
      renderGraph();
      updateGraphStats();
      updateLastUpdateTime();

      if (graphState.nodes.length > 0) {
        hideEmptyState();
      } else {
        showEmptyState();
      }
    } else {
      console.error('[GraphTab] Refresh failed:', result.error);
    }
  } catch (err) {
    console.error('[GraphTab] Refresh error:', err);
  }
}

/**
 * Save graph to disk
 */
async function saveGraph() {
  try {
    const result = await window.ipcRenderer.invoke('graph-save');
    if (result.success) {
      console.log('[GraphTab] Graph saved');
    }
  } catch (err) {
    console.error('[GraphTab] Save error:', err);
  }
}

/**
 * Calculate node positions using force-directed layout
 */
function calculateNodePositions() {
  const canvas = graphState.canvas;
  if (!canvas || graphState.nodes.length === 0) return;

  const width = canvas.width;
  const height = canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;

  // Group nodes by type for initial positioning
  const groups = {};
  graphState.nodes.forEach((node, i) => {
    if (!groups[node.type]) groups[node.type] = [];
    groups[node.type].push({ node, index: i });
  });

  // Position nodes in circles by type
  const typeAngles = {
    agent: 0,
    file: Math.PI / 3,
    decision: 2 * Math.PI / 3,
    error: Math.PI,
    task: 4 * Math.PI / 3,
    concept: 5 * Math.PI / 3
  };

  const baseRadius = Math.min(width, height) / 4;

  graphState.nodes.forEach((node, i) => {
    // Get existing position or calculate new one
    let pos = graphState.nodePositions.get(node.id);
    if (!pos) {
      const typeAngle = typeAngles[node.type] || (i * 2 * Math.PI / graphState.nodes.length);
      const groupNodes = groups[node.type] || [{ node, index: 0 }];
      const indexInGroup = groupNodes.findIndex(g => g.node.id === node.id);
      const groupSpread = Math.PI / 4;
      const angle = typeAngle + (indexInGroup - groupNodes.length / 2) * (groupSpread / groupNodes.length);

      // Vary radius based on connectivity
      const connectivity = graphState.edges.filter(e => e.source === node.id || e.target === node.id).length;
      const radius = baseRadius * (0.5 + Math.min(connectivity / 10, 0.5));

      pos = {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      };
      graphState.nodePositions.set(node.id, pos);
    }
  });

  // Simple force-directed adjustment (a few iterations)
  for (let iter = 0; iter < 50; iter++) {
    graphState.nodes.forEach(node => {
      const pos = graphState.nodePositions.get(node.id);
      if (!pos) return;

      let fx = 0, fy = 0;

      // Repulsion from other nodes
      graphState.nodes.forEach(other => {
        if (other.id === node.id) return;
        const otherPos = graphState.nodePositions.get(other.id);
        if (!otherPos) return;

        const dx = pos.x - otherPos.x;
        const dy = pos.y - otherPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = 1000 / (dist * dist);
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      });

      // Attraction along edges
      graphState.edges.forEach(edge => {
        let otherId = null;
        if (edge.source === node.id) otherId = edge.target;
        else if (edge.target === node.id) otherId = edge.source;
        if (!otherId) return;

        const otherPos = graphState.nodePositions.get(otherId);
        if (!otherPos) return;

        const dx = otherPos.x - pos.x;
        const dy = otherPos.y - pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * 0.01;
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      });

      // Center gravity
      fx += (centerX - pos.x) * 0.001;
      fy += (centerY - pos.y) * 0.001;

      // Apply forces
      pos.x += fx * 0.5;
      pos.y += fy * 0.5;

      // Keep in bounds
      pos.x = Math.max(30, Math.min(width - 30, pos.x));
      pos.y = Math.max(30, Math.min(height - 30, pos.y));
    });
  }
}

/**
 * Render the graph on canvas
 */
function renderGraph() {
  const canvas = graphState.canvas;
  const ctx = graphState.ctx;
  if (!canvas || !ctx) return;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Apply transformations
  ctx.save();
  ctx.translate(graphState.offsetX, graphState.offsetY);
  ctx.scale(graphState.scale, graphState.scale);

  // Get dimmed types from legend
  const dimmedTypes = new Set();
  document.querySelectorAll('.graph-legend-item.dimmed').forEach(item => {
    dimmedTypes.add(item.dataset.type);
  });

  // Filter nodes
  const visibleNodes = graphState.nodes.filter(node => {
    if (dimmedTypes.has(node.type)) return false;
    if (graphState.filter !== 'all' && node.type !== graphState.filter) return false;
    return true;
  });
  const visibleNodeIds = new Set(visibleNodes.map(n => n.id));

  // Draw edges
  ctx.lineWidth = 1;
  graphState.edges.forEach(edge => {
    if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) return;

    const sourcePos = graphState.nodePositions.get(edge.source);
    const targetPos = graphState.nodePositions.get(edge.target);
    if (!sourcePos || !targetPos) return;

    ctx.beginPath();
    ctx.moveTo(sourcePos.x, sourcePos.y);
    ctx.lineTo(targetPos.x, targetPos.y);
    ctx.strokeStyle = 'rgba(108, 117, 125, 0.4)';
    ctx.stroke();
  });

  // Draw nodes
  visibleNodes.forEach(node => {
    const pos = graphState.nodePositions.get(node.id);
    if (!pos) return;

    const radius = getNodeRadius(node);
    const color = NODE_COLORS[node.type] || '#6272a4';
    const isSelected = graphState.selectedNode && graphState.selectedNode.id === node.id;

    // Node circle
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Selection ring
    if (isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Label
    ctx.fillStyle = '#f8f8f2';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const label = node.label.length > 15 ? node.label.slice(0, 12) + '...' : node.label;
    ctx.fillText(label, pos.x, pos.y + radius + 4);
  });

  ctx.restore();
}

/**
 * Select a node and show its details
 */
async function selectNode(node) {
  graphState.selectedNode = node;
  renderGraph();

  const titleEl = document.getElementById('graphDetailsTitle');
  const typeEl = document.getElementById('graphDetailsType');
  const contentEl = document.getElementById('graphDetailsContent');
  const relatedEl = document.getElementById('graphRelatedList');

  if (titleEl) titleEl.textContent = node.label;
  if (typeEl) {
    typeEl.textContent = node.type;
    typeEl.className = `graph-details-type ${node.type}`;
  }

  // Show node data
  if (contentEl) {
    let content = '';
    if (node.data) {
      if (node.data.path) content += `Path: ${node.data.path}\n`;
      if (node.data.description) content += `${node.data.description}\n`;
      if (node.data.message) content += `${node.data.message}\n`;
      if (node.data.context) content += `Context: ${JSON.stringify(node.data.context)}\n`;
      if (node.data.timestamp) content += `Time: ${new Date(node.data.timestamp).toLocaleString()}`;
    }
    contentEl.innerHTML = content ? `<pre style="margin:0;white-space:pre-wrap">${content}</pre>` : '<div class="graph-details-empty">No additional details</div>';
  }

  // Get related nodes
  if (relatedEl) {
    try {
      const result = await window.ipcRenderer.invoke('graph-related', { nodeId: node.id, depth: 1 });
      if (result.success && result.results.nodes.length > 1) {
        const related = result.results.nodes.filter(n => n.id !== node.id);
        relatedEl.innerHTML = related.slice(0, 8).map(rel => {
          const edge = result.results.edges.find(e =>
            (e.source === node.id && e.target === rel.id) ||
            (e.target === node.id && e.source === rel.id)
          );
          return `
            <div class="graph-related-item" data-node-id="${rel.id}">
              <span class="graph-related-type" style="background:${NODE_COLORS[rel.type] || '#6272a4'}"></span>
              <span class="graph-related-label">${rel.label}</span>
              <span class="graph-related-edge">${edge ? edge.type : ''}</span>
            </div>
          `;
        }).join('');

        // Add click handlers to related items
        relatedEl.querySelectorAll('.graph-related-item').forEach(item => {
          item.addEventListener('click', () => {
            const nodeId = item.dataset.nodeId;
            const relNode = graphState.nodes.find(n => n.id === nodeId);
            if (relNode) selectNode(relNode);
          });
        });
      } else {
        relatedEl.innerHTML = '<div class="graph-details-empty">No related nodes</div>';
      }
    } catch (err) {
      console.error('[GraphTab] Related nodes error:', err);
      relatedEl.innerHTML = '';
    }
  }
}

/**
 * Update graph statistics display
 */
function updateGraphStats() {
  const nodeCountEl = document.getElementById('graphNodeCount');
  const edgeCountEl = document.getElementById('graphEdgeCount');
  const fileCountEl = document.getElementById('graphFileCount');
  const decisionCountEl = document.getElementById('graphDecisionCount');

  if (nodeCountEl) nodeCountEl.textContent = graphState.nodes.length;
  if (edgeCountEl) edgeCountEl.textContent = graphState.edges.length;

  const fileCt = graphState.nodes.filter(n => n.type === 'file').length;
  const decisionCt = graphState.nodes.filter(n => n.type === 'decision').length;

  if (fileCountEl) fileCountEl.textContent = fileCt;
  if (decisionCountEl) decisionCountEl.textContent = decisionCt;
}

/**
 * Update last update time display
 */
function updateLastUpdateTime() {
  const el = document.getElementById('graphLastUpdate');
  if (el && graphState.lastUpdate) {
    el.textContent = `Updated: ${graphState.lastUpdate.toLocaleTimeString()}`;
  }
}

/**
 * Show empty state
 */
function showEmptyState() {
  const emptyEl = document.getElementById('graphEmpty');
  if (emptyEl) emptyEl.style.display = 'block';
}

/**
 * Hide empty state
 */
function hideEmptyState() {
  const emptyEl = document.getElementById('graphEmpty');
  if (emptyEl) emptyEl.style.display = 'none';
}

/**
 * Get current graph state
 */
function getGraphState() {
  return {
    nodes: graphState.nodes,
    edges: graphState.edges,
    selectedNode: graphState.selectedNode,
    filter: graphState.filter,
    lastUpdate: graphState.lastUpdate
  };
}

// ============================================================================
// WORKFLOW BUILDER TAB (Task #19)
// ============================================================================

function setupWorkflowTab() {
  const tab = document.getElementById('tab-workflow');
  if (!tab) return;

  workflowState.canvas = tab.querySelector('#workflowCanvas');
  workflowState.nodesEl = tab.querySelector('#workflowNodes');
  workflowState.edgesEl = tab.querySelector('#workflowEdges');
  workflowState.emptyEl = tab.querySelector('#workflowEmpty');
  workflowState.inspectorEl = tab.querySelector('#workflowInspectorBody');
  workflowState.statusEl = tab.querySelector('#workflowStatus');
  workflowState.statsEl = tab.querySelector('#workflowStats');
  workflowState.connectBtn = tab.querySelector('#workflowConnectBtn');

  // Setup node type buttons (existing and new)
  tab.querySelectorAll('[data-node-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.nodeType;
      addWorkflowNode(type);
    });
  });

  const autoLayoutBtn = tab.querySelector('#workflowAutoLayoutBtn');
  if (autoLayoutBtn) autoLayoutBtn.addEventListener('click', autoLayoutWorkflow);

  const clearBtn = tab.querySelector('#workflowClearBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearWorkflow);

  const saveBtn = tab.querySelector('#workflowSaveBtn');
  if (saveBtn) saveBtn.addEventListener('click', () => saveWorkflowToFile());

  const loadBtn = tab.querySelector('#workflowLoadBtn');
  if (loadBtn) loadBtn.addEventListener('click', () => showWorkflowLoadDialog());

  const exportBtn = tab.querySelector('#workflowExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportWorkflowToFile);

  // New buttons for Task #19 enhancements
  const validateBtn = tab.querySelector('#workflowValidateBtn');
  if (validateBtn) validateBtn.addEventListener('click', validateWorkflowUI);

  const executeBtn = tab.querySelector('#workflowExecuteBtn');
  if (executeBtn) executeBtn.addEventListener('click', generateWorkflowPlan);

  const importBtn = tab.querySelector('#workflowImportBtn');
  if (importBtn) importBtn.addEventListener('click', importWorkflowFromFile);

  const templateBtn = tab.querySelector('#workflowTemplateBtn');
  if (templateBtn) templateBtn.addEventListener('click', showWorkflowTemplates);

  const undoBtn = tab.querySelector('#workflowUndoBtn');
  if (undoBtn) undoBtn.addEventListener('click', undoWorkflow);

  const redoBtn = tab.querySelector('#workflowRedoBtn');
  if (redoBtn) redoBtn.addEventListener('click', redoWorkflow);

  const zoomInBtn = tab.querySelector('#workflowZoomInBtn');
  if (zoomInBtn) zoomInBtn.addEventListener('click', () => zoomWorkflow(1.2));

  const zoomOutBtn = tab.querySelector('#workflowZoomOutBtn');
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => zoomWorkflow(0.8));

  const zoomResetBtn = tab.querySelector('#workflowZoomResetBtn');
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', resetWorkflowZoom);

  const deleteNodeBtn = tab.querySelector('#workflowDeleteNodeBtn');
  if (deleteNodeBtn) deleteNodeBtn.addEventListener('click', deleteSelectedWorkflowNode);

  const duplicateNodeBtn = tab.querySelector('#workflowDuplicateNodeBtn');
  if (duplicateNodeBtn) duplicateNodeBtn.addEventListener('click', duplicateSelectedWorkflowNode);

  if (workflowState.connectBtn) {
    workflowState.connectBtn.addEventListener('click', () => {
      setConnectMode(!workflowState.connectMode);
    });
  }

  // Canvas click for deselection
  if (workflowState.canvas) {
    workflowState.canvas.addEventListener('click', (e) => {
      if (e.target === workflowState.canvas || e.target === workflowState.nodesEl) {
        selectWorkflowNode(null);
      }
    });

    // Pan/zoom with mouse wheel
    workflowState.canvas.addEventListener('wheel', handleWorkflowWheel, { passive: false });

    // Pan with middle mouse button
    workflowState.canvas.addEventListener('mousedown', handleWorkflowPanStart);
    document.addEventListener('mousemove', handleWorkflowPanMove);
    document.addEventListener('mouseup', handleWorkflowPanEnd);
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', handleWorkflowKeyboard);

  window.addEventListener('resize', () => {
    updateWorkflowEdges();
  });

  // Load node types from IPC
  loadWorkflowNodeTypes();
  loadWorkflowTemplates();

  // Load saved workflow
  loadWorkflow(true);
  renderWorkflow();
}

/**
 * Load node type definitions from IPC
 */
async function loadWorkflowNodeTypes() {
  try {
    const result = await window.ipcRenderer.invoke('workflow-get-node-types');
    if (result.success) {
      workflowState.nodeTypes = result.nodeTypes;
    }
  } catch (err) {
    console.error('[Workflow] Failed to load node types:', err);
  }
}

/**
 * Load workflow templates from IPC
 */
async function loadWorkflowTemplates() {
  try {
    const result = await window.ipcRenderer.invoke('workflow-get-templates');
    if (result.success) {
      workflowState.templates = result.templates;
    }
  } catch (err) {
    console.error('[Workflow] Failed to load templates:', err);
  }
}

/**
 * Handle mouse wheel for zoom
 */
function handleWorkflowWheel(e) {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  zoomWorkflow(delta, e.clientX, e.clientY);
}

/**
 * Handle pan start
 */
function handleWorkflowPanStart(e) {
  if (e.button !== 1) return; // Middle mouse button only
  e.preventDefault();
  workflowState.isPanning = true;
  workflowState.panStart = { x: e.clientX, y: e.clientY };
  if (workflowState.canvas) {
    workflowState.canvas.style.cursor = 'grabbing';
  }
}

/**
 * Handle pan move
 */
function handleWorkflowPanMove(e) {
  if (!workflowState.isPanning) return;
  const dx = e.clientX - workflowState.panStart.x;
  const dy = e.clientY - workflowState.panStart.y;
  workflowState.panX += dx;
  workflowState.panY += dy;
  workflowState.panStart = { x: e.clientX, y: e.clientY };
  applyWorkflowTransform();
}

/**
 * Handle pan end
 */
function handleWorkflowPanEnd() {
  if (workflowState.isPanning) {
    workflowState.isPanning = false;
    if (workflowState.canvas) {
      workflowState.canvas.style.cursor = '';
    }
  }
}

/**
 * Zoom workflow canvas
 */
function zoomWorkflow(factor, centerX, centerY) {
  const oldZoom = workflowState.zoom;
  workflowState.zoom = Math.max(0.25, Math.min(4, workflowState.zoom * factor));

  // Adjust pan to zoom toward center point
  if (centerX !== undefined && centerY !== undefined && workflowState.canvas) {
    const rect = workflowState.canvas.getBoundingClientRect();
    const x = centerX - rect.left;
    const y = centerY - rect.top;
    workflowState.panX -= (x - workflowState.panX) * (workflowState.zoom / oldZoom - 1);
    workflowState.panY -= (y - workflowState.panY) * (workflowState.zoom / oldZoom - 1);
  }

  applyWorkflowTransform();
  setWorkflowStatus(`Zoom: ${Math.round(workflowState.zoom * 100)}%`);
}

/**
 * Reset zoom and pan
 */
function resetWorkflowZoom() {
  workflowState.zoom = 1;
  workflowState.panX = 0;
  workflowState.panY = 0;
  applyWorkflowTransform();
  setWorkflowStatus('View reset');
}

/**
 * Apply transform to workflow canvas
 */
function applyWorkflowTransform() {
  if (workflowState.nodesEl) {
    workflowState.nodesEl.style.transform = `translate(${workflowState.panX}px, ${workflowState.panY}px) scale(${workflowState.zoom})`;
    workflowState.nodesEl.style.transformOrigin = '0 0';
  }
  updateWorkflowEdges();
}

/**
 * Handle keyboard shortcuts
 */
function handleWorkflowKeyboard(e) {
  // Only handle when workflow tab is active
  const workflowTab = document.getElementById('tab-workflow');
  if (!workflowTab || !workflowTab.classList.contains('active')) return;

  // Delete selected node
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (workflowState.selectedNodeId && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      deleteSelectedWorkflowNode();
    }
  }

  // Ctrl+Z: Undo
  if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undoWorkflow();
  }

  // Ctrl+Shift+Z or Ctrl+Y: Redo
  if ((e.ctrlKey && e.shiftKey && e.key === 'z') || (e.ctrlKey && e.key === 'y')) {
    e.preventDefault();
    redoWorkflow();
  }

  // Ctrl+C: Copy
  if (e.ctrlKey && e.key === 'c' && workflowState.selectedNodeId) {
    e.preventDefault();
    copySelectedWorkflowNode();
  }

  // Ctrl+V: Paste
  if (e.ctrlKey && e.key === 'v' && workflowState.clipboard) {
    e.preventDefault();
    pasteWorkflowNode();
  }

  // Ctrl+D: Duplicate
  if (e.ctrlKey && e.key === 'd' && workflowState.selectedNodeId) {
    e.preventDefault();
    duplicateSelectedWorkflowNode();
  }

  // Escape: Deselect or exit connect mode
  if (e.key === 'Escape') {
    if (workflowState.connectMode) {
      setConnectMode(false);
    } else {
      selectWorkflowNode(null);
    }
  }
}

/**
 * Save current state for undo
 */
function pushWorkflowUndoState() {
  const state = {
    nodes: JSON.parse(JSON.stringify(workflowState.nodes)),
    edges: JSON.parse(JSON.stringify(workflowState.edges))
  };
  workflowState.undoStack.push(state);
  if (workflowState.undoStack.length > 50) {
    workflowState.undoStack.shift();
  }
  workflowState.redoStack = [];
}

/**
 * Undo last action
 */
function undoWorkflow() {
  if (workflowState.undoStack.length === 0) {
    setWorkflowStatus('Nothing to undo');
    return;
  }

  const state = {
    nodes: JSON.parse(JSON.stringify(workflowState.nodes)),
    edges: JSON.parse(JSON.stringify(workflowState.edges))
  };
  workflowState.redoStack.push(state);

  const prev = workflowState.undoStack.pop();
  workflowState.nodes = prev.nodes;
  workflowState.edges = prev.edges;
  workflowState.selectedNodeId = null;
  renderWorkflow();
  setWorkflowStatus('Undo');
}

/**
 * Redo last undone action
 */
function redoWorkflow() {
  if (workflowState.redoStack.length === 0) {
    setWorkflowStatus('Nothing to redo');
    return;
  }

  const state = {
    nodes: JSON.parse(JSON.stringify(workflowState.nodes)),
    edges: JSON.parse(JSON.stringify(workflowState.edges))
  };
  workflowState.undoStack.push(state);

  const next = workflowState.redoStack.pop();
  workflowState.nodes = next.nodes;
  workflowState.edges = next.edges;
  workflowState.selectedNodeId = null;
  renderWorkflow();
  setWorkflowStatus('Redo');
}

/**
 * Copy selected node
 */
function copySelectedWorkflowNode() {
  const node = getWorkflowNode(workflowState.selectedNodeId);
  if (!node) return;
  workflowState.clipboard = JSON.parse(JSON.stringify(node));
  setWorkflowStatus('Copied node');
}

/**
 * Paste copied node
 */
function pasteWorkflowNode() {
  if (!workflowState.clipboard) return;
  pushWorkflowUndoState();

  const node = {
    ...workflowState.clipboard,
    id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    x: workflowState.clipboard.x + 30,
    y: workflowState.clipboard.y + 30,
    label: workflowState.clipboard.label + ' (copy)'
  };

  workflowState.nodes.push(node);
  workflowState.clipboard = node;
  selectWorkflowNode(node.id);
  renderWorkflow();
  setWorkflowStatus('Pasted node');
}

/**
 * Delete selected node
 */
function deleteSelectedWorkflowNode() {
  const nodeId = workflowState.selectedNodeId;
  if (!nodeId) {
    setWorkflowStatus('No node selected');
    return;
  }

  pushWorkflowUndoState();

  // Remove node
  workflowState.nodes = workflowState.nodes.filter(n => n.id !== nodeId);

  // Remove edges connected to this node
  workflowState.edges = workflowState.edges.filter(e => e.from !== nodeId && e.to !== nodeId);

  workflowState.selectedNodeId = null;
  renderWorkflow();
  setWorkflowStatus('Deleted node');
}

/**
 * Duplicate selected node
 */
function duplicateSelectedWorkflowNode() {
  const node = getWorkflowNode(workflowState.selectedNodeId);
  if (!node) {
    setWorkflowStatus('No node selected');
    return;
  }

  pushWorkflowUndoState();

  const newNode = {
    ...JSON.parse(JSON.stringify(node)),
    id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    x: node.x + 30,
    y: node.y + 30,
    label: node.label + ' (copy)'
  };

  workflowState.nodes.push(newNode);
  selectWorkflowNode(newNode.id);
  renderWorkflow();
  setWorkflowStatus('Duplicated node');
}

/**
 * Validate workflow via IPC
 */
async function validateWorkflowUI() {
  try {
    const workflow = {
      nodes: workflowState.nodes,
      edges: workflowState.edges
    };

    const result = await window.ipcRenderer.invoke('workflow-validate', { workflow, options: { strict: true } });
    workflowState.validationResult = result;

    if (result.valid) {
      setWorkflowStatus(`Valid: ${result.stats.nodes} nodes, ${result.stats.edges} edges`);
    } else {
      const errorMsgs = result.errors.map(e => e.message).join('; ');
      setWorkflowStatus(`Invalid: ${errorMsgs}`);
    }

    // Update visual feedback
    renderWorkflow();
  } catch (err) {
    console.error('[Workflow] Validation error:', err);
    setWorkflowStatus('Validation failed');
  }
}

/**
 * Generate execution plan
 */
async function generateWorkflowPlan() {
  try {
    const workflow = {
      nodes: workflowState.nodes,
      edges: workflowState.edges
    };

    const result = await window.ipcRenderer.invoke('workflow-generate-plan', { workflow });

    if (result.success) {
      workflowState.executionPlan = result.plan;
      setWorkflowStatus(`Plan generated: ${result.plan.length} steps`);
      showExecutionPlan(result.plan);
    } else {
      setWorkflowStatus(`Plan failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Plan generation error:', err);
    setWorkflowStatus('Plan generation failed');
  }
}

/**
 * Show execution plan in inspector
 */
function showExecutionPlan(plan) {
  const inspector = workflowState.inspectorEl;
  if (!inspector) return;

  inspector.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'workflow-inspector-title';
  title.textContent = 'Execution Plan';
  inspector.appendChild(title);

  plan.forEach((step, i) => {
    const stepEl = document.createElement('div');
    stepEl.className = 'workflow-plan-step';
    stepEl.innerHTML = `
      <span class="step-num">${i + 1}</span>
      <span class="step-type">${step.type}</span>
      <span class="step-label">${step.label}</span>
    `;
    stepEl.addEventListener('click', () => {
      selectWorkflowNode(step.nodeId);
    });
    inspector.appendChild(stepEl);
  });
}

/**
 * Save workflow to file via IPC
 */
async function saveWorkflowToFile() {
  const name = workflowState.workflowName || prompt('Enter workflow name:', 'Untitled');
  if (!name) return;

  try {
    const workflow = {
      name,
      description: workflowState.workflowDescription,
      nodes: workflowState.nodes,
      edges: workflowState.edges
    };

    const result = await window.ipcRenderer.invoke('workflow-save', { name, workflow, overwrite: true });

    if (result.success) {
      workflowState.workflowName = name;
      workflowState.lastSaved = new Date();
      setWorkflowStatus(`Saved: ${name}`);
    } else {
      setWorkflowStatus(`Save failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Save error:', err);
    setWorkflowStatus('Save failed');
  }

  // Also save to localStorage for quick recovery
  saveWorkflow(true);
}

/**
 * Show workflow load dialog
 */
async function showWorkflowLoadDialog() {
  try {
    const result = await window.ipcRenderer.invoke('workflow-list');
    if (!result.success || !result.workflows.length) {
      setWorkflowStatus('No saved workflows');
      return;
    }

    const names = result.workflows.map(w => w.name);
    const name = prompt(`Load workflow:\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\nEnter name:`, names[0]);
    if (!name) return;

    const loadResult = await window.ipcRenderer.invoke('workflow-load', { name });
    if (loadResult.success) {
      pushWorkflowUndoState();
      workflowState.nodes = loadResult.workflow.nodes || [];
      workflowState.edges = loadResult.workflow.edges || [];
      workflowState.workflowName = loadResult.workflow.name;
      workflowState.workflowDescription = loadResult.workflow.description || '';
      workflowState.selectedNodeId = null;
      renderWorkflow();
      setWorkflowStatus(`Loaded: ${name}`);
    } else {
      setWorkflowStatus(`Load failed: ${loadResult.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Load error:', err);
    setWorkflowStatus('Load failed');
  }
}

/**
 * Export workflow to file
 */
async function exportWorkflowToFile() {
  try {
    const workflow = {
      name: workflowState.workflowName,
      description: workflowState.workflowDescription,
      nodes: workflowState.nodes,
      edges: workflowState.edges
    };

    const result = await window.ipcRenderer.invoke('workflow-export-file', {
      workflow,
      defaultName: workflowState.workflowName
    });

    if (result.success) {
      setWorkflowStatus('Workflow exported');
    } else if (!result.canceled) {
      setWorkflowStatus(`Export failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Export error:', err);
    // Fallback to browser download
    exportWorkflow();
  }
}

/**
 * Import workflow from file
 */
async function importWorkflowFromFile() {
  try {
    const result = await window.ipcRenderer.invoke('workflow-import-file');

    if (result.success) {
      pushWorkflowUndoState();
      workflowState.nodes = result.workflow.nodes || [];
      workflowState.edges = result.workflow.edges || [];
      workflowState.workflowName = result.workflow.name || 'Imported';
      workflowState.workflowDescription = result.workflow.description || '';
      workflowState.selectedNodeId = null;
      renderWorkflow();
      setWorkflowStatus(`Imported: ${workflowState.workflowName}`);
    } else if (!result.canceled) {
      setWorkflowStatus(`Import failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Import error:', err);
    setWorkflowStatus('Import failed');
  }
}

/**
 * Show workflow templates dialog
 */
async function showWorkflowTemplates() {
  const templates = workflowState.templates;
  if (!templates || templates.length === 0) {
    setWorkflowStatus('No templates available');
    return;
  }

  const templateNames = templates.map((t, i) => `${i + 1}. ${t.name}`).join('\n');
  const choice = prompt(`Select template:\n${templateNames}\n\nEnter number:`, '1');
  if (!choice) return;

  const index = parseInt(choice, 10) - 1;
  if (index < 0 || index >= templates.length) {
    setWorkflowStatus('Invalid template selection');
    return;
  }

  const template = templates[index];

  try {
    const result = await window.ipcRenderer.invoke('workflow-apply-template', { templateId: template.id });
    if (result.success) {
      pushWorkflowUndoState();
      workflowState.nodes = result.workflow.nodes;
      workflowState.edges = result.workflow.edges;
      workflowState.workflowName = result.workflow.name;
      workflowState.workflowDescription = result.workflow.description;
      workflowState.selectedNodeId = null;
      renderWorkflow();
      setWorkflowStatus(`Applied template: ${template.name}`);
    } else {
      setWorkflowStatus(`Template failed: ${result.error}`);
    }
  } catch (err) {
    console.error('[Workflow] Template error:', err);
    setWorkflowStatus('Template failed');
  }
}

function addWorkflowNode(type) {
  const normalizedType = WORKFLOW_NODE_TYPES[type] ? type : 'agent';
  const labelBase = WORKFLOW_NODE_TYPES[normalizedType];
  const nextIndex = workflowState.nodes.filter(n => n.type === normalizedType).length + 1;

  const canvasRect = workflowState.canvas?.getBoundingClientRect();
  const maxX = canvasRect ? Math.max(canvasRect.width - 180, 20) : 200;
  const maxY = canvasRect ? Math.max(canvasRect.height - 80, 20) : 120;
  const x = canvasRect ? Math.min(30 + Math.random() * maxX, maxX) : 40;
  const y = canvasRect ? Math.min(30 + Math.random() * maxY, maxY) : 40;

  const node = {
    id: `node-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    type: normalizedType,
    label: `${labelBase} ${nextIndex}`,
    x,
    y,
    notes: ''
  };

  workflowState.nodes.push(node);
  selectWorkflowNode(node.id);
  renderWorkflow();
  setWorkflowStatus(`Added ${labelBase}`);
}

function clearWorkflow() {
  if (workflowState.nodes.length === 0 && workflowState.edges.length === 0) {
    setWorkflowStatus('Nothing to clear');
    return;
  }

  if (!window.confirm('Clear the current workflow?')) return;

  workflowState.nodes = [];
  workflowState.edges = [];
  workflowState.selectedNodeId = null;
  workflowState.connectingFrom = null;
  workflowState.connectMode = false;
  renderWorkflow();
  setWorkflowStatus('Workflow cleared');
}

function renderWorkflow() {
  renderWorkflowNodes();
  requestAnimationFrame(() => updateWorkflowEdges());
  updateWorkflowStats();

  if (workflowState.emptyEl) {
    workflowState.emptyEl.style.display = workflowState.nodes.length === 0 ? 'flex' : 'none';
  }
}

function renderWorkflowNodes() {
  if (!workflowState.nodesEl) return;

  workflowState.nodesEl.innerHTML = '';

  workflowState.nodes.forEach(node => {
    const nodeEl = document.createElement('div');
    nodeEl.className = `workflow-node type-${node.type}`;
    nodeEl.dataset.nodeId = node.id;
    if (workflowState.selectedNodeId === node.id) {
      nodeEl.classList.add('selected');
    }
    if (workflowState.connectingFrom === node.id) {
      nodeEl.classList.add('connect-source');
    }

    const typeEl = document.createElement('div');
    typeEl.className = 'workflow-node-type';
    typeEl.textContent = WORKFLOW_NODE_TYPES[node.type] || node.type;

    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'workflow-node-input';
    inputEl.value = node.label;
    inputEl.addEventListener('input', () => {
      node.label = inputEl.value;
      renderWorkflowInspector();
    });

    nodeEl.appendChild(typeEl);
    nodeEl.appendChild(inputEl);
    positionWorkflowNode(nodeEl, node);

    nodeEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target === inputEl) return;
      beginWorkflowDrag(node.id, e);
    });

    workflowState.nodesEl.appendChild(nodeEl);
  });

  renderWorkflowInspector();
}

function positionWorkflowNode(nodeEl, node) {
  nodeEl.style.left = `${node.x}px`;
  nodeEl.style.top = `${node.y}px`;
}

function beginWorkflowDrag(nodeId, event) {
  const node = getWorkflowNode(nodeId);
  if (!node) return;

  workflowState.drag = {
    id: nodeId,
    startX: event.clientX,
    startY: event.clientY,
    originX: node.x,
    originY: node.y,
    moved: false
  };

  document.addEventListener('mousemove', handleWorkflowDragMove);
  document.addEventListener('mouseup', handleWorkflowDragEnd);
}

function handleWorkflowDragMove(event) {
  if (!workflowState.drag) return;

  const drag = workflowState.drag;
  const node = getWorkflowNode(drag.id);
  const nodeEl = getWorkflowNodeElement(drag.id);
  const canvasRect = workflowState.canvas?.getBoundingClientRect();
  if (!node || !nodeEl || !canvasRect) return;

  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;

  if (Math.abs(dx) + Math.abs(dy) > 2) {
    drag.moved = true;
  }

  const nextX = drag.originX + dx;
  const nextY = drag.originY + dy;

  const maxX = canvasRect.width - nodeEl.offsetWidth - 10;
  const maxY = canvasRect.height - nodeEl.offsetHeight - 10;

  node.x = Math.max(10, Math.min(nextX, maxX));
  node.y = Math.max(10, Math.min(nextY, maxY));

  positionWorkflowNode(nodeEl, node);
  updateWorkflowEdges();
}

function handleWorkflowDragEnd() {
  if (!workflowState.drag) return;

  const { id, moved } = workflowState.drag;
  workflowState.drag = null;
  document.removeEventListener('mousemove', handleWorkflowDragMove);
  document.removeEventListener('mouseup', handleWorkflowDragEnd);

  if (!moved) {
    handleWorkflowNodeActivate(id);
  }
}

function handleWorkflowNodeActivate(nodeId) {
  if (workflowState.connectMode) {
    if (!workflowState.connectingFrom) {
      workflowState.connectingFrom = nodeId;
      setWorkflowStatus('Select a target node to connect');
    } else if (workflowState.connectingFrom !== nodeId) {
      addWorkflowEdge(workflowState.connectingFrom, nodeId);
      workflowState.connectingFrom = null;
      setWorkflowStatus('Connection added');
    } else {
      workflowState.connectingFrom = null;
    }
    updateWorkflowConnectUI();
    renderWorkflow();
    return;
  }

  selectWorkflowNode(nodeId);
}

function selectWorkflowNode(nodeId) {
  workflowState.selectedNodeId = nodeId;
  renderWorkflow();
}

function renderWorkflowInspector() {
  const inspector = workflowState.inspectorEl;
  if (!inspector) return;

  inspector.innerHTML = '';
  const node = getWorkflowNode(workflowState.selectedNodeId);

  if (!node) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'workflow-inspector-empty';
    emptyEl.textContent = 'Select a node to edit details';
    inspector.appendChild(emptyEl);

    // Show workflow info when nothing selected
    const workflowInfo = document.createElement('div');
    workflowInfo.className = 'workflow-inspector-info';
    workflowInfo.innerHTML = `
      <div class="inspector-section">
        <div class="inspector-section-title">Workflow</div>
        <div class="inspector-stat">Nodes: ${workflowState.nodes.length}</div>
        <div class="inspector-stat">Edges: ${workflowState.edges.length}</div>
        <div class="inspector-stat">Zoom: ${Math.round(workflowState.zoom * 100)}%</div>
      </div>
    `;
    inspector.appendChild(workflowInfo);
    return;
  }

  // Node title
  const titleSection = document.createElement('div');
  titleSection.className = 'workflow-inspector-title';
  titleSection.textContent = WORKFLOW_NODE_TYPES[node.type] || node.type;
  inspector.appendChild(titleSection);

  // Basic properties
  inspector.appendChild(buildInspectorRow('Name', node.label, (value) => {
    node.label = value;
    const nodeEl = getWorkflowNodeElement(node.id);
    const inputEl = nodeEl?.querySelector('.workflow-node-input');
    if (inputEl) inputEl.value = value;
  }));

  inspector.appendChild(buildInspectorRow('Type', WORKFLOW_NODE_TYPES[node.type] || node.type, null, true));

  // Node-specific config fields from IPC
  if (workflowState.nodeTypes && workflowState.nodeTypes[node.type]) {
    const typeConfig = workflowState.nodeTypes[node.type];
    if (typeConfig.config && typeConfig.config.length > 0) {
      const configSection = document.createElement('div');
      configSection.className = 'inspector-section';

      const configTitle = document.createElement('div');
      configTitle.className = 'inspector-section-title';
      configTitle.textContent = 'Configuration';
      configSection.appendChild(configTitle);

      // Initialize node config if missing
      if (!node.config) node.config = {};

      typeConfig.config.forEach(field => {
        // Check showIf condition
        if (field.showIf) {
          const conditionMet = Object.entries(field.showIf).every(([key, value]) => node.config[key] === value);
          if (!conditionMet) return;
        }

        const row = document.createElement('div');
        row.className = 'workflow-inspector-row';

        const label = document.createElement('div');
        label.className = 'workflow-inspector-label';
        label.textContent = field.label;
        row.appendChild(label);

        let input;
        switch (field.type) {
          case 'select':
            input = document.createElement('select');
            input.className = 'workflow-inspector-input';
            (field.options || []).forEach(opt => {
              const option = document.createElement('option');
              option.value = opt;
              option.textContent = opt;
              if (node.config[field.key] === opt) option.selected = true;
              input.appendChild(option);
            });
            input.addEventListener('change', () => {
              node.config[field.key] = input.value;
              renderWorkflowInspector(); // Re-render for showIf updates
            });
            break;

          case 'textarea':
            input = document.createElement('textarea');
            input.className = 'workflow-inspector-input';
            input.rows = 3;
            input.value = node.config[field.key] || '';
            input.addEventListener('input', () => {
              node.config[field.key] = input.value;
            });
            break;

          case 'number':
            input = document.createElement('input');
            input.type = 'number';
            input.className = 'workflow-inspector-input';
            input.value = node.config[field.key] || '';
            input.addEventListener('input', () => {
              node.config[field.key] = input.value ? parseInt(input.value, 10) : null;
            });
            break;

          case 'checkbox':
            input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = !!node.config[field.key];
            input.addEventListener('change', () => {
              node.config[field.key] = input.checked;
              renderWorkflowInspector(); // Re-render for showIf updates
            });
            break;

          default: // text
            input = document.createElement('input');
            input.type = 'text';
            input.className = 'workflow-inspector-input';
            input.value = node.config[field.key] || '';
            input.addEventListener('input', () => {
              node.config[field.key] = input.value;
            });
        }

        row.appendChild(input);
        configSection.appendChild(row);
      });

      inspector.appendChild(configSection);
    }
  }

  // Notes
  inspector.appendChild(buildInspectorRow('Notes', node.notes || '', (value) => {
    node.notes = value;
  }, false, true));

  // Connection info
  const connections = document.createElement('div');
  connections.className = 'inspector-section';

  const connTitle = document.createElement('div');
  connTitle.className = 'inspector-section-title';
  connTitle.textContent = 'Connections';
  connections.appendChild(connTitle);

  const inEdges = workflowState.edges.filter(e => e.to === node.id);
  const outEdges = workflowState.edges.filter(e => e.from === node.id);

  const inInfo = document.createElement('div');
  inInfo.className = 'inspector-stat';
  inInfo.textContent = `Inputs: ${inEdges.length}`;
  connections.appendChild(inInfo);

  const outInfo = document.createElement('div');
  outInfo.className = 'inspector-stat';
  outInfo.textContent = `Outputs: ${outEdges.length}`;
  connections.appendChild(outInfo);

  inspector.appendChild(connections);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'inspector-actions';

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn btn-sm';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', deleteSelectedWorkflowNode);
  actions.appendChild(deleteBtn);

  const duplicateBtn = document.createElement('button');
  duplicateBtn.className = 'btn btn-sm';
  duplicateBtn.textContent = 'Duplicate';
  duplicateBtn.addEventListener('click', duplicateSelectedWorkflowNode);
  actions.appendChild(duplicateBtn);

  inspector.appendChild(actions);
}

function buildInspectorRow(label, value, onChange, readOnly = false, multiline = false) {
  const row = document.createElement('div');
  row.className = 'workflow-inspector-row';

  const labelEl = document.createElement('div');
  labelEl.className = 'workflow-inspector-label';
  labelEl.textContent = label;

  let inputEl;
  if (multiline) {
    inputEl = document.createElement('textarea');
    inputEl.rows = 3;
  } else {
    inputEl = document.createElement('input');
    inputEl.type = 'text';
  }

  inputEl.className = 'workflow-inspector-input';
  inputEl.value = value;
  if (readOnly) {
    inputEl.readOnly = true;
  } else if (onChange) {
    inputEl.addEventListener('input', () => onChange(inputEl.value));
  }

  row.appendChild(labelEl);
  row.appendChild(inputEl);
  return row;
}

function addWorkflowEdge(fromId, toId) {
  const exists = workflowState.edges.some(edge => edge.from === fromId && edge.to === toId);
  if (exists) return;

  workflowState.edges.push({
    id: `edge-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    from: fromId,
    to: toId
  });

  updateWorkflowEdges();
  updateWorkflowStats();
}

function updateWorkflowEdges() {
  const edgesEl = workflowState.edgesEl;
  const canvas = workflowState.canvas;
  if (!edgesEl || !canvas) return;

  const rect = canvas.getBoundingClientRect();
  edgesEl.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  edgesEl.setAttribute('width', `${rect.width}`);
  edgesEl.setAttribute('height', `${rect.height}`);
  edgesEl.innerHTML = '';

  // Add arrow marker definition
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'workflow-arrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '8');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '6');
  marker.setAttribute('markerHeight', '6');
  marker.setAttribute('orient', 'auto-start-reverse');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  arrowPath.setAttribute('fill', 'rgba(139, 233, 253, 0.9)');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);

  // Add active arrow marker
  const markerActive = marker.cloneNode(true);
  markerActive.setAttribute('id', 'workflow-arrow-active');
  markerActive.querySelector('path').setAttribute('fill', 'var(--color-primary)');
  defs.appendChild(markerActive);

  edgesEl.appendChild(defs);

  workflowState.edges.forEach(edge => {
    const fromEl = getWorkflowNodeElement(edge.from);
    const toEl = getWorkflowNodeElement(edge.to);
    if (!fromEl || !toEl) return;

    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();

    // Calculate edge points from node edges (not centers)
    const fromCenterX = fromRect.left - rect.left + fromRect.width / 2;
    const fromCenterY = fromRect.top - rect.top + fromRect.height / 2;
    const toCenterX = toRect.left - rect.left + toRect.width / 2;
    const toCenterY = toRect.top - rect.top + toRect.height / 2;

    // Determine connection points on node edges
    const dx = toCenterX - fromCenterX;
    const dy = toCenterY - fromCenterY;
    const angle = Math.atan2(dy, dx);

    // Start point on from node edge
    let x1, y1;
    if (Math.abs(dx) > Math.abs(dy)) {
      x1 = fromCenterX + (dx > 0 ? fromRect.width / 2 : -fromRect.width / 2);
      y1 = fromCenterY;
    } else {
      x1 = fromCenterX;
      y1 = fromCenterY + (dy > 0 ? fromRect.height / 2 : -fromRect.height / 2);
    }

    // End point on to node edge
    let x2, y2;
    if (Math.abs(dx) > Math.abs(dy)) {
      x2 = toCenterX + (dx > 0 ? -toRect.width / 2 - 8 : toRect.width / 2 + 8);
      y2 = toCenterY;
    } else {
      x2 = toCenterX;
      y2 = toCenterY + (dy > 0 ? -toRect.height / 2 - 8 : toRect.height / 2 + 8);
    }

    // Calculate control points for bezier curve
    const dist = Math.sqrt(dx * dx + dy * dy);
    const curvature = Math.min(dist / 3, 80);

    let cx1, cy1, cx2, cy2;
    if (Math.abs(dx) > Math.abs(dy)) {
      cx1 = x1 + (dx > 0 ? curvature : -curvature);
      cy1 = y1;
      cx2 = x2 + (dx > 0 ? -curvature : curvature);
      cy2 = y2;
    } else {
      cx1 = x1;
      cy1 = y1 + (dy > 0 ? curvature : -curvature);
      cx2 = x2;
      cy2 = y2 + (dy > 0 ? -curvature : curvature);
    }

    // Create bezier path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'rgba(139, 233, 253, 0.7)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('marker-end', 'url(#workflow-arrow)');
    path.dataset.edgeId = edge.id;

    // Highlight if connected to selected node
    if (edge.from === workflowState.selectedNodeId || edge.to === workflowState.selectedNodeId) {
      path.setAttribute('stroke', 'var(--color-primary)');
      path.setAttribute('stroke-width', '3');
      path.setAttribute('marker-end', 'url(#workflow-arrow-active)');
    }

    // Add edge label if exists
    if (edge.label) {
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', midX);
      text.setAttribute('y', midY - 5);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'var(--color-text-muted)');
      text.setAttribute('font-size', '10');
      text.textContent = edge.label;
      edgesEl.appendChild(text);
    }

    // Click handler to select edge
    path.style.cursor = 'pointer';
    path.addEventListener('click', (e) => {
      e.stopPropagation();
      selectWorkflowEdge(edge.id);
    });

    edgesEl.appendChild(path);
  });
}

/**
 * Select an edge
 */
function selectWorkflowEdge(edgeId) {
  workflowState.selectedNodeId = null;
  const edge = workflowState.edges.find(e => e.id === edgeId);
  if (!edge) return;

  // Show edge in inspector
  const inspector = workflowState.inspectorEl;
  if (inspector) {
    inspector.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'workflow-inspector-title';
    title.textContent = 'Edge Properties';
    inspector.appendChild(title);

    const fromNode = getWorkflowNode(edge.from);
    const toNode = getWorkflowNode(edge.to);

    inspector.appendChild(buildInspectorRow('From', fromNode?.label || edge.from, null, true));
    inspector.appendChild(buildInspectorRow('To', toNode?.label || edge.to, null, true));
    inspector.appendChild(buildInspectorRow('Label', edge.label || '', (value) => {
      edge.label = value;
      updateWorkflowEdges();
    }));

    // Delete edge button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-sm btn-danger';
    deleteBtn.textContent = 'Delete Edge';
    deleteBtn.style.marginTop = '10px';
    deleteBtn.addEventListener('click', () => {
      pushWorkflowUndoState();
      workflowState.edges = workflowState.edges.filter(e => e.id !== edgeId);
      renderWorkflow();
      setWorkflowStatus('Edge deleted');
    });
    inspector.appendChild(deleteBtn);
  }

  updateWorkflowEdges();
}

function updateWorkflowStats() {
  if (workflowState.statsEl) {
    workflowState.statsEl.textContent = `${workflowState.nodes.length} nodes / ${workflowState.edges.length} links`;
  }
}

function setWorkflowStatus(message) {
  if (workflowState.statusEl) {
    workflowState.statusEl.textContent = message;
  }
}

function setConnectMode(enabled) {
  workflowState.connectMode = enabled;
  if (!enabled) {
    workflowState.connectingFrom = null;
  }
  updateWorkflowConnectUI();
}

function updateWorkflowConnectUI() {
  if (workflowState.canvas) {
    workflowState.canvas.classList.toggle('connect-mode', workflowState.connectMode);
  }
  if (workflowState.connectBtn) {
    workflowState.connectBtn.classList.toggle('active', workflowState.connectMode);
  }
  renderWorkflow();
}

function autoLayoutWorkflow() {
  const canvas = workflowState.canvas;
  if (!canvas || workflowState.nodes.length === 0) return;

  const rect = canvas.getBoundingClientRect();
  const columns = Math.max(1, Math.floor(rect.width / 200));
  const spacingX = rect.width / columns;
  const spacingY = 90;

  workflowState.nodes.forEach((node, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    node.x = Math.max(10, col * spacingX + 20);
    node.y = Math.max(10, row * spacingY + 20);
  });

  renderWorkflow();
  setWorkflowStatus('Layout updated');
}

function saveWorkflow(silent) {
  const payload = {
    version: 1,
    nodes: workflowState.nodes,
    edges: workflowState.edges
  };

  try {
    localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(payload));
    workflowState.lastSaved = new Date();
    if (!silent) setWorkflowStatus('Workflow saved');
  } catch (err) {
    console.error('[Workflow] Save failed:', err);
    if (!silent) setWorkflowStatus('Save failed');
  }
}

function loadWorkflow(silent) {
  try {
    const raw = localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) {
      if (!silent) setWorkflowStatus('No saved workflow');
      return;
    }

    const data = JSON.parse(raw);
    workflowState.nodes = Array.isArray(data.nodes) ? data.nodes : [];
    workflowState.edges = Array.isArray(data.edges) ? data.edges : [];
    workflowState.selectedNodeId = null;
    workflowState.connectMode = false;
    workflowState.connectingFrom = null;
    renderWorkflow();
    if (!silent) setWorkflowStatus('Workflow loaded');
  } catch (err) {
    console.error('[Workflow] Load failed:', err);
    if (!silent) setWorkflowStatus('Load failed');
  }
}

function exportWorkflow() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    nodes: workflowState.nodes,
    edges: workflowState.edges
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'workflow.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setWorkflowStatus('Workflow exported');
}

function getWorkflowNode(nodeId) {
  if (!nodeId) return null;
  return workflowState.nodes.find(node => node.id === nodeId) || null;
}

function getWorkflowNodeElement(nodeId) {
  if (!workflowState.nodesEl) return null;
  return workflowState.nodesEl.querySelector(`[data-node-id="${nodeId}"]`);
}

// ============================================================================
// DEBUG REPLAY TAB (Task #21)
// ============================================================================

/**
 * Debug replay state
 */
const debugState = {
  session: null,
  actions: [],
  filteredActions: [],
  currentIndex: -1,
  isPlaying: false,
  playSpeed: 1,
  filter: 'all',
  breakpoints: new Set(),
  typeBreakpoints: new Set(),
  searchQuery: '',
  searchResults: []
};

/**
 * Action type colors
 */
const ACTION_COLORS = {
  'message': '#8be9fd',
  'tool_call': '#50fa7b',
  'tool_result': '#6272a4',
  'error': '#ff5555',
  'state_change': '#ffb86c',
  'decision': '#bd93f9',
  'file_access': '#f1fa8c',
  'system': '#ff79c6'
};

/**
 * Setup debug replay tab
 */
function setupDebugTab() {
  const sessionSelect = document.getElementById('debugSessionSelect');
  const loadBtn = document.getElementById('debugLoadBtn');
  const stepBackBtn = document.getElementById('debugStepBack');
  const stepForwardBtn = document.getElementById('debugStepForward');
  const playBtn = document.getElementById('debugPlayBtn');
  const resetBtn = document.getElementById('debugResetBtn');
  const speedSelect = document.getElementById('debugSpeedSelect');
  const filterSelect = document.getElementById('debugFilterSelect');
  const searchInput = document.getElementById('debugSearchInput');
  const searchBtn = document.getElementById('debugSearchBtn');
  const exportBtn = document.getElementById('debugExportBtn');
  const progress = document.getElementById('debugProgress');
  const progressBar = document.getElementById('debugProgressBar');
  const progressText = document.getElementById('debugProgressText');
  const timeline = document.getElementById('debugTimeline');
  const detailsContent = document.getElementById('debugDetailsContent');
  const breakpointBtn = document.getElementById('debugBreakpointBtn');
  const contextBtn = document.getElementById('debugContextBtn');

  // Populate session selector with agent roles
  if (sessionSelect) {
    const roles = ['lead', 'orchestrator', 'worker-a', 'worker-b', 'investigator', 'reviewer'];
    sessionSelect.innerHTML = '<option value="">Select agent...</option>' +
      roles.map(r => `<option value="${r}">${r}</option>`).join('');
  }

  // Load session button
  if (loadBtn) {
    loadBtn.addEventListener('click', async () => {
      const role = sessionSelect?.value;
      if (!role) return;
      await loadDebugSession(role);
    });
  }

  // Step controls
  if (stepBackBtn) {
    stepBackBtn.addEventListener('click', async () => {
      await debugStepBackward();
    });
  }

  if (stepForwardBtn) {
    stepForwardBtn.addEventListener('click', async () => {
      await debugStepForward();
    });
  }

  // Play/pause
  if (playBtn) {
    playBtn.addEventListener('click', async () => {
      if (debugState.isPlaying) {
        await debugPause();
      } else {
        await debugPlay();
      }
    });
  }

  // Reset
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await debugReset();
    });
  }

  // Speed control
  if (speedSelect) {
    speedSelect.addEventListener('change', (e) => {
      debugState.playSpeed = parseFloat(e.target.value) || 1;
    });
  }

  // Filter control
  if (filterSelect) {
    filterSelect.addEventListener('change', async (e) => {
      debugState.filter = e.target.value;
      await applyDebugFilter();
    });
  }

  // Search
  if (searchBtn) {
    searchBtn.addEventListener('click', async () => {
      const query = searchInput?.value;
      if (query) {
        await searchDebugActions(query);
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        const query = searchInput.value;
        if (query) {
          await searchDebugActions(query);
        }
      }
    });
  }

  // Export
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      await exportDebugSession();
    });
  }

  // Progress bar click to seek
  if (progress) {
    progress.addEventListener('click', (e) => {
      if (debugState.filteredActions.length === 0) return;
      const rect = progress.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const idx = Math.floor(pct * debugState.filteredActions.length);
      debugJumpTo(idx);
    });
  }

  // Timeline click handler
  if (timeline) {
    timeline.addEventListener('click', (e) => {
      const item = e.target.closest('.debug-action-item');
      if (item) {
        const idx = parseInt(item.dataset.index, 10);
        if (!isNaN(idx)) {
          debugJumpTo(idx);
        }
      }
    });
  }

  // Breakpoint button
  if (breakpointBtn) {
    breakpointBtn.addEventListener('click', () => {
      if (debugState.currentIndex >= 0) {
        toggleBreakpoint(debugState.currentIndex);
      }
    });
  }

  // Context button
  if (contextBtn) {
    contextBtn.addEventListener('click', async () => {
      await showActionContext();
    });
  }

  console.log('[DebugTab] Setup complete');
}

/**
 * Load debug session for an agent
 */
async function loadDebugSession(role) {
  const timeline = document.getElementById('debugTimeline');
  const emptyState = document.getElementById('debugEmpty');

  try {
    if (timeline) timeline.innerHTML = '<div class="debug-loading">Loading session...</div>';

    const result = await window.ipcRenderer.invoke('debug-load-session', { role });

    if (!result.success) {
      console.error('[DebugTab] Load failed:', result.error);
      if (timeline) timeline.innerHTML = `<div class="debug-error">Error: ${result.error}</div>`;
      return;
    }

    debugState.session = { role, loadedAt: Date.now() };
    debugState.actions = result.actions || [];
    debugState.filteredActions = [...debugState.actions];
    debugState.currentIndex = -1;
    debugState.isPlaying = false;
    debugState.searchResults = [];

    if (emptyState) {
      emptyState.style.display = debugState.actions.length === 0 ? 'block' : 'none';
    }

    updateDebugTimeline();
    updateDebugProgress();
    updateDebugStats();

    console.log(`[DebugTab] Loaded ${debugState.actions.length} actions for ${role}`);
  } catch (err) {
    console.error('[DebugTab] Load error:', err);
    if (timeline) timeline.innerHTML = `<div class="debug-error">Error: ${err.message}</div>`;
  }
}

/**
 * Step forward in replay
 */
async function debugStepForward() {
  if (debugState.filteredActions.length === 0) return;

  const nextIndex = debugState.currentIndex + 1;
  if (nextIndex >= debugState.filteredActions.length) return;

  debugState.currentIndex = nextIndex;
  updateDebugUI();

  // Check for breakpoint
  if (debugState.breakpoints.has(nextIndex)) {
    await debugPause();
    showNotification('Breakpoint hit at index ' + nextIndex);
  }

  // Check for type breakpoint
  const action = debugState.filteredActions[nextIndex];
  if (action && debugState.typeBreakpoints.has(action.type)) {
    await debugPause();
    showNotification('Type breakpoint hit: ' + action.type);
  }
}

/**
 * Step backward in replay
 */
async function debugStepBackward() {
  if (debugState.currentIndex <= 0) return;

  debugState.currentIndex--;
  updateDebugUI();
}

/**
 * Jump to specific index
 */
function debugJumpTo(index) {
  if (index < 0 || index >= debugState.filteredActions.length) return;

  debugState.currentIndex = index;
  updateDebugUI();
}

/**
 * Start auto-play
 */
async function debugPlay() {
  if (debugState.filteredActions.length === 0) return;
  if (debugState.currentIndex >= debugState.filteredActions.length - 1) {
    debugState.currentIndex = -1; // Start from beginning
  }

  debugState.isPlaying = true;
  updatePlayButton();

  const playLoop = async () => {
    if (!debugState.isPlaying) return;
    if (debugState.currentIndex >= debugState.filteredActions.length - 1) {
      await debugPause();
      return;
    }

    await debugStepForward();

    if (debugState.isPlaying) {
      const delay = 1000 / debugState.playSpeed;
      setTimeout(playLoop, delay);
    }
  };

  playLoop();
}

/**
 * Pause auto-play
 */
async function debugPause() {
  debugState.isPlaying = false;
  updatePlayButton();
}

/**
 * Reset to beginning
 */
async function debugReset() {
  debugState.currentIndex = -1;
  debugState.isPlaying = false;
  updateDebugUI();
  updatePlayButton();
}

/**
 * Apply filter to actions
 */
async function applyDebugFilter() {
  if (debugState.filter === 'all') {
    debugState.filteredActions = [...debugState.actions];
  } else {
    debugState.filteredActions = debugState.actions.filter(a => a.type === debugState.filter);
  }

  debugState.currentIndex = -1;
  updateDebugTimeline();
  updateDebugProgress();
}

/**
 * Search actions
 */
async function searchDebugActions(query) {
  debugState.searchQuery = query;

  try {
    const result = await window.ipcRenderer.invoke('debug-search', { query });

    if (result.success) {
      debugState.searchResults = result.results || [];
      highlightSearchResults();
      showNotification(`Found ${result.count} matches`);
    }
  } catch (err) {
    console.error('[DebugTab] Search error:', err);
  }
}

/**
 * Export session
 */
async function exportDebugSession() {
  try {
    const result = await window.ipcRenderer.invoke('debug-export', { format: 'json', includeContent: true });

    if (result.success) {
      // Create download
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `debug-session-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showNotification('Session exported');
    }
  } catch (err) {
    console.error('[DebugTab] Export error:', err);
  }
}

/**
 * Toggle breakpoint at index
 */
function toggleBreakpoint(index) {
  if (debugState.breakpoints.has(index)) {
    debugState.breakpoints.delete(index);
  } else {
    debugState.breakpoints.add(index);
  }
  updateDebugTimeline();
}

/**
 * Show action context
 */
async function showActionContext() {
  if (debugState.currentIndex < 0) return;

  try {
    const result = await window.ipcRenderer.invoke('debug-get-context', {
      index: debugState.currentIndex,
      range: 5
    });

    if (result.success) {
      const modal = document.createElement('div');
      modal.className = 'debug-context-modal';
      modal.innerHTML = `
        <div class="debug-context-content">
          <div class="debug-context-header">
            <h3>Action Context</h3>
            <button class="debug-context-close">&times;</button>
          </div>
          <div class="debug-context-body">
            <h4>Before (${result.context.before.length})</h4>
            <pre>${JSON.stringify(result.context.before, null, 2)}</pre>
            <h4>Current</h4>
            <pre>${JSON.stringify(result.context.current, null, 2)}</pre>
            <h4>After (${result.context.after.length})</h4>
            <pre>${JSON.stringify(result.context.after, null, 2)}</pre>
            ${result.related?.length ? `<h4>Related (${result.related.length})</h4><pre>${JSON.stringify(result.related, null, 2)}</pre>` : ''}
          </div>
        </div>
      `;

      modal.querySelector('.debug-context-close').addEventListener('click', () => {
        modal.remove();
      });

      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });

      document.body.appendChild(modal);
    }
  } catch (err) {
    console.error('[DebugTab] Context error:', err);
  }
}

/**
 * Update debug UI (all components)
 */
function updateDebugUI() {
  updateDebugProgress();
  updateDebugTimeline();
  updateDebugDetails();
}

/**
 * Update progress bar
 */
function updateDebugProgress() {
  const progressBar = document.getElementById('debugProgressBar');
  const progressText = document.getElementById('debugProgressText');

  const total = debugState.filteredActions.length;
  const current = debugState.currentIndex + 1;
  const pct = total > 0 ? (current / total) * 100 : 0;

  if (progressBar) progressBar.style.width = `${pct}%`;
  if (progressText) progressText.textContent = `${current} / ${total}`;
}

/**
 * Update timeline display
 */
function updateDebugTimeline() {
  const timeline = document.getElementById('debugTimeline');
  if (!timeline) return;

  if (debugState.filteredActions.length === 0) {
    timeline.innerHTML = '<div class="debug-empty-timeline">No actions to display</div>';
    return;
  }

  const html = debugState.filteredActions.map((action, idx) => {
    const color = ACTION_COLORS[action.type] || '#6272a4';
    const isCurrent = idx === debugState.currentIndex;
    const hasBreakpoint = debugState.breakpoints.has(idx);
    const isSearchMatch = debugState.searchResults.some(r => r.index === idx);
    const time = action.timestamp ? new Date(action.timestamp).toLocaleTimeString() : '';

    return `
      <div class="debug-action-item ${isCurrent ? 'current' : ''} ${hasBreakpoint ? 'breakpoint' : ''} ${isSearchMatch ? 'search-match' : ''}"
           data-index="${idx}">
        <span class="debug-action-marker" style="background: ${color}"></span>
        <span class="debug-action-index">#${idx}</span>
        <span class="debug-action-type">${action.type}</span>
        <span class="debug-action-preview">${getActionPreview(action)}</span>
        <span class="debug-action-time">${time}</span>
        ${hasBreakpoint ? '<span class="debug-breakpoint-icon">●</span>' : ''}
      </div>
    `;
  }).join('');

  timeline.innerHTML = html;

  // Scroll current into view
  const currentEl = timeline.querySelector('.debug-action-item.current');
  if (currentEl) {
    currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/**
 * Get preview text for an action
 */
function getActionPreview(action) {
  if (!action) return '';

  if (action.content) {
    const text = typeof action.content === 'string' ? action.content : JSON.stringify(action.content);
    return text.slice(0, 50) + (text.length > 50 ? '...' : '');
  }

  if (action.tool) return `${action.tool}()`;
  if (action.message) return action.message.slice(0, 50);
  if (action.error) return action.error.slice(0, 50);

  return '';
}

/**
 * Update details panel
 */
function updateDebugDetails() {
  const detailsContent = document.getElementById('debugDetailsContent');
  if (!detailsContent) return;

  if (debugState.currentIndex < 0 || debugState.currentIndex >= debugState.filteredActions.length) {
    detailsContent.innerHTML = '<div class="debug-no-selection">Select an action to view details</div>';
    return;
  }

  const action = debugState.filteredActions[debugState.currentIndex];
  const color = ACTION_COLORS[action.type] || '#6272a4';
  const time = action.timestamp ? new Date(action.timestamp).toLocaleString() : 'Unknown';

  let content = '';

  // Type badge
  content += `<div class="debug-detail-type" style="background: ${color}">${action.type}</div>`;

  // Timestamp
  content += `<div class="debug-detail-time">${time}</div>`;

  // Role
  if (action.role) {
    content += `<div class="debug-detail-field"><label>Role:</label><span>${action.role}</span></div>`;
  }

  // Tool info
  if (action.tool) {
    content += `<div class="debug-detail-field"><label>Tool:</label><span>${action.tool}</span></div>`;
  }

  // Content
  if (action.content) {
    const contentStr = typeof action.content === 'string' ? action.content : JSON.stringify(action.content, null, 2);
    content += `<div class="debug-detail-content"><label>Content:</label><pre>${escapeHtml(contentStr)}</pre></div>`;
  }

  // Result
  if (action.result) {
    const resultStr = typeof action.result === 'string' ? action.result : JSON.stringify(action.result, null, 2);
    content += `<div class="debug-detail-content"><label>Result:</label><pre>${escapeHtml(resultStr)}</pre></div>`;
  }

  // Error
  if (action.error) {
    content += `<div class="debug-detail-error"><label>Error:</label><pre>${escapeHtml(action.error)}</pre></div>`;
  }

  // Metadata
  if (action.metadata) {
    content += `<div class="debug-detail-content"><label>Metadata:</label><pre>${escapeHtml(JSON.stringify(action.metadata, null, 2))}</pre></div>`;
  }

  detailsContent.innerHTML = content;
}

/**
 * Update stats display
 */
function updateDebugStats() {
  const totalEl = document.getElementById('debugTotalActions');
  const errorsEl = document.getElementById('debugErrorCount');
  const toolsEl = document.getElementById('debugToolCount');

  if (totalEl) totalEl.textContent = debugState.actions.length;
  if (errorsEl) errorsEl.textContent = debugState.actions.filter(a => a.type === 'error').length;
  if (toolsEl) toolsEl.textContent = debugState.actions.filter(a => a.type === 'tool_call').length;
}

/**
 * Update play button state
 */
function updatePlayButton() {
  const playBtn = document.getElementById('debugPlayBtn');
  if (playBtn) {
    playBtn.textContent = debugState.isPlaying ? '⏸' : '▶';
    playBtn.title = debugState.isPlaying ? 'Pause' : 'Play';
  }
}

/**
 * Highlight search results in timeline
 */
function highlightSearchResults() {
  const timeline = document.getElementById('debugTimeline');
  if (!timeline) return;

  // Remove previous highlights
  timeline.querySelectorAll('.search-match').forEach(el => el.classList.remove('search-match'));

  // Add new highlights
  debugState.searchResults.forEach(result => {
    const item = timeline.querySelector(`.debug-action-item[data-index="${result.index}"]`);
    if (item) item.classList.add('search-match');
  });

  // Jump to first result
  if (debugState.searchResults.length > 0) {
    debugJumpTo(debugState.searchResults[0].index);
  }
}

/**
 * Show notification
 */
function showNotification(message) {
  console.log('[DebugTab]', message);
  // Could integrate with a toast system
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Get current debug state
 */
function getDebugState() {
  return {
    session: debugState.session,
    actionCount: debugState.actions.length,
    filteredCount: debugState.filteredActions.length,
    currentIndex: debugState.currentIndex,
    isPlaying: debugState.isPlaying,
    filter: debugState.filter,
    breakpointCount: debugState.breakpoints.size
  };
}

// ============================================================================
// REVIEW TAB (Task #18: AI-Powered Code Review)
// ============================================================================

/**
 * Review state
 */
const reviewState = {
  mode: 'all',
  issues: [],
  filteredIssues: [],
  selectedIssue: null,
  severityFilter: 'all',
  isLoading: false,
  aiAvailable: false,
  lastReview: null,
};

/**
 * Severity colors
 */
const SEVERITY_COLORS = {
  critical: 'var(--color-red)',
  high: '#ff79c6',
  medium: 'var(--color-yellow)',
  low: 'var(--color-text-muted)',
  info: 'var(--color-text-muted)',
};

/**
 * Setup review tab
 */
function setupReviewTab() {
  const runBtn = document.getElementById('reviewRunBtn');
  const historyBtn = document.getElementById('reviewHistoryBtn');
  const settingsBtn = document.getElementById('reviewSettingsBtn');
  const modeButtons = document.querySelectorAll('.review-mode-btn');
  const severityButtons = document.querySelectorAll('.review-sev-btn');
  const issuesList = document.getElementById('reviewIssuesList');
  const detailsClose = document.getElementById('reviewDetailsClose');

  // Mode buttons
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      modeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      reviewState.mode = btn.dataset.mode;
    });
  });

  // Severity filters
  severityButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      severityButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      reviewState.severityFilter = btn.dataset.severity;
      filterReviewIssues();
    });
  });

  // Run review button
  if (runBtn) {
    runBtn.addEventListener('click', runCodeReview);
  }

  // History button
  if (historyBtn) {
    historyBtn.addEventListener('click', showReviewHistory);
  }

  // Settings button
  if (settingsBtn) {
    settingsBtn.addEventListener('click', showReviewSettings);
  }

  // Issue list click handler
  if (issuesList) {
    issuesList.addEventListener('click', (e) => {
      const issueEl = e.target.closest('.review-issue');
      if (issueEl) {
        const idx = parseInt(issueEl.dataset.index, 10);
        if (!isNaN(idx)) {
          selectReviewIssue(idx);
        }
      }
    });
  }

  // Details close button
  if (detailsClose) {
    detailsClose.addEventListener('click', () => {
      const details = document.getElementById('reviewDetails');
      if (details) details.classList.remove('visible');
      reviewState.selectedIssue = null;
      updateReviewIssuesList();
    });
  }

  // Check AI availability
  checkReviewAIStatus();

  console.log('[ReviewTab] Setup complete');
}

/**
 * Run code review
 */
async function runCodeReview() {
  const loading = document.getElementById('reviewLoading');
  const summary = document.getElementById('reviewSummary');

  reviewState.isLoading = true;
  if (loading) loading.classList.remove('hidden');

  try {
    const result = await window.ipcRenderer.invoke('review-diff', {
      mode: reviewState.mode,
    });

    if (!result.success) {
      throw new Error(result.error || 'Review failed');
    }

    reviewState.issues = result.issues || [];
    reviewState.filteredIssues = [...reviewState.issues];
    reviewState.lastReview = {
      timestamp: Date.now(),
      summary: result.summary,
      stats: result.stats,
      usedAI: result.usedAI,
    };

    updateReviewSummary(result);
    updateReviewSeverityCounts(result.stats);
    filterReviewIssues();

    console.log(`[ReviewTab] Review complete: ${result.issues.length} issues`);
  } catch (err) {
    console.error('[ReviewTab] Review error:', err);
    if (summary) {
      summary.classList.add('error');
      summary.querySelector('.review-summary-text').textContent = `Error: ${err.message}`;
    }
  } finally {
    reviewState.isLoading = false;
    if (loading) loading.classList.add('hidden');
  }
}

/**
 * Update review summary display
 */
function updateReviewSummary(result) {
  const summary = document.getElementById('reviewSummary');
  const summaryText = summary?.querySelector('.review-summary-text');
  const stats = document.getElementById('reviewStats');

  if (!summary || !summaryText) return;

  summary.classList.remove('success', 'warning', 'error');

  if (result.issues.length === 0) {
    summary.classList.add('success');
    summaryText.textContent = result.summary || 'No issues found. Code looks good!';
  } else if (result.stats?.bySeverity?.critical || result.stats?.bySeverity?.high) {
    summary.classList.add('error');
    summaryText.textContent = result.summary;
  } else {
    summary.classList.add('warning');
    summaryText.textContent = result.summary;
  }

  // Show stats
  if (stats && result.stats) {
    const parts = [];
    if (result.usedAI) parts.push('AI: Yes');
    if (result.truncated) parts.push('(truncated)');
    parts.push(`Local: ${result.stats.bySource?.local || 0}`);
    if (result.usedAI) parts.push(`AI: ${result.stats.bySource?.ai || 0}`);
    stats.textContent = parts.join(' | ');
  }
}

/**
 * Update severity count badges
 */
function updateReviewSeverityCounts(stats) {
  if (!stats?.bySeverity) return;

  const criticalEl = document.getElementById('reviewCriticalCount');
  const highEl = document.getElementById('reviewHighCount');
  const mediumEl = document.getElementById('reviewMediumCount');
  const lowEl = document.getElementById('reviewLowCount');

  if (criticalEl) criticalEl.textContent = stats.bySeverity.critical || 0;
  if (highEl) highEl.textContent = stats.bySeverity.high || 0;
  if (mediumEl) mediumEl.textContent = stats.bySeverity.medium || 0;
  if (lowEl) lowEl.textContent = (stats.bySeverity.low || 0) + (stats.bySeverity.info || 0);
}

/**
 * Filter issues by severity
 */
function filterReviewIssues() {
  if (reviewState.severityFilter === 'all') {
    reviewState.filteredIssues = [...reviewState.issues];
  } else if (reviewState.severityFilter === 'low') {
    reviewState.filteredIssues = reviewState.issues.filter(i =>
      i.severity === 'low' || i.severity === 'info'
    );
  } else {
    reviewState.filteredIssues = reviewState.issues.filter(i =>
      i.severity === reviewState.severityFilter
    );
  }

  updateReviewIssuesList();
}

/**
 * Update issues list display
 */
function updateReviewIssuesList() {
  const list = document.getElementById('reviewIssuesList');
  const countEl = document.getElementById('reviewIssueCount');
  const emptyEl = document.getElementById('reviewEmpty');

  if (!list) return;

  if (countEl) {
    countEl.textContent = `${reviewState.filteredIssues.length} issue${reviewState.filteredIssues.length !== 1 ? 's' : ''}`;
  }

  if (reviewState.filteredIssues.length === 0) {
    list.innerHTML = '';
    if (emptyEl) {
      emptyEl.style.display = 'flex';
      list.appendChild(emptyEl);
    }
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';

  list.innerHTML = reviewState.filteredIssues.map((issue, idx) => {
    const isSelected = reviewState.selectedIssue === idx;
    const file = issue.file && issue.file !== 'unknown' ? issue.file : '';
    const line = issue.line ? `:${issue.line}` : '';

    return `
      <div class="review-issue ${issue.severity} ${isSelected ? 'selected' : ''}" data-index="${idx}">
        <div class="review-issue-header">
          <span class="review-issue-severity ${issue.severity}">${issue.severity}</span>
          <span class="review-issue-category">${issue.category}</span>
          ${file ? `<span class="review-issue-file">${file}${line}</span>` : ''}
        </div>
        <div class="review-issue-message">${escapeHtml(issue.message)}</div>
        <div class="review-issue-source">${issue.source === 'ai' ? 'AI Analysis' : 'Pattern Match'}</div>
      </div>
    `;
  }).join('');
}

/**
 * Select an issue and show details
 */
function selectReviewIssue(index) {
  if (index < 0 || index >= reviewState.filteredIssues.length) return;

  reviewState.selectedIssue = index;
  updateReviewIssuesList();

  const issue = reviewState.filteredIssues[index];
  const details = document.getElementById('reviewDetails');
  const content = document.getElementById('reviewDetailsContent');

  if (!details || !content) return;

  details.classList.add('visible');

  let html = '';

  // Severity and category
  html += `<div class="review-detail-row">
    <span class="review-detail-label">Severity:</span>
    <span class="review-issue-severity ${issue.severity}">${issue.severity}</span>
  </div>`;

  html += `<div class="review-detail-row">
    <span class="review-detail-label">Category:</span>
    <span class="review-detail-value">${issue.category}</span>
  </div>`;

  // File and line
  if (issue.file && issue.file !== 'unknown') {
    html += `<div class="review-detail-row">
      <span class="review-detail-label">File:</span>
      <span class="review-detail-value">${issue.file}${issue.line ? ':' + issue.line : ''}</span>
    </div>`;
  }

  // Message
  html += `<div class="review-detail-row">
    <span class="review-detail-label">Issue:</span>
    <span class="review-detail-value">${escapeHtml(issue.message)}</span>
  </div>`;

  // Code content
  if (issue.content) {
    html += `<div class="review-detail-row">
      <span class="review-detail-label">Code:</span>
      <pre class="review-detail-code">${escapeHtml(issue.content)}</pre>
    </div>`;
  }

  // Suggestion
  if (issue.suggestion) {
    html += `<div class="review-detail-suggestion">
      <div class="review-detail-suggestion-label">Suggestion:</div>
      <div class="review-detail-value">${escapeHtml(issue.suggestion)}</div>
    </div>`;
  }

  // Source
  html += `<div class="review-detail-row">
    <span class="review-detail-label">Source:</span>
    <span class="review-detail-value">${issue.source === 'ai' ? 'AI Analysis' : 'Local Pattern Detection'}</span>
  </div>`;

  content.innerHTML = html;
}

/**
 * Check AI review availability
 */
async function checkReviewAIStatus() {
  const statusEl = document.getElementById('reviewAIStatus');

  try {
    const result = await window.ipcRenderer.invoke('review-ai-status');

    if (statusEl) {
      statusEl.classList.remove('available', 'unavailable');
      statusEl.classList.add(result.available ? 'available' : 'unavailable');

      const statusText = statusEl.querySelector('.review-ai-status-text');
      if (statusText) {
        statusText.textContent = result.available
          ? (result.enabled ? 'Enabled' : 'Disabled')
          : 'API key not set';
      }
    }

    reviewState.aiAvailable = result.available;
  } catch (err) {
    console.error('[ReviewTab] AI status check failed:', err);
  }
}

/**
 * Show review history modal
 */
async function showReviewHistory() {
  try {
    const result = await window.ipcRenderer.invoke('review-get-history', { limit: 20 });

    if (!result.success) {
      console.error('[ReviewTab] Failed to load history:', result.error);
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'review-history-modal';

    const historyHtml = result.history.length > 0
      ? result.history.map(item => `
          <div class="review-history-item" data-id="${item.id}">
            <div class="review-history-item-header">
              <span class="review-history-item-date">${new Date(item.timestamp).toLocaleString()}</span>
              <span class="review-history-item-mode">${item.mode}</span>
            </div>
            <div class="review-history-item-summary">${item.summary} (${item.issueCount} issues)</div>
          </div>
        `).join('')
      : '<div class="review-empty"><div class="review-empty-text">No review history</div></div>';

    modal.innerHTML = `
      <div class="review-history-content">
        <div class="review-history-header">
          <h3>Review History</h3>
          <button class="review-details-close">&times;</button>
        </div>
        <div class="review-history-list">${historyHtml}</div>
      </div>
    `;

    modal.querySelector('.review-details-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Load review on click
    modal.querySelectorAll('.review-history-item').forEach(item => {
      item.addEventListener('click', async () => {
        const id = item.dataset.id;
        const detail = await window.ipcRenderer.invoke('review-get-detail', { id });
        if (detail.success && detail.review) {
          reviewState.issues = detail.review.issues || [];
          reviewState.filteredIssues = [...reviewState.issues];
          updateReviewSummary(detail.review);
          updateReviewSeverityCounts(detail.review.stats);
          filterReviewIssues();
          modal.remove();
        }
      });
    });

    document.body.appendChild(modal);
  } catch (err) {
    console.error('[ReviewTab] History error:', err);
  }
}

/**
 * Show review settings modal
 */
async function showReviewSettings() {
  try {
    const result = await window.ipcRenderer.invoke('review-get-settings');
    const settings = result.settings || {};

    const modal = document.createElement('div');
    modal.className = 'review-settings-modal';

    modal.innerHTML = `
      <div class="review-settings-content">
        <div class="review-settings-header">
          <h3>Review Settings</h3>
          <button class="review-details-close">&times;</button>
        </div>
        <div class="review-settings-body">
          <div class="review-settings-group">
            <label class="review-settings-checkbox">
              <input type="checkbox" id="settingUseAI" ${settings.useAI ? 'checked' : ''}>
              <span>Enable AI analysis (requires API key)</span>
            </label>
          </div>
          <div class="review-settings-group">
            <label class="review-settings-checkbox">
              <input type="checkbox" id="settingAutoReview" ${settings.autoReview ? 'checked' : ''}>
              <span>Auto-review on git diff changes</span>
            </label>
          </div>
          <div class="review-settings-group">
            <label>Categories to check:</label>
            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;">
              ${['security', 'bug', 'performance', 'style', 'error_handling', 'complexity'].map(cat => `
                <label class="review-settings-checkbox" style="flex: 0 0 45%;">
                  <input type="checkbox" data-category="${cat}" ${settings.categories?.includes(cat) ? 'checked' : ''}>
                  <span>${cat.replace('_', ' ')}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <div class="review-settings-group" style="margin-top: 16px;">
            <button class="btn btn-primary" id="settingsSaveBtn">Save Settings</button>
            <button class="btn btn-sm" id="settingsClearBtn" style="margin-left: 8px;">Clear History</button>
          </div>
        </div>
      </div>
    `;

    modal.querySelector('.review-details-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Save button
    modal.querySelector('#settingsSaveBtn').addEventListener('click', async () => {
      const categories = [];
      modal.querySelectorAll('[data-category]').forEach(cb => {
        if (cb.checked) categories.push(cb.dataset.category);
      });

      await window.ipcRenderer.invoke('review-set-settings', {
        settings: {
          useAI: modal.querySelector('#settingUseAI').checked,
          autoReview: modal.querySelector('#settingAutoReview').checked,
          categories,
        }
      });

      checkReviewAIStatus();
      modal.remove();
    });

    // Clear history button
    modal.querySelector('#settingsClearBtn').addEventListener('click', async () => {
      await window.ipcRenderer.invoke('review-clear');
      modal.remove();
    });

    document.body.appendChild(modal);
  } catch (err) {
    console.error('[ReviewTab] Settings error:', err);
  }
}

/**
 * Get current review state
 */
function getReviewState() {
  return {
    mode: reviewState.mode,
    issueCount: reviewState.issues.length,
    filteredCount: reviewState.filteredIssues.length,
    severityFilter: reviewState.severityFilter,
    isLoading: reviewState.isLoading,
    aiAvailable: reviewState.aiAvailable,
    lastReview: reviewState.lastReview,
  };
}

// ================================================
// DOCUMENTATION TAB - Task #23
// ================================================

// Documentation state
const docsState = {
  mode: 'file',           // file, directory, project
  format: 'markdown',     // markdown, html, json
  targetPath: '',
  isLoading: false,
  lastGenerated: null,
  coverage: null,
  undocumented: [],
  preview: '',
  config: null,
};

/**
 * Setup documentation tab event listeners
 */
function setupDocsTab() {
  const modeBtns = document.querySelectorAll('.docs-mode-btn');
  const targetInput = document.getElementById('docsTargetInput');
  const browseBtn = document.getElementById('docsBrowseBtn');
  const formatSelect = document.getElementById('docsFormatSelect');
  const generateBtn = document.getElementById('docsGenerateBtn');
  const previewBtn = document.getElementById('docsPreviewBtn');
  const coverageBtn = document.getElementById('docsCoverageBtn');
  const settingsBtn = document.getElementById('docsSettingsBtn');
  const copyBtn = document.getElementById('docsCopyBtn');
  const exportBtn = document.getElementById('docsExportBtn');

  // Mode selector
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      docsState.mode = btn.dataset.mode;
      updateDocsTargetPlaceholder();
    });
  });

  // Target input
  if (targetInput) {
    targetInput.addEventListener('change', (e) => {
      docsState.targetPath = e.target.value;
    });
  }

  // Browse button
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      try {
        const result = await window.ipcRenderer.invoke('dialog-open', {
          type: docsState.mode === 'file' ? 'file' : 'directory',
          title: docsState.mode === 'file' ? 'Select File' : 'Select Directory',
          filters: docsState.mode === 'file' ? [
            { name: 'JavaScript/TypeScript', extensions: ['js', 'ts', 'mjs', 'jsx', 'tsx'] }
          ] : undefined,
        });
        if (result?.path) {
          docsState.targetPath = result.path;
          if (targetInput) targetInput.value = result.path;
        }
      } catch (err) {
        console.error('[DocsTab] Browse error:', err);
      }
    });
  }

  // Format selector
  if (formatSelect) {
    formatSelect.addEventListener('change', (e) => {
      docsState.format = e.target.value;
    });
  }

  // Generate button
  if (generateBtn) {
    generateBtn.addEventListener('click', async () => {
      await generateDocumentation();
    });
  }

  // Preview button
  if (previewBtn) {
    previewBtn.addEventListener('click', async () => {
      await previewDocumentation();
    });
  }

  // Coverage button
  if (coverageBtn) {
    coverageBtn.addEventListener('click', async () => {
      await checkDocsCoverage();
    });
  }

  // Settings button
  if (settingsBtn) {
    settingsBtn.addEventListener('click', async () => {
      await showDocsSettings();
    });
  }

  // Copy button
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (docsState.preview) {
        navigator.clipboard.writeText(docsState.preview);
        updateConnectionStatus('Copied to clipboard');
      }
    });
  }

  // Export button
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      await exportDocumentation();
    });
  }

  // Load initial config
  loadDocsConfig();

  console.log('[DocsTab] Setup complete');
}

/**
 * Update target input placeholder based on mode
 */
function updateDocsTargetPlaceholder() {
  const targetInput = document.getElementById('docsTargetInput');
  if (!targetInput) return;

  const placeholders = {
    file: 'Enter file path...',
    directory: 'Enter directory path...',
    project: 'Leave empty for entire project',
  };

  targetInput.placeholder = placeholders[docsState.mode] || 'Enter path...';
}

/**
 * Load documentation config
 */
async function loadDocsConfig() {
  try {
    const result = await window.ipcRenderer.invoke('docs-get-config');
    if (result?.success) {
      docsState.config = result.config;
    }
  } catch (err) {
    console.error('[DocsTab] Load config error:', err);
  }
}

/**
 * Generate documentation
 */
async function generateDocumentation() {
  const loading = document.getElementById('docsLoading');
  const previewContent = document.getElementById('docsPreviewContent');

  docsState.isLoading = true;
  if (loading) loading.classList.remove('hidden');

  try {
    let result;
    const payload = {
      format: docsState.format,
    };

    if (docsState.mode === 'file') {
      if (!docsState.targetPath) {
        throw new Error('Please select a file');
      }
      payload.filePath = docsState.targetPath;
      result = await window.ipcRenderer.invoke('docs-generate-file', payload);
    } else if (docsState.mode === 'directory') {
      payload.dirPath = docsState.targetPath || undefined;
      result = await window.ipcRenderer.invoke('docs-generate-directory', payload);
    } else {
      result = await window.ipcRenderer.invoke('docs-generate-project', payload);
    }

    if (!result.success) {
      throw new Error(result.error || 'Generation failed');
    }

    docsState.preview = result.documentation || '';
    docsState.lastGenerated = {
      timestamp: Date.now(),
      mode: docsState.mode,
      format: docsState.format,
      stats: result.stats,
    };

    // Update preview
    if (previewContent) {
      if (docsState.preview) {
        previewContent.textContent = docsState.preview;
        previewContent.classList.remove('docs-preview-empty');
      } else {
        previewContent.innerHTML = '<div class="docs-preview-empty">No documentation generated</div>';
      }
    }

    // Update coverage display
    if (result.stats) {
      updateDocsCoverageDisplay(result.stats);
    }

    console.log(`[DocsTab] Generated docs: ${result.elements?.length || result.totalElements || 0} elements`);
    updateConnectionStatus('Documentation generated');
  } catch (err) {
    console.error('[DocsTab] Generate error:', err);
    if (previewContent) {
      previewContent.innerHTML = `<div class="docs-preview-empty" style="color: var(--color-error);">Error: ${err.message}</div>`;
    }
    updateConnectionStatus(err.message);
  } finally {
    docsState.isLoading = false;
    if (loading) loading.classList.add('hidden');
  }
}

/**
 * Preview documentation without saving
 */
async function previewDocumentation() {
  if (!docsState.targetPath && docsState.mode === 'file') {
    updateConnectionStatus('Please select a file');
    return;
  }

  const loading = document.getElementById('docsLoading');
  const previewContent = document.getElementById('docsPreviewContent');

  docsState.isLoading = true;
  if (loading) loading.classList.remove('hidden');

  try {
    const result = await window.ipcRenderer.invoke('docs-preview', {
      filePath: docsState.targetPath,
      format: docsState.format,
    });

    if (!result.success) {
      throw new Error(result.error || 'Preview failed');
    }

    docsState.preview = result.preview || '';

    if (previewContent) {
      if (docsState.preview) {
        previewContent.textContent = docsState.preview;
        previewContent.classList.remove('docs-preview-empty');
      } else {
        previewContent.innerHTML = '<div class="docs-preview-empty">No documentation to preview</div>';
      }
    }

    console.log(`[DocsTab] Preview: ${result.elements} elements`);
  } catch (err) {
    console.error('[DocsTab] Preview error:', err);
    updateConnectionStatus(err.message);
  } finally {
    docsState.isLoading = false;
    if (loading) loading.classList.add('hidden');
  }
}

/**
 * Check documentation coverage
 */
async function checkDocsCoverage() {
  const loading = document.getElementById('docsLoading');

  docsState.isLoading = true;
  if (loading) loading.classList.remove('hidden');

  try {
    const result = await window.ipcRenderer.invoke('docs-get-coverage', {
      dirPath: docsState.targetPath || undefined,
    });

    if (!result.success) {
      throw new Error(result.error || 'Coverage check failed');
    }

    docsState.coverage = {
      percent: result.coverage,
      documented: result.documented,
      undocumented: result.undocumented,
      total: result.total,
    };

    updateDocsCoverageDisplay(result.stats);

    // Load undocumented items
    await loadUndocumentedItems();

    console.log(`[DocsTab] Coverage: ${result.coverage}%`);
    updateConnectionStatus(`Coverage: ${result.coverage}%`);
  } catch (err) {
    console.error('[DocsTab] Coverage error:', err);
    updateConnectionStatus(err.message);
  } finally {
    docsState.isLoading = false;
    if (loading) loading.classList.add('hidden');
  }
}

/**
 * Update coverage display
 */
function updateDocsCoverageDisplay(stats) {
  const percentEl = document.getElementById('docsCoveragePercent');
  const fillEl = document.getElementById('docsCoverageFill');
  const documentedEl = document.getElementById('docsDocumentedCount');
  const undocumentedEl = document.getElementById('docsUndocumentedCount');
  const totalEl = document.getElementById('docsTotalCount');

  if (!stats) return;

  const total = (stats.functions || 0) + (stats.classes || 0);
  const documented = stats.documented || 0;
  const undocumented = stats.undocumented || 0;
  const percent = total > 0 ? Math.round((documented / total) * 100) : 100;

  if (percentEl) percentEl.textContent = `${percent}%`;
  if (documentedEl) documentedEl.textContent = documented;
  if (undocumentedEl) undocumentedEl.textContent = undocumented;
  if (totalEl) totalEl.textContent = total;

  if (fillEl) {
    fillEl.style.width = `${percent}%`;
    fillEl.classList.remove('low', 'medium', 'high');
    if (percent < 40) {
      fillEl.classList.add('low');
    } else if (percent < 70) {
      fillEl.classList.add('medium');
    } else {
      fillEl.classList.add('high');
    }
  }
}

/**
 * Load undocumented items
 */
async function loadUndocumentedItems() {
  try {
    const result = await window.ipcRenderer.invoke('docs-get-undocumented', {
      dirPath: docsState.targetPath || undefined,
    });

    if (!result.success) {
      return;
    }

    docsState.undocumented = result.undocumented || [];
    updateUndocumentedList();
  } catch (err) {
    console.error('[DocsTab] Load undocumented error:', err);
  }
}

/**
 * Update undocumented items list
 */
function updateUndocumentedList() {
  const list = document.getElementById('docsUndocumentedList');
  const countEl = document.getElementById('docsUndocumentedItemCount');

  if (!list) return;

  if (countEl) {
    countEl.textContent = `${docsState.undocumented.length} item${docsState.undocumented.length !== 1 ? 's' : ''}`;
  }

  if (docsState.undocumented.length === 0) {
    list.innerHTML = '<div class="docs-undocumented-empty">All exported items are documented!</div>';
    return;
  }

  list.innerHTML = docsState.undocumented.map(item => `
    <div class="docs-undoc-item" data-file="${item.file}" data-line="${item.line}">
      <span class="docs-undoc-type">${item.type}</span>
      <span class="docs-undoc-name">${escapeHtml(item.name)}</span>
      <span class="docs-undoc-file">${item.file}</span>
      <span class="docs-undoc-line">:${item.line}</span>
    </div>
  `).join('');
}

/**
 * Export documentation to file
 */
async function exportDocumentation() {
  const loading = document.getElementById('docsLoading');

  if (!docsState.preview) {
    updateConnectionStatus('Generate documentation first');
    return;
  }

  docsState.isLoading = true;
  if (loading) loading.classList.remove('hidden');

  try {
    const result = await window.ipcRenderer.invoke('docs-export', {
      dirPath: docsState.targetPath || undefined,
      format: docsState.format,
    });

    if (!result.success) {
      throw new Error(result.error || 'Export failed');
    }

    console.log(`[DocsTab] Exported to: ${result.outputDir}`);
    updateConnectionStatus(`Exported to ${result.outputDir}`);
  } catch (err) {
    console.error('[DocsTab] Export error:', err);
    updateConnectionStatus(err.message);
  } finally {
    docsState.isLoading = false;
    if (loading) loading.classList.add('hidden');
  }
}

/**
 * Show documentation settings modal
 */
async function showDocsSettings() {
  try {
    const result = await window.ipcRenderer.invoke('docs-get-config');
    const config = result?.config || {};

    const modal = document.createElement('div');
    modal.className = 'docs-settings-modal';
    modal.innerHTML = `
      <div class="docs-settings-content">
        <div class="docs-settings-header">
          <h3>Documentation Settings</h3>
          <button class="review-details-close" id="docsSettingsClose">&times;</button>
        </div>
        <div class="docs-settings-body">
          <div class="docs-settings-group">
            <label>Project Name</label>
            <input type="text" class="docs-settings-input" id="docsSettingProjectName" value="${config.projectName || 'Hivemind'}">
          </div>
          <div class="docs-settings-group">
            <label>Version</label>
            <input type="text" class="docs-settings-input" id="docsSettingVersion" value="${config.version || '1.0.0'}">
          </div>
          <div class="docs-settings-group">
            <label>Default Output Directory</label>
            <input type="text" class="docs-settings-input" id="docsSettingOutputDir" value="${config.outputDir || './docs/api'}">
          </div>
          <div class="docs-settings-group">
            <label class="docs-settings-checkbox">
              <input type="checkbox" id="docsSettingIncludePrivate" ${config.includePrivate ? 'checked' : ''}>
              <span>Include private members</span>
            </label>
          </div>
          <div class="docs-settings-group">
            <label class="docs-settings-checkbox">
              <input type="checkbox" id="docsSettingRecursive" ${config.recursive !== false ? 'checked' : ''}>
              <span>Recursive directory scanning</span>
            </label>
          </div>
          <div class="docs-settings-group" style="margin-top: 16px;">
            <button class="btn btn-primary" id="docsSettingsSaveBtn">Save Settings</button>
            <button class="btn btn-sm" id="docsSettingsClearCacheBtn" style="margin-left: 8px;">Clear Cache</button>
          </div>
        </div>
      </div>
    `;

    modal.querySelector('#docsSettingsClose').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Save button
    modal.querySelector('#docsSettingsSaveBtn').addEventListener('click', async () => {
      const newConfig = {
        projectName: modal.querySelector('#docsSettingProjectName').value,
        version: modal.querySelector('#docsSettingVersion').value,
        outputDir: modal.querySelector('#docsSettingOutputDir').value,
        includePrivate: modal.querySelector('#docsSettingIncludePrivate').checked,
        recursive: modal.querySelector('#docsSettingRecursive').checked,
      };

      await window.ipcRenderer.invoke('docs-set-config', { config: newConfig });
      docsState.config = newConfig;
      modal.remove();
      updateConnectionStatus('Settings saved');
    });

    // Clear cache button
    modal.querySelector('#docsSettingsClearCacheBtn').addEventListener('click', async () => {
      await window.ipcRenderer.invoke('docs-clear-cache');
      updateConnectionStatus('Cache cleared');
    });

    document.body.appendChild(modal);
  } catch (err) {
    console.error('[DocsTab] Settings error:', err);
  }
}

/**
 * Get current docs state
 */
function getDocsState() {
  return {
    mode: docsState.mode,
    format: docsState.format,
    targetPath: docsState.targetPath,
    isLoading: docsState.isLoading,
    coverage: docsState.coverage,
    lastGenerated: docsState.lastGenerated,
  };
}

/* ================================================
   COST OPTIMIZATION TAB - Task #24
   API cost tracking, budget predictions, optimization suggestions
   ================================================ */

// Cost tab state
const costsState = {
  summary: null,
  agents: [],
  predictions: null,
  optimizations: [],
  alerts: [],
  budget: null,
  history: [],
  isLoading: false,
  budgetModalOpen: false,
  historyModalOpen: false,
};

/**
 * Setup the Costs tab UI and event handlers
 */
function setupCostsTab() {
  console.log('[CostsTab] Setting up costs tab');

  // Tab button
  const costsTabBtn = document.querySelector('[data-tab="costs"]');
  if (costsTabBtn) {
    costsTabBtn.addEventListener('click', () => {
      switchTab('costs');
      loadCostData();
    });
  }

  // Refresh button
  const refreshBtn = document.querySelector('.costs-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadCostData());
  }

  // Set budget button
  const budgetBtn = document.querySelector('.costs-budget-btn');
  if (budgetBtn) {
    budgetBtn.addEventListener('click', () => showBudgetModal());
  }

  // History button
  const historyBtn = document.querySelector('.costs-history-btn');
  if (historyBtn) {
    historyBtn.addEventListener('click', () => showHistoryModal());
  }

  // Alerts button
  const alertsBtn = document.querySelector('.costs-alerts-btn');
  if (alertsBtn) {
    alertsBtn.addEventListener('click', () => loadCostAlerts());
  }

  // Reset button
  const resetBtn = document.querySelector('.costs-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (confirm('Reset all cost tracking data? This cannot be undone.')) {
        resetCostData();
      }
    });
  }

  // Listen for cost events from main process
  if (window.electronAPI) {
    window.electronAPI.receive('cost-recorded', (record) => {
      console.log('[CostsTab] Cost recorded:', record);
      // Refresh data when new cost is recorded
      loadCostData();
    });

    window.electronAPI.receive('cost-alert', (alert) => {
      console.log('[CostsTab] Cost alert:', alert);
      showCostAlert(alert);
    });
  }

  console.log('[CostsTab] Setup complete');
}

/**
 * Load all cost data
 */
async function loadCostData() {
  if (costsState.isLoading) return;

  const loadingEl = document.querySelector('.costs-loading');
  if (loadingEl) loadingEl.classList.remove('hidden');
  costsState.isLoading = true;

  try {
    // Load summary, agents, predictions, optimizations in parallel
    const [summaryRes, agentsRes, predictionsRes, optimizationsRes, budgetRes] = await Promise.all([
      window.electronAPI?.invoke('cost-get-summary'),
      window.electronAPI?.invoke('cost-get-by-agent'),
      window.electronAPI?.invoke('cost-get-predictions'),
      window.electronAPI?.invoke('cost-get-optimizations'),
      window.electronAPI?.invoke('cost-get-budget'),
    ]);

    if (summaryRes?.success) {
      costsState.summary = summaryRes.summary;
      renderCostOverview(summaryRes.summary);
    }

    if (agentsRes?.success) {
      costsState.agents = agentsRes.agents || [];
      renderAgentBreakdown(agentsRes.agents);
    }

    if (predictionsRes?.success) {
      costsState.predictions = predictionsRes.predictions;
      renderPredictions(predictionsRes.predictions);
    }

    if (optimizationsRes?.success) {
      costsState.optimizations = optimizationsRes.optimizations || [];
      renderOptimizations(optimizationsRes.optimizations);
    }

    if (budgetRes?.success) {
      costsState.budget = budgetRes.budget;
      renderBudgetProgress(budgetRes.budget, budgetRes.usage);
    }

  } catch (err) {
    console.error('[CostsTab] Load error:', err);
  } finally {
    costsState.isLoading = false;
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

/**
 * Render cost overview cards
 */
function renderCostOverview(summary) {
  if (!summary) return;

  // Total cost
  const totalEl = document.querySelector('.costs-card-value.total');
  if (totalEl) {
    totalEl.textContent = formatCurrency(summary.total || 0);
  }

  // Today's cost
  const todayEl = document.querySelector('.costs-card-value.today');
  if (todayEl) {
    todayEl.textContent = formatCurrency(summary.today || 0);
  }

  // This week's cost
  const weekEl = document.querySelector('.costs-card-value.week');
  if (weekEl) {
    weekEl.textContent = formatCurrency(summary.thisWeek || 0);
  }

  // This month's cost
  const monthEl = document.querySelector('.costs-card-value.month');
  if (monthEl) {
    monthEl.textContent = formatCurrency(summary.thisMonth || 0);
  }

  // Update change indicators
  updateChangeIndicator('.costs-total-change', summary.totalChange);
  updateChangeIndicator('.costs-today-change', summary.todayChange);
  updateChangeIndicator('.costs-week-change', summary.weekChange);
  updateChangeIndicator('.costs-month-change', summary.monthChange);
}

/**
 * Update change indicator element
 */
function updateChangeIndicator(selector, change) {
  const el = document.querySelector(selector);
  if (!el || change === undefined) return;

  el.classList.remove('up', 'down', 'neutral');

  if (change > 0) {
    el.classList.add('up');
    el.innerHTML = `<span>↑</span> ${change.toFixed(1)}%`;
  } else if (change < 0) {
    el.classList.add('down');
    el.innerHTML = `<span>↓</span> ${Math.abs(change).toFixed(1)}%`;
  } else {
    el.classList.add('neutral');
    el.innerHTML = `<span>—</span> 0%`;
  }
}

/**
 * Render budget progress bar
 */
function renderBudgetProgress(budget, usage) {
  const budgetSection = document.querySelector('.costs-budget');
  if (!budgetSection) return;

  if (!budget || !budget.daily) {
    budgetSection.style.display = 'none';
    return;
  }

  budgetSection.style.display = 'block';

  const usedEl = budgetSection.querySelector('.costs-budget-used');
  const limitEl = budgetSection.querySelector('.costs-budget-limit');
  const fillEl = budgetSection.querySelector('.costs-budget-fill');
  const percentEl = budgetSection.querySelector('.costs-budget-percent');
  const remainEl = budgetSection.querySelector('.costs-budget-remaining');

  const used = usage?.daily || 0;
  const limit = budget.daily || 100;
  const percent = Math.min((used / limit) * 100, 100);

  if (usedEl) usedEl.textContent = `Used: ${formatCurrency(used)}`;
  if (limitEl) limitEl.textContent = `Budget: ${formatCurrency(limit)}`;

  if (fillEl) {
    fillEl.style.width = `${percent}%`;
    fillEl.classList.remove('warning', 'danger');
    if (percent >= 90) {
      fillEl.classList.add('danger');
    } else if (percent >= 70) {
      fillEl.classList.add('warning');
    }
  }

  if (percentEl) percentEl.textContent = `${percent.toFixed(1)}%`;
  if (remainEl) remainEl.textContent = `${formatCurrency(Math.max(limit - used, 0))} remaining`;
}

/**
 * Render predictions section
 */
function renderPredictions(predictions) {
  const listEl = document.querySelector('.costs-predictions-list');
  const trendEl = document.querySelector('.costs-predictions-trend');
  if (!listEl) return;

  if (!predictions || !predictions.daily) {
    listEl.innerHTML = '<div class="costs-empty"><p>Not enough data for predictions</p></div>';
    return;
  }

  // Update trend indicator
  if (trendEl) {
    const trend = predictions.trend || 'stable';
    trendEl.classList.remove('up', 'down', 'stable');
    trendEl.classList.add(trend);
    trendEl.innerHTML = trend === 'up' ? '↑ Rising' : trend === 'down' ? '↓ Falling' : '— Stable';
  }

  // Render prediction items
  const items = [
    { period: 'Today (Projected)', value: predictions.daily, confidence: predictions.dailyConfidence },
    { period: 'This Week', value: predictions.weekly, confidence: predictions.weeklyConfidence },
    { period: 'This Month', value: predictions.monthly, confidence: predictions.monthlyConfidence },
  ].filter(item => item.value !== undefined);

  listEl.innerHTML = items.map(item => `
    <div class="costs-prediction-item">
      <span class="costs-prediction-period">${item.period}</span>
      <span class="costs-prediction-value">${formatCurrency(item.value)}</span>
      ${item.confidence ? `<span class="costs-prediction-confidence">${(item.confidence * 100).toFixed(0)}% conf</span>` : ''}
    </div>
  `).join('');
}

/**
 * Render agent breakdown section
 */
function renderAgentBreakdown(agents) {
  const listEl = document.querySelector('.costs-agents-list');
  const countEl = document.querySelector('.costs-agents-count');
  if (!listEl) return;

  const agentList = Object.entries(agents || {});
  if (countEl) countEl.textContent = `${agentList.length} agent${agentList.length !== 1 ? 's' : ''}`;

  if (agentList.length === 0) {
    listEl.innerHTML = '<div class="costs-empty"><p>No agent cost data</p></div>';
    return;
  }

  // Sort by total cost descending
  agentList.sort((a, b) => (b[1].total || 0) - (a[1].total || 0));

  // Calculate max for bar scaling
  const maxCost = Math.max(...agentList.map(([, data]) => data.total || 0), 1);

  listEl.innerHTML = agentList.map(([agentId, data]) => {
    const barWidth = ((data.total || 0) / maxCost) * 100;
    const icon = getAgentIcon(agentId);

    return `
      <div class="costs-agent-item" data-agent="${agentId}">
        <div class="costs-agent-icon">${icon}</div>
        <div class="costs-agent-info">
          <div class="costs-agent-name">${agentId}</div>
          <div class="costs-agent-requests">${data.requests || 0} requests</div>
        </div>
        <div class="costs-agent-cost">${formatCurrency(data.total || 0)}</div>
        <div class="costs-agent-bar">
          <div class="costs-agent-bar-fill" style="width: ${barWidth}%"></div>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers for agent details
  listEl.querySelectorAll('.costs-agent-item').forEach(item => {
    item.addEventListener('click', () => {
      const agentId = item.dataset.agent;
      showAgentCostDetails(agentId);
    });
  });
}

/**
 * Get icon for agent type
 */
function getAgentIcon(agentId) {
  const id = (agentId || '').toLowerCase();
  if (id.includes('architect') || id.includes('lead')) return '🏗️';
  if (id.includes('worker') || id.includes('implement')) return '⚙️';
  if (id.includes('review')) return '🔍';
  if (id.includes('orchestrat')) return '🎯';
  if (id.includes('investigat')) return '🔬';
  return '🤖';
}

/**
 * Render optimizations section
 */
function renderOptimizations(optimizations) {
  const listEl = document.querySelector('.costs-optimizations-list');
  const countEl = document.querySelector('.costs-optimizations-count');
  if (!listEl) return;

  if (countEl) countEl.textContent = `${(optimizations || []).length} suggestion${optimizations?.length !== 1 ? 's' : ''}`;

  if (!optimizations || optimizations.length === 0) {
    listEl.innerHTML = '<div class="costs-empty"><p>No optimization suggestions</p></div>';
    return;
  }

  listEl.innerHTML = optimizations.map(opt => {
    const icon = getOptimizationIcon(opt.type);
    const priority = opt.priority || 'low';

    return `
      <div class="costs-optimization-item ${priority}" data-type="${opt.type}">
        <div class="costs-optimization-icon">${icon}</div>
        <div class="costs-optimization-content">
          <div class="costs-optimization-type">${formatOptimizationType(opt.type)}</div>
          <div class="costs-optimization-desc">${opt.description || ''}</div>
        </div>
        <div class="costs-optimization-savings">Save ${formatCurrency(opt.potentialSavings || 0)}</div>
      </div>
    `;
  }).join('');

  // Add click handlers for optimization details
  listEl.querySelectorAll('.costs-optimization-item').forEach(item => {
    item.addEventListener('click', () => {
      const type = item.dataset.type;
      showOptimizationDetails(type);
    });
  });
}

/**
 * Get icon for optimization type
 */
function getOptimizationIcon(type) {
  switch (type) {
    case 'model_downgrade': return '📉';
    case 'context_reduction': return '✂️';
    case 'caching': return '💾';
    case 'batching': return '📦';
    case 'rate_limiting': return '⏱️';
    default: return '💡';
  }
}

/**
 * Format optimization type for display
 */
function formatOptimizationType(type) {
  const types = {
    model_downgrade: 'Use Cheaper Model',
    context_reduction: 'Reduce Context Size',
    caching: 'Enable Caching',
    batching: 'Batch Requests',
    rate_limiting: 'Rate Limiting',
  };
  return types[type] || type;
}

/**
 * Format currency value
 */
function formatCurrency(value) {
  if (value === undefined || value === null) return '$0.00';
  return `$${value.toFixed(2)}`;
}

/**
 * Show budget modal
 */
function showBudgetModal() {
  costsState.budgetModalOpen = true;

  const existingModal = document.querySelector('.costs-budget-modal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.className = 'costs-budget-modal';
  modal.innerHTML = `
    <div class="costs-budget-modal-content">
      <div class="costs-budget-modal-header">
        <h4>Set Budget Limits</h4>
        <button class="costs-modal-close costs-btn">✕</button>
      </div>
      <div class="costs-budget-modal-body">
        <div class="costs-budget-modal-group">
          <label>Daily Budget ($)</label>
          <input type="number" class="costs-budget-modal-input" id="budget-daily"
            value="${costsState.budget?.daily || 50}" min="0" step="0.01">
        </div>
        <div class="costs-budget-modal-group">
          <label>Weekly Budget ($)</label>
          <input type="number" class="costs-budget-modal-input" id="budget-weekly"
            value="${costsState.budget?.weekly || 250}" min="0" step="0.01">
        </div>
        <div class="costs-budget-modal-group">
          <label>Monthly Budget ($)</label>
          <input type="number" class="costs-budget-modal-input" id="budget-monthly"
            value="${costsState.budget?.monthly || 1000}" min="0" step="0.01">
        </div>
        <div class="costs-budget-modal-group">
          <label>Alert Threshold (%)</label>
          <input type="number" class="costs-budget-modal-input" id="budget-threshold"
            value="${(costsState.budget?.alertThreshold || 0.8) * 100}" min="0" max="100" step="1">
        </div>
      </div>
      <div class="costs-budget-modal-footer">
        <button class="costs-btn costs-modal-cancel">Cancel</button>
        <button class="costs-btn primary costs-modal-save">Save</button>
      </div>
    </div>
  `;

  // Event handlers
  modal.querySelector('.costs-modal-close').addEventListener('click', () => closeBudgetModal(modal));
  modal.querySelector('.costs-modal-cancel').addEventListener('click', () => closeBudgetModal(modal));
  modal.querySelector('.costs-modal-save').addEventListener('click', () => saveBudgetSettings(modal));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeBudgetModal(modal);
  });

  document.body.appendChild(modal);
}

/**
 * Close budget modal
 */
function closeBudgetModal(modal) {
  costsState.budgetModalOpen = false;
  modal.remove();
}

/**
 * Save budget settings
 */
async function saveBudgetSettings(modal) {
  const daily = parseFloat(document.getElementById('budget-daily').value) || 0;
  const weekly = parseFloat(document.getElementById('budget-weekly').value) || 0;
  const monthly = parseFloat(document.getElementById('budget-monthly').value) || 0;
  const threshold = (parseFloat(document.getElementById('budget-threshold').value) || 80) / 100;

  try {
    await window.electronAPI?.invoke('cost-set-budget', { type: 'daily', amount: daily });
    await window.electronAPI?.invoke('cost-set-budget', { type: 'weekly', amount: weekly });
    await window.electronAPI?.invoke('cost-set-budget', { type: 'monthly', amount: monthly });
    await window.electronAPI?.invoke('cost-set-budget', { type: 'alertThreshold', amount: threshold });

    costsState.budget = { daily, weekly, monthly, alertThreshold: threshold };
    closeBudgetModal(modal);
    loadCostData();
  } catch (err) {
    console.error('[CostsTab] Save budget error:', err);
  }
}

/**
 * Show history modal
 */
async function showHistoryModal() {
  costsState.historyModalOpen = true;

  const existingModal = document.querySelector('.costs-history-modal');
  if (existingModal) existingModal.remove();

  // Load history
  let history = [];
  try {
    const res = await window.electronAPI?.invoke('cost-get-history', { limit: 100 });
    if (res?.success) {
      history = res.history || [];
    }
  } catch (err) {
    console.error('[CostsTab] Load history error:', err);
  }

  const modal = document.createElement('div');
  modal.className = 'costs-history-modal';
  modal.innerHTML = `
    <div class="costs-history-modal-content">
      <div class="costs-history-modal-header">
        <h4>Cost History (${history.length} records)</h4>
        <button class="costs-modal-close costs-btn">✕</button>
      </div>
      <div class="costs-history-list">
        ${history.length === 0 ? '<div class="costs-empty"><p>No cost history</p></div>' :
          history.map(item => `
            <div class="costs-history-item">
              <span class="costs-history-time">${formatTime(item.timestamp)}</span>
              <span class="costs-history-desc">${item.model || 'Unknown'} - ${item.inputTokens || 0} in / ${item.outputTokens || 0} out</span>
              <span class="costs-history-agent">${item.agentId || 'N/A'}</span>
              <span class="costs-history-cost">${formatCurrency(item.cost)}</span>
            </div>
          `).join('')
        }
      </div>
    </div>
  `;

  // Event handlers
  modal.querySelector('.costs-modal-close').addEventListener('click', () => closeHistoryModal(modal));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeHistoryModal(modal);
  });

  document.body.appendChild(modal);
}

/**
 * Close history modal
 */
function closeHistoryModal(modal) {
  costsState.historyModalOpen = false;
  modal.remove();
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Load cost alerts
 */
async function loadCostAlerts() {
  try {
    const res = await window.electronAPI?.invoke('cost-get-alerts');
    if (res?.success) {
      costsState.alerts = res.alerts || [];
      renderAlerts(res.alerts);
    }
  } catch (err) {
    console.error('[CostsTab] Load alerts error:', err);
  }
}

/**
 * Render alerts section
 */
function renderAlerts(alerts) {
  let alertsContainer = document.querySelector('.costs-alerts');

  if (!alerts || alerts.length === 0) {
    if (alertsContainer) alertsContainer.innerHTML = '';
    return;
  }

  if (!alertsContainer) {
    // Create alerts container if it doesn't exist
    const container = document.querySelector('.costs-container');
    if (!container) return;

    alertsContainer = document.createElement('div');
    alertsContainer.className = 'costs-alerts';
    container.insertBefore(alertsContainer, container.firstChild.nextSibling);
  }

  alertsContainer.innerHTML = alerts.map(alert => `
    <div class="costs-alert" data-id="${alert.id}">
      <span class="costs-alert-icon">⚠️</span>
      <div class="costs-alert-content">
        <div class="costs-alert-title">${alert.type || 'Alert'}</div>
        <div class="costs-alert-desc">${alert.message || ''}</div>
      </div>
      <button class="costs-alert-dismiss">✕</button>
    </div>
  `).join('');

  // Add dismiss handlers
  alertsContainer.querySelectorAll('.costs-alert-dismiss').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.electronAPI?.invoke('cost-clear-alerts');
      loadCostAlerts();
    });
  });
}

/**
 * Show a single cost alert (real-time notification)
 */
function showCostAlert(alert) {
  console.log('[CostsTab] Showing alert:', alert);

  // Add to state
  costsState.alerts = [...costsState.alerts, alert];
  renderAlerts(costsState.alerts);

  // Also show as toast notification if available
  if (window.showToast) {
    window.showToast(`Cost Alert: ${alert.message}`, 'warning');
  }
}

/**
 * Reset all cost data
 */
async function resetCostData() {
  try {
    const res = await window.electronAPI?.invoke('cost-reset');
    if (res?.success) {
      costsState.summary = null;
      costsState.agents = [];
      costsState.predictions = null;
      costsState.optimizations = [];
      costsState.alerts = [];
      costsState.history = [];

      loadCostData();
      console.log('[CostsTab] Cost data reset');
    }
  } catch (err) {
    console.error('[CostsTab] Reset error:', err);
  }
}

/**
 * Show agent cost details (placeholder for drill-down)
 */
function showAgentCostDetails(agentId) {
  console.log('[CostsTab] Show details for agent:', agentId);
  // Future: Open detailed view for specific agent
}

/**
 * Show optimization details (placeholder for drill-down)
 */
function showOptimizationDetails(type) {
  console.log('[CostsTab] Show optimization details:', type);
  // Future: Open detailed simulation for optimization
}

/**
 * Record a cost event (called from other modules)
 */
async function recordCost(data) {
  try {
    const res = await window.electronAPI?.invoke('cost-record', data);
    return res?.success;
  } catch (err) {
    console.error('[CostsTab] Record cost error:', err);
    return false;
  }
}

/**
 * Get current costs state
 */
function getCostsState() {
  return {
    summary: costsState.summary,
    budget: costsState.budget,
    isLoading: costsState.isLoading,
    alertCount: costsState.alerts.length,
  };
}

/* ================================================
   SECURITY TAB - Task #25
   Authentication, encryption, and access control
   ================================================ */

// Security tab state
const securityState = {
  status: null,
  credentials: [],
  sessions: [],
  auditLog: [],
  roles: {},
  isLoading: false,
};

/**
 * Setup the Security tab UI and event handlers
 */
function setupSecurityTab() {
  console.log('[SecurityTab] Setting up security tab');

  // Tab button
  const secTabBtn = document.querySelector('[data-tab="security"]');
  if (secTabBtn) {
    secTabBtn.addEventListener('click', () => {
      switchTab('security');
      loadSecurityData();
    });
  }

  // Refresh button
  const refreshBtn = document.getElementById('secRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadSecurityData());
  }

  // Add credential button
  const addCredBtn = document.getElementById('secAddCredentialBtn');
  if (addCredBtn) {
    addCredBtn.addEventListener('click', () => showAddCredentialModal());
  }

  // Revoke all sessions button
  const revokeAllBtn = document.getElementById('secRevokeAllBtn');
  if (revokeAllBtn) {
    revokeAllBtn.addEventListener('click', () => {
      if (confirm('Revoke all active sessions? Users will need to re-authenticate.')) {
        revokeAllSessions();
      }
    });
  }

  // View audit log button
  const viewAuditBtn = document.getElementById('secViewAuditBtn');
  if (viewAuditBtn) {
    viewAuditBtn.addEventListener('click', () => showAuditLogModal());
  }

  // Encrypt button
  const encryptBtn = document.getElementById('secEncryptBtn');
  if (encryptBtn) {
    encryptBtn.addEventListener('click', () => showEncryptModal());
  }

  // Create session button
  const createSessionBtn = document.getElementById('secCreateSessionBtn');
  if (createSessionBtn) {
    createSessionBtn.addEventListener('click', () => showCreateSessionModal());
  }

  // Cleanup button
  const cleanupBtn = document.getElementById('secCleanupBtn');
  if (cleanupBtn) {
    cleanupBtn.addEventListener('click', () => runSecurityCleanup());
  }

  // Listen for security events
  if (window.electronAPI) {
    window.electronAPI.receive('security-session-created', () => loadSecurityData());
    window.electronAPI.receive('security-session-invalidated', () => loadSecurityData());
  }

  console.log('[SecurityTab] Setup complete');
}

/**
 * Load all security data
 */
async function loadSecurityData() {
  if (securityState.isLoading) return;

  const loadingEl = document.getElementById('securityLoading');
  if (loadingEl) loadingEl.classList.remove('hidden');
  securityState.isLoading = true;

  try {
    const [statusRes, credsRes, rolesRes, auditRes] = await Promise.all([
      window.electronAPI?.invoke('security-get-status'),
      window.electronAPI?.invoke('security-list-credentials'),
      window.electronAPI?.invoke('security-get-roles'),
      window.electronAPI?.invoke('security-get-audit-log', { limit: 20 }),
    ]);

    if (statusRes?.success) {
      securityState.status = statusRes.status;
      renderSecurityStatus(statusRes.status);
    }

    if (credsRes?.success) {
      securityState.credentials = credsRes.credentials || [];
      renderCredentialsList(credsRes.credentials);
    }

    if (rolesRes?.success) {
      securityState.roles = rolesRes.roles;
      renderRolesList(rolesRes.roles);
    }

    if (auditRes?.success) {
      securityState.auditLog = auditRes.entries || [];
      renderAuditLog(auditRes.entries);
    }
  } catch (err) {
    console.error('[SecurityTab] Load error:', err);
  } finally {
    securityState.isLoading = false;
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

/**
 * Render security status header
 */
function renderSecurityStatus(status) {
  if (!status) return;

  const sessionsEl = document.getElementById('secActiveSessionsCount');
  const credsEl = document.getElementById('secCredentialsCount');
  const auditEl = document.getElementById('secAuditCount');

  if (sessionsEl) sessionsEl.textContent = status.sessionCount || 0;
  if (credsEl) credsEl.textContent = status.credentialCount || 0;
  if (auditEl) auditEl.textContent = status.auditLogCount || 0;

  const indicator = document.getElementById('securityIndicator');
  if (indicator) {
    indicator.classList.remove('secure', 'warning', 'danger');
    indicator.classList.add('secure');
    indicator.querySelector('.security-label').textContent = 'Secure';
  }
}

/**
 * Render credentials list
 */
function renderCredentialsList(credentials) {
  const listEl = document.getElementById('secCredentialsList');
  if (!listEl) return;

  if (!credentials || credentials.length === 0) {
    listEl.innerHTML = '<div class="security-empty">No credentials stored</div>';
    return;
  }

  listEl.innerHTML = credentials.map(cred => `
    <div class="security-credential-item" data-key="${cred.key}">
      <div class="security-credential-info">
        <div class="security-credential-key">${cred.key}</div>
        <div class="security-credential-meta">Added ${formatSecurityTime(cred.metadata?.createdAt)}</div>
      </div>
      <div class="security-credential-actions">
        <button class="security-credential-btn sec-copy-btn" title="Copy">Copy</button>
        <button class="security-credential-btn danger sec-delete-btn" title="Delete">Delete</button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.sec-copy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.target.closest('.security-credential-item').dataset.key;
      await copyCredential(key);
    });
  });

  listEl.querySelectorAll('.sec-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = e.target.closest('.security-credential-item').dataset.key;
      if (confirm(`Delete credential "${key}"?`)) {
        await deleteCredential(key);
      }
    });
  });
}

/**
 * Render roles list
 */
function renderRolesList(roles) {
  const listEl = document.getElementById('secRolesList');
  if (!listEl) return;

  const roleEntries = Object.entries(roles || {});
  if (roleEntries.length === 0) return;

  listEl.innerHTML = roleEntries.map(([id, role]) => `
    <div class="security-role-item">
      <span class="security-role-name">${id}</span>
      <span class="security-role-desc">${role.name}</span>
    </div>
  `).join('');
}

/**
 * Render audit log
 */
function renderAuditLog(entries) {
  const listEl = document.getElementById('secAuditList');
  if (!listEl) return;

  if (!entries || entries.length === 0) {
    listEl.innerHTML = '<div class="security-empty">No recent events</div>';
    return;
  }

  listEl.innerHTML = entries.slice(0, 10).map(entry => {
    const actionClass = getAuditActionClass(entry.action);
    return `
      <div class="security-audit-item">
        <span class="security-audit-time">${formatSecurityTime(entry.timestamp)}</span>
        <span class="security-audit-action ${actionClass}">${entry.action}</span>
        <span class="security-audit-details">${formatAuditDetails(entry.details)}</span>
      </div>
    `;
  }).join('');
}

function getAuditActionClass(action) {
  if (action.includes('create') || action.includes('store')) return 'create';
  if (action.includes('delete') || action.includes('invalidate')) return 'delete';
  if (action.includes('access') || action.includes('validate')) return 'access';
  return '';
}

function formatAuditDetails(details) {
  if (!details) return '';
  if (details.key) return `key: ${details.key}`;
  if (details.userId) return `user: ${details.userId}`;
  if (details.sessionId) return `session: ${details.sessionId.slice(0, 8)}...`;
  return JSON.stringify(details).slice(0, 50);
}

function formatSecurityTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Show add credential modal
 */
function showAddCredentialModal() {
  const existingModal = document.querySelector('.security-modal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.className = 'security-modal';
  modal.innerHTML = `
    <div class="security-modal-content">
      <div class="security-modal-header">
        <h4>Add Credential</h4>
        <button class="btn btn-sm sec-modal-close">✕</button>
      </div>
      <div class="security-modal-body">
        <div class="security-modal-group">
          <label>Key / Name</label>
          <input type="text" class="security-modal-input" id="secCredKey" placeholder="e.g., ANTHROPIC_API_KEY">
        </div>
        <div class="security-modal-group">
          <label>Value (will be encrypted)</label>
          <input type="password" class="security-modal-input" id="secCredValue" placeholder="Secret value">
        </div>
      </div>
      <div class="security-modal-footer">
        <button class="btn sec-modal-cancel">Cancel</button>
        <button class="btn btn-primary sec-modal-save">Save</button>
      </div>
    </div>
  `;

  modal.querySelector('.sec-modal-close').addEventListener('click', () => modal.remove());
  modal.querySelector('.sec-modal-cancel').addEventListener('click', () => modal.remove());
  modal.querySelector('.sec-modal-save').addEventListener('click', async () => {
    const key = document.getElementById('secCredKey').value.trim();
    const value = document.getElementById('secCredValue').value;
    if (!key || !value) { alert('Key and value required'); return; }
    await storeCredential(key, value, {});
    modal.remove();
    loadSecurityData();
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function storeCredential(key, value, metadata = {}) {
  try {
    await window.electronAPI?.invoke('security-store-credential', { key, value, metadata });
  } catch (err) {
    console.error('[SecurityTab] Store credential error:', err);
  }
}

async function copyCredential(key) {
  try {
    const res = await window.electronAPI?.invoke('security-get-credential', { key });
    if (res?.success && res.value) {
      await navigator.clipboard.writeText(res.value);
    }
  } catch (err) {
    console.error('[SecurityTab] Copy error:', err);
  }
}

async function deleteCredential(key) {
  try {
    await window.electronAPI?.invoke('security-delete-credential', { key });
    loadSecurityData();
  } catch (err) {
    console.error('[SecurityTab] Delete error:', err);
  }
}

function revokeAllSessions() {
  console.log('[SecurityTab] Revoke all sessions - not implemented');
}

async function showAuditLogModal() {
  let entries = [];
  try {
    const res = await window.electronAPI?.invoke('security-get-audit-log', { limit: 100 });
    if (res?.success) entries = res.entries || [];
  } catch (err) { console.error('[SecurityTab] Audit error:', err); }

  const existingModal = document.querySelector('.security-modal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.className = 'security-modal';
  modal.innerHTML = `
    <div class="security-modal-content" style="width: 600px;">
      <div class="security-modal-header">
        <h4>Security Audit Log (${entries.length})</h4>
        <button class="btn btn-sm sec-modal-close">✕</button>
      </div>
      <div class="security-modal-body" style="max-height: 400px; overflow-y: auto;">
        ${entries.length === 0 ? '<div class="security-empty">No events</div>' :
          entries.map(e => `<div class="security-audit-item">
            <span class="security-audit-time">${formatSecurityTime(e.timestamp)}</span>
            <span class="security-audit-action ${getAuditActionClass(e.action)}">${e.action}</span>
            <span class="security-audit-details">${formatAuditDetails(e.details)}</span>
          </div>`).join('')}
      </div>
    </div>
  `;
  modal.querySelector('.sec-modal-close').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

function showEncryptModal() {
  const existingModal = document.querySelector('.security-modal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.className = 'security-modal';
  modal.innerHTML = `
    <div class="security-modal-content">
      <div class="security-modal-header">
        <h4>Encrypt / Decrypt</h4>
        <button class="btn btn-sm sec-modal-close">✕</button>
      </div>
      <div class="security-modal-body">
        <div class="security-modal-group">
          <label>Input</label>
          <textarea class="security-modal-input" id="secEncryptInput" rows="3"></textarea>
        </div>
        <div class="security-modal-group">
          <label>Output</label>
          <textarea class="security-modal-input" id="secEncryptOutput" rows="3" readonly></textarea>
        </div>
      </div>
      <div class="security-modal-footer">
        <button class="btn" id="secDoEncrypt">Encrypt</button>
        <button class="btn" id="secDoDecrypt">Decrypt</button>
        <button class="btn sec-modal-cancel">Close</button>
      </div>
    </div>
  `;

  modal.querySelector('.sec-modal-close').addEventListener('click', () => modal.remove());
  modal.querySelector('.sec-modal-cancel').addEventListener('click', () => modal.remove());
  modal.querySelector('#secDoEncrypt').addEventListener('click', async () => {
    const input = document.getElementById('secEncryptInput').value;
    if (!input) return;
    const res = await window.electronAPI?.invoke('security-encrypt', { data: input });
    if (res?.success) document.getElementById('secEncryptOutput').value = res.encrypted;
  });
  modal.querySelector('#secDoDecrypt').addEventListener('click', async () => {
    const input = document.getElementById('secEncryptInput').value;
    if (!input) return;
    const res = await window.electronAPI?.invoke('security-decrypt', { encrypted: input });
    document.getElementById('secEncryptOutput').value = res?.success ? res.decrypted : 'Error: ' + res?.error;
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

function showCreateSessionModal() {
  const existingModal = document.querySelector('.security-modal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.className = 'security-modal';
  modal.innerHTML = `
    <div class="security-modal-content">
      <div class="security-modal-header">
        <h4>Create Session</h4>
        <button class="btn btn-sm sec-modal-close">✕</button>
      </div>
      <div class="security-modal-body">
        <div class="security-modal-group">
          <label>User ID</label>
          <input type="text" class="security-modal-input" id="secSessionUser" placeholder="e.g., operator-1">
        </div>
        <div class="security-modal-group">
          <label>Role</label>
          <select class="security-modal-input" id="secSessionRole">
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
      <div class="security-modal-footer">
        <button class="btn sec-modal-cancel">Cancel</button>
        <button class="btn btn-primary sec-modal-create">Create</button>
      </div>
    </div>
  `;

  modal.querySelector('.sec-modal-close').addEventListener('click', () => modal.remove());
  modal.querySelector('.sec-modal-cancel').addEventListener('click', () => modal.remove());
  modal.querySelector('.sec-modal-create').addEventListener('click', async () => {
    const userId = document.getElementById('secSessionUser').value.trim();
    const role = document.getElementById('secSessionRole').value;
    if (!userId) { alert('User ID required'); return; }
    const res = await window.electronAPI?.invoke('security-create-session', { userId, role, ttl: 24 * 60 * 60 * 1000 });
    if (res?.success) {
      alert(`Session created!\nID: ${res.session.sessionId}\nToken: ${res.session.token}`);
      modal.remove();
      loadSecurityData();
    }
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function runSecurityCleanup() {
  try {
    await window.electronAPI?.invoke('security-cleanup');
    loadSecurityData();
  } catch (err) {
    console.error('[SecurityTab] Cleanup error:', err);
  }
}

function getSecurityState() {
  return {
    status: securityState.status,
    credentialCount: securityState.credentials.length,
    sessionCount: securityState.status?.sessionCount || 0,
    isLoading: securityState.isLoading,
  };
}

// ============================================
// DASHBOARD TAB (Task #30: Multi-Project Dashboard)
// ============================================

const dashboardState = {
  summary: null,
  projects: [],
  healthScores: {},
  activities: [],
  activeProjectId: null,
  isLoading: false,
  selectedProjects: [], // For comparison
};

/**
 * Setup Dashboard tab event handlers
 */
function setupDashboardTab() {
  console.log('[DashboardTab] Setting up dashboard tab');

  // Tab button
  const dashTabBtn = document.querySelector('[data-tab="dashboard"]');
  if (dashTabBtn) {
    dashTabBtn.addEventListener('click', () => {
      switchTab('dashboard');
      loadDashboardData();
    });
  }

  // Switch project button
  const switchBtn = document.getElementById('dashSwitchProjectBtn');
  if (switchBtn) {
    switchBtn.addEventListener('click', () => showProjectSwitchModal());
  }

  // Add project button
  const addBtn = document.getElementById('dashAddProjectBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => showAddProjectModal());
  }

  // Refresh health button
  const refreshHealthBtn = document.getElementById('dashRefreshHealthBtn');
  if (refreshHealthBtn) {
    refreshHealthBtn.addEventListener('click', () => loadHealthScores());
  }

  // Export button
  const exportBtn = document.getElementById('dashExportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => exportProjectData());
  }

  // Import button
  const importBtn = document.getElementById('dashImportBtn');
  if (importBtn) {
    importBtn.addEventListener('click', () => importProjectData());
  }

  // Compare button
  const compareBtn = document.getElementById('dashCompareBtn');
  if (compareBtn) {
    compareBtn.addEventListener('click', () => showCompareModal());
  }

  // Listen for dashboard events
  if (window.electronAPI) {
    window.electronAPI.receive('multi-project-registered', () => loadDashboardData());
    window.electronAPI.receive('multi-project-unregistered', () => loadDashboardData());
    window.electronAPI.receive('multi-project-switched', (data) => {
      dashboardState.activeProjectId = data.projectId;
      updateActiveProjectDisplay(data.project);
      loadDashboardData();
    });
    window.electronAPI.receive('multi-project-updated', () => loadDashboardData());
  }

  console.log('[DashboardTab] Setup complete');
}

/**
 * Load all dashboard data
 */
async function loadDashboardData() {
  if (dashboardState.isLoading) return;

  const loadingEl = document.getElementById('dashboardLoading');
  if (loadingEl) loadingEl.classList.remove('hidden');
  dashboardState.isLoading = true;

  try {
    const summaryRes = await window.electronAPI?.invoke('multi-project-get-summary');

    if (summaryRes?.success) {
      dashboardState.summary = summaryRes.summary;
      dashboardState.projects = [];
      dashboardState.healthScores = summaryRes.summary.healthScores || {};
      dashboardState.activities = summaryRes.summary.recentActivity || [];
      dashboardState.activeProjectId = summaryRes.summary.activeProjectId;

      // Render all sections
      renderDashboardSummary(summaryRes.summary);
      renderDashboardProjects();
      renderDashboardHealth();
      renderDashboardActivity();
    }

    // Also load projects list
    const projectsRes = await window.electronAPI?.invoke('multi-project-get-all');
    if (projectsRes?.success) {
      dashboardState.projects = projectsRes.projects || [];
      renderDashboardProjects();
    }

  } catch (err) {
    console.error('[DashboardTab] Load error:', err);
  } finally {
    dashboardState.isLoading = false;
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

/**
 * Render dashboard summary stats
 */
function renderDashboardSummary(summary) {
  const totalEl = document.getElementById('dashTotalProjects');
  const activeEl = document.getElementById('dashActiveProjects');
  const healthEl = document.getElementById('dashAvgHealth');
  const activeNameEl = document.getElementById('dashActiveProjectName');

  if (totalEl) totalEl.textContent = summary.totalProjects || 0;
  if (activeEl) activeEl.textContent = summary.statusCounts?.active || 0;

  // Calculate average health
  const healthValues = Object.values(summary.healthScores || {});
  if (healthValues.length > 0) {
    const avgHealth = Math.round(
      healthValues.reduce((sum, h) => sum + (h?.score || 0), 0) / healthValues.length
    );
    if (healthEl) healthEl.textContent = avgHealth + '%';
  }

  // Update active project display
  if (summary.activeProjectId) {
    const activeProject = dashboardState.projects.find(p => p.id === summary.activeProjectId);
    updateActiveProjectDisplay(activeProject);
  } else {
    if (activeNameEl) activeNameEl.textContent = 'None';
  }
}

/**
 * Update active project display
 */
function updateActiveProjectDisplay(project) {
  const nameEl = document.getElementById('dashActiveProjectName');
  if (nameEl) {
    nameEl.textContent = project?.name || 'None';
  }
}

/**
 * Render projects list
 */
function renderDashboardProjects() {
  const listEl = document.getElementById('dashboardProjectList');
  if (!listEl) return;

  if (dashboardState.projects.length === 0) {
    listEl.innerHTML = '<div class="dashboard-empty">No projects registered</div>';
    return;
  }

  listEl.innerHTML = dashboardState.projects.map(project => {
    const isActive = project.id === dashboardState.activeProjectId;
    const statusClass = project.status === 'paused' ? 'paused' :
                       project.status === 'archived' ? 'archived' : '';

    return `
      <div class="dashboard-project-item ${isActive ? 'active' : ''}" data-project-id="${project.id}">
        <div class="dashboard-project-status ${statusClass}"></div>
        <div class="dashboard-project-info">
          <div class="dashboard-project-name">${escapeHtml(project.name)}</div>
          <div class="dashboard-project-path">${escapeHtml(project.path || '')}</div>
        </div>
        <div class="dashboard-project-actions">
          <button class="btn btn-xs" data-action="switch" title="Switch to project">Switch</button>
          <button class="btn btn-xs" data-action="archive" title="Archive project">Archive</button>
        </div>
      </div>
    `;
  }).join('');

  // Add click handlers
  listEl.querySelectorAll('.dashboard-project-item').forEach(item => {
    const projectId = item.dataset.projectId;

    item.querySelector('[data-action="switch"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      switchToProject(projectId);
    });

    item.querySelector('[data-action="archive"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      archiveProject(projectId);
    });

    // Toggle selection for comparison
    item.addEventListener('click', () => {
      const idx = dashboardState.selectedProjects.indexOf(projectId);
      if (idx >= 0) {
        dashboardState.selectedProjects.splice(idx, 1);
        item.classList.remove('selected');
      } else {
        dashboardState.selectedProjects.push(projectId);
        item.classList.add('selected');
      }
    });
  });
}

/**
 * Render health scores list
 */
function renderDashboardHealth() {
  const listEl = document.getElementById('dashboardHealthList');
  if (!listEl) return;

  const entries = Object.entries(dashboardState.healthScores);
  if (entries.length === 0) {
    listEl.innerHTML = '<div class="dashboard-empty">No health data</div>';
    return;
  }

  listEl.innerHTML = entries.map(([projectId, health]) => {
    const project = dashboardState.projects.find(p => p.id === projectId);
    const score = health?.score || 0;
    const healthClass = score >= 80 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor';

    return `
      <div class="dashboard-health-item">
        <div class="dashboard-health-name">${escapeHtml(project?.name || projectId)}</div>
        <div class="dashboard-health-bar">
          <div class="dashboard-health-fill ${healthClass}" style="width: ${score}%"></div>
        </div>
        <div class="dashboard-health-score">${score}%</div>
      </div>
    `;
  }).join('');
}

/**
 * Render recent activity list
 */
function renderDashboardActivity() {
  const listEl = document.getElementById('dashboardActivityList');
  if (!listEl) return;

  if (dashboardState.activities.length === 0) {
    listEl.innerHTML = '<div class="dashboard-empty">No recent activity</div>';
    return;
  }

  listEl.innerHTML = dashboardState.activities.slice(0, 10).map(activity => {
    const project = dashboardState.projects.find(p => p.id === activity.projectId);
    const time = formatRelativeTime(activity.timestamp);
    const typeClass = activity.type || '';

    return `
      <div class="dashboard-activity-item">
        <span class="dashboard-activity-time">${time}</span>
        <span class="dashboard-activity-project">${escapeHtml(project?.name || activity.projectId)}</span>
        <span class="dashboard-activity-type ${typeClass}">${escapeHtml(activity.type)}</span>
      </div>
    `;
  }).join('');
}

/**
 * Load health scores only
 */
async function loadHealthScores() {
  try {
    const res = await window.electronAPI?.invoke('multi-project-get-all-health');
    if (res?.success) {
      dashboardState.healthScores = res.healthScores;
      renderDashboardHealth();
    }
  } catch (err) {
    console.error('[DashboardTab] Load health error:', err);
  }
}

/**
 * Switch to a project
 */
async function switchToProject(projectId) {
  try {
    const res = await window.electronAPI?.invoke('multi-project-switch', projectId);
    if (res?.success) {
      dashboardState.activeProjectId = projectId;
      loadDashboardData();
    } else {
      alert('Failed to switch project: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[DashboardTab] Switch error:', err);
    alert('Failed to switch project');
  }
}

/**
 * Archive a project
 */
async function archiveProject(projectId) {
  if (!confirm('Archive this project? You can restore it later.')) return;

  try {
    const res = await window.electronAPI?.invoke('multi-project-archive', projectId);
    if (res?.success) {
      loadDashboardData();
    } else {
      alert('Failed to archive project: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[DashboardTab] Archive error:', err);
    alert('Failed to archive project');
  }
}

/**
 * Show add project modal
 */
async function showAddProjectModal() {
  // Use the existing project picker for now
  try {
    const res = await window.electronAPI?.invoke('select-project');
    if (res?.success) {
      // Register the project
      const projectId = 'proj-' + Date.now();
      await window.electronAPI?.invoke('multi-project-register', {
        id: projectId,
        name: res.name,
        projectPath: res.path,
      });
      loadDashboardData();
    }
  } catch (err) {
    console.error('[DashboardTab] Add project error:', err);
  }
}

/**
 * Show project switch modal (project list)
 */
function showProjectSwitchModal() {
  // For now, just load and let user click in the list
  loadDashboardData();
}

/**
 * Export project data
 */
async function exportProjectData() {
  if (dashboardState.selectedProjects.length === 0) {
    alert('Select a project to export');
    return;
  }

  try {
    const projectId = dashboardState.selectedProjects[0];
    const res = await window.electronAPI?.invoke('multi-project-export', projectId);
    if (res?.success) {
      alert('Project exported to: ' + res.filePath);
    } else if (!res?.canceled) {
      alert('Export failed: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[DashboardTab] Export error:', err);
    alert('Export failed');
  }
}

/**
 * Import project data
 */
async function importProjectData() {
  try {
    const res = await window.electronAPI?.invoke('multi-project-import');
    if (res?.success) {
      loadDashboardData();
      alert('Project imported: ' + res.project.name);
    } else if (!res?.canceled) {
      alert('Import failed: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[DashboardTab] Import error:', err);
    alert('Import failed');
  }
}

/**
 * Show compare modal
 */
async function showCompareModal() {
  if (dashboardState.selectedProjects.length < 2) {
    alert('Select at least 2 projects to compare');
    return;
  }

  try {
    const res = await window.electronAPI?.invoke('multi-project-compare', dashboardState.selectedProjects);
    if (res?.success) {
      // Show comparison in a modal or alert for now
      console.log('[DashboardTab] Comparison:', res.comparison);
      alert('Comparison complete. Check console for details.');
    } else {
      alert('Compare failed: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[DashboardTab] Compare error:', err);
    alert('Compare failed');
  }
}

/**
 * Format relative time
 */
function formatRelativeTime(timestamp) {
  if (!timestamp) return '--';
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
  return Math.floor(diff / 86400000) + 'd';
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Get current dashboard state
 */
function getDashboardState() {
  return {
    projectCount: dashboardState.projects.length,
    activeProjectId: dashboardState.activeProjectId,
    selectedCount: dashboardState.selectedProjects.length,
    isLoading: dashboardState.isLoading,
  };
}

// ============================================
// SCAFFOLD TAB (Task #12: Project Templates and Scaffolding)
// ============================================

const scaffoldState = {
  templates: [],
  selectedTemplate: null,
  selectedCategory: 'all',
  targetPath: null,
  isLoading: false,
};

/**
 * Setup Scaffold tab event handlers
 */
function setupScaffoldTab() {
  console.log('[ScaffoldTab] Setting up scaffold tab');

  // Tab button
  const scaffoldTabBtn = document.querySelector('[data-tab="scaffold"]');
  if (scaffoldTabBtn) {
    scaffoldTabBtn.addEventListener('click', () => {
      switchTab('scaffold');
      loadScaffoldTemplates();
    });
  }

  // Category buttons
  const categoriesEl = document.getElementById('scaffoldCategories');
  if (categoriesEl) {
    categoriesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.scaffold-category');
      if (!btn) return;

      const category = btn.dataset.category;
      scaffoldState.selectedCategory = category;

      // Update active state
      categoriesEl.querySelectorAll('.scaffold-category').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Filter templates
      renderScaffoldTemplates();
    });
  }

  // Browse button
  const browseBtn = document.getElementById('scaffoldBrowseBtn');
  if (browseBtn) {
    browseBtn.addEventListener('click', () => selectScaffoldFolder());
  }

  // Location input click
  const locationInput = document.getElementById('scaffoldLocation');
  if (locationInput) {
    locationInput.addEventListener('click', () => selectScaffoldFolder());
  }

  // Create button
  const createBtn = document.getElementById('scaffoldCreateBtn');
  if (createBtn) {
    createBtn.addEventListener('click', () => createScaffoldProject());
  }

  // Import button
  const importBtn = document.getElementById('scaffoldImportBtn');
  if (importBtn) {
    importBtn.addEventListener('click', () => importScaffoldTemplate());
  }

  // Preview close button
  const previewCloseBtn = document.getElementById('scaffoldPreviewClose');
  if (previewCloseBtn) {
    previewCloseBtn.addEventListener('click', () => {
      const previewEl = document.getElementById('scaffoldPreview');
      if (previewEl) previewEl.classList.add('hidden');
      scaffoldState.selectedTemplate = null;
      renderScaffoldTemplates();
      updateScaffoldCreateButton();
    });
  }

  // Listen for events
  if (window.electronAPI) {
    window.electronAPI.receive('scaffolding-project-created', (data) => {
      showScaffoldSuccess(data.path);
      loadScaffoldTemplates();
    });
    window.electronAPI.receive('scaffolding-template-imported', () => {
      loadScaffoldTemplates();
    });
  }

  console.log('[ScaffoldTab] Setup complete');
}

/**
 * Load scaffold templates
 */
async function loadScaffoldTemplates() {
  try {
    const res = await window.electronAPI?.invoke('scaffolding-get-templates');
    if (res?.success) {
      scaffoldState.templates = res.templates || [];
      renderScaffoldTemplates();
    }
  } catch (err) {
    console.error('[ScaffoldTab] Load templates error:', err);
  }
}

/**
 * Render scaffold templates
 */
function renderScaffoldTemplates() {
  const listEl = document.getElementById('scaffoldTemplateList');
  if (!listEl) return;

  let templates = scaffoldState.templates;

  // Filter by category
  if (scaffoldState.selectedCategory !== 'all') {
    templates = templates.filter(t => t.category === scaffoldState.selectedCategory);
  }

  if (templates.length === 0) {
    listEl.innerHTML = '<div class="scaffold-empty">No templates in this category</div>';
    return;
  }

  const iconMap = {
    nodejs: '🟢',
    python: '🐍',
    frontend: '⚛️',
    desktop: '🖥️',
    hivemind: '🐝',
    infrastructure: '📦',
    basic: '📁',
    custom: '⭐',
  };

  listEl.innerHTML = templates.map(template => {
    const isSelected = scaffoldState.selectedTemplate === template.id;
    const icon = iconMap[template.category] || '📄';
    const badgeClass = template.source === 'builtin' ? 'builtin' : 'custom';

    return `
      <div class="scaffold-template-item ${isSelected ? 'selected' : ''}" data-template-id="${template.id}">
        <div class="scaffold-template-icon ${template.category || ''}">${icon}</div>
        <div class="scaffold-template-info">
          <div class="scaffold-template-name">${escapeHtml(template.name)}</div>
          <div class="scaffold-template-desc">${escapeHtml(template.description || '')}</div>
        </div>
        <span class="scaffold-template-badge ${badgeClass}">${template.source}</span>
      </div>
    `;
  }).join('');

  // Add click handlers
  listEl.querySelectorAll('.scaffold-template-item').forEach(item => {
    item.addEventListener('click', () => {
      const templateId = item.dataset.templateId;
      selectScaffoldTemplate(templateId);
    });
  });
}

/**
 * Select a template
 */
async function selectScaffoldTemplate(templateId) {
  scaffoldState.selectedTemplate = templateId;

  // Update selection UI
  const listEl = document.getElementById('scaffoldTemplateList');
  if (listEl) {
    listEl.querySelectorAll('.scaffold-template-item').forEach(item => {
      item.classList.toggle('selected', item.dataset.templateId === templateId);
    });
  }

  // Load preview
  try {
    const res = await window.electronAPI?.invoke('scaffolding-preview', templateId);
    if (res?.success) {
      showScaffoldPreview(res);
    }
  } catch (err) {
    console.error('[ScaffoldTab] Preview error:', err);
  }

  updateScaffoldCreateButton();
}

/**
 * Show template preview
 */
function showScaffoldPreview(preview) {
  const previewEl = document.getElementById('scaffoldPreview');
  const nameEl = document.getElementById('scaffoldPreviewName');
  const descEl = document.getElementById('scaffoldPreviewDesc');
  const dirsEl = document.getElementById('scaffoldPreviewDirs');
  const filesEl = document.getElementById('scaffoldPreviewFiles');

  if (!previewEl) return;

  if (nameEl) nameEl.textContent = preview.template?.name || 'Template';
  if (descEl) descEl.textContent = preview.template?.description || '';

  if (dirsEl) {
    dirsEl.innerHTML = (preview.directories || []).slice(0, 8)
      .map(d => `<span>${escapeHtml(d)}</span>`).join('');
    if (preview.directories?.length > 8) {
      dirsEl.innerHTML += `<span>... +${preview.directories.length - 8} more</span>`;
    }
  }

  if (filesEl) {
    filesEl.innerHTML = (preview.files || []).slice(0, 8)
      .map(f => `<span>${escapeHtml(f)}</span>`).join('');
    if (preview.files?.length > 8) {
      filesEl.innerHTML += `<span>... +${preview.files.length - 8} more</span>`;
    }
  }

  previewEl.classList.remove('hidden');
}

/**
 * Select folder for project
 */
async function selectScaffoldFolder() {
  try {
    const projectName = document.getElementById('scaffoldProjectName')?.value?.trim();
    const res = await window.electronAPI?.invoke('scaffolding-select-folder', {
      projectName: projectName || undefined,
    });

    if (res?.success) {
      scaffoldState.targetPath = res.path;
      const locationInput = document.getElementById('scaffoldLocation');
      if (locationInput) locationInput.value = res.path;
      updateScaffoldCreateButton();
    }
  } catch (err) {
    console.error('[ScaffoldTab] Select folder error:', err);
  }
}

/**
 * Update create button state
 */
function updateScaffoldCreateButton() {
  const createBtn = document.getElementById('scaffoldCreateBtn');
  if (!createBtn) return;

  const hasTemplate = !!scaffoldState.selectedTemplate;
  const hasPath = !!scaffoldState.targetPath;
  const hasName = !!document.getElementById('scaffoldProjectName')?.value?.trim();

  createBtn.disabled = !(hasTemplate && hasPath);
}

/**
 * Create project from template
 */
async function createScaffoldProject() {
  const templateId = scaffoldState.selectedTemplate;
  const targetPath = scaffoldState.targetPath;
  const projectName = document.getElementById('scaffoldProjectName')?.value?.trim();
  const projectDesc = document.getElementById('scaffoldProjectDesc')?.value?.trim();

  if (!templateId || !targetPath) {
    alert('Please select a template and location');
    return;
  }

  const loadingEl = document.getElementById('scaffoldLoading');
  if (loadingEl) loadingEl.classList.remove('hidden');
  scaffoldState.isLoading = true;

  try {
    const res = await window.electronAPI?.invoke('scaffolding-create', {
      targetPath,
      templateId,
      variables: {
        projectName: projectName || require('path').basename(targetPath),
        description: projectDesc || '',
        author: '',
      },
    });

    if (res?.success) {
      showScaffoldSuccess(res.path);
      // Reset form
      document.getElementById('scaffoldProjectName').value = '';
      document.getElementById('scaffoldProjectDesc').value = '';
      document.getElementById('scaffoldLocation').value = '';
      scaffoldState.targetPath = null;
      updateScaffoldCreateButton();
    } else {
      alert('Failed to create project: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[ScaffoldTab] Create error:', err);
    alert('Failed to create project');
  } finally {
    scaffoldState.isLoading = false;
    if (loadingEl) loadingEl.classList.add('hidden');
  }
}

/**
 * Show success message
 */
function showScaffoldSuccess(projectPath) {
  alert(`Project created successfully at:\n${projectPath}`);
}

/**
 * Import custom template
 */
async function importScaffoldTemplate() {
  try {
    const res = await window.electronAPI?.invoke('scaffolding-import-template');
    if (res?.success) {
      loadScaffoldTemplates();
      alert('Template imported successfully');
    } else if (!res?.canceled) {
      alert('Import failed: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[ScaffoldTab] Import error:', err);
    alert('Import failed');
  }
}

/**
 * Get scaffold state
 */
function getScaffoldState() {
  return {
    templateCount: scaffoldState.templates.length,
    selectedTemplate: scaffoldState.selectedTemplate,
    selectedCategory: scaffoldState.selectedCategory,
    hasTargetPath: !!scaffoldState.targetPath,
    isLoading: scaffoldState.isLoading,
  };
}

// ============================================
// DEPLOY TAB (Task #15: Automated Deployment Pipeline)
// ============================================

const deployState = {
  config: null,
  currentBuild: null,
  buildHistory: [],
  isBuilding: false,
  selectedEnvironment: 'development',
  readinessChecks: [],
  pipelineStages: [],
  outputLines: [],
};

/**
 * Setup Deploy tab event handlers
 */
function setupDeployTab() {
  console.log('[DeployTab] Setting up deploy tab');

  // Tab button
  const deployTabBtn = document.querySelector('[data-tab="deploy"]');
  if (deployTabBtn) {
    deployTabBtn.addEventListener('click', () => {
      switchTab('deploy');
      loadDeployConfig();
    });
  }

  // Environment selector
  const envSelect = document.getElementById('deployEnvironment');
  if (envSelect) {
    envSelect.addEventListener('change', (e) => {
      deployState.selectedEnvironment = e.target.value;
      checkDeployReadiness();
    });
  }

  // Check readiness button
  const checkBtn = document.getElementById('deployCheckBtn');
  if (checkBtn) {
    checkBtn.addEventListener('click', () => checkDeployReadiness());
  }

  // Start build button
  const startBtn = document.getElementById('deployStartBtn');
  if (startBtn) {
    startBtn.addEventListener('click', () => startDeployBuild());
  }

  // Cancel build button
  const cancelBtn = document.getElementById('deployCancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => cancelDeployBuild());
  }

  // Deploy to GitHub button
  const githubBtn = document.getElementById('deployGitHubBtn');
  if (githubBtn) {
    githubBtn.addEventListener('click', () => deployToGitHub());
  }

  // Clear output button
  const clearBtn = document.getElementById('deployClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => clearDeployOutput());
  }

  // Listen for build progress events
  if (window.electronAPI) {
    window.electronAPI.receive('deployment-build-progress', (data) => {
      handleDeployProgress(data);
    });
    window.electronAPI.receive('deployment-build-complete', (data) => {
      handleDeployComplete(data);
    });
    window.electronAPI.receive('deployment-build-failed', (data) => {
      handleDeployFailed(data);
    });
  }

  console.log('[DeployTab] Setup complete');
}

/**
 * Load deployment configuration
 */
async function loadDeployConfig() {
  try {
    const res = await window.electronAPI?.invoke('deployment-get-config');
    if (res?.success) {
      deployState.config = res.config;
      renderDeployConfig();
    }
  } catch (err) {
    console.error('[DeployTab] Load config error:', err);
  }

  // Also load history and check readiness
  await Promise.all([
    loadDeployHistory(),
    checkDeployReadiness(),
  ]);
}

/**
 * Render deployment configuration
 */
function renderDeployConfig() {
  const config = deployState.config;
  if (!config) return;

  // Update environment options if needed
  const envSelect = document.getElementById('deployEnvironment');
  if (envSelect && config.environments) {
    const envNames = Object.keys(config.environments);
    envSelect.innerHTML = envNames.map(env =>
      `<option value="${env}" ${env === deployState.selectedEnvironment ? 'selected' : ''}>${env}</option>`
    ).join('');
  }
}

/**
 * Check deployment readiness
 */
async function checkDeployReadiness() {
  const checksEl = document.getElementById('deployReadinessChecks');
  if (checksEl) {
    checksEl.innerHTML = '<div class="deploy-loading">Checking readiness...</div>';
  }

  try {
    const res = await window.electronAPI?.invoke('deployment-check-readiness', {
      environment: deployState.selectedEnvironment,
    });

    if (res?.success) {
      deployState.readinessChecks = res.checks || [];
      renderReadinessChecks();
      updateDeployButtons();
    }
  } catch (err) {
    console.error('[DeployTab] Readiness check error:', err);
    if (checksEl) {
      checksEl.innerHTML = '<div class="deploy-error">Failed to check readiness</div>';
    }
  }
}

/**
 * Render readiness checks
 */
function renderReadinessChecks() {
  const checksEl = document.getElementById('deployReadinessChecks');
  if (!checksEl) return;

  if (deployState.readinessChecks.length === 0) {
    checksEl.innerHTML = '<div class="deploy-empty">No checks configured</div>';
    return;
  }

  const iconMap = {
    passed: '✓',
    failed: '✗',
    warning: '⚠',
    pending: '○',
  };

  checksEl.innerHTML = deployState.readinessChecks.map(check => `
    <div class="deploy-check ${check.status}">
      <span class="deploy-check-icon">${iconMap[check.status] || '?'}</span>
      <span class="deploy-check-name">${escapeHtml(check.name)}</span>
      ${check.message ? `<span class="deploy-check-message">${escapeHtml(check.message)}</span>` : ''}
    </div>
  `).join('');
}

/**
 * Update deploy buttons based on state
 */
function updateDeployButtons() {
  const startBtn = document.getElementById('deployStartBtn');
  const cancelBtn = document.getElementById('deployCancelBtn');
  const githubBtn = document.getElementById('deployGitHubBtn');

  const allChecksPassed = deployState.readinessChecks.every(c => c.status === 'passed' || c.status === 'warning');
  const hasCurrentBuild = deployState.currentBuild && deployState.currentBuild.status === 'success';

  if (startBtn) {
    startBtn.disabled = deployState.isBuilding || !allChecksPassed;
    startBtn.textContent = deployState.isBuilding ? 'Building...' : 'Start Build';
  }

  if (cancelBtn) {
    cancelBtn.classList.toggle('hidden', !deployState.isBuilding);
  }

  if (githubBtn) {
    githubBtn.disabled = deployState.isBuilding || !hasCurrentBuild;
  }
}

/**
 * Start deployment build
 */
async function startDeployBuild() {
  if (deployState.isBuilding) return;

  deployState.isBuilding = true;
  deployState.outputLines = [];
  deployState.pipelineStages = [];
  updateDeployButtons();
  clearDeployOutput();

  // Initialize pipeline stages
  const stages = ['checkout', 'install', 'lint', 'test', 'build', 'package'];
  deployState.pipelineStages = stages.map(name => ({
    name,
    status: 'pending',
    duration: null,
  }));
  renderPipelineStages();

  addDeployOutput(`Starting ${deployState.selectedEnvironment} build...`, 'info');

  try {
    const res = await window.electronAPI?.invoke('deployment-start-build', {
      environment: deployState.selectedEnvironment,
      projectDir: deployState.config?.projectDir || process.cwd(),
    });

    if (!res?.success) {
      handleDeployFailed({ error: res?.error || 'Build failed to start' });
    }
  } catch (err) {
    console.error('[DeployTab] Start build error:', err);
    handleDeployFailed({ error: err.message });
  }
}

/**
 * Cancel deployment build
 */
async function cancelDeployBuild() {
  if (!deployState.isBuilding) return;

  try {
    await window.electronAPI?.invoke('deployment-cancel-build');
    addDeployOutput('Build cancelled by user', 'warning');
    deployState.isBuilding = false;
    updateDeployButtons();
  } catch (err) {
    console.error('[DeployTab] Cancel build error:', err);
  }
}

/**
 * Handle build progress updates
 */
function handleDeployProgress(data) {
  // Update stage status
  if (data.stage) {
    const stageIndex = deployState.pipelineStages.findIndex(s => s.name === data.stage);
    if (stageIndex >= 0) {
      deployState.pipelineStages[stageIndex].status = data.status || 'running';
      if (data.duration) {
        deployState.pipelineStages[stageIndex].duration = data.duration;
      }
      renderPipelineStages();
    }
  }

  // Add output line
  if (data.message) {
    addDeployOutput(data.message, data.type || 'info');
  }

  // Update status bar
  updateDeployStatusBar(data);
}

/**
 * Handle build completion
 */
function handleDeployComplete(data) {
  deployState.isBuilding = false;
  deployState.currentBuild = data.build;

  // Mark all stages as complete
  deployState.pipelineStages.forEach(stage => {
    if (stage.status === 'running' || stage.status === 'pending') {
      stage.status = 'success';
    }
  });
  renderPipelineStages();

  addDeployOutput(`Build completed successfully in ${formatDuration(data.duration)}`, 'success');
  updateDeployButtons();
  loadDeployHistory();
}

/**
 * Handle build failure
 */
function handleDeployFailed(data) {
  deployState.isBuilding = false;

  // Mark current stage as failed
  const runningStage = deployState.pipelineStages.find(s => s.status === 'running');
  if (runningStage) {
    runningStage.status = 'failed';
  }
  renderPipelineStages();

  addDeployOutput(`Build failed: ${data.error}`, 'error');
  updateDeployButtons();
}

/**
 * Render pipeline stages
 */
function renderPipelineStages() {
  const stagesEl = document.getElementById('deployPipelineStages');
  if (!stagesEl) return;

  const iconMap = {
    pending: '○',
    running: '◉',
    success: '✓',
    failed: '✗',
    skipped: '⊘',
  };

  stagesEl.innerHTML = deployState.pipelineStages.map(stage => `
    <div class="deploy-stage ${stage.status}">
      <span class="deploy-stage-icon">${iconMap[stage.status] || '?'}</span>
      <span class="deploy-stage-name">${stage.name}</span>
      ${stage.duration ? `<span class="deploy-stage-duration">${formatDuration(stage.duration)}</span>` : ''}
    </div>
  `).join('');
}

/**
 * Update deploy status bar
 */
function updateDeployStatusBar(data) {
  const statusEl = document.getElementById('deployStatusText');
  const progressEl = document.getElementById('deployProgressBar');

  if (statusEl) {
    statusEl.textContent = data.message || (deployState.isBuilding ? 'Building...' : 'Ready');
  }

  if (progressEl && data.progress !== undefined) {
    progressEl.style.width = `${data.progress}%`;
  }
}

/**
 * Add line to deploy output
 */
function addDeployOutput(message, type = 'info') {
  const outputEl = document.getElementById('deployOutput');
  if (!outputEl) return;

  const timestamp = new Date().toLocaleTimeString();
  const line = { timestamp, message, type };
  deployState.outputLines.push(line);

  // Limit output lines
  if (deployState.outputLines.length > 500) {
    deployState.outputLines = deployState.outputLines.slice(-500);
  }

  const lineEl = document.createElement('div');
  lineEl.className = `deploy-output-line ${type}`;
  lineEl.innerHTML = `<span class="deploy-output-time">${timestamp}</span> ${escapeHtml(message)}`;
  outputEl.appendChild(lineEl);

  // Auto-scroll to bottom
  outputEl.scrollTop = outputEl.scrollHeight;
}

/**
 * Clear deploy output
 */
function clearDeployOutput() {
  const outputEl = document.getElementById('deployOutput');
  if (outputEl) {
    outputEl.innerHTML = '';
  }
  deployState.outputLines = [];
}

/**
 * Deploy to GitHub
 */
async function deployToGitHub() {
  if (!deployState.currentBuild || deployState.isBuilding) return;

  addDeployOutput('Deploying to GitHub...', 'info');

  try {
    const res = await window.electronAPI?.invoke('deployment-deploy-github', {
      buildId: deployState.currentBuild.id,
      environment: deployState.selectedEnvironment,
    });

    if (res?.success) {
      addDeployOutput(`Deployed to GitHub: ${res.url}`, 'success');
    } else {
      addDeployOutput(`GitHub deploy failed: ${res?.error}`, 'error');
    }
  } catch (err) {
    console.error('[DeployTab] GitHub deploy error:', err);
    addDeployOutput(`GitHub deploy error: ${err.message}`, 'error');
  }
}

/**
 * Load deployment history
 */
async function loadDeployHistory() {
  try {
    const res = await window.electronAPI?.invoke('deployment-get-history', {
      limit: 20,
    });

    if (res?.success) {
      deployState.buildHistory = res.history || [];
      renderDeployHistory();
    }
  } catch (err) {
    console.error('[DeployTab] Load history error:', err);
  }
}

/**
 * Render deployment history
 */
function renderDeployHistory() {
  const historyEl = document.getElementById('deployHistory');
  if (!historyEl) return;

  if (deployState.buildHistory.length === 0) {
    historyEl.innerHTML = '<div class="deploy-empty">No build history</div>';
    return;
  }

  const statusIcons = {
    success: '✓',
    failed: '✗',
    cancelled: '⊘',
    running: '◉',
  };

  historyEl.innerHTML = deployState.buildHistory.map(build => {
    const date = new Date(build.timestamp).toLocaleString();
    const icon = statusIcons[build.status] || '?';
    const duration = build.duration ? formatDuration(build.duration) : '-';

    return `
      <div class="deploy-history-item ${build.status}" data-build-id="${build.id}">
        <span class="deploy-history-icon">${icon}</span>
        <span class="deploy-history-env">${build.environment}</span>
        <span class="deploy-history-date">${date}</span>
        <span class="deploy-history-duration">${duration}</span>
      </div>
    `;
  }).join('');
}

/**
 * Format duration in ms to human readable
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

/**
 * Get deploy state
 */
function getDeployState() {
  return {
    isBuilding: deployState.isBuilding,
    selectedEnvironment: deployState.selectedEnvironment,
    currentBuild: deployState.currentBuild,
    historyCount: deployState.buildHistory.length,
    readinessStatus: deployState.readinessChecks.every(c => c.status === 'passed') ? 'ready' : 'not-ready',
  };
}

// ============================================
// COLLAB TAB (Task #11: Real-time Collaboration)
// ============================================

const collabState = {
  session: null,
  users: [],
  chatMessages: [],
  connectionState: 'disconnected',
  isHost: false,
  unreadChat: 0,
};

/**
 * Setup Collab tab event handlers
 */
function setupCollabTab() {
  console.log('[CollabTab] Setting up collaboration tab');

  // Tab button
  const collabTabBtn = document.querySelector('[data-tab="collab"]');
  if (collabTabBtn) {
    collabTabBtn.addEventListener('click', () => {
      switchTab('collab');
      loadCollabState();
      collabState.unreadChat = 0;
      updateCollabChatBadge();
    });
  }

  // Create session button
  const createBtn = document.getElementById('collabCreateBtn');
  if (createBtn) {
    createBtn.addEventListener('click', () => createCollabSession());
  }

  // Join session button
  const joinBtn = document.getElementById('collabJoinBtn');
  if (joinBtn) {
    joinBtn.addEventListener('click', () => joinCollabSession());
  }

  // Leave session button
  const leaveBtn = document.getElementById('collabLeaveBtn');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', () => leaveCollabSession());
  }

  // Copy invite link button
  const copyLinkBtn = document.getElementById('collabCopyLinkBtn');
  if (copyLinkBtn) {
    copyLinkBtn.addEventListener('click', () => copyCollabInviteLink());
  }

  // Copy invite code button
  const copyCodeBtn = document.getElementById('collabCopyCodeBtn');
  if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', () => copyCollabInviteCode());
  }

  // Send chat button
  const sendBtn = document.getElementById('collabSendBtn');
  if (sendBtn) {
    sendBtn.addEventListener('click', () => sendCollabChat());
  }

  // Chat input enter key
  const chatInput = document.getElementById('collabChatInput');
  if (chatInput) {
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendCollabChat();
      }
    });
  }

  // Update profile button
  const updateProfileBtn = document.getElementById('collabUpdateProfileBtn');
  if (updateProfileBtn) {
    updateProfileBtn.addEventListener('click', () => updateCollabProfile());
  }

  // Save settings button
  const saveSettingsBtn = document.getElementById('collabSaveSettingsBtn');
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', () => saveCollabSettings());
  }

  // Listen for collaboration events from main process
  if (window.electronAPI) {
    window.electronAPI.receive('collab-session-created', handleCollabSessionCreated);
    window.electronAPI.receive('collab-session-joined', handleCollabSessionJoined);
    window.electronAPI.receive('collab-session-left', handleCollabSessionLeft);
    window.electronAPI.receive('collab-session-ended', handleCollabSessionEnded);
    window.electronAPI.receive('collab-user-joined', handleCollabUserJoined);
    window.electronAPI.receive('collab-user-left', handleCollabUserLeft);
    window.electronAPI.receive('collab-user-kicked', handleCollabUserKicked);
    window.electronAPI.receive('collab-chat-message', handleCollabChatMessage);
    window.electronAPI.receive('collab-connection-state', handleCollabConnectionState);
    window.electronAPI.receive('collab-cursor-update', handleCollabCursorUpdate);
    window.electronAPI.receive('collab-terminal-sync', handleCollabTerminalSync);
  }

  console.log('[CollabTab] Setup complete');
}

/**
 * Load current collaboration state
 */
async function loadCollabState() {
  try {
    const res = await window.electronAPI?.invoke('collab-get-state');
    if (res?.success && res.state) {
      collabState.session = res.state.session;
      collabState.users = res.state.users || [];
      collabState.connectionState = res.state.connectionState;
      collabState.isHost = res.state.isHost;
      renderCollabUI();
    }
  } catch (err) {
    console.error('[CollabTab] Load state error:', err);
  }
}

/**
 * Create a new collaboration session
 */
async function createCollabSession() {
  const nameInput = document.getElementById('collabSessionName');
  const portInput = document.getElementById('collabPort');
  const allowEditCheck = document.getElementById('collabAllowEdit');
  const allowChatCheck = document.getElementById('collabAllowChat');
  const syncTerminalsCheck = document.getElementById('collabSyncTerminals');

  const payload = {
    name: nameInput?.value || 'Hivemind Session',
    port: parseInt(portInput?.value) || 9876,
    allowEditing: allowEditCheck?.checked !== false,
    allowChat: allowChatCheck?.checked !== false,
    syncTerminals: syncTerminalsCheck?.checked !== false,
  };

  try {
    const res = await window.electronAPI?.invoke('collab-create-session', payload);
    if (res?.success) {
      console.log('[CollabTab] Session created:', res.session);
    } else {
      alert('Failed to create session: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[CollabTab] Create session error:', err);
    alert('Failed to create session');
  }
}

/**
 * Join an existing session
 */
async function joinCollabSession() {
  const hostInput = document.getElementById('collabJoinHost');
  const portInput = document.getElementById('collabJoinPort');
  const codeInput = document.getElementById('collabJoinCode');

  const payload = {
    host: hostInput?.value || 'localhost',
    port: parseInt(portInput?.value) || 9876,
    inviteCode: codeInput?.value || undefined,
  };

  if (!payload.port) {
    alert('Please enter a port number');
    return;
  }

  try {
    const res = await window.electronAPI?.invoke('collab-join-session', payload);
    if (res?.success) {
      console.log('[CollabTab] Joined session:', res.session);
    } else {
      alert('Failed to join session: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('[CollabTab] Join session error:', err);
    alert('Failed to join session');
  }
}

/**
 * Leave current session
 */
async function leaveCollabSession() {
  try {
    const res = await window.electronAPI?.invoke('collab-leave-session');
    if (res?.success) {
      console.log('[CollabTab] Left session');
    }
  } catch (err) {
    console.error('[CollabTab] Leave session error:', err);
  }
}

/**
 * Copy invite link to clipboard
 */
async function copyCollabInviteLink() {
  const linkInput = document.getElementById('collabInviteLink');
  if (linkInput?.value) {
    try {
      await navigator.clipboard.writeText(linkInput.value);
      const btn = document.getElementById('collabCopyLinkBtn');
      if (btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = originalText; }, 1500);
      }
    } catch (err) {
      console.error('[CollabTab] Copy link error:', err);
    }
  }
}

/**
 * Copy invite code to clipboard
 */
async function copyCollabInviteCode() {
  const codeEl = document.getElementById('collabInviteCode');
  if (codeEl?.textContent) {
    try {
      await navigator.clipboard.writeText(codeEl.textContent);
      const btn = document.getElementById('collabCopyCodeBtn');
      if (btn) {
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = originalText; }, 1500);
      }
    } catch (err) {
      console.error('[CollabTab] Copy code error:', err);
    }
  }
}

/**
 * Send chat message
 */
async function sendCollabChat() {
  const chatInput = document.getElementById('collabChatInput');
  const text = chatInput?.value?.trim();
  if (!text) return;

  try {
    await window.electronAPI?.invoke('collab-send-chat', { text });
    chatInput.value = '';
  } catch (err) {
    console.error('[CollabTab] Send chat error:', err);
  }
}

/**
 * Update user profile
 */
async function updateCollabProfile() {
  const nameInput = document.getElementById('collabUserName');
  const colorInput = document.getElementById('collabUserColor');

  try {
    await window.electronAPI?.invoke('collab-update-profile', {
      name: nameInput?.value,
      color: colorInput?.value,
    });
  } catch (err) {
    console.error('[CollabTab] Update profile error:', err);
  }
}

/**
 * Save session settings (host only)
 */
async function saveCollabSettings() {
  const allowEdit = document.getElementById('collabSettingEdit')?.checked;
  const allowChat = document.getElementById('collabSettingChat')?.checked;
  const syncTerminals = document.getElementById('collabSettingSync')?.checked;
  const syncSettings = document.getElementById('collabSettingSyncSettings')?.checked;
  const maxUsers = parseInt(document.getElementById('collabSettingMaxUsers')?.value) || 10;

  try {
    const res = await window.electronAPI?.invoke('collab-update-session-settings', {
      allowEditing: allowEdit,
      allowChat,
      syncTerminals,
      syncSettings,
      maxUsers,
    });
    if (res?.success) {
      alert('Settings saved');
    }
  } catch (err) {
    console.error('[CollabTab] Save settings error:', err);
  }
}

// Event handlers
function handleCollabSessionCreated(session) {
  collabState.session = session;
  collabState.isHost = true;
  collabState.connectionState = 'connected';
  renderCollabUI();
}

function handleCollabSessionJoined(session) {
  collabState.session = session;
  collabState.isHost = false;
  collabState.connectionState = 'connected';
  renderCollabUI();
}

function handleCollabSessionLeft() {
  collabState.session = null;
  collabState.users = [];
  collabState.chatMessages = [];
  collabState.connectionState = 'disconnected';
  collabState.isHost = false;
  renderCollabUI();
}

function handleCollabSessionEnded(data) {
  collabState.session = null;
  collabState.users = [];
  collabState.connectionState = 'disconnected';
  collabState.isHost = false;
  renderCollabUI();
  alert('Session ended: ' + (data?.reason || 'Host left'));
}

function handleCollabUserJoined(user) {
  collabState.users.push(user);
  renderCollabUsers();
}

function handleCollabUserLeft(data) {
  collabState.users = collabState.users.filter(u => u.id !== data.userId);
  renderCollabUsers();
}

function handleCollabUserKicked(data) {
  collabState.users = collabState.users.filter(u => u.id !== data.userId);
  renderCollabUsers();
}

function handleCollabChatMessage(message) {
  collabState.chatMessages.push(message);
  if (collabState.chatMessages.length > 500) {
    collabState.chatMessages = collabState.chatMessages.slice(-500);
  }
  renderCollabChat();

  // Update unread count if not on collab tab
  const collabTab = document.getElementById('tab-collab');
  if (!collabTab || !collabTab.classList.contains('active')) {
    collabState.unreadChat++;
    updateCollabChatBadge();
  }
}

function handleCollabConnectionState(data) {
  collabState.connectionState = data.state;
  updateCollabStatusBar();
}

function handleCollabCursorUpdate(data) {
  // Render remote cursor on terminal pane
  renderCollabCursor(data);
}

function handleCollabTerminalSync(data) {
  // Sync terminal output (handled by terminal module)
  console.log('[CollabTab] Terminal sync:', data.paneId);
}

/**
 * Render collaboration UI based on current state
 */
function renderCollabUI() {
  const controlsEl = document.getElementById('collabSessionControls');
  const activeEl = document.getElementById('collabActiveSession');
  const settingsEl = document.getElementById('collabSettingsSection');
  const inviteEl = document.getElementById('collabInviteSection');

  if (collabState.session) {
    // Show active session view
    if (controlsEl) controlsEl.classList.add('hidden');
    if (activeEl) activeEl.classList.remove('hidden');

    // Update session info
    const nameEl = document.getElementById('collabCurrentName');
    const roleEl = document.getElementById('collabCurrentRole');
    if (nameEl) nameEl.textContent = collabState.session.name || 'Session';
    if (roleEl) {
      roleEl.textContent = collabState.isHost ? 'Host' : 'Guest';
      roleEl.className = 'collab-session-role ' + (collabState.isHost ? 'host' : '');
    }

    // Show/hide host-only sections
    if (inviteEl) inviteEl.classList.toggle('hidden', !collabState.isHost);
    if (settingsEl) settingsEl.classList.toggle('hidden', !collabState.isHost);

    // Update invite info
    if (collabState.isHost && collabState.session.inviteLink) {
      const linkInput = document.getElementById('collabInviteLink');
      const codeEl = document.getElementById('collabInviteCode');
      if (linkInput) linkInput.value = collabState.session.inviteLink;
      if (codeEl) codeEl.textContent = collabState.session.inviteCode || '-';
    }

    // Update settings checkboxes
    if (collabState.isHost && collabState.session.settings) {
      const s = collabState.session.settings;
      const editCheck = document.getElementById('collabSettingEdit');
      const chatCheck = document.getElementById('collabSettingChat');
      const syncCheck = document.getElementById('collabSettingSync');
      const syncSettingsCheck = document.getElementById('collabSettingSyncSettings');
      const maxUsersInput = document.getElementById('collabSettingMaxUsers');

      if (editCheck) editCheck.checked = s.allowEditing;
      if (chatCheck) chatCheck.checked = s.allowChat;
      if (syncCheck) syncCheck.checked = s.syncTerminals;
      if (syncSettingsCheck) syncSettingsCheck.checked = s.syncSettings;
      if (maxUsersInput) maxUsersInput.value = s.maxUsers || 10;
    }

    renderCollabUsers();
    renderCollabChat();
  } else {
    // Show session controls
    if (controlsEl) controlsEl.classList.remove('hidden');
    if (activeEl) activeEl.classList.add('hidden');
  }

  updateCollabStatusBar();
}

/**
 * Update status bar
 */
function updateCollabStatusBar() {
  const indicatorEl = document.getElementById('collabStatusIndicator');
  const textEl = document.getElementById('collabStatusText');
  const countEl = document.getElementById('collabUserCount');

  if (indicatorEl) {
    indicatorEl.className = 'collab-status-indicator ' + collabState.connectionState;
  }

  if (textEl) {
    const stateText = {
      disconnected: 'Not connected',
      connecting: 'Connecting...',
      connected: collabState.session ? `Connected to ${collabState.session.name}` : 'Connected',
      reconnecting: 'Reconnecting...',
    };
    textEl.textContent = stateText[collabState.connectionState] || 'Unknown';
  }

  if (countEl) {
    if (collabState.session && collabState.users.length > 0) {
      countEl.textContent = `${collabState.users.length} user${collabState.users.length !== 1 ? 's' : ''}`;
      countEl.classList.remove('hidden');
    } else {
      countEl.classList.add('hidden');
    }
  }
}

/**
 * Render users list
 */
function renderCollabUsers() {
  const listEl = document.getElementById('collabUsersList');
  if (!listEl) return;

  if (collabState.users.length === 0) {
    listEl.innerHTML = '<div class="collab-users-empty">No other users</div>';
    return;
  }

  listEl.innerHTML = collabState.users.map(user => {
    const initials = (user.name || 'A').substring(0, 2).toUpperCase();
    const isHost = user.role === 'host';

    return `
      <div class="collab-user-item" data-user-id="${user.id}">
        <div class="collab-user-avatar" style="background-color: ${user.color || '#4ECDC4'}">${initials}</div>
        <span class="collab-user-name">${escapeHtml(user.name || 'Anonymous')}</span>
        <span class="collab-user-role ${isHost ? 'host' : ''}">${user.role || 'guest'}</span>
        ${collabState.isHost && !isHost ? `
          <div class="collab-user-actions">
            <button class="btn btn-xs btn-danger" onclick="kickCollabUser('${user.id}')">Kick</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

/**
 * Kick a user (host only)
 */
async function kickCollabUser(userId) {
  if (!confirm('Kick this user from the session?')) return;

  try {
    await window.electronAPI?.invoke('collab-kick-user', { userId });
  } catch (err) {
    console.error('[CollabTab] Kick user error:', err);
  }
}

/**
 * Render chat messages
 */
function renderCollabChat() {
  const messagesEl = document.getElementById('collabChatMessages');
  if (!messagesEl) return;

  if (collabState.chatMessages.length === 0) {
    messagesEl.innerHTML = '<div class="collab-chat-empty">No messages yet</div>';
    return;
  }

  messagesEl.innerHTML = collabState.chatMessages.map(msg => {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    return `
      <div class="collab-chat-message">
        <div class="collab-chat-header">
          <span class="collab-chat-author" style="color: ${msg.userColor || '#4ECDC4'}">${escapeHtml(msg.userName || 'Anonymous')}</span>
          <span class="collab-chat-time">${time}</span>
        </div>
        <div class="collab-chat-text">${escapeHtml(msg.text)}</div>
      </div>
    `;
  }).join('');

  // Auto-scroll to bottom
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Update chat badge
 */
function updateCollabChatBadge() {
  const badgeEl = document.getElementById('collabChatBadge');
  if (badgeEl) {
    if (collabState.unreadChat > 0) {
      badgeEl.textContent = collabState.unreadChat > 99 ? '99+' : collabState.unreadChat;
      badgeEl.classList.remove('hidden');
    } else {
      badgeEl.classList.add('hidden');
    }
  }
}

/**
 * Render remote cursor
 */
function renderCollabCursor(data) {
  // Find or create cursor element
  let cursorEl = document.getElementById(`collab-cursor-${data.userId}`);
  if (!cursorEl) {
    cursorEl = document.createElement('div');
    cursorEl.id = `collab-cursor-${data.userId}`;
    cursorEl.className = 'collab-cursor';
    cursorEl.innerHTML = `
      <div class="collab-cursor-dot" style="background-color: ${data.userColor}"></div>
      <div class="collab-cursor-name" style="background-color: ${data.userColor}">${escapeHtml(data.userName)}</div>
    `;
    document.body.appendChild(cursorEl);
  }

  // Position cursor
  if (data.position) {
    cursorEl.style.left = data.position.x + 'px';
    cursorEl.style.top = data.position.y + 'px';
    cursorEl.style.display = 'block';
  } else {
    cursorEl.style.display = 'none';
  }

  // Remove cursor after timeout if no updates
  clearTimeout(cursorEl._hideTimeout);
  cursorEl._hideTimeout = setTimeout(() => {
    cursorEl.style.display = 'none';
  }, 5000);
}

/**
 * Get collab state
 */
function getCollabState() {
  return {
    hasSession: !!collabState.session,
    isHost: collabState.isHost,
    userCount: collabState.users.length,
    connectionState: collabState.connectionState,
    chatCount: collabState.chatMessages.length,
    unreadChat: collabState.unreadChat,
  };
}

// ==========================================
// Task #17: Mobile Companion App
// ==========================================

/**
 * Mobile API state
 */
const mobileState = {
  isRunning: false,
  port: 8080,
  sessions: [],
  pushSubscriptions: [],
  sseClientCount: 0,
  connectionInfo: null,
};

/**
 * Setup mobile tab event handlers
 */
function setupMobileTab() {
  // Elements
  const startBtn = document.getElementById('mobileStartBtn');
  const stopBtn = document.getElementById('mobileStopBtn');
  const portInput = document.getElementById('mobilePort');
  const statusIndicator = document.getElementById('mobileStatusIndicator');
  const statusText = document.getElementById('mobileStatusText');
  const clientCount = document.getElementById('mobileClientCount');
  const qrPlaceholder = document.getElementById('mobileQrPlaceholder');
  const qrCode = document.getElementById('mobileQrCode');
  const qrCanvas = document.getElementById('mobileQrCanvas');
  const connectionInfo = document.getElementById('mobileConnectionInfo');
  const hostDisplay = document.getElementById('mobileHost');
  const portDisplay = document.getElementById('mobilePortDisplay');
  const apiEndpoint = document.getElementById('mobileApiEndpoint');
  const sessionsList = document.getElementById('mobileSessionsList');
  const pushList = document.getElementById('mobilePushList');
  const createSessionBtn = document.getElementById('mobileCreateSessionBtn');
  const refreshSessionsBtn = document.getElementById('mobileRefreshSessionsBtn');
  const testNotifyBtn = document.getElementById('mobileTestNotifyBtn');

  if (!startBtn) return;

  // Update UI based on state
  function updateUI() {
    if (mobileState.isRunning) {
      statusIndicator.classList.remove('stopped');
      statusIndicator.classList.add('running');
      statusText.textContent = `Server running on port ${mobileState.port}`;
      startBtn.disabled = true;
      stopBtn.disabled = false;
      createSessionBtn.disabled = false;
      refreshSessionsBtn.disabled = false;
      testNotifyBtn.disabled = false;

      // Show QR code and connection info
      qrPlaceholder.classList.add('hidden');
      qrCode.classList.remove('hidden');
      connectionInfo.classList.remove('hidden');

      if (mobileState.connectionInfo) {
        hostDisplay.textContent = mobileState.connectionInfo.host;
        portDisplay.textContent = mobileState.connectionInfo.port;
        apiEndpoint.textContent = mobileState.connectionInfo.apiEndpoint;
      }

      // Show client count
      if (mobileState.sseClientCount > 0) {
        clientCount.textContent = `${mobileState.sseClientCount} client${mobileState.sseClientCount !== 1 ? 's' : ''}`;
        clientCount.classList.remove('hidden');
      } else {
        clientCount.classList.add('hidden');
      }
    } else {
      statusIndicator.classList.remove('running');
      statusIndicator.classList.add('stopped');
      statusText.textContent = 'Server stopped';
      startBtn.disabled = false;
      stopBtn.disabled = true;
      createSessionBtn.disabled = true;
      refreshSessionsBtn.disabled = true;
      testNotifyBtn.disabled = true;

      // Hide QR code and connection info
      qrPlaceholder.classList.remove('hidden');
      qrCode.classList.add('hidden');
      connectionInfo.classList.add('hidden');
      clientCount.classList.add('hidden');
    }

    // Update sessions list
    renderSessions();

    // Update push subscriptions list
    renderPushSubscriptions();
  }

  // Render sessions list
  function renderSessions() {
    if (mobileState.sessions.length === 0) {
      sessionsList.innerHTML = '<div class="mobile-sessions-empty">No active sessions</div>';
      return;
    }

    sessionsList.innerHTML = mobileState.sessions.map(session => `
      <div class="mobile-session-item" data-session-id="${session.id}">
        <span class="mobile-session-icon">${getPlatformIcon(session.platform)}</span>
        <div class="mobile-session-info">
          <div class="mobile-session-name">${escapeHtml(session.deviceName)}</div>
          <div class="mobile-session-meta">${formatDate(session.lastUsed)} • ${session.permissions.join(', ')}</div>
        </div>
        <button class="btn btn-xs btn-danger" onclick="window.revokeMobileSession('${session.id}')" title="Revoke session">×</button>
      </div>
    `).join('');
  }

  // Render push subscriptions list
  function renderPushSubscriptions() {
    if (mobileState.pushSubscriptions.length === 0) {
      pushList.innerHTML = '<div class="mobile-push-empty">No push subscriptions</div>';
      return;
    }

    pushList.innerHTML = mobileState.pushSubscriptions.map(sub => `
      <div class="mobile-push-item" data-push-id="${sub.id}">
        <span class="mobile-push-icon">${getPlatformIcon(sub.platform)}</span>
        <div class="mobile-push-info">
          <div class="mobile-push-name">${escapeHtml(sub.deviceName)}</div>
          <div class="mobile-push-platform">${sub.platform} • ${formatDate(sub.createdAt)}</div>
        </div>
      </div>
    `).join('');
  }

  // Get platform icon
  function getPlatformIcon(platform) {
    const icons = {
      ios: '🍎',
      android: '🤖',
      mobile: '📱',
      manual: '🔧',
      web: '🌐',
    };
    return icons[platform] || '📱';
  }

  // Format date
  function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  }

  // Escape HTML
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  // Generate QR code
  async function generateQrCode(data) {
    if (!qrCanvas) return;

    const ctx = qrCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 200, 200);

    // Simple QR code representation (would use a library in production)
    // For now, display connection data as text
    ctx.fillStyle = '#000000';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';

    const lines = [
      'Scan with',
      'Hivemind Mobile',
      '',
      `${data.host}:${data.port}`,
    ];

    lines.forEach((line, i) => {
      ctx.fillText(line, 100, 60 + i * 20);
    });

    // Draw a border
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 4;
    ctx.strokeRect(20, 20, 160, 160);

    // Draw corner markers (QR code style)
    const drawCorner = (x, y) => {
      ctx.fillRect(x, y, 30, 30);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x + 5, y + 5, 20, 20);
      ctx.fillStyle = '#000000';
      ctx.fillRect(x + 10, y + 10, 10, 10);
    };

    drawCorner(25, 25);
    drawCorner(145, 25);
    drawCorner(25, 145);
  }

  // Start server
  startBtn.addEventListener('click', async () => {
    const port = parseInt(portInput.value, 10);
    if (isNaN(port) || port < 1024 || port > 65535) {
      alert('Invalid port number. Use a port between 1024 and 65535.');
      return;
    }

    startBtn.disabled = true;
    statusText.textContent = 'Starting server...';

    try {
      const result = await window.electronAPI.invoke('mobile-api-start', { port });
      if (result.success) {
        mobileState.isRunning = true;
        mobileState.port = port;

        // Get QR code data
        const qrResult = await window.electronAPI.invoke('mobile-api-get-qr-code', { includeSession: false });
        if (qrResult.success) {
          mobileState.connectionInfo = qrResult.connectionInfo;
          generateQrCode({
            host: qrResult.connectionInfo.host,
            port: qrResult.connectionInfo.port,
          });
        }

        // Load sessions
        await loadMobileSessions();
        await loadMobilePushSubscriptions();
      } else {
        statusText.textContent = `Error: ${result.error}`;
        startBtn.disabled = false;
      }
    } catch (error) {
      statusText.textContent = `Error: ${error.message}`;
      startBtn.disabled = false;
    }

    updateUI();
  });

  // Stop server
  stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    statusText.textContent = 'Stopping server...';

    try {
      const result = await window.electronAPI.invoke('mobile-api-stop');
      if (result.success) {
        mobileState.isRunning = false;
        mobileState.sessions = [];
        mobileState.pushSubscriptions = [];
        mobileState.sseClientCount = 0;
        mobileState.connectionInfo = null;
      } else {
        statusText.textContent = `Error: ${result.error}`;
      }
    } catch (error) {
      statusText.textContent = `Error: ${error.message}`;
    }

    updateUI();
  });

  // Create session
  createSessionBtn.addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.invoke('mobile-api-create-session', {
        deviceName: 'Manual Session',
        platform: 'manual',
        permissions: ['read', 'command'],
      });

      if (result.success) {
        await loadMobileSessions();
        updateUI();

        // Show the new session API key
        alert(`Session created!\nAPI Key: ${result.session.apiKey}\n\nSave this key - it won't be shown again.`);
      } else {
        alert(`Error: ${result.error}`);
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  });

  // Refresh sessions
  refreshSessionsBtn.addEventListener('click', async () => {
    await loadMobileSessions();
    await loadMobilePushSubscriptions();
    await loadMobileState();
    updateUI();
  });

  // Test notification
  testNotifyBtn.addEventListener('click', async () => {
    try {
      const result = await window.electronAPI.invoke('mobile-api-send-notification', {
        type: 'AGENT_STATUS',
        data: {
          agentId: 'test',
          status: 'active',
          message: 'Test notification from Hivemind',
        },
      });

      if (result.success) {
        alert('Test notification sent!');
      } else {
        alert(`Error: ${result.error}`);
      }
    } catch (error) {
      alert(`Error: ${error.message}`);
    }
  });

  // Listen for mobile API events
  if (window.electronAPI && window.electronAPI.on) {
    window.electronAPI.on('mobile-api-started', (data) => {
      mobileState.isRunning = true;
      if (data.port) mobileState.port = data.port;
      updateUI();
    });

    window.electronAPI.on('mobile-api-stopped', () => {
      mobileState.isRunning = false;
      mobileState.sessions = [];
      mobileState.pushSubscriptions = [];
      mobileState.sseClientCount = 0;
      updateUI();
    });

    window.electronAPI.on('mobile-api-session-created', (data) => {
      loadMobileSessions().then(() => updateUI());
    });

    window.electronAPI.on('mobile-api-push-registered', (data) => {
      loadMobilePushSubscriptions().then(() => updateUI());
    });

    window.electronAPI.on('mobile-api-push-unregistered', (data) => {
      loadMobilePushSubscriptions().then(() => updateUI());
    });

    window.electronAPI.on('mobile-api-error', (data) => {
      console.error('Mobile API error:', data.error);
      statusText.textContent = `Error: ${data.error}`;
    });
  }

  // Initial load
  loadMobileState().then(() => updateUI());
}

/**
 * Load mobile API state
 */
async function loadMobileState() {
  try {
    const result = await window.electronAPI.invoke('mobile-api-get-state');
    if (result.success && result.state) {
      mobileState.isRunning = result.state.isRunning;
      mobileState.port = result.state.port;
      mobileState.sseClientCount = result.state.sseClientCount || 0;
    }
  } catch (error) {
    console.error('Error loading mobile state:', error);
  }
}

/**
 * Load mobile sessions
 */
async function loadMobileSessions() {
  try {
    const result = await window.electronAPI.invoke('mobile-api-get-sessions');
    if (result.success) {
      mobileState.sessions = result.sessions || [];
    }
  } catch (error) {
    console.error('Error loading mobile sessions:', error);
  }
}

/**
 * Load mobile push subscriptions
 */
async function loadMobilePushSubscriptions() {
  try {
    const result = await window.electronAPI.invoke('mobile-api-get-subscriptions');
    if (result.success) {
      mobileState.pushSubscriptions = result.subscriptions || [];
    }
  } catch (error) {
    console.error('Error loading push subscriptions:', error);
  }
}

/**
 * Revoke a mobile session
 */
async function revokeMobileSession(sessionId) {
  if (!confirm('Revoke this session? The device will need to reconnect.')) {
    return;
  }

  try {
    const result = await window.electronAPI.invoke('mobile-api-revoke-session', { sessionId });
    if (result.success) {
      await loadMobileSessions();
      // Trigger UI update
      const event = new CustomEvent('mobile-sessions-updated');
      document.dispatchEvent(event);
    } else {
      alert(`Error: ${result.error}`);
    }
  } catch (error) {
    alert(`Error: ${error.message}`);
  }
}

/**
 * Get mobile API state
 */
function getMobileState() {
  return {
    isRunning: mobileState.isRunning,
    port: mobileState.port,
    sessionCount: mobileState.sessions.length,
    pushCount: mobileState.pushSubscriptions.length,
    clientCount: mobileState.sseClientCount,
  };
}

// Make revokeMobileSession available globally for onclick handler
if (typeof window !== 'undefined') {
  window.revokeMobileSession = revokeMobileSession;
}

// Make kickCollabUser available globally for onclick handler
if (typeof window !== 'undefined') {
  window.kickCollabUser = kickCollabUser;
}

module.exports = {
  setConnectionStatusCallback,
  togglePanel,
  isPanelOpen,
  switchTab,
  setupProcessesTab,
  setupBuildProgressTab,
  setupHistoryTab,
  setupProjectsTab,
  setupPerformanceTab,
  setupTemplatesTab,
  setupActivityTab,
  setupTestsTab,           // TR1: Test results panel
  setupCIStatusIndicator,  // CI2: CI status indicator
  setupInspectorTab,       // P2-5: Message inspector
  setupQueueTab,           // Task #3: Task queue dashboard
  setupScheduleTab,        // Task #28: Scheduler
  setupGitTab,             // Task #6: Git integration
  setupFrictionPanel,
  setupRightPanel,
  updateBuildProgress,
  refreshBuildProgress,
  loadProcesses,
  loadScreenshots,
  loadSessionHistory,
  loadRecentProjects,
  loadPerformanceData,
  loadPerfProfile,
  loadTemplates,
  loadActivityLog,
  loadTestResults,         // TR1: Load test results
  loadSequenceState,       // P2-5: Load sequence state
  loadReliabilityStats,    // Task #8: Load reliability analytics
  addActivityEntry,
  addInspectorEvent,       // P2-5: Add inspector event
  updateCIStatus,          // CI2: Update CI status
  setupMCPStatusIndicator, // MC7: MCP status indicator
  updateMCPAgentStatus,    // MC7: Update single agent status
  setAllMCPStatus,         // MC7: Set all agents status
  loadMCPStatus,           // MC7: Load MCP status from backend
  configureMCPForAgent,    // MC8: Configure MCP for single agent
  configureAllMCP,         // MC8: Configure MCP for all agents
  autoConfigureMCPOnSpawn, // MC8: Auto-config on spawn
  isMCPConfigured,         // MC8: Check if agent MCP configured
  resetMCPConfiguration,   // MC8: Reset configuration state
  startMCPHealthMonitoring,  // MC9: Start health checks
  stopMCPHealthMonitoring,   // MC9: Stop health checks
  checkMCPHealth,            // MC9: Manual health check
  attemptMCPReconnect,       // MC9: Reconnect single agent
  reconnectAllMCP,           // MC9: Reconnect all agents
  getMCPHealthSummary,       // MC9: Get health summary
  setupMemoryTab,            // Task #8: Conversation history viewer
  setupHealthTab,            // Task #29: Self-healing error recovery UI
  refreshHealthData,         // Task #29: Refresh agent health data
  updateAgentHealth,         // Task #29: Update single agent health
  getHealthState,            // Task #29: Get current health state
  stopHealthMonitoring,      // Task #29: Cleanup health monitoring
  loadMemoryTranscript,      // Task #8: Load agent transcript
  loadMemoryTimeline,        // Task #34: Memory timeline view
  loadMemoryContext,         // Task #8: Load agent context
  loadMemoryLearnings,       // Task #8: Load agent learnings
  loadMemoryTeam,            // Task #8: Load team overview
  searchMemory,              // Task #8: Search memory
  switchMemoryView,          // Task #8: Switch memory view
  setupGraphTab,             // Task #36: Knowledge graph visualization
  refreshGraphData,          // Task #36: Refresh graph data
  searchGraph,               // Task #36: Search knowledge graph
  getGraphState,             // Task #36: Get current graph state
  setupWorkflowTab,          // Task #19: Workflow builder
  loadWorkflowNodeTypes,     // Task #19: Load node type definitions
  loadWorkflowTemplates,     // Task #19: Load workflow templates
  validateWorkflowUI,        // Task #19: Validate workflow
  generateWorkflowPlan,      // Task #19: Generate execution plan
  saveWorkflowToFile,        // Task #19: Save to file system
  showWorkflowLoadDialog,    // Task #19: Show load dialog
  exportWorkflowToFile,      // Task #19: Export to file
  importWorkflowFromFile,    // Task #19: Import from file
  showWorkflowTemplates,     // Task #19: Show template picker
  undoWorkflow,              // Task #19: Undo action
  redoWorkflow,              // Task #19: Redo action
  deleteSelectedWorkflowNode, // Task #19: Delete selected
  duplicateSelectedWorkflowNode, // Task #19: Duplicate selected
  zoomWorkflow,              // Task #19: Zoom canvas
  resetWorkflowZoom,         // Task #19: Reset zoom
  setupDebugTab,             // Task #21: Debug replay tab
  loadDebugSession,          // Task #21: Load agent debug session
  debugStepForward,          // Task #21: Step forward in replay
  debugStepBackward,         // Task #21: Step backward in replay
  debugJumpTo,               // Task #21: Jump to specific action
  debugPlay,                 // Task #21: Start auto-play
  debugPause,                // Task #21: Pause auto-play
  debugReset,                // Task #21: Reset replay
  getDebugState,             // Task #21: Get current debug state
  setupReviewTab,            // Task #18: Code review tab
  runCodeReview,             // Task #18: Run code review
  filterReviewIssues,        // Task #18: Filter issues by severity
  checkReviewAIStatus,       // Task #18: Check AI availability
  getReviewState,            // Task #18: Get current review state
  setupDocsTab,              // Task #23: Documentation tab
  generateDocumentation,     // Task #23: Generate documentation
  previewDocumentation,      // Task #23: Preview documentation
  checkDocsCoverage,         // Task #23: Check documentation coverage
  loadUndocumentedItems,     // Task #23: Load undocumented items
  exportDocumentation,       // Task #23: Export documentation
  getDocsState,              // Task #23: Get current docs state
  setupCostsTab,             // Task #24: Cost optimization tab
  loadCostData,              // Task #24: Load cost data
  recordCost,                // Task #24: Record a cost event
  showBudgetModal,           // Task #24: Show budget settings modal
  showHistoryModal,          // Task #24: Show cost history modal
  loadCostAlerts,            // Task #24: Load cost alerts
  resetCostData,             // Task #24: Reset cost tracking
  getCostsState,             // Task #24: Get current costs state
  setupSecurityTab,          // Task #25: Security tab
  loadSecurityData,          // Task #25: Load security data
  getSecurityState,          // Task #25: Get security state
  setupDashboardTab,         // Task #30: Multi-project dashboard
  loadDashboardData,         // Task #30: Load dashboard data
  loadHealthScores,          // Task #30: Load health scores
  getDashboardState,         // Task #30: Get dashboard state
  setupScaffoldTab,          // Task #12: Project scaffolding
  loadScaffoldTemplates,     // Task #12: Load scaffold templates
  getScaffoldState,          // Task #12: Get scaffold state
  setupDeployTab,            // Task #15: Automated deployment
  loadDeployConfig,          // Task #15: Load deploy config
  checkDeployReadiness,      // Task #15: Check readiness
  startDeployBuild,          // Task #15: Start build
  cancelDeployBuild,         // Task #15: Cancel build
  deployToGitHub,            // Task #15: Deploy to GitHub
  loadDeployHistory,         // Task #15: Load history
  getDeployState,            // Task #15: Get deploy state
  setupCollabTab,            // Task #11: Real-time collaboration
  loadCollabState,           // Task #11: Load collab state
  createCollabSession,       // Task #11: Create session
  joinCollabSession,         // Task #11: Join session
  leaveCollabSession,        // Task #11: Leave session
  sendCollabChat,            // Task #11: Send chat message
  getCollabState,            // Task #11: Get collab state
  setupMobileTab,            // Task #17: Mobile companion app
  loadMobileState,           // Task #17: Load mobile state
  loadMobileSessions,        // Task #17: Load sessions
  loadMobilePushSubscriptions, // Task #17: Load push subscriptions
  revokeMobileSession,       // Task #17: Revoke session
  getMobileState,            // Task #17: Get mobile state
};
