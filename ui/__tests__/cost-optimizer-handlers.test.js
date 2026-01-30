/**
 * Cost Optimizer IPC Handlers Tests
 * Target: Full coverage of modules/ipc/cost-optimizer-handlers.js
 */

// Mock fs - use inline factory to avoid hoisting issues
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock the cost-optimizer module
const mockOptimizer = {
  getSummary: jest.fn(),
  getCostsByAgent: jest.fn(),
  getCostsByTask: jest.fn(),
  recordCost: jest.fn(),
  getHistory: jest.fn(),
  getTimeSeries: jest.fn(),
  getPredictions: jest.fn(),
  getOptimizations: jest.fn(),
  setBudget: jest.fn(),
  getAlerts: jest.fn(),
  clearAlerts: jest.fn(),
  reset: jest.fn(),
  export: jest.fn(),
  import: jest.fn(),
  costs: { byModel: {} },
};

jest.mock('../modules/analysis/cost-optimizer', () => ({
  createCostOptimizer: jest.fn(() => mockOptimizer),
  estimateTokens: jest.fn((text) => text.length / 4),
  calculateCost: jest.fn(() => 0.05),
  getModelPricing: jest.fn(() => ({ input: 3, output: 15 })),
  MODEL_PRICING: { 'claude-3-opus': { input: 15, output: 75 } },
  COST_THRESHOLDS: { warning: 0.8, critical: 1.0 },
}));

const { registerCostOptimizerHandlers } = require('../modules/ipc/cost-optimizer-handlers');
const fs = require('fs');

describe('Cost Optimizer IPC Handlers', () => {
  let mockIpcMain;
  let handlers;
  let mockCtx;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mock implementations
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue('{}');
    fs.writeFileSync.mockImplementation(() => {});
    fs.mkdirSync.mockImplementation(() => {});

    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
    };

    mockCtx = {
      ipcMain: mockIpcMain,
      WORKSPACE_PATH: '/test/workspace',
      mainWindow: {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: {
          send: jest.fn(),
        },
      },
    };

    // Reset mock optimizer
    mockOptimizer.getSummary.mockReturnValue({ total: 10.50, budget: { daily: 100 }, budgetUsage: 0.1 });
    mockOptimizer.getCostsByAgent.mockReturnValue({ '1': 5.25, '2': 5.25 });
    mockOptimizer.getCostsByTask.mockReturnValue({ 'task-1': 3.00, 'task-2': 7.50 });
    mockOptimizer.recordCost.mockReturnValue({ id: 'cost-1', amount: 0.05 });
    mockOptimizer.getHistory.mockReturnValue([{ id: 'cost-1', amount: 0.05 }]);
    mockOptimizer.getTimeSeries.mockReturnValue([{ date: '2026-01-30', total: 5.00 }]);
    mockOptimizer.getPredictions.mockReturnValue({ daily: 10.00, weekly: 70.00 });
    mockOptimizer.getOptimizations.mockReturnValue([{ type: 'use_haiku', savings: 5.00 }]);
    mockOptimizer.setBudget.mockReturnValue({ type: 'daily', amount: 100 });
    mockOptimizer.getAlerts.mockReturnValue([{ type: 'budget_warning', timestamp: Date.now() }]);
    mockOptimizer.export.mockReturnValue({ history: [], budgets: [] });
    mockOptimizer.costs = { byModel: {} };
  });

  describe('registerCostOptimizerHandlers', () => {
    test('returns early if ipcMain is missing', () => {
      registerCostOptimizerHandlers({ WORKSPACE_PATH: '/test' });

      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('returns early if WORKSPACE_PATH is missing', () => {
      registerCostOptimizerHandlers({ ipcMain: mockIpcMain });

      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('registers all expected handlers', () => {
      registerCostOptimizerHandlers(mockCtx);

      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-summary', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-by-agent', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-by-task', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-record', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-history', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-time-series', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-predictions', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-optimizations', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-set-budget', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-budget', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-alerts', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-clear-alerts', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-reset', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-export', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-import', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-estimate', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-get-pricing', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('cost-simulate-optimization', expect.any(Function));
    });
  });

  describe('cost-get-summary', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns cost summary', async () => {
      const result = await handlers['cost-get-summary']({});

      expect(result.success).toBe(true);
      expect(result.summary).toBeDefined();
      expect(result.summary.total).toBe(10.50);
    });

    test('handles errors', async () => {
      mockOptimizer.getSummary.mockImplementation(() => {
        throw new Error('Summary failed');
      });

      const result = await handlers['cost-get-summary']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Summary failed');
    });
  });

  describe('cost-get-by-agent', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns costs by agent', async () => {
      const result = await handlers['cost-get-by-agent']({});

      expect(result.success).toBe(true);
      expect(result.agents['1']).toBe(5.25);
      expect(result.agents['2']).toBe(5.25);
    });

    test('handles errors', async () => {
      mockOptimizer.getCostsByAgent.mockImplementation(() => {
        throw new Error('Agent cost error');
      });

      const result = await handlers['cost-get-by-agent']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent cost error');
    });
  });

  describe('cost-get-by-task', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns costs by task', async () => {
      const result = await handlers['cost-get-by-task']({});

      expect(result.success).toBe(true);
      expect(result.tasks['task-1']).toBe(3.00);
    });

    test('handles errors', async () => {
      mockOptimizer.getCostsByTask.mockImplementation(() => {
        throw new Error('Task cost error');
      });

      const result = await handlers['cost-get-by-task']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Task cost error');
    });
  });

  describe('cost-record', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('records a cost event', async () => {
      const result = await handlers['cost-record']({}, { model: 'claude-3-opus', tokens: 1000 });

      expect(result.success).toBe(true);
      expect(result.record.id).toBe('cost-1');
      expect(mockOptimizer.recordCost).toHaveBeenCalledWith({ model: 'claude-3-opus', tokens: 1000 });
    });

    test('saves data after recording', async () => {
      await handlers['cost-record']({}, {});

      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('notifies renderer of new cost event', async () => {
      await handlers['cost-record']({}, {});

      expect(mockCtx.mainWindow.webContents.send).toHaveBeenCalledWith('cost-recorded', expect.any(Object));
    });

    test('sends alert if recent alert exists', async () => {
      mockOptimizer.getAlerts.mockReturnValue([{ type: 'budget_warning', timestamp: Date.now() }]);

      await handlers['cost-record']({}, {});

      expect(mockCtx.mainWindow.webContents.send).toHaveBeenCalledWith('cost-alert', expect.any(Object));
    });

    test('does not send alert if alert is old', async () => {
      mockOptimizer.getAlerts.mockReturnValue([{ type: 'budget_warning', timestamp: Date.now() - 10000 }]);

      await handlers['cost-record']({}, {});

      // Should only be called once for 'cost-recorded', not 'cost-alert'
      expect(mockCtx.mainWindow.webContents.send).toHaveBeenCalledTimes(1);
    });

    test('handles destroyed window gracefully', async () => {
      mockCtx.mainWindow.isDestroyed.mockReturnValue(true);

      const result = await handlers['cost-record']({}, {});

      expect(result.success).toBe(true);
      expect(mockCtx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('handles missing window gracefully', async () => {
      mockCtx.mainWindow = null;
      registerCostOptimizerHandlers(mockCtx);

      const result = await handlers['cost-record']({}, {});

      expect(result.success).toBe(true);
    });

    test('handles errors', async () => {
      mockOptimizer.recordCost.mockImplementation(() => {
        throw new Error('Record failed');
      });

      const result = await handlers['cost-record']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Record failed');
    });
  });

  describe('cost-get-history', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns cost history with defaults', async () => {
      const result = await handlers['cost-get-history']({}, {});

      expect(result.success).toBe(true);
      expect(result.history).toHaveLength(1);
      expect(mockOptimizer.getHistory).toHaveBeenCalledWith({
        limit: 100,
        agentId: undefined,
        taskId: undefined,
        since: undefined,
      });
    });

    test('returns cost history with custom options', async () => {
      const result = await handlers['cost-get-history']({}, {
        limit: 50,
        agentId: '1',
        taskId: 'task-1',
        since: 1234567890,
      });

      expect(result.success).toBe(true);
      expect(mockOptimizer.getHistory).toHaveBeenCalledWith({
        limit: 50,
        agentId: '1',
        taskId: 'task-1',
        since: 1234567890,
      });
    });

    test('handles errors', async () => {
      mockOptimizer.getHistory.mockImplementation(() => {
        throw new Error('History error');
      });

      const result = await handlers['cost-get-history']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('History error');
    });
  });

  describe('cost-get-time-series', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns time series with defaults', async () => {
      const result = await handlers['cost-get-time-series']({}, {});

      expect(result.success).toBe(true);
      expect(result.series).toHaveLength(1);
      expect(mockOptimizer.getTimeSeries).toHaveBeenCalledWith('day', 30);
    });

    test('returns time series with custom options', async () => {
      const result = await handlers['cost-get-time-series']({}, {
        granularity: 'hour',
        limit: 24,
      });

      expect(result.success).toBe(true);
      expect(mockOptimizer.getTimeSeries).toHaveBeenCalledWith('hour', 24);
    });

    test('handles errors', async () => {
      mockOptimizer.getTimeSeries.mockImplementation(() => {
        throw new Error('Time series error');
      });

      const result = await handlers['cost-get-time-series']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Time series error');
    });
  });

  describe('cost-get-predictions', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns predictions', async () => {
      const result = await handlers['cost-get-predictions']({});

      expect(result.success).toBe(true);
      expect(result.predictions.daily).toBe(10.00);
      expect(result.predictions.weekly).toBe(70.00);
    });

    test('handles errors', async () => {
      mockOptimizer.getPredictions.mockImplementation(() => {
        throw new Error('Prediction error');
      });

      const result = await handlers['cost-get-predictions']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Prediction error');
    });
  });

  describe('cost-get-optimizations', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns optimization suggestions', async () => {
      const result = await handlers['cost-get-optimizations']({});

      expect(result.success).toBe(true);
      expect(result.optimizations).toHaveLength(1);
      expect(result.optimizations[0].type).toBe('use_haiku');
    });

    test('handles errors', async () => {
      mockOptimizer.getOptimizations.mockImplementation(() => {
        throw new Error('Optimization error');
      });

      const result = await handlers['cost-get-optimizations']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Optimization error');
    });
  });

  describe('cost-set-budget', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns error when type is missing', async () => {
      const result = await handlers['cost-set-budget']({}, { amount: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Type and amount required');
    });

    test('returns error when amount is missing', async () => {
      const result = await handlers['cost-set-budget']({}, { type: 'daily' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Type and amount required');
    });

    test('sets budget successfully', async () => {
      const result = await handlers['cost-set-budget']({}, {
        type: 'daily',
        amount: 100,
        target: 'project',
      });

      expect(result.success).toBe(true);
      expect(result.budget.type).toBe('daily');
      expect(mockOptimizer.setBudget).toHaveBeenCalledWith('daily', 100, 'project');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles errors', async () => {
      mockOptimizer.setBudget.mockImplementation(() => {
        throw new Error('Budget error');
      });

      const result = await handlers['cost-set-budget']({}, { type: 'daily', amount: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Budget error');
    });
  });

  describe('cost-get-budget', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns budget configuration', async () => {
      const result = await handlers['cost-get-budget']({});

      expect(result.success).toBe(true);
      expect(result.budget).toEqual({ daily: 100 });
      expect(result.usage).toBe(0.1);
    });

    test('handles errors', async () => {
      mockOptimizer.getSummary.mockImplementation(() => {
        throw new Error('Budget fetch error');
      });

      const result = await handlers['cost-get-budget']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Budget fetch error');
    });
  });

  describe('cost-get-alerts', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns alerts', async () => {
      const result = await handlers['cost-get-alerts']({});

      expect(result.success).toBe(true);
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].type).toBe('budget_warning');
    });

    test('handles errors', async () => {
      mockOptimizer.getAlerts.mockImplementation(() => {
        throw new Error('Alerts error');
      });

      const result = await handlers['cost-get-alerts']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Alerts error');
    });
  });

  describe('cost-clear-alerts', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('clears alerts successfully', async () => {
      const result = await handlers['cost-clear-alerts']({});

      expect(result.success).toBe(true);
      expect(mockOptimizer.clearAlerts).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles errors', async () => {
      mockOptimizer.clearAlerts.mockImplementation(() => {
        throw new Error('Clear error');
      });

      const result = await handlers['cost-clear-alerts']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Clear error');
    });
  });

  describe('cost-reset', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('resets cost tracking', async () => {
      const result = await handlers['cost-reset']({});

      expect(result.success).toBe(true);
      expect(mockOptimizer.reset).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles errors', async () => {
      mockOptimizer.reset.mockImplementation(() => {
        throw new Error('Reset error');
      });

      const result = await handlers['cost-reset']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Reset error');
    });
  });

  describe('cost-export', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('exports cost data', async () => {
      const result = await handlers['cost-export']({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ history: [], budgets: [] });
    });

    test('handles errors', async () => {
      mockOptimizer.export.mockImplementation(() => {
        throw new Error('Export error');
      });

      const result = await handlers['cost-export']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Export error');
    });
  });

  describe('cost-import', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns error when data is missing', async () => {
      const result = await handlers['cost-import']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Data required');
    });

    test('imports cost data successfully', async () => {
      const importData = { history: [{ id: 'cost-1' }], budgets: [] };

      const result = await handlers['cost-import']({}, { data: importData });

      expect(result.success).toBe(true);
      expect(mockOptimizer.import).toHaveBeenCalledWith(importData);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles errors', async () => {
      mockOptimizer.import.mockImplementation(() => {
        throw new Error('Import error');
      });

      const result = await handlers['cost-import']({}, { data: {} });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Import error');
    });
  });

  describe('cost-estimate', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('estimates cost with token counts', async () => {
      const result = await handlers['cost-estimate']({}, {
        model: 'claude-3-opus',
        inputTokens: 1000,
        outputTokens: 500,
      });

      expect(result.success).toBe(true);
      expect(result.estimate.model).toBe('claude-3-opus');
      expect(result.estimate.inputTokens).toBe(1000);
      expect(result.estimate.outputTokens).toBe(500);
    });

    test('estimates tokens from text', async () => {
      const result = await handlers['cost-estimate']({}, {
        text: 'Hello world this is a test message',
      });

      expect(result.success).toBe(true);
      expect(result.estimate.inputTokens).toBeGreaterThan(0);
    });

    test('uses default model', async () => {
      const result = await handlers['cost-estimate']({}, {
        inputTokens: 100,
      });

      expect(result.success).toBe(true);
      expect(result.estimate.model).toBe('default');
    });

    test('handles errors', async () => {
      const costOptimizer = require('../modules/analysis/cost-optimizer');
      costOptimizer.calculateCost.mockImplementation(() => {
        throw new Error('Calculation error');
      });

      const result = await handlers['cost-estimate']({}, { inputTokens: 100 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Calculation error');

      // Reset mock
      costOptimizer.calculateCost.mockReturnValue(0.05);
    });
  });

  describe('cost-get-pricing', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('returns pricing information', async () => {
      const result = await handlers['cost-get-pricing']({});

      expect(result.success).toBe(true);
      expect(result.pricing).toBeDefined();
      expect(result.thresholds).toBeDefined();
    });

    test('handles errors', async () => {
      // Temporarily break the module
      const costOptimizer = require('../modules/analysis/cost-optimizer');
      const originalPricing = costOptimizer.MODEL_PRICING;
      Object.defineProperty(costOptimizer, 'MODEL_PRICING', {
        get: () => { throw new Error('Pricing error'); },
        configurable: true,
      });

      const result = await handlers['cost-get-pricing']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Pricing error');

      // Restore
      Object.defineProperty(costOptimizer, 'MODEL_PRICING', {
        value: originalPricing,
        configurable: true,
      });
    });
  });

  describe('cost-simulate-optimization', () => {
    beforeEach(() => {
      registerCostOptimizerHandlers(mockCtx);
    });

    test('simulates model downgrade optimization', async () => {
      mockOptimizer.costs = {
        byModel: {
          'claude-3-opus': {
            total: 10.00,
            inputTokens: 100000,
            outputTokens: 50000,
          },
        },
      };

      const result = await handlers['cost-simulate-optimization']({}, {
        optimizationType: 'model_downgrade',
        targetModel: 'claude-3-haiku',
      });

      expect(result.success).toBe(true);
      expect(result.simulation.optimizationType).toBe('model_downgrade');
      expect(result.simulation.targetModel).toBe('claude-3-haiku');
      expect(result.simulation.potentialSavings).toBeDefined();
    });

    test('handles non-model_downgrade optimization type', async () => {
      const result = await handlers['cost-simulate-optimization']({}, {
        optimizationType: 'caching',
      });

      expect(result.success).toBe(true);
      expect(result.simulation.potentialSavings).toBe(0);
    });

    test('handles errors', async () => {
      mockOptimizer.getSummary.mockImplementation(() => {
        throw new Error('Simulation error');
      });

      const result = await handlers['cost-simulate-optimization']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Simulation error');
    });
  });

  describe('lazy loading and persistence', () => {
    test('loads persisted data on first use', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({ history: [] }));

      registerCostOptimizerHandlers(mockCtx);

      // Trigger optimizer initialization
      await handlers['cost-get-summary']({});

      expect(fs.existsSync).toHaveBeenCalled();
      expect(mockOptimizer.import).toHaveBeenCalled();
    });

    test('handles persistence load errors gracefully', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      registerCostOptimizerHandlers(mockCtx);

      // Should not throw
      const result = await handlers['cost-get-summary']({});

      expect(result.success).toBe(true);
    });

    test('creates directory on save if needed', async () => {
      fs.existsSync.mockReturnValue(false);

      registerCostOptimizerHandlers(mockCtx);
      await handlers['cost-record']({}, {});

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        { recursive: true }
      );
    });

    test('handles save errors gracefully', async () => {
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Write error');
      });

      registerCostOptimizerHandlers(mockCtx);

      // Should not throw
      const result = await handlers['cost-record']({}, {});

      expect(result.success).toBe(true);
    });
  });
});
