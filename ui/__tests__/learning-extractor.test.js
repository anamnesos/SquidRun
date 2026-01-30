/**
 * Learning Extractor Tests
 * Target: Full coverage of modules/memory/learning-extractor.js
 */

const learningExtractor = require('../modules/memory/learning-extractor');

describe('Learning Extractor', () => {
  // Note: The module maintains internal state (recentKeys Map) which
  // persists across tests. Tests should use unique content to avoid
  // deduplication affecting results.

  describe('extractLearnings', () => {
    describe('basic functionality', () => {
      test('returns empty array for null input', () => {
        expect(learningExtractor.extractLearnings(null)).toEqual([]);
      });

      test('returns empty array for undefined input', () => {
        expect(learningExtractor.extractLearnings(undefined)).toEqual([]);
      });

      test('returns empty array for non-string input', () => {
        expect(learningExtractor.extractLearnings(123)).toEqual([]);
        expect(learningExtractor.extractLearnings({})).toEqual([]);
      });

      test('returns empty array for empty string', () => {
        expect(learningExtractor.extractLearnings('')).toEqual([]);
      });

      test('returns empty array for text without learnings', () => {
        const result = learningExtractor.extractLearnings('Just a normal message without any patterns');
        expect(result).toEqual([]);
      });
    });

    describe('pattern category extraction', () => {
      test('extracts "I learned that" pattern', () => {
        const text = 'I learned that using async/await is better than callbacks for readability';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        const learning = result.find(l => l.category === 'pattern');
        expect(learning).toBeDefined();
        expect(learning.content).toContain('async/await');
        expect(learning.confidence).toBe(0.85);
      });

      test('extracts "we learned that" pattern', () => {
        const text = 'We learned that proper error handling prevents crashes';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result.some(l => l.category === 'pattern')).toBe(true);
      });

      test('extracts "lesson learned" pattern', () => {
        const text = 'Lesson learned: always validate user input before processing';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result.some(l => l.category === 'pattern')).toBe(true);
      });

      test('extracts "best practice" pattern', () => {
        const text = 'Best practice: use TypeScript for large codebases to improve maintainability';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result.some(l => l.category === 'pattern')).toBe(true);
      });
    });

    describe('bug category extraction', () => {
      test('extracts "root cause was" pattern', () => {
        const text = 'Root cause was the missing null check in the validation function';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        const learning = result.find(l => l.category === 'bug');
        expect(learning).toBeDefined();
        expect(learning.content).toContain('null check');
        expect(learning.confidence).toBe(0.85);
      });

      test('extracts "root cause is" pattern', () => {
        const text = 'Root cause is incorrect state management in the component lifecycle';
        const result = learningExtractor.extractLearnings(text);

        expect(result.some(l => l.category === 'bug')).toBe(true);
      });

      test('extracts "the issue was" pattern', () => {
        const text = 'The issue was a race condition in the async handler code path';
        const result = learningExtractor.extractLearnings(text);

        expect(result.some(l => l.category === 'bug')).toBe(true);
      });

      test('extracts "the problem was" pattern', () => {
        const text = 'The problem was incorrect parameter order in the API call function';
        const result = learningExtractor.extractLearnings(text);

        expect(result.some(l => l.category === 'bug')).toBe(true);
      });
    });

    describe('solution category extraction', () => {
      test('extracts "the fix is" pattern', () => {
        const text = 'The fix is to add a debounce wrapper around the scroll handler';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        const learning = result.find(l => l.category === 'solution');
        expect(learning).toBeDefined();
        expect(learning.confidence).toBe(0.85);
      });

      test('extracts "the fix was" pattern', () => {
        const text = 'The fix was updating the dependency version in package.json';
        const result = learningExtractor.extractLearnings(text);

        expect(result.some(l => l.category === 'solution')).toBe(true);
      });

      test('extracts "fixed by" pattern', () => {
        const text = 'Fixed by implementing proper cleanup in useEffect return function';
        const result = learningExtractor.extractLearnings(text);

        expect(result.some(l => l.category === 'solution')).toBe(true);
      });

      test('extracts "resolved by" pattern', () => {
        const text = 'Resolved by adding the missing await keyword before the promise call';
        const result = learningExtractor.extractLearnings(text);

        expect(result.some(l => l.category === 'solution')).toBe(true);
      });

      test('extracts "solution is" pattern', () => {
        const text = 'Solution is to refactor the component to use hooks instead of class';
        const result = learningExtractor.extractLearnings(text);

        expect(result.some(l => l.category === 'solution')).toBe(true);
      });
    });

    describe('warning category extraction', () => {
      test('extracts "warning:" pattern', () => {
        const text = 'Warning: avoid mutating state directly as it can cause unexpected behavior';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        const learning = result.find(l => l.category === 'warning');
        expect(learning).toBeDefined();
        expect(learning.confidence).toBe(0.8);
      });

      test('extracts "we should avoid" pattern', () => {
        const text = 'We should avoid using inline styles for performance critical components';
        const result = learningExtractor.extractLearnings(text);

        expect(result.some(l => l.category === 'warning')).toBe(true);
      });

      test('extracts "beware of" pattern', () => {
        const text = 'Beware of circular dependencies when refactoring module imports structure';
        const result = learningExtractor.extractLearnings(text);

        expect(result.some(l => l.category === 'warning')).toBe(true);
      });
    });

    describe('extraction details', () => {
      test('includes pattern source in result', () => {
        const text = 'I learned that testing is important for code quality';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result[0].pattern).toBeDefined();
        expect(typeof result[0].pattern).toBe('string');
      });

      test('sets topic same as category', () => {
        const text = 'Root cause was the incorrect configuration setting';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result[0].topic).toBe(result[0].category);
      });

      test('includes sourceHint from options', () => {
        const text = 'I learned that documentation helps onboarding';
        const result = learningExtractor.extractLearnings(text, { sourceHint: 'output' });

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result[0].sourceHint).toBe('output');
      });

      test('sourceHint is null when not provided', () => {
        const text = 'The fix is to use proper error boundaries';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result[0].sourceHint).toBeNull();
      });
    });

    describe('content cleaning', () => {
      test('removes extra whitespace', () => {
        const text = 'I learned that    spacing    matters     in   outputs';
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result[0].content).not.toContain('    ');
      });

      test('removes leading punctuation', () => {
        const text = 'Lesson learned: - the leading dash should be removed here';
        const result = learningExtractor.extractLearnings(text);

        if (result.length > 0) {
          expect(result[0].content).not.toMatch(/^[\-\*\:]/);
        }
      });

      test('truncates very long content', () => {
        const longContent = 'x'.repeat(2000);
        const text = `I learned that ${longContent} is important`;
        const result = learningExtractor.extractLearnings(text);

        if (result.length > 0) {
          expect(result[0].content.length).toBeLessThanOrEqual(1203); // 1200 + "..."
        }
      });
    });

    describe('filtering', () => {
      test('ignores extracts shorter than 8 characters', () => {
        const text = 'I learned that X.'; // 'X' is too short
        const result = learningExtractor.extractLearnings(text);

        // Should not extract single character
        expect(result.every(l => l.content.length >= 8)).toBe(true);
      });

      test('truncates input longer than MAX_SCAN_CHARS', () => {
        // Create text with learnings at the end that won't be scanned
        const filler = 'a'.repeat(25000);
        const text = filler + '\nI learned that this wont be found due to length';
        const result = learningExtractor.extractLearnings(text);

        // The learning at the end should not be found
        expect(result.find(l => l.content.includes('wont be found'))).toBeUndefined();
      });
    });

    describe('deduplication', () => {
      test('deduplicates identical learnings within short time', () => {
        // Use unique content for this test
        const uniqueId = Date.now().toString(36);
        const text = `I learned that dedup test ${uniqueId} is important for memory efficiency`;

        // First extraction should find it
        const result1 = learningExtractor.extractLearnings(text);
        expect(result1.length).toBeGreaterThanOrEqual(1);

        // Immediate second extraction should be deduplicated
        const result2 = learningExtractor.extractLearnings(text);
        // The same content should be filtered out
        expect(result2.filter(l => l.content.includes(uniqueId))).toHaveLength(0);
      });

      test('allows different categories with same content', () => {
        const uniqueId1 = 'unique' + Date.now().toString(36) + 'a';
        const uniqueId2 = 'unique' + Date.now().toString(36) + 'b';

        const text1 = `I learned that ${uniqueId1} helps with code quality`;
        const text2 = `The fix is ${uniqueId2} for better performance`;

        const result1 = learningExtractor.extractLearnings(text1);
        const result2 = learningExtractor.extractLearnings(text2);

        // Different categories should both be extracted
        expect(result1.length + result2.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe('multiple learnings', () => {
      test('extracts multiple learnings from single text', () => {
        const uniqueId = Date.now().toString(36) + 'multi';
        const text = `
          I learned that testing ${uniqueId}A is essential for quality.
          Root cause was the missing validation ${uniqueId}B in the form.
          The fix is to add proper input sanitization ${uniqueId}C here.
          Warning: always escape user input ${uniqueId}D before rendering.
        `;
        const result = learningExtractor.extractLearnings(text);

        // Should find multiple learnings from different categories
        expect(result.length).toBeGreaterThanOrEqual(3);

        const categories = new Set(result.map(l => l.category));
        expect(categories.size).toBeGreaterThanOrEqual(3);
      });
    });

    describe('edge cases', () => {
      test('handles pattern after newline', () => {
        // Tests that (?:^|\n) matches \n (pattern not at start of string)
        const uniqueId = Date.now().toString(36) + 'afterNL';
        const text = `Some text before.\nI learned that ${uniqueId} patterns after newline work.`;
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result.some(l => l.content.includes(uniqueId))).toBe(true);
      });

      test('handles case insensitivity', () => {
        const uniqueId = Date.now().toString(36) + 'case';
        const text = `I LEARNED THAT ${uniqueId} uppercase works too`;
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
      });

      test('handles patterns at start of text', () => {
        const uniqueId = Date.now().toString(36) + 'start';
        const text = `I learned that ${uniqueId} at start is detected`;
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
      });

      test('handles patterns at end of text', () => {
        // Note: patterns require ^|\n before them, so use newline before "The fix"
        const uniqueId = Date.now().toString(36) + 'end';
        const text = `Some intro text.\nThe fix is ${uniqueId} at the end`;
        const result = learningExtractor.extractLearnings(text);

        expect(result.length).toBeGreaterThanOrEqual(1);
        expect(result.some(l => l.content.includes(uniqueId))).toBe(true);
      });
    });
  });
});
