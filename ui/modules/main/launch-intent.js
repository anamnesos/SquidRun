'use strict';

const { DEFAULT_PROFILE, normalizeProfileName, parseProfileArg } = require('../../profile');

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeWindowKey(value) {
  const normalized = toNonEmptyString(String(value || '').toLowerCase());
  if (!normalized) return 'main';
  if (normalized === '은별' || normalized === 'eunbyul' || normalized === 'eunbyeol') {
    return 'eunbyeol';
  }
  return normalized;
}

function normalizeLaunchIntent(rawIntent = {}) {
  const windowKey = normalizeWindowKey(rawIntent.windowKey || rawIntent.targetWindowKey || 'main');
  const includeMainWindow = windowKey === 'main'
    ? true
    : rawIntent.includeMainWindow !== false;
  const profileName = normalizeProfileName(rawIntent.profileName || DEFAULT_PROFILE);
  return {
    profileName,
    windowKey,
    includeMainWindow,
    focusWindowKey: normalizeWindowKey(rawIntent.focusWindowKey || windowKey),
  };
}

function parseLaunchIntent(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  let windowKey = null;
  let includeMainWindow = true;
  const profileName = parseProfileArg(args);

  for (let index = 0; index < args.length; index += 1) {
    const token = toNonEmptyString(String(args[index] || ''));
    if (!token) continue;

    if (token === '--eunbyeol' || token === '--eunbyul') {
      windowKey = 'eunbyeol';
      includeMainWindow = false;
      continue;
    }

    if (token === '--solo-window' || token === '--standalone' || token === '--standalone-window') {
      includeMainWindow = false;
      continue;
    }

    if (token === '--with-main-window') {
      includeMainWindow = true;
      continue;
    }

    if (token.startsWith('--window=')) {
      windowKey = token.slice('--window='.length);
      continue;
    }

    if (token === '--window') {
      const next = toNonEmptyString(String(args[index + 1] || ''));
      if (next) {
        windowKey = next;
        index += 1;
      }
    }
  }

  return normalizeLaunchIntent({
    profileName,
    windowKey,
    includeMainWindow,
  });
}

module.exports = {
  normalizeLaunchIntent,
  normalizeWindowKey,
  parseLaunchIntent,
};
