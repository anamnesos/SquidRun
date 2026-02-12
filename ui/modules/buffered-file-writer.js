const fs = require('fs');

function createBufferedFileWriter(options = {}) {
  const filePath = typeof options.filePath === 'string' ? options.filePath : null;
  const flushIntervalMs = Number.isFinite(options.flushIntervalMs)
    ? Math.max(10, Number(options.flushIntervalMs))
    : 500;
  const ensureDir = typeof options.ensureDir === 'function' ? options.ensureDir : null;
  const onError = typeof options.onError === 'function' ? options.onError : null;
  const maxPendingLines = Number.isFinite(options.maxPendingLines)
    ? Math.max(1, Number(options.maxPendingLines))
    : 2000;

  let queue = [];
  let flushTimer = null;
  let flushing = false;
  let stopped = false;
  let pendingFlushResolvers = [];

  function resolvePendingFlushes() {
    if (pendingFlushResolvers.length === 0) return;
    const resolvers = pendingFlushResolvers;
    pendingFlushResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  function startTimer() {
    if (flushTimer || stopped || !filePath) return;
    flushTimer = setInterval(() => {
      flushInternal();
    }, flushIntervalMs);
    if (flushTimer && typeof flushTimer.unref === 'function') {
      flushTimer.unref();
    }
  }

  function stopTimer() {
    if (!flushTimer) return;
    clearInterval(flushTimer);
    flushTimer = null;
  }

  function emitError(err) {
    if (typeof onError === 'function') {
      onError(err);
    }
  }

  function flushInternal() {
    if (stopped || !filePath) {
      queue = [];
      resolvePendingFlushes();
      return;
    }
    if (flushing) return;
    if (queue.length === 0) {
      resolvePendingFlushes();
      return;
    }

    flushing = true;
    const chunk = queue.join('');
    queue = [];

    fs.appendFile(filePath, chunk, 'utf8', (err) => {
      flushing = false;
      if (err) {
        emitError(err);
      }

      if (queue.length > 0) {
        flushInternal();
        return;
      }

      resolvePendingFlushes();
    });
  }

  function write(line) {
    if (stopped || !filePath) return;

    if (ensureDir) {
      try {
        ensureDir();
      } catch {
        // ensureDir errors are routed through caller path.
      }
    }

    queue.push(String(line || ''));

    if (queue.length > maxPendingLines) {
      // Drop oldest lines when backpressured to keep UI responsive.
      queue.splice(0, queue.length - maxPendingLines);
    }

    startTimer();
  }

  function flush() {
    return new Promise((resolve) => {
      pendingFlushResolvers.push(resolve);
      flushInternal();
    });
  }

  function stop() {
    stopped = true;
    stopTimer();
    return flush();
  }

  return {
    write,
    flush,
    stop,
  };
}

module.exports = {
  createBufferedFileWriter,
};
