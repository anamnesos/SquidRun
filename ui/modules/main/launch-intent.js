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
  if (normalized === 'scoped') return 'scoped';
  return normalized;
}

function normalizeLaunchIntent(rawIntent = {}) {
  const explicitWindowKey = toNonEmptyString(String(rawIntent.windowKey || rawIntent.targetWindowKey || ''));
  const profileName = normalizeProfileName(
    rawIntent.profileName || (normalizeWindowKey(explicitWindowKey) === 'scoped' ? 'scoped' : DEFAULT_PROFILE)
  );
  const profileOnlyScopedLaunch = !explicitWindowKey && profileName === 'scoped';
  const windowKey = profileOnlyScopedLaunch
    ? 'scoped'
    : normalizeWindowKey(explicitWindowKey || 'main');
  const includeMainWindow = windowKey === 'main'
    ? true
    : (profileOnlyScopedLaunch ? rawIntent.includeMainWindow === true : rawIntent.includeMainWindow !== false);
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
  let includeMainWindow = null;
  let profileName = null;

  for (let index = 0; index < args.length; index += 1) {
    const token = toNonEmptyString(String(args[index] || ''));
    if (!token) continue;

    if (token === '--scoped') {
      windowKey = 'scoped';
      includeMainWindow = false;
      continue;
    }

    if (token.startsWith('--profile=')) {
      profileName = parseProfileArg([token]);
      continue;
    }

    if (token === '--profile') {
      const next = toNonEmptyString(String(args[index + 1] || ''));
      if (next) {
        profileName = parseProfileArg([token, next]);
        index += 1;
      }
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
