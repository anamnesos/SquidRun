'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pathApiFor(platform) {
  if (platform === 'win32') return path.win32;
  if (platform === 'linux' || platform === 'darwin') return path.posix;
  return path;
}

function realpathFunction(fsImpl, explicitRealpath) {
  if (typeof explicitRealpath === 'function') return explicitRealpath;
  if (typeof fsImpl?.realpathSync?.native === 'function') {
    return fsImpl.realpathSync.native.bind(fsImpl.realpathSync);
  }
  if (typeof fsImpl?.realpathSync === 'function') return fsImpl.realpathSync.bind(fsImpl);
  return null;
}

function canonicalizePathIdentity(value, options = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;

  const platform = options.platform || process.platform;
  const pathApi = options.pathApi || pathApiFor(platform);
  const resolved = pathApi.resolve(text);
  const realpath = realpathFunction(options.fsImpl || fs, options.realpath);
  if (!realpath) return resolved;

  let cursor = resolved;
  const missingParts = [];
  while (true) {
    try {
      const realCursor = pathApi.resolve(String(realpath(cursor)));
      return pathApi.resolve(realCursor, ...missingParts);
    } catch (error) {
      if (options.allowMissing === false
          || !['ENOENT', 'ENOTDIR'].includes(String(error?.code || ''))) {
        return null;
      }
      const parent = pathApi.dirname(cursor);
      if (parent === cursor) return null;
      missingParts.unshift(pathApi.basename(cursor));
      cursor = parent;
    }
  }
}

function comparablePathIdentity(value, options = {}) {
  const platform = options.platform || process.platform;
  const canonical = canonicalizePathIdentity(value, options);
  if (!canonical) return null;
  let normalized = canonical;
  if (platform === 'win32') {
    normalized = normalized
      .replace(/^\\\\\?\\UNC\\/iu, '\\\\')
      .replace(/^\\\\\?\\/u, '')
      .toLowerCase();
  }
  return normalized;
}

function canonicalPathsEqual(left, right, options = {}) {
  const leftIdentity = comparablePathIdentity(left, options);
  const rightIdentity = comparablePathIdentity(right, options);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

function canonicalPathContains(root, candidate, options = {}) {
  const platform = options.platform || process.platform;
  const pathApi = options.pathApi || pathApiFor(platform);
  const canonicalRoot = canonicalizePathIdentity(root, options);
  const canonicalCandidate = canonicalizePathIdentity(candidate, options);
  if (!canonicalRoot || !canonicalCandidate) return false;
  const rootIdentity = comparablePathIdentity(canonicalRoot, {
    ...options,
    realpath: (value) => value,
  });
  const candidateIdentity = comparablePathIdentity(canonicalCandidate, {
    ...options,
    realpath: (value) => value,
  });
  if (!rootIdentity || !candidateIdentity) return false;
  const relative = pathApi.relative(rootIdentity, candidateIdentity);
  if (relative === '' || relative === '.') return options.allowEqual === true;
  return !relative.startsWith('..') && !pathApi.isAbsolute(relative);
}

module.exports = {
  canonicalPathContains,
  canonicalPathsEqual,
  canonicalizePathIdentity,
  comparablePathIdentity,
};
