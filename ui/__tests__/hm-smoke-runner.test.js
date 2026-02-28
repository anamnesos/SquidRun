jest.mock('../scripts/hm-telegram', () => ({
  sendTelegramPhoto: jest.fn(async () => ({ ok: true })),
}));
const path = require('path');

jest.mock('../scripts/hm-visual-utils', () => ({
  asString: (value, fallback = '') => {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  },
  asPositiveInt: (value, fallback = 0) => {
    const numeric = Number.parseInt(String(value), 10);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return numeric;
  },
  ensureDir: jest.fn(),
  resolveProjectPath: ({ projectPath } = {}) => projectPath || 'D:\\projects\\squidrun',
  resolveVisualRuntimeRoot: ({ projectPath } = {}) => `${projectPath || 'D:\\projects\\squidrun'}\\.squidrun`,
  resolveReadyVisualUrl: jest.fn(async () => ({ ok: false, reason: 'not-used-in-unit-test', checks: [] })),
  writeCachedVisualUrl: jest.fn(() => ({ ok: true })),
  buildVisualRunId: jest.fn(() => 'smoke-run-id'),
}));

const smokeRunner = require('../scripts/hm-smoke-runner');

describe('hm-smoke-runner option parsing', () => {
  test('collectRunOptions applies P2 defaults', () => {
    const { options } = smokeRunner.parseArgs([
      'run',
      '--project-path', 'D:\\projects\\squidrun',
    ]);

    const result = smokeRunner.collectRunOptions(options);
    expect(result.collectA11y).toBe(true);
    expect(result.validateLinks).toBe(true);
    expect(result.maxLinks).toBe(25);
    expect(result.axeMaxViolations).toBe(0);
    expect(result.maxBrokenLinks).toBe(0);
    expect(result.enableVisualDiff).toBe(true);
    expect(result.maxDiffPixels).toBe(-1);
    expect(result.diffThreshold).toBe(0.1);
    expect(result.updateBaselineOnPass).toBe(true);
    expect(result.updateBaselineAlways).toBe(false);
    expect(result.generateSpec).toBe(true);
    expect(result.specDir).toBe('');
    expect(result.specOut).toBe('');
    expect(result.specName).toBe('');
    expect(result.requireTexts).toEqual([]);
  });

  test('collectRunOptions honors explicit P2 flags and aliases', () => {
    const { options } = smokeRunner.parseArgs([
      'run',
      '--target-url', 'http://localhost:3000',
      '--timeout-ms', '42000',
      '--require-text', 'Dashboard',
      '--require-text', 'Signed in',
      '--no-axe',
      '--no-validate-links',
      '--include-external-links',
      '--content-case-sensitive',
      '--max-links', '7',
      '--max-broken-links', '2',
      '--axe-max-violations', '3',
      '--min-body-text-chars', '150',
      '--link-timeout-ms', '2300',
      '--max-diff-pixels', '500',
      '--diff-threshold', '0.33',
      '--no-diff',
      '--no-update-baseline',
      '--update-baseline-always',
      '--baseline-key', 'login-home',
      '--no-generate-spec',
      '--spec-dir', 'D:\\specs',
      '--spec-out', 'D:\\specs\\custom.spec.ts',
      '--spec-name', 'assistive-login',
    ]);

    const result = smokeRunner.collectRunOptions(options);
    expect(result.explicitUrl).toBe('http://localhost:3000');
    expect(result.timeoutMs).toBe(42000);
    expect(result.requireTexts).toEqual(['Dashboard', 'Signed in']);
    expect(result.collectA11y).toBe(false);
    expect(result.validateLinks).toBe(false);
    expect(result.includeExternalLinks).toBe(true);
    expect(result.contentCaseSensitive).toBe(true);
    expect(result.maxLinks).toBe(7);
    expect(result.maxBrokenLinks).toBe(2);
    expect(result.axeMaxViolations).toBe(3);
    expect(result.minBodyTextChars).toBe(150);
    expect(result.linkTimeoutMs).toBe(2300);
    expect(result.maxDiffPixels).toBe(500);
    expect(result.diffThreshold).toBe(0.33);
    expect(result.enableVisualDiff).toBe(false);
    expect(result.updateBaselineOnPass).toBe(false);
    expect(result.updateBaselineAlways).toBe(true);
    expect(result.baselineKey).toBe('login-home');
    expect(result.generateSpec).toBe(false);
    expect(result.specDir).toBe('D:\\specs');
    expect(result.specOut).toBe('D:\\specs\\custom.spec.ts');
    expect(result.specName).toBe('assistive-login');
  });

  test('collectRunOptions rejects missing require-text value', () => {
    const { options } = smokeRunner.parseArgs(['run', '--require-text']);
    expect(() => smokeRunner.collectRunOptions(options)).toThrow('--require-text expects a text value');
  });

  test('buildDiffBaselineKey is deterministic for same route/url', () => {
    const options = {
      projectPath: 'D:\\projects\\squidrun',
      route: '/dashboard',
    };
    const first = smokeRunner.buildDiffBaselineKey(options, 'http://127.0.0.1:3000/dashboard');
    const second = smokeRunner.buildDiffBaselineKey(options, 'http://127.0.0.1:3000/dashboard');
    expect(first).toBe(second);
    expect(first).toContain('squidrun');
  });

  test('buildFailureExplanation includes failure codes and artifact lines', () => {
    const summary = {
      runId: 'run-1',
      url: 'http://localhost:3000',
      tracePath: 'trace.zip',
      screenshotPath: 'screenshot.png',
      hardFailureCount: 1,
      hardFailures: [
        { code: 'visual_diff_exceeded', message: 'Diff too high' },
      ],
    };
    const output = smokeRunner.buildFailureExplanation(summary, {});
    expect(output).toContain('visual_diff_exceeded');
    expect(output).toContain('trace.zip');
  });

  test('buildAssistivePlaywrightSpecDraft includes human review note and selectors', () => {
    const draft = smokeRunner.buildAssistivePlaywrightSpecDraft({
      summary: {
        runId: 'run-7',
        url: 'http://127.0.0.1:3000/dashboard',
        route: '/dashboard',
        title: 'Dashboard',
        tracePath: 'trace.zip',
      },
      diagnostics: {
        selectorChecks: [{ selector: '#app', ok: true }],
        textChecks: [{ text: 'Welcome', ok: true }],
      },
      options: {},
    });
    expect(draft).toContain('HUMAN REVIEW REQUIRED');
    expect(draft).toContain('await page.goto("http://127.0.0.1:3000/dashboard")');
    expect(draft).toContain("#app");
    expect(draft).toContain('Welcome');
  });

  test('buildSpecGenerationPaths honors explicit output', () => {
    const explicitSpecOut = 'D:\\tmp\\generated.spec.ts';
    const paths = smokeRunner.buildSpecGenerationPaths(
      { runtimeRoot: 'D:\\projects\\squidrun\\.squidrun', specOut: explicitSpecOut },
      { route: '/dashboard', url: 'http://127.0.0.1:3000/dashboard' },
    );
    const expectedSpecPath = process.platform === 'win32'
      ? explicitSpecOut
      : path.resolve(explicitSpecOut);
    expect(paths.specPath).toBe(expectedSpecPath);
    expect(paths.specMetaPath).toBe(`${expectedSpecPath}.meta.json`);
    expect(path.isAbsolute(paths.specPath)).toBe(true);
  });
});
