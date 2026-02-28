jest.mock('../scripts/hm-telegram', () => ({
  sendTelegramPhoto: jest.fn(async () => ({ ok: true })),
}));

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
  });

  test('collectRunOptions rejects missing require-text value', () => {
    const { options } = smokeRunner.parseArgs(['run', '--require-text']);
    expect(() => smokeRunner.collectRunOptions(options)).toThrow('--require-text expects a text value');
  });
});
