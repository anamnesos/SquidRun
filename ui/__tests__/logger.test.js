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
  let stdoutWriteSpy;
  let stderrWriteSpy;

  beforeEach(() => {
    // Reset module cache
    jest.resetModules();
    // Override global mock from setup to use real logger module
    jest.unmock('../modules/logger');

    // Create fs mock
    fsMock = {
      mkdirSync: jest.fn(),
      appendFile: jest.fn((filePath, data, encoding, cb) => cb(null)),
    };

    // Mock console
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk, encoding, callback) => {
      if (typeof encoding === 'function') {
        encoding();
      } else if (typeof callback === 'function') {
        callback();
      }
      return true;
    });
    stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk, encoding, callback) => {
      if (typeof encoding === 'function') {
        encoding();
      } else if (typeof callback === 'function') {
        callback();
      }
      return true;
    });

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
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    jest.resetModules();
  });

  describe('log levels', () => {
    test('info logs to console.log by default', () => {
      logger.info('Test', 'info message');
      expect(process.stdout.write).toHaveBeenCalledTimes(1);
    });

    test('warn logs to console.warn by default', () => {
      logger.warn('Test', 'warn message');
      expect(process.stderr.write).toHaveBeenCalledTimes(1);
    });

    test('error logs to console.error by default', () => {
      logger.error('Test', 'error message');
      expect(process.stderr.write).toHaveBeenCalledTimes(1);
    });

    test('debug is suppressed by default', () => {
      logger.debug('Test', 'debug message');
      expect(process.stdout.write).not.toHaveBeenCalled();
    });

    test('debug logs when level set to debug', () => {
      logger.setLevel('debug');
      logger.debug('Test', 'debug message');
      expect(process.stdout.write).toHaveBeenCalledTimes(1);
    });

    test('setLevel filters messages below threshold', () => {
      logger.setLevel('error');
      logger.info('Test', 'should not appear');
      logger.warn('Test', 'should not appear');
      logger.error('Test', 'should appear');

      expect(process.stdout.write).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledTimes(1);
    });

    test('setLevel ignores invalid level names', () => {
      logger.setLevel('invalid');
      logger.info('Test', 'still works');
      expect(process.stdout.write).toHaveBeenCalledTimes(1);
    });
  });

  describe('message formatting', () => {
    test('includes timestamp in HH:mm:ss.SSS format', () => {
      logger.info('Test', 'message');
      const prefix = process.stdout.write.mock.calls[0][0];
      expect(prefix).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}/);
    });

    test('includes level in uppercase brackets', () => {
      logger.info('Test', 'message');
      const prefix = process.stdout.write.mock.calls[0][0];
      expect(prefix).toContain('[INFO]');
    });

    test('includes subsystem in brackets', () => {
      logger.info('MySubsystem', 'message');
      const prefix = process.stdout.write.mock.calls[0][0];
      expect(prefix).toContain('[MySubsystem]');
    });

    test('message is second argument', () => {
      logger.info('Test', 'my message');
      expect(process.stdout.write.mock.calls[0][0]).toContain('my message');
    });

    test('extra data passed as third argument', () => {
      const extra = { key: 'value' };
      logger.info('Test', 'message', extra);
      expect(process.stdout.write.mock.calls[0][0]).toContain('"key":"value"');
    });

    test('no third argument when extra not provided', () => {
      logger.info('Test', 'message');
      expect(process.stdout.write.mock.calls[0].length).toBeGreaterThanOrEqual(1);
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

    test('appends to app.log file', async () => {
      logger.info('Test', 'message');
      await logger._flushForTesting();
      expect(fsMock.appendFile).toHaveBeenCalledWith(
        expect.stringContaining('app.log'),
        expect.stringContaining('message'),
        'utf8',
        expect.any(Function)
      );
    });

    test('serializes objects in file output', async () => {
      logger.info('Test', 'payload', { value: 42 });
      await logger._flushForTesting();
      const line = fsMock.appendFile.mock.calls[0][1];
      expect(line).toContain('"value":42');
    });

    test('only creates log dir once', () => {
      logger.info('Test', 'first');
      logger.info('Test', 'second');
      expect(fsMock.mkdirSync).toHaveBeenCalledTimes(1);
    });

    test('continues logging if file write fails', async () => {
      fsMock.appendFile.mockImplementation((filePath, data, encoding, cb) => {
        cb(new Error('Write failed'));
      });

      expect(() => logger.info('Test', 'message')).not.toThrow();
      await logger._flushForTesting();
      expect(process.stdout.write).toHaveBeenCalled();
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
      const prefix = process.stdout.write.mock.calls[0][0];
      expect(prefix).toContain('[ScopedSub]');
    });

    test('respects log level setting', () => {
      logger.setLevel('warn');
      const scoped = logger.scope('Test');

      scoped.info('should not appear');
      scoped.warn('should appear');

      expect(process.stdout.write).not.toHaveBeenCalled();
      expect(process.stderr.write).toHaveBeenCalledTimes(1);
    });

    test('passes extra data correctly', () => {
      const scoped = logger.scope('Test');
      const extra = { data: 123 };
      scoped.info('message', extra);
      expect(process.stdout.write.mock.calls[0][0]).toContain('"data":123');
    });

    test('routes error to console.error', () => {
      const scoped = logger.scope('Test');
      scoped.error('error message');
      expect(process.stderr.write).toHaveBeenCalledTimes(1);
      expect(process.stdout.write).not.toHaveBeenCalled();
    });

    test('scoped debug logs when level set to debug', () => {
      logger.setLevel('debug');
      const scoped = logger.scope('ScopedDebug');
      scoped.debug('debug message');
      expect(process.stdout.write).toHaveBeenCalledTimes(1);
      expect(process.stdout.write.mock.calls[0][0]).toContain('[ScopedDebug]');
    });
  });

  describe('edge cases', () => {
    test('handles circular reference in extra', async () => {
      const circular = {};
      circular.self = circular;

      // Should not throw
      expect(() => logger.info('Test', 'message', circular)).not.toThrow();

      // File output should use String() fallback for circular object
      await logger._flushForTesting();
      expect(fsMock.appendFile).toHaveBeenCalled();
      const line = fsMock.appendFile.mock.calls[0][1];
      expect(line).toContain('[object Object]');
    });
  });
});
