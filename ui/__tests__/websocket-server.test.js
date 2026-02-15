/**
 * WebSocket Server Facade Tests
 * Target: Full coverage of websocket-server.js
 */

'use strict';

const mockRuntime = {
  start: jest.fn().mockResolvedValue({ port: 3001 }),
  stop: jest.fn().mockResolvedValue(undefined),
  isRunning: jest.fn().mockReturnValue(true),
  getPort: jest.fn().mockReturnValue(3001),
  getClients: jest.fn().mockReturnValue([]),
  sendToTarget: jest.fn().mockReturnValue(true),
  sendToPane: jest.fn().mockReturnValue(true),
  broadcast: jest.fn().mockReturnValue(true),
  DEFAULT_PORT: 9867,
};

const mockWorkerClient = {
  start: jest.fn().mockResolvedValue({ port: 3002 }),
  stop: jest.fn().mockResolvedValue(undefined),
  isRunning: jest.fn().mockReturnValue(false),
  getPort: jest.fn().mockReturnValue(3002),
  getClients: jest.fn().mockReturnValue([{ id: 1 }]),
  sendToTarget: jest.fn().mockReturnValue(true),
  sendToPane: jest.fn().mockReturnValue(true),
  broadcast: jest.fn().mockReturnValue(true),
};

jest.mock('../modules/websocket-runtime', () => mockRuntime);
jest.mock('../modules/comms-worker-client', () => mockWorkerClient);

describe('WebSocket Server Facade', () => {
  afterEach(() => jest.clearAllMocks());

  // Default mode (worker client)
  describe('default mode (worker client)', () => {
    let server;

    beforeAll(() => {
      delete process.env.HIVEMIND_COMMS_FORCE_IN_PROCESS;
      jest.resetModules();
      jest.mock('../modules/websocket-runtime', () => mockRuntime);
      jest.mock('../modules/comms-worker-client', () => mockWorkerClient);
      server = require('../modules/websocket-server');
    });

    test('start delegates to workerClient', async () => {
      const result = await server.start({ port: 9999 });
      expect(mockWorkerClient.start).toHaveBeenCalledWith({ port: 9999 });
      expect(result).toEqual({ port: 3002 });
    });

    test('stop delegates to workerClient', async () => {
      await server.stop();
      expect(mockWorkerClient.stop).toHaveBeenCalled();
    });

    test('isRunning delegates to workerClient', () => {
      const result = server.isRunning();
      expect(mockWorkerClient.isRunning).toHaveBeenCalled();
      expect(result).toBe(false);
    });

    test('getPort delegates to workerClient', () => {
      const result = server.getPort();
      expect(mockWorkerClient.getPort).toHaveBeenCalled();
      expect(result).toBe(3002);
    });

    test('getClients delegates to workerClient', () => {
      const result = server.getClients();
      expect(mockWorkerClient.getClients).toHaveBeenCalled();
      expect(result).toEqual([{ id: 1 }]);
    });

    test('sendToTarget delegates to workerClient', () => {
      server.sendToTarget('builder', 'hello', { priority: 'high' });
      expect(mockWorkerClient.sendToTarget).toHaveBeenCalledWith('builder', 'hello', { priority: 'high' });
    });

    test('sendToPane delegates to workerClient', () => {
      server.sendToPane('2', 'msg', { ack: true });
      expect(mockWorkerClient.sendToPane).toHaveBeenCalledWith('2', 'msg', { ack: true });
    });

    test('broadcast delegates to workerClient', () => {
      server.broadcast('update', { exclude: '1' });
      expect(mockWorkerClient.broadcast).toHaveBeenCalledWith('update', { exclude: '1' });
    });

    test('exports DEFAULT_PORT from runtime', () => {
      expect(server.DEFAULT_PORT).toBe(9867);
    });
  });

  // In-process mode (runtime)
  describe('in-process mode (FORCE_IN_PROCESS=1)', () => {
    let server;

    beforeAll(() => {
      process.env.HIVEMIND_COMMS_FORCE_IN_PROCESS = '1';
      jest.resetModules();
      jest.mock('../modules/websocket-runtime', () => mockRuntime);
      jest.mock('../modules/comms-worker-client', () => mockWorkerClient);
      server = require('../modules/websocket-server');
    });

    afterAll(() => {
      delete process.env.HIVEMIND_COMMS_FORCE_IN_PROCESS;
    });

    test('start delegates to runtime', async () => {
      const result = await server.start({ port: 8888 });
      expect(mockRuntime.start).toHaveBeenCalledWith({ port: 8888 });
      expect(result).toEqual({ port: 3001 });
    });

    test('stop delegates to runtime', async () => {
      await server.stop();
      expect(mockRuntime.stop).toHaveBeenCalled();
    });

    test('isRunning delegates to runtime', () => {
      const result = server.isRunning();
      expect(mockRuntime.isRunning).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    test('getPort delegates to runtime', () => {
      const result = server.getPort();
      expect(mockRuntime.getPort).toHaveBeenCalled();
      expect(result).toBe(3001);
    });

    test('getClients delegates to runtime', () => {
      const result = server.getClients();
      expect(mockRuntime.getClients).toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    test('sendToTarget delegates to runtime', () => {
      server.sendToTarget('oracle', 'data', { flag: true });
      expect(mockRuntime.sendToTarget).toHaveBeenCalledWith('oracle', 'data', { flag: true });
    });

    test('sendToPane delegates to runtime', () => {
      server.sendToPane('5', 'msg', {});
      expect(mockRuntime.sendToPane).toHaveBeenCalledWith('5', 'msg', {});
    });

    test('broadcast delegates to runtime', () => {
      server.broadcast('alert', { urgent: true });
      expect(mockRuntime.broadcast).toHaveBeenCalledWith('alert', { urgent: true });
    });

    test('exports DEFAULT_PORT from runtime', () => {
      expect(server.DEFAULT_PORT).toBe(9867);
    });
  });
});
