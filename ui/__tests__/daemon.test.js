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
    });

    test('should return false when not connected', () => {
      const result = client.spawn('1', '/tmp');
      expect(result).toBe(false);
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

      const msg = JSON.stringify({ event: 'exit', paneId: '1', code: 0 }) + '\n';
      mockSocket.emit('data', msg);

      expect(exitHandler).toHaveBeenCalledWith('1', 0);
    });

    test('should emit spawned event and cache terminal', async () => {
      const spawnedHandler = jest.fn();
      client.on('spawned', spawnedHandler);

      await client.connect();

      const msg = JSON.stringify({ event: 'spawned', paneId: '1', pid: 9999 }) + '\n';
      mockSocket.emit('data', msg);

      expect(spawnedHandler).toHaveBeenCalledWith('1', 9999, false);
      expect(client.terminals.has('1')).toBe(true);
      expect(client.terminals.get('1').pid).toBe(9999);
    });

    test('should emit error event', async () => {
      const errorHandler = jest.fn();
      client.on('error', errorHandler);

      await client.connect();

      const msg = JSON.stringify({ event: 'error', paneId: '1', message: 'fail' }) + '\n';
      mockSocket.emit('data', msg);

      expect(errorHandler).toHaveBeenCalledWith('1', 'fail');
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
