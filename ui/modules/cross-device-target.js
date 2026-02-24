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
  isCrossDeviceEnabled,
  parseCrossDeviceTarget,
};
