'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const DEFAULT_PROFILE = 'main';
const EUNBYEOL_CHAT_ID = '8754356993';
const DEFAULT_MAIN_TELEGRAM_CHAT_ID = '5613428850';
const PROFILE_SCOPED_DIRS = new Set([
  'runtime',
  'settings',
  'logs',
  'triggers',
  'state',
  'context-snapshots',
  'handoffs',
  'memory',
  'instances',
]);
const PROFILE_SCOPED_FILES = new Set([
  'app-status.json',
  'state.json',
  'activity.json',
  'shared_context.md',
  'contract-stats.json',
]);
const PROFILE_PORT_OFFSETS = Object.freeze({
  main: 0,
  private-profile: 1,
});

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeProfileName(value) {
  const normalized = toNonEmptyString(String(value || '').toLowerCase());
  if (!normalized) return DEFAULT_PROFILE;
  if (normalized === 'private-profile' || normalized === '은별' || normalized === 'private-profile') {
    return 'private-profile';
  }
  return normalized.replace(/[^a-z0-9_-]+/g, '-');
}

function getActiveProfileName(env = process.env) {
  return normalizeProfileName(env?.SQUIDRUN_PROFILE || DEFAULT_PROFILE);
}

function isMainProfile(profileName = null) {
  return normalizeProfileName(profileName || DEFAULT_PROFILE) === DEFAULT_PROFILE;
}

function parseProfileArg(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const token = toNonEmptyString(String(args[index] || ''));
    if (!token) continue;
    if (token.startsWith('--profile=')) {
      return normalizeProfileName(token.slice('--profile='.length));
    }
    if (token === '--profile') {
      const next = toNonEmptyString(String(args[index + 1] || ''));
      if (next) return normalizeProfileName(next);
    }
  }
  return DEFAULT_PROFILE;
}

function applyProfileEnv(profileName, env = process.env) {
  const normalized = normalizeProfileName(profileName);
  env.SQUIDRUN_PROFILE = normalized;
  // [private-profile] profile MUST NOT spawn wallet-touching trading lanes — it shares the
  // same .env wallet with the main profile and would cause duplicate HL polling
  // (root cause of the 429 wall during live betting). Force every wallet-touching
  // lane to disabled at supervisor construction time, and blank out HL credentials
  // as defense in depth so any lane that slips through cannot reach the wallet.
  if (normalized === 'private-profile') {
    env.SQUIDRUN_LIVE_OPS_AUTOMATION = '0';
    env.SQUIDRUN_ORACLE_WATCH = '0';
    env.SQUIDRUN_CRYPTO_TRADING_AUTOMATION = '0';
    env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = '0';
    env.SQUIDRUN_LIVE_OPS_SQUEEZE_DETECTOR = '0';
    env.SQUIDRUN_LIVE_OPS_MONITOR = '0';
    env.LIVE_OPS_WALLET_ADDRESS = '';
    env.LIVE_OPS_ADDRESS = '';
    env.POLYMARKET_FUNDER_ADDRESS = '';
    env.LIVE_OPS_PRIVATE_KEY = '';
  }
  return normalized;
}

function suffixName(name, profileName) {
  if (isMainProfile(profileName)) return name;
  const ext = path.extname(name);
  if (!ext) return `${name}-${profileName}`;
  const base = name.slice(0, -ext.length);
  return `${base}-${profileName}${ext}`;
}

function namespaceCoordRelPath(relPath, profileName) {
  const normalizedProfile = normalizeProfileName(profileName);
  const normalizedRelPath = String(relPath || '')
    .replace(/^[\\/]+/, '')
    .replace(/[\\/]+/g, '/');
  if (!normalizedRelPath || isMainProfile(normalizedProfile)) {
    return normalizedRelPath;
  }

  const segments = normalizedRelPath.split('/').filter(Boolean);
  if (segments.length === 0) return normalizedRelPath;

  if (PROFILE_SCOPED_DIRS.has(segments[0])) {
    segments[0] = `${segments[0]}-${normalizedProfile}`;
    return segments.join('/');
  }

  if (segments.length === 1 && PROFILE_SCOPED_FILES.has(segments[0])) {
    return suffixName(segments[0], normalizedProfile);
  }

  return normalizedRelPath;
}

function getProfilePipePath(profileName = null, platform = os.platform()) {
  const normalizedProfile = normalizeProfileName(profileName || DEFAULT_PROFILE);
  const pipeBaseName = isMainProfile(normalizedProfile)
    ? 'squidrun-terminal'
    : `squidrun-terminal-${normalizedProfile}`;
  return platform === 'win32'
    ? `\\\\.\\pipe\\${pipeBaseName}`
    : `/tmp/${pipeBaseName}.sock`;
}

function getProfileWebSocketPort(profileName = null, basePort = 9900) {
  const normalizedProfile = normalizeProfileName(profileName || DEFAULT_PROFILE);
  const explicitOffset = PROFILE_PORT_OFFSETS[normalizedProfile];
  if (Number.isInteger(explicitOffset)) {
    return basePort + explicitOffset;
  }
  let hash = 0;
  for (const ch of normalizedProfile) {
    hash = (hash + ch.charCodeAt(0)) % 97;
  }
  return basePort + 10 + hash;
}

function getProfileProjectRootOverride(profileName = null, env = process.env) {
  const normalizedProfile = normalizeProfileName(profileName || env?.SQUIDRUN_PROFILE || DEFAULT_PROFILE);
  if (isMainProfile(normalizedProfile)) return null;

  const specificEnvName = `SQUIDRUN_${normalizedProfile.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PROJECT_ROOT`;
  const explicitRoot = toNonEmptyString(env?.[specificEnvName]);
  if (explicitRoot && fs.existsSync(explicitRoot)) {
    return path.resolve(explicitRoot);
  }

  if (normalizedProfile === 'private-profile') {
    const siblingCaseworkRoot = path.resolve(__dirname, '..', '..', 'private-profile-casework');
    if (fs.existsSync(siblingCaseworkRoot)) {
      return siblingCaseworkRoot;
    }
  }

  return null;
}

function getProfileInstructionFilename(baseName, profileName = null) {
  const normalizedProfile = normalizeProfileName(profileName || DEFAULT_PROFILE);
  if (isMainProfile(normalizedProfile)) return baseName;
  if (!['CLAUDE.md', 'ROLES.md'].includes(String(baseName || ''))) {
    return baseName;
  }
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  return `${stem}.${normalizedProfile}${ext || ''}`;
}

function resolveProfileInstructionPath(projectRoot, baseName, profileName = null) {
  return path.join(projectRoot, getProfileInstructionFilename(baseName, profileName));
}

function sanitizeChatList(value, denySet = new Set()) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !denySet.has(entry))
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .join(',');
}

function buildProfileTelegramEnv(env = process.env, profileName = null) {
  const normalizedProfile = normalizeProfileName(profileName || env?.SQUIDRUN_PROFILE || DEFAULT_PROFILE);
  const nextEnv = {
    ...env,
    SQUIDRUN_PROFILE: normalizedProfile,
  };
  if (normalizedProfile === 'private-profile') {
    nextEnv.TELEGRAM_CHAT_ID = EUNBYEOL_CHAT_ID;
    nextEnv.TELEGRAM_AUTHORIZED_CHAT_IDS = '';
    nextEnv.TELEGRAM_CHAT_ALLOWLIST = '';
    return nextEnv;
  }

  const denySet = new Set([EUNBYEOL_CHAT_ID]);
  nextEnv.TELEGRAM_AUTHORIZED_CHAT_IDS = sanitizeChatList(env?.TELEGRAM_AUTHORIZED_CHAT_IDS, denySet);
  nextEnv.TELEGRAM_CHAT_ALLOWLIST = sanitizeChatList(env?.TELEGRAM_CHAT_ALLOWLIST, denySet);
  if (String(nextEnv.TELEGRAM_CHAT_ID || '').trim() === EUNBYEOL_CHAT_ID) {
    nextEnv.TELEGRAM_CHAT_ID = DEFAULT_MAIN_TELEGRAM_CHAT_ID;
  }
  return nextEnv;
}

module.exports = {
  DEFAULT_PROFILE,
  EUNBYEOL_CHAT_ID,
  PROFILE_SCOPED_DIRS,
  PROFILE_SCOPED_FILES,
  normalizeProfileName,
  getActiveProfileName,
  isMainProfile,
  parseProfileArg,
  applyProfileEnv,
  namespaceCoordRelPath,
  getProfilePipePath,
  getProfileWebSocketPort,
  getProfileProjectRootOverride,
  getProfileInstructionFilename,
  resolveProfileInstructionPath,
  buildProfileTelegramEnv,
};
