const hmBg = require('../scripts/hm-bg');

describe('hm-bg CLI helpers', () => {
  test('normalizeCommand handles aliases', () => {
    expect(hmBg.normalizeCommand('status')).toBe('list');
    expect(hmBg.normalizeCommand('ps')).toBe('list');
    expect(hmBg.normalizeCommand('stop')).toBe('kill');
    expect(hmBg.normalizeCommand('killall')).toBe('kill-all');
    expect(hmBg.normalizeCommand('target-map')).toBe('map');
  });

  test('toAction maps background commands', () => {
    expect(hmBg.toAction('spawn')).toBe('spawn');
    expect(hmBg.toAction('list')).toBe('list');
    expect(hmBg.toAction('kill')).toBe('kill');
    expect(hmBg.toAction('kill-all')).toBe('kill-all');
    expect(hmBg.toAction('map')).toBe('target-map');
  });

  test('normalizeTarget maps numeric slot to builder alias', () => {
    expect(hmBg.normalizeTarget('1')).toBe('builder-bg-1');
    expect(hmBg.normalizeTarget('builder-bg-2')).toBe('builder-bg-2');
    expect(hmBg.normalizeTarget('bg-2-3')).toBe('bg-2-3');
  });

  test('buildPayload creates spawn payload from --slot', () => {
    const payload = hmBg.buildPayload(
      'spawn',
      ['spawn'],
      new Map([['slot', '2']])
    );
    expect(payload).toEqual({ slot: 2 });
  });

  test('buildPayload normalizes spawn alias from synthetic pane id', () => {
    const payload = hmBg.buildPayload(
      'spawn',
      ['spawn', 'bg-2-3'],
      new Map()
    );
    expect(payload).toEqual({ alias: 'builder-bg-3' });
  });

  test('buildPayload creates kill payload from positional target', () => {
    const payload = hmBg.buildPayload(
      'kill',
      ['kill', '1'],
      new Map()
    );
    expect(payload).toEqual({ target: 'builder-bg-1' });
  });

  test('buildPayload throws when kill target is missing', () => {
    expect(() => hmBg.buildPayload('kill', ['kill'], new Map())).toThrow('target is required');
  });
});
