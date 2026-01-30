/**
 * Documentation Generator IPC Handlers Tests
 * Target: Full coverage of modules/ipc/doc-generator-handlers.js
 */

const path = require('path');

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  readdirSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

// Mock doc generator
const mockGeneratorInstance = {
  generateForFile: jest.fn(),
  generateForDirectory: jest.fn(),
  writeDocumentation: jest.fn(),
};

jest.mock('../modules/analysis/doc-generator', () => ({
  createDocGenerator: jest.fn(() => mockGeneratorInstance),
}));

const fs = require('fs');
const docGenerator = require('../modules/analysis/doc-generator');
const { registerDocGeneratorHandlers } = require('../modules/ipc/doc-generator-handlers');

describe('Documentation Generator IPC Handlers', () => {
  let mockIpcMain;
  let handlers;
  const WORKSPACE_PATH = '/test/workspace';

  beforeEach(() => {
    jest.clearAllMocks();

    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      }),
    };

    // Default mock implementations
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue('{}');
    fs.writeFileSync.mockReturnValue(undefined);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.readdirSync.mockReturnValue([]);

    mockGeneratorInstance.generateForFile.mockResolvedValue({
      success: true,
      documentation: '# Test Doc',
      elements: [{ name: 'test', type: 'function' }],
      stats: { functions: 1 },
    });

    mockGeneratorInstance.generateForDirectory.mockResolvedValue({
      success: true,
      files: ['file1.js'],
      totalElements: 5,
      results: [],
      stats: { functions: 3, classes: 2, documented: 4, undocumented: 1 },
    });

    mockGeneratorInstance.writeDocumentation.mockResolvedValue(undefined);
  });

  describe('registerDocGeneratorHandlers', () => {
    test('does nothing if ipcMain is missing', () => {
      registerDocGeneratorHandlers({});

      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('does nothing if WORKSPACE_PATH is missing', () => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain });

      expect(mockIpcMain.handle).not.toHaveBeenCalled();
    });

    test('registers all expected handlers', () => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });

      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-generate-file', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-generate-directory', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-generate-project', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-preview', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-export', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-get-config', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-set-config', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-get-coverage', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-get-undocumented', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-generate-ipc', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-get-cached', expect.any(Function));
      expect(mockIpcMain.handle).toHaveBeenCalledWith('docs-clear-cache', expect.any(Function));
    });

    test('loads config on initialization', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        projectName: 'CustomProject',
        version: '2.0.0',
      }));

      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });

      expect(fs.existsSync).toHaveBeenCalled();
      expect(fs.readFileSync).toHaveBeenCalled();
    });

    test('handles config load error gracefully', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      expect(() => {
        registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
      }).not.toThrow();
    });
  });

  describe('docs-generate-file', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns error when filePath is missing', async () => {
      const result = await handlers['docs-generate-file']({}, {});

      expect(result).toEqual({ success: false, error: 'File path required' });
    });

    test('generates docs for relative file path', async () => {
      const result = await handlers['docs-generate-file']({}, { filePath: 'src/main.js' });

      expect(result.success).toBe(true);
      expect(mockGeneratorInstance.generateForFile).toHaveBeenCalledWith(
        expect.stringContaining('main.js')
      );
    });

    test('generates docs for absolute file path', async () => {
      const result = await handlers['docs-generate-file']({}, {
        filePath: '/absolute/path/file.js',
      });

      expect(result.success).toBe(true);
      expect(mockGeneratorInstance.generateForFile).toHaveBeenCalledWith('/absolute/path/file.js');
    });

    test('uses custom format', async () => {
      await handlers['docs-generate-file']({}, {
        filePath: 'test.js',
        format: 'html',
      });

      expect(docGenerator.createDocGenerator).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'html' })
      );
    });

    test('caches successful result', async () => {
      const result = await handlers['docs-generate-file']({}, { filePath: 'test.js' });

      expect(result.success).toBe(true);
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('handles generation error', async () => {
      mockGeneratorInstance.generateForFile.mockRejectedValue(new Error('Parse error'));

      const result = await handlers['docs-generate-file']({}, { filePath: 'bad.js' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Parse error');
    });
  });

  describe('docs-generate-directory', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('generates docs for default directory', async () => {
      const result = await handlers['docs-generate-directory']({}, {});

      expect(result.success).toBe(true);
      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalled();
    });

    test('generates docs for relative directory', async () => {
      await handlers['docs-generate-directory']({}, { dirPath: 'src' });

      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalledWith(
        expect.stringContaining('src'),
        expect.any(Object)
      );
    });

    test('generates docs for absolute directory', async () => {
      await handlers['docs-generate-directory']({}, { dirPath: '/absolute/path' });

      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalledWith(
        '/absolute/path',
        expect.any(Object)
      );
    });

    test('respects recursive option', async () => {
      await handlers['docs-generate-directory']({}, { recursive: false });

      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ recursive: false })
      );
    });

    test('handles generation error', async () => {
      mockGeneratorInstance.generateForDirectory.mockRejectedValue(new Error('Dir error'));

      const result = await handlers['docs-generate-directory']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Dir error');
    });
  });

  describe('docs-generate-project', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('generates docs for entire project', async () => {
      const result = await handlers['docs-generate-project']({}, {});

      expect(result.success).toBe(true);
      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalled();
    });

    test('writes to output directory if specified', async () => {
      await handlers['docs-generate-project']({}, { outputDir: './docs/output' });

      expect(mockGeneratorInstance.writeDocumentation).toHaveBeenCalled();
    });

    test('writes to absolute output directory', async () => {
      await handlers['docs-generate-project']({}, { outputDir: '/absolute/docs' });

      expect(mockGeneratorInstance.writeDocumentation).toHaveBeenCalledWith(
        expect.any(Object),
        '/absolute/docs'
      );
    });

    test('does not write if generation fails', async () => {
      mockGeneratorInstance.generateForDirectory.mockResolvedValue({
        success: false,
        error: 'Generation failed',
      });

      await handlers['docs-generate-project']({}, { outputDir: './docs' });

      expect(mockGeneratorInstance.writeDocumentation).not.toHaveBeenCalled();
    });

    test('handles generation error', async () => {
      mockGeneratorInstance.generateForDirectory.mockRejectedValue(new Error('Project error'));

      const result = await handlers['docs-generate-project']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Project error');
    });
  });

  describe('docs-preview', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns error when filePath is missing', async () => {
      const result = await handlers['docs-preview']({}, {});

      expect(result).toEqual({ success: false, error: 'File path required' });
    });

    test('returns preview for file', async () => {
      const result = await handlers['docs-preview']({}, { filePath: 'test.js' });

      expect(result.success).toBe(true);
      expect(result.preview).toBe('# Test Doc');
      expect(result.format).toBe('markdown');
      expect(result.elements).toBe(1);
    });

    test('uses custom format', async () => {
      await handlers['docs-preview']({}, { filePath: 'test.js', format: 'html' });

      expect(docGenerator.createDocGenerator).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'html' })
      );
    });

    test('returns error if generation fails', async () => {
      mockGeneratorInstance.generateForFile.mockResolvedValue({
        success: false,
        error: 'Parse failed',
      });

      const result = await handlers['docs-preview']({}, { filePath: 'bad.js' });

      expect(result.success).toBe(false);
    });

    test('handles preview error', async () => {
      mockGeneratorInstance.generateForFile.mockRejectedValue(new Error('Preview error'));

      const result = await handlers['docs-preview']({}, { filePath: 'test.js' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Preview error');
    });
  });

  describe('docs-export', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('exports docs to default output directory', async () => {
      const result = await handlers['docs-export']({}, {});

      expect(result.success).toBe(true);
      expect(mockGeneratorInstance.writeDocumentation).toHaveBeenCalled();
    });

    test('exports docs from relative source directory', async () => {
      await handlers['docs-export']({}, { dirPath: 'src' });

      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalledWith(
        expect.stringContaining('src'),
        expect.any(Object)
      );
    });

    test('exports docs to custom output directory', async () => {
      await handlers['docs-export']({}, { outputDir: './custom-docs' });

      expect(mockGeneratorInstance.writeDocumentation).toHaveBeenCalled();
    });

    test('exports docs with absolute paths', async () => {
      await handlers['docs-export']({}, {
        dirPath: '/absolute/src',
        outputDir: '/absolute/docs',
      });

      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalledWith(
        '/absolute/src',
        expect.any(Object)
      );
    });

    test('returns error if generation fails', async () => {
      mockGeneratorInstance.generateForDirectory.mockResolvedValue({
        success: false,
        error: 'Generation failed',
      });

      const result = await handlers['docs-export']({}, {});

      expect(result.success).toBe(false);
    });

    test('handles export error', async () => {
      mockGeneratorInstance.generateForDirectory.mockRejectedValue(new Error('Export error'));

      const result = await handlers['docs-export']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Export error');
    });
  });

  describe('docs-get-config', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns current config', async () => {
      const result = await handlers['docs-get-config']({});

      expect(result.success).toBe(true);
      expect(result.config).toBeDefined();
      expect(result.config.projectName).toBeDefined();
      expect(result.config.format).toBeDefined();
    });
  });

  describe('docs-set-config', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns error when config is missing', async () => {
      const result = await handlers['docs-set-config']({}, {});

      expect(result).toEqual({ success: false, error: 'Config required' });
    });

    test('updates config and saves', async () => {
      const result = await handlers['docs-set-config']({}, {
        config: { projectName: 'NewProject', version: '3.0.0' },
      });

      expect(result.success).toBe(true);
      expect(result.config.projectName).toBe('NewProject');
      expect(result.config.version).toBe('3.0.0');
      expect(fs.writeFileSync).toHaveBeenCalled();
    });

    test('creates config directory if needed', async () => {
      fs.existsSync.mockReturnValue(false);

      await handlers['docs-set-config']({}, { config: { projectName: 'Test' } });

      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    test('handles save config error gracefully', async () => {
      fs.writeFileSync.mockImplementation(() => {
        throw new Error('Write error');
      });

      const result = await handlers['docs-set-config']({}, { config: { projectName: 'Test' } });

      // Should still succeed even if save fails
      expect(result.success).toBe(true);
    });
  });

  describe('docs-get-coverage', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns coverage stats for default directory', async () => {
      const result = await handlers['docs-get-coverage']({}, {});

      expect(result.success).toBe(true);
      expect(result.coverage).toBeDefined();
      expect(result.documented).toBeDefined();
      expect(result.undocumented).toBeDefined();
    });

    test('returns coverage stats for specific directory', async () => {
      await handlers['docs-get-coverage']({}, { dirPath: 'src' });

      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalledWith(
        expect.stringContaining('src'),
        expect.any(Object)
      );
    });

    test('calculates coverage percentage correctly', async () => {
      mockGeneratorInstance.generateForDirectory.mockResolvedValue({
        success: true,
        stats: { functions: 8, classes: 2, documented: 5, undocumented: 5 },
      });

      const result = await handlers['docs-get-coverage']({}, {});

      expect(result.coverage).toBe(50);
    });

    test('handles zero elements', async () => {
      mockGeneratorInstance.generateForDirectory.mockResolvedValue({
        success: true,
        stats: { functions: 0, classes: 0, documented: 0, undocumented: 0 },
      });

      const result = await handlers['docs-get-coverage']({}, {});

      expect(result.coverage).toBe(100);
    });

    test('returns error if generation fails', async () => {
      mockGeneratorInstance.generateForDirectory.mockResolvedValue({
        success: false,
        error: 'Failed',
      });

      const result = await handlers['docs-get-coverage']({}, {});

      expect(result.success).toBe(false);
    });

    test('handles coverage error', async () => {
      mockGeneratorInstance.generateForDirectory.mockRejectedValue(new Error('Coverage error'));

      const result = await handlers['docs-get-coverage']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Coverage error');
    });
  });

  describe('docs-get-undocumented', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns empty list when all documented', async () => {
      mockGeneratorInstance.generateForDirectory.mockResolvedValue({
        success: true,
        results: [{
          filePath: '/test/file.js',
          elements: [
            { name: 'func1', type: 'function', description: 'Doc', exported: true },
          ],
        }],
      });

      const result = await handlers['docs-get-undocumented']({}, {});

      expect(result.success).toBe(true);
      expect(result.undocumented).toEqual([]);
      expect(result.count).toBe(0);
    });

    test('returns undocumented items', async () => {
      mockGeneratorInstance.generateForDirectory.mockResolvedValue({
        success: true,
        results: [{
          filePath: '/test/workspace/file.js',
          elements: [
            { name: 'undocFunc', type: 'function', description: null, exported: true, line: 10 },
            { name: 'docFunc', type: 'function', description: 'Has docs', exported: true },
            { name: 'UndocClass', type: 'class', description: '', exported: true, line: 50 },
            { name: 'privateFunc', type: 'function', description: null, exported: false },
          ],
        }],
      });

      const result = await handlers['docs-get-undocumented']({}, {});

      expect(result.success).toBe(true);
      expect(result.undocumented).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.undocumented[0].name).toBe('undocFunc');
      expect(result.undocumented[1].name).toBe('UndocClass');
    });

    test('handles absolute directory path', async () => {
      await handlers['docs-get-undocumented']({}, { dirPath: '/absolute/path' });

      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalledWith(
        '/absolute/path',
        expect.any(Object)
      );
    });

    test('returns error if generation fails', async () => {
      mockGeneratorInstance.generateForDirectory.mockResolvedValue({
        success: false,
        error: 'Failed',
      });

      const result = await handlers['docs-get-undocumented']({}, {});

      expect(result.success).toBe(false);
    });

    test('handles undocumented error', async () => {
      mockGeneratorInstance.generateForDirectory.mockRejectedValue(new Error('Undoc error'));

      const result = await handlers['docs-get-undocumented']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Undoc error');
    });
  });

  describe('docs-generate-ipc', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('generates docs for IPC modules', async () => {
      const result = await handlers['docs-generate-ipc']({}, {});

      expect(result.success).toBe(true);
      expect(mockGeneratorInstance.generateForDirectory).toHaveBeenCalledWith(
        expect.stringContaining('ipc'),
        expect.objectContaining({ recursive: false })
      );
    });

    test('uses custom format', async () => {
      await handlers['docs-generate-ipc']({}, { format: 'html' });

      expect(docGenerator.createDocGenerator).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'html' })
      );
    });

    test('handles IPC docs error', async () => {
      mockGeneratorInstance.generateForDirectory.mockRejectedValue(new Error('IPC error'));

      const result = await handlers['docs-generate-ipc']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('IPC error');
    });
  });

  describe('docs-get-cached', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('returns cached docs for specific file', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        timestamp: 12345,
        elements: [{ name: 'test' }],
      }));

      const result = await handlers['docs-get-cached']({}, { filePath: 'test.js' });

      expect(result.success).toBe(true);
      expect(result.cached.timestamp).toBe(12345);
    });

    test('returns error when file not cached', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await handlers['docs-get-cached']({}, { filePath: 'uncached.js' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not cached');
    });

    test('lists all cached files when no filePath', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['file1.json', 'file2.json']);
      fs.readFileSync.mockReturnValue(JSON.stringify({
        timestamp: 12345,
        elements: [{ name: 'test' }],
      }));

      const result = await handlers['docs-get-cached']({}, {});

      expect(result.success).toBe(true);
      expect(result.cached).toHaveLength(2);
    });

    test('handles parse error for individual cached files', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['good.json', 'bad.json']);
      fs.readFileSync
        .mockReturnValueOnce(JSON.stringify({ timestamp: 1, elements: [] }))
        .mockImplementationOnce(() => { throw new Error('Parse error'); });

      const result = await handlers['docs-get-cached']({}, {});

      expect(result.success).toBe(true);
      expect(result.cached).toHaveLength(1);
    });

    test('handles cache error', async () => {
      fs.existsSync.mockImplementation(() => { throw new Error('Cache error'); });

      const result = await handlers['docs-get-cached']({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cache error');
    });
  });

  describe('docs-clear-cache', () => {
    beforeEach(() => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });
    });

    test('clears all cached files', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue(['file1.json', 'file2.json']);

      const result = await handlers['docs-clear-cache']({});

      expect(result.success).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(2);
    });

    test('succeeds when cache is empty', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockReturnValue([]);

      const result = await handlers['docs-clear-cache']({});

      expect(result.success).toBe(true);
    });

    test('succeeds when cache directory does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await handlers['docs-clear-cache']({});

      expect(result.success).toBe(true);
    });

    test('handles clear cache error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readdirSync.mockImplementation(() => { throw new Error('Clear error'); });

      const result = await handlers['docs-clear-cache']({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Clear error');
    });
  });

  describe('lazy loading and generator instance', () => {
    test('creates new generator instance with refresh option', async () => {
      registerDocGeneratorHandlers({ ipcMain: mockIpcMain, WORKSPACE_PATH });

      // First call creates instance
      await handlers['docs-generate-file']({}, { filePath: 'test.js' });
      const callCount1 = docGenerator.createDocGenerator.mock.calls.length;

      // Second call reuses instance
      await handlers['docs-generate-file']({}, { filePath: 'test2.js' });
      const callCount2 = docGenerator.createDocGenerator.mock.calls.length;

      // Both should use same instance for same format
      expect(callCount2).toBe(callCount1);
    });
  });
});
