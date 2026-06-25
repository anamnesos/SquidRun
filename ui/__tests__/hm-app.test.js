const { normalizeCommand } = require('../scripts/hm-app');

describe('hm-app CLI command normalization', () => {
  test('routes Squid Room aliases to the surface opener', () => {
    expect(normalizeCommand('squid-room')).toBe('open-squid-room');
    expect(normalizeCommand('open-squid-room')).toBe('open-squid-room');
    expect(normalizeCommand('squid-room-open')).toBe('open-squid-room');
  });

  test('routes Today feed aliases to the timeline side window opener', () => {
    expect(normalizeCommand('human-timeline-sidecar')).toBe('open-human-timeline-sidecar');
    expect(normalizeCommand('timeline')).toBe('open-human-timeline-sidecar');
    expect(normalizeCommand('today-feed')).toBe('open-human-timeline-sidecar');
    expect(normalizeCommand('open-today-feed')).toBe('open-human-timeline-sidecar');
  });

  test('routes generic close aliases to close-app-window', () => {
    expect(normalizeCommand('close-window')).toBe('close-app-window');
    expect(normalizeCommand('window-close')).toBe('close-app-window');
    expect(normalizeCommand('close-app-window')).toBe('close-app-window');
  });
});
