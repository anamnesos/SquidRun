'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveInstalledDataRoot,
  resolveExternalWorkspaceDefault,
  resolveExplicitDataRoot,
  parseInstallManifest,
} = require('../modules/installed-data-root');

describe('installed-data-root', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-data-root-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('uses SQUIDRUN_DATA_ROOT before other packaged discovery', () => {
    const dataRoot = path.join(tempRoot, 'eunbyeol-data');
    const result = resolveInstalledDataRoot({
      env: {
        SQUIDRUN_DATA_ROOT: dataRoot,
        SQUIDRUN_WORKSPACE_ROOT: path.join(tempRoot, 'workspace-root'),
      },
      homePath: path.join(tempRoot, 'home'),
    });

    expect(result).toEqual({
      path: path.resolve(dataRoot),
      source: 'env:SQUIDRUN_DATA_ROOT',
    });
    expect(resolveExplicitDataRoot({ SQUIDRUN_DATA_ROOT: dataRoot }).path).toBe(path.resolve(dataRoot));
  });

  test('discovers manifest from packaged runtime ancestors', () => {
    const installRoot = path.join(tempRoot, 'SquidRun-Eunbyeol');
    const manifestPath = path.join(installRoot, 'squidrun-install.json');
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify({ dataRoot: 'data' }, null, 2)}\n`, 'utf8');

    const result = resolveInstalledDataRoot({
      env: {},
      runtimePath: path.join(installRoot, 'resources', 'app.asar', 'ui'),
      homePath: path.join(tempRoot, 'home'),
    });

    expect(result.path).toBe(path.join(installRoot, 'data'));
    expect(result.source).toBe(`manifest:${manifestPath}`);
  });

  test('falls back to the external workspace default', () => {
    const homePath = path.join(tempRoot, 'home');
    expect(resolveExternalWorkspaceDefault({ homePath })).toBe(path.join(homePath, 'SquidRun'));

    const result = resolveInstalledDataRoot({
      env: {},
      cwd: path.join(tempRoot, 'cwd'),
      execPath: path.join(tempRoot, 'app', 'SquidRun.exe'),
      homePath,
      resourcesPath: path.join(tempRoot, 'app', 'resources'),
    });

    expect(result).toEqual({
      path: path.join(homePath, 'SquidRun'),
      source: 'default-external-workspace',
    });
  });

  test('accepts workspace/project root aliases in install manifests', () => {
    const installRoot = path.join(tempRoot, 'install');
    const manifestPath = path.join(installRoot, '.squidrun-install.json');
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify({ workspace: 'instance-data' }, null, 2)}\n`, 'utf8');

    expect(parseInstallManifest(manifestPath)).toEqual(expect.objectContaining({
      path: path.join(installRoot, 'instance-data'),
      source: `manifest:${manifestPath}`,
    }));
  });
});
