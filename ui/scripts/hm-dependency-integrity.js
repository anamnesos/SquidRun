#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { getProjectRoot } = require('../config');

const REQUIRED_RESOLVE_REQUESTS = Object.freeze([
  'busboy',
  'dotenv',
  'sharp',
  'ws',
  'electron/package.json',
  'eslint/package.json',
  'typescript/package.json',
  'electron-builder/package.json',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const args = { projectRoot: '', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (token === '--project-root' && argv[index + 1]) {
      args.projectRoot = String(argv[index + 1]).trim();
      index += 1;
      continue;
    }
    if (token === '--json') args.json = true;
  }
  return args;
}

function readJsonFile(filePath, fsRef = fs) {
  try {
    return { ok: true, value: JSON.parse(fsRef.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function uniqueExistingPaths(candidates, fsRef = fs) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fsRef.existsSync(resolved)) result.push(resolved);
  }
  return result;
}

function resolveNpmCliPath(options = {}) {
  const fsRef = options.fs || fs;
  const env = options.env || process.env;
  const execPath = path.resolve(options.execPath || process.execPath);
  const candidates = uniqueExistingPaths([
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    env.NVM_SYMLINK && path.join(env.NVM_SYMLINK, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ], fsRef);
  return candidates[0] || null;
}

function truncate(value, max = 2_000) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function dependencyProbeScript(uiRoot) {
  return `
const fs = require('fs');
const path = require('path');
const uiRoot = ${JSON.stringify(uiRoot)};
const requests = ${JSON.stringify(REQUIRED_RESOLVE_REQUESTS)};
const resolved = {};
for (const request of requests) {
  resolved[request] = require.resolve(request, { paths: [uiRoot] });
}
const jestBin = path.join(uiRoot, 'node_modules', 'jest', 'bin', 'jest.js');
if (!fs.statSync(jestBin).isFile()) throw new Error('jest_bin_missing');
const sharp = require(resolved.sharp);
if (typeof sharp !== 'function') throw new Error('sharp_load_invalid');
process.stdout.write(JSON.stringify({ ok: true, resolved, jestBin }));
`;
}

function runSpawn(spawnSyncImpl, command, args, options) {
  try {
    const result = spawnSyncImpl(command, args, options);
    return {
      status: result?.status,
      signal: result?.signal || null,
      stdout: String(result?.stdout || ''),
      stderr: String(result?.stderr || ''),
      error: result?.error?.message || null,
    };
  } catch (error) {
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: error?.message || String(error),
    };
  }
}

function checkDependencyIntegrity(projectRoot, options = {}) {
  const fsRef = options.fs || fs;
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const execPath = path.resolve(options.execPath || process.execPath);
  const env = options.env || process.env;
  const resolvedProjectRoot = path.resolve(projectRoot || getProjectRoot());
  const uiRoot = path.join(resolvedProjectRoot, 'ui');
  const requiredJsonPaths = [
    path.join(uiRoot, 'package.json'),
    path.join(uiRoot, 'package-lock.json'),
    path.join(uiRoot, 'node_modules', '.package-lock.json'),
  ];

  const jsonChecks = requiredJsonPaths.map((filePath) => ({ filePath, ...readJsonFile(filePath, fsRef) }));
  const badJson = jsonChecks.find((entry) => !entry.ok);
  if (badJson) {
    return {
      ok: false,
      reason: 'installed_dependency_manifest_missing_or_invalid',
      projectRoot: resolvedProjectRoot,
      uiRoot,
      path: badJson.filePath,
      error: badJson.error,
    };
  }

  const npmCliPath = options.npmCliPath || resolveNpmCliPath({ fs: fsRef, env, execPath });
  if (!npmCliPath) {
    return {
      ok: false,
      reason: 'npm_cli_not_found',
      projectRoot: resolvedProjectRoot,
      uiRoot,
    };
  }

  const commonSpawnOptions = {
    cwd: uiRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: Math.max(5_000, Number(options.timeoutMs) || 120_000),
  };
  const npmTreeRun = runSpawn(
    spawnSyncImpl,
    execPath,
    [npmCliPath, 'ls', '--all', '--json'],
    commonSpawnOptions
  );
  let npmTree = null;
  try {
    npmTree = JSON.parse(npmTreeRun.stdout || '{}');
  } catch {
    npmTree = null;
  }
  if (npmTreeRun.status !== 0 || !npmTree || typeof npmTree !== 'object') {
    return {
      ok: false,
      reason: 'npm_tree_invalid',
      projectRoot: resolvedProjectRoot,
      uiRoot,
      npm: {
        status: npmTreeRun.status,
        signal: npmTreeRun.signal,
        error: npmTreeRun.error,
        stderr: truncate(npmTreeRun.stderr),
        problems: Array.isArray(npmTree?.problems) ? npmTree.problems.slice(0, 20) : [],
      },
    };
  }

  const probeRun = runSpawn(
    spawnSyncImpl,
    execPath,
    ['-e', dependencyProbeScript(uiRoot)],
    commonSpawnOptions
  );
  let probe = null;
  try {
    probe = JSON.parse(probeRun.stdout || '{}');
  } catch {
    probe = null;
  }
  if (probeRun.status !== 0 || probe?.ok !== true) {
    return {
      ok: false,
      reason: 'required_dependency_probe_failed',
      projectRoot: resolvedProjectRoot,
      uiRoot,
      probe: {
        status: probeRun.status,
        signal: probeRun.signal,
        error: probeRun.error,
        stderr: truncate(probeRun.stderr),
      },
    };
  }

  return {
    ok: true,
    reason: null,
    projectRoot: resolvedProjectRoot,
    uiRoot,
    npmCliPath,
    npm: {
      status: npmTreeRun.status,
      problemCount: Array.isArray(npmTree.problems) ? npmTree.problems.length : 0,
    },
    probe: {
      status: probeRun.status,
      requestCount: REQUIRED_RESOLVE_REQUESTS.length,
      jestBin: probe.jestBin,
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = checkDependencyIntegrity(args.projectRoot || getProjectRoot());
  process.stdout.write(`${JSON.stringify(result, null, args.json ? 2 : 0)}\n`);
  process.exitCode = result.ok ? 0 : 1;
  return result;
}

if (require.main === module) main();

module.exports = {
  REQUIRED_RESOLVE_REQUESTS,
  parseArgs,
  readJsonFile,
  resolveNpmCliPath,
  dependencyProbeScript,
  checkDependencyIntegrity,
  main,
};
