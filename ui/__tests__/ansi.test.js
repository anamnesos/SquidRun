const { stripAnsi } = require('../modules/ansi');

describe('ansi helpers', () => {
  test('stripAnsi preserves leading trigger text after reset sequences', () => {
    expect(stripAnsi('\x1b[1;33m[TRIGGER]\x1b[0m Enforce max stale'))
      .toBe('[TRIGGER] Enforce max stale');
  });
});
