/**
 * Token Utils Tests
 * Target: Full coverage of token-utils.js
 */

const { estimateTokens, truncateToTokenBudget, truncateContent } = require('../modules/token-utils');

describe('Token Utils', () => {
  describe('estimateTokens', () => {
    test('returns 0 for empty/null input', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens(null)).toBe(0);
      expect(estimateTokens(undefined)).toBe(0);
    });

    test('estimates tokens for short text', () => {
      const result = estimateTokens('hello world');
      expect(result).toBeGreaterThan(0);
      expect(typeof result).toBe('number');
    });

    test('estimates tokens by word count', () => {
      // 10 words * 1.3 = 13 tokens by words
      const text = 'one two three four five six seven eight nine ten';
      const result = estimateTokens(text);
      expect(result).toBeGreaterThanOrEqual(13);
    });

    test('estimates tokens by character count', () => {
      // Very long word: 100 chars / 4 = 25 tokens by chars (higher than 1 word * 1.3)
      const text = 'a'.repeat(100);
      const result = estimateTokens(text);
      expect(result).toBe(25);
    });

    test('uses max of word-based and char-based estimates', () => {
      // Short text with few long words — char estimate should dominate
      const longWord = 'supercalifragilisticexpialidocious';
      const result = estimateTokens(longWord);
      const byChars = Math.ceil(longWord.length / 4);
      const byWords = Math.ceil(1 * 1.3);
      expect(result).toBe(Math.max(byChars, byWords));
    });

    test('respects custom tokensPerWord option', () => {
      const text = 'one two three four five';
      const result = estimateTokens(text, { tokensPerWord: 2 });
      expect(result).toBeGreaterThanOrEqual(10); // 5 words * 2
    });

    test('respects custom charsPerToken option', () => {
      const text = 'a'.repeat(100);
      const result = estimateTokens(text, { charsPerToken: 2 });
      expect(result).toBe(50); // 100 / 2
    });

    test('handles whitespace-only text', () => {
      // wordCount=0 but byChars = ceil(7/4) = 2 (uses raw length, not trimmed)
      const result = estimateTokens('   \n\t  ');
      expect(result).toBe(2);
    });
  });

  describe('truncateContent', () => {
    test('returns empty string for null/empty input', () => {
      expect(truncateContent('')).toBe('');
      expect(truncateContent(null)).toBe('');
      expect(truncateContent(undefined)).toBe('');
    });

    test('returns text unchanged when under max length', () => {
      const text = 'short text';
      expect(truncateContent(text)).toBe(text);
    });

    test('truncates at sentence boundary when available', () => {
      const text = 'First sentence. Second sentence. ' + 'x'.repeat(500);
      const result = truncateContent(text, 100);
      expect(result).toContain('...');
      expect(result.length).toBeLessThanOrEqual(104); // 100 + '...'
    });

    test('truncates at newline boundary when available', () => {
      const text = 'First line\nSecond line\n' + 'x'.repeat(500);
      const result = truncateContent(text, 50);
      expect(result).toContain('...');
    });

    test('truncates at maxLength when no good break point', () => {
      const text = 'x'.repeat(600);
      const result = truncateContent(text, 100);
      expect(result).toBe('x'.repeat(100) + '...');
    });

    test('uses default maxLength of 500', () => {
      const text = 'a'.repeat(600);
      const result = truncateContent(text);
      expect(result.length).toBeLessThanOrEqual(504); // 500 + '...'
    });

    test('prefers break point in latter half of text', () => {
      // Period at position 20 out of 100 chars — too early (< 50%), should use hard truncate
      const text = 'a'.repeat(20) + '.' + 'b'.repeat(80);
      const result = truncateContent(text, 50);
      // Break point at 20 is 40% of 50, which is < 50%, so should hard-truncate
      expect(result).toBe(text.slice(0, 50) + '...');
    });
  });

  describe('truncateToTokenBudget', () => {
    test('returns empty string for null/empty input', () => {
      expect(truncateToTokenBudget('', 100)).toBe('');
      expect(truncateToTokenBudget(null, 100)).toBe('');
    });

    test('returns empty string for zero/negative budget', () => {
      expect(truncateToTokenBudget('hello', 0)).toBe('');
      expect(truncateToTokenBudget('hello', -5)).toBe('');
    });

    test('returns text unchanged when within budget', () => {
      const text = 'hello world';
      expect(truncateToTokenBudget(text, 1000)).toBe(text);
    });

    test('truncates when over budget', () => {
      const text = 'word '.repeat(200); // ~200 words
      const result = truncateToTokenBudget(text, 10);
      expect(result.length).toBeLessThan(text.length);
      expect(result).toContain('...');
    });

    test('respects custom charsPerToken option', () => {
      const text = 'a'.repeat(200);
      const result = truncateToTokenBudget(text, 10, { charsPerToken: 2 });
      // budget 10 * charsPerToken 2 = 20 chars max
      expect(result.length).toBeLessThanOrEqual(24); // 20 + '...'
    });

    test('enforces minimum 20 char truncation', () => {
      const text = 'a'.repeat(200);
      const result = truncateToTokenBudget(text, 1); // Very small budget
      // Even with budget=1, maxChars should be at least 20
      expect(result.length).toBeGreaterThanOrEqual(20);
    });
  });
});
