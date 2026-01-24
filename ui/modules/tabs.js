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
};
