/**
 * Diagnostic Log Tests
 * Target: Full coverage of modules/diagnostic-log.js
 */

const fs = require('fs');
const path = require('path');

jest.mock('fs');
jest.mock('../config', () => require('./helpers/real-config').mockWorkspaceOnly);

const diagnosticLog = require('../modules/diagnostic-log');

describe('diagnostic-log', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.mkdirSync.mockImplementation(() => {});
    fs.appendFile.mockImplementation((filePath, data, encoding, cb) => cb(null));
  });

  describe('write', () => {
    test('writes simple message', async () => {
      diagnosticLog.write('TEST', 'simple message');
      await diagnosticLog._flushForTesting();

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('[TEST]'),
        'utf8',
        expect.any(Function)
      );
      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('simple message'),
        'utf8',
        expect.any(Function)
      );
    });

    test('writes message with string extra', async () => {
      diagnosticLog.write('TEST', 'message', 'extra string');
      await diagnosticLog._flushForTesting();

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('extra string'),
        'utf8',
        expect.any(Function)
      );
    });

    test('writes message with object extra', async () => {
      diagnosticLog.write('TEST', 'message', { key: 'value' });
      await diagnosticLog._flushForTesting();

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"key":"value"'),
        'utf8',
        expect.any(Function)
      );
    });

    test('handles circular reference in extra', async () => {
      const circular = {};
      circular.self = circular;

      // Should not throw
      expect(() => diagnosticLog.write('TEST', 'message', circular)).not.toThrow();
      await diagnosticLog._flushForTesting();

      expect(fs.appendFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('[object Object]'),
        'utf8',
        expect.any(Function)
      );
    });

    test('handles appendFile error gracefully', async () => {
      fs.appendFile.mockImplementation((filePath, data, encoding, cb) => {
        cb(new Error('Write failed'));
      });

      // Should not throw
      expect(() => diagnosticLog.write('TEST', 'message')).not.toThrow();
      await diagnosticLog._flushForTesting();
    });

    test('handles mkdirSync error gracefully', () => {
      fs.mkdirSync.mockImplementation(() => {
        throw new Error('Mkdir failed');
      });

      // Should not throw
      expect(() => diagnosticLog.write('TEST', 'message')).not.toThrow();
    });
  });

  describe('LOG_PATH', () => {
    test('exports LOG_PATH', () => {
      expect(diagnosticLog.LOG_PATH).toBeDefined();
      expect(diagnosticLog.LOG_PATH).toContain('diagnostic.log');
    });
  });
});

describe('diagnostic-log with null workspace', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.mock('../config', () => require('./helpers/real-config').mockCreateConfig({ WORKSPACE_PATH: null }));
  });

  test('handles null workspace path', () => {
    const log = require('../modules/diagnostic-log');

    // Should not throw when workspace is null
    expect(() => log.write('TEST', 'message')).not.toThrow();
    expect(log.LOG_PATH).toBeNull();
  });
});
