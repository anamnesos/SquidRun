const { normalizeCommand } = require('../scripts/hm-app');

describe('hm-app CLI command normalization', () => {
  test('routes Squid Room aliases to the display-only opener', () => {
    expect(normalizeCommand('squid-room')).toBe('open-squid-room');
    expect(normalizeCommand('open-squid-room')).toBe('open-squid-room');
    expect(normalizeCommand('squid-room-open')).toBe('open-squid-room');
  });

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
