const { EventEmitter } = require('events');

function emitJson(socket, payload) {
  socket.emit('message', Buffer.from(JSON.stringify(payload)));
}

function createWebSocketMock(instances) {
  class MockWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      instances.push(this);
    }

    send(payload) {
      this.sent.push(payload);
      return true;
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }
  }

  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSED = 3;

  return MockWebSocket;
}

describe('bridge-client', () => {
  let instances;
  let MockWebSocket;
  let createBridgeClient;
  let logger;

  beforeEach(() => {
    jest.resetModules();
    instances = [];
    MockWebSocket = createWebSocketMock(instances);
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    jest.doMock('ws', () => MockWebSocket);
    jest.doMock('../modules/logger', () => logger);
    ({ createBridgeClient } = require('../modules/bridge-client'));
  });

  afterEach(() => {
    delete process.env.SQUIDRUN_BRIDGE_RECONNECT_BASE_MS;
    delete process.env.SQUIDRUN_BRIDGE_RECONNECT_MAX_MS;
    jest.useRealTimers();
  });

  test('sendToDevice emits xsend and resolves from xack', async () => {
    const client = createBridgeClient({
      relayUrl: 'ws://relay',
      deviceId: 'local_a',
      sharedSecret: 'secret',
    });

    expect(client.start()).toBe(true);
    expect(instances).toHaveLength(1);
    const socket = instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.emit('open');

    const registerFrame = JSON.parse(socket.sent[0]);
    expect(registerFrame).toEqual({
      type: 'register',
      deviceId: 'LOCAL_A',
      sharedSecret: 'secret',
    });

    emitJson(socket, { type: 'register-ack', ok: true });
    expect(client.isReady()).toBe(true);

    const pending = client.sendToDevice({
      messageId: 'msg-1',
      toDevice: 'peer_2',
      content: 'sync update',
      fromRole: 'architect',
      metadata: { traceId: 't-1' },
      timeoutMs: 50,
    });

    const xsendFrame = JSON.parse(socket.sent[1]);
    expect(xsendFrame).toEqual({
      type: 'xsend',
      messageId: 'msg-1',
      fromDevice: 'LOCAL_A',
      toDevice: 'PEER_2',
      fromRole: 'architect',
      content: 'sync update',
      metadata: { traceId: 't-1' },
    });

    emitJson(socket, {
      type: 'xack',
      messageId: 'msg-1',
      ok: true,
      status: 'bridge_delivered',
      fromDevice: 'LOCAL_A',
      toDevice: 'PEER_2',
    });

    await expect(pending).resolves.toMatchObject({
      ok: true,
      accepted: true,
      queued: true,
      verified: true,
      status: 'bridge_delivered',
      fromDevice: 'LOCAL_A',
      toDevice: 'PEER_2',
    });
  });

  test('sendToDevice returns bridge_unavailable when relay is not ready', async () => {
    const client = createBridgeClient({
      relayUrl: 'ws://relay',
      deviceId: 'local_a',
      sharedSecret: 'secret',
    });

    const result = await client.sendToDevice({
      messageId: 'msg-2',
      toDevice: 'peer',
      content: 'hello',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'bridge_unavailable',
      error: 'Relay is not connected',
    });
  });

  test('handleInboundDelivery calls onMessage and ACKs normalized payload', async () => {
    const onMessage = jest.fn().mockResolvedValue({
      ok: true,
      accepted: true,
      queued: true,
      verified: true,
      status: 'bridge_delivered',
    });

    const client = createBridgeClient({
      relayUrl: 'ws://relay',
      deviceId: 'local_a',
      sharedSecret: 'secret',
      onMessage,
    });

    const socket = new MockWebSocket('ws://relay');
    socket.readyState = MockWebSocket.OPEN;
    client.socket = socket;

    await client.handleInboundDelivery({
      messageId: 'in-1',
      fromDevice: 'peer-b!@',
      content: 'status update',
      fromRole: 'architect',
      metadata: { line: 42 },
    });

    expect(onMessage).toHaveBeenCalledWith({
      messageId: 'in-1',
      fromDevice: 'PEER-B',
      toDevice: 'LOCAL_A',
      content: 'status update',
      fromRole: 'architect',
      metadata: { line: 42 },
    });

    const ackFrame = JSON.parse(socket.sent[0]);
    expect(ackFrame).toMatchObject({
      type: 'xack',
      messageId: 'in-1',
      ok: true,
      accepted: true,
      queued: true,
      verified: true,
      status: 'bridge_delivered',
      fromDevice: 'PEER-B',
      toDevice: 'LOCAL_A',
    });
  });

  test('handleInboundDelivery returns bridge_handler_error when callback fails', async () => {
    const onMessage = jest.fn().mockRejectedValue(new Error('boom'));

    const client = createBridgeClient({
      relayUrl: 'ws://relay',
      deviceId: 'local_a',
      sharedSecret: 'secret',
      onMessage,
    });

    const socket = new MockWebSocket('ws://relay');
    socket.readyState = MockWebSocket.OPEN;
    client.socket = socket;

    await client.handleInboundDelivery({
      messageId: 'in-2',
      fromDevice: 'peer-b',
      content: 'status update',
    });

    const ackFrame = JSON.parse(socket.sent[0]);
    expect(ackFrame).toMatchObject({
      type: 'xack',
      messageId: 'in-2',
      ok: false,
      status: 'bridge_handler_error',
      error: 'boom',
    });
  });

  test('reconnects after close with exponential backoff timer', () => {
    jest.useFakeTimers();
    process.env.SQUIDRUN_BRIDGE_RECONNECT_BASE_MS = '5';
    process.env.SQUIDRUN_BRIDGE_RECONNECT_MAX_MS = '5';

    const client = createBridgeClient({
      relayUrl: 'ws://relay',
      deviceId: 'local_a',
      sharedSecret: 'secret',
    });

    expect(client.start()).toBe(true);
    expect(instances).toHaveLength(1);
    const firstSocket = instances[0];
    firstSocket.emit('close');

    expect(logger.warn).toHaveBeenCalledWith('Bridge', expect.stringContaining('Reconnecting in 5ms'));

    jest.advanceTimersByTime(5);
    expect(instances).toHaveLength(2);
  });
});
