const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectSurfaceClaimGuardViolation,
  extractImagePaths,
  findLatestUserRepeat,
  hasSurfaceCompletionClaim,
  validateSurfaceArtifact,
} = require('../scripts/hm-send-surface-claim-guard');

const NOW_MS = 1_780_000_000_000;

function userRow(rawBody, offsetMs, id = 'row') {
  return {
    messageId: id,
    senderRole: 'user',
    targetRole: 'architect',
    direction: 'inbound',
    brokeredAtMs: NOW_MS - offsetMs,
    rawBody,
  };
}

function writeSurfaceArtifact(tempDir, options = {}) {
  const runDir = path.join(tempDir, options.runDir || 'visible-pane-submit', options.runId || 'trustquote-builder-run');
  const currentDir = path.join(runDir, 'current');
  fs.mkdirSync(currentDir, { recursive: true });
  const screenshotPath = path.join(currentDir, options.fileName || 'screenshot.png');
  fs.writeFileSync(screenshotPath, 'not actually a png but enough for path/provenance tests');
  const windowKey = options.windowKey || 'trustquote';
  const paneId = options.paneId || 'trustquote-builder';
  const targetRole = options.targetRole || 'builder';
  const imageSha256 = options.imageSha256 || 'a'.repeat(64);
  const eventId = options.eventId || 'capture-event-1';
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    schema: 'squidrun.visible_pane_submit_harness.v0',
    producer: 'hm-visible-pane-submit-harness',
    runId: options.runId || 'trustquote-builder-run',
    generatedAt: new Date(options.generatedAtMs || NOW_MS).toISOString(),
    windowKey,
    paneId,
    terminalId: paneId,
    targetRole,
    screenshotPath,
    observedStateSummary: options.observedStateSummary || 'target=builder; pane=trustquote-builder; window=trustquote; outputDeltaChars=120; postSubmitOutputObserved=true',
    surface: {
      kind: 'visible_pane_submit',
      source: 'same-window-user-surface',
      sameWindowUserSurface: true,
      forbiddenSubstitute: false,
      windowKey,
      paneId,
      terminalId: paneId,
      targetRole,
    },
    capture: {
      provider: options.captureProvider || 'squidrun-app-websocket-screenshot',
      source: options.captureSource || 'electron.capturePage',
      eventId,
      eventSource: options.eventSource || 'squidrun-electron-main-capture-event',
      eventRecordedAt: new Date(options.generatedAtMs || NOW_MS).toISOString(),
      imageSha256,
      runId: options.runId || 'trustquote-builder-run',
      requestedWindowKey: options.requestedWindowKey || windowKey,
      windowKey,
      requestedPaneId: options.requestedPaneId || paneId,
      paneId,
      scope: options.captureScope || 'pane',
      returnedPath: options.captureReturnedPath || screenshotPath,
    },
    files: {
      screenshot: screenshotPath,
    },
    summary: {
      screenshotPath,
      observedStateSummary: options.observedStateSummary || 'target=builder; pane=trustquote-builder; window=trustquote; outputDeltaChars=120; postSubmitOutputObserved=true',
    },
  }, null, 2));
  return screenshotPath;
}

function verifiedCaptureEvent() {
  return { ok: true };
}

function writeGenericFreshArtifact(tempDir) {
  const runDir = path.join(tempDir, 'visual-capture-run');
  const currentDir = path.join(runDir, 'current');
  fs.mkdirSync(currentDir, { recursive: true });
  const screenshotPath = path.join(currentDir, 'screenshot.png');
  fs.writeFileSync(screenshotPath, 'generic image');
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    generatedAt: new Date(NOW_MS).toISOString(),
    files: { screenshot: screenshotPath },
    summary: { screenshotPath },
  }, null, 2));
  return screenshotPath;
}

describe('hm-send surface claim guard', () => {
  test('detects repeated James points from recent inbound rows', () => {
    const repeat = findLatestUserRepeat([
      userRow('There is still nothing in my TrustQuote dashboard.', 0, 'latest'),
      userRow('There is nothing in my TrustQuote dashboard.', 60_000, 'previous'),
    ], {
      nowMs: NOW_MS,
    });

    expect(repeat).toEqual(expect.objectContaining({
      latestMessageId: 'latest',
      previousMessageId: 'previous',
    }));
    expect(repeat.score).toBeGreaterThanOrEqual(0.6);
  });

  test('blocks user-facing output after a repeated point unless the unresolved surface is named', () => {
    const violation = detectSurfaceClaimGuardViolation({
      content: 'Route proof is green and status is clean.',
      targetRole: 'telegram',
      targetRaw: 'telegram',
      senderRole: 'architect',
      sessionId: 'app-session-386',
      nowMs: NOW_MS,
      recentUserRows: [
        userRow('There is still nothing in my TrustQuote dashboard.', 0, 'latest'),
        userRow('There is nothing in my TrustQuote dashboard.', 60_000, 'previous'),
      ],
    });

    expect(violation).toMatchObject({
      violation_class: 'james_repeat_requires_surface_concession',
      sessionId: 'app-session-386',
    });
  });

  test('allows repeated-point replies that concede the actual missing surface', () => {
    const violation = detectSurfaceClaimGuardViolation({
      content: "You're right, it is not visible in your TrustQuote dashboard. Exact blocker: I do not have the real surface proof yet.",
      targetRole: 'telegram',
      targetRaw: 'telegram',
      senderRole: 'architect',
      nowMs: NOW_MS,
      recentUserRows: [
        userRow('There is still nothing in my TrustQuote dashboard.', 0, 'latest'),
        userRow('There is nothing in my TrustQuote dashboard.', 60_000, 'previous'),
      ],
    });

    expect(violation).toBeNull();
  });

  test('blocks done or visible claims to James without a literal surface artifact', () => {
    expect(hasSurfaceCompletionClaim('Done: the demo invoice is visible in the TrustQuote dashboard.')).toBe(true);

    const violation = detectSurfaceClaimGuardViolation({
      content: 'Done: the demo invoice is visible in the TrustQuote dashboard.',
      targetRole: 'telegram',
      targetRaw: 'telegram',
      senderRole: 'architect',
      recentUserRows: [],
    });

    expect(violation).toMatchObject({
      violation_class: 'surface_done_claim_without_artifact',
    });
  });

  test('allows forward-looking Telegram status without treating the channel as a surface', () => {
    for (const content of [
      "We'll keep working on TrustQuote route-owner tonight.",
      "Builder is finishing the TrustQuote route-owner fix; you'll see it after restart.",
      'Planning the dashboard proof next once the restart gate clears.',
      'The route-owner fix is in progress; it is not visible yet.',
    ]) {
      expect(hasSurfaceCompletionClaim(content)).toBe(false);
      expect(detectSurfaceClaimGuardViolation({
        content,
        targetRole: 'telegram',
        targetRaw: 'telegram',
        senderRole: 'architect',
        recentUserRows: [],
        nowMs: NOW_MS,
      })).toBeNull();
    }
  });

  test('still blocks present-tense surface completion claims to James', () => {
    for (const content of [
      'The invoice is fixed and showing on your dashboard now.',
      'Done - visible in the TrustQuote pane.',
    ]) {
      expect(hasSurfaceCompletionClaim(content)).toBe(true);
      expect(detectSurfaceClaimGuardViolation({
        content,
        targetRole: 'telegram',
        targetRaw: 'telegram',
        senderRole: 'architect',
        recentUserRows: [],
        nowMs: NOW_MS,
      })).toMatchObject({
        violation_class: 'surface_done_claim_without_artifact',
      });
    }
  });

  test('does not let an unrelated existing PNG satisfy a visible claim', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-claim-'));
    const screenshotPath = path.join(tempDir, 'old-unrelated.png');
    fs.writeFileSync(screenshotPath, 'unrelated image');

    try {
      const content = `Done: visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`;
      expect(extractImagePaths(content)).toContain(screenshotPath);
      const violation = detectSurfaceClaimGuardViolation({
        content,
        targetRole: 'telegram',
        targetRaw: 'telegram',
        senderRole: 'architect',
        recentUserRows: [],
        nowMs: NOW_MS,
      });

      expect(violation).toMatchObject({
        violation_class: 'surface_done_claim_without_artifact',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('allows visible claims only with fresh visible-pane-submit provenance', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-claim-'));
    const screenshotPath = writeSurfaceArtifact(tempDir);

    try {
      const content = `Visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`;
      expect(validateSurfaceArtifact(screenshotPath, {
        nowMs: NOW_MS,
        content,
        captureEventVerifier: verifiedCaptureEvent,
      })).toEqual(expect.objectContaining({
        ok: true,
        provenancePath: path.join(tempDir, 'visible-pane-submit', 'trustquote-builder-run', 'manifest.json'),
      }));
      const violation = detectSurfaceClaimGuardViolation({
        content,
        targetRole: 'telegram',
        targetRaw: 'telegram',
        senderRole: 'architect',
        recentUserRows: [],
        nowMs: NOW_MS,
        captureEventVerifier: verifiedCaptureEvent,
      });

      expect(violation).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects fresh generic manifests that are not visible-pane-submit provenance', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-claim-'));
    const screenshotPath = writeGenericFreshArtifact(tempDir);

    try {
      expect(validateSurfaceArtifact(screenshotPath, { nowMs: NOW_MS })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'surface_manifest_untrusted_schema',
      }));
      const violation = detectSurfaceClaimGuardViolation({
        content: `Done: visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`,
        targetRole: 'telegram',
        targetRaw: 'telegram',
        senderRole: 'architect',
        recentUserRows: [],
        nowMs: NOW_MS,
      });

      expect(violation).toMatchObject({
        violation_class: 'surface_done_claim_without_artifact',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects hand-written visible-pane-submit manifests without an app-verified capture event', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-claim-'));
    const screenshotPath = writeSurfaceArtifact(tempDir);

    try {
      expect(validateSurfaceArtifact(screenshotPath, {
        nowMs: NOW_MS,
        content: `Done: visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`,
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'surface_capture_event_verifier_missing',
      }));
      expect(validateSurfaceArtifact(screenshotPath, {
        nowMs: NOW_MS,
        content: `Done: visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`,
        captureEventVerifier: () => ({ ok: false, reason: 'surface_capture_event_not_found' }),
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'surface_capture_event_not_found',
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects fresh wrong-window visible-pane-submit manifests for TrustQuote claims', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-claim-'));
    const screenshotPath = writeSurfaceArtifact(tempDir, {
      runId: 'main-builder-run',
      windowKey: 'main',
      paneId: '2',
      targetRole: 'builder',
    });

    try {
      const content = `Done: visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`;
      expect(validateSurfaceArtifact(screenshotPath, { nowMs: NOW_MS, content })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'surface_claim_window_mismatch',
        expectedWindowKey: 'trustquote',
      }));
      const violation = detectSurfaceClaimGuardViolation({
        content,
        targetRole: 'telegram',
        targetRaw: 'telegram',
        senderRole: 'architect',
        recentUserRows: [],
        nowMs: NOW_MS,
      });

      expect(violation).toMatchObject({
        violation_class: 'surface_done_claim_without_artifact',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects visible-pane-submit manifests that point back to a substitute capture path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-claim-'));
    const screenshotPath = writeSurfaceArtifact(tempDir, {
      captureReturnedPath: path.join(tempDir, 'emulator', 'capture.png'),
    });

    try {
      expect(validateSurfaceArtifact(screenshotPath, {
        nowMs: NOW_MS,
        content: `Done: visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`,
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'surface_capture_returned_path_forbidden',
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects visible-pane-submit manifests when requested capture target does not match the pane', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-claim-'));
    const screenshotPath = writeSurfaceArtifact(tempDir, {
      requestedWindowKey: 'main',
    });

    try {
      expect(validateSurfaceArtifact(screenshotPath, {
        nowMs: NOW_MS,
        content: `Done: visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`,
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'surface_capture_requested_window_mismatch',
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects stale provenance-bound surface artifact paths', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-claim-'));
    const screenshotPath = writeSurfaceArtifact(tempDir, {
      generatedAtMs: NOW_MS - (2 * 60 * 60 * 1000),
    });

    try {
      expect(validateSurfaceArtifact(screenshotPath, {
        nowMs: NOW_MS,
        content: 'Done: visible in the TrustQuote dashboard.',
        captureEventVerifier: verifiedCaptureEvent,
      })).toEqual(expect.objectContaining({
        ok: false,
        reason: 'surface_artifact_stale',
      }));
      const violation = detectSurfaceClaimGuardViolation({
        content: `Done: visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`,
        targetRole: 'telegram',
        targetRaw: 'telegram',
        senderRole: 'architect',
        recentUserRows: [],
        nowMs: NOW_MS,
      });

      expect(violation).toMatchObject({
        violation_class: 'surface_done_claim_without_artifact',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('blocks local or emulator substitutes framed as proof for real surfaces before work starts', () => {
    const violation = detectSurfaceClaimGuardViolation({
      content: "Use the local emulator dashboard screenshot as proof for James's real TrustQuote dashboard.",
      targetRole: 'builder',
      targetRaw: 'builder',
      senderRole: 'architect',
      recentUserRows: [],
    });

    expect(violation).toMatchObject({
      violation_class: 'substitute_as_surface_proof',
    });
  });

  test('does not block local checks that explicitly say the substitute will not count', () => {
    const violation = detectSurfaceClaimGuardViolation({
      content: "Run the local emulator check, but it is not proof and does not count for James's real dashboard.",
      targetRole: 'builder',
      targetRaw: 'builder',
      senderRole: 'architect',
      recentUserRows: [],
    });

    expect(violation).toBeNull();
  });

  test('does not block agent discussion of substitute-proof failures', () => {
    const violation = detectSurfaceClaimGuardViolation({
      content: 'The anti-substitute check false-positives on agents discussing substitutes: emulator plus production plus proof got blocked.',
      targetRole: 'builder',
      targetRaw: 'builder',
      senderRole: 'oracle',
      recentUserRows: [],
      nowMs: NOW_MS,
    });

    expect(violation).toBeNull();
  });
});
