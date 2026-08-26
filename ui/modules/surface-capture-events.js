'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EVENT_SOURCE = 'squidrun-electron-main-capture-event';
const DEFAULT_MAX_EVENT_AGE_MS = 45 * 60 * 1000;
const MAX_EVENTS = 1000;
const eventsById = new Map();

function asText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizePath(value) {
  const text = asText(value);
  if (!text) return '';
  try {
    return path.resolve(text).toLowerCase();
  } catch (_) {
    return text.replace(/\\/g, '/').toLowerCase();
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function pruneEvents(nowMs = Date.now(), maxAgeMs = DEFAULT_MAX_EVENT_AGE_MS) {
  const cutoff = Math.max(0, Number(nowMs) - Math.max(1, Number(maxAgeMs) || DEFAULT_MAX_EVENT_AGE_MS));
  for (const [eventId, event] of eventsById.entries()) {
    const recordedAtMs = Date.parse(event.recordedAt || '');
    if (!Number.isFinite(recordedAtMs) || recordedAtMs < cutoff || eventsById.size > MAX_EVENTS) {
      eventsById.delete(eventId);
    }
  }
}

function recordSurfaceCaptureEvent(input = {}, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : null;
  const imageSha256 = asText(input.imageSha256) || (buffer ? sha256Buffer(buffer) : '');
  const event = {
    schema: 'squidrun.surface_capture_event.v0',
    source: EVENT_SOURCE,
    eventId: crypto.randomUUID(),
    recordedAt: new Date(nowMs).toISOString(),
    windowKey: asText(input.windowKey, 'main'),
    paneId: asText(input.paneId) || null,
    scope: asText(input.scope, 'all'),
    path: path.resolve(asText(input.path)),
    imageSha256,
    requestId: asText(input.requestId) || null,
    runId: asText(input.runId) || null,
  };
  eventsById.set(event.eventId, event);
  pruneEvents(nowMs);

  const auditLogPath = asText(options.auditLogPath);
  if (auditLogPath) {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    fs.appendFileSync(auditLogPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  return event;
}

function verifySurfaceCaptureEvent(input = {}, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const maxAgeMs = Math.max(1, Number(options.maxAgeMs) || DEFAULT_MAX_EVENT_AGE_MS);
  pruneEvents(nowMs, maxAgeMs);

  const eventId = asText(input.eventId);
  if (!eventId) return { ok: false, reason: 'surface_capture_event_id_missing' };
  const event = eventsById.get(eventId);
  if (!event) return { ok: false, reason: 'surface_capture_event_not_found' };

  const recordedAtMs = Date.parse(event.recordedAt || '');
  if (!Number.isFinite(recordedAtMs) || nowMs - recordedAtMs > maxAgeMs) {
    return { ok: false, reason: 'surface_capture_event_stale' };
  }
  if (event.source !== EVENT_SOURCE) {
    return { ok: false, reason: 'surface_capture_event_untrusted_source' };
  }

  const windowKey = asText(input.windowKey, 'main');
  const paneId = asText(input.paneId) || null;
  const scope = asText(input.scope, 'pane');
  const runId = asText(input.runId) || null;
  const returnedPath = asText(input.returnedPath);
  const screenshotPath = asText(input.screenshotPath);
  const expectedHash = asText(input.imageSha256);

  if (event.windowKey !== windowKey) return { ok: false, reason: 'surface_capture_event_window_mismatch' };
  if ((event.paneId || null) !== paneId) return { ok: false, reason: 'surface_capture_event_pane_mismatch' };
  if (event.scope !== scope) return { ok: false, reason: 'surface_capture_event_scope_mismatch' };
  if ((event.runId || null) !== runId) return { ok: false, reason: 'surface_capture_event_run_mismatch' };
  if (expectedHash && event.imageSha256 !== expectedHash) {
    return { ok: false, reason: 'surface_capture_event_manifest_hash_mismatch' };
  }
  if (returnedPath && normalizePath(event.path) !== normalizePath(returnedPath)) {
    return { ok: false, reason: 'surface_capture_event_returned_path_mismatch' };
  }

  try {
    if (screenshotPath) {
      const claimHash = sha256File(screenshotPath);
      if (claimHash !== event.imageSha256) {
        return { ok: false, reason: 'surface_capture_event_claim_image_hash_mismatch' };
      }
    }
    if (event.path && fs.existsSync(event.path)) {
      const eventPathHash = sha256File(event.path);
      if (eventPathHash !== event.imageSha256) {
        return { ok: false, reason: 'surface_capture_event_source_image_hash_mismatch' };
      }
    }
  } catch (err) {
    return { ok: false, reason: 'surface_capture_event_hash_read_failed', error: err.message };
  }

  return {
    ok: true,
    event: {
      eventId: event.eventId,
      recordedAt: event.recordedAt,
      windowKey: event.windowKey,
      paneId: event.paneId,
      scope: event.scope,
      path: event.path,
      imageSha256: event.imageSha256,
      runId: event.runId,
    },
  };
}

function clearSurfaceCaptureEvents() {
  eventsById.clear();
}

module.exports = {
  EVENT_SOURCE,
  DEFAULT_MAX_EVENT_AGE_MS,
  clearSurfaceCaptureEvents,
  recordSurfaceCaptureEvent,
  sha256Buffer,
  sha256File,
  verifySurfaceCaptureEvent,
};
