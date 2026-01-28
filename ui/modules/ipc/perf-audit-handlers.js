const fs = require('fs');
const path = require('path');

function registerPerfAuditHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerPerfAuditHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const PERF_PROFILE_PATH = path.join(ctx.WORKSPACE_PATH, 'perf-profile.json');

  const perfProfile = {
    handlers: {},
    slowCalls: [],
    enabled: true,
    slowThreshold: 100,
  };

  try {
    if (fs.existsSync(PERF_PROFILE_PATH)) {
      const content = fs.readFileSync(PERF_PROFILE_PATH, 'utf-8');
      Object.assign(perfProfile, JSON.parse(content));
    }
  } catch (err) {
    console.error('[Perf] Error loading profile:', err.message);
  }

  function recordHandlerPerf(handler, durationMs) {
    if (!perfProfile.enabled) return;

    if (!perfProfile.handlers[handler]) {
      perfProfile.handlers[handler] = {
        calls: 0,
        totalMs: 0,
        avgMs: 0,
        maxMs: 0,
        minMs: Infinity,
      };
    }

    const stats = perfProfile.handlers[handler];
    stats.calls++;
    stats.totalMs += durationMs;
    stats.avgMs = Math.round(stats.totalMs / stats.calls);
    stats.maxMs = Math.max(stats.maxMs, durationMs);
    stats.minMs = Math.min(stats.minMs, durationMs);

    if (durationMs > perfProfile.slowThreshold) {
      perfProfile.slowCalls.push({
        handler,
        duration: durationMs,
        timestamp: new Date().toISOString(),
      });

      if (perfProfile.slowCalls.length > 50) {
        perfProfile.slowCalls.shift();
      }

      console.log(`[Perf] Slow call: ${handler} took ${durationMs}ms`);
    }
  }

  ctx.recordHandlerPerf = recordHandlerPerf;

  function savePerfProfile() {
    try {
      const tempPath = PERF_PROFILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(perfProfile, null, 2), 'utf-8');
      fs.renameSync(tempPath, PERF_PROFILE_PATH);
    } catch (err) {
      console.error('[Perf] Error saving profile:', err.message);
    }
  }

  ipcMain.handle('get-perf-profile', () => {
    const sortedByAvg = Object.entries(perfProfile.handlers)
      .map(([handler, stats]) => ({ handler, ...stats }))
      .sort((a, b) => b.avgMs - a.avgMs);

    const sortedByCalls = Object.entries(perfProfile.handlers)
      .map(([handler, stats]) => ({ handler, ...stats }))
      .sort((a, b) => b.calls - a.calls);

    const totalCalls = Object.values(perfProfile.handlers)
      .reduce((sum, s) => sum + s.calls, 0);

    const totalTime = Object.values(perfProfile.handlers)
      .reduce((sum, s) => sum + s.totalMs, 0);

    return {
      success: true,
      handlers: perfProfile.handlers,
      slowCalls: perfProfile.slowCalls.slice(-20),
      slowThreshold: perfProfile.slowThreshold,
      enabled: perfProfile.enabled,
      summary: {
        totalHandlers: Object.keys(perfProfile.handlers).length,
        totalCalls,
        totalTimeMs: totalTime,
        avgCallTime: totalCalls > 0 ? Math.round(totalTime / totalCalls) : 0,
        slowestHandlers: sortedByAvg.slice(0, 5),
        mostCalled: sortedByCalls.slice(0, 5),
      },
    };
  });

  ipcMain.handle('set-perf-enabled', (event, enabled) => {
    perfProfile.enabled = enabled;
    console.log(`[Perf] Profiling ${enabled ? 'enabled' : 'disabled'}`);
    return { success: true, enabled };
  });

  ipcMain.handle('set-slow-threshold', (event, thresholdMs) => {
    perfProfile.slowThreshold = thresholdMs;
    console.log(`[Perf] Slow threshold set to ${thresholdMs}ms`);
    return { success: true, threshold: thresholdMs };
  });

  ipcMain.handle('reset-perf-profile', () => {
    perfProfile.handlers = {};
    perfProfile.slowCalls = [];
    savePerfProfile();
    console.log('[Perf] Profile reset');
    return { success: true };
  });

  ipcMain.handle('save-perf-profile', () => {
    savePerfProfile();
    return { success: true, path: PERF_PROFILE_PATH };
  });

  ipcMain.handle('get-slow-handlers', (event, limit = 10) => {
    const sorted = Object.entries(perfProfile.handlers)
      .map(([handler, stats]) => ({ handler, ...stats }))
      .filter(h => h.avgMs > 0)
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, limit);

    return {
      success: true,
      handlers: sorted,
      threshold: perfProfile.slowThreshold,
    };
  });

  ipcMain.handle('get-handler-perf', (event, handlerName) => {
    const stats = perfProfile.handlers[handlerName];
    if (!stats) {
      return { success: false, error: 'No performance data for handler' };
    }

    const slowCalls = perfProfile.slowCalls
      .filter(c => c.handler === handlerName)
      .slice(-10);

    return {
      success: true,
      handler: handlerName,
      stats,
      slowCalls,
    };
  });

  ipcMain.handle('benchmark-handler', async (event, handlerName, iterations = 10) => {
    const times = [];
    const benchmarkHandlers = ctx.benchmarkHandlers || {};
    const target = benchmarkHandlers[handlerName];

    if (typeof target !== 'function') {
      return { success: false, error: 'Handler not benchmarkable' };
    }

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      try {
        await target();
      } catch {
        // Ignore errors during benchmark
      }
      times.push(Date.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);

    return {
      success: true,
      handler: handlerName,
      iterations,
      avgMs: Math.round(avg),
      minMs: min,
      maxMs: max,
      times,
    };
  });

  if (ctx.perfAuditInterval) {
    clearInterval(ctx.perfAuditInterval);
  }

  ctx.perfAuditInterval = setInterval(() => {
    if (Object.keys(perfProfile.handlers).length > 0) {
      savePerfProfile();
    }
  }, 60000);
}

module.exports = {
  registerPerfAuditHandlers,
};
