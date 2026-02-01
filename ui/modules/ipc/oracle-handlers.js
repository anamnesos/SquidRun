/**
 * Oracle IPC Handlers
 * Channels: oracle:analyzeScreenshot, save-oracle-history, load-oracle-history
 */

const fs = require('fs');
const path = require('path');
const { analyzeScreenshot } = require('../gemini-oracle');

function registerOracleHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerOracleHandlers requires ctx.ipcMain');
  }

  const { ipcMain, WORKSPACE_PATH } = ctx;
  const ORACLE_HISTORY_PATH = path.join(WORKSPACE_PATH || '.', 'oracle-history.json');

  ipcMain.handle('oracle:analyzeScreenshot', async (event, payload = {}) => {
    const imagePath = payload?.imagePath;
    const prompt = payload?.prompt;
    try {
      const result = await analyzeScreenshot({ imagePath, prompt });
      return {
        success: true,
        analysis: result.analysis,
        usage: result.usage,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Save oracle history to file
  ipcMain.handle('save-oracle-history', async (event, history) => {
    try {
      fs.writeFileSync(ORACLE_HISTORY_PATH, JSON.stringify(history, null, 2));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Load oracle history from file
  ipcMain.handle('load-oracle-history', async () => {
    try {
      if (fs.existsSync(ORACLE_HISTORY_PATH)) {
        const data = fs.readFileSync(ORACLE_HISTORY_PATH, 'utf8');
        return JSON.parse(data);
      }
      return [];
    } catch (err) {
      return [];
    }
  });
}

module.exports = { registerOracleHandlers };
