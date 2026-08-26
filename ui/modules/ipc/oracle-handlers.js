/**
 * Oracle IPC Handlers
 * Channels: oracle:generateImage, oracle:deleteImage, oracle:listImages
 */

const fs = require('fs');
const path = require('path');
const {
  generateImage,
  removeHistoryEntryByPath,
  GENERATED_IMAGES_DIR,
} = require('../image-gen');

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
  const removeHistoryByPathFn = typeof deps.removeHistoryEntryByPath === 'function'
    ? deps.removeHistoryEntryByPath
    : removeHistoryEntryByPath;

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

      // Canonical history writer lives in image-gen module.
      try {
        removeHistoryByPathFn(resolved);
      } catch {
        // Non-fatal: image file delete still succeeds.
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // List all image files in generated-images directory (sorted newest first)
  // Returns file paths (CSP allows file: protocol). No base64 because IPC payloads can get large.
  const MIN_IMAGE_SIZE = 10000; // Skip icon-sized files (16x16, 32x32, 64x64 variants)

  // Fix legacy WEBP-in-.png files: rename to .webp based on magic bytes
  function fixMismatchedExtension(fullPath) {
    try {
      if (!fullPath.endsWith('.png')) return fullPath;
      const fd = fs.openSync(fullPath, 'r');
      const header = Buffer.alloc(12);
      fs.readSync(fd, header, 0, 12, 0);
      fs.closeSync(fd);
      if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
          header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) {
        const webpPath = fullPath.replace(/\.png$/i, '.webp');
        fs.renameSync(fullPath, webpPath);
        return webpPath;
      }
    } catch { /* non-fatal */ }
    return fullPath;
  }

  ipcMain.handle('oracle:listImages', async () => {
    try {
      if (!fs.existsSync(GENERATED_IMAGES_DIR)) return [];
      const files = fs.readdirSync(GENERATED_IMAGES_DIR)
        .filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f));

      // Build set of bases that have -converted versions (prefer converted over raw)
      const convertedBases = new Set();
      for (const f of files) {
        const match = f.match(/^(.+?)[.-]converted\.png$/i);
        if (match) convertedBases.add(match[1]);
      }

      const results = [];
      for (const f of files) {
        // Skip raw file if a -converted version exists
        const baseMatch = f.match(/^(.+?)\.(png|jpg|jpeg|gif|webp|svg)$/i);
        if (baseMatch && !f.includes('converted') && convertedBases.has(baseMatch[1])) continue;

        let fullPath = path.join(GENERATED_IMAGES_DIR, f);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < MIN_IMAGE_SIZE) continue;
          // Fix mismatched WEBP-in-.png on the fly
          fullPath = fixMismatchedExtension(fullPath);
          const filename = path.basename(fullPath);
          results.push({ filename, path: fullPath, mtime: stat.mtimeMs });
        } catch {
          // Skip unreadable files
        }
      }
      results.sort((a, b) => b.mtime - a.mtime);
      return results;
    } catch (_err) {
      return [];
    }
  });
}


function unregisterOracleHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('oracle:generateImage');
    ipcMain.removeHandler('oracle:deleteImage');
    ipcMain.removeHandler('oracle:listImages');
}

registerOracleHandlers.unregister = unregisterOracleHandlers;
module.exports = { registerOracleHandlers, mapOracleError };
