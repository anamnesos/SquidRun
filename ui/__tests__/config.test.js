/**
 * Tests for config.js exports
 */

const os = require('os');
const path = require('path');
const {
  PIPE_PATH,
  WORKSPACE_PATH,
  INSTANCE_DIRS,
  PANE_ROLES,
  TRIGGER_TARGETS,
  PROTOCOL_ACTIONS,
  PROTOCOL_EVENTS,
} = require('../config');

describe('config.js', () => {
  describe('PIPE_PATH', () => {
    test('should be a string', () => {
      expect(typeof PIPE_PATH).toBe('string');
    });

    test('should be Windows named pipe on win32', () => {
      if (os.platform() === 'win32') {
        expect(PIPE_PATH).toContain('\\\\.\\pipe\\');
      }
    });

    test('should be Unix socket path on non-Windows', () => {
      if (os.platform() !== 'win32') {
        expect(PIPE_PATH).toMatch(/^\/tmp\//);
      }
    });
  });

  describe('INSTANCE_DIRS', () => {
    test('should have all 3 pane IDs', () => {
      expect(Object.keys(INSTANCE_DIRS)).toEqual(['1', '2', '5']);
    });

    test('should have paths for each pane', () => {
      expect(INSTANCE_DIRS['1']).toContain('arch');
      expect(INSTANCE_DIRS['2']).toContain('infra');
      expect(INSTANCE_DIRS['5']).toContain('ana');
    });

    test('all paths should be absolute', () => {
      Object.values(INSTANCE_DIRS).forEach(dir => {
        expect(path.isAbsolute(dir)).toBe(true);
      });
    });
  });

  describe('PANE_ROLES', () => {
    test('should have all 3 pane IDs', () => {
      expect(Object.keys(PANE_ROLES)).toEqual(['1', '2', '5']);
    });

    test('should have correct role names', () => {
      expect(PANE_ROLES['1']).toBe('Architect');
      expect(PANE_ROLES['2']).toBe('DevOps');
      expect(PANE_ROLES['5']).toBe('Analyst');
    });
  });

  describe('TRIGGER_TARGETS', () => {
    test('should have expected trigger files', () => {
      const keys = Object.keys(TRIGGER_TARGETS);
      expect(keys).toContain('architect.txt');
      expect(keys).toContain('infra.txt');
      expect(keys).toContain('backend.txt');
      expect(keys).toContain('analyst.txt');
      expect(keys).toContain('workers.txt');
      expect(keys).toContain('all.txt');
    });

    test('architect.txt should target pane 1', () => {
      expect(TRIGGER_TARGETS['architect.txt']).toEqual(['1']);
    });

    test('workers.txt should target DevOps', () => {
      expect(TRIGGER_TARGETS['workers.txt']).toEqual(['2']);
    });

    test('all.txt should target all 3 panes', () => {
      expect(TRIGGER_TARGETS['all.txt']).toEqual(['1', '2', '5']);
    });
  });

  describe('PROTOCOL_ACTIONS', () => {
    test('should include spawn action', () => {
      expect(PROTOCOL_ACTIONS).toContain('spawn');
    });

    test('should include write action', () => {
      expect(PROTOCOL_ACTIONS).toContain('write');
    });

    test('should include all required actions', () => {
      const required = ['spawn', 'write', 'resize', 'kill', 'list'];
      required.forEach(action => {
        expect(PROTOCOL_ACTIONS).toContain(action);
      });
    });
  });

  describe('PROTOCOL_EVENTS', () => {
    test('should include data event', () => {
      expect(PROTOCOL_EVENTS).toContain('data');
    });

    test('should include exit event', () => {
      expect(PROTOCOL_EVENTS).toContain('exit');
    });

    test('should include all required events', () => {
      const required = ['data', 'exit', 'spawned', 'error'];
      required.forEach(event => {
        expect(PROTOCOL_EVENTS).toContain(event);
      });
    });
  });
});
