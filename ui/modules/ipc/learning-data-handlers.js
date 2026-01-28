/**
 * Learning Data IPC Handlers
 * Channels: record-task-outcome, get-learning-data, get-best-agent-for-task, reset-learning, get-routing-weights
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

function registerLearningDataHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerLearningDataHandlers requires ctx.ipcMain');
  }

  const { ipcMain, WORKSPACE_PATH, PANE_ROLES } = ctx;
  const LEARNING_FILE_PATH = path.join(WORKSPACE_PATH, 'learning.json');

  const DEFAULT_LEARNING = {
    taskTypes: {},
    routingWeights: { '1': 1.0, '2': 1.0, '3': 1.0, '4': 1.0, '5': 1.0, '6': 1.0 },
    totalDecisions: 0,
    lastUpdated: null,
  };

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

    const successRate = agentStats.success / agentStats.attempts;
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
          successRate: stats.attempts > 0 ? stats.success / stats.attempts : 0,
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
        const rate = stats.success / stats.attempts;
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
}

module.exports = { registerLearningDataHandlers };
