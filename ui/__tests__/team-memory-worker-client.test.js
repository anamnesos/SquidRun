const { EventEmitter } = require('events');

function createWorkerStub() {
  const worker = new EventEmitter();
  worker.connected = true;
  worker.send = jest.fn((msg) => {
    setImmediate(() => {
      if (msg.type === 'close') {
        worker.emit('message', {
          type: 'response',
          reqId: msg.reqId,
          ok: true,
          result: { ok: true },
        });
        worker.connected = false;
        worker.emit('exit', 0, null);
        return;
      }

      worker.emit('message', {
        type: 'response',
        reqId: msg.reqId,
        ok: true,
        result: {
          ok: true,
          echoedType: msg.type,
          action: msg.action || null,
        },
      });
    });
  });
  worker.kill = jest.fn(() => {
    worker.connected = false;
    setImmediate(() => worker.emit('exit', 0, 'SIGTERM'));
  });
  return worker;
}

describe('team-memory worker client', () => {
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

    client = require('../modules/team-memory/worker-client');
  });

  afterEach(async () => {
    await client.resetForTests();
  });

  test('initializeRuntime forks worker and resolves', async () => {
    const result = await client.initializeRuntime({ runtimeOptions: {} });
    expect(result.ok).toBe(true);
    expect(result.echoedType).toBe('init');
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  test('executeOperation respawns worker after unexpected exit', async () => {
    const first = await client.executeOperation('health', {}, {});
    expect(first.ok).toBe(true);
    expect(forkMock).toHaveBeenCalledTimes(1);

    workers[0].connected = false;
    workers[0].emit('exit', 1, null);

    const second = await client.executeOperation('health', {}, {});
    expect(second.ok).toBe(true);
    expect(forkMock).toHaveBeenCalledTimes(2);
  });
});
