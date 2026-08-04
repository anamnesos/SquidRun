'use strict';

const {
  extractAddedTestNames,
  buildJestPlan,
  buildTargetedJestArgs,
} = require('../scripts/jest-staged');

describe('jest-staged: one deterministic run, and failures that say why', () => {
  const { exitOnFailure } = require('../scripts/jest-staged');

  test('seven staged test files, including a new one, become ONE run of all seven', () => {
    // THE EXACT SHAPE THAT BROKE THE GATE. Six modified test files yield no
    // extracted names and one NEW file yields many, which is what sent the old
    // per-file loop down seven separate Jest processes. Everything is in one
    // process now, and every staged path is in it.
    const staged = [
      'ui/__tests__/squidrun-app.test.js',
      'ui/__tests__/telegram-drain-ordering-integrity.test.js',
      'ui/__tests__/telegram-ingress-ack.test.js',
      'ui/__tests__/telegram-ingress-drain.test.js',
      'ui/__tests__/telegram-orphan-health-reporting.test.js',
      'ui/__tests__/telegram-recover-inbound.test.js',
      'ui/__tests__/telegram-source-protocol.test.js',
      'ui/modules/main/telegram-source-protocol.js',
    ];
    const plan = buildJestPlan(staged, (filePath) => (
      filePath.endsWith('telegram-source-protocol.test.js')
        ? "+  test('a live-shaped legacy record hashes to its exact pre-change digest', () => {\n"
          + "+  test('a producer that cannot name itself APPENDS NOTHING', () => {\n"
        : ''
    ));

    expect(plan.testPaths).toEqual([
      '__tests__/squidrun-app.test.js',
      '__tests__/telegram-drain-ordering-integrity.test.js',
      '__tests__/telegram-ingress-ack.test.js',
      '__tests__/telegram-ingress-drain.test.js',
      '__tests__/telegram-orphan-health-reporting.test.js',
      '__tests__/telegram-recover-inbound.test.js',
      '__tests__/telegram-source-protocol.test.js',
    ]);
    // THE LAST FILE IS NOT LAST-AND-OPTIONAL ANY MORE. Under the old loop a
    // non-zero status from an EARLIER suite stopped the loop and this file was
    // simply never run - which read as the final file failing silently.
    expect(plan.testPaths).toContain('__tests__/telegram-source-protocol.test.js');
    // Staged test files still suppress the related-test fanout.
    expect(plan.relatedFiles).toEqual([]);
    expect(plan.hasWork).toBe(true);
  });

  test('coverage is not narrowed by a name filter any more', () => {
    // The old behaviour ran ONLY the newly added tests in a file whose names
    // could be extracted, so adding a test could run less of a file than
    // touching a comment in it would. testPaths carries no pattern at all.
    const plan = buildJestPlan(
      ['ui/__tests__/telegram-source-protocol.test.js'],
      () => "+  test('only this one was added', () => {\n"
    );
    expect(plan.testPaths).toEqual(['__tests__/telegram-source-protocol.test.js']);
    // The extracted names are still available for reporting; they just no
    // longer decide what runs.
    expect(plan.targetedRuns[0].testNames).toEqual(['only this one was added']);
  });

  test('a failure surfaces status, signal and spawn error, and never retries', () => {
    const written = [];
    const exits = [];
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => { exits.push(code); });

    try {
      // A SPAWN THAT NEVER STARTED: status null plus an error. This became a
      // bare `exit 1` with no output, which is exactly how a tool defect gets
      // mistaken for a broken change.
      exitOnFailure({ status: null, signal: null, error: new Error('spawn ENOENT') }, 'unit');
      const nullReport = written.join('');
      expect(nullReport).toContain('status=null');
      expect(nullReport).toContain('spawnError=spawn ENOENT');
      expect(nullReport).toContain('never produced an exit code');
      expect(exits).toEqual([1]);

      written.length = 0;
      exits.length = 0;
      exitOnFailure({ status: 2, signal: 'SIGKILL', error: null }, 'unit');
      const killedReport = written.join('');
      expect(killedReport).toContain('status=2');
      expect(killedReport).toContain('signal=SIGKILL');
      // The real status is preserved rather than flattened to 1.
      expect(exits).toEqual([2]);

      // A pass writes nothing and exits nothing. No retry anywhere.
      written.length = 0;
      exits.length = 0;
      exitOnFailure({ status: 0 }, 'unit');
      expect(written).toEqual([]);
      expect(exits).toEqual([]);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe('jest-staged helper', () => {
  test('extracts added Jest test names from staged diff text', () => {
    const diffText = [
      '@@ -10,0 +11,8 @@',
      "+  test('runs only the staged test', () => {",
      '+    expect(true).toBe(true);',
      '+  });',
      '+',
      '+  it("supports it aliases too", () => {',
      '+    expect(true).toBe(true);',
      '+  });',
    ].join('\n');

    expect(extractAddedTestNames(diffText)).toEqual([
      'runs only the staged test',
      'supports it aliases too',
    ]);
  });

  test('prefers staged test-file runs over related-test fanout when tests are staged', () => {
    const plan = buildJestPlan(
      [
        'ui/modules/startup-ai-briefing.js',
        'ui/__tests__/startup-ai-briefing.test.js',
      ],
      (filePath) => (
        filePath.endsWith('startup-ai-briefing.test.js')
          ? "+  test('builds a scoped prompt without private state blocks', () => {"
          : ''
      )
    );

    expect(plan.targetedRuns).toEqual([
      expect.objectContaining({
        uiPath: '__tests__/startup-ai-briefing.test.js',
        testNames: ['builds a scoped prompt without private state blocks'],
      }),
    ]);
    expect(plan.relatedFiles).toEqual([]);
  });

  test('recognizes script-level test files moved into Jest roots', () => {
    const plan = buildJestPlan(
      [
        'ui/scripts/hm-restart-execute.js',
        'ui/__tests__/hm-restart-execute.test.js',
      ],
      (filePath) => (
        filePath.endsWith('hm-restart-execute.test.js')
          ? "+  test('requires a fresh green preflight before touching processes', async () => {"
          : ''
      )
    );

    expect(plan.targetedRuns).toEqual([
      expect.objectContaining({
        uiPath: '__tests__/hm-restart-execute.test.js',
        testNames: ['requires a fresh green preflight before touching processes'],
      }),
    ]);
    expect(plan.relatedFiles).toEqual([]);
  });

  test('falls back to related tests when only source files are staged', () => {
    const plan = buildJestPlan(
      [
        'ui/profile.js',
        'ui/config.js',
      ],
      () => ''
    );

    expect(plan.targetedRuns).toEqual([]);
    expect(plan.relatedFiles).toEqual(['profile.js', 'config.js']);
  });

  test('ignores non-ui JavaScript files for Jest targeting', () => {
    const plan = buildJestPlan(
      [
        '.geminiignore',
        'tools/inject-evidence-images.js',
      ],
      () => ''
    );

    expect(plan.hasWork).toBe(false);
    expect(plan.relatedFiles).toEqual([]);
    expect(plan.targetedRuns).toEqual([]);
  });

  test('passes option-looking test names as a single Jest pattern argument', () => {
    const args = buildTargetedJestArgs({
      uiPath: '__tests__/hm-comms.test.js',
      testNames: ['--limit is a real alias for history row count'],
    });

    expect(args).toEqual([
      '--runTestsByPath',
      '__tests__/hm-comms.test.js',
      '--testNamePattern=--limit is a real alias for history row count',
    ]);
  });
});
