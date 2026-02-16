/**
 * Tests for config.js exports
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  PIPE_PATH,
  WORKSPACE_PATH,
  PROJECT_ROOT,
  COORD_ROOT,
  PANE_ROLES,
  TRIGGER_TARGETS,
  PROTOCOL_ACTIONS,
  PROTOCOL_EVENTS,
  resolvePaneCwd,
  resolveCoordRoot,
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

  describe('Resolvers', () => {
    test('resolvePaneCwd should prefer paneProjects for known panes when provided', () => {
      const paneProjects = { '2': '/tmp/target-repo' };
      expect(resolvePaneCwd('2', { paneProjects })).toBe(path.resolve('/tmp/target-repo'));
    });

    test('resolvePaneCwd should return project root for known panes', () => {
      expect(resolvePaneCwd('1')).toBe(PROJECT_ROOT);
      expect(resolvePaneCwd('2')).toBe(PROJECT_ROOT);
      expect(resolvePaneCwd('5')).toBe(PROJECT_ROOT);
    });

    test('resolvePaneCwd should support injected instanceDirs for unknown panes', () => {
      const override = { '99': '/override/agent' };
      expect(resolvePaneCwd('99', { instanceDirs: override })).toBe('/override/agent');
      expect(resolvePaneCwd('1', { instanceDirs: override })).toBe(PROJECT_ROOT);
      expect(resolvePaneCwd('2', { instanceDirs: override })).toBe(PROJECT_ROOT);
    });

    test('resolveCoordRoot should return .hivemind when present, else workspace', () => {
      const expected = fs.existsSync(COORD_ROOT) ? COORD_ROOT : WORKSPACE_PATH;
      expect(resolveCoordRoot()).toBe(expected);
    });
  });

  describe('PANE_ROLES', () => {
    test('should have all 3 pane IDs', () => {
      expect(Object.keys(PANE_ROLES)).toEqual(['1', '2', '5']);
    });

    test('should have correct role names', () => {
      expect(PANE_ROLES['1']).toBe('Architect');
      expect(PANE_ROLES['2']).toBe('Builder');
      expect(PANE_ROLES['5']).toBe('Oracle');
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

    test('workers.txt should target Builder', () => {
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
