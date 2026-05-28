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
    daemonClient.spawn = jest.fn().mockReturnValue(true);
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
});
