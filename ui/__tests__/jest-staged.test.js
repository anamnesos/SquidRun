'use strict';

const {
  extractAddedTestNames,
  buildJestPlan,
} = require('../scripts/jest-staged');

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
          ? "+  test('builds an Eunbyeol-scoped prompt without trading state blocks', () => {"
          : ''
      )
    );

    expect(plan.targetedRuns).toEqual([
      expect.objectContaining({
        uiPath: '__tests__/startup-ai-briefing.test.js',
        testNames: ['builds an Eunbyeol-scoped prompt without trading state blocks'],
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
});
