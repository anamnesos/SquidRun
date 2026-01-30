/**
 * Cost Optimizer IPC Handlers - Task #24
 *
 * Channels:
 * - cost-get-summary: Get overall cost summary
 * - cost-get-by-agent: Get costs per agent
 * - cost-get-by-task: Get costs per task
 * - cost-record: Record a new cost event
 * - cost-get-history: Get cost history
 * - cost-get-time-series: Get time series data for charts
 * - cost-get-predictions: Get budget predictions
 * - cost-get-optimizations: Get optimization suggestions
 * - cost-set-budget: Set budget limits
 * - cost-get-budget: Get current budget configuration
 * - cost-get-alerts: Get cost alerts
 * - cost-clear-alerts: Clear all alerts
 * - cost-reset: Reset all cost tracking
 * - cost-export: Export cost data
 * - cost-import: Import cost data
 */

const path = require('path');
const fs = require('fs');

function registerCostOptimizerHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;
  if (!ipcMain || !WORKSPACE_PATH) return;

  // Lazy load cost optimizer
  let costOptimizer = null;
  let optimizerInstance = null;

  function getOptimizer() {
    if (!costOptimizer) {
      costOptimizer = require('../analysis/cost-optimizer');
    }
    if (!optimizerInstance) {
      optimizerInstance = costOptimizer.createCostOptimizer({
        historyLimit: 10000,
        budgetAlertThreshold: 0.8,
        anomalyThreshold: 2.0,
      });

      // Load persisted data
      loadPersistedData();
    }
    return optimizerInstance;
  }

  // Persistence paths
  const DATA_PATH = path.join(WORKSPACE_PATH, 'memory', '_cost-data.json');

  /**
   * Load persisted cost data
   */
  function loadPersistedData() {
    try {
      if (fs.existsSync(DATA_PATH)) {
        const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
        optimizerInstance.import(data);
        console.log('[CostOptimizer] Loaded persisted data');
      }
    } catch (err) {
      console.error('[CostOptimizer] Failed to load persisted data:', err);
    }
  }

  /**
   * Save cost data to disk
   */
  function saveData() {
    try {
      const dir = path.dirname(DATA_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = optimizerInstance.export();
      fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[CostOptimizer] Failed to save data:', err);
    }
  }

  /**
   * Get overall cost summary
   */
  ipcMain.handle('cost-get-summary', async () => {
    try {
      const optimizer = getOptimizer();
      const summary = optimizer.getSummary();
      return { success: true, summary };
    } catch (err) {
      console.error('[CostOptimizer] Get summary error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get costs by agent
   */
  ipcMain.handle('cost-get-by-agent', async () => {
    try {
      const optimizer = getOptimizer();
      const agents = optimizer.getCostsByAgent();
      return { success: true, agents };
    } catch (err) {
      console.error('[CostOptimizer] Get by agent error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get costs by task
   */
  ipcMain.handle('cost-get-by-task', async () => {
    try {
      const optimizer = getOptimizer();
      const tasks = optimizer.getCostsByTask();
      return { success: true, tasks };
    } catch (err) {
      console.error('[CostOptimizer] Get by task error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Record a new cost event
   */
  ipcMain.handle('cost-record', async (event, payload = {}) => {
    try {
      const optimizer = getOptimizer();
      const record = optimizer.recordCost(payload);

      // Auto-save after recording
      saveData();

      // Notify renderer of new cost event
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('cost-recorded', record);

        // Send alerts if any were generated
        const alerts = optimizer.getAlerts().filter(a => Date.now() - a.timestamp < 5000);
        if (alerts.length > 0) {
          ctx.mainWindow.webContents.send('cost-alert', alerts[0]);
          if (ctx.externalNotifier && typeof ctx.externalNotifier.notify === 'function') {
            const alert = alerts[0];
            ctx.externalNotifier.notify({
              category: 'alert',
              title: 'Cost alert',
              message: alert.message || 'Cost alert threshold exceeded',
            }).catch(() => {});
          }
        }
      }

      return { success: true, record };
    } catch (err) {
      console.error('[CostOptimizer] Record error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get cost history
   */
  ipcMain.handle('cost-get-history', async (event, payload = {}) => {
    const { limit = 100, agentId, taskId, since } = payload;

    try {
      const optimizer = getOptimizer();
      const history = optimizer.getHistory({ limit, agentId, taskId, since });
      return { success: true, history, total: history.length };
    } catch (err) {
      console.error('[CostOptimizer] Get history error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get time series data for charts
   */
  ipcMain.handle('cost-get-time-series', async (event, payload = {}) => {
    const { granularity = 'day', limit = 30 } = payload;

    try {
      const optimizer = getOptimizer();
      const series = optimizer.getTimeSeries(granularity, limit);
      return { success: true, series };
    } catch (err) {
      console.error('[CostOptimizer] Get time series error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get budget predictions
   */
  ipcMain.handle('cost-get-predictions', async () => {
    try {
      const optimizer = getOptimizer();
      const predictions = optimizer.getPredictions();
      return { success: true, predictions };
    } catch (err) {
      console.error('[CostOptimizer] Get predictions error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get optimization suggestions
   */
  ipcMain.handle('cost-get-optimizations', async () => {
    try {
      const optimizer = getOptimizer();
      const optimizations = optimizer.getOptimizations();
      return { success: true, optimizations };
    } catch (err) {
      console.error('[CostOptimizer] Get optimizations error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Set budget limits
   */
  ipcMain.handle('cost-set-budget', async (event, payload = {}) => {
    const { type, amount, target } = payload;

    if (!type || amount === undefined) {
      return { success: false, error: 'Type and amount required' };
    }

    try {
      const optimizer = getOptimizer();
      const budget = optimizer.setBudget(type, amount, target);
      saveData();
      return { success: true, budget };
    } catch (err) {
      console.error('[CostOptimizer] Set budget error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get current budget configuration
   */
  ipcMain.handle('cost-get-budget', async () => {
    try {
      const optimizer = getOptimizer();
      const summary = optimizer.getSummary();
      return {
        success: true,
        budget: summary.budget,
        usage: summary.budgetUsage,
      };
    } catch (err) {
      console.error('[CostOptimizer] Get budget error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get cost alerts
   */
  ipcMain.handle('cost-get-alerts', async () => {
    try {
      const optimizer = getOptimizer();
      const alerts = optimizer.getAlerts();
      return { success: true, alerts };
    } catch (err) {
      console.error('[CostOptimizer] Get alerts error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Clear all alerts
   */
  ipcMain.handle('cost-clear-alerts', async () => {
    try {
      const optimizer = getOptimizer();
      optimizer.clearAlerts();
      saveData();
      return { success: true };
    } catch (err) {
      console.error('[CostOptimizer] Clear alerts error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Reset all cost tracking
   */
  ipcMain.handle('cost-reset', async () => {
    try {
      const optimizer = getOptimizer();
      optimizer.reset();
      saveData();
      return { success: true };
    } catch (err) {
      console.error('[CostOptimizer] Reset error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Export cost data
   */
  ipcMain.handle('cost-export', async () => {
    try {
      const optimizer = getOptimizer();
      const data = optimizer.export();
      return { success: true, data };
    } catch (err) {
      console.error('[CostOptimizer] Export error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Import cost data
   */
  ipcMain.handle('cost-import', async (event, payload = {}) => {
    const { data } = payload;

    if (!data) {
      return { success: false, error: 'Data required' };
    }

    try {
      const optimizer = getOptimizer();
      optimizer.import(data);
      saveData();
      return { success: true };
    } catch (err) {
      console.error('[CostOptimizer] Import error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Calculate cost estimate for a request (utility)
   */
  ipcMain.handle('cost-estimate', async (event, payload = {}) => {
    const { model = 'default', inputTokens = 0, outputTokens = 0, text } = payload;

    try {
      if (!costOptimizer) {
        costOptimizer = require('../analysis/cost-optimizer');
      }

      let input = inputTokens;
      let output = outputTokens;

      // Estimate from text if provided
      if (text && !inputTokens) {
        input = costOptimizer.estimateTokens(text);
      }

      const cost = costOptimizer.calculateCost(model, input, output);
      const pricing = costOptimizer.getModelPricing(model);

      return {
        success: true,
        estimate: {
          model,
          inputTokens: input,
          outputTokens: output,
          pricing,
          cost,
        },
      };
    } catch (err) {
      console.error('[CostOptimizer] Estimate error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Get model pricing information
   */
  ipcMain.handle('cost-get-pricing', async () => {
    try {
      if (!costOptimizer) {
        costOptimizer = require('../analysis/cost-optimizer');
      }

      return {
        success: true,
        pricing: costOptimizer.MODEL_PRICING,
        thresholds: costOptimizer.COST_THRESHOLDS,
      };
    } catch (err) {
      console.error('[CostOptimizer] Get pricing error:', err);
      return { success: false, error: err.message };
    }
  });

  /**
   * Simulate cost impact of optimization
   */
  ipcMain.handle('cost-simulate-optimization', async (event, payload = {}) => {
    const { optimizationType, targetModel } = payload;

    try {
      const optimizer = getOptimizer();
      const summary = optimizer.getSummary();

      if (!costOptimizer) {
        costOptimizer = require('../analysis/cost-optimizer');
      }

      let savings = 0;
      let description = '';

      if (optimizationType === 'model_downgrade' && targetModel) {
        // Calculate potential savings from model downgrade
        const modelCosts = optimizer.costs.byModel;
        for (const [model, data] of Object.entries(modelCosts)) {
          if (model !== targetModel) {
            const currentPricing = costOptimizer.getModelPricing(model);
            const targetPricing = costOptimizer.getModelPricing(targetModel);

            const currentCost = data.total;
            const newCost = ((data.inputTokens / 1_000_000) * targetPricing.input) +
                           ((data.outputTokens / 1_000_000) * targetPricing.output);

            savings += currentCost - newCost;
          }
        }
        description = `Switching all requests to ${targetModel} would save approximately $${savings.toFixed(2)}`;
      }

      return {
        success: true,
        simulation: {
          optimizationType,
          targetModel,
          potentialSavings: savings,
          description,
          currentTotal: summary.total,
          projectedTotal: summary.total - savings,
        },
      };
    } catch (err) {
      console.error('[CostOptimizer] Simulate error:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerCostOptimizerHandlers };
