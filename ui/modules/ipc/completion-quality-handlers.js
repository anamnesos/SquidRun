/**
 * Completion Quality IPC Handlers
 * Channels: check-completion-quality, validate-state-transition, get-quality-rules
 */

function registerCompletionQualityHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerCompletionQualityHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const paneRoles = ctx.PANE_ROLES || {};
  const { logActivity } = deps;

  const getWatcher = () => {
    const watcher = ctx.watcher;
    if (!watcher || typeof watcher.readState !== 'function') {
      return { ok: false, error: 'state watcher not available' };
    }
    return { ok: true, watcher };
  };

  const QUALITY_RULES = {
    executing: {
      to: ['checkpoint', 'checkpoint_review'],
      validate: true,
    },
    checkpoint_fix: {
      to: ['checkpoint_review'],
      validate: true,
    },
  };

  async function runQualityCheck(paneId, claimedWork) {
    const role = paneRoles[paneId] || `Pane ${paneId}`;
    const issues = [];
    let qualityScore = 100;

    const calculateConfidence = ctx.calculateConfidence;
    const validationResult = typeof calculateConfidence === 'function'
      ? calculateConfidence(claimedWork || '')
      : 50;
    if (validationResult < 50) {
      issues.push({
        type: 'low_confidence',
        severity: 'warning',
        message: `Low completion confidence: ${validationResult}%`,
      });
      qualityScore -= 20;
    }

    const watcher = ctx.watcher;
    const state = watcher && typeof watcher.readState === 'function'
      ? watcher.readState()
      : {};
    if (state.project) {
      try {
        const { execSync } = require('child_process');
        const gitStatus = execSync('git status --porcelain', {
          cwd: state.project,
          encoding: 'utf-8',
        });
        const uncommittedFiles = gitStatus.trim().split('\n').filter(l => l.trim());
        if (uncommittedFiles.length > 0) {
          issues.push({
            type: 'uncommitted_changes',
            severity: 'info',
            message: `${uncommittedFiles.length} uncommitted file(s)`,
            files: uncommittedFiles.slice(0, 5),
          });
        }
      } catch (err) {
        // Not a git repo or git not available - skip
      }
    }

    if (logActivity) {
      logActivity('system', paneId, `Quality check: ${qualityScore}% (${issues.length} issues)`, {
        role,
        qualityScore,
        issues,
      });
    }

    const criticalIssues = issues.filter(i => i.severity === 'error');
    const blocked = criticalIssues.length > 0;

    if (blocked) {
      const mainWindow = ctx.mainWindow;
      if (mainWindow && typeof mainWindow.isDestroyed === 'function' && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('quality-check-failed', {
          paneId,
          role,
          issues: criticalIssues,
        });
      }
    }

    return {
      success: true,
      paneId,
      role,
      qualityScore,
      issues,
      blocked,
      timestamp: new Date().toISOString(),
    };
  }

  ipcMain.handle('check-completion-quality', async (event, paneId, claimedWork) => {
    return runQualityCheck(paneId, claimedWork);
  });

  ipcMain.handle('validate-state-transition', async (event, fromState, toState) => {
    const rule = QUALITY_RULES[fromState];

    if (!rule || !rule.validate || !rule.to.includes(toState)) {
      return { success: true, allowed: true, reason: 'No validation required' };
    }

    const { ok, watcher, error } = getWatcher();
    if (!ok) {
      return {
        success: false,
        allowed: true,
        reason: `${error}; skipping validation`,
        qualityResults: [],
      };
    }
    const state = watcher.readState();
    const activeAgents = state.active_agents || [];
    const qualityResults = [];

    for (const paneId of activeAgents) {
      if (ctx.agentRunning && typeof ctx.agentRunning.get === 'function' &&
          ctx.agentRunning.get(paneId) === 'running') {
        const result = await runQualityCheck(paneId, '');
        qualityResults.push(result);
      }
    }

    const anyBlocked = qualityResults.some(r => r.blocked);

    if (anyBlocked && logActivity) {
      logActivity('system', null, `State transition blocked: ${fromState} -> ${toState}`, {
        qualityResults,
      });
    }

    return {
      success: true,
      allowed: !anyBlocked,
      qualityResults,
      reason: anyBlocked ? 'Quality check failed for one or more agents' : 'All quality checks passed',
    };
  });

  ipcMain.handle('get-quality-rules', () => {
    return QUALITY_RULES;
  });
}

module.exports = { registerCompletionQualityHandlers };
