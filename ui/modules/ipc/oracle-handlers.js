/**
 * Oracle IPC Handlers
 * Channels: oracle:generateImage, oracle:deleteImage, save-oracle-history, load-oracle-history
 */

const fs = require('fs');
const path = require('path');
const { generateImage, IMAGE_HISTORY_PATH, GENERATED_IMAGES_DIR } = require('../image-gen');

function mapOracleError(err) {
  const message = err && err.message ? err.message : 'Image generation failed';
  const normalized = message.toLowerCase();

  if (normalized.includes('no image generation api key available')) {
    return {
      code: 'MISSING_IMAGE_KEY',
      error: 'Image generation requires RECRAFT_API_KEY or OPENAI_API_KEY.',
    };
  }
  if (normalized.includes('openai_api_key') && normalized.includes('not set')) {
    return { code: 'MISSING_OPENAI_KEY', error: 'OPENAI_API_KEY is not configured.' };
  }
  if (normalized.includes('recraft_api_key') && normalized.includes('not set')) {
    return { code: 'MISSING_RECRAFT_KEY', error: 'RECRAFT_API_KEY is not configured.' };
  }

  return { code: 'IMAGE_GENERATION_FAILED', error: message };
}

function registerOracleHandlers(ctx, deps = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerOracleHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const generateImageFn = typeof deps.generateImage === 'function' ? deps.generateImage : generateImage;

  ipcMain.handle('oracle:generateImage', async (event, payload = {}) => {
    const { prompt, provider, style, size } = payload;
    try {
      const result = await generateImageFn({ prompt, provider, style, size });
      return {
        success: true,
        imagePath: result.imagePath,
        provider: result.provider,
      };
    } catch (err) {
      const mapped = mapOracleError(err);
      return { success: false, code: mapped.code, error: mapped.error };
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

  // Detect MIME type from file magic bytes (handles WEBP-in-.png mislabeling)
  function detectMime(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(12);
      fs.readSync(fd, buf, 0, 12, 0);
      fs.closeSync(fd);
      // PNG: 89 50 4E 47
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
      // JPEG: FF D8 FF
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
      // GIF: GIF8
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
      // WEBP: RIFF....WEBP
      if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
          buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
      // SVG: starts with < (text)
      if (buf[0] === 0x3C) return 'image/svg+xml';
      return 'image/png'; // fallback
    } catch {
      return 'image/png';
    }
  }

  // List all image files in generated-images directory (sorted newest first)
  // Returns file paths (CSP allows file: protocol). No base64 — too large for IPC.
  const MIN_IMAGE_SIZE = 10000; // Skip icon-sized files (16x16, 32x32, 64x64 variants)
  ipcMain.handle('oracle:listImages', async () => {
    try {
      if (!fs.existsSync(GENERATED_IMAGES_DIR)) return [];
      const files = fs.readdirSync(GENERATED_IMAGES_DIR)
        .filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f));
      const results = [];
      for (const f of files) {
        const fullPath = path.join(GENERATED_IMAGES_DIR, f);
        try {
          const stat = fs.statSync(fullPath);
          // Skip tiny icon variants
          if (stat.size < MIN_IMAGE_SIZE) continue;
          results.push({ filename: f, path: fullPath, mtime: stat.mtimeMs });
        } catch {
          // Skip unreadable files
        }
      }
      results.sort((a, b) => b.mtime - a.mtime);
      return results;
    } catch (err) {
      return [];
    }
  });
}

module.exports = { registerOracleHandlers, mapOracleError };
