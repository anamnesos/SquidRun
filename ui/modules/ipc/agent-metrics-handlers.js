/**
 * Agent Metrics IPC Handlers
 * Combines performance tracking, learning data, usage stats, and activity log.
 *
 * Channels:
 * - Performance: record-completion, record-error, record-response-time, get-performance,
 *   get-performance-stats, reset-performance, reset-performance-stats
 * - Learning: record-task-outcome, get-learning-data, get-best-agent-for-task,
 *   reset-learning, get-routing-weights
 * - Usage stats: get-usage-stats, reset-usage-stats
 * - Activity log: get-activity-log, clear-activity-log, save-activity-log, log-activity
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

function registerAgentMetricsHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerAgentMetricsHandlers requires ctx.ipcMain');
  }

  const { ipcMain, WORKSPACE_PATH, PANE_ROLES } = ctx;
  const {
    saveUsageStats,
    logActivity,
    getActivityLog,
    clearActivityLog,
    saveActivityLog,
  } = deps;

  const PERFORMANCE_FILE_PATH = path.join(WORKSPACE_PATH, 'performance.json');
  const LEARNING_FILE_PATH = path.join(WORKSPACE_PATH, 'learning.json');

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

  const DEFAULT_LEARNING = {
    taskTypes: {},
    routingWeights: { '1': 1.0, '2': 1.0, '3': 1.0, '4': 1.0, '5': 1.0, '6': 1.0 },
    totalDecisions: 0,
    lastUpdated: null,
  };

  const calculateSuccessRate = (successes, failures) => {
    const attempts = successes + failures;
    if (attempts <= 0) return 0;
    return successes / attempts;
  };

  function loadPerformance() {
    try {
      if (fs.existsSync(PERFORMANCE_FILE_PATH)) {
        const content = fs.readFileSync(PERFORMANCE_FILE_PATH, 'utf-8');
        return { ...DEFAULT_PERFORMANCE, ...JSON.parse(content) };
      }
    } catch (err) {
      log.error('Performance', 'Error loading:', err.message);
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
      log.error('Performance', 'Error saving:', err.message);
    }
  }

  function buildPerformanceStats() {
    const perf = loadPerformance();
    const stats = {};

    for (const [paneId, data] of Object.entries(perf.agents)) {
      const completions = data.completions || 0;
      const errors = data.errors || 0;
      const successes = Math.max(0, completions - errors);
      stats[paneId] = {
        ...data,
        role: PANE_ROLES[paneId] || `Pane ${paneId}`,
        avgResponseTime: data.responseCount > 0
          ? Math.round(data.totalResponseTime / data.responseCount)
          : 0,
        successes,
        successRate: calculateSuccessRate(successes, errors),
      };
    }

    return { perf, stats };
  }

  function resetPerformanceData() {
    savePerformance({ ...DEFAULT_PERFORMANCE });
  }

  function loadLearning() {
    try {
      if (fs.existsSync(LEARNING_FILE_PATH)) {
        const content = fs.readFileSync(LEARNING_FILE_PATH, 'utf-8');
        return { ...DEFAULT_LEARNING, ...JSON.parse(content) };
      }
    } catch (err) {
      log.error('Learning', 'Error loading:', err.message);
    }
    return { ...DEFAULT_LEARNING };
  }

  function saveLearning(data) {
    try {
      data.lastUpdated = new Date().toISOString();
      const tempPath = LEARNING_FILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tempPath, LEARNING_FILE_PATH);
    } catch (err) {
      log.error('Learning', 'Error saving:', err.message);
    }
  }

  const missingDependency = (name, fallback = {}) => ({
    success: false,
    error: `${name} not available`,
    ...fallback,
  });

  ipcMain.handle('record-completion', (event, paneId) => {
    const perf = loadPerformance();
    if (!perf.agents[paneId]) {
      perf.agents[paneId] = { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 };
    }
    perf.agents[paneId].completions++;
    savePerformance(perf);

    log.info('Performance', `Pane ${paneId} completion recorded. Total: ${perf.agents[paneId].completions}`);
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
    const { perf, stats } = buildPerformanceStats();
    return {
      success: true,
      agents: stats,
      lastUpdated: perf.lastUpdated,
    };
  });

  ipcMain.handle('get-performance-stats', () => {
    const { perf, stats } = buildPerformanceStats();
    return {
      success: true,
      stats,
      lastUpdated: perf.lastUpdated,
    };
  });

  ipcMain.handle('reset-performance', () => {
    resetPerformanceData();
    return { success: true };
  });

  ipcMain.handle('reset-performance-stats', () => {
    resetPerformanceData();
    return { success: true };
  });

  ipcMain.handle('record-task-outcome', (event, taskType, paneId, success, timeMs) => {
    const learning = loadLearning();

    if (!learning.taskTypes[taskType]) {
      learning.taskTypes[taskType] = {
        agentStats: {},
        totalAttempts: 0,
      };
    }

    const taskData = learning.taskTypes[taskType];

    if (!taskData.agentStats[paneId]) {
      taskData.agentStats[paneId] = {
        success: 0,
        failure: 0,
        totalTime: 0,
        attempts: 0,
      };
    }

    const agentStats = taskData.agentStats[paneId];

    if (success) {
      agentStats.success++;
    } else {
      agentStats.failure++;
    }
    agentStats.attempts++;
    agentStats.totalTime += timeMs || 0;
    taskData.totalAttempts++;
    learning.totalDecisions++;

    const successRate = calculateSuccessRate(agentStats.success, agentStats.failure);
    learning.routingWeights[paneId] = 0.5 + (successRate * 0.5);

    saveLearning(learning);

    log.info('Learning', `${taskType} by pane ${paneId}: ${success ? 'SUCCESS' : 'FAILURE'} (rate: ${(successRate * 100).toFixed(1)}%)`);

    return {
      success: true,
      taskType,
      paneId,
      successRate,
      newWeight: learning.routingWeights[paneId],
    };
  });

  ipcMain.handle('get-learning-data', () => {
    const learning = loadLearning();

    const insights = {};
    for (const [taskType, data] of Object.entries(learning.taskTypes)) {
      const agentRankings = Object.entries(data.agentStats)
        .map(([paneId, stats]) => ({
          paneId,
          role: PANE_ROLES[paneId],
          successRate: stats.attempts > 0 ? calculateSuccessRate(stats.success, stats.failure) : 0,
          avgTime: stats.attempts > 0 ? Math.round(stats.totalTime / stats.attempts) : 0,
          attempts: stats.attempts,
        }))
        .sort((a, b) => b.successRate - a.successRate);

      insights[taskType] = {
        bestAgent: agentRankings[0] || null,
        rankings: agentRankings,
        totalAttempts: data.totalAttempts,
      };
    }

    return {
      success: true,
      taskTypes: learning.taskTypes,
      routingWeights: learning.routingWeights,
      insights,
      totalDecisions: learning.totalDecisions,
      lastUpdated: learning.lastUpdated,
    };
  });

  ipcMain.handle('get-best-agent-for-task', (event, taskType) => {
    const learning = loadLearning();

    const taskData = learning.taskTypes[taskType];
    if (!taskData || Object.keys(taskData.agentStats).length === 0) {
      return { success: true, bestAgent: null, reason: 'No data for task type' };
    }

    let bestAgent = null;
    let bestRate = -1;

    for (const [paneId, stats] of Object.entries(taskData.agentStats)) {
      if (stats.attempts >= 2) {
        const rate = calculateSuccessRate(stats.success, stats.failure);
        if (rate > bestRate) {
          bestRate = rate;
          bestAgent = {
            paneId,
            role: PANE_ROLES[paneId],
            successRate: rate,
            avgTime: Math.round(stats.totalTime / stats.attempts),
            attempts: stats.attempts,
          };
        }
      }
    }

    return {
      success: true,
      bestAgent,
      reason: bestAgent ? `${(bestRate * 100).toFixed(0)}% success rate` : 'Insufficient data',
    };
  });

  ipcMain.handle('reset-learning', () => {
    saveLearning({ ...DEFAULT_LEARNING });
    log.info('Learning', 'Reset all learning data');
    return { success: true };
  });

  ipcMain.handle('get-routing-weights', () => {
    const learning = loadLearning();
    return {
      success: true,
      weights: learning.routingWeights,
    };
  });

  ipcMain.handle('get-usage-stats', () => {
    const formatDuration = (ms) => {
      const seconds = Math.floor(ms / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      if (hours > 0) return `${hours}h ${minutes % 60}m`;
      if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
      return `${seconds}s`;
    };

    const COST_PER_MINUTE = 0.05;
    const totalMinutes = ctx.usageStats.totalSessionTimeMs / 60000;
    const estimatedCost = totalMinutes * COST_PER_MINUTE;
    const costStr = estimatedCost.toFixed(2);

    if (ctx.currentSettings.costAlertEnabled && !ctx.costAlertSent) {
      const threshold = ctx.currentSettings.costAlertThreshold || 5.00;
      if (parseFloat(costStr) >= threshold) {
        ctx.costAlertSent = true;
        log.info('Cost Alert', `Threshold exceeded: $${costStr} >= $${threshold}`);
        if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.webContents.send('cost-alert', {
            cost: costStr,
            threshold: threshold,
            message: `Cost alert: Session cost ($${costStr}) has exceeded your threshold ($${threshold.toFixed(2)})`
          });
        }
        if (ctx.externalNotifier && typeof ctx.externalNotifier.notify === 'function') {
          ctx.externalNotifier.notify({
            category: 'alert',
            title: 'Cost alert',
            message: `Session cost ($${costStr}) exceeded threshold ($${threshold.toFixed(2)})`,
          }).catch(() => {});
        }
      }
    }

    return {
      totalSpawns: ctx.usageStats.totalSpawns,
      spawnsPerPane: ctx.usageStats.spawnsPerPane,
      totalSessionTime: formatDuration(ctx.usageStats.totalSessionTimeMs),
      totalSessionTimeMs: ctx.usageStats.totalSessionTimeMs,
      sessionTimePerPane: Object.fromEntries(
        Object.entries(ctx.usageStats.sessionTimePerPane).map(([k, v]) => [k, formatDuration(v)])
      ),
      sessionsToday: ctx.usageStats.sessionsToday,
      lastResetDate: ctx.usageStats.lastResetDate,
      estimatedCost: costStr,
      estimatedCostPerPane: Object.fromEntries(
        Object.entries(ctx.usageStats.sessionTimePerPane).map(([k, v]) => [k, ((v / 60000) * COST_PER_MINUTE).toFixed(2)])
      ),
      recentSessions: ctx.usageStats.history.slice(-10).map(s => ({
        ...s,
        durationFormatted: formatDuration(s.duration),
      })),
      costAlertEnabled: ctx.currentSettings.costAlertEnabled,
      costAlertThreshold: ctx.currentSettings.costAlertThreshold,
      costAlertSent: ctx.costAlertSent,
    };
  });

  ipcMain.handle('reset-usage-stats', () => {
    ctx.usageStats.totalSpawns = 0;
    ctx.usageStats.spawnsPerPane = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 };
    ctx.usageStats.totalSessionTimeMs = 0;
    ctx.usageStats.sessionTimePerPane = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 };
    ctx.usageStats.sessionsToday = 0;
    ctx.usageStats.lastResetDate = new Date().toISOString().split('T')[0];
    ctx.usageStats.history = [];
    ctx.costAlertSent = false;
    saveUsageStats();
    return { success: true };
  });

  ipcMain.handle('get-activity-log', (event, filter = {}) => {
    if (typeof getActivityLog !== 'function') {
      return missingDependency('activity log provider', { entries: [], total: 0 });
    }
    const entries = getActivityLog(filter);
    return {
      success: true,
      entries,
      total: entries.length,
    };
  });

  ipcMain.handle('clear-activity-log', () => {
    if (typeof clearActivityLog !== 'function') {
      return missingDependency('activity log provider');
    }
    clearActivityLog();
    log.info('Activity', 'Log cleared');
    return { success: true };
  });

  ipcMain.handle('save-activity-log', () => {
    if (typeof saveActivityLog !== 'function') {
      return missingDependency('activity log provider');
    }
    saveActivityLog();
    return { success: true };
  });

  ipcMain.handle('log-activity', (event, type, paneId, message, details = {}) => {
    if (typeof logActivity !== 'function') {
      return missingDependency('activity log provider');
    }
    logActivity(type, paneId, message, details);
    return { success: true };
  });
}

module.exports = { registerAgentMetricsHandlers };
