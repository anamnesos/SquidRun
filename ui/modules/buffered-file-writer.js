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
  const rotateMaxBytes = Number.isFinite(options.rotateMaxBytes) && Number(options.rotateMaxBytes) > 0
    ? Number(options.rotateMaxBytes)
    : 0;
  const rotateMaxFiles = Number.isFinite(options.rotateMaxFiles)
    ? Math.max(0, Math.floor(Number(options.rotateMaxFiles)))
    : 0;
  const rotationEnabled = Boolean(filePath && rotateMaxBytes > 0 && rotateMaxFiles > 0);

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

  function renameIfExists(sourcePath, targetPath, done) {
    if (typeof fs.rename !== 'function') {
      done();
      return;
    }
    fs.rename(sourcePath, targetPath, (err) => {
      if (err && err.code !== 'ENOENT') {
        done(err);
        return;
      }
      done();
    });
  }

  function removeIfExists(targetPath, done) {
    if (typeof fs.unlink !== 'function') {
      done();
      return;
    }
    fs.unlink(targetPath, (err) => {
      if (err && err.code !== 'ENOENT') {
        done(err);
        return;
      }
      done();
    });
  }

  function shiftRotatedFiles(index, done) {
    if (index < 1) {
      renameIfExists(filePath, `${filePath}.1`, done);
      return;
    }
    const sourcePath = `${filePath}.${index}`;
    const targetPath = `${filePath}.${index + 1}`;
    renameIfExists(sourcePath, targetPath, (err) => {
      if (err) {
        done(err);
        return;
      }
      shiftRotatedFiles(index - 1, done);
    });
  }

  function rotateFiles(done) {
    const oldestPath = `${filePath}.${rotateMaxFiles}`;
    removeIfExists(oldestPath, (removeErr) => {
      if (removeErr) {
        done(removeErr);
        return;
      }
      shiftRotatedFiles(rotateMaxFiles - 1, done);
    });
  }

  function rotateIfNeeded(chunk, done) {
    if (!rotationEnabled || typeof fs.stat !== 'function') {
      done();
      return;
    }

    const incomingBytes = Buffer.byteLength(chunk, 'utf8');
    fs.stat(filePath, (statErr, stats) => {
      if (statErr) {
        if (statErr.code === 'ENOENT') {
          done();
          return;
        }
        done(statErr);
        return;
      }

      const size = stats && typeof stats.size === 'number' ? stats.size : 0;
      if ((size + incomingBytes) <= rotateMaxBytes) {
        done();
        return;
      }

      rotateFiles(done);
    });
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

    rotateIfNeeded(chunk, (rotateErr) => {
      if (rotateErr) {
        emitError(rotateErr);
      }

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
