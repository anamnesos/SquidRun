const {
  buildHistoryQuery,
  parseArgs,
} = require('../scripts/hm-comms');

describe('hm-comms CLI parsing', () => {
  test('--limit is a real alias for history row count', () => {
    const { positional, options } = parseArgs(['history', '--limit', '3', '--json']);
    expect(positional).toEqual(['history']);
    expect(options.get('limit')).toBe('3');
    expect(options.get('json')).toBe(true);

    const query = buildHistoryQuery(options);
    expect(query.limit).toBe(3);
    expect(query.params.at(-1)).toBe(30);
  });

  test('--last still controls history row count when --limit is absent', () => {
    const { options } = parseArgs(['history', '--last', '7']);
    const query = buildHistoryQuery(options);
    expect(query.limit).toBe(7);
    expect(query.params.at(-1)).toBe(70);
  });

  test('unknown options fail closed instead of widening the query silently', () => {
    expect(() => parseArgs(['history', '--limt', '3'])).toThrow('unknown_option: --limt');
  });

  test('value options fail closed when their value is missing', () => {
    expect(() => parseArgs(['history', '--limit'])).toThrow('--limit requires a value');
    expect(() => parseArgs(['history', '--session', '--json'])).toThrow('--session requires a value');
  });
});
