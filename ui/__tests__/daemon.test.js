/**
 * Integration tests for DaemonClient
 * T4 - Worker B
 */

const { EventEmitter } = require('events');
const { PIPE_PATH, PROTOCOL_ACTIONS, PROTOCOL_EVENTS } = require('../config');

// Mock net module
jest.mock('net', () => ({
  createConnection: jest.fn(),
}));

// Mock child_process
jest.mock('child_process', () => ({
  spawn: jest.fn(() => ({
    pid: 12345,
    unref: jest.fn(),
  })),
}));

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(() => false),
  readFileSync: jest.fn(),
}));

const net = require('net');
const { spawn } = require('child_process');
const { getProfilePipePath } = require('../profile');
const { DaemonClient, getDaemonClient } = require('../daemon-client');

describe('DaemonClient', () => {
  let client;
  let mockSocket;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock socket
    mockSocket = new EventEmitter();
    mockSocket.write = jest.fn();
    mockSocket.destroy = jest.fn();
    mockSocket.destroyed = false;

    // Setup net.createConnection mock
    net.createConnection.mockImplementation(() => {
      // Simulate async connection
      setTimeout(() => mockSocket.emit('connect'), 10);
      return mockSocket;
    });

    client = new DaemonClient();
  });

  afterEach(() => {
    if (client) {
      client.disconnect();
    }
  });

  describe('constructor', () => {
    test('should initialize with disconnected state', () => {
      const newClient = new DaemonClient();
      expect(newClient.connected).toBe(false);
      expect(newClient.client).toBeNull();
    });

    test('should initialize empty terminals cache', () => {
      const newClient = new DaemonClient();
      expect(newClient.terminals.size).toBe(0);
    });

    test('can target a profile-scoped terminal daemon pipe', async () => {
      const profileClient = new DaemonClient({ profileName: 'sideprofile' });

      await profileClient.connect();

      expect(net.createConnection).toHaveBeenCalledWith(getProfilePipePath('sideprofile', process.platform));
      profileClient.disconnect();
    });

    test('spawns daemon through the running Electron binary as node', async () => {
      const profileClient = new DaemonClient({
        profileName: 'sideprofile',
        daemonEnv: {
          ELECTRON_RUN_AS_NODE: 'stale',
          Electron_Run_As_Node: 'stale-case-variant',
          SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\sideprofile',
          SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\sideprofile',
        },
      });

      await profileClient._spawnDaemon();

      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        [expect.stringContaining('terminal-daemon.js')],
        expect.objectContaining({
          env: expect.objectContaining({
            SQUIDRUN_PROFILE: 'sideprofile',
            SQUIDRUN_DATA_ROOT: 'D:\\SquidRun\\sideprofile',
            SQUIDRUN_PROJECT_ROOT: 'D:\\SquidRun\\sideprofile',
            ELECTRON_RUN_AS_NODE: '1',
          }),
        })
      );
      const env = spawn.mock.calls[0][2].env;
      expect(env.Electron_Run_As_Node).toBeUndefined();
    });

    test('should extend EventEmitter', () => {
      expect(client).toBeInstanceOf(EventEmitter);
    });
  });

  describe('connect', () => {
    test('should attempt connection to PIPE_PATH', async () => {
      const connectPromise = client.connect();

      // Wait for connection
      await connectPromise;

      expect(net.createConnection).toHaveBeenCalledWith(PIPE_PATH);
    });

    test('should set connected=true on successful connection', async () => {
      await client.connect();
      expect(client.connected).toBe(true);
    });

    test('should emit connected event with terminals list', async () => {
      const connectedHandler = jest.fn();
      client.on('connected', connectedHandler);

      await client.connect();

      // Simulate daemon sending connected event
      const connectedMsg = JSON.stringify({ event: 'connected', terminals: [] }) + '\n';
      mockSocket.emit('data', connectedMsg);

      expect(connectedHandler).toHaveBeenCalledWith([]);
    });

    test('tracks whether daemon was spawned during latest connect', async () => {
      await client.connect();
      expect(client.didSpawnDuringLastConnect()).toBe(false);

      let connectionAttempt = 0;
      net.createConnection.mockImplementation(() => {
        const socket = new EventEmitter();
        socket.write = jest.fn();
        socket.destroy = jest.fn();
        socket.destroyed = false;

        setTimeout(() => {
          connectionAttempt += 1;
          if (connectionAttempt === 1) {
            socket.emit('error', new Error('ENOENT'));
          } else {
            socket.emit('connect');
          }
        }, 10);

        return socket;
      });

      const spawnedClient = new DaemonClient();
      await spawnedClient.connect();
      expect(spawnedClient.didSpawnDuringLastConnect()).toBe(true);
      spawnedClient.disconnect();
    });

    test('reuses active connection instead of opening duplicate sockets', async () => {
      await client.connect();
      expect(net.createConnection).toHaveBeenCalledTimes(1);

      await client.connect();
      expect(net.createConnection).toHaveBeenCalledTimes(1);
    });

    test('dedupes concurrent connect calls to a single socket attempt', async () => {
      const first = client.connect();
      const second = client.connect();
      await Promise.all([first, second]);

      expect(net.createConnection).toHaveBeenCalledTimes(1);
    });

    test('connectExisting attaches to the existing pipe without spawning a daemon', async () => {
      await expect(client.connectExisting()).resolves.toBe(true);

      expect(client.connected).toBe(true);
      expect(net.createConnection).toHaveBeenCalledWith(PIPE_PATH);
      expect(spawn).not.toHaveBeenCalled();
      expect(client.didSpawnDuringLastConnect()).toBe(false);
    });

    test('connectExisting fails closed when the pipe is absent', async () => {
      net.createConnection.mockImplementation(() => {
        const socket = new EventEmitter();
        socket.write = jest.fn();
        socket.destroy = jest.fn();
        socket.destroyed = false;
        setTimeout(() => socket.emit('error', new Error('ENOENT')), 0);
        return socket;
      });

      await expect(client.connectExisting()).resolves.toBe(false);

      expect(client.connected).toBe(false);
      expect(net.createConnection).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
      expect(client.didSpawnDuringLastConnect()).toBe(false);
    });

    test('ignores stale socket data after reconnect swap', async () => {
      const socketA = new EventEmitter();
      socketA.write = jest.fn();
      socketA.destroy = jest.fn();
      socketA.destroyed = false;

      const socketB = new EventEmitter();
      socketB.write = jest.fn();
      socketB.destroy = jest.fn();
      socketB.destroyed = false;

      let connectCall = 0;
      net.createConnection.mockImplementation(() => {
        connectCall += 1;
        const socket = connectCall === 1 ? socketA : socketB;
        setTimeout(() => socket.emit('connect'), 0);
        return socket;
      });

      const dataHandler = jest.fn();
      client.on('data', dataHandler);

      await client.connect();
      // Force a reconnect path while socketA still exists.
      client.connected = false;
      await client.connect();

      socketA.emit('data', JSON.stringify({ event: 'data', paneId: '1', data: 'from-stale' }) + '\n');
      socketB.emit('data', JSON.stringify({ event: 'data', paneId: '1', data: 'from-active' }) + '\n');

      expect(dataHandler).toHaveBeenCalledTimes(1);
      expect(dataHandler).toHaveBeenCalledWith('1', 'from-active');
    });
  });

  describe('disconnect', () => {
    test('should set connected=false', async () => {
      await client.connect();
      expect(client.connected).toBe(true);

      client.disconnect();
      expect(client.connected).toBe(false);
    });

    test('should destroy socket', async () => {
      await client.connect();
      client.disconnect();

      expect(mockSocket.destroy).toHaveBeenCalled();
    });

    test('should set client to null', async () => {
      await client.connect();
      client.disconnect();

      expect(client.client).toBeNull();
    });
  });

  describe('spawn', () => {
    test('should send spawn action with paneId', async () => {
      await client.connect();

      client.spawn('1', '/tmp');

      expect(mockSocket.write).toHaveBeenCalled();
      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));

      expect(parsed.action).toBe('spawn');
      expect(parsed.paneId).toBe('1');
      expect(parsed.cwd).toBe('/tmp');
      expect(parsed.env).toEqual(expect.objectContaining({
        SQUIDRUN_ROLE: 'Architect',
        SQUIDRUN_PANE_ID: '1',
      }));
    });

    test('L0 characterizes the legacy daemon spawn request as pane-keyed and lease-free', async () => {
      await client.connect();

      client.spawn(
        'trustquote-lead',
        'D:\\projects\\TrustQuote',
        false,
        'pty-command',
        { SQUIDRUN_ROLE: 'trustquote-lead' },
        { paneCommand: 'codex', spawnCommandOnCreate: true }
      );

      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));

      expect(parsed).toEqual(expect.objectContaining({
        action: 'spawn',
        paneId: 'trustquote-lead',
        cwd: 'D:\\projects\\TrustQuote',
        mode: 'pty-command',
        env: expect.objectContaining({
          SQUIDRUN_ROLE: 'trustquote-lead',
          SQUIDRUN_PANE_ID: 'trustquote-lead',
        }),
        options: {
          paneCommand: 'codex',
          spawnCommandOnCreate: true,
        },
      }));
      expect(parsed).not.toHaveProperty('address');
      expect(parsed).not.toHaveProperty('leaseId');
      expect(parsed.options).not.toHaveProperty('address');
      expect(parsed.options).not.toHaveProperty('leaseId');
    });

    test('strips Electron-as-Node from pane spawn env', async () => {
      await client.connect();

      client.spawn('2', '/tmp', false, null, {
        ELECTRON_RUN_AS_NODE: '1',
        Electron_Run_As_Node: '1',
        KEEP_ME: 'yes',
      });

      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));

      expect(parsed.env).toEqual(expect.objectContaining({
        SQUIDRUN_PANE_ID: '2',
        KEEP_ME: 'yes',
      }));
      expect(parsed.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(parsed.env.Electron_Run_As_Node).toBeUndefined();
    });

    test('should return false when not connected', () => {
      const result = client.spawn('1', '/tmp');
      expect(result).toBe(false);
    });

    test('removes caller-authored launch identity fields before the app-owned spawn checkpoint', async () => {
      const previousGeneration = process.env.SQUIDRUN_APP_GENERATION;
      delete process.env.SQUIDRUN_APP_GENERATION;
      try {
        await client.connect();
        client.spawn('3', 'D:\\projects\\squidrun', false, null, {
          squidrun_role: 'Architect',
          SquidRun_Pane_Id: '1',
          SQUIDRUN_PANE_LAUNCH_ID: `pl_${'f'.repeat(32)}`,
          squidrun_app_generation: 'app-session-999',
          KEEP_ME: 'yes',
        }, {
          paneCommand: 'codex',
          spawnCommandOnCreate: true,
        });

        const request = JSON.parse(mockSocket.write.mock.calls.at(-1)[0].trim());
        expect(request.env).toEqual(expect.objectContaining({
          KEEP_ME: 'yes',
          SQUIDRUN_ROLE: 'Oracle',
          SQUIDRUN_PANE_ID: '3',
        }));
        expect(Object.keys(request.env).filter((key) => (
          ['SQUIDRUN_ROLE', 'SQUIDRUN_PANE_ID'].includes(key.toUpperCase())
        ))).toEqual(['SQUIDRUN_ROLE', 'SQUIDRUN_PANE_ID']);
        expect(Object.keys(request.env).filter((key) => (
          ['SQUIDRUN_PANE_LAUNCH_ID', 'SQUIDRUN_APP_GENERATION'].includes(key.toUpperCase())
        ))).toEqual([]);
        expect(client.pendingPaneLaunchBindings.has('3')).toBe(false);
      } finally {
        if (previousGeneration === undefined) delete process.env.SQUIDRUN_APP_GENERATION;
        else process.env.SQUIDRUN_APP_GENERATION = previousGeneration;
      }
    });

    test('removes nested spawn options that could replace app-owned env and request provenance', async () => {
      const previousGeneration = process.env.SQUIDRUN_APP_GENERATION;
      delete process.env.SQUIDRUN_APP_GENERATION;
      try {
        await client.connect();
        client.spawn('3', 'D:\\projects\\squidrun', false, null, {
          SQUIDRUN_PANE_LAUNCH_ID: `pl_${'a'.repeat(32)}`,
          SQUIDRUN_APP_GENERATION: 'app-session-999',
        }, {
          paneCommand: 'codex',
          spawnCommandOnCreate: true,
          env: {
            SQUIDRUN_PANE_LAUNCH_ID: `pl_${'b'.repeat(32)}`,
            SQUIDRUN_APP_GENERATION: 'app-session-998',
          },
          requestId: 'nested-override',
          mode: 'nested-mode',
        });

        const request = JSON.parse(mockSocket.write.mock.calls.at(-1)[0].trim());
        expect(request.requestId).toMatch(/^pane-spawn-/u);
        expect(request.requestId).not.toBe('nested-override');
        expect(request.options).toEqual({
          paneCommand: 'codex',
          spawnCommandOnCreate: true,
        });
        expect(request.env.SQUIDRUN_PANE_LAUNCH_ID).toBeUndefined();
        expect(request.env.SQUIDRUN_APP_GENERATION).toBeUndefined();
      } finally {
        if (previousGeneration === undefined) delete process.env.SQUIDRUN_APP_GENERATION;
        else process.env.SQUIDRUN_APP_GENERATION = previousGeneration;
      }
    });

    test('waits for the matching daemon spawned event before accepting command-on-create', async () => {
      await client.connect();

      const pending = client.spawnAndWait(
        '3',
        'D:\\projects\\squidrun',
        false,
        null,
        null,
        { paneCommand: 'codex --yolo', spawnCommandOnCreate: true }
      );
      const request = JSON.parse(mockSocket.write.mock.calls.at(-1)[0].trim());
      mockSocket.emit('data', `${JSON.stringify({
        event: 'spawned',
        requestId: request.requestId,
        paneId: '3',
        pid: 42608,
        dryRun: false,
        mode: 'pty-command',
      })}\n`);

      await expect(pending).resolves.toEqual(expect.objectContaining({
        ok: true,
        reason: 'daemon_pane_spawn_observed',
        paneId: '3',
        pid: 42608,
        requestId: request.requestId,
      }));
    });

    test('waits for the exact request-scoped spawn error', async () => {
      await client.connect();

      const pending = client.spawnAndWait(
        '3',
        'D:\\projects\\squidrun',
        false,
        null,
        null,
        { paneCommand: 'codex --yolo', spawnCommandOnCreate: true }
      );
      const request = JSON.parse(mockSocket.write.mock.calls.at(-1)[0].trim());
      mockSocket.emit('data', `${JSON.stringify({
        event: 'error',
        requestId: 'unrelated-request',
        paneId: '3',
        message: 'unrelated attach error',
      })}\n`);
      mockSocket.emit('data', `${JSON.stringify({
        event: 'error',
        requestId: request.requestId,
        paneId: '3',
        message: 'exact spawn error',
      })}\n`);

      await expect(pending).resolves.toEqual(expect.objectContaining({
        ok: false,
        reason: 'daemon_pane_spawn_failed',
        error: 'exact spawn error',
        requestId: request.requestId,
      }));
    });
  });

  describe('spawnAddressed', () => {
    test('sends the required durable receipt fields and waits for its request result', async () => {
      await client.connect();

      const pending = client.spawnAddressed({
        requestId: 'spawn-request-1',
        durableAddress: 'arm://qa/portal',
        paneId: 'qa-portal',
        cwd: 'D:\\qa\\portal',
        owner: 'terminal-daemon',
        recoveryEvent: 'lease_check_on_spawn',
        sourceMessageId: 'ping-1',
        expectedResponseClass: 'arm.liveness.pong',
        env: { SQUIDRUN_ROLE: 'qa-portal' },
        options: { paneCommand: 'codex', spawnCommandOnCreate: true },
      });

      const request = JSON.parse(mockSocket.write.mock.calls[0][0].trim());
      expect(request).toEqual(expect.objectContaining({
        action: 'spawn-addressed',
        requestId: 'spawn-request-1',
        durableAddress: 'arm://qa/portal',
        paneId: 'qa-portal',
        owner: 'terminal-daemon',
        recoveryEvent: 'lease_check_on_spawn',
        sourceMessageId: 'ping-1',
        expectedResponseClass: 'arm.liveness.pong',
        env: expect.objectContaining({
          SQUIDRUN_ROLE: 'qa-portal',
          SQUIDRUN_PANE_ID: 'qa-portal',
        }),
      }));

      mockSocket.emit('data', JSON.stringify({
        event: 'address-spawn-result',
        requestId: 'spawn-request-1',
        ok: true,
        status: 'spawned',
        paneId: 'qa-portal',
        durableAddress: 'arm://qa/portal',
        spawnLeaseId: 'lease-1',
        terminal: {
          paneId: 'qa-portal',
          pid: 4321,
          durableAddress: 'arm://qa/portal',
          spawnLeaseId: 'lease-1',
        },
      }) + '\n');

      await expect(pending).resolves.toEqual(expect.objectContaining({
        ok: true,
        spawnLeaseId: 'lease-1',
      }));
      expect(client.getTerminal('qa-portal')).toEqual(expect.objectContaining({
        alive: true,
        pid: 4321,
        durableAddress: 'arm://qa/portal',
        spawnLeaseId: 'lease-1',
      }));
    });

    test('returns a refusal without replacing the cached live generation', async () => {
      await client.connect();
      client.terminals.set('qa-portal', {
        paneId: 'qa-portal',
        pid: 4321,
        alive: true,
        spawnLeaseId: 'lease-1',
      });

      const pending = client.spawnAddressed({
        requestId: 'spawn-request-2',
        durableAddress: 'arm://qa/portal',
        paneId: 'qa-portal',
        owner: 'terminal-daemon',
        recoveryEvent: 'lease_check_on_spawn',
        sourceMessageId: 'ping-2',
        expectedResponseClass: 'arm.liveness.pong',
      });
      mockSocket.emit('data', JSON.stringify({
        event: 'address-spawn-result',
        requestId: 'spawn-request-2',
        ok: false,
        status: 'refused',
        reason: 'address_lease_held',
        paneId: 'qa-portal',
        spawnLeaseId: 'lease-1',
      }) + '\n');

      await expect(pending).resolves.toEqual(expect.objectContaining({
        ok: false,
        reason: 'address_lease_held',
      }));
      expect(client.getTerminal('qa-portal')).toEqual(expect.objectContaining({
        pid: 4321,
        spawnLeaseId: 'lease-1',
      }));
    });

    test('fails closed before sending when the daemon is disconnected', async () => {
      await expect(client.spawnAddressed({
        durableAddress: 'arm://qa/portal',
        paneId: 'qa-portal',
      })).resolves.toEqual(expect.objectContaining({
        ok: false,
        status: 'not_connected',
      }));
    });
  });

  describe('killAddressed', () => {
    test('waits for a generation-specific kill result and clears only the matching cache', async () => {
      await client.connect();
      client.terminals.set('qa-portal', {
        paneId: 'qa-portal',
        pid: 4321,
        alive: true,
        durableAddress: 'arm://qa/portal',
        spawnLeaseId: 'lease-2',
      });

      const pending = client.killAddressed({
        requestId: 'kill-request-1',
        durableAddress: 'arm://qa/portal',
        spawnLeaseId: 'lease-2',
        paneId: 'qa-portal',
        reason: 'registry_rollback',
      });
      const request = JSON.parse(mockSocket.write.mock.calls[0][0].trim());
      expect(request).toEqual(expect.objectContaining({
        action: 'kill-addressed',
        requestId: 'kill-request-1',
        durableAddress: 'arm://qa/portal',
        spawnLeaseId: 'lease-2',
        reason: 'registry_rollback',
      }));
      mockSocket.emit('data', JSON.stringify({
        event: 'address-kill-result',
        requestId: 'kill-request-1',
        ok: true,
        status: 'killed',
        paneId: 'qa-portal',
        spawnLeaseId: 'lease-2',
      }) + '\n');

      await expect(pending).resolves.toEqual(expect.objectContaining({ ok: true, status: 'killed' }));
      expect(client.getTerminal('qa-portal')).toBeUndefined();
    });

    test('stale generation refusal preserves the newer cached terminal', async () => {
      await client.connect();
      client.terminals.set('qa-portal', {
        paneId: 'qa-portal',
        pid: 4322,
        alive: true,
        spawnLeaseId: 'lease-2',
      });
      const pending = client.killAddressed({
        requestId: 'kill-request-2',
        durableAddress: 'arm://qa/portal',
        spawnLeaseId: 'lease-1',
        paneId: 'qa-portal',
      });
      mockSocket.emit('data', JSON.stringify({
        event: 'address-kill-result',
        requestId: 'kill-request-2',
        ok: false,
        status: 'stale_generation',
        paneId: 'qa-portal',
        spawnLeaseId: 'lease-1',
        activeSpawnLeaseId: 'lease-2',
      }) + '\n');

      await pending;
      expect(client.getTerminal('qa-portal')).toEqual(expect.objectContaining({
        pid: 4322,
        spawnLeaseId: 'lease-2',
      }));
    });
  });

  describe('write', () => {
    test('should send write action with data', async () => {
      await client.connect();

      client.write('1', 'hello\n');

      expect(mockSocket.write).toHaveBeenCalled();
      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));

      expect(parsed.action).toBe('write');
      expect(parsed.paneId).toBe('1');
      expect(parsed.data).toBe('hello\n');
    });

    test('should return false when not connected', () => {
      const result = client.write('1', 'test');
      expect(result).toBe(false);
    });

    test('should include kernelMeta when provided', async () => {
      await client.connect();

      client.write('1', 'hello', {
        eventId: 'evt-1',
        correlationId: 'corr-1',
        source: 'injection.js',
      });

      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));
      expect(parsed.kernelMeta).toEqual({
        eventId: 'evt-1',
        correlationId: 'corr-1',
        source: 'injection.js',
      });
    });

    test('writeAndWaitAck resolves on matching daemon.write.ack', async () => {
      await client.connect();

      const writePromise = client.writeAndWaitAck(
        '1',
        'hello',
        { eventId: 'evt-ack-1', correlationId: 'corr-ack-1', source: 'injection.js' },
        { timeoutMs: 200 }
      );

      const ackMsg = JSON.stringify({
        event: 'kernel-event',
        eventData: {
          type: 'daemon.write.ack',
          payload: { status: 'accepted', requestedByEventId: 'evt-ack-1' },
        },
      }) + '\n';
      mockSocket.emit('data', ackMsg);

      const result = await writePromise;
      expect(result.success).toBe(true);
      expect(result.status).toBe('accepted');
      expect(result.requestEventId).toBe('evt-ack-1');
    });

    test('writeAndWaitAck times out when no ack arrives', async () => {
      await client.connect();

      const result = await client.writeAndWaitAck(
        '1',
        'hello',
        { eventId: 'evt-ack-timeout', correlationId: 'corr-ack-timeout', source: 'injection.js' },
        { timeoutMs: 10 }
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe('ack_timeout');
    });
  });

  describe('resize', () => {
    test('should send resize action with cols and rows', async () => {
      await client.connect();

      client.resize('1', 120, 40);

      expect(mockSocket.write).toHaveBeenCalled();
      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));

      expect(parsed.action).toBe('resize');
      expect(parsed.paneId).toBe('1');
      expect(parsed.cols).toBe(120);
      expect(parsed.rows).toBe(40);
    });

    test('should include kernelMeta for resize when provided', async () => {
      await client.connect();

      client.resize('1', 120, 40, { correlationId: 'corr-2', source: 'terminal.js' });

      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));
      expect(parsed.kernelMeta).toEqual({ correlationId: 'corr-2', source: 'terminal.js' });
    });
  });

  describe('kill', () => {
    test('should send kill action', async () => {
      await client.connect();

      client.kill('1');

      expect(mockSocket.write).toHaveBeenCalled();
      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));

      expect(parsed.action).toBe('kill');
      expect(parsed.paneId).toBe('1');
    });
  });

  describe('list', () => {
    test('should send list action', async () => {
      await client.connect();

      client.list();

      expect(mockSocket.write).toHaveBeenCalled();
      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));

      expect(parsed.action).toBe('list');
    });
  });

  describe('message handling', () => {
    test('should emit data event', async () => {
      const dataHandler = jest.fn();
      client.on('data', dataHandler);

      await client.connect();

      const msg = JSON.stringify({ event: 'data', paneId: '1', data: 'output' }) + '\n';
      mockSocket.emit('data', msg);

      expect(dataHandler).toHaveBeenCalledWith('1', 'output');
    });

    test('should emit exit event', async () => {
      const exitHandler = jest.fn();
      client.on('exit', exitHandler);

      await client.connect();

      const msg = JSON.stringify({
        event: 'exit',
        paneId: '1',
        code: 0,
        pid: 9999,
        createdAt: 123,
      }) + '\n';
      mockSocket.emit('data', msg);

      expect(exitHandler).toHaveBeenCalledWith('1', 0, expect.objectContaining({
        pid: 9999,
        createdAt: 123,
      }));
    });

    test('keeps canonical terminal liveness but strips a launch identity with no app-owned handoff', async () => {
      const spawnedHandler = jest.fn();
      client.on('spawned', spawnedHandler);

      await client.connect();

      const msg = JSON.stringify({
        event: 'spawned',
        paneId: '1',
        pid: 9999,
        mode: 'pty',
        createdAt: 123,
        paneLaunchId: `pl_${'1'.repeat(32)}`,
        appGeneration: 'app-session-512',
      }) + '\n';
      mockSocket.emit('data', msg);

      expect(spawnedHandler).toHaveBeenCalledWith('1', 9999, false, expect.objectContaining({
        pid: 9999,
        createdAt: 123,
      }));
      expect(client.terminals.has('1')).toBe(true);
      expect(client.terminals.get('1').pid).toBe(9999);
      expect(client.terminals.get('1').createdAt).toBe(123);
      expect(client.terminals.get('1')).toEqual(expect.objectContaining({
        paneLaunchId: null,
        appGeneration: null,
      }));
      expect(spawnedHandler).toHaveBeenCalledWith('1', 9999, false, expect.objectContaining({
        paneLaunchId: null,
        appGeneration: null,
      }));
      expect(client.ownedPaneLaunchBindings.has('1')).toBe(false);
    });

    test('joins an older daemon spawn acknowledgement to the exact app-owned pending launch', async () => {
      const spawnedHandler = jest.fn();
      client.on('spawned', spawnedHandler);
      await client.connect();
      client.pendingPaneLaunchBindings.set('3', {
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-512',
        requestId: 'pane-spawn-512',
      });

      mockSocket.emit('data', `${JSON.stringify({
        event: 'spawned',
        requestId: 'pane-spawn-512',
        paneId: '3',
        pid: 7777,
      })}\n`);

      expect(client.getTerminal('3')).toEqual(expect.objectContaining({
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-512',
      }));
      expect(spawnedHandler).toHaveBeenCalledWith(
        '3',
        7777,
        false,
        expect.objectContaining({
          paneLaunchId: `pl_${'a'.repeat(32)}`,
          appGeneration: 'app-session-512',
        })
      );
      expect(client.pendingPaneLaunchBindings.has('3')).toBe(false);
      expect(client.ownedPaneLaunchBindings.get('3')).toEqual(expect.objectContaining({
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-512',
        pid: 7777,
        requestId: 'pane-spawn-512',
      }));
    });

    test('does not publish a daemon launch identity that disagrees with the app-owned pending launch', async () => {
      const spawnedHandler = jest.fn();
      client.on('spawned', spawnedHandler);
      await client.connect();
      const priorTerminal = {
        paneId: '3',
        pid: 6666,
        alive: true,
        paneLaunchId: `pl_${'0'.repeat(32)}`,
        appGeneration: 'app-session-512',
      };
      client.terminals.set('3', priorTerminal);
      const pending = {
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-512',
        requestId: 'pane-spawn-512',
      };
      client.pendingPaneLaunchBindings.set('3', pending);

      mockSocket.emit('data', `${JSON.stringify({
        event: 'spawned',
        requestId: 'pane-spawn-512',
        paneId: '3',
        pid: 7777,
        paneLaunchId: `pl_${'b'.repeat(32)}`,
        appGeneration: 'app-session-512',
      })}\n`);

      expect(client.getTerminal('3')).toBe(priorTerminal);
      expect(client.pendingPaneLaunchBindings.get('3')).toBe(pending);
      expect(spawnedHandler).not.toHaveBeenCalled();
    });

    test('ignores a different-request spawn event while preserving the pending launch and prior cache', async () => {
      const spawnedHandler = jest.fn();
      client.on('spawned', spawnedHandler);
      await client.connect();
      const priorTerminal = {
        paneId: '3',
        pid: 6666,
        alive: true,
        paneLaunchId: `pl_${'0'.repeat(32)}`,
        appGeneration: 'app-session-534',
      };
      client.terminals.set('3', priorTerminal);
      const pending = {
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
        requestId: 'expected-request',
      };
      client.pendingPaneLaunchBindings.set('3', pending);

      mockSocket.emit('data', `${JSON.stringify({
        event: 'spawned',
        requestId: 'different-request',
        paneId: '3',
        pid: 7777,
        paneLaunchId: `pl_${'b'.repeat(32)}`,
        appGeneration: 'app-session-534',
      })}\n`);

      expect(client.getTerminal('3')).toBe(priorTerminal);
      expect(client.pendingPaneLaunchBindings.get('3')).toBe(pending);
      expect(spawnedHandler).not.toHaveBeenCalled();
    });

    test('keeps a pending app-owned pane launch authoritative across daemon snapshots and addressed results', async () => {
      const connectedHandler = jest.fn();
      const listHandler = jest.fn();
      const spawnedHandler = jest.fn();
      client.on('connected', connectedHandler);
      client.on('list', listHandler);
      client.on('spawned', spawnedHandler);
      await client.connect();
      const priorTerminal = {
        paneId: '3',
        pid: 6666,
        alive: true,
        paneLaunchId: `pl_${'0'.repeat(32)}`,
        appGeneration: 'app-session-534',
      };
      client.terminals.set('3', priorTerminal);
      const pending = {
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
        requestId: 'expected-request',
      };
      client.pendingPaneLaunchBindings.set('3', pending);
      const unrelatedTerminal = {
        paneId: '2',
        pid: 5555,
        alive: true,
      };
      const competingTerminal = {
        paneId: '3',
        pid: 7777,
        alive: true,
        paneLaunchId: `pl_${'b'.repeat(32)}`,
        appGeneration: 'app-session-534',
      };

      mockSocket.emit('data', `${JSON.stringify({
        event: 'connected',
        terminals: [unrelatedTerminal, competingTerminal],
      })}\n`);
      mockSocket.emit('data', `${JSON.stringify({
        event: 'list',
        terminals: [unrelatedTerminal, competingTerminal],
      })}\n`);
      mockSocket.emit('data', `${JSON.stringify({
        event: 'address-spawn-result',
        requestId: 'addressed-request',
        ok: true,
        paneId: '3',
        terminal: competingTerminal,
      })}\n`);

      expect(client.getTerminal('3')).toBe(priorTerminal);
      expect(client.getTerminal('2')).toEqual(expect.objectContaining(unrelatedTerminal));
      expect(client.pendingPaneLaunchBindings.get('3')).toBe(pending);
      expect(connectedHandler).toHaveBeenLastCalledWith(expect.arrayContaining([
        priorTerminal,
        expect.objectContaining(unrelatedTerminal),
      ]));
      expect(listHandler).toHaveBeenLastCalledWith(expect.arrayContaining([
        priorTerminal,
        expect.objectContaining(unrelatedTerminal),
      ]));
      expect(spawnedHandler).not.toHaveBeenCalled();

      mockSocket.emit('data', `${JSON.stringify({
        event: 'spawned',
        requestId: 'expected-request',
        paneId: '3',
        pid: 8888,
      })}\n`);

      expect(client.getTerminal('3')).toEqual(expect.objectContaining({
        pid: 8888,
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
      }));
      expect(client.pendingPaneLaunchBindings.has('3')).toBe(false);
      expect(spawnedHandler).toHaveBeenCalledTimes(1);
    });

    test('recovers a pending app-owned launch from an exact reconnect snapshot without trusting newer rows', async () => {
      const spawnedHandler = jest.fn();
      client.on('spawned', spawnedHandler);
      await client.connect();
      const pending = {
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
        requestId: 'expected-request',
      };
      client.pendingPaneLaunchBindings.set('3', pending);

      mockSocket.emit('data', `${JSON.stringify({
        event: 'connected',
        terminals: [{
          paneId: '3',
          pid: 8888,
          alive: true,
          paneLaunchId: `pl_${'a'.repeat(32)}`,
          appGeneration: 'app-session-534',
          spawnRequestId: 'expected-request',
        }],
      })}\n`);

      expect(client.pendingPaneLaunchBindings.has('3')).toBe(false);
      expect(client.ownedPaneLaunchBindings.get('3')).toEqual(expect.objectContaining({
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
        pid: 8888,
        requestId: 'expected-request',
      }));
      expect(client.getTerminal('3')).toEqual(expect.objectContaining({
        pid: 8888,
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
        spawnRequestId: 'expected-request',
      }));
      expect(spawnedHandler).toHaveBeenCalledWith(
        '3',
        8888,
        false,
        expect.objectContaining({
          requestId: 'expected-request',
          paneLaunchRecovered: true,
        })
      );
    });

    test('does not let the same owned launch label move to a different process event or snapshot', async () => {
      const spawnedHandler = jest.fn();
      const listHandler = jest.fn();
      client.on('spawned', spawnedHandler);
      client.on('list', listHandler);
      await client.connect();
      const owned = {
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
        pid: 6666,
        requestId: 'owned-request',
      };
      const priorTerminal = {
        paneId: '3',
        pid: 6666,
        alive: true,
        paneLaunchId: owned.paneLaunchId,
        appGeneration: owned.appGeneration,
      };
      client.ownedPaneLaunchBindings.set('3', owned);
      client.terminals.set('3', priorTerminal);

      mockSocket.emit('data', `${JSON.stringify({
        event: 'spawned',
        requestId: 'unowned-request',
        paneId: '3',
        pid: 7777,
        paneLaunchId: owned.paneLaunchId,
        appGeneration: owned.appGeneration,
      })}\n`);

      expect(client.getTerminal('3')).toBe(priorTerminal);
      expect(client.ownedPaneLaunchBindings.get('3')).toBe(owned);
      expect(spawnedHandler).not.toHaveBeenCalled();

      mockSocket.emit('data', `${JSON.stringify({
        event: 'list',
        terminals: [{
          paneId: '3',
          pid: 8888,
          alive: true,
          paneLaunchId: owned.paneLaunchId,
          appGeneration: owned.appGeneration,
          spawnRequestId: 'owned-request',
        }],
      })}\n`);

      expect(client.getTerminal('3')).toBeUndefined();
      expect(client.ownedPaneLaunchBindings.get('3')).toBe(owned);
      expect(listHandler).toHaveBeenCalledWith([]);
      expect(spawnedHandler).not.toHaveBeenCalled();
    });

    test('clears owned launch authority only for the exact process lifecycle end', async () => {
      await client.connect();
      const owned = {
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
        pid: 7777,
        requestId: 'owned-request',
      };
      client.ownedPaneLaunchBindings.set('3', owned);
      client.terminals.set('3', {
        paneId: '3',
        pid: 7777,
        alive: true,
        paneLaunchId: owned.paneLaunchId,
        appGeneration: owned.appGeneration,
      });

      mockSocket.emit('data', `${JSON.stringify({
        event: 'exit',
        paneId: '3',
        pid: 6666,
        code: 0,
        paneLaunchId: owned.paneLaunchId,
        appGeneration: owned.appGeneration,
      })}\n`);
      expect(client.ownedPaneLaunchBindings.get('3')).toBe(owned);
      expect(client.getTerminal('3').alive).toBe(true);

      mockSocket.emit('data', `${JSON.stringify({
        event: 'exit',
        paneId: '3',
        pid: 7777,
        code: 0,
        paneLaunchId: owned.paneLaunchId,
        appGeneration: owned.appGeneration,
      })}\n`);
      expect(client.ownedPaneLaunchBindings.has('3')).toBe(false);
      expect(client.getTerminal('3').alive).toBe(false);
    });

    test.each([
      {
        retryReason: 'claude_session_collision',
        originalCommand: 'claude --dangerously-skip-permissions --resume 11111111-1111-4111-8111-111111111111',
        expectedCommand: 'claude --dangerously-skip-permissions',
        recoveryFlag: 'claudeCollisionRecoveryAttempted',
      },
      {
        retryReason: 'codex_missing_resume',
        originalCommand: 'codex --profile squidrun-oracle --yolo resume 22222222-2222-4222-8222-222222222222',
        expectedCommand: 'codex --profile squidrun-oracle --yolo',
        recoveryFlag: 'codexResumeRecoveryAttempted',
      },
    ])(
      'bounces $retryReason through a new app-owned request and process before publishing the replacement',
      async ({ retryReason, originalCommand, expectedCommand, recoveryFlag }) => {
        const retryResultHandler = jest.fn();
        const spawnedHandler = jest.fn();
        client.on('spawn-retry-result', retryResultHandler);
        client.on('spawned', spawnedHandler);
        await client.connect();

        const original = {
          paneLaunchId: `pl_${'a'.repeat(32)}`,
          appGeneration: 'app-session-534',
          pid: 6666,
          requestId: 'original-request',
          launchSpec: {
            cwd: 'D:\\projects\\squidrun',
            dryRun: false,
            mode: 'pty-command',
            env: { KEEP_ME: 'yes' },
            spawnOptions: {
              paneCommand: originalCommand,
              spawnCommandOnCreate: true,
            },
            retryCount: 0,
          },
        };
        client.ownedPaneLaunchBindings.set('3', original);
        client.terminals.set('3', {
          paneId: '3',
          pid: original.pid,
          alive: true,
          paneLaunchId: original.paneLaunchId,
          appGeneration: original.appGeneration,
          spawnRequestId: original.requestId,
        });

        const replacement = {
          paneLaunchId: `pl_${'b'.repeat(32)}`,
          appGeneration: original.appGeneration,
          requestId: 'replacement-request',
          launchSpec: {
            ...original.launchSpec,
            retryCount: 1,
          },
        };
        const spawnReplacement = jest.spyOn(client, 'spawn').mockImplementation(
          (paneId, cwd, dryRun, mode, env, spawnOptions, requestMeta) => {
            expect(paneId).toBe('3');
            expect(cwd).toBe(original.launchSpec.cwd);
            expect(dryRun).toBe(false);
            expect(mode).toBe('pty-command');
            expect(env).toEqual({ KEEP_ME: 'yes' });
            expect(spawnOptions).toEqual(expect.objectContaining({
              paneCommand: expectedCommand,
              spawnCommandOnCreate: true,
              [recoveryFlag]: true,
            }));
            expect(requestMeta).toEqual({
              retryCount: 1,
              requireLaunchBinding: true,
            });
            client.pendingPaneLaunchBindings.set('3', replacement);
            return true;
          }
        );

        mockSocket.emit('data', `${JSON.stringify({
          event: 'spawn-retry-requested',
          paneId: '3',
          reason: retryReason,
          pid: original.pid,
          paneLaunchId: original.paneLaunchId,
          appGeneration: original.appGeneration,
          spawnRequestId: original.requestId,
          // These daemon-authored fields are deliberately hostile. The app
          // must replay only its own saved launch specification.
          cwd: 'D:\\attacker',
          paneCommand: 'malicious-command',
          env: { SQUIDRUN_ROLE: 'Architect' },
        })}\n`);

        expect(spawnReplacement).toHaveBeenCalledTimes(1);
        expect(retryResultHandler).toHaveBeenCalledWith('3', expect.objectContaining({
          ok: true,
          retryReason,
          previousPaneLaunchId: original.paneLaunchId,
          replacementPaneLaunchId: replacement.paneLaunchId,
          replacementRequestId: replacement.requestId,
        }));
        expect(replacement.paneLaunchId).not.toBe(original.paneLaunchId);
        expect(replacement.requestId).not.toBe(original.requestId);

        mockSocket.emit('data', `${JSON.stringify({
          event: 'exit',
          paneId: '3',
          pid: original.pid,
          code: 1,
          paneLaunchId: original.paneLaunchId,
          appGeneration: original.appGeneration,
          spawnRequestId: original.requestId,
        })}\n`);
        expect(client.pendingPaneLaunchBindings.get('3')).toBe(replacement);
        expect(client.ownedPaneLaunchBindings.has('3')).toBe(false);

        mockSocket.emit('data', `${JSON.stringify({
          event: 'spawned',
          paneId: '3',
          pid: 7777,
          requestId: replacement.requestId,
        })}\n`);

        expect(client.pendingPaneLaunchBindings.has('3')).toBe(false);
        expect(client.ownedPaneLaunchBindings.get('3')).toEqual(expect.objectContaining({
          paneLaunchId: replacement.paneLaunchId,
          appGeneration: original.appGeneration,
          pid: 7777,
          requestId: replacement.requestId,
          launchSpec: expect.objectContaining({ retryCount: 1 }),
        }));
        expect(client.getTerminal('3')).toEqual(expect.objectContaining({
          pid: 7777,
          alive: true,
          paneLaunchId: replacement.paneLaunchId,
          appGeneration: original.appGeneration,
          spawnRequestId: replacement.requestId,
        }));
        expect(spawnedHandler).toHaveBeenCalledWith(
          '3',
          7777,
          false,
          expect.objectContaining({
            paneLaunchId: replacement.paneLaunchId,
            appGeneration: original.appGeneration,
            spawnRequestId: replacement.requestId,
          })
        );
      }
    );

    test('refuses retry requests that are stale, altered, unowned, repeated, or already being replaced', async () => {
      await client.connect();
      const baseOwned = {
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
        pid: 6666,
        requestId: 'owned-request',
        launchSpec: {
          cwd: 'D:\\projects\\squidrun',
          dryRun: false,
          mode: 'pty-command',
          env: {},
          spawnOptions: { paneCommand: 'codex', spawnCommandOnCreate: true },
          retryCount: 0,
        },
      };
      const baseEvent = {
        event: 'spawn-retry-requested',
        paneId: '3',
        reason: 'codex_missing_resume',
        pid: baseOwned.pid,
        paneLaunchId: baseOwned.paneLaunchId,
        appGeneration: baseOwned.appGeneration,
        spawnRequestId: baseOwned.requestId,
      };
      const refused = [
        { event: { ...baseEvent, reason: 'unknown_retry' } },
        { event: { ...baseEvent, pid: 7777 } },
        { event: { ...baseEvent, paneLaunchId: `pl_${'b'.repeat(32)}` } },
        { event: { ...baseEvent, appGeneration: 'app-session-older' } },
        { event: { ...baseEvent, spawnRequestId: 'stale-request' } },
        { event: baseEvent, owned: { ...baseOwned, retryRequested: true } },
        {
          event: baseEvent,
          owned: {
            ...baseOwned,
            launchSpec: { ...baseOwned.launchSpec, retryCount: 1 },
          },
        },
        { event: baseEvent, owned: { ...baseOwned, launchSpec: null } },
        { event: baseEvent, pending: true },
        { event: baseEvent, currentPid: 7777 },
      ];
      const spawnReplacement = jest.spyOn(client, 'spawn').mockReturnValue(true);

      for (const scenario of refused) {
        client.ownedPaneLaunchBindings.clear();
        client.pendingPaneLaunchBindings.clear();
        client.terminals.clear();
        client.ownedPaneLaunchBindings.set('3', scenario.owned || { ...baseOwned });
        client.terminals.set('3', {
          paneId: '3',
          pid: scenario.currentPid || baseOwned.pid,
          alive: true,
          paneLaunchId: baseOwned.paneLaunchId,
          appGeneration: baseOwned.appGeneration,
          spawnRequestId: baseOwned.requestId,
        });
        if (scenario.pending) {
          client.pendingPaneLaunchBindings.set('3', {
            paneLaunchId: `pl_${'c'.repeat(32)}`,
            appGeneration: baseOwned.appGeneration,
            requestId: 'replacement-in-flight',
          });
        }
        client._handleMessage(JSON.stringify(scenario.event));
      }

      client.ownedPaneLaunchBindings.clear();
      client.pendingPaneLaunchBindings.clear();
      client.terminals.clear();
      client._handleMessage(JSON.stringify(baseEvent));
      expect(spawnReplacement).not.toHaveBeenCalled();
    });

    test('sends no automatic retry process when the app cannot mint replacement launch authority', async () => {
      const previousGeneration = process.env.SQUIDRUN_APP_GENERATION;
      delete process.env.SQUIDRUN_APP_GENERATION;
      try {
        await client.connect();
        mockSocket.write.mockClear();

        const accepted = client.spawn(
          '3',
          'D:\\projects\\squidrun',
          false,
          'pty-command',
          {},
          { paneCommand: 'codex', spawnCommandOnCreate: true },
          { retryCount: 1, requireLaunchBinding: true }
        );

        expect(accepted).toBe(false);
        expect(mockSocket.write).not.toHaveBeenCalled();
        expect(client.pendingPaneLaunchBindings.has('3')).toBe(false);
      } finally {
        if (previousGeneration === undefined) delete process.env.SQUIDRUN_APP_GENERATION;
        else process.env.SQUIDRUN_APP_GENERATION = previousGeneration;
      }
    });

    test('an unrelated pane error cannot retire the exact pending spawn request', async () => {
      const errorHandler = jest.fn();
      client.on('error', errorHandler);
      await client.connect();
      const pending = {
        paneLaunchId: `pl_${'a'.repeat(32)}`,
        appGeneration: 'app-session-534',
        requestId: 'expected-request',
      };
      client.pendingPaneLaunchBindings.set('3', pending);

      mockSocket.emit('data', `${JSON.stringify({
        event: 'error',
        paneId: '3',
        requestId: 'unrelated-request',
        message: 'unrelated attach error',
      })}\n`);

      expect(client.pendingPaneLaunchBindings.get('3')).toBe(pending);
      expect(errorHandler).toHaveBeenCalledWith(
        '3',
        'unrelated attach error',
        expect.objectContaining({ requestId: 'unrelated-request' })
      );

      mockSocket.emit('data', `${JSON.stringify({
        event: 'error',
        paneId: '3',
        requestId: 'expected-request',
        message: 'spawn failed',
      })}\n`);

      expect(client.pendingPaneLaunchBindings.has('3')).toBe(false);
    });

    test('should not mark a newer cached terminal dead from a stale exit event', async () => {
      await client.connect();
      mockSocket.emit('data', `${JSON.stringify({
        event: 'spawned',
        paneId: '1',
        pid: 2222,
        createdAt: 200,
      })}\n`);

      mockSocket.emit('data', `${JSON.stringify({
        event: 'exit',
        paneId: '1',
        code: 0,
        pid: 1111,
        createdAt: 100,
      })}\n`);

      expect(client.terminals.get('1')).toEqual(expect.objectContaining({
        pid: 2222,
        alive: true,
      }));
    });

    test('should emit error event', async () => {
      const errorHandler = jest.fn();
      client.on('error', errorHandler);

      await client.connect();

      const msg = JSON.stringify({ event: 'error', paneId: '1', message: 'fail' }) + '\n';
      mockSocket.emit('data', msg);

      expect(errorHandler).toHaveBeenCalledWith(
        '1',
        'fail',
        expect.objectContaining({ paneId: '1', message: 'fail' })
      );
    });

    test('should handle multiple messages in one chunk', async () => {
      const dataHandler = jest.fn();
      client.on('data', dataHandler);

      await client.connect();

      const msg1 = JSON.stringify({ event: 'data', paneId: '1', data: 'first' });
      const msg2 = JSON.stringify({ event: 'data', paneId: '2', data: 'second' });
      mockSocket.emit('data', msg1 + '\n' + msg2 + '\n');

      expect(dataHandler).toHaveBeenCalledTimes(2);
      expect(dataHandler).toHaveBeenCalledWith('1', 'first');
      expect(dataHandler).toHaveBeenCalledWith('2', 'second');
    });

    test('should buffer incomplete messages', async () => {
      const dataHandler = jest.fn();
      client.on('data', dataHandler);

      await client.connect();

      // Send partial message
      mockSocket.emit('data', '{"event":"data","pane');
      expect(dataHandler).not.toHaveBeenCalled();

      // Complete the message
      mockSocket.emit('data', 'Id":"1","data":"test"}\n');
      expect(dataHandler).toHaveBeenCalledWith('1', 'test');
    });

    test('should emit kernel-event envelopes', async () => {
      const kernelHandler = jest.fn();
      client.on('kernel-event', kernelHandler);

      await client.connect();

      const eventData = {
        eventId: 'evt-k1',
        correlationId: 'corr-k1',
        causationId: null,
        type: 'daemon.write.ack',
        source: 'daemon',
        paneId: '1',
        ts: Date.now(),
        seq: 1,
        payload: { status: 'accepted' },
      };
      const msg = JSON.stringify({ event: 'kernel-event', eventData }) + '\n';
      mockSocket.emit('data', msg);

      expect(kernelHandler).toHaveBeenCalledWith(eventData);
    });

    test('should emit kernel-stats diagnostics', async () => {
      const statsHandler = jest.fn();
      client.on('kernel-stats', statsHandler);

      await client.connect();

      const stats = { droppedCount: 2, queueDepth: 5 };
      const msg = JSON.stringify({ event: 'kernel-stats', stats }) + '\n';
      mockSocket.emit('data', msg);

      expect(statsHandler).toHaveBeenCalledWith(stats);
    });

  });

  describe('terminals cache', () => {
    test('getTerminal should return cached terminal', async () => {
      await client.connect();

      // Simulate spawned event
      const msg = JSON.stringify({ event: 'spawned', paneId: '1', pid: 1234 }) + '\n';
      mockSocket.emit('data', msg);

      const terminal = client.getTerminal('1');
      expect(terminal).toBeDefined();
      expect(terminal.pid).toBe(1234);
    });

    test('getTerminals should return all cached terminals', async () => {
      await client.connect();

      // Simulate connected with existing terminals
      const msg = JSON.stringify({
        event: 'connected',
        terminals: [
          { paneId: '1', pid: 111, alive: true },
          { paneId: '2', pid: 222, alive: true },
        ]
      }) + '\n';
      mockSocket.emit('data', msg);

      const terminals = client.getTerminals();
      expect(terminals.length).toBe(2);
    });

    test('should clear terminals cache on list event', async () => {
      await client.connect();

      // Add a terminal
      client.terminals.set('1', { paneId: '1', pid: 111 });

      // List event clears and repopulates
      const msg = JSON.stringify({
        event: 'list',
        terminals: [{ paneId: '2', pid: 222, alive: true }]
      }) + '\n';
      mockSocket.emit('data', msg);

      expect(client.terminals.has('1')).toBe(false);
      expect(client.terminals.has('2')).toBe(true);
    });
  });

  describe('ping/pong', () => {
    test('should send ping action', async () => {
      await client.connect();

      client.ping();

      expect(mockSocket.write).toHaveBeenCalled();
      const sentData = mockSocket.write.mock.calls[0][0];
      const parsed = JSON.parse(sentData.replace('\n', ''));

      expect(parsed.action).toBe('ping');
    });

    test('should emit pong on pong event', async () => {
      const pongHandler = jest.fn();
      client.on('pong', pongHandler);

      await client.connect();

      const msg = JSON.stringify({ event: 'pong' }) + '\n';
      mockSocket.emit('data', msg);

      expect(pongHandler).toHaveBeenCalled();
    });
  });
});

describe('getDaemonClient singleton', () => {
  test('should return same instance on multiple calls', () => {
    // Clear module cache to get fresh singleton
    jest.resetModules();

    const { getDaemonClient: getSingleton } = require('../daemon-client');

    const instance1 = getSingleton();
    const instance2 = getSingleton();

    expect(instance1).toBe(instance2);
  });
});
