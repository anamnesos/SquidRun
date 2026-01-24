/**
 * Tabs and panels module
 * Handles right panel, tab switching, screenshots, processes, and build progress
 */

const { ipcRenderer } = require('electron');

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
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer',
};

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
    console.error('Error loading processes:', err);
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
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer',
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
    console.error('[OB2] Error loading activity log:', err);
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
  testSummary = summary || { passed: 0, failed: 0, skipped: 0, total: results.length };
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
  testStatus = 'running';
  testResults = [];
  testSummary = { passed: 0, failed: 0, skipped: 0, total: 0 };
  renderTestSummary();
  renderTestResults();

  try {
    const result = await ipcRenderer.invoke('run-tests');
    if (result && result.success) {
      setTestResults(result.results, result.summary);
      updateConnectionStatus(`Tests complete: ${result.summary.passed} passed, ${result.summary.failed} failed`);
    } else {
      testStatus = 'idle';
      renderTestSummary();
      updateConnectionStatus(`Test run failed: ${result?.error || 'Unknown error'}`);
    }
  } catch (err) {
    testStatus = 'idle';
    renderTestSummary();
    updateConnectionStatus(`Test error: ${err.message}`);
  }
}

async function loadTestResults() {
  try {
    const result = await ipcRenderer.invoke('get-test-results');
    if (result && result.success) {
      setTestResults(result.results, result.summary);
    }
  } catch (err) {
    console.error('[TR1] Error loading test results:', err);
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
    setTestResults(data.results, data.summary);
    updateConnectionStatus(`Tests complete: ${data.summary.passed} passed, ${data.summary.failed} failed`);
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
  '4': 'disconnected'
};

const MCP_AGENT_NAMES = {
  '1': 'Lead',
  '2': 'Worker A',
  '3': 'Worker B',
  '4': 'Reviewer'
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
  const total = 4;

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
  for (const paneId of ['1', '2', '3', '4']) {
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
    console.log('[MC7] MCP status not available yet');
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
  '4': false
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

  for (const paneId of ['1', '2', '3', '4']) {
    await configureMCPForAgent(paneId);
  }

  const configured = Object.values(mcpConfigured).filter(Boolean).length;
  updateConnectionStatus(`MCP configured for ${configured}/4 agents`);
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
    console.error('[MC8] Error checking MCP auto-config setting:', err);
  }
}

function isMCPConfigured(paneId) {
  return mcpConfigured[paneId] === true;
}

function resetMCPConfiguration() {
  mcpConfigured = {
    '1': false,
    '2': false,
    '3': false,
    '4': false
  };
  setAllMCPStatus('disconnected');
}

// ============================================================
// MC9: MCP CONNECTION HEALTH MONITORING
// ============================================================

let mcpHealthCheckInterval = null;
const MCP_HEALTH_CHECK_INTERVAL = 30000; // Check every 30 seconds
const MCP_STALE_THRESHOLD = 60000; // Consider stale after 60 seconds

let lastMCPHealthCheck = {
  '1': null,
  '2': null,
  '3': null,
  '4': null
};

async function checkMCPHealth() {
  try {
    const result = await ipcRenderer.invoke('get-mcp-status');
    if (!result || !result.success) return;

    const now = Date.now();

    for (const paneId of ['1', '2', '3', '4']) {
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
    console.error('[MC9] Health check error:', err);
  }
}

function startMCPHealthMonitoring() {
  // Stop any existing interval
  stopMCPHealthMonitoring();

  // Initial check
  checkMCPHealth();

  // Start periodic checks
  mcpHealthCheckInterval = setInterval(checkMCPHealth, MCP_HEALTH_CHECK_INTERVAL);
  console.log('[MC9] MCP health monitoring started');
}

function stopMCPHealthMonitoring() {
  if (mcpHealthCheckInterval) {
    clearInterval(mcpHealthCheckInterval);
    mcpHealthCheckInterval = null;
    console.log('[MC9] MCP health monitoring stopped');
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

  for (const paneId of ['1', '2', '3', '4']) {
    if (mcpStatus[paneId] !== 'connected') {
      await attemptMCPReconnect(paneId);
    }
  }
}

function getMCPHealthSummary() {
  const connected = Object.values(mcpStatus).filter(s => s === 'connected').length;
  const errors = Object.values(mcpStatus).filter(s => s === 'error').length;
  const connecting = Object.values(mcpStatus).filter(s => s === 'connecting').length;

  return {
    connected,
    disconnected: 4 - connected - errors - connecting,
    errors,
    connecting,
    healthy: connected === 4
  };
}

// ============================================================
// PT2: PERFORMANCE DASHBOARD
// ============================================================

let performanceData = {};

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
  for (const paneId of ['1', '2', '3', '4']) {
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
    console.error('[PT2] Error loading performance data:', err);
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
    console.error('[PT2] Error resetting performance data:', err);
  }
}

function setupPerformanceTab() {
  const refreshBtn = document.getElementById('refreshPerfBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadPerformanceData);

  const resetBtn = document.getElementById('resetPerfBtn');
  if (resetBtn) resetBtn.addEventListener('click', resetPerformanceData);

  loadPerformanceData();
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
    console.error('[TM2] Error loading templates:', err);
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
    console.error('Error loading recent projects:', err);
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
    console.error('Error loading session history:', err);
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
    console.error('Error loading usage stats:', err);
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
    console.error('Error loading state:', err);
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
    console.log('[Conflict]', conflicts);
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
  const badge = document.getElementById('frictionBadge');
  if (badge) {
    badge.textContent = count;
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
  const listEl = document.getElementById('frictionList');
  if (!listEl) return;

  if (frictionFiles.length === 0) {
    listEl.innerHTML = '<div class="friction-empty">No friction logs found</div>';
    updateFrictionBadge(0);
    return;
  }

  updateFrictionBadge(frictionFiles.length);

  listEl.innerHTML = frictionFiles.map(f => `
    <div class="friction-item" data-filename="${f.name}">
      <span class="friction-item-name">${f.name}</span>
      <span class="friction-item-time">${formatFrictionTime(f.modified)}</span>
    </div>
  `).join('');

  listEl.querySelectorAll('.friction-item').forEach(item => {
    item.addEventListener('click', () => viewFrictionFile(item.dataset.filename));
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
    console.error('Error loading friction files:', err);
  }
}

async function viewFrictionFile(filename) {
  try {
    const result = await window.hivemind.friction.read(filename);
    if (result.success) {
      alert(`=== ${filename} ===\n\n${result.content}`);
    }
  } catch (err) {
    console.error('Error reading friction file:', err);
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
    console.error('Error clearing friction:', err);
  }
}

function setupFrictionPanel() {
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

  const refreshBtn = document.getElementById('refreshFrictionBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadFrictionFiles);
  }

  const clearBtn = document.getElementById('clearFrictionBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearFriction);
  }

  loadFrictionFiles();
}

// ============================================================
// MQ3+MQ6: MESSAGES TAB
// ============================================================

let messageHistory = [];
let messageFilter = 'all';
let selectedRecipients = [];

const MESSAGE_AGENT_MAP = {
  'lead': { pane: '1', name: 'Lead' },
  'worker-a': { pane: '2', name: 'Worker A' },
  'worker-b': { pane: '3', name: 'Worker B' },
  'reviewer': { pane: '4', name: 'Reviewer' }
};

const PANE_TO_AGENT = {
  '1': 'lead',
  '2': 'worker-a',
  '3': 'worker-b',
  '4': 'reviewer'
};

function formatMessageTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function getAgentDisplayName(agentId) {
  if (MESSAGE_AGENT_MAP[agentId]) return MESSAGE_AGENT_MAP[agentId].name;
  if (AGENT_NAMES[agentId]) return AGENT_NAMES[agentId];
  return agentId;
}

function renderMessagesList() {
  const listEl = document.getElementById('messagesList');
  if (!listEl) return;

  // Apply filter
  let filtered = messageHistory;
  if (messageFilter !== 'all') {
    filtered = messageHistory.filter(msg => {
      const fromAgent = msg.from?.toLowerCase().replace(' ', '-');
      const toAgent = msg.to?.toLowerCase().replace(' ', '-');
      return fromAgent === messageFilter || toAgent === messageFilter ||
             msg.from === messageFilter || msg.to === messageFilter;
    });
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="messages-empty">No messages yet</div>';
    return;
  }

  // Sort by time (newest last)
  const sorted = [...filtered].sort((a, b) =>
    new Date(a.time || a.timestamp) - new Date(b.time || b.timestamp)
  );

  listEl.innerHTML = sorted.map(msg => {
    const fromName = getAgentDisplayName(msg.from);
    const toName = msg.to ? getAgentDisplayName(msg.to) : 'All';
    const time = formatMessageTime(msg.time || msg.timestamp);
    const delivered = msg.delivered !== false;

    return `
      <div class="message-item ${delivered ? '' : 'unread'}">
        <div class="message-header">
          <span>
            <span class="message-from">${fromName}</span>
            <span class="message-to">→ ${toName}</span>
          </span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-body">${escapeHtml(msg.msg || msg.message || '')}</div>
        ${delivered ? '<div class="message-delivered">✓ Delivered</div>' : '<div class="message-pending">⏳ Pending</div>'}
      </div>
    `;
  }).join('');

  // Auto-scroll to bottom
  listEl.scrollTop = listEl.scrollHeight;
}

async function loadMessageHistory() {
  try {
    // Get messages from all queues
    const result = await ipcRenderer.invoke('get-all-messages');
    if (result && result.success) {
      // Flatten all queues into single array
      const allMessages = [];
      for (const paneId in result.queues) {
        const queue = result.queues[paneId];
        if (Array.isArray(queue)) {
          allMessages.push(...queue);
        }
      }
      messageHistory = allMessages;
      renderMessagesList();
    }
  } catch (err) {
    console.error('[MQ3] Error loading message history:', err);
  }
}

async function clearMessageHistory() {
  if (!confirm('Clear all message history?')) return;

  try {
    // Clear all queues
    for (const paneId of ['1', '2', '3', '4']) {
      await ipcRenderer.invoke('clear-messages', paneId);
    }
    messageHistory = [];
    renderMessagesList();
    updateConnectionStatus('Message history cleared');
  } catch (err) {
    console.error('[MQ3] Error clearing message history:', err);
    updateConnectionStatus('Failed to clear message history');
  }
}

function updateSendButtonState() {
  const sendBtn = document.getElementById('messageSendBtn');
  const input = document.getElementById('messageComposerInput');

  if (sendBtn && input) {
    const hasRecipients = selectedRecipients.length > 0;
    const hasMessage = input.value.trim().length > 0;
    sendBtn.disabled = !hasRecipients || !hasMessage;
  }
}

async function sendGroupMessage() {
  const input = document.getElementById('messageComposerInput');
  if (!input || !input.value.trim() || selectedRecipients.length === 0) return;

  const message = input.value.trim();
  let recipients = [];

  // Expand recipient groups
  for (const r of selectedRecipients) {
    if (r === 'all') {
      recipients = ['1', '2', '3', '4'];
      break;
    } else if (r === 'workers') {
      recipients.push('2', '3');
    } else if (MESSAGE_AGENT_MAP[r]) {
      recipients.push(MESSAGE_AGENT_MAP[r].pane);
    }
  }

  // Remove duplicates
  recipients = [...new Set(recipients)];

  updateConnectionStatus(`Sending message to ${recipients.length} recipient(s)...`);

  try {
    // Use the API from checkpoint.md: send-group-message(fromPaneId, toPanes, content)
    // From 'user' we use pane 0 or system indicator
    const result = await ipcRenderer.invoke('send-group-message', 'system', recipients, message);

    if (result && result.success) {
      input.value = '';
      updateSendButtonState();
      await loadMessageHistory();
      updateConnectionStatus(`Message sent to ${recipients.length} agent(s)`);
    } else {
      updateConnectionStatus(`Failed to send: ${result?.error || 'Unknown error'}`);
    }
  } catch (err) {
    updateConnectionStatus(`Send error: ${err.message}`);
  }
}

function setupMessagesTab() {
  // Filter buttons
  document.querySelectorAll('.messages-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.messages-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      messageFilter = btn.dataset.filter;
      renderMessagesList();
    });
  });

  // Recipient buttons (multi-select)
  document.querySelectorAll('.recipient-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const recipient = btn.dataset.recipient;

      // Handle "all" and "workers" - clear other selections
      if (recipient === 'all' || recipient === 'workers') {
        document.querySelectorAll('.recipient-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedRecipients = [recipient];
      } else {
        // If "all" or "workers" is selected, clear it
        const allBtn = document.querySelector('.recipient-btn[data-recipient="all"]');
        const workersBtn = document.querySelector('.recipient-btn[data-recipient="workers"]');
        if (allBtn) allBtn.classList.remove('selected');
        if (workersBtn) workersBtn.classList.remove('selected');
        selectedRecipients = selectedRecipients.filter(r => r !== 'all' && r !== 'workers');

        // Toggle individual recipient
        if (btn.classList.contains('selected')) {
          btn.classList.remove('selected');
          selectedRecipients = selectedRecipients.filter(r => r !== recipient);
        } else {
          btn.classList.add('selected');
          selectedRecipients.push(recipient);
        }
      }

      updateSendButtonState();
    });
  });

  // Message input
  const input = document.getElementById('messageComposerInput');
  if (input) {
    input.addEventListener('input', updateSendButtonState);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendGroupMessage();
      }
    });
  }

  // Send button
  const sendBtn = document.getElementById('messageSendBtn');
  if (sendBtn) {
    sendBtn.addEventListener('click', sendGroupMessage);
  }

  // Action buttons
  const refreshBtn = document.getElementById('refreshMessagesBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadMessageHistory);

  const clearBtn = document.getElementById('clearMessagesBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearMessageHistory);

  // Listen for message events (from checkpoint.md API)
  ipcRenderer.on('message-queued', (event, msg) => {
    messageHistory.push(msg);
    renderMessagesList();
  });

  ipcRenderer.on('message-delivered', (event, data) => {
    // Update delivery status
    const msg = messageHistory.find(m => m.id === data.messageId);
    if (msg) {
      msg.delivered = true;
      msg.deliveredAt = data.deliveredAt;
      renderMessagesList();
    }
  });

  ipcRenderer.on('messages-cleared', () => {
    loadMessageHistory(); // Reload to sync state
  });

  ipcRenderer.on('direct-message-sent', (event, data) => {
    // Direct message sent via triggers, reload history
    loadMessageHistory();
  });

  loadMessageHistory();
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
      console.error('Failed to load screenshots:', result.error);
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
    console.error('Error loading screenshots:', err);
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
  setupMessagesTab,        // MQ3+MQ6: Messages tab
  setupFrictionPanel,
  setupRightPanel,
  updateBuildProgress,
  refreshBuildProgress,
  loadProcesses,
  loadScreenshots,
  loadSessionHistory,
  loadRecentProjects,
  loadPerformanceData,
  loadTemplates,
  loadActivityLog,
  loadTestResults,         // TR1: Load test results
  loadMessageHistory,      // MQ3: Load message history
  addActivityEntry,
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
};
