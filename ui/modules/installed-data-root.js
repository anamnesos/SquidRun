'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_EXTERNAL_WORKSPACE_DIRNAME = 'SquidRun';
const INSTALL_MANIFEST_FILENAMES = Object.freeze([
  'squidrun-install.json',
  '.squidrun-install.json',
]);
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
  DATA_ROOT_ENV_NAMES,
  buildInstallManifestCandidates,
  parseInstallManifest,
  resolveDataRootFromInstallManifest,
  resolveExplicitDataRoot,
  resolveExternalWorkspaceDefault,
  resolveInstalledDataRoot,
};
