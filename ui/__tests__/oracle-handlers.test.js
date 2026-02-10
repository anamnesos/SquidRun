/**
 * Oracle IPC handler structured error tests.
 */

jest.mock('../modules/image-gen', () => ({
  generateImage: jest.fn(),
  IMAGE_HISTORY_PATH: 'D:\\projects\\hivemind\\workspace\\image-gen-history.json',
  GENERATED_IMAGES_DIR: 'D:\\projects\\hivemind\\workspace\\generated-images',
}));

const { generateImage } = require('../modules/image-gen');
const { createIpcHarness, createDefaultContext } = require('./helpers/ipc-harness');
const { registerOracleHandlers } = require('../modules/ipc/oracle-handlers');

describe('oracle handlers', () => {
  let harness;
  let ctx;

  beforeEach(() => {
    jest.clearAllMocks();
    harness = createIpcHarness();
    ctx = createDefaultContext({ ipcMain: harness.ipcMain });
    registerOracleHandlers(ctx);
  });

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
});
