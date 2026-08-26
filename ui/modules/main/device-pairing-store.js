const fs = require('fs');
const path = require('path');
const { resolveCoordPath } = require('../../config');
const { normalizeDeviceId } = require('../cross-device-target');

function asNonEmptyString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function resolveDevicesPath() {
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath('devices.json', { forWrite: true });
  }
  return path.join(process.cwd(), '.squidrun', 'devices.json');
}

function normalizePairedConfig(input = {}) {
  const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const deviceId = normalizeDeviceId(source.device_id || source.deviceId);
  const sharedSecret = asNonEmptyString(source.shared_secret || source.sharedSecret);
  const relayUrl = asNonEmptyString(source.relay_url || source.relayUrl);
  const pairedDeviceId = normalizeDeviceId(source.paired_device_id || source.pairedDeviceId) || null;
  const pairedAt = asNonEmptyString(source.paired_at || source.pairedAt) || new Date().toISOString();
  if (!deviceId || !sharedSecret || !relayUrl) {
    return null;
  }
  return {
    device_id: deviceId,
    shared_secret: sharedSecret,
    relay_url: relayUrl,
    paired_device_id: pairedDeviceId,
    paired_at: pairedAt,
  };
}

function readPairedConfig(filePath = resolveDevicesPath()) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: true, config: null, path: filePath };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const normalized = normalizePairedConfig(parsed);
    if (!normalized) {
      return {
        ok: false,
        reason: 'invalid_devices_config',
        error: 'devices.json missing required fields',
        config: null,
        path: filePath,
      };
    }
    return { ok: true, config: normalized, path: filePath };
  } catch (err) {
    return {
      ok: false,
      reason: 'devices_read_failed',
      error: err.message,
      config: null,
      path: filePath,
    };
  }
}

function writePairedConfig(input = {}, filePath = resolveDevicesPath()) {
  const normalized = normalizePairedConfig(input);
  if (!normalized) {
    return {
      ok: false,
      reason: 'invalid_devices_config',
      error: 'device_id/shared_secret/relay_url are required',
      path: filePath,
      config: null,
    };
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempPath, filePath);
    return { ok: true, config: normalized, path: filePath };
  } catch (err) {
    return {
      ok: false,
      reason: 'devices_write_failed',
      error: err.message,
      path: filePath,
      config: null,
    };
  }
}

module.exports = {
  resolveDevicesPath,
  normalizePairedConfig,
  readPairedConfig,
  writePairedConfig,
};
