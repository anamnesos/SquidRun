'use strict';

const path = require('path');
const {
  toNonEmptyString,
  normalizeRootForCompare,
  resolveRootPath,
  rootContainsPath,
  normalizeToPosixPath,
} = require('../modules/main/squidrun-root-paths');

// Coverage for the root/path helpers carved out of squidrun-app.js (task #7).
// Pins behavior so the extraction stays equivalent to the original in-file defs.
describe('squidrun-root-paths', () => {
  describe('toNonEmptyString', () => {
    it('returns null for empty/whitespace/nullish', () => {
      expect(toNonEmptyString(null)).toBeNull();
      expect(toNonEmptyString(undefined)).toBeNull();
      expect(toNonEmptyString('   ')).toBeNull();
      expect(toNonEmptyString('')).toBeNull();
    });
    it('trims and returns non-empty', () => {
      expect(toNonEmptyString('  hi  ')).toBe('hi');
      expect(toNonEmptyString(42)).toBe('42');
    });
  });

  describe('normalizeRootForCompare', () => {
    it('resolves, strips trailing slashes, lowercases', () => {
      expect(normalizeRootForCompare('  /Foo/Bar/  ')).toBe(path.resolve('/Foo/Bar').toLowerCase());
      expect(normalizeRootForCompare('')).toBeNull();
    });
  });

  describe('resolveRootPath', () => {
    it('resolves a non-empty path, null otherwise', () => {
      expect(resolveRootPath('foo/bar')).toBe(path.resolve('foo/bar'));
      expect(resolveRootPath('   ')).toBeNull();
    });
  });

  describe('rootContainsPath', () => {
    it('true when target is inside root (incl. the root itself)', () => {
      expect(rootContainsPath('/a/b', '/a/b/c')).toBe(true);
      expect(rootContainsPath('/a/b', '/a/b')).toBe(true);
    });
    it('false when target escapes root or inputs empty', () => {
      expect(rootContainsPath('/a/b', '/a/c')).toBe(false);
      expect(rootContainsPath('', '/a/b')).toBe(false);
      expect(rootContainsPath('/a/b', '')).toBe(false);
    });
  });

  describe('normalizeToPosixPath', () => {
    it('converts backslashes to forward slashes', () => {
      expect(normalizeToPosixPath('a\\b\\c')).toBe('a/b/c');
      expect(normalizeToPosixPath('')).toBe('');
      expect(normalizeToPosixPath(null)).toBe('');
    });
  });
});
