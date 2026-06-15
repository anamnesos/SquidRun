'use strict';

/**
 * Root/path resolution helpers carved out of squidrun-app.js (god-object
 * reduction, task #7: "carve delivery/root corner only when touched").
 *
 * These are pure functions with no dependency on SquidRunApp instance state -
 * they only use the Node `path` builtin. Extracting them shrinks the main
 * controller and gives the root-coherence logic a testable home. Behavior is
 * identical to the original in-file definitions; squidrun-app.js requires them
 * at the top of its module so availability matches the prior hoisted
 * `function` declarations.
 */

const path = require('path');

function toNonEmptyString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeRootForCompare(value) {
  const normalized = toNonEmptyString(value);
  if (!normalized) return null;
  return path.resolve(normalized).replace(/[\\/]+$/, '').toLowerCase();
}

function resolveRootPath(value) {
  const normalized = toNonEmptyString(value);
  return normalized ? path.resolve(normalized) : null;
}

function rootContainsPath(root, targetPath) {
  const rootText = toNonEmptyString(root);
  const targetText = toNonEmptyString(targetPath);
  if (!rootText || !targetText) return false;
  const relative = path.relative(path.resolve(rootText), path.resolve(targetText));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeToPosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

module.exports = {
  toNonEmptyString,
  normalizeRootForCompare,
  resolveRootPath,
  rootContainsPath,
  normalizeToPosixPath,
};
