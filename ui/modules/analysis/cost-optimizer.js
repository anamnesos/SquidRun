/**
 * Cost Optimization Engine - Task #24
 *
 * Track API costs per agent/task, predict budgets, suggest optimizations.
 * Integrates with activity log and usage stats systems.
 */

// Model pricing (per 1M tokens as of 2024)
const MODEL_PRICING = {
  // Anthropic Claude models
  'claude-3-opus': { input: 15.00, output: 75.00 },
  'claude-3-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3.5-sonnet': { input: 3.00, output: 15.00 },
  'claude-3.5-haiku': { input: 0.80, output: 4.00 },

  // OpenAI models
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-4o': { input: 5.00, output: 15.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },

  // Default fallback
  'default': { input: 3.00, output: 15.00 },
};

// Cost severity thresholds
const COST_THRESHOLDS = {
  LOW: 0.10,      // < $0.10 per request
  MEDIUM: 0.50,   // < $0.50 per request
  HIGH: 2.00,     // < $2.00 per request
  CRITICAL: 5.00, // >= $5.00 per request
};

// Optimization categories
const OPTIMIZATION_CATEGORIES = {
  MODEL_DOWNGRADE: 'model_downgrade',
  CONTEXT_REDUCTION: 'context_reduction',
  CACHING: 'caching',
  BATCHING: 'batching',
  PROMPT_OPTIMIZATION: 'prompt_optimization',
  AGENT_CONSOLIDATION: 'agent_consolidation',
};

/**
 * Cost Optimizer class
 */
class CostOptimizer {
  constructor(options = {}) {
    this.options = {
      historyLimit: options.historyLimit || 10000,
      budgetAlertThreshold: options.budgetAlertThreshold || 0.8, // 80% of budget
      anomalyThreshold: options.anomalyThreshold || 2.0, // 2x average = anomaly
      ...options,
    };

    // Cost tracking state
    this.costs = {
      total: 0,
      byAgent: {},      // { paneId: { total, requests, inputTokens, outputTokens } }
      byTask: {},       // { taskId: { total, requests, inputTokens, outputTokens } }
      byModel: {},      // { modelId: { total, requests, inputTokens, outputTokens } }
      byHour: {},       // { 'YYYY-MM-DD-HH': total }
      byDay: {},        // { 'YYYY-MM-DD': total }
    };

    // Cost event history
    this.history = [];

    // Budget configuration
    this.budget = {
      daily: null,
      weekly: null,
      monthly: null,
      perAgent: {},     // { paneId: limit }
      perTask: {},      // { taskType: limit }
    };

    // Alerts
    this.alerts = [];
    this.alertsSent = new Set();

    // Cached predictions
    this.predictions = null;
    this.predictionsUpdatedAt = null;
  }

  /**
   * Record a cost event
   */
  recordCost(event) {
    const {
      agentId,
      taskId,
      taskType,
      model = 'default',
      inputTokens = 0,
      outputTokens = 0,
      customCost = null,
      metadata = {},
    } = event;

    // Calculate cost
    const pricing = MODEL_PRICING[model] || MODEL_PRICING.default;
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const totalCost = customCost !== null ? customCost : (inputCost + outputCost);

    // Create cost record
    const record = {
      id: `cost-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      agentId,
      taskId,
      taskType,
      model,
      inputTokens,
      outputTokens,
      inputCost,
      outputCost,
      totalCost,
      metadata,
    };

    // Update totals
    this.costs.total += totalCost;

    // Update by agent
    if (agentId) {
      if (!this.costs.byAgent[agentId]) {
        this.costs.byAgent[agentId] = { total: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
      }
      this.costs.byAgent[agentId].total += totalCost;
      this.costs.byAgent[agentId].requests++;
      this.costs.byAgent[agentId].inputTokens += inputTokens;
      this.costs.byAgent[agentId].outputTokens += outputTokens;
    }

    // Update by task
    const taskKey = taskId || taskType || 'unknown';
    if (!this.costs.byTask[taskKey]) {
      this.costs.byTask[taskKey] = { total: 0, requests: 0, inputTokens: 0, outputTokens: 0, taskType };
    }
    this.costs.byTask[taskKey].total += totalCost;
    this.costs.byTask[taskKey].requests++;
    this.costs.byTask[taskKey].inputTokens += inputTokens;
    this.costs.byTask[taskKey].outputTokens += outputTokens;

    // Update by model
    if (!this.costs.byModel[model]) {
      this.costs.byModel[model] = { total: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
    }
    this.costs.byModel[model].total += totalCost;
    this.costs.byModel[model].requests++;
    this.costs.byModel[model].inputTokens += inputTokens;
    this.costs.byModel[model].outputTokens += outputTokens;

    // Update time-based aggregates
    const now = new Date();
    const hourKey = `${now.toISOString().split('T')[0]}-${String(now.getHours()).padStart(2, '0')}`;
    const dayKey = now.toISOString().split('T')[0];

    this.costs.byHour[hourKey] = (this.costs.byHour[hourKey] || 0) + totalCost;
    this.costs.byDay[dayKey] = (this.costs.byDay[dayKey] || 0) + totalCost;

    // Add to history
    this.history.push(record);
    if (this.history.length > this.options.historyLimit) {
      this.history.shift();
    }

    // Check for alerts
    this._checkAlerts(record);

    // Invalidate predictions cache
    this.predictions = null;

    return record;
  }

  /**
   * Get cost summary
   */
  getSummary() {
    const now = new Date();
    const todayKey = now.toISOString().split('T')[0];
    const weekStart = this._getWeekStart(now);
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Calculate period costs
    const todayCost = this.costs.byDay[todayKey] || 0;
    const weekCost = this._sumDayRange(weekStart, now);
    const monthCost = this._sumMonthCost(monthKey);

    // Calculate averages
    const dayCount = Object.keys(this.costs.byDay).length || 1;
    const avgDailyCost = this.costs.total / dayCount;

    // Find top spenders
    const topAgents = this._getTopSpenders(this.costs.byAgent, 3);
    const topTasks = this._getTopSpenders(this.costs.byTask, 3);
    const topModels = this._getTopSpenders(this.costs.byModel, 3);

    return {
      total: this.costs.total,
      today: todayCost,
      thisWeek: weekCost,
      thisMonth: monthCost,
      avgDaily: avgDailyCost,
      totalRequests: this.history.length,
      totalInputTokens: this._sumField('inputTokens'),
      totalOutputTokens: this._sumField('outputTokens'),
      topAgents,
      topTasks,
      topModels,
      budget: this.budget,
      budgetUsage: this._calculateBudgetUsage(todayCost, weekCost, monthCost),
    };
  }

  /**
   * Get costs by agent
   */
  getCostsByAgent() {
    const agentNames = {
      '1': 'Architect',
      '2': 'Infra',
      '3': 'Frontend',
      '4': 'Backend',
      '5': 'Analyst',
      '6': 'Reviewer',
    };

    const result = {};
    for (const [agentId, data] of Object.entries(this.costs.byAgent)) {
      result[agentId] = {
        ...data,
        name: agentNames[agentId] || `Agent ${agentId}`,
        avgCostPerRequest: data.requests > 0 ? data.total / data.requests : 0,
        percentOfTotal: this.costs.total > 0 ? (data.total / this.costs.total) * 100 : 0,
      };
    }

    return result;
  }

  /**
   * Get costs by task
   */
  getCostsByTask() {
    const result = {};
    for (const [taskKey, data] of Object.entries(this.costs.byTask)) {
      result[taskKey] = {
        ...data,
        avgCostPerRequest: data.requests > 0 ? data.total / data.requests : 0,
        percentOfTotal: this.costs.total > 0 ? (data.total / this.costs.total) * 100 : 0,
      };
    }

    return result;
  }

  /**
   * Get historical cost data
   */
  getHistory(options = {}) {
    const { limit = 100, agentId, taskId, since } = options;

    let filtered = [...this.history];

    if (agentId) {
      filtered = filtered.filter(r => r.agentId === agentId);
    }

    if (taskId) {
      filtered = filtered.filter(r => r.taskId === taskId);
    }

    if (since) {
      const sinceTime = new Date(since).getTime();
      filtered = filtered.filter(r => r.timestamp >= sinceTime);
    }

    return filtered.slice(-limit).reverse();
  }

  /**
   * Get time series data for charts
   */
  getTimeSeries(granularity = 'day', limit = 30) {
    const data = granularity === 'hour' ? this.costs.byHour : this.costs.byDay;
    const entries = Object.entries(data)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-limit);

    return entries.map(([key, value]) => ({
      period: key,
      cost: value,
    }));
  }

  /**
   * Predict future costs
   */
  getPredictions() {
    // Use cached predictions if recent
    if (this.predictions && this.predictionsUpdatedAt &&
        Date.now() - this.predictionsUpdatedAt < 60000) {
      return this.predictions;
    }

    const now = new Date();
    const dayData = Object.entries(this.costs.byDay).sort(([a], [b]) => a.localeCompare(b));

    if (dayData.length < 3) {
      return {
        daily: null,
        weekly: null,
        monthly: null,
        confidence: 'low',
        message: 'Insufficient data for predictions (need at least 3 days)',
      };
    }

    // Calculate moving averages
    const recentDays = dayData.slice(-7);
    const avgDaily = recentDays.reduce((sum, [, val]) => sum + val, 0) / recentDays.length;

    // Calculate trend (simple linear regression)
    const trend = this._calculateTrend(recentDays.map(([, val]) => val));

    // Project forward
    const daysRemaining = this._getDaysRemainingInMonth(now);
    const weeksRemaining = Math.ceil(daysRemaining / 7);

    const projectedDaily = avgDaily * (1 + trend);
    const projectedWeekly = projectedDaily * 7;
    const projectedMonthly = (this.costs.byDay[now.toISOString().split('T')[0]] || 0) +
                             (projectedDaily * daysRemaining);

    // Determine confidence
    let confidence = 'medium';
    if (dayData.length >= 14) confidence = 'high';
    if (dayData.length < 7) confidence = 'low';

    this.predictions = {
      daily: {
        estimated: projectedDaily,
        low: projectedDaily * 0.7,
        high: projectedDaily * 1.3,
      },
      weekly: {
        estimated: projectedWeekly,
        low: projectedWeekly * 0.7,
        high: projectedWeekly * 1.3,
      },
      monthly: {
        estimated: projectedMonthly,
        low: projectedMonthly * 0.8,
        high: projectedMonthly * 1.2,
        daysRemaining,
      },
      trend: trend > 0.05 ? 'increasing' : trend < -0.05 ? 'decreasing' : 'stable',
      trendPercent: trend * 100,
      confidence,
      basedOnDays: dayData.length,
      avgDaily,
    };

    this.predictionsUpdatedAt = Date.now();
    return this.predictions;
  }

  /**
   * Generate optimization suggestions
   */
  getOptimizations() {
    const suggestions = [];
    const summary = this.getSummary();
    const agentCosts = this.getCostsByAgent();
    const taskCosts = this.getCostsByTask();

    // 1. Model downgrade suggestions
    for (const [model, data] of Object.entries(this.costs.byModel)) {
      if (model.includes('opus') && data.total > 1.00) {
        suggestions.push({
          category: OPTIMIZATION_CATEGORIES.MODEL_DOWNGRADE,
          priority: 'high',
          title: 'Consider downgrading from Claude Opus',
          description: `Claude Opus costs $${data.total.toFixed(2)} (${data.requests} requests). ` +
                       `Consider using Sonnet for routine tasks to save ~80% on those requests.`,
          potentialSavings: data.total * 0.8,
          affectedRequests: data.requests,
        });
      }

      if (model === 'gpt-4' && data.total > 1.00) {
        suggestions.push({
          category: OPTIMIZATION_CATEGORIES.MODEL_DOWNGRADE,
          priority: 'high',
          title: 'Consider GPT-4 Turbo instead of GPT-4',
          description: `GPT-4 costs $${data.total.toFixed(2)}. GPT-4 Turbo offers similar quality at ~67% lower cost.`,
          potentialSavings: data.total * 0.67,
          affectedRequests: data.requests,
        });
      }
    }

    // 2. High-cost agent suggestions
    for (const [agentId, data] of Object.entries(agentCosts)) {
      if (data.percentOfTotal > 40 && data.total > 2.00) {
        suggestions.push({
          category: OPTIMIZATION_CATEGORIES.AGENT_CONSOLIDATION,
          priority: 'medium',
          title: `${data.name} consuming ${data.percentOfTotal.toFixed(0)}% of budget`,
          description: `Consider reviewing ${data.name}'s workload. It has made ${data.requests} requests ` +
                       `costing $${data.total.toFixed(2)}. Average ${data.avgCostPerRequest.toFixed(3)} per request.`,
          potentialSavings: data.total * 0.2,
          agentId,
        });
      }
    }

    // 3. High token usage suggestions
    const totalTokens = summary.totalInputTokens + summary.totalOutputTokens;
    const inputRatio = summary.totalInputTokens / (totalTokens || 1);

    if (inputRatio > 0.8 && summary.totalInputTokens > 100000) {
      suggestions.push({
        category: OPTIMIZATION_CATEGORIES.CONTEXT_REDUCTION,
        priority: 'medium',
        title: 'High input token ratio detected',
        description: `${(inputRatio * 100).toFixed(0)}% of tokens are inputs. Consider reducing context window size ` +
                     `or implementing conversation summarization to lower input costs.`,
        potentialSavings: summary.total * 0.15,
      });
    }

    // 4. Caching opportunities
    const avgRequestsPerHour = this.history.length / Math.max(Object.keys(this.costs.byHour).length, 1);
    if (avgRequestsPerHour > 10) {
      suggestions.push({
        category: OPTIMIZATION_CATEGORIES.CACHING,
        priority: 'low',
        title: 'High request volume - consider caching',
        description: `Averaging ${avgRequestsPerHour.toFixed(1)} requests/hour. Caching repeated queries ` +
                     `could reduce costs significantly.`,
        potentialSavings: summary.total * 0.1,
      });
    }

    // 5. Batching opportunities
    const recentHistory = this.history.slice(-100);
    const quickSuccession = this._countQuickSuccessionRequests(recentHistory, 5000);
    if (quickSuccession > 20) {
      suggestions.push({
        category: OPTIMIZATION_CATEGORIES.BATCHING,
        priority: 'low',
        title: 'Multiple rapid requests detected',
        description: `${quickSuccession} requests made within 5 seconds of each other. ` +
                     `Batching these could reduce overhead costs.`,
        potentialSavings: summary.total * 0.05,
      });
    }

    // Sort by potential savings
    suggestions.sort((a, b) => (b.potentialSavings || 0) - (a.potentialSavings || 0));

    return {
      suggestions,
      totalPotentialSavings: suggestions.reduce((sum, s) => sum + (s.potentialSavings || 0), 0),
      analysisTimestamp: Date.now(),
    };
  }

  /**
   * Set budget limits
   */
  setBudget(type, amount, target = null) {
    if (type === 'daily') {
      this.budget.daily = amount;
    } else if (type === 'weekly') {
      this.budget.weekly = amount;
    } else if (type === 'monthly') {
      this.budget.monthly = amount;
    } else if (type === 'agent' && target) {
      this.budget.perAgent[target] = amount;
    } else if (type === 'task' && target) {
      this.budget.perTask[target] = amount;
    }

    return this.budget;
  }

  /**
   * Get active alerts
   */
  getAlerts() {
    return this.alerts.slice(-50).reverse();
  }

  /**
   * Clear alerts
   */
  clearAlerts() {
    this.alerts = [];
    this.alertsSent.clear();
  }

  /**
   * Reset all cost tracking
   */
  reset() {
    this.costs = {
      total: 0,
      byAgent: {},
      byTask: {},
      byModel: {},
      byHour: {},
      byDay: {},
    };
    this.history = [];
    this.predictions = null;
    this.clearAlerts();
  }

  /**
   * Export data for persistence
   */
  export() {
    return {
      costs: this.costs,
      history: this.history,
      budget: this.budget,
      alerts: this.alerts,
      exportedAt: Date.now(),
    };
  }

  /**
   * Import data from persistence
   */
  import(data) {
    if (data.costs) this.costs = data.costs;
    if (data.history) this.history = data.history;
    if (data.budget) this.budget = data.budget;
    if (data.alerts) this.alerts = data.alerts;
  }

  // Private helper methods

  _checkAlerts(record) {
    const now = new Date();
    const todayKey = now.toISOString().split('T')[0];
    const todayCost = this.costs.byDay[todayKey] || 0;

    // Daily budget alert
    if (this.budget.daily && todayCost >= this.budget.daily * this.options.budgetAlertThreshold) {
      const alertKey = `daily-${todayKey}`;
      if (!this.alertsSent.has(alertKey)) {
        this.alerts.push({
          type: 'budget_warning',
          level: todayCost >= this.budget.daily ? 'critical' : 'warning',
          message: `Daily budget ${todayCost >= this.budget.daily ? 'exceeded' : 'warning'}: $${todayCost.toFixed(2)} / $${this.budget.daily.toFixed(2)}`,
          timestamp: Date.now(),
          data: { budget: this.budget.daily, actual: todayCost },
        });
        this.alertsSent.add(alertKey);
      }
    }

    // Per-agent budget alert
    if (record.agentId && this.budget.perAgent[record.agentId]) {
      const agentCost = this.costs.byAgent[record.agentId]?.total || 0;
      const agentBudget = this.budget.perAgent[record.agentId];
      const alertKey = `agent-${record.agentId}-${todayKey}`;

      if (agentCost >= agentBudget * this.options.budgetAlertThreshold && !this.alertsSent.has(alertKey)) {
        this.alerts.push({
          type: 'agent_budget_warning',
          level: agentCost >= agentBudget ? 'critical' : 'warning',
          message: `Agent ${record.agentId} budget ${agentCost >= agentBudget ? 'exceeded' : 'warning'}: $${agentCost.toFixed(2)} / $${agentBudget.toFixed(2)}`,
          timestamp: Date.now(),
          data: { agentId: record.agentId, budget: agentBudget, actual: agentCost },
        });
        this.alertsSent.add(alertKey);
      }
    }

    // Anomaly detection
    const avgCostPerRequest = this.costs.total / Math.max(this.history.length - 1, 1);
    if (record.totalCost > avgCostPerRequest * this.options.anomalyThreshold && this.history.length > 10) {
      this.alerts.push({
        type: 'cost_anomaly',
        level: 'warning',
        message: `Unusual cost detected: $${record.totalCost.toFixed(4)} (avg: $${avgCostPerRequest.toFixed(4)})`,
        timestamp: Date.now(),
        data: { recordId: record.id, cost: record.totalCost, average: avgCostPerRequest },
      });
    }

    // High cost request alert
    if (record.totalCost >= COST_THRESHOLDS.CRITICAL) {
      this.alerts.push({
        type: 'high_cost_request',
        level: 'critical',
        message: `Critical cost request: $${record.totalCost.toFixed(2)} (model: ${record.model})`,
        timestamp: Date.now(),
        data: record,
      });
    }
  }

  _getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
  }

  _sumDayRange(start, end) {
    let sum = 0;
    const startKey = start.toISOString().split('T')[0];
    const endKey = end.toISOString().split('T')[0];

    for (const [key, value] of Object.entries(this.costs.byDay)) {
      if (key >= startKey && key <= endKey) {
        sum += value;
      }
    }
    return sum;
  }

  _sumMonthCost(monthKey) {
    let sum = 0;
    for (const [key, value] of Object.entries(this.costs.byDay)) {
      if (key.startsWith(monthKey)) {
        sum += value;
      }
    }
    return sum;
  }

  _getTopSpenders(data, limit) {
    return Object.entries(data)
      .map(([key, value]) => ({ id: key, ...value }))
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }

  _sumField(field) {
    return this.history.reduce((sum, r) => sum + (r[field] || 0), 0);
  }

  _calculateTrend(values) {
    if (values.length < 2) return 0;

    const n = values.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((sum, val, i) => sum + i * val, 0);
    const sumX2 = values.reduce((sum, _, i) => sum + i * i, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const avg = sumY / n;

    return avg > 0 ? slope / avg : 0;
  }

  _getDaysRemainingInMonth(date) {
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    return lastDay - date.getDate();
  }

  _calculateBudgetUsage(todayCost, weekCost, monthCost) {
    return {
      daily: this.budget.daily ? {
        used: todayCost,
        limit: this.budget.daily,
        percent: (todayCost / this.budget.daily) * 100,
        remaining: Math.max(0, this.budget.daily - todayCost),
      } : null,
      weekly: this.budget.weekly ? {
        used: weekCost,
        limit: this.budget.weekly,
        percent: (weekCost / this.budget.weekly) * 100,
        remaining: Math.max(0, this.budget.weekly - weekCost),
      } : null,
      monthly: this.budget.monthly ? {
        used: monthCost,
        limit: this.budget.monthly,
        percent: (monthCost / this.budget.monthly) * 100,
        remaining: Math.max(0, this.budget.monthly - monthCost),
      } : null,
    };
  }

  _countQuickSuccessionRequests(history, thresholdMs) {
    let count = 0;
    for (let i = 1; i < history.length; i++) {
      if (history[i].timestamp - history[i - 1].timestamp < thresholdMs) {
        count++;
      }
    }
    return count;
  }
}

/**
 * Estimate tokens for a text string (rough approximation)
 */
function estimateTokens(text) {
  if (!text) return 0;
  // Rough approximation: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

/**
 * Get pricing for a model
 */
function getModelPricing(model) {
  return MODEL_PRICING[model] || MODEL_PRICING.default;
}

/**
 * Calculate cost for given tokens
 */
function calculateCost(model, inputTokens, outputTokens) {
  const pricing = getModelPricing(model);
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return {
    input: inputCost,
    output: outputCost,
    total: inputCost + outputCost,
  };
}

/**
 * Create a new cost optimizer instance
 */
function createCostOptimizer(options = {}) {
  return new CostOptimizer(options);
}

module.exports = {
  CostOptimizer,
  createCostOptimizer,
  estimateTokens,
  getModelPricing,
  calculateCost,
  MODEL_PRICING,
  COST_THRESHOLDS,
  OPTIMIZATION_CATEGORIES,
};
