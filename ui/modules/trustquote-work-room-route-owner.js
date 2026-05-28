'use strict';

const fs = require('fs');
const path = require('path');

const { DaemonClient } = require('../daemon-client');
const { getProfileWebSocketPort } = require('../profile');
const {
  REAL_ROOM_ROUTE_CLIENT_KIND,
  TRUSTQUOTE_PROJECT_PATH,
  TRUSTQUOTE_ROOM_ID,
  makeRoomRouteScope,
  makeTrustQuoteSessionScopeId,
} = require('./project-room-envelope');
const {
  buildTrustQuoteWorkRoomPrerequisiteArtifacts,
  resolveMainSessionScopeId,
} = require('./trustquote-work-room-prerequisites');

const ROUTE_OWNER_VERSION = 'squidrun.trustquote-work-room-route-owner.v0';
const ROUTE_OWNER_ID = 'trustquote-work-room-route-owner';
const DEFAULT_ROLE_PANE_IDS = Object.freeze({
  builder: 'trustquote-builder',
  oracle: 'trustquote-oracle',
});
const DEFAULT_ROLE_COMMANDS = Object.freeze({
  builder: 'codex',
  oracle: 'gemini --yolo --model gemini-3.1-pro-preview',
});
const DEFAULT_HEARTBEAT_MS = 15000;

function toText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizePathForMetadata(value) {
  return toText(value, '').replace(/\\/g, '/');
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readSettings(settingsPath = path.join(__dirname, '..', 'settings.json')) {
  const parsed = readJsonFile(settingsPath);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function commandForRole(role, options = {}) {
  const roleCommands = options.roleCommands && typeof options.roleCommands === 'object'
    ? options.roleCommands
    : {};
  if (toText(roleCommands[role], '')) return toText(roleCommands[role], '');
  const settings = options.settings && typeof options.settings === 'object'
    ? options.settings
    : readSettings(options.settingsPath);
  const paneCommands = settings.paneCommands && typeof settings.paneCommands === 'object'
    ? settings.paneCommands
    : {};
  if (role === 'builder') return toText(paneCommands['2'], DEFAULT_ROLE_COMMANDS.builder);
  if (role === 'oracle') return toText(paneCommands['3'], DEFAULT_ROLE_COMMANDS.oracle);
  return toText(DEFAULT_ROLE_COMMANDS[role], role);
}

function createRouteBinding(spec, plan, options = {}) {
  return {
    clientKind: REAL_ROOM_ROUTE_CLIENT_KIND,
    routeOwner: ROUTE_OWNER_ID,
    roomId: TRUSTQUOTE_ROOM_ID,
    role: spec.role,
    paneId: spec.paneId,
    terminalPaneId: spec.paneId,
    terminalBacked: true,
    agentProcessStarted: options.agentProcessStarted !== false,
    profileName: TRUSTQUOTE_ROOM_ID,
    windowKey: TRUSTQUOTE_ROOM_ID,
    sessionScopeId: plan.sessionScopeId,
    workspace: plan.projectPath,
    startupBundlePath: plan.startupBundlePath,
    workstreamPath: plan.workstreamPath,
  };
}

function createRegisterPayload(spec, plan, options = {}) {
  return {
    type: 'register',
    role: spec.role,
    paneId: spec.paneId,
    profileName: TRUSTQUOTE_ROOM_ID,
    windowKey: TRUSTQUOTE_ROOM_ID,
    sessionScopeId: plan.sessionScopeId,
    routeBinding: createRouteBinding(spec, plan, options),
  };
}

function buildTrustQuoteRouteOwnerPlan(options = {}) {
  const projectPath = path.resolve(options.projectPath || TRUSTQUOTE_PROJECT_PATH);
  const squidrunRoot = path.resolve(options.squidrunRoot || path.join(__dirname, '..', '..'));
  const mainSessionScopeId = resolveMainSessionScopeId({
    ...options,
    squidrunRoot,
  });
  const sessionScopeId = makeTrustQuoteSessionScopeId(mainSessionScopeId);
  const artifacts = buildTrustQuoteWorkRoomPrerequisiteArtifacts({
    ...options,
    projectPath,
    squidrunRoot,
    mainSessionScopeId,
  });
  const roles = ['builder', 'oracle'].map((role) => {
    const paneId = toText(options.rolePaneIds?.[role], DEFAULT_ROLE_PANE_IDS[role]);
    return {
      role,
      paneId,
      cwd: normalizePathForMetadata(projectPath),
      command: commandForRole(role, options),
      env: {
        SQUIDRUN_PROFILE: TRUSTQUOTE_ROOM_ID,
        SQUIDRUN_WINDOW_KEY: TRUSTQUOTE_ROOM_ID,
        SQUIDRUN_SESSION_SCOPE_ID: sessionScopeId,
        SQUIDRUN_WORK_ROOM_ID: TRUSTQUOTE_ROOM_ID,
        SQUIDRUN_PROJECT_ROOT: normalizePathForMetadata(projectPath),
        SQUIDRUN_ROLE: role,
        SQUIDRUN_PANE_ID: paneId,
      },
    };
  });

  return {
    version: ROUTE_OWNER_VERSION,
    routeOwner: ROUTE_OWNER_ID,
    roomId: TRUSTQUOTE_ROOM_ID,
    projectPath: normalizePathForMetadata(projectPath),
    squidrunRoot: normalizePathForMetadata(squidrunRoot),
    mainSessionScopeId,
    sessionScopeId,
    port: getProfileWebSocketPort(TRUSTQUOTE_ROOM_ID),
    routeScope: makeRoomRouteScope(TRUSTQUOTE_ROOM_ID, sessionScopeId),
    startupBundlePath: artifacts.paths.startupBundlePath,
    workstreamPath: artifacts.paths.workstreamPath,
    linkPath: artifacts.paths.linkPath,
    roles,
  };
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch (_) {
    return null;
  }
}

function waitForSocketMessage(ws, predicate, timeoutMs = 5000, label = 'socket message') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off?.('message', onMessage);
      ws.off?.('error', onError);
      ws.off?.('close', onClose);
    };
    const onMessage = (raw) => {
      const msg = parseJson(raw?.toString ? raw.toString() : raw);
      if (!msg || !predicate(msg)) return;
      cleanup();
      resolve(msg);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${label} socket closed`));
    };
    ws.on?.('message', onMessage);
    ws.on?.('error', onError);
    ws.on?.('close', onClose);
  });
}

class TrustQuoteWorkRoomRouteOwner {
  constructor(options = {}) {
    this.options = options;
    this.plan = options.plan || buildTrustQuoteRouteOwnerPlan(options);
    this.websocketRuntime = options.websocketRuntime || require('./websocket-runtime');
    this.WebSocketImpl = options.WebSocketImpl || require('ws');
    this.daemonClient = options.daemonClient || new DaemonClient();
    this.heartbeatMs = Number.parseInt(String(options.heartbeatMs || DEFAULT_HEARTBEAT_MS), 10) || DEFAULT_HEARTBEAT_MS;
    this.clients = new Map();
    this.heartbeatTimers = new Map();
    this.started = false;
    this.handleDaemonExit = (paneId) => {
      const spec = this.plan.roles.find((roleSpec) => roleSpec.paneId === String(paneId));
      if (!spec) return;
      this.closeRouteClient(spec.role);
    };
  }

  async start() {
    if (this.started) return { ok: true, alreadyRunning: true, plan: this.plan };
    await this.websocketRuntime.start({
      port: this.plan.port,
      sessionScopeId: this.plan.sessionScopeId,
    });
    const connected = typeof this.daemonClient.connect === 'function'
      ? await this.daemonClient.connect()
      : true;
    if (connected === false) {
      throw new Error('terminal daemon unavailable');
    }
    if (typeof this.daemonClient.on === 'function') {
      this.daemonClient.on('exit', this.handleDaemonExit);
      this.daemonClient.on('killed', this.handleDaemonExit);
    }

    for (const spec of this.plan.roles) {
      this.spawnRoleTerminal(spec);
      if (this.options.launchAgents !== false) {
        this.launchRoleAgent(spec);
      }
      await this.openRouteClient(spec);
    }
    this.started = true;
    return { ok: true, plan: this.plan };
  }

  spawnRoleTerminal(spec) {
    if (typeof this.daemonClient.spawn !== 'function') return false;
    return this.daemonClient.spawn(
      spec.paneId,
      spec.cwd,
      this.options.dryRun === true,
      null,
      spec.env,
      {
        workRoomRouteOwner: true,
        roomId: TRUSTQUOTE_ROOM_ID,
        routeOwner: ROUTE_OWNER_ID,
        role: spec.role,
        paneCommand: spec.command,
      }
    );
  }

  launchRoleAgent(spec) {
    if (!spec.command || typeof this.daemonClient.write !== 'function') return false;
    return this.daemonClient.write(spec.paneId, `${spec.command}\r`, {
      source: ROUTE_OWNER_ID,
      roomId: TRUSTQUOTE_ROOM_ID,
      role: spec.role,
      sessionScopeId: this.plan.sessionScopeId,
    });
  }

  async openRouteClient(spec) {
    const ws = new this.WebSocketImpl(`ws://127.0.0.1:${this.plan.port}`);
    await waitForSocketMessage(ws, (msg) => msg.type === 'welcome', this.options.timeoutMs, `${spec.role} welcome`);
    ws.send(JSON.stringify(createRegisterPayload(spec, this.plan, {
      agentProcessStarted: this.options.launchAgents !== false,
    })));
    await waitForSocketMessage(ws, (msg) => msg.type === 'registered', this.options.timeoutMs, `${spec.role} registered`);
    ws.on?.('message', (raw) => {
      const msg = parseJson(raw?.toString ? raw.toString() : raw);
      if (!msg || msg.type !== 'message') return;
      if (typeof this.daemonClient.write !== 'function') return;
      this.daemonClient.write(spec.paneId, `${String(msg.content || '')}\r`, {
        source: ROUTE_OWNER_ID,
        roomId: TRUSTQUOTE_ROOM_ID,
        role: spec.role,
        traceId: msg.traceId || null,
      });
    });
    const heartbeat = () => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({
        type: 'route-heartbeat',
        requestId: `${spec.role}-${Date.now()}`,
      }));
    };
    this.heartbeatTimers.set(spec.role, setInterval(heartbeat, this.heartbeatMs));
    this.clients.set(spec.role, ws);
    heartbeat();
    return ws;
  }

  closeRouteClient(role) {
    const timer = this.heartbeatTimers.get(role);
    if (timer) clearInterval(timer);
    this.heartbeatTimers.delete(role);
    const ws = this.clients.get(role);
    this.clients.delete(role);
    try {
      if (ws && ws.readyState !== 3) ws.close();
    } catch (_) {}
  }

  async stop() {
    for (const role of Array.from(this.clients.keys())) {
      this.closeRouteClient(role);
    }
    if (this.options.killTerminalsOnStop !== false && typeof this.daemonClient.kill === 'function') {
      for (const spec of this.plan.roles) {
        try {
          this.daemonClient.kill(spec.paneId);
        } catch (_) {}
      }
    }
    if (typeof this.daemonClient.off === 'function') {
      this.daemonClient.off('exit', this.handleDaemonExit);
      this.daemonClient.off('killed', this.handleDaemonExit);
    }
    if (this.options.stopWebsocket !== false && typeof this.websocketRuntime.stop === 'function') {
      await this.websocketRuntime.stop();
    }
    this.started = false;
  }
}

module.exports = {
  DEFAULT_ROLE_PANE_IDS,
  ROUTE_OWNER_ID,
  ROUTE_OWNER_VERSION,
  TrustQuoteWorkRoomRouteOwner,
  buildTrustQuoteRouteOwnerPlan,
  createRegisterPayload,
  createRouteBinding,
};
