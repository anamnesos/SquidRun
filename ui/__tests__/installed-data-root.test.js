'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveInstalledDataRoot,
  resolveExternalWorkspaceDefault,
  resolveExplicitDataRoot,
  applyInstalledElectronUserDataPath,
  isPinnedInstalledDataRoot,
  parseInstallManifest,
  resolveDataRootRuntimePath,
  resolveInstalledElectronUserDataPath,
  resolveInstalledGlobalStateRoot,
  resolveInstalledPipeDiscriminator,
  computeDataRootPipeDiscriminator,
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

  test('classifies only env and manifest roots as pinned install roots', () => {
    const dataRoot = path.join(tempRoot, 'pinned-root');
    const envRoot = resolveInstalledDataRoot({
      env: { SQUIDRUN_DATA_ROOT: dataRoot },
      homePath: path.join(tempRoot, 'home'),
    });
    const manifestPath = path.join(tempRoot, 'install', 'squidrun-install.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify({ dataRoot }, null, 2)}\n`, 'utf8');
    const manifestRoot = parseInstallManifest(manifestPath);
    const defaultRoot = resolveInstalledDataRoot({
      env: {},
      homePath: path.join(tempRoot, 'home'),
    });

    expect(isPinnedInstalledDataRoot(envRoot)).toBe(true);
    expect(isPinnedInstalledDataRoot(manifestRoot)).toBe(true);
    expect(isPinnedInstalledDataRoot(defaultRoot)).toBe(false);
  });

  test('builds Electron userData and global state paths under a pinned data root', () => {
    const dataRoot = path.join(tempRoot, 'eunbyeol');
    const resolved = resolveInstalledDataRoot({
      env: { SQUIDRUN_DATA_ROOT: dataRoot },
      homePath: path.join(tempRoot, 'home'),
    });

    expect(resolveDataRootRuntimePath(dataRoot, 'nested\\state.json')).toBe(
      path.join(path.resolve(dataRoot), '.squidrun', 'nested', 'state.json')
    );
    expect(resolveInstalledElectronUserDataPath(resolved)).toBe(
      path.join(path.resolve(dataRoot), '.squidrun', 'electron-user-data')
    );
    expect(resolveInstalledGlobalStateRoot(resolved)).toBe(
      path.join(path.resolve(dataRoot), '.squidrun', 'global-state')
    );
  });

  test('derives a per-install pipe discriminator only for pinned roots', () => {
    const dataRoot = path.join(tempRoot, 'pinned-pipe-root');
    const envRoot = resolveInstalledDataRoot({
      env: { SQUIDRUN_DATA_ROOT: dataRoot },
      homePath: path.join(tempRoot, 'home'),
    });
    const defaultRoot = resolveInstalledDataRoot({
      env: {},
      homePath: path.join(tempRoot, 'home'),
    });

    // Pinned install → a stable short hash; default/dev root → null (legacy pipe).
    const disc = resolveInstalledPipeDiscriminator(envRoot);
    expect(disc).toMatch(/^[0-9a-f]{10}$/);
    expect(resolveInstalledPipeDiscriminator(defaultRoot)).toBeNull();

    // Stable + case/separator/trailing-slash insensitive so app and daemon agree.
    expect(computeDataRootPipeDiscriminator(dataRoot)).toBe(disc);
    expect(computeDataRootPipeDiscriminator(`${dataRoot}\\`)).toBe(disc);
    expect(computeDataRootPipeDiscriminator(dataRoot.toUpperCase())).toBe(disc);

    // Different roots → different pipes.
    expect(computeDataRootPipeDiscriminator(path.join(tempRoot, 'other-install')))
      .not.toBe(disc);
    expect(computeDataRootPipeDiscriminator('')).toBeNull();
    expect(computeDataRootPipeDiscriminator(null)).toBeNull();
  });

  test('applies pinned Electron userData path to the app before the instance lock', () => {
    const dataRoot = path.join(tempRoot, 'eunbyeol-userdata');
    const resolved = resolveInstalledDataRoot({
      env: { SQUIDRUN_DATA_ROOT: dataRoot },
      homePath: path.join(tempRoot, 'home'),
    });
    const electronApp = { setPath: jest.fn() };
    const fsImpl = { mkdirSync: jest.fn() };
    const expectedPath = path.join(path.resolve(dataRoot), '.squidrun', 'electron-user-data');

    expect(applyInstalledElectronUserDataPath(electronApp, resolved, { fs: fsImpl })).toEqual({
      applied: true,
      path: expectedPath,
      source: 'env:SQUIDRUN_DATA_ROOT',
    });
    expect(fsImpl.mkdirSync).toHaveBeenCalledWith(expectedPath, { recursive: true });
    expect(electronApp.setPath).toHaveBeenCalledWith('userData', expectedPath);
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
