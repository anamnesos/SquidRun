/**
 * Screenshot IPC Handler Tests
 * Target: Full coverage of screenshot-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');

// Mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  appendFileSync: jest.fn(),
  readdirSync: jest.fn(),
  statSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

const fs = require('fs');
const { registerScreenshotHandlers } = require('../modules/ipc/screenshot-handlers');

describe('Screenshot Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.writeFileSync.mockImplementation(() => {});
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.SCREENSHOTS_DIR = '/test/screenshots';
    ctx.mainWindow.isDestroyed = jest.fn(() => false);

    registerScreenshotHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('save-screenshot', () => {
    test('saves screenshot with base64 data', async () => {
      fs.existsSync.mockReturnValue(true);
      const base64Data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      const result = await harness.invoke('save-screenshot', base64Data, 'test.png');

      expect(result.success).toBe(true);
      expect(result.filename).toMatch(/^screenshot-\d+\.png$/);
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('creates directory if not exists', async () => {
      fs.existsSync.mockReturnValue(false);
      const base64Data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      await harness.invoke('save-screenshot', base64Data, 'test.png');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/test/screenshots', { recursive: true });
    });

    test('saves to latest.png', async () => {
      fs.existsSync.mockReturnValue(true);
      const base64Data = 'data:image/png;base64,SGVsbG8=';

      await harness.invoke('save-screenshot', base64Data, 'test.png');

      const calls = fs.writeFileSync.mock.calls;
      const latestCall = calls.find(c => c[0].includes('latest.png'));
      expect(latestCall).toBeDefined();
    });

    test('appends to index.md', async () => {
      fs.existsSync.mockReturnValue(true);
      const base64Data = 'data:image/png;base64,SGVsbG8=';

      await harness.invoke('save-screenshot', base64Data, 'test.png');

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining('index.md'),
        expect.any(String)
      );
    });

    test('uses default .png extension when originalName has no extension', async () => {
      fs.existsSync.mockReturnValue(true);
      const base64Data = 'data:image/png;base64,SGVsbG8=';

      const result = await harness.invoke('save-screenshot', base64Data, 'noext');

      expect(result.filename).toMatch(/\.png$/);
    });

    test('uses default .png extension when no originalName', async () => {
      fs.existsSync.mockReturnValue(true);
      const base64Data = 'data:image/png;base64,SGVsbG8=';

      const result = await harness.invoke('save-screenshot', base64Data);

      expect(result.filename).toMatch(/\.png$/);
    });

    test('preserves original extension', async () => {
      fs.existsSync.mockReturnValue(true);
      const base64Data = 'data:image/jpeg;base64,SGVsbG8=';

      const result = await harness.invoke('save-screenshot', base64Data, 'photo.jpg');

      expect(result.filename).toMatch(/\.jpg$/);
    });

    test('sends screenshot-added event', async () => {
      fs.existsSync.mockReturnValue(true);
      const base64Data = 'data:image/png;base64,SGVsbG8=';

      await harness.invoke('save-screenshot', base64Data, 'test.png');

      expect(ctx.mainWindow.webContents.send).toHaveBeenCalledWith('screenshot-added', {
        filename: expect.any(String),
        path: expect.any(String),
      });
    });

    test('handles destroyed mainWindow', async () => {
      ctx.mainWindow.isDestroyed.mockReturnValue(true);
      fs.existsSync.mockReturnValue(true);
      const base64Data = 'data:image/png;base64,SGVsbG8=';

      const result = await harness.invoke('save-screenshot', base64Data, 'test.png');

      expect(result.success).toBe(true);
      expect(ctx.mainWindow.webContents.send).not.toHaveBeenCalled();
    });

    test('handles write error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Disk full');
      });
      const base64Data = 'data:image/png;base64,SGVsbG8=';

      const result = await harness.invoke('save-screenshot', base64Data, 'test.png');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Disk full');
    });

    test('strips data URI prefix from base64', async () => {
      fs.existsSync.mockReturnValue(true);
      const base64Data = 'data:image/png;base64,SGVsbG8=';

      await harness.invoke('save-screenshot', base64Data, 'test.png');

      const writeCall = fs.writeFileSync.mock.calls[0];
      const buffer = writeCall[1];
      // The buffer should be decoded from 'SGVsbG8=' (which is "Hello")
      expect(buffer.toString()).toBe('Hello');
    });
  });

  describe('capture-screenshot', () => {
    test('captures full window when pane is not specified', async () => {
      fs.existsSync.mockReturnValue(true);
      const image = { toPNG: jest.fn(() => Buffer.from('png-data')) };
      ctx.mainWindow.webContents.capturePage = jest.fn().mockResolvedValue(image);
      ctx.mainWindow.webContents.executeJavaScript = jest.fn();

      const result = await harness.invoke('capture-screenshot');

      expect(result).toEqual(expect.objectContaining({
        success: true,
        paneId: null,
        scope: 'all',
      }));
      expect(ctx.mainWindow.webContents.capturePage).toHaveBeenCalledWith();
      expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('latest.png'),
        expect.any(Buffer)
      );
    });

    test('captures specific pane region when pane rect resolves', async () => {
      fs.existsSync.mockReturnValue(true);
      const image = { toPNG: jest.fn(() => Buffer.from('pane-data')) };
      const rect = { x: 10, y: 20, width: 300, height: 120 };
      ctx.mainWindow.webContents.executeJavaScript = jest.fn().mockResolvedValue(rect);
      ctx.mainWindow.webContents.capturePage = jest.fn().mockResolvedValue(image);

      const result = await harness.invoke('capture-screenshot', { paneId: '3' });

      expect(result).toEqual(expect.objectContaining({
        success: true,
        paneId: '3',
        scope: 'pane',
      }));
      expect(ctx.mainWindow.webContents.executeJavaScript).toHaveBeenCalled();
      expect(ctx.mainWindow.webContents.capturePage).toHaveBeenCalledWith(rect);
      expect(result.filename).toMatch(/^capture-pane-3-\d+\.png$/);
    });

    test('returns window-not-available when window is destroyed', async () => {
      ctx.mainWindow.isDestroyed = jest.fn(() => true);

      const result = await harness.invoke('capture-screenshot');

      expect(result).toEqual({ success: false, error: 'Window not available' });
    });
  });

  describe('list-screenshots', () => {
    test('creates directory and returns empty list when not exists', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('list-screenshots');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/test/screenshots', { recursive: true });
      expect(result).toEqual({ success: true, files: [] });
    });

    test('returns list of image files sorted by date', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['old.png', 'new.png', 'text.txt']);
      fs.statSync.mockImplementation((path) => {
        if (path.includes('old.png')) {
          return { size: 1000, mtime: new Date('2026-01-01') };
        }
        if (path.includes('new.png')) {
          return { size: 2000, mtime: new Date('2026-01-02') };
        }
        return { size: 100, mtime: new Date('2026-01-01') };
      });

      const result = await harness.invoke('list-screenshots');

      expect(result.success).toBe(true);
      expect(result.files.length).toBe(2); // Only image files
      expect(result.files[0].name).toBe('new.png'); // Sorted newest first
    });

    test('includes all image extensions', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'g.txt']);
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });

      const result = await harness.invoke('list-screenshots');

      expect(result.files.length).toBe(6);
    });

    test('includes file metadata', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['test.png']);
      fs.statSync.mockReturnValue({ size: 5000, mtime: new Date('2026-01-15T12:00:00Z') });

      const result = await harness.invoke('list-screenshots');

      expect(result.files[0]).toEqual({
        name: 'test.png',
        path: expect.stringContaining('test.png'),
        size: 5000,
        modified: '2026-01-15T12:00:00.000Z',
      });
    });

    test('filters out latest.png from listing', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['screenshot-1.png', 'latest.png', 'screenshot-2.png']);
      fs.statSync.mockReturnValue({ size: 1000, mtime: new Date() });

      const result = await harness.invoke('list-screenshots');

      expect(result.files.length).toBe(2);
      expect(result.files.map(f => f.name)).not.toContain('latest.png');
    });

    test('handles readdir error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      const result = await harness.invoke('list-screenshots');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });
  });

  describe('delete-screenshot', () => {
    test('deletes file when exists', async () => {
      fs.existsSync.mockReturnValue(true);

      const result = await harness.invoke('delete-screenshot', 'old.png');

      expect(fs.unlinkSync).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('succeeds silently when file not exists', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('delete-screenshot', 'missing.png');

      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    test('handles delete error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => {
        throw new Error('File locked');
      });

      const result = await harness.invoke('delete-screenshot', 'locked.png');

      expect(result.success).toBe(false);
      expect(result.error).toBe('File locked');
    });

    test('rejects path traversal filenames', async () => {
      const result = await harness.invoke('delete-screenshot', '../secret.txt');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid filename');
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });

  describe('get-screenshot-path', () => {
    test('returns path and exists true when file exists', async () => {
      fs.existsSync.mockReturnValue(true);

      const result = await harness.invoke('get-screenshot-path', 'test.png');

      expect(result.path).toContain('test.png');
      expect(result.exists).toBe(true);
    });

    test('returns path and exists false when file not exists', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('get-screenshot-path', 'missing.png');

      expect(result.path).toContain('missing.png');
      expect(result.exists).toBe(false);
    });

    test('rejects path traversal filenames', async () => {
      const result = await harness.invoke('get-screenshot-path', '../secret.txt');

      expect(result.path).toBeNull();
      expect(result.exists).toBe(false);
      expect(result.error).toBe('Invalid filename');
    });
  });
});
