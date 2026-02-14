/**
 * Usage Manager
 * Handles usage statistics tracking and persistence for the main process
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { WORKSPACE_PATH, resolveCoordPath } = require('../../config');

class UsageManager {
  constructor(appContext) {
    this.ctx = appContext;
    this.usageFilePath = typeof resolveCoordPath === 'function'
      ? resolveCoordPath('usage-stats.json', { forWrite: true })
      : path.join(WORKSPACE_PATH, 'usage-stats.json');
    this.ctx.usageStats = {
      totalSpawns: 0,
      spawnsPerPane: { '1': 0, '2': 0, '5': 0 },
      totalSessionTimeMs: 0,
      sessionTimePerPane: { '1': 0, '2': 0, '5': 0 },
      sessionsToday: 0,
      lastResetDate: new Date().toISOString().split('T')[0],
      history: [],
    };
    this.ctx.sessionStartTimes = new Map();
  }

  loadUsageStats() {
    try {
      if (fs.existsSync(this.usageFilePath)) {
        const content = fs.readFileSync(this.usageFilePath, 'utf-8');
        Object.assign(this.ctx.usageStats, JSON.parse(content));
        const today = new Date().toISOString().split('T')[0];
        if (this.ctx.usageStats.lastResetDate !== today) {
          this.ctx.usageStats.sessionsToday = 0;
          this.ctx.usageStats.lastResetDate = today;
        }
      }
    } catch (err) {
      log.error('Usage', 'Error loading usage stats', err);
    }
    return this.ctx.usageStats;
  }

  saveUsageStats() {
    try {
      const tempPath = this.usageFilePath + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.ctx.usageStats, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.usageFilePath);
    } catch (err) {
      log.error('Usage', 'Error saving usage stats', err);
    }
  }

  recordSessionStart(paneId) {
    this.ctx.sessionStartTimes.set(paneId, Date.now());
    this.ctx.usageStats.totalSpawns++;
    this.ctx.usageStats.spawnsPerPane[paneId] = (this.ctx.usageStats.spawnsPerPane[paneId] || 0) + 1;
    this.ctx.usageStats.sessionsToday++;
    this.saveUsageStats();
  }

  recordSessionEnd(paneId) {
    const startTime = this.ctx.sessionStartTimes.get(paneId);
    if (startTime) {
      const duration = Date.now() - startTime;
      this.ctx.usageStats.totalSessionTimeMs += duration;
      this.ctx.usageStats.sessionTimePerPane[paneId] = (this.ctx.usageStats.sessionTimePerPane[paneId] || 0) + duration;

      this.ctx.usageStats.history.push({
        pane: paneId,
        duration,
        timestamp: new Date().toISOString(),
      });
      if (this.ctx.usageStats.history.length > 50) {
        this.ctx.usageStats.history = this.ctx.usageStats.history.slice(-50);
      }

      this.ctx.sessionStartTimes.delete(paneId);
      this.saveUsageStats();
    }
  }
}

module.exports = UsageManager;
