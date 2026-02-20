const hmPane = require('../scripts/hm-pane');

describe('hm-pane CLI helpers', () => {
  test('normalizeCommand handles aliases', () => {
    expect(hmPane.normalizeCommand('ctrl-c')).toBe('interrupt');
    expect(hmPane.normalizeCommand('kill')).toBe('interrupt');
    expect(hmPane.normalizeCommand('enter-pane')).toBe('enter');
    expect(hmPane.normalizeCommand('nudge-agent')).toBe('nudge');
  });

  test('toAction maps pane commands', () => {
    expect(hmPane.toAction('enter')).toBe('enter');
    expect(hmPane.toAction('interrupt')).toBe('interrupt');
    expect(hmPane.toAction('restart')).toBe('restart');
    expect(hmPane.toAction('nudge')).toBe('nudge');
  });

  test('buildPayload creates enter payload', () => {
    const payload = hmPane.buildPayload('enter', ['enter', '2'], new Map());
    expect(payload).toEqual({ paneId: '2' });
  });

  test('buildPayload creates nudge payload with optional message', () => {
    const payload = hmPane.buildPayload(
      'nudge',
      ['nudge', '3', 'Status?', 'Ping'],
      new Map()
    );
    expect(payload).toEqual({ paneId: '3', message: 'Status? Ping' });
  });

  test('buildPayload prefers --message over positional text', () => {
    const payload = hmPane.buildPayload(
      'nudge',
      ['nudge', '1', 'old'],
      new Map([['message', 'new']])
    );
    expect(payload).toEqual({ paneId: '1', message: 'new' });
  });

  test('buildPayload throws when paneId is missing', () => {
    expect(() => hmPane.buildPayload('enter', ['enter'], new Map())).toThrow('paneId is required');
  });
});
