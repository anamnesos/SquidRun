/**
 * Activity Manager
 * Handles activity logging and persistence for the main process
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { WORKSPACE_PATH, resolveCoordPath } = require('../../config');

const MAX_ACTIVITY_ENTRIES = 500;
const ACTIVITY_FILE_PATH = typeof resolveCoordPath === 'function'
  ? resolveCoordPath('activity.json', { forWrite: true })
  : path.join(WORKSPACE_PATH, 'activity.json');

class ActivityManager {
  constructor(appContext) {
    this.ctx = appContext;
    this.ctx.activityLog = [];
  }

  logActivity(type, paneId, message, details = {}) {
    const entry = {
      id: `act-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      type,
      paneId,
      message,
      details,
    };

    this.ctx.activityLog.push(entry);

    if (this.ctx.activityLog.length > MAX_ACTIVITY_ENTRIES) {
      this.ctx.activityLog.shift();
    }

    if (this.ctx.mainWindow && !this.ctx.mainWindow.isDestroyed()) {
      this.ctx.mainWindow.webContents.send('activity-logged', entry);
    }

    if (this.ctx.pluginManager?.hasHook('activity:log')) {
      this.ctx.pluginManager.dispatch('activity:log', entry).catch(() => {});
    }

    if (this.ctx.externalNotifier && typeof this.ctx.externalNotifier.notify === 'function') {
      if (type === 'error') {
        this.ctx.externalNotifier.notify({
          category: 'alert',
          title: `Error detected${paneId ? ` (pane ${paneId})` : ''}`,
          message: details.snippet || message,
          meta: { paneId },
        }).catch(() => {});
      }

      if (type === 'terminal' && /completion/i.test(message)) {
        this.ctx.externalNotifier.notify({
          category: 'completion',
          title: `Completion detected${paneId ? ` (pane ${paneId})` : ''}`,
          message: details.snippet || message,
          meta: { paneId },
        }).catch(() => {});
      }
    }
  }

  getActivityLog(filter = {}) {
    let filtered = [...this.ctx.activityLog];

    if (filter.type) {
      filtered = filtered.filter(e => e.type === filter.type);
    }
    if (filter.paneId) {
      filtered = filtered.filter(e => e.paneId === filter.paneId);
    }
    if (filter.since) {
      const sinceTime = new Date(filter.since).getTime();
      filtered = filtered.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
    }
    if (filter.search) {
      const searchLower = filter.search.toLowerCase();
      filtered = filtered.filter(e =>
        e.message.toLowerCase().includes(searchLower) ||
        JSON.stringify(e.details).toLowerCase().includes(searchLower)
      );
    }

    return filtered;
  }

  clearActivityLog() {
    this.ctx.activityLog.length = 0;
  }

  saveActivityLog() {
    try {
      const tempPath = ACTIVITY_FILE_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.ctx.activityLog, null, 2), 'utf-8');
      fs.renameSync(tempPath, ACTIVITY_FILE_PATH);
      log.info('Activity', `Saved ${this.ctx.activityLog.length} entries`);
    } catch (err) {
      log.error('Activity', 'Error saving', err.message);
    }
  }

  loadActivityLog() {
    try {
      if (fs.existsSync(ACTIVITY_FILE_PATH)) {
        const content = fs.readFileSync(ACTIVITY_FILE_PATH, 'utf-8');
        const loaded = JSON.parse(content);
        this.ctx.activityLog.push(...loaded.slice(-MAX_ACTIVITY_ENTRIES));
        log.info('Activity', `Loaded ${this.ctx.activityLog.length} entries`);
      }
    } catch (err) {
      log.error('Activity', 'Error loading', err.message);
    }
  }
}

module.exports = ActivityManager;
