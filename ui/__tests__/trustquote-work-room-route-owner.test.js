const { EventEmitter } = require('events');

const {
  ROUTE_OWNER_ID,
  TrustQuoteWorkRoomRouteOwner,
  buildTrustQuoteRouteOwnerPlan,
  createRegisterPayload,
} = require('../modules/trustquote-work-room-route-owner');
const {
  buildRunArgs,
  probeTrustQuoteRouteOwner,
  readRouteOwnerStatus,
  resolveStatusPath,
  startTrustQuoteRouteOwner,
  stopTrustQuoteRouteOwner,
  writeSupervisorStatus,
} = require('../modules/trustquote-work-room-route-owner-supervisor');

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    setImmediate(() => {
      this.emit('message', JSON.stringify({ type: 'welcome' }));
    });
  }

  send(raw) {
    const parsed = JSON.parse(String(raw));
    this.sent.push(parsed);
    if (parsed.type === 'register') {
      setImmediate(() => {
        this.emit('message', JSON.stringify({
          type: 'registered',
          role: parsed.role,
          paneId: parsed.paneId,
          routeBinding: parsed.routeBinding,
        }));
      });
    }
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

describe('TrustQuote work-room route owner', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  test('builds a headless route-owner plan for exact TrustQuote profile/session scope', () => {
    const plan = buildTrustQuoteRouteOwnerPlan({
      mainSessionScopeId: 'app-session-384',
      settings: {
        paneCommands: {
          2: 'codex',
          3: 'gemini --yolo --model gemini-3.1-pro-preview',
        },
      },
    });

    expect(plan).toEqual(expect.objectContaining({
      routeOwner: ROUTE_OWNER_ID,
      roomId: 'trustquote',
      sessionScopeId: 'app-session-384:trustquote',
      port: 9979,
      routeScope: {
        profileName: 'trustquote',
        windowKey: 'trustquote',
        sessionScopeId: 'app-session-384:trustquote',
      },
    }));
    expect(plan.roles).toEqual([
      expect.objectContaining({
        role: 'builder',
        paneId: 'trustquote-builder',
        command: 'codex',
        env: expect.objectContaining({
          SQUIDRUN_PROFILE: 'trustquote',
          SQUIDRUN_SESSION_SCOPE_ID: 'app-session-384:trustquote',
          SQUIDRUN_WORK_ROOM_ID: 'trustquote',
        }),
      }),
      expect.objectContaining({
        role: 'oracle',
        paneId: 'trustquote-oracle',
        command: 'gemini --yolo --model gemini-3.1-pro-preview',
      }),
    ]);
  });

  test('register payload carries terminal-backed route proof instead of a bare heartbeat', () => {
    const plan = buildTrustQuoteRouteOwnerPlan({
      mainSessionScopeId: 'app-session-384',
      settings: { paneCommands: { 2: 'codex', 3: 'gemini' } },
    });
    const payload = createRegisterPayload(plan.roles[0], plan);

    expect(payload).toEqual(expect.objectContaining({
      type: 'register',
      role: 'builder',
      paneId: 'trustquote-builder',
      profileName: 'trustquote',
      windowKey: 'trustquote',
      sessionScopeId: 'app-session-384:trustquote',
    }));
    expect(payload.routeBinding).toEqual(expect.objectContaining({
      clientKind: 'work_room_route_client',
      routeOwner: ROUTE_OWNER_ID,
      roomId: 'trustquote',
      role: 'builder',
      terminalPaneId: 'trustquote-builder',
      terminalBacked: true,
      agentProcessStarted: true,
      workspace: 'D:/projects/TrustQuote',
      workstreamPath: 'D:/projects/TrustQuote/.squidrun/work-rooms/trustquote/current-workstream.json',
    }));
  });

  test('start opens profile websocket runtime, spawns owned terminals, and registers both route clients', async () => {
    const websocketRuntime = {
      start: jest.fn().mockResolvedValue({}),
      stop: jest.fn().mockResolvedValue({}),
    };
    const daemonClient = new EventEmitter();
    daemonClient.connect = jest.fn().mockResolvedValue(true);
    let nextPid = 31000;
    daemonClient.spawn = jest.fn((paneId) => {
      const pid = nextPid++;
      setImmediate(() => daemonClient.emit('spawned', paneId, pid, false, {
        paneId,
        pid,
        dryRun: false,
        mode: 'pty',
        createdAt: pid + 1000,
      }));
      return true;
    });
    daemonClient.write = jest.fn().mockReturnValue(true);
    const plan = buildTrustQuoteRouteOwnerPlan({
      mainSessionScopeId: 'app-session-384',
      settings: { paneCommands: { 2: 'codex', 3: 'gemini' } },
    });
    const owner = new TrustQuoteWorkRoomRouteOwner({
      plan,
      websocketRuntime,
      daemonClient,
      WebSocketImpl: FakeWebSocket,
      heartbeatMs: 100000,
    });

    await owner.start();

    expect(websocketRuntime.start).toHaveBeenCalledWith({
      port: 9979,
      sessionScopeId: 'app-session-384:trustquote',
    });
    expect(daemonClient.spawn).toHaveBeenCalledTimes(2);
    expect(daemonClient.spawn).toHaveBeenNthCalledWith(
      1,
      'trustquote-builder',
      'D:/projects/TrustQuote',
      false,
      null,
      expect.objectContaining({
        SQUIDRUN_PROFILE: 'trustquote',
        SQUIDRUN_ROLE: 'builder',
      }),
      expect.objectContaining({
        workRoomRouteOwner: true,
        role: 'builder',
      })
    );
    expect(daemonClient.write).toHaveBeenCalledWith(
      'trustquote-builder',
      'codex\r',
      expect.objectContaining({
        source: ROUTE_OWNER_ID,
        sessionScopeId: 'app-session-384:trustquote',
      })
    );

    const registerMessages = FakeWebSocket.instances
      .flatMap((ws) => ws.sent)
      .filter((msg) => msg.type === 'register');
    expect(registerMessages).toHaveLength(2);
    expect(registerMessages.map((msg) => msg.role).sort()).toEqual(['builder', 'oracle']);
    expect(registerMessages.every((msg) => (
      msg.routeBinding.clientKind === 'work_room_route_client'
      && msg.routeBinding.terminalBacked === true
      && msg.routeBinding.agentProcessStarted === true
      && msg.routeBinding.sessionScopeId === 'app-session-384:trustquote'
    ))).toBe(true);

    await owner.stop();
    expect(websocketRuntime.stop).toHaveBeenCalled();
  });

  test('route messages write payload and Enter as separate PTY events', async () => {
    const websocketRuntime = {
      start: jest.fn().mockResolvedValue({}),
      stop: jest.fn().mockResolvedValue({}),
    };
    const daemonClient = new EventEmitter();
    daemonClient.connect = jest.fn().mockResolvedValue(true);
    daemonClient.spawn = jest.fn((paneId) => {
      setImmediate(() => daemonClient.emit('spawned', paneId, 32000, false, {
        paneId,
        pid: 32000,
        dryRun: false,
        mode: 'pty',
        createdAt: 32100,
      }));
      return true;
    });
    daemonClient.write = jest.fn().mockReturnValue(true);
    const owner = new TrustQuoteWorkRoomRouteOwner({
      plan: buildTrustQuoteRouteOwnerPlan({
        mainSessionScopeId: 'app-session-384',
        settings: { paneCommands: { 2: 'codex', 3: 'claude' } },
      }),
      websocketRuntime,
      daemonClient,
      WebSocketImpl: FakeWebSocket,
      heartbeatMs: 100000,
      routeMessageEnterDelayMs: 1,
    });

    await owner.start();
    const builderSocket = FakeWebSocket.instances.find((ws) => (
      ws.sent.some((msg) => msg.type === 'register' && msg.role === 'builder')
    ));
    expect(builderSocket).toBeTruthy();

    daemonClient.write.mockClear();
    builderSocket.emit('message', JSON.stringify({
      type: 'message',
      content: '(ROUTE TEST): submit this payload',
      traceId: 'route-test-1',
    }));

    expect(daemonClient.write).toHaveBeenCalledWith(
      'trustquote-builder',
      '(ROUTE TEST): submit this payload',
      expect.objectContaining({
        source: ROUTE_OWNER_ID,
        role: 'builder',
        traceId: 'route-test-1',
        phase: 'payload',
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(daemonClient.write).toHaveBeenCalledWith(
      'trustquote-builder',
      '\r',
      expect.objectContaining({
        source: ROUTE_OWNER_ID,
        role: 'builder',
        traceId: 'route-test-1',
        phase: 'submit-enter',
      })
    );

    await owner.stop();
  });

  test('attach-existing mode binds live route terminals without respawning or killing them', async () => {
    const websocketRuntime = {
      start: jest.fn().mockResolvedValue({}),
      stop: jest.fn().mockResolvedValue({}),
    };
    const daemonClient = new EventEmitter();
    daemonClient.connect = jest.fn().mockResolvedValue(true);
    daemonClient.spawn = jest.fn();
    daemonClient.write = jest.fn().mockReturnValue(true);
    daemonClient.kill = jest.fn();
    daemonClient.list = jest.fn(() => {
      setImmediate(() => daemonClient.emit('list', [
        {
          paneId: 'trustquote-builder',
          pid: 42001,
          alive: true,
          cwd: 'D:/projects/TrustQuote',
          dryRun: false,
          mode: 'pty',
          createdAt: 42100,
          workRoomRouteOwner: true,
          routeOwner: ROUTE_OWNER_ID,
          roomId: 'trustquote',
          role: 'builder',
        },
        {
          paneId: 'trustquote-oracle',
          pid: 42002,
          alive: true,
          cwd: 'D:/projects/TrustQuote',
          dryRun: false,
          mode: 'pty',
          createdAt: 42200,
          workRoomRouteOwner: true,
          routeOwner: ROUTE_OWNER_ID,
          roomId: 'trustquote',
          role: 'oracle',
        },
      ]));
      return true;
    });
    const owner = new TrustQuoteWorkRoomRouteOwner({
      plan: buildTrustQuoteRouteOwnerPlan({
        mainSessionScopeId: 'app-session-384',
        settings: { paneCommands: { 2: 'codex', 3: 'claude' } },
      }),
      websocketRuntime,
      daemonClient,
      WebSocketImpl: FakeWebSocket,
      heartbeatMs: 100000,
      attachExistingTerminals: true,
      launchAgents: false,
      spawnAckTimeoutMs: 50,
    });

    await owner.start();

    expect(daemonClient.spawn).not.toHaveBeenCalled();
    expect(daemonClient.write).not.toHaveBeenCalledWith(
      'trustquote-builder',
      'codex\r',
      expect.anything()
    );
    expect(owner.roleTerminalRefs.get('builder')).toEqual(expect.objectContaining({
      paneId: 'trustquote-builder',
      pid: 42001,
    }));

    const registerMessages = FakeWebSocket.instances
      .flatMap((ws) => ws.sent)
      .filter((msg) => msg.type === 'register');
    expect(registerMessages).toHaveLength(2);
    expect(registerMessages.every((msg) => msg.routeBinding.agentProcessStarted === true)).toBe(true);

    await owner.stop();

    expect(daemonClient.kill).not.toHaveBeenCalled();
    expect(websocketRuntime.stop).toHaveBeenCalled();
  });

  test('attach-existing mode rejects panes that lack TrustQuote room ownership proof', async () => {
    const websocketRuntime = {
      start: jest.fn().mockResolvedValue({}),
      stop: jest.fn().mockResolvedValue({}),
    };
    const daemonClient = new EventEmitter();
    daemonClient.connect = jest.fn().mockResolvedValue(true);
    daemonClient.list = jest.fn(() => {
      setImmediate(() => daemonClient.emit('list', [
        {
          paneId: 'trustquote-builder',
          pid: 43001,
          alive: true,
          cwd: 'D:/projects/squidrun/ui',
          dryRun: false,
          mode: 'pty',
          createdAt: 43100,
        },
      ]));
      return true;
    });
    const owner = new TrustQuoteWorkRoomRouteOwner({
      plan: buildTrustQuoteRouteOwnerPlan({
        mainSessionScopeId: 'app-session-384',
        settings: { paneCommands: { 2: 'codex', 3: 'claude' } },
      }),
      websocketRuntime,
      daemonClient,
      WebSocketImpl: FakeWebSocket,
      heartbeatMs: 100000,
      attachExistingTerminals: true,
      launchAgents: false,
      spawnAckTimeoutMs: 50,
    });

    await expect(owner.start()).rejects.toThrow(/existing terminal unavailable for trustquote-builder/);
  });

  test('reopens a route client after websocket disconnect while terminal is still alive', async () => {
    const websocketRuntime = {
      start: jest.fn().mockResolvedValue({}),
      stop: jest.fn().mockResolvedValue({}),
    };
    const daemonClient = new EventEmitter();
    daemonClient.connect = jest.fn().mockResolvedValue(true);
    daemonClient.write = jest.fn().mockReturnValue(true);
    daemonClient.spawn = jest.fn((paneId) => {
      const pid = paneId === 'trustquote-builder' ? 44001 : 44002;
      setImmediate(() => daemonClient.emit('spawned', paneId, pid, false, {
        paneId,
        pid,
        dryRun: false,
        mode: 'pty',
        createdAt: pid + 100,
      }));
      return true;
    });
    const owner = new TrustQuoteWorkRoomRouteOwner({
      plan: buildTrustQuoteRouteOwnerPlan({
        mainSessionScopeId: 'app-session-384',
        settings: { paneCommands: { 2: 'codex', 3: 'claude' } },
      }),
      websocketRuntime,
      daemonClient,
      WebSocketImpl: FakeWebSocket,
      heartbeatMs: 100000,
      routeReconnectDelayMs: 1,
    });

    await owner.start();
    const firstBuilderSocket = owner.clients.get('builder');
    expect(firstBuilderSocket).toBeDefined();
    expect(FakeWebSocket.instances).toHaveLength(2);

    firstBuilderSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondBuilderSocket = owner.clients.get('builder');
    expect(secondBuilderSocket).toBeDefined();
    expect(secondBuilderSocket).not.toBe(firstBuilderSocket);
    expect(FakeWebSocket.instances).toHaveLength(3);
    const registerMessages = FakeWebSocket.instances
      .flatMap((ws) => ws.sent)
      .filter((msg) => msg.type === 'register' && msg.role === 'builder');
    expect(registerMessages).toHaveLength(2);

    await owner.stop();
  });

  test('ignores stale daemon exits from replaced terminals before closing a current route client', async () => {
    const websocketRuntime = {
      start: jest.fn().mockResolvedValue({}),
      stop: jest.fn().mockResolvedValue({}),
    };
    const daemonClient = new EventEmitter();
    daemonClient.connect = jest.fn().mockResolvedValue(true);
    daemonClient.write = jest.fn().mockReturnValue(true);
    daemonClient.kill = jest.fn().mockReturnValue(true);
    const spawned = {};
    let nextPid = 41000;
    daemonClient.spawn = jest.fn((paneId) => {
      const pid = nextPid++;
      const createdAt = pid + 2000;
      spawned[paneId] = { paneId, pid, createdAt, dryRun: false, mode: 'pty' };
      setImmediate(() => daemonClient.emit('spawned', paneId, pid, false, spawned[paneId]));
      return true;
    });
    const owner = new TrustQuoteWorkRoomRouteOwner({
      plan: buildTrustQuoteRouteOwnerPlan({
        mainSessionScopeId: 'app-session-384',
        settings: { paneCommands: { 2: 'codex', 3: 'gemini' } },
      }),
      websocketRuntime,
      daemonClient,
      WebSocketImpl: FakeWebSocket,
      heartbeatMs: 100000,
      spawnAckTimeoutMs: 50,
    });

    await owner.start();
    const oracleWs = owner.clients.get('oracle');
    expect(oracleWs).toBeDefined();

    daemonClient.emit('exit', 'trustquote-oracle', 0, {
      paneId: 'trustquote-oracle',
      pid: 1,
      createdAt: 1,
    });

    expect(owner.clients.get('oracle')).toBe(oracleWs);
    expect(oracleWs.readyState).toBe(1);
    expect(owner.ignoredDaemonEvents).toEqual([
      expect.objectContaining({
        role: 'oracle',
        reason: 'stale_terminal_lifecycle_event',
      }),
    ]);

    daemonClient.emit('exit', 'trustquote-oracle', 0, {
      paneId: 'trustquote-oracle',
      pid: spawned['trustquote-oracle'].pid,
      createdAt: spawned['trustquote-oracle'].createdAt,
    });

    expect(owner.clients.has('oracle')).toBe(false);
    expect(oracleWs.readyState).toBe(3);

    await owner.stop();
  });

  test('uses daemon list proof to avoid closing current clients on legacy unidentified exit events', async () => {
    const websocketRuntime = {
      start: jest.fn().mockResolvedValue({}),
      stop: jest.fn().mockResolvedValue({}),
    };
    const daemonClient = new EventEmitter();
    daemonClient.connect = jest.fn().mockResolvedValue(true);
    daemonClient.write = jest.fn().mockReturnValue(true);
    daemonClient.kill = jest.fn().mockReturnValue(true);
    let listAlive = true;
    const spawned = {};
    let nextPid = 51000;
    daemonClient.spawn = jest.fn((paneId) => {
      const pid = nextPid++;
      const createdAt = pid + 3000;
      spawned[paneId] = { paneId, pid, createdAt, dryRun: false, mode: 'pty' };
      setImmediate(() => daemonClient.emit('spawned', paneId, pid, false, spawned[paneId]));
      return true;
    });
    daemonClient.list = jest.fn(() => {
      setImmediate(() => daemonClient.emit('list', [
        {
          ...spawned['trustquote-oracle'],
          alive: listAlive,
        },
      ]));
      return true;
    });
    const owner = new TrustQuoteWorkRoomRouteOwner({
      plan: buildTrustQuoteRouteOwnerPlan({
        mainSessionScopeId: 'app-session-384',
        settings: { paneCommands: { 2: 'codex', 3: 'gemini' } },
      }),
      websocketRuntime,
      daemonClient,
      WebSocketImpl: FakeWebSocket,
      heartbeatMs: 100000,
      spawnAckTimeoutMs: 50,
    });

    await owner.start();
    const oracleWs = owner.clients.get('oracle');

    daemonClient.emit('exit', 'trustquote-oracle', 0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(owner.clients.get('oracle')).toBe(oracleWs);
    expect(owner.ignoredDaemonEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'oracle',
          reason: 'unidentified_lifecycle_event_but_current_terminal_alive',
        }),
      ])
    );

    listAlive = false;
    daemonClient.emit('exit', 'trustquote-oracle', 0);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(owner.clients.has('oracle')).toBe(false);
    expect(oracleWs.readyState).toBe(3);

    await owner.stop();
  });

  test('supervised start defaults to no live agents and records PID ownership', () => {
    const spawned = [];
    const tempDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'trustquote-route-owner-'));
    try {
      const fs = require('fs');
      const path = require('path');
      const statusPath = resolveStatusPath({ lifecycleDir: tempDir });
      fs.mkdirSync(path.dirname(statusPath), { recursive: true });
      fs.writeFileSync(statusPath, `${JSON.stringify({
        state: 'stopped',
        running: false,
        pid: 999,
        updatedAt: '2000-01-01T00:00:00.000Z',
        stopReason: 'stop_requested',
        terminalCleanup: { ok: true, killed: ['trustquote-builder'] },
        error: 'old failure',
      })}\n`, 'utf8');

      const spawnImpl = jest.fn((command, args, options) => {
        spawned.push({ command, args, options });
        return { pid: 12345, unref: jest.fn() };
      });

      const result = startTrustQuoteRouteOwner({
        lifecycleDir: tempDir,
        mainSessionScopeId: 'app-session-384',
        spawnImpl,
        killImpl: () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); },
      });

      expect(result.ok).toBe(true);
      expect(result.status).toEqual(expect.objectContaining({
        state: 'starting',
        running: true,
        pid: 12345,
        launchAgents: false,
        stopReason: null,
        terminalCleanup: null,
        error: null,
      }));
      expect(result.status.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      expect(spawned[0].options.env).toEqual(expect.objectContaining({
        SQUIDRUN_PROFILE: 'trustquote',
      }));
      expect(spawned[0].args).toEqual(expect.arrayContaining([
        'run',
        '--session',
        'app-session-384',
        '--no-launch-agents',
      ]));
      expect(statusPath).toBe(result.status.statusPath.replace(/\//g, '\\'));
    } finally {
      require('fs').rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('supervisor refuses live agent activation without explicit allow flag', () => {
    const tempDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'trustquote-route-owner-'));
    try {
      const result = startTrustQuoteRouteOwner({
        lifecycleDir: tempDir,
        mainSessionScopeId: 'app-session-384',
        launchAgents: true,
        spawnImpl: jest.fn(),
      });

      expect(result).toEqual(expect.objectContaining({
        ok: false,
        reason: 'live_agent_launch_requires_explicit_allow',
        launchAgents: true,
      }));
    } finally {
      require('fs').rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('supervised stop owns cleanup through recorded PID status', async () => {
    const tempDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'trustquote-route-owner-'));
    let alive = true;
    const signals = [];
    const killImpl = jest.fn((pid, signal) => {
      if (signal === 0) {
        if (alive) return true;
        throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      }
      signals.push({ pid, signal });
      alive = false;
      return true;
    });
    const daemonClient = {
      connect: jest.fn().mockResolvedValue(true),
      kill: jest.fn(),
    };
    try {
      writeSupervisorStatus({ lifecycleDir: tempDir }, {
        state: 'running',
        running: true,
        pid: 12345,
      });

      const before = readRouteOwnerStatus({ lifecycleDir: tempDir, killImpl });
      expect(before.running).toBe(true);

      const stopped = await stopTrustQuoteRouteOwner({
        lifecycleDir: tempDir,
        killImpl,
        daemonClient,
        timeoutMs: 50,
      });
      expect(stopped.ok).toBe(true);
      expect(stopped.status.state).toBe('stopped');
      expect(signals).toEqual([{ pid: 12345, signal: 'SIGTERM' }]);
      expect(daemonClient.kill).toHaveBeenCalledWith('trustquote-builder');
      expect(daemonClient.kill).toHaveBeenCalledWith('trustquote-oracle');
      expect(stopped.terminalCleanup).toEqual({
        ok: true,
        killed: ['trustquote-builder', 'trustquote-oracle'],
      });
    } finally {
      require('fs').rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('supervised stop does not kill terminals for attach-existing route owners', async () => {
    const tempDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'trustquote-route-owner-'));
    let alive = true;
    const killImpl = jest.fn((pid, signal) => {
      if (signal === 0) {
        if (alive) return true;
        throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      }
      alive = false;
      return true;
    });
    const daemonClient = {
      connect: jest.fn().mockResolvedValue(true),
      kill: jest.fn(),
    };
    try {
      writeSupervisorStatus({ lifecycleDir: tempDir }, {
        state: 'running',
        running: true,
        pid: 12345,
        attachExistingTerminals: true,
      });

      const stopped = await stopTrustQuoteRouteOwner({
        lifecycleDir: tempDir,
        killImpl,
        daemonClient,
        timeoutMs: 50,
      });

      expect(stopped.ok).toBe(true);
      expect(daemonClient.kill).not.toHaveBeenCalled();
      expect(stopped.terminalCleanup).toEqual({
        skipped: true,
        reason: 'attached_existing_terminals',
      });
    } finally {
      require('fs').rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('probe reports route health without proving contract when agents are not started', async () => {
    class ProbeWebSocket extends EventEmitter {
      constructor() {
        super();
        this.readyState = 1;
        setImmediate(() => this.emit('message', JSON.stringify({ type: 'welcome' })));
      }

      send(raw) {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'register') {
          setImmediate(() => this.emit('message', JSON.stringify({ type: 'registered' })));
        }
        if (msg.type === 'health-check') {
          setImmediate(() => this.emit('message', JSON.stringify({
            type: 'health-check-result',
            requestId: msg.requestId,
            target: msg.target,
            healthy: true,
            status: 'healthy',
            source: 'client_activity',
            routeScope: {
              profileName: 'trustquote',
              windowKey: 'trustquote',
              sessionScopeId: 'app-session-384:trustquote',
            },
            clientKind: 'work_room_route_client',
            routeBinding: {
              clientKind: 'work_room_route_client',
              routeOwner: ROUTE_OWNER_ID,
              roomId: 'trustquote',
              role: msg.target,
              paneId: `trustquote-${msg.target}`,
              terminalPaneId: `trustquote-${msg.target}`,
              terminalBacked: true,
              agentProcessStarted: false,
              profileName: 'trustquote',
              windowKey: 'trustquote',
              sessionScopeId: 'app-session-384:trustquote',
              workspace: 'D:/projects/TrustQuote',
              startupBundlePath: 'D:/projects/squidrun/.squidrun/runtime/window-teams/trustquote/startup-bundle.md',
              workstreamPath: 'D:/projects/TrustQuote/.squidrun/work-rooms/trustquote/current-workstream.json',
            },
          })));
        }
      }

      close() {
        this.readyState = 3;
      }
    }

    const result = await probeTrustQuoteRouteOwner({
      mainSessionScopeId: 'app-session-384',
      WebSocketImpl: ProbeWebSocket,
      env: { SQUIDRUN_TRUSTQUOTE_PROJECT_ROOT: 'D:/projects/TrustQuote' },
      pathExists: () => true,
      readJson: () => ({
        workspace: 'D:/projects/TrustQuote',
        profile: 'trustquote',
        session_id: 'app-session-384:trustquote',
      }),
      workstreamEvidence: {
        version: 'squidrun.work-room-workstream.v0',
        roomId: 'trustquote',
        profile: 'trustquote',
        projectRoot: 'D:/projects/TrustQuote',
        sessionScopeId: 'app-session-384:trustquote',
        status: 'initialized_no_active_task',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.reachable).toBe(true);
    expect(result.routeHealth.builder.source).toBe('client_activity');
    expect(result.contract.status).toBe('blocked');
    expect(result.contract.blockers).toEqual(expect.arrayContaining([
      'route_owner_proof_agent_process_not_started:builder',
      'route_owner_proof_agent_process_not_started:oracle',
    ]));
  });

  test('run args include status file and no-launch flag for supervised dry activation', () => {
    const args = buildRunArgs({
      mainSessionScopeId: 'app-session-384',
      statusPath: 'D:/tmp/status.json',
    });

    expect(args).toEqual(expect.arrayContaining([
      'run',
      '--session',
      'app-session-384',
      '--status-file',
      require('path').resolve('D:/tmp/status.json'),
      '--no-launch-agents',
    ]));
  });

  test('run args can attach to existing terminals without cleanup ownership', () => {
    const args = buildRunArgs({
      mainSessionScopeId: 'app-session-384',
      statusPath: 'D:/tmp/status.json',
      attachExistingTerminals: true,
      killTerminalsOnStop: false,
    });

    expect(args).toEqual(expect.arrayContaining([
      'run',
      '--session',
      'app-session-384',
      '--status-file',
      require('path').resolve('D:/tmp/status.json'),
      '--attach-existing-terminals',
      '--no-kill-terminals',
      '--no-launch-agents',
    ]));
  });
});
