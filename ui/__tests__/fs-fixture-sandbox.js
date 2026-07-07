'use strict';

/**
 * fs fixture sandbox: keep unix-absolute fixture paths off the real drive.
 *
 * mock-config.js (and friends) use "obviously fake" unix-absolute roots like
 * '/test/workspace' and '/custom'. On Windows those resolve onto the current
 * drive — path.resolve('/test') === 'D:\\test' — so any test that does a REAL
 * fs write through a mocked config materializes folders at the drive root.
 * Found 2026-07-07: months of D:\test, D:\storage, D:\active, D:\assigned,
 * D:\custom, D:\d debris came from exactly this.
 *
 * This guard patches fs so every path under those fixture roots is
 * transparently redirected into a per-run temp sandbox. Assertions on path
 * STRINGS are untouched; read/write round-trips stay consistent because both
 * directions redirect identically.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURE_ROOT_NAMES = ['test', 'storage', 'active', 'assigned', 'custom', 'd'];
const SANDBOX_ROOT = path.join(os.tmpdir(), `squidrun-jest-fixture-roots-${process.pid}`);
const FORBIDDEN_ROOTS = FIXTURE_ROOT_NAMES.map((name) => path.resolve(path.sep + name));

// Jest re-evaluates this module per test file, but the core fs object is
// shared per worker — anchor install state and pre-patch handles THERE so a
// re-evaluation never captures patched functions as "originals" or wraps twice.
const state = fs.__squidrunFixtureSandbox || (fs.__squidrunFixtureSandbox = {
  installed: false,
  originals: {},
});

// Pre-patch handles: used by redirect internals and exported so tests can
// inspect the REAL filesystem (e.g. assert D:\test was never created).
const ORIGINALS = state.originals;

function redirectFixturePath(target) {
  if (typeof target !== 'string' || !target) return target;
  let resolved;
  try { resolved = path.resolve(target); } catch { return target; }
  for (const root of FORBIDDEN_ROOTS) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      const driveRoot = path.parse(root).root;
      const sandboxed = path.join(SANDBOX_ROOT, path.relative(driveRoot, resolved));
      try { ORIGINALS.mkdirSync(path.dirname(sandboxed), { recursive: true }); } catch {}
      return sandboxed;
    }
  }
  return target;
}

function wrap(holder, name, argCount) {
  const original = holder[name];
  if (typeof original !== 'function') return;
  const patched = argCount === 2
    ? function patchedFsTwoPath(src, dest, ...rest) {
      return original.call(this, redirectFixturePath(src), redirectFixturePath(dest), ...rest);
    }
    : function patchedFsOnePath(target, ...rest) {
      return original.call(this, redirectFixturePath(target), ...rest);
    };
  // Preserve statics like realpathSync.native (used by Jest itself). The
  // preserved statics bypass redirection — acceptable: internals need them
  // for real paths, and fixture paths never legitimately hit them.
  Object.assign(patched, original);
  holder[name] = patched;
}

const ONE_PATH_SYNC_AND_CB = [
  'writeFileSync', 'readFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync',
  'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'rmSync', 'rmdirSync',
  'unlinkSync', 'openSync', 'accessSync', 'realpathSync', 'chmodSync', 'truncateSync',
  'createWriteStream', 'createReadStream', 'watch', 'watchFile', 'unwatchFile',
  'writeFile', 'readFile', 'appendFile', 'mkdir', 'mkdtemp', 'stat', 'lstat',
  'readdir', 'rm', 'rmdir', 'unlink', 'open', 'access', 'realpath',
];
const TWO_PATH_SYNC_AND_CB = [
  'copyFileSync', 'renameSync', 'linkSync', 'symlinkSync', 'cpSync',
  'copyFile', 'rename', 'link', 'symlink', 'cp',
];
const ONE_PATH_PROMISES = [
  'writeFile', 'readFile', 'appendFile', 'mkdir', 'mkdtemp', 'stat', 'lstat',
  'readdir', 'rm', 'rmdir', 'unlink', 'open', 'access', 'chmod', 'truncate', 'realpath',
];
const TWO_PATH_PROMISES = ['copyFile', 'rename', 'link', 'symlink', 'cp'];

function installFsFixtureSandbox() {
  if (state.installed) return;
  state.installed = true;
  for (const name of [...ONE_PATH_SYNC_AND_CB, ...TWO_PATH_SYNC_AND_CB]) {
    if (typeof fs[name] === 'function') ORIGINALS[name] = fs[name].bind(fs);
  }
  for (const name of ONE_PATH_SYNC_AND_CB) wrap(fs, name, 1);
  for (const name of TWO_PATH_SYNC_AND_CB) wrap(fs, name, 2);
  if (fs.promises) {
    for (const name of ONE_PATH_PROMISES) wrap(fs.promises, name, 1);
    for (const name of TWO_PATH_PROMISES) wrap(fs.promises, name, 2);
  }
}

module.exports = {
  FIXTURE_ROOT_NAMES,
  FORBIDDEN_ROOTS,
  SANDBOX_ROOT,
  ORIGINALS,
  redirectFixturePath,
  installFsFixtureSandbox,
};
