'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  resolveInstalledDataRoot,
  resolveInstalledPipeDiscriminator,
  computeDataRootPipeDiscriminator,
} = require('./modules/installed-data-root');

const DEFAULT_PROFILE = 'main';
const SCOPED_PROFILE_CHAT_ID = '2222222222';
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
  scoped: 1,
  eunbyeol: 1,
});
const PROFILE_ROOT_CONFIG_VERSION = 'squidrun.profile-root.v0';

function toNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeProfileName(value) {
  const normalized = toNonEmptyString(String(value || '').toLowerCase());
  if (!normalized) return DEFAULT_PROFILE;
  if (normalized === 'scoped') return 'scoped';
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
  // Scoped profiles run only the public-core coordination lanes. Keep removed
  // live-ops flags disabled as defense in depth for older env files.
  if (normalized === 'scoped') {
    env.SQUIDRUN_LIVE_OPS_AUTOMATION = '0';
    env.SQUIDRUN_ORACLE_WATCH = '0';
    env.SQUIDRUN_CRYPTO_TRADING_AUTOMATION = '0';
    env.SQUIDRUN_MARKET_SCANNER_AUTOMATION = '0';
    env.SQUIDRUN_LIVE_OPS_SQUEEZE_DETECTOR = '0';
    env.SQUIDRUN_LIVE_OPS_MONITOR = '0';
    env.LIVE_OPS_WALLET_ADDRESS = '';
    env.LIVE_OPS_ADDRESS = '';
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

// Resolve the per-install pipe discriminator. Self-resolving (not caller-passed)
// so every consumer — the config PIPE_PATH constant, the daemon client, and the
// detached daemon process — derives the SAME pipe from the same data root without
// threading the value through call sites. Options override for determinism/tests:
//   { installDiscriminator } - explicit value (or null to force the legacy pipe)
//   { dataRoot }             - hash this path
//   { env }                  - env used for install resolution (default process.env)
function resolvePipeDiscriminator(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'installDiscriminator')) {
    return toNonEmptyString(options.installDiscriminator);
  }
  if (options.dataRoot) {
    return computeDataRootPipeDiscriminator(options.dataRoot);
  }
  try {
    const resolved = resolveInstalledDataRoot({ env: options.env || process.env });
    return resolveInstalledPipeDiscriminator(resolved);
  } catch (_) {
    // Pipe resolution must never throw at startup; fall back to the legacy pipe.
    return null;
  }
}

function getProfilePipePath(profileName = null, platform = os.platform(), options = {}) {
  const normalizedProfile = normalizeProfileName(profileName || DEFAULT_PROFILE);
  let pipeBaseName = isMainProfile(normalizedProfile)
    ? 'squidrun-terminal'
    : `squidrun-terminal-${normalizedProfile}`;
  const discriminator = resolvePipeDiscriminator(options);
  if (discriminator) {
    pipeBaseName = `${pipeBaseName}-${discriminator}`;
  }
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

function getProfileProjectRootOverride(profileName = null, env = process.env, options = {}) {
  const normalizedProfile = normalizeProfileName(profileName || env?.SQUIDRUN_PROFILE || DEFAULT_PROFILE);
  if (isMainProfile(normalizedProfile)) return null;

  const specificEnvName = `SQUIDRUN_${normalizedProfile.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PROJECT_ROOT`;
  const explicitRoot = toNonEmptyString(env?.[specificEnvName]);
  if (explicitRoot && fs.existsSync(explicitRoot)) {
    return path.resolve(explicitRoot);
  }

  const configPath = getProfileProjectRootConfigPath(normalizedProfile, options?.squidrunRoot);
  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const configuredRoot = toNonEmptyString(parsed?.projectRoot || parsed?.workspace);
      if (configuredRoot && fs.existsSync(configuredRoot)) {
        return path.resolve(configuredRoot);
      }
    }
  } catch (_) {
    // Invalid local profile-root contracts are ignored so env/bundled fallbacks still work.
  }

  const bundledProfileRoot = path.resolve(__dirname, '..', '.squidrun', 'profiles', normalizedProfile, 'workspace');
  if (fs.existsSync(bundledProfileRoot)) {
    return bundledProfileRoot;
  }

  return null;
}

function getProfileProjectRootConfigPath(profileName = null, squidrunRoot = null) {
  const normalizedProfile = normalizeProfileName(profileName || DEFAULT_PROFILE);
  const root = path.resolve(squidrunRoot || path.join(__dirname, '..'));
  return path.join(root, '.squidrun', 'profiles', normalizedProfile, 'project-root.json');
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

function normalizeTelegramChatId(value) {
  const text = toNonEmptyString(String(value || ''));
  if (!text || !/^-?\d+$/.test(text)) return null;
  return text;
}

function resolveScopedProfileChatId(env = process.env, options = {}) {
  const configured = normalizeTelegramChatId(env?.TELEGRAM_SCOPED_CHAT_ID);
  if (configured) return configured;
  if (options.warnOnFallback === true && typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn('[profile] TELEGRAM_SCOPED_CHAT_ID is not configured; using placeholder scoped chat id.');
  }
  return SCOPED_PROFILE_CHAT_ID;
}

function collectScopedTelegramChatIds(env = process.env, scopedProfileChatId = null) {
  const ids = String(env?.TELEGRAM_SCOPED_CHAT_IDS || '')
    .split(',')
    .map((entry) => normalizeTelegramChatId(entry))
    .filter(Boolean);
  const directScopedChatId = normalizeTelegramChatId(scopedProfileChatId)
    || resolveScopedProfileChatId(env);
  ids.push(directScopedChatId, SCOPED_PROFILE_CHAT_ID);
  return Array.from(new Set(ids));
}

function buildProfileTelegramEnv(env = process.env, profileName = null) {
  const normalizedProfile = normalizeProfileName(profileName || env?.SQUIDRUN_PROFILE || DEFAULT_PROFILE);
  const scopedProfileChatId = resolveScopedProfileChatId(env, {
    warnOnFallback: !isMainProfile(normalizedProfile),
  });
  const nextEnv = {
    ...env,
    SQUIDRUN_PROFILE: normalizedProfile,
  };
  nextEnv.TELEGRAM_SCOPED_CHAT_IDS = sanitizeChatList(
    `${env?.TELEGRAM_SCOPED_CHAT_IDS || ''},${scopedProfileChatId}`
  );
  if (!isMainProfile(normalizedProfile)) {
    nextEnv.TELEGRAM_CHAT_ID = scopedProfileChatId;
    nextEnv.TELEGRAM_AUTHORIZED_CHAT_IDS = '';
    nextEnv.TELEGRAM_CHAT_ALLOWLIST = '';
    return nextEnv;
  }

  const denySet = new Set(collectScopedTelegramChatIds(env, scopedProfileChatId));
  nextEnv.TELEGRAM_AUTHORIZED_CHAT_IDS = sanitizeChatList(env?.TELEGRAM_AUTHORIZED_CHAT_IDS, denySet);
  nextEnv.TELEGRAM_CHAT_ALLOWLIST = sanitizeChatList(env?.TELEGRAM_CHAT_ALLOWLIST, denySet);
  if (denySet.has(String(nextEnv.TELEGRAM_CHAT_ID || '').trim())) {
    delete nextEnv.TELEGRAM_CHAT_ID;
  }
  return nextEnv;
}

module.exports = {
  DEFAULT_PROFILE,
  PROFILE_ROOT_CONFIG_VERSION,
  SCOPED_PROFILE_CHAT_ID,
  PROFILE_SCOPED_DIRS,
  PROFILE_SCOPED_FILES,
  normalizeProfileName,
  getActiveProfileName,
  isMainProfile,
  parseProfileArg,
  applyProfileEnv,
  getProfileProjectRootConfigPath,
  namespaceCoordRelPath,
  getProfilePipePath,
  getProfileWebSocketPort,
  getProfileProjectRootOverride,
  getProfileInstructionFilename,
  resolveProfileInstructionPath,
  resolveScopedProfileChatId,
  buildProfileTelegramEnv,
};
