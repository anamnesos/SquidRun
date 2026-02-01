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
  });
});
