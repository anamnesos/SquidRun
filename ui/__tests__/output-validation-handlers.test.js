/**
 * Output Validation IPC Handler Tests
 * Target: Full coverage of output-validation-handlers.js
 */

const {
  createIpcHarness,
  createDefaultContext,
} = require('./helpers/ipc-harness');
const path = require('path');

// Mock fs
jest.mock('fs', () => {
  const realpathSync = jest.fn((targetPath) => targetPath);
  realpathSync.native = jest.fn((targetPath) => targetPath);
  return {
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    realpathSync,
  };
});

// Mock logger
jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const fs = require('fs');
const { registerOutputValidationHandlers } = require('../modules/ipc/output-validation-handlers');

describe('Output Validation Handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    ctx.WORKSPACE_PATH = '/test/workspace';
    fs.realpathSync.mockImplementation((targetPath) => targetPath);
    fs.realpathSync.native.mockImplementation((targetPath) => targetPath);

    registerOutputValidationHandlers(ctx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('registration', () => {
    test('throws if ctx is missing', () => {
      expect(() => registerOutputValidationHandlers(null)).toThrow('requires ctx.ipcMain');
    });

    test('throws if ipcMain is missing', () => {
      expect(() => registerOutputValidationHandlers({})).toThrow('requires ctx.ipcMain');
    });

    test('sets ctx.calculateConfidence', () => {
      expect(ctx.calculateConfidence).toBeDefined();
      expect(typeof ctx.calculateConfidence).toBe('function');
    });

    test('sets ctx.INCOMPLETE_PATTERNS', () => {
      expect(ctx.INCOMPLETE_PATTERNS).toBeDefined();
      expect(Array.isArray(ctx.INCOMPLETE_PATTERNS)).toBe(true);
    });
  });

  describe('validate-output', () => {
    test('returns valid result for clean text', async () => {
      const result = await harness.invoke('validate-output', 'This is a complete and well-written implementation that is finished and working.');

      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    test('detects TODO markers', async () => {
      const result = await harness.invoke('validate-output', 'Some code TODO: fix this later');

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.match === 'TODO:')).toBe(true);
    });

    test('detects FIXME markers', async () => {
      const result = await harness.invoke('validate-output', 'FIXME: broken code here');

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.match === 'FIXME:')).toBe(true);
    });

    test('detects XXX markers', async () => {
      const result = await harness.invoke('validate-output', 'XXX: this is a hack');

      expect(result.valid).toBe(false);
    });

    test('detects HACK markers', async () => {
      const result = await harness.invoke('validate-output', 'HACK: temporary solution');

      expect(result.valid).toBe(false);
    });

    test('detects trailing ellipsis', async () => {
      const result = await harness.invoke('validate-output', 'The implementation is...');

      expect(result.valid).toBe(false);
      expect(result.issues.some(i => i.type === 'incomplete')).toBe(true);
    });

    test('detects "not implemented" text', async () => {
      const result = await harness.invoke('validate-output', 'This feature is not implemented yet');

      expect(result.valid).toBe(false);
    });

    test('detects "placeholder" text', async () => {
      const result = await harness.invoke('validate-output', 'This is just a placeholder for now');

      expect(result.valid).toBe(false);
    });

    test('calculates confidence score', async () => {
      const result = await harness.invoke('validate-output', 'DONE! The feature is complete and fully implemented.');

      expect(result.confidence).toBeGreaterThan(50);
    });

    test('adds low confidence warning', async () => {
      const result = await harness.invoke('validate-output', 'TODO: fix');

      expect(result.warnings.some(w => w.type === 'low_confidence')).toBe(true);
    });

    test('validates JavaScript syntax when option set', async () => {
      const result = await harness.invoke('validate-output', 'const x = {;', {
        checkSyntax: true,
        language: 'javascript',
      });

      expect(result.issues.some(i => i.type === 'syntax')).toBe(true);
    });

    test('passes valid JavaScript syntax', async () => {
      const result = await harness.invoke('validate-output', 'const x = 1; console.log(x);', {
        checkSyntax: true,
        language: 'javascript',
      });

      expect(result.issues.filter(i => i.type === 'syntax')).toEqual([]);
    });

    test('validates JSON when option set', async () => {
      const result = await harness.invoke('validate-output', '{"invalid": json}', {
        checkJson: true,
      });

      expect(result.issues.some(i => i.type === 'json')).toBe(true);
    });

    test('passes valid JSON', async () => {
      const result = await harness.invoke('validate-output', '{"valid": "json"}', {
        checkJson: true,
      });

      expect(result.issues.filter(i => i.type === 'json')).toEqual([]);
    });

    test('penalizes short text', async () => {
      const shortResult = await harness.invoke('validate-output', 'ok');
      const longResult = await harness.invoke('validate-output', 'This is a much longer piece of text that provides more context and detail about the implementation, which should result in a higher confidence score than the very short text.');

      expect(shortResult.confidence).toBeLessThan(longResult.confidence);
    });

    test('boosts long text confidence', async () => {
      const longText = 'a'.repeat(600) + ' DONE';
      const result = await harness.invoke('validate-output', longText);

      expect(result.confidence).toBeGreaterThan(50);
    });
  });

  describe('validate-file', () => {
    test('returns error when file not found', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await harness.invoke('validate-file', 'missing.js');

      expect(result.success).toBe(false);
      expect(result.error).toBe('File not found');
    });

    test('validates .js files with syntax check', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('const x = 1;');

      const result = await harness.invoke('validate-file', 'file.js');

      expect(result.success).toBe(true);
      expect(result.extension).toBe('.js');
    });

    test('validates .ts files with syntax check', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('const x: number = 1;');

      const result = await harness.invoke('validate-file', 'file.ts');

      expect(result.extension).toBe('.ts');
    });

    test('validates .json files with JSON check', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('{"key": "value"}');

      const result = await harness.invoke('validate-file', 'file.json');

      expect(result.success).toBe(true);
      expect(result.valid).toBe(true);
    });

    test('handles read error', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = await harness.invoke('validate-file', 'file.js');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read error');
    });

    test('includes file path in result', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('valid code');

      const result = await harness.invoke('validate-file', 'myfile.js');

      expect(result.filePath).toBe(path.resolve('/test/workspace', 'myfile.js'));
    });

    test('rejects absolute paths outside workspace boundary', async () => {
      fs.existsSync.mockReturnValue(true);

      const result = await harness.invoke('validate-file', '/test/other/file.js');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Path outside project boundary');
    });

    test('rejects relative traversal outside workspace boundary', async () => {
      fs.existsSync.mockReturnValue(true);

      const result = await harness.invoke('validate-file', '../outside.js');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Path outside project boundary');
    });

    test('canonicalizes path before reading file', async () => {
      fs.existsSync.mockReturnValue(true);
      const resolvedWorkspace = path.resolve('/test/workspace');
      const resolvedLinkPath = path.resolve('/test/workspace', 'link.js');
      const canonicalWorkspace = path.resolve('/canonical/workspace');
      const canonicalRealFile = path.resolve('/canonical/workspace', 'real.js');
      fs.realpathSync.native.mockImplementation((targetPath) => {
        if (targetPath === resolvedWorkspace) return canonicalWorkspace;
        if (targetPath === resolvedLinkPath) return canonicalRealFile;
        return targetPath;
      });
      fs.readFileSync.mockReturnValue('const x = 1;');

      const result = await harness.invoke('validate-file', 'link.js');

      expect(fs.readFileSync).toHaveBeenCalledWith(canonicalRealFile, 'utf-8');
      expect(result.filePath).toBe(canonicalRealFile);
    });
  });

  describe('get-validation-patterns', () => {
    test('returns incomplete patterns', async () => {
      const result = await harness.invoke('get-validation-patterns');

      expect(result.incomplete).toBeDefined();
      expect(result.incomplete.length).toBeGreaterThan(0);
      expect(result.incomplete.some(p => p.includes('TODO'))).toBe(true);
    });

    test('returns completion patterns', async () => {
      const result = await harness.invoke('get-validation-patterns');

      expect(result.completion).toBeDefined();
      expect(result.completion.length).toBeGreaterThan(0);
      expect(result.completion.some(p => p.includes('DONE'))).toBe(true);
    });
  });
});
