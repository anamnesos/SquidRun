/**
 * Debug Replay IPC Handlers - Task #21
 *
 * Channels:
 * - debug-load-session: Load transcript session for replay
 * - debug-step-forward: Step to next action
 * - debug-step-backward: Step to previous action
 * - debug-jump-to: Jump to specific action index
 * - debug-play: Start auto-play
 * - debug-pause: Pause auto-play
 * - debug-reset: Reset to beginning
 * - debug-set-filter: Set action type filter
 * - debug-search: Search actions
 * - debug-get-state: Get current replay state
 * - debug-get-action: Get current action details
 * - debug-add-breakpoint: Add breakpoint
 * - debug-export: Export session
 */

const path = require('path');

function registerDebugReplayHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain || !WORKSPACE_PATH) return;

  // Lazy load debug replay module
  let debugReplay = null;
  function getDebugReplay() {
    if (!debugReplay) {
      debugReplay = require('../memory/debug-replay');
    }
    return debugReplay;
  }

  /**
   * Load a replay session for an agent
   */
  ipcMain.handle('debug-load-session', async (event, payload = {}) => {
    const { role, startTime, endTime, limit, types } = payload;
    if (!role) {
      return { success: false, error: 'role required' };
    }

    try {
      const replay = getDebugReplay();
      const result = replay.loadSession(role, { startTime, endTime, limit, types });
      return result;
    } catch (err) {
      console.error('[DebugReplay] Load session error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Load session for time range across all agents
   */
  ipcMain.handle('debug-load-timerange', async (event, payload = {}) => {
    const { startTime, endTime } = payload;
    if (!startTime || !endTime) {
      return { success: false, error: 'startTime and endTime required' };
    }

    try {
      const replay = getDebugReplay();
      const result = replay.loadTimeRangeSession(startTime, endTime);
      return result;
    } catch (err) {
      console.error('[DebugReplay] Load timerange error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Step forward in replay
   */
  ipcMain.handle('debug-step-forward', async () => {
    try {
      const replay = getDebugReplay();
      const action = replay.stepForward();
      return {
        success: true,
        action,
        state: replay.getState()
      };
    } catch (err) {
      console.error('[DebugReplay] Step forward error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Step backward in replay
   */
  ipcMain.handle('debug-step-backward', async () => {
    try {
      const replay = getDebugReplay();
      const action = replay.stepBackward();
      return {
        success: true,
        action,
        state: replay.getState()
      };
    } catch (err) {
      console.error('[DebugReplay] Step backward error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Jump to specific action index
   */
  ipcMain.handle('debug-jump-to', async (event, payload = {}) => {
    const { index } = payload;
    if (index === undefined) {
      return { success: false, error: 'index required' };
    }

    try {
      const replay = getDebugReplay();
      const action = replay.jumpTo(index);
      return {
        success: true,
        action,
        state: replay.getState()
      };
    } catch (err) {
      console.error('[DebugReplay] Jump to error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Jump to timestamp
   */
  ipcMain.handle('debug-jump-to-time', async (event, payload = {}) => {
    const { timestamp } = payload;
    if (!timestamp) {
      return { success: false, error: 'timestamp required' };
    }

    try {
      const replay = getDebugReplay();
      const action = replay.jumpToTime(timestamp);
      return {
        success: true,
        action,
        state: replay.getState()
      };
    } catch (err) {
      console.error('[DebugReplay] Jump to time error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Start auto-play
   */
  ipcMain.handle('debug-play', async (event, payload = {}) => {
    const { speed = 1 } = payload;

    try {
      const replay = getDebugReplay();
      replay.play(speed);
      return {
        success: true,
        state: replay.getState()
      };
    } catch (err) {
      console.error('[DebugReplay] Play error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Pause auto-play
   */
  ipcMain.handle('debug-pause', async () => {
    try {
      const replay = getDebugReplay();
      replay.pause();
      return {
        success: true,
        state: replay.getState()
      };
    } catch (err) {
      console.error('[DebugReplay] Pause error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Reset to beginning
   */
  ipcMain.handle('debug-reset', async () => {
    try {
      const replay = getDebugReplay();
      replay.reset();
      return {
        success: true,
        state: replay.getState()
      };
    } catch (err) {
      console.error('[DebugReplay] Reset error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Set action type filter
   */
  ipcMain.handle('debug-set-filter', async (event, payload = {}) => {
    const { filter = 'all' } = payload;

    try {
      const replay = getDebugReplay();
      replay.setFilter(filter);
      return {
        success: true,
        state: replay.getState()
      };
    } catch (err) {
      console.error('[DebugReplay] Set filter error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Search actions
   */
  ipcMain.handle('debug-search', async (event, payload = {}) => {
    const { query } = payload;
    if (!query) {
      return { success: false, error: 'query required', results: [] };
    }

    try {
      const replay = getDebugReplay();
      const results = replay.searchActions(query);
      return {
        success: true,
        results,
        count: results.length
      };
    } catch (err) {
      console.error('[DebugReplay] Search error:', err);
      return { success: false, error: err.message, results: [] };
    }
  });

  /**
   * Get current replay state
   */
  ipcMain.handle('debug-get-state', async () => {
    try {
      const replay = getDebugReplay();
      return {
        success: true,
        state: replay.getState(),
        currentAction: replay.getCurrentAction()
      };
    } catch (err) {
      console.error('[DebugReplay] Get state error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get all actions (filtered)
   */
  ipcMain.handle('debug-get-actions', async () => {
    try {
      const replay = getDebugReplay();
      const actions = replay.getActions();
      return {
        success: true,
        actions,
        count: actions.length
      };
    } catch (err) {
      console.error('[DebugReplay] Get actions error:', err);
      return { success: false, error: err.message, actions: [] };
    }
  });

  /**
   * Get action context (surrounding actions)
   */
  ipcMain.handle('debug-get-context', async (event, payload = {}) => {
    const { index, range = 5 } = payload;
    if (index === undefined) {
      return { success: false, error: 'index required' };
    }

    try {
      const replay = getDebugReplay();
      const context = replay.getActionContext(index, range);
      const related = replay.findRelatedActions(context.current);
      return {
        success: true,
        context,
        related
      };
    } catch (err) {
      console.error('[DebugReplay] Get context error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Add breakpoint at index
   */
  ipcMain.handle('debug-add-breakpoint', async (event, payload = {}) => {
    const { index, type } = payload;

    try {
      const replay = getDebugReplay();
      if (index !== undefined) {
        replay.addBreakpoint(index);
      }
      if (type) {
        replay.addTypeBreakpoint(type);
      }
      return { success: true, state: replay.getState() };
    } catch (err) {
      console.error('[DebugReplay] Add breakpoint error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Remove breakpoint
   */
  ipcMain.handle('debug-remove-breakpoint', async (event, payload = {}) => {
    const { index, type } = payload;

    try {
      const replay = getDebugReplay();
      if (index !== undefined) {
        replay.removeBreakpoint(index);
      }
      if (type) {
        replay.removeTypeBreakpoint(type);
      }
      return { success: true, state: replay.getState() };
    } catch (err) {
      console.error('[DebugReplay] Remove breakpoint error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Clear all breakpoints
   */
  ipcMain.handle('debug-clear-breakpoints', async () => {
    try {
      const replay = getDebugReplay();
      replay.clearBreakpoints();
      return { success: true, state: replay.getState() };
    } catch (err) {
      console.error('[DebugReplay] Clear breakpoints error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Export session
   */
  ipcMain.handle('debug-export', async (event, payload = {}) => {
    const { format = 'json', includeContent = true } = payload;

    try {
      const replay = getDebugReplay();
      const exported = replay.exportSession({ format, includeContent });
      return {
        success: true,
        data: exported,
        format
      };
    } catch (err) {
      console.error('[DebugReplay] Export error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get session statistics
   */
  ipcMain.handle('debug-get-stats', async () => {
    try {
      const replay = getDebugReplay();
      const actions = replay.getActions();
      const stats = replay.getSessionStats(actions);
      return {
        success: true,
        stats
      };
    } catch (err) {
      console.error('[DebugReplay] Get stats error:', err);
      return { success: false, error: err.message };
    }
  });
}


function unregisterDebugReplayHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('debug-load-session');
    ipcMain.removeHandler('debug-load-timerange');
    ipcMain.removeHandler('debug-step-forward');
    ipcMain.removeHandler('debug-step-backward');
    ipcMain.removeHandler('debug-jump-to');
    ipcMain.removeHandler('debug-jump-to-time');
    ipcMain.removeHandler('debug-play');
    ipcMain.removeHandler('debug-pause');
    ipcMain.removeHandler('debug-reset');
    ipcMain.removeHandler('debug-set-filter');
    ipcMain.removeHandler('debug-search');
    ipcMain.removeHandler('debug-get-state');
    ipcMain.removeHandler('debug-get-actions');
    ipcMain.removeHandler('debug-get-context');
    ipcMain.removeHandler('debug-add-breakpoint');
    ipcMain.removeHandler('debug-remove-breakpoint');
    ipcMain.removeHandler('debug-clear-breakpoints');
    ipcMain.removeHandler('debug-export');
    ipcMain.removeHandler('debug-get-stats');
}

registerDebugReplayHandlers.unregister = unregisterDebugReplayHandlers;
module.exports = { registerDebugReplayHandlers };
