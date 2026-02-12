/**
 * Hivemind Status Strip - Task status overview
 * Extracted from renderer.js for modularization
 */

const { ipcRenderer } = require('electron');
const log = require('./logger');
const { registerScopedIpcListener } = require('./renderer-ipc-registry');

// Session start time for duration tracking
let sessionStartTime = Date.now();

// Cached task pool data
let cachedTaskPool = { tasks: [] };

// Smart Parallelism Phase 3 - Domain ownership mapping
const PANE_DOMAIN_MAP = {
  '1': 'architecture',  // Architect
  '2': 'devops',        // DevOps (Infra + Backend)
  '5': 'analysis',      // Analyst
};

// Check if there are claimable tasks for a given pane's domain
function hasClaimableTasks(paneId) {
  const domain = PANE_DOMAIN_MAP[paneId];
  if (!domain) return false;

  return cachedTaskPool.tasks.some(task =>
    task.status === 'open' &&
    !task.owner &&
    task.metadata?.domain === domain &&
    (!task.blockedBy || task.blockedBy.length === 0)
  );
}

// Get claimable tasks for a pane's domain
function getClaimableTasksForPane(paneId) {
  const domain = PANE_DOMAIN_MAP[paneId];
  if (!domain) return [];

  return cachedTaskPool.tasks.filter(task =>
    task.status === 'open' &&
    !task.owner &&
    task.metadata?.domain === domain &&
    (!task.blockedBy || task.blockedBy.length === 0)
  );
}

let sessionTimerInterval = null;
let pollInterval = null;
let initialized = false;

/**
 * Update session timer display
 */
function updateSessionTimer() {
  const timerEl = document.getElementById('sessionTimer');
  if (!timerEl) return;

  const elapsed = Date.now() - sessionStartTime;
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);

  if (hours > 0) {
    timerEl.textContent = `Session: ${hours}h ${minutes}m`;
  } else {
    timerEl.textContent = `Session: ${minutes}m`;
  }
}

/**
 * Fetch task pool via IPC (uses existing get-task-list handler)
 */
async function fetchTaskPool() {
  try {
    const tasks = await ipcRenderer.invoke('get-task-list');
    if (Array.isArray(tasks)) {
      cachedTaskPool = { tasks };
    }
  } catch (err) {
    log.error('StatusStrip', 'Failed to fetch task pool:', err);
  }
  return cachedTaskPool;
}

/**
 * Count tasks by status
 * @param {Array} tasks - Array of task objects
 * @returns {Object} Counts object with completed, in_progress, waiting, failed
 */
function countTasksByStatus(tasks) {
  const counts = {
    completed: 0,
    in_progress: 0,
    waiting: 0,
    failed: 0
  };

  tasks.forEach(task => {
    const status = task.status || 'open';

    if (status === 'completed') {
      counts.completed++;
    } else if (status === 'in_progress') {
      counts.in_progress++;
    } else if (status === 'failed') {
      counts.failed++;
    } else if (status === 'needs_input') {
      counts.waiting++;
    } else if (task.blockedBy && task.blockedBy.length > 0) {
      // Check if blockers are still open
      const hasUnresolvedBlocker = task.blockedBy.some(blockerId => {
        const blocker = tasks.find(t => t.id === blockerId);
        return blocker && blocker.status !== 'completed';
      });
      if (hasUnresolvedBlocker) {
        counts.waiting++;
      }
    }
  });

  return counts;
}

/**
 * Get tasks filtered by status for dropdown display
 * @param {Array} tasks - Array of task objects
 * @param {string} statusFilter - Status filter (completed, in_progress, waiting, failed)
 * @returns {Array} Filtered tasks
 */
function getTasksByStatus(tasks, statusFilter) {
  return tasks.filter(task => {
    const status = task.status || 'open';

    if (statusFilter === 'completed') {
      return status === 'completed';
    } else if (statusFilter === 'in_progress') {
      return status === 'in_progress';
    } else if (statusFilter === 'failed') {
      return status === 'failed';
    } else if (statusFilter === 'waiting') {
      if (status === 'needs_input') return true;
      if (task.blockedBy && task.blockedBy.length > 0) {
        const hasUnresolvedBlocker = task.blockedBy.some(blockerId => {
          const blocker = tasks.find(t => t.id === blockerId);
          return blocker && blocker.status !== 'completed';
        });
        return hasUnresolvedBlocker;
      }
      return false;
    }
    return false;
  });
}

/**
 * Render dropdown list for a status segment
 * @param {Element} listEl - DOM element for the list
 * @param {Array} tasks - Tasks to render
 * @param {string} statusType - Status type for formatting
 */
function renderDropdownList(listEl, tasks, statusType) {
  if (!listEl) return;

  if (tasks.length === 0) {
    listEl.innerHTML = '<div class="status-dropdown-empty">None</div>';
    return;
  }

  listEl.innerHTML = tasks.map(task => {
    let meta = '';
    if (statusType === 'waiting' && task.status === 'needs_input') {
      meta = 'Needs human input';
    } else if (statusType === 'waiting' && task.blockedBy) {
      meta = `Blocked by: ${task.blockedBy.join(', ')}`;
    } else if (statusType === 'failed' && task.metadata?.error) {
      meta = task.metadata.error.message || 'Error';
    } else if (task.owner) {
      meta = `Owner: ${task.owner}`;
    }

    return `
      <div class="status-dropdown-item">
        <div class="status-dropdown-item-title">${task.subject || task.id}</div>
        ${meta ? `<div class="status-dropdown-item-meta">${meta}</div>` : ''}
      </div>
    `;
  }).join('');
}

/**
 * Update status strip UI with current task counts
 */
function updateStatusStrip() {
  const tasks = cachedTaskPool.tasks || [];
  const counts = countTasksByStatus(tasks);

  // Update counts
  const updateSegment = (id, count, statusType) => {
    const countEl = document.getElementById(`count${id}`);
    const segmentEl = document.getElementById(`status${id}`);
    const listEl = document.getElementById(`list${id}`);

    if (countEl) countEl.textContent = count;
    if (segmentEl) {
      segmentEl.classList.toggle('zero', count === 0);
    }

    // Update dropdown list
    const filteredTasks = getTasksByStatus(tasks, statusType);
    renderDropdownList(listEl, filteredTasks, statusType);
  };

  updateSegment('Done', counts.completed, 'completed');
  updateSegment('Running', counts.in_progress, 'in_progress');
  updateSegment('Waiting', counts.waiting, 'waiting');
  updateSegment('Failed', counts.failed, 'failed');
}

/**
 * Initialize status strip event handlers
 */
function initStatusStrip() {
  if (initialized) return;
  initialized = true;
  const segments = document.querySelectorAll('.status-segment');

  segments.forEach(segment => {
    // Toggle dropdown on click
    segment.addEventListener('click', (e) => {
      // Close other dropdowns
      segments.forEach(s => {
        if (s !== segment) s.classList.remove('open');
      });

      // Toggle this dropdown
      segment.classList.toggle('open');
      e.stopPropagation();
    });
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', () => {
    segments.forEach(s => s.classList.remove('open'));
  });

  // Initial fetch and update
  fetchTaskPool().then(() => updateStatusStrip());

  // Poll every 30 seconds as backup (primary updates come via task-list-updated IPC event)
  pollInterval = setInterval(async () => {
    await fetchTaskPool();
    updateStatusStrip();
  }, 30000);

  // Listen for immediate task updates from main process
  registerScopedIpcListener('status-strip', 'task-list-updated', (event, data) => {
    if (data && Array.isArray(data.tasks)) {
      cachedTaskPool = { tasks: data.tasks };
      updateStatusStrip();
    }
  });

  // Update session timer every minute
  updateSessionTimer();
  sessionTimerInterval = setInterval(updateSessionTimer, 60000);

  log.info('StatusStrip', 'Initialized');
}

/**
 * Shutdown status strip and clear intervals
 */
function shutdownStatusStrip() {
  initialized = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
}

module.exports = {
  initStatusStrip,
  shutdownStatusStrip,
  fetchTaskPool,
  updateStatusStrip,
  hasClaimableTasks,
  getClaimableTasksForPane,
};
