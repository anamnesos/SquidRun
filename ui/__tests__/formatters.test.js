/**
 * Formatters Tests
 * Target: Full coverage of formatters.js
 */

const { formatDuration, formatTimeSince, formatShort, formatCompound, formatPrecise } = require('../modules/formatters');

describe('Formatters', () => {
  describe('formatShort', () => {
    test('formats seconds', () => {
      expect(formatShort(5000)).toBe('5s');
      expect(formatShort(0)).toBe('0s');
      expect(formatShort(59000)).toBe('59s');
    });

    test('formats minutes', () => {
      expect(formatShort(60000)).toBe('1m');
      expect(formatShort(300000)).toBe('5m');
      expect(formatShort(3540000)).toBe('59m');
    });

    test('formats hours', () => {
      expect(formatShort(3600000)).toBe('1h');
      expect(formatShort(7200000)).toBe('2h');
    });

    test('handles negative values', () => {
      expect(formatShort(-1000)).toBe('-');
    });
  });

  describe('formatCompound', () => {
    test('formats seconds only', () => {
      expect(formatCompound(5000)).toBe('5s');
      expect(formatCompound(0)).toBe('0s');
    });

    test('formats minutes and seconds', () => {
      expect(formatCompound(90000)).toBe('1m 30s');
      expect(formatCompound(60000)).toBe('1m 0s');
    });

    test('formats hours and minutes', () => {
      expect(formatCompound(3600000)).toBe('1h 0m');
      expect(formatCompound(5400000)).toBe('1h 30m');
    });
  });

  describe('formatPrecise', () => {
    test('formats milliseconds', () => {
      expect(formatPrecise(500)).toBe('500ms');
      expect(formatPrecise(0)).toBe('0ms');
      expect(formatPrecise(999)).toBe('999ms');
    });

    test('formats seconds with decimal', () => {
      expect(formatPrecise(1500)).toBe('1.5s');
      expect(formatPrecise(1000)).toBe('1.0s');
    });

    test('formats minutes with decimal', () => {
      expect(formatPrecise(90000)).toBe('1.5m');
      expect(formatPrecise(60000)).toBe('1.0m');
    });

    test('formats hours with decimal', () => {
      expect(formatPrecise(5400000)).toBe('1.5h');
      expect(formatPrecise(3600000)).toBe('1.0h');
    });
  });

  describe('formatDuration', () => {
    test('defaults to compound style', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
    });

    test('uses short style', () => {
      expect(formatDuration(90000, { style: 'short' })).toBe('1m');
    });

    test('uses compound style', () => {
      expect(formatDuration(90000, { style: 'compound' })).toBe('1m 30s');
    });

    test('uses precise style', () => {
      expect(formatDuration(90000, { style: 'precise' })).toBe('1.5m');
    });
  });

  describe('formatTimeSince', () => {
    test('returns dash for falsy timestamp', () => {
      expect(formatTimeSince(0)).toBe('-');
      expect(formatTimeSince(null)).toBe('-');
      expect(formatTimeSince(undefined)).toBe('-');
    });

    test('returns dash for future timestamp', () => {
      expect(formatTimeSince(Date.now() + 100000)).toBe('-');
    });

    test('formats elapsed time using short style', () => {
      const fiveMinAgo = Date.now() - 300000;
      expect(formatTimeSince(fiveMinAgo)).toBe('5m');
    });

    test('formats recent timestamp', () => {
      const tenSecAgo = Date.now() - 10000;
      expect(formatTimeSince(tenSecAgo)).toBe('10s');
    });
  });
});
