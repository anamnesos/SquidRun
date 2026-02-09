/**
 * Oracle IPC Handlers
 * Channels: oracle:generateImage, save-oracle-history, load-oracle-history
 */

const fs = require('fs');
const { generateImage, IMAGE_HISTORY_PATH } = require('../image-gen');

function registerOracleHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerOracleHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  ipcMain.handle('oracle:generateImage', async (event, payload = {}) => {
    const { prompt, provider, style, size } = payload;
    try {
      const result = await generateImage({ prompt, provider, style, size });
      return {
        success: true,
        imagePath: result.imagePath,
        provider: result.provider,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Save oracle history to file
  ipcMain.handle('save-oracle-history', async (event, history) => {
    try {
      fs.writeFileSync(IMAGE_HISTORY_PATH, JSON.stringify(history, null, 2));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Load oracle history from file
  ipcMain.handle('load-oracle-history', async () => {
    try {
      if (fs.existsSync(IMAGE_HISTORY_PATH)) {
        const data = fs.readFileSync(IMAGE_HISTORY_PATH, 'utf8');
        return JSON.parse(data);
      }
      return [];
    } catch (err) {
      return [];
    }
  });
}

module.exports = { registerOracleHandlers };
