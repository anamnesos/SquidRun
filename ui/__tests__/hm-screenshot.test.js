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
});
