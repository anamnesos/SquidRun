/**
 * WebSocket Delivery Audit
 * Ensures agent-to-agent delivery reaches the target pane.
 */

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const WebSocket = require('ws');
const websocketServer = require('../modules/websocket-server');

function connectAndRegister({ port, role, paneId }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    ws.on('error', reject);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return;
      }

      if (msg.type === 'welcome') {
        ws.send(JSON.stringify({ type: 'register', role, paneId }));
        return;
      }

      if (msg.type === 'registered') {
        resolve(ws);
      }
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return;
      }

      if (predicate(msg)) {
        clearTimeout(timeout);
        resolve(msg);
      }
    });
  });
}

function closeClient(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === ws.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) {
        ws.terminate();
      }
      resolve();
    }, 500);

    ws.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.close();
  });
}

describe('WebSocket Delivery Audit', () => {
  let port;
  let activeClients = new Set();
  let onMessageSpy;

  beforeAll(async () => {
    onMessageSpy = jest.fn();
    await websocketServer.start({
      port: 0,
      onMessage: (payload) => onMessageSpy(payload),
    });
    port = websocketServer.getPort();
    if (!port || port === 0) {
      throw new Error('WebSocket server failed to bind an ephemeral port');
    }
  });

  beforeEach(() => {
    activeClients = new Set();
    onMessageSpy.mockClear();
  });

  afterEach(async () => {
    const clients = Array.from(activeClients);
    activeClients.clear();
    await Promise.all(clients.map(closeClient));
  });

  afterAll(async () => {
    await websocketServer.stop();
  });

  test('delivers send message to target pane', async () => {
    const receiver = await connectAndRegister({ port, role: 'devops', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const delivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'ping');

    sender.send(JSON.stringify({
      type: 'send',
      target: '2',
      content: 'ping',
      priority: 'normal',
    }));

    const received = await delivery;
    expect(received.from).toBe('architect');
  });

  test('delivers send message to target role', async () => {
    const receiver = await connectAndRegister({ port, role: 'devops', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const delivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'role-ping');

    sender.send(JSON.stringify({
      type: 'send',
      target: 'devops',
      content: 'role-ping',
      priority: 'normal',
    }));

    const received = await delivery;
    expect(received.from).toBe('architect');
  });

  test('returns send-ack when ackRequired is true and route is delivered', async () => {
    const receiver = await connectAndRegister({ port, role: 'devops', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const messageId = 'ack-delivered-1';
    const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);
    const delivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'needs-ack');

    sender.send(JSON.stringify({
      type: 'send',
      target: 'devops',
      content: 'needs-ack',
      messageId,
      ackRequired: true,
    }));

    const [ack, received] = await Promise.all([ackPromise, delivery]);
    expect(ack.ok).toBe(true);
    expect(ack.status).toBe('delivered.websocket');
    expect(ack.traceId).toBe(messageId);
    expect(received.from).toBe('architect');
  });

  test('forwards trace context to message handler for routed send', async () => {
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);
    const messageId = 'trace-forward-1';

    const ackPromise = waitForMessage(
      sender,
      (msg) => msg.type === 'send-ack' && msg.messageId === messageId
    );

    sender.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'trace-forward',
      messageId,
      ackRequired: true,
    }));

    await ackPromise;
    const routedSend = onMessageSpy.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.message?.messageId === messageId);

    expect(routedSend).toBeDefined();
    expect(routedSend.traceContext).toEqual(expect.objectContaining({
      traceId: messageId,
      correlationId: messageId,
    }));
    expect(routedSend.message.traceContext).toEqual(expect.objectContaining({
      traceId: messageId,
      correlationId: messageId,
    }));
  });

  test('returns unrouted send-ack when ackRequired is true and no route exists', async () => {
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const messageId = 'ack-unrouted-1';
    const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);

    sender.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'no-route',
      messageId,
      ackRequired: true,
    }));

    const ack = await ackPromise;
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('unrouted');
  });

  test('deduplicates ackRequired send by messageId and reuses prior ack', async () => {
    const receiver = await connectAndRegister({ port, role: 'devops', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const messageId = 'ack-dedup-1';
    let deliveredCount = 0;
    receiver.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'message' && msg.content === 'dedup-payload') {
        deliveredCount++;
      }
    });

    const firstAck = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);
    const firstDelivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'dedup-payload');
    sender.send(JSON.stringify({
      type: 'send',
      target: 'devops',
      content: 'dedup-payload',
      messageId,
      ackRequired: true,
    }));
    await Promise.all([firstAck, firstDelivery]);

    const secondAckPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);
    sender.send(JSON.stringify({
      type: 'send',
      target: 'devops',
      content: 'dedup-payload',
      messageId,
      ackRequired: true,
    }));
    const secondAck = await secondAckPromise;

    await new Promise((resolve) => setTimeout(resolve, 100));

    const routedSendCalls = onMessageSpy.mock.calls
      .map(([payload]) => payload?.message)
      .filter((msg) => msg?.type === 'send' && msg?.messageId === messageId);
    const dedupeMetricCalls = onMessageSpy.mock.calls
      .map(([payload]) => payload?.message)
      .filter((msg) => msg?.type === 'comms-metric' && msg?.eventType === 'comms.dedupe.hit');

    expect(deliveredCount).toBe(1);
    expect(routedSendCalls).toHaveLength(1);
    expect(dedupeMetricCalls).toHaveLength(1);
    expect(dedupeMetricCalls[0].payload.mode).toBe('cache');
    expect(secondAck.ok).toBe(true);
    expect(secondAck.status).toBe('delivered.websocket');
  });

  test('returns cached delivery-check result for previously ACKed messageId', async () => {
    const receiver = await connectAndRegister({ port, role: 'devops', paneId: '2' });
    activeClients.add(receiver);
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    const messageId = 'delivery-check-cached-1';
    const ackPromise = waitForMessage(sender, (msg) => msg.type === 'send-ack' && msg.messageId === messageId);
    sender.send(JSON.stringify({
      type: 'send',
      target: 'devops',
      content: 'delivery-check-payload',
      messageId,
      ackRequired: true,
    }));
    const ack = await ackPromise;
    expect(ack.ok).toBe(true);

    const requestId = 'delivery-check-request-1';
    const checkPromise = waitForMessage(
      sender,
      (msg) => msg.type === 'delivery-check-result' && msg.requestId === requestId
    );
    sender.send(JSON.stringify({
      type: 'delivery-check',
      requestId,
      messageId,
    }));

    const check = await checkPromise;
    expect(check.known).toBe(true);
    expect(check.status).toBe('cached');
    expect(check.pending).toBe(false);
    expect(check.ack).toEqual(expect.objectContaining({
      type: 'send-ack',
      messageId,
      ok: true,
    }));
  });

  test('tracks heartbeat health and reports stale targets by threshold', async () => {
    const targetClient = await connectAndRegister({ port, role: 'devops', paneId: '2' });
    activeClients.add(targetClient);
    const probeClient = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(probeClient);

    const heartbeatAckPromise = waitForMessage(targetClient, (msg) => msg.type === 'heartbeat-ack');
    targetClient.send(JSON.stringify({
      type: 'heartbeat',
      role: 'devops',
      paneId: '2',
    }));
    await heartbeatAckPromise;

    const freshRequestId = 'health-fresh-1';
    const freshHealthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === freshRequestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'devops',
      requestId: freshRequestId,
    }));
    const freshHealth = await freshHealthPromise;
    expect(freshHealth.healthy).toBe(true);
    expect(freshHealth.status).toBe('healthy');
    expect(freshHealth.role).toBe('devops');
    expect(freshHealth.paneId).toBe('2');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const staleRequestId = 'health-stale-1';
    const staleHealthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === staleRequestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'devops',
      requestId: staleRequestId,
      staleAfterMs: 1,
    }));
    const staleHealth = await staleHealthPromise;
    expect(staleHealth.healthy).toBe(false);
    expect(staleHealth.status).toBe('stale');
  });

  test('clears heartbeat state when registered client disconnects', async () => {
    const targetClient = await connectAndRegister({ port, role: 'devops', paneId: '2' });
    activeClients.add(targetClient);
    const probeClient = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(probeClient);

    const heartbeatAckPromise = waitForMessage(targetClient, (msg) => msg.type === 'heartbeat-ack');
    targetClient.send(JSON.stringify({
      type: 'heartbeat',
      role: 'devops',
      paneId: '2',
    }));
    await heartbeatAckPromise;

    await closeClient(targetClient);
    activeClients.delete(targetClient);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const requestId = 'health-after-disconnect-1';
    const healthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === requestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'devops',
      requestId,
    }));

    const health = await healthPromise;
    expect(health.healthy).toBe(false);
    expect(health.status).toBe('no_heartbeat');
    expect(health.paneId).toBe('2');
    expect(health.role).toBe('devops');
  });

  test('refreshes target health on non-heartbeat message activity', async () => {
    const targetClient = await connectAndRegister({ port, role: 'devops', paneId: '2' });
    activeClients.add(targetClient);
    const probeClient = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(probeClient);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const staleRequestId = 'health-before-send-1';
    const staleHealthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === staleRequestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'devops',
      requestId: staleRequestId,
      staleAfterMs: 1,
    }));
    const staleHealth = await staleHealthPromise;
    expect(staleHealth.healthy).toBe(false);

    targetClient.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'presence-refresh-ping',
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const freshRequestId = 'health-after-send-1';
    const freshHealthPromise = waitForMessage(
      probeClient,
      (msg) => msg.type === 'health-check-result' && msg.requestId === freshRequestId
    );
    probeClient.send(JSON.stringify({
      type: 'health-check',
      target: 'devops',
      requestId: freshRequestId,
      staleAfterMs: 100,
    }));
    const freshHealth = await freshHealthPromise;
    expect(freshHealth.healthy).toBe(true);
    expect(freshHealth.status).toBe('healthy');
  });

  test('includes handler error details in send-ack when message handler throws', async () => {
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });
    activeClients.add(sender);

    onMessageSpy.mockImplementation((payload) => {
      if (payload?.message?.type === 'send' && payload?.message?.messageId === 'ack-handler-error-1') {
        throw new Error('simulated handler failure');
      }
      return undefined;
    });

    const ackPromise = waitForMessage(
      sender,
      (msg) => msg.type === 'send-ack' && msg.messageId === 'ack-handler-error-1'
    );

    sender.send(JSON.stringify({
      type: 'send',
      target: 'missing-role',
      content: 'handler-should-fail',
      messageId: 'ack-handler-error-1',
      ackRequired: true,
    }));

    const ack = await ackPromise;
    expect(ack.ok).toBe(false);
    expect(ack.status).toBe('handler_error');
    expect(ack.error).toBe('simulated handler failure');

    onMessageSpy.mockImplementation(() => undefined);
  });
});
