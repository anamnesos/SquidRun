const fs = require('fs');
const path = require('path');

function registerPrecommitHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerPrecommitHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const CI_STATUS_PATH = path.join(ctx.WORKSPACE_PATH, 'ci-status.json');

  let ciEnabled = true;
  let lastCiCheck = null;

  ipcMain.handle('run-pre-commit-checks', async (event, projectPath) => {
    const checkId = `ci-${Date.now()}`;
    const checks = [];
    let allPassed = true;

    let testResult = { success: false, error: 'Test runner unavailable' };
    try {
      if (typeof ctx.runTests === 'function') {
        testResult = await ctx.runTests(projectPath);
      }
    } catch {
      testResult = { success: false, error: 'Test execution failed' };
    }

    if (testResult.results) {
      const testsPassed = testResult.results.failed === 0;
      checks.push({
        name: 'tests',
        passed: testsPassed,
        message: testsPassed
          ? `${testResult.results.passed} tests passed`
          : `${testResult.results.failed} tests failed`,
        details: testResult.results,
      });
      if (!testsPassed) allPassed = false;
    }

    try {
      const { execSync } = require('child_process');
      const stagedFiles = execSync('git diff --cached --name-only', {
        cwd: projectPath,
        encoding: 'utf-8',
      }).trim().split('\n').filter(f => f);

      let validationIssues = 0;
      for (const file of stagedFiles) {
        const filePath = path.join(projectPath, file);
        if (fs.existsSync(filePath) && (file.endsWith('.js') || file.endsWith('.json'))) {
          const content = fs.readFileSync(filePath, 'utf-8');
          const confidence = ctx.calculateConfidence
            ? ctx.calculateConfidence(content)
            : 0;
          if (confidence < 40) {
            validationIssues++;
          }
        }
      }

      checks.push({
        name: 'validation',
        passed: validationIssues === 0,
        message: validationIssues === 0
          ? `${stagedFiles.length} files validated`
          : `${validationIssues} file(s) with low confidence`,
      });
      if (validationIssues > 0) allPassed = false;
    } catch {
      checks.push({
        name: 'validation',
        passed: true,
        message: 'Skipped (not a git repo)',
      });
    }

    try {
      const { execSync } = require('child_process');
      const stagedContent = execSync('git diff --cached', {
        cwd: projectPath,
        encoding: 'utf-8',
      });

      const incompletePatterns = ctx.INCOMPLETE_PATTERNS || [];
      const hasIncomplete = incompletePatterns.some(p => p.test(stagedContent));
      checks.push({
        name: 'incomplete_check',
        passed: !hasIncomplete,
        message: hasIncomplete
          ? 'Found TODO/FIXME markers in staged changes'
          : 'No incomplete markers found',
      });
      if (hasIncomplete) allPassed = false;
    } catch {
      // Skip if git not available
    }

    lastCiCheck = {
      id: checkId,
      timestamp: new Date().toISOString(),
      passed: allPassed,
      checks,
    };

    fs.writeFileSync(CI_STATUS_PATH, JSON.stringify(lastCiCheck, null, 2), 'utf-8');

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('ci-check-complete', lastCiCheck);
    }

    return { success: true, ...lastCiCheck };
  });

  ipcMain.handle('get-ci-status', () => {
    try {
      if (fs.existsSync(CI_STATUS_PATH)) {
        const content = fs.readFileSync(CI_STATUS_PATH, 'utf-8');
        return { success: true, status: JSON.parse(content), enabled: ciEnabled };
      }
      return { success: true, status: null, enabled: ciEnabled };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('set-ci-enabled', (event, enabled) => {
    ciEnabled = enabled;
    console.log(`[CI] Pre-commit checks ${enabled ? 'enabled' : 'disabled'}`);
    return { success: true, enabled: ciEnabled };
  });

  ipcMain.handle('should-block-commit', () => {
    if (!ciEnabled) {
      return { success: true, block: false, reason: 'CI checks disabled' };
    }

    if (!lastCiCheck) {
      return { success: true, block: true, reason: 'No CI check has been run' };
    }

    const checkAge = Date.now() - new Date(lastCiCheck.timestamp).getTime();
    if (checkAge > 5 * 60 * 1000) {
      return { success: true, block: true, reason: 'CI check is stale (> 5 minutes)' };
    }

    return {
      success: true,
      block: !lastCiCheck.passed,
      reason: lastCiCheck.passed ? 'All checks passed' : 'CI checks failed',
      lastCheck: lastCiCheck,
    };
  });
}

module.exports = {
  registerPrecommitHandlers,
};
