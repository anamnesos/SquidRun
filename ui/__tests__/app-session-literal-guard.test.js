'use strict';

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_ALLOWLIST,
  classifyAppSessionLiteralScope,
  evaluateAppSessionLiteralGuard,
  findAppSessionLiteralOccurrences,
} = require('../scripts/hm-app-session-literal-guard');

const repoRoot = path.resolve(__dirname, '../..');

function appSession(id, suffix = '') {
  return `app-session-${id}${suffix}`;
}

describe('app-session literal guard', () => {
  test('scopes only guard/watchdog/eval/fixture code', () => {
    expect(classifyAppSessionLiteralScope('ui/modules/main/system-protected-evals.js')).toBe('protected eval source');
    expect(classifyAppSessionLiteralScope('ui/__tests__/fixtures/mira-core-contract.json')).toBe('fixture path');
    expect(classifyAppSessionLiteralScope('ui/__tests__/hm-send-surface-claim-guard.test.js')).toBe('guard/watchdog/eval/fixture file');
    expect(classifyAppSessionLiteralScope('ui/__tests__/ordinary-runtime.test.js')).toBeNull();
  });

  test('detects plain, scoped, and suffixed app session literals without eating arrows', () => {
    const text = [
      `session=${appSession(111)}`,
      `scope=${appSession(112, ':trustquote')}`,
      `mismatch=${appSession(113, ':eunbyeol')}->${appSession(113)}`,
    ].join('\n');

    expect(findAppSessionLiteralOccurrences(text).map((item) => item.literal)).toEqual([
      appSession(111),
      appSession(112, ':trustquote'),
      appSession(113, ':eunbyeol'),
      appSession(113),
    ]);
  });

  test('fails on a planted hard-coded app session literal in guard code', () => {
    const planted = appSession(777);
    const report = evaluateAppSessionLiteralGuard({
      files: [
        {
          path: 'ui/scripts/planted-route-guard.js',
          text: `const pinnedSessionId = '${planted}';\n`,
        },
      ],
      allowlist: [],
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      expect.objectContaining({
        type: 'unallowlisted_app_session_literal',
        path: 'ui/scripts/planted-route-guard.js',
        literal: planted,
      }),
    ]);
  });

  test('passes an allowlisted historical fixture only with an exact count and reason', () => {
    const historical = appSession(778, ':trustquote');
    const report = evaluateAppSessionLiteralGuard({
      files: [
        {
          path: 'ui/__tests__/fixtures/historical-route-sample.json',
          text: JSON.stringify({ sessionId: historical }, null, 2),
        },
      ],
      allowlist: [
        {
          path: 'ui/__tests__/fixtures/historical-route-sample.json',
          literal: historical,
          count: 1,
          reason: 'Historical route fixture sample for guard coverage only.',
        },
      ],
    });

    expect(report.ok).toBe(true);
    expect(report.allowlisted).toEqual([
      expect.objectContaining({
        path: 'ui/__tests__/fixtures/historical-route-sample.json',
        literal: historical,
        count: 1,
      }),
    ]);
  });

  test('fails allowlisted fixture samples when the count changes', () => {
    const historical = appSession(779);
    const report = evaluateAppSessionLiteralGuard({
      files: [
        {
          path: 'ui/__tests__/fixtures/historical-route-sample.json',
          text: `${historical}\n${historical}\n`,
        },
      ],
      allowlist: [
        {
          path: 'ui/__tests__/fixtures/historical-route-sample.json',
          literal: historical,
          count: 1,
          reason: 'Historical route fixture sample for guard coverage only.',
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      expect.objectContaining({
        type: 'allowlist_count_mismatch',
        expectedCount: 1,
        actualCount: 2,
      }),
    ]);
  });

  test('fails allowlist entries without a useful reason', () => {
    const historical = appSession(780);
    const report = evaluateAppSessionLiteralGuard({
      files: [
        {
          path: 'ui/__tests__/fixtures/historical-route-sample.json',
          text: historical,
        },
      ],
      allowlist: [
        {
          path: 'ui/__tests__/fixtures/historical-route-sample.json',
          literal: historical,
          count: 1,
          reason: 'old',
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      expect.objectContaining({
        type: 'invalid_allowlist_entry',
        reasonCode: 'missing_or_weak_reason',
      }),
      expect.objectContaining({
        type: 'unallowlisted_app_session_literal',
      }),
    ]);
  });

  test('current repo scan contains only exact documented historical samples', () => {
    const report = evaluateAppSessionLiteralGuard({
      root: repoRoot,
      allowlist: DEFAULT_ALLOWLIST,
    });

    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.scannedFiles).toBeGreaterThan(0);
    expect(report.allowlisted.length).toBe(DEFAULT_ALLOWLIST.length);
  });

  test('pre-commit hook runs the literal guard fail-closed', () => {
    const hookText = fs.readFileSync(path.join(repoRoot, 'scripts/pre-commit.sh'), 'utf8');

    expect(hookText).toContain('node ui/scripts/hm-app-session-literal-guard.js');
    expect(hookText).toContain('app session literal guard cannot be skipped');
    expect(hookText).toContain('FAILED=1');
  });

  test('pre-commit JavaScript gates use package entrypoints and fail closed when tooling is missing', () => {
    const hookText = fs.readFileSync(path.join(repoRoot, 'scripts/pre-commit.sh'), 'utf8');
    const installedHookPath = path.join(repoRoot, '.git/hooks/pre-commit');
    const hookTexts = [hookText];

    if (fs.existsSync(installedHookPath)) {
      hookTexts.push(fs.readFileSync(installedHookPath, 'utf8'));
    }

    for (const text of hookTexts) {
      expect(text).toContain('ui/node_modules/eslint/bin/eslint.js');
      expect(text).toContain('node ./node_modules/eslint/bin/eslint.js "**/*.js" --quiet');
      expect(text).toContain('ui/node_modules/jest/bin/jest.js');
      expect(text).toContain('node ui/scripts/jest-staged.js');
      expect(text).toContain('ESLint entrypoint missing; JavaScript lint gate cannot run');
      expect(text).toContain('Jest entrypoint missing; unit-test gate cannot run');
      expect(text).not.toContain('ui/node_modules/.bin/eslint');
      expect(text).not.toContain('ui/node_modules/.bin/jest');
      expect(text).not.toContain('skipping JavaScript lint');
      expect(text).not.toContain('skipping unit tests');
    }
  });
});
