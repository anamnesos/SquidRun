/**
 * Tests for modules/logger.js
 * Tests structured logging with levels, timestamps, scopes, and file output.
 */

const path = require('path');

// Store original console methods for restoration
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

describe('logger', () => {
  let logger;
  let fsMock;

  beforeEach(() => {
    // Reset module cache
    jest.resetModules();
    // Override global mock from setup to use real logger module
    jest.unmock('../modules/logger');

    // Create fs mock
    fsMock = {
      mkdirSync: jest.fn(),
      appendFileSync: jest.fn(),
    };

    // Mock console
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();

    // Mock dependencies before requiring logger
    jest.doMock('fs', () => fsMock);
    jest.doMock('../config', () => ({
      WORKSPACE_PATH: path.join(__dirname, '__workspace__'),
    }));

    // Now require the logger
    logger = require('../modules/logger');
  });

  afterEach(() => {
    // Restore console
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    jest.resetModules();
  });

  describe('log levels', () => {
    test('info logs to console.log by default', () => {
      logger.info('Test', 'info message');
      expect(console.log).toHaveBeenCalledTimes(1);
    });

    test('warn logs to console.warn by default', () => {
      logger.warn('Test', 'warn message');
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    test('error logs to console.error by default', () => {
      logger.error('Test', 'error message');
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    test('debug is suppressed by default', () => {
      logger.debug('Test', 'debug message');
      expect(console.log).not.toHaveBeenCalled();
    });

    test('debug logs when level set to debug', () => {
      logger.setLevel('debug');
      logger.debug('Test', 'debug message');
      expect(console.log).toHaveBeenCalledTimes(1);
    });

    test('setLevel filters messages below threshold', () => {
      logger.setLevel('error');
      logger.info('Test', 'should not appear');
      logger.warn('Test', 'should not appear');
      logger.error('Test', 'should appear');

      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
    });

    test('setLevel ignores invalid level names', () => {
      logger.setLevel('invalid');
      logger.info('Test', 'still works');
      expect(console.log).toHaveBeenCalledTimes(1);
    });
  });

  describe('message formatting', () => {
    test('includes timestamp in HH:mm:ss.SSS format', () => {
      logger.info('Test', 'message');
      const prefix = console.log.mock.calls[0][0];
      expect(prefix).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}/);
    });

    test('includes level in uppercase brackets', () => {
      logger.info('Test', 'message');
      const prefix = console.log.mock.calls[0][0];
      expect(prefix).toContain('[INFO]');
    });

    test('includes subsystem in brackets', () => {
      logger.info('MySubsystem', 'message');
      const prefix = console.log.mock.calls[0][0];
      expect(prefix).toContain('[MySubsystem]');
    });

    test('message is second argument', () => {
      logger.info('Test', 'my message');
      expect(console.log.mock.calls[0][1]).toBe('my message');
    });

    test('extra data passed as third argument', () => {
      const extra = { key: 'value' };
      logger.info('Test', 'message', extra);
      expect(console.log.mock.calls[0][2]).toEqual(extra);
    });

    test('no third argument when extra not provided', () => {
      logger.info('Test', 'message');
      expect(console.log.mock.calls[0].length).toBe(2);
    });
  });

  describe('file output', () => {
    test('creates log directory on first write', () => {
      logger.info('Test', 'message');
      expect(fsMock.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('logs'),
        { recursive: true }
      );
    });

    test('appends to app.log file', () => {
      logger.info('Test', 'message');
      expect(fsMock.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining('app.log'),
        expect.stringContaining('message')
      );
    });

    test('serializes objects in file output', () => {
      logger.info('Test', 'payload', { value: 42 });
      const line = fsMock.appendFileSync.mock.calls[0][1];
      expect(line).toContain('"value":42');
    });

    test('only creates log dir once', () => {
      logger.info('Test', 'first');
      logger.info('Test', 'second');
      expect(fsMock.mkdirSync).toHaveBeenCalledTimes(1);
    });

    test('continues logging if file write fails', () => {
      fsMock.appendFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });

      expect(() => logger.info('Test', 'message')).not.toThrow();
      expect(console.log).toHaveBeenCalled();
    });

    test('continues if mkdir fails', () => {
      fsMock.mkdirSync.mockImplementation(() => {
        throw new Error('Mkdir failed');
      });

      expect(() => logger.info('Test', 'message')).not.toThrow();
    });
  });

  describe('scope()', () => {
    test('returns object with all log methods', () => {
      const scoped = logger.scope('MyScope');
      expect(scoped).toHaveProperty('debug');
      expect(scoped).toHaveProperty('info');
      expect(scoped).toHaveProperty('warn');
      expect(scoped).toHaveProperty('error');
    });

    test('uses subsystem in all messages', () => {
      const scoped = logger.scope('ScopedSub');
      scoped.info('message');
      const prefix = console.log.mock.calls[0][0];
      expect(prefix).toContain('[ScopedSub]');
    });

    test('respects log level setting', () => {
      logger.setLevel('warn');
      const scoped = logger.scope('Test');

      scoped.info('should not appear');
      scoped.warn('should appear');

      expect(console.log).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    test('passes extra data correctly', () => {
      const scoped = logger.scope('Test');
      const extra = { data: 123 };
      scoped.info('message', extra);
      expect(console.log.mock.calls[0][2]).toEqual(extra);
    });

    test('routes error to console.error', () => {
      const scoped = logger.scope('Test');
      scoped.error('error message');
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.log).not.toHaveBeenCalled();
    });
  });
});
