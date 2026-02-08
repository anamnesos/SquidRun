/**
 * Real config helper for tests.
 *
 * Loads the actual config.js and applies optional overrides so tests stay
 * aligned with the real config shape while still customizing values.
 *
 * Usage — default real config:
 *   jest.mock('../config', () => require('./helpers/real-config').mockDefaultConfig);
 *
 * Usage — with overrides:
 *   jest.mock('../config', () => require('./helpers/real-config').mockCreateConfig({ WORKSPACE_PATH: '/custom' }));
 *
 * Usage — minimal (only WORKSPACE_PATH):
 *   jest.mock('../config', () => require('./helpers/real-config').mockWorkspaceOnly);
 */

const realConfig = typeof jest !== 'undefined' && jest.requireActual
  ? jest.requireActual('../../config')
  : require('../../config');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (Array.isArray(value)) {
    return value.map(deepClone);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = deepClone(child);
    }
    return out;
  }
  return value;
}

function mergeDeep(base, overrides) {
  const merged = deepClone(base);
  if (!overrides || typeof overrides !== 'object') {
    return merged;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeDeep(merged[key], value);
    } else {
      merged[key] = deepClone(value);
    }
  }
  return merged;
}

const mockDefaultConfig = mergeDeep(realConfig, {});

/** Minimal mock — only WORKSPACE_PATH (for modules that just need the path) */
const mockWorkspaceOnly = {
  WORKSPACE_PATH: realConfig.WORKSPACE_PATH,
};

/**
 * Create a config mock with selective overrides.
 *
 * @param {Object} overrides - Keys to override in the default config
 * @returns {Object} Merged config object
 */
function mockCreateConfig(overrides = {}) {
  return mergeDeep(realConfig, overrides);
}

module.exports = {
  mockDefaultConfig,
  mockWorkspaceOnly,
  mockCreateConfig,
};
