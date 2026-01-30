/**
 * Git IPC Handlers - Task #6 + Task #18
 *
 * Provides git operations for the UI:
 * - git-status: Get repository status
 * - git-diff: Get diff content (staged/unstaged/all)
 * - git-log: Get commit history
 * - git-stage: Stage files
 * - git-unstage: Unstage files
 * - git-commit: Create commit
 * - git-branch: Get current branch
 * - git-files-changed: Get list of changed files with stats
 */

const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

function registerGitHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain) return;

  /**
   * Execute git command and return result
   */
  function execGit(cmd, cwd) {
    try {
      const result = execSync(cmd, {
        cwd: cwd || WORKSPACE_PATH,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
        timeout: 30000,
      });
      return { success: true, output: result };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        stderr: err.stderr?.toString() || '',
        stdout: err.stdout?.toString() || '',
      };
    }
  }

  /**
   * Get git repository status
   */
  ipcMain.handle('git-status', async (event, payload = {}) => {
    const { projectPath } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    try {
      // Get porcelain status for parsing
      const statusResult = execGit('git status --porcelain -uall', cwd);
      if (!statusResult.success) {
        return { success: false, error: statusResult.error };
      }

      const lines = statusResult.output.trim().split('\n').filter(l => l);
      const files = {
        staged: [],
        unstaged: [],
        untracked: [],
      };

      for (const line of lines) {
        const index = line[0];
        const worktree = line[1];
        const filePath = line.slice(3);

        if (index === '?' && worktree === '?') {
          files.untracked.push({ path: filePath, status: 'untracked' });
        } else if (index !== ' ' && index !== '?') {
          files.staged.push({ path: filePath, status: getStatusLabel(index) });
        }
        if (worktree !== ' ' && worktree !== '?') {
          files.unstaged.push({ path: filePath, status: getStatusLabel(worktree) });
        }
      }

      // Get branch info
      const branchResult = execGit('git branch --show-current', cwd);
      const branch = branchResult.success ? branchResult.output.trim() : 'unknown';

      // Get ahead/behind counts
      let ahead = 0, behind = 0;
      const trackResult = execGit('git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null', cwd);
      if (trackResult.success) {
        const parts = trackResult.output.trim().split(/\s+/);
        ahead = parseInt(parts[0]) || 0;
        behind = parseInt(parts[1]) || 0;
      }

      return {
        success: true,
        status: {
          branch,
          ahead,
          behind,
          files,
          totalChanges: files.staged.length + files.unstaged.length + files.untracked.length,
        },
      };
    } catch (err) {
      console.error('[Git] Status error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get diff content
   */
  ipcMain.handle('git-diff', async (event, payload = {}) => {
    const { projectPath, mode = 'all', file } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    try {
      let cmd = 'git diff';
      if (mode === 'staged') {
        cmd = 'git diff --cached';
      } else if (mode === 'unstaged') {
        cmd = 'git diff';
      } else if (mode === 'all') {
        cmd = 'git diff HEAD';
      }

      if (file) {
        cmd += ` -- "${file}"`;
      }

      const result = execGit(cmd, cwd);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      // Parse diff into structured format
      const diff = parseDiff(result.output);

      return {
        success: true,
        diff: result.output,
        parsed: diff,
        mode,
      };
    } catch (err) {
      console.error('[Git] Diff error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get commit log
   */
  ipcMain.handle('git-log', async (event, payload = {}) => {
    const { projectPath, limit = 20, format = 'medium' } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    try {
      const logFormat = format === 'oneline'
        ? '--oneline'
        : '--format=format:%H|%h|%an|%ae|%at|%s';

      const result = execGit(`git log ${logFormat} -n ${limit}`, cwd);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      const commits = result.output.trim().split('\n').filter(l => l).map(line => {
        if (format === 'oneline') {
          const [hash, ...rest] = line.split(' ');
          return { hash, message: rest.join(' ') };
        }
        const [hash, shortHash, author, email, timestamp, subject] = line.split('|');
        return {
          hash,
          shortHash,
          author,
          email,
          timestamp: parseInt(timestamp) * 1000,
          message: subject,
        };
      });

      return { success: true, commits };
    } catch (err) {
      console.error('[Git] Log error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Stage files
   */
  ipcMain.handle('git-stage', async (event, payload = {}) => {
    const { projectPath, files } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    try {
      let cmd = 'git add -A';
      if (files && files.length > 0) {
        const fileList = files.map(f => `"${f}"`).join(' ');
        cmd = `git add ${fileList}`;
      }

      const result = execGit(cmd, cwd);
      return result;
    } catch (err) {
      console.error('[Git] Stage error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Unstage files
   */
  ipcMain.handle('git-unstage', async (event, payload = {}) => {
    const { projectPath, files } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    try {
      let cmd = 'git reset HEAD';
      if (files && files.length > 0) {
        const fileList = files.map(f => `"${f}"`).join(' ');
        cmd = `git reset HEAD ${fileList}`;
      }

      const result = execGit(cmd, cwd);
      return result;
    } catch (err) {
      console.error('[Git] Unstage error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Create commit
   */
  ipcMain.handle('git-commit', async (event, payload = {}) => {
    const { projectPath, message } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    if (!message) {
      return { success: false, error: 'Commit message required' };
    }

    try {
      // Escape message for shell
      const escapedMessage = message.replace(/"/g, '\\"');
      const result = execGit(`git commit -m "${escapedMessage}"`, cwd);
      return result;
    } catch (err) {
      console.error('[Git] Commit error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get current branch
   */
  ipcMain.handle('git-branch', async (event, payload = {}) => {
    const { projectPath } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    try {
      const result = execGit('git branch --show-current', cwd);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      return { success: true, branch: result.output.trim() };
    } catch (err) {
      console.error('[Git] Branch error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get changed files with stats
   */
  ipcMain.handle('git-files-changed', async (event, payload = {}) => {
    const { projectPath, mode = 'all' } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    try {
      let cmd = 'git diff --stat';
      if (mode === 'staged') {
        cmd = 'git diff --cached --stat';
      } else if (mode === 'all') {
        cmd = 'git diff HEAD --stat';
      }

      const result = execGit(cmd, cwd);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      // Also get numstat for detailed changes
      let numCmd = 'git diff --numstat';
      if (mode === 'staged') {
        numCmd = 'git diff --cached --numstat';
      } else if (mode === 'all') {
        numCmd = 'git diff HEAD --numstat';
      }

      const numResult = execGit(numCmd, cwd);
      const files = [];

      if (numResult.success) {
        const lines = numResult.output.trim().split('\n').filter(l => l);
        for (const line of lines) {
          const [added, deleted, filePath] = line.split('\t');
          files.push({
            path: filePath,
            added: added === '-' ? 0 : parseInt(added),
            deleted: deleted === '-' ? 0 : parseInt(deleted),
          });
        }
      }

      return {
        success: true,
        stat: result.output,
        files,
        totalFiles: files.length,
        totalAdded: files.reduce((sum, f) => sum + f.added, 0),
        totalDeleted: files.reduce((sum, f) => sum + f.deleted, 0),
      };
    } catch (err) {
      console.error('[Git] Files changed error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get file content at a specific revision
   */
  ipcMain.handle('git-show', async (event, payload = {}) => {
    const { projectPath, file, revision = 'HEAD' } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    if (!file) {
      return { success: false, error: 'File path required' };
    }

    try {
      const result = execGit(`git show ${revision}:"${file}"`, cwd);
      return result;
    } catch (err) {
      console.error('[Git] Show error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Check if directory is a git repository
   */
  ipcMain.handle('git-is-repo', async (event, payload = {}) => {
    const { projectPath } = payload;
    const cwd = projectPath || WORKSPACE_PATH;

    try {
      const result = execGit('git rev-parse --is-inside-work-tree', cwd);
      return { success: true, isRepo: result.success && result.output.trim() === 'true' };
    } catch (err) {
      return { success: true, isRepo: false };
    }
  });
}

/**
 * Get human-readable status label
 */
function getStatusLabel(code) {
  const labels = {
    'M': 'modified',
    'A': 'added',
    'D': 'deleted',
    'R': 'renamed',
    'C': 'copied',
    'U': 'unmerged',
    '?': 'untracked',
  };
  return labels[code] || 'unknown';
}

/**
 * Parse git diff into structured format
 */
function parseDiff(diffText) {
  if (!diffText) return [];

  const files = [];
  const fileChunks = diffText.split(/^diff --git /m).filter(c => c.trim());

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');
    const headerMatch = lines[0].match(/a\/(.+) b\/(.+)/);
    if (!headerMatch) continue;

    const file = {
      oldPath: headerMatch[1],
      newPath: headerMatch[2],
      hunks: [],
      additions: 0,
      deletions: 0,
    };

    let currentHunk = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      // Hunk header
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (hunkMatch) {
        if (currentHunk) file.hunks.push(currentHunk);
        currentHunk = {
          oldStart: parseInt(hunkMatch[1]),
          oldLines: parseInt(hunkMatch[2]) || 1,
          newStart: parseInt(hunkMatch[3]),
          newLines: parseInt(hunkMatch[4]) || 1,
          header: hunkMatch[5] || '',
          changes: [],
        };
        continue;
      }

      if (currentHunk) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          currentHunk.changes.push({ type: 'add', content: line.slice(1) });
          file.additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          currentHunk.changes.push({ type: 'del', content: line.slice(1) });
          file.deletions++;
        } else if (line.startsWith(' ')) {
          currentHunk.changes.push({ type: 'normal', content: line.slice(1) });
        }
      }
    }

    if (currentHunk) file.hunks.push(currentHunk);
    files.push(file);
  }

  return files;
}

module.exports = { registerGitHandlers };
