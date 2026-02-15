/**
 * Organic UI IPC Handlers
 * Provides events for the organic bubble UI to visualize agent states and message routing.
 *
 * Events emitted to renderer:
 * - agent-state-changed: { agentId, state, previousState, timestamp }
 * - message-routing: { messageId, from, to, phase, timestamp }
 * - agent-online: { agentId, role, timestamp }
 * - agent-offline: { agentId, role, timestamp }
 *
 * States: 'offline' | 'idle' | 'thinking' | 'active' | 'receiving'
 * Phases: 'queued' | 'sending' | 'delivered' | 'failed'
 */

const log = require('../logger');
const { PANE_ROLES } = require('../../config');

// Agent state tracking
const agentStates = new Map([
  ['1', 'offline'],
  ['2', 'offline'],
  ['5', 'offline'],
]);

// Short role names for UI
const SHORT_ROLES = {
  '1': 'arch',
  '2': 'builder',
  '5': 'oracle',
};

// Active message routes for tracking in-flight messages
const activeRoutes = new Map();

// Idle timers for auto-transition from active to idle
const idleTimers = new Map();
const IDLE_TIMEOUT_MS = 2000; // 2 seconds of no activity = idle

let mainWindow = null;
let ipcMain = null;

/**
 * Emit event to renderer if window is available
 */
function emit(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, {
      ...data,
      timestamp: Date.now(),
    });
  }
}

/**
 * Update agent state and emit event
 * @param {string} agentId - Pane ID ('1', '2', '5')
 * @param {string} newState - New state
 */
function setAgentState(agentId, newState) {
  const previousState = agentStates.get(agentId);
  if (previousState === newState) return; // No change

  agentStates.set(agentId, newState);

  log.info('OrganicUI', `Agent ${SHORT_ROLES[agentId]} state: ${previousState} -> ${newState}`);

  emit('agent-state-changed', {
    agentId,
    role: SHORT_ROLES[agentId],
    state: newState,
    previousState,
  });
}

/**
 * Get current state of an agent
 * @param {string} agentId - Pane ID
 * @returns {string} Current state
 */
function getAgentState(agentId) {
  return agentStates.get(agentId) || 'offline';
}

/**
 * Get all agent states
 * @returns {Object} Map of agentId -> state
 */
function getAllAgentStates() {
  const states = {};
  for (const [id, state] of agentStates) {
    states[id] = {
      state,
      role: SHORT_ROLES[id],
      fullRole: PANE_ROLES[id],
    };
  }
  return states;
}

/**
 * Mark agent as online (spawned/ready)
 * @param {string} agentId - Pane ID
 */
function agentOnline(agentId) {
  const wasOffline = agentStates.get(agentId) === 'offline';

  setAgentState(agentId, 'idle');

  if (wasOffline) {
    log.info('OrganicUI', `Agent ${SHORT_ROLES[agentId]} online`);
    emit('agent-online', {
      agentId,
      role: SHORT_ROLES[agentId],
      fullRole: PANE_ROLES[agentId],
    });
  }
}

/**
 * Mark agent as offline (exited/killed)
 * @param {string} agentId - Pane ID
 */
function agentOffline(agentId) {
  const wasOnline = agentStates.get(agentId) !== 'offline';

  setAgentState(agentId, 'offline');

  if (wasOnline) {
    log.info('OrganicUI', `Agent ${SHORT_ROLES[agentId]} offline`);
    emit('agent-offline', {
      agentId,
      role: SHORT_ROLES[agentId],
      fullRole: PANE_ROLES[agentId],
    });
  }
}

/**
 * Mark agent as thinking (processing, generating response)
 * @param {string} agentId - Pane ID
 */
function agentThinking(agentId) {
  if (agentStates.get(agentId) === 'offline') {
    agentOnline(agentId);
  }
  setAgentState(agentId, 'thinking');
}

/**
 * Mark agent as active (speaking, outputting)
 * @param {string} agentId - Pane ID
 */
function agentActive(agentId) {
  if (agentStates.get(agentId) === 'offline') {
    agentOnline(agentId);
  }
  setAgentState(agentId, 'active');

  // Reset idle timer - agent goes idle after no output for IDLE_TIMEOUT_MS
  if (idleTimers.has(agentId)) {
    clearTimeout(idleTimers.get(agentId));
  }
  idleTimers.set(agentId, setTimeout(() => {
    if (agentStates.get(agentId) === 'active') {
      setAgentState(agentId, 'idle');
    }
    idleTimers.delete(agentId);
  }, IDLE_TIMEOUT_MS));
}

/**
 * Mark agent as receiving (incoming message)
 * @param {string} agentId - Pane ID
 */
function agentReceiving(agentId) {
  if (agentStates.get(agentId) === 'offline') {
    agentOnline(agentId);
  }
  setAgentState(agentId, 'receiving');

  // Auto-transition to thinking after brief receiving state
  setTimeout(() => {
    if (agentStates.get(agentId) === 'receiving') {
      setAgentState(agentId, 'thinking');
    }
  }, 500);
}

/**
 * Mark agent as idle (waiting for input)
 * @param {string} agentId - Pane ID
 */
function agentIdle(agentId) {
  if (agentStates.get(agentId) === 'offline') {
    agentOnline(agentId);
  }
  setAgentState(agentId, 'idle');
}

/**
 * Track message routing - called when message enters queue
 * @param {string} messageId - Unique message ID
 * @param {string} from - Source agent ID
 * @param {string} to - Target agent ID
 */
function messageQueued(messageId, from, to) {
  activeRoutes.set(messageId, { from, to, phase: 'queued', startTime: Date.now() });

  log.info('OrganicUI', `Message ${messageId}: ${SHORT_ROLES[from]} -> ${SHORT_ROLES[to]} [queued]`);

  emit('message-routing', {
    messageId,
    from,
    fromRole: SHORT_ROLES[from],
    to,
    toRole: SHORT_ROLES[to],
    phase: 'queued',
  });
}

/**
 * Track message routing - called when message is being sent
 * @param {string} messageId - Unique message ID
 */
function messageSending(messageId) {
  const route = activeRoutes.get(messageId);
  if (!route) return;

  route.phase = 'sending';

  log.info('OrganicUI', `Message ${messageId}: ${SHORT_ROLES[route.from]} -> ${SHORT_ROLES[route.to]} [sending]`);

  emit('message-routing', {
    messageId,
    from: route.from,
    fromRole: SHORT_ROLES[route.from],
    to: route.to,
    toRole: SHORT_ROLES[route.to],
    phase: 'sending',
  });

  // Mark target as receiving
  agentReceiving(route.to);
}

/**
 * Track message routing - called when message is delivered
 * @param {string} messageId - Unique message ID
 */
function messageDelivered(messageId) {
  const route = activeRoutes.get(messageId);
  if (!route) return;

  route.phase = 'delivered';
  const duration = Date.now() - route.startTime;

  log.info('OrganicUI', `Message ${messageId}: ${SHORT_ROLES[route.from]} -> ${SHORT_ROLES[route.to]} [delivered in ${duration}ms]`);

  emit('message-routing', {
    messageId,
    from: route.from,
    fromRole: SHORT_ROLES[route.from],
    to: route.to,
    toRole: SHORT_ROLES[route.to],
    phase: 'delivered',
    duration,
  });

  // Cleanup after animation completes
  setTimeout(() => activeRoutes.delete(messageId), 2000);
}

/**
 * Track message routing - called when message fails
 * @param {string} messageId - Unique message ID
 * @param {string} error - Error message
 */
function messageFailed(messageId, error) {
  const route = activeRoutes.get(messageId);
  if (!route) return;

  route.phase = 'failed';

  log.warn('OrganicUI', `Message ${messageId}: ${SHORT_ROLES[route.from]} -> ${SHORT_ROLES[route.to]} [failed: ${error}]`);

  emit('message-routing', {
    messageId,
    from: route.from,
    fromRole: SHORT_ROLES[route.from],
    to: route.to,
    toRole: SHORT_ROLES[route.to],
    phase: 'failed',
    error,
  });

  // Cleanup
  setTimeout(() => activeRoutes.delete(messageId), 2000);
}

/**
 * Register IPC handlers
 */
function registerOrganicUIHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerOrganicUIHandlers requires ctx.ipcMain');
  }

  mainWindow = ctx.mainWindow;
  ipcMain = ctx.ipcMain;

  // Get all agent states
  ipcMain.handle('organic:get-agent-states', () => {
    return {
      success: true,
      states: getAllAgentStates(),
    };
  });

  // Get single agent state
  ipcMain.handle('organic:get-agent-state', (event, agentId) => {
    return {
      success: true,
      agentId,
      state: getAgentState(agentId),
      role: SHORT_ROLES[agentId],
    };
  });

  // Manually set agent state (for renderer-driven updates)
  ipcMain.handle('organic:set-agent-state', (event, agentId, state) => {
    setAgentState(agentId, state);
    return { success: true };
  });

  // Get active message routes (for reconnecting UI)
  ipcMain.handle('organic:get-active-routes', () => {
    const routes = [];
    for (const [messageId, route] of activeRoutes) {
      routes.push({
        messageId,
        from: route.from,
        fromRole: SHORT_ROLES[route.from],
        to: route.to,
        toRole: SHORT_ROLES[route.to],
        phase: route.phase,
      });
    }
    return {
      success: true,
      routes,
    };
  });

  log.info('OrganicUI', 'Handlers registered');
}

function unregisterOrganicUIHandlers(ctx) {
  // Clear all active idle timers
  for (const timer of idleTimers.values()) {
    clearTimeout(timer);
  }
  idleTimers.clear();
  activeRoutes.clear();

  const { ipcMain } = ctx;
  if (ipcMain) {
    ipcMain.removeHandler('organic:get-agent-states');
    ipcMain.removeHandler('organic:get-agent-state');
    ipcMain.removeHandler('organic:set-agent-state');
    ipcMain.removeHandler('organic:get-active-routes');
  }
  log.info('OrganicUI', 'Handlers unregistered');
}

registerOrganicUIHandlers.unregister = unregisterOrganicUIHandlers;

module.exports = {
  registerOrganicUIHandlers,
  // State management
  setAgentState,
  getAgentState,
  getAllAgentStates,
  // Agent lifecycle
  agentOnline,
  agentOffline,
  agentThinking,
  agentActive,
  agentReceiving,
  agentIdle,
  // Message routing
  messageQueued,
  messageSending,
  messageDelivered,
  messageFailed,
  // Constants
  SHORT_ROLES,
};
