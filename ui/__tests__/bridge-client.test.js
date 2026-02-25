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
      metadata: {
        traceId: 't-1',
        structured: {
          type: 'conflictcheck',
          payload: {
            resource: 'ui/modules/auth.js',
            action: 'write',
            reason: 'sync protocol',
          },
        },
      },
      timeoutMs: 50,
    });

    const xsendFrame = JSON.parse(socket.sent[1]);
    expect(xsendFrame).toEqual({
      type: 'xsend',
      messageId: 'msg-1',
      fromDevice: 'LOCAL_A',
      toDevice: 'PEER_2',
      fromRole: 'architect',
      targetRole: 'architect',
      content: 'sync update',
      metadata: {
        traceId: 't-1',
        structured: {
          type: 'ConflictCheck',
          payload: {
            resource: 'ui/modules/auth.js',
            action: 'write',
            reason: 'sync protocol',
          },
        },
      },
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

  test('discoverDevices sends xdiscovery and resolves normalized device list', async () => {
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
    emitJson(socket, { type: 'register-ack', ok: true });
    expect(client.isReady()).toBe(true);

    const pending = client.discoverDevices({ timeoutMs: 100 });
    const discoveryFrame = JSON.parse(socket.sent[1]);
    expect(discoveryFrame.type).toBe('xdiscovery');
    expect(typeof discoveryFrame.requestId).toBe('string');
    expect(discoveryFrame.requestId).toContain('xdiscovery-');

    emitJson(socket, {
      type: 'xdiscovery',
      requestId: discoveryFrame.requestId,
      ok: true,
      devices: [
        { device_id: 'vigil', roles: ['architect', 'architect'], connected_since: '2026-02-25T00:00:00.000Z' },
        { device_id: 'macbook', roles: ['builder'], connected_since: '2026-02-25T00:01:00.000Z' },
      ],
    });

    await expect(pending).resolves.toMatchObject({
      ok: true,
      devices: [
        { device_id: 'MACBOOK', roles: ['builder'], connected_since: '2026-02-25T00:01:00.000Z' },
        { device_id: 'VIGIL', roles: ['architect'], connected_since: '2026-02-25T00:00:00.000Z' },
      ],
    });
  });

  test('discoverDevices returns clear unsupported error when relay rejects xdiscovery', async () => {
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
    emitJson(socket, { type: 'register-ack', ok: true });
    expect(client.isReady()).toBe(true);

    const pending = client.discoverDevices({ timeoutMs: 100 });
    emitJson(socket, {
      type: 'error',
      error: 'unsupported_type:xdiscovery',
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      status: 'bridge_discovery_unsupported',
      error: 'Relay does not support device discovery (xdiscovery)',
      devices: [],
    });
  });

  test('sendToDevice preserves unknownDevice and connectedDevices from relay xack', async () => {
    const client = createBridgeClient({
      relayUrl: 'ws://relay',
      deviceId: 'local_a',
      sharedSecret: 'secret',
    });

    expect(client.start()).toBe(true);
    const socket = instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.emit('open');
    emitJson(socket, { type: 'register-ack', ok: true });

    const pending = client.sendToDevice({
      messageId: 'msg-unknown-device',
      toDevice: 'windows',
      content: 'bridge ping',
      timeoutMs: 50,
    });

    emitJson(socket, {
      type: 'xack',
      messageId: 'msg-unknown-device',
      ok: false,
      accepted: false,
      queued: false,
      verified: false,
      status: 'target_offline',
      error: 'Unknown device WINDOWS. Connected devices: MACBOOK, VIGIL',
      fromDevice: 'LOCAL_A',
      toDevice: 'WINDOWS',
      unknownDevice: 'windows',
      connectedDevices: ['vigil', 'macbook'],
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      status: 'target_offline',
      unknownDevice: 'WINDOWS',
      connectedDevices: ['MACBOOK', 'VIGIL'],
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

  test('sendToDevice adds default FYI structured metadata when none provided', async () => {
    const client = createBridgeClient({
      relayUrl: 'ws://relay',
      deviceId: 'local_a',
      sharedSecret: 'secret',
    });

    expect(client.start()).toBe(true);
    const socket = instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.emit('open');
    emitJson(socket, { type: 'register-ack', ok: true });

    const pending = client.sendToDevice({
      messageId: 'msg-default-structured',
      toDevice: 'peer_2',
      content: 'plain bridge summary',
    });

    const xsendFrame = JSON.parse(socket.sent[1]);
    expect(xsendFrame.metadata.structured).toEqual({
      type: 'FYI',
      payload: {
        category: 'status',
        detail: 'plain bridge summary',
        impact: 'context-only',
        originalType: null,
      },
    });

    emitJson(socket, {
      type: 'xack',
      messageId: 'msg-default-structured',
      ok: true,
      status: 'bridge_delivered',
      fromDevice: 'LOCAL_A',
      toDevice: 'PEER_2',
    });
    await expect(pending).resolves.toMatchObject({ ok: true, status: 'bridge_delivered' });
  });

  test('sendToDevice downgrades unknown structured type to FYI', async () => {
    const client = createBridgeClient({
      relayUrl: 'ws://relay',
      deviceId: 'local_a',
      sharedSecret: 'secret',
    });

    expect(client.start()).toBe(true);
    const socket = instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.emit('open');
    emitJson(socket, { type: 'register-ack', ok: true });

    const pending = client.sendToDevice({
      messageId: 'msg-structured-unknown',
      toDevice: 'peer_2',
      content: 'plain fallback summary',
      metadata: {
        structured: {
          type: 'unexpectedType',
          payload: {
            detail: 'unknown type payload',
          },
        },
      },
    });

    const xsendFrame = JSON.parse(socket.sent[1]);
    expect(xsendFrame.metadata.structured).toEqual({
      type: 'FYI',
      payload: {
        category: 'status',
        detail: 'unknown type payload',
        impact: 'context-only',
        originalType: 'unexpectedType',
      },
    });

    emitJson(socket, {
      type: 'xack',
      messageId: 'msg-structured-unknown',
      ok: true,
      status: 'bridge_delivered',
      fromDevice: 'LOCAL_A',
      toDevice: 'PEER_2',
    });
    await expect(pending).resolves.toMatchObject({ ok: true, status: 'bridge_delivered' });
  });

  test('sendToDevice redacts sensitive outbound content and metadata before relay send', async () => {
    const client = createBridgeClient({
      relayUrl: 'ws://relay',
      deviceId: 'local_a',
      sharedSecret: 'secret',
    });

    expect(client.start()).toBe(true);
    const socket = instances[0];
    socket.readyState = MockWebSocket.OPEN;
    socket.emit('open');
    emitJson(socket, { type: 'register-ack', ok: true });

    const pending = client.sendToDevice({
      messageId: 'msg-redaction-1',
      toDevice: 'peer_2',
      content: [
        'OPENAI_API_KEY=sk-1234567890abcdefghijklmnop',
        'Authorization: Bearer supersecrettoken123',
        'read from /Users/jk/.env.production',
      ].join('\n'),
      metadata: {
        structured: {
          type: 'fyi',
          payload: {
            detail: 'token=ghp_1234567890abcdefghijklmnop',
            secret: 'dont-send-this',
            sourcePath: 'C:\\Users\\jk\\.env',
          },
        },
      },
    });

    const xsendFrame = JSON.parse(socket.sent[1]);
    expect(xsendFrame.content).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(xsendFrame.content).toContain('Bearer [REDACTED_TOKEN]');
    expect(xsendFrame.content).toContain('[REDACTED_PATH]');
    expect(xsendFrame.content).not.toContain('sk-1234567890abcdefghijklmnop');
    expect(xsendFrame.content).not.toContain('supersecrettoken123');

    expect(xsendFrame.metadata.structured.payload.detail).toContain('[REDACTED]');
    expect(xsendFrame.metadata.structured.payload.secret).toBe('[REDACTED]');
    expect(xsendFrame.metadata.structured.payload.sourcePath).toBe('[REDACTED_PATH]');

    emitJson(socket, {
      type: 'xack',
      messageId: 'msg-redaction-1',
      ok: true,
      status: 'bridge_delivered',
      fromDevice: 'LOCAL_A',
      toDevice: 'PEER_2',
    });

    await expect(pending).resolves.toMatchObject({ ok: true, status: 'bridge_delivered' });
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
      metadata: {
        line: 42,
        structured: {
          type: 'Approval',
          payload: { requestType: 'schema-change', details: 'Need migration', urgency: 'normal' },
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith({
      messageId: 'in-1',
      fromDevice: 'PEER-B',
      toDevice: 'LOCAL_A',
      content: 'status update',
      fromRole: 'architect',
      metadata: {
        line: 42,
        structured: {
          type: 'Approval',
          payload: { requestType: 'schema-change', details: 'Need migration', urgency: 'normal' },
        },
      },
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

  test('handleInboundDelivery downgrades unknown structured type to FYI before callback', async () => {
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
      messageId: 'in-structured-unknown',
      fromDevice: 'peer-b',
      content: 'fallback summary',
      metadata: {
        structured: {
          type: 'mysteryType',
          payload: { detail: 'mystery payload detail' },
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        structured: {
          type: 'FYI',
          payload: {
            category: 'status',
            detail: 'mystery payload detail',
            impact: 'context-only',
            originalType: 'mysteryType',
          },
        },
      },
    }));
  });

  test('handleInboundDelivery adds default FYI structured metadata when inbound metadata missing', async () => {
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
      messageId: 'in-no-metadata',
      fromDevice: 'peer-b',
      content: 'plain inbound summary',
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        structured: {
          type: 'FYI',
          payload: {
            category: 'status',
            detail: 'plain inbound summary',
            impact: 'context-only',
            originalType: null,
          },
        },
      },
    }));
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
