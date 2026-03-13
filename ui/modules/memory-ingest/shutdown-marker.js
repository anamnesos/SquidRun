const fs = require('fs');
const path = require('path');
const { resolveCoordPath } = require('../../config');

const SHUTDOWN_MARKER_VERSION = 1;

function resolveDefaultShutdownMarkerPath() {
  if (typeof resolveCoordPath !== 'function') {
    throw new Error('resolveCoordPath unavailable; cannot resolve runtime/memory-ingest-shutdown.json');
  }
  return resolveCoordPath(path.join('runtime', 'memory-ingest-shutdown.json'), { forWrite: true });
}

function asString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, payload) {
  const targetPath = path.resolve(String(filePath));
  const tempPath = `${targetPath}.tmp`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, targetPath);
  return targetPath;
}

class MemoryIngestShutdownMarker {
  constructor(options = {}) {
    this.filePath = options.filePath || resolveDefaultShutdownMarkerPath();
  }

  read() {
    return safeReadJson(this.filePath);
  }

  armStartup(options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
    const previous = this.read();
    const hadAbruptShutdown = !previous || previous.clean !== true;
    const marker = {
      version: SHUTDOWN_MARKER_VERSION,
      clean: false,
      pid: process.pid,
      started_at: nowMs,
      session_id: asString(options.sessionId || '', '') || null,
      device_id: asString(options.deviceId || process.env.SQUIDRUN_DEVICE_ID || '', '') || null,
      armed_reason: asString(options.reason || 'startup', 'startup'),
    };
    writeJsonAtomic(this.filePath, marker);
    return {
      ok: true,
      hadAbruptShutdown,
      previous,
      marker,
      filePath: this.filePath,
    };
  }

  markCleanShutdown(options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.floor(Number(options.nowMs)) : Date.now();
    const marker = {
      version: SHUTDOWN_MARKER_VERSION,
      clean: true,
      pid: process.pid,
      clean_shutdown_at: nowMs,
      session_id: asString(options.sessionId || '', '') || null,
      device_id: asString(options.deviceId || process.env.SQUIDRUN_DEVICE_ID || '', '') || null,
      shutdown_reason: asString(options.reason || 'shutdown', 'shutdown'),
    };
    writeJsonAtomic(this.filePath, marker);
    return {
      ok: true,
      marker,
      filePath: this.filePath,
    };
  }
}

module.exports = {
  MemoryIngestShutdownMarker,
  SHUTDOWN_MARKER_VERSION,
  resolveDefaultShutdownMarkerPath,
};
