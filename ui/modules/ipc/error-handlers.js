function registerErrorHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerErrorHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  const ERROR_MESSAGES = {
    DAEMON_NOT_CONNECTED: {
      title: 'Daemon Disconnected',
      message: 'Terminal daemon is not running.',
      recovery: 'Run "npm run daemon:start" in the ui folder, then restart the app.',
    },
    CLAUDE_NOT_FOUND: {
      title: 'CLI Not Found',
      message: 'Agent CLI is not installed or not in PATH.',
      recovery: 'Verify the CLI command for this pane or install the missing CLI.',
    },
    PROJECT_NOT_FOUND: {
      title: 'Project Not Found',
      message: 'The selected project folder does not exist.',
      recovery: 'Click "Select Project" to choose a valid folder.',
    },
    FILE_WRITE_ERROR: {
      title: 'File Write Failed',
      message: 'Could not write to file. Check permissions.',
      recovery: 'Ensure the file is not locked and you have write permissions.',
    },
    TEST_TIMEOUT: {
      title: 'Test Timeout',
      message: 'Tests took too long to complete.',
      recovery: 'Check for infinite loops or long-running tests. Increase timeout in settings.',
    },
    GIT_NOT_FOUND: {
      title: 'Git Not Found',
      message: 'Git is not installed or not in PATH.',
      recovery: 'Install Git from https://git-scm.com/',
    },
    VALIDATION_FAILED: {
      title: 'Validation Failed',
      message: 'Content validation found issues.',
      recovery: 'Check activity log for details. Fix incomplete markers.',
    },
    STATE_TRANSITION_BLOCKED: {
      title: 'Transition Blocked',
      message: 'Cannot change state due to workflow rules.',
      recovery: 'Ensure Reviewer has approved the plan before starting work.',
    },
  };

  ipcMain.handle('get-error-message', (event, errorCode) => {
    const errorInfo = ERROR_MESSAGES[errorCode];
    if (!errorInfo) {
      return {
        success: false,
        error: 'Unknown error code',
        fallback: {
          title: 'Error',
          message: `An error occurred: ${errorCode}`,
          recovery: 'Check the console for more details.',
        },
      };
    }
    return { success: true, ...errorInfo };
  });

  ipcMain.handle('show-error-toast', (event, errorCode, additionalInfo = {}) => {
    const errorInfo = ERROR_MESSAGES[errorCode] || {
      title: 'Error',
      message: additionalInfo.message || 'An unexpected error occurred.',
      recovery: 'Check the console for details.',
    };

    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
      ctx.mainWindow.webContents.send('error-toast', {
        ...errorInfo,
        code: errorCode,
        timestamp: new Date().toISOString(),
        ...additionalInfo,
      });
    }

    if (typeof deps.logActivity === 'function') {
      deps.logActivity('error', null, `${errorInfo.title}: ${errorInfo.message}`, {
        code: errorCode,
        recovery: errorInfo.recovery,
        ...additionalInfo,
      });
    }

    console.error(`[Error] ${errorInfo.title}: ${errorInfo.message}`);

    return { success: true, shown: true };
  });

  ipcMain.handle('list-error-codes', () => {
    return {
      success: true,
      codes: Object.keys(ERROR_MESSAGES),
      errors: ERROR_MESSAGES,
    };
  });

  ipcMain.handle('handle-error', (event, error, context = {}) => {
    const errorStr = error?.message || String(error);
    let code = 'UNKNOWN';

    if (errorStr.includes('daemon') || errorStr.includes('not connected')) {
      code = 'DAEMON_NOT_CONNECTED';
    } else if ((errorStr.includes('claude') || errorStr.includes('codex') || errorStr.includes('gemini')) && errorStr.includes('not found')) {
      code = 'CLAUDE_NOT_FOUND';
    } else if (errorStr.includes('ENOENT') || errorStr.includes('not found')) {
      code = 'PROJECT_NOT_FOUND';
    } else if (errorStr.includes('EACCES') || errorStr.includes('permission')) {
      code = 'FILE_WRITE_ERROR';
    } else if (errorStr.includes('timeout')) {
      code = 'TEST_TIMEOUT';
    } else if (errorStr.includes('git')) {
      code = 'GIT_NOT_FOUND';
    }

    ipcMain.emit('show-error-toast', event, code, { originalError: errorStr, ...context });

    return { success: true, code, handled: true };
  });

  ipcMain.handle('full-restart', async () => {
    const { app } = require('electron');

    console.log('[Full Restart] Initiating full restart...');

    if (ctx.daemonClient) {
      try {
        ctx.daemonClient.shutdown();
        console.log('[Full Restart] Sent shutdown to daemon');
      } catch (err) {
        console.log('[Full Restart] Error shutting down daemon:', err.message);
      }
    }

    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const { spawn } = require('child_process');

    if (os.platform() === 'win32') {
      try {
        const daemonPidPath = path.join(__dirname, '..', 'daemon.pid');
        if (fs.existsSync(daemonPidPath)) {
          const pid = fs.readFileSync(daemonPidPath, 'utf-8').trim();
          spawn('taskkill', ['/pid', pid, '/f', '/t'], { shell: true, detached: true });
          fs.unlinkSync(daemonPidPath);
          console.log('[Full Restart] Killed daemon PID:', pid);
        }
      } catch (err) {
        console.log('[Full Restart] Error killing daemon:', err.message);
      }
    }

    console.log('[Full Restart] Shutting down. Please run "npm start" to restart.');
    app.exit(0);

    return { success: true };
  });
}

module.exports = {
  registerErrorHandlers,
};
