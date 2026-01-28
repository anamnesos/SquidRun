/**
 * Performance Tracking IPC Handlers
 * Channels: record-completion, record-error, record-response-time, get-performance, reset-performance
 */

const fs = require('fs');
const path = require('path');

function registerPerformanceTrackingHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH, PANE_ROLES } = ctx;

  const PERFORMANCE_FILE_PATH = path.join(WORKSPACE_PATH, 'performance.json');

  const DEFAULT_PERFORMANCE = {
    agents: {
      '1': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '2': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '3': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '4': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '5': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '6': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
    },
    lastUpdated: null,
  };

  function loadPerformance() {
    try {
      if (fs.existsSync(PERFORMANCE_FILE_PATH)) {
        const content = fs.readFileSync(PERFORMANCE_FILE_PATH, 'utf-8');
        return { ...DEFAULT_PERFORMANCE, ...JSON.parse(content) };
      }
    } catch (err) {
      console.error('[Performance] Error loading:', err.message);
    }
    return { ...DEFAULT_PERFORMANCE };
  }

  function savePerformance(data) {
    try {
      data.lastUpdated = new Date().toISOString();
      const tempPath = PERFORMANCE_FILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tempPath, PERFORMANCE_FILE_PATH);
    } catch (err) {
      console.error('[Performance] Error saving:', err.message);
    }
  }

  ipcMain.handle('record-completion', (event, paneId) => {
    const perf = loadPerformance();
    if (!perf.agents[paneId]) {
      perf.agents[paneId] = { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 };
    }
    perf.agents[paneId].completions++;
    savePerformance(perf);

    console.log(`[Performance] Pane ${paneId} completion recorded. Total: ${perf.agents[paneId].completions}`);
    return { success: true, completions: perf.agents[paneId].completions };
  });

  ipcMain.handle('record-error', (event, paneId) => {
    const perf = loadPerformance();
    if (!perf.agents[paneId]) {
      perf.agents[paneId] = { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 };
    }
    perf.agents[paneId].errors++;
    savePerformance(perf);

    return { success: true, errors: perf.agents[paneId].errors };
  });

  ipcMain.handle('record-response-time', (event, paneId, timeMs) => {
    const perf = loadPerformance();
    if (!perf.agents[paneId]) {
      perf.agents[paneId] = { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 };
    }
    perf.agents[paneId].totalResponseTime += timeMs;
    perf.agents[paneId].responseCount++;
    savePerformance(perf);

    const avg = Math.round(perf.agents[paneId].totalResponseTime / perf.agents[paneId].responseCount);
    return { success: true, avgResponseTime: avg };
  });

  ipcMain.handle('get-performance', () => {
    const perf = loadPerformance();

    const stats = {};
    for (const [paneId, data] of Object.entries(perf.agents)) {
      stats[paneId] = {
        ...data,
        role: PANE_ROLES[paneId] || `Pane ${paneId}`,
        avgResponseTime: data.responseCount > 0
          ? Math.round(data.totalResponseTime / data.responseCount)
          : 0,
      };
    }

    return {
      success: true,
      agents: stats,
      lastUpdated: perf.lastUpdated,
    };
  });

  ipcMain.handle('reset-performance', () => {
    savePerformance({ ...DEFAULT_PERFORMANCE });
    return { success: true };
  });
}

module.exports = { registerPerformanceTrackingHandlers };
