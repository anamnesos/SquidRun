/**
 * Mobile API Server (Task #17: Mobile Companion App)
 *
 * REST API server for mobile companion app integration.
 * Features:
 *  - Agent status monitoring
 *  - Remote command execution
 *  - Push notification registration
 *  - Session management
 *  - Real-time status updates via SSE
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const url = require('url');
const EventEmitter = require('events');
const log = require('../logger');

// API versioning
const API_VERSION = 'v1';

// Authentication methods
const AuthMethod = {
  API_KEY: 'api_key',
  JWT: 'jwt',
  NONE: 'none',
};

// Notification types
const NotificationType = {
  AGENT_STATUS: 'agent_status',
  AGENT_ERROR: 'agent_error',
  AGENT_COMPLETE: 'agent_complete',
  BUILD_STATUS: 'build_status',
  CHAT_MESSAGE: 'chat_message',
  SYSTEM_ALERT: 'system_alert',
};

class MobileApiServer extends EventEmitter {
  constructor(options = {}) {
    super();

    this.port = options.port || 8080;
    this.host = options.host || '0.0.0.0';
    this.useHttps = options.useHttps || false;
    this.authMethod = options.authMethod || AuthMethod.API_KEY;
    this.apiKeys = new Map();
    this.sessions = new Map();
    this.pushSubscriptions = new Map();
    this.sseClients = new Map();

    this.server = null;
    this.isRunning = false;

    // Rate limiting
    this.rateLimits = new Map();
    this.rateLimit = options.rateLimit || 100; // requests per minute
    this.rateLimitWindow = options.rateLimitWindow || 60000;

    // State getters (injected from main process)
    this.getAgentStatus = options.getAgentStatus || (() => ({}));
    this.getSystemStatus = options.getSystemStatus || (() => ({}));
    this.executeCommand = options.executeCommand || (() => Promise.resolve({ success: false }));

    log.info('MobileAPI', 'Initialized');
  }

  /**
   * Start the API server
   */
  async start() {
    if (this.isRunning) {
      return { success: false, error: 'Server already running' };
    }

    try {
      const requestHandler = this.createRequestHandler();

      if (this.useHttps) {
        // For HTTPS, certificates would need to be provided
        this.server = https.createServer({}, requestHandler);
      } else {
        this.server = http.createServer(requestHandler);
      }

      return new Promise((resolve, reject) => {
        this.server.listen(this.port, this.host, () => {
          this.isRunning = true;
          log.info('MobileAPI', `Server started on ${this.host}:${this.port}`);
          this.emit('started', { port: this.port, host: this.host });
          resolve({ success: true, port: this.port });
        });

        this.server.on('error', (error) => {
          log.error('MobileAPI', 'Server error:', error.message);
          this.emit('error', error);
          reject(error);
        });
      });
    } catch (error) {
      log.error('MobileAPI', 'Failed to start server:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Stop the API server
   */
  async stop() {
    if (!this.isRunning || !this.server) {
      return { success: false, error: 'Server not running' };
    }

    return new Promise((resolve) => {
      // Close all SSE connections
      this.sseClients.forEach((client, id) => {
        client.res.end();
      });
      this.sseClients.clear();

      this.server.close(() => {
        this.isRunning = false;
        log.info('MobileAPI', 'Server stopped');
        this.emit('stopped');
        resolve({ success: true });
      });
    });
  }

  /**
   * Create HTTP request handler
   */
  createRequestHandler() {
    return async (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

      // Handle preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const parsedUrl = url.parse(req.url, true);
      const path = parsedUrl.pathname;
      const query = parsedUrl.query;

      // Rate limiting
      const clientIp = req.socket.remoteAddress;
      if (!this.checkRateLimit(clientIp)) {
        this.sendJson(res, 429, { error: 'Too many requests' });
        return;
      }

      // Authentication
      if (this.authMethod !== AuthMethod.NONE) {
        const authResult = this.authenticate(req);
        if (!authResult.success) {
          this.sendJson(res, 401, { error: authResult.error || 'Unauthorized' });
          return;
        }
        req.user = authResult.user;
      }

      // Route request
      try {
        await this.routeRequest(req, res, path, query);
      } catch (error) {
        log.error('MobileAPI', `Request error: ${error.message}`);
        this.sendJson(res, 500, { error: 'Internal server error' });
      }
    };
  }

  /**
   * Route request to appropriate handler
   */
  async routeRequest(req, res, path, query) {
    const method = req.method;
    const apiPath = path.replace(`/api/${API_VERSION}`, '');

    // API routes
    const routes = {
      // Status endpoints
      'GET /status': () => this.handleGetStatus(req, res),
      'GET /status/agents': () => this.handleGetAgentStatus(req, res),
      'GET /status/agents/:id': () => this.handleGetSingleAgentStatus(req, res, apiPath),
      'GET /status/system': () => this.handleGetSystemStatus(req, res),

      // Agent control
      'POST /agents/:id/command': () => this.handleAgentCommand(req, res, apiPath),
      'POST /agents/:id/restart': () => this.handleAgentRestart(req, res, apiPath),
      'POST /agents/:id/stop': () => this.handleAgentStop(req, res, apiPath),

      // Push notifications
      'POST /push/register': () => this.handlePushRegister(req, res),
      'DELETE /push/unregister': () => this.handlePushUnregister(req, res),
      'GET /push/subscriptions': () => this.handleGetPushSubscriptions(req, res),
      'PUT /push/preferences': () => this.handleUpdatePushPreferences(req, res),

      // Session management
      'POST /session/create': () => this.handleCreateSession(req, res),
      'POST /session/validate': () => this.handleValidateSession(req, res),
      'DELETE /session/revoke': () => this.handleRevokeSession(req, res),

      // Real-time updates (SSE)
      'GET /events': () => this.handleSSE(req, res),

      // Build/deployment status
      'GET /builds': () => this.handleGetBuilds(req, res),
      'GET /builds/:id': () => this.handleGetBuild(req, res, apiPath),
      'POST /builds/trigger': () => this.handleTriggerBuild(req, res),

      // Collaboration status
      'GET /collab/status': () => this.handleGetCollabStatus(req, res),
      'GET /collab/users': () => this.handleGetCollabUsers(req, res),

      // Quick actions
      'POST /quick/sync': () => this.handleQuickSync(req, res),
      'POST /quick/broadcast': () => this.handleQuickBroadcast(req, res),

      // API info
      'GET /': () => this.handleApiInfo(req, res),
      'GET /health': () => this.handleHealthCheck(req, res),
    };

    // Match route
    const routeKey = `${method} ${apiPath}`;
    let handler = routes[routeKey];

    // Try pattern matching for routes with params
    if (!handler) {
      for (const [pattern, h] of Object.entries(routes)) {
        const regex = this.patternToRegex(pattern);
        if (regex.test(`${method} ${apiPath}`)) {
          handler = h;
          break;
        }
      }
    }

    if (handler) {
      await handler();
    } else {
      this.sendJson(res, 404, { error: 'Not found' });
    }
  }

  /**
   * Convert route pattern to regex
   */
  patternToRegex(pattern) {
    const escaped = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/:\w+/g, '[^/]+');
    return new RegExp(`^${escaped}$`);
  }

  /**
   * Extract route params
   */
  extractParams(pattern, path) {
    const patternParts = pattern.split('/');
    const pathParts = path.split('/');
    const params = {};

    patternParts.forEach((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = pathParts[i];
      }
    });

    return params;
  }

  // ==========================================
  // Status Handlers
  // ==========================================

  handleApiInfo(req, res) {
    this.sendJson(res, 200, {
      name: 'Hivemind Mobile API',
      version: API_VERSION,
      endpoints: [
        'GET /status - Overall status',
        'GET /status/agents - All agent statuses',
        'GET /status/agents/:id - Single agent status',
        'GET /status/system - System status',
        'POST /agents/:id/command - Send command to agent',
        'POST /push/register - Register for push notifications',
        'GET /events - SSE stream for real-time updates',
        'GET /health - Health check',
      ],
    });
  }

  handleHealthCheck(req, res) {
    this.sendJson(res, 200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  }

  async handleGetStatus(req, res) {
    const agents = await this.getAgentStatus();
    const system = await this.getSystemStatus();

    this.sendJson(res, 200, {
      agents,
      system,
      timestamp: new Date().toISOString(),
    });
  }

  async handleGetAgentStatus(req, res) {
    const agents = await this.getAgentStatus();
    this.sendJson(res, 200, { agents });
  }

  async handleGetSingleAgentStatus(req, res, path) {
    const params = this.extractParams('/status/agents/:id', path);
    const agents = await this.getAgentStatus();
    const agent = agents[params.id] || agents[`pane-${params.id}`];

    if (!agent) {
      this.sendJson(res, 404, { error: 'Agent not found' });
      return;
    }

    this.sendJson(res, 200, { agent });
  }

  async handleGetSystemStatus(req, res) {
    const system = await this.getSystemStatus();
    this.sendJson(res, 200, { system });
  }

  // ==========================================
  // Agent Control Handlers
  // ==========================================

  async handleAgentCommand(req, res, path) {
    const params = this.extractParams('/agents/:id/command', path);
    const body = await this.parseBody(req);

    if (!body.command) {
      this.sendJson(res, 400, { error: 'Command is required' });
      return;
    }

    try {
      const result = await this.executeCommand(params.id, body.command, body.options);
      this.sendJson(res, 200, { success: true, result });
    } catch (error) {
      this.sendJson(res, 500, { error: error.message });
    }
  }

  async handleAgentRestart(req, res, path) {
    const params = this.extractParams('/agents/:id/restart', path);

    try {
      const result = await this.executeCommand(params.id, '__restart__');
      this.sendJson(res, 200, { success: true, result });
    } catch (error) {
      this.sendJson(res, 500, { error: error.message });
    }
  }

  async handleAgentStop(req, res, path) {
    const params = this.extractParams('/agents/:id/stop', path);

    try {
      const result = await this.executeCommand(params.id, '__stop__');
      this.sendJson(res, 200, { success: true, result });
    } catch (error) {
      this.sendJson(res, 500, { error: error.message });
    }
  }

  // ==========================================
  // Push Notification Handlers
  // ==========================================

  async handlePushRegister(req, res) {
    const body = await this.parseBody(req);

    if (!body.token || !body.platform) {
      this.sendJson(res, 400, { error: 'Token and platform are required' });
      return;
    }

    const subscription = {
      id: crypto.randomBytes(16).toString('hex'),
      token: body.token,
      platform: body.platform, // 'ios', 'android', 'web'
      deviceName: body.deviceName || 'Unknown',
      preferences: body.preferences || {
        agentStatus: true,
        agentErrors: true,
        buildStatus: true,
        chatMessages: false,
      },
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };

    this.pushSubscriptions.set(subscription.id, subscription);
    this.emit('push_registered', subscription);

    log.info('MobileAPI', `Push subscription registered: ${subscription.id}`);
    this.sendJson(res, 201, { success: true, subscriptionId: subscription.id });
  }

  async handlePushUnregister(req, res) {
    const body = await this.parseBody(req);

    if (!body.subscriptionId) {
      this.sendJson(res, 400, { error: 'Subscription ID is required' });
      return;
    }

    if (this.pushSubscriptions.delete(body.subscriptionId)) {
      this.emit('push_unregistered', body.subscriptionId);
      this.sendJson(res, 200, { success: true });
    } else {
      this.sendJson(res, 404, { error: 'Subscription not found' });
    }
  }

  handleGetPushSubscriptions(req, res) {
    const subscriptions = Array.from(this.pushSubscriptions.values()).map(sub => ({
      id: sub.id,
      platform: sub.platform,
      deviceName: sub.deviceName,
      preferences: sub.preferences,
      createdAt: sub.createdAt,
    }));

    this.sendJson(res, 200, { subscriptions });
  }

  async handleUpdatePushPreferences(req, res) {
    const body = await this.parseBody(req);

    if (!body.subscriptionId) {
      this.sendJson(res, 400, { error: 'Subscription ID is required' });
      return;
    }

    const subscription = this.pushSubscriptions.get(body.subscriptionId);
    if (!subscription) {
      this.sendJson(res, 404, { error: 'Subscription not found' });
      return;
    }

    subscription.preferences = { ...subscription.preferences, ...body.preferences };
    this.sendJson(res, 200, { success: true, preferences: subscription.preferences });
  }

  // ==========================================
  // Session Management
  // ==========================================

  async handleCreateSession(req, res) {
    const body = await this.parseBody(req);

    // Generate API key for this session
    const apiKey = crypto.randomBytes(32).toString('hex');
    const session = {
      id: crypto.randomBytes(16).toString('hex'),
      apiKey,
      deviceName: body.deviceName || 'Mobile App',
      platform: body.platform || 'unknown',
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      permissions: body.permissions || ['read', 'command'],
    };

    this.sessions.set(session.id, session);
    this.apiKeys.set(apiKey, session);

    log.info('MobileAPI', `Session created: ${session.id}`);
    this.emit('session_created', { sessionId: session.id });

    this.sendJson(res, 201, {
      success: true,
      sessionId: session.id,
      apiKey,
      expiresIn: '30d',
    });
  }

  async handleValidateSession(req, res) {
    const apiKey = req.headers['x-api-key'];
    const session = this.apiKeys.get(apiKey);

    if (session) {
      session.lastUsed = new Date().toISOString();
      this.sendJson(res, 200, { valid: true, sessionId: session.id });
    } else {
      this.sendJson(res, 200, { valid: false });
    }
  }

  async handleRevokeSession(req, res) {
    const body = await this.parseBody(req);

    if (!body.sessionId) {
      this.sendJson(res, 400, { error: 'Session ID is required' });
      return;
    }

    const session = this.sessions.get(body.sessionId);
    if (session) {
      this.apiKeys.delete(session.apiKey);
      this.sessions.delete(body.sessionId);
      this.sendJson(res, 200, { success: true });
    } else {
      this.sendJson(res, 404, { error: 'Session not found' });
    }
  }

  // ==========================================
  // SSE (Server-Sent Events)
  // ==========================================

  handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const clientId = crypto.randomBytes(8).toString('hex');
    this.sseClients.set(clientId, { res, connectedAt: Date.now() });

    // Send initial connection event
    this.sendSSE(res, 'connected', { clientId });

    // Keep-alive ping every 30 seconds
    const pingInterval = setInterval(() => {
      this.sendSSE(res, 'ping', { timestamp: Date.now() });
    }, 30000);

    req.on('close', () => {
      clearInterval(pingInterval);
      this.sseClients.delete(clientId);
      log.info('MobileAPI', `SSE client disconnected: ${clientId}`);
    });

    log.info('MobileAPI', `SSE client connected: ${clientId}`);
  }

  sendSSE(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Broadcast event to all SSE clients
   */
  broadcastSSE(event, data) {
    this.sseClients.forEach((client) => {
      try {
        this.sendSSE(client.res, event, data);
      } catch (error) {
        // Client disconnected
      }
    });
  }

  // ==========================================
  // Build Handlers
  // ==========================================

  async handleGetBuilds(req, res) {
    // This would be connected to the deployment manager
    this.sendJson(res, 200, {
      builds: [],
      message: 'Connect to deployment manager for build history',
    });
  }

  async handleGetBuild(req, res, path) {
    const params = this.extractParams('/builds/:id', path);
    this.sendJson(res, 200, {
      build: null,
      message: `Build ${params.id} - connect to deployment manager`,
    });
  }

  async handleTriggerBuild(req, res) {
    const body = await this.parseBody(req);
    this.emit('build_trigger', body);
    this.sendJson(res, 202, { success: true, message: 'Build triggered' });
  }

  // ==========================================
  // Collaboration Handlers
  // ==========================================

  async handleGetCollabStatus(req, res) {
    this.sendJson(res, 200, {
      active: false,
      message: 'Connect to collaboration manager for status',
    });
  }

  async handleGetCollabUsers(req, res) {
    this.sendJson(res, 200, { users: [] });
  }

  // ==========================================
  // Quick Action Handlers
  // ==========================================

  async handleQuickSync(req, res) {
    this.emit('quick_sync');
    this.sendJson(res, 200, { success: true, message: 'Sync triggered' });
  }

  async handleQuickBroadcast(req, res) {
    const body = await this.parseBody(req);

    if (!body.message) {
      this.sendJson(res, 400, { error: 'Message is required' });
      return;
    }

    this.emit('quick_broadcast', body.message);
    this.sendJson(res, 200, { success: true, message: 'Broadcast sent' });
  }

  // ==========================================
  // Authentication
  // ==========================================

  authenticate(req) {
    if (this.authMethod === AuthMethod.API_KEY) {
      const apiKey = req.headers['x-api-key'];
      if (!apiKey) {
        return { success: false, error: 'API key required' };
      }

      const session = this.apiKeys.get(apiKey);
      if (!session) {
        return { success: false, error: 'Invalid API key' };
      }

      session.lastUsed = new Date().toISOString();
      return { success: true, user: { sessionId: session.id, permissions: session.permissions } };
    }

    return { success: true, user: {} };
  }

  // ==========================================
  // Rate Limiting
  // ==========================================

  checkRateLimit(clientIp) {
    const now = Date.now();
    const key = clientIp;

    if (!this.rateLimits.has(key)) {
      this.rateLimits.set(key, { count: 1, windowStart: now });
      return true;
    }

    const limit = this.rateLimits.get(key);

    if (now - limit.windowStart > this.rateLimitWindow) {
      limit.count = 1;
      limit.windowStart = now;
      return true;
    }

    limit.count++;
    return limit.count <= this.rateLimit;
  }

  // ==========================================
  // Utilities
  // ==========================================

  sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  async parseBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Send push notification
   */
  async sendPushNotification(type, data) {
    const subscriptions = Array.from(this.pushSubscriptions.values());

    for (const sub of subscriptions) {
      // Check preferences
      const prefKey = {
        [NotificationType.AGENT_STATUS]: 'agentStatus',
        [NotificationType.AGENT_ERROR]: 'agentErrors',
        [NotificationType.BUILD_STATUS]: 'buildStatus',
        [NotificationType.CHAT_MESSAGE]: 'chatMessages',
      }[type];

      if (prefKey && !sub.preferences[prefKey]) {
        continue;
      }

      // Emit for external push service to handle
      this.emit('send_push', {
        subscription: sub,
        notification: {
          type,
          data,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Also broadcast via SSE
    this.broadcastSSE(type, data);
  }

  /**
   * Get server state
   */
  getState() {
    return {
      isRunning: this.isRunning,
      port: this.port,
      host: this.host,
      sessionCount: this.sessions.size,
      pushSubscriptionCount: this.pushSubscriptions.size,
      sseClientCount: this.sseClients.size,
    };
  }
}

// Singleton instance
let instance = null;

function getMobileApiServer(options) {
  if (!instance) {
    instance = new MobileApiServer(options);
  }
  return instance;
}

function resetMobileApiServer() {
  if (instance) {
    instance.stop();
    instance = null;
  }
}

module.exports = {
  MobileApiServer,
  getMobileApiServer,
  resetMobileApiServer,
  NotificationType,
  AuthMethod,
  API_VERSION,
};
