/**
 * Debug Replay System - Task #21
 *
 * Record, replay, and step through agent actions for debugging.
 * Leverages transcript-logger for action recording.
 *
 * Features:
 * - Load recorded sessions from transcripts
 * - Step-by-step action replay
 * - Timeline navigation (forward, backward, jump)
 * - Action filtering by type
 * - Breakpoints on specific action types
 * - Export sessions for sharing
 */

const fs = require('fs');
const path = require('path');
const memoryStore = require('./memory-store');
const log = require('../logger');
const { formatPrecise } = require('../formatters');

// ============================================================
// REPLAY STATE
// ============================================================

// Current replay session state
const replayState = {
  session: null,           // Current loaded session
  actions: [],             // Array of actions in chronological order
  currentIndex: -1,        // Current position in replay
  isPlaying: false,        // Auto-play mode
  playbackSpeed: 1,        // 1x, 2x, 0.5x speed multiplier
  breakpoints: new Set(),  // Action indices to pause at
  typeBreakpoints: new Set(), // Action types to pause at
  filter: 'all',           // Current type filter
  filteredActions: [],     // Filtered view of actions
  listeners: [],           // State change listeners
  playTimer: null          // Auto-play timer
};

// Action type categories for grouping
const ACTION_CATEGORIES = {
  communication: ['input', 'output', 'trigger_sent', 'trigger_received'],
  tools: ['tool_use', 'tool_result'],
  decisions: ['decision'],
  errors: ['error'],
  system: ['system', 'state']
};

// ============================================================
// SESSION LOADING
// ============================================================

/**
 * Load a replay session from transcript files
 * @param {string} role - Agent role (e.g., 'Architect', 'Implementer A')
 * @param {Object} options - Load options
 * @returns {Object} Session data
 */
function loadSession(role, options = {}) {
  const {
    startTime = null,    // ISO timestamp to start from
    endTime = null,      // ISO timestamp to end at
    limit = 1000,        // Max actions to load
    types = null         // Array of types to include
  } = options;

  try {
    // Read transcript entries
    const entries = memoryStore.readTranscript(role, { limit: limit * 2 });

    if (!entries || entries.length === 0) {
      return { success: false, error: 'No transcript data found', actions: [] };
    }

    // Filter by time range if specified
    let filtered = entries;
    if (startTime) {
      filtered = filtered.filter(e => e.timestamp >= startTime);
    }
    if (endTime) {
      filtered = filtered.filter(e => e.timestamp <= endTime);
    }

    // Filter by types if specified
    if (types && types.length > 0) {
      filtered = filtered.filter(e => types.includes(e.type));
    }

    // Limit results
    filtered = filtered.slice(0, limit);

    // Build session object
    const session = {
      id: `session-${Date.now()}`,
      role,
      startTime: filtered.length > 0 ? filtered[0].timestamp : null,
      endTime: filtered.length > 0 ? filtered[filtered.length - 1].timestamp : null,
      actionCount: filtered.length,
      loadedAt: new Date().toISOString()
    };

    // Enrich actions with indices and categorization
    const actions = filtered.map((entry, index) => ({
      ...entry,
      index,
      category: categorizeAction(entry.type),
      duration: index > 0 ? calculateDuration(filtered[index - 1].timestamp, entry.timestamp) : 0
    }));

    // Update replay state
    replayState.session = session;
    replayState.actions = actions;
    replayState.currentIndex = -1;
    replayState.filteredActions = [...actions];
    replayState.isPlaying = false;

    notifyListeners('session-loaded', { session, actionCount: actions.length });

    log.info('DebugReplay', `Loaded session for ${role}: ${actions.length} actions`);

    return {
      success: true,
      session,
      actions,
      stats: getSessionStats(actions)
    };
  } catch (err) {
    log.error('DebugReplay', `Failed to load session: ${err.message}`);
    return { success: false, error: err.message, actions: [] };
  }
}

/**
 * Load session for a specific time range across all agents
 * @param {string} startTime - ISO timestamp
 * @param {string} endTime - ISO timestamp
 * @returns {Object} Combined session data
 */
function loadTimeRangeSession(startTime, endTime) {
  const roles = ['Architect', 'Infra', 'Frontend', 'Backend', 'Analyst', 'Reviewer'];
  const allActions = [];

  for (const role of roles) {
    const entries = memoryStore.readTranscript(role, { limit: 5000 });
    const filtered = entries.filter(e =>
      e.timestamp >= startTime && e.timestamp <= endTime
    );

    // Add role info to each action
    filtered.forEach(entry => {
      allActions.push({
        ...entry,
        role,
        category: categorizeAction(entry.type)
      });
    });
  }

  // Sort by timestamp
  allActions.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Add indices
  allActions.forEach((action, index) => {
    action.index = index;
    action.duration = index > 0 ?
      calculateDuration(allActions[index - 1].timestamp, action.timestamp) : 0;
  });

  const session = {
    id: `session-multi-${Date.now()}`,
    role: 'All Agents',
    startTime,
    endTime,
    actionCount: allActions.length,
    loadedAt: new Date().toISOString()
  };

  replayState.session = session;
  replayState.actions = allActions;
  replayState.currentIndex = -1;
  replayState.filteredActions = [...allActions];

  notifyListeners('session-loaded', { session, actionCount: allActions.length });

  return {
    success: true,
    session,
    actions: allActions,
    stats: getSessionStats(allActions)
  };
}

// ============================================================
// REPLAY CONTROLS
// ============================================================

/**
 * Step to next action
 * @returns {Object|null} Current action or null if at end
 */
function stepForward() {
  if (replayState.currentIndex >= replayState.filteredActions.length - 1) {
    notifyListeners('replay-end', {});
    return null;
  }

  replayState.currentIndex++;
  const action = replayState.filteredActions[replayState.currentIndex];

  // Check breakpoints
  if (shouldPause(action)) {
    pause();
  }

  notifyListeners('step', { action, index: replayState.currentIndex });
  return action;
}

/**
 * Step to previous action
 * @returns {Object|null} Current action or null if at start
 */
function stepBackward() {
  if (replayState.currentIndex <= 0) {
    notifyListeners('replay-start', {});
    return null;
  }

  replayState.currentIndex--;
  const action = replayState.filteredActions[replayState.currentIndex];

  notifyListeners('step', { action, index: replayState.currentIndex });
  return action;
}

/**
 * Jump to specific action index
 * @param {number} index
 * @returns {Object|null} Action at index
 */
function jumpTo(index) {
  if (index < 0 || index >= replayState.filteredActions.length) {
    return null;
  }

  replayState.currentIndex = index;
  const action = replayState.filteredActions[index];

  notifyListeners('jump', { action, index });
  return action;
}

/**
 * Jump to action by timestamp
 * @param {string} timestamp - ISO timestamp
 * @returns {Object|null} Nearest action
 */
function jumpToTime(timestamp) {
  const targetTime = new Date(timestamp).getTime();
  let closestIndex = 0;
  let closestDiff = Infinity;

  replayState.filteredActions.forEach((action, index) => {
    const actionTime = new Date(action.timestamp).getTime();
    const diff = Math.abs(actionTime - targetTime);
    if (diff < closestDiff) {
      closestDiff = diff;
      closestIndex = index;
    }
  });

  return jumpTo(closestIndex);
}

/**
 * Start auto-play
 * @param {number} [speed=1] - Playback speed multiplier
 */
function play(speed = 1) {
  replayState.isPlaying = true;
  replayState.playbackSpeed = speed;

  scheduleNextStep();
  notifyListeners('play', { speed });
}

/**
 * Pause auto-play
 */
function pause() {
  replayState.isPlaying = false;
  if (replayState.playTimer) {
    clearTimeout(replayState.playTimer);
    replayState.playTimer = null;
  }

  notifyListeners('pause', {});
}

/**
 * Schedule next auto-play step
 */
function scheduleNextStep() {
  if (!replayState.isPlaying) return;
  if (replayState.currentIndex >= replayState.filteredActions.length - 1) {
    pause();
    return;
  }

  // Calculate delay based on action duration and playback speed
  const nextAction = replayState.filteredActions[replayState.currentIndex + 1];
  const baseDelay = Math.min(nextAction?.duration || 1000, 3000); // Max 3 seconds
  const delay = baseDelay / replayState.playbackSpeed;

  replayState.playTimer = setTimeout(() => {
    const action = stepForward();
    if (action && replayState.isPlaying) {
      scheduleNextStep();
    }
  }, Math.max(delay, 100)); // Min 100ms between steps
}

/**
 * Reset replay to beginning
 */
function reset() {
  pause();
  replayState.currentIndex = -1;
  notifyListeners('reset', {});
}

// ============================================================
// FILTERING
// ============================================================

/**
 * Set action type filter
 * @param {string} filter - 'all' or action type
 */
function setFilter(filter) {
  replayState.filter = filter;

  if (filter === 'all') {
    replayState.filteredActions = [...replayState.actions];
  } else if (ACTION_CATEGORIES[filter]) {
    // Filter by category
    const types = ACTION_CATEGORIES[filter];
    replayState.filteredActions = replayState.actions.filter(a =>
      types.includes(a.type) || types.includes(a.metadata?.messageType)
    );
  } else {
    // Filter by specific type
    replayState.filteredActions = replayState.actions.filter(a =>
      a.type === filter || a.metadata?.messageType === filter
    );
  }

  // Re-index filtered actions
  replayState.filteredActions.forEach((a, i) => a.filteredIndex = i);

  // Reset position
  replayState.currentIndex = -1;

  notifyListeners('filter-changed', {
    filter,
    count: replayState.filteredActions.length
  });
}

/**
 * Search actions by content
 * @param {string} query - Search query
 * @returns {Array} Matching actions
 */
function searchActions(query) {
  if (!query || query.length < 2) {
    return [];
  }

  const lowerQuery = query.toLowerCase();
  return replayState.actions.filter(action => {
    const content = (action.content || '').toLowerCase();
    const metadata = JSON.stringify(action.metadata || {}).toLowerCase();
    return content.includes(lowerQuery) || metadata.includes(lowerQuery);
  });
}

// ============================================================
// BREAKPOINTS
// ============================================================

/**
 * Add breakpoint at index
 * @param {number} index
 */
function addBreakpoint(index) {
  replayState.breakpoints.add(index);
  notifyListeners('breakpoint-added', { index });
}

/**
 * Remove breakpoint at index
 * @param {number} index
 */
function removeBreakpoint(index) {
  replayState.breakpoints.delete(index);
  notifyListeners('breakpoint-removed', { index });
}

/**
 * Add breakpoint on action type
 * @param {string} type
 */
function addTypeBreakpoint(type) {
  replayState.typeBreakpoints.add(type);
  notifyListeners('type-breakpoint-added', { type });
}

/**
 * Remove breakpoint on action type
 * @param {string} type
 */
function removeTypeBreakpoint(type) {
  replayState.typeBreakpoints.delete(type);
  notifyListeners('type-breakpoint-removed', { type });
}

/**
 * Check if should pause at action
 * @param {Object} action
 * @returns {boolean}
 */
function shouldPause(action) {
  if (replayState.breakpoints.has(action.index)) return true;
  if (replayState.typeBreakpoints.has(action.type)) return true;
  return false;
}

/**
 * Clear all breakpoints
 */
function clearBreakpoints() {
  replayState.breakpoints.clear();
  replayState.typeBreakpoints.clear();
  notifyListeners('breakpoints-cleared', {});
}

// ============================================================
// ANALYSIS
// ============================================================

/**
 * Get session statistics
 * @param {Array} actions
 * @returns {Object}
 */
function getSessionStats(actions) {
  const stats = {
    total: actions.length,
    byType: {},
    byCategory: {},
    duration: 0,
    errors: 0,
    toolUses: 0,
    decisions: 0
  };

  if (actions.length > 0) {
    stats.duration = calculateDuration(actions[0].timestamp, actions[actions.length - 1].timestamp);
  }

  for (const action of actions) {
    // Count by type
    stats.byType[action.type] = (stats.byType[action.type] || 0) + 1;

    // Count by category
    const cat = action.category || 'unknown';
    stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;

    // Special counters
    if (action.type === 'error') stats.errors++;
    if (action.type === 'tool_use') stats.toolUses++;
    if (action.type === 'decision') stats.decisions++;
  }

  return stats;
}

/**
 * Find related actions (e.g., tool_use and its tool_result)
 * @param {Object} action
 * @returns {Array} Related actions
 */
function findRelatedActions(action) {
  const related = [];

  if (action.type === 'tool_use' && action.metadata?.toolId) {
    // Find corresponding tool_result
    const result = replayState.actions.find(a =>
      a.type === 'tool_result' &&
      a.metadata?.toolId === action.metadata.toolId &&
      a.index > action.index
    );
    if (result) related.push(result);
  }

  if (action.type === 'tool_result' && action.metadata?.toolId) {
    // Find corresponding tool_use
    const use = replayState.actions.find(a =>
      a.type === 'tool_use' &&
      a.metadata?.toolId === action.metadata.toolId &&
      a.index < action.index
    );
    if (use) related.push(use);
  }

  // Find trigger pairs
  if (action.metadata?.messageType === 'trigger_sent') {
    const received = replayState.actions.find(a =>
      a.metadata?.messageType === 'trigger_received' &&
      a.content === action.content &&
      Math.abs(new Date(a.timestamp) - new Date(action.timestamp)) < 5000
    );
    if (received) related.push(received);
  }

  return related;
}

/**
 * Get action context (surrounding actions)
 * @param {number} index
 * @param {number} [range=5] - Actions before and after
 * @returns {Object}
 */
function getActionContext(index, range = 5) {
  const start = Math.max(0, index - range);
  const end = Math.min(replayState.actions.length, index + range + 1);

  return {
    before: replayState.actions.slice(start, index),
    current: replayState.actions[index],
    after: replayState.actions.slice(index + 1, end)
  };
}

// ============================================================
// EXPORT
// ============================================================

/**
 * Export session for sharing/analysis
 * @param {Object} options
 * @returns {Object}
 */
function exportSession(options = {}) {
  const { format = 'json', includeContent = true } = options;

  const exportData = {
    session: replayState.session,
    stats: getSessionStats(replayState.actions),
    exportedAt: new Date().toISOString(),
    actions: replayState.actions.map(action => {
      if (!includeContent) {
        return {
          index: action.index,
          type: action.type,
          timestamp: action.timestamp,
          category: action.category,
          paneId: action.paneId,
          role: action.role
        };
      }
      return action;
    })
  };

  if (format === 'json') {
    return JSON.stringify(exportData, null, 2);
  }

  // CSV format for spreadsheet analysis
  if (format === 'csv') {
    const headers = ['index', 'timestamp', 'type', 'category', 'role', 'content'];
    const rows = exportData.actions.map(a => [
      a.index,
      a.timestamp,
      a.type,
      a.category,
      a.role || '',
      `"${(a.content || '').replace(/"/g, '""').slice(0, 500)}"`
    ]);
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }

  return exportData;
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Categorize action type
 * @param {string} type
 * @returns {string}
 */
function categorizeAction(type) {
  for (const [category, types] of Object.entries(ACTION_CATEGORIES)) {
    if (types.includes(type)) return category;
  }
  return 'other';
}

/**
 * Calculate duration between timestamps
 * @param {string} start
 * @param {string} end
 * @returns {number} Milliseconds
 */
function calculateDuration(start, end) {
  return new Date(end) - new Date(start);
}

// formatDuration now imported as formatPrecise from ../formatters

// ============================================================
// EVENT SYSTEM
// ============================================================

/**
 * Add state change listener
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
function addListener(callback) {
  replayState.listeners.push(callback);
  return () => {
    const index = replayState.listeners.indexOf(callback);
    if (index >= 0) replayState.listeners.splice(index, 1);
  };
}

/**
 * Notify all listeners
 * @param {string} event
 * @param {Object} data
 */
function notifyListeners(event, data) {
  for (const listener of replayState.listeners) {
    try {
      listener(event, data);
    } catch (err) {
      log.error('DebugReplay', `Listener error: ${err.message}`);
    }
  }
}

// ============================================================
// STATE ACCESS
// ============================================================

/**
 * Get current replay state
 * @returns {Object}
 */
function getState() {
  return {
    hasSession: !!replayState.session,
    session: replayState.session,
    currentIndex: replayState.currentIndex,
    totalActions: replayState.filteredActions.length,
    isPlaying: replayState.isPlaying,
    playbackSpeed: replayState.playbackSpeed,
    filter: replayState.filter,
    breakpointCount: replayState.breakpoints.size + replayState.typeBreakpoints.size
  };
}

/**
 * Get current action
 * @returns {Object|null}
 */
function getCurrentAction() {
  if (replayState.currentIndex < 0 || replayState.currentIndex >= replayState.filteredActions.length) {
    return null;
  }
  return replayState.filteredActions[replayState.currentIndex];
}

/**
 * Get all actions (filtered)
 * @returns {Array}
 */
function getActions() {
  return replayState.filteredActions;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Session management
  loadSession,
  loadTimeRangeSession,
  exportSession,

  // Replay controls
  stepForward,
  stepBackward,
  jumpTo,
  jumpToTime,
  play,
  pause,
  reset,

  // Filtering
  setFilter,
  searchActions,

  // Breakpoints
  addBreakpoint,
  removeBreakpoint,
  addTypeBreakpoint,
  removeTypeBreakpoint,
  clearBreakpoints,

  // Analysis
  getSessionStats,
  findRelatedActions,
  getActionContext,

  // State
  getState,
  getCurrentAction,
  getActions,
  addListener,

  // Constants
  ACTION_CATEGORIES,

  // Helpers (re-export from formatters for API compatibility)
  formatDuration: formatPrecise
};
