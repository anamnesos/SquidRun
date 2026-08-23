'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkDependencyIntegrity,
  resolveNpmCliPath,
} = require('../scripts/hm-dependency-integrity');

describe('restart dependency integrity', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-dependency-integrity-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeHealthyManifestShell() {
    const uiRoot = path.join(projectRoot, 'ui');
    fs.mkdirSync(path.join(uiRoot, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(uiRoot, 'package.json'), '{"name":"fixture"}\n');
    fs.writeFileSync(path.join(uiRoot, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3}\n');
    fs.writeFileSync(path.join(uiRoot, 'node_modules', '.package-lock.json'), '{"name":"fixture","lockfileVersion":3}\n');
    return uiRoot;
  }

  test('fails closed when the installed package manifest is absent', () => {
    const spawn = jest.fn();

    const result = checkDependencyIntegrity(projectRoot, {
      spawnSync: spawn,
      npmCliPath: path.join(projectRoot, 'npm-cli.js'),
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'installed_dependency_manifest_missing_or_invalid',
    }));
    expect(spawn).not.toHaveBeenCalled();
  });

  test('requires both a green npm tree and direct runtime/tool probes', () => {
    writeHealthyManifestShell();
    const npmCliPath = path.join(projectRoot, 'npm-cli.js');
    fs.writeFileSync(npmCliPath, '// fixture');
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: '{"name":"fixture"}', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ok: true, jestBin: 'fixture/jest.js' }),
        stderr: '',
      });

    const result = checkDependencyIntegrity(projectRoot, {
      spawnSync: spawn,
      npmCliPath,
      execPath: process.execPath,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      npm: expect.objectContaining({ status: 0 }),
      probe: expect.objectContaining({ status: 0 }),
    }));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual([npmCliPath, 'ls', '--all', '--json']);
    expect(spawn.mock.calls[1][1][0]).toBe('-e');
  });

  test('blocks restart on a red npm dependency tree before direct probes', () => {
    writeHealthyManifestShell();
    const npmCliPath = path.join(projectRoot, 'npm-cli.js');
    fs.writeFileSync(npmCliPath, '// fixture');
    const spawn = jest.fn(() => ({
      status: 1,
      stdout: JSON.stringify({ problems: ['missing: sharp'] }),
      stderr: 'npm error missing',
    }));

    const result = checkDependencyIntegrity(projectRoot, { spawnSync: spawn, npmCliPath });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'npm_tree_invalid',
      npm: expect.objectContaining({ problems: ['missing: sharp'] }),
    }));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('resolves npm CLI without invoking a shell shim', () => {
    const cliPath = path.join(projectRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '// fixture');

    expect(resolveNpmCliPath({
      execPath: path.join(projectRoot, 'node.exe'),
      env: {},
    })).toBe(cliPath);
  });
});
