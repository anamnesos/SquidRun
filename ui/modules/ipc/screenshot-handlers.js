/**
 * Screenshot IPC Handlers
 * Channels: save-screenshot, list-screenshots, delete-screenshot, get-screenshot-path, capture-screenshot
 */

const fs = require('fs');
const path = require('path');

function sanitizePaneSegment(paneId) {
  const raw = String(paneId || '').trim();
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9_-]/g, '');
}

async function resolvePaneCaptureRect(mainWindow, paneId) {
  if (!mainWindow?.webContents?.executeJavaScript) return null;
  const safePaneId = String(paneId || '').trim();
  if (!safePaneId) return null;

  // capturePage() expects DIP (device-independent pixel) coordinates — same units
  // as getBoundingClientRect(). Do NOT multiply by devicePixelRatio.
  const script = `(() => {
    const pane = document.querySelector('.pane[data-pane-id="${safePaneId.replace(/"/g, '\\"')}"]');
    if (!pane) return null;
    const rect = pane.getBoundingClientRect();
    const width = Math.max(0, Math.round(rect.width));
    const height = Math.max(0, Math.round(rect.height));
    if (!width || !height) return null;
    return {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.top)),
      width,
      height,
    };
  })();`;

  try {
    const rect = await mainWindow.webContents.executeJavaScript(script, true);
    if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
    if (rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  } catch {
    return null;
  }
}

async function captureScreenshot(ctx, options = {}) {
  const SCREENSHOTS_DIR = ctx?.SCREENSHOTS_DIR;
  const mainWindow = ctx?.mainWindow;

  try {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false, error: 'Window not available' };
    }

    const paneId = typeof options?.paneId === 'string' || typeof options?.paneId === 'number'
      ? String(options.paneId).trim()
      : '';
    const rect = paneId ? await resolvePaneCaptureRect(mainWindow, paneId) : null;

    const image = rect
      ? await mainWindow.webContents.capturePage(rect)
      : await mainWindow.webContents.capturePage();
    const buffer = image.toPNG();

    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    const timestamp = Date.now();
    const paneSegment = sanitizePaneSegment(paneId);
    const filename = paneSegment
      ? `capture-pane-${paneSegment}-${timestamp}.png`
      : `capture-${timestamp}.png`;
    const filePath = path.join(SCREENSHOTS_DIR, filename);

    fs.writeFileSync(filePath, buffer);

    const latestPath = path.join(SCREENSHOTS_DIR, 'latest.png');
    fs.writeFileSync(latestPath, buffer);

    return {
      success: true,
      filename,
      path: filePath,
      paneId: paneId || null,
      scope: rect ? 'pane' : 'all',
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function registerScreenshotHandlers(ctx) {
  const { ipcMain, SCREENSHOTS_DIR } = ctx;

  const isSafeScreenshotFilename = (name) => {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (trimmed === '.' || trimmed === '..') return false;
    if (trimmed.includes('/') || trimmed.includes('\\')) return false;
    if (path.basename(trimmed) !== trimmed) return false;
    const resolvedPath = path.resolve(SCREENSHOTS_DIR, trimmed);
    const relative = path.relative(SCREENSHOTS_DIR, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    return true;
  };

  // Capture current window as screenshot (for Oracle Visual QA)
  ipcMain.handle('capture-screenshot', async (event, payload = {}) => {
    const options = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    return captureScreenshot({ ...ctx, SCREENSHOTS_DIR }, options);
  });

  ipcMain.handle('save-screenshot', (event, base64Data, originalName) => {
    try {
      if (!fs.existsSync(SCREENSHOTS_DIR)) {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      }

      const timestamp = Date.now();
      const ext = originalName ? path.extname(originalName) || '.png' : '.png';
      const filename = `screenshot-${timestamp}${ext}`;
      const filePath = path.join(SCREENSHOTS_DIR, filename);

      const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Content, 'base64');
      fs.writeFileSync(filePath, buffer);

      const latestPath = path.join(SCREENSHOTS_DIR, 'latest.png');
      fs.writeFileSync(latestPath, buffer);

      const indexPath = path.join(SCREENSHOTS_DIR, 'index.md');
      const entry = `- **${new Date().toISOString()}**: \`${filename}\` → To view: read \`workspace/screenshots/latest.png\`\n`;
      fs.appendFileSync(indexPath, entry);

      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('screenshot-added', { filename, path: filePath });
      }

      return { success: true, filename, path: filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-screenshots', () => {
    try {
      if (!fs.existsSync(SCREENSHOTS_DIR)) {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        return { success: true, files: [] };
      }

      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
      const files = fs.readdirSync(SCREENSHOTS_DIR)
        .filter(f => f !== 'latest.png' && imageExts.includes(path.extname(f).toLowerCase()))
        .map(f => {
          const filePath = path.join(SCREENSHOTS_DIR, f);
          const stats = fs.statSync(filePath);
          return {
            name: f,
            path: filePath,
            size: stats.size,
            modified: stats.mtime.toISOString(),
          };
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));

      return { success: true, files };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('delete-screenshot', (event, filename) => {
    try {
      if (!isSafeScreenshotFilename(filename)) {
        return { success: false, error: 'Invalid filename' };
      }
      const sanitized = filename.trim();
      const filePath = path.join(SCREENSHOTS_DIR, sanitized);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-screenshot-path', (event, filename) => {
    if (!isSafeScreenshotFilename(filename)) {
      return { path: null, exists: false, error: 'Invalid filename' };
    }
    const filePath = path.join(SCREENSHOTS_DIR, filename.trim());
    return { path: filePath, exists: fs.existsSync(filePath) };
  });
}


function unregisterScreenshotHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('capture-screenshot');
    ipcMain.removeHandler('save-screenshot');
    ipcMain.removeHandler('list-screenshots');
    ipcMain.removeHandler('delete-screenshot');
    ipcMain.removeHandler('get-screenshot-path');
}

registerScreenshotHandlers.unregister = unregisterScreenshotHandlers;
module.exports = {
  registerScreenshotHandlers,
  captureScreenshot,
};
