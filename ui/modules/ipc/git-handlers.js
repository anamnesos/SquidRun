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

const { execFile } = require('child_process');

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        if (err.stdout == null) err.stdout = stdout;
        if (err.stderr == null) err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function sanitizeFileList(files) {
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => String(file || '').trim())
    .filter((file) => file.length > 0);
}

function asPositiveInt(value, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function registerGitHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain) return;

  /**
   * Execute git command and return result
   */
  async function execGit(args, cwd) {
    try {
      const stdout = await execFileAsync('git', args, {
        cwd: cwd || WORKSPACE_PATH,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
        timeout: 30000,
        windowsHide: true,
      });
      return { success: true, output: stdout };
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
      const statusResult = await execGit(['status', '--porcelain', '-uall'], cwd);
      if (!statusResult.success) {
        return { success: false, error: statusResult.error };
      }

      const statusText = String(statusResult.output ?? '');
      if (!statusText.trim()) {
        return { success: false, error: 'no output' };
      }
      const lines = statusText.trim().split('\n').filter(l => l);
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
      const branchResult = await execGit(['branch', '--show-current'], cwd);
      const branch = branchResult.success ? branchResult.output.trim() : 'unknown';

      // Get ahead/behind counts
      let ahead = 0;
      let behind = 0;
      const trackResult = await execGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], cwd);
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
      const args = ['diff'];
      if (mode === 'staged') {
        args.push('--cached');
      } else if (mode === 'all') {
        args.push('HEAD');
      }

      const targetFile = typeof file === 'string' ? file.trim() : '';
      if (targetFile) {
        args.push('--', targetFile);
      }

      const result = await execGit(args, cwd);
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
      const safeLimit = asPositiveInt(limit, 20);
      const args = ['log'];
      if (format === 'oneline') {
        args.push('--oneline');
      } else {
        args.push('--format=format:%H|%h|%an|%ae|%at|%s');
      }
      args.push('-n', String(safeLimit));

      const result = await execGit(args, cwd);
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
      const targets = sanitizeFileList(files);
      const args = targets.length > 0
        ? ['add', '--', ...targets]
        : ['add', '-A'];

      const result = await execGit(args, cwd);
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
      const targets = sanitizeFileList(files);
      const args = targets.length > 0
        ? ['reset', 'HEAD', '--', ...targets]
        : ['reset', 'HEAD'];

      const result = await execGit(args, cwd);
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
      const result = await execGit(['commit', '-m', String(message)], cwd);
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
      const result = await execGit(['branch', '--show-current'], cwd);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      const text = String(result.output ?? '');
      if (!text.trim()) {
        return { success: false, error: 'no output' };
      }

      return { success: true, branch: text.trim() };
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
      const statArgs = ['diff'];
      if (mode === 'staged') {
        statArgs.push('--cached');
      } else if (mode === 'all') {
        statArgs.push('HEAD');
      }
      statArgs.push('--stat');

      const result = await execGit(statArgs, cwd);
      if (!result.success) {
        return { success: false, error: result.error };
      }

      // Also get numstat for detailed changes
      const numArgs = ['diff'];
      if (mode === 'staged') {
        numArgs.push('--cached');
      } else if (mode === 'all') {
        numArgs.push('HEAD');
      }
      numArgs.push('--numstat');

      const numResult = await execGit(numArgs, cwd);
      const files = [];

      if (numResult.success) {
        const text = String(numResult.output ?? '');
        if (!text.trim()) {
          return { success: false, error: 'no output' };
        }

        const lines = text.trim().split('\n').filter(l => l);
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
      const spec = `${String(revision)}:${String(file)}`;
      const result = await execGit(['show', spec], cwd);
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
      const result = await execGit(['rev-parse', '--is-inside-work-tree'], cwd);
      if (!result.success) {
        return {
          success: false,
          isRepo: false,
          error: result.error,
          stderr: result.stderr,
          stdout: result.stdout,
        };
      }

      return { success: true, isRepo: result.output.trim() === 'true' };
    } catch (err) {
      return { success: false, isRepo: false, error: err.message };
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


function unregisterGitHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('git-status');
    ipcMain.removeHandler('git-diff');
    ipcMain.removeHandler('git-log');
    ipcMain.removeHandler('git-stage');
    ipcMain.removeHandler('git-unstage');
    ipcMain.removeHandler('git-commit');
    ipcMain.removeHandler('git-branch');
    ipcMain.removeHandler('git-files-changed');
    ipcMain.removeHandler('git-show');
    ipcMain.removeHandler('git-is-repo');
}

registerGitHandlers.unregister = unregisterGitHandlers;
module.exports = { registerGitHandlers };
