const { EventEmitter } = require('events');

function createWorkerStub() {
  const worker = new EventEmitter();
  worker.connected = true;

  worker.send = jest.fn((msg) => {
    setImmediate(() => {
      if (msg.kind === 'request' && msg.action === 'start') {
        worker.emit('message', {
          kind: 'response',
          reqId: msg.reqId,
          ok: true,
          result: { ok: true, port: 9911 },
        });
        return;
      }

      if (msg.kind === 'request' && msg.action === 'shutdown') {
        worker.emit('message', {
          kind: 'response',
          reqId: msg.reqId,
          ok: true,
          result: { ok: true, shutdown: true },
        });
        worker.connected = false;
        worker.emit('exit', 0, null);
        return;
      }

      if (msg.kind === 'request' && msg.action === 'broadcast') {
        worker.emit('message', {
          kind: 'response',
          reqId: msg.reqId,
          ok: true,
          result: 2,
        });
        return;
      }

      if (msg.kind === 'request' && msg.action === 'sendToTarget') {
        worker.emit('message', {
          kind: 'response',
          reqId: msg.reqId,
          ok: true,
          result: false,
        });
        return;
      }

      if (msg.kind === 'request' && msg.action === 'sendToPane') {
        worker.emit('message', {
          kind: 'response',
          reqId: msg.reqId,
          ok: true,
          result: true,
        });
      }
    });
  });

  worker.kill = jest.fn(() => {
    worker.connected = false;
    setImmediate(() => worker.emit('exit', 0, 'SIGTERM'));
  });

  return worker;
}

describe('comms-worker-client', () => {
  let client;
  let forkMock;
  let workers;

  beforeEach(() => {
    jest.resetModules();

    workers = [];
    forkMock = jest.fn(() => {
      const worker = createWorkerStub();
      workers.push(worker);
      return worker;
    });

    jest.doMock('child_process', () => ({ fork: forkMock }));
    jest.doMock('../modules/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }));

    client = require('../modules/comms-worker-client');
  });

  afterEach(async () => {
    await client.resetForTests();
  });

  test('start initializes worker and caches running state/port', async () => {
    const result = await client.start({
      port: 0,
      onMessage: jest.fn(async () => ({ ok: true })),
    });

    expect(result.ok).toBe(true);
    expect(client.isRunning()).toBe(true);
    expect(client.getPort()).toBe(9911);
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  test('routes onMessage callback requests from worker to parent handler', async () => {
    const onMessage = jest.fn(async (payload) => ({ ok: true, routed: payload?.message?.type || 'none' }));
    await client.start({ port: 0, onMessage });

    const worker = workers[0];
    worker.emit('message', {
      kind: 'callback',
      reqId: 'cb-1',
      action: 'onMessage',
      payload: {
        data: {
          role: 'architect',
          message: { type: 'send', target: 'devops', content: 'ping' },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'architect',
      message: expect.objectContaining({ type: 'send' }),
    }));

    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'callback-response',
      reqId: 'cb-1',
      ok: true,
      result: expect.objectContaining({ ok: true, routed: 'send' }),
    }));
  });

  test('returns real worker delivery values for send/broadcast APIs', async () => {
    await client.start({ port: 0, onMessage: jest.fn(async () => ({ ok: true })) });

    const sendToTargetResult = await client.sendToTarget('devops', 'hello');
    const sendToPaneResult = await client.sendToPane('2', 'hello');
    const broadcastResult = await client.broadcast('hello-all');

    expect(sendToTargetResult).toBe(false);
    expect(sendToPaneResult).toBe(true);
    expect(broadcastResult).toBe(2);
  });

  test('broadcast is no-op when worker is not running', async () => {
    const result = await client.broadcast('hello');
    expect(result).toBe(0);
  });
});
