/**
 * Mobile API IPC Handlers (Task #17: Mobile Companion App)
 *
 * Channels:
 *  - mobile-api-start
 *  - mobile-api-stop
 *  - mobile-api-get-state
 *  - mobile-api-create-session
 *  - mobile-api-revoke-session
 *  - mobile-api-get-sessions
 *  - mobile-api-get-subscriptions
 *  - mobile-api-send-notification
 *  - mobile-api-get-qr-code
 *  - mobile-api-update-settings
 *
 * Events (to renderer):
 *  - mobile-api-started
 *  - mobile-api-stopped
 *  - mobile-api-session-created
 *  - mobile-api-client-connected
 *  - mobile-api-notification-sent
 */

const {
  getMobileApiServer,
  resetMobileApiServer,
  NotificationType,
} = require('../mobile/mobile-api-server');
const log = require('../logger');

function registerMobileApiHandlers(ctx) {
  const { ipcMain } = ctx;
  let apiServer = null;

  // Initialize server with context getters
  const getServer = () => {
    if (!apiServer) {
      apiServer = getMobileApiServer({
        getAgentStatus: () => getAgentStatusFromContext(ctx),
        getSystemStatus: () => getSystemStatusFromContext(ctx),
        executeCommand: (agentId, command, options) => executeAgentCommand(ctx, agentId, command, options),
      });
      setupEventForwarding();
    }
    return apiServer;
  };

  // Forward server events to renderer
  const setupEventForwarding = () => {
    const server = apiServer;
    if (!server) return;

    const sendToRenderer = (channel, data) => {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send(channel, data);
      }
    };

    server.on('started', (data) => {
      sendToRenderer('mobile-api-started', data);
    });

    server.on('stopped', () => {
      sendToRenderer('mobile-api-stopped', {});
    });

    server.on('session_created', (data) => {
      sendToRenderer('mobile-api-session-created', data);
    });

    server.on('push_registered', (data) => {
      sendToRenderer('mobile-api-push-registered', data);
    });

    server.on('push_unregistered', (id) => {
      sendToRenderer('mobile-api-push-unregistered', { id });
    });

    server.on('quick_sync', () => {
      // Trigger sync across all agents
      sendToRenderer('mobile-api-quick-sync', {});
    });

    server.on('quick_broadcast', (message) => {
      sendToRenderer('mobile-api-quick-broadcast', { message });
    });

    server.on('build_trigger', (data) => {
      sendToRenderer('mobile-api-build-trigger', data);
    });

    server.on('send_push', (data) => {
      // This would connect to actual push notification service
      // For now, just log and emit
      log.info('MobileAPIHandlers', `Push notification: ${data.notification.type}`);
      sendToRenderer('mobile-api-notification-sent', data);
    });

    server.on('error', (error) => {
      sendToRenderer('mobile-api-error', { error: error.message });
    });
  };

  // ==========================================
  // Server Control
  // ==========================================

  ipcMain.handle('mobile-api-start', async (event, payload = {}) => {
    try {
      const server = getServer();

      if (payload.port) {
        server.port = payload.port;
      }

      const result = await server.start();
      log.info('MobileAPIHandlers', `Server start result: ${result.success}`);
      return result;
    } catch (error) {
      log.error('MobileAPIHandlers', 'Start error:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mobile-api-stop', async () => {
    try {
      if (!apiServer) {
        return { success: false, error: 'Server not initialized' };
      }
      const result = await apiServer.stop();
      return result;
    } catch (error) {
      log.error('MobileAPIHandlers', 'Stop error:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mobile-api-get-state', () => {
    if (!apiServer) {
      return {
        success: true,
        state: {
          isRunning: false,
          port: 8080,
          sessionCount: 0,
          pushSubscriptionCount: 0,
          sseClientCount: 0,
        },
      };
    }
    return { success: true, state: apiServer.getState() };
  });

  // ==========================================
  // Session Management
  // ==========================================

  ipcMain.handle('mobile-api-create-session', async (event, payload = {}) => {
    try {
      const server = getServer();

      const apiKey = require('crypto').randomBytes(32).toString('hex');
      const session = {
        id: require('crypto').randomBytes(16).toString('hex'),
        apiKey,
        deviceName: payload.deviceName || 'Manual Session',
        platform: payload.platform || 'manual',
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        permissions: payload.permissions || ['read', 'command'],
      };

      server.sessions.set(session.id, session);
      server.apiKeys.set(apiKey, session);

      log.info('MobileAPIHandlers', `Session created: ${session.id}`);
      return { success: true, session: { ...session, apiKey } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('mobile-api-revoke-session', (event, payload = {}) => {
    if (!apiServer || !payload.sessionId) {
      return { success: false, error: 'Invalid request' };
    }

    const session = apiServer.sessions.get(payload.sessionId);
    if (session) {
      apiServer.apiKeys.delete(session.apiKey);
      apiServer.sessions.delete(payload.sessionId);
      return { success: true };
    }
    return { success: false, error: 'Session not found' };
  });

  ipcMain.handle('mobile-api-get-sessions', () => {
    if (!apiServer) {
      return { success: true, sessions: [] };
    }

    const sessions = Array.from(apiServer.sessions.values()).map(s => ({
      id: s.id,
      deviceName: s.deviceName,
      platform: s.platform,
      createdAt: s.createdAt,
      lastUsed: s.lastUsed,
      permissions: s.permissions,
    }));

    return { success: true, sessions };
  });

  // ==========================================
  // Push Notifications
  // ==========================================

  ipcMain.handle('mobile-api-get-subscriptions', () => {
    if (!apiServer) {
      return { success: true, subscriptions: [] };
    }

    const subscriptions = Array.from(apiServer.pushSubscriptions.values()).map(s => ({
      id: s.id,
      platform: s.platform,
      deviceName: s.deviceName,
      preferences: s.preferences,
      createdAt: s.createdAt,
      lastUsed: s.lastUsed,
    }));

    return { success: true, subscriptions };
  });

  ipcMain.handle('mobile-api-send-notification', async (event, payload = {}) => {
    if (!apiServer) {
      return { success: false, error: 'Server not running' };
    }

    const { type, data } = payload;
    if (!type) {
      return { success: false, error: 'Notification type required' };
    }

    await apiServer.sendPushNotification(type, data);
    return { success: true };
  });

  // ==========================================
  // QR Code Generation
  // ==========================================

  ipcMain.handle('mobile-api-get-qr-code', async (event, payload = {}) => {
    if (!apiServer) {
      return { success: false, error: 'Server not running' };
    }

    const state = apiServer.getState();
    if (!state.isRunning) {
      return { success: false, error: 'Server not running' };
    }

    // Get local IP address
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let localIp = 'localhost';

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIp = iface.address;
          break;
        }
      }
    }

    // Generate connection data for QR code
    const connectionData = {
      host: localIp,
      port: state.port,
      protocol: 'http',
      version: require('../mobile/mobile-api-server').API_VERSION,
    };

    // If session requested, create one and include API key
    if (payload.includeSession) {
      const apiKey = require('crypto').randomBytes(32).toString('hex');
      const session = {
        id: require('crypto').randomBytes(16).toString('hex'),
        apiKey,
        deviceName: 'QR Code Session',
        platform: 'mobile',
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        permissions: ['read', 'command'],
      };

      apiServer.sessions.set(session.id, session);
      apiServer.apiKeys.set(apiKey, session);

      connectionData.apiKey = apiKey;
      connectionData.sessionId = session.id;
    }

    // Return data that can be encoded into QR code
    const qrData = JSON.stringify(connectionData);
    const qrUrl = `hivemind://connect?data=${encodeURIComponent(qrData)}`;

    return {
      success: true,
      qrData,
      qrUrl,
      connectionInfo: {
        host: localIp,
        port: state.port,
        apiEndpoint: `http://${localIp}:${state.port}/api/v1`,
      },
    };
  });

  // ==========================================
  // Settings
  // ==========================================

  ipcMain.handle('mobile-api-update-settings', (event, payload = {}) => {
    if (!apiServer) {
      return { success: false, error: 'Server not initialized' };
    }

    if (payload.rateLimit !== undefined) {
      apiServer.rateLimit = payload.rateLimit;
    }

    if (payload.authMethod !== undefined) {
      apiServer.authMethod = payload.authMethod;
    }

    return { success: true };
  });

  // ==========================================
  // Cleanup
  // ==========================================

  ipcMain.handle('mobile-api-reset', () => {
    if (apiServer) {
      apiServer.stop();
      apiServer = null;
    }
    resetMobileApiServer();
    return { success: true };
  });

  // ==========================================
  // Notification type constants
  // ==========================================

  ipcMain.handle('mobile-api-get-notification-types', () => {
    return { success: true, types: NotificationType };
  });
}

// ==========================================
// Helper Functions
// ==========================================

function getAgentStatusFromContext(ctx) {
  // Get agent status from various sources
  const agents = {};

  // Try to get from watcher state
  if (ctx.watcher?.readState) {
    const state = ctx.watcher.readState();
    if (state?.agents) {
      Object.assign(agents, state.agents);
    }
  }

  // Default agent structure
  for (let i = 1; i <= 6; i++) {
    if (!agents[`pane-${i}`]) {
      agents[`pane-${i}`] = {
        id: `pane-${i}`,
        status: 'unknown',
        role: getAgentRole(i),
        lastActivity: null,
      };
    }
  }

  return agents;
}

function getAgentRole(paneIndex) {
  const roles = {
    1: 'Architect',
    2: 'Infra',
    3: 'Frontend',
    4: 'Backend',
    5: 'Analyst',
    6: 'Reviewer',
  };
  return roles[paneIndex] || `Agent ${paneIndex}`;
}

function getSystemStatusFromContext(ctx) {
  return {
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    platform: process.platform,
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
  };
}

async function executeAgentCommand(ctx, agentId, command, options = {}) {
  // This would connect to terminal/PTY to send commands
  log.info('MobileAPIHandlers', `Execute command on ${agentId}: ${command}`);

  // Emit event for renderer to handle
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.webContents.send('mobile-api-execute-command', {
      agentId,
      command,
      options,
    });
  }

  return { success: true, message: 'Command sent' };
}

module.exports = { registerMobileApiHandlers };
