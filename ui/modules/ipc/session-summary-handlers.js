/**
 * Session Summary IPC Handlers
 * Channels: save-session-summary, get-session-summaries, get-latest-summary, clear-session-summaries
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

function registerSessionSummaryHandlers(ctx) {
  const { ipcMain, WORKSPACE_PATH } = ctx;

  const SESSION_SUMMARY_PATH = path.join(WORKSPACE_PATH, 'session-summaries.json');

  ipcMain.handle('save-session-summary', (event, summary) => {
    try {
      let summaries = [];
      if (fs.existsSync(SESSION_SUMMARY_PATH)) {
        const content = fs.readFileSync(SESSION_SUMMARY_PATH, 'utf-8');
        summaries = JSON.parse(content);
      }

      summaries.push({
        ...summary,
        savedAt: new Date().toISOString(),
        id: `session-${Date.now()}`,
      });

      if (summaries.length > 50) {
        summaries = summaries.slice(-50);
      }

      const tempPath = SESSION_SUMMARY_PATH + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(summaries, null, 2), 'utf-8');
      fs.renameSync(tempPath, SESSION_SUMMARY_PATH);

      log.info('Session Summary', 'Saved summary:', summary.title || 'Untitled');
      return { success: true, id: summaries[summaries.length - 1].id };
    } catch (err) {
      log.error('Session Summary', 'Error saving:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-session-summaries', (event, limit = 10) => {
    try {
      if (!fs.existsSync(SESSION_SUMMARY_PATH)) {
        return { success: true, summaries: [] };
      }

      const content = fs.readFileSync(SESSION_SUMMARY_PATH, 'utf-8');
      const summaries = JSON.parse(content);

      return {
        success: true,
        summaries: summaries.slice(-limit).reverse(),
        total: summaries.length,
      };
    } catch (err) {
      return { success: false, error: err.message, summaries: [] };
    }
  });

  ipcMain.handle('get-latest-summary', () => {
    try {
      if (!fs.existsSync(SESSION_SUMMARY_PATH)) {
        return { success: true, summary: null };
      }

      const content = fs.readFileSync(SESSION_SUMMARY_PATH, 'utf-8');
      const summaries = JSON.parse(content);

      if (summaries.length === 0) {
        return { success: true, summary: null };
      }

      return { success: true, summary: summaries[summaries.length - 1] };
    } catch (err) {
      return { success: false, error: err.message, summary: null };
    }
  });

  ipcMain.handle('clear-session-summaries', () => {
    try {
      if (fs.existsSync(SESSION_SUMMARY_PATH)) {
        fs.unlinkSync(SESSION_SUMMARY_PATH);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}


function unregisterSessionSummaryHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('save-session-summary');
    ipcMain.removeHandler('get-session-summaries');
    ipcMain.removeHandler('get-latest-summary');
    ipcMain.removeHandler('clear-session-summaries');
}

registerSessionSummaryHandlers.unregister = unregisterSessionSummaryHandlers;
module.exports = { registerSessionSummaryHandlers };
