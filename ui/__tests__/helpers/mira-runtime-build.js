'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 50;
const LOCK_TIMEOUT_MS = 60_000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pathSegments(value) {
  return String(value || '').split(/[\\/]+/).filter(Boolean);
}

function isInsideSquidRunPrivateRoot(candidatePath) {
  return pathSegments(path.resolve(candidatePath)).some((segment) => segment.toLowerCase() === '.squidrun');
}

function ensureFirstWritableDir(candidates) {
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    try {
      fs.mkdirSync(resolved, { recursive: true });
      return resolved;
    } catch (_) {
      // Try the next location.
    }
  }
  throw new Error('Unable to create a Mira runtime build lock directory.');
}

function getBuildLockRoot(repoRoot) {
  const parsed = path.parse(path.resolve(repoRoot));
  const candidates = [];
  if (process.platform === 'win32') {
    const driveRoot = parsed.root || `${process.env.SystemDrive || 'C:'}\\`;
    candidates.push(path.win32.join(driveRoot, 'squidrun-tmp', 'jest-runtime-build'));
    candidates.push('C:\\squidrun-tmp\\jest-runtime-build');
  }
  const systemTemp = os.tmpdir();
  if (!isInsideSquidRunPrivateRoot(systemTemp)) {
    candidates.push(path.join(systemTemp, 'squidrun-jest-runtime-build'));
  }
  candidates.push(path.join(parsed.root || process.cwd(), 'tmp', 'squidrun-jest-runtime-build'));
  return ensureFirstWritableDir(candidates);
}

function getSafeMiraRuntimeTempRoot(repoRoot) {
  const parsed = path.parse(path.resolve(repoRoot));
  const candidates = [];
  if (process.platform === 'win32') {
    const driveRoot = parsed.root || `${process.env.SystemDrive || 'C:'}\\`;
    candidates.push(path.win32.join(driveRoot, 'squidrun-tmp', 'mira-runtime-tests'));
    candidates.push('C:\\squidrun-tmp\\mira-runtime-tests');
  }
  const currentTemp = os.tmpdir();
  if (!isInsideSquidRunPrivateRoot(currentTemp)) {
    candidates.push(path.join(currentTemp, 'mira-runtime-tests'));
  }
  candidates.push(path.join(parsed.root || process.cwd(), 'tmp', 'mira-runtime-tests'));
  return ensureFirstWritableDir(candidates);
}

function ensureSafeMiraRuntimeTempEnv(repoRoot) {
  if (!isInsideSquidRunPrivateRoot(os.tmpdir())) {
    return { changed: false, tempRoot: os.tmpdir() };
  }
  const tempRoot = getSafeMiraRuntimeTempRoot(repoRoot);
  process.env.TMPDIR = tempRoot;
  process.env.TMP = tempRoot;
  process.env.TEMP = tempRoot;
  return { changed: true, tempRoot };
}

function listRuntimeSources(repoRoot) {
  const runtimeRoot = path.join(repoRoot, 'mira', 'runtime');
  const srcRoot = path.join(runtimeRoot, 'src');
  return [
    path.join(runtimeRoot, 'tsconfig.json'),
    ...fs.readdirSync(srcRoot)
      .filter((fileName) => fileName.endsWith('.ts'))
      .sort()
      .map((fileName) => path.join(srcRoot, fileName)),
  ];
}

function buildSourceStamp(repoRoot) {
  const hash = crypto.createHash('sha256');
  for (const filePath of listRuntimeSources(repoRoot)) {
    const stat = fs.statSync(filePath);
    hash.update(path.relative(repoRoot, filePath));
    hash.update(String(stat.size));
    hash.update(String(stat.mtimeMs));
  }
  return hash.digest('hex');
}

function hasExpectedRuntimeExports(repoRoot) {
  const routePreviewPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'mission-control-route-preview.js');
  const serverPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'server.js');
  if (!fs.existsSync(routePreviewPath) || !fs.existsSync(serverPath)) return false;
  const routePreview = fs.readFileSync(routePreviewPath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');
  return routePreview.includes('export function createMissionControlDispatchReadiness')
    && routePreview.includes('export function listMissionControlDispatchReadiness')
    && server.includes('createMissionControlDispatchReadiness');
}

function readStamp(stampPath) {
  try {
    return fs.readFileSync(stampPath, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function acquireLock(lockPath) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (_) {
        // The lock disappeared between attempts; retry immediately.
        continue;
      }
      sleep(LOCK_WAIT_MS);
    }
  }
  throw new Error(`Timed out waiting for Mira runtime build lock: ${lockPath}`);
}

function compileMiraRuntime(repoRoot) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  ensureSafeMiraRuntimeTempEnv(resolvedRepoRoot);
  const lockRoot = getBuildLockRoot(resolvedRepoRoot);
  const lockPath = path.join(lockRoot, 'mira-runtime-tsc.lock');
  const stampPath = path.join(lockRoot, 'mira-runtime-tsc.stamp');
  const expectedStamp = buildSourceStamp(resolvedRepoRoot);
  const lockHandle = acquireLock(lockPath);
  try {
    if (readStamp(stampPath) === expectedStamp && hasExpectedRuntimeExports(resolvedRepoRoot)) {
      return { compiled: false, stamp: expectedStamp, lockRoot };
    }

    const runtimeTsconfig = path.join(resolvedRepoRoot, 'mira', 'runtime', 'tsconfig.json');
    const tscBin = path.join(resolvedRepoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tscBin, '-p', runtimeTsconfig], {
      cwd: resolvedRepoRoot,
      stdio: 'pipe',
    });
    if (!hasExpectedRuntimeExports(resolvedRepoRoot)) {
      throw new Error('Mira runtime compile completed without expected Mission Control dispatch-readiness exports.');
    }
    fs.writeFileSync(stampPath, `${expectedStamp}\n`, 'utf8');
    return { compiled: true, stamp: expectedStamp, lockRoot };
  } finally {
    fs.closeSync(lockHandle);
    fs.rmSync(lockPath, { force: true });
  }
}

module.exports = {
  compileMiraRuntime,
  _internals: {
    ensureSafeMiraRuntimeTempEnv,
    getBuildLockRoot,
    getSafeMiraRuntimeTempRoot,
    hasExpectedRuntimeExports,
    isInsideSquidRunPrivateRoot,
  },
};
