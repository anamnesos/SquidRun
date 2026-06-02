const { normalizeCommand } = require('../scripts/hm-app');

describe('hm-app CLI command normalization', () => {
  test('routes TrustQuote close aliases to the safe close action', () => {
    expect(normalizeCommand('close-trustquote')).toBe('close-trustquote-workspace');
    expect(normalizeCommand('trustquote-close')).toBe('close-trustquote-workspace');
    expect(normalizeCommand('close-trustquote-window')).toBe('close-trustquote-workspace');
  });

  test('routes generic close aliases to close-app-window', () => {
    expect(normalizeCommand('close-window')).toBe('close-app-window');
    expect(normalizeCommand('window-close')).toBe('close-app-window');
    expect(normalizeCommand('close-app-window')).toBe('close-app-window');
  });
});
