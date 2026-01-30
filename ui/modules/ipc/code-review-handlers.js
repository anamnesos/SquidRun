/**
 * Code Review IPC Handlers - Task #18
 *
 * Channels:
 * - review-diff: Review current git diff
 * - review-staged: Review only staged changes
 * - review-files: Review specific files
 * - review-commit: Review a specific commit
 * - review-get-settings: Get review settings
 * - review-set-settings: Update review settings
 * - review-clear: Clear cached review results
 * - review-get-history: Get review history
 */

const path = require('path');
const fs = require('fs');

function registerCodeReviewHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain || !WORKSPACE_PATH) return;

  // Lazy load code review module
  let codeReview = null;
  let reviewerInstance = null;

  function getReviewer() {
    if (!codeReview) {
      codeReview = require('../analysis/code-review');
    }
    if (!reviewerInstance) {
      reviewerInstance = codeReview.createReviewer({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }
    return reviewerInstance;
  }

  // Review history storage
  const REVIEW_HISTORY_PATH = path.join(WORKSPACE_PATH, 'memory', '_reviews');
  const REVIEW_SETTINGS_PATH = path.join(WORKSPACE_PATH, 'memory', '_review-settings.json');

  // Ensure directories exist
  function ensureDirectories() {
    if (!fs.existsSync(REVIEW_HISTORY_PATH)) {
      fs.mkdirSync(REVIEW_HISTORY_PATH, { recursive: true });
    }
  }

  // Default settings
  let reviewSettings = {
    autoReview: false,
    categories: ['security', 'bug', 'performance', 'error_handling'],
    minSeverity: 'low',
    useAI: true,
    maxDiffSize: 50000,
  };

  // Load settings
  function loadSettings() {
    try {
      if (fs.existsSync(REVIEW_SETTINGS_PATH)) {
        const data = JSON.parse(fs.readFileSync(REVIEW_SETTINGS_PATH, 'utf-8'));
        reviewSettings = { ...reviewSettings, ...data };
      }
    } catch (err) {
      console.error('[CodeReview] Failed to load settings:', err);
    }
  }

  // Save settings
  function saveSettings() {
    try {
      ensureDirectories();
      fs.writeFileSync(REVIEW_SETTINGS_PATH, JSON.stringify(reviewSettings, null, 2));
    } catch (err) {
      console.error('[CodeReview] Failed to save settings:', err);
    }
  }

  // Save review to history
  function saveReview(review, mode) {
    try {
      ensureDirectories();
      const timestamp = Date.now();
      const filename = `review-${timestamp}.json`;
      const data = {
        timestamp,
        mode,
        ...review,
      };
      fs.writeFileSync(path.join(REVIEW_HISTORY_PATH, filename), JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[CodeReview] Failed to save review:', err);
    }
  }

  // Initialize
  loadSettings();

  /**
   * Review current git diff
   */
  ipcMain.handle('review-diff', async (event, payload = {}) => {
    const { projectPath, mode = 'all' } = payload;
    const cwd = projectPath || path.join(WORKSPACE_PATH, '..');

    try {
      const { execSync } = require('child_process');

      // Get diff based on mode
      let cmd = 'git diff HEAD';
      if (mode === 'staged') {
        cmd = 'git diff --cached';
      } else if (mode === 'unstaged') {
        cmd = 'git diff';
      }

      let diff;
      try {
        diff = execSync(cmd, {
          cwd,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (err) {
        diff = err.stdout || '';
      }

      if (!diff || diff.trim().length === 0) {
        return {
          success: true,
          issues: [],
          summary: 'No changes to review',
          stats: { total: 0, bySeverity: {}, byCategory: {} },
        };
      }

      const reviewer = getReviewer();
      const result = await reviewer.reviewDiff(diff, {
        projectPath: cwd,
        mode,
      });

      // Save to history
      if (result.success && result.issues.length > 0) {
        saveReview(result, mode);
      }

      return result;
    } catch (err) {
      console.error('[CodeReview] Review diff error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Review only staged changes
   */
  ipcMain.handle('review-staged', async (event, payload = {}) => {
    return ipcMain.handle('review-diff', event, { ...payload, mode: 'staged' });
  });

  /**
   * Review specific files
   */
  ipcMain.handle('review-files', async (event, payload = {}) => {
    const { files, projectPath } = payload;

    if (!files || files.length === 0) {
      return { success: false, error: 'No files specified' };
    }

    const cwd = projectPath || path.join(WORKSPACE_PATH, '..');

    try {
      const reviewer = getReviewer();
      const result = await reviewer.reviewFiles(files, cwd);

      if (result.success && result.issues.length > 0) {
        saveReview(result, 'files');
      }

      return result;
    } catch (err) {
      console.error('[CodeReview] Review files error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Review a specific commit
   */
  ipcMain.handle('review-commit', async (event, payload = {}) => {
    const { commit, projectPath } = payload;

    if (!commit) {
      return { success: false, error: 'Commit hash required' };
    }

    const cwd = projectPath || path.join(WORKSPACE_PATH, '..');

    try {
      const reviewer = getReviewer();
      const result = await reviewer.reviewCommit(commit, cwd);

      if (result.success && result.issues.length > 0) {
        saveReview(result, `commit:${commit}`);
      }

      return result;
    } catch (err) {
      console.error('[CodeReview] Review commit error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get review settings
   */
  ipcMain.handle('review-get-settings', async () => {
    return { success: true, settings: reviewSettings };
  });

  /**
   * Update review settings
   */
  ipcMain.handle('review-set-settings', async (event, payload = {}) => {
    const { settings } = payload;

    if (!settings) {
      return { success: false, error: 'Settings required' };
    }

    reviewSettings = { ...reviewSettings, ...settings };
    saveSettings();

    // Recreate reviewer with new settings if needed
    if (settings.useAI !== undefined || settings.categories !== undefined) {
      reviewerInstance = null; // Will be recreated on next use
    }

    return { success: true, settings: reviewSettings };
  });

  /**
   * Clear cached review results
   */
  ipcMain.handle('review-clear', async () => {
    try {
      if (fs.existsSync(REVIEW_HISTORY_PATH)) {
        const files = fs.readdirSync(REVIEW_HISTORY_PATH);
        for (const file of files) {
          if (file.endsWith('.json')) {
            fs.unlinkSync(path.join(REVIEW_HISTORY_PATH, file));
          }
        }
      }
      return { success: true };
    } catch (err) {
      console.error('[CodeReview] Clear history error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get review history
   */
  ipcMain.handle('review-get-history', async (event, payload = {}) => {
    const { limit = 10 } = payload;

    try {
      ensureDirectories();

      const files = fs.readdirSync(REVIEW_HISTORY_PATH)
        .filter(f => f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a)) // Newest first
        .slice(0, limit);

      const history = [];
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(REVIEW_HISTORY_PATH, file), 'utf-8'));
          history.push({
            id: file.replace('.json', ''),
            timestamp: data.timestamp,
            mode: data.mode,
            summary: data.summary,
            issueCount: data.stats?.total || 0,
            stats: data.stats,
          });
        } catch (err) {
          // Skip corrupted files
        }
      }

      return { success: true, history };
    } catch (err) {
      console.error('[CodeReview] Get history error:', err);
      return { success: false, error: err.message, history: [] };
    }
  });

  /**
   * Get specific review from history
   */
  ipcMain.handle('review-get-detail', async (event, payload = {}) => {
    const { id } = payload;

    if (!id) {
      return { success: false, error: 'Review ID required' };
    }

    try {
      const filePath = path.join(REVIEW_HISTORY_PATH, `${id}.json`);
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Review not found' };
      }

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return { success: true, review: data };
    } catch (err) {
      console.error('[CodeReview] Get detail error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Quick review - analyze without saving
   */
  ipcMain.handle('review-quick', async (event, payload = {}) => {
    const { code, filename } = payload;

    if (!code) {
      return { success: false, error: 'Code content required' };
    }

    try {
      // Create pseudo-diff
      const pseudoDiff = `+++ b/${filename || 'code.js'}\n` + code.split('\n').map(l => '+' + l).join('\n');

      const reviewer = getReviewer();
      const result = await reviewer.reviewDiff(pseudoDiff, {});

      return result;
    } catch (err) {
      console.error('[CodeReview] Quick review error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Check if AI review is available
   */
  ipcMain.handle('review-ai-status', async () => {
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    return {
      success: true,
      available: hasApiKey,
      enabled: reviewSettings.useAI && hasApiKey,
    };
  });
}

module.exports = { registerCodeReviewHandlers };
