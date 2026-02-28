const {
  shouldTriggerAutonomousSmoke,
  buildSmokeRunnerArgs,
  formatSmokeResultMessage,
} = require('../modules/main/autonomous-smoke');

describe('autonomous-smoke helpers', () => {
  describe('shouldTriggerAutonomousSmoke', () => {
    test('triggers for [SMOKE] tag from builder', () => {
      const result = shouldTriggerAutonomousSmoke({
        senderRole: 'builder',
        messageContent: 'P1 complete [SMOKE]',
      });

      expect(result).toEqual({ trigger: true, reason: 'smoke_tag' });
    });

    test('triggers for completion phrase from builder background role', () => {
      const result = shouldTriggerAutonomousSmoke({
        senderRole: 'builder-bg-2',
        messageContent: 'Changes are ready for review',
      });

      expect(result).toEqual({ trigger: true, reason: 'builder_ready_for_review' });
    });

    test('does not trigger for unauthorized sender', () => {
      const result = shouldTriggerAutonomousSmoke({
        senderRole: 'oracle',
        messageContent: '[VISUAL] done',
      });

      expect(result).toEqual({ trigger: false, reason: 'sender_not_allowed' });
    });

    test('does not trigger for builder without signal', () => {
      const result = shouldTriggerAutonomousSmoke({
        senderRole: 'builder',
        messageContent: 'still implementing task',
      });

      expect(result).toEqual({ trigger: false, reason: null });
    });
  });

  describe('buildSmokeRunnerArgs', () => {
    test('builds ordered args from mixed options', () => {
      const args = buildSmokeRunnerArgs({
        senderRole: 'builder-bg-1',
        triggerReason: 'smoke_tag',
        messageContent: '[SMOKE] done',
        runId: 'run-42',
        sessionId: '201',
        projectPath: 'D:\\projects\\squidrun',
        targetUrl: 'http://localhost:3000',
        timeoutMs: 45000,
        maxFailures: 2,
        visual: true,
        headless: false,
        dryRun: true,
        tags: ['p1', 'autonomous smoke'],
        extraArgs: ['--verbose', '  ', null],
      });

      expect(args).toEqual([
        '--sender-role', 'builder-bg-1',
        '--trigger-reason', 'smoke_tag',
        '--message', '[SMOKE] done',
        '--run-id', 'run-42',
        '--session-id', '201',
        '--project-path', 'D:\\projects\\squidrun',
        '--target-url', 'http://localhost:3000',
        '--timeout-ms', '45000',
        '--max-failures', '2',
        '--visual',
        '--headed',
        '--dry-run',
        '--tag', 'p1',
        '--tag', 'autonomous_smoke',
        '--verbose',
      ]);
    });

    test('returns empty args for empty options', () => {
      expect(buildSmokeRunnerArgs()).toEqual([]);
      expect(buildSmokeRunnerArgs({ timeoutMs: -10, extraArgs: ['   '] })).toEqual([]);
    });
  });

  describe('formatSmokeResultMessage', () => {
    test('formats pass result with counts', () => {
      const msg = formatSmokeResultMessage(
        { success: true, passed: 4, failed: 0, skipped: 1, total: 5 },
        { senderRole: 'builder', triggerReason: 'smoke_tag', runId: 'run-42' },
      );

      expect(msg).toContain('[AUTONOMOUS_SMOKE] PASS');
      expect(msg).toContain('pass=4');
      expect(msg).toContain('fail=0');
      expect(msg).toContain('skip=1');
      expect(msg).toContain('total=5');
    });

    test('formats fail result from nested stats and derives total', () => {
      const msg = formatSmokeResultMessage(
        { stats: { passed: 2, failed: 1, skipped: 0 } },
        { senderRole: 'builder-bg-3', reason: 'builder_ready_for_review' },
      );

      expect(msg).toContain('[AUTONOMOUS_SMOKE] FAIL');
      expect(msg).toContain('pass=2');
      expect(msg).toContain('fail=1');
      expect(msg).toContain('skip=0');
      expect(msg).toContain('total=3');
    });
  });
});
