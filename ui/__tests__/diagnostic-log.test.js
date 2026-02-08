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
    fs.appendFileSync.mockImplementation(() => {});
  });

  describe('write', () => {
    test('writes simple message', () => {
      diagnosticLog.write('TEST', 'simple message');

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('[TEST]')
      );
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('simple message')
      );
    });

    test('writes message with string extra', () => {
      diagnosticLog.write('TEST', 'message', 'extra string');

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('extra string')
      );
    });

    test('writes message with object extra', () => {
      diagnosticLog.write('TEST', 'message', { key: 'value' });

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"key":"value"')
      );
    });

    test('handles circular reference in extra', () => {
      const circular = {};
      circular.self = circular;

      // Should not throw
      expect(() => diagnosticLog.write('TEST', 'message', circular)).not.toThrow();

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('[object Object]')
      );
    });

    test('handles appendFileSync error gracefully', () => {
      fs.appendFileSync.mockImplementation(() => {
        throw new Error('Write failed');
      });

      // Should not throw
      expect(() => diagnosticLog.write('TEST', 'message')).not.toThrow();
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
