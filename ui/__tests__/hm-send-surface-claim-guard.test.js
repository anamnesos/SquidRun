const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectSurfaceClaimGuardViolation,
  extractImagePaths,
  findLatestUserRepeat,
  hasSurfaceCompletionClaim,
} = require('../scripts/hm-send-surface-claim-guard');

function userRow(rawBody, offsetMs, id = 'row') {
  const nowMs = 1_780_000_000_000;
  return {
    messageId: id,
    senderRole: 'user',
    targetRole: 'architect',
    direction: 'inbound',
    brokeredAtMs: nowMs - offsetMs,
    rawBody,
  };
}

describe('hm-send surface claim guard', () => {
  test('detects repeated James points from recent inbound rows', () => {
    const repeat = findLatestUserRepeat([
      userRow('There is still nothing in my TrustQuote dashboard.', 0, 'latest'),
      userRow('There is nothing in my TrustQuote dashboard.', 60_000, 'previous'),
    ], {
      nowMs: 1_780_000_000_000,
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
      nowMs: 1_780_000_000_000,
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
      nowMs: 1_780_000_000_000,
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

  test('allows visible claims when the message carries an existing screenshot artifact path', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-claim-'));
    const screenshotPath = path.join(tempDir, 'proof screenshot.png');
    fs.writeFileSync(screenshotPath, 'not actually a png but path existence is the guard proof');

    try {
      const content = `Visible in the TrustQuote dashboard. Screenshot: "${screenshotPath}"`;
      expect(extractImagePaths(content)).toContain(screenshotPath);
      const violation = detectSurfaceClaimGuardViolation({
        content,
        targetRole: 'telegram',
        targetRaw: 'telegram',
        senderRole: 'architect',
        recentUserRows: [],
      });

      expect(violation).toBeNull();
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
});
