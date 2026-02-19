const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WORKSPACE_PATH, resolveCoordPath } = require('../../config');

function resolveDefaultProfilesPath() {
  if (typeof resolveCoordPath !== 'function') {
    throw new Error('resolveCoordPath unavailable; cannot resolve runtime/experiment-profiles.json');
  }
  return resolveCoordPath(path.join('runtime', 'experiment-profiles.json'), { forWrite: true });
}

const DEFAULT_PROFILE_CWD = path.join(WORKSPACE_PATH, '..', 'ui');
const BASELINE_ENV_KEYS = Object.freeze([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'TMP',
  'TEMP',
  'TERM',
]);
const PARAM_VALUE_REGEX = /^[A-Za-z0-9_./:\\-]+$/;

const DEFAULT_EXPERIMENT_PROFILES = Object.freeze({
  'jest-suite': Object.freeze({
    command: 'npx jest --no-coverage',
    timeoutMs: 120000,
    description: 'Full test suite',
    cwd: DEFAULT_PROFILE_CWD,
    params: [],
  }),
  'jest-file': Object.freeze({
    command: 'npx jest --no-coverage -- {file}',
    timeoutMs: 30000,
    description: 'Single test file',
    cwd: DEFAULT_PROFILE_CWD,
    params: ['file'],
  }),
  lint: Object.freeze({
    command: 'npx eslint {file}',
    timeoutMs: 15000,
    description: 'Lint a specific file',
    cwd: DEFAULT_PROFILE_CWD,
    params: ['file'],
  }),
});

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asPositiveInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.floor(numeric);
}

function normalizeProfileId(value) {
  return asString(value, '').toLowerCase();
}

function normalizeParamList(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const params = [];
  for (const entry of source) {
    const key = normalizeProfileId(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    params.push(key);
  }
  return params;
}

function sanitizeParamValue(value) {
  const text = asString(value, '');
  if (!text) return null;
  if (!PARAM_VALUE_REGEX.test(text)) return null;
  return text;
}

function normalizeProfilesMap(rawProfiles = {}) {
  const source = asObject(rawProfiles);
  const normalized = {};

  for (const [rawProfileId, rawProfile] of Object.entries(source)) {
    const profileId = normalizeProfileId(rawProfileId);
    if (!profileId) continue;

    const profile = asObject(rawProfile);
    const command = asString(profile.command, '');
    if (!command) continue;
    const timeoutMs = asPositiveInt(profile.timeoutMs ?? profile.timeout_ms, 30000) || 30000;
    const description = asString(profile.description, '') || null;
    const cwd = asString(profile.cwd, DEFAULT_PROFILE_CWD);
    const params = normalizeParamList(profile.params);
    const maxOutputBytes = asPositiveInt(profile.outputCapBytes ?? profile.output_cap_bytes, null);

    normalized[profileId] = {
      id: profileId,
      command,
      timeoutMs,
      description,
      cwd,
      params,
      ...(maxOutputBytes ? { outputCapBytes: maxOutputBytes } : {}),
    };
  }

  return normalized;
}

function ensureProfilesFile(options = {}) {
  const profilesPath = asString(options.profilesPath, resolveDefaultProfilesPath());
  const defaults = normalizeProfilesMap(options.defaults || DEFAULT_EXPERIMENT_PROFILES);

  try {
    fs.mkdirSync(path.dirname(profilesPath), { recursive: true });
  } catch {
    // Best effort; read step below will fail with reason.
  }

  if (fs.existsSync(profilesPath)) {
    return {
      ok: true,
      created: false,
      profilesPath,
      defaults,
    };
  }

  try {
    fs.writeFileSync(profilesPath, `${JSON.stringify(defaults, null, 2)}\n`, 'utf-8');
    return {
      ok: true,
      created: true,
      profilesPath,
      defaults,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'profiles_write_failed',
      error: err.message,
      profilesPath,
      defaults,
    };
  }
}

function loadExperimentProfiles(options = {}) {
  const ensureResult = ensureProfilesFile(options);
  const profilesPath = ensureResult.profilesPath || asString(options.profilesPath, resolveDefaultProfilesPath());

  if (!ensureResult.ok) {
    return {
      ok: false,
      reason: ensureResult.reason || 'profiles_unavailable',
      error: ensureResult.error || null,
      profilesPath,
      profiles: {},
      profileIds: [],
    };
  }

  try {
    const rawContent = fs.readFileSync(profilesPath, 'utf-8');
    const parsed = JSON.parse(rawContent);
    const profiles = normalizeProfilesMap(parsed);
    const profileIds = Object.keys(profiles).sort();
    return {
      ok: true,
      profilesPath,
      profiles,
      profileIds,
      created: ensureResult.created === true,
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'profiles_parse_failed',
      error: err.message,
      profilesPath,
      profiles: {},
      profileIds: [],
    };
  }
}

function resolveProfileAndCommand(input = {}, profilesMap = {}) {
  const payload = asObject(input);
  const profileId = normalizeProfileId(payload.profileId || payload.profile || payload.profile_id);
  if (!profileId) {
    return { ok: false, reason: 'profile_id_required' };
  }

  const profile = asObject(profilesMap)[profileId];
  if (!profile || !profile.command) {
    return {
      ok: false,
      reason: 'profile_not_found',
      profileId,
    };
  }

  const sourceArgs = asObject(asObject(payload.input).args);
  let command = String(profile.command);

  for (const param of normalizeParamList(profile.params)) {
    const value = sanitizeParamValue(sourceArgs[param]);
    if (!value) {
      return {
        ok: false,
        reason: 'invalid_or_missing_param',
        profileId,
        param,
      };
    }
    command = command.split(`{${param}}`).join(value);
  }

  return {
    ok: true,
    profileId,
    profile,
    command,
    cwd: asString(asObject(payload.input).repoPath, profile.cwd || DEFAULT_PROFILE_CWD),
    timeoutMs: asPositiveInt(payload.timeoutMs, profile.timeoutMs || 30000) || 30000,
  };
}

function buildExperimentEnv(allowlist) {
  const source = Array.isArray(allowlist) ? allowlist : [];
  const env = {};
  const keys = new Set([...BASELINE_ENV_KEYS, ...source.map((entry) => asString(entry, ''))]);
  for (const key of keys) {
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      env[key] = String(process.env[key]);
    }
  }
  return env;
}

function fingerprintEnv(env = {}) {
  const keys = Object.keys(env).sort();
  const canonical = keys.map((key) => `${key}=${env[key]}`).join('\n');
  return crypto.createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

module.exports = {
  get DEFAULT_PROFILES_PATH() {
    return resolveDefaultProfilesPath();
  },
  DEFAULT_EXPERIMENT_PROFILES,
  DEFAULT_PROFILE_CWD,
  BASELINE_ENV_KEYS,
  resolveDefaultProfilesPath,
  ensureProfilesFile,
  loadExperimentProfiles,
  resolveProfileAndCommand,
  buildExperimentEnv,
  fingerprintEnv,
};
