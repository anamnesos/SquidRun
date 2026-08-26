'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_EXTERNAL_WORKSPACE_DIRNAME = 'SquidRun';
const INSTALL_MANIFEST_FILENAMES = Object.freeze([
  'squidrun-install.json',
  '.squidrun-install.json',
]);
const DATA_ROOT_RUNTIME_DIRNAME = '.squidrun';
const ELECTRON_USER_DATA_RELPATH = 'electron-user-data';
const GLOBAL_STATE_RELPATH = 'global-state';
const DATA_ROOT_ENV_NAMES = Object.freeze([
  'SQUIDRUN_DATA_ROOT',
  'SQUIDRUN_WORKSPACE_ROOT',
]);

// Install manifests are exe-adjacent pointer stores only. They may point at the
// writable data root, but secrets such as Telegram bot tokens belong under that
// data root's settings/config, never in squidrun-install.json.

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveHomePath(options = {}) {
  const explicitHome = toNonEmptyString(options.homePath);
  if (explicitHome) return explicitHome;
  return os.homedir();
}

function resolveExternalWorkspaceDefault(options = {}) {
  return path.join(
    resolveHomePath(options),
    toNonEmptyString(options.defaultDirName) || DEFAULT_EXTERNAL_WORKSPACE_DIRNAME
  );
}

function resolveExplicitDataRoot(env = process.env) {
  for (const envName of DATA_ROOT_ENV_NAMES) {
    const value = toNonEmptyString(env?.[envName]);
    if (value) {
      return {
        path: path.resolve(value),
        source: `env:${envName}`,
      };
    }
  }
  return null;
}

function isPinnedInstalledDataRoot(result) {
  const source = toNonEmptyString(result?.source);
  const dataRoot = toNonEmptyString(result?.path);
  if (!source || !dataRoot) return false;
  return source.startsWith('env:') || source.startsWith('manifest:');
}

function normalizeRuntimeRelPath(relPath = '') {
  return String(relPath || '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, path.sep);
}

function resolveDataRootRuntimePath(dataRoot, relPath = '') {
  const root = toNonEmptyString(dataRoot);
  if (!root) return null;
  const runtimeRoot = path.join(path.resolve(root), DATA_ROOT_RUNTIME_DIRNAME);
  const normalizedRelPath = normalizeRuntimeRelPath(relPath);
  return normalizedRelPath
    ? path.join(runtimeRoot, normalizedRelPath)
    : runtimeRoot;
}

function resolvePinnedInstalledRuntimePath(result, relPath = '') {
  if (!isPinnedInstalledDataRoot(result)) return null;
  return resolveDataRootRuntimePath(result.path, relPath);
}

function resolveInstalledElectronUserDataPath(result) {
  return resolvePinnedInstalledRuntimePath(result, ELECTRON_USER_DATA_RELPATH);
}

function applyInstalledElectronUserDataPath(electronApp, result, options = {}) {
  const userDataPath = resolveInstalledElectronUserDataPath(result);
  if (!userDataPath || typeof electronApp?.setPath !== 'function') {
    return {
      applied: false,
      path: userDataPath,
      source: result?.source || null,
    };
  }
  const fsImpl = options.fs || fs;
  fsImpl.mkdirSync(userDataPath, { recursive: true });
  electronApp.setPath('userData', userDataPath);
  return {
    applied: true,
    path: userDataPath,
    source: result.source,
  };
}

function resolveInstalledGlobalStateRoot(result) {
  return resolvePinnedInstalledRuntimePath(result, GLOBAL_STATE_RELPATH);
}

// The terminal daemon's named pipe is a per-machine discovery channel keyed only
// by profile name, so two installs that both run as profile=main would collide on
// the same pipe and one would join the other's daemon. Derive a stable, short
// discriminator from the data-root path so each pinned install gets its OWN pipe.
// Case/separator-insensitive and trailing-slash-stripped so the app process and
// the detached daemon (which resolve the same root from env or manifest) always
// compute the identical pipe name.
function computeDataRootPipeDiscriminator(dataRootPath) {
  const root = toNonEmptyString(dataRootPath);
  if (!root) return null;
  const normalized = path.resolve(root).replace(/[\\/]+$/, '').toLowerCase();
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
}

// Only pinned installs (env:/manifest: source) get a per-install pipe; the dev /
// default root keeps the legacy unsuffixed pipe so existing main instances are
// completely unchanged (no migration, no breakage).
function resolveInstalledPipeDiscriminator(result) {
  if (!isPinnedInstalledDataRoot(result)) return null;
  return computeDataRootPipeDiscriminator(result.path);
}

function parseInstallManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  const dataRoot = toNonEmptyString(
    parsed.dataRoot
    || parsed.data_root
    || parsed.workspace
    || parsed.projectRoot
    || parsed.project_root
  );
  if (!dataRoot) return null;
  return {
    path: path.resolve(path.dirname(manifestPath), dataRoot),
    source: `manifest:${manifestPath}`,
    manifest: parsed,
    manifestPath,
  };
}

function pushInstallManifestCandidates(candidates, root) {
  const normalizedRoot = toNonEmptyString(root);
  if (!normalizedRoot) return;
  for (const fileName of INSTALL_MANIFEST_FILENAMES) {
    candidates.push(path.join(normalizedRoot, fileName));
  }
}

function pushInstallManifestAncestorCandidates(candidates, startPath, maxDepth = 8) {
  const normalizedStart = toNonEmptyString(startPath);
  if (!normalizedStart) return;
  let current = path.resolve(normalizedStart);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    pushInstallManifestCandidates(candidates, current);
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
}

function buildInstallManifestCandidates(options = {}) {
  const candidates = [];
  pushInstallManifestCandidates(candidates, options.installDir);
  pushInstallManifestAncestorCandidates(
    candidates,
    options.runtimePath || options.appPath || options.startDir
  );
  pushInstallManifestCandidates(candidates, options.cwd || process.cwd());

  const execPath = toNonEmptyString(options.execPath || process.execPath);
  if (execPath) {
    pushInstallManifestCandidates(candidates, path.dirname(execPath));
  }

  const resourcesPath = toNonEmptyString(options.resourcesPath || process.resourcesPath);
  if (resourcesPath) {
    pushInstallManifestCandidates(candidates, resourcesPath);
    pushInstallManifestCandidates(candidates, path.dirname(resourcesPath));
  }

  const explicitManifest = toNonEmptyString(options.manifestPath || process.env.SQUIDRUN_INSTALL_MANIFEST);
  if (explicitManifest) {
    candidates.unshift(explicitManifest);
  }

  return Array.from(new Set(candidates.map((candidate) => path.resolve(candidate))));
}

function resolveDataRootFromInstallManifest(options = {}) {
  for (const manifestPath of buildInstallManifestCandidates(options)) {
    try {
      if (!fs.existsSync(manifestPath)) continue;
      const result = parseInstallManifest(manifestPath);
      if (result?.path) return result;
    } catch (_) {
      // Invalid local install manifests are ignored so env/default roots still work.
    }
  }
  return null;
}

function resolveInstalledDataRoot(options = {}) {
  const explicit = resolveExplicitDataRoot(options.env || process.env);
  if (explicit?.path) return explicit;

  const manifest = resolveDataRootFromInstallManifest(options);
  if (manifest?.path) return manifest;

  return {
    path: path.resolve(resolveExternalWorkspaceDefault(options)),
    source: 'default-external-workspace',
  };
}

module.exports = {
  DEFAULT_EXTERNAL_WORKSPACE_DIRNAME,
  INSTALL_MANIFEST_FILENAMES,
  DATA_ROOT_RUNTIME_DIRNAME,
  ELECTRON_USER_DATA_RELPATH,
  GLOBAL_STATE_RELPATH,
  DATA_ROOT_ENV_NAMES,
  buildInstallManifestCandidates,
  applyInstalledElectronUserDataPath,
  isPinnedInstalledDataRoot,
  parseInstallManifest,
  resolveDataRootRuntimePath,
  resolveDataRootFromInstallManifest,
  resolveExplicitDataRoot,
  resolveExternalWorkspaceDefault,
  resolveInstalledElectronUserDataPath,
  resolveInstalledDataRoot,
  resolveInstalledGlobalStateRoot,
  resolveInstalledPipeDiscriminator,
  computeDataRootPipeDiscriminator,
  resolvePinnedInstalledRuntimePath,
};
