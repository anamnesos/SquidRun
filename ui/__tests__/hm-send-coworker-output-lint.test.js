'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectCoworkerLintViolation,
  appendCoworkerLintViolation,
  appendCoworkerLintBypass,
  summarizeCoworkerLintViolations,
  COWORKER_LINT_PATTERNS,
  ENVELOPE_PREFIX_PATTERN,
  _internals,
} = require('../scripts/hm-send-coworker-output-lint');

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coworker-lint-test-'));
  return dir;
}

function cleanupTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('hm-send coworker output lint v0 — architect canonical', () => {
  test('"Sorry about that" reply to "the build is broken again" FAILS the lint', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: 'Sorry about that — I let the regex slip through.',
    });
    expect(result).not.toBeNull();
    expect(result.violation_class).toBe('apology_preamble');
    expect(result.phrase.toLowerCase()).toMatch(/^sorry\b/);
  });

  test('action-statement reply PASSES the lint', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: 'Shipping the regex fix at bde31c8. Re-running the suite.',
    });
    expect(result).toBeNull();
  });

  test('technical-noun-led reply PASSES the lint', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: 'BRIEF_PRIMING_PATTERN was the culprit — TIER_A now wholesale-rejects it.',
    });
    expect(result).toBeNull();
  });

  test('direct-yes/no answer PASSES the lint', () => {
    expect(detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: 'Yes — verified at restart-364.',
    })).toBeNull();
    expect(detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: 'No. The friction-state machine threads through priorFrameState.',
    })).toBeNull();
  });
});

describe('hm-send coworker output lint v0 — BLOCK family', () => {
  const failures = [
    ['Sorry about the delay — restart pending.', 'apology_preamble'],
    ["I'm sorry, I missed that.", 'apology_preamble'],
    ['Apologies for the noise on the bus.', 'apology_preamble'],
    ['My bad on the truncated envelope.', 'apology_preamble'],
    ['My fault — landed the wrong commit.', 'apology_preamble'],
    ['I hear you on the scope creep.', 'feeling_ack_preamble'],
    ['I understand the constraint, here is the fix.', 'feeling_ack_preamble'],
    ['I get it, the rebase was painful.', 'feeling_ack_preamble'],
    ['Great point about the friction-state thread.', 'sycophancy_opener'],
    ["That's a great catch.", 'sycophancy_opener'],
    ["You're absolutely right about the gate.", 'sycophancy_opener'],
    ['Fair point on the bypass flag.', 'sycophancy_opener'],
    ["I'm working on it now.", 'status_preamble'],
    ['Let me start by reading the dispatch.', 'status_preamble'],
    ['On it. Will report back.', 'status_preamble'],
    ['Just to clarify — is this for restart-365?', 'status_preamble'],
    ['Sure, will ship that.', 'assistant_compliance_opener'],
    ['Of course — landing the patch.', 'assistant_compliance_opener'],
    ['Happy to take that on.', 'assistant_compliance_opener'],
    ['Absolutely, queuing it up.', 'assistant_compliance_opener'],
    ['I think maybe we could try splitting the pattern.', 'hedge_cascade'],
    ['Perhaps we could route via Plan A.', 'hedge_cascade'],
  ];

  test.each(failures)('blocks: %s -> %s', (content, expectedClass) => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content,
    });
    expect(result).not.toBeNull();
    expect(result.violation_class).toBe(expectedClass);
  });
});

describe('hm-send coworker output lint v0 — PRESERVE family', () => {
  const passes = [
    // Action statements
    'Shipped the brief-priming tier split at bde31c8.',
    'Rolled back to b3f7c76 — preflight ok.',
    'Killed PID 564080; eunbyeol tree preserved.',
    'Landing the gate now.',
    // Direct technical answers
    'PID 564080 was the offender.',
    'TIER_A_PATTERN catches it; TIER_B needs the marker.',
    'restart-364 stamped; verifier all_pass true.',
    'ARCH #60.3 done. Moving to #60.4.',
    // Clarifying questions (technical, no helpdesk shape)
    'Which scope is in play — friction or context-leak?',
    'Should the gate be hard-block or soft-warn by default?',
    // Pushback / disagreement (no apology, no sycophancy)
    'Disagree — the Tier-B detector should stay strict.',
    'Pushback: hard-block on first ship will mask real-world false positives.',
    // Neutral status without helpdesk preamble
    'Done. Pre-commit green.',
    'Verified end-to-end. Closing the lane.',
    'Commit bde31c8 lands the tier split with 358 fixtures green.',
  ];

  test.each(passes)('passes: %s', (content) => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content,
    });
    expect(result).toBeNull();
  });
});

describe('hm-send coworker output lint v0 — envelope prefix is stripped', () => {
  test('"(BUILDER -> ARCH #60): Sorry about that" still trips the gate', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: '(BUILDER -> ARCH #60): Sorry about that — fix incoming.',
    });
    expect(result).not.toBeNull();
    expect(result.violation_class).toBe('apology_preamble');
  });

  test('"(Oracle to Builder): I hear you" still trips the gate', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'oracle',
      targetRole: 'builder',
      content: '(Oracle to Builder): I hear you on the scope.',
    });
    expect(result).not.toBeNull();
    expect(result.violation_class).toBe('feeling_ack_preamble');
  });

  test('"(ARCH -> BUILDER):" with action content PASSES', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'architect',
      targetRole: 'builder',
      content: '(ARCH -> BUILDER): ARCH #60 dispatch landing now.',
    });
    expect(result).toBeNull();
  });

  test('envelope regex matches expected shapes', () => {
    expect(ENVELOPE_PREFIX_PATTERN.test('(BUILDER -> ARCH #60): hi')).toBe(true);
    expect(ENVELOPE_PREFIX_PATTERN.test('(Oracle to Builder): hi')).toBe(true);
    expect(ENVELOPE_PREFIX_PATTERN.test('(ARCH -> BUILDER): hi')).toBe(true);
    expect(ENVELOPE_PREFIX_PATTERN.test('not an envelope')).toBe(false);
  });
});

describe('hm-send coworker output lint v0 — scope guard', () => {
  test('skips when sender is not an enforced role', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'telegram',
      targetRole: 'architect',
      content: 'Sorry about that.',
    });
    expect(result).toBeNull();
  });

  test('skips when target is user', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'user',
      content: 'Sorry about that.',
    });
    expect(result).toBeNull();
  });

  test('skips when target is telegram', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'telegram',
      content: 'Sorry about that.',
    });
    expect(result).toBeNull();
  });

  test('skips when message starts with (PEER CALL-OUT):', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: '(PEER CALL-OUT): Sorry about that — peer-callout bypass.',
    });
    expect(result).toBeNull();
  });

  test('skips when message starts with (PERMISSION GUARD):', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: '(PERMISSION GUARD): Sorry about that — guard bypass.',
    });
    expect(result).toBeNull();
  });

  test('skips when message starts with (COWORKER LINT):', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: '(COWORKER LINT): Sorry about that — self-bypass for lint discussions.',
    });
    expect(result).toBeNull();
  });

  test('bypass flag short-circuits the gate', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: 'Sorry about that.',
      bypass: '1',
    });
    expect(result).toBeNull();
  });

  test('cli sender targeting architect still enforced', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'cli',
      targetRole: 'architect',
      content: 'Sorry about that.',
    });
    expect(result).not.toBeNull();
    expect(result.violation_class).toBe('apology_preamble');
  });
});

describe('hm-send coworker output lint v0 — first 50-char window', () => {
  test('violation deep in body (past char 50) does NOT trip the gate', () => {
    const padding = 'Shipped the brief-priming tier split at bde31c8.';
    // padding is >= 48 chars; "Sorry about that" appears AFTER the window.
    const content = `${padding} Sorry about that earlier oversight.`;
    expect(content.length).toBeGreaterThan(50);
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content,
    });
    expect(result).toBeNull();
  });

  test('exact-50-char boundary still catches opener-position match', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: 'Sorry — fix landing.',
    });
    expect(result).not.toBeNull();
    expect(result.violation_class).toBe('apology_preamble');
  });
});

describe('hm-send coworker output lint v0 — violation logging', () => {
  let tempDir;
  let logPath;

  beforeEach(() => {
    tempDir = makeTempDir();
    logPath = path.join(tempDir, 'coworker-lint-violations.jsonl');
  });

  afterEach(() => cleanupTempDir(tempDir));

  test('appendCoworkerLintViolation writes a JSONL row', () => {
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: 'Sorry about that.',
    });
    expect(result).not.toBeNull();
    const writeResult = appendCoworkerLintViolation(
      { ...result, messageId: 'test-msg-1' },
      { logPath }
    );
    expect(writeResult.ok).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const row = JSON.parse(lines[0]);
    expect(row.type).toBe('coworker_lint');
    expect(row.violation_class).toBe('apology_preamble');
    expect(row.senderRole).toBe('builder');
    expect(row.targetRole).toBe('architect');
    expect(row.messageId).toBe('test-msg-1');
    expect(row.enforcement_mode).toBe('soft_warn');
  });

  test('appendCoworkerLintBypass writes a JSONL row to bypass log', () => {
    const bypassPath = path.join(tempDir, 'coworker-lint-bypasses.jsonl');
    const result = detectCoworkerLintViolation({
      senderRole: 'builder',
      targetRole: 'architect',
      content: 'Sorry about that.',
    });
    appendCoworkerLintBypass(
      { ...result, messageId: 'test-bypass-1', bypassReason: 'env' },
      { logPath: bypassPath }
    );
    expect(fs.existsSync(bypassPath)).toBe(true);
    const row = JSON.parse(fs.readFileSync(bypassPath, 'utf8').trim());
    expect(row.type).toBe('coworker_lint_bypass');
    expect(row.bypassReason).toBe('env');
  });

  test('summarizeCoworkerLintViolations aggregates by role + class', () => {
    appendCoworkerLintViolation(
      { senderRole: 'builder', targetRole: 'architect', violation_class: 'apology_preamble', phrase: 'sorry', occurredAt: new Date().toISOString() },
      { logPath }
    );
    appendCoworkerLintViolation(
      { senderRole: 'builder', targetRole: 'oracle', violation_class: 'sycophancy_opener', phrase: 'great point', occurredAt: new Date().toISOString() },
      { logPath }
    );
    appendCoworkerLintViolation(
      { senderRole: 'oracle', targetRole: 'builder', violation_class: 'apology_preamble', phrase: 'apologies', occurredAt: new Date().toISOString() },
      { logPath }
    );
    const summary = summarizeCoworkerLintViolations({ logPath });
    expect(summary.total).toBe(3);
    expect(summary.countsByRole.builder).toBe(2);
    expect(summary.countsByRole.oracle).toBe(1);
    expect(summary.countsByClass.apology_preamble).toBe(2);
    expect(summary.countsByClass.sycophancy_opener).toBe(1);
  });
});

describe('hm-send coworker output lint v0 — internals', () => {
  test('stripEnvelopePrefix removes (BUILDER -> ARCH #60):', () => {
    expect(_internals.stripEnvelopePrefix('(BUILDER -> ARCH #60): hi')).toBe('hi');
  });

  test('stripEnvelopePrefix leaves non-envelope strings intact', () => {
    expect(_internals.stripEnvelopePrefix('Shipped the patch.')).toBe('Shipped the patch.');
  });

  test('firstWindow respects the 50-char limit', () => {
    const window = _internals.firstWindow('(BUILDER -> ARCH #60): Sorry about that — really long delay context follows here.');
    expect(window.length).toBeLessThanOrEqual(50);
    expect(window).toMatch(/^Sorry/);
  });

  test('COWORKER_LINT_PATTERNS list has six distinct classes', () => {
    const classes = COWORKER_LINT_PATTERNS.map((p) => p.id);
    expect(new Set(classes).size).toBe(classes.length);
    expect(classes).toEqual(expect.arrayContaining([
      'apology_preamble',
      'feeling_ack_preamble',
      'sycophancy_opener',
      'status_preamble',
      'assistant_compliance_opener',
      'hedge_cascade',
    ]));
  });
});
