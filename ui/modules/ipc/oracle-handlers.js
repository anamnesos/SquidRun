/**
 * Oracle IPC Handlers
 * Channels: oracle:generateImage, oracle:deleteImage, save-oracle-history, load-oracle-history
 */

const fs = require('fs');
const path = require('path');
const { generateImage, IMAGE_HISTORY_PATH, GENERATED_IMAGES_DIR } = require('../image-gen');

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

  // Delete an image from disk and remove its history entry
  ipcMain.handle('oracle:deleteImage', async (event, imagePath) => {
    try {
      // Security: only allow deleting files inside generated-images directory
      const resolved = path.resolve(imagePath);
      const imagesDir = path.resolve(GENERATED_IMAGES_DIR);
      if (!resolved.startsWith(imagesDir + path.sep) && resolved !== imagesDir) {
        return { success: false, error: 'Path outside generated-images directory' };
      }

      // Delete file from disk
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }

      // Remove from history
      if (fs.existsSync(IMAGE_HISTORY_PATH)) {
        try {
          const history = JSON.parse(fs.readFileSync(IMAGE_HISTORY_PATH, 'utf8'));
          const filtered = history.filter(h => path.resolve(h.imagePath) !== resolved);
          fs.writeFileSync(IMAGE_HISTORY_PATH, JSON.stringify(filtered, null, 2));
        } catch {
          // History file corrupt — not critical
        }
      }

      return { success: true };
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
