const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  clearSurfaceCaptureEvents,
  recordSurfaceCaptureEvent,
  sha256Buffer,
  verifySurfaceCaptureEvent,
} = require('../modules/surface-capture-events');

describe('surface-capture-events', () => {
  afterEach(() => {
    clearSurfaceCaptureEvents();
  });

  test('verifies an app-recorded capture event against current image bytes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-capture-event-'));
    const screenshotPath = path.join(tempDir, 'screenshot.png');
    const sourcePath = path.join(tempDir, 'capture.png');
    const buffer = Buffer.from('real capture bytes');
    fs.writeFileSync(screenshotPath, buffer);
    fs.writeFileSync(sourcePath, buffer);

    try {
      const event = recordSurfaceCaptureEvent({
        windowKey: 'squid-room',
        paneId: 'trustquote-app',
        scope: 'pane',
        path: sourcePath,
        buffer,
        runId: 'run-1',
      }, {
        nowMs: 1_780_000_000_000,
      });

      expect(verifySurfaceCaptureEvent({
        eventId: event.eventId,
        imageSha256: sha256Buffer(buffer),
        screenshotPath,
        returnedPath: sourcePath,
        windowKey: 'squid-room',
        paneId: 'trustquote-app',
        scope: 'pane',
        runId: 'run-1',
      }, {
        nowMs: 1_780_000_000_100,
      })).toEqual(expect.objectContaining({ ok: true }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects a forged event id even when the caller supplies a matching fake hash', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-capture-event-'));
    const screenshotPath = path.join(tempDir, 'fake.png');
    const buffer = Buffer.from('fake bytes');
    fs.writeFileSync(screenshotPath, buffer);

    try {
      expect(verifySurfaceCaptureEvent({
        eventId: 'hand-written-event',
        imageSha256: sha256Buffer(buffer),
        screenshotPath,
        returnedPath: screenshotPath,
        windowKey: 'squid-room',
        paneId: 'trustquote-app',
        scope: 'pane',
        runId: 'run-1',
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'surface_capture_event_not_found',
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects image bytes that no longer match the app-recorded hash', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-capture-event-'));
    const screenshotPath = path.join(tempDir, 'screenshot.png');
    const sourcePath = path.join(tempDir, 'capture.png');
    const buffer = Buffer.from('real capture bytes');
    fs.writeFileSync(screenshotPath, buffer);
    fs.writeFileSync(sourcePath, buffer);

    try {
      const event = recordSurfaceCaptureEvent({
        windowKey: 'squid-room',
        paneId: 'trustquote-app',
        scope: 'pane',
        path: sourcePath,
        buffer,
        runId: 'run-1',
      });
      fs.writeFileSync(screenshotPath, Buffer.from('tampered bytes'));

      expect(verifySurfaceCaptureEvent({
        eventId: event.eventId,
        imageSha256: sha256Buffer(buffer),
        screenshotPath,
        returnedPath: sourcePath,
        windowKey: 'squid-room',
        paneId: 'trustquote-app',
        scope: 'pane',
        runId: 'run-1',
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'surface_capture_event_claim_image_hash_mismatch',
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
