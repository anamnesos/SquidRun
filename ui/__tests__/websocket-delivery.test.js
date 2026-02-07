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
    ws.on('close', () => resolve());
    ws.close();
  });
}

describe('WebSocket Delivery Audit', () => {
  let port;

  beforeAll(async () => {
    port = 9900 + Math.floor(Math.random() * 500);
    await websocketServer.start({ port });
  });

  afterAll(async () => {
    await websocketServer.stop();
  });

  test('delivers send message to target pane', async () => {
    const receiver = await connectAndRegister({ port, role: 'devops', paneId: '2' });
    const sender = await connectAndRegister({ port, role: 'architect', paneId: '1' });

    const delivery = waitForMessage(receiver, (msg) => msg.type === 'message' && msg.content === 'ping');

    sender.send(JSON.stringify({
      type: 'send',
      target: '2',
      content: 'ping',
      priority: 'normal',
    }));

    const received = await delivery;
    expect(received.from).toBe('architect');

    await Promise.all([closeClient(sender), closeClient(receiver)]);
  });
});
