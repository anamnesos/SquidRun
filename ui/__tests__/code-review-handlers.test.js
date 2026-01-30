/**
 * Code Review IPC Handlers Tests
 * Target: Full coverage of modules/ipc/code-review-handlers.js
 */

// Mock fs - use inline factory
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

// Create mock reviewer
const mockReviewer = {
  reviewDiff: jest.fn(),
  reviewFiles: jest.fn(),
  reviewCommit: jest.fn(),
};

// Mock code-review module
jest.mock('../modules/analysis/code-review', () => ({
  createReviewer: jest.fn(() => mockReviewer),
}));

const { registerCodeReviewHandlers } = require('../modules/ipc/code-review-handlers');
const fs = require('fs');
const { execSync } = require('child_process');

describe('Code Review IPC Handlers', () => {
  let mockIpcMain;
  let handlers;

  beforeEach(() => {
    jest.clearAllMocks();

    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
    };

    // Default fs mock behaviors
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue('{}');
    fs.writeFileSync.mockImplementation(() => {});
    fs.mkdirSync.mockImplementation(() => {});
    fs.readdirSync.mockReturnValue([]);
    fs.unlinkSync.mockImplementation(() => {});

    // Default mock reviewer responses
    mockReviewer.reviewDiff.mockResolvedValue({
      success: true,
      issues: [],
      summary: 'No issues found',
      stats: { total: 0, bySeverity: {}, byCategory: {} },
    });
    mockReviewer.reviewFiles.mockResolvedValue({
      success: true,
      issues: [],
      summary: 'No issues found',
      stats: { total: 0, bySeverity: {}, byCategory: {} },
    });
    mockReviewer.reviewCommit.mockResolvedValue({
      success: true,
      issues: [],
      summary: 'No issues found',
      stats: { total: 0, bySeverity: {}, byCategory: {} },
    });
  });

  describe('registerCodeReviewHandlers', () => {
    test('returns early if ipcMain is missing', () => {
      registerCodeReviewHandlers({ WORKSPACE_PATH: '/test' });
      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('returns early if WORKSPACE_PATH is missing', () => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain });
      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('registers all expected handlers', () => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });

      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-diff', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-staged', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-files', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-commit', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-get-settings', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-set-settings', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-clear', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-get-history', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-get-detail', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-quick', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('review-ai-status', expect.any(Function));
    });

    test('loads settings on initialization', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ autoReview: true }));

      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });

      // Settings file should be checked during initialization
      expect(fs.existsSync).toHaveBeenCalled();
    });

    test('handles settings load error gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      // Should not throw
      expect(() => {
        registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test' });
      }).not.toThrow();
    });
  });

  describe('review-diff', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('returns empty result when no diff', async () => {
      execSync.mockReturnValue('');

      const result = await handlers['review-diff']({}, {});

      expect(result.success).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.summary).toBe('No changes to review');
    });

    test('reviews diff with default mode', async () => {
      execSync.mockReturnValue('diff --git a/file.js\n+added line');
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [{ severity: 'low', message: 'Test issue' }],
        summary: '1 issue found',
        stats: { total: 1, bySeverity: { low: 1 }, byCategory: {} },
      });

      const result = await handlers['review-diff']({}, {});

      expect(result.success).toBe(true);
      expect(mockReviewer.reviewDiff).toHaveBeenCalledWith(
        'diff --git a/file.js\n+added line',
        expect.objectContaining({ mode: 'all' })
      );
    });

    test('reviews staged changes with mode=staged', async () => {
      execSync.mockReturnValue('staged diff');
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      const result = await handlers['review-diff']({}, { mode: 'staged' });

      expect(result.success).toBe(true);
      expect(execSync).toHaveBeenCalledWith('git diff --cached', expect.any(Object));
    });

    test('reviews unstaged changes with mode=unstaged', async () => {
      execSync.mockReturnValue('unstaged diff');
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      const result = await handlers['review-diff']({}, { mode: 'unstaged' });

      expect(result.success).toBe(true);
      expect(execSync).toHaveBeenCalledWith('git diff', expect.any(Object));
    });

    test('uses custom project path', async () => {
      execSync.mockReturnValue('diff content');
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      await handlers['review-diff']({}, { projectPath: '/custom/path' });

      expect(execSync).toHaveBeenCalledWith('git diff HEAD', expect.objectContaining({
        cwd: '/custom/path',
      }));
    });

    test('handles git diff error gracefully', async () => {
      const error = new Error('Not a git repo');
      error.stdout = '';
      execSync.mockImplementation(() => { throw error; });

      const result = await handlers['review-diff']({}, {});

      expect(result.success).toBe(true);
      expect(result.summary).toBe('No changes to review');
    });

    test('saves review to history when issues found', async () => {
      execSync.mockReturnValue('diff content');
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [{ severity: 'high', message: 'Critical issue' }],
        summary: '1 critical issue',
        stats: { total: 1, bySeverity: { high: 1 }, byCategory: {} },
      });

      await handlers['review-diff']({}, {});

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles review error', async () => {
      execSync.mockReturnValue('diff content');
      mockReviewer.reviewDiff.mockRejectedValue(new Error('Review failed'));

      const result = await handlers['review-diff']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Review failed');
    });
  });

  describe('review-staged', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('reviews staged changes successfully', async () => {
      execSync.mockReturnValue('diff --git a/test.js b/test.js\n+console.log("test");');
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [{ severity: 'low', message: 'Console statement' }],
        summary: 'Found issues',
        stats: { total: 1, bySeverity: { low: 1 }, byCategory: {} },
      });

      const result = await handlers['review-staged']({}, { projectPath: '/test' });

      // Should call git diff --cached for staged changes
      expect(execSync).toHaveBeenCalledWith('git diff --cached', expect.any(Object));
      expect(result.success).toBe(true);
      expect(result.issues).toHaveLength(1);
    });

    test('returns no changes message when no staged changes', async () => {
      execSync.mockReturnValue('');

      const result = await handlers['review-staged']({}, { projectPath: '/test' });

      expect(result.success).toBe(true);
      expect(result.summary).toBe('No changes to review');
      expect(result.issues).toHaveLength(0);
    });

    test('handles errors gracefully', async () => {
      execSync.mockReturnValue('diff content');
      mockReviewer.reviewDiff.mockRejectedValue(new Error('Review error'));

      const result = await handlers['review-staged']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Review error');
    });
  });

  describe('review-files', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('returns error when no files specified', async () => {
      const result = await handlers['review-files']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('No files specified');
    });

    test('returns error when files array is empty', async () => {
      const result = await handlers['review-files']({}, { files: [] });

      expect(result.success).toBe(false);
      expect(result.error).toBe('No files specified');
    });

    test('reviews specified files', async () => {
      mockReviewer.reviewFiles.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      const result = await handlers['review-files']({}, {
        files: ['file1.js', 'file2.js'],
      });

      expect(result.success).toBe(true);
      expect(mockReviewer.reviewFiles).toHaveBeenCalledWith(
        ['file1.js', 'file2.js'],
        expect.any(String)
      );
    });

    test('uses custom project path', async () => {
      mockReviewer.reviewFiles.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      await handlers['review-files']({}, {
        files: ['test.js'],
        projectPath: '/custom/project',
      });

      expect(mockReviewer.reviewFiles).toHaveBeenCalledWith(
        ['test.js'],
        '/custom/project'
      );
    });

    test('saves review to history when issues found', async () => {
      mockReviewer.reviewFiles.mockResolvedValue({
        success: true,
        issues: [{ severity: 'medium', message: 'Issue' }],
        summary: '1 issue',
        stats: { total: 1, bySeverity: { medium: 1 }, byCategory: {} },
      });

      await handlers['review-files']({}, { files: ['test.js'] });

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles review error', async () => {
      mockReviewer.reviewFiles.mockRejectedValue(new Error('File read error'));

      const result = await handlers['review-files']({}, { files: ['test.js'] });

      expect(result.success).toBe(false);
      expect(result.error).toBe('File read error');
    });
  });

  describe('review-commit', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('returns error when commit hash missing', async () => {
      const result = await handlers['review-commit']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Commit hash required');
    });

    test('reviews specific commit', async () => {
      mockReviewer.reviewCommit.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean commit',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      const result = await handlers['review-commit']({}, { commit: 'abc123' });

      expect(result.success).toBe(true);
      expect(mockReviewer.reviewCommit).toHaveBeenCalledWith('abc123', expect.any(String));
    });

    test('uses custom project path', async () => {
      mockReviewer.reviewCommit.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      await handlers['review-commit']({}, {
        commit: 'def456',
        projectPath: '/custom/repo',
      });

      expect(mockReviewer.reviewCommit).toHaveBeenCalledWith('def456', '/custom/repo');
    });

    test('saves review to history when issues found', async () => {
      mockReviewer.reviewCommit.mockResolvedValue({
        success: true,
        issues: [{ severity: 'high', message: 'Security issue' }],
        summary: 'Critical',
        stats: { total: 1, bySeverity: { high: 1 }, byCategory: {} },
      });

      await handlers['review-commit']({}, { commit: 'xyz789' });

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles review error', async () => {
      mockReviewer.reviewCommit.mockRejectedValue(new Error('Invalid commit'));

      const result = await handlers['review-commit']({}, { commit: 'invalid' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid commit');
    });
  });

  describe('review-get-settings', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('returns default settings', async () => {
      const result = await handlers['review-get-settings']({});

      expect(result.success).toBe(true);
      expect(result.settings).toEqual({
        autoReview: false,
        categories: ['security', 'bug', 'performance', 'error_handling'],
        minSeverity: 'low',
        useAI: true,
        maxDiffSize: 50000,
      });
    });

    test('returns loaded settings', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        autoReview: true,
        minSeverity: 'high',
      }));

      // Re-register to reload settings
      handlers = {};
      mockIpcMain.handle.mockImplementation((channel, handler) => {
        handlers[channel] = handler;
      });
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });

      const result = await handlers['review-get-settings']({});

      expect(result.settings.autoReview).toBe(true);
      expect(result.settings.minSeverity).toBe('high');
    });
  });

  describe('review-set-settings', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('returns error when settings missing', async () => {
      const result = await handlers['review-set-settings']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Settings required');
    });

    test('updates settings', async () => {
      const result = await handlers['review-set-settings']({}, {
        settings: { autoReview: true },
      });

      expect(result.success).toBe(true);
      expect(result.settings.autoReview).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('resets reviewer instance when AI settings change', async () => {
      await handlers['review-set-settings']({}, {
        settings: { useAI: false },
      });

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('resets reviewer instance when categories change', async () => {
      await handlers['review-set-settings']({}, {
        settings: { categories: ['security'] },
      });

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles save error gracefully', async () => {
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Write error');
      });

      // Should not throw, but log error
      const result = await handlers['review-set-settings']({}, {
        settings: { autoReview: true },
      });

      expect(result.success).toBe(true);
    });
  });

  describe('review-clear', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('returns success when history directory does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await handlers['review-clear']({});

      expect(result.success).toBe(true);
    });

    test('deletes all review files', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['review-1.json', 'review-2.json', 'other.txt']);

      const result = await handlers['review-clear']({});

      expect(result.success).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2); // Only .json files
    });

    test('handles delete error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = await handlers['review-clear']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read error');
    });
  });

  describe('review-get-history', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('returns empty history when no files', async () => {
      fs.readdirSync.mockReturnValue([]);

      const result = await handlers['review-get-history']({}, {});

      expect(result.success).toBe(true);
      expect(result.history).toEqual([]);
    });

    test('returns limited history', async () => {
      fs.readdirSync.mockReturnValue([
        'review-3.json',
        'review-2.json',
        'review-1.json',
      ]);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        timestamp: 12345,
        mode: 'all',
        summary: 'Test review',
        stats: { total: 5 },
      }));

      const result = await handlers['review-get-history']({}, { limit: 2 });

      expect(result.success).toBe(true);
      expect(result.history.length).toBeLessThanOrEqual(2);
    });

    test('skips corrupted files', async () => {
      fs.readdirSync.mockReturnValue(['review-1.json', 'review-2.json']);
      fs.readFileSync
        .mockReturnValueOnce('invalid json')
        .mockReturnValueOnce(JSON.stringify({
          timestamp: 12345,
          mode: 'all',
          summary: 'Valid review',
          stats: { total: 1 },
        }));

      const result = await handlers['review-get-history']({}, {});

      expect(result.success).toBe(true);
      expect(result.history.length).toBe(1);
    });

    test('uses default limit of 10', async () => {
      const files = Array.from({ length: 15 }, (_, i) => `review-${i}.json`);
      fs.readdirSync.mockReturnValue(files);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        timestamp: 12345,
        mode: 'all',
        summary: 'Review',
        stats: { total: 0 },
      }));

      const result = await handlers['review-get-history']({}, {});

      expect(result.success).toBe(true);
      expect(result.history.length).toBe(10);
    });

    test('handles read error', async () => {
      fs.readdirSync.mockImplementation(() => {
        throw new Error('Access denied');
      });

      const result = await handlers['review-get-history']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Access denied');
    });
  });

  describe('review-get-detail', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('returns error when id missing', async () => {
      const result = await handlers['review-get-detail']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Review ID required');
    });

    test('returns error when review not found', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await handlers['review-get-detail']({}, { id: 'review-999' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Review not found');
    });

    test('returns review details', async () => {
      const reviewData = {
        timestamp: 12345,
        mode: 'all',
        summary: 'Found issues',
        issues: [{ severity: 'high', message: 'Security issue' }],
        stats: { total: 1 },
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(reviewData));

      const result = await handlers['review-get-detail']({}, { id: 'review-12345' });

      expect(result.success).toBe(true);
      expect(result.review).toEqual(reviewData);
    });

    test('handles read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Corrupted file');
      });

      const result = await handlers['review-get-detail']({}, { id: 'review-bad' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Corrupted file');
    });
  });

  describe('review-quick', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('returns error when code missing', async () => {
      const result = await handlers['review-quick']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Code content required');
    });

    test('reviews code snippet', async () => {
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean code',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      const result = await handlers['review-quick']({}, {
        code: 'const x = 1;\nconsole.log(x);',
      });

      expect(result.success).toBe(true);
      expect(mockReviewer.reviewDiff).toHaveBeenCalledWith(
        expect.stringContaining('+const x = 1;'),
        expect.any(Object)
      );
    });

    test('uses provided filename', async () => {
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      await handlers['review-quick']({}, {
        code: 'test code',
        filename: 'test.ts',
      });

      expect(mockReviewer.reviewDiff).toHaveBeenCalledWith(
        expect.stringContaining('test.ts'),
        expect.any(Object)
      );
    });

    test('uses default filename when not provided', async () => {
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [],
        summary: 'Clean',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      });

      await handlers['review-quick']({}, {
        code: 'test code',
      });

      expect(mockReviewer.reviewDiff).toHaveBeenCalledWith(
        expect.stringContaining('code.js'),
        expect.any(Object)
      );
    });

    test('handles review error', async () => {
      mockReviewer.reviewDiff.mockRejectedValue(new Error('AI unavailable'));

      const result = await handlers['review-quick']({}, { code: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('AI unavailable');
    });
  });

  describe('review-ai-status', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      jest.resetModules();
      process.env = { ...originalEnv };
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    test('returns unavailable when no API key', async () => {
      delete process.env.ANTHROPIC_API_KEY;

      const result = await handlers['review-ai-status']({});

      expect(result.success).toBe(true);
      expect(result.available).toBe(false);
      expect(result.enabled).toBe(false);
    });

    test('returns available when API key exists', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const result = await handlers['review-ai-status']({});

      expect(result.success).toBe(true);
      expect(result.available).toBe(true);
    });

    test('reports enabled status correctly', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';

      const result = await handlers['review-ai-status']({});

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(true); // useAI defaults to true
    });
  });

  describe('helper functions', () => {
    beforeEach(() => {
      registerCodeReviewHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH: '/test/workspace' });
    });

    test('ensureDirectories creates directory if not exists', async () => {
      fs.existsSync.mockReturnValue(false);

      // Trigger a save which calls ensureDirectories
      await handlers['review-get-history']({}, {});

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('_reviews'),
        expect.objectContaining({ recursive: true })
      );
    });

    test('saveReview handles write errors gracefully', async () => {
      execSync.mockReturnValue('diff content');
      mockReviewer.reviewDiff.mockResolvedValue({
        success: true,
        issues: [{ severity: 'low', message: 'Issue' }],
        summary: 'Found issue',
        stats: { total: 1, bySeverity: { low: 1 }, byCategory: {} },
      });
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Disk full');
      });

      // Should not throw
      const result = await handlers['review-diff']({}, {});

      expect(result.success).toBe(true);
    });
  });
});
