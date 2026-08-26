const { normalizeCommand } = require('../scripts/hm-app');

describe('hm-app CLI command normalization', () => {
  test('routes Squid Room aliases to the surface opener', () => {
    expect(normalizeCommand('squid-room')).toBe('open-squid-room');
    expect(normalizeCommand('open-squid-room')).toBe('open-squid-room');
    expect(normalizeCommand('squid-room-open')).toBe('open-squid-room');
  });

  test('routes generic close aliases to close-app-window', () => {
    expect(normalizeCommand('close-window')).toBe('close-app-window');
    expect(normalizeCommand('window-close')).toBe('close-app-window');
    expect(normalizeCommand('close-app-window')).toBe('close-app-window');
  });

  test('keeps Telegram poller restart aliases separate from renderer reload aliases', () => {
    expect(normalizeCommand('restart-telegram')).toBe('restart-telegram-poller');
    expect(normalizeCommand('reload-telegram-poller')).toBe('restart-telegram-poller');
    expect(normalizeCommand('restart-telegram-poller')).toBe('restart-telegram-poller');
    expect(normalizeCommand('reload')).toBe('reload-renderers');
    expect(normalizeCommand('reload-renderer')).toBe('reload-renderers');
    expect(normalizeCommand('reload-renderers')).toBe('reload-renderers');
  });
});
