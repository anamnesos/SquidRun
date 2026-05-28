const { EventEmitter } = require('events');

const {
  ROUTE_OWNER_ID,
  TrustQuoteWorkRoomRouteOwner,
  buildTrustQuoteRouteOwnerPlan,
  createRegisterPayload,
} = require('../modules/trustquote-work-room-route-owner');

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
});
