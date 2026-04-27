const {
  getActiveProfileName,
  isMainProfile,
  normalizeProfileName,
} = require('../profile');

function asNonEmptyString(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text;
}

function normalizeDeviceId(value) {
  const text = asNonEmptyString(value).toUpperCase();
  if (!text) return '';
  const normalized = text.replace(/[^A-Z0-9_-]/g, '');
  return normalized;
}

function getLocalDeviceId(env = process.env) {
  return normalizeDeviceId(env?.SQUIDRUN_DEVICE_ID);
}

function profileDeviceEnvKeys(profileName = '') {
  const suffix = normalizeProfileName(profileName)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  if (!suffix) return [];
  return [
    `SQUIDRUN_DEVICE_ID_${suffix}`,
    `SQUIDRUN_${suffix}_DEVICE_ID`,
  ];
}

function getProfileSpecificDeviceId(env = process.env, profileName = '') {
  for (const key of profileDeviceEnvKeys(profileName)) {
    const deviceId = normalizeDeviceId(env?.[key]);
    if (deviceId) return deviceId;
  }
  return '';
}

function getProfileDeviceId(env = process.env, profileName = null, options = {}) {
  const normalizedProfile = normalizeProfileName(profileName || env?.SQUIDRUN_PROFILE || getActiveProfileName(env));
  const explicit = getProfileSpecificDeviceId(env, normalizedProfile);
  if (explicit) return explicit;

  const baseDeviceId = normalizeDeviceId(options.baseDeviceId || env?.SQUIDRUN_DEVICE_ID);
  if (!baseDeviceId) return '';
  if (isMainProfile(normalizedProfile)) return baseDeviceId;
  return normalizeDeviceId(`${baseDeviceId}-${normalizedProfile}`);
}

function isCrossDeviceEnabled(env = process.env) {
  return String(env?.SQUIDRUN_CROSS_DEVICE || '').trim() === '1';
}

function parseCrossDeviceTarget(target) {
  const raw = asNonEmptyString(target);
  if (!raw.startsWith('@')) return null;

  const match = raw.match(/^@([a-z0-9][a-z0-9_-]{0,63})-(arch|architect)$/i);
  if (!match) return null;

  const toDevice = normalizeDeviceId(match[1]);
  if (!toDevice) return null;

  return {
    raw,
    toDevice,
    targetRole: 'architect',
  };
}

module.exports = {
  normalizeDeviceId,
  getLocalDeviceId,
  getProfileDeviceId,
  getProfileSpecificDeviceId,
  isCrossDeviceEnabled,
  parseCrossDeviceTarget,
};
