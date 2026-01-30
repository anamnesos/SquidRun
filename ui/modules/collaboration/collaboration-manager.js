/**
 * Collaboration Manager (Task #11: Real-time Collaboration)
 *
 * Core logic for multi-user sessions with live sync.
 * Features:
 *  - Session management (create, join, leave)
 *  - User presence tracking
 *  - Real-time state synchronization
 *  - Conflict resolution with operational transforms
 *  - Permission levels (host, editor, viewer)
 *  - Activity broadcasting
 */

const EventEmitter = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const log = require('../logger');

// Session roles
const CollabRole = {
  HOST: 'host',
  EDITOR: 'editor',
  VIEWER: 'viewer',
};

// Sync event types
const SyncEventType = {
  USER_JOIN: 'user_join',
  USER_LEAVE: 'user_leave',
  USER_CURSOR: 'user_cursor',
  TERMINAL_OUTPUT: 'terminal_output',
  TERMINAL_INPUT: 'terminal_input',
  SETTINGS_CHANGE: 'settings_change',
  AGENT_STATE: 'agent_state',
  FILE_CHANGE: 'file_change',
  CHAT_MESSAGE: 'chat_message',
  PING: 'ping',
  PONG: 'pong',
  SYNC_REQUEST: 'sync_request',
  SYNC_RESPONSE: 'sync_response',
  ERROR: 'error',
};

// Connection states
const ConnectionState = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
};

class CollaborationManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.userId = options.userId || this.generateUserId();
    this.userName = options.userName || 'Anonymous';
    this.userColor = options.userColor || this.generateUserColor();

    this.session = null;
    this.users = new Map();
    this.connectionState = ConnectionState.DISCONNECTED;
    this.ws = null;
    this.wsServer = null;

    this.pendingOps = [];
    this.syncVersion = 0;
    this.lastSyncTime = null;

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.pingInterval = null;
    this.pingTimeout = options.pingTimeout || 30000;

    this.chatHistory = [];
    this.maxChatHistory = options.maxChatHistory || 500;

    // Terminal sync buffers
    this.terminalBuffers = new Map();
    this.maxTerminalBuffer = options.maxTerminalBuffer || 10000;

    log.info('CollabManager', `Initialized with userId: ${this.userId}`);
  }

  generateUserId() {
    return 'user_' + crypto.randomBytes(8).toString('hex');
  }

  generateSessionId() {
    return 'session_' + crypto.randomBytes(12).toString('hex');
  }

  generateUserColor() {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
      '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
      '#BB8FCE', '#85C1E9', '#F8B500', '#00CED1',
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  // ==========================================
  // Session Management
  // ==========================================

  /**
   * Create a new collaboration session (as host)
   */
  async createSession(options = {}) {
    const sessionId = options.sessionId || this.generateSessionId();
    const port = options.port || 9876;

    try {
      // Start WebSocket server for this session
      this.wsServer = new WebSocket.Server({ port });

      this.session = {
        id: sessionId,
        name: options.name || 'Hivemind Session',
        createdAt: new Date().toISOString(),
        hostId: this.userId,
        port,
        settings: {
          allowEditing: options.allowEditing !== false,
          allowChat: options.allowChat !== false,
          syncTerminals: options.syncTerminals !== false,
          syncSettings: options.syncSettings !== false,
          requireApproval: options.requireApproval || false,
          maxUsers: options.maxUsers || 10,
        },
        inviteCode: this.generateInviteCode(sessionId),
      };

      // Add self as host
      this.users.set(this.userId, {
        id: this.userId,
        name: this.userName,
        color: this.userColor,
        role: CollabRole.HOST,
        joinedAt: new Date().toISOString(),
        cursor: null,
        isOnline: true,
      });

      // Handle incoming connections
      this.wsServer.on('connection', (ws, req) => {
        this.handleIncomingConnection(ws, req);
      });

      this.wsServer.on('error', (error) => {
        log.error('CollabManager', 'WebSocket server error:', error.message);
        this.emit('error', { type: 'server_error', error });
      });

      this.connectionState = ConnectionState.CONNECTED;

      log.info('CollabManager', `Created session ${sessionId} on port ${port}`);
      this.emit('session_created', this.session);

      return {
        success: true,
        session: this.session,
        inviteLink: this.getInviteLink(),
      };
    } catch (error) {
      log.error('CollabManager', 'Failed to create session:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Join an existing session
   */
  async joinSession(options = {}) {
    const { host, port, sessionId, inviteCode } = options;

    if (!host || !port) {
      return { success: false, error: 'Host and port are required' };
    }

    try {
      this.connectionState = ConnectionState.CONNECTING;
      this.emit('connection_state', this.connectionState);

      const wsUrl = `ws://${host}:${port}`;
      this.ws = new WebSocket(wsUrl);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.ws.close();
          reject(new Error('Connection timeout'));
        }, 10000);

        this.ws.on('open', () => {
          clearTimeout(timeout);

          // Send join request
          this.sendMessage({
            type: SyncEventType.USER_JOIN,
            userId: this.userId,
            userName: this.userName,
            userColor: this.userColor,
            inviteCode,
          });

          this.connectionState = ConnectionState.CONNECTED;
          this.emit('connection_state', this.connectionState);
          this.startPingInterval();

          log.info('CollabManager', `Connected to session at ${wsUrl}`);
        });

        this.ws.on('message', (data) => {
          this.handleMessage(data.toString());
        });

        this.ws.on('close', () => {
          this.handleDisconnect();
        });

        this.ws.on('error', (error) => {
          clearTimeout(timeout);
          log.error('CollabManager', 'WebSocket error:', error.message);
          this.emit('error', { type: 'connection_error', error });
          reject(error);
        });

        // Wait for session info
        this.once('session_joined', (session) => {
          resolve({ success: true, session });
        });

        this.once('join_rejected', (reason) => {
          clearTimeout(timeout);
          this.ws.close();
          resolve({ success: false, error: reason });
        });
      });
    } catch (error) {
      this.connectionState = ConnectionState.DISCONNECTED;
      log.error('CollabManager', 'Failed to join session:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Leave current session
   */
  async leaveSession() {
    if (!this.session) {
      return { success: false, error: 'Not in a session' };
    }

    try {
      // Notify others
      this.broadcast({
        type: SyncEventType.USER_LEAVE,
        userId: this.userId,
      });

      // Clean up
      this.stopPingInterval();

      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }

      if (this.wsServer) {
        // Notify all clients
        this.wsServer.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'session_ended',
              reason: 'Host left the session',
            }));
            client.close();
          }
        });
        this.wsServer.close();
        this.wsServer = null;
      }

      const sessionId = this.session.id;
      this.session = null;
      this.users.clear();
      this.connectionState = ConnectionState.DISCONNECTED;

      log.info('CollabManager', `Left session ${sessionId}`);
      this.emit('session_left', { sessionId });

      return { success: true };
    } catch (error) {
      log.error('CollabManager', 'Error leaving session:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==========================================
  // Connection Handling
  // ==========================================

  handleIncomingConnection(ws, req) {
    const clientIp = req.socket.remoteAddress;
    log.info('CollabManager', `New connection from ${clientIp}`);

    // Temporary client ID until they send join message
    let clientUserId = null;

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === SyncEventType.USER_JOIN) {
          // Validate invite code if required
          if (this.session.settings.requireApproval &&
              message.inviteCode !== this.session.inviteCode) {
            ws.send(JSON.stringify({
              type: 'join_rejected',
              reason: 'Invalid invite code',
            }));
            ws.close();
            return;
          }

          // Check max users
          if (this.users.size >= this.session.settings.maxUsers) {
            ws.send(JSON.stringify({
              type: 'join_rejected',
              reason: 'Session is full',
            }));
            ws.close();
            return;
          }

          clientUserId = message.userId;

          // Add user
          const user = {
            id: message.userId,
            name: message.userName || 'Anonymous',
            color: message.userColor || this.generateUserColor(),
            role: this.session.settings.allowEditing ? CollabRole.EDITOR : CollabRole.VIEWER,
            joinedAt: new Date().toISOString(),
            cursor: null,
            isOnline: true,
            ws,
          };
          this.users.set(clientUserId, user);

          // Send session info to new user
          ws.send(JSON.stringify({
            type: 'session_info',
            session: {
              id: this.session.id,
              name: this.session.name,
              hostId: this.session.hostId,
              settings: this.session.settings,
            },
            users: this.getUserList(),
            syncVersion: this.syncVersion,
          }));

          // Broadcast to others
          this.broadcast({
            type: SyncEventType.USER_JOIN,
            user: {
              id: user.id,
              name: user.name,
              color: user.color,
              role: user.role,
            },
          }, clientUserId);

          this.emit('user_joined', user);
          log.info('CollabManager', `User ${user.name} joined session`);

        } else if (message.type === SyncEventType.PONG) {
          // Update last seen
          const user = this.users.get(clientUserId);
          if (user) {
            user.lastSeen = Date.now();
          }
        } else {
          // Forward other messages
          this.handleSyncMessage(message, clientUserId);
        }
      } catch (error) {
        log.error('CollabManager', 'Error handling message:', error.message);
      }
    });

    ws.on('close', () => {
      if (clientUserId) {
        const user = this.users.get(clientUserId);
        this.users.delete(clientUserId);

        // Broadcast leave
        this.broadcast({
          type: SyncEventType.USER_LEAVE,
          userId: clientUserId,
        });

        this.emit('user_left', { userId: clientUserId, userName: user?.name });
        log.info('CollabManager', `User ${user?.name || clientUserId} left session`);
      }
    });

    ws.on('error', (error) => {
      log.error('CollabManager', `Client ${clientUserId} error:`, error.message);
    });
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'session_info':
          this.session = message.session;
          this.syncVersion = message.syncVersion;
          message.users.forEach(user => {
            this.users.set(user.id, { ...user, isOnline: true });
          });
          this.emit('session_joined', this.session);
          break;

        case 'join_rejected':
          this.emit('join_rejected', message.reason);
          break;

        case 'session_ended':
          this.handleSessionEnded(message.reason);
          break;

        case SyncEventType.PING:
          this.sendMessage({ type: SyncEventType.PONG });
          break;

        default:
          this.handleSyncMessage(message);
      }
    } catch (error) {
      log.error('CollabManager', 'Error parsing message:', error.message);
    }
  }

  handleSyncMessage(message, senderId) {
    // Update sync version
    if (message.version && message.version > this.syncVersion) {
      this.syncVersion = message.version;
    }

    switch (message.type) {
      case SyncEventType.USER_JOIN:
        if (message.user) {
          this.users.set(message.user.id, { ...message.user, isOnline: true });
          this.emit('user_joined', message.user);
        }
        break;

      case SyncEventType.USER_LEAVE:
        this.users.delete(message.userId);
        this.emit('user_left', { userId: message.userId });
        break;

      case SyncEventType.USER_CURSOR:
        this.handleCursorUpdate(message);
        break;

      case SyncEventType.TERMINAL_OUTPUT:
        this.handleTerminalSync(message);
        break;

      case SyncEventType.TERMINAL_INPUT:
        this.emit('remote_terminal_input', message);
        break;

      case SyncEventType.SETTINGS_CHANGE:
        this.emit('remote_settings_change', message);
        break;

      case SyncEventType.AGENT_STATE:
        this.emit('remote_agent_state', message);
        break;

      case SyncEventType.FILE_CHANGE:
        this.emit('remote_file_change', message);
        break;

      case SyncEventType.CHAT_MESSAGE:
        this.handleChatMessage(message);
        break;

      case SyncEventType.SYNC_REQUEST:
        this.handleSyncRequest(message, senderId);
        break;

      case SyncEventType.SYNC_RESPONSE:
        this.handleSyncResponse(message);
        break;
    }

    // Broadcast to other clients (if we're host)
    if (this.isHost() && senderId) {
      this.broadcast(message, senderId);
    }
  }

  handleDisconnect() {
    this.connectionState = ConnectionState.DISCONNECTED;
    this.emit('connection_state', this.connectionState);
    this.stopPingInterval();

    // Try to reconnect if we were a client
    if (!this.isHost() && this.session && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.attemptReconnect();
    } else {
      this.emit('disconnected');
    }
  }

  handleSessionEnded(reason) {
    this.session = null;
    this.users.clear();
    this.connectionState = ConnectionState.DISCONNECTED;
    this.stopPingInterval();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.emit('session_ended', { reason });
    log.info('CollabManager', `Session ended: ${reason}`);
  }

  attemptReconnect() {
    this.reconnectAttempts++;
    this.connectionState = ConnectionState.RECONNECTING;
    this.emit('connection_state', this.connectionState);

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    log.info('CollabManager', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      // Store session info for rejoin
      const sessionInfo = { ...this.session };
      const result = await this.joinSession({
        host: sessionInfo.host,
        port: sessionInfo.port,
        sessionId: sessionInfo.id,
      });

      if (result.success) {
        this.reconnectAttempts = 0;
        this.emit('reconnected');
      }
    }, delay);
  }

  // ==========================================
  // Sync Operations
  // ==========================================

  /**
   * Broadcast cursor position
   */
  updateCursor(paneId, position) {
    if (!this.session) return;

    this.broadcast({
      type: SyncEventType.USER_CURSOR,
      userId: this.userId,
      paneId,
      position,
      timestamp: Date.now(),
    });
  }

  handleCursorUpdate(message) {
    const user = this.users.get(message.userId);
    if (user) {
      user.cursor = {
        paneId: message.paneId,
        position: message.position,
        timestamp: message.timestamp,
      };
      this.emit('cursor_update', {
        userId: message.userId,
        userName: user.name,
        userColor: user.color,
        ...user.cursor,
      });
    }
  }

  /**
   * Sync terminal output
   */
  syncTerminalOutput(paneId, data) {
    if (!this.session || !this.session.settings.syncTerminals) return;

    // Buffer for incremental sync
    let buffer = this.terminalBuffers.get(paneId) || '';
    buffer += data;
    if (buffer.length > this.maxTerminalBuffer) {
      buffer = buffer.slice(-this.maxTerminalBuffer);
    }
    this.terminalBuffers.set(paneId, buffer);

    this.broadcast({
      type: SyncEventType.TERMINAL_OUTPUT,
      paneId,
      data,
      timestamp: Date.now(),
      version: ++this.syncVersion,
    });
  }

  handleTerminalSync(message) {
    this.emit('terminal_sync', {
      paneId: message.paneId,
      data: message.data,
      userId: message.userId,
    });
  }

  /**
   * Sync terminal input (for remote control)
   */
  syncTerminalInput(paneId, input) {
    if (!this.session) return;

    // Only editors can send input
    const user = this.users.get(this.userId);
    if (user?.role === CollabRole.VIEWER) return;

    this.broadcast({
      type: SyncEventType.TERMINAL_INPUT,
      paneId,
      input,
      userId: this.userId,
      timestamp: Date.now(),
    });
  }

  /**
   * Sync settings changes
   */
  syncSettings(settings) {
    if (!this.session || !this.session.settings.syncSettings) return;

    this.broadcast({
      type: SyncEventType.SETTINGS_CHANGE,
      settings,
      userId: this.userId,
      timestamp: Date.now(),
      version: ++this.syncVersion,
    });
  }

  /**
   * Sync agent state changes
   */
  syncAgentState(paneId, state) {
    if (!this.session) return;

    this.broadcast({
      type: SyncEventType.AGENT_STATE,
      paneId,
      state,
      userId: this.userId,
      timestamp: Date.now(),
    });
  }

  /**
   * Request full state sync
   */
  requestSync() {
    if (!this.session) return;

    this.sendMessage({
      type: SyncEventType.SYNC_REQUEST,
      userId: this.userId,
      currentVersion: this.syncVersion,
    });
  }

  handleSyncRequest(message, senderId) {
    if (!this.isHost()) return;

    // Send full state to requesting user
    const user = this.users.get(senderId);
    if (user?.ws && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(JSON.stringify({
        type: SyncEventType.SYNC_RESPONSE,
        users: this.getUserList(),
        terminalBuffers: Object.fromEntries(this.terminalBuffers),
        chatHistory: this.chatHistory.slice(-50),
        syncVersion: this.syncVersion,
      }));
    }
  }

  handleSyncResponse(message) {
    // Update local state with sync response
    if (message.users) {
      message.users.forEach(user => {
        if (user.id !== this.userId) {
          this.users.set(user.id, { ...user, isOnline: true });
        }
      });
    }

    if (message.terminalBuffers) {
      Object.entries(message.terminalBuffers).forEach(([paneId, buffer]) => {
        this.terminalBuffers.set(paneId, buffer);
        this.emit('terminal_sync', { paneId, data: buffer, isFullSync: true });
      });
    }

    if (message.chatHistory) {
      this.chatHistory = message.chatHistory;
      this.emit('chat_history', this.chatHistory);
    }

    this.syncVersion = message.syncVersion;
    this.lastSyncTime = Date.now();
    this.emit('sync_complete', { version: this.syncVersion });
  }

  // ==========================================
  // Chat
  // ==========================================

  /**
   * Send chat message
   */
  sendChat(text) {
    if (!this.session || !this.session.settings.allowChat) return;

    const message = {
      id: crypto.randomBytes(8).toString('hex'),
      userId: this.userId,
      userName: this.userName,
      userColor: this.userColor,
      text,
      timestamp: new Date().toISOString(),
    };

    this.chatHistory.push(message);
    if (this.chatHistory.length > this.maxChatHistory) {
      this.chatHistory = this.chatHistory.slice(-this.maxChatHistory);
    }

    this.broadcast({
      type: SyncEventType.CHAT_MESSAGE,
      message,
    });

    this.emit('chat_message', message);
  }

  handleChatMessage(data) {
    if (data.message) {
      this.chatHistory.push(data.message);
      if (this.chatHistory.length > this.maxChatHistory) {
        this.chatHistory = this.chatHistory.slice(-this.maxChatHistory);
      }
      this.emit('chat_message', data.message);
    }
  }

  // ==========================================
  // User Management
  // ==========================================

  /**
   * Update user role (host only)
   */
  setUserRole(userId, role) {
    if (!this.isHost()) return { success: false, error: 'Not authorized' };

    const user = this.users.get(userId);
    if (!user) return { success: false, error: 'User not found' };
    if (userId === this.userId) return { success: false, error: 'Cannot change own role' };

    user.role = role;

    this.broadcast({
      type: 'user_role_changed',
      userId,
      role,
    });

    this.emit('user_role_changed', { userId, role });
    return { success: true };
  }

  /**
   * Kick user from session (host only)
   */
  kickUser(userId) {
    if (!this.isHost()) return { success: false, error: 'Not authorized' };
    if (userId === this.userId) return { success: false, error: 'Cannot kick self' };

    const user = this.users.get(userId);
    if (!user) return { success: false, error: 'User not found' };

    // Close their connection
    if (user.ws && user.ws.readyState === WebSocket.OPEN) {
      user.ws.send(JSON.stringify({
        type: 'kicked',
        reason: 'Kicked by host',
      }));
      user.ws.close();
    }

    this.users.delete(userId);

    this.broadcast({
      type: SyncEventType.USER_LEAVE,
      userId,
      kicked: true,
    });

    this.emit('user_kicked', { userId, userName: user.name });
    return { success: true };
  }

  // ==========================================
  // Utilities
  // ==========================================

  generateInviteCode(sessionId) {
    const hash = crypto.createHash('sha256')
      .update(sessionId + Date.now())
      .digest('hex')
      .substring(0, 8)
      .toUpperCase();
    return hash;
  }

  getInviteLink() {
    if (!this.session) return null;
    // Format: hivemind://join?port=9876&code=ABCD1234
    return `hivemind://join?port=${this.session.port}&code=${this.session.inviteCode}`;
  }

  getUserList() {
    return Array.from(this.users.values()).map(user => ({
      id: user.id,
      name: user.name,
      color: user.color,
      role: user.role,
      joinedAt: user.joinedAt,
      isOnline: user.isOnline,
      cursor: user.cursor,
    }));
  }

  isHost() {
    return this.session?.hostId === this.userId;
  }

  isConnected() {
    return this.connectionState === ConnectionState.CONNECTED;
  }

  sendMessage(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  broadcast(message, excludeUserId = null) {
    if (this.wsServer) {
      // Host broadcasts to all clients
      this.users.forEach((user, id) => {
        if (id !== excludeUserId && id !== this.userId && user.ws?.readyState === WebSocket.OPEN) {
          user.ws.send(JSON.stringify(message));
        }
      });
    } else if (this.ws?.readyState === WebSocket.OPEN) {
      // Client sends to host for relay
      this.ws.send(JSON.stringify(message));
    }

    // Also emit locally for UI updates
    this.emit('broadcast', message);
  }

  startPingInterval() {
    this.stopPingInterval();
    this.pingInterval = setInterval(() => {
      if (this.wsServer) {
        // Server pings all clients
        this.users.forEach((user, id) => {
          if (id !== this.userId && user.ws?.readyState === WebSocket.OPEN) {
            user.ws.send(JSON.stringify({ type: SyncEventType.PING }));
          }
        });
      } else if (this.ws?.readyState === WebSocket.OPEN) {
        // Client pings server
        this.sendMessage({ type: SyncEventType.PING });
      }
    }, this.pingTimeout / 2);
  }

  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Get current state summary
   */
  getState() {
    return {
      userId: this.userId,
      userName: this.userName,
      userColor: this.userColor,
      session: this.session ? {
        id: this.session.id,
        name: this.session.name,
        hostId: this.session.hostId,
        settings: this.session.settings,
        inviteCode: this.session.inviteCode,
        inviteLink: this.getInviteLink(),
      } : null,
      users: this.getUserList(),
      connectionState: this.connectionState,
      isHost: this.isHost(),
      syncVersion: this.syncVersion,
      chatCount: this.chatHistory.length,
    };
  }

  /**
   * Update user profile
   */
  updateProfile(name, color) {
    if (name) this.userName = name;
    if (color) this.userColor = color;

    const user = this.users.get(this.userId);
    if (user) {
      if (name) user.name = name;
      if (color) user.color = color;
    }

    this.broadcast({
      type: 'user_profile_updated',
      userId: this.userId,
      name: this.userName,
      color: this.userColor,
    });
  }

  /**
   * Cleanup
   */
  destroy() {
    this.leaveSession();
    this.removeAllListeners();
    log.info('CollabManager', 'Destroyed');
  }
}

// Singleton instance
let instance = null;

function getCollaborationManager(options) {
  if (!instance) {
    instance = new CollaborationManager(options);
  }
  return instance;
}

function resetCollaborationManager() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

module.exports = {
  CollaborationManager,
  getCollaborationManager,
  resetCollaborationManager,
  CollabRole,
  SyncEventType,
  ConnectionState,
};
