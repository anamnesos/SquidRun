/**
 * Hivemind Status Strip (legacy module)
 * Status strip UI was removed; this module now maintains only session timer text.
 */

const { ipcRenderer } = require('electron');
const log = require('./logger');

// Session start time for duration tracking
let sessionStartTime = Date.now();
let sessionTimerInterval = null;
let initialized = false;

// Kept for compatibility with existing exports/callers.
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

/**
 * Fetch task pool via IPC (kept for compatibility)
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
 * Update session timer display in X:XX format.
 */
function updateSessionTimer() {
  const timerEl = document.getElementById('sessionTimer');
  if (!timerEl) return;

  const elapsed = Date.now() - sessionStartTime;
  const totalMinutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  timerEl.textContent = `Session: ${hours}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Legacy no-op now that status strip counters are removed.
 */
function updateStatusStrip() {
  // Intentionally blank: done/running/waiting/failed segments were removed from the DOM.
}

/**
 * Initialize session timer behavior.
 */
function initStatusStrip() {
  if (initialized) return;
  initialized = true;

  sessionStartTime = Date.now();
  updateSessionTimer();
  sessionTimerInterval = setInterval(updateSessionTimer, 60000);

  log.info('StatusStrip', 'Initialized (timer-only mode)');
}

/**
 * Shutdown and clear timer interval.
 */
function shutdownStatusStrip() {
  initialized = false;
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
