const hmScreenshot = require('../scripts/hm-screenshot');

describe('hm-screenshot CLI helpers', () => {
  test('normalizeCommand handles alias', () => {
    expect(hmScreenshot.normalizeCommand('shot')).toBe('capture');
    expect(hmScreenshot.normalizeCommand('capture')).toBe('capture');
  });

  test('buildPayload creates capture payload without pane', () => {
    expect(hmScreenshot.buildPayload('capture', new Map())).toEqual({});
  });

  test('buildPayload creates capture payload with pane filter', () => {
    expect(
      hmScreenshot.buildPayload('capture', new Map([['pane', '2']]))
    ).toEqual({ paneId: '2' });
  });

  test('buildPayload includes visible-proof run id', () => {
    expect(
      hmScreenshot.buildPayload('capture', new Map([['window-key', 'squid-room'], ['pane', 'trustquote-app'], ['run-id', 'run-1']]))
    ).toEqual({ windowKey: 'squid-room', paneId: 'trustquote-app', runId: 'run-1' });
  });
});
