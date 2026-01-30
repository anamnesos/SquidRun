/**
 * Collaboration IPC Handlers (Task #11: Real-time Collaboration)
 *
 * Channels:
 *  - collab-create-session
 *  - collab-join-session
 *  - collab-leave-session
 *  - collab-get-state
 *  - collab-get-users
 *  - collab-update-profile
 *  - collab-send-chat
 *  - collab-get-chat-history
 *  - collab-sync-cursor
 *  - collab-sync-terminal
 *  - collab-sync-settings
 *  - collab-set-user-role
 *  - collab-kick-user
 *  - collab-request-sync
 *  - collab-get-invite-link
 *  - collab-update-session-settings
 *
 * Events (to renderer):
 *  - collab-user-joined
 *  - collab-user-left
 *  - collab-cursor-update
 *  - collab-terminal-sync
 *  - collab-settings-sync
 *  - collab-chat-message
 *  - collab-connection-state
 *  - collab-session-ended
 *  - collab-error
 */

const {
  getCollaborationManager,
  resetCollaborationManager,
  CollabRole,
} = require('../collaboration/collaboration-manager');
const log = require('../logger');

function registerCollaborationHandlers(ctx) {
  const { ipcMain } = ctx;
  let collabManager = null;

  // Initialize collaboration manager
  const getManager = () => {
    if (!collabManager) {
      collabManager = getCollaborationManager({
        userName: ctx.getUserName?.() || 'User',
      });
      setupEventForwarding();
    }
    return collabManager;
  };

  // Forward collaboration events to renderer
  const setupEventForwarding = () => {
    const manager = collabManager;
    if (!manager) return;

    const sendToRenderer = (channel, data) => {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send(channel, data);
      }
    };

    manager.on('session_created', (session) => {
      sendToRenderer('collab-session-created', session);
    });

    manager.on('session_joined', (session) => {
      sendToRenderer('collab-session-joined', session);
    });

    manager.on('session_left', (data) => {
      sendToRenderer('collab-session-left', data);
    });

    manager.on('session_ended', (data) => {
      sendToRenderer('collab-session-ended', data);
    });

    manager.on('user_joined', (user) => {
      sendToRenderer('collab-user-joined', user);
      log.info('CollabHandlers', `User ${user.name} joined`);
    });

    manager.on('user_left', (data) => {
      sendToRenderer('collab-user-left', data);
      log.info('CollabHandlers', `User ${data.userId} left`);
    });

    manager.on('user_kicked', (data) => {
      sendToRenderer('collab-user-kicked', data);
    });

    manager.on('user_role_changed', (data) => {
      sendToRenderer('collab-user-role-changed', data);
    });

    manager.on('cursor_update', (data) => {
      sendToRenderer('collab-cursor-update', data);
    });

    manager.on('terminal_sync', (data) => {
      sendToRenderer('collab-terminal-sync', data);
    });

    manager.on('remote_terminal_input', (data) => {
      sendToRenderer('collab-remote-input', data);
    });

    manager.on('remote_settings_change', (data) => {
      sendToRenderer('collab-settings-sync', data);
    });

    manager.on('remote_agent_state', (data) => {
      sendToRenderer('collab-agent-state', data);
    });

    manager.on('chat_message', (message) => {
      sendToRenderer('collab-chat-message', message);
    });

    manager.on('chat_history', (history) => {
      sendToRenderer('collab-chat-history', history);
    });

    manager.on('connection_state', (state) => {
      sendToRenderer('collab-connection-state', { state });
    });

    manager.on('sync_complete', (data) => {
      sendToRenderer('collab-sync-complete', data);
    });

    manager.on('error', (error) => {
      sendToRenderer('collab-error', error);
      log.error('CollabHandlers', 'Collaboration error:', error);
    });

    manager.on('reconnected', () => {
      sendToRenderer('collab-reconnected', {});
    });

    manager.on('disconnected', () => {
      sendToRenderer('collab-disconnected', {});
    });
  };

  // ==========================================
  // Session Management
  // ==========================================

  ipcMain.handle('collab-create-session', async (event, payload = {}) => {
    try {
      const manager = getManager();
      const result = await manager.createSession({
        name: payload.name,
        port: payload.port,
        allowEditing: payload.allowEditing,
        allowChat: payload.allowChat,
        syncTerminals: payload.syncTerminals,
        syncSettings: payload.syncSettings,
        requireApproval: payload.requireApproval,
        maxUsers: payload.maxUsers,
      });

      log.info('CollabHandlers', `Create session result: ${result.success}`);
      return result;
    } catch (error) {
      log.error('CollabHandlers', 'Create session error:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('collab-join-session', async (event, payload = {}) => {
    try {
      const manager = getManager();
      const result = await manager.joinSession({
        host: payload.host || 'localhost',
        port: payload.port,
        sessionId: payload.sessionId,
        inviteCode: payload.inviteCode,
      });

      log.info('CollabHandlers', `Join session result: ${result.success}`);
      return result;
    } catch (error) {
      log.error('CollabHandlers', 'Join session error:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('collab-leave-session', async () => {
    try {
      if (!collabManager) {
        return { success: false, error: 'Not in a session' };
      }
      const result = await collabManager.leaveSession();
      return result;
    } catch (error) {
      log.error('CollabHandlers', 'Leave session error:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('collab-get-state', () => {
    if (!collabManager) {
      return {
        success: true,
        state: {
          session: null,
          users: [],
          connectionState: 'disconnected',
          isHost: false,
        },
      };
    }
    return { success: true, state: collabManager.getState() };
  });

  ipcMain.handle('collab-get-users', () => {
    if (!collabManager) {
      return { success: true, users: [] };
    }
    return { success: true, users: collabManager.getUserList() };
  });

  // ==========================================
  // User Management
  // ==========================================

  ipcMain.handle('collab-update-profile', (event, payload = {}) => {
    if (!collabManager) {
      return { success: false, error: 'Not in a session' };
    }
    collabManager.updateProfile(payload.name, payload.color);
    return { success: true };
  });

  ipcMain.handle('collab-set-user-role', (event, payload = {}) => {
    if (!collabManager) {
      return { success: false, error: 'Not in a session' };
    }
    return collabManager.setUserRole(payload.userId, payload.role);
  });

  ipcMain.handle('collab-kick-user', (event, payload = {}) => {
    if (!collabManager) {
      return { success: false, error: 'Not in a session' };
    }
    return collabManager.kickUser(payload.userId);
  });

  // ==========================================
  // Chat
  // ==========================================

  ipcMain.handle('collab-send-chat', (event, payload = {}) => {
    if (!collabManager) {
      return { success: false, error: 'Not in a session' };
    }
    collabManager.sendChat(payload.text);
    return { success: true };
  });

  ipcMain.handle('collab-get-chat-history', () => {
    if (!collabManager) {
      return { success: true, history: [] };
    }
    return { success: true, history: collabManager.chatHistory };
  });

  // ==========================================
  // Sync Operations
  // ==========================================

  ipcMain.handle('collab-sync-cursor', (event, payload = {}) => {
    if (!collabManager) return { success: false };
    collabManager.updateCursor(payload.paneId, payload.position);
    return { success: true };
  });

  ipcMain.handle('collab-sync-terminal', (event, payload = {}) => {
    if (!collabManager) return { success: false };
    collabManager.syncTerminalOutput(payload.paneId, payload.data);
    return { success: true };
  });

  ipcMain.handle('collab-sync-input', (event, payload = {}) => {
    if (!collabManager) return { success: false };
    collabManager.syncTerminalInput(payload.paneId, payload.input);
    return { success: true };
  });

  ipcMain.handle('collab-sync-settings', (event, payload = {}) => {
    if (!collabManager) return { success: false };
    collabManager.syncSettings(payload.settings);
    return { success: true };
  });

  ipcMain.handle('collab-sync-agent-state', (event, payload = {}) => {
    if (!collabManager) return { success: false };
    collabManager.syncAgentState(payload.paneId, payload.state);
    return { success: true };
  });

  ipcMain.handle('collab-request-sync', () => {
    if (!collabManager) return { success: false };
    collabManager.requestSync();
    return { success: true };
  });

  // ==========================================
  // Session Settings
  // ==========================================

  ipcMain.handle('collab-get-invite-link', () => {
    if (!collabManager) {
      return { success: false, error: 'Not in a session' };
    }
    const link = collabManager.getInviteLink();
    const state = collabManager.getState();
    return {
      success: true,
      inviteLink: link,
      inviteCode: state.session?.inviteCode,
      port: state.session?.port,
    };
  });

  ipcMain.handle('collab-update-session-settings', (event, payload = {}) => {
    if (!collabManager || !collabManager.isHost()) {
      return { success: false, error: 'Not authorized' };
    }

    const session = collabManager.session;
    if (!session) {
      return { success: false, error: 'No active session' };
    }

    // Update settings
    if (payload.allowEditing !== undefined) {
      session.settings.allowEditing = payload.allowEditing;
    }
    if (payload.allowChat !== undefined) {
      session.settings.allowChat = payload.allowChat;
    }
    if (payload.syncTerminals !== undefined) {
      session.settings.syncTerminals = payload.syncTerminals;
    }
    if (payload.syncSettings !== undefined) {
      session.settings.syncSettings = payload.syncSettings;
    }
    if (payload.maxUsers !== undefined) {
      session.settings.maxUsers = payload.maxUsers;
    }

    // Broadcast update
    collabManager.broadcast({
      type: 'session_settings_updated',
      settings: session.settings,
    });

    return { success: true, settings: session.settings };
  });

  // ==========================================
  // Cleanup
  // ==========================================

  ipcMain.handle('collab-reset', () => {
    if (collabManager) {
      collabManager.destroy();
      collabManager = null;
    }
    resetCollaborationManager();
    return { success: true };
  });

  // Expose role constants
  ipcMain.handle('collab-get-roles', () => {
    return { success: true, roles: CollabRole };
  });
}

module.exports = { registerCollaborationHandlers };
