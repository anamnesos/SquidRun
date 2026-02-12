const fs = require('fs');
const path = require('path');
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

function registerTestExecutionHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerTestExecutionHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const TEST_RESULTS_PATH = path.join(ctx.WORKSPACE_PATH, 'test-results.json');

  const TEST_FRAMEWORKS = {
    jest: {
      detect: (projectPath) => {
        const pkgPath = path.join(projectPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            return pkg.devDependencies?.jest || pkg.dependencies?.jest ||
                   pkg.scripts?.test?.includes('jest');
          } catch {
            return false;
          }
        }
        return false;
      },
      command: 'npx',
      args: ['jest', '--json', '--testLocationInResults'],
      parseOutput: (output) => {
        try {
          const result = JSON.parse(output);
          return {
            passed: result.numPassedTests || 0,
            failed: result.numFailedTests || 0,
            total: result.numTotalTests || 0,
            duration: result.testResults?.[0]?.perfStats?.runtime || 0,
            failures: result.testResults?.flatMap(r =>
              r.assertionResults?.filter(a => a.status === 'failed').map(a => ({
                test: a.fullName,
                message: a.failureMessages?.join('\n') || '',
              }))
            ) || [],
          };
        } catch {
          return null;
        }
      },
    },
    npm: {
      detect: (projectPath) => {
        const pkgPath = path.join(projectPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            return !!pkg.scripts?.test;
          } catch {
            return false;
          }
        }
        return false;
      },
      command: 'npm',
      args: ['test', '--', '--passWithNoTests'],
      parseOutput: (output) => {
        const passed = (output.match(/(\d+)\s+(passing|passed)/i) || [])[1] || 0;
        const failed = (output.match(/(\d+)\s+(failing|failed)/i) || [])[1] || 0;
        return {
          passed: parseInt(passed),
          failed: parseInt(failed),
          total: parseInt(passed) + parseInt(failed),
          duration: 0,
          failures: [],
          raw: output,
        };
      },
    },
  };

  let activeTestRun = null;

  async function runTests(projectPath, frameworkName = null) {
    if (activeTestRun) {
      return { success: false, error: 'Tests already running' };
    }

    if (!frameworkName) {
      for (const [name, framework] of Object.entries(TEST_FRAMEWORKS)) {
        if (framework.detect(projectPath)) {
          frameworkName = name;
          break;
        }
      }
    }

    if (!frameworkName || !TEST_FRAMEWORKS[frameworkName]) {
      return { success: false, error: 'No test framework detected' };
    }

    const framework = TEST_FRAMEWORKS[frameworkName];
    const runId = `test-${Date.now()}`;

    activeTestRun = {
      id: runId,
      startTime: Date.now(),
      framework: frameworkName,
      status: 'running',
    };

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('test-run-started', { runId, framework: frameworkName });
    }

    try {
      const output = await execFileAsync(framework.command, framework.args, {
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const results = framework.parseOutput(output) || {
        passed: 0,
        failed: 0,
        total: 0,
        raw: output,
      };

      results.runId = runId;
      results.framework = frameworkName;
      results.duration = Date.now() - activeTestRun.startTime;
      results.timestamp = new Date().toISOString();
      results.success = results.failed === 0;

      fs.writeFileSync(TEST_RESULTS_PATH, JSON.stringify(results, null, 2), 'utf-8');

      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('test-run-complete', results);
      }

      activeTestRun = null;
      return { success: true, results };
    } catch (err) {
      const results = {
        runId,
        framework: frameworkName,
        success: false,
        error: err.message,
        output: err.stdout?.toString() || err.stderr?.toString() || '',
        duration: Date.now() - activeTestRun.startTime,
        timestamp: new Date().toISOString(),
      };

      const parsed = framework.parseOutput(results.output);
      if (parsed) {
        Object.assign(results, parsed);
      }

      fs.writeFileSync(TEST_RESULTS_PATH, JSON.stringify(results, null, 2), 'utf-8');

      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('test-run-complete', results);
      }

      activeTestRun = null;
      return { success: true, results };
    }
  }

  ctx.runTests = runTests;

  ipcMain.handle('detect-test-framework', (event, projectPath) => {
    const detected = [];
    for (const [name, framework] of Object.entries(TEST_FRAMEWORKS)) {
      try {
        if (framework.detect(projectPath)) {
          detected.push(name);
        }
      } catch {
        // Skip detection errors
      }
    }
    return {
      success: true,
      frameworks: detected,
      recommended: detected[0] || null,
    };
  });

  ipcMain.handle('run-tests', async (event, projectPath, frameworkName = null) => {
    return runTests(projectPath, frameworkName);
  });

  ipcMain.handle('get-test-results', () => {
    try {
      if (fs.existsSync(TEST_RESULTS_PATH)) {
        const content = fs.readFileSync(TEST_RESULTS_PATH, 'utf-8');
        return { success: true, results: JSON.parse(content) };
      }
      return { success: true, results: null };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-test-status', () => {
    return {
      success: true,
      running: !!activeTestRun,
      currentRun: activeTestRun,
    };
  });
}


function unregisterTestExecutionHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('detect-test-framework');
    ipcMain.removeHandler('run-tests');
    ipcMain.removeHandler('get-test-results');
    ipcMain.removeHandler('get-test-status');
}

registerTestExecutionHandlers.unregister = unregisterTestExecutionHandlers;
module.exports = {
  registerTestExecutionHandlers,
};
