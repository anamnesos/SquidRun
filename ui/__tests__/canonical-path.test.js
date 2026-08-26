'use strict';

const path = require('node:path');

const {
  canonicalPathContains,
  canonicalPathsEqual,
  canonicalizePathIdentity,
} = require('../modules/canonical-path');

function windowsAliasRealpath(value) {
  const resolved = path.win32.resolve(value);
  const shortRoot = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';
  const longRoot = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
  if (resolved.toLowerCase().startsWith(shortRoot.toLowerCase())) {
    return `${longRoot}${resolved.slice(shortRoot.length)}`;
  }
  return resolved;
}

describe('canonical Windows path identity', () => {
  const options = {
    platform: 'win32',
    pathApi: path.win32,
    realpath: windowsAliasRealpath,
  };

  test('treats 8.3 and expanded profile paths as the same identity', () => {
    const shortPath = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\fixture\\file.json';
    const longPath = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\fixture\\file.json';
    expect(canonicalPathsEqual(shortPath, longPath, options)).toBe(true);
    expect(canonicalizePathIdentity(shortPath, options)).toBe(longPath);
  });

  test('contains an expanded child under a short-form trusted root', () => {
    const root = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\fixture';
    const child = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\fixture\\child\\file.json';
    expect(canonicalPathContains(root, child, options)).toBe(true);
  });

  test('still rejects a canonical escape', () => {
    const root = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\fixture';
    const outside = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\outside\\file.json';
    expect(canonicalPathContains(root, outside, options)).toBe(false);
  });
});
