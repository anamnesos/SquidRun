/**
 * Oracle IPC handler tests — full coverage.
 */

jest.mock('../modules/image-gen', () => ({
  generateImage: jest.fn(),
  removeHistoryEntryByPath: jest.fn(),
  GENERATED_IMAGES_DIR: 'workspace\\generated-images',
}));

const { generateImage, removeHistoryEntryByPath } = require('../modules/image-gen');
const { createIpcHarness, createDefaultContext } = require('./helpers/ipc-harness');
const { registerOracleHandlers, mapOracleError } = require('../modules/ipc/oracle-handlers');

describe('oracle handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    registerOracleHandlers(ctx);
  });

  // ── mapOracleError ──

  describe('mapOracleError', () => {
    test('maps missing image key error', () => {
      const result = mapOracleError(new Error('No image generation API key available'));
      expect(result.code).toBe('MISSING_IMAGE_KEY');
    });

    test('maps missing openai key', () => {
      const result = mapOracleError(new Error('OPENAI_API_KEY is not set'));
      expect(result.code).toBe('MISSING_OPENAI_KEY');
    });

    test('maps missing recraft key', () => {
      const result = mapOracleError(new Error('RECRAFT_API_KEY not set'));
      expect(result.code).toBe('MISSING_RECRAFT_KEY');
    });

    test('maps generic error', () => {
      const result = mapOracleError(new Error('Random failure'));
      expect(result.code).toBe('IMAGE_GENERATION_FAILED');
      expect(result.error).toBe('Random failure');
    });

    test('handles null error', () => {
      const result = mapOracleError(null);
      expect(result.code).toBe('IMAGE_GENERATION_FAILED');
    });

    test('handles error without message', () => {
      const result = mapOracleError({});
      expect(result.code).toBe('IMAGE_GENERATION_FAILED');
    });
  });

  // ── ctx validation ──

  test('throws without ctx.ipcMain', () => {
    expect(() => registerOracleHandlers()).toThrow('requires ctx.ipcMain');
    expect(() => registerOracleHandlers({})).toThrow('requires ctx.ipcMain');
  });

  // ── oracle:generateImage ──

  describe('oracle:generateImage', () => {
    test('returns MISSING_IMAGE_KEY when no image key is available', async () => {
      generateImage.mockRejectedValue(new Error('No image generation API key available. Set RECRAFT_API_KEY or OPENAI_API_KEY.'));
      const result = await harness.invoke('oracle:generateImage', { prompt: 'test prompt' });
      expect(result.success).toBe(false);
      expect(result.code).toBe('MISSING_IMAGE_KEY');
    });

    test('returns MISSING_OPENAI_KEY for missing OpenAI provider key', async () => {
      generateImage.mockRejectedValue(new Error('OPENAI_API_KEY is not set'));
      const result = await harness.invoke('oracle:generateImage', { prompt: 'test prompt', provider: 'openai' });
      expect(result.success).toBe(false);
      expect(result.code).toBe('MISSING_OPENAI_KEY');
    });

    test('returns success with imagePath and provider', async () => {
      generateImage.mockResolvedValue({ imagePath: '/images/cat.png', provider: 'recraft' });
      const result = await harness.invoke('oracle:generateImage', {
        prompt: 'a cat', provider: 'recraft', style: 'realistic_image', size: '1024x1024'
      });
      expect(result.success).toBe(true);
      expect(result.imagePath).toBe('/images/cat.png');
      expect(result.provider).toBe('recraft');
      expect(generateImage).toHaveBeenCalledWith({
        prompt: 'a cat', provider: 'recraft', style: 'realistic_image', size: '1024x1024'
      });
    });

    test('handles empty/undefined payload', async () => {
      generateImage.mockResolvedValue({ imagePath: '/x.png', provider: 'openai' });
      const result = await harness.invoke('oracle:generateImage');
      expect(result.success).toBe(true);
    });
  });

  // ── oracle:deleteImage ──

  describe('oracle:deleteImage', () => {
    test('registers no renderer history writer handlers', () => {
      expect(harness.handlers.has('save-oracle-history')).toBe(false);
      expect(harness.handlers.has('load-oracle-history')).toBe(false);
    });

    test('routes history updates through image-gen canonical writer', async () => {
      const result = await harness.invoke(
        'oracle:deleteImage',
        'workspace\\generated-images\\icon-test.png'
      );
      expect(result.success).toBe(true);
      expect(removeHistoryEntryByPath).toHaveBeenCalledWith(
        expect.stringContaining('generated-images')
      );
    });

    test('rejects path outside generated-images directory', async () => {
      const result = await harness.invoke('oracle:deleteImage', 'outside\\evil.exe');
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    });

    test('succeeds even if removeHistory throws', async () => {
      removeHistoryEntryByPath.mockImplementation(() => { throw new Error('history fail'); });
      const result = await harness.invoke(
        'oracle:deleteImage',
        'workspace\\generated-images\\test.png'
      );
      expect(result.success).toBe(true);
    });
  });

  // ── unregister ──

  describe('unregister', () => {
    test('removes all oracle handlers', () => {
      registerOracleHandlers.unregister({ ipcMain: harness.ipcMain });
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('oracle:generateImage');
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('oracle:deleteImage');
      expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith('oracle:listImages');
    });

    test('handles missing ipcMain gracefully', () => {
      expect(() => registerOracleHandlers.unregister()).not.toThrow();
      expect(() => registerOracleHandlers.unregister({})).not.toThrow();
    });
  });
});
