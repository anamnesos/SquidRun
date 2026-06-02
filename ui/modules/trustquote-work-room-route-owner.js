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
const DEFAULT_SPAWN_ACK_TIMEOUT_MS = 1500;
const DEFAULT_ROUTE_MESSAGE_ENTER_DELAY_MS = process.platform === 'win32' ? 500 : 150;
const DEFAULT_ROUTE_RECONNECT_DELAY_MS = 1000;

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

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function waitForDaemonEvent(emitter, eventName, predicate, timeoutMs = DEFAULT_SPAWN_ACK_TIMEOUT_MS) {
  if (!emitter || typeof emitter.on !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      if (typeof emitter.off === 'function') emitter.off(eventName, onEvent);
      else if (typeof emitter.removeListener === 'function') emitter.removeListener(eventName, onEvent);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    const onEvent = (...args) => {
      const result = predicate(...args);
      if (!result) return;
      cleanup();
      resolve(result);
    };
    emitter.on(eventName, onEvent);
  });
}

function normalizeSpawnAck(spec, paneId, pid, dryRun, metadata = {}) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const normalizedPaneId = String(paneId || source.paneId || spec.paneId);
  if (normalizedPaneId !== String(spec.paneId)) return null;
  return {
    role: spec.role,
    paneId: normalizedPaneId,
    pid: toFiniteNumber(pid ?? source.pid),
    dryRun: Boolean(dryRun ?? source.dryRun),
    mode: source.mode || null,
    createdAt: source.createdAt || null,
  };
}

function normalizeLifecycleEvent(event, paneId, codeOrMetadata, maybeMetadata) {
  const metadata = maybeMetadata && typeof maybeMetadata === 'object'
    ? maybeMetadata
    : (codeOrMetadata && typeof codeOrMetadata === 'object' ? codeOrMetadata : {});
  const code = typeof codeOrMetadata === 'number' ? codeOrMetadata : metadata.code;
  return {
    event,
    paneId: String(paneId || metadata.paneId || ''),
    code: Number.isFinite(Number(code)) ? Number(code) : null,
    pid: toFiniteNumber(metadata.pid),
    createdAt: metadata.createdAt || null,
    mode: metadata.mode || null,
    dryRun: metadata.dryRun === true,
    at: new Date().toISOString(),
  };
}

function normalizedComparablePath(value) {
  return normalizePathForMetadata(value).toLowerCase();
}

function validateAttachedTerminal(spec, terminal = {}) {
  const problems = [];
  if (!terminal || terminal.alive === false) {
    problems.push('terminal_not_alive');
  }
  if (String(terminal?.paneId || '') !== String(spec.paneId)) {
    problems.push('pane_id_mismatch');
  }
  if (normalizedComparablePath(terminal?.cwd) !== normalizedComparablePath(spec.cwd)) {
    problems.push('cwd_mismatch');
  }
  if (terminal?.workRoomRouteOwner !== true) {
    problems.push('missing_work_room_owner_flag');
  }
  if (String(terminal?.routeOwner || '') !== ROUTE_OWNER_ID) {
    problems.push('route_owner_mismatch');
  }
  if (String(terminal?.roomId || '') !== TRUSTQUOTE_ROOM_ID) {
    problems.push('room_id_mismatch');
  }
  if (String(terminal?.role || '') !== String(spec.role)) {
    problems.push('role_mismatch');
  }
  return {
    ok: problems.length === 0,
    problems,
  };
}

function terminalEventMatchesRef(event, ref) {
  if (!ref) return true;
  if (event.pid !== null && ref.pid !== null && event.pid !== ref.pid) return false;
  if (event.createdAt && ref.createdAt && String(event.createdAt) !== String(ref.createdAt)) return false;
  return true;
}

class TrustQuoteWorkRoomRouteOwner {
  constructor(options = {}) {
    this.options = options;
    this.plan = options.plan || buildTrustQuoteRouteOwnerPlan(options);
    this.websocketRuntime = options.websocketRuntime || require('./websocket-runtime');
    this.WebSocketImpl = options.WebSocketImpl || require('ws');
    this.daemonClient = options.daemonClient || new DaemonClient({ profileName: TRUSTQUOTE_ROOM_ID });
    this.heartbeatMs = Number.parseInt(String(options.heartbeatMs || DEFAULT_HEARTBEAT_MS), 10) || DEFAULT_HEARTBEAT_MS;
    this.spawnAckTimeoutMs = Number.parseInt(String(options.spawnAckTimeoutMs || DEFAULT_SPAWN_ACK_TIMEOUT_MS), 10) || DEFAULT_SPAWN_ACK_TIMEOUT_MS;
    const routeMessageEnterDelayMs = Number.parseInt(
      String(options.routeMessageEnterDelayMs ?? DEFAULT_ROUTE_MESSAGE_ENTER_DELAY_MS),
      10
    );
    this.routeMessageEnterDelayMs = Number.isFinite(routeMessageEnterDelayMs) && routeMessageEnterDelayMs >= 0
      ? routeMessageEnterDelayMs
      : DEFAULT_ROUTE_MESSAGE_ENTER_DELAY_MS;
    const routeReconnectDelayMs = Number.parseInt(
      String(options.routeReconnectDelayMs ?? DEFAULT_ROUTE_RECONNECT_DELAY_MS),
      10
    );
    this.routeReconnectDelayMs = Number.isFinite(routeReconnectDelayMs) && routeReconnectDelayMs >= 0
      ? routeReconnectDelayMs
      : DEFAULT_ROUTE_RECONNECT_DELAY_MS;
    this.attachExistingTerminals = options.attachExistingTerminals === true;
    this.clients = new Map();
    this.heartbeatTimers = new Map();
    this.routeReconnectTimers = new Map();
    this.routeCloseSuppressions = new Set();
    this.roleTerminalRefs = new Map();
    this.ignoredDaemonEvents = [];
    this.started = false;
    this.stopping = false;
    this.handleDaemonExit = (paneId, code, metadata) => {
      void this.handleDaemonLifecycleEvent('exit', paneId, code, metadata);
    };
    this.handleDaemonKilled = (paneId, metadata) => {
      void this.handleDaemonLifecycleEvent('killed', paneId, metadata);
    };
  }

  async start() {
    if (this.started) return { ok: true, alreadyRunning: true, plan: this.plan };
    this.stopping = false;
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
      this.daemonClient.on('killed', this.handleDaemonKilled);
    }

    for (const spec of this.plan.roles) {
      if (this.attachExistingTerminals) {
        await this.attachExistingRoleTerminal(spec);
      } else {
        await this.spawnRoleTerminal(spec);
      }
      if (!this.attachExistingTerminals && this.options.launchAgents !== false) {
        this.launchRoleAgent(spec);
      }
      await this.openRouteClient(spec);
    }
    this.started = true;
    return { ok: true, plan: this.plan };
  }

  async spawnRoleTerminal(spec) {
    if (typeof this.daemonClient.spawn !== 'function') return false;
    const spawnAck = waitForDaemonEvent(
      this.daemonClient,
      'spawned',
      (paneId, pid, dryRun, metadata) => normalizeSpawnAck(spec, paneId, pid, dryRun, metadata),
      this.spawnAckTimeoutMs
    );
    const result = this.daemonClient.spawn(
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
    if (result && typeof result === 'object') {
      const ref = normalizeSpawnAck(spec, result.paneId, result.pid, result.dryRun, result);
      if (ref) this.roleTerminalRefs.set(spec.role, ref);
      return result;
    }
    if (!result) return result;
    const ref = await spawnAck;
    if (ref) this.roleTerminalRefs.set(spec.role, ref);
    return result;
  }

  async attachExistingRoleTerminal(spec) {
    const current = await this.readCurrentTerminalSnapshot(spec.paneId);
    const validation = validateAttachedTerminal(spec, current);
    if (!validation.ok) {
      throw new Error(`existing terminal unavailable for ${spec.paneId}: ${validation.problems.join(',')}`);
    }
    const ref = normalizeSpawnAck(spec, current.paneId, current.pid, current.dryRun, current);
    if (ref) this.roleTerminalRefs.set(spec.role, ref);
    return ref;
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

  submitRouteMessage(spec, content, traceId = null) {
    if (typeof this.daemonClient.write !== 'function') return false;
    const meta = {
      source: ROUTE_OWNER_ID,
      roomId: TRUSTQUOTE_ROOM_ID,
      role: spec.role,
      traceId: traceId || null,
      sessionScopeId: this.plan.sessionScopeId,
    };
    const accepted = this.daemonClient.write(spec.paneId, String(content || ''), {
      ...meta,
      phase: 'payload',
    });
    if (accepted === false) return false;

    const sendEnter = () => this.daemonClient.write(spec.paneId, '\r', {
      ...meta,
      phase: 'submit-enter',
    });
    if (this.routeMessageEnterDelayMs <= 0) {
      return sendEnter();
    }
    const timer = setTimeout(sendEnter, this.routeMessageEnterDelayMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    return true;
  }

  async openRouteClient(spec) {
    const pendingReconnect = this.routeReconnectTimers.get(spec.role);
    if (pendingReconnect) clearTimeout(pendingReconnect);
    this.routeReconnectTimers.delete(spec.role);
    const ws = new this.WebSocketImpl(`ws://127.0.0.1:${this.plan.port}`);
    await waitForSocketMessage(ws, (msg) => msg.type === 'welcome', this.options.timeoutMs, `${spec.role} welcome`);
    ws.send(JSON.stringify(createRegisterPayload(spec, this.plan, {
      agentProcessStarted: this.attachExistingTerminals || this.options.launchAgents !== false,
    })));
    await waitForSocketMessage(ws, (msg) => msg.type === 'registered', this.options.timeoutMs, `${spec.role} registered`);
    ws.on?.('message', (raw) => {
      const msg = parseJson(raw?.toString ? raw.toString() : raw);
      if (!msg || msg.type !== 'message') return;
      this.submitRouteMessage(spec, msg.content || '', msg.traceId || null);
    });
    ws.on?.('close', () => {
      const current = this.clients.get(spec.role);
      if (current === ws) this.clients.delete(spec.role);
      const timer = this.heartbeatTimers.get(spec.role);
      if (timer) clearInterval(timer);
      this.heartbeatTimers.delete(spec.role);
      if (this.routeCloseSuppressions.delete(spec.role)) return;
      this.scheduleRouteClientReconnect(spec, 'socket_closed');
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

  scheduleRouteClientReconnect(spec, reason = 'socket_closed') {
    if (!this.started || this.stopping) return false;
    if (!this.roleTerminalRefs.has(spec.role)) return false;
    if (this.routeReconnectTimers.has(spec.role)) return false;
    const timer = setTimeout(() => {
      this.routeReconnectTimers.delete(spec.role);
      if (!this.started || this.stopping || !this.roleTerminalRefs.has(spec.role)) return;
      this.openRouteClient(spec).catch((err) => {
        this.ignoredDaemonEvents.push({
          role: spec.role,
          reason: 'route_client_reconnect_failed',
          reconnectReason: reason,
          error: err?.message || String(err),
          at: new Date().toISOString(),
        });
        this.scheduleRouteClientReconnect(spec, 'reconnect_failed');
      });
    }, this.routeReconnectDelayMs);
    if (timer && typeof timer.unref === 'function') {
      timer.unref();
    }
    this.routeReconnectTimers.set(spec.role, timer);
    return true;
  }

  closeRouteClient(role) {
    const timer = this.heartbeatTimers.get(role);
    if (timer) clearInterval(timer);
    this.heartbeatTimers.delete(role);
    const reconnectTimer = this.routeReconnectTimers.get(role);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.routeReconnectTimers.delete(role);
    const ws = this.clients.get(role);
    this.clients.delete(role);
    this.routeCloseSuppressions.add(role);
    try {
      if (ws && ws.readyState !== 3) ws.close();
    } catch (_) {}
    this.routeCloseSuppressions.delete(role);
  }

  async readCurrentTerminalSnapshot(paneId) {
    if (typeof this.daemonClient.list !== 'function' || typeof this.daemonClient.on !== 'function') return null;
    const listResult = waitForDaemonEvent(
      this.daemonClient,
      'list',
      (terminals) => (Array.isArray(terminals) ? terminals : null),
      this.spawnAckTimeoutMs
    );
    const sent = this.daemonClient.list();
    if (!sent) return null;
    const terminals = await listResult;
    if (!Array.isArray(terminals)) return null;
    return terminals.find((terminal) => String(terminal?.paneId) === String(paneId)) || null;
  }

  async handleDaemonLifecycleEvent(event, paneId, codeOrMetadata, maybeMetadata) {
    const spec = this.plan.roles.find((roleSpec) => roleSpec.paneId === String(paneId));
    if (!spec) return;
    const lifecycleEvent = normalizeLifecycleEvent(event, paneId, codeOrMetadata, maybeMetadata);
    const terminalRef = this.roleTerminalRefs.get(spec.role) || null;
    if (!terminalEventMatchesRef(lifecycleEvent, terminalRef)) {
      this.ignoredDaemonEvents.push({
        role: spec.role,
        reason: 'stale_terminal_lifecycle_event',
        event: lifecycleEvent,
        terminalRef,
      });
      return;
    }
    if (terminalRef && lifecycleEvent.pid === null && !lifecycleEvent.createdAt) {
      const current = await this.readCurrentTerminalSnapshot(spec.paneId);
      const currentPid = toFiniteNumber(current?.pid);
      if (
        current
        && currentPid !== null
        && terminalRef.pid !== null
        && currentPid === terminalRef.pid
        && current.alive !== false
      ) {
        this.ignoredDaemonEvents.push({
          role: spec.role,
          reason: 'unidentified_lifecycle_event_but_current_terminal_alive',
          event: lifecycleEvent,
          terminalRef,
          currentTerminal: current,
        });
        return;
      }
      if (
        current
        && currentPid !== null
        && terminalRef.pid !== null
        && currentPid !== terminalRef.pid
      ) {
        this.ignoredDaemonEvents.push({
          role: spec.role,
          reason: 'unidentified_lifecycle_event_for_replaced_terminal',
          event: lifecycleEvent,
          terminalRef,
          currentTerminal: current,
        });
        return;
      }
    }
    this.closeRouteClient(spec.role);
    this.roleTerminalRefs.delete(spec.role);
  }

  async stop() {
    this.stopping = true;
    for (const timer of this.routeReconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.routeReconnectTimers.clear();
    for (const role of Array.from(this.clients.keys())) {
      this.closeRouteClient(role);
    }
    if (
      !this.attachExistingTerminals
      && this.options.killTerminalsOnStop !== false
      && typeof this.daemonClient.kill === 'function'
    ) {
      for (const spec of this.plan.roles) {
        try {
          this.daemonClient.kill(spec.paneId);
        } catch (_) {}
      }
    }
    if (typeof this.daemonClient.off === 'function') {
      this.daemonClient.off('exit', this.handleDaemonExit);
      this.daemonClient.off('killed', this.handleDaemonKilled);
    }
    if (this.options.stopWebsocket !== false && typeof this.websocketRuntime.stop === 'function') {
      await this.websocketRuntime.stop();
    }
    this.started = false;
    this.stopping = false;
  }
}

module.exports = {
  DEFAULT_SPAWN_ACK_TIMEOUT_MS,
  DEFAULT_ROLE_PANE_IDS,
  ROUTE_OWNER_ID,
  ROUTE_OWNER_VERSION,
  TrustQuoteWorkRoomRouteOwner,
  buildTrustQuoteRouteOwnerPlan,
  createRegisterPayload,
  createRouteBinding,
  validateAttachedTerminal,
};
