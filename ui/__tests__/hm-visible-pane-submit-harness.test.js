const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  collectHarnessOptions,
  parseArgs,
  resolvePaneId,
  runHarness,
} = require('../scripts/hm-visible-pane-submit-harness');
const {
  validateSurfaceArtifact,
} = require('../scripts/hm-send-surface-claim-guard');

const NOW_MS = 1_780_000_000_000;

class FakeDaemonClient extends EventEmitter {
  constructor() {
    super();
    this.attachCount = 0;
  }

  async connect() {
    return true;
  }

  attach(paneId) {
    const scrollback = this.attachCount === 0
      ? 'codex> '
      : 'codex> test prompt\r\nAgent output underneath after submit.\r\ncodex> ';
    this.attachCount += 1;
    setImmediate(() => {
      this.emit('attached', paneId, 1234, true, scrollback);
    });
    return true;
  }

  getLastActivity() {
    return NOW_MS + 1000;
  }

  disconnect() {}
}

function writeCaptureFile(tempDir) {
  const capturePath = path.join(tempDir, 'capture-pane-trustquote-builder.png');
  fs.writeFileSync(capturePath, 'capture image');
  return capturePath;
}

describe('hm-visible-pane-submit-harness', () => {
  test('resolves TrustQuote target roles to work-room pane ids', () => {
    expect(resolvePaneId({ windowKey: 'trustquote', targetRole: 'builder' })).toBe('trustquote-builder');
    expect(resolvePaneId({ windowKey: 'trustquote', targetRole: 'oracle' })).toBe('trustquote-oracle');
  });

  test('collects CLI options for a TrustQuote visible pane run', () => {
    const parsed = parseArgs([
      'run',
      '--window-key', 'trustquote',
      '--target-role', 'builder',
      '--message', 'What do you see?',
      '--artifact-root', 'D:/tmp/artifacts',
    ]);
    const options = collectHarnessOptions(parsed);

    expect(options).toMatchObject({
      command: 'run',
      windowKey: 'trustquote',
      targetRole: 'builder',
      paneId: 'trustquote-builder',
      message: 'What do you see?',
    });
  });

  test('writes manifest that the surface guard accepts for the same TrustQuote pane surface', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visible-pane-submit-'));
    const capturePath = writeCaptureFile(tempDir);

    try {
      const result = await runHarness({
        windowKey: 'trustquote',
        targetRole: 'builder',
        paneId: 'trustquote-builder',
        terminalId: 'trustquote-builder',
        message: 'Harness prompt',
        role: 'builder',
        port: 9979,
        waitMs: 100,
        pollMs: 10,
        timeoutMs: 1000,
        label: 'visible-pane-submit',
        artifactRoot: path.join(tempDir, 'visible-pane-submit'),
      }, {
        nowMs: () => NOW_MS,
        daemonClient: new FakeDaemonClient(),
        sendHarnessMessage: async () => ({
          requestId: 'request-1',
          messageId: 'message-1',
          result: {
            accepted: true,
            verified: true,
            status: 'delivered.verified',
            deliveryId: 'delivery-1',
          },
        }),
        captureScreenshot: async (payload) => ({
          success: true,
          path: capturePath,
          paneId: 'trustquote-builder',
          scope: 'pane',
          imageSha256: 'b'.repeat(64),
          captureEvent: {
            eventId: 'capture-event-1',
            source: 'squidrun-electron-main-capture-event',
            recordedAt: new Date(NOW_MS).toISOString(),
            imageSha256: 'b'.repeat(64),
            runId: payload.runId,
          },
        }),
      });

      expect(result.ok).toBe(true);
      expect(fs.existsSync(result.screenshotPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
      expect(manifest).toMatchObject({
        schema: 'squidrun.visible_pane_submit_harness.v0',
        producer: 'hm-visible-pane-submit-harness',
        windowKey: 'trustquote',
        paneId: 'trustquote-builder',
        targetRole: 'builder',
        surface: {
          sameWindowUserSurface: true,
          windowKey: 'trustquote',
          paneId: 'trustquote-builder',
        },
        capture: {
          provider: 'squidrun-app-websocket-screenshot',
          source: 'electron.capturePage',
          eventId: 'capture-event-1',
          eventSource: 'squidrun-electron-main-capture-event',
          imageSha256: 'b'.repeat(64),
          windowKey: 'trustquote',
          paneId: 'trustquote-builder',
          scope: 'pane',
        },
      });
      expect(validateSurfaceArtifact(result.screenshotPath, {
        nowMs: NOW_MS,
        content: `Visible in the TrustQuote dashboard: ${result.screenshotPath}`,
        captureEventVerifier: () => ({ ok: true }),
      })).toEqual(expect.objectContaining({ ok: true }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
