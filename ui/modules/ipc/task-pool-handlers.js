/**
 * Task Pool IPC Handlers - Smart Parallelism Phase 3
 * Channels: get-task-list, claim-task, task-list-updated
 *
 * Provides task pool management for agent self-claim workflow.
 * Tasks are stored in workspace/task-pool.json with domain metadata.
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

// In-memory task cache (loaded from file on startup)
let taskPool = [];

function registerTaskPoolHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerTaskPoolHandlers requires ctx.ipcMain');
  }

  const { ipcMain, mainWindow } = ctx;
  const workspacePath = ctx.WORKSPACE_PATH;
  const TASK_POOL_FILE = workspacePath
    ? path.join(workspacePath, 'task-pool.json')
    : null;

  // Load task pool from file
  function loadTaskPool() {
    if (!TASK_POOL_FILE) return [];
    try {
      if (fs.existsSync(TASK_POOL_FILE)) {
        const content = fs.readFileSync(TASK_POOL_FILE, 'utf-8');
        const data = JSON.parse(content);
        return Array.isArray(data.tasks) ? data.tasks : [];
      }
    } catch (err) {
      log.error('TaskPool', 'Error loading task pool:', err.message);
    }
    return [];
  }

  // Save task pool to file
  function saveTaskPool(tasks) {
    if (!TASK_POOL_FILE) return false;
    try {
      const data = {
        tasks,
        lastUpdated: new Date().toISOString()
      };
      fs.writeFileSync(TASK_POOL_FILE, JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      log.error('TaskPool', 'Error saving task pool:', err.message);
      return false;
    }
  }

  // Broadcast task list update to renderer
  function broadcastTaskUpdate() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('task-list-updated', { tasks: taskPool });
    }
  }

  // Initialize task pool
  taskPool = loadTaskPool();
  log.info('TaskPool', `Loaded ${taskPool.length} tasks`);

  // Get current task list
  ipcMain.handle('get-task-list', () => {
    return taskPool;
  });

  // Claim a task for an agent
  ipcMain.handle('claim-task', (event, { paneId, taskId, domain }) => {
    const task = taskPool.find(t => t.id === taskId);

    if (!task) {
      return { success: false, error: 'Task not found' };
    }

    // Verify task is claimable
    if (task.status !== 'open') {
      return { success: false, error: 'Task is not open' };
    }

    if (task.owner) {
      return { success: false, error: 'Task already claimed' };
    }

    // BUG FIX 1: Null domain tasks require Architect routing (per design)
    if (!task.metadata?.domain) {
      return { success: false, error: 'Task has no domain - requires Architect routing' };
    }

    // Verify domain match (per design: exact match required)
    if (task.metadata.domain !== domain) {
      return { success: false, error: 'Domain mismatch' };
    }

    // BUG FIX 2: Check blockedBy before allowing claim
    if (task.blockedBy && task.blockedBy.length > 0) {
      return { success: false, error: 'Task has unresolved blockers' };
    }

    // First-write-wins: claim the task
    task.status = 'claimed';
    task.owner = paneId;
    task.claimedAt = new Date().toISOString();

    // Save and broadcast
    saveTaskPool(taskPool);
    broadcastTaskUpdate();

    log.info('TaskPool', `Task ${taskId} claimed by pane ${paneId}`);

    // BUG FIX 3: Notify Architect on successful claim (per design protocol)
    const triggerPath = workspacePath
      ? path.join(workspacePath, 'triggers', 'architect.txt')
      : null;
    if (triggerPath) {
      try {
        const PANE_ROLES = { '1': 'ARCHITECT', '2': 'INFRA', '3': 'FRONTEND', '4': 'BACKEND', '5': 'ANALYST', '6': 'REVIEWER' };
        const role = PANE_ROLES[paneId] || `PANE-${paneId}`;
        const notification = `(${role} #AUTO): Claimed task #${taskId}: ${task.subject}\n`;
        fs.writeFileSync(triggerPath, notification);
        log.info('TaskPool', `Notified Architect of claim`);
      } catch (err) {
        log.warn('TaskPool', 'Failed to notify Architect:', err.message);
      }
    }

    return { success: true, task };
  });

  // Watch for external changes to task-pool.json
  if (TASK_POOL_FILE && ctx.watcher) {
    const watchDir = path.dirname(TASK_POOL_FILE);
    const watchFile = path.basename(TASK_POOL_FILE);

    // Add file to watch list if watcher supports it
    if (typeof ctx.watcher.addWatch === 'function') {
      ctx.watcher.addWatch(TASK_POOL_FILE, () => {
        const newTasks = loadTaskPool();
        if (JSON.stringify(newTasks) !== JSON.stringify(taskPool)) {
          taskPool = newTasks;
          broadcastTaskUpdate();
          log.info('TaskPool', 'Task pool updated from file');
        }
      });
    }
  }
}

module.exports = { registerTaskPoolHandlers };
