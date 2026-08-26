'use strict';

const { EventEmitter } = require('events');

jest.mock('../config', () => ({
  PIPE_PATH: '\\\\.\\pipe\\squidrun-test-terminal-daemon',
}));

const mockCreateConnection = jest.fn();
jest.mock('net', () => ({
  createConnection: (...args) => mockCreateConnection(...args),
}));

class MockSocket extends EventEmitter {
  constructor() {
    super();
    this.write = jest.fn();
    this.destroy = jest.fn();
  }
}

describe('daemon-snapshot', () => {
  let requestDaemonTerminalSnapshot;
  let socket;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    socket = new MockSocket();
    mockCreateConnection.mockReset();
    mockCreateConnection.mockReturnValue(socket);
    ({ requestDaemonTerminalSnapshot } = require('../modules/daemon-snapshot'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('requests terminal list from daemon pipe and resolves snapshot', async () => {
    const promise = requestDaemonTerminalSnapshot({ timeoutMs: 1000 });

    socket.emit('connect');
    expect(socket.write).toHaveBeenCalledWith('{"action":"list"}\n');

    socket.emit('data', Buffer.from(JSON.stringify({
      event: 'list',
      terminals: [{ paneId: '1', alive: true }],
    }) + '\n'));

    await expect(promise).resolves.toEqual({
      ok: true,
      source: 'terminal-daemon',
      event: 'list',
      terminals: [{ paneId: '1', alive: true }],
    });
    expect(socket.destroy).toHaveBeenCalled();
  });

  test('uses connected event as a valid terminal snapshot', async () => {
    const promise = requestDaemonTerminalSnapshot({ timeoutMs: 1000 });

    socket.emit('data', Buffer.from(JSON.stringify({
      event: 'connected',
      terminals: [{ paneId: '2', alive: true }],
    }) + '\n'));

    await expect(promise).resolves.toMatchObject({
      ok: true,
      source: 'terminal-daemon',
      event: 'connected',
      terminals: [{ paneId: '2', alive: true }],
    });
  });

  test('returns nonfatal error when pipe connection fails', async () => {
    const promise = requestDaemonTerminalSnapshot({ timeoutMs: 1000 });

    socket.emit('error', new Error('pipe missing'));

    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'daemon_snapshot_connect_failed',
      error: 'pipe missing',
      terminals: [],
    });
  });
});
