'use strict';

function errorDetails(error) {
  const message = String(error?.message || error || 'unknown startup failure');
  return {
    message,
    stack: error?.stack ? String(error.stack) : null,
  };
}

function createBootFailurePolicy(options = {}) {
  const appRef = options.app;
  const dialogRef = options.dialog;
  const processRef = options.processRef || process;
  let logger = options.log || console;
  let breadcrumb = typeof options.breadcrumb === 'function' ? options.breadcrumb : () => {};
  let bootComplete = false;
  let exitRequested = false;

  function logError(label, details) {
    try {
      logger?.error?.(`[Main] ${label}:`, details.message);
      if (details.stack) logger?.error?.('[Main] Stack:', details.stack);
    } catch {
      // A broken logger must not suppress the fatal exit path.
    }
  }

  function requestFatalExit(stage, error) {
    const details = errorDetails(error);
    logError(`Fatal startup failure (${stage})`, details);
    try {
      breadcrumb('main:boot-fatal', {
        stage,
        error: details.message,
        stack: details.stack,
      });
    } catch {
      // Diagnostics are best effort; releasing the lock is mandatory.
    }

    if (exitRequested) {
      return { fatal: true, duplicate: true, stage, ...details };
    }
    exitRequested = true;

    try {
      dialogRef?.showErrorBox?.(
        'SquidRun could not start',
        `${details.message}\n\nThe app will close so it can be repaired and opened again.`
      );
    } catch {
      // Native error UI is best effort; never trade it for another ghost lock.
    }

    if (typeof appRef?.exit === 'function') {
      appRef.exit(1);
    } else {
      processRef.exitCode = 1;
      if (typeof processRef.exit === 'function') processRef.exit(1);
    }
    return { fatal: true, duplicate: false, stage, ...details };
  }

  function logRuntimeError(label, error) {
    const details = errorDetails(error);
    logError(label, details);
    return { fatal: false, ...details };
  }

  return {
    setReporter(next = {}) {
      if (next.log) logger = next.log;
      if (typeof next.breadcrumb === 'function') breadcrumb = next.breadcrumb;
    },
    markBootComplete() {
      bootComplete = true;
    },
    handleUncaughtException(error) {
      return bootComplete
        ? logRuntimeError('Uncaught exception', error)
        : requestFatalExit('uncaught_exception', error);
    },
    handleUnhandledRejection(reason) {
      return bootComplete
        ? logRuntimeError('Unhandled rejection', reason)
        : requestFatalExit('unhandled_rejection', reason);
    },
    handleInitFailure(error) {
      return requestFatalExit('app_init', error);
    },
    getState() {
      return { bootComplete, exitRequested };
    },
  };
}

module.exports = {
  createBootFailurePolicy,
  errorDetails,
};
