/**
 * Tests for config.js exports
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  PIPE_PATH,
  WORKSPACE_PATH,
  PROJECT_ROOT,
  COORD_ROOT,
  GLOBAL_STATE_ROOT,
  PANE_ROLES,
  PANE_DISPLAY_NAMES,
  TRIGGER_TARGETS,
  BACKWARD_COMPAT_ROLE_ALIASES,
  LEGACY_ROLE_ALIASES,
  ROLE_ID_MAP,
  PROTOCOL_ACTIONS,
  PROTOCOL_EVENTS,
  getProjectRoot,
  setProjectRoot,
  resetProjectRoot,
  resolvePaneCwd,
  resolveCoordRoot,
  resolveCoordPath,
  resolveGlobalPath,
  resolveWebSocketPortInfo,
  getPaneDisplayName,
} = require('../config');

describe('config.js', () => {
  beforeEach(() => {
    resetProjectRoot();
  });

  afterEach(() => {
    resetProjectRoot();
  });

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
      expect(resolvePaneCwd('3')).toBe(PROJECT_ROOT);
    });

    test('resolvePaneCwd should use active project root fallback for known panes', () => {
      setProjectRoot('/tmp/switched-project');
      const expected = path.resolve('/tmp/switched-project');
      expect(getProjectRoot()).toBe(expected);
      expect(resolvePaneCwd('1')).toBe(expected);
      expect(resolvePaneCwd('2')).toBe(expected);
      expect(resolvePaneCwd('3')).toBe(expected);
    });

    test('discovers bundled side-profile workspace as the active project root', () => {
      const previousProfile = process.env.SQUIDRUN_PROFILE;
      const previousProjectRoot = process.env.SQUIDRUN_PROJECT_ROOT;
      const profileRoot = path.resolve(__dirname, '..', '..', '.squidrun', 'profiles', 'unit-config-profile', 'workspace');
      try {
        fs.mkdirSync(profileRoot, { recursive: true });
        process.env.SQUIDRUN_PROFILE = 'unit-config-profile';
        process.env.SQUIDRUN_PROJECT_ROOT = path.resolve('/tmp/generic-project-root');

        jest.isolateModules(() => {
          const isolatedConfig = require('../config');
          expect(isolatedConfig.getProjectRoot()).toBe(profileRoot);
          expect(isolatedConfig.resolvePaneCwd('1')).toBe(profileRoot);
        });
      } finally {
        if (previousProfile === undefined) {
          delete process.env.SQUIDRUN_PROFILE;
        } else {
          process.env.SQUIDRUN_PROFILE = previousProfile;
        }
        if (previousProjectRoot === undefined) {
          delete process.env.SQUIDRUN_PROJECT_ROOT;
        } else {
          process.env.SQUIDRUN_PROJECT_ROOT = previousProjectRoot;
        }
        fs.rmSync(path.dirname(profileRoot), { recursive: true, force: true });
      }
    });

    test('discovers explicit installed data root before SQUIDRUN_PROJECT_ROOT', () => {
      const previousProfile = process.env.SQUIDRUN_PROFILE;
      const previousDataRoot = process.env.SQUIDRUN_DATA_ROOT;
      const previousWorkspaceRoot = process.env.SQUIDRUN_WORKSPACE_ROOT;
      const previousProjectRoot = process.env.SQUIDRUN_PROJECT_ROOT;
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-config-data-root-'));
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-config-project-root-'));

      try {
        process.env.SQUIDRUN_PROFILE = 'main';
        process.env.SQUIDRUN_DATA_ROOT = dataRoot;
        process.env.SQUIDRUN_WORKSPACE_ROOT = path.join(os.tmpdir(), 'unused-workspace-root');
        process.env.SQUIDRUN_PROJECT_ROOT = projectRoot;

        jest.isolateModules(() => {
          const isolatedConfig = require('../config');
          expect(isolatedConfig.getProjectRoot()).toBe(path.resolve(dataRoot));
          expect(isolatedConfig.resolvePaneCwd('2')).toBe(path.resolve(dataRoot));
        });
      } finally {
        if (previousProfile === undefined) {
          delete process.env.SQUIDRUN_PROFILE;
        } else {
          process.env.SQUIDRUN_PROFILE = previousProfile;
        }
        if (previousDataRoot === undefined) {
          delete process.env.SQUIDRUN_DATA_ROOT;
        } else {
          process.env.SQUIDRUN_DATA_ROOT = previousDataRoot;
        }
        if (previousWorkspaceRoot === undefined) {
          delete process.env.SQUIDRUN_WORKSPACE_ROOT;
        } else {
          process.env.SQUIDRUN_WORKSPACE_ROOT = previousWorkspaceRoot;
        }
        if (previousProjectRoot === undefined) {
          delete process.env.SQUIDRUN_PROJECT_ROOT;
        } else {
          process.env.SQUIDRUN_PROJECT_ROOT = previousProjectRoot;
        }
        fs.rmSync(dataRoot, { recursive: true, force: true });
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    test('scopes global state to explicit installed data root', () => {
      const previousProfile = process.env.SQUIDRUN_PROFILE;
      const previousDataRoot = process.env.SQUIDRUN_DATA_ROOT;
      const previousWorkspaceRoot = process.env.SQUIDRUN_WORKSPACE_ROOT;
      const previousProjectRoot = process.env.SQUIDRUN_PROJECT_ROOT;
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-config-global-root-'));

      try {
        process.env.SQUIDRUN_PROFILE = 'main';
        process.env.SQUIDRUN_DATA_ROOT = dataRoot;
        delete process.env.SQUIDRUN_WORKSPACE_ROOT;
        delete process.env.SQUIDRUN_PROJECT_ROOT;

        jest.isolateModules(() => {
          const isolatedConfig = require('../config');
          const expectedRoot = path.join(path.resolve(dataRoot), '.squidrun', 'global-state');
          expect(isolatedConfig.GLOBAL_STATE_ROOT).toBe(expectedRoot);
          expect(isolatedConfig.resolveGlobalPath('message-state.json')).toBe(
            path.join(expectedRoot, 'message-state.json')
          );
        });
      } finally {
        if (previousProfile === undefined) {
          delete process.env.SQUIDRUN_PROFILE;
        } else {
          process.env.SQUIDRUN_PROFILE = previousProfile;
        }
        if (previousDataRoot === undefined) {
          delete process.env.SQUIDRUN_DATA_ROOT;
        } else {
          process.env.SQUIDRUN_DATA_ROOT = previousDataRoot;
        }
        if (previousWorkspaceRoot === undefined) {
          delete process.env.SQUIDRUN_WORKSPACE_ROOT;
        } else {
          process.env.SQUIDRUN_WORKSPACE_ROOT = previousWorkspaceRoot;
        }
        if (previousProjectRoot === undefined) {
          delete process.env.SQUIDRUN_PROJECT_ROOT;
        } else {
          process.env.SQUIDRUN_PROJECT_ROOT = previousProjectRoot;
        }
        fs.rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    test('resolves installed websocket port from explicit data-root settings', () => {
      const previousProfile = process.env.SQUIDRUN_PROFILE;
      const previousDataRoot = process.env.SQUIDRUN_DATA_ROOT;
      const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-config-ws-root-'));
      const settingsDir = path.join(dataRoot, '.squidrun', 'settings');

      try {
        fs.mkdirSync(settingsDir, { recursive: true });
        fs.writeFileSync(
          path.join(settingsDir, 'websocket.json'),
          `${JSON.stringify({ schema: 'squidrun.websocket_settings.v1', port: 9901 }, null, 2)}\n`,
          'utf8'
        );
        process.env.SQUIDRUN_PROFILE = 'main';
        process.env.SQUIDRUN_DATA_ROOT = dataRoot;

        jest.isolateModules(() => {
          const isolatedConfig = require('../config');
          expect(isolatedConfig.resolveWebSocketPortInfo({
            env: process.env,
            profileName: 'main',
          })).toEqual(expect.objectContaining({
            port: 9901,
            settingsPath: path.join(dataRoot, '.squidrun', 'settings', 'websocket.json'),
          }));
        });
      } finally {
        if (previousProfile === undefined) {
          delete process.env.SQUIDRUN_PROFILE;
        } else {
          process.env.SQUIDRUN_PROFILE = previousProfile;
        }
        if (previousDataRoot === undefined) {
          delete process.env.SQUIDRUN_DATA_ROOT;
        } else {
          process.env.SQUIDRUN_DATA_ROOT = previousDataRoot;
        }
        fs.rmSync(dataRoot, { recursive: true, force: true });
      }
    });

    test('resolves installed websocket port from packaged install manifest', () => {
      const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-config-ws-manifest-'));
      const manifestPath = path.join(installRoot, 'squidrun-install.json');
      const dataRoot = path.join(installRoot, 'instance-data');
      const runtimePath = path.join(installRoot, 'resources', 'app.asar', 'ui');

      try {
        fs.writeFileSync(
          manifestPath,
          `${JSON.stringify({ dataRoot: 'instance-data', webSocketPort: 9901 }, null, 2)}\n`,
          'utf8'
        );
        expect(resolveWebSocketPortInfo({
          env: {},
          profileName: 'main',
          runtimePath,
          startDir: runtimePath,
          homePath: path.join(installRoot, 'home'),
        })).toEqual(expect.objectContaining({
          port: 9901,
          manifestPath,
          dataRoot: path.resolve(dataRoot),
        }));
      } finally {
        fs.rmSync(installRoot, { recursive: true, force: true });
      }
    });

    test('keeps dev main websocket default on 9900 and side profile fallbacks on 9901', () => {
      expect(resolveWebSocketPortInfo({
        env: { SQUIDRUN_PROFILE: 'main' },
        profileName: 'main',
      })).toEqual(expect.objectContaining({
        port: 9900,
        source: 'profile:main',
      }));
      expect(resolveWebSocketPortInfo({
        env: { SQUIDRUN_PROFILE: 'scoped' },
        profileName: 'scoped',
      })).toEqual(expect.objectContaining({
        port: 9901,
        source: 'profile:scoped',
      }));
      expect(resolveWebSocketPortInfo({
        env: { SQUIDRUN_PROFILE: 'eunbyeol' },
        profileName: 'eunbyeol',
      })).toEqual(expect.objectContaining({
        port: 9901,
        source: 'profile:eunbyeol',
      }));
    });

    test('discovers packaged install manifest from app.asar runtime path', () => {
      const previousProfile = process.env.SQUIDRUN_PROFILE;
      const previousDataRoot = process.env.SQUIDRUN_DATA_ROOT;
      const previousWorkspaceRoot = process.env.SQUIDRUN_WORKSPACE_ROOT;
      const previousProjectRoot = process.env.SQUIDRUN_PROJECT_ROOT;
      const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-config-install-'));
      const manifestPath = path.join(installRoot, 'squidrun-install.json');
      const dataRoot = path.join(installRoot, 'instance-data');
      const runtimePath = path.join(installRoot, 'resources', 'app.asar', 'ui');

      try {
        process.env.SQUIDRUN_PROFILE = 'main';
        delete process.env.SQUIDRUN_DATA_ROOT;
        delete process.env.SQUIDRUN_WORKSPACE_ROOT;
        delete process.env.SQUIDRUN_PROJECT_ROOT;
        fs.writeFileSync(manifestPath, `${JSON.stringify({ dataRoot: 'instance-data' }, null, 2)}\n`, 'utf8');

        jest.isolateModules(() => {
          const isolatedConfig = require('../config');
          expect(isolatedConfig.isPackagedRuntimePath(runtimePath)).toBe(true);
          expect(isolatedConfig.discoverProjectRoot(runtimePath)).toBe(path.resolve(dataRoot));
        });
      } finally {
        if (previousProfile === undefined) {
          delete process.env.SQUIDRUN_PROFILE;
        } else {
          process.env.SQUIDRUN_PROFILE = previousProfile;
        }
        if (previousDataRoot === undefined) {
          delete process.env.SQUIDRUN_DATA_ROOT;
        } else {
          process.env.SQUIDRUN_DATA_ROOT = previousDataRoot;
        }
        if (previousWorkspaceRoot === undefined) {
          delete process.env.SQUIDRUN_WORKSPACE_ROOT;
        } else {
          process.env.SQUIDRUN_WORKSPACE_ROOT = previousWorkspaceRoot;
        }
        if (previousProjectRoot === undefined) {
          delete process.env.SQUIDRUN_PROJECT_ROOT;
        } else {
          process.env.SQUIDRUN_PROJECT_ROOT = previousProjectRoot;
        }
        fs.rmSync(installRoot, { recursive: true, force: true });
      }
    });

    test('prefers packaged install manifest over git root when staged inside a worktree', () => {
      const previousProfile = process.env.SQUIDRUN_PROFILE;
      const previousDataRoot = process.env.SQUIDRUN_DATA_ROOT;
      const previousWorkspaceRoot = process.env.SQUIDRUN_WORKSPACE_ROOT;
      const previousProjectRoot = process.env.SQUIDRUN_PROJECT_ROOT;
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-config-git-install-'));
      const versionRoot = path.join(repoRoot, 'release', 'versions', '0.1.34');
      const manifestPath = path.join(versionRoot, 'squidrun-install.json');
      const dataRoot = path.join(repoRoot, 'external-data');
      const runtimePath = path.join(versionRoot, 'resources', 'app.asar', 'ui');

      try {
        execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
        process.env.SQUIDRUN_PROFILE = 'main';
        delete process.env.SQUIDRUN_DATA_ROOT;
        delete process.env.SQUIDRUN_WORKSPACE_ROOT;
        delete process.env.SQUIDRUN_PROJECT_ROOT;
        fs.mkdirSync(runtimePath, { recursive: true });
        fs.writeFileSync(manifestPath, `${JSON.stringify({ dataRoot }, null, 2)}\n`, 'utf8');

        jest.isolateModules(() => {
          const isolatedConfig = require('../config');
          expect(isolatedConfig.discoverProjectRoot(runtimePath)).toBe(path.resolve(dataRoot));
        });
      } finally {
        if (previousProfile === undefined) {
          delete process.env.SQUIDRUN_PROFILE;
        } else {
          process.env.SQUIDRUN_PROFILE = previousProfile;
        }
        if (previousDataRoot === undefined) {
          delete process.env.SQUIDRUN_DATA_ROOT;
        } else {
          process.env.SQUIDRUN_DATA_ROOT = previousDataRoot;
        }
        if (previousWorkspaceRoot === undefined) {
          delete process.env.SQUIDRUN_WORKSPACE_ROOT;
        } else {
          process.env.SQUIDRUN_WORKSPACE_ROOT = previousWorkspaceRoot;
        }
        if (previousProjectRoot === undefined) {
          delete process.env.SQUIDRUN_PROJECT_ROOT;
        } else {
          process.env.SQUIDRUN_PROJECT_ROOT = previousProjectRoot;
        }
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    test('scopes global state to packaged install manifest data root', () => {
      const previousProfile = process.env.SQUIDRUN_PROFILE;
      const previousDataRoot = process.env.SQUIDRUN_DATA_ROOT;
      const previousWorkspaceRoot = process.env.SQUIDRUN_WORKSPACE_ROOT;
      const previousProjectRoot = process.env.SQUIDRUN_PROJECT_ROOT;
      const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-config-global-manifest-'));
      const manifestPath = path.join(installRoot, 'squidrun-install.json');
      const dataRoot = path.join(installRoot, 'instance-data');
      const runtimePath = path.join(installRoot, 'resources', 'app.asar', 'ui');

      try {
        process.env.SQUIDRUN_PROFILE = 'main';
        delete process.env.SQUIDRUN_DATA_ROOT;
        delete process.env.SQUIDRUN_WORKSPACE_ROOT;
        delete process.env.SQUIDRUN_PROJECT_ROOT;
        fs.writeFileSync(manifestPath, `${JSON.stringify({ dataRoot: 'instance-data' }, null, 2)}\n`, 'utf8');

        jest.isolateModules(() => {
          const isolatedConfig = require('../config');
          expect(isolatedConfig.resolveGlobalStateRoot({
            env: {},
            runtimePath,
            startDir: runtimePath,
            homePath: path.join(installRoot, 'home'),
          })).toBe(path.join(path.resolve(dataRoot), '.squidrun', 'global-state'));
        });
      } finally {
        if (previousProfile === undefined) {
          delete process.env.SQUIDRUN_PROFILE;
        } else {
          process.env.SQUIDRUN_PROFILE = previousProfile;
        }
        if (previousDataRoot === undefined) {
          delete process.env.SQUIDRUN_DATA_ROOT;
        } else {
          process.env.SQUIDRUN_DATA_ROOT = previousDataRoot;
        }
        if (previousWorkspaceRoot === undefined) {
          delete process.env.SQUIDRUN_WORKSPACE_ROOT;
        } else {
          process.env.SQUIDRUN_WORKSPACE_ROOT = previousWorkspaceRoot;
        }
        if (previousProjectRoot === undefined) {
          delete process.env.SQUIDRUN_PROJECT_ROOT;
        } else {
          process.env.SQUIDRUN_PROJECT_ROOT = previousProjectRoot;
        }
        fs.rmSync(installRoot, { recursive: true, force: true });
      }
    });

    test('resolvePaneCwd should prefer state project fallback when no pane override exists', () => {
      const expected = path.resolve('/tmp/state-project');
      expect(resolvePaneCwd('2', { projectRoot: '/tmp/state-project' })).toBe(expected);
    });

    test('resolvePaneCwd should support injected instanceDirs for unknown panes', () => {
      const override = { '99': '/override/agent' };
      expect(resolvePaneCwd('99', { instanceDirs: override })).toBe('/override/agent');
      expect(resolvePaneCwd('1', { instanceDirs: override })).toBe(PROJECT_ROOT);
      expect(resolvePaneCwd('2', { instanceDirs: override })).toBe(PROJECT_ROOT);
    });

    test('resolveCoordRoot should always resolve to project .squidrun root', () => {
      expect(path.resolve(resolveCoordRoot())).toBe(path.resolve(COORD_ROOT));
    });

    test('resolveGlobalPath should resolve under GLOBAL_STATE_ROOT and ensure directory exists', () => {
      const resolved = resolveGlobalPath('usage-stats.json', { forWrite: true });
      const expected = path.join(GLOBAL_STATE_ROOT, 'usage-stats.json');
      expect(path.resolve(resolved)).toBe(path.resolve(expected));
      expect(fs.existsSync(path.resolve(GLOBAL_STATE_ROOT))).toBe(true);
    });

    test('resolveCoordPath should write under active project .squidrun root', () => {
      const switchedProject = path.resolve('/tmp/switched-project');
      setProjectRoot(switchedProject);
      const resolved = resolveCoordPath('app-status.json', { forWrite: true });
      expect(path.resolve(resolved)).toBe(path.join(switchedProject, '.squidrun', 'app-status.json'));
    });
  });

  describe('PANE_ROLES', () => {
    test('should have all 3 pane IDs', () => {
      expect(Object.keys(PANE_ROLES)).toEqual(['1', '2', '3']);
    });

    test('should have correct role names', () => {
      expect(PANE_ROLES['1']).toBe('Architect');
      expect(PANE_ROLES['2']).toBe('Builder');
      expect(PANE_ROLES['3']).toBe('Oracle');
    });
  });

  describe('PANE_DISPLAY_NAMES', () => {
    test('keeps Mira as the pane 1 display name without changing the role contract', () => {
      expect(PANE_DISPLAY_NAMES['1']).toBe('Mira');
      expect(getPaneDisplayName('1')).toBe('Mira');
      expect(getPaneDisplayName('1', { includeRole: true })).toBe('Mira (Architect)');
      expect(ROLE_ID_MAP.architect).toBe('1');
      expect(TRIGGER_TARGETS['architect.txt']).toEqual(['1']);
    });
  });

  describe('BACKWARD_COMPAT_ROLE_ALIASES', () => {
    test('maps director alias to architect', () => {
      expect(BACKWARD_COMPAT_ROLE_ALIASES.director).toBe('architect');
    });
  });

  describe('ROLE_ID_MAP', () => {
    test('maps canonical roles to pane ids', () => {
      expect(ROLE_ID_MAP.architect).toBe('1');
      expect(ROLE_ID_MAP.builder).toBe('2');
      expect(ROLE_ID_MAP.oracle).toBe('3');
      expect(ROLE_ID_MAP.director).toBeUndefined();
    });
  });

  describe('LEGACY_ROLE_ALIASES', () => {
    test('remains exported for compatibility and matches canonical alias map', () => {
      expect(LEGACY_ROLE_ALIASES).toBe(BACKWARD_COMPAT_ROLE_ALIASES);
    });
  });

  describe('TRIGGER_TARGETS', () => {
    test('should have expected trigger files', () => {
      const keys = Object.keys(TRIGGER_TARGETS);
      expect(keys).toContain('architect.txt');
      expect(keys).toContain('builder.txt');
      expect(keys).toContain('oracle.txt');
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
      expect(TRIGGER_TARGETS['all.txt']).toEqual(['1', '2', '3']);
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
