jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

function uniqueQueuePath() {
  return path.join(
    os.tmpdir(),
    `hivemind-comms-outbound-queue-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(queuePath, 'utf-8'));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.entries)) return parsed.entries;
  return [];
}

async function closeClient(ws) {
  if (!ws || ws.readyState === ws.CLOSED) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (ws.readyState !== ws.CLOSED) {
        ws.terminate();
      }
      resolve();
    }, 500);
    ws.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.close();
  });
}

async function connectAndRegister(port, role, paneId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox = [];

    ws.once('error', reject);
    ws.on('message', (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return;
      }
      inbox.push(msg);

      if (msg.type === 'welcome') {
        ws.send(JSON.stringify({ type: 'register', role, paneId }));
        return;
      }

      if (msg.type === 'registered') {
        resolve({ ws, inbox });
      }
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout waiting for websocket message')), timeoutMs);
    const onMessage = (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });
}

function loadRuntime({ queuePath, maxEntries = 500, maxAgeMs = 1800000 }) {
  jest.resetModules();
  process.env.HIVEMIND_COMMS_QUEUE_FILE = queuePath;
  process.env.HIVEMIND_COMMS_QUEUE_MAX_ENTRIES = String(maxEntries);
  process.env.HIVEMIND_COMMS_QUEUE_MAX_AGE_MS = String(maxAgeMs);
  process.env.HIVEMIND_COMMS_QUEUE_FLUSH_INTERVAL_MS = '30000';
  return require('../modules/websocket-runtime');
}

describe('websocket-runtime outbound queue', () => {
  let queuePath;

  beforeEach(() => {
    queuePath = uniqueQueuePath();
  });

  afterEach(() => {
    delete process.env.HIVEMIND_COMMS_QUEUE_FILE;
    delete process.env.HIVEMIND_COMMS_QUEUE_MAX_ENTRIES;
    delete process.env.HIVEMIND_COMMS_QUEUE_MAX_AGE_MS;
    delete process.env.HIVEMIND_COMMS_QUEUE_FLUSH_INTERVAL_MS;
    if (queuePath && fs.existsSync(queuePath)) {
      fs.unlinkSync(queuePath);
    }
  });

  test('queues undeliverable target message and flushes on target register', async () => {
    const runtime = loadRuntime({ queuePath });
    let receiver = null;
    try {
      await runtime.start({ port: 0, sessionScopeId: 'scope-a', onMessage: jest.fn() });
      const port = runtime.getPort();
      expect(port).toBeTruthy();

      const immediate = runtime.sendToTarget('devops', 'queued-once', { from: 'architect' });
      expect(immediate).toBe(false);
      expect(readQueue(queuePath)).toHaveLength(1);

      const connected = await connectAndRegister(port, 'devops', '2');
      receiver = connected.ws;
      const preRegisteredDelivery = connected.inbox.find(
        (msg) => msg.type === 'message' && msg.content === 'queued-once'
      );
      const delivered = preRegisteredDelivery || await waitForMessage(
        receiver,
        (msg) => msg.type === 'message' && msg.content === 'queued-once'
      );
      expect(delivered.from).toBe('architect');

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(readQueue(queuePath)).toHaveLength(0);
    } finally {
      await closeClient(receiver);
      await runtime.stop();
    }
  });

  test('replays queued messages after runtime restart when session scope matches', async () => {
    const runtimeA = loadRuntime({ queuePath });
    let runtimeB = null;
    let receiver = null;
    try {
      await runtimeA.start({ port: 0, sessionScopeId: 'scope-a', onMessage: jest.fn() });
      const queued = runtimeA.sendToTarget('devops', 'survives-restart', { from: 'architect' });
      expect(queued).toBe(false);
      expect(readQueue(queuePath)).toHaveLength(1);
      await runtimeA.stop();

      runtimeB = loadRuntime({ queuePath });
      await runtimeB.start({ port: 0, sessionScopeId: 'scope-a', onMessage: jest.fn() });
      const port = runtimeB.getPort();
      const connected = await connectAndRegister(port, 'devops', '2');
      receiver = connected.ws;

      const preRegisteredDelivery = connected.inbox.find(
        (msg) => msg.type === 'message' && msg.content === 'survives-restart'
      );
      const delivered = preRegisteredDelivery || await waitForMessage(
        receiver,
        (msg) => msg.type === 'message' && msg.content === 'survives-restart'
      );
      expect(delivered.from).toBe('architect');

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(readQueue(queuePath)).toHaveLength(0);
    } finally {
      await closeClient(receiver);
      if (runtimeB) {
        await runtimeB.stop();
      } else {
        await runtimeA.stop();
      }
    }
  });

  test('drops queued messages across session scope changes', async () => {
    const runtimeA = loadRuntime({ queuePath });
    let runtimeB = null;
    let receiver = null;
    try {
      await runtimeA.start({ port: 0, sessionScopeId: 'scope-a', onMessage: jest.fn() });
      const queued = runtimeA.sendToTarget('devops', 'stale-message', { from: 'architect' });
      expect(queued).toBe(false);
      expect(readQueue(queuePath)).toHaveLength(1);
      await runtimeA.stop();

      runtimeB = loadRuntime({ queuePath });
      await runtimeB.start({ port: 0, sessionScopeId: 'scope-b', onMessage: jest.fn() });
      const port = runtimeB.getPort();
      const connected = await connectAndRegister(port, 'devops', '2');
      receiver = connected.ws;

      const staleDelivery = connected.inbox.find(
        (msg) => msg.type === 'message' && msg.content === 'stale-message'
      );
      expect(staleDelivery).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(readQueue(queuePath)).toHaveLength(0);
    } finally {
      await closeClient(receiver);
      if (runtimeB) {
        await runtimeB.stop();
      } else {
        await runtimeA.stop();
      }
    }
  });

  test('enforces queue max entries by dropping oldest entries', async () => {
    const runtime = loadRuntime({ queuePath, maxEntries: 2 });
    await runtime.start({ port: 0, sessionScopeId: 'scope-a', onMessage: jest.fn() });

    runtime.sendToTarget('devops', 'first', { from: 'architect' });
    runtime.sendToTarget('devops', 'second', { from: 'architect' });
    runtime.sendToTarget('devops', 'third', { from: 'architect' });

    const queue = readQueue(queuePath);
    expect(queue).toHaveLength(2);
    expect(queue.map((entry) => entry.content)).toEqual(['second', 'third']);

    await runtime.stop();
  });
});
