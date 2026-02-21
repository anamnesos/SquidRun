/**
 * Task Pool IPC Handlers - Smart Parallelism Phase 3
 * Channels: get-task-list, claim-task, task-list-updated
 *
 * Provides task pool management for agent self-claim workflow.
 * Tasks are stored in .squidrun/task-pool.json with domain metadata.
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { WORKSPACE_PATH, resolveCoordPath, getCoordRoots } = require('../../config');
const teamMemory = require('../team-memory');
const {
  buildReadBeforeWorkQueryPayloads,
  pickTopClaims,
  formatReadBeforeWorkMessage,
  normalizeDomain,
  buildTaskStatusPatternEvent,
  buildTaskCloseClaimPayload,
} = require('../team-memory/daily-integration');

// In-memory task cache (loaded from file on startup)
let taskPool = [];
const VALID_STATUSES = new Set(['open', 'in_progress', 'completed', 'failed', 'needs_input']);
let activeTaskPoolBridge = null;

function getTaskPoolBridge() {
  return activeTaskPoolBridge;
}

function registerTaskPoolHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerTaskPoolHandlers requires ctx.ipcMain');
  }

  const { ipcMain, mainWindow } = ctx;
  const workspacePath = ctx.WORKSPACE_PATH;
  const hasCustomWorkspacePath = typeof workspacePath === 'string'
    && workspacePath.length > 0
    && path.resolve(workspacePath) !== path.resolve(WORKSPACE_PATH);
  const resolveCoordFile = (relPath, options = {}) => {
    if (hasCustomWorkspacePath) {
      return path.join(workspacePath, relPath);
    }
    if (typeof resolveCoordPath === 'function') {
      return resolveCoordPath(relPath, options);
    }
    const base = workspacePath || WORKSPACE_PATH;
    return base ? path.join(base, relPath) : null;
  };
  const getCoordWatchFiles = (relPath) => {
    if (hasCustomWorkspacePath) {
      return [path.join(workspacePath, relPath)];
    }
    if (typeof getCoordRoots === 'function') {
      return getCoordRoots({ includeLegacy: false, includeMissing: false })
        .map((root) => path.join(root, relPath));
    }
    const base = workspacePath || WORKSPACE_PATH;
    return base ? [path.join(base, relPath)] : [];
  };
  const TASK_POOL_FILE = resolveCoordFile('task-pool.json');
  const TASK_POOL_WRITE_FILE = resolveCoordFile('task-pool.json', { forWrite: true });
  const TASK_POOL_WATCH_FILES = Array.from(new Set(getCoordWatchFiles('task-pool.json')));
  const READ_BEFORE_WORK_LIMIT = Number.parseInt(process.env.SQUIDRUN_TEAM_MEMORY_READ_BEFORE_WORK_LIMIT || '3', 10);

  async function executeTeamMemory(action, payload) {
    try {
      return await teamMemory.executeTeamMemoryOperation(action, payload || {});
    } catch (err) {
      log.warn('TaskPool', `Team memory action '${action}' failed: ${err.message}`);
      return { ok: false, reason: 'team_memory_error', error: err.message };
    }
  }

  async function appendPatternEvent(event, label = 'pattern-event') {
    if (!event) return { ok: false, reason: 'event_missing' };
    try {
      const result = await teamMemory.appendPatternHookEvent(event);
      if (result?.ok === false) {
        log.warn('TaskPool', `Failed to append ${label}: ${result.reason || 'unknown'}`);
      }
      return result;
    } catch (err) {
      log.warn('TaskPool', `Failed to append ${label}: ${err.message}`);
      return { ok: false, reason: 'pattern_append_failed', error: err.message };
    }
  }

  async function loadReadBeforeWorkContext({ paneId, task, domain }) {
    const payloads = buildReadBeforeWorkQueryPayloads({
      task,
      paneId,
      domain,
      limit: 8,
      sessionsBack: 3,
    });
    if (payloads.length === 0) {
      return { ok: true, claims: [], message: null };
    }

    const claimGroups = [];
    for (const payload of payloads) {
      const result = await executeTeamMemory('query-claims', payload);
      if (!result?.ok || !Array.isArray(result?.claims) || result.claims.length === 0) {
        continue;
      }
      claimGroups.push(result.claims);
    }

    const claims = pickTopClaims(claimGroups, READ_BEFORE_WORK_LIMIT);
    const message = formatReadBeforeWorkMessage({ task, claims });
    return {
      ok: true,
      claims,
      message,
      total: claims.length,
    };
  }

  // Load task pool from file
  function loadTaskPool() {
    if (!TASK_POOL_FILE) return [];
    try {
      if (fs.existsSync(TASK_POOL_FILE)) {
        const content = fs.readFileSync(TASK_POOL_FILE, 'utf-8');
        const data = JSON.parse(content);
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        // Backward compat: normalize legacy status values
        return tasks.map(task => {
          if (task && task.status === 'claimed') {
            return { ...task, status: 'in_progress' };
          }
          return task;
        });
      }
    } catch (err) {
      log.error('TaskPool', 'Error loading task pool:', err.message);
    }
    return [];
  }

  // Save task pool to file
  function saveTaskPool(tasks) {
    if (!TASK_POOL_WRITE_FILE) return false;
    try {
      const data = {
        tasks,
        lastUpdated: new Date().toISOString()
      };
      fs.mkdirSync(path.dirname(TASK_POOL_WRITE_FILE), { recursive: true });
      fs.writeFileSync(TASK_POOL_WRITE_FILE, JSON.stringify(data, null, 2));
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

  async function claimTaskInternal(payload = {}) {
    const paneId = payload?.paneId;
    const taskId = payload?.taskId;
    const requestedDomain = normalizeDomain(payload?.domain || '');
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

    const taskDomain = normalizeDomain(task.metadata.domain || '');
    const effectiveDomain = requestedDomain || taskDomain;
    // Verify domain match (supports backend/infra alias normalization)
    if (!effectiveDomain || taskDomain !== effectiveDomain) {
      return { success: false, error: 'Domain mismatch' };
    }

    // BUG FIX 2: Check blockedBy before allowing claim
    if (task.blockedBy && task.blockedBy.length > 0) {
      return { success: false, error: 'Task has unresolved blockers' };
    }

    // First-write-wins: claim the task
    task.status = 'in_progress';
    task.owner = paneId;
    task.claimedAt = new Date().toISOString();

    // Save and broadcast
    saveTaskPool(taskPool);
    broadcastTaskUpdate();

    log.info('TaskPool', `Task ${taskId} claimed by pane ${paneId}`);

    const context = await loadReadBeforeWorkContext({
      paneId,
      task,
      domain: effectiveDomain,
    });
    if (context?.message && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inject-message', {
        panes: [String(paneId)],
        message: context.message,
      });
    }

    await appendPatternEvent(
      buildTaskStatusPatternEvent({
        task,
        status: 'in_progress',
        metadata: { domain: effectiveDomain },
        paneId,
      }),
      'task-claim'
    );

    return {
      success: true,
      task,
      memoryContext: {
        claimsUsed: Number(context?.total || 0),
      },
    };
  }

  async function updateTaskStatusInternal(payload = {}) {
    const targetId = payload.taskId;
    const nextStatus = payload.status;
    const meta = payload.metadata;

    if (!targetId || !nextStatus) {
      return { success: false, error: 'taskId and status are required' };
    }

    if (!VALID_STATUSES.has(nextStatus)) {
      return { success: false, error: 'Invalid status value' };
    }

    const task = taskPool.find(t => t.id === targetId);
    if (!task) {
      return { success: false, error: 'Task not found' };
    }

    if (nextStatus === 'failed') {
      const errorObj = meta && meta.error ? meta.error : null;
      if (!errorObj || typeof errorObj.message !== 'string' || !errorObj.message.trim()) {
        return { success: false, error: 'Failed status requires metadata.error.message' };
      }

      const at = errorObj.at || new Date().toISOString();
      task.metadata = {
        ...(task.metadata || {}),
        ...(meta || {}),
        error: { message: errorObj.message, at }
      };
      task.failedAt = at;
    } else {
      if (meta) {
        task.metadata = { ...(task.metadata || {}), ...meta };
      }

      if (nextStatus === 'completed') {
        task.completedAt = new Date().toISOString();
      } else if (nextStatus === 'needs_input') {
        task.needsInputAt = new Date().toISOString();
      }
    }

    task.status = nextStatus;
    task.updatedAt = new Date().toISOString();

    saveTaskPool(taskPool);
    broadcastTaskUpdate();

    log.info('TaskPool', `Task ${targetId} status -> ${nextStatus}`);

    const patternResult = await appendPatternEvent(
      buildTaskStatusPatternEvent({
        task,
        status: nextStatus,
        metadata: meta,
        paneId: task.owner || meta?.paneId || null,
      }),
      'task-status-change'
    );

    let claimResult = null;
    const claimPayload = buildTaskCloseClaimPayload({
      task,
      status: nextStatus,
      metadata: meta,
      paneId: task.owner || meta?.paneId || null,
      nowMs: Date.now(),
    });
    if (claimPayload) {
      claimResult = await executeTeamMemory('create-claim', claimPayload);
      if (claimResult?.ok === false) {
        log.warn(
          'TaskPool',
          `Failed task-close claim for ${targetId}: ${claimResult.reason || claimResult.error || 'unknown'}`
        );
      }
    }

    return {
      success: true,
      task,
      teamMemory: {
        patternQueued: Boolean(patternResult?.ok),
        claimWritten: Boolean(claimResult?.ok),
        claimStatus: claimResult?.status || null,
      },
    };
  }

  // Initialize task pool
  taskPool = loadTaskPool();
  log.info('TaskPool', `Loaded ${taskPool.length} tasks`);

  // Get current task list
  ipcMain.handle('get-task-list', () => {
    return taskPool;
  });

  // Claim a task for an agent
  ipcMain.handle('claim-task', async (event, { paneId, taskId, domain }) => {
    return claimTaskInternal({ paneId, taskId, domain });
  });

  // Update task status for completion/failure/needs_input
  ipcMain.handle('update-task-status', async (event, taskId, status, metadata) => {
    let payload = { taskId, status, metadata };
    if (taskId && typeof taskId === 'object') {
      payload = taskId;
    }
    return updateTaskStatusInternal(payload);
  });

  activeTaskPoolBridge = {
    claimTask: claimTaskInternal,
    updateTaskStatus: updateTaskStatusInternal,
  };

  // Watch for external changes to task-pool.json
  if (TASK_POOL_WATCH_FILES.length > 0 && ctx.watcher) {
    // Add file to watch list if watcher supports it
    if (typeof ctx.watcher.addWatch === 'function') {
      for (const taskPoolWatchFile of TASK_POOL_WATCH_FILES) {
        ctx.watcher.addWatch(taskPoolWatchFile, () => {
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
}


function unregisterTaskPoolHandlers(ctx) {
  const { ipcMain } = ctx || {};
  activeTaskPoolBridge = null;
  if (!ipcMain) return;
    ipcMain.removeHandler('get-task-list');
    ipcMain.removeHandler('claim-task');
    ipcMain.removeHandler('update-task-status');
}

registerTaskPoolHandlers.unregister = unregisterTaskPoolHandlers;
module.exports = {
  registerTaskPoolHandlers,
  getTaskPoolBridge,
};
